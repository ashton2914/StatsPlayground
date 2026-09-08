use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::models::distribution::DistributionRequest;
use crate::models::fit_y_by_x::FitYByXRequest;
use crate::models::tabulate::TabulateRequest;
use crate::services::distribution_service::DistributionService;
use crate::services::fit_y_by_x_service::FitYByXService;
use crate::services::tabulate_service::TabulateService;
use crate::services::workflow_executor::FrozenTableInput;
use crate::services::workflow_fingerprint::canonical_json_hash;
use crate::state::AppState;

#[derive(Clone, Debug)]
pub enum WorkflowAnalysisRequest {
    Distribution(DistributionRequest),
    FitYByX(FitYByXRequest),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowDocumentCommit {
    Graph {
        id: String,
        name: String,
        source_table_id: String,
        document: Value,
        validation_result_hash: String,
    },
    Analysis {
        id: String,
        name: String,
        source_table_id: String,
        document: Value,
        validation_result_hash: String,
    },
    Tabulate {
        id: String,
        name: String,
        source_table_id: String,
        document: Value,
        result: Value,
        validation_result_hash: String,
    },
    Report {
        id: String,
        name: String,
        markdown: String,
        dependency_ids: Vec<String>,
        validation_result_hash: String,
    },
}

impl WorkflowDocumentCommit {
    pub fn source_table_id(&self) -> Option<&str> {
        match self {
            Self::Graph {
                source_table_id, ..
            }
            | Self::Analysis {
                source_table_id, ..
            }
            | Self::Tabulate {
                source_table_id, ..
            } => Some(source_table_id),
            Self::Report { .. } => None,
        }
    }

    pub fn validation_result_hash(&self) -> &str {
        match self {
            Self::Graph {
                validation_result_hash,
                ..
            }
            | Self::Analysis {
                validation_result_hash,
                ..
            }
            | Self::Tabulate {
                validation_result_hash,
                ..
            }
            | Self::Report {
                validation_result_hash,
                ..
            } => validation_result_hash,
        }
    }
}

pub struct WorkflowDocumentExecutor<'a> {
    state: &'a AppState,
}

impl<'a> WorkflowDocumentExecutor<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn execute_analysis(
        &self,
        id: &str,
        name: &str,
        document: Value,
        request: WorkflowAnalysisRequest,
        frozen_input: &FrozenTableInput,
    ) -> Result<WorkflowDocumentCommit, AppError> {
        validate_analysis_document(&document, id, frozen_input)?;
        validate_request_identity(&request, frozen_input)?;
        self.validate_frozen_input(frozen_input)?;
        let result = match request {
            WorkflowAnalysisRequest::Distribution(request) => serde_json::to_value(
                DistributionService::new(self.state).compute_distribution_report(&request)?,
            ),
            WorkflowAnalysisRequest::FitYByX(request) => {
                serde_json::to_value(FitYByXService::new(self.state).run(request)?)
            }
        }
        .map_err(|error| AppError::Stats(format!("failed to encode analysis result: {error}")))?;
        self.validate_frozen_input(frozen_input)?;
        Ok(WorkflowDocumentCommit::Analysis {
            id: id.to_string(),
            name: name.to_string(),
            source_table_id: frozen_input.table_document_id.clone(),
            document,
            validation_result_hash: canonical_json_hash(&result)?,
        })
    }

    pub fn execute_tabulate(
        &self,
        id: &str,
        name: &str,
        document: Value,
        request: TabulateRequest,
        frozen_input: &FrozenTableInput,
    ) -> Result<WorkflowDocumentCommit, AppError> {
        validate_document_identity(&document, id, "sourceDatasetId", frozen_input)?;
        if request.dataset_id != frozen_input.table_document_id {
            return Err(identity_error(&request.dataset_id, frozen_input));
        }
        self.validate_frozen_input(frozen_input)?;
        let result = serde_json::to_value(TabulateService::new(self.state).run(request)?).map_err(
            |error| AppError::Stats(format!("failed to encode tabulate result: {error}")),
        )?;
        self.validate_frozen_input(frozen_input)?;
        Ok(WorkflowDocumentCommit::Tabulate {
            id: id.to_string(),
            name: name.to_string(),
            source_table_id: frozen_input.table_document_id.clone(),
            document,
            validation_result_hash: canonical_json_hash(&result)?,
            result,
        })
    }

    pub fn stage_graph(
        &self,
        id: &str,
        name: &str,
        document: Value,
        frozen_input: &FrozenTableInput,
    ) -> Result<WorkflowDocumentCommit, AppError> {
        validate_document_identity(&document, id, "sourceDatasetId", frozen_input)?;
        if document.get("mode").and_then(Value::as_str).is_none()
            || document
                .get("modeStates")
                .and_then(Value::as_object)
                .is_none()
        {
            return Err(AppError::InvalidParam(
                "workflow Graph document requires mode and modeStates".to_string(),
            ));
        }
        self.validate_frozen_input(frozen_input)?;
        Ok(WorkflowDocumentCommit::Graph {
            id: id.to_string(),
            name: name.to_string(),
            source_table_id: frozen_input.table_document_id.clone(),
            validation_result_hash: canonical_json_hash(&document)?,
            document,
        })
    }

    pub fn stage_report(
        &self,
        id: &str,
        name: &str,
        document: Value,
        dependency_ids: Vec<String>,
    ) -> Result<WorkflowDocumentCommit, AppError> {
        if document.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return Err(AppError::InvalidParam(
                "workflow Report document requires schema version 1".to_string(),
            ));
        }
        if document.get("id").and_then(Value::as_str) != Some(id) {
            return Err(AppError::InvalidParam(format!(
                "workflow Report document id does not match declared output {id}"
            )));
        }
        let markdown = document
            .get("markdown")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidParam("workflow Report markdown is required".into()))?;
        let embedded_ids = report_dependency_ids(markdown)?;
        if embedded_ids != dependency_ids {
            return Err(AppError::InvalidParam(
                "Workflow Report dependencies do not match embedded documents".to_string(),
            ));
        }
        Ok(WorkflowDocumentCommit::Report {
            id: id.to_string(),
            name: name.to_string(),
            validation_result_hash: canonical_json_hash(&Value::String(markdown.to_string()))?,
            markdown: markdown.to_string(),
            dependency_ids,
        })
    }

    fn validate_frozen_input(&self, frozen_input: &FrozenTableInput) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let actual_generation = db.get_dataset_generation(&frozen_input.table_document_id)?;
        if actual_generation != frozen_input.generation {
            return Err(AppError::InvalidParam(format!(
                "stale workflow document input {}: expected generation {}, found {actual_generation}",
                frozen_input.table_document_id, frozen_input.generation
            )));
        }
        let actual_hash = db.workflow_table_content_hash(
            &frozen_input.table_document_id,
            frozen_input.generation,
        )?;
        if actual_hash != frozen_input.content_hash {
            return Err(AppError::InvalidParam(format!(
                "workflow document input {} content hash changed",
                frozen_input.table_document_id
            )));
        }
        Ok(())
    }
}

fn validate_request_identity(
    request: &WorkflowAnalysisRequest,
    frozen_input: &FrozenTableInput,
) -> Result<(), AppError> {
    let (dataset_id, generation) = match request {
        WorkflowAnalysisRequest::Distribution(request) => {
            (request.dataset_id.as_str(), request.generation)
        }
        WorkflowAnalysisRequest::FitYByX(request) => {
            (request.dataset_id.as_str(), request.generation)
        }
    };
    if dataset_id != frozen_input.table_document_id || generation != frozen_input.generation {
        return Err(identity_error(dataset_id, frozen_input));
    }
    Ok(())
}

fn validate_analysis_document(
    document: &Value,
    id: &str,
    frozen_input: &FrozenTableInput,
) -> Result<(), AppError> {
    if document.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || document.get("documentType").and_then(Value::as_str) != Some("analysis")
        || document
            .pointer("/presentation/schemaVersion")
            .and_then(Value::as_u64)
            != Some(1)
    {
        return Err(AppError::InvalidParam(
            "workflow Analysis document requires schema version 1".to_string(),
        ));
    }
    validate_document_identity_at_path(document, id, "/source/datasetId", frozen_input)
}

fn validate_document_identity(
    document: &Value,
    id: &str,
    source_field: &str,
    frozen_input: &FrozenTableInput,
) -> Result<(), AppError> {
    validate_document_identity_at_path(document, id, &format!("/{source_field}"), frozen_input)
}

fn validate_document_identity_at_path(
    document: &Value,
    id: &str,
    source_path: &str,
    frozen_input: &FrozenTableInput,
) -> Result<(), AppError> {
    if document
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|value| value != id)
    {
        return Err(AppError::InvalidParam(format!(
            "workflow document id does not match declared output {id}"
        )));
    }
    let dataset_id = document
        .pointer(source_path)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::InvalidParam(format!(
                "workflow document is missing source reference {source_path}"
            ))
        })?;
    if dataset_id != frozen_input.table_document_id {
        return Err(identity_error(dataset_id, frozen_input));
    }
    Ok(())
}

fn identity_error(dataset_id: &str, frozen_input: &FrozenTableInput) -> AppError {
    AppError::InvalidParam(format!(
        "workflow request source {dataset_id} does not match frozen input {}",
        frozen_input.table_document_id
    ))
}

pub fn remap_document_references(
    commits: Vec<WorkflowDocumentCommit>,
    stable_ids: &HashMap<String, String>,
) -> Result<Vec<WorkflowDocumentCommit>, AppError> {
    commits
        .into_iter()
        .map(|commit| remap_document_commit(commit, stable_ids))
        .collect()
}

fn remap_document_commit(
    commit: WorkflowDocumentCommit,
    stable_ids: &HashMap<String, String>,
) -> Result<WorkflowDocumentCommit, AppError> {
    match commit {
        WorkflowDocumentCommit::Graph {
            id,
            name,
            source_table_id,
            mut document,
            validation_result_hash,
        } => {
            let stable_source = resolve_stable_id(&source_table_id, stable_ids)?;
            replace_string_field(
                &mut document,
                &["sourceDatasetId"],
                &source_table_id,
                &stable_source,
            )?;
            Ok(WorkflowDocumentCommit::Graph {
                id,
                name,
                source_table_id: stable_source,
                document,
                validation_result_hash,
            })
        }
        WorkflowDocumentCommit::Analysis {
            id,
            name,
            source_table_id,
            mut document,
            validation_result_hash,
        } => {
            let stable_source = resolve_stable_id(&source_table_id, stable_ids)?;
            replace_string_field(
                &mut document,
                &["source", "datasetId"],
                &source_table_id,
                &stable_source,
            )?;
            Ok(WorkflowDocumentCommit::Analysis {
                id,
                name,
                source_table_id: stable_source,
                document,
                validation_result_hash,
            })
        }
        WorkflowDocumentCommit::Tabulate {
            id,
            name,
            source_table_id,
            mut document,
            result,
            validation_result_hash,
        } => {
            let stable_source = resolve_stable_id(&source_table_id, stable_ids)?;
            replace_string_field(
                &mut document,
                &["sourceDatasetId"],
                &source_table_id,
                &stable_source,
            )?;
            Ok(WorkflowDocumentCommit::Tabulate {
                id,
                name,
                source_table_id: stable_source,
                document,
                result,
                validation_result_hash,
            })
        }
        WorkflowDocumentCommit::Report {
            id,
            name,
            markdown,
            dependency_ids,
            validation_result_hash,
        } => {
            if report_dependency_ids(&markdown)? != dependency_ids {
                return Err(AppError::InvalidParam(
                    "Workflow Report dependencies do not match embedded documents".to_string(),
                ));
            }
            let (remapped_markdown, remapped_dependencies) =
                remap_report_markdown(&markdown, stable_ids)?;
            Ok(WorkflowDocumentCommit::Report {
                id,
                name,
                markdown: remapped_markdown,
                dependency_ids: remapped_dependencies,
                validation_result_hash,
            })
        }
    }
}

pub(crate) fn report_dependency_ids(markdown: &str) -> Result<Vec<String>, AppError> {
    Ok(remap_report_markdown(markdown, &HashMap::new())?.1)
}

fn remap_report_markdown(
    markdown: &str,
    stable_ids: &HashMap<String, String>,
) -> Result<(String, Vec<String>), AppError> {
    let mut output = String::with_capacity(markdown.len());
    let mut dependencies = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut fence: Option<(char, usize)> = None;

    for segment in markdown.split_inclusive('\n') {
        let line = segment.trim_end_matches(['\r', '\n']);
        let ending = &segment[line.len()..];
        if let Some((marker, length)) = fence {
            output.push_str(segment);
            if is_fence_close(line, marker, length) {
                fence = None;
            }
            continue;
        }
        if let Some((marker, length)) = fence_open(line) {
            fence = Some((marker, length));
            output.push_str(segment);
            continue;
        }
        if let Some((kind, document_id)) = parse_report_embed(line)? {
            let remapped_id = if stable_ids.is_empty() {
                document_id.to_string()
            } else {
                resolve_stable_id(document_id, stable_ids)?
            };
            if seen.insert(remapped_id.clone()) {
                dependencies.push(remapped_id.clone());
            }
            output.push_str(&format!(
                "{{{{sp-embed kind=\"{kind}\" id=\"{remapped_id}\"}}}}{ending}"
            ));
        } else {
            output.push_str(segment);
        }
    }
    Ok((output, dependencies))
}

fn parse_report_embed(line: &str) -> Result<Option<(&str, &str)>, AppError> {
    let Some(rest) = line.strip_prefix("{{sp-embed kind=\"") else {
        return Ok(None);
    };
    let Some((kind, rest)) = rest.split_once("\" id=\"") else {
        return Err(AppError::InvalidParam(
            "invalid Workflow Report embed directive".to_string(),
        ));
    };
    let Some(document_id) = rest.strip_suffix("\"}}") else {
        return Err(AppError::InvalidParam(
            "invalid Workflow Report embed directive".to_string(),
        ));
    };
    if !matches!(
        kind,
        "table" | "graph" | "fitYByX" | "tabulate" | "distribution"
    ) || document_id.is_empty()
        || document_id.chars().any(|character| {
            character.is_whitespace()
                || character.is_control()
                || matches!(character, '"' | '{' | '}')
        })
    {
        return Err(AppError::InvalidParam(
            "invalid Workflow Report embed directive".to_string(),
        ));
    }
    Ok(Some((kind, document_id)))
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let marker = trimmed.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let length = trimmed.chars().take_while(|value| *value == marker).count();
    (length >= 3).then_some((marker, length))
}

fn is_fence_close(line: &str, marker: char, minimum_length: usize) -> bool {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return false;
    }
    let marker_length = trimmed.chars().take_while(|value| *value == marker).count();
    marker_length >= minimum_length && trimmed[marker_length..].trim().is_empty()
}

fn resolve_stable_id(
    reference: &str,
    stable_ids: &HashMap<String, String>,
) -> Result<String, AppError> {
    stable_ids.get(reference).cloned().ok_or_else(|| {
        AppError::InvalidParam(format!(
            "unresolved workflow document reference {reference}"
        ))
    })
}

fn replace_string_field(
    document: &mut Value,
    path: &[&str],
    expected: &str,
    replacement: &str,
) -> Result<(), AppError> {
    let mut current = document;
    for segment in path {
        current = current.get_mut(*segment).ok_or_else(|| {
            AppError::InvalidParam(format!(
                "workflow document is missing reference field {}",
                path.join(".")
            ))
        })?;
    }
    if current.as_str() != Some(expected) {
        return Err(AppError::InvalidParam(format!(
            "workflow document reference field {} does not match {expected}",
            path.join(".")
        )));
    }
    *current = Value::String(replacement.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use crate::models::distribution::{DistributionFitKind, DistributionRequest};
    use crate::models::fit_y_by_x::{FitYByXPersonality, FitYByXRequest};
    use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateStatistic};
    use crate::services::workflow_executor::FrozenTableInput;
    use crate::state::AppState;

    use super::{
        remap_document_references, WorkflowAnalysisRequest, WorkflowDocumentCommit,
        WorkflowDocumentExecutor,
    };

    fn seed_compute_dataset(state: &AppState) -> FrozenTableInput {
        let db = state.db.lock().expect("test db lock");
        db.create_empty_table(
            "workflow-compute",
            "workflow-compute",
            &["height".to_string(), "site".to_string()],
            &["DOUBLE".to_string(), "VARCHAR".to_string()],
        )
        .expect("create compute dataset");
        db.conn()
            .execute_batch(
                r#"
                INSERT INTO "dataset_workflow_compute" (_row_id, height, site) VALUES
                    (1, 60.0, 'A'),
                    (2, 62.0, 'A'),
                    (3, 65.0, 'B'),
                    (4, 67.0, 'B');
                UPDATE _meta_datasets SET row_count = 4 WHERE id = 'workflow-compute';
                UPDATE _meta_columns SET role = 'nominal'
                    WHERE dataset_id = 'workflow-compute' AND col_name = 'site';
                "#,
            )
            .expect("seed compute rows");
        let generation = db
            .get_dataset_generation("workflow-compute")
            .expect("dataset generation");
        let content_hash = db
            .workflow_table_content_hash("workflow-compute", generation)
            .expect("dataset hash");
        FrozenTableInput {
            table_document_id: "workflow-compute".to_string(),
            generation,
            content_hash,
        }
    }

    #[test]
    fn computes_analysis_and_tabulate_with_stable_validation_hashes() {
        let state = AppState::new().expect("test state");
        let frozen = seed_compute_dataset(&state);
        let executor = WorkflowDocumentExecutor::new(&state);
        let fit_document = json!({
            "schemaVersion": 1,
            "documentType": "analysis",
            "id": "fit-output",
            "name": "Height by site",
            "analysisKind": "fitYByX",
            "source": { "datasetId": "workflow-compute" },
            "definition": { "kind": "fitYByX" },
            "presentation": { "schemaVersion": 1, "layout": "fit-y-by-x-v1" }
        });
        let fit_request = WorkflowAnalysisRequest::FitYByX(FitYByXRequest {
            dataset_id: frozen.table_document_id.clone(),
            generation: frozen.generation,
            response_column: "height".to_string(),
            factor_column: "site".to_string(),
            personality: FitYByXPersonality::Oneway,
            confidence_level: 0.95,
        });

        let first_fit = executor
            .execute_analysis(
                "fit-output",
                "Height by site",
                fit_document.clone(),
                fit_request.clone(),
                &frozen,
            )
            .expect("fit execution");
        let second_fit = executor
            .execute_analysis(
                "fit-output",
                "Height by site",
                fit_document,
                fit_request,
                &frozen,
            )
            .expect("repeat fit execution");
        assert_eq!(
            first_fit.validation_result_hash(),
            second_fit.validation_result_hash()
        );
        assert!(matches!(first_fit, WorkflowDocumentCommit::Analysis { .. }));

        let distribution = executor
            .execute_analysis(
                "distribution-output",
                "Height distribution",
                json!({
                    "schemaVersion": 1,
                    "documentType": "analysis",
                    "id": "distribution-output",
                    "name": "Height distribution",
                    "analysisKind": "distribution",
                    "source": { "datasetId": "workflow-compute" },
                    "definition": { "kind": "distribution" },
                    "presentation": { "schemaVersion": 1, "layout": "distribution-v1" }
                }),
                WorkflowAnalysisRequest::Distribution(DistributionRequest {
                    dataset_id: frozen.table_document_id.clone(),
                    generation: frozen.generation,
                    response_columns: vec!["height".to_string()],
                    weight_column: None,
                    freq_column: None,
                    by_columns: vec![],
                    confidence_level: 0.95,
                    spec_limits: HashMap::new(),
                    fit_distributions: vec![DistributionFitKind::Normal],
                }),
                &frozen,
            )
            .expect("distribution execution");
        assert!(matches!(
            distribution,
            WorkflowDocumentCommit::Analysis { .. }
        ));

        let tabulate = executor
            .execute_tabulate(
                "tabulate-output",
                "Height summary",
                json!({
                    "id": "tabulate-output",
                    "name": "Height summary",
                    "sourceDatasetId": "workflow-compute"
                }),
                TabulateRequest {
                    dataset_id: frozen.table_document_id.clone(),
                    row_fields: vec!["site".to_string()],
                    column_fields: vec![],
                    statistics: vec![TabulateStatistic {
                        id: "mean-height".to_string(),
                        field: "height".to_string(),
                        kind: StatisticKind::Mean,
                        quantile: None,
                    }],
                    include_row_totals: true,
                    include_column_totals: true,
                    max_result_cells: 10_000,
                },
                &frozen,
            )
            .expect("tabulate execution");
        let WorkflowDocumentCommit::Tabulate { result, .. } = tabulate else {
            panic!("expected tabulate commit");
        };
        assert_eq!(result["cellCount"], 2);
    }

    #[test]
    fn rejects_compute_after_frozen_generation_changes() {
        let state = AppState::new().expect("test state");
        let frozen = seed_compute_dataset(&state);
        state
            .db
            .lock()
            .expect("test db lock")
            .conn()
            .execute(
                "UPDATE _meta_datasets SET generation = generation + 1 WHERE id = $1",
                duckdb::params![&frozen.table_document_id],
            )
            .expect("increment generation");

        let error = WorkflowDocumentExecutor::new(&state)
            .execute_tabulate(
                "tabulate-output",
                "Height summary",
                json!({ "sourceDatasetId": "workflow-compute" }),
                TabulateRequest {
                    dataset_id: frozen.table_document_id.clone(),
                    row_fields: vec![],
                    column_fields: vec![],
                    statistics: vec![TabulateStatistic {
                        id: "count-height".to_string(),
                        field: "height".to_string(),
                        kind: StatisticKind::Count,
                        quantile: None,
                    }],
                    include_row_totals: false,
                    include_column_totals: false,
                    max_result_cells: 10_000,
                },
                &frozen,
            )
            .expect_err("stale frozen input must fail");

        assert!(error
            .to_string()
            .contains("stale workflow document input workflow-compute"));
    }

    #[test]
    fn stages_graph_and_report_documents_with_validated_dependencies() {
        let state = AppState::new().expect("test state");
        let frozen = seed_compute_dataset(&state);
        let executor = WorkflowDocumentExecutor::new(&state);
        let graph = executor
            .stage_graph(
                "graph-output",
                "Height graph",
                json!({
                    "id": "graph-output",
                    "name": "Height graph",
                    "sourceDatasetId": "workflow-compute",
                    "mode": "2d",
                    "modeStates": { "twoD": {}, "threeD": {}, "multivariate": {} }
                }),
                &frozen,
            )
            .expect("graph staging");
        assert!(matches!(graph, WorkflowDocumentCommit::Graph { .. }));

        let report = executor
            .stage_report(
                "report-output",
                "Height report",
                json!({
                    "schemaVersion": 1,
                    "id": "report-output",
                    "name": "Height report",
                    "markdown": concat!(
                        "{{sp-embed kind=\"graph\" id=\"graph-output\"}}\n",
                        "```text\n",
                        "{{sp-embed kind=\"graph\" id=\"not-a-dependency\"}}\n",
                        "```"
                    )
                }),
                vec!["graph-output".to_string()],
            )
            .expect("report staging");
        let WorkflowDocumentCommit::Report { dependency_ids, .. } = report else {
            panic!("expected report commit");
        };
        assert_eq!(dependency_ids, vec!["graph-output"]);
    }

    #[test]
    fn rejects_report_when_an_embed_is_not_declared() {
        let state = AppState::new().expect("test state");
        let error = WorkflowDocumentExecutor::new(&state)
            .stage_report(
                "report-output",
                "Height report",
                json!({
                    "schemaVersion": 1,
                    "id": "report-output",
                    "markdown": "{{sp-embed kind=\"graph\" id=\"graph-output\"}}"
                }),
                vec![],
            )
            .expect_err("undeclared embed must fail");

        assert!(error
            .to_string()
            .contains("Report dependencies do not match embedded documents"));
    }

    #[test]
    fn remaps_document_sources_and_report_embeds_to_stable_ids() {
        let remap = HashMap::from([
            ("workflow-input-1".to_string(), "table-a".to_string()),
            (
                "workflow-output-1".to_string(),
                "stable-table-c".to_string(),
            ),
            ("workflow-output-2".to_string(), "stable-graph".to_string()),
            (
                "workflow-output-3".to_string(),
                "stable-analysis".to_string(),
            ),
            (
                "workflow-output-4".to_string(),
                "stable-tabulate".to_string(),
            ),
        ]);
        let commits = remap_document_references(
            vec![
                WorkflowDocumentCommit::Graph {
                    id: "stable-graph".to_string(),
                    name: "Graph".to_string(),
                    source_table_id: "workflow-output-1".to_string(),
                    document: json!({ "sourceDatasetId": "workflow-output-1" }),
                    validation_result_hash: "graph-hash".to_string(),
                },
                WorkflowDocumentCommit::Analysis {
                    id: "stable-analysis".to_string(),
                    name: "Analysis".to_string(),
                    source_table_id: "workflow-output-1".to_string(),
                    document: json!({ "source": { "datasetId": "workflow-output-1" } }),
                    validation_result_hash: "analysis-hash".to_string(),
                },
                WorkflowDocumentCommit::Tabulate {
                    id: "stable-tabulate".to_string(),
                    name: "Tabulate".to_string(),
                    source_table_id: "workflow-output-1".to_string(),
                    document: json!({ "sourceDatasetId": "workflow-output-1" }),
                    result: json!({ "cells": [1.0] }),
                    validation_result_hash: "tabulate-hash".to_string(),
                },
                WorkflowDocumentCommit::Report {
                    id: "stable-report".to_string(),
                    name: "Report".to_string(),
                    markdown: concat!(
                        "{{sp-embed kind=\"graph\" id=\"workflow-output-2\"}}\n",
                        "{{sp-embed kind=\"fitYByX\" id=\"workflow-output-3\"}}\n",
                        "{{sp-embed kind=\"tabulate\" id=\"workflow-output-4\"}}"
                    )
                    .to_string(),
                    dependency_ids: vec![
                        "workflow-output-2".to_string(),
                        "workflow-output-3".to_string(),
                        "workflow-output-4".to_string(),
                    ],
                    validation_result_hash: "report-hash".to_string(),
                },
            ],
            &remap,
        )
        .expect("references remap");

        assert_eq!(commits[0].source_table_id(), Some("stable-table-c"));
        assert_eq!(commits[1].source_table_id(), Some("stable-table-c"));
        assert_eq!(commits[2].source_table_id(), Some("stable-table-c"));
        let WorkflowDocumentCommit::Report {
            markdown,
            dependency_ids,
            ..
        } = &commits[3]
        else {
            panic!("expected report commit");
        };
        assert!(markdown.contains("id=\"stable-graph\""));
        assert!(markdown.contains("id=\"stable-analysis\""));
        assert!(markdown.contains("id=\"stable-tabulate\""));
        assert_eq!(
            dependency_ids,
            &vec![
                "stable-graph".to_string(),
                "stable-analysis".to_string(),
                "stable-tabulate".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_an_unresolved_document_reference() {
        let error = remap_document_references(
            vec![WorkflowDocumentCommit::Graph {
                id: "stable-graph".to_string(),
                name: "Graph".to_string(),
                source_table_id: "unknown-slot".to_string(),
                document: json!({ "sourceDatasetId": "unknown-slot" }),
                validation_result_hash: "graph-hash".to_string(),
            }],
            &HashMap::new(),
        )
        .expect_err("unknown source must fail");

        assert!(error
            .to_string()
            .contains("unresolved workflow document reference unknown-slot"));
    }

    #[test]
    fn serializes_document_commit_fields_in_camel_case() {
        let value = serde_json::to_value(WorkflowDocumentCommit::Graph {
            id: "graph-output".to_string(),
            name: "Graph".to_string(),
            source_table_id: "table-c".to_string(),
            document: json!({ "sourceDatasetId": "table-c" }),
            validation_result_hash: "result-hash".to_string(),
        })
        .expect("serialize commit");

        assert_eq!(value["kind"], "graph");
        assert_eq!(value["sourceTableId"], "table-c");
        assert_eq!(value["validationResultHash"], "result-hash");
        assert!(value.get("source_table_id").is_none());
    }
}

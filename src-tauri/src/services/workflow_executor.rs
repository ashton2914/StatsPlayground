use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::engine::duckdb_engine::{DatasetReplacement, DuckDbEngine};
use crate::error::AppError;
use crate::models::distribution::DistributionRequest;
use crate::models::fit_y_by_x::FitYByXRequest;
use crate::models::table::DatasetMeta;
use crate::models::tabulate::TabulateRequest;
use crate::services::save_coordinator::SaveCoordinator;
use crate::services::table_transform_domain::TableTransformDefinition;
use crate::services::table_transform_service::{
    TableTransformProjectBinding, TableTransformService,
};
use crate::services::workflow_document_executor::{
    remap_document_references, report_dependency_ids, WorkflowAnalysisRequest,
    WorkflowDocumentCommit, WorkflowDocumentExecutor,
};
use crate::services::workflow_domain::{
    ArtifactKind, OperationKind, WorkflowDefinition, WorkflowInputBinding,
    WorkflowInputFingerprint, WorkflowNodeRunRecord, WorkflowOutputBinding,
    WorkflowOutputFingerprint, WorkflowRun, WorkflowRunError, WorkflowRunStatus,
};
use crate::services::workflow_fingerprint::canonical_json_hash;
use crate::services::workflow_planner::plan_workflow;
use crate::state::{AppState, WorkflowRunJournalEntry};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRequest {
    pub workflow: WorkflowDefinition,
    pub input_bindings: Vec<WorkflowInputBinding>,
    pub output_bindings: Vec<WorkflowOutputBinding>,
    pub seed: u64,
    #[serde(default)]
    pub previous_runs: Vec<WorkflowRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunCommitPacket {
    pub commit_id: String,
    pub documents: Vec<WorkflowDocumentCommit>,
    pub run: WorkflowRun,
}

pub struct WorkflowExecutor<'a> {
    state: &'a AppState,
}

impl<'a> WorkflowExecutor<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn execute(
        &self,
        request: WorkflowRunRequest,
    ) -> Result<WorkflowRunCommitPacket, AppError> {
        let started_at = workflow_timestamp()?;
        let run_id = Uuid::new_v4().to_string();
        let workflow_id = request.workflow.id.clone();
        let workflow_revision = request.workflow.revision;
        let input_bindings = request.input_bindings.clone();
        let output_bindings = request.output_bindings.clone();
        let seed = request.seed;

        match self.execute_succeeded(request, run_id.clone(), started_at.clone()) {
            Ok(packet) => Ok(packet),
            Err(error) => Ok(WorkflowRunCommitPacket {
                commit_id: run_id.clone(),
                documents: vec![],
                run: WorkflowRun {
                    id: run_id,
                    workflow_id,
                    workflow_revision,
                    status: WorkflowRunStatus::Failed,
                    started_at: Some(started_at),
                    completed_at: Some(workflow_timestamp()?),
                    input_bindings,
                    schema_validation_report: None,
                    node_results: vec![],
                    output_bindings,
                    errors: vec![WorkflowRunError {
                        code: "workflowExecutionFailed".to_string(),
                        message: error.to_string(),
                    }],
                    parent_folder_id: None,
                    seed: Some(seed),
                    engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                    configuration_hash: None,
                    input_fingerprints: vec![],
                    output_fingerprints: vec![],
                    determinism_baseline_run_id: None,
                },
            }),
        }
    }

    pub fn acknowledge(&self, commit_id: &str) -> Result<(), AppError> {
        if commit_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "Workflow commit ID is required".into(),
            ));
        }
        let mut journal = self
            .state
            .workflow_run_journal
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if journal
            .get(commit_id)
            .is_some_and(|entry| entry.packet.is_some())
        {
            journal.remove(commit_id);
        }
        Ok(())
    }

    fn execute_succeeded(
        &self,
        request: WorkflowRunRequest,
        run_id: String,
        started_at: String,
    ) -> Result<WorkflowRunCommitPacket, AppError> {
        let plan = plan_workflow(&request.workflow)?;
        let input_bindings = exact_input_bindings(&request)?;
        let output_bindings = exact_output_bindings(&request)?;
        let frozen_inputs = self.freeze_inputs(&request, &input_bindings)?;
        let configuration_hash = canonical_json_hash(
            &serde_json::to_value(&request.workflow.operations).map_err(|error| {
                AppError::InvalidParam(format!("failed to encode Workflow configuration: {error}"))
            })?,
        )?;
        let output_by_operation = request
            .workflow
            .output_declarations
            .iter()
            .filter_map(|declaration| {
                output_bindings
                    .get(declaration.id.as_str())
                    .map(|stable_id| {
                        (
                            declaration.source_endpoint.node_id.as_str(),
                            (*stable_id).clone(),
                        )
                    })
            })
            .collect::<HashMap<_, _>>();
        let _permit = self.state.save_coordinator.mutation_permit()?;
        let table_stage = {
            let engine = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let steps = workflow_table_steps(
                &request.workflow,
                &plan.operation_ids,
                &input_bindings,
                &output_by_operation,
                &engine,
            )?;
            WorkflowTableExecutor::new(&engine, &self.state.save_coordinator).stage(
                &run_id,
                &steps,
                &frozen_inputs.values().cloned().collect::<Vec<_>>(),
            )?
        };
        let project_path = self
            .state
            .project
            .read()
            .map_err(|error| AppError::Database(error.to_string()))?
            .as_ref()
            .map(|project| project.file_path.clone())
            .unwrap_or_default();
        self.state
            .workflow_run_journal
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .insert(
                run_id.clone(),
                WorkflowRunJournalEntry {
                    project_path,
                    staging_ids: table_stage.staging_ids.clone(),
                    packet: None,
                },
            );
        let packet = (|| -> Result<WorkflowRunCommitPacket, AppError> {
            let document_executor = WorkflowDocumentExecutor::new(self.state);
            let mut documents = Vec::new();
            let mut node_results = Vec::new();

            for operation_id in &plan.operation_ids {
                let operation = request
                    .workflow
                    .operations
                    .iter()
                    .find(|candidate| candidate.id == *operation_id)
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!("unknown Workflow operation {operation_id}"))
                    })?;
                let stable_id =
                    output_by_operation
                        .get(operation_id.as_str())
                        .ok_or_else(|| {
                            AppError::InvalidParam(format!(
                                "Workflow operation {operation_id} has no stable document output"
                            ))
                        })?;
                let declaration = request
                    .workflow
                    .output_declarations
                    .iter()
                    .find(|candidate| candidate.source_endpoint.node_id == *operation_id)
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!(
                            "missing output declaration for {operation_id}"
                        ))
                    })?;
                if operation.kind == OperationKind::TableTransform {
                    node_results.push(WorkflowNodeRunRecord {
                        node_id: operation_id.clone(),
                        status: WorkflowRunStatus::Succeeded,
                        started_at: Some(started_at.clone()),
                        completed_at: Some(workflow_timestamp()?),
                    });
                    continue;
                }
                let commit = match operation.kind {
                    OperationKind::GraphGeneration => {
                        let frozen_input = resolve_frozen_table_input(
                            &request.workflow,
                            operation_id,
                            &input_bindings,
                            &frozen_inputs,
                            &output_by_operation,
                            &table_stage.runtime_outputs,
                        )?;
                        let document = graph_document(
                            stable_id,
                            &declaration.name,
                            &frozen_input.table_document_id,
                            operation.configuration.as_ref(),
                            &started_at,
                        )?;
                        document_executor.stage_graph(
                            stable_id,
                            &declaration.name,
                            document,
                            frozen_input,
                        )?
                    }
                    OperationKind::AnalysisExecution | OperationKind::FitYByX => {
                        let frozen_input = resolve_frozen_table_input(
                            &request.workflow,
                            operation_id,
                            &input_bindings,
                            &frozen_inputs,
                            &output_by_operation,
                            &table_stage.runtime_outputs,
                        )?;
                        let (document, analysis_request) = analysis_document_and_request(
                            stable_id,
                            &declaration.name,
                            &frozen_input.table_document_id,
                            frozen_input.generation,
                            operation.configuration.as_ref(),
                            &started_at,
                        )?;
                        document_executor.execute_analysis(
                            stable_id,
                            &declaration.name,
                            document,
                            analysis_request,
                            frozen_input,
                        )?
                    }
                    OperationKind::Tabulate => {
                        let frozen_input = resolve_frozen_table_input(
                            &request.workflow,
                            operation_id,
                            &input_bindings,
                            &frozen_inputs,
                            &output_by_operation,
                            &table_stage.runtime_outputs,
                        )?;
                        let (document, tabulate_request) = tabulate_document_and_request(
                            stable_id,
                            &declaration.name,
                            &frozen_input.table_document_id,
                            operation.configuration.as_ref(),
                            &started_at,
                        )?;
                        document_executor.execute_tabulate(
                            stable_id,
                            &declaration.name,
                            document,
                            tabulate_request,
                            frozen_input,
                        )?
                    }
                    OperationKind::ReportComposition => {
                        let (document, original_dependency_ids, reference_map) =
                            report_document_and_references(
                                &request.workflow,
                                operation_id,
                                stable_id,
                                &declaration.name,
                                operation.configuration.as_ref(),
                                &input_bindings,
                                &output_by_operation,
                                &started_at,
                            )?;
                        let staged = document_executor.stage_report(
                            stable_id,
                            &declaration.name,
                            document,
                            original_dependency_ids,
                        )?;
                        remap_document_references(vec![staged], &reference_map)?
                            .into_iter()
                            .next()
                            .ok_or_else(|| {
                                AppError::Stats(
                                    "Workflow Report staging returned no document".into(),
                                )
                            })?
                    }
                    _ => {
                        return Err(AppError::InvalidParam(format!(
                            "Workflow operation {operation_id} is not executable yet"
                        )))
                    }
                };
                documents.push(commit);
                node_results.push(WorkflowNodeRunRecord {
                    node_id: operation_id.clone(),
                    status: WorkflowRunStatus::Succeeded,
                    started_at: Some(started_at.clone()),
                    completed_at: Some(workflow_timestamp()?),
                });
            }

            let stable_references = frozen_inputs
                .values()
                .map(|input| {
                    (
                        input.table_document_id.clone(),
                        input.table_document_id.clone(),
                    )
                })
                .chain(
                    table_stage
                        .runtime_outputs
                        .iter()
                        .map(|(stable_id, input)| {
                            (input.table_document_id.clone(), stable_id.clone())
                        }),
                )
                .chain(
                    output_by_operation
                        .values()
                        .map(|stable_id| (stable_id.clone(), stable_id.clone())),
                )
                .collect::<HashMap<_, _>>();
            let documents = remap_document_references(documents, &stable_references)?;

            let output_fingerprints = request
                .workflow
                .output_declarations
                .iter()
                .map(|declaration| {
                    let stable_id =
                        output_bindings
                            .get(declaration.id.as_str())
                            .ok_or_else(|| {
                                AppError::InvalidParam(format!(
                                    "missing output binding {}",
                                    declaration.id
                                ))
                            })?;
                    let content_hash = if declaration.artifact_kind == ArtifactKind::Table {
                        table_stage
                            .output_hashes
                            .get(stable_id)
                            .cloned()
                            .ok_or_else(|| {
                                AppError::InvalidParam(format!(
                                    "missing staged Table output {stable_id}"
                                ))
                            })?
                    } else {
                        documents
                            .iter()
                            .find(|commit| document_commit_id(commit) == stable_id)
                            .ok_or_else(|| {
                                AppError::InvalidParam(format!("missing staged output {stable_id}"))
                            })?
                            .validation_result_hash()
                            .to_string()
                    };
                    Ok(WorkflowOutputFingerprint {
                        declaration_id: declaration.id.clone(),
                        artifact_document_id: stable_id.clone(),
                        content_hash,
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            let completed_at = workflow_timestamp()?;
            let run = WorkflowRun {
                id: run_id.clone(),
                workflow_id: plan.workflow_id,
                workflow_revision: plan.workflow_revision,
                status: WorkflowRunStatus::Succeeded,
                started_at: Some(started_at),
                completed_at: Some(completed_at),
                input_bindings: request.input_bindings.clone(),
                schema_validation_report: None,
                node_results,
                output_bindings: request.output_bindings.clone(),
                errors: vec![],
                parent_folder_id: None,
                seed: Some(request.seed),
                engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                configuration_hash: Some(configuration_hash),
                input_fingerprints: frozen_inputs
                    .iter()
                    .map(|(slot_id, input)| WorkflowInputFingerprint {
                        slot_id: slot_id.clone(),
                        table_document_id: input.table_document_id.clone(),
                        generation: input.generation,
                        schema_fingerprint: request
                            .workflow
                            .input_slots
                            .iter()
                            .find(|slot| slot.id == *slot_id)
                            .map(|slot| slot.schema_contract.schema_fingerprint.clone())
                            .unwrap_or_default(),
                        content_hash: input.content_hash.clone(),
                    })
                    .collect(),
                output_fingerprints,
                determinism_baseline_run_id: None,
            };
            Ok(WorkflowRunCommitPacket {
                commit_id: run_id.clone(),
                documents,
                run,
            })
        })();
        let packet = match packet {
            Ok(packet) => packet,
            Err(error) => {
                let engine = self
                    .state
                    .db
                    .lock()
                    .map_err(|lock_error| AppError::Database(lock_error.to_string()))?;
                WorkflowTableExecutor::new(&engine, &self.state.save_coordinator)
                    .cleanup(&table_stage.staging_ids);
                self.state
                    .workflow_run_journal
                    .lock()
                    .map_err(|lock_error| AppError::Database(lock_error.to_string()))?
                    .remove(&run_id);
                return Err(error);
            }
        };
        {
            let engine = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            WorkflowTableExecutor::new(&engine, &self.state.save_coordinator)
                .publish(table_stage)?;
        }
        let mut journal = self
            .state
            .workflow_run_journal
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let entry = journal.get_mut(&packet.commit_id).ok_or_else(|| {
            AppError::Database("Workflow run journal entry disappeared before commit".into())
        })?;
        entry.staging_ids.clear();
        entry.packet = Some(packet.clone());
        Ok(packet)
    }

    fn freeze_inputs(
        &self,
        request: &WorkflowRunRequest,
        input_bindings: &HashMap<&str, String>,
    ) -> Result<HashMap<String, FrozenTableInput>, AppError> {
        let engine = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        request
            .workflow
            .input_slots
            .iter()
            .map(|slot| {
                let table_document_id = input_bindings.get(slot.id.as_str()).ok_or_else(|| {
                    AppError::InvalidParam(format!("missing Workflow input binding {}", slot.id))
                })?;
                let generation = engine.get_dataset_generation(table_document_id)?;
                let content_hash =
                    engine.workflow_table_content_hash(table_document_id, generation)?;
                Ok((
                    slot.id.clone(),
                    FrozenTableInput {
                        table_document_id: table_document_id.clone(),
                        generation,
                        content_hash,
                    },
                ))
            })
            .collect()
    }
}

fn exact_input_bindings(request: &WorkflowRunRequest) -> Result<HashMap<&str, String>, AppError> {
    let mut bindings = HashMap::new();
    for binding in &request.input_bindings {
        if bindings
            .insert(binding.slot_id.as_str(), binding.table_document_id.clone())
            .is_some()
        {
            return Err(AppError::InvalidParam(format!(
                "duplicate Workflow input binding {}",
                binding.slot_id
            )));
        }
    }
    let expected = request
        .workflow
        .input_slots
        .iter()
        .map(|slot| slot.id.as_str())
        .collect::<HashSet<_>>();
    if bindings.keys().copied().collect::<HashSet<_>>() != expected {
        return Err(AppError::InvalidParam(
            "Workflow input bindings do not match input slots".to_string(),
        ));
    }
    Ok(bindings)
}

fn exact_output_bindings(request: &WorkflowRunRequest) -> Result<HashMap<&str, String>, AppError> {
    let mut bindings = HashMap::new();
    let mut stable_ids = HashSet::new();
    for binding in &request.output_bindings {
        if binding.artifact_document_id.trim().is_empty()
            || !stable_ids.insert(binding.artifact_document_id.as_str())
            || bindings
                .insert(
                    binding.declaration_id.as_str(),
                    binding.artifact_document_id.clone(),
                )
                .is_some()
        {
            return Err(AppError::InvalidParam(
                "Workflow output bindings contain duplicate or empty identities".to_string(),
            ));
        }
    }
    let expected = request
        .workflow
        .output_declarations
        .iter()
        .map(|declaration| declaration.id.as_str())
        .collect::<HashSet<_>>();
    if bindings.keys().copied().collect::<HashSet<_>>() != expected {
        return Err(AppError::InvalidParam(
            "Workflow output bindings do not match output declarations".to_string(),
        ));
    }
    Ok(bindings)
}

fn workflow_table_steps(
    workflow: &WorkflowDefinition,
    operation_ids: &[String],
    input_bindings: &HashMap<&str, String>,
    output_by_operation: &HashMap<&str, String>,
    engine: &DuckDbEngine,
) -> Result<Vec<WorkflowTableStep>, AppError> {
    let generations = engine
        .list_datasets()?
        .into_iter()
        .map(|dataset| (dataset.id, dataset.generation))
        .collect::<HashMap<_, _>>();
    operation_ids
        .iter()
        .filter_map(|operation_id| {
            workflow
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
                .filter(|operation| operation.kind == OperationKind::TableTransform)
                .map(|operation| (operation_id, operation))
        })
        .map(|(operation_id, operation)| {
            let mut definition = serde_json::from_value::<TableTransformDefinition>(
                operation.configuration.clone().ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "Workflow Table Transform {operation_id} configuration is required"
                    ))
                })?,
            )
            .map_err(|error| {
                AppError::InvalidParam(format!(
                    "invalid Workflow Table Transform {operation_id}: {error}"
                ))
            })?;
            let stable_id = output_by_operation
                .get(operation_id.as_str())
                .ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "Workflow Table Transform {operation_id} has no stable output"
                    ))
                })?;
            definition.output.table_document_id = stable_id.clone();
            let inputs = operation
                .input_ports
                .iter()
                .map(|port| {
                    let edge = workflow
                        .edges
                        .iter()
                        .find(|edge| {
                            edge.target.node_id == *operation_id && edge.target.port_id == port.id
                        })
                        .ok_or_else(|| {
                            AppError::InvalidParam(format!(
                                "Workflow Table Transform {operation_id} input {} is unbound",
                                port.name
                            ))
                        })?;
                    let table_document_id = input_bindings
                        .get(edge.source.node_id.as_str())
                        .cloned()
                        .or_else(|| {
                            output_by_operation
                                .get(edge.source.node_id.as_str())
                                .cloned()
                        })
                        .ok_or_else(|| {
                            AppError::InvalidParam(format!(
                                "Workflow Table Transform {operation_id} input {} is unresolved",
                                port.name
                            ))
                        })?;
                    Ok(
                        crate::services::table_transform_service::TableTransformInputBinding {
                            role: port.name.clone(),
                            table_document_id,
                        },
                    )
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            Ok(WorkflowTableStep {
                operation_id: operation_id.clone(),
                binding: TableTransformProjectBinding {
                    definition_id: definition.id.clone(),
                    definition_revision: definition.revision,
                    inputs,
                    output_generation: generations.get(stable_id).copied().unwrap_or(0),
                },
                definition,
            })
        })
        .collect()
}

fn resolve_frozen_table_input<'a>(
    workflow: &WorkflowDefinition,
    operation_id: &str,
    input_bindings: &HashMap<&str, String>,
    frozen_inputs: &'a HashMap<String, FrozenTableInput>,
    output_by_operation: &HashMap<&str, String>,
    runtime_outputs: &'a HashMap<String, FrozenTableInput>,
) -> Result<&'a FrozenTableInput, AppError> {
    let edge = workflow
        .edges
        .iter()
        .find(|edge| edge.target.node_id == operation_id)
        .ok_or_else(|| {
            AppError::InvalidParam(format!("Workflow operation {operation_id} has no input"))
        })?;
    if input_bindings.contains_key(edge.source.node_id.as_str()) {
        return frozen_inputs.get(&edge.source.node_id).ok_or_else(|| {
            AppError::InvalidParam(format!(
                "missing frozen Workflow input {}",
                edge.source.node_id
            ))
        });
    }
    if let Some(table_id) = output_by_operation.get(edge.source.node_id.as_str()) {
        return runtime_outputs.get(table_id).ok_or_else(|| {
            AppError::InvalidParam(format!(
                "Workflow table output {table_id} is not available to {operation_id}"
            ))
        });
    }
    Err(AppError::InvalidParam(format!(
        "Workflow operation {operation_id} has an unresolved table input"
    )))
}

fn graph_document(
    id: &str,
    name: &str,
    source_table_id: &str,
    configuration: Option<&Value>,
    created_at: &str,
) -> Result<Value, AppError> {
    let configuration = configuration.and_then(Value::as_object).ok_or_else(|| {
        AppError::InvalidParam("Workflow Graph configuration is required".to_string())
    })?;
    let mode = configuration
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidParam("Workflow Graph mode is required".to_string()))?;
    let active_state = configuration.get("activeState").cloned().ok_or_else(|| {
        AppError::InvalidParam("Workflow Graph active state is required".to_string())
    })?;
    let empty_two_d = json!({
        "encoding": {}, "multiX": [], "multiY": [], "elements": [], "smootherLambda": 0.5
    });
    let empty_three_d = json!({ "encoding": {}, "elements": [], "smootherLambda": 0.5 });
    let empty_multivariate = json!({
        "columns": [], "chartType": "correlationMatrix", "correlationMethod": "pearson"
    });
    Ok(json!({
        "id": id,
        "name": name,
        "sourceDatasetId": source_table_id,
        "mode": mode,
        "modeStates": {
            "twoD": if mode == "2d" { active_state.clone() } else { empty_two_d },
            "threeD": if mode == "3d" { active_state.clone() } else { empty_three_d },
            "multivariate": if mode == "multivariate" { active_state } else { empty_multivariate }
        },
        "sampling": configuration.get("sampling").cloned().unwrap_or_else(|| json!({ "mode": "full" })),
        "filters": configuration.get("filters").cloned().unwrap_or_else(|| json!([])),
        "groupThemeSlots": configuration.get("groupThemeSlots").cloned().unwrap_or_else(|| json!({})),
        "createdAt": created_at
    }))
}

fn analysis_document_and_request(
    id: &str,
    name: &str,
    source_table_id: &str,
    generation: u64,
    configuration: Option<&Value>,
    created_at: &str,
) -> Result<(Value, WorkflowAnalysisRequest), AppError> {
    let configuration = configuration.and_then(Value::as_object).ok_or_else(|| {
        AppError::InvalidParam("Workflow Analysis configuration is required".to_string())
    })?;
    let analysis_kind = configuration
        .get("analysisKind")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidParam("Workflow Analysis kind is required".to_string()))?;
    let definition = configuration.get("definition").cloned().ok_or_else(|| {
        AppError::InvalidParam("Workflow Analysis definition is required".to_string())
    })?;
    let presentation = configuration.get("presentation").cloned().ok_or_else(|| {
        AppError::InvalidParam("Workflow Analysis presentation is required".to_string())
    })?;
    let document = json!({
        "schemaVersion": 1,
        "documentType": "analysis",
        "id": id,
        "name": name,
        "analysisKind": analysis_kind,
        "configRevision": configuration.get("configRevision").cloned().unwrap_or_else(|| json!(1)),
        "source": { "datasetId": source_table_id },
        "definition": definition,
        "presentation": presentation,
        "createdAt": created_at,
        "updatedAt": created_at
    });
    let request = match analysis_kind {
        "fitYByX" => WorkflowAnalysisRequest::FitYByX(
            serde_json::from_value::<FitYByXRequest>(json!({
                "datasetId": source_table_id,
                "generation": generation,
                "responseColumn": definition.pointer("/response/name"),
                "factorColumn": definition.pointer("/factor/name"),
                "personality": definition.get("personality"),
                "confidenceLevel": definition.get("confidenceLevel")
            }))
            .map_err(|error| {
                AppError::InvalidParam(format!("invalid Workflow Fit Y by X request: {error}"))
            })?,
        ),
        "distribution" => WorkflowAnalysisRequest::Distribution(
            serde_json::from_value::<DistributionRequest>(json!({
                "datasetId": source_table_id,
                "generation": generation,
                "responseColumns": definition.get("responses")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(|value| value.get("name")).cloned().collect::<Vec<_>>())
                    .unwrap_or_default(),
                "weightColumn": definition.pointer("/weight/name"),
                "freqColumn": definition.pointer("/frequency/name"),
                "byColumns": definition.get("by")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(|value| value.get("name")).cloned().collect::<Vec<_>>())
                    .unwrap_or_default(),
                "confidenceLevel": definition.pointer("/analysis/confidenceLevel"),
                "specLimits": definition.pointer("/analysis/specLimits").cloned().unwrap_or_else(|| json!({})),
                "fitDistributions": definition.pointer("/analysis/fitDistributions").cloned().unwrap_or_else(|| json!(["normal"]))
            }))
            .map_err(|error| {
                AppError::InvalidParam(format!("invalid Workflow Distribution request: {error}"))
            })?,
        ),
        _ => {
            return Err(AppError::InvalidParam(format!(
                "unsupported Workflow Analysis kind {analysis_kind}"
            )))
        }
    };
    Ok((document, request))
}

fn tabulate_document_and_request(
    id: &str,
    name: &str,
    source_table_id: &str,
    configuration: Option<&Value>,
    created_at: &str,
) -> Result<(Value, TabulateRequest), AppError> {
    let configuration = configuration.cloned().ok_or_else(|| {
        AppError::InvalidParam("Workflow Tabulate configuration is required".to_string())
    })?;
    let request = serde_json::from_value::<TabulateRequest>(json!({
        "datasetId": source_table_id,
        "rowFields": configuration.get("rowFields"),
        "columnFields": configuration.get("columnFields"),
        "statistics": configuration.get("statistics"),
        "includeRowTotals": configuration.get("includeRowTotals"),
        "includeColumnTotals": configuration.get("includeColumnTotals"),
        "maxResultCells": crate::services::tabulate_service::MAX_RESULT_CELLS
    }))
    .map_err(|error| {
        AppError::InvalidParam(format!("invalid Workflow Tabulate request: {error}"))
    })?;
    Ok((
        json!({
            "id": id,
            "name": name,
            "sourceDatasetId": source_table_id,
            "rowFields": configuration.get("rowFields"),
            "columnFields": configuration.get("columnFields"),
            "statistics": configuration.get("statistics"),
            "includeRowTotals": configuration.get("includeRowTotals"),
            "includeColumnTotals": configuration.get("includeColumnTotals"),
            "createdAt": created_at
        }),
        request,
    ))
}

#[allow(clippy::too_many_arguments)]
fn report_document_and_references(
    workflow: &WorkflowDefinition,
    operation_id: &str,
    id: &str,
    name: &str,
    configuration: Option<&Value>,
    input_bindings: &HashMap<&str, String>,
    output_by_operation: &HashMap<&str, String>,
    created_at: &str,
) -> Result<(Value, Vec<String>, HashMap<String, String>), AppError> {
    let configuration = configuration.and_then(Value::as_object).ok_or_else(|| {
        AppError::InvalidParam("Workflow Report configuration is required".to_string())
    })?;
    if configuration.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::InvalidParam(
            "Workflow Report requires schema version 1".to_string(),
        ));
    }
    let markdown = configuration
        .get("markdown")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::InvalidParam("Workflow Report markdown is required".to_string())
        })?;
    let operation = workflow
        .operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| AppError::InvalidParam(format!("unknown Workflow Report {operation_id}")))?;
    let mut reference_map = HashMap::new();
    for edge in workflow
        .edges
        .iter()
        .filter(|edge| edge.target.node_id == operation_id)
    {
        let port = operation
            .input_ports
            .iter()
            .find(|port| port.id == edge.target.port_id)
            .ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "unknown Workflow Report port {}",
                    edge.target.port_id
                ))
            })?;
        let original_id = port
            .name
            .split_once(':')
            .map(|(_, value)| value)
            .ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "invalid Workflow Report dependency port {}",
                    port.name
                ))
            })?;
        let stable_id = output_by_operation
            .get(edge.source.node_id.as_str())
            .cloned()
            .or_else(|| input_bindings.get(edge.source.node_id.as_str()).cloned())
            .ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "unresolved Workflow Report dependency {original_id}"
                ))
            })?;
        reference_map.insert(original_id.to_string(), stable_id);
    }
    let original_dependency_ids = report_dependency_ids(markdown)?;
    if let Some(unresolved) = original_dependency_ids
        .iter()
        .find(|dependency_id| !reference_map.contains_key(*dependency_id))
    {
        return Err(AppError::InvalidParam(format!(
            "unresolved Workflow Report dependency {unresolved}"
        )));
    }
    Ok((
        json!({
            "schemaVersion": 1,
            "id": id,
            "name": name,
            "markdown": markdown,
            "createdAt": created_at,
            "updatedAt": created_at
        }),
        original_dependency_ids,
        reference_map,
    ))
}

pub(crate) fn document_commit_id(commit: &WorkflowDocumentCommit) -> &str {
    match commit {
        WorkflowDocumentCommit::Graph { id, .. }
        | WorkflowDocumentCommit::Analysis { id, .. }
        | WorkflowDocumentCommit::Tabulate { id, .. }
        | WorkflowDocumentCommit::Report { id, .. } => id,
    }
}

fn workflow_timestamp() -> Result<String, AppError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Stats(format!("system clock precedes Unix epoch: {error}")))?
        .as_millis();
    Ok(milliseconds.to_string())
}

#[derive(Clone, Debug)]
pub struct FrozenTableInput {
    pub table_document_id: String,
    pub generation: u64,
    pub content_hash: String,
}

#[derive(Clone, Debug)]
pub struct WorkflowTableStep {
    pub operation_id: String,
    pub definition: TableTransformDefinition,
    pub binding: TableTransformProjectBinding,
}

#[derive(Clone, Debug)]
pub struct WorkflowTableExecutionResult {
    pub outputs: Vec<DatasetMeta>,
    pub output_hashes: HashMap<String, String>,
}

struct WorkflowTableStage {
    staging_ids: Vec<String>,
    replacements: Vec<DatasetReplacement>,
    runtime_outputs: HashMap<String, FrozenTableInput>,
    output_hashes: HashMap<String, String>,
}

pub struct WorkflowTableExecutor<'a> {
    engine: &'a DuckDbEngine,
    coordinator: &'a SaveCoordinator,
}

impl<'a> WorkflowTableExecutor<'a> {
    pub fn new(engine: &'a DuckDbEngine, coordinator: &'a SaveCoordinator) -> Self {
        Self {
            engine,
            coordinator,
        }
    }

    pub fn execute(
        &self,
        run_id: &str,
        steps: &[WorkflowTableStep],
        frozen_inputs: &[FrozenTableInput],
    ) -> Result<WorkflowTableExecutionResult, AppError> {
        if run_id.trim().is_empty() {
            return Err(AppError::InvalidParam("workflow run id is required".into()));
        }
        let _permit = self.coordinator.mutation_permit()?;
        let stage = self.stage(run_id, steps, frozen_inputs)?;
        self.publish(stage)
    }

    fn stage(
        &self,
        run_id: &str,
        steps: &[WorkflowTableStep],
        frozen_inputs: &[FrozenTableInput],
    ) -> Result<WorkflowTableStage, AppError> {
        let service = TableTransformService::new(self.engine);
        let mut operation_ids = HashSet::new();
        let mut output_ids = HashSet::new();
        let mut staged_outputs: HashMap<String, String> = HashMap::new();
        let mut runtime_outputs = HashMap::new();
        let mut staging_ids = Vec::new();
        let mut replacements = Vec::new();
        let mut output_hashes = HashMap::new();

        let staged = (|| -> Result<(), AppError> {
            for (index, step) in steps.iter().enumerate() {
                if !operation_ids.insert(step.operation_id.as_str()) {
                    return Err(AppError::InvalidParam(format!(
                        "duplicate workflow operation id: {}",
                        step.operation_id
                    )));
                }
                let stable_id = &step.definition.output.table_document_id;
                if !output_ids.insert(stable_id.as_str()) {
                    return Err(AppError::InvalidParam(format!(
                        "duplicate workflow output table id: {stable_id}"
                    )));
                }
                let mut binding = step.binding.clone();
                for input in &mut binding.inputs {
                    if let Some(staging_id) = staged_outputs.get(&input.table_document_id) {
                        input.table_document_id = staging_id.clone();
                    }
                }
                let staging_id = format!(
                    "__workflow_stage_{}_{}_{}",
                    run_id.replace('-', "_"),
                    index,
                    Uuid::new_v4().simple()
                );
                service.stage_for_workflow(&step.definition, &binding, &staging_id)?;
                let staging_generation = self.engine.get_dataset_generation(&staging_id)?;
                output_hashes.insert(
                    stable_id.clone(),
                    self.engine
                        .workflow_table_content_hash(&staging_id, staging_generation)?,
                );
                let content_hash = output_hashes
                    .get(stable_id)
                    .cloned()
                    .ok_or_else(|| AppError::Stats("missing staged Table hash".into()))?;
                staging_ids.push(staging_id.clone());
                staged_outputs.insert(stable_id.clone(), staging_id.clone());
                runtime_outputs.insert(
                    stable_id.clone(),
                    FrozenTableInput {
                        table_document_id: staging_id.clone(),
                        generation: staging_generation,
                        content_hash,
                    },
                );
                replacements.push(DatasetReplacement {
                    stable_id: stable_id.clone(),
                    temporary_id: staging_id,
                    stable_name: step.definition.output.name.clone(),
                    expected_generation: step.binding.output_generation,
                });
            }
            for input in frozen_inputs {
                let actual = self
                    .engine
                    .get_dataset_generation(&input.table_document_id)?;
                if actual != input.generation {
                    return Err(AppError::InvalidParam(format!(
                        "stale workflow input {}: expected generation {}, found {actual}",
                        input.table_document_id, input.generation
                    )));
                }
                let content_hash = self
                    .engine
                    .workflow_table_content_hash(&input.table_document_id, input.generation)?;
                if content_hash != input.content_hash {
                    return Err(AppError::InvalidParam(format!(
                        "workflow input {} content hash changed",
                        input.table_document_id
                    )));
                }
            }
            Ok(())
        })();

        if let Err(error) = staged {
            self.cleanup(&staging_ids);
            return Err(error);
        }
        Ok(WorkflowTableStage {
            staging_ids,
            replacements,
            runtime_outputs,
            output_hashes,
        })
    }

    fn publish(&self, stage: WorkflowTableStage) -> Result<WorkflowTableExecutionResult, AppError> {
        let outputs = self.engine.replace_datasets_atomically(&stage.replacements);
        if outputs.is_err() {
            self.cleanup(&stage.staging_ids);
        }
        Ok(WorkflowTableExecutionResult {
            outputs: outputs?,
            output_hashes: stage.output_hashes,
        })
    }

    fn cleanup(&self, staging_ids: &[String]) {
        for staging_id in staging_ids {
            let _ = self.engine.delete_dataset(staging_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::engine::duckdb_engine::DuckDbEngine;
    use crate::services::project_service::ProjectService;
    use crate::services::save_coordinator::SaveCoordinator;
    use crate::services::spprj_archive::TableColumn;
    use crate::services::table_transform_domain::{
        derive_input_contracts, JoinType, SortColumn, SortDirection, TableTransformDefinition,
        TableTransformOperation, TableTransformOutput,
    };
    use crate::services::table_transform_service::{
        TableTransformInputBinding, TableTransformProjectBinding,
    };
    use crate::services::workflow_domain::{
        WorkflowDefinition, WorkflowInputBinding, WorkflowOutputBinding,
    };
    use crate::state::AppState;

    use super::{
        FrozenTableInput, WorkflowExecutor, WorkflowRunRequest, WorkflowTableExecutor,
        WorkflowTableStep,
    };

    fn seed(engine: &DuckDbEngine, id: &str, values: &[i64]) {
        engine
            .create_empty_table(id, id, &["value".to_string()], &["BIGINT".to_string()])
            .unwrap();
        for value in values {
            let row_id = engine.add_row(id).unwrap();
            engine
                .update_cell(id, row_id, "value", &value.to_string())
                .unwrap();
        }
    }

    fn sort_step(
        engine: &DuckDbEngine,
        id: &str,
        input_id: &str,
        output_id: &str,
        output_generation: u64,
        column: &str,
    ) -> WorkflowTableStep {
        let operation = TableTransformOperation::Sort {
            sort_columns: vec![SortColumn {
                column: column.to_string(),
                direction: SortDirection::Ascending,
            }],
        };
        let contract_operation = TableTransformOperation::Sort {
            sort_columns: vec![SortColumn {
                column: "value".to_string(),
                direction: SortDirection::Ascending,
            }],
        };
        let source_columns = engine
            .get_user_columns(input_id)
            .unwrap()
            .into_iter()
            .map(|(name, col_type)| TableColumn {
                name,
                col_type,
                width: None,
                format: None,
                extras: None,
            })
            .collect();
        WorkflowTableStep {
            operation_id: id.to_string(),
            definition: TableTransformDefinition {
                id: id.to_string(),
                name: id.to_string(),
                format_version: "1".to_string(),
                revision: 1,
                input_slots: derive_input_contracts(
                    &contract_operation,
                    &HashMap::from([("source".to_string(), source_columns)]),
                )
                .unwrap(),
                operation,
                output: TableTransformOutput {
                    table_document_id: output_id.to_string(),
                    name: output_id.to_string(),
                },
            },
            binding: TableTransformProjectBinding {
                definition_id: id.to_string(),
                definition_revision: 1,
                inputs: vec![TableTransformInputBinding {
                    role: "source".to_string(),
                    table_document_id: input_id.to_string(),
                }],
                output_generation,
            },
        }
    }

    fn operation_step(
        engine: &DuckDbEngine,
        id: &str,
        operation: TableTransformOperation,
        role_ids: &[(&str, &str)],
        output_id: &str,
    ) -> WorkflowTableStep {
        let schemas = role_ids
            .iter()
            .map(|(role, table_id)| {
                let columns = engine
                    .get_user_columns(table_id)
                    .unwrap()
                    .into_iter()
                    .map(|(name, col_type)| TableColumn {
                        name,
                        col_type,
                        width: None,
                        format: None,
                        extras: None,
                    })
                    .collect();
                ((*role).to_string(), columns)
            })
            .collect();
        WorkflowTableStep {
            operation_id: id.to_string(),
            definition: TableTransformDefinition {
                id: id.to_string(),
                name: id.to_string(),
                format_version: "1".to_string(),
                revision: 1,
                input_slots: derive_input_contracts(&operation, &schemas).unwrap(),
                operation,
                output: TableTransformOutput {
                    table_document_id: output_id.to_string(),
                    name: output_id.to_string(),
                },
            },
            binding: TableTransformProjectBinding {
                definition_id: id.to_string(),
                definition_revision: 1,
                inputs: role_ids
                    .iter()
                    .map(|(role, table_id)| TableTransformInputBinding {
                        role: (*role).to_string(),
                        table_document_id: (*table_id).to_string(),
                    })
                    .collect(),
                output_generation: 0,
            },
        }
    }

    #[test]
    fn failed_downstream_step_preserves_outputs_and_hides_staging() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        let coordinator = SaveCoordinator::new();
        seed(&engine, "source", &[3, 1]);
        seed(&engine, "stable-first", &[99]);
        let stable_generation = engine.get_dataset_generation("stable-first").unwrap();
        let stable_hash = engine
            .workflow_table_content_hash("stable-first", stable_generation)
            .unwrap();
        let source_generation = engine.get_dataset_generation("source").unwrap();
        let source_hash = engine
            .workflow_table_content_hash("source", source_generation)
            .unwrap();
        let first = sort_step(
            &engine,
            "first",
            "source",
            "stable-first",
            stable_generation,
            "value",
        );
        let second = sort_step(
            &engine,
            "second",
            "stable-first",
            "stable-second",
            0,
            "missing",
        );

        let error = WorkflowTableExecutor::new(&engine, &coordinator)
            .execute(
                "run-1",
                &[first, second],
                &[FrozenTableInput {
                    table_document_id: "source".to_string(),
                    generation: source_generation,
                    content_hash: source_hash,
                }],
            )
            .unwrap_err();

        assert!(error.to_string().contains("missing"));
        assert_eq!(
            engine.get_dataset_generation("stable-first").unwrap(),
            stable_generation
        );
        assert_eq!(
            engine
                .workflow_table_content_hash("stable-first", stable_generation)
                .unwrap(),
            stable_hash
        );
        assert!(engine
            .list_datasets()
            .unwrap()
            .iter()
            .all(|dataset| !dataset.id.starts_with("__workflow_stage_")));
    }

    #[test]
    fn publishes_chained_table_outputs_together() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        let coordinator = SaveCoordinator::new();
        seed(&engine, "source", &[3, 1, 2]);
        let source_generation = engine.get_dataset_generation("source").unwrap();
        let source_hash = engine
            .workflow_table_content_hash("source", source_generation)
            .unwrap();
        let first = sort_step(&engine, "first", "source", "first-output", 0, "value");
        let mut second = sort_step(&engine, "second", "source", "second-output", 0, "value");
        second.binding.inputs[0].table_document_id = "first-output".to_string();

        let outputs = WorkflowTableExecutor::new(&engine, &coordinator)
            .execute(
                "run-chain",
                &[first, second],
                &[FrozenTableInput {
                    table_document_id: "source".to_string(),
                    generation: source_generation,
                    content_hash: source_hash,
                }],
            )
            .unwrap();

        assert_eq!(outputs.outputs.len(), 2);
        assert_eq!(outputs.output_hashes.len(), 2);
        assert_eq!(engine.get_dataset_generation("first-output").unwrap(), 0);
        assert_eq!(engine.get_dataset_generation("second-output").unwrap(), 0);
    }

    #[test]
    fn supports_two_input_and_ordered_multi_input_operations() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        let coordinator = SaveCoordinator::new();
        seed(&engine, "left", &[1, 2]);
        seed(&engine, "right", &[2, 3]);
        let join = operation_step(
            &engine,
            "join",
            TableTransformOperation::Join {
                join_type: JoinType::Inner,
                left_key: "value".to_string(),
                right_key: "value".to_string(),
            },
            &[("left", "left"), ("right", "right")],
            "join-output",
        );
        let concatenate = operation_step(
            &engine,
            "concatenate",
            TableTransformOperation::Concatenate { source_count: 2 },
            &[("source-1", "left"), ("source-2", "right")],
            "concatenate-output",
        );

        WorkflowTableExecutor::new(&engine, &coordinator)
            .execute("run-multi", &[join, concatenate], &[])
            .unwrap();

        assert_eq!(
            engine
                .query_table("concatenate-output", 0, 10, None, None)
                .unwrap()
                .rows
                .into_iter()
                .map(|row| row[1].clone())
                .collect::<Vec<_>>(),
            vec![
                serde_json::json!(1),
                serde_json::json!(2),
                serde_json::json!(2),
                serde_json::json!(3)
            ]
        );
    }

    #[test]
    fn stale_frozen_input_publishes_nothing() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        let coordinator = SaveCoordinator::new();
        seed(&engine, "source", &[2, 1]);
        let stale_generation = engine.get_dataset_generation("source").unwrap();
        let stale_hash = engine
            .workflow_table_content_hash("source", stale_generation)
            .unwrap();
        let row_id = engine.add_row("source").unwrap();
        engine.update_cell("source", row_id, "value", "3").unwrap();
        let step = sort_step(&engine, "sort", "source", "new-output", 0, "value");

        let error = WorkflowTableExecutor::new(&engine, &coordinator)
            .execute(
                "run-stale",
                &[step],
                &[FrozenTableInput {
                    table_document_id: "source".to_string(),
                    generation: stale_generation,
                    content_hash: stale_hash,
                }],
            )
            .unwrap_err();

        assert!(error.to_string().contains("stale workflow input"));
        assert!(engine.get_dataset_meta("new-output").is_err());
        assert!(engine
            .list_datasets()
            .unwrap()
            .iter()
            .all(|dataset| !dataset.id.starts_with("__workflow_stage_")));
    }

    #[test]
    fn executes_graph_workflow_as_one_commit_packet() {
        let state = AppState::new().expect("test state");
        seed(
            &state.db.lock().expect("test db lock"),
            "source",
            &[1, 2, 3],
        );
        let workflow: WorkflowDefinition = serde_json::from_value(serde_json::json!({
            "id": "workflow-graph",
            "name": "Graph workflow",
            "formatVersion": "1",
            "revision": 1,
            "inputSlots": [{
                "id": "input-source",
                "name": "Source",
                "outputPort": { "id": "input-source:out", "name": "table", "payloadKind": "table" },
                "schemaContract": {
                    "schemaFingerprint": "schema-hash",
                    "columns": [{
                        "name": "value",
                        "canonicalDuckdbType": "BIGINT",
                        "required": true,
                        "requiredByOperationIds": ["operation-graph"]
                    }]
                }
            }],
            "operations": [{
                "id": "operation-graph",
                "kind": "graphGeneration",
                "schemaVersion": "1",
                "configuration": {
                    "mode": "2d",
                    "activeState": {
                        "encoding": { "x": { "name": "value", "type": "continuous" } },
                        "multiX": [], "multiY": [], "elements": [], "smootherLambda": 0.5
                    },
                    "filters": [],
                    "sampling": { "mode": "full" },
                    "groupThemeSlots": {}
                },
                "inputPorts": [{ "id": "operation-graph:in", "name": "source", "payloadKind": "table" }],
                "outputPorts": [{ "id": "operation-graph:out", "name": "result", "payloadKind": "graph" }]
            }],
            "edges": [
                {
                    "id": "edge-input",
                    "kind": "consumes",
                    "source": { "nodeId": "input-source", "portId": "input-source:out" },
                    "target": { "nodeId": "operation-graph", "portId": "operation-graph:in" }
                },
                {
                    "id": "edge-output",
                    "kind": "produces",
                    "source": { "nodeId": "operation-graph", "portId": "operation-graph:out" },
                    "target": { "nodeId": "output-graph", "portId": "output-graph:in" }
                }
            ],
            "outputDeclarations": [{
                "id": "output-graph",
                "name": "Stable graph",
                "inputPort": { "id": "output-graph:in", "name": "input", "payloadKind": "graph" },
                "outputPort": { "id": "output-graph:out", "name": "output", "payloadKind": "graph" },
                "sourceEndpoint": { "nodeId": "operation-graph", "portId": "operation-graph:out" },
                "artifactKind": "graph"
            }]
        }))
        .expect("workflow fixture");

        let packet = WorkflowExecutor::new(&state)
            .execute(WorkflowRunRequest {
                workflow: workflow.clone(),
                input_bindings: vec![WorkflowInputBinding {
                    slot_id: "input-source".to_string(),
                    table_document_id: "source".to_string(),
                }],
                output_bindings: vec![WorkflowOutputBinding {
                    declaration_id: "output-graph".to_string(),
                    artifact_document_id: "stable-graph".to_string(),
                }],
                seed: 42,
                previous_runs: vec![],
            })
            .expect("workflow run");

        assert_eq!(
            packet.run.status,
            crate::services::workflow_domain::WorkflowRunStatus::Succeeded
        );
        assert_eq!(packet.run.input_fingerprints.len(), 1);
        assert_eq!(packet.run.output_fingerprints.len(), 1);
        assert_eq!(packet.documents.len(), 1);
        assert_eq!(packet.documents[0].source_table_id(), Some("source"));
        assert_eq!(
            packet.documents[0].validation_result_hash(),
            packet.run.output_fingerprints[0].content_hash
        );
        assert_eq!(packet.commit_id, packet.run.id);

        let failed = WorkflowExecutor::new(&state)
            .execute(WorkflowRunRequest {
                workflow,
                input_bindings: vec![WorkflowInputBinding {
                    slot_id: "input-source".to_string(),
                    table_document_id: "missing-source".to_string(),
                }],
                output_bindings: vec![WorkflowOutputBinding {
                    declaration_id: "output-graph".to_string(),
                    artifact_document_id: "stable-graph".to_string(),
                }],
                seed: 42,
                previous_runs: vec![],
            })
            .expect("failed Workflow packet");
        assert_eq!(
            failed.run.status,
            crate::services::workflow_domain::WorkflowRunStatus::Failed
        );
        assert!(failed.documents.is_empty());
        assert_eq!(failed.run.errors.len(), 1);
        assert!(failed.run.errors[0].message.contains("missing-source"));
    }

    #[test]
    fn executes_table_transform_into_graph_with_stable_references() {
        let state = AppState::new().expect("test state");
        let project_path =
            std::env::temp_dir().join(format!("workflow_recovery_{}.spprj", uuid::Uuid::new_v4()));
        let project_path_string = project_path.to_string_lossy().to_string();
        ProjectService::new(&state)
            .create_project("Workflow recovery", &project_path_string)
            .expect("create recovery project");
        seed(
            &state.db.lock().expect("test db lock"),
            "source",
            &[3, 1, 2],
        );
        let transform = {
            let engine = state.db.lock().expect("test db lock");
            sort_step(&engine, "op-sort", "source", "template-output", 0, "value").definition
        };
        let workflow: WorkflowDefinition = serde_json::from_value(serde_json::json!({
            "id": "workflow-transform-graph",
            "name": "Transform graph workflow",
            "formatVersion": "1",
            "revision": 1,
            "inputSlots": [{
                "id": "input-source",
                "name": "Source",
                "outputPort": { "id": "input-source:out", "name": "table", "payloadKind": "table" },
                "schemaContract": {
                    "schemaFingerprint": "schema-hash",
                    "columns": [{
                        "name": "value", "canonicalDuckdbType": "BIGINT", "required": true,
                        "requiredByOperationIds": ["op-sort", "op-graph"]
                    }]
                }
            }],
            "operations": [
                {
                    "id": "op-sort", "kind": "tableTransform", "schemaVersion": "1",
                    "configuration": transform,
                    "inputPorts": [{ "id": "op-sort:in", "name": "source", "payloadKind": "table" }],
                    "outputPorts": [{ "id": "op-sort:out", "name": "result", "payloadKind": "table" }]
                },
                {
                    "id": "op-graph", "kind": "graphGeneration", "schemaVersion": "1",
                    "configuration": {
                        "mode": "2d",
                        "activeState": { "encoding": { "x": { "name": "value", "type": "continuous" } }, "multiX": [], "multiY": [], "elements": [], "smootherLambda": 0.5 },
                        "filters": [], "sampling": { "mode": "full" }, "groupThemeSlots": {}
                    },
                    "inputPorts": [{ "id": "op-graph:in", "name": "source", "payloadKind": "table" }],
                    "outputPorts": [{ "id": "op-graph:out", "name": "result", "payloadKind": "graph" }]
                }
            ],
            "edges": [
                { "id": "edge-input", "kind": "consumes", "source": { "nodeId": "input-source", "portId": "input-source:out" }, "target": { "nodeId": "op-sort", "portId": "op-sort:in" } },
                { "id": "edge-table", "kind": "consumes", "source": { "nodeId": "op-sort", "portId": "op-sort:out" }, "target": { "nodeId": "op-graph", "portId": "op-graph:in" } },
                { "id": "edge-sort-output", "kind": "produces", "source": { "nodeId": "op-sort", "portId": "op-sort:out" }, "target": { "nodeId": "output-sort", "portId": "output-sort:in" } },
                { "id": "edge-graph-output", "kind": "produces", "source": { "nodeId": "op-graph", "portId": "op-graph:out" }, "target": { "nodeId": "output-graph", "portId": "output-graph:in" } }
            ],
            "outputDeclarations": [
                { "id": "output-sort", "name": "Sorted table", "inputPort": { "id": "output-sort:in", "name": "input", "payloadKind": "table" }, "outputPort": { "id": "output-sort:out", "name": "output", "payloadKind": "table" }, "sourceEndpoint": { "nodeId": "op-sort", "portId": "op-sort:out" }, "artifactKind": "table" },
                { "id": "output-graph", "name": "Sorted graph", "inputPort": { "id": "output-graph:in", "name": "input", "payloadKind": "graph" }, "outputPort": { "id": "output-graph:out", "name": "output", "payloadKind": "graph" }, "sourceEndpoint": { "nodeId": "op-graph", "portId": "op-graph:out" }, "artifactKind": "graph" }
            ]
        }))
        .expect("workflow fixture");

        let packet = WorkflowExecutor::new(&state)
            .execute(WorkflowRunRequest {
                workflow: workflow.clone(),
                input_bindings: vec![WorkflowInputBinding {
                    slot_id: "input-source".to_string(),
                    table_document_id: "source".to_string(),
                }],
                output_bindings: vec![
                    WorkflowOutputBinding {
                        declaration_id: "output-sort".to_string(),
                        artifact_document_id: "stable-sorted".to_string(),
                    },
                    WorkflowOutputBinding {
                        declaration_id: "output-graph".to_string(),
                        artifact_document_id: "stable-graph".to_string(),
                    },
                ],
                seed: 42,
                previous_runs: vec![],
            })
            .expect("workflow run");

        assert_eq!(
            packet.run.status,
            crate::services::workflow_domain::WorkflowRunStatus::Succeeded
        );
        assert_eq!(packet.documents.len(), 1);
        assert_eq!(packet.documents[0].source_table_id(), Some("stable-sorted"));
        assert_eq!(
            state
                .db
                .lock()
                .expect("test db lock")
                .get_dataset_generation("stable-sorted")
                .unwrap(),
            0,
        );
        assert!(state
            .db
            .lock()
            .expect("test db lock")
            .list_datasets()
            .unwrap()
            .iter()
            .all(|dataset| !dataset.id.starts_with("__workflow_stage_"),));
        assert_eq!(
            state
                .workflow_run_journal
                .lock()
                .expect("journal lock")
                .get(&packet.commit_id)
                .and_then(|entry| entry.packet.as_ref())
                .map(|committed| committed.commit_id.as_str()),
            Some(packet.commit_id.as_str()),
        );
        let (stable_generation, stable_hash) = {
            let engine = state.db.lock().expect("test db lock");
            let generation = engine.get_dataset_generation("stable-sorted").unwrap();
            let hash = engine
                .workflow_table_content_hash("stable-sorted", generation)
                .unwrap();
            (generation, hash)
        };
        let mut invalid_workflow = workflow;
        invalid_workflow
            .operations
            .iter_mut()
            .find(|operation| operation.id == "op-graph")
            .expect("Graph operation")
            .configuration = Some(serde_json::json!({}));
        let failed = WorkflowExecutor::new(&state)
            .execute(WorkflowRunRequest {
                workflow: invalid_workflow,
                input_bindings: vec![WorkflowInputBinding {
                    slot_id: "input-source".to_string(),
                    table_document_id: "source".to_string(),
                }],
                output_bindings: vec![
                    WorkflowOutputBinding {
                        declaration_id: "output-sort".to_string(),
                        artifact_document_id: "stable-sorted".to_string(),
                    },
                    WorkflowOutputBinding {
                        declaration_id: "output-graph".to_string(),
                        artifact_document_id: "stable-graph".to_string(),
                    },
                ],
                seed: 42,
                previous_runs: vec![],
            })
            .expect("failed Workflow packet");
        assert_eq!(
            failed.run.status,
            crate::services::workflow_domain::WorkflowRunStatus::Failed
        );
        assert!(failed.documents.is_empty());
        let engine = state.db.lock().expect("test db lock");
        assert_eq!(
            engine.get_dataset_generation("stable-sorted").unwrap(),
            stable_generation,
        );
        assert_eq!(
            engine
                .workflow_table_content_hash("stable-sorted", stable_generation)
                .unwrap(),
            stable_hash,
        );
        assert!(engine
            .list_datasets()
            .unwrap()
            .iter()
            .all(|dataset| !dataset.id.starts_with("__workflow_stage_")));
        drop(engine);

        let recovered = ProjectService::new(&state)
            .open_project(&project_path_string, None)
            .expect("recover committed Workflow run");
        assert_eq!(recovered.recovered_workflow_packets.len(), 1);
        assert_eq!(
            recovered.recovered_workflow_packets[0].commit_id,
            packet.commit_id
        );
        assert_eq!(
            state
                .db
                .lock()
                .expect("test db lock")
                .workflow_table_content_hash("stable-sorted", 0)
                .unwrap(),
            stable_hash,
        );
        let executor = WorkflowExecutor::new(&state);
        executor
            .acknowledge(&packet.commit_id)
            .expect("acknowledge commit");
        executor
            .acknowledge(&packet.commit_id)
            .expect("repeat acknowledgement");
        assert!(!state
            .workflow_run_journal
            .lock()
            .expect("journal lock")
            .contains_key(&packet.commit_id));
        std::fs::remove_file(project_path).expect("remove recovery project");
    }

    #[test]
    fn executes_document_branch_and_report_join_with_stable_references() {
        let state = AppState::new().expect("test state");
        {
            let engine = state.db.lock().expect("test db lock");
            engine
                .create_empty_table(
                    "branch-source",
                    "branch-source",
                    &["value".to_string(), "site".to_string()],
                    &["DOUBLE".to_string(), "VARCHAR".to_string()],
                )
                .expect("create source");
            engine
                .conn()
                .execute_batch(
                    r#"
                    INSERT INTO "dataset_branch_source" (_row_id, value, site) VALUES
                        (1, 1.0, 'A'), (2, 2.0, 'A'), (3, 3.0, 'B'), (4, 4.0, 'B');
                    UPDATE _meta_datasets SET row_count = 4 WHERE id = 'branch-source';
                    UPDATE _meta_columns SET role = 'nominal'
                        WHERE dataset_id = 'branch-source' AND col_name = 'site';
                    "#,
                )
                .expect("seed branch source");
        }
        let workflow: WorkflowDefinition = serde_json::from_value(serde_json::json!({
            "id": "workflow-branch",
            "name": "Branch workflow",
            "formatVersion": "1",
            "revision": 1,
            "inputSlots": [{
                "id": "input-source",
                "name": "Source",
                "outputPort": { "id": "input-source:out", "name": "table", "payloadKind": "table" },
                "schemaContract": {
                    "schemaFingerprint": "schema-hash",
                    "columns": [
                        { "name": "value", "canonicalDuckdbType": "DOUBLE", "required": true, "requiredByOperationIds": ["op-graph", "op-fit", "op-tabulate"] },
                        { "name": "site", "canonicalDuckdbType": "VARCHAR", "required": true, "requiredByOperationIds": ["op-fit", "op-tabulate"] }
                    ]
                }
            }],
            "operations": [
                {
                    "id": "op-graph", "kind": "graphGeneration", "schemaVersion": "1",
                    "configuration": {
                        "mode": "2d",
                        "activeState": { "encoding": { "x": { "name": "value", "type": "continuous" } }, "multiX": [], "multiY": [], "elements": [], "smootherLambda": 0.5 },
                        "filters": [], "sampling": { "mode": "full" }, "groupThemeSlots": {}
                    },
                    "inputPorts": [{ "id": "op-graph:in", "name": "source", "payloadKind": "table" }],
                    "outputPorts": [{ "id": "op-graph:out", "name": "result", "payloadKind": "graph" }]
                },
                {
                    "id": "op-fit", "kind": "analysisExecution", "schemaVersion": "1",
                    "configuration": {
                        "schemaVersion": 1, "analysisKind": "fitYByX", "configRevision": 1,
                        "source": { "datasetId": "original-source" },
                        "definition": {
                            "kind": "fitYByX",
                            "response": { "name": "value", "type": "continuous" },
                            "factor": { "name": "site", "type": "nominal" },
                            "personality": "oneway", "confidenceLevel": 0.95
                        },
                        "presentation": { "schemaVersion": 1, "layout": "fit-y-by-x-v1", "graph": null }
                    },
                    "inputPorts": [{ "id": "op-fit:in", "name": "source", "payloadKind": "table" }],
                    "outputPorts": [{ "id": "op-fit:out", "name": "result", "payloadKind": "analysis" }]
                },
                {
                    "id": "op-tabulate", "kind": "tabulate", "schemaVersion": "1",
                    "configuration": {
                        "sourceDatasetId": "original-source", "rowFields": ["site"], "columnFields": [],
                        "statistics": [{ "id": "mean-value", "field": "value", "kind": "mean" }],
                        "includeRowTotals": true, "includeColumnTotals": true
                    },
                    "inputPorts": [{ "id": "op-tabulate:in", "name": "source", "payloadKind": "table" }],
                    "outputPorts": [{ "id": "op-tabulate:out", "name": "result", "payloadKind": "tabulate" }]
                },
                {
                    "id": "op-report", "kind": "reportComposition", "schemaVersion": "1",
                    "configuration": {
                        "schemaVersion": 1,
                        "markdown": "{{sp-embed kind=\"graph\" id=\"original-graph\"}}\n{{sp-embed kind=\"fitYByX\" id=\"original-fit\"}}\n{{sp-embed kind=\"tabulate\" id=\"original-tabulate\"}}"
                    },
                    "inputPorts": [
                        { "id": "op-report:graph", "name": "graph:original-graph", "payloadKind": "graph" },
                        { "id": "op-report:fit", "name": "analysis:original-fit", "payloadKind": "analysis" },
                        { "id": "op-report:tabulate", "name": "tabulate:original-tabulate", "payloadKind": "tabulate" }
                    ],
                    "outputPorts": [{ "id": "op-report:out", "name": "result", "payloadKind": "report" }]
                }
            ],
            "edges": [
                { "id": "input-graph", "kind": "consumes", "source": { "nodeId": "input-source", "portId": "input-source:out" }, "target": { "nodeId": "op-graph", "portId": "op-graph:in" } },
                { "id": "input-fit", "kind": "consumes", "source": { "nodeId": "input-source", "portId": "input-source:out" }, "target": { "nodeId": "op-fit", "portId": "op-fit:in" } },
                { "id": "input-tabulate", "kind": "consumes", "source": { "nodeId": "input-source", "portId": "input-source:out" }, "target": { "nodeId": "op-tabulate", "portId": "op-tabulate:in" } },
                { "id": "graph-report", "kind": "consumes", "source": { "nodeId": "op-graph", "portId": "op-graph:out" }, "target": { "nodeId": "op-report", "portId": "op-report:graph" } },
                { "id": "fit-report", "kind": "consumes", "source": { "nodeId": "op-fit", "portId": "op-fit:out" }, "target": { "nodeId": "op-report", "portId": "op-report:fit" } },
                { "id": "tabulate-report", "kind": "consumes", "source": { "nodeId": "op-tabulate", "portId": "op-tabulate:out" }, "target": { "nodeId": "op-report", "portId": "op-report:tabulate" } },
                { "id": "graph-output", "kind": "produces", "source": { "nodeId": "op-graph", "portId": "op-graph:out" }, "target": { "nodeId": "out-graph", "portId": "out-graph:in" } },
                { "id": "fit-output", "kind": "produces", "source": { "nodeId": "op-fit", "portId": "op-fit:out" }, "target": { "nodeId": "out-fit", "portId": "out-fit:in" } },
                { "id": "tabulate-output", "kind": "produces", "source": { "nodeId": "op-tabulate", "portId": "op-tabulate:out" }, "target": { "nodeId": "out-tabulate", "portId": "out-tabulate:in" } },
                { "id": "report-output", "kind": "produces", "source": { "nodeId": "op-report", "portId": "op-report:out" }, "target": { "nodeId": "out-report", "portId": "out-report:in" } }
            ],
            "outputDeclarations": [
                { "id": "out-graph", "name": "Graph", "inputPort": { "id": "out-graph:in", "name": "input", "payloadKind": "graph" }, "outputPort": { "id": "out-graph:out", "name": "output", "payloadKind": "graph" }, "sourceEndpoint": { "nodeId": "op-graph", "portId": "op-graph:out" }, "artifactKind": "graph" },
                { "id": "out-fit", "name": "Analysis", "inputPort": { "id": "out-fit:in", "name": "input", "payloadKind": "analysis" }, "outputPort": { "id": "out-fit:out", "name": "output", "payloadKind": "analysis" }, "sourceEndpoint": { "nodeId": "op-fit", "portId": "op-fit:out" }, "artifactKind": "analysis" },
                { "id": "out-tabulate", "name": "Tabulate", "inputPort": { "id": "out-tabulate:in", "name": "input", "payloadKind": "tabulate" }, "outputPort": { "id": "out-tabulate:out", "name": "output", "payloadKind": "tabulate" }, "sourceEndpoint": { "nodeId": "op-tabulate", "portId": "op-tabulate:out" }, "artifactKind": "tabulate" },
                { "id": "out-report", "name": "Report", "inputPort": { "id": "out-report:in", "name": "input", "payloadKind": "report" }, "outputPort": { "id": "out-report:out", "name": "output", "payloadKind": "report" }, "sourceEndpoint": { "nodeId": "op-report", "portId": "op-report:out" }, "artifactKind": "report" }
            ]
        }))
        .expect("branch workflow fixture");
        let packet = WorkflowExecutor::new(&state)
            .execute(WorkflowRunRequest {
                workflow,
                input_bindings: vec![WorkflowInputBinding {
                    slot_id: "input-source".to_string(),
                    table_document_id: "branch-source".to_string(),
                }],
                output_bindings: [
                    ("out-graph", "stable-graph"),
                    ("out-fit", "stable-fit"),
                    ("out-tabulate", "stable-tabulate"),
                    ("out-report", "stable-report"),
                ]
                .into_iter()
                .map(
                    |(declaration_id, artifact_document_id)| WorkflowOutputBinding {
                        declaration_id: declaration_id.to_string(),
                        artifact_document_id: artifact_document_id.to_string(),
                    },
                )
                .collect(),
                seed: 42,
                previous_runs: vec![],
            })
            .expect("branch workflow run");

        assert_eq!(packet.documents.len(), 4);
        let report = packet
            .documents
            .iter()
            .find(|commit| matches!(commit, crate::services::workflow_document_executor::WorkflowDocumentCommit::Report { .. }))
            .expect("report commit");
        let crate::services::workflow_document_executor::WorkflowDocumentCommit::Report {
            markdown,
            dependency_ids,
            ..
        } = report
        else {
            unreachable!();
        };
        assert!(markdown.contains("id=\"stable-graph\""));
        assert!(markdown.contains("id=\"stable-fit\""));
        assert!(markdown.contains("id=\"stable-tabulate\""));
        assert_eq!(
            dependency_ids,
            &vec![
                "stable-graph".to_string(),
                "stable-fit".to_string(),
                "stable-tabulate".to_string(),
            ]
        );
    }
}

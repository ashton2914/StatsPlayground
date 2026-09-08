use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::table::DatasetMeta;
use crate::services::spprj_archive::{ProjectDocumentKind, ProjectDocumentRef, TableColumn};
use crate::services::table_transform_domain::{
    derive_input_contracts, validate_table_transform_definition, JoinType, SortDirection,
    SummaryStatistic, TableFilterComparisonOperator, TableFilterExpression,
    TableFilterLogicalOperator, TableFilterScalar, TableTransformDefinition, TableTransformDraft,
    TableTransformOperation, TableTransformOutput,
};
use crate::services::workflow_domain::{
    validate_lineage_graph, validate_schema_contract, ArtifactKind, ArtifactNode, LineageEdge,
    LineageEdgeKind, LineageEndpoint, LineageNode, LineagePort, OperationKind, OperationNode,
    PortPayloadKind, ProjectLineageGraph, SchemaValidationReport,
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidParam(message.into())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformInputBinding {
    pub role: String,
    pub table_document_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformProjectBinding {
    pub definition_id: String,
    pub definition_revision: u64,
    #[serde(default)]
    pub inputs: Vec<TableTransformInputBinding>,
    pub output_generation: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableTransformRunStatus {
    Succeeded,
    Failed,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformRoleSchemaReport {
    pub role: String,
    pub report: SchemaValidationReport,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformRunState {
    pub definition_revision: u64,
    pub status: TableTransformRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformExecutionResult {
    pub definition_id: String,
    pub status: TableTransformRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<DatasetMeta>,
    #[serde(default)]
    pub schema_reports: Vec<TableTransformRoleSchemaReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub binding: TableTransformProjectBinding,
    pub run_state: TableTransformRunState,
}

pub struct TableTransformService<'a> {
    engine: &'a DuckDbEngine,
}

impl<'a> TableTransformService<'a> {
    pub fn new(engine: &'a DuckDbEngine) -> Self {
        Self { engine }
    }

    pub fn create_from_draft(
        &self,
        draft: &TableTransformDraft,
        inputs: Vec<TableTransformInputBinding>,
        lineage: &mut ProjectLineageGraph,
    ) -> Result<(TableTransformDefinition, TableTransformExecutionResult), AppError> {
        let source_schemas = inputs
            .iter()
            .map(|input| {
                let columns = self
                    .engine
                    .get_user_columns(&input.table_document_id)?
                    .into_iter()
                    .map(|(name, col_type)| TableColumn {
                        name,
                        col_type,
                        width: None,
                        format: None,
                        extras: None,
                    })
                    .collect();
                Ok((input.role.clone(), columns))
            })
            .collect::<Result<HashMap<_, _>, AppError>>()?;
        let definition = TableTransformDefinition {
            id: Uuid::new_v4().to_string(),
            name: draft.name.clone(),
            format_version: "1".to_string(),
            revision: 1,
            operation: draft.operation.clone(),
            input_slots: derive_input_contracts(&draft.operation, &source_schemas)?,
            output: TableTransformOutput {
                table_document_id: Uuid::new_v4().to_string(),
                name: draft.output_name.clone(),
            },
        };
        let execution = self.create_and_run(&definition, inputs, lineage)?;
        Ok((definition, execution))
    }

    pub fn create_and_run(
        &self,
        definition: &TableTransformDefinition,
        inputs: Vec<TableTransformInputBinding>,
        lineage: &mut ProjectLineageGraph,
    ) -> Result<TableTransformExecutionResult, AppError> {
        self.run(
            definition,
            &TableTransformProjectBinding {
                definition_id: definition.id.clone(),
                definition_revision: definition.revision,
                inputs,
                output_generation: 0,
            },
            lineage,
        )
    }

    pub fn rebind_and_run(
        &self,
        definition: &TableTransformDefinition,
        binding: &TableTransformProjectBinding,
        role: &str,
        table_document_id: &str,
        lineage: &mut ProjectLineageGraph,
    ) -> Result<TableTransformExecutionResult, AppError> {
        if role.trim().is_empty() || table_document_id.trim().is_empty() {
            return Err(invalid("rebind role and table document id are required"));
        }
        let mut rebound = binding.clone();
        rebound
            .inputs
            .iter_mut()
            .find(|input| input.role == role)
            .ok_or_else(|| invalid(format!("unknown transform input role: {role}")))?
            .table_document_id = table_document_id.to_string();
        self.run(definition, &rebound, lineage)
    }

    pub fn run(
        &self,
        definition: &TableTransformDefinition,
        binding: &TableTransformProjectBinding,
        lineage: &mut ProjectLineageGraph,
    ) -> Result<TableTransformExecutionResult, AppError> {
        validate_table_transform_definition(definition)?;
        self.validate_binding(definition, binding)?;
        let inputs = binding
            .inputs
            .iter()
            .map(|input| (input.role.as_str(), input.table_document_id.as_str()))
            .collect::<HashMap<_, _>>();
        let reports = self.validate_schemas(definition, &inputs)?;
        if reports.iter().any(|item| !compatible(&item.report)) {
            return Ok(self.result(
                definition,
                binding.clone(),
                TableTransformRunStatus::Blocked,
                None,
                reports,
                None,
            ));
        }

        let temporary_id = Uuid::new_v4().to_string();
        let temporary_name = format!("{} refresh {temporary_id}", definition.output.name);
        if let Err(error) = self.dispatch(
            &temporary_id,
            &temporary_name,
            &definition.operation,
            &inputs,
        ) {
            let _ = self.engine.delete_dataset(&temporary_id);
            return Ok(self.result(
                definition,
                binding.clone(),
                TableTransformRunStatus::Failed,
                None,
                reports,
                Some(error.to_string()),
            ));
        }

        let next_lineage = match self.build_lineage(definition, binding, lineage) {
            Ok(next_lineage) => next_lineage,
            Err(error) => {
                let _ = self.engine.delete_dataset(&temporary_id);
                return Err(error);
            }
        };
        let output = match self.engine.replace_dataset_atomically(
            &definition.output.table_document_id,
            &temporary_id,
            &definition.output.name,
            binding.output_generation,
        ) {
            Ok(output) => output,
            Err(error) => {
                let _ = self.engine.delete_dataset(&temporary_id);
                return Err(error);
            }
        };
        let mut updated_binding = binding.clone();
        updated_binding.output_generation = output.generation;
        *lineage = next_lineage;
        Ok(self.result(
            definition,
            updated_binding,
            TableTransformRunStatus::Succeeded,
            Some(output),
            reports,
            None,
        ))
    }

    pub(crate) fn stage_for_workflow(
        &self,
        definition: &TableTransformDefinition,
        binding: &TableTransformProjectBinding,
        staging_id: &str,
    ) -> Result<DatasetMeta, AppError> {
        validate_table_transform_definition(definition)?;
        self.validate_binding(definition, binding)?;
        let inputs = binding
            .inputs
            .iter()
            .map(|input| (input.role.as_str(), input.table_document_id.as_str()))
            .collect::<HashMap<_, _>>();
        let reports = self.validate_schemas(definition, &inputs)?;
        if let Some(report) = reports.iter().find(|item| !compatible(&item.report)) {
            return Err(invalid(format!(
                "workflow transform {} input {} does not satisfy its schema contract",
                definition.id, report.role
            )));
        }
        self.dispatch(
            staging_id,
            &format!("__workflow_stage_{}", definition.id),
            &definition.operation,
            &inputs,
        )
    }

    fn validate_binding(
        &self,
        definition: &TableTransformDefinition,
        binding: &TableTransformProjectBinding,
    ) -> Result<(), AppError> {
        if binding.definition_id != definition.id {
            return Err(invalid(
                "transform binding references a different definition",
            ));
        }
        if binding.definition_revision != definition.revision {
            return Err(invalid("stale table transform definition revision"));
        }
        let expected = definition
            .input_slots
            .iter()
            .map(|slot| slot.role.as_str())
            .collect::<Vec<_>>();
        let actual = binding
            .inputs
            .iter()
            .map(|input| input.role.as_str())
            .collect::<Vec<_>>();
        if actual != expected {
            return Err(invalid(format!(
                "transform bindings must be ordered as {}",
                expected.join(", ")
            )));
        }
        if binding
            .inputs
            .iter()
            .any(|input| input.table_document_id.trim().is_empty())
        {
            return Err(invalid("transform input table document id is required"));
        }
        Ok(())
    }

    fn validate_schemas(
        &self,
        definition: &TableTransformDefinition,
        inputs: &HashMap<&str, &str>,
    ) -> Result<Vec<TableTransformRoleSchemaReport>, AppError> {
        definition
            .input_slots
            .iter()
            .map(|slot| {
                let table_id = inputs
                    .get(slot.role.as_str())
                    .ok_or_else(|| invalid(format!("missing binding for role {}", slot.role)))?;
                let columns = self
                    .engine
                    .get_user_columns(table_id)?
                    .into_iter()
                    .map(|(name, col_type)| TableColumn {
                        name,
                        col_type,
                        width: None,
                        format: None,
                        extras: None,
                    })
                    .collect::<Vec<_>>();
                Ok(TableTransformRoleSchemaReport {
                    role: slot.role.clone(),
                    report: validate_schema_contract(&slot.schema_contract, &columns),
                })
            })
            .collect()
    }

    fn dispatch(
        &self,
        id: &str,
        name: &str,
        operation: &TableTransformOperation,
        inputs: &HashMap<&str, &str>,
    ) -> Result<DatasetMeta, AppError> {
        let source = |role: &str| {
            inputs
                .get(role)
                .copied()
                .ok_or_else(|| invalid(format!("missing binding for role {role}")))
        };
        match operation {
            TableTransformOperation::Sort { sort_columns } => self.engine.sort_table(
                id,
                name,
                source("source")?,
                &sort_columns
                    .iter()
                    .map(|item| item.column.clone())
                    .collect::<Vec<_>>(),
                &sort_columns
                    .iter()
                    .map(|item| match item.direction {
                        SortDirection::Ascending => "asc".to_string(),
                        SortDirection::Descending => "desc".to_string(),
                    })
                    .collect::<Vec<_>>(),
            ),
            TableTransformOperation::Subset { columns, filter } => {
                let filter = filter.as_ref().map(render_filter).transpose()?;
                self.engine
                    .subset_table(id, name, source("source")?, columns, filter.as_deref())
            }
            TableTransformOperation::Transpose => {
                self.engine.transpose_table(id, name, source("source")?)
            }
            TableTransformOperation::Stack {
                stack_columns,
                id_columns,
            } => self
                .engine
                .stack_table(id, name, source("source")?, stack_columns, id_columns),
            TableTransformOperation::Split {
                split_column,
                value_column,
                id_columns,
            } => self.engine.split_table(
                id,
                name,
                source("source")?,
                split_column,
                value_column,
                id_columns,
            ),
            TableTransformOperation::Summary {
                statistic_columns,
                group_columns,
                statistics,
            } => self.engine.summary_table(
                id,
                name,
                source("source")?,
                statistic_columns,
                group_columns,
                &statistics
                    .iter()
                    .map(|statistic| summary_name(statistic).to_string())
                    .collect::<Vec<_>>(),
            ),
            TableTransformOperation::Join {
                join_type,
                left_key,
                right_key,
            } => self.engine.join_tables(
                id,
                name,
                source("left")?,
                source("right")?,
                join_name(join_type),
                left_key,
                right_key,
            ),
            TableTransformOperation::Update {
                match_column,
                update_columns,
            } => self.engine.copy_and_update_table(
                id,
                name,
                source("left")?,
                source("right")?,
                match_column,
                update_columns,
            ),
            TableTransformOperation::Concatenate { source_count } => {
                let source_ids = (1..=*source_count)
                    .map(|index| source(&format!("source-{index}")).map(str::to_string))
                    .collect::<Result<Vec<_>, _>>()?;
                self.engine.concatenate_tables(id, name, &source_ids)
            }
        }
    }

    fn build_lineage(
        &self,
        definition: &TableTransformDefinition,
        binding: &TableTransformProjectBinding,
        lineage: &ProjectLineageGraph,
    ) -> Result<ProjectLineageGraph, AppError> {
        let mut next = lineage.clone();
        let transform_ref = doc_ref(ProjectDocumentKind::TableTransform, &definition.id);
        let operation_id = find_node(&next, &transform_ref)
            .unwrap_or_else(|| format!("operation-table-transform-{}", definition.id));
        let output_ref = doc_ref(
            ProjectDocumentKind::Table,
            &definition.output.table_document_id,
        );
        let output_id = find_node(&next, &output_ref)
            .unwrap_or_else(|| format!("artifact-table-{}", definition.output.table_document_id));

        next.nodes.retain(|node| node_id(node) != operation_id);
        next.nodes.push(LineageNode::Operation(OperationNode {
            id: operation_id.clone(),
            kind: OperationKind::TableTransform,
            schema_version: definition.format_version.clone(),
            configuration: None,
            document_ref: Some(transform_ref),
            input_ports: binding
                .inputs
                .iter()
                .map(|input| LineagePort {
                    id: format!("{operation_id}-in-{}", input.role),
                    name: input.role.clone(),
                    payload_kind: PortPayloadKind::Table,
                })
                .collect(),
            output_ports: vec![LineagePort {
                id: format!("{operation_id}-out-table"),
                name: "output".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
        }));
        upsert_table_artifact(
            &mut next,
            &output_id,
            &definition.output.table_document_id,
            &definition.output.name,
        );
        next.edges.retain(|edge| {
            !(edge.kind == LineageEdgeKind::Consumes && edge.target.node_id == operation_id
                || edge.kind == LineageEdgeKind::Produces && edge.source.node_id == operation_id)
        });

        for input in &binding.inputs {
            let input_ref = doc_ref(ProjectDocumentKind::Table, &input.table_document_id);
            let input_id = find_node(&next, &input_ref)
                .unwrap_or_else(|| format!("artifact-table-{}", input.table_document_id));
            upsert_table_artifact(
                &mut next,
                &input_id,
                &input.table_document_id,
                &input.table_document_id,
            );
            next.edges.push(LineageEdge {
                id: format!("edge-{operation_id}-consumes-{}", input.role),
                kind: LineageEdgeKind::Consumes,
                source: LineageEndpoint {
                    node_id: input_id.clone(),
                    port_id: format!("{input_id}-out"),
                },
                target: LineageEndpoint {
                    node_id: operation_id.clone(),
                    port_id: format!("{operation_id}-in-{}", input.role),
                },
            });
        }
        next.edges.push(LineageEdge {
            id: format!("edge-{operation_id}-produces"),
            kind: LineageEdgeKind::Produces,
            source: LineageEndpoint {
                node_id: operation_id.clone(),
                port_id: format!("{operation_id}-out-table"),
            },
            target: LineageEndpoint {
                node_id: output_id.clone(),
                port_id: format!("{output_id}-in"),
            },
        });
        let known_documents = next
            .nodes
            .iter()
            .filter_map(|node| match node {
                LineageNode::Artifact(artifact) => Some(artifact.document_ref.clone()),
                LineageNode::Operation(operation) => operation.document_ref.clone(),
            })
            .collect::<HashSet<_>>();
        validate_lineage_graph(&next, &known_documents)?;
        Ok(next)
    }

    fn result(
        &self,
        definition: &TableTransformDefinition,
        binding: TableTransformProjectBinding,
        status: TableTransformRunStatus,
        output: Option<DatasetMeta>,
        schema_reports: Vec<TableTransformRoleSchemaReport>,
        error: Option<String>,
    ) -> TableTransformExecutionResult {
        let output_generation = output.as_ref().map(|item| item.generation);
        TableTransformExecutionResult {
            definition_id: definition.id.clone(),
            status: status.clone(),
            output,
            schema_reports,
            error: error.clone(),
            binding,
            run_state: TableTransformRunState {
                definition_revision: definition.revision,
                status,
                output_generation,
                error,
            },
        }
    }
}

fn compatible(report: &SchemaValidationReport) -> bool {
    report.missing_columns.is_empty() && report.type_mismatches.is_empty()
}

fn doc_ref(kind: ProjectDocumentKind, id: &str) -> ProjectDocumentRef {
    ProjectDocumentRef {
        kind,
        id: id.to_string(),
    }
}

fn node_id(node: &LineageNode) -> &str {
    match node {
        LineageNode::Artifact(artifact) => &artifact.id,
        LineageNode::Operation(operation) => &operation.id,
    }
}

fn find_node(graph: &ProjectLineageGraph, document_ref: &ProjectDocumentRef) -> Option<String> {
    graph.nodes.iter().find_map(|node| match node {
        LineageNode::Artifact(artifact) if &artifact.document_ref == document_ref => {
            Some(artifact.id.clone())
        }
        LineageNode::Operation(operation)
            if operation.document_ref.as_ref() == Some(document_ref) =>
        {
            Some(operation.id.clone())
        }
        _ => None,
    })
}

fn upsert_table_artifact(
    graph: &mut ProjectLineageGraph,
    id: &str,
    table_document_id: &str,
    name: &str,
) {
    graph.nodes.retain(|node| node_id(node) != id);
    graph.nodes.push(LineageNode::Artifact(ArtifactNode {
        id: id.to_string(),
        document_ref: doc_ref(ProjectDocumentKind::Table, table_document_id),
        name: name.to_string(),
        parent_folder_id: None,
        artifact_kind: ArtifactKind::Table,
        input_port: LineagePort {
            id: format!("{id}-in"),
            name: "input".to_string(),
            payload_kind: PortPayloadKind::Table,
        },
        output_port: LineagePort {
            id: format!("{id}-out"),
            name: "output".to_string(),
            payload_kind: PortPayloadKind::Table,
        },
        materialized_by_workflow_run_id: None,
    }));
}

fn join_name(value: &JoinType) -> &'static str {
    match value {
        JoinType::Inner => "inner",
        JoinType::Left => "left",
        JoinType::Right => "right",
        JoinType::Full => "full",
    }
}

fn summary_name(value: &SummaryStatistic) -> &'static str {
    match value {
        SummaryStatistic::N => "n",
        SummaryStatistic::Mean => "mean",
        SummaryStatistic::Std => "std",
        SummaryStatistic::Min => "min",
        SummaryStatistic::Max => "max",
        SummaryStatistic::Sum => "sum",
        SummaryStatistic::Median => "median",
    }
}

fn render_filter(expression: &TableFilterExpression) -> Result<String, AppError> {
    match expression {
        TableFilterExpression::Logical {
            operator,
            left,
            right,
        } => Ok(format!(
            "({} {} {})",
            render_filter(left)?,
            match operator {
                TableFilterLogicalOperator::And => "AND",
                TableFilterLogicalOperator::Or => "OR",
            },
            render_filter(right)?
        )),
        TableFilterExpression::Not { expression } => {
            Ok(format!("(NOT {})", render_filter(expression)?))
        }
        TableFilterExpression::Comparison {
            column,
            operator,
            value,
        } => Ok(format!(
            "{} {} {}",
            quote_identifier(column),
            match operator {
                TableFilterComparisonOperator::Equal => "=",
                TableFilterComparisonOperator::NotEqual => "<>",
                TableFilterComparisonOperator::GreaterThan => ">",
                TableFilterComparisonOperator::GreaterThanOrEqual => ">=",
                TableFilterComparisonOperator::LessThan => "<",
                TableFilterComparisonOperator::LessThanOrEqual => "<=",
            },
            render_scalar(value)?
        )),
        TableFilterExpression::IsNull { column, negated } => Ok(format!(
            "{} IS {}NULL",
            quote_identifier(column),
            if *negated { "NOT " } else { "" }
        )),
    }
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn render_scalar(value: &TableFilterScalar) -> Result<String, AppError> {
    match value {
        TableFilterScalar::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
        TableFilterScalar::Number(value) => {
            value
                .parse::<f64>()
                .map_err(|_| invalid("invalid persisted filter number"))?;
            Ok(value.clone())
        }
        TableFilterScalar::Boolean(value) => Ok(value.to_string().to_uppercase()),
        TableFilterScalar::Null => Ok("NULL".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::table_transform_domain::{
        derive_input_contracts, SortColumn, TableTransformInputSlot, TableTransformOutput,
    };

    fn seed(engine: &DuckDbEngine, id: &str, values: &[i64]) {
        engine
            .create_empty_table(id, id, &["value".to_string()], &["BIGINT".to_string()])
            .expect("create source");
        for value in values {
            let row = engine.add_row(id).expect("add source row");
            engine
                .update_cell(id, row, "value", &value.to_string())
                .expect("set source value");
        }
    }

    fn definition(engine: &DuckDbEngine) -> TableTransformDefinition {
        let columns = engine
            .get_user_columns("source-a")
            .expect("source columns")
            .into_iter()
            .map(|(name, col_type)| TableColumn {
                name,
                col_type,
                width: None,
                format: None,
                extras: None,
            })
            .collect();
        let operation = TableTransformOperation::Sort {
            sort_columns: vec![SortColumn {
                column: "value".to_string(),
                direction: SortDirection::Ascending,
            }],
        };
        TableTransformDefinition {
            id: "sort-transform".to_string(),
            name: "Reusable sort".to_string(),
            format_version: "1".to_string(),
            revision: 1,
            input_slots: derive_input_contracts(
                &operation,
                &HashMap::from([("source".to_string(), columns)]),
            )
            .expect("derive contract"),
            operation,
            output: TableTransformOutput {
                table_document_id: "stable-output".to_string(),
                name: "Sorted output".to_string(),
            },
        }
    }

    fn rich_seed(engine: &DuckDbEngine, id: &str, offset: i64) {
        let names = ["id", "grp", "a", "b", "label", "value"].map(str::to_string);
        engine
            .create_empty_table(id, id, &names, &vec!["VARCHAR".to_string(); names.len()])
            .expect("create rich source");
        for (row_index, label) in ["x", "y"].iter().enumerate() {
            let row = engine.add_row(id).expect("add rich row");
            let values = [
                "1".to_string(),
                "g1".to_string(),
                (10 + offset + row_index as i64).to_string(),
                (20 + offset + row_index as i64).to_string(),
                (*label).to_string(),
                (1 + offset + row_index as i64).to_string(),
            ];
            for (column, value) in names.iter().zip(values) {
                engine
                    .update_cell(id, row, column, &value)
                    .expect("set rich value");
            }
        }
    }

    fn slots_for(
        engine: &DuckDbEngine,
        operation: &TableTransformOperation,
        role_ids: &[(&str, &str)],
    ) -> Vec<TableTransformInputSlot> {
        let schemas = role_ids
            .iter()
            .map(|(role, id)| {
                let columns = engine
                    .get_user_columns(id)
                    .expect("role columns")
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
        derive_input_contracts(operation, &schemas).expect("derive role contracts")
    }

    #[test]
    fn rebind_refreshes_output_without_changing_its_table_id() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        seed(&engine, "source-a", &[3, 1]);
        seed(&engine, "source-b", &[9, 2]);
        let definition = definition(&engine);
        let service = TableTransformService::new(&engine);
        let mut lineage = ProjectLineageGraph::default();
        let first = service
            .create_and_run(
                &definition,
                vec![TableTransformInputBinding {
                    role: "source".to_string(),
                    table_document_id: "source-a".to_string(),
                }],
                &mut lineage,
            )
            .expect("first run");
        let output_id = first.output.as_ref().expect("first output").id.clone();
        let output_node = find_node(&lineage, &doc_ref(ProjectDocumentKind::Table, &output_id))
            .expect("output node");
        lineage.nodes.push(LineageNode::Operation(OperationNode {
            id: "analysis-1".to_string(),
            kind: OperationKind::GraphGeneration,
            schema_version: "1".to_string(),
            configuration: None,
            document_ref: None,
            input_ports: vec![LineagePort {
                id: "analysis-1-input".to_string(),
                name: "input".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
            output_ports: vec![],
        }));
        lineage.edges.push(LineageEdge {
            id: "edge-output-analysis".to_string(),
            kind: LineageEdgeKind::Consumes,
            source: LineageEndpoint {
                node_id: output_node.clone(),
                port_id: format!("{output_node}-out"),
            },
            target: LineageEndpoint {
                node_id: "analysis-1".to_string(),
                port_id: "analysis-1-input".to_string(),
            },
        });

        let second = service
            .rebind_and_run(
                &definition,
                &first.binding,
                "source",
                "source-b",
                &mut lineage,
            )
            .expect("rebound run");

        assert_eq!(second.output.as_ref().expect("second output").id, output_id);
        assert_eq!(second.output.as_ref().expect("second output").generation, 1);
        assert!(lineage
            .edges
            .iter()
            .any(|edge| edge.id == "edge-output-analysis"));
        assert!(lineage.edges.iter().any(|edge| {
            edge.kind == LineageEdgeKind::Consumes
                && edge.source.node_id == "artifact-table-source-b"
                && edge.target.node_id == "operation-table-transform-sort-transform"
        }));
    }

    #[test]
    fn dispatches_all_nine_transform_operations() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        rich_seed(&engine, "rich-left", 0);
        rich_seed(&engine, "rich-right", 100);
        let service = TableTransformService::new(&engine);
        let inputs = HashMap::from([
            ("source", "rich-left"),
            ("left", "rich-left"),
            ("right", "rich-right"),
            ("source-1", "rich-left"),
            ("source-2", "rich-right"),
        ]);
        let operations = vec![
            TableTransformOperation::Sort {
                sort_columns: vec![SortColumn {
                    column: "a".to_string(),
                    direction: SortDirection::Descending,
                }],
            },
            TableTransformOperation::Subset {
                columns: vec!["id".to_string(), "a".to_string()],
                filter: Some(TableFilterExpression::Comparison {
                    column: "a".to_string(),
                    operator: TableFilterComparisonOperator::GreaterThan,
                    value: TableFilterScalar::String("10".to_string()),
                }),
            },
            TableTransformOperation::Transpose,
            TableTransformOperation::Stack {
                stack_columns: vec!["a".to_string(), "b".to_string()],
                id_columns: vec!["id".to_string()],
            },
            TableTransformOperation::Split {
                split_column: "label".to_string(),
                value_column: "value".to_string(),
                id_columns: vec!["id".to_string()],
            },
            TableTransformOperation::Summary {
                statistic_columns: vec!["a".to_string()],
                group_columns: vec!["grp".to_string()],
                statistics: vec![SummaryStatistic::Mean],
            },
            TableTransformOperation::Join {
                join_type: JoinType::Inner,
                left_key: "id".to_string(),
                right_key: "id".to_string(),
            },
            TableTransformOperation::Update {
                match_column: "id".to_string(),
                update_columns: vec!["a".to_string()],
            },
            TableTransformOperation::Concatenate { source_count: 2 },
        ];

        for (index, operation) in operations.iter().enumerate() {
            let output_id = format!("operation-output-{index}");
            let output = service
                .dispatch(
                    &output_id,
                    &format!("Operation {index}"),
                    operation,
                    &inputs,
                )
                .unwrap_or_else(|error| panic!("operation {index} failed: {error}"));
            assert_eq!(output.id, output_id);
        }
    }

    #[test]
    fn incompatible_schema_blocks_before_creating_output() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        seed(&engine, "source-a", &[1]);
        rich_seed(&engine, "incompatible", 0);
        let definition = definition(&engine);
        let service = TableTransformService::new(&engine);
        let result = service
            .create_and_run(
                &definition,
                vec![TableTransformInputBinding {
                    role: "source".to_string(),
                    table_document_id: "incompatible".to_string(),
                }],
                &mut ProjectLineageGraph::default(),
            )
            .expect("blocked result");

        assert_eq!(result.status, TableTransformRunStatus::Blocked);
        assert!(result.output.is_none());
        assert!(engine.get_dataset_meta("stable-output").is_err());
    }

    #[test]
    fn failed_rerun_preserves_last_successful_output() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        seed(&engine, "source-a", &[3, 1]);
        let mut definition = definition(&engine);
        let service = TableTransformService::new(&engine);
        let mut lineage = ProjectLineageGraph::default();
        let first = service
            .create_and_run(
                &definition,
                vec![TableTransformInputBinding {
                    role: "source".to_string(),
                    table_document_id: "source-a".to_string(),
                }],
                &mut lineage,
            )
            .expect("first run");
        definition.operation = TableTransformOperation::Subset {
            columns: vec!["value".to_string()],
            filter: Some(TableFilterExpression::Comparison {
                column: "value".to_string(),
                operator: TableFilterComparisonOperator::GreaterThan,
                value: TableFilterScalar::Number("0); DROP TABLE x; --".to_string()),
            }),
        };

        let failed = service
            .run(&definition, &first.binding, &mut lineage)
            .expect("structured failed result");

        assert_eq!(failed.status, TableTransformRunStatus::Failed);
        assert_eq!(
            engine
                .get_dataset_meta("stable-output")
                .expect("old output")
                .generation,
            0
        );
    }

    #[test]
    fn stale_revision_is_rejected_before_execution() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        seed(&engine, "source-a", &[1]);
        let definition = definition(&engine);
        let service = TableTransformService::new(&engine);
        let error = service
            .run(
                &definition,
                &TableTransformProjectBinding {
                    definition_id: definition.id.clone(),
                    definition_revision: definition.revision + 1,
                    inputs: vec![TableTransformInputBinding {
                        role: "source".to_string(),
                        table_document_id: "source-a".to_string(),
                    }],
                    output_generation: 0,
                },
                &mut ProjectLineageGraph::default(),
            )
            .expect_err("stale revision must fail");

        assert!(error
            .to_string()
            .contains("stale table transform definition revision"));
    }

    #[test]
    fn lineage_preflight_failure_removes_temporary_output() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        seed(&engine, "source-a", &[1]);
        let definition = definition(&engine);
        let mut lineage = ProjectLineageGraph::default();
        lineage.edges.push(LineageEdge {
            id: "dangling".to_string(),
            kind: LineageEdgeKind::Consumes,
            source: LineageEndpoint {
                node_id: "missing-source".to_string(),
                port_id: "missing-source-out".to_string(),
            },
            target: LineageEndpoint {
                node_id: "missing-operation".to_string(),
                port_id: "missing-operation-in".to_string(),
            },
        });

        TableTransformService::new(&engine)
            .create_and_run(
                &definition,
                vec![TableTransformInputBinding {
                    role: "source".to_string(),
                    table_document_id: "source-a".to_string(),
                }],
                &mut lineage,
            )
            .expect_err("invalid lineage must fail");

        let datasets = engine.list_datasets().expect("list remaining datasets");
        assert_eq!(datasets.len(), 1);
        assert_eq!(datasets[0].id, "source-a");
    }

    #[test]
    fn update_service_keeps_both_inputs_unchanged() {
        let engine = DuckDbEngine::new_in_memory().expect("create transform engine");
        rich_seed(&engine, "update-left", 0);
        rich_seed(&engine, "update-right", 100);
        let operation = TableTransformOperation::Update {
            match_column: "id".to_string(),
            update_columns: vec!["a".to_string()],
        };
        let definition = TableTransformDefinition {
            id: "update-transform".to_string(),
            name: "Reusable update".to_string(),
            format_version: "1".to_string(),
            revision: 1,
            input_slots: slots_for(
                &engine,
                &operation,
                &[("left", "update-left"), ("right", "update-right")],
            ),
            operation,
            output: TableTransformOutput {
                table_document_id: "update-output".to_string(),
                name: "Updated output".to_string(),
            },
        };
        let before_left = engine.get_dataset_meta("update-left").expect("left meta");
        let before_right = engine.get_dataset_meta("update-right").expect("right meta");
        let result = TableTransformService::new(&engine)
            .create_and_run(
                &definition,
                vec![
                    TableTransformInputBinding {
                        role: "left".to_string(),
                        table_document_id: "update-left".to_string(),
                    },
                    TableTransformInputBinding {
                        role: "right".to_string(),
                        table_document_id: "update-right".to_string(),
                    },
                ],
                &mut ProjectLineageGraph::default(),
            )
            .expect("update run");

        assert_eq!(result.status, TableTransformRunStatus::Succeeded);
        assert_eq!(
            engine
                .get_dataset_meta("update-left")
                .expect("left after")
                .generation,
            before_left.generation
        );
        assert_eq!(
            engine
                .get_dataset_meta("update-right")
                .expect("right after")
                .generation,
            before_right.generation
        );
    }
}

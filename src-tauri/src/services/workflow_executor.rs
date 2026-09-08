use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::engine::duckdb_engine::{DatasetReplacement, DuckDbEngine};
use crate::error::AppError;
use crate::models::table::DatasetMeta;
use crate::services::save_coordinator::SaveCoordinator;
use crate::services::table_transform_domain::TableTransformDefinition;
use crate::services::table_transform_service::{
    TableTransformProjectBinding, TableTransformService,
};

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
        let service = TableTransformService::new(self.engine);
        let mut operation_ids = HashSet::new();
        let mut output_ids = HashSet::new();
        let mut staged_outputs: HashMap<String, String> = HashMap::new();
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
                staging_ids.push(staging_id.clone());
                staged_outputs.insert(stable_id.clone(), staging_id.clone());
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
        let outputs = self.engine.replace_datasets_atomically(&replacements);
        if outputs.is_err() {
            self.cleanup(&staging_ids);
        }
        Ok(WorkflowTableExecutionResult {
            outputs: outputs?,
            output_hashes,
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
    use crate::services::save_coordinator::SaveCoordinator;
    use crate::services::spprj_archive::TableColumn;
    use crate::services::table_transform_domain::{
        derive_input_contracts, JoinType, SortColumn, SortDirection, TableTransformDefinition,
        TableTransformOperation, TableTransformOutput,
    };
    use crate::services::table_transform_service::{
        TableTransformInputBinding, TableTransformProjectBinding,
    };

    use super::{FrozenTableInput, WorkflowTableExecutor, WorkflowTableStep};

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
}

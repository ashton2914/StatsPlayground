#[cfg(test)]
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use duckdb::params;

use crate::engine::duckdb_engine::{DuckDbEngine, UserColumnDescriptor};
use crate::error::AppError;
use crate::models::calculated_column::{
    definition_fingerprint, ArchivedCalculatedColumn, ArchivedCalculatedColumnState,
    CalculatedColumnDefinitionV1, CalculatedColumnMutationResult, CalculatedColumnStatus,
    CalculatedColumnValidationResult, CalculatedColumnWarningCount, CalculatedOutputTypeV1,
};
use crate::state::AppState;

use super::calculated_column_expression::{
    compile_formula_sql, parse_and_validate_formula, validate_formula_graph, FormulaColumn,
    FormulaError, FormulaSqlColumn, TypedCalculatedExpression, TypedCalculatedOutput,
};
use super::table_mutation_coordinator::{execute_table_mutation, TableMutationEffects};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpsertCalculatedColumnInput {
    pub dataset_id: String,
    pub output_name: String,
    pub formula_text: String,
    pub at_index: Option<i32>,
    pub output_column_id: Option<String>,
    pub formula_id: Option<String>,
    pub expected_generation: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteCalculatedColumnsInput {
    pub dataset_id: String,
    pub column_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConvertCalculatedColumnToValuesInput {
    pub dataset_id: String,
    pub formula_id: String,
    pub expected_generation: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedCalculatedColumnInput {
    pub dataset_id: String,
    pub output_name: String,
    pub formula_text: String,
    pub source_formula_id: String,
    pub source_output_column_id: String,
    pub source_column_id_map: HashMap<String, String>,
}

#[cfg(test)]
thread_local! {
    static MATERIALIZATION_FAILURE_AFTER_METADATA: RefCell<Option<usize>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn install_test_materialization_failure_after_metadata(
    remaining_outputs: Option<usize>,
) {
    MATERIALIZATION_FAILURE_AFTER_METADATA.with(|slot| {
        *slot.borrow_mut() = remaining_outputs;
    });
}

#[cfg(not(test))]
pub(crate) fn install_test_materialization_failure_after_metadata(
    _remaining_outputs: Option<usize>,
) {
}

fn maybe_fail_after_metadata() -> Result<(), AppError> {
    #[cfg(test)]
    {
        MATERIALIZATION_FAILURE_AFTER_METADATA.with(|slot| {
            let mut borrowed = slot.borrow_mut();
            match *borrowed {
                Some(remaining) if remaining <= 1 => {
                    *borrowed = None;
                    Err(AppError::Database(
                        "injected calculated materialization failure after metadata".into(),
                    ))
                }
                Some(remaining) => {
                    *borrowed = Some(remaining - 1);
                    Ok(())
                }
                None => Ok(()),
            }
        })
    }

    #[cfg(not(test))]
    {
        Ok(())
    }
}

struct TargetColumnPlan {
    dataset_id: String,
    column_id: String,
    previous_name: Option<String>,
    output_name: String,
    sql_type: String,
    col_index: i32,
    created: bool,
}

struct ValidationPlan {
    candidate_definition: CalculatedColumnDefinitionV1,
    target_column: TargetColumnPlan,
    all_definitions_by_output: BTreeMap<String, CalculatedColumnDefinitionV1>,
    affected_output_ids: Vec<String>,
}

pub struct CalculatedColumnService<'a> {
    state: &'a AppState,
}

impl<'a> CalculatedColumnService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn validate(
        &self,
        input: &UpsertCalculatedColumnInput,
    ) -> Result<CalculatedColumnValidationResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let plan = self.build_validation_plan(&db, input)?;
        Ok(CalculatedColumnValidationResult {
            status: CalculatedColumnStatus::Ready,
            diagnostics: Vec::new(),
            warning_count: CalculatedColumnWarningCount::default(),
            definition: plan.candidate_definition,
        })
    }

    pub fn upsert(
        &self,
        input: &UpsertCalculatedColumnInput,
    ) -> Result<CalculatedColumnMutationResult, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let (output_column_id, warning_count) = execute_table_mutation(
            &db,
            &input.dataset_id,
            input.expected_generation,
            |engine| {
                let plan = self.build_validation_plan(engine, input)?;
                let output_column_id = plan.target_column.column_id.clone();
                let warning_count =
                    self.validation_warning_count(engine, &input.dataset_id, &plan)?;
                self.apply_target_column(engine, &plan.target_column)?;
                engine.upsert_archived_calculated_column(
                    &input.dataset_id,
                    &plan.target_column.column_id,
                    &ArchivedCalculatedColumn::Ready {
                        definition: plan.candidate_definition.clone(),
                        state: ArchivedCalculatedColumnState::default(),
                    },
                )?;
                maybe_fail_after_metadata()?;

                Ok(TableMutationEffects {
                    value: (output_column_id.clone(), warning_count),
                    changed_column_ids: BTreeSet::from([output_column_id]),
                    change_set_id: Some(change_set_id.clone()),
                    recompute_column_ids: None,
                })
            },
        )?;
        let descriptor = db
            .get_table_column_descriptors(&input.dataset_id)?
            .into_iter()
            .find_map(|column| {
                column
                    .calculated
                    .filter(|calculated| calculated.output_column_id == output_column_id)
            })
            .ok_or_else(|| {
                AppError::Database("calculated descriptor missing after successful upsert".into())
            })?;
        let dataset_generation = db.get_dataset_generation(&input.dataset_id)?;
        Ok(CalculatedColumnMutationResult {
            column_id: output_column_id,
            dataset_generation,
            change_set_id,
            calculated: Some(descriptor),
            diagnostics: Vec::new(),
            warning_count,
        })
    }

    pub fn delete_columns(&self, input: &DeleteCalculatedColumnsInput) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let requested = input.column_ids.iter().cloned().collect::<HashSet<_>>();
        let definitions = self.ready_definitions_by_output(&db, &input.dataset_id)?;
        let blockers = dependency_blocker_paths(&definitions, &requested);
        if !blockers.is_empty() {
            return Err(AppError::InvalidParam(format!(
                "formula_dependency_in_use:{}",
                serde_json::to_string(&blockers)
                    .map_err(|error| AppError::InvalidParam(error.to_string()))?
            )));
        }

        let columns = db.get_user_column_descriptors(&input.dataset_id)?;
        let columns_by_id = columns
            .iter()
            .map(|column| (column.column_id.as_str(), column))
            .collect::<HashMap<_, _>>();
        let mut targets = requested
            .iter()
            .map(|column_id| {
                columns_by_id
                    .get(column_id.as_str())
                    .copied()
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!("unknown column id: {column_id}"))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        targets.sort_by(|left, right| right.col_index.cmp(&left.col_index));
        db.conn().execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<(), AppError> {
            for column in targets {
                let column_id = &column.column_id;
                let identifier = DuckDbEngine::quote_identifier(&column.name);
                let table_name = DuckDbEngine::quote_identifier(&format!(
                    "dataset_{}",
                    input.dataset_id.replace('-', "_")
                ));
                db.conn().execute(
                    &format!("ALTER TABLE {table_name} DROP COLUMN {identifier}"),
                    [],
                )?;
                db.conn().execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1 AND column_id = $2",
                    params![&input.dataset_id, column_id],
                )?;
                db.conn().execute(
                    "DELETE FROM _meta_columns WHERE dataset_id = $1 AND column_id = $2",
                    params![&input.dataset_id, column_id],
                )?;
                db.conn().execute(
                    "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = $1 AND col_index > $2",
                    params![&input.dataset_id, column.col_index],
                )?;
                db.conn().execute(
                    "UPDATE _meta_datasets SET col_count = col_count - 1 WHERE id = $1",
                    params![&input.dataset_id],
                )?;
            }
            db.bump_dataset_generation(&input.dataset_id)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                db.conn().execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = db.conn().execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn convert_to_values(
        &self,
        input: &ConvertCalculatedColumnToValuesInput,
    ) -> Result<(String, u64, String), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let output_column_id = execute_table_mutation(
            &db,
            &input.dataset_id,
            input.expected_generation,
            |engine| {
                let output_column_id = self.resolve_output_column_id_by_formula_id(
                    engine,
                    &input.dataset_id,
                    &input.formula_id,
                )?;
                if !engine.delete_calculated_metadata_by_formula_id(
                    &input.dataset_id,
                    &input.formula_id,
                )? {
                    return Err(AppError::InvalidParam(format!(
                        "unknown calculated formula id: {}",
                        input.formula_id
                    )));
                }
                Ok(TableMutationEffects {
                    value: output_column_id.clone(),
                    changed_column_ids: BTreeSet::from([output_column_id]),
                    change_set_id: Some(change_set_id.clone()),
                    recompute_column_ids: None,
                })
            },
        )?;
        let generation = db.get_dataset_generation(&input.dataset_id)?;
        Ok((output_column_id, generation, change_set_id))
    }

    fn resolve_output_column_id_by_formula_id(
        &self,
        db: &DuckDbEngine,
        dataset_id: &str,
        formula_id: &str,
    ) -> Result<String, AppError> {
        db.get_table_column_descriptors(dataset_id)?
            .into_iter()
            .find_map(|column| {
                column.calculated.and_then(|calculated| {
                    if calculated.formula_id == formula_id {
                        Some(calculated.output_column_id)
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| {
                AppError::InvalidParam(format!("unknown calculated formula id: {formula_id}"))
            })
    }

    pub fn remap_imported_formula(
        &self,
        input: &ImportedCalculatedColumnInput,
    ) -> Result<CalculatedColumnDefinitionV1, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let columns =
            formula_columns_from_descriptors(&db.get_user_column_descriptors(&input.dataset_id)?);
        let validated = parse_and_validate_formula(&input.formula_text, &columns, None, &[])
            .map_err(map_formula_error)?;
        let dependency_count = validated.definition.dependency_column_ids.len();
        if input.source_column_id_map.len() != dependency_count {
            return Err(AppError::InvalidParam(
                "standalone import requires a total source column id map".into(),
            ));
        }
        for target_column_id in input.source_column_id_map.values() {
            columns
                .iter()
                .find(|column| column.column_id == *target_column_id)
                .ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "standalone import map points to unknown target column {target_column_id}"
                    ))
                })?;
        }
        Ok(rebind_definition(
            validated.definition,
            input.source_formula_id.clone(),
            input.source_output_column_id.clone(),
        ))
    }

    fn build_validation_plan(
        &self,
        db: &DuckDbEngine,
        input: &UpsertCalculatedColumnInput,
    ) -> Result<ValidationPlan, AppError> {
        db.get_dataset_meta(&input.dataset_id)?;
        check_expected_generation(db, &input.dataset_id, input.expected_generation)?;
        if input.output_name.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "calculated output name cannot be empty".into(),
            ));
        }

        let user_columns = db.get_user_column_descriptors(&input.dataset_id)?;
        let formula_columns = formula_columns_from_descriptors(&user_columns);
        let existing_definitions_by_output =
            self.ready_definitions_by_output(db, &input.dataset_id)?;
        let mut target_column =
            resolve_target_column(input, &user_columns, &existing_definitions_by_output)?;
        let validated = parse_and_validate_formula(
            &input.formula_text,
            &formula_columns,
            Some(&target_column.column_id),
            &[],
        )
        .map_err(map_formula_error)?;
        let resolved_formula_id = input.formula_id.clone().or_else(|| {
            existing_definitions_by_output
                .get(&target_column.column_id)
                .map(|definition| definition.formula_id.clone())
        });
        let candidate_definition = rebind_definition(
            validated.definition,
            resolved_formula_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            target_column.column_id.clone(),
        );
        target_column.sql_type = sql_type_for_output(&candidate_definition.inferred_output_type);

        let existing_definitions = existing_definitions_by_output
            .into_values()
            .filter(|definition| {
                definition.output_column_id != candidate_definition.output_column_id
                    && definition.formula_id != candidate_definition.formula_id
            })
            .collect::<Vec<_>>();
        let graph = validate_formula_graph(
            &candidate_definition,
            &existing_definitions,
            &formula_columns,
        )
        .map_err(map_formula_error)?;

        let mut all_definitions_by_output = existing_definitions
            .iter()
            .cloned()
            .map(|definition| (definition.output_column_id.clone(), definition))
            .collect::<BTreeMap<_, _>>();
        all_definitions_by_output.insert(
            candidate_definition.output_column_id.clone(),
            candidate_definition.clone(),
        );

        let sql_columns = project_sql_columns(&user_columns, &target_column);
        for output_column_id in collect_downstream_outputs(
            &candidate_definition.output_column_id,
            &all_definitions_by_output,
        ) {
            let definition = all_definitions_by_output
                .get(&output_column_id)
                .ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "unknown calculated output id {output_column_id}"
                    ))
                })?;
            let typed_expression = typed_expression_from_definition(definition)?;
            let _ =
                compile_formula_sql(&typed_expression, &sql_columns).map_err(map_formula_error)?;
        }

        let affected_output_ids = topological_outputs(
            &collect_downstream_outputs(
                &candidate_definition.output_column_id,
                &all_definitions_by_output,
            ),
            &all_definitions_by_output,
        );
        if graph.topological_output_column_ids.is_empty() {
            return Err(AppError::InvalidParam(
                "calculated graph validation returned no outputs".into(),
            ));
        }

        Ok(ValidationPlan {
            candidate_definition,
            target_column,
            all_definitions_by_output,
            affected_output_ids,
        })
    }

    fn validation_warning_count(
        &self,
        db: &DuckDbEngine,
        dataset_id: &str,
        plan: &ValidationPlan,
    ) -> Result<CalculatedColumnWarningCount, AppError> {
        let table_name =
            DuckDbEngine::quote_identifier(&format!("dataset_{}", dataset_id.replace('-', "_")));
        let current_columns = db.get_user_column_descriptors(dataset_id)?;
        let sql_columns = project_sql_columns(&current_columns, &plan.target_column);
        let typed_expression = typed_expression_from_definition(&plan.candidate_definition)?;
        let compiled =
            compile_formula_sql(&typed_expression, &sql_columns).map_err(map_formula_error)?;
        if compiled.fault_predicates.is_empty() {
            return Ok(CalculatedColumnWarningCount::default());
        }
        let predicate = compiled
            .fault_predicates
            .iter()
            .map(|fault| format!("({fault})"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let count: i64 = db.conn().query_row(
            &format!("SELECT COUNT(*) FROM {table_name} WHERE {predicate}"),
            [],
            |row| row.get(0),
        )?;
        let count = u32::try_from(count)
            .map_err(|_| AppError::Database("warning count overflow".into()))?;
        Ok(CalculatedColumnWarningCount {
            total: count,
            validation: count,
            ..Default::default()
        })
    }

    fn apply_target_column(
        &self,
        db: &DuckDbEngine,
        target: &TargetColumnPlan,
    ) -> Result<(), AppError> {
        let dataset_table = DuckDbEngine::quote_identifier(&format!(
            "dataset_{}",
            target.dataset_id.replace('-', "_")
        ));
        let identifier = DuckDbEngine::quote_identifier(&target.output_name);
        if target.created {
            db.conn().execute(
                &format!(
                    "ALTER TABLE {dataset_table} ADD COLUMN {identifier} {}",
                    target.sql_type
                ),
                [],
            )?;
            db.conn().execute(
                "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = $1 AND col_index >= $2",
                params![&target.dataset_id, target.col_index],
            )?;
            db.conn().execute(
                "INSERT INTO _meta_columns (dataset_id, column_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4, $5)",
                params![
                    &target.dataset_id,
                    &target.column_id,
                    target.col_index,
                    &target.output_name,
                    &target.sql_type,
                ],
            )?;
            db.conn().execute(
                "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
                params![&target.dataset_id],
            )?;
            return Ok(());
        }

        let previous_name = target.previous_name.as_deref().ok_or_else(|| {
            AppError::InvalidParam("existing calculated target column missing previous name".into())
        })?;
        let previous_identifier = DuckDbEngine::quote_identifier(previous_name);
        if previous_name != target.output_name {
            db.conn().execute(
                &format!(
                    "ALTER TABLE {dataset_table} RENAME COLUMN {previous_identifier} TO {identifier}"
                ),
                [],
            )?;
        }
        db.conn().execute(
            &format!(
                "ALTER TABLE {dataset_table} ALTER COLUMN {identifier} SET DATA TYPE {} USING NULL::{}",
                target.sql_type, target.sql_type
            ),
            [],
        )?;
        db.conn().execute(
            "UPDATE _meta_columns SET col_name = $1, col_type = $2 WHERE dataset_id = $3 AND column_id = $4",
            params![&target.output_name, &target.sql_type, &target.dataset_id, &target.column_id],
        )?;
        Ok(())
    }

    fn ready_definitions_by_output(
        &self,
        db: &DuckDbEngine,
        dataset_id: &str,
    ) -> Result<BTreeMap<String, CalculatedColumnDefinitionV1>, AppError> {
        let archived = db.get_archived_calculated_columns_by_id(dataset_id)?;
        Ok(archived
            .into_values()
            .filter_map(|calculated| match calculated {
                ArchivedCalculatedColumn::Ready { definition, .. } => {
                    Some((definition.output_column_id.clone(), definition))
                }
                ArchivedCalculatedColumn::Preserved { .. } => None,
            })
            .collect())
    }

    fn materialize_outputs(
        &self,
        db: &DuckDbEngine,
        dataset_id: &str,
        plan: &ValidationPlan,
    ) -> Result<CalculatedColumnWarningCount, AppError> {
        let table_name =
            DuckDbEngine::quote_identifier(&format!("dataset_{}", dataset_id.replace('-', "_")));
        let current_columns = db.get_user_column_descriptors(dataset_id)?;
        let sql_columns = project_sql_columns(&current_columns, &plan.target_column);
        let mut warning_count = CalculatedColumnWarningCount::default();

        for output_column_id in &plan.affected_output_ids {
            let definition = plan
                .all_definitions_by_output
                .get(output_column_id)
                .ok_or_else(|| {
                    AppError::Database(format!(
                        "missing calculated definition for {output_column_id}"
                    ))
                })?;
            let typed_expression = typed_expression_from_definition(definition)?;
            let compiled =
                compile_formula_sql(&typed_expression, &sql_columns).map_err(map_formula_error)?;
            let output_column = sql_columns
                .iter()
                .find(|column| column.column_id == *output_column_id)
                .ok_or_else(|| {
                    AppError::Database(format!("missing SQL column binding for {output_column_id}"))
                })?;
            if !compiled.fault_predicates.is_empty() {
                let predicate = compiled
                    .fault_predicates
                    .iter()
                    .map(|fault| format!("({fault})"))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                let count: i64 = db.conn().query_row(
                    &format!("SELECT COUNT(*) FROM {table_name} WHERE {predicate}"),
                    [],
                    |row| row.get(0),
                )?;
                let count = u32::try_from(count)
                    .map_err(|_| AppError::Database("warning count overflow".into()))?;
                warning_count.total = warning_count.total.saturating_add(count);
                warning_count.validation = warning_count.validation.saturating_add(count);
            }
            let identifier = DuckDbEngine::quote_identifier(&output_column.physical_name);
            db.conn().execute(
                &format!(
                    "UPDATE {table_name} SET {identifier} = {}",
                    compiled.value_sql
                ),
                [],
            )?;
        }

        Ok(warning_count)
    }
}

fn map_formula_error(error: FormulaError) -> AppError {
    match error {
        FormulaError::Syntax { message }
        | FormulaError::Unsupported { message }
        | FormulaError::UnknownIdentifier {
            identifier: message,
        }
        | FormulaError::Type { message }
        | FormulaError::Limits { message } => AppError::InvalidParam(message),
        FormulaError::AmbiguousIdentifier {
            identifier,
            column_ids,
        } => AppError::InvalidParam(format!(
            "ambiguous identifier {identifier}: {}",
            column_ids.join(",")
        )),
        FormulaError::DependencyGraph { message, path } => {
            AppError::InvalidParam(format!("{message}: {}", path.join(" -> ")))
        }
    }
}

fn check_expected_generation(
    db: &DuckDbEngine,
    dataset_id: &str,
    expected_generation: Option<u64>,
) -> Result<(), AppError> {
    let Some(expected_generation) = expected_generation else {
        return Ok(());
    };
    let actual_generation = db.get_dataset_generation(dataset_id)?;
    if actual_generation != expected_generation {
        return Err(AppError::InvalidParam(format!(
            "stale dataset generation: expected {expected_generation}, found {actual_generation}"
        )));
    }
    Ok(())
}

fn formula_columns_from_descriptors(columns: &[UserColumnDescriptor]) -> Vec<FormulaColumn> {
    columns
        .iter()
        .map(|column| FormulaColumn {
            column_id: column.column_id.clone(),
            name: column.name.clone(),
            sql_type: column.sql_type.clone(),
        })
        .collect()
}

fn project_sql_columns(
    columns: &[UserColumnDescriptor],
    target: &TargetColumnPlan,
) -> Vec<FormulaSqlColumn> {
    let mut projected = columns
        .iter()
        .filter(|column| column.column_id != target.column_id)
        .map(|column| FormulaSqlColumn {
            column_id: column.column_id.clone(),
            sql_type: column.sql_type.clone(),
            physical_name: column.name.clone(),
        })
        .collect::<Vec<_>>();
    projected.push(FormulaSqlColumn {
        column_id: target.column_id.clone(),
        sql_type: target.sql_type.clone(),
        physical_name: target.output_name.clone(),
    });
    projected
}

fn resolve_target_column(
    input: &UpsertCalculatedColumnInput,
    columns: &[UserColumnDescriptor],
    existing_definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
) -> Result<TargetColumnPlan, AppError> {
    if let Some(output_column_id) = &input.output_column_id {
        let column = columns
            .iter()
            .find(|column| column.column_id == *output_column_id)
            .ok_or_else(|| {
                AppError::InvalidParam(format!("unknown output column id: {output_column_id}"))
            })?;
        return Ok(TargetColumnPlan {
            dataset_id: input.dataset_id.clone(),
            column_id: column.column_id.clone(),
            previous_name: Some(column.name.clone()),
            output_name: input.output_name.clone(),
            sql_type: column.sql_type.clone(),
            col_index: column.col_index,
            created: false,
        });
    }

    if let Some(column) = columns.iter().find(|column| {
        column.name.eq_ignore_ascii_case(&input.output_name)
            && existing_definitions_by_output.contains_key(&column.column_id)
    }) {
        return Ok(TargetColumnPlan {
            dataset_id: input.dataset_id.clone(),
            column_id: column.column_id.clone(),
            previous_name: Some(column.name.clone()),
            output_name: input.output_name.clone(),
            sql_type: column.sql_type.clone(),
            col_index: column.col_index,
            created: false,
        });
    }

    if columns
        .iter()
        .any(|column| column.name.eq_ignore_ascii_case(&input.output_name))
    {
        return Err(AppError::InvalidParam(format!(
            "column name already exists: {}",
            input.output_name
        )));
    }
    let column_count = i32::try_from(columns.len())
        .map_err(|_| AppError::InvalidParam("column count overflow".into()))?;
    Ok(TargetColumnPlan {
        dataset_id: input.dataset_id.clone(),
        column_id: uuid::Uuid::new_v4().to_string(),
        previous_name: None,
        output_name: input.output_name.clone(),
        sql_type: String::new(),
        col_index: input
            .at_index
            .unwrap_or(column_count)
            .clamp(0, column_count),
        created: true,
    })
}

fn sql_type_for_output(output_type: &CalculatedOutputTypeV1) -> String {
    match output_type {
        CalculatedOutputTypeV1::Boolean => "BOOLEAN".to_string(),
        CalculatedOutputTypeV1::Integer => "BIGINT".to_string(),
        CalculatedOutputTypeV1::Continuous
        | CalculatedOutputTypeV1::Null
        | CalculatedOutputTypeV1::Text
        | CalculatedOutputTypeV1::Unknown => "DOUBLE".to_string(),
    }
}

fn rebind_definition(
    mut definition: CalculatedColumnDefinitionV1,
    formula_id: String,
    output_column_id: String,
) -> CalculatedColumnDefinitionV1 {
    definition.formula_id = formula_id;
    definition.output_column_id = output_column_id;
    definition.fingerprint = definition_fingerprint(&definition);
    definition
}

fn typed_expression_from_definition(
    definition: &CalculatedColumnDefinitionV1,
) -> Result<TypedCalculatedExpression, AppError> {
    let output_type = match definition.inferred_output_type {
        CalculatedOutputTypeV1::Boolean => TypedCalculatedOutput::Boolean,
        CalculatedOutputTypeV1::Continuous => TypedCalculatedOutput::Double,
        CalculatedOutputTypeV1::Integer => TypedCalculatedOutput::BigInt,
        CalculatedOutputTypeV1::Null => TypedCalculatedOutput::Null,
        CalculatedOutputTypeV1::Text | CalculatedOutputTypeV1::Unknown => {
            return Err(AppError::InvalidParam(
                "calculated column output type is unsupported in v1".into(),
            ));
        }
    };
    Ok(TypedCalculatedExpression {
        expression: definition.expression.clone(),
        output_type,
    })
}

fn collect_downstream_outputs(
    root_output_id: &str,
    definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
) -> HashSet<String> {
    let mut affected = HashSet::from([root_output_id.to_string()]);
    let mut changed = true;
    while changed {
        changed = false;
        for definition in definitions_by_output.values() {
            if affected.contains(&definition.output_column_id) {
                continue;
            }
            if definition
                .dependency_column_ids
                .iter()
                .any(|dependency| affected.contains(dependency))
            {
                changed = affected.insert(definition.output_column_id.clone()) || changed;
            }
        }
    }
    affected
}

fn topological_outputs(
    affected: &HashSet<String>,
    definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
) -> Vec<String> {
    fn visit(
        output_id: &str,
        affected: &HashSet<String>,
        definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
        seen: &mut HashSet<String>,
        ordered: &mut Vec<String>,
    ) {
        if !affected.contains(output_id) || !seen.insert(output_id.to_string()) {
            return;
        }
        if let Some(definition) = definitions_by_output.get(output_id) {
            for dependency in &definition.dependency_column_ids {
                if affected.contains(dependency) {
                    visit(dependency, affected, definitions_by_output, seen, ordered);
                }
            }
        }
        ordered.push(output_id.to_string());
    }

    let mut seen = HashSet::new();
    let mut ordered = Vec::new();
    for output_id in affected {
        visit(
            output_id,
            affected,
            definitions_by_output,
            &mut seen,
            &mut ordered,
        );
    }
    ordered
}

fn dependency_blocker_paths(
    definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
    targets: &HashSet<String>,
) -> Vec<Vec<String>> {
    fn walk(
        output_id: &str,
        definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
        targets: &HashSet<String>,
        stack: &mut Vec<String>,
        blockers: &mut Vec<Vec<String>>,
    ) {
        let Some(definition) = definitions_by_output.get(output_id) else {
            return;
        };
        stack.push(output_id.to_string());
        for dependency in &definition.dependency_column_ids {
            if targets.contains(dependency) {
                let mut path = stack.clone();
                path.push(dependency.clone());
                blockers.push(path);
            }
            if definitions_by_output.contains_key(dependency) {
                walk(dependency, definitions_by_output, targets, stack, blockers);
            }
        }
        stack.pop();
    }

    let mut blockers = Vec::new();
    for output_id in definitions_by_output.keys() {
        if targets.contains(output_id) {
            continue;
        }
        walk(
            output_id,
            definitions_by_output,
            targets,
            &mut Vec::new(),
            &mut blockers,
        );
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::error::AppError;
    use crate::models::calculated_column::{
        CalculatedColumnDescriptor, CalculatedColumnMutationResult, CalculatedColumnStatus,
    };
    use crate::models::table::{CellUpdate, ColumnDescriptor, CreateTableFromRowsRequest};
    use crate::services::calculated_column_expression::FormulaColumn;
    use crate::services::data_service::DataService;
    use crate::state::AppState;

    #[derive(Clone, Debug, PartialEq)]
    struct DatasetSnapshot {
        generation: u64,
        descriptors: Vec<serde_json::Value>,
        rows: Vec<Vec<serde_json::Value>>,
    }

    fn seeded_state() -> (AppState, String) {
        let state = AppState::new().expect("state");
        let dataset_id = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Calculated Lifecycle".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Width".to_string(),
                    "Flag".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "BOOLEAN".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(2.0),
                        serde_json::json!(3.0),
                        serde_json::json!(true),
                    ],
                    vec![
                        serde_json::json!(4.0),
                        serde_json::json!(5.0),
                        serde_json::json!(false),
                    ],
                ],
            })
            .expect("seed dataset")
            .id;
        (state, dataset_id)
    }

    fn column_descriptors(state: &AppState, dataset_id: &str) -> Vec<ColumnDescriptor> {
        DataService::new(state)
            .get_column_descriptors(dataset_id)
            .expect("column descriptors")
    }

    fn formula_columns(state: &AppState, dataset_id: &str) -> Vec<FormulaColumn> {
        column_descriptors(state, dataset_id)
            .into_iter()
            .map(|column| FormulaColumn {
                column_id: column.column_id,
                name: column.name,
                sql_type: column.sql_type,
            })
            .collect()
    }

    fn column_id(state: &AppState, dataset_id: &str, name: &str) -> String {
        column_descriptors(state, dataset_id)
            .into_iter()
            .find(|column| column.name == name)
            .unwrap_or_else(|| panic!("missing column {name}"))
            .column_id
    }

    fn snapshot_state(state: &AppState, dataset_id: &str) -> DatasetSnapshot {
        let data_service = DataService::new(state);
        DatasetSnapshot {
            generation: data_service
                .get_dataset_generation(dataset_id)
                .expect("dataset generation"),
            descriptors: data_service
                .get_column_descriptors(dataset_id)
                .expect("dataset descriptors")
                .into_iter()
                .map(|descriptor| serde_json::to_value(descriptor).expect("serialize descriptor"))
                .collect(),
            rows: data_service
                .query_table(dataset_id, 0, 100, None, None)
                .expect("dataset rows")
                .rows,
        }
    }

    fn meta_columns(state: &AppState, dataset_id: &str) -> Vec<(String, i32, String)> {
        let db = state.db.lock().expect("db");
        let mut statement = db
            .conn()
            .prepare(
                "SELECT column_id, col_index, col_name
                 FROM _meta_columns
                 WHERE dataset_id = $1
                 ORDER BY col_index",
            )
            .expect("prepare meta column query");
        statement
            .query_map(duckdb::params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query meta columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect meta columns")
    }

    fn numeric_values(state: &AppState, dataset_id: &str, column_name: &str) -> Vec<f64> {
        let table = DataService::new(state)
            .query_table(dataset_id, 0, 100, None, None)
            .expect("table values");
        let column_index = table
            .columns
            .iter()
            .position(|candidate| candidate == column_name)
            .unwrap_or_else(|| panic!("missing value column {column_name}"));
        table
            .rows
            .into_iter()
            .map(|row| {
                row[column_index]
                    .as_f64()
                    .unwrap_or_else(|| panic!("expected numeric value in {column_name}"))
            })
            .collect()
    }

    fn calculated_descriptor(
        result: &CalculatedColumnMutationResult,
    ) -> &CalculatedColumnDescriptor {
        result
            .calculated
            .as_ref()
            .expect("mutation result should include calculated metadata")
    }

    fn new_formula(
        dataset_id: &str,
        output_name: &str,
        formula_text: &str,
    ) -> UpsertCalculatedColumnInput {
        UpsertCalculatedColumnInput {
            dataset_id: dataset_id.to_string(),
            output_name: output_name.to_string(),
            formula_text: formula_text.to_string(),
            at_index: None,
            output_column_id: None,
            formula_id: None,
            expected_generation: None,
        }
    }

    #[test]
    fn calculated_column_service_chained_columns_materialize_in_topological_order() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);

        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create area formula");
        let doubled = service
            .upsert(&new_formula(&dataset_id, "DoubleArea", "Area * 2"))
            .expect("create dependent formula");

        assert_eq!(numeric_values(&state, &dataset_id, "Area"), vec![6.0, 20.0]);
        assert_eq!(
            numeric_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0, 40.0]
        );
        assert_eq!(area.column_id, column_id(&state, &dataset_id, "Area"));
        assert_eq!(
            doubled.column_id,
            column_id(&state, &dataset_id, "DoubleArea")
        );
    }

    #[test]
    fn calculated_materialization_failed_upsert_rolls_back_schema_metadata_values_and_generation() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        install_test_materialization_failure_after_metadata(Some(1));
        let result = service.upsert(&new_formula(&dataset_id, "Area", "Length * Width"));
        install_test_materialization_failure_after_metadata(None);

        assert!(matches!(result, Err(AppError::Database(_))));
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_column_service_validate_is_side_effect_free() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        let validated = service
            .validate(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("validate formula without mutation");

        assert_eq!(validated.status, CalculatedColumnStatus::Ready);
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_column_service_validate_rejects_stale_generation_without_mutation() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);
        let stale_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        DataService::new(&state)
            .update_cells(
                &dataset_id,
                &[CellUpdate {
                    row_id: 1,
                    column_name: "Length".to_string(),
                    value: Some("8".to_string()),
                }],
                None,
            )
            .expect("bump dataset generation");
        let before_validate = snapshot_state(&state, &dataset_id);
        let mut request = new_formula(&dataset_id, "Area", "Length * Width");
        request.expected_generation = Some(stale_generation);

        let error = service
            .validate(&request)
            .expect_err("stale generation must be rejected");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
        );
        assert_ne!(before_validate, before);
        assert_eq!(snapshot_state(&state, &dataset_id), before_validate);
    }

    #[test]
    fn calculated_column_service_validate_does_not_scan_warning_counts_or_mutate() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        DataService::new(&state)
            .update_cells(
                &dataset_id,
                &[CellUpdate {
                    row_id: 2,
                    column_name: "Width".to_string(),
                    value: Some("0".to_string()),
                }],
                None,
            )
            .expect("introduce divisor warning");
        let before = snapshot_state(&state, &dataset_id);

        let validated = service
            .validate(&new_formula(&dataset_id, "Ratio", "Length / Width"))
            .expect("validate formula with warning predicates");

        assert_eq!(validated.status, CalculatedColumnStatus::Ready);
        assert_eq!(validated.warning_count.total, 0);
        assert_eq!(validated.warning_count.validation, 0);
        assert!(validated.diagnostics.is_empty());
        assert_eq!(snapshot_state(&state, &dataset_id), before);

        let upserted = service
            .upsert(&new_formula(&dataset_id, "Ratio", "Length / Width"))
            .expect("upsert should still report data-dependent warning counts");
        assert_eq!(upserted.warning_count.total, 1);
        assert_eq!(upserted.warning_count.validation, 1);
    }

    #[test]
    fn calculated_column_service_validate_ignores_fault_rows_without_mutation() {
        let state = AppState::new().expect("state");
        let dataset_id = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Validation Faults".to_string(),
                column_names: vec!["Value".to_string(), "Divisor".to_string()],
                column_types: vec!["BIGINT".to_string(), "BIGINT".to_string()],
                rows: vec![
                    vec![serde_json::json!(1), serde_json::json!(0)],
                    vec![serde_json::json!(i64::MAX), serde_json::json!(1)],
                ],
            })
            .expect("seed faulting dataset")
            .id;
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        let validated = service
            .validate(&new_formula(&dataset_id, "Quotient", "Value / Divisor"))
            .expect("validate faulting formula without mutation");

        assert_eq!(validated.status, CalculatedColumnStatus::Ready);
        assert_eq!(validated.warning_count.total, 0);
        assert_eq!(validated.warning_count.validation, 0);
        assert!(validated.diagnostics.is_empty());
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_column_service_validate_rejects_downstream_type_incompatibility_without_mutation()
    {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create upstream formula");
        service
            .upsert(&new_formula(&dataset_id, "DoubleArea", "Area * 2"))
            .expect("create downstream formula");
        let before = snapshot_state(&state, &dataset_id);

        let mut request = new_formula(&dataset_id, "Area", "Length > Width");
        request.formula_id = Some(calculated_descriptor(&area).formula_id.clone());
        request.output_column_id = Some(area.column_id.clone());

        let error = service
            .validate(&request)
            .expect_err("downstream type incompatibility must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_column_service_creates_new_formula_at_requested_index() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let mut request = new_formula(&dataset_id, "Area", "Length * Width");
        request.at_index = Some(1);

        service.upsert(&request).expect("create formula at index");

        let names = column_descriptors(&state, &dataset_id)
            .into_iter()
            .map(|column| column.name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Length", "Area", "Width", "Flag"]);
    }

    #[test]
    fn calculated_column_service_converts_ordinary_column_to_calculated_in_place() {
        let (state, dataset_id) = seeded_state();
        let data_service = DataService::new(&state);
        data_service
            .add_column(&dataset_id, "Area", "DOUBLE")
            .expect("seed ordinary target column");
        let seeded_column_id = column_id(&state, &dataset_id, "Area");
        let service = CalculatedColumnService::new(&state);
        let mut request = new_formula(&dataset_id, "Area", "Length * Width");
        request.output_column_id = Some(seeded_column_id.clone());

        let result = service
            .upsert(&request)
            .expect("convert ordinary to calculated");

        assert_eq!(result.column_id, seeded_column_id);
        assert_eq!(numeric_values(&state, &dataset_id, "Area"), vec![6.0, 20.0]);
    }

    #[test]
    fn calculated_column_service_edit_formula_can_change_type() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let created = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create numeric formula");

        let mut edit = new_formula(&dataset_id, "Area", "Length > Width");
        edit.formula_id = Some(calculated_descriptor(&created).formula_id.clone());
        edit.output_column_id = Some(created.column_id.clone());
        let edited = service
            .upsert(&edit)
            .expect("edit formula with type change");

        assert_eq!(
            calculated_descriptor(&edited).formula_id,
            calculated_descriptor(&created).formula_id
        );
        assert_eq!(edited.column_id, created.column_id);
        assert_eq!(
            calculated_descriptor(&edited).inferred_output_type.as_str(),
            "boolean"
        );
    }

    #[test]
    fn calculated_column_service_rename_and_reorder_keep_formula_fingerprint_stable() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let created = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create formula");
        let data_service = DataService::new(&state);
        data_service
            .alter_column_with_change_set(&dataset_id, "Length", "LengthMm", "DOUBLE", None)
            .expect("rename dependency column");
        data_service
            .reorder_column_if_generation(
                &dataset_id,
                2,
                0,
                data_service
                    .get_dataset_generation(&dataset_id)
                    .expect("post-rename generation"),
            )
            .expect("reorder columns");

        let descriptor = column_descriptors(&state, &dataset_id)
            .into_iter()
            .find_map(|column| column.calculated)
            .expect("calculated descriptor remains present");
        assert_eq!(
            descriptor.fingerprint,
            calculated_descriptor(&created).fingerprint
        );
    }

    #[test]
    fn calculated_column_service_rejects_direct_and_transitive_cycles() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create base formula");
        service
            .upsert(&new_formula(&dataset_id, "Perimeter", "Area + Width"))
            .expect("create dependent formula");

        let mut direct_cycle = new_formula(&dataset_id, "Area", "Area + 1");
        direct_cycle.formula_id = Some(calculated_descriptor(&area).formula_id.clone());
        direct_cycle.output_column_id = Some(area.column_id.clone());
        let direct_error = service
            .validate(&direct_cycle)
            .expect_err("direct self-cycle must be rejected");

        let mut transitive_cycle = new_formula(&dataset_id, "Area", "Perimeter + 1");
        transitive_cycle.formula_id = Some(calculated_descriptor(&area).formula_id.clone());
        transitive_cycle.output_column_id = Some(area.column_id.clone());
        let transitive_error = service
            .validate(&transitive_cycle)
            .expect_err("transitive cycle must be rejected");

        assert!(matches!(direct_error, AppError::InvalidParam(_)));
        assert!(matches!(transitive_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn calculated_materialization_reports_stable_warning_counts_for_faulty_rows() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let result = service
            .upsert(&new_formula(&dataset_id, "Ratio", "Length / Width"))
            .expect("create ratio formula");

        assert_eq!(result.warning_count.total, 0);

        DataService::new(&state)
            .update_cells(
                &dataset_id,
                &[CellUpdate {
                    row_id: 2,
                    column_name: "Width".to_string(),
                    value: Some("0".to_string()),
                }],
                None,
            )
            .expect("introduce faulting divisor");

        let updated = service
            .upsert(&new_formula(&dataset_id, "Ratio", "Length / Width"))
            .expect("refresh ratio formula");
        assert_eq!(updated.warning_count.total, 1);
        assert_eq!(updated.warning_count.validation, 1);
    }

    #[test]
    fn calculated_column_service_rejects_backend_mutation_of_materialized_output() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create formula");

        let err = DataService::new(&state)
            .update_cells(
                &dataset_id,
                &[CellUpdate {
                    row_id: 1,
                    column_name: "Area".to_string(),
                    value: Some("999".to_string()),
                }],
                None,
            )
            .expect_err("calculated output column must be backend read-only");

        assert!(matches!(err, AppError::InvalidParam(_)));
    }

    #[test]
    fn calculated_delete_blocks_direct_and_transitive_dependency_paths() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create area formula");
        let doubled = service
            .upsert(&new_formula(&dataset_id, "DoubleArea", "Area * 2"))
            .expect("create dependent formula");
        service
            .upsert(&new_formula(&dataset_id, "TripleArea", "DoubleArea + Area"))
            .expect("create transitive dependent formula");

        let direct = service
            .delete_columns(&DeleteCalculatedColumnsInput {
                dataset_id: dataset_id.clone(),
                column_ids: vec![area.column_id.clone()],
            })
            .expect_err("direct dependency delete must be blocked");
        let transitive = service
            .delete_columns(&DeleteCalculatedColumnsInput {
                dataset_id: dataset_id.clone(),
                column_ids: vec![doubled.column_id.clone()],
            })
            .expect_err("transitive dependency delete must be blocked");

        assert!(
            matches!(direct, AppError::InvalidParam(message) if message.contains("formula_dependency_in_use"))
        );
        assert!(
            matches!(transitive, AppError::InvalidParam(message) if message.contains("formula_dependency_in_use"))
        );
    }

    #[test]
    fn calculated_delete_allows_unreferenced_formula_column_removal() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create formula");

        service
            .delete_columns(&DeleteCalculatedColumnsInput {
                dataset_id: dataset_id.clone(),
                column_ids: vec![area.column_id.clone()],
            })
            .expect("delete unreferenced formula column");

        let names = column_descriptors(&state, &dataset_id)
            .into_iter()
            .map(|column| column.name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Length", "Width", "Flag"]);
    }

    #[test]
    fn calculated_delete_multiple_nonadjacent_columns_keeps_contiguous_meta_order() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Area".to_string(),
                formula_text: "Length * Width".to_string(),
                at_index: Some(1),
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create area at index 1");
        let sum = service
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Sum".to_string(),
                formula_text: "Length + Width".to_string(),
                at_index: Some(3),
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create sum");
        let delta = service
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Delta".to_string(),
                formula_text: "Length - Width".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create delta at end");

        service
            .delete_columns(&DeleteCalculatedColumnsInput {
                dataset_id: dataset_id.clone(),
                column_ids: vec![area.column_id.clone(), sum.column_id.clone()],
            })
            .expect("delete nonadjacent calculated columns");

        let columns = meta_columns(&state, &dataset_id);
        assert_eq!(
            columns
                .iter()
                .map(|(_, col_index, name)| (*col_index, name.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "Length"), (1, "Width"), (2, "Flag"), (3, "Delta")]
        );
        assert_eq!(columns[3].0, delta.column_id);
    }

    #[test]
    fn calculated_column_service_validate_ignores_bigint_overflow_rows_without_mutation() {
        let state = AppState::new().expect("state");
        let dataset_id = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Overflow Faults".to_string(),
                column_names: vec!["Value".to_string(), "Increment".to_string()],
                column_types: vec!["BIGINT".to_string(), "BIGINT".to_string()],
                rows: vec![
                    vec![serde_json::json!(i64::MAX), serde_json::json!(1)],
                    vec![serde_json::json!(1), serde_json::json!(1)],
                ],
            })
            .expect("seed overflow dataset")
            .id;
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        let validated = service
            .validate(&new_formula(&dataset_id, "Overflow", "Value + Increment"))
            .expect("validate overflow formula without mutation");

        assert_eq!(validated.status, CalculatedColumnStatus::Ready);
        assert_eq!(validated.warning_count.total, 0);
        assert_eq!(validated.warning_count.validation, 0);
        assert!(validated.diagnostics.is_empty());
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_delete_multiple_adjacent_columns_keeps_contiguous_meta_order() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create area");
        let sum = service
            .upsert(&new_formula(&dataset_id, "Sum", "Length + Width"))
            .expect("create sum");
        let delta = service
            .upsert(&new_formula(&dataset_id, "Delta", "Length - Width"))
            .expect("create delta");

        service
            .delete_columns(&DeleteCalculatedColumnsInput {
                dataset_id: dataset_id.clone(),
                column_ids: vec![area.column_id.clone(), sum.column_id.clone()],
            })
            .expect("delete adjacent calculated columns");

        let columns = meta_columns(&state, &dataset_id);
        assert_eq!(
            columns
                .iter()
                .map(|(_, col_index, name)| (*col_index, name.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "Length"), (1, "Width"), (2, "Flag"), (3, "Delta")]
        );
        assert_eq!(columns[3].0, delta.column_id);
    }

    #[test]
    fn calculated_convert_to_values_preserves_identity_name_type_order_and_values() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let created = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create formula");
        let before = snapshot_state(&state, &dataset_id);
        let before_typed = column_descriptors(&state, &dataset_id);

        service
            .convert_to_values(&ConvertCalculatedColumnToValuesInput {
                dataset_id: dataset_id.clone(),
                formula_id: calculated_descriptor(&created).formula_id.clone(),
                expected_generation: None,
            })
            .expect("convert calculated column to values");

        let after = snapshot_state(&state, &dataset_id);
        assert_eq!(after.generation, before.generation + 1);
        assert_eq!(after.rows, before.rows);
        let after_typed = column_descriptors(&state, &dataset_id);
        assert_eq!(
            after_typed
                .iter()
                .map(|descriptor| (
                    &descriptor.column_id,
                    &descriptor.name,
                    &descriptor.sql_type
                ))
                .collect::<Vec<_>>(),
            before_typed
                .iter()
                .map(|descriptor| (
                    &descriptor.column_id,
                    &descriptor.name,
                    &descriptor.sql_type
                ))
                .collect::<Vec<_>>()
        );
        let converted = after_typed
            .into_iter()
            .find(|descriptor| descriptor.column_id == created.column_id)
            .expect("converted descriptor");
        assert!(converted.calculated.is_none());
    }

    #[test]
    fn calculated_convert_to_values_keeps_downstream_formula_valid() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let area = service
            .upsert(&new_formula(&dataset_id, "Area", "Length * Width"))
            .expect("create area formula");
        let doubled = service
            .upsert(&new_formula(&dataset_id, "DoubleArea", "Area * 2"))
            .expect("create dependent formula");

        service
            .convert_to_values(&ConvertCalculatedColumnToValuesInput {
                dataset_id: dataset_id.clone(),
                formula_id: calculated_descriptor(&area).formula_id.clone(),
                expected_generation: None,
            })
            .expect("convert upstream formula to values");

        let descriptors = column_descriptors(&state, &dataset_id);
        let converted = descriptors
            .iter()
            .find(|descriptor| descriptor.column_id == area.column_id)
            .expect("converted upstream descriptor");
        let downstream = descriptors
            .iter()
            .find(|descriptor| descriptor.column_id == doubled.column_id)
            .expect("downstream descriptor");
        assert!(converted.calculated.is_none());
        assert_eq!(
            downstream
                .calculated
                .as_ref()
                .expect("downstream calculated descriptor")
                .status,
            CalculatedColumnStatus::Ready
        );
        assert_eq!(
            numeric_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0, 40.0]
        );
    }

    #[test]
    fn calculated_convert_to_values_rejects_unknown_formula_without_bumping_generation() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        let error = service
            .convert_to_values(&ConvertCalculatedColumnToValuesInput {
                dataset_id: dataset_id.clone(),
                formula_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: Some(before.generation),
            })
            .expect_err("unknown formula conversion must fail");

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_convert_to_values_leaves_generation_unchanged_when_formula_is_missing() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let before = snapshot_state(&state, &dataset_id);

        let result = service.convert_to_values(&ConvertCalculatedColumnToValuesInput {
            dataset_id: dataset_id.clone(),
            formula_id: uuid::Uuid::new_v4().to_string(),
            expected_generation: Some(before.generation),
        });

        assert!(matches!(result, Err(AppError::InvalidParam(_))));
        assert_eq!(snapshot_state(&state, &dataset_id), before);
    }

    #[test]
    fn calculated_column_service_requires_total_column_id_maps_for_standalone_import() {
        let (state, dataset_id) = seeded_state();
        let service = CalculatedColumnService::new(&state);
        let _ = formula_columns(&state, &dataset_id);

        let err = service
            .remap_imported_formula(&ImportedCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Imported Area".to_string(),
                formula_text: "Length * Width".to_string(),
                source_formula_id: uuid::Uuid::new_v4().to_string(),
                source_output_column_id: uuid::Uuid::new_v4().to_string(),
                source_column_id_map: std::collections::HashMap::from([(
                    "missing-width".to_string(),
                    column_id(&state, &dataset_id, "Length"),
                )]),
            })
            .expect_err("standalone import must reject incomplete source column maps");

        assert!(matches!(err, AppError::InvalidParam(_)));
    }
}

use std::sync::Arc;
use std::collections::{BTreeMap, BTreeSet, HashSet};

use duckdb::params;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::calculated_column::{
    ArchivedCalculatedColumn, CalculatedColumnDefinitionV1, CalculatedOutputTypeV1,
};
use crate::services::calculated_column_expression::{
    compile_materialized_formula_sql, FormulaError, FormulaSqlColumn, TypedCalculatedExpression,
    TypedCalculatedOutput,
};
use crate::services::table_history_archive::{capture_history_schema, record_history_timeline};

#[cfg(test)]
thread_local! {
    static FULL_BEFORE_TABLE_COPIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_full_before_table_copy_counter() {
    FULL_BEFORE_TABLE_COPIES.with(|counter| counter.set(0));
}

#[cfg(test)]
pub(crate) fn full_before_table_copy_counter() -> usize {
    FULL_BEFORE_TABLE_COPIES.with(std::cell::Cell::get)
}

#[cfg(all(not(test), feature="perf-harness"))]
static FULL_BEFORE_TABLE_COPIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(all(not(test), feature="perf-harness"))]
pub(crate) fn reset_full_before_table_copy_counter(){FULL_BEFORE_TABLE_COPIES.store(0,std::sync::atomic::Ordering::Relaxed);}
#[cfg(all(not(test), feature="perf-harness"))]
pub(crate) fn full_before_table_copy_counter()->usize {FULL_BEFORE_TABLE_COPIES.load(std::sync::atomic::Ordering::Relaxed)}

pub(crate) struct TableMutationEffects<T> {
    pub value: T,
    pub changed_column_ids: BTreeSet<String>,
    pub change_set_id: Option<String>,
    pub recompute_column_ids: Option<BTreeSet<String>>,
}

#[derive(Clone)]
struct ColumnHistoryState {
    column_index: i32,
    column_id: String,
    name: String,
    sql_type: String,
    calculated: Option<ArchivedCalculatedColumn>,
}

pub(crate) fn execute_table_mutation<T>(
    engine: &DuckDbEngine,
    dataset_id: &str,
    expected_generation: Option<u64>,
    operation: impl FnOnce(&DuckDbEngine) -> Result<TableMutationEffects<T>, AppError>,
) -> Result<T, AppError> {
    engine.conn().execute_batch("BEGIN TRANSACTION")?;
    let result = execute_table_mutation_in_transaction(engine, dataset_id, expected_generation, operation);
    crate::services::table_delta_mutation::finish_transaction(engine, result)
}

pub(crate) fn execute_table_mutation_in_transaction<T>(
    engine: &DuckDbEngine,
    dataset_id: &str,
    expected_generation: Option<u64>,
    operation: impl FnOnce(&DuckDbEngine) -> Result<TableMutationEffects<T>, AppError>,
) -> Result<T, AppError> {
    execute_table_mutation_scoped_in_transaction(engine,dataset_id,expected_generation,None,operation)
}

pub(crate) fn execute_column_mutation_in_transaction<T>(
    engine:&DuckDbEngine,dataset_id:&str,expected_generation:Option<u64>,column_ids:Option<BTreeSet<String>>,
    operation:impl FnOnce(&DuckDbEngine)->Result<TableMutationEffects<T>,AppError>,
)->Result<T,AppError> {
    execute_table_mutation_scoped_in_transaction(engine,dataset_id,expected_generation,column_ids,operation)
}

fn execute_table_mutation_scoped_in_transaction<T>(
    engine:&DuckDbEngine,dataset_id:&str,expected_generation:Option<u64>,column_ids:Option<BTreeSet<String>>,
    operation:impl FnOnce(&DuckDbEngine)->Result<TableMutationEffects<T>,AppError>,
)->Result<T,AppError> {
    let change_set_id = uuid::Uuid::new_v4().to_string();
    let suffix = change_set_id.replace('-', "_");
    let full_before_table =
        DuckDbEngine::quote_identifier(&format!("_history_full_before_{suffix}"));

    let result = (|| -> Result<T, AppError> {
        let generation = engine.get_dataset_generation(dataset_id)?;
        if let Some(expected_generation) = expected_generation {
            if generation != expected_generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected_generation}"
                )));
            }
        }

        let before_schema_json = capture_history_schema(engine, dataset_id)?;
        let before_columns = column_history_by_id(engine, dataset_id)?;
        let dataset_table =
            DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));

        let projection=if let Some(ids)=column_ids.as_ref() {
            std::iter::once("\"_row_id\"".to_string()).chain(before_columns.iter().filter(|(id,_)|ids.contains(*id)).map(|(_,column)|DuckDbEngine::quote_identifier(&column.name))).collect::<Vec<_>>().join(", ")
        } else {
            #[cfg(test)]
            FULL_BEFORE_TABLE_COPIES.with(|counter| counter.set(counter.get().saturating_add(1)));
            #[cfg(all(not(test), feature="perf-harness"))]
            FULL_BEFORE_TABLE_COPIES.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
            "*".into()
        };
        engine.conn().execute(&format!("CREATE TABLE {full_before_table} AS SELECT {projection} FROM {dataset_table} ORDER BY \"_row_id\""),[])?;

        let effects = operation(engine)?;
        let definitions_by_output = ready_definitions_by_output(engine, dataset_id)?;
        let recompute_column_ids = effects
            .recompute_column_ids
            .clone()
            .unwrap_or_else(|| effects.changed_column_ids.clone());
        let affected_outputs = affected_output_ids(&recompute_column_ids, &definitions_by_output);
        materialize_outputs(
            engine,
            dataset_id,
            &definitions_by_output,
            &affected_outputs,
            None,
        )?;
        let after_columns = column_history_by_id(engine, dataset_id)?;
        let after_schema_json = capture_history_schema(engine, dataset_id)?;

        let mut tracked_column_ids = if let Some(ids)=column_ids.as_ref() {ids.clone()} else {before_columns.keys().chain(after_columns.keys()).cloned().collect::<BTreeSet<_>>()};
        tracked_column_ids.extend(affected_outputs);
        let prefer_before_history_order = effects
            .recompute_column_ids
            .as_ref()
            .is_some_and(|column_ids| column_ids.is_empty())
            && effects.changed_column_ids.len() == before_columns.len()
            && before_columns.len() == after_columns.len();
        record_history_change_set(
            engine,
            dataset_id,
            effects.change_set_id.as_deref().unwrap_or(&change_set_id),
            generation
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?,
            &full_before_table,
            &before_columns,
            &after_columns,
            &tracked_column_ids,
            prefer_before_history_order,
        )?;
        record_history_timeline(
            engine,
            effects.change_set_id.as_deref().unwrap_or(&change_set_id),
            dataset_id,
            "full",
            if column_ids.is_some() {"column_values"} else {"legacy_full"},
            generation,
            generation + 1,
            &before_schema_json,
            &after_schema_json,
        )?;
        engine
            .conn()
            .execute(&format!("DROP TABLE {full_before_table}"), [])?;
        engine.conn().execute(
            "UPDATE _meta_datasets SET generation = ?, updated_at = CAST(current_timestamp AS VARCHAR) WHERE id = ?",
            params![generation + 1, dataset_id],
        )?;
        engine.rebuild_natural_anchors(dataset_id, generation + 1)?;

        Ok(effects.value)
    })();

    result
}

pub(crate) fn has_affected_calculated_outputs(engine: &DuckDbEngine, dataset_id: &str, changed: &BTreeSet<String>) -> Result<bool, AppError> {
    Ok(!affected_output_ids(changed, &ready_definitions_by_output(engine, dataset_id)?).is_empty())
}

fn ready_definitions_by_output(
    engine: &DuckDbEngine,
    dataset_id: &str,
) -> Result<BTreeMap<String, CalculatedColumnDefinitionV1>, AppError> {
    let archived = engine.get_archived_calculated_columns_by_id(dataset_id)?;
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

pub(crate) fn mutation_column_ids(engine:&DuckDbEngine,dataset_id:&str,changed:&BTreeSet<String>)->Result<BTreeSet<String>,AppError> {
    let mut ids=changed.clone();ids.extend(affected_output_ids(changed,&ready_definitions_by_output(engine,dataset_id)?));Ok(ids)
}

pub(crate) type FormulaRowSets = BTreeMap<String,Arc<BTreeSet<i64>>>;

pub(crate) fn affected_formula_rows(engine:&DuckDbEngine,dataset:&str,changed:&FormulaRowSets)->Result<FormulaRowSets,AppError> {
    let definitions=ready_definitions_by_output(engine,dataset)?;
    let mut known=changed.clone();let mut derived=FormulaRowSets::new();
    let mut unions=BTreeMap::<Vec<usize>,Arc<BTreeSet<i64>>>::new();
    for id in affected_output_ids(&changed.keys().cloned().collect(),&definitions) {
        let definition=definitions.get(&id).ok_or_else(||AppError::Database("calculated definition is missing".into()))?;
        let sets=definition.dependency_column_ids.iter().filter_map(|dependency|known.get(dependency)).collect::<Vec<_>>();
        let Some(first)=sets.first() else {continue;};
        let rows=if sets.iter().all(|set|Arc::ptr_eq(first,set)||first.as_ref()==set.as_ref()) {Arc::clone(first)} else {
            let mut key=sets.iter().map(|set|Arc::as_ptr(set) as usize).collect::<Vec<_>>();key.sort_unstable();key.dedup();
            Arc::clone(unions.entry(key).or_insert_with(||Arc::new(sets.iter().flat_map(|set|set.iter().copied()).collect())))
        };
        known.insert(id.clone(),Arc::clone(&rows));derived.insert(id,rows);
    }
    Ok(derived)
}

pub(crate) fn materialize_formula_rows(engine:&DuckDbEngine,dataset:&str,rows:&FormulaRowSets)->Result<(),AppError> {
    if rows.is_empty() {return Ok(());}
    let definitions=ready_definitions_by_output(engine,dataset)?;
    let ordered=affected_output_ids(&rows.keys().cloned().collect(),&definitions);
    materialize_outputs(engine,dataset,&definitions,&ordered,Some(rows))
}

pub(crate) fn materialize_added_rows(engine:&DuckDbEngine,dataset:&str,row_ids:&[i64])->Result<(),AppError> {
    if row_ids.is_empty() {return Ok(());}
    let definitions=ready_definitions_by_output(engine,dataset)?;
    let rows=Arc::new(row_ids.iter().copied().collect::<BTreeSet<_>>());
    let sets=definitions.keys().map(|id|(id.clone(),Arc::clone(&rows))).collect::<FormulaRowSets>();
    let ordered=affected_output_ids(&definitions.keys().cloned().collect(),&definitions);
    materialize_outputs(engine,dataset,&definitions,&ordered,Some(&sets))
}

fn affected_output_ids(
    changed_column_ids: &BTreeSet<String>,
    definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
) -> Vec<String> {
    let mut affected = changed_column_ids
        .iter()
        .filter(|column_id| definitions_by_output.contains_key(*column_id))
        .cloned()
        .collect::<HashSet<_>>();
    let mut changed = true;
    while changed {
        changed = false;
        for definition in definitions_by_output.values() {
            if affected.contains(&definition.output_column_id) {
                continue;
            }
            if definition.dependency_column_ids.iter().any(|dependency| {
                changed_column_ids.contains(dependency) || affected.contains(dependency)
            }) {
                changed = affected.insert(definition.output_column_id.clone()) || changed;
            }
        }
    }

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
    for output_id in &affected {
        visit(
            output_id,
            &affected,
            definitions_by_output,
            &mut seen,
            &mut ordered,
        );
    }
    ordered
}

/// Validate ready formula bindings after a NULL-only source type change, with no row writes.
pub(crate) fn validate_materialized_formula_types(engine:&DuckDbEngine,dataset:&str)->Result<(),AppError> {
    let definitions=ready_definitions_by_output(engine,dataset)?;
    let outputs=definitions.keys().cloned().collect::<Vec<_>>();
    materialize_outputs(engine,dataset,&definitions,&outputs,Some(&FormulaRowSets::new()))
}

fn materialize_outputs(
    engine: &DuckDbEngine,
    dataset_id: &str,
    definitions_by_output: &BTreeMap<String, CalculatedColumnDefinitionV1>,
    output_ids: &[String],
    row_sets:Option<&FormulaRowSets>,
) -> Result<(), AppError> {
    if output_ids.is_empty() {
        return Ok(());
    }

    let table_name =
        DuckDbEngine::quote_identifier(&format!("dataset_{}", dataset_id.replace('-', "_")));
    let sql_columns = engine
        .get_user_column_descriptors(dataset_id)?
        .into_iter()
        .map(|column| FormulaSqlColumn {
            column_id: column.column_id,
            sql_type: column.sql_type,
            physical_name: column.name,
        })
        .collect::<Vec<_>>();

    for output_id in output_ids {
        let definition = definitions_by_output.get(output_id).ok_or_else(|| {
            AppError::Database(format!("missing calculated definition for {output_id}"))
        })?;
        let compiled =
            compile_materialized_formula_sql(&typed_expression_from_definition(definition)?, &sql_columns)
                .map_err(map_formula_error)?;
        let output_column = sql_columns
            .iter()
            .find(|column| column.column_id == *output_id)
            .ok_or_else(|| {
                AppError::Database(format!("missing SQL column binding for {output_id}"))
            })?;
        let identifier = DuckDbEngine::quote_identifier(&output_column.physical_name);
        let predicate=if let Some(sets)=row_sets {
            let Some(rows)=sets.get(output_id).filter(|rows|!rows.is_empty()) else {continue;};
            format!(" WHERE \"_row_id\" IN ({})",rows.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
        } else {String::new()};
        engine.conn().execute(
            &format!(
                "UPDATE {table_name} SET {identifier} = {}{predicate}",
                compiled.value_sql
            ),
            [],
        )?;
    }

    Ok(())
}

fn record_history_change_set(
    engine: &DuckDbEngine,
    dataset_id: &str,
    change_set_id: &str,
    next_generation: u64,
    full_before_table: &str,
    before_columns: &BTreeMap<String, ColumnHistoryState>,
    after_columns: &BTreeMap<String, ColumnHistoryState>,
    tracked_column_ids: &BTreeSet<String>,
    prefer_before_history_order: bool,
) -> Result<(), AppError> {
    let suffix = change_set_id.replace('-', "_");
    let before_table = DuckDbEngine::quote_identifier(&format!("_history_before_{suffix}"));
    let after_table = DuckDbEngine::quote_identifier(&format!("_history_after_{suffix}"));
    let ordered_column_ids = ordered_column_ids(
        before_columns,
        after_columns,
        tracked_column_ids,
        prefer_before_history_order,
    );

    create_snapshot_table(
        engine,
        full_before_table,
        &before_table,
        before_columns,
        &ordered_column_ids,
    )?;
    create_snapshot_table(
        engine,
        &DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id)),
        &after_table,
        after_columns,
        &ordered_column_ids,
    )?;
    engine.conn().execute(
        "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
        params![change_set_id, dataset_id, next_generation],
    )?;

    for (ordinal, column_id) in ordered_column_ids.iter().enumerate() {
        let before = before_columns.get(column_id);
        let after = after_columns.get(column_id);
        let column_index = after
            .map(|column| column.column_index)
            .or_else(|| before.map(|column| column.column_index))
            .ok_or_else(|| {
                AppError::Database(format!("missing history column state for {column_id}"))
            })?;
        engine.conn().execute(
            "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_column_id, before_name, before_type, before_calculated_definition_json, after_column_id, after_name, after_type, after_calculated_definition_json, after_present) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                change_set_id,
                ordinal as i32,
                column_index,
                before.map(|column| column.column_id.as_str()),
                before.map(|column| column.name.as_str()),
                before.map(|column| column.sql_type.as_str()),
                serialize_calculated(before.and_then(|column| column.calculated.as_ref()))?,
                after.map(|column| column.column_id.as_str()),
                after.map(|column| column.name.as_str()).unwrap_or("__missing__"),
                after.map(|column| column.sql_type.as_str()).unwrap_or("VARCHAR"),
                serialize_calculated(after.and_then(|column| column.calculated.as_ref()))?,
                after.is_some(),
            ],
        )?;
    }

    Ok(())
}

fn create_snapshot_table(
    engine: &DuckDbEngine,
    source_table: &str,
    target_table: &str,
    columns_by_id: &BTreeMap<String, ColumnHistoryState>,
    ordered_column_ids: &[String],
) -> Result<(), AppError> {
    let snapshot_columns = ordered_column_ids
        .iter()
        .enumerate()
        .map(|(ordinal, column_id)| match columns_by_id.get(column_id) {
            Some(column) => format!(
                "{} AS {}",
                DuckDbEngine::quote_identifier(&column.name),
                DuckDbEngine::quote_identifier(&format!("c{ordinal}"))
            ),
            None => format!("CAST(NULL AS VARCHAR) AS \"c{ordinal}\""),
        })
        .collect::<Vec<_>>();
    let snapshot_select = std::iter::once("\"_row_id\"".to_string())
        .chain(snapshot_columns)
        .collect::<Vec<_>>()
        .join(", ");
    engine.conn().execute(
        &format!(
            "CREATE TABLE {target_table} AS SELECT {snapshot_select} FROM {source_table} ORDER BY \"_row_id\""
        ),
        [],
    )?;
    Ok(())
}

fn ordered_column_ids(
    before_columns: &BTreeMap<String, ColumnHistoryState>,
    after_columns: &BTreeMap<String, ColumnHistoryState>,
    tracked_column_ids: &BTreeSet<String>,
    prefer_before_history_order: bool,
) -> Vec<String> {
    let mut ordered = tracked_column_ids.iter().cloned().collect::<Vec<_>>();
    ordered.sort_by_key(|column_id| {
        let primary = if prefer_before_history_order {
            before_columns.get(column_id)
        } else {
            after_columns.get(column_id)
        };
        let fallback = if prefer_before_history_order {
            after_columns.get(column_id)
        } else {
            before_columns.get(column_id)
        };
        primary
            .map(|column| column.column_index)
            .or_else(|| fallback.map(|column| column.column_index))
            .unwrap_or(i32::MAX)
    });
    ordered
}

fn column_history_by_id(
    engine: &DuckDbEngine,
    dataset_id: &str,
) -> Result<BTreeMap<String, ColumnHistoryState>, AppError> {
    let descriptors = engine.get_user_column_descriptors(dataset_id)?;
    let archive_plans = engine.get_archive_column_plans(dataset_id)?;
    let plans_by_id = archive_plans
        .into_iter()
        .map(|plan| (plan.column_id.clone(), plan))
        .collect::<BTreeMap<_, _>>();

    Ok(descriptors
        .into_iter()
        .map(|descriptor| {
            let calculated = plans_by_id
                .get(&descriptor.column_id)
                .and_then(|plan| plan.calculated.clone());
            (
                descriptor.column_id.clone(),
                ColumnHistoryState {
                    column_index: descriptor.col_index,
                    column_id: descriptor.column_id,
                    name: descriptor.name,
                    sql_type: descriptor.sql_type,
                    calculated,
                },
            )
        })
        .collect())
}

fn serialize_calculated(
    calculated: Option<&ArchivedCalculatedColumn>,
) -> Result<Option<String>, AppError> {
    calculated
        .map(|calculated| {
            serde_json::to_string(calculated).map_err(|error| AppError::Database(error.to_string()))
        })
        .transpose()
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

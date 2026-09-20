use duckdb::params;
use serde::{Deserialize, Serialize};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySchemaColumn {
    pub column_id: String,
    pub col_index: i32,
    pub name: String,
    pub duckdb_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculated_definition_json: Option<String>,
}

pub(crate) fn capture_history_schema(
    engine: &DuckDbEngine,
    dataset_id: &str,
) -> Result<String, AppError> {
    let calculated = engine.get_archived_calculated_columns_by_id(dataset_id)?;
    let columns = engine
        .get_user_column_descriptors(dataset_id)?
        .into_iter()
        .map(|column| {
            let calculated_definition_json = calculated
                .get(&column.column_id)
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| AppError::Database(error.to_string()))?;
            Ok(HistorySchemaColumn {
                column_id: column.column_id,
                col_index: column.col_index,
                name: column.name,
                duckdb_type: column.sql_type,
                calculated_definition_json,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    serde_json::to_string(&columns).map_err(|error| AppError::Database(error.to_string()))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_history_timeline(
    engine: &DuckDbEngine,
    change_set_id: &str,
    dataset_id: &str,
    storage_kind: &str,
    operation: &str,
    before_generation: u64,
    after_generation: u64,
    before_schema_json: &str,
    after_schema_json: &str,
) -> Result<(), AppError> {
    let history_ordinal: u64 = engine.conn().query_row(
        "SELECT COALESCE(MAX(history_ordinal) + 1, 0)
         FROM _history_timeline WHERE dataset_id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    engine.conn().execute(
        "UPDATE _history_timeline SET current_generation = ? WHERE dataset_id = ?",
        params![after_generation, dataset_id],
    )?;
    engine.conn().execute(
        "INSERT INTO _history_timeline
         (change_set_id, dataset_id, history_ordinal, storage_kind, operation,
          created_before_generation, created_after_generation, current_generation,
          applied, before_schema_json, after_schema_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)",
        params![
            change_set_id,
            dataset_id,
            history_ordinal,
            storage_kind,
            operation,
            before_generation,
            after_generation,
            after_generation,
            before_schema_json,
            after_schema_json
        ],
    )?;
    Ok(())
}

pub(crate) fn advance_history_timeline(
    engine: &DuckDbEngine,
    dataset_id: &str,
    change_set_id: &str,
    applied: bool,
    current_generation: u64,
) -> Result<(), AppError> {
    engine.conn().execute(
        "UPDATE _history_timeline SET current_generation = ? WHERE dataset_id = ?",
        params![current_generation, dataset_id],
    )?;
    let updated = engine.conn().execute(
        "UPDATE _history_timeline SET applied = ?
         WHERE dataset_id = ? AND change_set_id = ?",
        params![applied, dataset_id, change_set_id],
    )?;
    if updated != 1 {
        return Err(AppError::Database(
            "history timeline entry is missing for replay".into(),
        ));
    }
    Ok(())
}

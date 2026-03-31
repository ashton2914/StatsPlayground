use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::state::AppState;

/// A full project data snapshot (all datasets + display props)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDataSnapshot {
    pub datasets: Vec<SnapshotDataset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDataset {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub columns: Vec<SnapshotColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotColumn {
    pub name: String,
    pub col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<SnapshotColumnFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotColumnFormat {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// Capture entire project state as a snapshot
#[tauri::command]
pub fn capture_project_snapshot(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ProjectDataSnapshot, AppError> {
    let db = state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
    let display = state
        .column_display
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;

    let dataset_metas = db.list_datasets()?;
    let total_datasets = dataset_metas.len();
    let mut datasets = Vec::new();

    for (ds_idx, ds) in dataset_metas.iter().enumerate() {
        let _ = app.emit("snapshot-progress", serde_json::json!({
            "datasetIndex": ds_idx,
            "datasetTotal": total_datasets,
            "datasetName": &ds.name,
        }));
        let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

        // Get columns from metadata
        let mut col_stmt = db.conn().prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let base_columns: Vec<(String, String)> = col_stmt
            .query_map(duckdb::params![ds.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Merge display props
        let ds_display = display.get(&ds.id);
        let columns: Vec<SnapshotColumn> = base_columns
            .iter()
            .enumerate()
            .map(|(i, (name, col_type))| {
                let dp = ds_display.and_then(|v| v.iter().find(|p| p.col_index == i));
                SnapshotColumn {
                    name: name.clone(),
                    col_type: col_type.clone(),
                    width: dp.and_then(|p| p.width),
                    format: dp.and_then(|p| p.format.as_ref()).map(|f| {
                        SnapshotColumnFormat {
                            kind: f.kind.clone(),
                            decimals: f.decimals,
                            currency: f.currency.clone(),
                        }
                    }),
                }
            })
            .collect();

        let col_names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();

        // Get all rows
        let select_cols = std::iter::once("\"_row_id\"".to_string())
            .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT {} FROM \"{}\" ORDER BY \"_row_id\"",
            select_cols, table_name
        );
        let mut stmt = db.conn().prepare(&query)?;
        let total_cols = 1 + col_names.len();

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut result_rows = stmt.query([])?;
        while let Some(row) = result_rows.next()? {
            let mut row_values = Vec::new();
            for i in 0..total_cols {
                let value: duckdb::types::Value = row.get(i)?;
                let json_val = match value {
                    duckdb::types::Value::Null => serde_json::Value::Null,
                    duckdb::types::Value::Boolean(b) => serde_json::Value::Bool(b),
                    duckdb::types::Value::TinyInt(n) => serde_json::json!(n),
                    duckdb::types::Value::SmallInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Int(n) => serde_json::json!(n),
                    duckdb::types::Value::BigInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Float(f) => serde_json::json!(f),
                    duckdb::types::Value::Double(f) => serde_json::json!(f),
                    duckdb::types::Value::Text(s) => serde_json::Value::String(s),
                    _ => serde_json::Value::String(format!("{:?}", value)),
                };
                row_values.push(json_val);
            }
            rows.push(row_values);
        }

        datasets.push(SnapshotDataset {
            id: ds.id.clone(),
            name: ds.name.clone(),
            source_type: ds.source_type.clone(),
            columns,
            rows,
        });
    }

    let _ = app.emit("snapshot-progress", serde_json::json!({
        "datasetIndex": total_datasets,
        "datasetTotal": total_datasets,
        "datasetName": "完成",
    }));

    Ok(ProjectDataSnapshot { datasets })
}

/// Restore project state from a snapshot
#[tauri::command]
pub fn restore_project_snapshot(
    state: State<'_, AppState>,
    app: AppHandle,
    snapshot: ProjectDataSnapshot,
) -> Result<(), AppError> {
    // Reset DuckDB and column display
    state.reset_db()?;

    let db = state
        .db
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;

    let total_datasets = snapshot.datasets.len();

    for (ds_idx, ds) in snapshot.datasets.iter().enumerate() {
        let _ = app.emit("restore-progress", serde_json::json!({
            "datasetIndex": ds_idx,
            "datasetTotal": total_datasets,
            "datasetName": &ds.name,
        }));

        let col_names: Vec<String> = ds.columns.iter().map(|c| c.name.clone()).collect();
        let col_types: Vec<String> = ds.columns.iter().map(|c| c.col_type.clone()).collect();
        db.create_empty_table(&ds.id, &ds.name, &col_names, &col_types)?;

        // Batch insert rows (1000 per batch) for performance
        if !ds.rows.is_empty() {
            let all_col_defs: Vec<String> = std::iter::once("\"_row_id\"".to_string())
                .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
                .collect();
            let col_list = all_col_defs.join(", ");
            let table_ident = format!("dataset_{}", ds.id.replace('-', "_"));

            for chunk in ds.rows.chunks(1000) {
                let values_lists: Vec<String> = chunk.iter().map(|row| {
                    let vals: Vec<String> = row.iter().map(|v| match v {
                        serde_json::Value::Null => "NULL".to_string(),
                        serde_json::Value::Number(n) => n.to_string(),
                        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                        serde_json::Value::Bool(b) => b.to_string(),
                        _ => format!("'{}'", v.to_string().replace('\'', "''")),
                    }).collect();
                    format!("({})", vals.join(", "))
                }).collect();

                let raw_sql = format!(
                    "INSERT INTO \"{}\" ({}) VALUES {}",
                    table_ident, col_list, values_lists.join(", ")
                );
                db.conn().execute_batch(&raw_sql).map_err(|e| AppError::Database(e.to_string()))?;
            }
        }

        // Update row count
        let row_count: i64 = db.conn().query_row(
            &format!(
                "SELECT COUNT(*) FROM \"dataset_{}\"",
                ds.id.replace('-', "_")
            ),
            [],
            |row| row.get(0),
        )?;
        db.conn().execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            duckdb::params![row_count, ds.id],
        )?;

        // Restore column display properties
        let mut display_props: Vec<crate::models::table::ColumnDisplayProps> = Vec::new();
        for (i, col) in ds.columns.iter().enumerate() {
            if col.width.is_some() || col.format.is_some() {
                display_props.push(crate::models::table::ColumnDisplayProps {
                    col_index: i,
                    width: col.width,
                    format: col.format.as_ref().map(|f| {
                        crate::models::table::ColumnFormatInfo {
                            kind: f.kind.clone(),
                            decimals: f.decimals,
                            currency: f.currency.clone(),
                        }
                    }),
                });
            }
        }
        if !display_props.is_empty() {
            let mut display = state
                .column_display
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            display.insert(ds.id.clone(), display_props);
        }
    }

    let _ = app.emit("restore-progress", serde_json::json!({
        "datasetIndex": total_datasets,
        "datasetTotal": total_datasets,
        "datasetName": "完成",
    }));

    Ok(())
}

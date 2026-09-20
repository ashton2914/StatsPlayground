use duckdb::params;
use serde::{Deserialize, Serialize};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::services::spprj_archive::{DeltaHistoryChangeSet, DeltaHistorySnapshotColumn};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySchemaColumn {
    pub column_id: String,
    pub col_index: i32,
    pub name: String,
    pub duckdb_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculated_definition_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTimelineRef {
    pub timeline_file: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTimelineArchive {
    pub version: u32,
    pub datasets: Vec<HistoryDatasetCursor>,
    pub entries: Vec<HistoryTimelineEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDatasetCursor {
    pub dataset_id: String,
    pub applied_count: u64,
    pub current_generation: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTimelineEntry {
    pub change_set_id: String,
    pub dataset_id: String,
    pub history_ordinal: u64,
    pub storage_kind: String,
    pub operation: String,
    pub created_before_generation: u64,
    pub created_after_generation: u64,
    pub current_generation: u64,
    pub applied: bool,
    pub before_schema: Vec<HistorySchemaColumn>,
    pub after_schema: Vec<HistorySchemaColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<DeltaHistoryChangeSet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legacy_columns: Vec<LegacyHistoryColumn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snapshots: Vec<HistorySnapshotRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHistoryColumn {
    pub ordinal: i32,
    pub column_index: i32,
    pub before_column_id: Option<String>,
    pub before_name: Option<String>,
    pub before_type: Option<String>,
    pub before_calculated_definition_json: Option<String>,
    pub after_column_id: Option<String>,
    pub after_name: String,
    pub after_type: String,
    pub after_calculated_definition_json: Option<String>,
    pub after_present: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshotRef {
    pub kind: String,
    pub file: String,
    pub table_name: String,
    pub columns: Vec<DeltaHistorySnapshotColumn>,
}

#[derive(Clone)]
pub struct HistoryTimelineBundle {
    pub metadata: HistoryTimelineArchive,
    pub snapshots: Vec<(String, HistorySnapshotRef, Vec<u8>)>,
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

pub(crate) fn validate_history_timeline(archive: &HistoryTimelineArchive) -> Result<(), AppError> {
    use std::collections::{HashMap, HashSet};

    if archive.version != 2 {
        return Err(AppError::FileIO(format!(
            "Unsupported history timeline version: {}",
            archive.version
        )));
    }
    let cursors = archive
        .datasets
        .iter()
        .map(|cursor| (cursor.dataset_id.as_str(), cursor))
        .collect::<HashMap<_, _>>();
    if cursors.len() != archive.datasets.len() {
        return Err(AppError::FileIO("Duplicate history dataset cursor".into()));
    }
    let mut change_set_ids = HashSet::new();
    let mut entries_by_dataset: HashMap<&str, Vec<&HistoryTimelineEntry>> = HashMap::new();
    let mut snapshot_files = HashSet::new();
    for entry in &archive.entries {
        uuid::Uuid::parse_str(&entry.change_set_id)
            .map_err(|_| AppError::FileIO("Invalid history change-set UUID".into()))?;
        if entry.dataset_id.trim().is_empty()
            || !change_set_ids.insert(entry.change_set_id.as_str())
        {
            return Err(AppError::FileIO(
                "Invalid or duplicate history change set".into(),
            ));
        }
        if entry.created_after_generation
            != entry
                .created_before_generation
                .checked_add(1)
                .ok_or_else(|| AppError::FileIO("History generation overflow".into()))?
        {
            return Err(AppError::FileIO(
                "History created generation transition is invalid".into(),
            ));
        }
        validate_schema(&entry.before_schema)?;
        validate_schema(&entry.after_schema)?;
        let expected_snapshot_kinds: &[&str] =
            match (entry.storage_kind.as_str(), entry.operation.as_str()) {
                ("row_delta", "add_rows") | ("column_delta", "add_columns") => &[],
                ("row_delta", "delete_rows") | ("column_delta", "delete_columns") => &["delta"],
                ("full", "legacy_full") => &["before", "after"],
                _ => return Err(AppError::FileIO("Unsupported history operation".into())),
            };
        let actual_kinds = entry
            .snapshots
            .iter()
            .map(|snapshot| snapshot.kind.as_str())
            .collect::<Vec<_>>();
        if actual_kinds != expected_snapshot_kinds {
            return Err(AppError::FileIO(
                "History snapshot set does not match its operation".into(),
            ));
        }
        for snapshot in &entry.snapshots {
            let expected_file = format!(
                "history/snapshots/{}/{}.parquet",
                entry.change_set_id, snapshot.kind
            );
            if snapshot.file != expected_file || !snapshot_files.insert(snapshot.file.as_str()) {
                return Err(AppError::FileIO(
                    "Invalid or duplicate history snapshot path".into(),
                ));
            }
            let suffix = entry.change_set_id.replace('-', "_");
            let expected_table = match snapshot.kind.as_str() {
                "before" => format!("_history_before_{suffix}"),
                "after" => format!("_history_after_{suffix}"),
                "delta" if entry.storage_kind == "row_delta" => {
                    format!("_history_rows_{}", entry.change_set_id.replace('-', ""))
                }
                "delta" if entry.storage_kind == "column_delta" => {
                    format!("_history_columns_{}", entry.change_set_id.replace('-', ""))
                }
                _ => return Err(AppError::FileIO("Invalid history snapshot kind".into())),
            };
            if snapshot.table_name != expected_table {
                return Err(AppError::FileIO(
                    "History snapshot table identity mismatch".into(),
                ));
            }
            validate_snapshot_columns(&snapshot.columns)?;
        }
        match entry.storage_kind.as_str() {
            "full" if entry.delta.is_none() && !entry.legacy_columns.is_empty() => {}
            "row_delta" | "column_delta"
                if entry.legacy_columns.is_empty()
                    && entry.delta.as_ref().is_some_and(|delta| {
                        delta.id == entry.change_set_id
                            && delta.dataset_id == entry.dataset_id
                            && delta.storage_kind == entry.storage_kind
                            && delta.operation == entry.operation
                    }) => {}
            _ => {
                return Err(AppError::FileIO(
                    "History storage metadata does not match its timeline entry".into(),
                ))
            }
        }
        if let Some(delta) = &entry.delta {
            for column in &delta.columns {
                validate_calculated_definition(column.calculated_definition_json.as_deref())?;
            }
            let mut expected_after = entry.before_schema.clone();
            apply_compact_schema_transition(&mut expected_after, delta)?;
            if expected_after != entry.after_schema {
                return Err(AppError::FileIO(
                    "History schema transition does not match compact metadata".into(),
                ));
            }
        }
        for column in &entry.legacy_columns {
            validate_calculated_definition(column.before_calculated_definition_json.as_deref())?;
            validate_calculated_definition(column.after_calculated_definition_json.as_deref())?;
        }
        entries_by_dataset
            .entry(entry.dataset_id.as_str())
            .or_default()
            .push(entry);
    }
    if entries_by_dataset.len() != cursors.len()
        || cursors
            .keys()
            .any(|dataset_id| !entries_by_dataset.contains_key(dataset_id))
    {
        return Err(AppError::FileIO(
            "History dataset cursors do not match timeline entries".into(),
        ));
    }
    for (dataset_id, mut entries) in entries_by_dataset {
        entries.sort_by_key(|entry| entry.history_ordinal);
        let cursor = cursors
            .get(dataset_id)
            .ok_or_else(|| AppError::FileIO("Missing history dataset cursor".into()))?;
        let mut saw_unapplied = false;
        for (ordinal, entry) in entries.iter().enumerate() {
            if entry.history_ordinal != ordinal as u64 {
                return Err(AppError::FileIO(
                    "History ordinals must be unique and contiguous".into(),
                ));
            }
            if entry.current_generation != cursor.current_generation {
                return Err(AppError::FileIO("History replay fences disagree".into()));
            }
            if entry.applied {
                if saw_unapplied {
                    return Err(AppError::FileIO(
                        "History applied state is not a prefix".into(),
                    ));
                }
            } else {
                saw_unapplied = true;
            }
            if ordinal > 0 {
                let previous = entries[ordinal - 1];
                if previous.after_schema != entry.before_schema
                    || entry.created_before_generation < previous.created_after_generation
                {
                    return Err(AppError::FileIO(
                        "History schema or generation transition mismatch".into(),
                    ));
                }
            }
        }
        if cursor.applied_count
            != u64::try_from(entries.iter().filter(|entry| entry.applied).count())
                .map_err(|_| AppError::FileIO("History cursor is too large".into()))?
        {
            return Err(AppError::FileIO(
                "History cursor does not match applied state".into(),
            ));
        }
    }
    Ok(())
}

fn validate_schema(columns: &[HistorySchemaColumn]) -> Result<(), AppError> {
    let mut ids = std::collections::HashSet::new();
    for (index, column) in columns.iter().enumerate() {
        if column.col_index != index as i32
            || column.column_id.trim().is_empty()
            || column.name.trim().is_empty()
            || !ids.insert(column.column_id.as_str())
        {
            return Err(AppError::FileIO(
                "Invalid stable-column history schema".into(),
            ));
        }
        validate_calculated_definition(column.calculated_definition_json.as_deref())?;
    }
    Ok(())
}

fn validate_calculated_definition(value: Option<&str>) -> Result<(), AppError> {
    if let Some(value) = value {
        serde_json::from_str::<crate::models::calculated_column::ArchivedCalculatedColumn>(value)
            .map_err(|error| {
            AppError::FileIO(format!(
                "Malformed calculated-column history definition: {error}"
            ))
        })?;
    }
    Ok(())
}

fn validate_snapshot_columns(columns: &[DeltaHistorySnapshotColumn]) -> Result<(), AppError> {
    if columns.is_empty() {
        return Err(AppError::FileIO("History snapshot schema is empty".into()));
    }
    for column in columns {
        let transport = column
            .transport_type
            .as_deref()
            .unwrap_or(&column.duckdb_type);
        let expected = if column.duckdb_type == "HUGEINT" {
            "VARCHAR"
        } else {
            column.duckdb_type.as_str()
        };
        if transport != expected {
            return Err(AppError::FileIO(
                "History snapshot logical/transport type mismatch".into(),
            ));
        }
    }
    Ok(())
}

fn apply_compact_schema_transition(
    schema: &mut Vec<HistorySchemaColumn>,
    delta: &DeltaHistoryChangeSet,
) -> Result<(), AppError> {
    match delta.operation.as_str() {
        "add_rows" | "delete_rows" => {}
        "add_columns" => {
            for column in &delta.columns {
                let index = usize::try_from(column.col_index)
                    .map_err(|_| AppError::FileIO("Invalid history column index".into()))?;
                if index > schema.len()
                    || schema
                        .iter()
                        .any(|current| current.column_id == column.column_id)
                {
                    return Err(AppError::FileIO(
                        "Invalid history add-column transition".into(),
                    ));
                }
                schema.insert(
                    index,
                    HistorySchemaColumn {
                        column_id: column.column_id.clone(),
                        col_index: column.col_index,
                        name: column.col_name.clone(),
                        duckdb_type: column.col_type.clone(),
                        calculated_definition_json: column.calculated_definition_json.clone(),
                    },
                );
            }
        }
        "delete_columns" => {
            for column in delta.columns.iter().rev() {
                let index = schema
                    .iter()
                    .position(|current| current.column_id == column.column_id)
                    .ok_or_else(|| {
                        AppError::FileIO("Invalid history delete-column transition".into())
                    })?;
                let removed = schema.remove(index);
                if removed.name != column.col_name
                    || removed.duckdb_type != column.col_type
                    || removed.col_index != column.col_index
                {
                    return Err(AppError::FileIO(
                        "History deleted-column metadata does not match schema".into(),
                    ));
                }
            }
        }
        _ => {
            return Err(AppError::FileIO(
                "Unsupported compact history operation".into(),
            ))
        }
    }
    for (index, column) in schema.iter_mut().enumerate() {
        column.col_index = i32::try_from(index)
            .map_err(|_| AppError::FileIO("History schema is too large".into()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::spprj_archive::{DeltaHistoryRow, DeltaHistorySnapshotColumn};

    fn schema() -> Vec<HistorySchemaColumn> {
        vec![HistorySchemaColumn {
            column_id: "column-a".into(),
            col_index: 0,
            name: "value".into(),
            duckdb_type: "HUGEINT".into(),
            calculated_definition_json: None,
        }]
    }

    fn row_delta(id: &str, dataset_id: &str, before: u64, after: u64) -> DeltaHistoryChangeSet {
        DeltaHistoryChangeSet {
            id: id.into(),
            dataset_id: dataset_id.into(),
            storage_kind: "row_delta".into(),
            generation: 2,
            operation: "add_rows".into(),
            before_generation: before,
            after_generation: after,
            snapshot_table: None,
            applied: true,
            rows: vec![DeltaHistoryRow {
                ordinal: 0,
                row_id: after as i64,
                row_order: Some(after as i128),
            }],
            columns: Vec::new(),
        }
    }

    fn valid_archive() -> HistoryTimelineArchive {
        let dataset_id = "dataset-a";
        let first_id = "00000000-0000-4000-8000-000000000011";
        let second_id = "00000000-0000-4000-8000-000000000012";
        HistoryTimelineArchive {
            version: 2,
            datasets: vec![HistoryDatasetCursor {
                dataset_id: dataset_id.into(),
                applied_count: 2,
                current_generation: 2,
            }],
            entries: vec![
                HistoryTimelineEntry {
                    change_set_id: first_id.into(),
                    dataset_id: dataset_id.into(),
                    history_ordinal: 0,
                    storage_kind: "row_delta".into(),
                    operation: "add_rows".into(),
                    created_before_generation: 0,
                    created_after_generation: 1,
                    current_generation: 2,
                    applied: true,
                    before_schema: schema(),
                    after_schema: schema(),
                    delta: Some(row_delta(first_id, dataset_id, 0, 1)),
                    legacy_columns: Vec::new(),
                    snapshots: Vec::new(),
                },
                HistoryTimelineEntry {
                    change_set_id: second_id.into(),
                    dataset_id: dataset_id.into(),
                    history_ordinal: 1,
                    storage_kind: "row_delta".into(),
                    operation: "add_rows".into(),
                    created_before_generation: 1,
                    created_after_generation: 2,
                    current_generation: 2,
                    applied: true,
                    before_schema: schema(),
                    after_schema: schema(),
                    delta: Some(row_delta(second_id, dataset_id, 1, 2)),
                    legacy_columns: Vec::new(),
                    snapshots: Vec::new(),
                },
            ],
        }
    }

    fn assert_corrupt(
        mut archive: HistoryTimelineArchive,
        edit: impl FnOnce(&mut HistoryTimelineArchive),
    ) {
        edit(&mut archive);
        assert!(matches!(
            validate_history_timeline(&archive),
            Err(AppError::FileIO(_))
        ));
    }

    #[test]
    fn unified_history_archive_rejects_invalid_state_machine_and_descriptors() {
        assert_corrupt(valid_archive(), |archive| {
            archive.entries[1].history_ordinal = 0;
        });
        assert_corrupt(valid_archive(), |archive| {
            archive.datasets[0].applied_count = 1;
        });
        assert_corrupt(valid_archive(), |archive| {
            archive.entries[1].created_before_generation = 0;
        });
        assert_corrupt(valid_archive(), |archive| {
            archive.entries[1].before_schema.clear();
        });
        assert_corrupt(valid_archive(), |archive| {
            let entry = &mut archive.entries[0];
            entry.operation = "delete_rows".into();
            entry.delta.as_mut().unwrap().operation = "delete_rows".into();
            entry.delta.as_mut().unwrap().snapshot_table =
                Some("_history_rows_00000000000040008000000000000011".into());
        });
        assert_corrupt(valid_archive(), |archive| {
            archive.entries[0].before_schema[0].calculated_definition_json = Some("{}".into());
        });
        assert_corrupt(valid_archive(), |archive| {
            let entry = &mut archive.entries[0];
            entry.operation = "delete_rows".into();
            entry.delta.as_mut().unwrap().operation = "delete_rows".into();
            entry.delta.as_mut().unwrap().snapshot_table =
                Some("_history_rows_00000000000040008000000000000011".into());
            entry.snapshots.push(HistorySnapshotRef {
                kind: "delta".into(),
                file: format!("history/snapshots/{}/delta.parquet", entry.change_set_id),
                table_name: "_history_rows_00000000000040008000000000000011".into(),
                columns: vec![DeltaHistorySnapshotColumn {
                    name: "_row_order".into(),
                    duckdb_type: "HUGEINT".into(),
                    transport_type: Some("BIGINT".into()),
                }],
            });
        });
    }
}

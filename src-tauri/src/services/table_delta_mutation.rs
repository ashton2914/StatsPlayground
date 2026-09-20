use duckdb::types::Value;
use duckdb::{params, params_from_iter};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::table::RowMutationResult;
use crate::services::natural_row_order::{
    allocate_before, publish_deleted_anchors, publish_inserted_anchors, publish_restored_anchors,
    resolve_natural_row_positions,
};

const MAX_ADDED_ROWS: usize = 100_000;
const MAX_DELETED_ROWS: usize = 5_000;

pub(crate) fn add_rows_compact(
    engine: &DuckDbEngine,
    dataset_id: &str,
    count: usize,
    before_row_id: Option<i64>,
    expected_generation: u64,
) -> Result<RowMutationResult, AppError> {
    if count == 0 || count > MAX_ADDED_ROWS {
        return Err(AppError::InvalidParam(format!(
            "row count must be between 1 and {MAX_ADDED_ROWS}"
        )));
    }
    engine.conn().execute_batch("BEGIN TRANSACTION")?;
    let result = (|| {
        validate_generation(engine, dataset_id, expected_generation)?;
        let next_generation = next_generation(expected_generation)?;
        let allocation = allocate_before(engine, dataset_id, before_row_id, count)?;
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
        let reserved_ids = engine.reserve_row_ids(dataset_id, count)?;
        let mut inserted = Vec::with_capacity(count);
        for (row_id, row_order) in reserved_ids
            .into_iter()
            .zip(allocation.row_orders.iter().copied())
        {
            engine.conn().execute(
                &format!("INSERT INTO {table} (\"_row_id\", \"_row_order\") VALUES (?, ?)"),
                params![row_id, row_order],
            )?;
            inserted.push((row_id, row_order));
        }
        let row_count = updated_row_count(engine, dataset_id, count as i64)?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        record_delta_change_set(
            engine,
            &change_set_id,
            dataset_id,
            "add_rows",
            expected_generation,
            next_generation,
            None,
            inserted
                .iter()
                .enumerate()
                .map(|(index, &(row_id, row_order))| {
                    Ok((
                        allocation.insertion_ordinal
                            + i64::try_from(index).map_err(|_| {
                                AppError::InvalidParam("row count is too large".into())
                            })?,
                        row_id,
                        Some(row_order),
                    ))
                })
                .collect::<Result<Vec<_>, AppError>>()?
                .as_slice(),
        )?;
        publish_inserted_anchors(
            engine,
            dataset_id,
            expected_generation,
            next_generation,
            allocation.insertion_ordinal,
            &inserted,
        )?;
        publish_generation(engine, dataset_id, next_generation)?;
        Ok(RowMutationResult {
            row_ids: inserted.into_iter().map(|row| row.0).collect(),
            generation: next_generation,
            row_count,
            change_set_id,
        })
    })();
    finish_transaction(engine, result)
}

pub(crate) fn delete_rows_compact(
    engine: &DuckDbEngine,
    dataset_id: &str,
    row_ids: &[i64],
    expected_generation: u64,
) -> Result<RowMutationResult, AppError> {
    if row_ids.is_empty() || row_ids.len() > MAX_DELETED_ROWS {
        return Err(AppError::InvalidParam(format!(
            "row count must be between 1 and {MAX_DELETED_ROWS}"
        )));
    }
    let mut unique_ids = row_ids.to_vec();
    unique_ids.sort_unstable();
    unique_ids.dedup();
    if unique_ids.len() != row_ids.len() || unique_ids.iter().any(|row_id| *row_id <= 0) {
        return Err(AppError::InvalidParam(
            "row IDs must be unique positive integers".into(),
        ));
    }
    engine.conn().execute_batch("BEGIN TRANSACTION")?;
    let result = (|| {
        validate_generation(engine, dataset_id, expected_generation)?;
        let next_generation = next_generation(expected_generation)?;
        engine.ensure_internal_row_order_column(dataset_id)?;
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
        let placeholders = std::iter::repeat_n("?", unique_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let deleted =
            resolve_natural_row_positions(engine, dataset_id, expected_generation, &unique_ids)?;

        let change_set_id = uuid::Uuid::new_v4().to_string();
        let snapshot_name = format!("_history_rows_{}", change_set_id.replace('-', ""));
        let snapshot = DuckDbEngine::quote_identifier(&snapshot_name);
        engine.conn().execute(
            &format!(
                "CREATE TABLE {snapshot} AS
                 SELECT * FROM {table} WHERE \"_row_id\" IN ({placeholders})"
            ),
            params_from_iter(unique_ids.iter()),
        )?;
        let delta_rows = deleted
            .iter()
            .map(|row| (row.ordinal, row.row_id, row.row_order))
            .collect::<Vec<_>>();
        record_delta_change_set(
            engine,
            &change_set_id,
            dataset_id,
            "delete_rows",
            expected_generation,
            next_generation,
            Some(&snapshot_name),
            &delta_rows,
        )?;
        engine.conn().execute(
            &format!("DELETE FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
            params_from_iter(unique_ids.iter()),
        )?;
        let row_count = updated_row_count(
            engine,
            dataset_id,
            -i64::try_from(unique_ids.len())
                .map_err(|_| AppError::InvalidParam("row count is too large".into()))?,
        )?;
        let deleted_anchors = deleted
            .iter()
            .map(|row| (row.row_id, row.order_key, row.ordinal))
            .collect::<Vec<_>>();
        publish_deleted_anchors(
            engine,
            dataset_id,
            expected_generation,
            next_generation,
            &deleted_anchors,
        )?;
        publish_generation(engine, dataset_id, next_generation)?;
        Ok(RowMutationResult {
            row_ids: unique_ids,
            generation: next_generation,
            row_count,
            change_set_id,
        })
    })();
    finish_transaction(engine, result)
}

pub(crate) fn apply_row_delta_change_set(
    engine: &DuckDbEngine,
    change_set_id: &str,
    undo: bool,
) -> Result<(), AppError> {
    engine.conn().execute_batch("BEGIN TRANSACTION")?;
    let result = (|| {
        let (dataset_id, operation, before_generation, after_generation, snapshot_table, applied):
            (String, String, u64, u64, Option<String>, bool) = engine.conn().query_row(
                "SELECT dataset_id, operation, before_generation, after_generation,
                        snapshot_table, applied
                 FROM _history_delta_change_sets WHERE id = ?",
                params![change_set_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?;
        if applied != undo {
            return Err(AppError::InvalidParam(if undo {
                "Change set is already undone".into()
            } else {
                "Change set is already applied".into()
            }));
        }
        let expected_generation = if applied {
            after_generation
        } else {
            before_generation
        };
        validate_generation(engine, &dataset_id, expected_generation)?;
        let target_generation = next_generation(expected_generation)?;
        let mut statement = engine.conn().prepare(
            "SELECT ordinal, row_id, row_order
             FROM _history_row_deltas WHERE change_set_id = ? ORDER BY ordinal",
        )?;
        let rows = statement
            .query_map(params![change_set_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i128>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
        let deleting = (operation.as_str() == "add_rows" && undo)
            || (operation.as_str() == "delete_rows" && !undo);
        if deleting {
            delete_delta_rows(engine, &table, &rows)?;
            updated_row_count(
                engine,
                &dataset_id,
                -i64::try_from(rows.len())
                    .map_err(|_| AppError::InvalidParam("row count is too large".into()))?,
            )?;
            let deleted = rows
                .iter()
                .map(|&(ordinal, row_id, row_order)| {
                    let order_key = row_order.unwrap_or(
                        i128::from(row_id) * crate::engine::duckdb_engine::NATURAL_ORDER_STRIDE,
                    );
                    (row_id, order_key, ordinal)
                })
                .collect::<Vec<_>>();
            publish_deleted_anchors(
                engine,
                &dataset_id,
                expected_generation,
                target_generation,
                &deleted,
            )?;
        } else if operation == "add_rows" {
            insert_added_rows(engine, &table, &rows)?;
            updated_row_count(
                engine,
                &dataset_id,
                i64::try_from(rows.len())
                    .map_err(|_| AppError::InvalidParam("row count is too large".into()))?,
            )?;
            let inserted = rows
                .iter()
                .map(|&(_, row_id, row_order)| {
                    let order_key = row_order.unwrap_or(
                        i128::from(row_id) * crate::engine::duckdb_engine::NATURAL_ORDER_STRIDE,
                    );
                    (row_id, order_key)
                })
                .collect::<Vec<_>>();
            let insertion_ordinal = rows.first().map(|row| row.0).unwrap_or(0);
            publish_inserted_anchors(
                engine,
                &dataset_id,
                expected_generation,
                target_generation,
                insertion_ordinal,
                &inserted,
            )?;
        } else if operation == "delete_rows" {
            let snapshot_table = snapshot_table.ok_or_else(|| {
                AppError::Database("deleted-row change set is missing its snapshot".into())
            })?;
            let parsed_id = uuid::Uuid::parse_str(change_set_id)
                .map_err(|_| AppError::InvalidParam("Invalid change set ID".into()))?;
            let expected_snapshot = format!("_history_rows_{}", parsed_id.simple());
            if snapshot_table != expected_snapshot {
                return Err(AppError::Database(
                    "deleted-row snapshot name does not match its change set".into(),
                ));
            }
            let snapshot = DuckDbEngine::quote_identifier(&snapshot_table);
            engine
                .conn()
                .execute(&format!("INSERT INTO {table} SELECT * FROM {snapshot}"), [])?;
            updated_row_count(
                engine,
                &dataset_id,
                i64::try_from(rows.len())
                    .map_err(|_| AppError::InvalidParam("row count is too large".into()))?,
            )?;
            let restored = rows
                .iter()
                .map(|&(ordinal, row_id, row_order)| {
                    let order_key = row_order.unwrap_or(
                        i128::from(row_id) * crate::engine::duckdb_engine::NATURAL_ORDER_STRIDE,
                    );
                    (row_id, order_key, ordinal)
                })
                .collect::<Vec<_>>();
            publish_restored_anchors(
                engine,
                &dataset_id,
                expected_generation,
                target_generation,
                &restored,
            )?;
        } else {
            return Err(AppError::Database(format!(
                "unknown row delta operation: {operation}"
            )));
        }
        publish_generation(engine, &dataset_id, target_generation)?;
        engine.conn().execute(
            "UPDATE _history_change_sets
             SET applied = ?, generation = ? WHERE id = ?",
            params![!undo, target_generation, change_set_id],
        )?;
        if undo {
            engine.conn().execute(
                "UPDATE _history_delta_change_sets
                 SET applied = FALSE, before_generation = ? WHERE id = ?",
                params![target_generation, change_set_id],
            )?;
        } else {
            engine.conn().execute(
                "UPDATE _history_delta_change_sets
                 SET applied = TRUE, after_generation = ? WHERE id = ?",
                params![target_generation, change_set_id],
            )?;
        }
        Ok(())
    })();
    finish_transaction(engine, result)
}

fn validate_generation(
    engine: &DuckDbEngine,
    dataset_id: &str,
    expected_generation: u64,
) -> Result<(), AppError> {
    let generation = engine.get_dataset_generation(dataset_id)?;
    if generation != expected_generation {
        return Err(AppError::InvalidParam(format!(
            "stale dataset generation: expected {generation}, received {expected_generation}"
        )));
    }
    let row_count: i64 = engine.conn().query_row(
        "SELECT row_count FROM _meta_datasets WHERE id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    let generation = i64::try_from(generation)
        .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
    engine.validate_natural_anchor_manifest(dataset_id, generation, row_count)?;
    Ok(())
}

fn next_generation(generation: u64) -> Result<u64, AppError> {
    generation
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))
}

fn updated_row_count(
    engine: &DuckDbEngine,
    dataset_id: &str,
    difference: i64,
) -> Result<usize, AppError> {
    let row_count: i64 = engine.conn().query_row(
        "SELECT row_count FROM _meta_datasets WHERE id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    let row_count = row_count
        .checked_add(difference)
        .ok_or_else(|| AppError::Database("dataset row count overflowed".into()))?;
    if row_count < 0 {
        return Err(AppError::Database(
            "dataset row count became negative".into(),
        ));
    }
    engine.conn().execute(
        "UPDATE _meta_datasets SET row_count = ? WHERE id = ?",
        params![row_count, dataset_id],
    )?;
    usize::try_from(row_count)
        .map_err(|_| AppError::Database("dataset row count is too large".into()))
}

fn publish_generation(
    engine: &DuckDbEngine,
    dataset_id: &str,
    generation: u64,
) -> Result<(), AppError> {
    engine.conn().execute(
        "UPDATE _meta_datasets
         SET generation = ?, updated_at = CAST(current_timestamp AS VARCHAR)
         WHERE id = ?",
        params![generation, dataset_id],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_delta_change_set(
    engine: &DuckDbEngine,
    change_set_id: &str,
    dataset_id: &str,
    operation: &str,
    before_generation: u64,
    after_generation: u64,
    snapshot_table: Option<&str>,
    rows: &[(i64, i64, Option<i128>)],
) -> Result<(), AppError> {
    engine.conn().execute(
        "INSERT INTO _history_change_sets
         (id, dataset_id, applied, generation, storage_kind)
         VALUES (?, ?, TRUE, ?, 'row_delta')",
        params![change_set_id, dataset_id, after_generation],
    )?;
    engine.conn().execute(
        "INSERT INTO _history_delta_change_sets
         (id, dataset_id, operation, before_generation, after_generation,
          snapshot_table, applied)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)",
        params![
            change_set_id,
            dataset_id,
            operation,
            before_generation,
            after_generation,
            snapshot_table
        ],
    )?;
    for &(ordinal, row_id, row_order) in rows {
        engine.conn().execute(
            "INSERT INTO _history_row_deltas
             (change_set_id, ordinal, row_id, row_order) VALUES (?, ?, ?, ?)",
            params![change_set_id, ordinal, row_id, row_order],
        )?;
    }
    Ok(())
}

fn delete_delta_rows(
    engine: &DuckDbEngine,
    table: &str,
    rows: &[(i64, i64, Option<i128>)],
) -> Result<(), AppError> {
    let placeholders = std::iter::repeat_n("?", rows.len())
        .collect::<Vec<_>>()
        .join(", ");
    engine.conn().execute(
        &format!("DELETE FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
        params_from_iter(rows.iter().map(|row| Value::BigInt(row.1))),
    )?;
    Ok(())
}

fn insert_added_rows(
    engine: &DuckDbEngine,
    table: &str,
    rows: &[(i64, i64, Option<i128>)],
) -> Result<(), AppError> {
    for &(_, row_id, row_order) in rows {
        engine.conn().execute(
            &format!("INSERT INTO {table} (\"_row_id\", \"_row_order\") VALUES (?, ?)"),
            params![row_id, row_order],
        )?;
    }
    Ok(())
}

fn finish_transaction<T>(
    engine: &DuckDbEngine,
    result: Result<T, AppError>,
) -> Result<T, AppError> {
    match result {
        Ok(value) => {
            engine.conn().execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = engine.conn().execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use duckdb::params;

    use super::*;
    use crate::engine::duckdb_engine::{
        full_anchor_rebuild_counter, reset_full_anchor_rebuild_counter, NATURAL_ORDER_SQL,
    };

    fn history_table_count(engine: &DuckDbEngine, pattern: &str) -> i64 {
        engine
            .conn()
            .query_row(
                "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE ?",
                params![pattern],
                |row| row.get(0),
            )
            .expect("history table count")
    }

    fn natural_rows(
        engine: &DuckDbEngine,
        dataset_id: &str,
    ) -> Vec<(i64, Option<i128>, Option<i64>)> {
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
        engine
            .conn()
            .prepare(&format!(
                "SELECT \"_row_id\", \"_row_order\", value_1
                 FROM {table}
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\""
            ))
            .expect("prepare natural rows")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query natural rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect natural rows")
    }

    #[test]
    fn compact_row_mutation_append_and_insert_return_exact_metadata() {
        let append_db = DuckDbEngine::new_in_memory().expect("engine");
        append_db
            .seed_benchmark_table("compact-append", "Compact append", 3, 1)
            .expect("seed");
        reset_full_anchor_rebuild_counter();

        let appended =
            add_rows_compact(&append_db, "compact-append", 2, None, 0).expect("append rows");
        assert_eq!(appended.row_ids, vec![4, 5]);
        assert_eq!((appended.generation, appended.row_count), (1, 5));
        uuid::Uuid::parse_str(&appended.change_set_id).expect("change set UUID");
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(history_table_count(&append_db, "_history_full_before_%"), 0);

        let insert_db = DuckDbEngine::new_in_memory().expect("engine");
        insert_db
            .seed_benchmark_table("compact-insert", "Compact insert", 4, 1)
            .expect("seed");
        reset_full_anchor_rebuild_counter();

        let inserted =
            add_rows_compact(&insert_db, "compact-insert", 2, Some(3), 0).expect("insert rows");
        assert_eq!(inserted.row_ids, vec![5, 6]);
        assert_eq!((inserted.generation, inserted.row_count), (1, 6));
        assert_eq!(
            natural_rows(&insert_db, "compact-insert")
                .into_iter()
                .map(|row| row.0)
                .collect::<Vec<_>>(),
            vec![1, 2, 5, 6, 3, 4]
        );
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(history_table_count(&insert_db, "_history_full_before_%"), 0);
    }

    #[test]
    fn compact_row_mutation_invalid_requests_are_atomic() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-atomic", "Compact atomic", 4, 1)
            .expect("seed");
        let before = natural_rows(&db, "compact-atomic");

        assert!(matches!(
            add_rows_compact(&db, "compact-atomic", 1, None, 9),
            Err(AppError::InvalidParam(_))
        ));
        assert!(matches!(
            add_rows_compact(&db, "compact-atomic", 1, Some(99), 0),
            Err(AppError::InvalidParam(_))
        ));
        assert_eq!(natural_rows(&db, "compact-atomic"), before);
        assert_eq!(
            db.get_dataset_generation("compact-atomic")
                .expect("generation"),
            0
        );
        let delta_count: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM _history_delta_change_sets",
                [],
                |row| row.get(0),
            )
            .expect("delta count");
        assert_eq!(delta_count, 0);
    }

    #[test]
    fn compact_row_mutation_delete_snapshots_only_typed_selected_rows() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-delete", "Compact delete", 5, 2)
            .expect("seed");
        db.ensure_internal_row_order_column("compact-delete")
            .expect("row order");
        db.conn()
            .execute(
                "UPDATE dataset_compact_delete SET \"_row_order\" = 123456789012345678901234567890::HUGEINT WHERE \"_row_id\" = 4",
                [],
            )
            .expect("set explicit order");
        db.rebuild_natural_anchors("compact-delete", 0)
            .expect("refresh fixture anchors");
        reset_full_anchor_rebuild_counter();

        let deleted = delete_rows_compact(&db, "compact-delete", &[2, 4], 0).expect("delete rows");
        assert_eq!(deleted.row_ids, vec![2, 4]);
        assert_eq!((deleted.generation, deleted.row_count), (1, 3));
        let suffix = deleted.change_set_id.replace('-', "");
        let snapshot = DuckDbEngine::quote_identifier(&format!("_history_rows_{suffix}"));
        let snapshot_rows: Vec<(i64, i64, f64, Option<i128>)> = db
            .conn()
            .prepare(&format!(
                "SELECT \"_row_id\", value_1, value_2, \"_row_order\"
                 FROM {snapshot} ORDER BY \"_row_id\""
            ))
            .expect("typed snapshot")
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect snapshot");
        assert_eq!(snapshot_rows.len(), 2);
        assert_eq!(snapshot_rows[0], (2, 2, 1.0, None));
        assert_eq!(snapshot_rows[1].0, 4);
        assert_eq!(snapshot_rows[1].1, 4);
        assert_eq!(snapshot_rows[1].2, 2.0);
        assert_eq!(
            snapshot_rows[1].3,
            Some(123456789012345678901234567890_i128)
        );
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(history_table_count(&db, "_history_full_before_%"), 0);
    }

    #[test]
    fn compact_row_mutation_undo_redo_preserves_ids_values_and_natural_order() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-replay", "Compact replay", 5, 2)
            .expect("seed");
        let before = natural_rows(&db, "compact-replay");
        let deleted = delete_rows_compact(&db, "compact-replay", &[2, 4], 0).expect("delete rows");
        let after_delete = natural_rows(&db, "compact-replay");

        db.apply_change_set(&deleted.change_set_id, true)
            .expect("undo delete");
        assert_eq!(natural_rows(&db, "compact-replay"), before);
        assert_eq!(
            db.get_dataset_generation("compact-replay")
                .expect("undo gen"),
            2
        );

        db.apply_change_set(&deleted.change_set_id, false)
            .expect("redo delete");
        assert_eq!(natural_rows(&db, "compact-replay"), after_delete);
        assert_eq!(
            db.get_dataset_generation("compact-replay")
                .expect("redo gen"),
            3
        );

        let add_db = DuckDbEngine::new_in_memory().expect("engine");
        add_db
            .seed_benchmark_table("compact-add-replay", "Compact add replay", 4, 1)
            .expect("seed");
        let added =
            add_rows_compact(&add_db, "compact-add-replay", 2, Some(3), 0).expect("add rows");
        let after_add = natural_rows(&add_db, "compact-add-replay");
        add_db
            .apply_change_set(&added.change_set_id, true)
            .expect("undo add");
        assert_eq!(
            natural_rows(&add_db, "compact-add-replay")
                .into_iter()
                .map(|row| row.0)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        add_db
            .apply_change_set(&added.change_set_id, false)
            .expect("redo add");
        assert_eq!(natural_rows(&add_db, "compact-add-replay"), after_add);
    }

    #[test]
    fn compact_row_mutation_undo_delete_repairs_sparse_anchor_boundaries() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-anchor-replay", "Compact anchor replay", 8_500, 1)
            .expect("seed");
        let deleted = delete_rows_compact(&db, "compact-anchor-replay", &[1, 4_097, 8_193], 0)
            .expect("delete anchor rows");

        db.apply_change_set(&deleted.change_set_id, true)
            .expect("undo anchor deletion");
        db.validate_natural_anchor_manifest("compact-anchor-replay", 2, 8_500)
            .expect("restored anchor manifest");
        let anchor_rows: Vec<i64> = db
            .conn()
            .prepare(
                "SELECT row_id FROM _table_navigation_anchors
                 WHERE dataset_id = ? AND generation = ? ORDER BY ordinal",
            )
            .expect("prepare anchors")
            .query_map(params!["compact-anchor-replay", 2_i64], |row| row.get(0))
            .expect("query anchors")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect anchors");
        assert_eq!(anchor_rows.first(), Some(&1));
        assert!(anchor_rows.len() <= 6);
    }

    #[test]
    fn compact_row_mutation_delete_uses_bounded_anchor_navigation() {
        let production = include_str!("table_delta_mutation.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source");
        let deletion = production
            .split("pub(crate) fn delete_rows_compact")
            .nth(1)
            .expect("compact delete")
            .split("pub(crate) fn apply_row_delta_change_set")
            .next()
            .expect("compact delete section");

        assert!(!deletion.contains("row_number()"));
        assert!(deletion.contains("resolve_natural_row_positions"));
    }

    #[test]
    fn compact_row_mutation_reserves_monotonic_ids_from_metadata() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-id-reserve", "Compact ID reserve", 3, 1)
            .expect("seed");
        let next_row_id: i64 = db
            .conn()
            .query_row(
                "SELECT next_row_id FROM _meta_datasets WHERE id = ?",
                params!["compact-id-reserve"],
                |row| row.get(0),
            )
            .expect("maintained next row ID");
        assert_eq!(next_row_id, 4);

        let first =
            add_rows_compact(&db, "compact-id-reserve", 2, None, 0).expect("first reservation");
        let second =
            add_rows_compact(&db, "compact-id-reserve", 2, None, 1).expect("second reservation");
        assert_eq!(first.row_ids, vec![4, 5]);
        assert_eq!(second.row_ids, vec![6, 7]);
        let reserved_tail: i64 = db
            .conn()
            .query_row(
                "SELECT next_row_id FROM _meta_datasets WHERE id = ?",
                params!["compact-id-reserve"],
                |row| row.get(0),
            )
            .expect("reserved tail");
        assert_eq!(reserved_tail, 8);

        let production = include_str!("table_delta_mutation.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source");
        let addition = production
            .split("pub(crate) fn add_rows_compact")
            .nth(1)
            .expect("compact add")
            .split("pub(crate) fn delete_rows_compact")
            .next()
            .expect("compact add section");
        assert!(!addition.to_ascii_lowercase().contains("max(\"_row_id\")"));
    }

    #[test]
    fn compact_row_mutation_controlled_rebuild_initializes_existing_id_metadata() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-id-migrate", "Compact ID migrate", 4, 1)
            .expect("seed");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET next_row_id = NULL WHERE id = ?",
                params!["compact-id-migrate"],
            )
            .expect("simulate legacy metadata");

        db.rebuild_natural_anchors("compact-id-migrate", 0)
            .expect("controlled rebuild");
        let added =
            add_rows_compact(&db, "compact-id-migrate", 1, None, 0).expect("post-migration add");
        assert_eq!(added.row_ids, vec![5]);
    }

    #[test]
    fn compact_row_mutation_controlled_rebuild_keeps_id_metadata_monotonic() {
        let db = DuckDbEngine::new_in_memory().expect("engine");
        db.seed_benchmark_table("compact-id-monotonic", "Compact ID monotonic", 3, 1)
            .expect("seed");
        let added =
            add_rows_compact(&db, "compact-id-monotonic", 2, None, 0).expect("reserve 4 and 5");
        assert_eq!(added.row_ids, vec![4, 5]);
        delete_rows_compact(&db, "compact-id-monotonic", &[5], 1).expect("delete reserved tail");

        db.rebuild_natural_anchors("compact-id-monotonic", 2)
            .expect("controlled rebuild");
        let next = add_rows_compact(&db, "compact-id-monotonic", 1, None, 2)
            .expect("reserve after rebuild");
        assert_eq!(next.row_ids, vec![6]);
    }

    #[test]
    fn compact_row_mutation_restore_anchor_shift_is_additive() {
        let production = include_str!("natural_row_order.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source");
        let restoration = production
            .split("fn copy_restored_anchors_setwise")
            .nth(1)
            .expect("restore anchors")
            .split("fn copy_deleted_anchors_setwise")
            .next()
            .expect("restore section");

        assert!(!restoration.contains("SELECT count(*) FROM restored"));
        assert!(restoration.contains("ASOF"));
    }
}

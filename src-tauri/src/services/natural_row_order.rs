use std::collections::BTreeMap;

use duckdb::types::Value;
use duckdb::{params, params_from_iter, OptionalExt};

use crate::engine::duckdb_engine::{
    DuckDbEngine, NATURAL_ANCHOR_STRIDE, NATURAL_ORDER_SQL, NATURAL_ORDER_STRIDE,
};
use crate::error::AppError;

const INITIAL_REBALANCE_WINDOW: usize = 256;
const MAX_REBALANCE_WINDOW: usize = 8_192;

#[cfg(test)]
static ANCHOR_REFRESH_QUERY_COUNTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
static REPAIR_ROWS_EXAMINED: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
fn anchor_refresh_query_counter() -> usize {
    ANCHOR_REFRESH_QUERY_COUNTER.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
fn reset_anchor_refresh_query_counter() {
    ANCHOR_REFRESH_QUERY_COUNTER.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
fn repair_rows_examined() -> usize {
    REPAIR_ROWS_EXAMINED.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
fn reset_repair_rows_examined() {
    REPAIR_ROWS_EXAMINED.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RowOrderAllocation {
    pub row_orders: Vec<i128>,
    pub insertion_ordinal: i64,
}

struct AllocationBoundary {
    predecessor_key: Option<i128>,
    target_key: Option<i128>,
    insertion_ordinal: i64,
}

enum AnchorMutation<'a> {
    Insert {
        insertion_ordinal: i64,
        inserted_count: i64,
    },
    Delete {
        deleted: &'a [(i64, i128, i64)],
    },
    Restore {
        restored: &'a [(i64, i128, i64)],
    },
}

pub(crate) fn allocate_before(
    engine: &DuckDbEngine,
    dataset_id: &str,
    before_row_id: Option<i64>,
    count: usize,
) -> Result<RowOrderAllocation, AppError> {
    if count == 0 {
        return Err(AppError::InvalidParam(
            "row-order allocation count must be at least one".into(),
        ));
    }
    engine.ensure_internal_row_order_column(dataset_id)?;
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    let boundary = load_allocation_boundary(engine, &table_name, before_row_id)?;

    if let Some(row_orders) =
        allocate_open_interval(boundary.predecessor_key, boundary.target_key, count)?
    {
        return Ok(RowOrderAllocation {
            row_orders,
            insertion_ordinal: boundary.insertion_ordinal,
        });
    }

    let mut window_size = INITIAL_REBALANCE_WINDOW;
    loop {
        if let Some(row_orders) = rebalance_window(
            engine,
            &table_name,
            boundary.insertion_ordinal,
            count,
            window_size,
        )? {
            return Ok(RowOrderAllocation {
                row_orders,
                insertion_ordinal: boundary.insertion_ordinal,
            });
        }
        if window_size == MAX_REBALANCE_WINDOW {
            break;
        }
        window_size = (window_size * 2).min(MAX_REBALANCE_WINDOW);
    }

    Err(AppError::InvalidParam(format!(
        "cannot allocate {count} row-order keys within a bounded {MAX_REBALANCE_WINDOW}-row window"
    )))
}

fn load_allocation_boundary(
    engine: &DuckDbEngine,
    table_name: &str,
    before_row_id: Option<i64>,
) -> Result<AllocationBoundary, AppError> {
    match before_row_id {
        Some(row_id) => {
            let sql = format!(
                "SELECT predecessor_key, order_key, ordinal
                 FROM (
                     SELECT \"_row_id\",
                            {NATURAL_ORDER_SQL} AS order_key,
                            lag({NATURAL_ORDER_SQL}) OVER (
                                ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                            ) AS predecessor_key,
                            row_number() OVER (
                                ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                            ) - 1 AS ordinal
                     FROM {table_name}
                 ) AS ordered_rows
                 WHERE \"_row_id\" = ?"
            );
            engine
                .conn()
                .query_row(&sql, params![row_id], |row| {
                    Ok(AllocationBoundary {
                        predecessor_key: row.get(0)?,
                        target_key: Some(row.get(1)?),
                        insertion_ordinal: row.get(2)?,
                    })
                })
                .optional()?
                .ok_or_else(|| AppError::InvalidParam(format!("unknown row {row_id}")))
        }
        None => {
            let sql = format!(
                "SELECT {NATURAL_ORDER_SQL}, ordinal + 1
                 FROM (
                     SELECT \"_row_id\", \"_row_order\",
                            row_number() OVER (
                                ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                            ) - 1 AS ordinal
                     FROM {table_name}
                 ) AS ordered_rows
                 ORDER BY ordinal DESC
                 LIMIT 1"
            );
            let tail = engine
                .conn()
                .query_row(&sql, [], |row| {
                    Ok((row.get::<_, i128>(0)?, row.get::<_, i64>(1)?))
                })
                .optional()?;
            Ok(match tail {
                Some((key, insertion_ordinal)) => AllocationBoundary {
                    predecessor_key: Some(key),
                    target_key: None,
                    insertion_ordinal,
                },
                None => AllocationBoundary {
                    predecessor_key: None,
                    target_key: None,
                    insertion_ordinal: 0,
                },
            })
        }
    }
}

fn allocate_open_interval(
    predecessor_key: Option<i128>,
    target_key: Option<i128>,
    count: usize,
) -> Result<Option<Vec<i128>>, AppError> {
    let divisor = i128::try_from(count)
        .map_err(|_| AppError::InvalidParam("row-order allocation count is too large".into()))?
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("row-order allocation count is too large".into()))?;
    let (lower, upper) = match (predecessor_key, target_key) {
        (Some(lower), Some(upper)) => (lower, upper),
        (Some(lower), None) => {
            let width = NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
            let upper = lower.checked_add(width).ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
            (lower, upper)
        }
        (None, Some(upper)) => {
            let width = NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
            let lower = upper.checked_sub(width).ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
            (lower, upper)
        }
        (None, None) => {
            let upper = NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
            (0, upper)
        }
    };
    let width = upper.checked_sub(lower).ok_or_else(|| {
        AppError::Database("natural row-order keys are not strictly increasing".into())
    })?;
    let step = width / divisor;
    if step == 0 {
        return Ok(None);
    }
    let mut row_orders = Vec::with_capacity(count);
    for index in 1..=count {
        let offset = step
            .checked_mul(i128::try_from(index).map_err(|_| {
                AppError::InvalidParam("row-order allocation count is too large".into())
            })?)
            .and_then(|value| lower.checked_add(value))
            .ok_or_else(|| {
                AppError::InvalidParam("row-order allocation exceeds key range".into())
            })?;
        row_orders.push(offset);
    }
    Ok(Some(row_orders))
}

fn rebalance_window(
    engine: &DuckDbEngine,
    table_name: &str,
    insertion_ordinal: i64,
    count: usize,
    window_size: usize,
) -> Result<Option<Vec<i128>>, AppError> {
    let half_window = i64::try_from(window_size / 2)
        .map_err(|_| AppError::InvalidParam("rebalance window is too large".into()))?;
    let start = insertion_ordinal.saturating_sub(half_window).max(0);
    let window_size_i64 = i64::try_from(window_size)
        .map_err(|_| AppError::InvalidParam("rebalance window is too large".into()))?;
    let end = start
        .checked_add(window_size_i64)
        .ok_or_else(|| AppError::InvalidParam("rebalance window is too large".into()))?;
    let sql = format!(
        "SELECT \"_row_id\", order_key, ordinal
         FROM (
             SELECT \"_row_id\", {NATURAL_ORDER_SQL} AS order_key,
                    row_number() OVER (
                        ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                    ) - 1 AS ordinal
             FROM {table_name}
         ) AS ordered_rows
         WHERE ordinal >= ? AND ordinal <= ?
         ORDER BY ordinal"
    );
    let query_start = start.saturating_sub(1);
    let mut statement = engine.conn().prepare(&sql)?;
    let queried = statement
        .query_map(params![query_start, end], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i128>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let left_boundary = queried
        .iter()
        .find(|row| row.2 == start - 1)
        .map(|row| row.1);
    let right_boundary = queried.iter().find(|row| row.2 == end).map(|row| row.1);
    let window_rows = queried
        .iter()
        .filter(|row| row.2 >= start && row.2 < end)
        .copied()
        .collect::<Vec<_>>();
    let relative_insertion = usize::try_from(insertion_ordinal - start)
        .map_err(|_| AppError::Database("rebalance insertion ordinal is outside window".into()))?;
    if relative_insertion > window_rows.len() {
        return Err(AppError::Database(
            "rebalance insertion ordinal exceeds loaded rows".into(),
        ));
    }
    let total_positions = window_rows
        .len()
        .checked_add(count)
        .ok_or_else(|| AppError::InvalidParam("rebalance window is too large".into()))?;
    let divisor = i128::try_from(total_positions)
        .map_err(|_| AppError::InvalidParam("rebalance window is too large".into()))?
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("rebalance window is too large".into()))?;
    let (lower, upper) = bounded_rebalance_boundaries(left_boundary, right_boundary, divisor)?;
    let step = upper
        .checked_sub(lower)
        .ok_or_else(|| AppError::Database("rebalance boundaries are reversed".into()))?
        / divisor;
    if step == 0 {
        return Ok(None);
    }

    let mut assigned = Vec::with_capacity(total_positions);
    for index in 1..=total_positions {
        assigned.push(
            lower
                .checked_add(
                    step.checked_mul(i128::try_from(index).map_err(|_| {
                        AppError::InvalidParam("rebalance window is too large".into())
                    })?)
                    .ok_or_else(|| AppError::InvalidParam("rebalance exceeds key range".into()))?,
                )
                .ok_or_else(|| AppError::InvalidParam("rebalance exceeds key range".into()))?,
        );
    }
    let inserted_end = relative_insertion
        .checked_add(count)
        .ok_or_else(|| AppError::InvalidParam("rebalance window is too large".into()))?;
    let inserted_orders = assigned[relative_insertion..inserted_end].to_vec();
    let update_sql = format!("UPDATE {table_name} SET \"_row_order\" = ? WHERE \"_row_id\" = ?");
    let mut assigned_index = 0;
    for (row_index, (row_id, _, _)) in window_rows.iter().enumerate() {
        if row_index == relative_insertion {
            assigned_index += count;
        }
        engine
            .conn()
            .execute(&update_sql, params![assigned[assigned_index], row_id])?;
        assigned_index += 1;
    }

    Ok(Some(inserted_orders))
}

fn bounded_rebalance_boundaries(
    left: Option<i128>,
    right: Option<i128>,
    divisor: i128,
) -> Result<(i128, i128), AppError> {
    match (left, right) {
        (Some(left), Some(right)) => Ok((left, right)),
        (Some(left), None) => {
            let width = NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("rebalance exceeds row-order key range".into())
            })?;
            Ok((
                left,
                left.checked_add(width).ok_or_else(|| {
                    AppError::InvalidParam("rebalance exceeds row-order key range".into())
                })?,
            ))
        }
        (None, Some(right)) => {
            let width = NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("rebalance exceeds row-order key range".into())
            })?;
            Ok((
                right.checked_sub(width).ok_or_else(|| {
                    AppError::InvalidParam("rebalance exceeds row-order key range".into())
                })?,
                right,
            ))
        }
        (None, None) => Ok((
            0,
            NATURAL_ORDER_STRIDE.checked_mul(divisor).ok_or_else(|| {
                AppError::InvalidParam("rebalance exceeds row-order key range".into())
            })?,
        )),
    }
}

pub(crate) fn publish_inserted_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    insertion_ordinal: i64,
    inserted: &[(i64, i128)],
) -> Result<(), AppError> {
    if insertion_ordinal < 0 {
        return Err(AppError::InvalidParam(
            "insertion ordinal cannot be negative".into(),
        ));
    }
    let inserted_count = i64::try_from(inserted.len())
        .map_err(|_| AppError::InvalidParam("inserted row count is too large".into()))?;
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    validate_inserted_rows(engine, &table_name, insertion_ordinal, inserted)?;
    publish_transformed_anchors(
        engine,
        dataset_id,
        source_generation,
        target_generation,
        &table_name,
        AnchorMutation::Insert {
            insertion_ordinal,
            inserted_count,
        },
    )
}

pub(crate) fn publish_deleted_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    deleted: &[(i64, i128, i64)],
) -> Result<(), AppError> {
    let mut deleted_by_id = BTreeMap::new();
    for &(row_id, order_key, ordinal) in deleted {
        if ordinal < 0 {
            return Err(AppError::InvalidParam(
                "deleted row ordinal cannot be negative".into(),
            ));
        }
        if deleted_by_id.insert(row_id, (order_key, ordinal)).is_some() {
            return Err(AppError::InvalidParam(format!(
                "duplicate deleted row {row_id}"
            )));
        }
    }
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    publish_transformed_anchors(
        engine,
        dataset_id,
        source_generation,
        target_generation,
        &table_name,
        AnchorMutation::Delete { deleted },
    )
}

pub(crate) fn publish_restored_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    restored: &[(i64, i128, i64)],
) -> Result<(), AppError> {
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    publish_transformed_anchors(
        engine,
        dataset_id,
        source_generation,
        target_generation,
        &table_name,
        AnchorMutation::Restore { restored },
    )
}

fn validate_inserted_rows(
    engine: &DuckDbEngine,
    table_name: &str,
    insertion_ordinal: i64,
    inserted: &[(i64, i128)],
) -> Result<(), AppError> {
    if inserted.is_empty() {
        return Ok(());
    }
    let end = insertion_ordinal
        .checked_add(
            i64::try_from(inserted.len())
                .map_err(|_| AppError::InvalidParam("inserted row count is too large".into()))?,
        )
        .ok_or_else(|| AppError::InvalidParam("inserted row range overflowed".into()))?;
    let sql = format!(
        "SELECT \"_row_id\", order_key
         FROM (
             SELECT \"_row_id\", {NATURAL_ORDER_SQL} AS order_key,
                    row_number() OVER (
                        ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                    ) - 1 AS ordinal
             FROM {table_name}
         ) AS ordered_rows
         WHERE ordinal >= ? AND ordinal < ?
         ORDER BY ordinal"
    );
    let mut statement = engine.conn().prepare(&sql)?;
    let actual = statement
        .query_map(params![insertion_ordinal, end], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i128>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if actual != inserted {
        return Err(AppError::InvalidParam(
            "inserted rows do not match the published natural-order range".into(),
        ));
    }
    Ok(())
}

fn publish_transformed_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    table_name: &str,
    mutation: AnchorMutation<'_>,
) -> Result<(), AppError> {
    let source_generation = generation_i64(source_generation)?;
    let target_generation = generation_i64(target_generation)?;
    validate_source_anchor_generation(
        engine,
        dataset_id,
        source_generation,
        table_name,
        &mutation,
    )?;

    engine.conn().execute(
        "DELETE FROM _table_navigation_anchors WHERE dataset_id = ? AND generation = ?",
        params![dataset_id, target_generation],
    )?;
    engine.conn().execute(
        "DELETE FROM _table_navigation_anchor_manifests
         WHERE dataset_id = ? AND generation = ?",
        params![dataset_id, target_generation],
    )?;
    #[cfg(test)]
    ANCHOR_REFRESH_QUERY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    match mutation {
        AnchorMutation::Insert {
            insertion_ordinal,
            inserted_count,
        } => {
            let copy_sql = format!(
                "INSERT INTO _table_navigation_anchors
                 (dataset_id, generation, ordinal, order_key, row_id)
                 SELECT ?, ?,
                        source.ordinal + CASE WHEN source.ordinal >= ? THEN ? ELSE 0 END,
                        COALESCE(rows.\"_row_order\",
                            CAST(rows.\"_row_id\" AS HUGEINT)
                                * 18446744073709551616::HUGEINT),
                        source.row_id
                 FROM _table_navigation_anchors AS source
                 JOIN {table_name} AS rows ON rows.\"_row_id\" = source.row_id
                 WHERE source.dataset_id = ? AND source.generation = ?"
            );
            engine.conn().execute(
                &copy_sql,
                params![
                    dataset_id,
                    target_generation,
                    insertion_ordinal,
                    inserted_count,
                    dataset_id,
                    source_generation
                ],
            )?;
        }
        AnchorMutation::Delete { deleted } => {
            copy_deleted_anchors_setwise(
                engine,
                dataset_id,
                source_generation,
                target_generation,
                table_name,
                deleted,
            )?;
        }
        AnchorMutation::Restore { restored } => {
            copy_restored_anchors_setwise(
                engine,
                dataset_id,
                source_generation,
                target_generation,
                table_name,
                restored,
            )?;
        }
    }
    repair_anchor_gaps(engine, dataset_id, target_generation, table_name)?;
    let target_row_count: i64 = engine.conn().query_row(
        "SELECT row_count FROM _meta_datasets WHERE id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    engine.publish_natural_anchor_manifest(dataset_id, target_generation, target_row_count)?;
    engine.conn().execute(
        "DELETE FROM _table_navigation_anchors WHERE dataset_id = ? AND generation <> ?",
        params![dataset_id, target_generation],
    )?;
    engine.conn().execute(
        "DELETE FROM _table_navigation_anchor_manifests
         WHERE dataset_id = ? AND generation <> ?",
        params![dataset_id, target_generation],
    )?;
    Ok(())
}

fn validate_source_anchor_generation(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: i64,
    _table_name: &str,
    mutation: &AnchorMutation<'_>,
) -> Result<(), AppError> {
    let row_count: i64 = engine.conn().query_row(
        "SELECT row_count FROM _meta_datasets WHERE id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    let source_row_count = match mutation {
        AnchorMutation::Insert { inserted_count, .. } => row_count
            .checked_sub(*inserted_count)
            .ok_or_else(|| AppError::InvalidParam("inserted row count exceeds dataset".into()))?,
        AnchorMutation::Delete { deleted } => row_count
            .checked_add(
                i64::try_from(deleted.len())
                    .map_err(|_| AppError::InvalidParam("deleted row count is too large".into()))?,
            )
            .ok_or_else(|| AppError::InvalidParam("source row count overflowed".into()))?,
        AnchorMutation::Restore { restored } => row_count
            .checked_sub(
                i64::try_from(restored.len())
                    .map_err(|_| AppError::InvalidParam("restored row count is too large".into()))?,
            )
            .ok_or_else(|| AppError::InvalidParam("restored row count exceeds dataset".into()))?,
    };
    let stride = i64::try_from(NATURAL_ANCHOR_STRIDE)
        .map_err(|_| AppError::InvalidParam("navigation anchor stride is too large".into()))?;
    let (anchor_count, first_ordinal, last_ordinal, null_keys, max_gap): (
        i64,
        Option<i64>,
        Option<i64>,
        i64,
        i64,
    ) = engine.conn().query_row(
        "WITH source AS (
                 SELECT ordinal, order_key,
                        ordinal - lag(ordinal) OVER (ORDER BY ordinal) AS gap
                 FROM _table_navigation_anchors
                 WHERE dataset_id = ? AND generation = ?
             )
             SELECT count(*), min(ordinal), max(ordinal),
                    count(*) FILTER (WHERE order_key IS NULL),
                    COALESCE(max(gap), 0)
             FROM source",
        params![dataset_id, source_generation],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    if source_row_count == 0 && anchor_count == 0 {
        engine.validate_natural_anchor_manifest(dataset_id, source_generation, 0)?;
        return Ok(());
    }
    let uncovered_tail = last_ordinal
        .map(|ordinal| source_row_count - 1 - ordinal)
        .unwrap_or(source_row_count);
    if anchor_count == 0
        || first_ordinal != Some(0)
        || null_keys != 0
        || max_gap > stride
        || uncovered_tail >= stride
    {
        return Err(AppError::InvalidParam(format!(
            "source anchor generation {source_generation} is missing or malformed for dataset {dataset_id}"
        )));
    }
    engine.validate_natural_anchor_manifest(dataset_id, source_generation, source_row_count)?;
    Ok(())
}

fn copy_restored_anchors_setwise(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: i64,
    target_generation: i64,
    table_name: &str,
    restored: &[(i64, i128, i64)],
) -> Result<(), AppError> {
    let placeholders = if restored.is_empty() {
        "SELECT NULL::BIGINT AS ordinal, NULL::BIGINT AS restored_rank WHERE FALSE".to_string()
    } else {
        std::iter::repeat_n("(?, ?)", restored.len())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut values = Vec::with_capacity(restored.len() * 2 + 4);
    for (rank, row) in restored.iter().enumerate() {
        values.push(Value::BigInt(row.2));
        values.push(Value::BigInt(i64::try_from(rank).map_err(|_| {
            AppError::InvalidParam("restored row count is too large".into())
        })?));
    }
    values.extend([
        Value::Text(dataset_id.to_string()),
        Value::BigInt(target_generation),
        Value::Text(dataset_id.to_string()),
        Value::BigInt(source_generation),
    ]);
    let sql = format!(
        "WITH restored(ordinal, restored_rank) AS ({values_sql})
         INSERT INTO _table_navigation_anchors
         (dataset_id, generation, ordinal, order_key, row_id)
         SELECT ?, ?,
                source.ordinal + (
                    SELECT count(*) FROM restored
                    WHERE ordinal - restored_rank <= source.ordinal
                ),
                COALESCE(rows.\"_row_order\",
                    CAST(rows.\"_row_id\" AS HUGEINT)
                        * 18446744073709551616::HUGEINT),
                source.row_id
         FROM _table_navigation_anchors AS source
         JOIN {table_name} AS rows ON rows.\"_row_id\" = source.row_id
         WHERE source.dataset_id = ? AND source.generation = ?",
        values_sql = if restored.is_empty() {
            placeholders
        } else {
            format!("VALUES {placeholders}")
        }
    );
    engine.conn().execute(&sql, params_from_iter(values))?;
    Ok(())
}

fn copy_deleted_anchors_setwise(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: i64,
    target_generation: i64,
    table_name: &str,
    deleted: &[(i64, i128, i64)],
) -> Result<(), AppError> {
    let (deleted_cte, mut values) = deleted_rows_cte(deleted);
    values.extend([
        Value::Text(dataset_id.to_string()),
        Value::BigInt(target_generation),
        Value::Text(dataset_id.to_string()),
        Value::BigInt(source_generation),
    ]);
    let copy_sql = format!(
        "WITH deleted(row_id, ordinal) AS ({deleted_cte})
         INSERT INTO _table_navigation_anchors
         (dataset_id, generation, ordinal, order_key, row_id)
         SELECT ?, ?,
                source.ordinal - (
                    SELECT count(*) FROM deleted AS preceding
                    WHERE preceding.ordinal < source.ordinal
                ),
                COALESCE(rows.\"_row_order\",
                    CAST(rows.\"_row_id\" AS HUGEINT)
                        * 18446744073709551616::HUGEINT),
                source.row_id
         FROM _table_navigation_anchors AS source
         JOIN {table_name} AS rows ON rows.\"_row_id\" = source.row_id
         LEFT JOIN deleted AS removed ON removed.row_id = source.row_id
         WHERE source.dataset_id = ? AND source.generation = ?
           AND removed.row_id IS NULL"
    );
    engine.conn().execute(&copy_sql, params_from_iter(values))?;
    Ok(())
}

fn deleted_rows_cte(deleted: &[(i64, i128, i64)]) -> (String, Vec<Value>) {
    if deleted.is_empty() {
        (
            "SELECT NULL::BIGINT AS row_id, NULL::BIGINT AS ordinal WHERE FALSE".to_string(),
            Vec::new(),
        )
    } else {
        let placeholders = std::iter::repeat_n("(?, ?)", deleted.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut values = Vec::with_capacity(deleted.len() * 2);
        for &(row_id, _, ordinal) in deleted {
            values.push(Value::BigInt(row_id));
            values.push(Value::BigInt(ordinal));
        }
        (format!("VALUES {placeholders}"), values)
    }
}

fn repair_anchor_gaps(
    engine: &DuckDbEngine,
    dataset_id: &str,
    generation: i64,
    table_name: &str,
) -> Result<(), AppError> {
    let row_count: i64 = engine.conn().query_row(
        "SELECT row_count FROM _meta_datasets WHERE id = ?",
        params![dataset_id],
        |row| row.get(0),
    )?;
    if row_count == 0 {
        return Ok(());
    }
    let mut anchors = {
        let mut statement = engine.conn().prepare(
            "SELECT ordinal, order_key, row_id FROM _table_navigation_anchors
             WHERE dataset_id = ? AND generation = ? ORDER BY ordinal",
        )?;
        statement
            .query_map(params![dataset_id, generation], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i128>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let stride = i64::try_from(NATURAL_ANCHOR_STRIDE)
        .map_err(|_| AppError::InvalidParam("navigation anchor stride is too large".into()))?;
    if anchors.first().map(|anchor| anchor.0) != Some(0) {
        let first = load_local_first_anchor(engine, table_name, anchors.first().copied())?;
        insert_repair_anchor(engine, dataset_id, generation, 0, first.1, first.0)?;
        anchors.insert(0, (0, first.1, first.0));
    }

    let original_anchors = anchors.clone();
    let mut left = original_anchors[0];
    for right in original_anchors.into_iter().skip(1) {
        while right.0 - left.0 > stride {
            let next = load_local_repair_anchor(engine, table_name, left, Some(right), stride)?;
            let ordinal = left.0.checked_add(stride).ok_or_else(|| {
                AppError::InvalidParam("navigation anchor ordinal overflowed".into())
            })?;
            insert_repair_anchor(engine, dataset_id, generation, ordinal, next.1, next.0)?;
            left = (ordinal, next.1, next.0);
        }
        left = right;
    }
    let last_ordinal = row_count - 1;
    while last_ordinal - left.0 >= stride {
        let next = load_local_repair_anchor(engine, table_name, left, None, stride)?;
        let ordinal = left
            .0
            .checked_add(stride)
            .ok_or_else(|| AppError::InvalidParam("navigation anchor ordinal overflowed".into()))?;
        insert_repair_anchor(engine, dataset_id, generation, ordinal, next.1, next.0)?;
        left = (ordinal, next.1, next.0);
    }
    Ok(())
}

fn load_local_first_anchor(
    engine: &DuckDbEngine,
    table_name: &str,
    right: Option<(i64, i128, i64)>,
) -> Result<(i64, i128), AppError> {
    let (sql, values) = match right {
        Some((_, right_key, right_row_id)) => (
            format!(
                "SELECT \"_row_id\", {NATURAL_ORDER_SQL}
                 FROM {table_name}
                 WHERE {NATURAL_ORDER_SQL} < ?
                    OR ({NATURAL_ORDER_SQL} = ? AND \"_row_id\" < ?)
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                 LIMIT 1"
            ),
            vec![
                Value::HugeInt(right_key),
                Value::HugeInt(right_key),
                Value::BigInt(right_row_id),
            ],
        ),
        None => (
            format!(
                "SELECT \"_row_id\", {NATURAL_ORDER_SQL}
                 FROM {table_name}
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                 LIMIT 1"
            ),
            Vec::new(),
        ),
    };
    let first = engine
        .conn()
        .query_row(&sql, params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    record_repair_rows_examined(1);
    Ok(first)
}

fn load_local_repair_anchor(
    engine: &DuckDbEngine,
    table_name: &str,
    left: (i64, i128, i64),
    right: Option<(i64, i128, i64)>,
    stride: i64,
) -> Result<(i64, i128), AppError> {
    let (sql, values) = match right {
        Some((_, right_key, right_row_id)) => (
            format!(
                "SELECT \"_row_id\", {NATURAL_ORDER_SQL}
                 FROM {table_name}
                 WHERE ({NATURAL_ORDER_SQL} > ?
                        OR ({NATURAL_ORDER_SQL} = ? AND \"_row_id\" > ?))
                   AND ({NATURAL_ORDER_SQL} < ?
                        OR ({NATURAL_ORDER_SQL} = ? AND \"_row_id\" < ?))
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                 LIMIT ?"
            ),
            vec![
                Value::HugeInt(left.1),
                Value::HugeInt(left.1),
                Value::BigInt(left.2),
                Value::HugeInt(right_key),
                Value::HugeInt(right_key),
                Value::BigInt(right_row_id),
                Value::BigInt(stride),
            ],
        ),
        None => (
            format!(
                "SELECT \"_row_id\", {NATURAL_ORDER_SQL}
                 FROM {table_name}
                 WHERE {NATURAL_ORDER_SQL} > ?
                    OR ({NATURAL_ORDER_SQL} = ? AND \"_row_id\" > ?)
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                 LIMIT ?"
            ),
            vec![
                Value::HugeInt(left.1),
                Value::HugeInt(left.1),
                Value::BigInt(left.2),
                Value::BigInt(stride),
            ],
        ),
    };
    let mut statement = engine.conn().prepare(&sql)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i128>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    record_repair_rows_examined(rows.len());
    let expected = usize::try_from(stride)
        .map_err(|_| AppError::InvalidParam("navigation anchor stride is too large".into()))?;
    if rows.len() != expected {
        return Err(AppError::Database(
            "local anchor repair gap contained too few rows".into(),
        ));
    }
    rows.last()
        .copied()
        .ok_or_else(|| AppError::Database("local anchor repair returned no rows".into()))
}

fn insert_repair_anchor(
    engine: &DuckDbEngine,
    dataset_id: &str,
    generation: i64,
    ordinal: i64,
    order_key: i128,
    row_id: i64,
) -> Result<(), AppError> {
    engine.conn().execute(
        "INSERT OR REPLACE INTO _table_navigation_anchors
         (dataset_id, generation, ordinal, order_key, row_id)
         VALUES (?, ?, ?, ?, ?)",
        params![dataset_id, generation, ordinal, order_key, row_id],
    )?;
    Ok(())
}

fn record_repair_rows_examined(rows: usize) {
    #[cfg(test)]
    REPAIR_ROWS_EXAMINED.fetch_add(rows, std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(test))]
    let _ = rows;
}

fn generation_i64(generation: u64) -> Result<i64, AppError> {
    i64::try_from(generation)
        .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        allocate_before, anchor_refresh_query_counter, publish_deleted_anchors,
        publish_inserted_anchors, repair_rows_examined, reset_anchor_refresh_query_counter,
        reset_repair_rows_examined,
    };
    use crate::engine::duckdb_engine::{
        full_anchor_rebuild_counter, reset_full_anchor_rebuild_counter, DuckDbEngine,
        NATURAL_ANCHOR_STRIDE, NATURAL_ORDER_SQL, NATURAL_ORDER_STRIDE,
    };
    use crate::models::table::{TableNavigationRequest, TableNavigationResult};
    use duckdb::params;

    fn seed(dataset_id: &str, row_count: usize) -> DuckDbEngine {
        let db = DuckDbEngine::new_in_memory().expect("db");
        db.seed_benchmark_table(dataset_id, "Natural row order", row_count, 1)
            .expect("seed");
        db
    }

    fn table(dataset_id: &str) -> String {
        DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id))
    }

    fn effective_keys(db: &DuckDbEngine, dataset_id: &str) -> Vec<(i64, i128)> {
        let mut statement = db
            .conn()
            .prepare(&format!(
                "SELECT \"_row_id\", {NATURAL_ORDER_SQL} FROM {} ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"",
                table(dataset_id)
            ))
            .expect("prepare effective keys");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query effective keys")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect effective keys")
    }

    fn insert_allocated(db: &DuckDbEngine, dataset_id: &str, row_id: i64, order_key: i128) {
        db.conn()
            .execute(
                &format!(
                    "INSERT INTO {} (\"_row_id\", \"value_1\", \"_row_order\") VALUES (?, ?, ?)",
                    table(dataset_id)
                ),
                params![row_id, row_id, order_key],
            )
            .expect("insert allocated row");
    }

    #[test]
    fn natural_row_order_allocates_append_keys_after_the_effective_tail() {
        let db = seed("allocate_append", 4);

        let allocation = allocate_before(&db, "allocate_append", None, 2).expect("allocate");

        assert_eq!(allocation.insertion_ordinal, 4);
        assert_eq!(
            allocation.row_orders,
            vec![5 * NATURAL_ORDER_STRIDE, 6 * NATURAL_ORDER_STRIDE]
        );
    }

    #[test]
    fn natural_row_order_allocates_before_row_three_without_changing_existing_keys() {
        let db = seed("allocate_before", 5);
        let before = effective_keys(&db, "allocate_before");

        let allocation = allocate_before(&db, "allocate_before", Some(3), 1).expect("allocate");

        assert_eq!(allocation.insertion_ordinal, 2);
        assert_eq!(
            allocation.row_orders,
            vec![2 * NATURAL_ORDER_STRIDE + NATURAL_ORDER_STRIDE / 2]
        );
        assert_eq!(effective_keys(&db, "allocate_before"), before);
    }

    #[test]
    fn natural_row_order_evenly_allocates_a_three_row_batch() {
        let db = seed("allocate_batch", 5);

        let allocation = allocate_before(&db, "allocate_batch", Some(3), 3).expect("allocate");

        assert_eq!(allocation.insertion_ordinal, 2);
        assert_eq!(
            allocation.row_orders,
            vec![
                2 * NATURAL_ORDER_STRIDE + NATURAL_ORDER_STRIDE / 4,
                2 * NATURAL_ORDER_STRIDE + NATURAL_ORDER_STRIDE / 2,
                2 * NATURAL_ORDER_STRIDE + 3 * NATURAL_ORDER_STRIDE / 4,
            ]
        );
    }

    #[test]
    fn natural_row_order_repeated_midpoint_insertions_remain_strictly_ordered() {
        let db = seed("allocate_repeated", 5);

        for index in 0..80_i64 {
            let allocation =
                allocate_before(&db, "allocate_repeated", Some(3), 1).expect("allocate");
            insert_allocated(
                &db,
                "allocate_repeated",
                10_000 + index,
                allocation.row_orders[0],
            );
        }

        let rows = effective_keys(&db, "allocate_repeated");
        assert!(rows.windows(2).all(|pair| pair[0].1 < pair[1].1));
        assert_eq!(rows.last().map(|row| row.0), Some(5));
    }

    #[test]
    fn natural_row_order_rejects_a_missing_target() {
        let db = seed("allocate_missing", 5);

        let error =
            allocate_before(&db, "allocate_missing", Some(99), 1).expect_err("missing target");

        assert!(error.to_string().contains("row 99"));
    }

    #[test]
    fn natural_row_order_rebalance_is_bounded_and_preserves_unaffected_keys() {
        let db = seed("allocate_rebalance", 9_000);
        let constrained_predecessor = 299 * NATURAL_ORDER_STRIDE;
        db.conn()
            .execute(
                &format!(
                    "UPDATE {} SET \"_row_order\" = CASE \"_row_id\" WHEN 299 THEN ? WHEN 300 THEN ? END WHERE \"_row_id\" IN (299, 300)",
                    table("allocate_rebalance")
                ),
                params![constrained_predecessor, constrained_predecessor + 1],
            )
            .expect("constrain interval");
        let before = effective_keys(&db, "allocate_rebalance");

        let allocation =
            allocate_before(&db, "allocate_rebalance", Some(300), 3).expect("rebalance");
        let after = effective_keys(&db, "allocate_rebalance");
        let changed = before
            .iter()
            .zip(after.iter())
            .filter(|(old, new)| old != new)
            .count();

        assert_eq!(allocation.insertion_ordinal, 299);
        assert!(allocation
            .row_orders
            .windows(2)
            .all(|pair| pair[0] < pair[1]));
        assert!(
            changed <= 8_192,
            "rebalance changed {changed} existing rows"
        );
        assert_eq!(before.first(), after.first());
        assert_eq!(before.last(), after.last());
    }

    fn set_generation_and_row_count(
        db: &DuckDbEngine,
        dataset_id: &str,
        generation: u64,
        row_count: i64,
    ) {
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET generation = ?, row_count = ? WHERE id = ?",
                params![generation as i64, row_count, dataset_id],
            )
            .expect("publish metadata");
    }

    fn query_all_windows(db: &DuckDbEngine, dataset_id: &str, generation: u64) -> Vec<i64> {
        let total: usize = db
            .conn()
            .query_row(
                "SELECT CAST(row_count AS UBIGINT) FROM _meta_datasets WHERE id = ?",
                params![dataset_id],
                |row| row.get(0),
            )
            .expect("row count");
        let mut ids = Vec::with_capacity(total);
        for start in (0..total).step_by(2_000) {
            let request = TableNavigationRequest {
                version: 1,
                request_id: format!("incremental-{start}"),
                dataset_id: dataset_id.to_string(),
                generation,
                start,
                count: (total - start).min(2_000),
                column_ids: vec![],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            };
            let TableNavigationResult { rows, .. } =
                DuckDbEngine::query_natural_navigation_window(db.conn(), &request)
                    .expect("query natural window");
            ids.extend(rows.into_iter().map(|row| row[0].as_i64().expect("row id")));
        }
        ids
    }

    fn max_anchor_gap(db: &DuckDbEngine, dataset_id: &str, generation: u64) -> usize {
        let mut statement = db
            .conn()
            .prepare(
                "SELECT ordinal FROM _table_navigation_anchors
                 WHERE dataset_id = ? AND generation = ? ORDER BY ordinal",
            )
            .expect("prepare anchors");
        let ordinals = statement
            .query_map(params![dataset_id, generation as i64], |row| {
                row.get::<_, i64>(0)
            })
            .expect("query anchors")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect anchors");
        ordinals
            .windows(2)
            .map(|pair| usize::try_from(pair[1] - pair[0]).expect("anchor gap"))
            .max()
            .unwrap_or(0)
    }

    fn anchors(db: &DuckDbEngine, dataset_id: &str) -> Vec<(i64, i64, i128, i64)> {
        let mut statement = db
            .conn()
            .prepare(
                "SELECT generation, ordinal, order_key, row_id
                 FROM _table_navigation_anchors
                 WHERE dataset_id = ?
                 ORDER BY generation, ordinal",
            )
            .expect("prepare all anchors");
        statement
            .query_map(params![dataset_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query all anchors")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect all anchors")
    }

    fn ensure_manifest_fixture_table(db: &DuckDbEngine) {
        db.conn()
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS _table_navigation_anchor_manifests (
                    dataset_id TEXT NOT NULL,
                    generation BIGINT NOT NULL,
                    row_count BIGINT NOT NULL,
                    anchor_count BIGINT NOT NULL,
                    checksum TEXT NOT NULL,
                    PRIMARY KEY (dataset_id, generation)
                );",
            )
            .expect("create manifest fixture table");
    }

    fn publish_insert(
        db: &DuckDbEngine,
        dataset_id: &str,
        source_generation: u64,
        before_row_id: i64,
        inserted_row_id: i64,
    ) -> u64 {
        let allocation =
            allocate_before(db, dataset_id, Some(before_row_id), 1).expect("allocate insert");
        insert_allocated(db, dataset_id, inserted_row_id, allocation.row_orders[0]);
        let target_generation = source_generation + 1;
        let row_count = effective_keys(db, dataset_id).len() as i64;
        set_generation_and_row_count(db, dataset_id, target_generation, row_count);
        publish_inserted_anchors(
            db,
            dataset_id,
            source_generation,
            target_generation,
            allocation.insertion_ordinal,
            &[(inserted_row_id, allocation.row_orders[0])],
        )
        .expect("publish inserted anchors");
        target_generation
    }

    #[test]
    fn incremental_anchor_insertions_repair_both_sides_of_a_boundary() {
        let dataset_id = "incremental_insert";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        reset_full_anchor_rebuild_counter();
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let generation = publish_insert(&db, dataset_id, source_generation, 4096, 90_001);
        let next_generation = publish_insert(&db, dataset_id, generation, 4098, 90_002);
        let expected_natural_row_ids = effective_keys(&db, dataset_id)
            .into_iter()
            .map(|row| row.0)
            .collect::<Vec<_>>();

        assert!(max_anchor_gap(&db, dataset_id, next_generation) <= NATURAL_ANCHOR_STRIDE);
        assert_eq!(
            query_all_windows(&db, dataset_id, next_generation),
            expected_natural_row_ids,
        );
        assert_eq!(full_anchor_rebuild_counter(), 0);
    }

    #[test]
    fn incremental_anchor_deletions_repair_both_sides_of_a_boundary() {
        let dataset_id = "incremental_delete";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        reset_full_anchor_rebuild_counter();
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let before = effective_keys(&db, dataset_id);
        let deleted = [before[4094], before[4096]];
        db.conn()
            .execute(
                &format!(
                    "DELETE FROM {} WHERE \"_row_id\" IN (?, ?)",
                    table(dataset_id)
                ),
                params![deleted[0].0, deleted[1].0],
            )
            .expect("delete boundary rows");
        let next_generation = source_generation + 1;
        set_generation_and_row_count(&db, dataset_id, next_generation, before.len() as i64 - 2);
        publish_deleted_anchors(
            &db,
            dataset_id,
            source_generation,
            next_generation,
            &[
                (deleted[0].0, deleted[0].1, 4094),
                (deleted[1].0, deleted[1].1, 4096),
            ],
        )
        .expect("publish deleted anchors");
        let expected_natural_row_ids = effective_keys(&db, dataset_id)
            .into_iter()
            .map(|row| row.0)
            .collect::<Vec<_>>();

        assert!(max_anchor_gap(&db, dataset_id, next_generation) <= NATURAL_ANCHOR_STRIDE);
        assert_eq!(
            query_all_windows(&db, dataset_id, next_generation),
            expected_natural_row_ids,
        );
        assert_eq!(full_anchor_rebuild_counter(), 0);
    }

    #[test]
    fn incremental_anchor_missing_source_fails_without_changing_any_generation() {
        let dataset_id = "incremental_missing_source";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(&db, dataset_id, 99, 100, 0, &[])
            .expect_err("missing source generation");

        assert!(error.to_string().contains("source anchor"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn incremental_anchor_malformed_source_fails_without_changing_any_generation() {
        let dataset_id = "incremental_malformed_source";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        db.conn()
            .execute(
                "DELETE FROM _table_navigation_anchors
                 WHERE dataset_id = ? AND generation = ? AND ordinal = 0",
                params![dataset_id, source_generation as i64],
            )
            .expect("malform source anchors");
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect_err("malformed source generation");

        assert!(error.to_string().contains("source anchor"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn incremental_anchor_empty_dataset_transition_remains_valid() {
        let dataset_id = "incremental_empty_transition";
        let db = seed(dataset_id, 3);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let deleted = effective_keys(&db, dataset_id)
            .into_iter()
            .enumerate()
            .map(|(ordinal, (row_id, order_key))| {
                (row_id, order_key, i64::try_from(ordinal).expect("ordinal"))
            })
            .collect::<Vec<_>>();
        db.conn()
            .execute(&format!("DELETE FROM {}", table(dataset_id)), [])
            .expect("delete all rows");
        set_generation_and_row_count(&db, dataset_id, source_generation + 1, 0);

        publish_deleted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            &deleted,
        )
        .expect("publish empty transition");

        assert!(anchors(&db, dataset_id).is_empty());
        assert!(query_all_windows(&db, dataset_id, source_generation + 1).is_empty());
    }

    #[test]
    fn incremental_anchor_insert_from_empty_dataset_remains_valid() {
        let dataset_id = "incremental_insert_from_empty";
        let db = seed(dataset_id, 0);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let allocation = allocate_before(&db, dataset_id, None, 1).expect("allocate first row");
        insert_allocated(&db, dataset_id, 1, allocation.row_orders[0]);
        set_generation_and_row_count(&db, dataset_id, source_generation + 1, 1);

        publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            allocation.insertion_ordinal,
            &[(1, allocation.row_orders[0])],
        )
        .expect("publish insertion from empty source");

        assert_eq!(
            query_all_windows(&db, dataset_id, source_generation + 1),
            vec![1]
        );
    }

    #[test]
    fn incremental_anchor_refreshes_copied_anchors_with_one_set_query() {
        let dataset_id = "incremental_set_refresh";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        reset_anchor_refresh_query_counter();

        publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect("publish unchanged anchors");

        assert_eq!(anchor_refresh_query_counter(), 1);
    }

    #[test]
    fn incremental_anchor_rejects_missing_nonzero_anchor_row_atomically() {
        let dataset_id = "incremental_missing_anchor_row";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        db.conn()
            .execute(
                "UPDATE _table_navigation_anchors SET row_id = 999999
                 WHERE dataset_id = ? AND generation = ? AND ordinal = ?",
                params![
                    dataset_id,
                    source_generation as i64,
                    NATURAL_ANCHOR_STRIDE as i64
                ],
            )
            .expect("corrupt nonzero anchor row");
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect_err("missing anchor row must fail");

        assert!(error.to_string().contains("source anchor"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn incremental_anchor_rejects_wrong_row_and_key_for_claimed_ordinal_atomically() {
        let dataset_id = "incremental_wrong_anchor_row";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let wrong_row_id = NATURAL_ANCHOR_STRIDE as i64 + 2;
        let wrong_order_key = i128::from(wrong_row_id) * NATURAL_ORDER_STRIDE;
        db.conn()
            .execute(
                "UPDATE _table_navigation_anchors SET row_id = ?, order_key = ?
                 WHERE dataset_id = ? AND generation = ? AND ordinal = ?",
                params![
                    wrong_row_id,
                    wrong_order_key,
                    dataset_id,
                    source_generation as i64,
                    NATURAL_ANCHOR_STRIDE as i64
                ],
            )
            .expect("misplace nonzero anchor");
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect_err("misplaced anchor must fail");

        assert!(error.to_string().contains("source anchor"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn incremental_anchor_local_repair_examines_only_the_affected_gap() {
        let dataset_id = "incremental_local_repair";
        let db = seed(dataset_id, 2 * NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let allocation =
            allocate_before(&db, dataset_id, Some(4096), 1).expect("allocate boundary insert");
        insert_allocated(&db, dataset_id, 90_003, allocation.row_orders[0]);
        set_generation_and_row_count(
            &db,
            dataset_id,
            source_generation + 1,
            (2 * NATURAL_ANCHOR_STRIDE + 11) as i64,
        );
        reset_repair_rows_examined();

        publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            allocation.insertion_ordinal,
            &[(90_003, allocation.row_orders[0])],
        )
        .expect("publish local repair");

        assert_eq!(repair_rows_examined(), NATURAL_ANCHOR_STRIDE);
        assert!(repair_rows_examined() < 2 * NATURAL_ANCHOR_STRIDE + 11);
        assert!(max_anchor_gap(&db, dataset_id, source_generation + 1) <= NATURAL_ANCHOR_STRIDE);
    }

    #[test]
    fn incremental_anchor_deleting_ordinal_zero_repairs_the_local_head() {
        let dataset_id = "incremental_delete_anchor_zero";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        let first = effective_keys(&db, dataset_id)[0];
        db.conn()
            .execute(
                &format!("DELETE FROM {} WHERE \"_row_id\" = ?", table(dataset_id)),
                params![first.0],
            )
            .expect("delete anchor zero row");
        set_generation_and_row_count(
            &db,
            dataset_id,
            source_generation + 1,
            (NATURAL_ANCHOR_STRIDE + 9) as i64,
        );

        publish_deleted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            &[(first.0, first.1, 0)],
        )
        .expect("publish anchor-zero deletion");

        assert_eq!(
            query_all_windows(&db, dataset_id, source_generation + 1),
            effective_keys(&db, dataset_id)
                .into_iter()
                .map(|row| row.0)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn incremental_anchor_rejects_legacy_source_without_manifest_atomically() {
        let dataset_id = "incremental_legacy_manifest";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        ensure_manifest_fixture_table(&db);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        db.conn()
            .execute(
                "DELETE FROM _table_navigation_anchor_manifests
                 WHERE dataset_id = ? AND generation = ?",
                params![dataset_id, source_generation as i64],
            )
            .expect("remove source manifest");
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect_err("legacy source requires controlled rebuild");

        assert!(error.to_string().contains("manifest"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn incremental_anchor_rejects_corrupt_manifest_atomically() {
        let dataset_id = "incremental_corrupt_manifest";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        ensure_manifest_fixture_table(&db);
        let source_generation = db.get_dataset_generation(dataset_id).expect("generation");
        db.conn()
            .execute(
                "UPDATE _table_navigation_anchor_manifests SET checksum = ?
                 WHERE dataset_id = ? AND generation = ?",
                params!["corrupt", dataset_id, source_generation as i64],
            )
            .expect("seed corrupt manifest");
        let before = anchors(&db, dataset_id);

        let error = publish_inserted_anchors(
            &db,
            dataset_id,
            source_generation,
            source_generation + 1,
            0,
            &[],
        )
        .expect_err("corrupt manifest");

        assert!(error.to_string().contains("manifest"));
        assert_eq!(anchors(&db, dataset_id), before);
    }

    #[test]
    fn natural_anchor_full_rebuild_publishes_manifest() {
        let dataset_id = "incremental_rebuild_manifest";
        let db = seed(dataset_id, NATURAL_ANCHOR_STRIDE + 10);
        ensure_manifest_fixture_table(&db);
        let generation = db.get_dataset_generation(dataset_id).expect("generation");

        db.rebuild_natural_anchors(dataset_id, generation)
            .expect("controlled rebuild");

        let count: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM _table_navigation_anchor_manifests
                 WHERE dataset_id = ? AND generation = ?",
                params![dataset_id, generation as i64],
                |row| row.get(0),
            )
            .expect("manifest count");
        assert_eq!(count, 1);
    }

    #[test]
    fn incremental_anchor_semantic_validation_has_no_global_dataset_ordering() {
        let production = include_str!("natural_row_order.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source");
        let validation = production
            .split("fn validate_source_anchor_generation")
            .nth(1)
            .expect("source validation")
            .split("fn copy_deleted_anchors_setwise")
            .next()
            .expect("validation section");

        assert!(!validation.contains("row_number()"));
        assert!(!validation.contains("ordered_rows"));

        let engine_source = include_str!("../engine/duckdb_engine.rs");
        let manifest_validation = engine_source
            .split("pub(crate) fn validate_natural_anchor_manifest")
            .nth(1)
            .expect("manifest validation")
            .split("fn natural_anchor_manifest_values")
            .next()
            .expect("manifest validation section");
        assert!(!manifest_validation.contains("row_number()"));
        assert!(!manifest_validation.contains("NATURAL_ORDER_SQL"));
        assert!(!manifest_validation.contains("internal_table_name"));
    }
}

use std::collections::{BTreeMap, HashSet};
use std::mem;
use std::time::Instant;

use duckdb::types::{OrderedMap, TimeUnit, Value};
use duckdb::{params, params_from_iter, Config, Connection};

use crate::engine::sql_query::{normalize_identifier, validate_read_only_query};
use crate::error::AppError;
use crate::models::graph_data::{
    BoxPlotEntry, BoxPlotOutlier, BoxPlotPacket, GraphAggregatePacket, GraphDataRequest,
    GraphSampling, HeatmapCell, HeatmapPacket, HistogramBin, HistogramPacket, SummaryEntry,
    SummaryPacket, GRAPH_VIRTUAL_SOURCE_COLUMN, GRAPH_VIRTUAL_VALUE_COLUMN,
};
use crate::models::table::{
    CellPosition, CellUpdate, CreateTableFromRowsRequest, DatasetMeta, SqlQueryResult,
    TableQueryResult, TableWindowFilterRule, TableWindowRequest, TableWindowResult,
};
use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateResult, TabulateStatistic};
use crate::services::archive_cell::archive_export_expression;

/// DuckDB engine wrapper
pub struct DuckDbEngine {
    conn: Connection,
}

pub struct GraphProjectionStats {
    pub source_rows: u64,
    pub projected_columns: Vec<String>,
    pub projected_column_types: Vec<String>,
}

struct GraphQueryPlan {
    source_sql: String,
    source_values: Vec<Value>,
    projection_sql: String,
    projection_values: Vec<Value>,
    projection_select_items: Vec<String>,
    projected_columns: Vec<String>,
    projected_column_types: Vec<String>,
}

struct MaterializedQuery {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
}
type GroupedStatisticValues = std::collections::HashMap<(String, String), Vec<Option<f64>>>;

fn role_column(request: &GraphDataRequest, role_name: &str) -> Option<String> {
    request
        .fields
        .iter()
        .find(|field| field.role.eq_ignore_ascii_case(role_name))
        .map(|field| field.column.clone())
}

fn is_sampling_strata_role(role: &str) -> bool {
    matches!(
        role,
        "group" | "filter" | "groupx" | "groupy" | "groupz" | "wrap" | "overlay" | "color" | "x"
    ) || role.starts_with("multix")
        || role.starts_with("multiy")
}

pub(crate) struct ArchiveKeysetReadPlan {
    select_sql: String,
    pub columns: Vec<(String, String)>,
}

pub(crate) struct ArchiveBatchRow {
    pub row_id: i64,
    pub values: Vec<Value>,
    pub retained_bytes_estimate: usize,
}

pub(crate) struct ArchiveBatch {
    pub rows: Vec<ArchiveBatchRow>,
    pub retained_bytes_estimate: usize,
}

impl DuckDbEngine {
    /// Get a reference to the underlying connection
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    fn bump_dataset_generation(&self, dataset_id: &str) -> Result<(), AppError> {
        let changed = self.conn.execute(
            "UPDATE _meta_datasets SET generation = generation + 1 WHERE id = ?",
            params![dataset_id],
        )?;
        if changed == 0 {
            return Err(AppError::InvalidParam(format!(
                "unknown dataset: {dataset_id}"
            )));
        }
        Ok(())
    }

    pub fn get_dataset_generation(&self, dataset_id: &str) -> Result<u64, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT generation FROM _meta_datasets WHERE id = $1")?;
        let mut rows = stmt.query(params![dataset_id])?;
        let generation: i64 = rows
            .next()?
            .ok_or_else(|| AppError::InvalidParam(format!("unknown dataset: {dataset_id}")))?
            .get(0)?;
        u64::try_from(generation)
            .map_err(|_| AppError::Database("dataset generation is negative".into()))
    }

    fn with_row_mutation<T>(
        &self,
        dataset_id: &str,
        operation: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = operation().and_then(|value| {
            self.bump_dataset_generation(dataset_id)?;
            Ok(value)
        });
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    #[cfg(any(test, feature = "perf-harness"))]
    pub(crate) fn seed_benchmark_table(
        &self,
        id: &str,
        name: &str,
        row_count: usize,
        column_count: usize,
    ) -> Result<(), AppError> {
        if column_count == 0 {
            return Err(AppError::InvalidParam(
                "benchmark column count must be at least 1".into(),
            ));
        }

        let column_names = (1..=column_count)
            .map(|index| format!("value_{index}"))
            .collect::<Vec<_>>();
        let column_types = (0..column_count)
            .map(|index| match index % 3 {
                0 => "BIGINT".to_string(),
                1 => "DOUBLE".to_string(),
                _ => "VARCHAR".to_string(),
            })
            .collect::<Vec<_>>();
        self.create_empty_table(id, name, &column_names, &column_types)?;

        let generated_columns = (0..column_count)
            .map(|index| match index % 3 {
                0 => format!("CAST(i * {} AS BIGINT)", index + 1),
                1 => format!("CAST(i AS DOUBLE) / {}", index + 1),
                _ => "'group_' || CAST(i % 100 AS VARCHAR)".to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        let table_name = Self::quote_identifier(&Self::internal_table_name(id));
        let upper_bound = row_count
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("benchmark row count is too large".into()))?;
        let upper_bound = i64::try_from(upper_bound)
            .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?;
        self.conn.execute(
            &format!(
                "INSERT INTO {table_name} SELECT i, {generated_columns} FROM range(1, CAST(? AS BIGINT)) AS generated(i)"
            ),
            params![upper_bound],
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count as i64, id],
        )?;

        Ok(())
    }

    /// Create a new in-memory DuckDB engine and initialize metadata tables
    pub fn new_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS _meta_datasets (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                source_path TEXT,
                source_type TEXT,
                row_count   BIGINT DEFAULT 0,
                col_count   INTEGER DEFAULT 0,
                generation  BIGINT DEFAULT 0,
                created_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR)),
                updated_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR))
            );

            CREATE TABLE IF NOT EXISTS _meta_columns (
                dataset_id  TEXT,
                col_index   INTEGER,
                col_name    TEXT,
                col_type    TEXT,
                role        TEXT DEFAULT 'continuous',
                missing_count BIGINT DEFAULT 0,
                PRIMARY KEY (dataset_id, col_index)
            );

            CREATE TABLE IF NOT EXISTS _history_change_sets (
                id          TEXT PRIMARY KEY,
                dataset_id  TEXT NOT NULL,
                applied     BOOLEAN NOT NULL DEFAULT TRUE,
                generation  BIGINT NOT NULL,
                created_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR))
            );

            CREATE TABLE IF NOT EXISTS _history_change_set_columns (
                change_set_id TEXT NOT NULL,
                ordinal       INTEGER NOT NULL,
                column_index  INTEGER NOT NULL,
                before_name   TEXT,
                before_type   TEXT,
                after_name    TEXT NOT NULL,
                after_type    TEXT NOT NULL,
                after_present BOOLEAN NOT NULL DEFAULT TRUE,
                PRIMARY KEY (change_set_id, ordinal)
            );
            ",
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS after_present BOOLEAN DEFAULT TRUE",
            [],
        )?;
        conn.execute(
            "UPDATE _history_change_set_columns SET after_present = TRUE WHERE after_present IS NULL",
            [],
        )?;

        Ok(Self { conn })
    }

    pub fn tabulate(&self, request: &TabulateRequest) -> Result<TabulateResult, AppError> {
        let dataset_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_datasets WHERE id = $1",
            params![&request.dataset_id],
            |row| row.get(0),
        )?;
        if dataset_exists == 0 {
            return Err(AppError::InvalidParam(format!(
                "Unknown dataset: {}",
                request.dataset_id
            )));
        }

        validate_unique_fields("row", &request.row_fields)?;
        validate_unique_fields("column", &request.column_fields)?;

        let table_name = format!("dataset_{}", request.dataset_id.replace('-', "_"));
        let mut columns_stmt = self.conn.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        )?;
        let columns: Vec<(String, String)> = columns_stmt
            .query_map(params![&table_name], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if columns.is_empty() {
            return Err(AppError::InvalidParam(format!(
                "Unknown dataset: {}",
                request.dataset_id
            )));
        }

        let column_types: std::collections::HashMap<String, String> = columns.into_iter().collect();

        for field in request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
        {
            if !column_types.contains_key(field) {
                return Err(AppError::InvalidParam(format!("Unknown field: {field}",)));
            }
        }

        for statistic in &request.statistics {
            let data_type = column_types.get(&statistic.field).ok_or_else(|| {
                AppError::InvalidParam(format!("Unknown field: {}", statistic.field))
            })?;

            if requires_numeric_field(&statistic.kind) && !is_numeric_type(data_type) {
                return Err(AppError::InvalidParam(format!(
                    "Field '{}' must be numeric for {:?}",
                    statistic.field, statistic.kind
                )));
            }

            if matches!(statistic.kind, StatisticKind::Quantile) {
                let probability = statistic.quantile.ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "Quantile statistic '{}' requires quantile",
                        statistic.id
                    ))
                })?;
                if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
                    return Err(AppError::InvalidParam(
                        "quantile must be finite and in [0,1]".into(),
                    ));
                }
            }
        }

        let row_count = grouped_cardinality(&self.conn, &table_name, &request.row_fields)?;
        let column_count = grouped_cardinality(&self.conn, &table_name, &request.column_fields)?;
        let cell_count = row_count
            .checked_mul(column_count)
            .and_then(|value| value.checked_mul(request.statistics.len() as u64))
            .ok_or_else(|| AppError::InvalidParam("Tabulate result size overflow".into()))?;
        if cell_count > request.max_result_cells {
            return Err(AppError::InvalidParam(format!(
                "Tabulate result has {cell_count} cells; limit is {}",
                request.max_result_cells,
            )));
        }

        let row_members =
            self.query_dimension_members(&table_name, &request.row_fields, &column_types)?;
        let column_members =
            self.query_dimension_members(&table_name, &request.column_fields, &column_types)?;
        let grouped_values = self.query_grouped_values(
            &table_name,
            &request.row_fields,
            &request.column_fields,
            &request.statistics,
            &column_types,
        )?;
        let needs_row_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::RowPercentage));
        let needs_column_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::ColumnPercentage));
        let needs_total_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::TotalPercentage));
        let needs_percentage_denominators =
            needs_row_denominators || needs_column_denominators || needs_total_denominators;

        let mut cells = Vec::with_capacity(cell_count as usize);
        for row_member in &row_members {
            let row_key = member_key(row_member)?;
            for column_member in &column_members {
                let column_key = member_key(column_member)?;
                if let Some(values) = grouped_values.get(&(row_key.clone(), column_key.clone())) {
                    cells.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        cells.push(default_missing_value(&statistic.kind));
                    }
                }
            }
        }

        let raw_row_totals = if request.include_row_totals || needs_row_denominators {
            let totals = self.query_grouped_values(
                &table_name,
                &request.row_fields,
                &[],
                &request.statistics,
                &column_types,
            )?;
            let empty_key = member_key(&[])?;
            let mut flattened = Vec::with_capacity(row_members.len() * request.statistics.len());
            for row_member in &row_members {
                let row_key = member_key(row_member)?;
                if let Some(values) = totals.get(&(row_key, empty_key.clone())) {
                    flattened.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        flattened.push(default_missing_value(&statistic.kind));
                    }
                }
            }
            flattened
        } else {
            Vec::new()
        };

        let raw_column_totals = if request.include_column_totals || needs_column_denominators {
            let totals = self.query_grouped_values(
                &table_name,
                &[],
                &request.column_fields,
                &request.statistics,
                &column_types,
            )?;
            let empty_key = member_key(&[])?;
            let mut flattened = Vec::with_capacity(column_members.len() * request.statistics.len());
            for column_member in &column_members {
                let column_key = member_key(column_member)?;
                if let Some(values) = totals.get(&(empty_key.clone(), column_key)) {
                    flattened.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        flattened.push(default_missing_value(&statistic.kind));
                    }
                }
            }
            flattened
        } else {
            Vec::new()
        };

        let raw_grand_totals = if request.include_row_totals
            || request.include_column_totals
            || needs_percentage_denominators
        {
            let totals = self.query_grouped_values(
                &table_name,
                &[],
                &[],
                &request.statistics,
                &column_types,
            )?;
            totals
                .get(&(member_key(&[])?, member_key(&[])?))
                .cloned()
                .unwrap_or_else(|| {
                    request
                        .statistics
                        .iter()
                        .map(|statistic| default_missing_value(&statistic.kind))
                        .collect()
                })
        } else {
            Vec::new()
        };

        let mut row_totals = if request.include_row_totals {
            raw_row_totals.clone()
        } else {
            Vec::new()
        };
        let mut column_totals = if request.include_column_totals {
            raw_column_totals.clone()
        } else {
            Vec::new()
        };
        let mut grand_totals = if request.include_row_totals || request.include_column_totals {
            raw_grand_totals.clone()
        } else {
            Vec::new()
        };

        if needs_percentage_denominators {
            let mut percentage_context = PercentageTransformContext {
                row_count: row_members.len(),
                column_count: column_members.len(),
                cells: &mut cells,
                row_totals: &mut row_totals,
                column_totals: &mut column_totals,
                grand_totals: &mut grand_totals,
                raw_row_totals: &raw_row_totals,
                raw_column_totals: &raw_column_totals,
                raw_grand_totals: &raw_grand_totals,
            };
            transform_percentage_values(&request.statistics, &mut percentage_context);
        }

        Ok(TabulateResult {
            row_members,
            column_members,
            statistics: request.statistics.clone(),
            cells,
            row_totals,
            column_totals,
            grand_totals,
            cell_count,
            limit: request.max_result_cells,
        })
    }

    fn query_dimension_members(
        &self,
        table_name: &str,
        dimensions: &[String],
        column_types: &std::collections::HashMap<String, String>,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        if dimensions.is_empty() {
            return Ok(vec![vec![]]);
        }

        let table_ident = quote_identifier(table_name);
        let select_dimensions = dimensions
            .iter()
            .enumerate()
            .map(|(index, field)| {
                dimension_select_expression(field, column_types)
                    .map(|expression| format!("{expression} AS \"__dim_{index}\""))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let group_dimensions = dimensions
            .iter()
            .map(|field| quote_identifier(field))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = build_nulls_last_order(dimensions);
        let sql = format!(
            "SELECT {select_dimensions} FROM {table_ident} GROUP BY {group_dimensions} ORDER BY {order_clause}"
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut members = Vec::new();
        while let Some(row) = rows.next()? {
            let mut values = Vec::with_capacity(dimensions.len());
            for index in 0..dimensions.len() {
                let value: Value = row.get(index)?;
                values.push(json_dimension_value(value));
            }
            members.push(values);
        }
        Ok(members)
    }

    fn query_grouped_values(
        &self,
        table_name: &str,
        row_fields: &[String],
        column_fields: &[String],
        statistics: &[TabulateStatistic],
        column_types: &std::collections::HashMap<String, String>,
    ) -> Result<GroupedStatisticValues, AppError> {
        let dimensions = row_fields
            .iter()
            .chain(column_fields.iter())
            .cloned()
            .collect::<Vec<_>>();
        let table_ident = quote_identifier(table_name);
        let statistic_sql = statistics
            .iter()
            .enumerate()
            .map(|(index, statistic)| {
                aggregate_sql(statistic).map(|sql| format!("{sql} AS \"__stat_{index}\""))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let sql = if dimensions.is_empty() {
            format!("SELECT {} FROM {}", statistic_sql.join(", "), table_ident)
        } else {
            let select_dimensions = dimensions
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    dimension_select_expression(field, column_types)
                        .map(|expression| format!("{expression} AS \"__dim_{index}\""))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            let group_dimensions = dimensions
                .iter()
                .map(|field| quote_identifier(field))
                .collect::<Vec<_>>()
                .join(", ");
            let order_clause = build_nulls_last_order(&dimensions);
            format!(
                "SELECT {select_dimensions}, {} FROM {table_ident} GROUP BY {group_dimensions} ORDER BY {order_clause}",
                statistic_sql.join(", "),
            )
        };

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut grouped = GroupedStatisticValues::new();
        while let Some(row) = rows.next()? {
            let mut row_member = Vec::with_capacity(row_fields.len());
            let mut column_member = Vec::with_capacity(column_fields.len());
            for index in 0..row_fields.len() {
                let value: Value = row.get(index)?;
                row_member.push(json_dimension_value(value));
            }
            for index in 0..column_fields.len() {
                let value: Value = row.get(row_fields.len() + index)?;
                column_member.push(json_dimension_value(value));
            }

            let mut values = Vec::with_capacity(statistics.len());
            let stats_offset = dimensions.len();
            for stat_index in 0..statistics.len() {
                let value: Value = row.get(stats_offset + stat_index)?;
                values.push(numeric_cell_value(value)?);
            }

            grouped.insert(
                (member_key(&row_member)?, member_key(&column_member)?),
                values,
            );
        }

        Ok(grouped)
    }

    /// Import a CSV file as a new dataset
    pub fn import_csv(
        &self,
        id: &str,
        name: &str,
        file_path: &str,
    ) -> Result<DatasetMeta, AppError> {
        self.validate_dataset_name(name, None)?;
        let table_name = format!("dataset_{}", id.replace('-', "_"));

        // Create table from CSV with the stable row identity required by
        // bounded windows, edits, history, and project serialization.
        let create_sql = format!(
            "CREATE TABLE \"{}\" AS SELECT ROW_NUMBER() OVER () AS \"_row_id\", __csv__.* FROM read_csv($1, auto_detect=true) AS __csv__",
            table_name
        );
        self.conn.execute(&create_sql, params![file_path])?;

        // Get row count
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info
        let mut col_stmt = self.conn.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name <> '_row_id' ORDER BY ordinal_position",
        )?;

        let col_count: i32 = {
            let mut rows = col_stmt.query(params![table_name])?;
            let mut count = 0i32;
            let mut col_index = 0i32;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(0)?;
                let col_type: String = row.get(1)?;
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index, col_name, col_type],
                )?;
                col_index += 1;
                count += 1;
            }
            count
        };

        // Insert dataset metadata
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'csv', $4, $5)",
            params![id, name, file_path, row_count, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Get metadata for a single dataset
    pub fn get_dataset_meta(&self, id: &str) -> Result<DatasetMeta, AppError> {
        let meta = self.conn.query_row(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets WHERE id = $1",
            params![id],
            |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )?;
        Ok(meta)
    }

    /// List all datasets
    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets ORDER BY created_at DESC",
        )?;

        let datasets = stmt
            .query_map([], |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(datasets)
    }

    /// Delete a dataset and its metadata
    pub fn delete_dataset(&self, id: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", id.replace('-', "_"));
        self.conn
            .execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM _meta_datasets WHERE id = $1", params![id])?;
        Ok(())
    }

    /// Execute a read-only SQL query against the visible dataset names.
    pub fn execute_sql_query(
        &self,
        sql: &str,
        page: usize,
        page_size: usize,
    ) -> Result<SqlQueryResult, AppError> {
        if page == 0 {
            return Err(AppError::InvalidParam("page must be at least 1".into()));
        }
        if !(1..=200).contains(&page_size) {
            return Err(AppError::InvalidParam(
                "page_size must be between 1 and 200".into(),
            ));
        }

        let started_at = Instant::now();
        let sql = self.validate_query_against_visible_tables(sql)?;
        let snapshot = self.build_isolated_snapshot_connection()?;
        let result = self.collect_sql_query_page(&snapshot, &sql, page, page_size)?;

        Ok(SqlQueryResult {
            execution_time_ms: started_at.elapsed().as_millis(),
            ..result
        })
    }

    /// Create a managed dataset from a guarded read-only SQL query.
    pub fn create_table_from_sql_query(
        &self,
        id: &str,
        name: &str,
        sql: &str,
    ) -> Result<DatasetMeta, AppError> {
        let sql = self.validate_query_against_visible_tables(sql)?;
        let snapshot = self.build_isolated_snapshot_connection()?;
        let materialized = self.collect_sql_query_rows(&snapshot, &sql)?;

        self.conn.execute_batch("BEGIN TRANSACTION")?;

        let outcome = (|| -> Result<DatasetMeta, AppError> {
            self.validate_dataset_name(name, None)?;

            let table_name = Self::internal_table_name(id);
            let quoted_table = Self::quote_identifier(&table_name);
            let column_defs = materialized
                .columns
                .iter()
                .zip(materialized.column_types.iter())
                .map(|(column_name, column_type)| {
                    format!("{} {}", Self::quote_identifier(column_name), column_type)
                })
                .collect::<Vec<_>>();

            let create_sql = if column_defs.is_empty() {
                format!("CREATE TABLE {} (\"_row_id\" BIGINT)", quoted_table)
            } else {
                format!(
                    "CREATE TABLE {} (\"_row_id\" BIGINT, {})",
                    quoted_table,
                    column_defs.join(", ")
                )
            };
            self.conn.execute(&create_sql, [])?;

            let insert_columns = std::iter::once(Self::quote_identifier("_row_id"))
                .chain(
                    materialized
                        .columns
                        .iter()
                        .map(|column_name| Self::quote_identifier(column_name)),
                )
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = std::iter::once("?".to_string())
                .chain(
                    materialized
                        .column_types
                        .iter()
                        .map(|column_type| Self::typed_parameter_expression(column_type)),
                )
                .collect::<Vec<_>>()
                .join(", ");
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                quoted_table, insert_columns, placeholders
            );

            for (row_index, row_values) in materialized.rows.iter().enumerate() {
                let mut values = Vec::with_capacity(row_values.len() + 1);
                values.push(Value::BigInt((row_index + 1) as i64));
                values.extend(row_values.iter().cloned());
                self.conn.execute(&insert_sql, params_from_iter(values))?;
            }

            for (col_index, (col_name, col_type)) in materialized
                .columns
                .iter()
                .zip(materialized.column_types.iter())
                .enumerate()
            {
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index as i32, col_name, col_type],
                )?;
            }

            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, NULL, 'query', $3, $4)",
                params![id, name, materialized.rows.len() as i64, materialized.columns.len() as i32],
            )?;

            self.get_dataset_meta(id)
        })();

        match outcome {
            Ok(meta) => {
                Self::finalize_transaction(
                    || {
                        self.conn.execute_batch("COMMIT")?;
                        Ok(())
                    },
                    || {
                        let _ = self.conn.execute_batch("ROLLBACK");
                    },
                )?;
                Ok(meta)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn create_table_from_rows(
        &self,
        id: &str,
        request: &CreateTableFromRowsRequest,
    ) -> Result<DatasetMeta, AppError> {
        if request.column_names.is_empty() {
            return Err(AppError::InvalidParam(
                "Column names and types must not be empty".into(),
            ));
        }
        if request.column_names.len() != request.column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }
        for (row_index, row) in request.rows.iter().enumerate() {
            if row.len() != request.column_names.len() {
                return Err(AppError::InvalidParam(format!(
                    "row {} has width {}, expected {}",
                    row_index + 1,
                    row.len(),
                    request.column_names.len()
                )));
            }
            for (column_index, value) in row.iter().enumerate() {
                if !matches!(
                    value,
                    serde_json::Value::Null
                        | serde_json::Value::Bool(_)
                        | serde_json::Value::Number(_)
                        | serde_json::Value::String(_)
                ) {
                    return Err(AppError::InvalidParam(format!(
                        "row {} column {} must be a scalar JSON value",
                        row_index + 1,
                        column_index + 1
                    )));
                }
            }
        }

        self.validate_dataset_name(&request.name, None)?;
        Self::validate_result_column_names(&request.column_names)?;
        let canonical_types = request
            .column_types
            .iter()
            .map(|column_type| self.canonicalize_column_type(column_type))
            .collect::<Result<Vec<_>, _>>()?;

        for (row_index, row) in request.rows.iter().enumerate() {
            for (column_index, (value, column_type)) in
                row.iter().zip(canonical_types.iter()).enumerate()
            {
                let duckdb_value = Self::json_scalar_to_duckdb_value(
                    value,
                    row_index + 1,
                    column_index + 1,
                )?;
                let validation_sql = format!(
                    "SELECT {}",
                    Self::typed_parameter_expression(column_type)
                );
                self.conn
                    .query_row(&validation_sql, params![duckdb_value], |_| Ok(()))
                    .map_err(|error| {
                        AppError::InvalidParam(format!(
                            "row {} column {} is incompatible with {}: {}",
                            row_index + 1,
                            column_index + 1,
                            column_type,
                            error
                        ))
                    })?;
            }
        }

        self.conn.execute_batch("BEGIN TRANSACTION")?;

        let outcome = (|| -> Result<DatasetMeta, AppError> {
            let table_name = Self::internal_table_name(id);
            let quoted_table = Self::quote_identifier(&table_name);
            let column_defs = request
                .column_names
                .iter()
                .zip(canonical_types.iter())
                .map(|(column_name, column_type)| {
                    format!("{} {}", Self::quote_identifier(column_name), column_type)
                })
                .collect::<Vec<_>>();

            let create_sql = format!(
                "CREATE TABLE {} (\"_row_id\" INTEGER, {})",
                quoted_table,
                column_defs.join(", ")
            );
            self.conn.execute(&create_sql, [])?;

            for (col_index, (col_name, col_type)) in request
                .column_names
                .iter()
                .zip(canonical_types.iter())
                .enumerate()
            {
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index as i32, col_name, col_type],
                )?;
            }

            let insert_columns = std::iter::once(Self::quote_identifier("_row_id"))
                .chain(
                    request
                        .column_names
                        .iter()
                        .map(|column_name| Self::quote_identifier(column_name)),
                )
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = std::iter::once("?".to_string())
                .chain(
                    canonical_types
                        .iter()
                        .map(|column_type| Self::typed_parameter_expression(column_type)),
                )
                .collect::<Vec<_>>()
                .join(", ");
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                quoted_table, insert_columns, placeholders
            );
            let mut insert_stmt = self.conn.prepare(&insert_sql)?;

            for (row_index, row) in request.rows.iter().enumerate() {
                let row_id = i64::try_from(row_index + 1).map_err(|_| {
                    AppError::InvalidParam("row count exceeds supported limits".into())
                })?;
                let mut values = Vec::with_capacity(row.len() + 1);
                values.push(Value::BigInt(row_id));
                for (column_index, value) in row.iter().enumerate() {
                    values.push(Self::json_scalar_to_duckdb_value(
                        value,
                        row_index + 1,
                        column_index + 1,
                    )?);
                }
                insert_stmt.execute(params_from_iter(values))?;
            }

            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, NULL, 'manual', $3, $4)",
                params![id, request.name, request.rows.len() as i64, request.column_names.len() as i32],
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![request.rows.len() as i64, id],
            )?;

            self.get_dataset_meta(id)
        })();

        match outcome {
            Ok(meta) => {
                Self::finalize_transaction(
                    || {
                        self.conn.execute_batch("COMMIT")?;
                        Ok(())
                    },
                    || {
                        let _ = self.conn.execute_batch("ROLLBACK");
                    },
                )?;
                Ok(meta)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn json_scalar_to_duckdb_value(
        value: &serde_json::Value,
        row_index: usize,
        column_index: usize,
    ) -> Result<Value, AppError> {
        match value {
            serde_json::Value::Null => Ok(Value::Null),
            serde_json::Value::Bool(value) => Ok(Value::Boolean(*value)),
            serde_json::Value::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    Ok(Value::BigInt(integer))
                } else if let Some(integer) = value.as_u64() {
                    Ok(Value::UBigInt(integer))
                } else if let Some(float) = value.as_f64() {
                    Ok(Value::Double(float))
                } else {
                    Err(AppError::InvalidParam(format!(
                        "row {row_index} column {column_index} number is not representable"
                    )))
                }
            }
            serde_json::Value::String(value) => Ok(Value::Text(value.clone())),
            _ => Err(AppError::InvalidParam(format!(
                "row {row_index} column {column_index} must be a scalar JSON value"
            ))),
        }
    }

    /// Query a dataset table with pagination
    pub fn query_table_window(
        &self,
        request: &TableWindowRequest,
    ) -> Result<TableWindowResult, AppError> {
        if !(1..=2_000).contains(&request.count) {
            return Err(AppError::InvalidParam(
                "window count must be between 1 and 2000".into(),
            ));
        }
        let offset = i64::try_from(request.start)
            .map_err(|_| AppError::InvalidParam("window start is too large".into()))?;
        let limit = i64::try_from(request.count)
            .map_err(|_| AppError::InvalidParam("window count is too large".into()))?;

        let generation = self.get_dataset_generation(&request.dataset_id)?;
        if generation != request.generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {generation}, received {}",
                request.generation
            )));
        }

        let user_columns = self.get_user_columns(&request.dataset_id)?;
        let allowed_columns = user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let (where_clause, filter_values) =
            Self::compile_table_window_filters(&request.filters, &allowed_columns)?;

        let order_clause = if let Some(sort) = &request.sort {
            if sort.column != "_row_id" && !allowed_columns.contains_key(sort.column.as_str()) {
                return Err(AppError::InvalidParam(format!(
                    "unknown sort column: {}",
                    sort.column
                )));
            }
            let direction = if sort.descending { "DESC" } else { "ASC" };
            let sort_column = Self::quote_identifier(&sort.column);
            if sort.column == "_row_id" {
                format!("ORDER BY {sort_column} {direction}")
            } else {
                format!("ORDER BY {sort_column} {direction}, \"_row_id\" ASC")
            }
        } else {
            "ORDER BY \"_row_id\" ASC".to_string()
        };

        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
        let count_sql = format!("SELECT COUNT(*) FROM {table_name} {where_clause}");
        let total_rows: i64 =
            self.conn
                .query_row(&count_sql, params_from_iter(filter_values.iter()), |row| {
                    row.get(0)
                })?;

        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["BIGINT".to_string()];
        columns.extend(user_columns.iter().map(|(name, _)| name.clone()));
        column_types.extend(
            user_columns
                .iter()
                .map(|(_, column_type)| column_type.clone()),
        );
        let select_columns = columns
            .iter()
            .zip(column_types.iter())
            .map(|(column, column_type)| {
                let quoted = Self::quote_identifier(column);
                let normalized_type = column_type.to_ascii_uppercase();
                if normalized_type.starts_with("DATE")
                    || normalized_type.starts_with("TIME")
                    || normalized_type.starts_with("INTERVAL")
                {
                    format!("CAST({quoted} AS VARCHAR) AS {quoted}")
                } else {
                    quoted
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let query_sql = format!(
            "SELECT {select_columns} FROM {table_name} {where_clause} {order_clause} LIMIT ? OFFSET ?"
        );
        let mut query_values = filter_values;
        query_values.push(Value::BigInt(limit));
        query_values.push(Value::BigInt(offset));
        let mut stmt = self.conn.prepare(&query_sql)?;
        let mut result_rows = stmt.query(params_from_iter(query_values.iter()))?;
        let mut rows = Vec::with_capacity(request.count.min(total_rows.max(0) as usize));
        while let Some(row) = result_rows.next()? {
            let mut values = Vec::with_capacity(columns.len());
            for column_index in 0..columns.len() {
                values.push(Self::duckdb_value_to_json(row.get(column_index)?));
            }
            rows.push(values);
        }

        Ok(TableWindowResult {
            columns,
            column_types,
            rows,
            total_rows,
            start: request.start,
            generation,
        })
    }

    pub fn locate_table_row(
        &self,
        dataset_id: &str,
        row_id: i64,
        filters: &[crate::models::table::TableWindowFilter],
        generation: u64,
    ) -> Result<Option<usize>, AppError> {
        let current_generation = self.get_dataset_generation(dataset_id)?;
        if generation != current_generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {generation}"
            )));
        }

        let user_columns = self.get_user_columns(dataset_id)?;
        let allowed_columns = user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let (where_clause, mut values) =
            Self::compile_table_window_filters(filters, &allowed_columns)?;
        values.push(Value::BigInt(row_id));
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let sql = format!(
            "WITH filtered AS (
                SELECT \"_row_id\", row_number() OVER (ORDER BY \"_row_id\" ASC) - 1 AS logical_index
                FROM {table_name} {where_clause}
             )
             SELECT logical_index FROM filtered WHERE \"_row_id\" = ?"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(values.iter()))?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let index: i64 = row.get(0)?;
        usize::try_from(index)
            .map(Some)
            .map_err(|_| AppError::Database("logical row index is negative".into()))
    }

    pub fn query_table_filter_values(
        &self,
        dataset_id: &str,
        field: &str,
        search: &str,
        limit: usize,
        generation: u64,
    ) -> Result<Vec<String>, AppError> {
        if !(1..=500).contains(&limit) {
            return Err(AppError::InvalidParam(
                "filter value limit must be between 1 and 500".into(),
            ));
        }
        let current_generation = self.get_dataset_generation(dataset_id)?;
        if generation != current_generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {generation}"
            )));
        }
        if !self
            .get_user_columns(dataset_id)?
            .iter()
            .any(|(name, _)| name == field)
        {
            return Err(AppError::InvalidParam(format!(
                "unknown filter column: {field}"
            )));
        }

        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let column = Self::quote_identifier(field);
        let sql = format!(
            "SELECT DISTINCT COALESCE(CAST({column} AS VARCHAR), '') AS value
             FROM {table}
             WHERE strpos(lower(COALESCE(CAST({column} AS VARCHAR), '')), lower(?)) > 0
             ORDER BY lower(value), value
             LIMIT ?"
        );
        let limit = i64::try_from(limit)
            .map_err(|_| AppError::InvalidParam("filter value limit is too large".into()))?;
        let mut stmt = self.conn.prepare(&sql)?;
        let values = stmt
            .query_map(params![search, limit], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }

    pub fn stream_graph_projection_rows<FMeta, F>(
        &self,
        request: &GraphDataRequest,
        include_row_id: bool,
        mut on_projection: FMeta,
        mut on_row: F,
    ) -> Result<GraphProjectionStats, AppError>
    where
        FMeta: FnMut(&GraphProjectionStats) -> Result<(), AppError>,
        F: FnMut(Option<i64>, Vec<Value>, u64) -> Result<bool, AppError>,
    {
        let current_generation = self.get_dataset_generation(&request.dataset_id)?;
        if current_generation != request.generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {}",
                request.generation
            )));
        }

        let user_columns = self.get_user_columns(&request.dataset_id)?;
        let allowed_columns = user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let plan = self.compile_graph_query_plan(request, &allowed_columns)?;

        let mut stats = GraphProjectionStats {
            source_rows: 0,
            projected_columns: plan.projected_columns.clone(),
            projected_column_types: plan.projected_column_types.clone(),
        };
        on_projection(&stats)?;

        let source_count_sql = format!(
            "SELECT COUNT(*) FROM ({}) AS __sp_graph_source",
            plan.source_sql
        );
        let source_rows_i64: i64 = self.conn.query_row(
            &source_count_sql,
            params_from_iter(plan.source_values.iter()),
            |row| row.get(0),
        )?;
        stats.source_rows = u64::try_from(source_rows_i64)
            .map_err(|_| AppError::Database("graph source row count is negative".into()))?;

        let select_sql = self.build_graph_projection_select_sql(&plan, include_row_id);

        let mut stmt = self.conn.prepare(&select_sql)?;
        let mut rows = stmt.query(params_from_iter(plan.projection_values.iter()))?;
        while let Some(row) = rows.next()? {
            let row_id = if include_row_id {
                Some(row.get::<_, i64>(0)?)
            } else {
                None
            };

            let start_index = if include_row_id { 1 } else { 0 };
            let mut values = Vec::with_capacity(plan.projected_columns.len());
            for index in 0..plan.projected_columns.len() {
                values.push(row.get::<_, Value>(start_index + index)?);
            }
            if !on_row(row_id, values, stats.source_rows)? {
                break;
            }
        }

        Ok(stats)
    }

    fn build_graph_projection_select_sql(
        &self,
        plan: &GraphQueryPlan,
        include_row_id: bool,
    ) -> String {
        let row_id_select = if include_row_id { "\"_row_id\", " } else { "" };
        format!(
            "SELECT {row_id_select}{projection} FROM ({}) AS __sp_graph_projection ORDER BY \"_row_id\" ASC",
            plan.projection_sql,
            projection = plan.projection_select_items.join(", ")
        )
    }

    fn compile_graph_query_plan(
        &self,
        request: &GraphDataRequest,
        allowed_columns: &std::collections::HashMap<&str, &str>,
    ) -> Result<GraphQueryPlan, AppError> {
        let role_to_column = request
            .fields
            .iter()
            .map(|field| {
                (
                    field.role.to_ascii_lowercase(),
                    field.column.trim().to_string(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();

        let y_column = role_to_column
            .get("y")
            .ok_or_else(|| AppError::InvalidParam("graph request is missing role y".into()))?
            .clone();

        let x_column = role_to_column.get("x").cloned();
        let group_column = role_to_column.get("group").cloned();
        let size_column = role_to_column.get("size").cloned();
        let z_column = role_to_column.get("z").cloned();
        let group_x_column = role_to_column.get("groupx").cloned();
        let group_y_column = role_to_column.get("groupy").cloned();
        let group_z_column = role_to_column.get("groupz").cloned();
        let wrap_column = role_to_column.get("wrap").cloned();

        let mut multi_y_columns = request
            .fields
            .iter()
            .filter(|field| field.role.to_ascii_lowercase().starts_with("multiy"))
            .map(|field| field.column.trim().to_string())
            .collect::<Vec<_>>();
        multi_y_columns.sort();
        multi_y_columns.dedup();

        let validate_column = |column_name: &str| -> Result<(), AppError> {
            if column_name.is_empty() {
                return Err(AppError::InvalidParam(
                    "graph field column must not be blank".to_string(),
                ));
            }
            if !allowed_columns.contains_key(column_name) {
                return Err(AppError::InvalidParam(format!(
                    "unknown graph column: {column_name}"
                )));
            }
            Ok(())
        };

        validate_column(&y_column)?;
        if let Some(column) = &x_column {
            validate_column(column)?;
        }
        if let Some(column) = &group_column {
            validate_column(column)?;
        }
        if let Some(column) = &size_column {
            validate_column(column)?;
        }
        if let Some(column) = &z_column {
            validate_column(column)?;
        }
        if let Some(column) = &group_x_column {
            validate_column(column)?;
        }
        if let Some(column) = &group_y_column {
            validate_column(column)?;
        }
        if let Some(column) = &group_z_column {
            validate_column(column)?;
        }
        if let Some(column) = &wrap_column {
            validate_column(column)?;
        }
        for column in &multi_y_columns {
            validate_column(column)?;
        }

        let mut sampling_strata_columns: Vec<String> = Vec::new();
        for field in &request.fields {
            let role = field.role.to_ascii_lowercase();
            if !is_sampling_strata_role(role.as_str()) {
                continue;
            }
            let column = field.column.trim().to_string();
            if column.is_empty() || !allowed_columns.contains_key(column.as_str()) {
                continue;
            }
            if !sampling_strata_columns
                .iter()
                .any(|existing| existing == &column)
            {
                sampling_strata_columns.push(column);
            }
        }
        if sampling_strata_columns.is_empty() {
            if let Some(column) = group_column.clone() {
                sampling_strata_columns.push(column);
            } else if let Some(column) = x_column.clone() {
                sampling_strata_columns.push(column);
            }
        }

        let mut sampling_strata_aliases: Vec<String> = Vec::new();
        let mut sampling_strata_select_sql: Vec<String> = Vec::new();
        for (index, column) in sampling_strata_columns.iter().enumerate() {
            let alias = format!("__sp_strata_{index}");
            sampling_strata_select_sql.push(format!(
                "CAST({column} AS VARCHAR) AS {alias}",
                column = Self::quote_identifier(column),
                alias = Self::quote_identifier(alias.as_str()),
            ));
            sampling_strata_aliases.push(alias);
        }

        let mut strata_key_parts = if sampling_strata_aliases.is_empty() {
            vec!["COALESCE(CAST(__sp_group AS VARCHAR), COALESCE(CAST(__sp_x AS VARCHAR), '__sp_all__'))".to_string()]
        } else {
            sampling_strata_aliases
                .iter()
                .map(|alias| format!("COALESCE(CAST({alias} AS VARCHAR), '')"))
                .collect::<Vec<_>>()
        };
        strata_key_parts.push(format!(
            "COALESCE(CAST({source_col} AS VARCHAR), '')",
            source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN)
        ));
        let sampling_strata_key_expr = format!("CONCAT_WS('|', {})", strata_key_parts.join(", "));

        let (where_clause, filter_values) =
            Self::compile_table_window_filters(&request.filters, allowed_columns)?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));

        let x_expr = x_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let group_expr = group_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let size_expr = size_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let z_expr = z_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let group_x_expr = group_x_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let group_y_expr = group_y_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let group_z_expr = group_z_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let wrap_expr = wrap_column
            .as_ref()
            .map(|column| Self::quote_identifier(column))
            .unwrap_or_else(|| "NULL".to_string());
        let strata_select_sql = if sampling_strata_select_sql.is_empty() {
            String::new()
        } else {
            format!(", {}", sampling_strata_select_sql.join(", "))
        };

        let (source_sql, source_values, source_column_type) = if multi_y_columns.len() >= 2 {
            let mut branches = Vec::with_capacity(multi_y_columns.len());
            let mut values = Vec::with_capacity(
                filter_values.len() * multi_y_columns.len() + multi_y_columns.len(),
            );
            for column in &multi_y_columns {
                let branch = format!(
                    "SELECT \"_row_id\", {x_expr} AS __sp_x, CAST({y_col} AS DOUBLE) AS __sp_y, {group_expr} AS __sp_group, {size_expr} AS __sp_size, CAST({z_expr} AS DOUBLE) AS __sp_z, {group_x_expr} AS __sp_groupx, {group_y_expr} AS __sp_groupy, {group_z_expr} AS __sp_groupz, {wrap_expr} AS __sp_wrap{strata_select}, ? AS {source_col} FROM {table_name} {where_clause}",
                    y_col = Self::quote_identifier(column),
                    source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                    strata_select = strata_select_sql,
                );
                branches.push(branch);
                values.push(Value::Text(column.clone()));
                values.extend(filter_values.iter().cloned());
            }
            (branches.join(" UNION ALL "), values, "VARCHAR".to_string())
        } else {
            let source_col = if multi_y_columns.len() == 1 {
                multi_y_columns[0].clone()
            } else {
                y_column.clone()
            };
            let sql = format!(
                "SELECT \"_row_id\", {x_expr} AS __sp_x, CAST({y_col} AS DOUBLE) AS __sp_y, {group_expr} AS __sp_group, {size_expr} AS __sp_size, CAST({z_expr} AS DOUBLE) AS __sp_z, {group_x_expr} AS __sp_groupx, {group_y_expr} AS __sp_groupy, {group_z_expr} AS __sp_groupz, {wrap_expr} AS __sp_wrap{strata_select}, ? AS {source_col} FROM {table_name} {where_clause}",
                y_col = Self::quote_identifier(&source_col),
                source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                strata_select = strata_select_sql,
            );
            let mut values = Vec::with_capacity(filter_values.len() + 1);
            values.push(Value::Text(source_col));
            values.extend(filter_values.iter().cloned());
            (sql, values, "VARCHAR".to_string())
        };

        let projection_sql = match request.sampling {
            GraphSampling::Full => source_sql.clone(),
            GraphSampling::Sample { size, seed } => {
                let sample_size = i64::try_from(size)
                    .map_err(|_| AppError::InvalidParam("sample size is too large".into()))?;
                if sample_size <= 0 {
                    return Err(AppError::InvalidParam(
                        "sample size must be positive".into(),
                    ));
                }
                let seed_i64 = i64::try_from(seed)
                    .map_err(|_| AppError::InvalidParam("sample seed is too large".into()))?;
                format!(
                    "WITH __sp_source AS ({source_sql}),
                      __sp_ranked AS (
                        SELECT *,
                                                             {strata_key} AS __sp_stratum,
                               COUNT(*) OVER () AS __sp_total_rows,
                                                             COUNT(*) OVER (PARTITION BY {strata_key}) AS __sp_stratum_rows,
                               ROW_NUMBER() OVER (
                                                                 PARTITION BY {strata_key}
                                 ORDER BY hash(CAST(\"_row_id\" AS BIGINT), CAST({seed_i64} AS BIGINT))
                               ) AS __sp_rank
                        FROM __sp_source
                      )
                      SELECT \"_row_id\", __sp_x, __sp_y, __sp_group, __sp_size, __sp_z, __sp_groupx, __sp_groupy, __sp_groupz, __sp_wrap, {source_col}
                      FROM __sp_ranked
                      WHERE __sp_rank <= CASE
                        WHEN __sp_total_rows <= {sample_size} THEN __sp_stratum_rows
                        ELSE GREATEST(
                          1,
                          CAST(ROUND(({sample_size}::DOUBLE * __sp_stratum_rows) / NULLIF(__sp_total_rows, 0)) AS BIGINT)
                        )
                                            END",
                                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                                        strata_key = sampling_strata_key_expr,
                )
            }
        };

        let projection_values = source_values.clone();

        let melt_active = multi_y_columns.len() >= 2;
        let mut projection_select_items = Vec::new();
        let mut projected_columns = Vec::new();
        let mut projected_column_types = Vec::new();

        let mut push_projected = |expr: String, name: String, column_type: String| {
            if projected_columns.iter().any(|existing| existing == &name) {
                return;
            }
            projection_select_items.push(expr);
            projected_columns.push(name);
            projected_column_types.push(column_type);
        };

        let x_public = x_column.clone().unwrap_or_else(|| "__sp_x".to_string());
        push_projected(
            format!("__sp_x AS {}", Self::quote_identifier(&x_public)),
            x_public,
            x_column
                .as_ref()
                .and_then(|column| allowed_columns.get(column.as_str()).copied())
                .unwrap_or("VARCHAR")
                .to_string(),
        );

        let y_public = if melt_active {
            GRAPH_VIRTUAL_VALUE_COLUMN.to_string()
        } else {
            y_column.clone()
        };
        push_projected(
            format!("__sp_y AS {}", Self::quote_identifier(&y_public)),
            y_public,
            "DOUBLE".to_string(),
        );

        if let Some(column) = group_column.clone() {
            push_projected(
                format!("__sp_group AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("VARCHAR")
                    .to_string(),
            );
        }

        if let Some(column) = size_column.clone() {
            push_projected(
                format!("__sp_size AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("DOUBLE")
                    .to_string(),
            );
        }

        if let Some(column) = z_column.clone() {
            push_projected(
                format!("__sp_z AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("DOUBLE")
                    .to_string(),
            );
        }

        if let Some(column) = group_x_column.clone() {
            push_projected(
                format!("__sp_groupx AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("VARCHAR")
                    .to_string(),
            );
        }

        if let Some(column) = group_y_column.clone() {
            push_projected(
                format!("__sp_groupy AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("VARCHAR")
                    .to_string(),
            );
        }

        if let Some(column) = group_z_column.clone() {
            push_projected(
                format!("__sp_groupz AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("VARCHAR")
                    .to_string(),
            );
        }

        if let Some(column) = wrap_column.clone() {
            push_projected(
                format!("__sp_wrap AS {}", Self::quote_identifier(&column)),
                column.clone(),
                allowed_columns
                    .get(column.as_str())
                    .copied()
                    .unwrap_or("VARCHAR")
                    .to_string(),
            );
        }

        if melt_active {
            push_projected(
                format!(
                    "{} AS {}",
                    Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                    Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN)
                ),
                GRAPH_VIRTUAL_SOURCE_COLUMN.to_string(),
                source_column_type,
            );
        }

        Ok(GraphQueryPlan {
            source_sql,
            source_values,
            projection_sql,
            projection_values,
            projection_select_items,
            projected_columns,
            projected_column_types,
        })
    }

    pub fn collect_graph_aggregate_packets(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphAggregatePacket>, AppError> {
        let user_columns = self.get_user_columns(&request.dataset_id)?;
        let allowed_columns = user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let plan = self.compile_graph_query_plan(request, &allowed_columns)?;

        let mut want_histogram = false;
        let mut want_heatmap = false;
        let mut want_boxplot = false;
        let mut want_summary = false;
        for element in &request.elements {
            let kind = element.kind.to_ascii_lowercase();
            match kind.as_str() {
                "histogram" => want_histogram = true,
                "heatmap" => want_heatmap = true,
                "boxplot" => want_boxplot = true,
                "summary" | "points" | "line" => want_summary = true,
                _ => {}
            }
        }

        if !(want_histogram || want_heatmap || want_boxplot || want_summary) {
            return Ok(Vec::new());
        }

        let mut packets = Vec::new();

        if want_histogram {
            packets.push(GraphAggregatePacket::Histogram(
                self.query_histogram_packet(request, &plan)?,
            ));
        }
        if want_heatmap {
            packets.push(GraphAggregatePacket::Heatmap(
                self.query_heatmap_packet(request, &plan)?,
            ));
        }
        if want_boxplot {
            packets.push(GraphAggregatePacket::BoxPlot(
                self.query_boxplot_packet(request, &plan)?,
            ));
        }
        if want_summary {
            packets.push(GraphAggregatePacket::Summary(
                self.query_summary_packet(request, &plan)?,
            ));
        }

        Ok(packets)
    }

    fn query_histogram_packet(
        &self,
        request: &GraphDataRequest,
        plan: &GraphQueryPlan,
    ) -> Result<HistogramPacket, AppError> {
        let stats_sql = format!(
            "WITH __sp_source AS ({})
             SELECT
                             COALESCE(SUM(CASE WHEN __sp_y IS NOT NULL AND isfinite(__sp_y) THEN 1 ELSE 0 END), 0) AS valid_rows,
                             COALESCE(SUM(CASE WHEN __sp_y IS NOT NULL AND isfinite(__sp_y) THEN 0 ELSE 1 END), 0) AS missing_rows,
               MIN(CASE WHEN __sp_y IS NOT NULL AND isfinite(__sp_y) THEN __sp_y ELSE NULL END) AS min_y,
               MAX(CASE WHEN __sp_y IS NOT NULL AND isfinite(__sp_y) THEN __sp_y ELSE NULL END) AS max_y
             FROM __sp_source",
            plan.source_sql
        );
        let (total_count, missing_count, min_y, max_y): (i64, i64, Option<f64>, Option<f64>) =
            self.conn.query_row(
                &stats_sql,
                params_from_iter(plan.source_values.iter()),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let total_count_u64 = u64::try_from(total_count)
            .map_err(|_| AppError::Database("histogram total count is negative".into()))?;
        let missing_count_u64 = u64::try_from(missing_count)
            .map_err(|_| AppError::Database("histogram missing count is negative".into()))?;

        let bin_count_i64: i64 = 20;
        let bin_count = bin_count_i64 as f64;
        let bin_width = if let (Some(minimum), Some(maximum)) = (min_y, max_y) {
            if maximum > minimum {
                (maximum - minimum) / bin_count
            } else {
                1.0
            }
        } else {
            1.0
        };

        let mut bins = Vec::new();
        if total_count_u64 > 0 {
            let bins_sql = format!(
                "WITH __sp_source AS ({source}),
                 __sp_valid AS (
                    SELECT
                      CAST(__sp_group AS VARCHAR) AS grp,
                      CAST(__sp_x AS VARCHAR) AS cat,
                                            CAST({source_col} AS VARCHAR) AS src,
                                            CAST(__sp_groupx AS VARCHAR) AS facet_x,
                                            CAST(__sp_groupy AS VARCHAR) AS facet_y,
                                            CAST(__sp_groupz AS VARCHAR) AS facet_z,
                                            CAST(__sp_wrap AS VARCHAR) AS wrp,
                      __sp_y AS y
                    FROM __sp_source
                    WHERE __sp_y IS NOT NULL AND isfinite(__sp_y)
                 )
                 SELECT
                   grp,
                   cat,
                   src,
                                     facet_x,
                                     facet_y,
                                     facet_z,
                                     wrp,
                   CASE
                                         WHEN ? <= 0 THEN 0
                                         WHEN y = ? THEN ? - 1
                                         ELSE CAST(FLOOR((y - ?) / ?) AS BIGINT)
                   END AS bin_idx,
                                     COUNT(*) AS cnt
                 FROM __sp_valid
                                 GROUP BY grp, cat, src, facet_x, facet_y, facet_z, wrp, bin_idx
                                 ORDER BY grp, cat, src, facet_x, facet_y, facet_z, wrp, bin_idx",
                source = plan.source_sql,
                source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
            );

            let mut values = plan.source_values.clone();
            values.push(Value::Double(bin_width.max(1e-12)));
            values.push(Value::Double(max_y.unwrap_or(0.0)));
            values.push(Value::BigInt(bin_count_i64));
            values.push(Value::Double(min_y.unwrap_or(0.0)));
            values.push(Value::Double(bin_width.max(1e-12)));

            let mut stmt = self.conn.prepare(&bins_sql)?;
            let mut rows = stmt.query(params_from_iter(values.iter()))?;
            while let Some(row) = rows.next()? {
                let group: Option<String> = row.get(0)?;
                let category: Option<String> = row.get(1)?;
                let source_column: Option<String> = row.get(2)?;
                let facet_x: Option<String> = row.get(3)?;
                let facet_y: Option<String> = row.get(4)?;
                let facet_z: Option<String> = row.get(5)?;
                let wrap: Option<String> = row.get(6)?;
                let bin_index: i64 = row.get(7)?;
                let count: i64 = row.get(8)?;
                let clamped_index = bin_index.clamp(0, bin_count_i64 - 1) as f64;
                let start = min_y.unwrap_or(0.0) + clamped_index * bin_width;
                bins.push(HistogramBin {
                    group,
                    category,
                    source_column,
                    facet_x,
                    facet_y,
                    facet_z,
                    wrap,
                    bin_start: start,
                    bin_end: start + bin_width,
                    count: u64::try_from(count).map_err(|_| {
                        AppError::Database("histogram bin count is negative".into())
                    })?,
                });
            }
        }

        Ok(HistogramPacket {
            x_column: role_column(request, "x"),
            y_column: role_column(request, "y").unwrap_or_else(|| "__sp_y".to_string()),
            group_column: role_column(request, "group"),
            source_column: Some(GRAPH_VIRTUAL_SOURCE_COLUMN.to_string()),
            bin_count: u32::try_from(bin_count_i64)
                .map_err(|_| AppError::Database("histogram bin count overflow".into()))?,
            min_value: min_y,
            max_value: max_y,
            missing_count: missing_count_u64,
            bin_width,
            total_count: total_count_u64,
            bins,
        })
    }

    fn query_heatmap_packet(
        &self,
        request: &GraphDataRequest,
        plan: &GraphQueryPlan,
    ) -> Result<HeatmapPacket, AppError> {
        let x_bin_count_i64: i64 = 20;
        let y_bin_count_i64: i64 = 20;
        let stats_sql = format!(
            "WITH __sp_source AS ({})
             SELECT
                             COALESCE(SUM(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN 1 ELSE 0 END), 0),
                             COALESCE(SUM(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN 0 ELSE 1 END), 0),
                             MIN(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN TRY_CAST(__sp_x AS DOUBLE) ELSE NULL END),
                             MAX(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN TRY_CAST(__sp_x AS DOUBLE) ELSE NULL END),
                             MIN(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN __sp_y ELSE NULL END),
                             MAX(CASE WHEN __sp_x IS NOT NULL AND __sp_y IS NOT NULL AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y) THEN __sp_y ELSE NULL END)
             FROM __sp_source
            ",
            plan.source_sql
        );
        let (total_count, missing_count, min_x, max_x, min_y, max_y): (
            i64,
            i64,
            Option<f64>,
            Option<f64>,
            Option<f64>,
            Option<f64>,
        ) = self.conn.query_row(
            &stats_sql,
            params_from_iter(plan.source_values.iter()),
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
        let total_count_u64 = u64::try_from(total_count)
            .map_err(|_| AppError::Database("heatmap total count is negative".into()))?;
        let missing_count_u64 = u64::try_from(missing_count)
            .map_err(|_| AppError::Database("heatmap missing count is negative".into()))?;
        let x_bin_width = match (min_x, max_x) {
            (Some(minimum), Some(maximum)) if maximum > minimum => {
                (maximum - minimum) / (x_bin_count_i64 as f64)
            }
            _ => 1.0,
        };
        let y_bin_width = match (min_y, max_y) {
            (Some(minimum), Some(maximum)) if maximum > minimum => {
                (maximum - minimum) / (y_bin_count_i64 as f64)
            }
            _ => 1.0,
        };

        let mut cells: Vec<HeatmapCell> = Vec::new();
        if total_count_u64 > 0 {
            let cells_sql = format!(
                "WITH __sp_source AS ({source}),
                 __sp_valid AS (
                   SELECT
                     CAST(__sp_group AS VARCHAR) AS grp,
                     CAST(__sp_x AS VARCHAR) AS cat,
                     CAST({source_col} AS VARCHAR) AS src,
                                         CAST(__sp_groupx AS VARCHAR) AS facet_x,
                                         CAST(__sp_groupy AS VARCHAR) AS facet_y,
                                         CAST(__sp_groupz AS VARCHAR) AS facet_z,
                                         CAST(__sp_wrap AS VARCHAR) AS wrp,
                                         TRY_CAST(__sp_x AS DOUBLE) AS x,
                     __sp_y AS y
                   FROM __sp_source
                   WHERE __sp_x IS NOT NULL AND __sp_y IS NOT NULL
                                         AND isfinite(TRY_CAST(__sp_x AS DOUBLE)) AND isfinite(__sp_y)
                 )
                 SELECT
                   grp,
                   cat,
                   src,
                                     facet_x,
                                     facet_y,
                                     facet_z,
                                     wrp,
                   CASE
                     WHEN ? <= 0 THEN 0
                     WHEN x = ? THEN ? - 1
                     ELSE CAST(FLOOR((x - ?) / ?) AS BIGINT)
                   END AS x_idx,
                   CASE
                     WHEN ? <= 0 THEN 0
                     WHEN y = ? THEN ? - 1
                     ELSE CAST(FLOOR((y - ?) / ?) AS BIGINT)
                   END AS y_idx,
                                     COUNT(*) AS cnt
                 FROM __sp_valid
                                 GROUP BY grp, cat, src, facet_x, facet_y, facet_z, wrp, x_idx, y_idx
                                 ORDER BY grp, cat, src, facet_x, facet_y, facet_z, wrp, x_idx, y_idx",
                source = plan.source_sql,
                source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
            );

            let mut values = plan.source_values.clone();
            values.push(Value::Double(x_bin_width.max(1e-12)));
            values.push(Value::Double(max_x.unwrap_or(0.0)));
            values.push(Value::BigInt(x_bin_count_i64));
            values.push(Value::Double(min_x.unwrap_or(0.0)));
            values.push(Value::Double(x_bin_width.max(1e-12)));
            values.push(Value::Double(y_bin_width.max(1e-12)));
            values.push(Value::Double(max_y.unwrap_or(0.0)));
            values.push(Value::BigInt(y_bin_count_i64));
            values.push(Value::Double(min_y.unwrap_or(0.0)));
            values.push(Value::Double(y_bin_width.max(1e-12)));

            let mut stmt = self.conn.prepare(&cells_sql)?;
            let mut rows = stmt.query(params_from_iter(values.iter()))?;
            while let Some(row) = rows.next()? {
                let group: Option<String> = row.get(0)?;
                let category: Option<String> = row.get(1)?;
                let source_column: Option<String> = row.get(2)?;
                let facet_x: Option<String> = row.get(3)?;
                let facet_y: Option<String> = row.get(4)?;
                let facet_z: Option<String> = row.get(5)?;
                let wrap: Option<String> = row.get(6)?;
                let x_bin_index: i64 = row.get(7)?;
                let y_bin_index: i64 = row.get(8)?;
                let count: i64 = row.get(9)?;
                let x_idx = x_bin_index.clamp(0, x_bin_count_i64 - 1);
                let y_idx = y_bin_index.clamp(0, y_bin_count_i64 - 1);
                let x_start = min_x.unwrap_or(0.0) + (x_idx as f64) * x_bin_width;
                let y_start = min_y.unwrap_or(0.0) + (y_idx as f64) * y_bin_width;
                cells.push(HeatmapCell {
                    group,
                    category,
                    source_column,
                    facet_x,
                    facet_y,
                    facet_z,
                    wrap,
                    x_bin_index: x_idx,
                    y_bin_index: y_idx,
                    x_bin_start: x_start,
                    x_bin_end: x_start + x_bin_width,
                    y_bin_start: y_start,
                    y_bin_end: y_start + y_bin_width,
                    count: u64::try_from(count)
                        .map_err(|_| AppError::Database("heatmap cell count is negative".into()))?,
                });
            }
        }

        Ok(HeatmapPacket {
            x_column: role_column(request, "x").unwrap_or_else(|| "__sp_x".to_string()),
            y_column: role_column(request, "y").unwrap_or_else(|| "__sp_y".to_string()),
            group_column: role_column(request, "group"),
            source_column: Some(GRAPH_VIRTUAL_SOURCE_COLUMN.to_string()),
            x_bin_count: u32::try_from(x_bin_count_i64)
                .map_err(|_| AppError::Database("heatmap x bin count overflow".into()))?,
            y_bin_count: u32::try_from(y_bin_count_i64)
                .map_err(|_| AppError::Database("heatmap y bin count overflow".into()))?,
            x_min: min_x,
            x_max: max_x,
            y_min: min_y,
            y_max: max_y,
            missing_count: missing_count_u64,
            x_bin_width,
            y_bin_width,
            total_count: total_count_u64,
            cells,
        })
    }

    fn query_boxplot_packet(
        &self,
        request: &GraphDataRequest,
        plan: &GraphQueryPlan,
    ) -> Result<BoxPlotPacket, AppError> {
        let sql = format!(
            "WITH __sp_source AS ({source}),
             __sp_valid AS (
               SELECT
                                 CAST(\"_row_id\" AS BIGINT) AS row_id,
                 CAST(__sp_group AS VARCHAR) AS grp,
                 CAST(__sp_x AS VARCHAR) AS cat,
                                 CAST({source_col} AS VARCHAR) AS src,
                                 CAST(__sp_groupx AS VARCHAR) AS facet_x,
                                 CAST(__sp_groupy AS VARCHAR) AS facet_y,
                                 CAST(__sp_groupz AS VARCHAR) AS facet_z,
                                 CAST(__sp_wrap AS VARCHAR) AS wrp,
                 __sp_y AS y
               FROM __sp_source
               WHERE __sp_y IS NOT NULL AND isfinite(__sp_y)
                         ),
                         __sp_stats AS (
                             SELECT
                                 grp,
                                 cat,
                                 src,
                                 facet_x,
                                 facet_y,
                                 facet_z,
                                 wrp,
                                 COUNT(*) AS n,
                                 MIN(y) AS min_y,
                                 quantile_cont(y, 0.25) AS q1,
                                 quantile_cont(y, 0.50) AS median,
                                 quantile_cont(y, 0.75) AS q3,
                                 MAX(y) AS max_y
                             FROM __sp_valid
                             GROUP BY grp, cat, src, facet_x, facet_y, facet_z, wrp
                         ),
                         __sp_whiskers AS (
                             SELECT
                                 s.grp,
                                 s.cat,
                                 s.src,
                                 s.facet_x,
                                 s.facet_y,
                                 s.facet_z,
                                 s.wrp,
                                 MIN(v.y) FILTER (WHERE v.y >= (s.q1 - 1.5 * (s.q3 - s.q1)) AND v.y <= (s.q3 + 1.5 * (s.q3 - s.q1))) AS whisker_low,
                                 MAX(v.y) FILTER (WHERE v.y >= (s.q1 - 1.5 * (s.q3 - s.q1)) AND v.y <= (s.q3 + 1.5 * (s.q3 - s.q1))) AS whisker_high
                             FROM __sp_stats s
                             JOIN __sp_valid v
                                 ON v.grp IS NOT DISTINCT FROM s.grp
                                AND v.cat IS NOT DISTINCT FROM s.cat
                                AND v.src IS NOT DISTINCT FROM s.src
                                AND v.facet_x IS NOT DISTINCT FROM s.facet_x
                                AND v.facet_y IS NOT DISTINCT FROM s.facet_y
                                AND v.facet_z IS NOT DISTINCT FROM s.facet_z
                                AND v.wrp IS NOT DISTINCT FROM s.wrp
                             GROUP BY s.grp, s.cat, s.src, s.facet_x, s.facet_y, s.facet_z, s.wrp
             )
             SELECT
                             s.grp,
                             s.cat,
                             s.src,
                             s.facet_x,
                             s.facet_y,
                             s.facet_z,
                             s.wrp,
                             s.n,
                             s.min_y,
                             s.q1,
                             s.median,
                             s.q3,
                             s.max_y,
                             COALESCE(w.whisker_low, s.min_y) AS whisker_low,
                             COALESCE(w.whisker_high, s.max_y) AS whisker_high
                         FROM __sp_stats s
                         LEFT JOIN __sp_whiskers w
                             ON w.grp IS NOT DISTINCT FROM s.grp
                            AND w.cat IS NOT DISTINCT FROM s.cat
                            AND w.src IS NOT DISTINCT FROM s.src
                                     AND w.facet_x IS NOT DISTINCT FROM s.facet_x
                                     AND w.facet_y IS NOT DISTINCT FROM s.facet_y
                                     AND w.facet_z IS NOT DISTINCT FROM s.facet_z
                                     AND w.wrp IS NOT DISTINCT FROM s.wrp
                                 ORDER BY s.grp, s.cat, s.src, s.facet_x, s.facet_y, s.facet_z, s.wrp",
                        source = plan.source_sql,
                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
        );

        let mut entries = Vec::new();
        let mut entry_index_by_key: std::collections::HashMap<
            (
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ),
            usize,
        > = std::collections::HashMap::new();
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(plan.source_values.iter()))?;
        while let Some(row) = rows.next()? {
            let group: Option<String> = row.get(0)?;
            let category: Option<String> = row.get(1)?;
            let source_column: Option<String> = row.get(2)?;
            let facet_x: Option<String> = row.get(3)?;
            let facet_y: Option<String> = row.get(4)?;
            let facet_z: Option<String> = row.get(5)?;
            let wrap: Option<String> = row.get(6)?;
            let count: i64 = row.get(7)?;
            let min: f64 = row.get(8)?;
            let q1: f64 = row.get(9)?;
            let median: f64 = row.get(10)?;
            let q3: f64 = row.get(11)?;
            let max: f64 = row.get(12)?;
            let whisker_low: f64 = row.get(13)?;
            let whisker_high: f64 = row.get(14)?;

            let key = (
                group.clone(),
                category.clone(),
                source_column.clone(),
                facet_x.clone(),
                facet_y.clone(),
                facet_z.clone(),
                wrap.clone(),
            );
            entry_index_by_key.insert(key, entries.len());

            entries.push(BoxPlotEntry {
                group,
                category,
                source_column,
                facet_x,
                facet_y,
                facet_z,
                wrap,
                count: u64::try_from(count)
                    .map_err(|_| AppError::Database("boxplot count is negative".into()))?,
                min,
                q1,
                median,
                q3,
                max,
                whisker_low,
                whisker_high,
                outliers: Vec::new(),
            });
        }

        let outlier_sql = format!(
                        "WITH __sp_source AS ({source}),
                         __sp_valid AS (
                             SELECT
                                 CAST(\"_row_id\" AS BIGINT) AS row_id,
                                 CAST(__sp_group AS VARCHAR) AS grp,
                                 CAST(__sp_x AS VARCHAR) AS cat,
                                 CAST({source_col} AS VARCHAR) AS src,
                                 CAST(__sp_groupx AS VARCHAR) AS facet_x,
                                 CAST(__sp_groupy AS VARCHAR) AS facet_y,
                                 CAST(__sp_groupz AS VARCHAR) AS facet_z,
                                 CAST(__sp_wrap AS VARCHAR) AS wrp,
                                 __sp_y AS y
                             FROM __sp_source
                             WHERE __sp_y IS NOT NULL AND isfinite(__sp_y)
                         ),
                         __sp_bounds AS (
                             SELECT
                                 grp,
                                 cat,
                                 src,
                                 facet_x,
                                 facet_y,
                                 facet_z,
                                 wrp,
                                 quantile_cont(y, 0.25) - 1.5 * (quantile_cont(y, 0.75) - quantile_cont(y, 0.25)) AS lo,
                                 quantile_cont(y, 0.75) + 1.5 * (quantile_cont(y, 0.75) - quantile_cont(y, 0.25)) AS hi
                             FROM __sp_valid
                             GROUP BY grp, cat, src, facet_x, facet_y, facet_z, wrp
                         )
                         SELECT v.grp, v.cat, v.src, v.facet_x, v.facet_y, v.facet_z, v.wrp, v.row_id, v.y
                         FROM __sp_valid v
                         JOIN __sp_bounds b
                             ON v.grp IS NOT DISTINCT FROM b.grp
                            AND v.cat IS NOT DISTINCT FROM b.cat
                            AND v.src IS NOT DISTINCT FROM b.src
                            AND v.facet_x IS NOT DISTINCT FROM b.facet_x
                            AND v.facet_y IS NOT DISTINCT FROM b.facet_y
                            AND v.facet_z IS NOT DISTINCT FROM b.facet_z
                            AND v.wrp IS NOT DISTINCT FROM b.wrp
                         WHERE v.y < b.lo OR v.y > b.hi
                         ORDER BY v.grp, v.cat, v.src, v.facet_x, v.facet_y, v.facet_z, v.wrp, v.row_id",
                        source = plan.source_sql,
                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                );

        let mut outlier_stmt = self.conn.prepare(&outlier_sql)?;
        let mut outlier_rows = outlier_stmt.query(params_from_iter(plan.source_values.iter()))?;
        while let Some(row) = outlier_rows.next()? {
            let group: Option<String> = row.get(0)?;
            let category: Option<String> = row.get(1)?;
            let source_column: Option<String> = row.get(2)?;
            let facet_x: Option<String> = row.get(3)?;
            let facet_y: Option<String> = row.get(4)?;
            let facet_z: Option<String> = row.get(5)?;
            let wrap: Option<String> = row.get(6)?;
            let row_id: Option<i64> = row.get(7)?;
            let value: f64 = row.get(8)?;
            let key = (
                group,
                category,
                source_column.clone(),
                facet_x,
                facet_y,
                facet_z,
                wrap,
            );
            if let Some(entry_index) = entry_index_by_key.get(&key).copied() {
                entries[entry_index].outliers.push(BoxPlotOutlier {
                    value,
                    row_id,
                    source_column,
                });
            }
        }

        Ok(BoxPlotPacket {
            x_column: role_column(request, "x"),
            y_column: role_column(request, "y").unwrap_or_else(|| "__sp_y".to_string()),
            group_column: role_column(request, "group"),
            source_column: Some(GRAPH_VIRTUAL_SOURCE_COLUMN.to_string()),
            entries,
        })
    }

    fn query_summary_packet(
        &self,
        request: &GraphDataRequest,
        plan: &GraphQueryPlan,
    ) -> Result<SummaryPacket, AppError> {
        let sql = format!(
            "WITH __sp_source AS ({source}),
             __sp_valid AS (
               SELECT
                 CAST(__sp_group AS VARCHAR) AS grp,
                 CAST(__sp_x AS VARCHAR) AS cat,
                                 CAST({source_col} AS VARCHAR) AS src,
                                 CAST(__sp_groupx AS VARCHAR) AS facet_x,
                                 CAST(__sp_groupy AS VARCHAR) AS facet_y,
                                 CAST(__sp_groupz AS VARCHAR) AS facet_z,
                                 CAST(__sp_wrap AS VARCHAR) AS wrp,
                 __sp_y AS y
               FROM __sp_source
               WHERE __sp_y IS NOT NULL AND isfinite(__sp_y)
             )
                                                 SELECT grp, cat, src, facet_x, facet_y, facet_z, wrp, COUNT(*) AS n, AVG(y) AS mean_y, quantile_cont(y, 0.50) AS median_y, COALESCE(stddev_samp(y), 0.0) AS std_y, MIN(y) AS min_y, MAX(y) AS max_y
             FROM __sp_valid
                         GROUP BY grp, cat, src, facet_x, facet_y, facet_z, wrp
                         ORDER BY grp, cat, src, facet_x, facet_y, facet_z, wrp",
                        source = plan.source_sql,
                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
        );

        let mut summaries = Vec::new();
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(plan.source_values.iter()))?;
        while let Some(row) = rows.next()? {
            let group: Option<String> = row.get(0)?;
            let category: Option<String> = row.get(1)?;
            let source_column: Option<String> = row.get(2)?;
            let facet_x: Option<String> = row.get(3)?;
            let facet_y: Option<String> = row.get(4)?;
            let facet_z: Option<String> = row.get(5)?;
            let wrap: Option<String> = row.get(6)?;
            let count: i64 = row.get(7)?;
            let mean: f64 = row.get(8)?;
            let median: f64 = row.get(9)?;
            let stddev: f64 = row.get(10)?;
            let min: f64 = row.get(11)?;
            let max: f64 = row.get(12)?;
            let n = u64::try_from(count)
                .map_err(|_| AppError::Database("summary count is negative".into()))?;
            let margin = if n > 1 {
                1.96 * stddev / (n as f64).sqrt()
            } else {
                0.0
            };

            summaries.push(SummaryEntry {
                group,
                category,
                source_column,
                facet_x,
                facet_y,
                facet_z,
                wrap,
                count: n,
                mean,
                median,
                stddev,
                min,
                max,
                interval_low: Some(mean - margin),
                interval_high: Some(mean + margin),
            });
        }

        Ok(SummaryPacket {
            x_column: role_column(request, "x"),
            y_column: role_column(request, "y").unwrap_or_else(|| "__sp_y".to_string()),
            group_column: role_column(request, "group"),
            source_column: Some(GRAPH_VIRTUAL_SOURCE_COLUMN.to_string()),
            summaries,
        })
    }

    fn compile_table_window_filters(
        filters: &[crate::models::table::TableWindowFilter],
        allowed_columns: &std::collections::HashMap<&str, &str>,
    ) -> Result<(String, Vec<Value>), AppError> {
        let mut expression = String::new();
        let mut values = Vec::new();

        for (index, filter) in filters.iter().enumerate() {
            let requested_field = match &filter.rule {
                TableWindowFilterRule::Continuous { field, .. }
                | TableWindowFilterRule::Categorical { field, .. }
                | TableWindowFilterRule::Date { field, .. } => field,
            };
            let column_type = allowed_columns
                .get(requested_field.as_str())
                .ok_or_else(|| {
                    AppError::InvalidParam(format!("unknown filter column: {requested_field}"))
                })?;
            let predicate = match &filter.rule {
                TableWindowFilterRule::Continuous { field, min, max } => {
                    if !is_numeric_type(column_type) {
                        return Err(AppError::InvalidParam(format!(
                            "continuous filter requires a numeric column: {field}"
                        )));
                    }
                    let column = Self::quote_identifier(field);
                    let mut parts = Vec::new();
                    if let Some(minimum) = min {
                        if !minimum.is_finite() {
                            return Err(AppError::InvalidParam(
                                "filter minimum must be finite".into(),
                            ));
                        }
                        parts.push(format!("{column} >= ?"));
                        values.push(Value::Double(*minimum));
                    }
                    if let Some(maximum) = max {
                        if !maximum.is_finite() {
                            return Err(AppError::InvalidParam(
                                "filter maximum must be finite".into(),
                            ));
                        }
                        parts.push(format!("{column} <= ?"));
                        values.push(Value::Double(*maximum));
                    }
                    if parts.is_empty() {
                        "TRUE".into()
                    } else {
                        parts.join(" AND ")
                    }
                }
                TableWindowFilterRule::Categorical {
                    field,
                    selected,
                    exclude,
                } => {
                    let predicate = if selected.is_empty() {
                        if *exclude { "TRUE" } else { "FALSE" }.to_string()
                    } else {
                        let includes_null = selected.iter().any(String::is_empty);
                        values.extend(selected.iter().cloned().map(Value::Text));
                        let placeholders = std::iter::repeat_n("?", selected.len())
                            .collect::<Vec<_>>()
                            .join(", ");
                        let column = Self::quote_identifier(field);
                        if *exclude && includes_null {
                            format!("NOT ({column} IN ({placeholders}) OR {column} IS NULL)")
                        } else if *exclude {
                            format!("({column} NOT IN ({placeholders}) OR {column} IS NULL)")
                        } else if includes_null {
                            format!("({column} IN ({placeholders}) OR {column} IS NULL)")
                        } else {
                            format!("{column} IN ({placeholders})")
                        }
                    };
                    predicate
                }
                TableWindowFilterRule::Date { field, start, end } => {
                    let normalized_type = column_type.to_ascii_uppercase();
                    if !normalized_type.starts_with("DATE")
                        && !normalized_type.starts_with("TIMESTAMP")
                    {
                        return Err(AppError::InvalidParam(format!(
                            "date filter requires a date or timestamp column: {field}"
                        )));
                    }
                    let column = format!(
                        "substr(CAST({} AS VARCHAR), 1, 10)",
                        Self::quote_identifier(field)
                    );
                    let mut parts = Vec::new();
                    if let Some(start) = start {
                        parts.push(format!("{column} >= ?"));
                        values.push(Value::Text(start.clone()));
                    }
                    if let Some(end) = end {
                        parts.push(format!("{column} <= ?"));
                        values.push(Value::Text(end.clone()));
                    }
                    if parts.is_empty() {
                        "TRUE".into()
                    } else {
                        parts.join(" AND ")
                    }
                }
            };

            let predicate = format!("({predicate})");
            if index == 0 {
                expression = predicate;
            } else {
                let connector = match filter.op.to_ascii_uppercase().as_str() {
                    "AND" => "AND",
                    "OR" => "OR",
                    _ => {
                        return Err(AppError::InvalidParam(format!(
                            "unknown filter operator: {}",
                            filter.op
                        )))
                    }
                };
                expression = format!("({expression} {connector} {predicate})");
            }
        }

        let clause = if expression.is_empty() {
            String::new()
        } else {
            format!("WHERE {expression}")
        };
        Ok((clause, values))
    }

    /// Query a dataset table with pagination
    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let offset = page * page_size;

        // Get total rows
        let total_rows: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info from metadata (avoids DuckDB panic on unexecuted statements)
        let mut col_stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let col_info: Vec<(String, String)> = col_stmt
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // _row_id + user columns
        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["INTEGER".to_string()];
        for (name, typ) in &col_info {
            columns.push(name.clone());
            column_types.push(typ.clone());
        }

        // Build SELECT with explicit column list
        let select_cols = columns
            .iter()
            .map(|c| format!("\"{}\"", c))
            .collect::<Vec<_>>()
            .join(", ");

        // Build query with optional sorting
        let order_clause = match sort_by {
            Some(col) => {
                let dir = sort_order.unwrap_or("asc");
                let dir = if dir.eq_ignore_ascii_case("desc") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!("ORDER BY \"{}\" {}", col, dir)
            }
            None => String::new(),
        };

        let query = format!(
            "SELECT {} FROM \"{}\" {} LIMIT {} OFFSET {}",
            select_cols, table_name, order_clause, page_size, offset
        );

        // Execute and fetch rows
        let mut stmt = self.conn.prepare(&query)?;
        let mut rows_data: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows = stmt.query([])?;
        let column_count = columns.len();

        while let Some(row) = rows.next()? {
            let mut row_values: Vec<serde_json::Value> = Vec::new();
            for i in 0..column_count {
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
            rows_data.push(row_values);
        }

        Ok(TableQueryResult {
            columns,
            column_types,
            rows: rows_data,
            total_rows,
            page,
            page_size,
        })
    }

    fn build_isolated_snapshot_connection(&self) -> Result<Connection, AppError> {
        let snapshot = Connection::open_in_memory_with_flags(
            Config::default().enable_external_access(false)?,
        )?;
        self.copy_visible_datasets_into_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    fn copy_visible_datasets_into_snapshot(&self, snapshot: &Connection) -> Result<(), AppError> {
        let datasets = self.list_datasets()?;
        let mut seen_names: HashSet<String> = HashSet::new();

        for dataset in datasets {
            let normalized_name = normalize_identifier(&dataset.name);
            if !seen_names.insert(normalized_name.clone()) {
                return Err(AppError::InvalidParam(format!(
                    "duplicate visible dataset name: {}",
                    dataset.name
                )));
            }

            let columns = self.get_user_columns(&dataset.id)?;
            if columns.is_empty() {
                continue;
            }
            let column_defs = columns
                .iter()
                .map(|(column_name, column_type)| {
                    format!("{} {}", Self::quote_identifier(column_name), column_type)
                })
                .collect::<Vec<_>>();

            let create_sql = format!(
                "CREATE TABLE {} ({})",
                Self::quote_identifier(&dataset.name),
                column_defs.join(", ")
            );
            snapshot.execute(&create_sql, [])?;

            let select_columns = columns
                .iter()
                .map(|(column_name, column_type)| {
                    let identifier = Self::quote_identifier(column_name);
                    Self::typed_export_expression(&identifier, column_type)
                })
                .collect::<Vec<_>>()
                .join(", ");
            let internal_table = Self::quote_identifier(&Self::internal_table_name(&dataset.id));
            let select_sql = format!(
                "SELECT {} FROM {} ORDER BY \"_row_id\"",
                select_columns, internal_table
            );
            let mut stmt = self.conn.prepare(&select_sql)?;
            let mut rows = stmt.query([])?;

            let placeholders = columns
                .iter()
                .map(|(_, column_type)| Self::typed_parameter_expression(column_type))
                .collect::<Vec<_>>()
                .join(", ");
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                Self::quote_identifier(&dataset.name),
                columns
                    .iter()
                    .map(|(column_name, _)| Self::quote_identifier(column_name))
                    .collect::<Vec<_>>()
                    .join(", "),
                placeholders
            );

            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(columns.len());
                for column_index in 0..columns.len() {
                    let value: Option<String> = row.get(column_index)?;
                    values.push(value.map(Value::Text).unwrap_or(Value::Null));
                }
                snapshot.execute(&insert_sql, params_from_iter(values))?;
            }
        }

        Ok(())
    }

    fn collect_sql_query_page(
        &self,
        conn: &Connection,
        sql: &str,
        page: usize,
        page_size: usize,
    ) -> Result<SqlQueryResult, AppError> {
        let offset = page
            .checked_sub(1)
            .and_then(|value| value.checked_mul(page_size))
            .ok_or_else(|| AppError::InvalidParam("page offset overflow".into()))?;

        let (columns, column_types) = self.collect_sql_query_schema(conn, sql)?;
        let count_sql = format!("SELECT COUNT(*) FROM ({}) AS \"_sp_query_count\"", sql);
        let total_rows: i64 = conn.query_row(&count_sql, [], |row| row.get(0))?;

        let page_sql = format!(
            "SELECT * FROM ({}) AS \"_sp_query_page\" LIMIT $1 OFFSET $2",
            sql
        );
        let mut stmt = conn.prepare(&page_sql)?;

        let limit = i64::try_from(page_size)
            .map_err(|_| AppError::InvalidParam("page_size is too large".into()))?;
        let offset = i64::try_from(offset)
            .map_err(|_| AppError::InvalidParam("page offset is too large".into()))?;

        let mut rows = stmt.query(params![limit, offset])?;
        let mut rows_data = Vec::new();
        let column_count = columns.len();
        while let Some(row) = rows.next()? {
            let mut row_values = Vec::with_capacity(column_count);
            for column_index in 0..column_count {
                let value: Value = row.get(column_index)?;
                row_values.push(Self::duckdb_value_to_json(value));
            }
            rows_data.push(row_values);
        }

        Ok(SqlQueryResult {
            columns,
            column_types,
            rows: rows_data,
            total_rows,
            page,
            page_size,
            execution_time_ms: 0,
        })
    }

    fn collect_sql_query_rows(
        &self,
        conn: &Connection,
        sql: &str,
    ) -> Result<MaterializedQuery, AppError> {
        let (columns, column_types) = self.collect_sql_query_schema(conn, sql)?;
        let select_columns = columns
            .iter()
            .zip(column_types.iter())
            .map(|(column_name, column_type)| {
                let identifier = Self::quote_identifier(column_name);
                format!(
                    "{} AS {}",
                    Self::typed_export_expression(&identifier, column_type),
                    identifier
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let transfer_sql =
            format!("SELECT {select_columns} FROM ({sql}) AS \"_sp_query_transfer\"");
        let mut stmt = conn.prepare(&transfer_sql)?;
        let mut rows = stmt.query([])?;
        let column_count = columns.len();
        let mut rows_data = Vec::new();

        while let Some(row) = rows.next()? {
            let mut row_values = Vec::with_capacity(column_count);
            for column_index in 0..column_count {
                let value: Option<String> = row.get(column_index)?;
                row_values.push(value.map(Value::Text).unwrap_or(Value::Null));
            }
            rows_data.push(row_values);
        }

        Ok(MaterializedQuery {
            columns,
            column_types,
            rows: rows_data,
        })
    }

    fn validate_query_against_visible_tables(&self, sql: &str) -> Result<String, AppError> {
        let datasets = self.list_datasets()?;
        let allowed_tables: HashSet<String> = datasets
            .iter()
            .filter(|dataset| dataset.col_count > 0)
            .map(|dataset| normalize_identifier(&dataset.name))
            .collect();

        validate_read_only_query(sql, &allowed_tables)
    }

    fn quote_identifier(name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    fn typed_export_expression(identifier: &str, column_type: &str) -> String {
        if column_type.trim().eq_ignore_ascii_case("BLOB") {
            format!("hex({identifier})")
        } else {
            format!("CAST({identifier} AS VARCHAR)")
        }
    }

    fn typed_parameter_expression(column_type: &str) -> String {
        if column_type.trim().eq_ignore_ascii_case("BLOB") {
            "from_hex(?)".to_string()
        } else {
            format!("CAST(? AS {column_type})")
        }
    }

    fn canonicalize_column_type(&self, column_type: &str) -> Result<String, AppError> {
        let type_query = format!("SELECT CAST(NULL AS {column_type}) AS value");
        let canonical_query = validate_read_only_query(&type_query, &HashSet::new())?;
        let (_, column_types) = self.collect_sql_query_schema(&self.conn, &canonical_query)?;
        column_types
            .into_iter()
            .next()
            .ok_or_else(|| AppError::InvalidParam("column type produced no schema".into()))
    }

    fn collect_sql_query_schema(
        &self,
        conn: &Connection,
        sql: &str,
    ) -> Result<(Vec<String>, Vec<String>), AppError> {
        let schema_sql = format!("DESCRIBE SELECT * FROM ({}) AS \"_sp_query_schema\"", sql);
        let mut stmt = conn.prepare(&schema_sql)?;
        let mut rows = stmt.query([])?;
        let mut columns = Vec::new();
        let mut column_types = Vec::new();

        while let Some(row) = rows.next()? {
            columns.push(row.get::<_, String>(0)?);
            column_types.push(row.get::<_, String>(1)?);
        }

        Self::validate_result_column_names(&columns)?;
        Ok((columns, column_types))
    }

    fn validate_result_column_names(columns: &[String]) -> Result<(), AppError> {
        let mut seen: HashSet<String> = HashSet::new();
        let reserved = normalize_identifier("_row_id");

        for column_name in columns {
            let trimmed = column_name.trim();
            if trimmed.is_empty() {
                return Err(AppError::InvalidParam(
                    "query result column names cannot be empty".into(),
                ));
            }

            let normalized = normalize_identifier(trimmed);
            if normalized == reserved {
                return Err(AppError::InvalidParam(
                    "query result column names cannot use reserved name _row_id".into(),
                ));
            }

            if !seen.insert(normalized.clone()) {
                return Err(AppError::InvalidParam(format!(
                    "query result column names must be unique case-insensitively: {}",
                    column_name
                )));
            }
        }

        Ok(())
    }

    fn finalize_transaction<T, Commit, Rollback>(
        commit: Commit,
        rollback: Rollback,
    ) -> Result<T, AppError>
    where
        Commit: FnOnce() -> Result<T, AppError>,
        Rollback: FnOnce(),
    {
        match commit() {
            Ok(value) => Ok(value),
            Err(error) => {
                rollback();
                Err(error)
            }
        }
    }

    fn internal_table_name(id: &str) -> String {
        format!("dataset_{}", id.replace('-', "_"))
    }

    fn duckdb_value_to_json(value: Value) -> serde_json::Value {
        match value {
            Value::Null => serde_json::Value::Null,
            Value::Boolean(value) => serde_json::Value::Bool(value),
            Value::TinyInt(value) => serde_json::json!(value),
            Value::SmallInt(value) => serde_json::json!(value),
            Value::Int(value) => serde_json::json!(value),
            Value::BigInt(value) => serde_json::json!(value),
            Value::HugeInt(value) => serde_json::Value::String(value.to_string()),
            Value::UHugeInt(value) => serde_json::Value::String(value.to_string()),
            Value::UTinyInt(value) => serde_json::json!(value),
            Value::USmallInt(value) => serde_json::json!(value),
            Value::UInt(value) => serde_json::json!(value),
            Value::UBigInt(value) => serde_json::Value::String(value.to_string()),
            Value::Float(value) => Self::float_to_json(value as f64),
            Value::Double(value) => Self::float_to_json(value),
            Value::Decimal(value) => serde_json::Value::String(value.to_string()),
            Value::Timestamp(unit, value) => serde_json::Value::String(format!(
                "timestamp({}, {})",
                Self::time_unit_label(unit),
                value
            )),
            Value::Text(value) => serde_json::Value::String(value),
            Value::Blob(bytes) => serde_json::Value::String(Self::bytes_to_hex(&bytes)),
            Value::Geometry(bytes) => serde_json::Value::String(Self::bytes_to_hex(&bytes)),
            Value::Date32(days) => serde_json::Value::String(format!("date32({days})")),
            Value::Time64(unit, value) => serde_json::Value::String(format!(
                "time64({}, {})",
                Self::time_unit_label(unit),
                value
            )),
            Value::Interval {
                months,
                days,
                nanos,
            } => serde_json::Value::String(format!(
                "interval(months={months}, days={days}, nanos={nanos})"
            )),
            Value::List(values) | Value::Array(values) => serde_json::Value::Array(
                values.into_iter().map(Self::duckdb_value_to_json).collect(),
            ),
            Value::Enum(value) => serde_json::Value::String(value),
            Value::Struct(entries) => {
                let mut object = serde_json::Map::new();
                for (key, value) in entries.iter() {
                    object.insert(key.clone(), Self::duckdb_value_to_json(value.clone()));
                }
                serde_json::Value::Object(object)
            }
            Value::Map(entries) => Self::duckdb_map_to_json(entries),
            Value::Union(value) => Self::duckdb_value_to_json(*value),
            other => serde_json::Value::String(format!("unsupported duckdb value: {:?}", other)),
        }
    }

    fn duckdb_map_to_json(entries: OrderedMap<Value, Value>) -> serde_json::Value {
        let mapped = entries
            .iter()
            .map(|(key, value)| {
                (
                    Self::duckdb_value_to_json(key.clone()),
                    Self::duckdb_value_to_json(value.clone()),
                )
            })
            .collect::<Vec<_>>();

        if mapped
            .iter()
            .all(|(key, _)| matches!(key, serde_json::Value::String(_)))
        {
            let mut object = serde_json::Map::new();
            for (key, value) in mapped {
                if let serde_json::Value::String(key) = key {
                    object.insert(key, value);
                }
            }
            serde_json::Value::Object(object)
        } else {
            serde_json::Value::Array(
                mapped
                    .into_iter()
                    .map(|(key, value)| {
                        serde_json::json!({
                            "key": key,
                            "value": value,
                        })
                    })
                    .collect(),
            )
        }
    }

    fn float_to_json(value: f64) -> serde_json::Value {
        match serde_json::Number::from_f64(value) {
            Some(number) => serde_json::Value::Number(number),
            None if value.is_nan() => serde_json::Value::String("NaN".to_string()),
            None if value.is_sign_positive() => serde_json::Value::String("Infinity".to_string()),
            None => serde_json::Value::String("-Infinity".to_string()),
        }
    }

    fn bytes_to_hex(bytes: &[u8]) -> String {
        let mut hex = String::with_capacity(bytes.len() * 2 + 2);
        hex.push_str("0x");
        for byte in bytes {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex
    }

    fn time_unit_label(unit: TimeUnit) -> &'static str {
        match unit {
            TimeUnit::Second => "Second",
            TimeUnit::Millisecond => "Millisecond",
            TimeUnit::Microsecond => "Microsecond",
            TimeUnit::Nanosecond => "Nanosecond",
        }
    }

    /// Export a dataset to CSV
    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        self.conn.execute(
            &format!("COPY \"{}\" TO $1 (HEADER, DELIMITER ',')", table_name),
            params![output_path],
        )?;
        Ok(())
    }

    /// Export all datasets as CSV files packed into a ZIP archive.
    ///
    /// This is the parameterized variant used both for "export everything"
    /// and for folder-scoped exports from the UI.
    ///
    /// * `subset` — if `Some`, only datasets whose ids appear in the slice are
    ///   exported; if `None`, all datasets are exported.
    /// * `archive_paths` — optional `dataset_id → path inside the zip` map
    ///   (without the `.csv` suffix). This is how the UI requests folder-aware
    ///   layouts (e.g. `Folder1/Sub/Table.csv`). Datasets not present in the
    ///   map fall back to a sanitized dataset name at the zip root.
    ///
    /// The path inside the zip is automatically suffixed with `.csv` and any
    /// characters that are illegal on Windows are replaced with `_`. The
    /// folder separator `/` is preserved so subfolder hierarchies survive.
    pub fn export_csv_zip_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        archive_paths: &std::collections::HashMap<String, String>,
    ) -> Result<(), AppError> {
        use std::io::Write;

        let datasets = self.list_datasets()?;
        // When a subset is requested, intersect with what actually exists so
        // a stale id from the UI doesn't blow up the whole export.
        let filtered: Vec<DatasetMeta> = match subset {
            Some(ids) => {
                let id_set: std::collections::HashSet<&str> =
                    ids.iter().map(|s| s.as_str()).collect();
                datasets
                    .into_iter()
                    .filter(|d| id_set.contains(d.id.as_str()))
                    .collect()
            }
            None => datasets,
        };
        if filtered.is_empty() {
            return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
        }

        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // Track used archive paths so a (folder, name) clash inside the zip
        // resolves to `name (2).csv`, `name (3).csv`, … instead of overwriting.
        let mut used_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

        for ds in &filtered {
            let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

            // Get user column names (exclude _row_id)
            let mut col_stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )?;
            let col_names: Vec<String> = col_stmt
                .query_map(params![ds.id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;

            if col_names.is_empty() {
                continue;
            }

            let select_cols = col_names
                .iter()
                .map(|c| format!("CAST(\"{}\" AS VARCHAR) AS \"{}\"", c, c))
                .collect::<Vec<_>>()
                .join(", ");

            // Query all data
            let sql = format!("SELECT {} FROM \"{}\"", select_cols, table_name);
            let mut stmt = self.conn.prepare(&sql)?;
            let col_count = col_names.len();
            let mut rows = stmt.query([])?;

            // Build CSV content in memory
            let mut csv_buf = Vec::new();
            // Header
            writeln!(&mut csv_buf, "{}", col_names.join(","))
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            // Data rows
            while let Some(row) = rows.next()? {
                let mut parts = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let val: Option<String> = row.get(i)?;
                    match val {
                        Some(v) => {
                            if v.contains(',') || v.contains('"') || v.contains('\n') {
                                parts.push(format!("\"{}\"", v.replace('"', "\"\"")));
                            } else {
                                parts.push(v);
                            }
                        }
                        None => parts.push(String::new()),
                    }
                }
                writeln!(&mut csv_buf, "{}", parts.join(","))
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
            }

            // Resolve the archive path. We sanitize each path segment so the
            // resulting zip is portable across platforms (Windows is the
            // strictest). Forward slashes between segments are intentionally
            // preserved so subfolders remain.
            let raw_path = archive_paths
                .get(&ds.id)
                .cloned()
                .unwrap_or_else(|| ds.name.clone());
            let safe_base = sanitize_archive_path(&raw_path);
            let file_name = dedupe_archive_path(&safe_base, "csv", &mut used_paths);
            zip.start_file(&file_name, options)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            zip.write_all(&csv_buf)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    }

    /// Import all tables from a SQLite database as datasets
    pub fn import_sqlite<F>(
        &self,
        file_path: &str,
        on_progress: &F,
    ) -> Result<Vec<(String, DatasetMeta)>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        use rusqlite::types::ValueRef;

        // Open SQLite file directly with rusqlite (bypasses DuckDB's scanner type issues)
        let sqlite_conn = rusqlite::Connection::open_with_flags(
            file_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;

        // List user tables
        let mut table_stmt = sqlite_conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let table_names: Vec<String> = table_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(table_stmt);

        let table_total = table_names.len();

        let mut results = Vec::new();

        for (table_index, src_table) in table_names.iter().enumerate() {
            self.validate_dataset_name(src_table, None)?;

            let id = uuid::Uuid::new_v4().to_string();
            let table_name = format!("dataset_{}", id.replace('-', "_"));

            // Get column info via PRAGMA table_info
            let mut pragma_stmt =
                sqlite_conn.prepare(&format!("PRAGMA table_info(\"{}\")", src_table))?;
            let columns: Vec<(String, String)> = pragma_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?, // column name
                        row.get::<_, String>(2)?, // column type
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(pragma_stmt);

            if columns.is_empty() {
                continue;
            }

            // Map SQLite types to DuckDB types (date/time types -> VARCHAR)
            let col_defs: Vec<String> = columns
                .iter()
                .map(|(name, sqlite_type)| {
                    let duckdb_type = Self::map_sqlite_type(sqlite_type);
                    format!("\"{}\" {}", name, duckdb_type)
                })
                .collect();

            self.conn.execute(
                &format!(
                    "CREATE TABLE \"{}\" (\"_row_id\" BIGINT, {})",
                    table_name,
                    col_defs.join(", ")
                ),
                [],
            )?;

            // Determine target types for value conversion
            let col_types: Vec<&str> = columns
                .iter()
                .map(|(_, t)| Self::map_sqlite_type(t))
                .collect();

            // Read ALL data from SQLite into memory first, then batch-insert into DuckDB.
            // This avoids holding the DuckDB mutex while doing slow SQLite I/O.
            let col_count = columns.len();
            on_progress(src_table, table_index, table_total, 0, 0); // signal: reading started
            let all_rows: Vec<Vec<String>> = {
                let col_names_sql = columns
                    .iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let select_sql = format!("SELECT {} FROM \"{}\"", col_names_sql, src_table);
                let mut data_stmt = sqlite_conn.prepare(&select_sql)?;
                let mut rows = data_stmt.query([])?;
                let mut collected = Vec::new();

                while let Some(row) = rows.next()? {
                    let mut row_vals = Vec::with_capacity(col_count);
                    for i in 0..col_count {
                        let val_ref = row.get_ref(i)?;
                        let s = match val_ref {
                            ValueRef::Null => "\0NULL\0".to_string(),
                            ValueRef::Integer(v) => v.to_string(),
                            ValueRef::Real(v) => v.to_string(),
                            ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
                            ValueRef::Blob(_) => "\0NULL\0".to_string(),
                        };
                        row_vals.push(s);
                    }
                    collected.push(row_vals);
                }
                collected
            };

            // Batch INSERT using VALUES lists (1000 rows per batch for speed)
            const BATCH_SIZE: usize = 1000;
            let total_rows = all_rows.len();
            let mut rows_done: usize = 0;
            on_progress(src_table, table_index, table_total, 0, total_rows);
            self.conn.execute_batch("BEGIN TRANSACTION")?;

            for chunk in all_rows.chunks(BATCH_SIZE) {
                let mut values_parts: Vec<String> = Vec::with_capacity(chunk.len());
                for (batch_idx, row_vals) in chunk.iter().enumerate() {
                    let row_id = values_parts.len(); // placeholder, will compute below
                    let _ = row_id; // suppress warning
                    let mut col_parts: Vec<String> = Vec::with_capacity(col_count + 1);
                    // _row_id will be added via a subquery
                    for (ci, val) in row_vals.iter().enumerate() {
                        if val == "\0NULL\0" {
                            col_parts.push("NULL".to_string());
                        } else {
                            match col_types[ci] {
                                "BIGINT" => match val.parse::<i64>() {
                                    Ok(v) => col_parts.push(v.to_string()),
                                    Err(_) => col_parts.push("NULL".to_string()),
                                },
                                "DOUBLE" => match val.parse::<f64>() {
                                    Ok(_) => col_parts.push(val.clone()),
                                    Err(_) => col_parts.push("NULL".to_string()),
                                },
                                _ => {
                                    // VARCHAR
                                    col_parts.push(format!("'{}'", val.replace('\'', "''")));
                                }
                            }
                        }
                    }
                    let _ = batch_idx;
                    values_parts.push(format!("({})", col_parts.join(", ")));
                }

                // Use INSERT with row_number() to generate _row_id
                let col_aliases = columns
                    .iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let insert_sql = format!(
                    "INSERT INTO \"{}\" SELECT row_number() OVER () + (SELECT COALESCE(MAX(\"_row_id\"), 0) FROM \"{}\"), {} FROM (VALUES {}) AS t({})",
                    table_name, table_name, col_aliases, values_parts.join(", "), col_aliases
                );
                self.conn.execute_batch(&insert_sql)?;
                rows_done += chunk.len();
                on_progress(src_table, table_index, table_total, rows_done, total_rows);
            }

            self.conn.execute_batch("COMMIT")?;

            // Get row count
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;

            // Insert column metadata
            let col_count_i32 = columns.len() as i32;
            for (col_index, (col_name, sqlite_type)) in columns.iter().enumerate() {
                let duckdb_type = Self::map_sqlite_type(sqlite_type);
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index as i32, col_name, duckdb_type],
                )?;
            }

            // Insert dataset metadata
            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'sqlite', $4, $5)",
                params![id, src_table, file_path, row_count, col_count_i32],
            )?;

            let meta = self.get_dataset_meta(&id)?;
            results.push((src_table.clone(), meta));
        }

        Ok(results)
    }

    /// Map SQLite column type to DuckDB type, keeping date/time types as VARCHAR
    fn map_sqlite_type(sqlite_type: &str) -> &'static str {
        let upper = sqlite_type.to_uppercase();
        if upper.contains("INT") || upper.contains("BOOL") {
            "BIGINT"
        } else if upper.contains("REAL")
            || upper.contains("FLOA")
            || upper.contains("DOUB")
            || upper.contains("NUMERIC")
            || upper.contains("DECIMAL")
        {
            "DOUBLE"
        } else {
            "VARCHAR"
        }
    }

    pub fn validate_dataset_name(
        &self,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<(), AppError> {
        if name.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "Dataset name cannot be empty".into(),
            ));
        }

        if name.starts_with(|ch: char| ch.is_whitespace() || ch == '.')
            || name.ends_with(|ch: char| ch.is_whitespace() || ch == '.')
        {
            return Err(AppError::InvalidParam(
                "Dataset name cannot start or end with a dot or whitespace".into(),
            ));
        }

        if name
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(AppError::InvalidParam(
                "Dataset name contains invalid characters: / \\ : * ? \" < > |".into(),
            ));
        }

        let mut stmt = self.conn.prepare(
            "SELECT name FROM _meta_datasets WHERE lower(name) = lower($1) AND ($2 IS NULL OR id != $2) LIMIT 1",
        )?;
        let mut rows = stmt.query(params![name, exclude_id])?;
        if let Some(row) = rows.next()? {
            let conflict_name: String = row.get(0)?;
            return Err(AppError::InvalidParam(format!(
                "Dataset name conflicts with existing dataset \"{}\"",
                conflict_name
            )));
        }

        Ok(())
    }

    /// Export datasets to a SQLite database file.
    ///
    /// This is the parameterized variant used both for "export everything"
    /// and for folder-scoped exports from the UI.
    ///
    /// * `subset` — if `Some`, only datasets whose ids appear in the slice are
    ///   exported; if `None`, all datasets are exported.
    /// * `name_overrides` — `dataset_id → table name to use in the destination
    ///   SQLite file`. Datasets not present in the map fall back to their
    ///   regular `name`. Used by the UI to encode folder structure into the
    ///   destination as `folder-tablename` (SQLite has no nested namespaces).
    ///
    /// If two datasets would map to the same SQLite table name (because they
    /// share the same `folder-name` after override), the second one is
    /// suffixed with ` (2)`, ` (3)`, … to avoid `CREATE TABLE` collisions.
    pub fn export_sqlite_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        name_overrides: &std::collections::HashMap<String, String>,
    ) -> Result<(), AppError> {
        // Install and load the sqlite extension
        self.conn.execute_batch("INSTALL sqlite; LOAD sqlite;")?;

        // Delete existing file if present (so we get a fresh database)
        let _ = std::fs::remove_file(output_path);

        // Detach if previously attached (from a failed attempt)
        let _ = self.conn.execute_batch("DETACH IF EXISTS _sqlite_dst;");

        // Attach the output SQLite database
        self.conn.execute(
            &format!(
                "ATTACH '{}' AS _sqlite_dst (TYPE sqlite)",
                output_path.replace('\'', "''")
            ),
            [],
        )?;

        let result = (|| -> Result<(), AppError> {
            let datasets = self.list_datasets()?;
            let filtered: Vec<DatasetMeta> = match subset {
                Some(ids) => {
                    let id_set: std::collections::HashSet<&str> =
                        ids.iter().map(|s| s.as_str()).collect();
                    datasets
                        .into_iter()
                        .filter(|d| id_set.contains(d.id.as_str()))
                        .collect()
                }
                None => datasets,
            };
            if filtered.is_empty() {
                return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
            }

            // Track which SQLite table names we've already emitted so the
            // (folder, name) → table name collisions resolve deterministically.
            let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

            for ds in &filtered {
                let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

                // Get user column names (exclude _row_id)
                let mut col_stmt = self.conn.prepare(
                    "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
                )?;
                let col_names: Vec<String> = col_stmt
                    .query_map(params![ds.id], |row| row.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;

                if col_names.is_empty() {
                    continue;
                }

                let select_cols = col_names
                    .iter()
                    .map(|c| format!("\"{}\" ", c))
                    .collect::<Vec<_>>()
                    .join(", ");

                // Pick the destination table name, then dedupe within this run.
                let base = name_overrides
                    .get(&ds.id)
                    .cloned()
                    .unwrap_or_else(|| ds.name.clone());
                let dst_name = dedupe_sqlite_table_name(&base, &mut used);

                // Create the table in the destination SQLite database
                self.conn.execute(
                    &format!(
                        "CREATE TABLE _sqlite_dst.\"{}\" AS SELECT {} FROM \"{}\"",
                        dst_name.replace('"', "\"\""),
                        select_cols,
                        table_name
                    ),
                    [],
                )?;
            }

            Ok(())
        })();

        // Always detach
        let _ = self.conn.execute_batch("DETACH _sqlite_dst;");

        result
    }

    /// Get basic descriptive stats for a numeric column
    pub fn column_stats(
        &self,
        dataset_id: &str,
        column_name: &str,
    ) -> Result<crate::models::stats::ColumnStats, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        let stats = self.conn.query_row(
            &format!(
                "SELECT
                    COUNT(*) as cnt,
                    COUNT(*) - COUNT(\"{col}\") as missing,
                    AVG(\"{col}\") as mean_val,
                    MEDIAN(\"{col}\") as median_val,
                    STDDEV_SAMP(\"{col}\") as std_val,
                    MIN(\"{col}\") as min_val,
                    MAX(\"{col}\") as max_val,
                    QUANTILE_CONT(\"{col}\", 0.25) as q1_val,
                    QUANTILE_CONT(\"{col}\", 0.75) as q3_val,
                    COUNT(DISTINCT \"{col}\") as unique_cnt
                FROM \"{table}\"",
                col = column_name,
                table = table_name
            ),
            [],
            |row| {
                Ok(crate::models::stats::ColumnStats {
                    column_name: column_name.to_string(),
                    count: row.get(0)?,
                    missing: row.get(1)?,
                    mean: row.get(2)?,
                    median: row.get(3)?,
                    std_dev: row.get(4)?,
                    min: row.get(5)?,
                    max: row.get(6)?,
                    q1: row.get(7)?,
                    q3: row.get(8)?,
                    unique_count: row.get(9)?,
                })
            },
        )?;

        Ok(stats)
    }

    /// Get descriptive stats for all numeric columns in a dataset
    pub fn descriptive_stats(
        &self,
        dataset_id: &str,
    ) -> Result<crate::models::stats::DescriptiveResult, AppError> {
        // Get column list
        let mut stmt = self.conn.prepare(
            "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;

        let col_names: Vec<String> = stmt
            .query_map(params![dataset_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut columns = Vec::new();
        for col_name in &col_names {
            match self.column_stats(dataset_id, col_name) {
                Ok(stats) => columns.push(stats),
                Err(_) => continue, // Skip non-numeric columns
            }
        }

        Ok(crate::models::stats::DescriptiveResult {
            dataset_id: dataset_id.to_string(),
            columns,
        })
    }

    /// Create an empty dataset with specified columns (columns may be empty)
    pub fn create_empty_table(
        &self,
        id: &str,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if column_names.len() != column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }

        self.validate_dataset_name(name, None)?;
        Self::validate_result_column_names(column_names)?;
        let canonical_types = column_types
            .iter()
            .map(|column_type| self.canonicalize_column_type(column_type))
            .collect::<Result<Vec<_>, _>>()?;

        let table_name = Self::quote_identifier(&Self::internal_table_name(id));

        // Build column definitions
        let col_defs: Vec<String> = column_names
            .iter()
            .zip(canonical_types.iter())
            .map(|(name, typ)| format!("{} {}", Self::quote_identifier(name), typ))
            .collect();

        // Add a hidden row_id column for row identification
        let create_sql = if col_defs.is_empty() {
            format!(
                "CREATE TABLE {} (\"_row_id\" INTEGER DEFAULT 0)",
                table_name
            )
        } else {
            format!(
                "CREATE TABLE {} (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Register column metadata
        for (i, (col_name, col_type)) in column_names.iter().zip(canonical_types.iter()).enumerate()
        {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![id, i as i32, col_name, col_type],
            )?;
        }

        // Insert dataset metadata
        let col_count = column_names.len() as i32;
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, NULL, 'manual', 0, $3)",
            params![id, name, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Add an empty row to a dataset, returns the new row_id
    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        self.with_row_mutation(dataset_id, || {
            let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
            let max_id: Option<i64> = self
                .conn
                .query_row(
                    &format!("SELECT MAX(\"_row_id\") FROM \"{}\"", table_name),
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(None);
            let new_id = max_id.unwrap_or(0) + 1;

            self.conn.execute(
                &format!("INSERT INTO \"{}\" (\"_row_id\") VALUES ($1)", table_name),
                params![new_id],
            )?;
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, dataset_id],
            )?;
            Ok(new_id)
        })
    }

    pub fn add_rows(&self, dataset_id: &str, count: usize) -> Result<Vec<i64>, AppError> {
        const MAX_ROWS: usize = 100_000;
        if count == 0 || count > MAX_ROWS {
            return Err(AppError::InvalidParam(format!(
                "row count must be between 1 and {MAX_ROWS}"
            )));
        }
        let count_i64 = i64::try_from(count)
            .map_err(|_| AppError::InvalidParam("row count is too large".into()))?;
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        self.with_row_mutation(dataset_id, || {
            let max_id: Option<i64> = self.conn.query_row(
                &format!("SELECT MAX(\"_row_id\") FROM {table}"),
                [],
                |row| row.get(0),
            )?;
            let first_id = max_id
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("row ID range is exhausted".into()))?;
            let final_id = first_id
                .checked_add(count_i64 - 1)
                .ok_or_else(|| AppError::InvalidParam("row ID range is exhausted".into()))?;
            self.conn.execute(
                &format!("INSERT INTO {table} (\"_row_id\") SELECT ? + range FROM range(?)"),
                params![first_id, count_i64],
            )?;
            let row_count: i64 =
                self.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = ? WHERE id = ?",
                params![row_count, dataset_id],
            )?;
            Ok((first_id..=final_id).collect())
        })
    }

    pub fn apply_added_rows(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
        undo: bool,
        expected_generation: u64,
    ) -> Result<u64, AppError> {
        const MAX_ROWS: usize = 100_000;
        if row_ids.is_empty() || row_ids.len() > MAX_ROWS {
            return Err(AppError::InvalidParam(format!(
                "row count must be between 1 and {MAX_ROWS}"
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
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<u64, AppError> {
            let generation = self.get_dataset_generation(dataset_id)?;
            if generation != expected_generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected_generation}"
                )));
            }
            for chunk in unique_ids.chunks(1_000) {
                let placeholders = std::iter::repeat_n("?", chunk.len())
                    .collect::<Vec<_>>()
                    .join(", ");
                if undo {
                    self.conn.execute(
                        &format!("DELETE FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
                        params_from_iter(chunk.iter()),
                    )?;
                } else {
                    let collisions: i64 = self.conn.query_row(
                        &format!(
                            "SELECT COUNT(*) FROM {table} WHERE \"_row_id\" IN ({placeholders})"
                        ),
                        params_from_iter(chunk.iter()),
                        |row| row.get(0),
                    )?;
                    if collisions != 0 {
                        return Err(AppError::InvalidParam(
                            "cannot redo added rows because row IDs already exist".into(),
                        ));
                    }
                    let value_rows = (0..chunk.len())
                        .map(|_| "(?)")
                        .collect::<Vec<_>>()
                        .join(", ");
                    self.conn.execute(
                        &format!("INSERT INTO {table} (\"_row_id\") VALUES {value_rows}"),
                        params_from_iter(chunk.iter()),
                    )?;
                }
            }
            let row_count: i64 =
                self.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = ? WHERE id = ?",
                params![row_count, dataset_id],
            )?;
            self.bump_dataset_generation(dataset_id)?;
            generation
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))
        })();
        match result {
            Ok(generation) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(generation)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Update a cell value
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        self.with_row_mutation(dataset_id, || {
            let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
            if value.is_empty() {
                let update_sql = format!(
                    "UPDATE \"{}\" SET \"{}\" = NULL WHERE \"_row_id\" = $1",
                    table_name, column_name
                );
                self.conn.execute(&update_sql, params![row_id])?;
            } else {
                let update_sql = format!(
                    "UPDATE \"{}\" SET \"{}\" = $1 WHERE \"_row_id\" = $2",
                    table_name, column_name
                );
                self.conn.execute(&update_sql, params![value, row_id])?;
            }
            Ok(())
        })
    }

    pub fn clear_cells(&self, dataset_id: &str, cells: &[CellPosition]) -> Result<(), AppError> {
        const MAX_CELLS: usize = 100_000;
        const ROW_IDS_PER_UPDATE: usize = 1_000;
        if cells.is_empty() {
            return Ok(());
        }
        if cells.len() > MAX_CELLS {
            return Err(AppError::InvalidParam(format!(
                "cannot clear more than {MAX_CELLS} cells at once"
            )));
        }

        let allowed_columns = self
            .get_user_columns(dataset_id)?
            .into_iter()
            .map(|(name, _)| name)
            .collect::<HashSet<_>>();
        let mut row_ids_by_column = BTreeMap::<String, Vec<i64>>::new();
        for cell in cells {
            if !allowed_columns.contains(&cell.column_name) {
                return Err(AppError::InvalidParam(format!(
                    "unknown column: {}",
                    cell.column_name
                )));
            }
            row_ids_by_column
                .entry(cell.column_name.clone())
                .or_default()
                .push(cell.row_id);
        }

        self.with_row_mutation(dataset_id, || {
            let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            for (column_name, mut row_ids) in row_ids_by_column {
                row_ids.sort_unstable();
                row_ids.dedup();
                let column = Self::quote_identifier(&column_name);
                for chunk in row_ids.chunks(ROW_IDS_PER_UPDATE) {
                    let placeholders = std::iter::repeat_n("?", chunk.len())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "UPDATE {table} SET {column} = NULL WHERE \"_row_id\" IN ({placeholders})"
                    );
                    self.conn.execute(&sql, params_from_iter(chunk.iter()))?;
                }
            }
            Ok(())
        })
    }

    pub fn update_cells(&self, dataset_id: &str, updates: &[CellUpdate]) -> Result<(), AppError> {
        self.update_cells_if_generation(dataset_id, updates, None)
            .map(|_| ())
    }

    pub fn update_cells_if_generation(
        &self,
        dataset_id: &str,
        updates: &[CellUpdate],
        expected_generation: Option<u64>,
    ) -> Result<u64, AppError> {
        const MAX_CELLS: usize = 100_000;
        if updates.is_empty() {
            return self.get_dataset_generation(dataset_id);
        }
        if updates.len() > MAX_CELLS {
            return Err(AppError::InvalidParam(format!(
                "cannot update more than {MAX_CELLS} cells at once"
            )));
        }
        let allowed_columns = self
            .get_user_columns(dataset_id)?
            .into_iter()
            .map(|(name, _)| name)
            .collect::<HashSet<_>>();
        for update in updates {
            if !allowed_columns.contains(&update.column_name) {
                return Err(AppError::InvalidParam(format!(
                    "unknown column: {}",
                    update.column_name
                )));
            }
        }

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<u64, AppError> {
            let generation = self.get_dataset_generation(dataset_id)?;
            if expected_generation.is_some_and(|expected| expected != generation) {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {}",
                    expected_generation.unwrap_or(generation)
                )));
            }
            let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            for update in updates {
                let column = Self::quote_identifier(&update.column_name);
                match &update.value {
                    Some(value) => {
                        self.conn.execute(
                            &format!("UPDATE {table} SET {column} = $1 WHERE \"_row_id\" = $2"),
                            params![value, update.row_id],
                        )?;
                    }
                    None => {
                        self.conn.execute(
                            &format!("UPDATE {table} SET {column} = NULL WHERE \"_row_id\" = $1"),
                            params![update.row_id],
                        )?;
                    }
                }
            }
            self.bump_dataset_generation(dataset_id)?;
            generation
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))
        })();
        match result {
            Ok(generation) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(generation)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Delete a row by row_id
    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        self.with_row_mutation(dataset_id, || {
            let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
            self.conn.execute(
                &format!("DELETE FROM \"{}\" WHERE \"_row_id\" = $1", table_name),
                params![row_id],
            )?;
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, dataset_id],
            )?;
            Ok(())
        })
    }

    pub fn delete_rows(&self, dataset_id: &str, row_ids: &[i64]) -> Result<(), AppError> {
        const MAX_ROWS: usize = 5_000;
        if row_ids.is_empty() {
            return Ok(());
        }
        if row_ids.len() > MAX_ROWS {
            return Err(AppError::InvalidParam(format!(
                "cannot delete more than {MAX_ROWS} rows at once"
            )));
        }
        let mut unique_row_ids = row_ids.to_vec();
        unique_row_ids.sort_unstable();
        unique_row_ids.dedup();

        self.with_row_mutation(dataset_id, || {
            let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            let placeholders = std::iter::repeat_n("?", unique_row_ids.len())
                .collect::<Vec<_>>()
                .join(", ");
            self.conn.execute(
                &format!("DELETE FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
                params_from_iter(unique_row_ids.iter()),
            )?;
            let row_count: i64 =
                self.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, dataset_id],
            )?;
            Ok(())
        })
    }

    /// Rename a dataset
    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        self.validate_dataset_name(new_name, Some(dataset_id))?;

        self.conn.execute(
            "UPDATE _meta_datasets SET name = $1 WHERE id = $2",
            params![new_name, dataset_id],
        )?;
        Ok(())
    }

    /// Add a column to a dataset
    pub fn add_column(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
    ) -> Result<(), AppError> {
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let column_name = Self::quote_identifier(col_name);
        let col_type = self.canonicalize_column_type(col_type)?;

        // ALTER TABLE to add column
        self.conn.execute(
            &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {col_type}"),
            [],
        )?;

        // Get current max col_index
        let max_idx: Option<i32> = self
            .conn
            .query_row(
                "SELECT MAX(col_index) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        let new_idx = max_idx.unwrap_or(-1) + 1;

        // Insert column metadata
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
            params![dataset_id, new_idx, col_name, col_type],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
            params![dataset_id],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    /// Insert a new column at a specific visible index (0-based among user
    /// columns). The column is always appended physically — display order is
    /// driven entirely by `_meta_columns.col_index`, so physical position is
    /// irrelevant — then `col_index` values are shifted so the new column lands
    /// at `at_index`. `at_index` is clamped to `[0, col_count]`.
    pub fn insert_column_at(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: i32,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Clamp the target index to the current column count.
        let col_count: i32 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let at = at_index.clamp(0, col_count);

        // ALTER TABLE to add the column (appended physically).
        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
                table_name, col_name, col_type
            ),
            [],
        )?;

        // Shift existing columns at/after the insertion point one slot right.
        // DuckDB evaluates the UPDATE set-based, mirroring the decrement used
        // by `delete_column`, so no primary-key clash occurs.
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = $1 AND col_index >= $2",
            params![dataset_id, at],
        )?;

        // Register the new column at the freed slot.
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
            params![dataset_id, at, col_name, col_type],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
            params![dataset_id],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    /// Move a user column from visible index `from` to visible index `to`,
    /// renumbering every `col_index` so they stay contiguous `0..n`. Both
    /// indices are clamped to the valid range; a no-op move returns `Ok`.
    pub fn reorder_column(&self, dataset_id: &str, from: i32, to: i32) -> Result<(), AppError> {
        // Read the current column order.
        let mut names: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )?;
            stmt.query_map(params![dataset_id], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect()
        };

        let n = names.len() as i32;
        if n == 0 {
            return Ok(());
        }
        let from = from.clamp(0, n - 1);
        let to = to.clamp(0, n - 1);
        if from == to {
            return Ok(());
        }

        // Apply the move within the ordered name list.
        let moved = names.remove(from as usize);
        names.insert(to as usize, moved);

        // Offset every col_index out of the target range `0..n` first so the
        // subsequent per-column assignment can't hit a primary-key clash.
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index + $1 WHERE dataset_id = $2",
            params![n + 1000, dataset_id],
        )?;
        for (i, name) in names.iter().enumerate() {
            self.conn.execute(
                "UPDATE _meta_columns SET col_index = $1 WHERE dataset_id = $2 AND col_name = $3",
                params![i as i32, dataset_id, name],
            )?;
        }

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    pub fn reorder_column_if_generation(
        &self,
        dataset_id: &str,
        from: i32,
        to: i32,
        expected_generation: u64,
    ) -> Result<u64, AppError> {
        let column_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
            params![dataset_id],
            |row| row.get(0),
        )?;
        if column_count == 0 {
            return Err(AppError::InvalidParam("dataset has no user columns".into()));
        }
        let from = from.clamp(0, column_count - 1);
        let to = to.clamp(0, column_count - 1);
        if from == to {
            return Err(AppError::InvalidParam(
                "column reorder has no effect".into(),
            ));
        }

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<u64, AppError> {
            let generation = self.get_dataset_generation(dataset_id)?;
            if generation != expected_generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected_generation}"
                )));
            }
            self.reorder_column(dataset_id, from, to)?;
            self.get_dataset_generation(dataset_id)
        })();
        match result {
            Ok(generation) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(generation)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    /// Delete a column from a dataset
    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // ALTER TABLE to drop column
        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table_name, col_name
            ),
            [],
        )?;

        // Get the index of the deleted column
        let del_idx: i32 = self.conn.query_row(
            "SELECT col_index FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
            |row| row.get(0),
        )?;

        // Delete column metadata
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
        )?;

        // Re-index remaining columns
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = $1 AND col_index > $2",
            params![dataset_id, del_idx],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count - 1 WHERE id = $1",
            params![dataset_id],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    /// Rename a column
    pub fn rename_column(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let old_identifier = Self::quote_identifier(old_name);
        let new_identifier = Self::quote_identifier(new_name);

        self.conn.execute(
            &format!("ALTER TABLE {table_name} RENAME COLUMN {old_identifier} TO {new_identifier}"),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_name = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![new_name, dataset_id, old_name],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    pub fn change_column_type(
        &self,
        dataset_id: &str,
        col_name: &str,
        new_type: &str,
    ) -> Result<(), AppError> {
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let column_name = Self::quote_identifier(col_name);
        let new_type = self.canonicalize_column_type(new_type)?;

        // Pre-validate: check if all non-null values can be cast to the new type
        let check_sql = format!(
            "SELECT COUNT(*) FROM {table_name} WHERE {column_name} IS NOT NULL AND TRY_CAST({column_name} AS {new_type}) IS NULL"
        );
        let fail_count: i64 = self
            .conn
            .query_row(&check_sql, [], |row| row.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;

        if fail_count > 0 {
            return Err(AppError::InvalidParam(format!(
                "无法将列 \"{}\" 转换为 {}：有 {} 个值无法转换",
                col_name, new_type, fail_count
            )));
        }

        self.conn.execute(
            &format!(
                "ALTER TABLE {table_name} ALTER COLUMN {column_name} SET DATA TYPE {new_type} USING {column_name}::{new_type}"
            ),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_type = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![&new_type, dataset_id, col_name],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    /// Paste data at a specific position in the dataset.
    /// Creates missing columns/rows as needed, updates cells.
    /// If `header_names` is provided, renames target columns to those names.
    /// For existing empty columns, changes type to detected type.
    ///
    /// Performance: wraps everything in a single transaction, allocates new rows
    /// in bulk, and applies all cell updates via a single `UPDATE ... FROM`
    /// against a temporary patch table. This avoids the O(rows * cols) per-cell
    /// UPDATE pattern, which is catastrophic on a column-store like DuckDB
    /// (each per-cell UPDATE rewrites the entire column block).
    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
    ) -> Result<(), AppError> {
        self.paste_at_position_if_generation(
            dataset_id,
            start_row,
            start_col,
            rows,
            header_names,
            new_col_types,
            None,
        )
    }

    pub fn paste_at_position_if_generation(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
        expected_generation: Option<u64>,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Wrap the entire operation in a transaction so we get a single commit
        // (instead of one auto-commit per statement) and atomic rollback on error.
        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| {
            if let Some(expected) = expected_generation {
                let current = self.get_dataset_generation(dataset_id)?;
                if current != expected {
                    return Err(AppError::InvalidParam(format!(
                        "stale dataset generation: expected {current}, received {expected}"
                    )));
                }
            }
            self.paste_at_position_inner(
                dataset_id,
                &table_name,
                start_row,
                start_col,
                rows,
                header_names,
                new_col_types,
            )
        })()
        .and_then(|()| self.bump_dataset_generation(dataset_id));
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(())
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                let _ = self.conn.execute("DROP TABLE IF EXISTS _paste_patch", []);
                Err(e)
            }
        }
    }

    pub fn paste_at_position_with_change_set(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let existing_columns = self.get_user_columns(dataset_id)?;
        let paste_column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
        start_col
            .checked_add(paste_column_count)
            .ok_or_else(|| AppError::InvalidParam("Paste column range is too large".into()))?;
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if generation != expected {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }

        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let before_columns = (0..paste_column_count)
            .map(|ordinal| existing_columns.get(start_col + ordinal).cloned())
            .collect::<Vec<_>>();
        let snapshot_columns = before_columns
            .iter()
            .enumerate()
            .map(|(ordinal, column)| match column {
                Some((name, _)) => format!(
                    "{} AS {}",
                    Self::quote_identifier(name),
                    Self::quote_identifier(&format!("c{ordinal}"))
                ),
                None => format!("CAST(NULL AS VARCHAR) AS \"c{ordinal}\""),
            })
            .collect::<Vec<_>>();
        let snapshot_select = std::iter::once("\"_row_id\"".to_string())
            .chain(snapshot_columns.iter().cloned())
            .collect::<Vec<_>>()
            .join(", ");
        let limit = i64::try_from(rows.len())
            .map_err(|_| AppError::InvalidParam("Paste row count is too large".into()))?;
        let offset = i64::try_from(start_row)
            .map_err(|_| AppError::InvalidParam("Paste row offset is too large".into()))?;
        let original_max_row_id: Option<i64> = self.conn.query_row(
            &format!("SELECT MAX(\"_row_id\") FROM {dataset_table}"),
            [],
            |row| row.get(0),
        )?;
        let original_max_row_id = original_max_row_id.unwrap_or(0);

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT {snapshot_select} FROM {dataset_table} ORDER BY \"_row_id\" LIMIT ? OFFSET ?"
                ),
                params![limit, offset],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, generation + 1],
            )?;
            self.paste_at_position_inner(
                dataset_id,
                &Self::internal_table_name(dataset_id),
                start_row,
                start_col,
                rows,
                header_names,
                new_col_types,
            )?;
            let after_columns = self.get_user_columns(dataset_id)?;
            for ordinal in 0..paste_column_count {
                let (after_name, after_type) =
                    after_columns.get(start_col + ordinal).ok_or_else(|| {
                        AppError::Database("Paste column allocation was incomplete".into())
                    })?;
                let (before_name, before_type) = before_columns[ordinal]
                    .as_ref()
                    .map(|(name, column_type)| (Some(name.as_str()), Some(column_type.as_str())))
                    .unwrap_or((None, None));
                self.conn.execute(
                    "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        &change_set_id,
                        ordinal as i32,
                        (start_col + ordinal) as i32,
                        before_name,
                        before_type,
                        after_name,
                        after_type,
                    ],
                )?;
            }
            let after_snapshot_select = std::iter::once("\"_row_id\"".to_string())
                .chain((0..paste_column_count).map(|ordinal| {
                    let column = Self::quote_identifier(&after_columns[start_col + ordinal].0);
                    format!("{column} AS \"c{ordinal}\"")
                }))
                .collect::<Vec<_>>()
                .join(", ");
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT {after_snapshot_select} FROM {dataset_table} WHERE \"_row_id\" IN (SELECT \"_row_id\" FROM {before_table}) OR \"_row_id\" > ?"
                ),
                params![original_max_row_id],
            )?;
            let changed = self.conn.execute(
                "UPDATE _meta_datasets SET generation = ? WHERE id = ?",
                params![generation + 1, dataset_id],
            )?;
            if changed != 1 {
                return Err(AppError::InvalidParam(format!(
                    "Unknown dataset: {dataset_id}"
                )));
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                let _ = self.conn.execute("DROP TABLE IF EXISTS _paste_patch", []);
                Err(error)
            }
        }
    }

    pub fn delete_rows_with_change_set(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        const MAX_ROWS: usize = 5_000;
        if row_ids.is_empty() || row_ids.len() > MAX_ROWS {
            return Err(AppError::InvalidParam(format!(
                "row count must be between 1 and {MAX_ROWS}"
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

        let columns = self.get_user_columns(dataset_id)?;
        let generation = self.get_dataset_generation(dataset_id)?;
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {generation}, received {}",
                expected_generation.unwrap_or_default()
            )));
        }
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let snapshot_select = std::iter::once("\"_row_id\"".to_string())
            .chain(columns.iter().enumerate().map(|(ordinal, (name, _))| {
                format!(
                    "{} AS {}",
                    Self::quote_identifier(name),
                    Self::quote_identifier(&format!("c{ordinal}"))
                )
            }))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = std::iter::repeat_n("?", unique_ids.len())
            .collect::<Vec<_>>()
            .join(", ");

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            let matched_rows: i64 = self.conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {dataset_table} WHERE \"_row_id\" IN ({placeholders})"
                ),
                params_from_iter(unique_ids.iter()),
                |row| row.get(0),
            )?;
            if matched_rows != unique_ids.len() as i64 {
                return Err(AppError::InvalidParam(
                    "one or more rows no longer exist".into(),
                ));
            }
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT {snapshot_select} FROM {dataset_table} WHERE \"_row_id\" IN ({placeholders})"
                ),
                params_from_iter(unique_ids.iter()),
            )?;
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT {snapshot_select} FROM {dataset_table} WHERE FALSE"
                ),
                [],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, generation + 1],
            )?;
            for (ordinal, (name, column_type)) in columns.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        &change_set_id,
                        ordinal as i32,
                        ordinal as i32,
                        name,
                        column_type,
                        name,
                        column_type,
                    ],
                )?;
            }
            self.conn.execute(
                &format!("DELETE FROM {dataset_table} WHERE \"_row_id\" IN ({placeholders})"),
                params_from_iter(unique_ids.iter()),
            )?;
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM {dataset_table}"),
                [],
                |row| row.get(0),
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = ?, generation = ? WHERE id = ?",
                params![row_count, generation + 1, dataset_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn add_column_with_change_set(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: Option<i32>,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let column_type = self.canonicalize_column_type(col_type)?;
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if expected != generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        let column_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
            params![dataset_id],
            |row| row.get(0),
        )?;
        let column_index = at_index.unwrap_or(column_count).clamp(0, column_count);
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let column_identifier = Self::quote_identifier(col_name);
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT \"_row_id\" FROM {dataset_table} WHERE FALSE"
                ),
                [],
            )?;
            self.conn.execute(
                &format!(
                    "ALTER TABLE {dataset_table} ADD COLUMN {column_identifier} {column_type}"
                ),
                [],
            )?;
            self.conn.execute(
                "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                params![dataset_id, column_index],
            )?;
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                params![dataset_id, column_index, col_name, &column_type],
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count + 1, generation = ? WHERE id = ?",
                params![next_generation, dataset_id],
            )?;
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT \"_row_id\", {column_identifier} AS \"c0\" FROM {dataset_table} WHERE FALSE"
                ),
                [],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, next_generation],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, 0, ?, NULL, NULL, ?, ?)",
                params![&change_set_id, column_index, col_name, &column_type],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn add_columns_with_change_set(
        &self,
        dataset_id: &str,
        columns: &[(String, String)],
        at_index: Option<i32>,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        const MAX_COLUMNS: usize = 1_000;
        if columns.is_empty() || columns.len() > MAX_COLUMNS {
            return Err(AppError::InvalidParam(format!(
                "column count must be between 1 and {MAX_COLUMNS}"
            )));
        }
        let canonical_columns = columns
            .iter()
            .map(|(name, column_type)| {
                self.canonicalize_column_type(column_type)
                    .map(|canonical_type| (name, canonical_type))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if expected != generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        let existing_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
            params![dataset_id],
            |row| row.get(0),
        )?;
        let first_index = at_index.unwrap_or(existing_count).clamp(0, existing_count);
        let added_count = i32::try_from(canonical_columns.len())
            .map_err(|_| AppError::InvalidParam("too many columns".into()))?;
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT \"_row_id\" FROM {dataset_table} WHERE FALSE"
                ),
                [],
            )?;
            for (ordinal, (name, column_type)) in canonical_columns.iter().enumerate() {
                let column_index = first_index + ordinal as i32;
                let column_identifier = Self::quote_identifier(name);
                self.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ADD COLUMN {column_identifier} {column_type}"
                    ),
                    [],
                )?;
                self.conn.execute(
                    "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                    params![dataset_id, column_index],
                )?;
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                    params![dataset_id, column_index, name, column_type],
                )?;
            }
            self.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count + ?, generation = ? WHERE id = ?",
                params![added_count, next_generation, dataset_id],
            )?;
            let after_select = std::iter::once("\"_row_id\"".to_string())
                .chain(
                    canonical_columns
                        .iter()
                        .enumerate()
                        .map(|(ordinal, (name, _))| {
                            format!(
                                "{} AS {}",
                                Self::quote_identifier(name),
                                Self::quote_identifier(&format!("c{ordinal}"))
                            )
                        }),
                )
                .collect::<Vec<_>>()
                .join(", ");
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT {after_select} FROM {dataset_table} WHERE FALSE"
                ),
                [],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, next_generation],
            )?;
            for (ordinal, (name, column_type)) in canonical_columns.iter().enumerate() {
                let column_index = first_index + ordinal as i32;
                self.conn.execute(
                    "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
                    params![&change_set_id, ordinal as i32, column_index, name, column_type],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn delete_columns_with_change_set(
        &self,
        dataset_id: &str,
        column_names: &[String],
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        const MAX_COLUMNS: usize = 1_000;
        if column_names.is_empty() || column_names.len() > MAX_COLUMNS {
            return Err(AppError::InvalidParam(format!(
                "column count must be between 1 and {MAX_COLUMNS}"
            )));
        }
        let mut requested = column_names.to_vec();
        requested.sort();
        requested.dedup();
        if requested.len() != column_names.len() {
            return Err(AppError::InvalidParam("column names must be unique".into()));
        }
        let existing_columns = self.get_user_columns(dataset_id)?;
        if requested.len() >= existing_columns.len() {
            return Err(AppError::InvalidParam(
                "cannot delete every user column".into(),
            ));
        }
        let requested_set = requested
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let deleted_columns = existing_columns
            .iter()
            .enumerate()
            .filter(|(_, (name, _))| requested_set.contains(name))
            .map(|(index, (name, column_type))| (index as i32, name.clone(), column_type.clone()))
            .collect::<Vec<_>>();
        if deleted_columns.len() != column_names.len() {
            return Err(AppError::InvalidParam(
                "one or more columns do not exist".into(),
            ));
        }
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if expected != generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));
        let before_select = std::iter::once("\"_row_id\"".to_string())
            .chain(
                deleted_columns
                    .iter()
                    .enumerate()
                    .map(|(ordinal, (_, name, _))| {
                        format!(
                            "{} AS {}",
                            Self::quote_identifier(name),
                            Self::quote_identifier(&format!("c{ordinal}"))
                        )
                    }),
            )
            .collect::<Vec<_>>()
            .join(", ");

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT {before_select} FROM {dataset_table}"
                ),
                [],
            )?;
            for (column_index, name, _) in deleted_columns.iter().rev() {
                self.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} DROP COLUMN {}",
                        Self::quote_identifier(name)
                    ),
                    [],
                )?;
                self.conn.execute(
                    "DELETE FROM _meta_columns WHERE dataset_id = ? AND col_name = ?",
                    params![dataset_id, name],
                )?;
                self.conn.execute(
                    "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = ? AND col_index > ?",
                    params![dataset_id, column_index],
                )?;
            }
            self.conn.execute(
                &format!("CREATE TABLE {after_table} AS SELECT \"_row_id\" FROM {dataset_table}"),
                [],
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count - ?, generation = ? WHERE id = ?",
                params![deleted_columns.len() as i32, next_generation, dataset_id],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, next_generation],
            )?;
            for (ordinal, (column_index, name, column_type)) in deleted_columns.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type, after_present) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)",
                    params![
                        &change_set_id,
                        ordinal as i32,
                        column_index,
                        name,
                        column_type,
                        name,
                        column_type,
                    ],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn alter_column_with_change_set(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
        new_type: &str,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let existing_columns = self.get_user_columns(dataset_id)?;
        let (column_index, old_type) = existing_columns
            .iter()
            .enumerate()
            .find(|(_, (name, _))| name == old_name)
            .map(|(index, (_, column_type))| (index as i32, column_type.clone()))
            .ok_or_else(|| AppError::InvalidParam(format!("unknown column: {old_name}")))?;
        if new_name != old_name && existing_columns.iter().any(|(name, _)| name == new_name) {
            return Err(AppError::InvalidParam(format!(
                "column already exists: {new_name}"
            )));
        }
        let new_type = self.canonicalize_column_type(new_type)?;
        if new_name == old_name && new_type == old_type {
            return Err(AppError::InvalidParam("column change has no effect".into()));
        }
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if expected != generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let old_identifier = Self::quote_identifier(old_name);
        let new_identifier = Self::quote_identifier(new_name);
        if new_type != old_type {
            let failed_casts: i64 = self.conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {dataset_table} WHERE {old_identifier} IS NOT NULL AND TRY_CAST({old_identifier} AS {new_type}) IS NULL"
                ),
                [],
                |row| row.get(0),
            )?;
            if failed_casts != 0 {
                return Err(AppError::InvalidParam(format!(
                    "cannot convert {failed_casts} values in column {old_name} to {new_type}"
                )));
            }
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT \"_row_id\", {old_identifier} AS \"c0\" FROM {dataset_table}"
                ),
                [],
            )?;
            if new_type != old_type {
                self.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ALTER COLUMN {old_identifier} SET DATA TYPE {new_type} USING {old_identifier}::{new_type}"
                    ),
                    [],
                )?;
            }
            if new_name != old_name {
                self.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} RENAME COLUMN {old_identifier} TO {new_identifier}"
                    ),
                    [],
                )?;
            }
            self.conn.execute(
                "UPDATE _meta_columns SET col_name = ?, col_type = ? WHERE dataset_id = ? AND col_name = ?",
                params![new_name, &new_type, dataset_id, old_name],
            )?;
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT \"_row_id\", {new_identifier} AS \"c0\" FROM {dataset_table}"
                ),
                [],
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET generation = ? WHERE id = ?",
                params![next_generation, dataset_id],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, next_generation],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, 0, ?, ?, ?, ?, ?)",
                params![
                    &change_set_id,
                    column_index,
                    old_name,
                    old_type,
                    new_name,
                    &new_type,
                ],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn alter_columns_type_with_change_set(
        &self,
        dataset_id: &str,
        column_names: &[String],
        new_type: &str,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        const MAX_COLUMNS: usize = 1_000;
        if column_names.is_empty() || column_names.len() > MAX_COLUMNS {
            return Err(AppError::InvalidParam(format!(
                "column count must be between 1 and {MAX_COLUMNS}"
            )));
        }
        let requested = column_names
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        if requested.len() != column_names.len() {
            return Err(AppError::InvalidParam("column names must be unique".into()));
        }
        let existing_columns = self.get_user_columns(dataset_id)?;
        let changed_columns = existing_columns
            .iter()
            .enumerate()
            .filter(|(_, (name, _))| requested.contains(name))
            .map(|(index, (name, column_type))| (index as i32, name.clone(), column_type.clone()))
            .collect::<Vec<_>>();
        if changed_columns.len() != column_names.len() {
            return Err(AppError::InvalidParam(
                "one or more columns do not exist".into(),
            ));
        }
        let new_type = self.canonicalize_column_type(new_type)?;
        if changed_columns
            .iter()
            .any(|(_, _, old_type)| old_type == &new_type)
        {
            return Err(AppError::InvalidParam(
                "one or more column changes have no effect".into(),
            ));
        }
        let generation = self.get_dataset_generation(dataset_id)?;
        if let Some(expected) = expected_generation {
            if expected != generation {
                return Err(AppError::InvalidParam(format!(
                    "stale dataset generation: expected {generation}, received {expected}"
                )));
            }
        }
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        for (_, name, _) in &changed_columns {
            let identifier = Self::quote_identifier(name);
            let failed_casts: i64 = self.conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {dataset_table} WHERE {identifier} IS NOT NULL AND TRY_CAST({identifier} AS {new_type}) IS NULL"
                ),
                [],
                |row| row.get(0),
            )?;
            if failed_casts != 0 {
                return Err(AppError::InvalidParam(format!(
                    "cannot convert {failed_casts} values in column {name} to {new_type}"
                )));
            }
        }
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let suffix = change_set_id.replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));
        let snapshot_select = |columns: &[(i32, String, String)]| {
            std::iter::once("\"_row_id\"".to_string())
                .chain(columns.iter().enumerate().map(|(ordinal, (_, name, _))| {
                    format!(
                        "{} AS {}",
                        Self::quote_identifier(name),
                        Self::quote_identifier(&format!("c{ordinal}"))
                    )
                }))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let before_select = snapshot_select(&changed_columns);

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {before_table} AS SELECT {before_select} FROM {dataset_table}"
                ),
                [],
            )?;
            for (_, name, _) in &changed_columns {
                let identifier = Self::quote_identifier(name);
                self.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ALTER COLUMN {identifier} SET DATA TYPE {new_type} USING {identifier}::{new_type}"
                    ),
                    [],
                )?;
                self.conn.execute(
                    "UPDATE _meta_columns SET col_type = ? WHERE dataset_id = ? AND col_name = ?",
                    params![&new_type, dataset_id, name],
                )?;
            }
            let after_select = snapshot_select(&changed_columns);
            self.conn.execute(
                &format!(
                    "CREATE TABLE {after_table} AS SELECT {after_select} FROM {dataset_table}"
                ),
                [],
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET generation = ? WHERE id = ?",
                params![next_generation, dataset_id],
            )?;
            self.conn.execute(
                "INSERT INTO _history_change_sets (id, dataset_id, generation) VALUES (?, ?, ?)",
                params![&change_set_id, dataset_id, next_generation],
            )?;
            for (ordinal, (column_index, name, old_type)) in changed_columns.iter().enumerate() {
                self.conn.execute(
                    "INSERT INTO _history_change_set_columns (change_set_id, ordinal, column_index, before_name, before_type, after_name, after_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        &change_set_id,
                        ordinal as i32,
                        column_index,
                        name,
                        old_type,
                        name,
                        &new_type,
                    ],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(change_set_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn apply_change_set(&self, change_set_id: &str, undo: bool) -> Result<(), AppError> {
        let parsed_id = uuid::Uuid::parse_str(change_set_id)
            .map_err(|_| AppError::InvalidParam("Invalid change set ID".into()))?;
        let suffix = parsed_id.to_string().replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));
        let snapshot_table = Self::quote_identifier(&format!(
            "_history_{}_{suffix}",
            if undo { "before" } else { "after" }
        ));
        let (dataset_id, applied, expected_generation): (String, bool, u64) = self
            .conn
            .query_row(
                "SELECT dataset_id, applied, generation FROM _history_change_sets WHERE id = ?",
                params![change_set_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| AppError::InvalidParam("Unknown change set ID".into()))?;
        if applied != undo {
            return Err(AppError::InvalidParam(if undo {
                "Change set is already undone".into()
            } else {
                "Change set is already applied".into()
            }));
        }
        let generation = self.get_dataset_generation(&dataset_id)?;
        if generation != expected_generation {
            return Err(AppError::InvalidParam(format!(
                "stale change set generation: expected {expected_generation}, received {generation}"
            )));
        }
        let mut statement = self.conn.prepare(
            "SELECT ordinal, column_index, before_name, before_type, after_name, after_type, after_present FROM _history_change_set_columns WHERE change_set_id = ? ORDER BY ordinal",
        )?;
        let columns = statement
            .query_map(params![change_set_id], |row| {
                Ok((
                    row.get::<_, i32>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(&dataset_id));
        let assignments = columns
            .iter()
            .filter_map(
                |(ordinal, _, before_name, _, after_name, _, after_present)| {
                    let target_name = if undo {
                        before_name.as_ref()
                    } else if *after_present {
                        Some(after_name)
                    } else {
                        None
                    }?;
                    Some(format!(
                        "{} = snapshot.{}",
                        Self::quote_identifier(target_name),
                        Self::quote_identifier(&format!("c{ordinal}"))
                    ))
                },
            )
            .collect::<Vec<_>>()
            .join(", ");
        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            if undo {
                for (_, column_index, before_name, before_type, _, _, after_present) in &columns {
                    if !after_present {
                        let before_name = before_name.as_ref().ok_or_else(|| {
                            AppError::Database("deleted column is missing its before name".into())
                        })?;
                        let before_type = before_type.as_ref().ok_or_else(|| {
                            AppError::Database("deleted column is missing its before type".into())
                        })?;
                        self.conn.execute(
                            "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                            params![&dataset_id, column_index],
                        )?;
                        self.conn.execute(
                            &format!(
                                "ALTER TABLE {dataset_table} ADD COLUMN {} {before_type}",
                                Self::quote_identifier(before_name)
                            ),
                            [],
                        )?;
                        self.conn.execute(
                            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                            params![&dataset_id, column_index, before_name, before_type],
                        )?;
                    }
                }
                for (_, _, before_name, before_type, after_name, after_type, after_present) in
                    &columns
                {
                    if !after_present {
                        continue;
                    }
                    if let (Some(_), Some(before_type)) = (before_name, before_type) {
                        if before_type != after_type {
                            let quoted_name = Self::quote_identifier(after_name);
                            self.conn.execute(
                                &format!(
                                    "ALTER TABLE {dataset_table} ALTER COLUMN {quoted_name} SET DATA TYPE {before_type} USING NULL::{before_type}"
                                ),
                                [],
                            )?;
                            self.conn.execute(
                                "UPDATE _meta_columns SET col_type = ? WHERE dataset_id = ? AND col_name = ?",
                                params![before_type, &dataset_id, after_name],
                            )?;
                        }
                    }
                }
                for (ordinal, _, before_name, _, after_name, _, after_present) in &columns {
                    if !after_present {
                        continue;
                    }
                    if before_name.as_ref().is_some_and(|name| name != after_name) {
                        let temporary = format!("__history_{suffix}_{ordinal}");
                        self.conn.execute(
                            &format!(
                                "ALTER TABLE {dataset_table} RENAME COLUMN {} TO {}",
                                Self::quote_identifier(after_name),
                                Self::quote_identifier(&temporary)
                            ),
                            [],
                        )?;
                        self.conn.execute(
                            "UPDATE _meta_columns SET col_name = ? WHERE dataset_id = ? AND col_name = ?",
                            params![&temporary, &dataset_id, after_name],
                        )?;
                    }
                }
                for (ordinal, _, before_name, _, after_name, _, after_present) in &columns {
                    if !after_present {
                        continue;
                    }
                    if let Some(before_name) = before_name {
                        if before_name != after_name {
                            let temporary = format!("__history_{suffix}_{ordinal}");
                            self.conn.execute(
                                &format!(
                                    "ALTER TABLE {dataset_table} RENAME COLUMN {} TO {}",
                                    Self::quote_identifier(&temporary),
                                    Self::quote_identifier(before_name)
                                ),
                                [],
                            )?;
                            self.conn.execute(
                                "UPDATE _meta_columns SET col_name = ? WHERE dataset_id = ? AND col_name = ?",
                                params![before_name, &dataset_id, &temporary],
                            )?;
                        }
                    }
                }
                for (_, column_index, before_name, _, after_name, _, after_present) in
                    columns.iter().rev()
                {
                    if !after_present {
                        continue;
                    }
                    if before_name.is_none() {
                        self.conn.execute(
                            &format!(
                                "ALTER TABLE {dataset_table} DROP COLUMN {}",
                                Self::quote_identifier(after_name)
                            ),
                            [],
                        )?;
                        self.conn.execute(
                            "DELETE FROM _meta_columns WHERE dataset_id = ? AND col_name = ?",
                            params![&dataset_id, after_name],
                        )?;
                        self.conn.execute(
                            "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = ? AND col_index > ?",
                            params![&dataset_id, column_index],
                        )?;
                    }
                }
                self.conn.execute(
                    &format!(
                        "DELETE FROM {dataset_table} WHERE \"_row_id\" IN (SELECT \"_row_id\" FROM {after_table} EXCEPT SELECT \"_row_id\" FROM {before_table})"
                    ),
                    [],
                )?;
                self.conn.execute(
                    &format!(
                        "INSERT INTO {dataset_table} (\"_row_id\") SELECT snapshot.\"_row_id\" FROM {before_table} snapshot LEFT JOIN {dataset_table} current_rows ON current_rows.\"_row_id\" = snapshot.\"_row_id\" WHERE current_rows.\"_row_id\" IS NULL"
                    ),
                    [],
                )?;
                if !assignments.is_empty() {
                    self.conn.execute(
                        &format!(
                            "UPDATE {dataset_table} SET {assignments} FROM {snapshot_table} snapshot WHERE {dataset_table}.\"_row_id\" = snapshot.\"_row_id\""
                        ),
                        [],
                    )?;
                }
            } else {
                self.conn.execute(
                    &format!(
                        "DELETE FROM {dataset_table} WHERE \"_row_id\" IN (SELECT \"_row_id\" FROM {before_table} EXCEPT SELECT \"_row_id\" FROM {after_table})"
                    ),
                    [],
                )?;
                for (_, column_index, before_name, _, after_name, after_type, after_present) in
                    &columns
                {
                    if !after_present {
                        continue;
                    }
                    if before_name.is_none() {
                        self.conn.execute(
                            "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                            params![&dataset_id, column_index],
                        )?;
                        self.conn.execute(
                            &format!(
                                "ALTER TABLE {dataset_table} ADD COLUMN {} {after_type}",
                                Self::quote_identifier(after_name)
                            ),
                            [],
                        )?;
                        self.conn.execute(
                            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                            params![&dataset_id, column_index, after_name, after_type],
                        )?;
                    }
                }
                for (_, _, before_name, before_type, _, after_type, after_present) in &columns {
                    if !after_present {
                        continue;
                    }
                    if let (Some(before_name), Some(before_type)) = (before_name, before_type) {
                        if before_type != after_type {
                            let quoted_name = Self::quote_identifier(before_name);
                            self.conn.execute(
                                &format!(
                                    "ALTER TABLE {dataset_table} ALTER COLUMN {quoted_name} SET DATA TYPE {after_type} USING {quoted_name}::{after_type}"
                                ),
                                [],
                            )?;
                            self.conn.execute(
                                "UPDATE _meta_columns SET col_type = ? WHERE dataset_id = ? AND col_name = ?",
                                params![after_type, &dataset_id, before_name],
                            )?;
                        }
                    }
                }
                for (ordinal, _, before_name, _, after_name, _, after_present) in &columns {
                    if !after_present {
                        continue;
                    }
                    if let Some(before_name) = before_name {
                        if before_name != after_name {
                            let temporary = format!("__history_{suffix}_{ordinal}");
                            self.conn.execute(
                                &format!(
                                    "ALTER TABLE {dataset_table} RENAME COLUMN {} TO {}",
                                    Self::quote_identifier(before_name),
                                    Self::quote_identifier(&temporary)
                                ),
                                [],
                            )?;
                            self.conn.execute(
                                "UPDATE _meta_columns SET col_name = ? WHERE dataset_id = ? AND col_name = ?",
                                params![&temporary, &dataset_id, before_name],
                            )?;
                        }
                    }
                }
                for (ordinal, _, before_name, _, after_name, _, after_present) in &columns {
                    if !after_present {
                        continue;
                    }
                    if before_name.as_ref().is_some_and(|name| name != after_name) {
                        let temporary = format!("__history_{suffix}_{ordinal}");
                        self.conn.execute(
                            &format!(
                                "ALTER TABLE {dataset_table} RENAME COLUMN {} TO {}",
                                Self::quote_identifier(&temporary),
                                Self::quote_identifier(after_name)
                            ),
                            [],
                        )?;
                        self.conn.execute(
                            "UPDATE _meta_columns SET col_name = ? WHERE dataset_id = ? AND col_name = ?",
                            params![after_name, &dataset_id, &temporary],
                        )?;
                    }
                }
                self.conn.execute(
                    &format!(
                        "INSERT INTO {dataset_table} (\"_row_id\") SELECT snapshot.\"_row_id\" FROM {after_table} snapshot LEFT JOIN {dataset_table} current_rows ON current_rows.\"_row_id\" = snapshot.\"_row_id\" WHERE current_rows.\"_row_id\" IS NULL"
                    ),
                    [],
                )?;
                if !assignments.is_empty() {
                    self.conn.execute(
                        &format!(
                            "UPDATE {dataset_table} SET {assignments} FROM {snapshot_table} snapshot WHERE {dataset_table}.\"_row_id\" = snapshot.\"_row_id\""
                        ),
                        [],
                    )?;
                }
                for (_, column_index, before_name, _, _, _, after_present) in columns.iter().rev() {
                    if *after_present {
                        continue;
                    }
                    let before_name = before_name.as_ref().ok_or_else(|| {
                        AppError::Database("deleted column is missing its before name".into())
                    })?;
                    self.conn.execute(
                        &format!(
                            "ALTER TABLE {dataset_table} DROP COLUMN {}",
                            Self::quote_identifier(before_name)
                        ),
                        [],
                    )?;
                    self.conn.execute(
                        "DELETE FROM _meta_columns WHERE dataset_id = ? AND col_name = ?",
                        params![&dataset_id, before_name],
                    )?;
                    self.conn.execute(
                        "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = ? AND col_index > ?",
                        params![&dataset_id, column_index],
                    )?;
                }
            }
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM {dataset_table}"),
                [],
                |row| row.get(0),
            )?;
            let col_count: i32 = self.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
                params![&dataset_id],
                |row| row.get(0),
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = ?, col_count = ?, generation = ? WHERE id = ?",
                params![row_count, col_count, generation + 1, &dataset_id],
            )?;
            self.conn.execute(
                "UPDATE _history_change_sets SET applied = ?, generation = ? WHERE id = ?",
                params![!undo, generation + 1, change_set_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT;").map_err(Into::into),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub fn drop_change_set(&self, change_set_id: &str) -> Result<(), AppError> {
        let parsed_id = uuid::Uuid::parse_str(change_set_id)
            .map_err(|_| AppError::InvalidParam("Invalid change set ID".into()))?;
        let suffix = parsed_id.to_string().replace('-', "_");
        let before_table = Self::quote_identifier(&format!("_history_before_{suffix}"));
        let after_table = Self::quote_identifier(&format!("_history_after_{suffix}"));

        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {before_table}"), [])?;
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {after_table}"), [])?;
            self.conn.execute(
                "DELETE FROM _history_change_set_columns WHERE change_set_id = ?",
                params![change_set_id],
            )?;
            self.conn.execute(
                "DELETE FROM _history_change_sets WHERE id = ?",
                params![change_set_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT;").map_err(Into::into),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    fn paste_at_position_inner(
        &self,
        dataset_id: &str,
        table_name: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
    ) -> Result<(), AppError> {
        // 1. Get existing columns
        let mut stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let existing_cols: Vec<(String, String)> = stmt
            .query_map(params![dataset_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let num_paste_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let num_paste_rows = rows.len();
        if let Some(names) = header_names {
            if names.len() != num_paste_cols {
                return Err(AppError::InvalidParam(format!(
                    "header width {} does not match pasted data width {num_paste_cols}",
                    names.len()
                )));
            }
        }
        let mut all_col_names: Vec<String> = existing_cols.iter().map(|(n, _)| n.clone()).collect();

        // 2. Determine target column names; create new columns if needed.
        //    Track resolved per-column type so the batch UPDATE can cast correctly.
        let mut paste_col_names: Vec<String> = Vec::with_capacity(num_paste_cols);
        let mut paste_col_types: Vec<String> = Vec::with_capacity(num_paste_cols);
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                paste_col_names.push(existing_cols[target_idx].0.clone());
                paste_col_types.push(existing_cols[target_idx].1.clone());
            } else {
                let col_type = new_col_types
                    .get(c)
                    .map(|s| s.as_str())
                    .unwrap_or("VARCHAR");
                let col_name = if let Some(names) = header_names {
                    let name = names.get(c).map(|s| s.trim()).unwrap_or("");
                    if name.is_empty() {
                        Self::generate_col_name(&all_col_names)
                    } else {
                        // Auto-suffix -2/-3/... if the header collides with an
                        // existing column (or with one created earlier in this
                        // same paste). Avoids DuckDB Catalog Errors like
                        // "Column with name X already exists!".
                        Self::unique_col_name(name, &all_col_names, None)
                    }
                } else {
                    Self::generate_col_name(&all_col_names)
                };
                self.add_column(dataset_id, &col_name, col_type)?;
                all_col_names.push(col_name.clone());
                paste_col_names.push(col_name);
                paste_col_types.push(col_type.to_string());
            }
        }

        // 3. For existing target columns with no data, change type to detected type
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                let (ref col_name, ref existing_type) = existing_cols[target_idx];
                let detected_type = new_col_types
                    .get(c)
                    .map(|s| s.as_str())
                    .unwrap_or("VARCHAR");
                if existing_type != detected_type {
                    let has_data: i64 = self.conn.query_row(
                        &format!(
                            "SELECT COUNT(*) FROM \"{}\" WHERE \"{}\" IS NOT NULL",
                            table_name, col_name
                        ),
                        [],
                        |row| row.get(0),
                    )?;
                    if has_data == 0 {
                        if self
                            .change_column_type(dataset_id, col_name, detected_type)
                            .is_ok()
                        {
                            paste_col_types[c] = detected_type.to_string();
                        }
                    }
                }
            }
        }

        // 4. Handle header renames for existing columns
        if let Some(names) = header_names {
            for (c, new_name) in names.iter().enumerate() {
                let target_idx = start_col + c;
                if target_idx < existing_cols.len() {
                    let old_name = &paste_col_names[c];
                    let trimmed = new_name.trim();
                    if !trimmed.is_empty() && old_name != trimmed {
                        // Auto-suffix -2/-3/... if the proposed name collides
                        // with any OTHER column. The column being renamed is
                        // excluded so a no-op rename (which we already filter
                        // above) wouldn't have been suffixed anyway.
                        let unique =
                            Self::unique_col_name(trimmed, &all_col_names, Some(target_idx));
                        let unique_owned = unique.clone();
                        self.rename_column(dataset_id, old_name, &unique_owned)?;
                        all_col_names[target_idx] = unique_owned.clone();
                        paste_col_names[c] = unique_owned;
                    }
                }
            }
        }

        // 5. Fetch only the existing row IDs touched by this paste.
        let start_row_i64 = i64::try_from(start_row)
            .map_err(|_| AppError::InvalidParam("Paste row offset is too large".into()))?;
        let num_paste_rows_i64 = i64::try_from(num_paste_rows)
            .map_err(|_| AppError::InvalidParam("Paste row count is too large".into()))?;
        let mut row_stmt = self.conn.prepare(&format!(
            "SELECT \"_row_id\" FROM \"{}\" ORDER BY \"_row_id\" LIMIT $1 OFFSET $2",
            table_name
        ))?;
        let mut affected_row_ids: Vec<i64> = row_stmt
            .query_map(params![num_paste_rows_i64, start_row_i64], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(row_stmt);

        // 5b. Bulk-allocate missing tail rows, including any gap when the
        // paste starts beyond the current end. Retain IDs only for rows that
        // the paste itself updates.
        let existing_row_count: usize = self
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get::<_, i64>(0),
            )?
            .try_into()
            .map_err(|_| AppError::Database("Invalid negative row count".into()))?;
        let total_target_rows = start_row
            .checked_add(num_paste_rows)
            .ok_or_else(|| AppError::InvalidParam("Paste row range is too large".into()))?;
        if total_target_rows > existing_row_count {
            let need = total_target_rows - existing_row_count;
            let max_id: Option<i64> = self.conn.query_row(
                &format!("SELECT MAX(\"_row_id\") FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;
            let start_new = max_id
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("Row ID range is exhausted".into()))?;
            let need_i64 = i64::try_from(need)
                .map_err(|_| AppError::InvalidParam("Paste row range is too large".into()))?;
            let final_new_id = start_new
                .checked_add(need_i64 - 1)
                .ok_or_else(|| AppError::InvalidParam("Row ID range is exhausted".into()))?;
            self.conn.execute(
                &format!(
                    "INSERT INTO \"{}\" (\"_row_id\") SELECT $1 + range FROM range($2)",
                    table_name
                ),
                params![start_new, need_i64],
            )?;
            let first_new_paste_row = affected_row_ids.len();
            for paste_row in first_new_paste_row..num_paste_rows {
                let logical_row = start_row
                    .checked_add(paste_row)
                    .ok_or_else(|| AppError::InvalidParam("Paste row range is too large".into()))?;
                let offset = i64::try_from(logical_row - existing_row_count)
                    .map_err(|_| AppError::InvalidParam("Paste row range is too large".into()))?;
                let row_id = start_new
                    .checked_add(offset)
                    .filter(|row_id| *row_id <= final_new_id)
                    .ok_or_else(|| AppError::InvalidParam("Row ID range is exhausted".into()))?;
                affected_row_ids.push(row_id);
            }
        }

        // 6. Build a temporary patch table and apply all cell updates with a
        //    single multi-column `UPDATE ... FROM`. Each target column is
        //    rewritten exactly once instead of once per pasted row.
        if num_paste_cols > 0 && num_paste_rows > 0 {
            // Defensive cleanup in case a previous error left it behind.
            let _ = self.conn.execute("DROP TABLE IF EXISTS _paste_patch", []);

            let mut create_cols = String::from("\"_row_id\" BIGINT");
            for c in 0..num_paste_cols {
                create_cols.push_str(&format!(", \"c{}\" VARCHAR", c));
            }
            self.conn.execute(
                &format!("CREATE TEMP TABLE _paste_patch ({})", create_cols),
                [],
            )?;

            // Prepared multi-row INSERT (param list: _row_id, c0, c1, ...).
            let mut col_list = String::from("\"_row_id\"");
            let mut placeholders = String::from("$1");
            for c in 0..num_paste_cols {
                col_list.push_str(&format!(", \"c{}\"", c));
                placeholders.push_str(&format!(", ${}", c + 2));
            }
            let insert_sql = format!(
                "INSERT INTO _paste_patch ({}) VALUES ({})",
                col_list, placeholders
            );
            let mut ins = self.conn.prepare(&insert_sql)?;

            for (r, row_data) in rows.iter().enumerate() {
                let row_id = affected_row_ids.get(r).copied().ok_or_else(|| {
                    AppError::Database("Paste target row allocation was incomplete".into())
                })?;

                let mut vals: Vec<Value> = Vec::with_capacity(num_paste_cols + 1);
                vals.push(Value::BigInt(row_id));
                for c in 0..num_paste_cols {
                    let v = row_data.get(c).map(|s| s.as_str()).unwrap_or("");
                    if v.is_empty() {
                        vals.push(Value::Null);
                    } else {
                        vals.push(Value::Text(v.to_string()));
                    }
                }
                ins.execute(params_from_iter(vals.iter()))?;
            }

            // Single UPDATE that touches every paste column at once.
            // COALESCE preserves the previous behavior of skipping empty
            // (NULL in the patch) cells. CAST errors abort the transaction so
            // invalid pasted values cannot be silently discarded.
            let mut set_clauses: Vec<String> = Vec::with_capacity(num_paste_cols);
            let quoted_table = Self::quote_identifier(table_name);
            for c in 0..num_paste_cols {
                let col_name = Self::quote_identifier(&paste_col_names[c]);
                let col_type = &paste_col_types[c];
                set_clauses.push(format!(
                    "{col_name} = COALESCE(CAST(p.\"c{c}\" AS {col_type}), {quoted_table}.{col_name})",
                ));
            }
            let update_sql = format!(
                "UPDATE {quoted_table} SET {set} FROM _paste_patch p \
                 WHERE {quoted_table}.\"_row_id\" = p.\"_row_id\"",
                set = set_clauses.join(", "),
            );
            self.conn.execute(&update_sql, [])?;

            self.conn.execute("DROP TABLE _paste_patch", [])?;
        }

        // 7. Update metadata counts (once at the end)
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        Ok(())
    }

    fn generate_col_name(existing: &[String]) -> String {
        let mut i = 1;
        loop {
            let name = format!("列{}", i);
            if !existing.contains(&name) {
                return name;
            }
            i += 1;
        }
    }

    /// Resolve a column name that may collide with existing ones.
    ///
    /// Returns `base` unchanged when it's free, otherwise appends `-2`, `-3`,
    /// ... until a non-conflicting name is produced. `exclude_idx`, if given,
    /// designates a slot in `existing` whose current name should NOT count as
    /// a collision (used when renaming a column to a header value that may
    /// equal its own current name).
    fn unique_col_name(base: &str, existing: &[String], exclude_idx: Option<usize>) -> String {
        let in_use = |candidate: &str| -> bool {
            existing
                .iter()
                .enumerate()
                .any(|(i, n)| n == candidate && Some(i) != exclude_idx)
        };
        if !in_use(base) {
            return base.to_string();
        }
        let mut i = 2usize;
        loop {
            let candidate = format!("{}-{}", base, i);
            if !in_use(&candidate) {
                return candidate;
            }
            i += 1;
        }
    }

    /// Restore a table from a full snapshot (columns, types, rows).
    /// Drops all existing data and recreates the table with the given schema and data.
    pub fn restore_snapshot(
        &self,
        dataset_id: &str,
        col_names: &[String],
        col_types: &[String],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Drop and recreate the table
        self.conn
            .execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;

        let col_defs: Vec<String> = col_names
            .iter()
            .zip(col_types.iter())
            .map(|(name, typ)| format!("\"{}\" {}", name, typ))
            .collect();

        let create_sql = if col_defs.is_empty() {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0)",
                table_name
            )
        } else {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Rebuild _meta_columns
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
        )?;
        for (i, (col_name, col_type)) in col_names.iter().zip(col_types.iter()).enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![dataset_id, i as i32, col_name, col_type],
            )?;
        }

        // Insert rows — each row includes _row_id as first element followed by column values
        for row_data in rows {
            if row_data.is_empty() {
                continue;
            }
            // First element is _row_id
            let row_id = match &row_data[0] {
                serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
                _ => 0,
            };

            // Build column list and values for non-null columns
            let mut insert_cols = vec!["\"_row_id\"".to_string()];
            let mut insert_vals = vec![row_id.to_string()];

            for (i, col_name) in col_names.iter().enumerate() {
                let val = row_data.get(i + 1).unwrap_or(&serde_json::Value::Null);
                if val.is_null() {
                    continue;
                }
                insert_cols.push(format!("\"{}\"", col_name));
                match val {
                    serde_json::Value::Bool(b) => insert_vals.push(b.to_string()),
                    serde_json::Value::Number(n) => insert_vals.push(n.to_string()),
                    serde_json::Value::String(s) => {
                        insert_vals.push(format!("'{}'", s.replace('\'', "''")));
                    }
                    _ => insert_vals.push(format!("'{}'", val.to_string().replace('\'', "''"))),
                }
            }

            let sql = format!(
                "INSERT INTO \"{}\" ({}) VALUES ({})",
                table_name,
                insert_cols.join(", "),
                insert_vals.join(", ")
            );
            self.conn.execute(&sql, [])?;
        }

        // Update metadata counts
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count = col_names.len() as i32;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────
    //  Table operations (JMP-style)
    // ───────────────────────────────────────────────────────────────

    /// Helper: create a new dataset from an arbitrary SELECT query.
    /// Adds `_row_id` via ROW_NUMBER(), registers metadata, returns DatasetMeta.
    fn create_table_from_query(
        &self,
        new_id: &str,
        new_name: &str,
        source_type: &str,
        select_sql: &str,
    ) -> Result<DatasetMeta, AppError> {
        self.validate_dataset_name(new_name, None)?;

        let table_name = format!("dataset_{}", new_id.replace('-', "_"));

        // Create table via CTAS wrapped with _row_id
        let ctas = format!(
            "CREATE TABLE \"{}\" AS SELECT ROW_NUMBER() OVER () AS \"_row_id\", __inner__.* FROM ({}) AS __inner__",
            table_name, select_sql
        );
        self.conn.execute(&ctas, [])?;

        // Collect column info (skip _row_id)
        let col_sql = format!(
            "SELECT column_name, data_type FROM information_schema.columns \
             WHERE table_name = '{}' AND column_name != '_row_id' \
             ORDER BY ordinal_position",
            table_name
        );
        let mut col_stmt = self.conn.prepare(&col_sql)?;
        let mut col_index = 0i32;
        let mut rows = col_stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(0)?;
            let col_type: String = row.get(1)?;
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) \
                 VALUES ($1, $2, $3, $4)",
                params![new_id, col_index, col_name, col_type],
            )?;
            col_index += 1;
        }

        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) \
             VALUES ($1, $2, NULL, $3, $4, $5)",
            params![new_id, new_name, source_type, row_count, col_index],
        )?;

        self.get_dataset_meta(new_id)
    }

    /// Sort: create sorted copy of a dataset
    pub fn sort_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        sort_cols: &[String],
        sort_orders: &[String],
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        // Get user columns (skip _row_id)
        let cols = self.get_user_columns(source_id)?;
        let select_cols = cols
            .iter()
            .map(|(n, _)| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ");

        let order_parts: Vec<String> = sort_cols
            .iter()
            .zip(sort_orders.iter())
            .map(|(col, ord)| {
                let dir = if ord.eq_ignore_ascii_case("desc") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!("\"{}\" {}", col, dir)
            })
            .collect();

        let sql = format!(
            "SELECT {} FROM \"{}\" ORDER BY {}",
            select_cols,
            src_table,
            order_parts.join(", ")
        );
        self.create_table_from_query(new_id, new_name, "sort", &sql)
    }

    /// Subset: create a subset from selected columns and optional row filter
    pub fn subset_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        columns: &[String],       // empty = all
        row_filter: Option<&str>, // SQL WHERE clause (e.g. "age > 18")
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        let user_cols = self.get_user_columns(source_id)?;

        let select_cols = if columns.is_empty() {
            user_cols
                .iter()
                .map(|(n, _)| format!("\"{}\"", n))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            columns
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let where_clause = match row_filter {
            Some(f) if !f.trim().is_empty() => format!(" WHERE {}", f),
            _ => String::new(),
        };

        let sql = format!(
            "SELECT {} FROM \"{}\"{}",
            select_cols, src_table, where_clause
        );
        self.create_table_from_query(new_id, new_name, "subset", &sql)
    }

    /// Transpose: swap rows and columns
    pub fn transpose_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
    ) -> Result<DatasetMeta, AppError> {
        self.validate_dataset_name(new_name, None)?;

        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        let user_cols = self.get_user_columns(source_id)?;
        if user_cols.is_empty() {
            return Err(AppError::InvalidParam("Source table has no columns".into()));
        }

        // Fetch all rows
        let select_cols = user_cols
            .iter()
            .map(|(n, _)| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT {} FROM \"{}\" ORDER BY \"_row_id\"",
            select_cols, src_table
        );
        let mut stmt = self.conn.prepare(&query)?;
        let mut rows_iter = stmt.query([])?;
        let mut all_rows: Vec<Vec<String>> = Vec::new();
        while let Some(row) = rows_iter.next()? {
            let mut r = Vec::new();
            for i in 0..user_cols.len() {
                let v: duckdb::types::Value = row.get(i)?;
                r.push(self.value_to_string(&v));
            }
            all_rows.push(r);
        }

        // Build transposed table:
        // First column = original column names ("Label")
        // Remaining columns = Row1, Row2, ...
        let n_new_cols = all_rows.len() + 1; // Label + each original row
        let mut new_col_names: Vec<String> = vec!["Label".to_string()];
        for i in 0..all_rows.len() {
            new_col_names.push(format!("Row{}", i + 1));
        }
        let new_col_types: Vec<String> = vec!["VARCHAR".to_string(); n_new_cols];

        let table_name = format!("dataset_{}", new_id.replace('-', "_"));
        let col_defs = new_col_names
            .iter()
            .zip(new_col_types.iter())
            .map(|(n, t)| format!("\"{}\" {}", n, t))
            .collect::<Vec<_>>()
            .join(", ");
        self.conn.execute(
            &format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name, col_defs
            ),
            [],
        )?;

        // Insert transposed rows
        for (ci, (col_name, _)) in user_cols.iter().enumerate() {
            let mut vals = vec![
                (ci as i64 + 1).to_string(),                   // _row_id
                format!("'{}'", col_name.replace('\'', "''")), // Label
            ];
            for row in &all_rows {
                let v = &row[ci];
                if v == "NULL" {
                    vals.push("NULL".to_string());
                } else {
                    vals.push(format!("'{}'", v.replace('\'', "''")));
                }
            }
            let insert = format!(
                "INSERT INTO \"{}\" (\"_row_id\", {}) VALUES ({})",
                table_name,
                new_col_names
                    .iter()
                    .map(|n| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", "),
                vals.join(", ")
            );
            self.conn.execute(&insert, [])?;
        }

        // Register metadata
        for (i, name) in new_col_names.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, 'VARCHAR')",
                params![new_id, i as i32, name],
            )?;
        }
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) \
             VALUES ($1, $2, NULL, 'transpose', $3, $4)",
            params![new_id, new_name, user_cols.len() as i64, n_new_cols as i32],
        )?;
        self.get_dataset_meta(new_id)
    }

    /// Stack: reshape wide to long (multiple columns → label + value)
    pub fn stack_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        stack_cols: &[String], // columns to stack (become values)
        id_cols: &[String],    // columns to keep as identifiers
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        let id_select = if id_cols.is_empty() {
            String::new()
        } else {
            id_cols
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ")
                + ", "
        };

        // UNION ALL for each stacked column
        // Let DuckDB resolve common type across the UNION ALL branches
        let unions: Vec<String> = stack_cols
            .iter()
            .map(|col| {
                format!(
                    "SELECT {}'{}' AS \"Label\", \"{}\" AS \"Value\" FROM \"{}\"",
                    id_select,
                    col.replace('\'', "''"),
                    col,
                    src_table,
                )
            })
            .collect();

        let sql = unions.join(" UNION ALL ");
        self.create_table_from_query(new_id, new_name, "stack", &sql)
    }

    /// Split: reshape long to wide (pivot label+value → multiple columns)
    pub fn split_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        split_col: &str,    // column containing new column names
        value_col: &str,    // column containing values
        id_cols: &[String], // grouping columns
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        // Get distinct values of split_col to become new column names
        let distinct_sql = format!(
            "SELECT DISTINCT CAST(\"{}\" AS VARCHAR) AS v FROM \"{}\" WHERE \"{}\" IS NOT NULL ORDER BY v",
            split_col, src_table, split_col
        );
        let mut stmt = self.conn.prepare(&distinct_sql)?;
        let mut rows = stmt.query([])?;
        let mut pivot_vals: Vec<String> = Vec::new();
        while let Some(row) = rows.next()? {
            let v: String = row.get(0)?;
            pivot_vals.push(v);
        }
        if pivot_vals.is_empty() {
            return Err(AppError::InvalidParam(
                "Split column has no non-null values".into(),
            ));
        }

        let id_group = if id_cols.is_empty() {
            // Use all columns except split and value as id
            let user_cols = self.get_user_columns(source_id)?;
            user_cols
                .iter()
                .filter(|(n, _)| n != split_col && n != value_col)
                .map(|(n, _)| n.clone())
                .collect::<Vec<_>>()
        } else {
            id_cols.to_vec()
        };

        let id_select = id_group
            .iter()
            .map(|c| format!("\"{}\"", c))
            .collect::<Vec<_>>()
            .join(", ");
        let pivot_cols: Vec<String> = pivot_vals
            .iter()
            .map(|v| {
                format!(
                    "MAX(CASE WHEN CAST(\"{}\" AS VARCHAR) = '{}' THEN \"{}\" END) AS \"{}\"",
                    split_col,
                    v.replace('\'', "''"),
                    value_col,
                    v.replace('"', "\"\"")
                )
            })
            .collect();

        // Add a within-group row number so that duplicate (id_group, split_col) rows
        // are preserved as separate output rows instead of being collapsed by MAX.
        let partition_cols = if id_group.is_empty() {
            format!("\"{}\"", split_col)
        } else {
            format!("{}, \"{}\"", id_select, split_col)
        };
        let cte = format!(
            "SELECT *, ROW_NUMBER() OVER (PARTITION BY {} ORDER BY \"_row_id\") AS _split_rn FROM \"{}\"",
            partition_cols, src_table
        );

        let sql = if id_group.is_empty() {
            format!(
                "SELECT {} FROM ({}) AS _src GROUP BY _split_rn ORDER BY _split_rn",
                pivot_cols.join(", "),
                cte
            )
        } else {
            format!(
                "SELECT {}, {} FROM ({}) AS _src GROUP BY {}, _split_rn ORDER BY {}, _split_rn",
                id_select,
                pivot_cols.join(", "),
                cte,
                id_select,
                id_select
            )
        };

        self.create_table_from_query(new_id, new_name, "split", &sql)
    }

    /// Summary: compute descriptive statistics grouped by optional columns
    pub fn summary_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        stat_cols: &[String],  // columns to summarize
        group_cols: &[String], // group-by columns (can be empty)
        statistics: &[String], // which stats: "n", "mean", "std", "min", "max", "sum", "median"
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        let mut select_parts: Vec<String> = Vec::new();

        // Group-by columns first
        for gc in group_cols {
            select_parts.push(format!("\"{}\"", gc));
        }

        // Stats for each stat_col
        for sc in stat_cols {
            for stat in statistics {
                let expr = match stat.as_str() {
                    "n" => format!("COUNT(\"{}\") AS \"{}_N\"", sc, sc),
                    "mean" => format!("AVG(CAST(\"{}\" AS DOUBLE)) AS \"{}_Mean\"", sc, sc),
                    "std" => format!("STDDEV(CAST(\"{}\" AS DOUBLE)) AS \"{}_Std\"", sc, sc),
                    "min" => format!("MIN(\"{}\") AS \"{}_Min\"", sc, sc),
                    "max" => format!("MAX(\"{}\") AS \"{}_Max\"", sc, sc),
                    "sum" => format!("SUM(CAST(\"{}\" AS DOUBLE)) AS \"{}_Sum\"", sc, sc),
                    "median" => format!("MEDIAN(CAST(\"{}\" AS DOUBLE)) AS \"{}_Median\"", sc, sc),
                    _ => continue,
                };
                select_parts.push(expr);
            }
        }

        if select_parts.is_empty() {
            return Err(AppError::InvalidParam("No statistics specified".into()));
        }

        let group_clause = if group_cols.is_empty() {
            String::new()
        } else {
            format!(
                " GROUP BY {}",
                group_cols
                    .iter()
                    .map(|c| format!("\"{}\"", c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let sql = format!(
            "SELECT {} FROM \"{}\"{}",
            select_parts.join(", "),
            src_table,
            group_clause
        );
        self.create_table_from_query(new_id, new_name, "summary", &sql)
    }

    /// Join: join two tables
    pub fn join_tables(
        &self,
        new_id: &str,
        new_name: &str,
        left_id: &str,
        right_id: &str,
        join_type: &str, // "inner", "left", "right", "full"
        left_key: &str,
        right_key: &str,
    ) -> Result<DatasetMeta, AppError> {
        let left_table = format!("dataset_{}", left_id.replace('-', "_"));
        let right_table = format!("dataset_{}", right_id.replace('-', "_"));
        let left_cols = self.get_user_columns(left_id)?;
        let right_cols = self.get_user_columns(right_id)?;

        let join_kw = match join_type.to_lowercase().as_str() {
            "left" => "LEFT JOIN",
            "right" => "RIGHT JOIN",
            "full" => "FULL OUTER JOIN",
            _ => "INNER JOIN",
        };

        // Build select: all left cols as-is, right cols with _r suffix for conflicts
        let mut select_parts: Vec<String> = Vec::new();
        let left_names: std::collections::HashSet<&str> =
            left_cols.iter().map(|(n, _)| n.as_str()).collect();

        for (n, _) in &left_cols {
            select_parts.push(format!("L.\"{}\"", n));
        }
        for (n, _) in &right_cols {
            if left_names.contains(n.as_str()) {
                select_parts.push(format!("R.\"{}\" AS \"{}_r\"", n, n));
            } else {
                select_parts.push(format!("R.\"{}\"", n));
            }
        }

        let sql = format!(
            "SELECT {} FROM \"{}\" AS L {} \"{}\" AS R ON L.\"{}\" = R.\"{}\"",
            select_parts.join(", "),
            left_table,
            join_kw,
            right_table,
            left_key,
            right_key
        );
        self.create_table_from_query(new_id, new_name, "join", &sql)
    }

    /// Update: update left table using values from right table
    pub fn update_table(
        &self,
        left_id: &str,
        right_id: &str,
        match_col: &str,
        update_cols: &[String], // columns to update from right into left
    ) -> Result<(), AppError> {
        self.with_row_mutation(left_id, || {
            let left_table = format!("dataset_{}", left_id.replace('-', "_"));
            let right_table = format!("dataset_{}", right_id.replace('-', "_"));

            for col in update_cols {
                let sql = format!(
                    "UPDATE \"{}\" SET \"{}\" = R.\"{}\" FROM \"{}\" AS R \
                     WHERE \"{}\".\"{}\" = R.\"{}\"",
                    left_table, col, col, right_table, left_table, match_col, match_col
                );
                self.conn.execute(&sql, [])?;
            }

            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", left_table),
                [],
                |row| row.get(0),
            )?;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, left_id],
            )?;
            Ok(())
        })
    }

    /// Concatenate: vertically stack multiple tables
    pub fn concatenate_tables(
        &self,
        new_id: &str,
        new_name: &str,
        source_ids: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if source_ids.is_empty() {
            return Err(AppError::InvalidParam("No source tables specified".into()));
        }

        // Collect union of all column names (in order of first appearance)
        let mut all_cols: Vec<(String, String)> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for sid in source_ids {
            let cols = self.get_user_columns(sid)?;
            for (name, typ) in cols {
                if seen.insert(name.clone()) {
                    all_cols.push((name, typ));
                }
            }
        }

        // Build UNION ALL: for each source, SELECT known cols or NULL for missing
        let unions: Vec<String> = source_ids
            .iter()
            .map(|sid| {
                let src_table = format!("dataset_{}", sid.replace('-', "_"));
                let src_cols: std::collections::HashSet<String> = self
                    .get_user_columns(sid)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(n, _)| n)
                    .collect();
                let selects: Vec<String> = all_cols
                    .iter()
                    .map(|(name, _)| {
                        if src_cols.contains(name) {
                            format!("\"{}\"", name)
                        } else {
                            format!("NULL AS \"{}\"", name)
                        }
                    })
                    .collect();
                format!("SELECT {} FROM \"{}\"", selects.join(", "), src_table)
            })
            .collect();

        let sql = unions.join(" UNION ALL ");
        self.create_table_from_query(new_id, new_name, "concatenate", &sql)
    }

    /// Helper: get user columns (excluding _row_id) for a dataset (public for service layer)
    pub fn get_user_columns(&self, dataset_id: &str) -> Result<Vec<(String, String)>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let cols = stmt
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(cols)
    }

    pub(crate) fn prepare_archive_keyset_read(
        &self,
        dataset_id: &str,
    ) -> Result<ArchiveKeysetReadPlan, AppError> {
        self.get_dataset_meta(dataset_id)?;
        let columns = self.get_user_columns(dataset_id)?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        let select_projection = if columns.is_empty() {
            String::new()
        } else {
            format!(
                ", {}",
                columns
                    .iter()
                    .map(|(name, column_type)| archive_export_expression(name, column_type))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let select_sql = format!(
            "SELECT \"_row_id\"{select_projection} FROM {table_name} WHERE \"_row_id\" > ? ORDER BY \"_row_id\" ASC LIMIT ?"
        );

        Ok(ArchiveKeysetReadPlan {
            select_sql,
            columns,
        })
    }

    pub(crate) fn read_archive_keyset_batch(
        &self,
        plan: &ArchiveKeysetReadPlan,
        after_row_id: i64,
        row_limit: usize,
        target_batch_bytes: usize,
        hard_batch_bytes: usize,
    ) -> Result<ArchiveBatch, AppError> {
        if row_limit == 0 {
            return Err(AppError::InvalidParam("row limit must be positive".into()));
        }

        let mut stmt = self.conn.prepare_cached(&plan.select_sql)?;
        let mut query_rows = stmt.query(params![after_row_id, row_limit as i64])?;

        let mut rows = Vec::new();
        let mut releasable_bytes_estimate = 0usize;

        while let Some(row) = query_rows.next()? {
            let row_id: i64 = row.get(0)?;
            let mut values = Vec::with_capacity(plan.columns.len());
            let mut row_bytes = estimate_retained_row_header_bytes(plan.columns.len());
            row_bytes = row_bytes.saturating_add(mem::size_of::<i64>());

            for index in 0..plan.columns.len() {
                let value: Value = row.get(index + 1)?;
                row_bytes = row_bytes.saturating_add(estimate_retained_value_bytes(&value));
                if row_bytes > hard_batch_bytes {
                    return Err(AppError::InvalidParam(format!(
                        "single archive row exceeds hard batch cap: {row_bytes} > {hard_batch_bytes}"
                    )));
                }
                values.push(value);
            }
            let _ = row_id;

            let row_releasable_bytes =
                row_bytes.saturating_sub(mem::size_of::<ArchiveBatchRow>());
            rows.reserve(1);
            let projected_retained_bytes = rows
                .capacity()
                .saturating_mul(mem::size_of::<ArchiveBatchRow>())
                .saturating_add(releasable_bytes_estimate)
                .saturating_add(row_releasable_bytes);
            if projected_retained_bytes > hard_batch_bytes {
                if rows.is_empty() {
                    return Err(AppError::InvalidParam(format!(
                        "single archive row exceeds retained batch cap: {projected_retained_bytes} > {hard_batch_bytes}"
                    )));
                }
                break;
            }

            releasable_bytes_estimate =
                releasable_bytes_estimate.saturating_add(row_releasable_bytes);
            rows.push(ArchiveBatchRow {
                row_id,
                values,
                retained_bytes_estimate: row_releasable_bytes,
            });

            if projected_retained_bytes >= target_batch_bytes {
                break;
            }
        }

        let retained_bytes_estimate = rows
            .capacity()
            .saturating_mul(mem::size_of::<ArchiveBatchRow>())
            .saturating_add(releasable_bytes_estimate);
        Ok(ArchiveBatch {
            rows,
            retained_bytes_estimate,
        })
    }

    /// Helper: convert DuckDB value to string for transpose
    fn value_to_string(&self, v: &duckdb::types::Value) -> String {
        match v {
            duckdb::types::Value::Null => "NULL".to_string(),
            duckdb::types::Value::Boolean(b) => b.to_string(),
            duckdb::types::Value::TinyInt(n) => n.to_string(),
            duckdb::types::Value::SmallInt(n) => n.to_string(),
            duckdb::types::Value::Int(n) => n.to_string(),
            duckdb::types::Value::BigInt(n) => n.to_string(),
            duckdb::types::Value::Float(f) => f.to_string(),
            duckdb::types::Value::Double(f) => f.to_string(),
            duckdb::types::Value::Text(s) => s.clone(),
            _ => format!("{:?}", v),
        }
    }
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn estimate_retained_row_header_bytes(column_count: usize) -> usize {
    let mut bytes = mem::size_of::<ArchiveBatchRow>();
    bytes = bytes.saturating_add(mem::size_of::<Vec<Value>>());
    bytes = bytes.saturating_add(column_count.saturating_mul(mem::size_of::<Value>()));
    bytes
}

fn estimate_retained_value_bytes(value: &Value) -> usize {
    let base = mem::size_of::<Value>();
    match value {
        Value::Null => base,
        Value::Boolean(_) => base.saturating_add(mem::size_of::<bool>()),
        Value::TinyInt(_) => base.saturating_add(mem::size_of::<i8>()),
        Value::SmallInt(_) => base.saturating_add(mem::size_of::<i16>()),
        Value::Int(_) => base.saturating_add(mem::size_of::<i32>()),
        Value::BigInt(_) => base.saturating_add(mem::size_of::<i64>()),
        Value::HugeInt(_) => base.saturating_add(mem::size_of::<i128>()),
        Value::UTinyInt(_) => base.saturating_add(mem::size_of::<u8>()),
        Value::USmallInt(_) => base.saturating_add(mem::size_of::<u16>()),
        Value::UInt(_) => base.saturating_add(mem::size_of::<u32>()),
        Value::UBigInt(_) => base.saturating_add(mem::size_of::<u64>()),
        Value::UHugeInt(_) => base.saturating_add(mem::size_of::<u128>()),
        Value::Float(_) => base.saturating_add(mem::size_of::<f32>()),
        Value::Double(_) => base.saturating_add(mem::size_of::<f64>()),
        Value::Decimal(_) => base.saturating_add(mem::size_of::<i128>()),
        Value::Timestamp(_, _) => base.saturating_add(mem::size_of::<i64>()),
        Value::Date32(_) => base.saturating_add(mem::size_of::<i32>()),
        Value::Time64(_, _) => base.saturating_add(mem::size_of::<i64>()),
        Value::Interval { .. } => base.saturating_add(mem::size_of::<i64>() * 3),
        Value::Text(text) | Value::Enum(text) => {
            base.saturating_add(mem::size_of::<String>())
                .saturating_add(text.capacity())
        }
        Value::Blob(bytes) | Value::Geometry(bytes) => {
            base.saturating_add(mem::size_of::<Vec<u8>>())
                .saturating_add(bytes.capacity())
        }
        Value::List(items) | Value::Array(items) => {
            let mut total = base
                .saturating_add(mem::size_of::<Vec<Value>>())
                .saturating_add(items.capacity().saturating_mul(mem::size_of::<Value>()));
            for item in items {
                total = total.saturating_add(estimate_retained_value_bytes(item));
            }
            total
        }
        Value::Struct(entries) => {
            let mut total = base.saturating_add(mem::size_of::<OrderedMap<String, Value>>());
            for (key, entry_value) in entries.iter() {
                total = total
                    .saturating_add(mem::size_of::<String>())
                    .saturating_add(key.capacity())
                    .saturating_add(estimate_retained_value_bytes(entry_value));
            }
            total
        }
        Value::Map(entries) => {
            let mut total = base.saturating_add(mem::size_of::<OrderedMap<Value, Value>>());
            for (key, entry_value) in entries.iter() {
                total = total
                    .saturating_add(estimate_retained_value_bytes(key))
                    .saturating_add(estimate_retained_value_bytes(entry_value));
            }
            total
        }
        Value::Union(inner) => base.saturating_add(estimate_retained_value_bytes(inner)),
        _ => base,
    }
}

struct PercentageTransformContext<'a> {
    row_count: usize,
    column_count: usize,
    cells: &'a mut [Option<f64>],
    row_totals: &'a mut [Option<f64>],
    column_totals: &'a mut [Option<f64>],
    grand_totals: &'a mut [Option<f64>],
    raw_row_totals: &'a [Option<f64>],
    raw_column_totals: &'a [Option<f64>],
    raw_grand_totals: &'a [Option<f64>],
}

fn aggregate_sql(statistic: &TabulateStatistic) -> Result<String, AppError> {
    let field = quote_identifier(&statistic.field);
    let expression = match statistic.kind {
        StatisticKind::Count => format!("CAST(COUNT({field}) AS DOUBLE)"),
        StatisticKind::MissingCount => {
            format!("CAST(COUNT(*) - COUNT({field}) AS DOUBLE)")
        }
        StatisticKind::UniqueCount => format!("CAST(COUNT(DISTINCT {field}) AS DOUBLE)"),
        StatisticKind::Sum => format!("CAST(SUM({field}) AS DOUBLE)"),
        StatisticKind::Mean => format!("CAST(AVG({field}) AS DOUBLE)"),
        StatisticKind::StandardDeviation => format!("CAST(STDDEV_SAMP({field}) AS DOUBLE)"),
        StatisticKind::Variance => format!("CAST(VAR_SAMP({field}) AS DOUBLE)"),
        StatisticKind::Minimum => format!("CAST(MIN({field}) AS DOUBLE)"),
        StatisticKind::Maximum => format!("CAST(MAX({field}) AS DOUBLE)"),
        StatisticKind::Median => format!("CAST(MEDIAN({field}) AS DOUBLE)"),
        StatisticKind::Range => format!("CAST(MAX({field}) - MIN({field}) AS DOUBLE)"),
        StatisticKind::Quantile => {
            let probability = statistic.quantile.ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "Quantile statistic '{}' requires quantile",
                    statistic.id
                ))
            })?;
            format!("CAST(QUANTILE_CONT({field}, {}) AS DOUBLE)", probability)
        }
        StatisticKind::RowPercentage
        | StatisticKind::ColumnPercentage
        | StatisticKind::TotalPercentage => format!("CAST(COUNT({field}) AS DOUBLE)"),
    };
    Ok(expression)
}

fn grouped_cardinality(
    conn: &Connection,
    table_name: &str,
    dimensions: &[String],
) -> Result<u64, AppError> {
    if dimensions.is_empty() {
        return Ok(1);
    }

    let table_ident = quote_identifier(table_name);
    let group_dimensions = dimensions
        .iter()
        .map(|field| quote_identifier(field))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM {table_ident} GROUP BY {group_dimensions}) AS \"__groups\""
    );
    let count: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    u64::try_from(count).map_err(|_| AppError::InvalidParam("Tabulate result size overflow".into()))
}

fn json_dimension_value(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(inner) => serde_json::Value::Bool(inner),
        Value::TinyInt(inner) => serde_json::json!(inner),
        Value::SmallInt(inner) => serde_json::json!(inner),
        Value::Int(inner) => serde_json::json!(inner),
        Value::BigInt(inner) => serde_json::json!(inner),
        Value::Float(inner) => serde_json::json!(inner),
        Value::Double(inner) => serde_json::json!(inner),
        Value::Text(inner) => serde_json::json!(inner),
        other => serde_json::json!(format!("{:?}", other)),
    }
}

fn numeric_cell_value(value: Value) -> Result<Option<f64>, AppError> {
    match value {
        Value::Null => Ok(None),
        Value::TinyInt(inner) => Ok(Some(inner as f64)),
        Value::SmallInt(inner) => Ok(Some(inner as f64)),
        Value::Int(inner) => Ok(Some(inner as f64)),
        Value::BigInt(inner) => Ok(Some(inner as f64)),
        Value::Float(inner) => Ok(Some(inner as f64)),
        Value::Double(inner) => Ok(Some(inner)),
        other => Err(AppError::Database(format!(
            "Unexpected non-numeric aggregate value: {:?}",
            other
        ))),
    }
}

fn member_key(members: &[serde_json::Value]) -> Result<String, AppError> {
    serde_json::to_string(members).map_err(|error| AppError::InvalidParam(error.to_string()))
}

fn build_nulls_last_order(dimensions: &[String]) -> String {
    dimensions
        .iter()
        .flat_map(|field| {
            let ident = quote_identifier(field);
            [format!("{ident} IS NULL"), ident]
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn validate_unique_fields(role: &str, fields: &[String]) -> Result<(), AppError> {
    let mut seen = std::collections::HashSet::new();
    for field in fields {
        if !seen.insert(field) {
            return Err(AppError::InvalidParam(format!(
                "duplicate {role} field: {field}",
            )));
        }
    }
    Ok(())
}

fn requires_numeric_field(kind: &StatisticKind) -> bool {
    matches!(
        kind,
        StatisticKind::Sum
            | StatisticKind::Mean
            | StatisticKind::StandardDeviation
            | StatisticKind::Variance
            | StatisticKind::Minimum
            | StatisticKind::Maximum
            | StatisticKind::Median
            | StatisticKind::Range
            | StatisticKind::Quantile
    )
}

fn is_numeric_type(data_type: &str) -> bool {
    matches!(
        base_data_type(data_type),
        "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "BIGINT"
            | "UTINYINT"
            | "USMALLINT"
            | "UINTEGER"
            | "UBIGINT"
            | "HUGEINT"
            | "UHUGEINT"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "DECIMAL"
            | "NUMERIC"
    )
}

fn base_data_type(data_type: &str) -> &str {
    let trimmed = data_type.trim();
    trimmed.split_once('(').map_or(trimmed, |(base, _)| base)
}

fn dimension_select_expression(
    field: &str,
    column_types: &std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    let data_type = column_types
        .get(field)
        .ok_or_else(|| AppError::InvalidParam(format!("Unknown field: {field}")))?;
    let identifier = quote_identifier(field);
    let expression = match base_data_type(data_type) {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "UTINYINT" | "USMALLINT"
        | "UINTEGER" | "UBIGINT" | "FLOAT" | "REAL" | "DOUBLE" | "VARCHAR" => identifier,
        _ => format!("CAST({identifier} AS VARCHAR)"),
    };
    Ok(expression)
}

fn default_missing_value(kind: &StatisticKind) -> Option<f64> {
    if matches!(
        kind,
        StatisticKind::Count
            | StatisticKind::MissingCount
            | StatisticKind::UniqueCount
            | StatisticKind::RowPercentage
            | StatisticKind::ColumnPercentage
            | StatisticKind::TotalPercentage
    ) {
        Some(0.0)
    } else {
        None
    }
}

fn divide_or_null(numerator: Option<f64>, denominator: Option<f64>) -> Option<f64> {
    match (numerator, denominator) {
        (Some(value), Some(total)) if total != 0.0 => Some(value / total),
        _ => None,
    }
}

fn flattened_total_value(
    values: &[Option<f64>],
    outer_index: usize,
    statistic_index: usize,
    statistic_count: usize,
) -> Option<f64> {
    values
        .get(outer_index * statistic_count + statistic_index)
        .copied()
        .flatten()
}

fn transform_percentage_values(
    statistics: &[TabulateStatistic],
    context: &mut PercentageTransformContext<'_>,
) {
    let statistic_count = statistics.len();

    for (statistic_index, statistic) in statistics.iter().enumerate() {
        let raw_grand_total = context
            .raw_grand_totals
            .get(statistic_index)
            .copied()
            .flatten();
        match statistic.kind {
            StatisticKind::RowPercentage => {
                for row_index in 0..context.row_count {
                    let denominator = flattened_total_value(
                        context.raw_row_totals,
                        row_index,
                        statistic_index,
                        statistic_count,
                    );
                    for column_index in 0..context.column_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], denominator);
                    }

                    if !context.row_totals.is_empty() {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            denominator,
                        );
                    }
                }

                if !context.column_totals.is_empty() {
                    for column_index in 0..context.column_count {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            StatisticKind::ColumnPercentage => {
                for column_index in 0..context.column_count {
                    let denominator = flattened_total_value(
                        context.raw_column_totals,
                        column_index,
                        statistic_index,
                        statistic_count,
                    );
                    for row_index in 0..context.row_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], denominator);
                    }

                    if !context.column_totals.is_empty() {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            denominator,
                        );
                    }
                }

                if !context.row_totals.is_empty() {
                    for row_index in 0..context.row_count {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            StatisticKind::TotalPercentage => {
                for row_index in 0..context.row_count {
                    for column_index in 0..context.column_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], raw_grand_total);
                    }

                    if !context.row_totals.is_empty() {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.column_totals.is_empty() {
                    for column_index in 0..context.column_count {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            _ => {}
        }
    }
}

// ---- Free helpers for archive path / SQLite table name sanitization -------

/// Sanitize a path destined for a ZIP archive. Each path segment is cleaned
/// of characters that are illegal on Windows so the zip can be extracted
/// anywhere; the `/` separator between segments is preserved so folder
/// structure survives. Empty segments and leading/trailing whitespace are
/// trimmed per segment.
fn sanitize_archive_path(raw: &str) -> String {
    let parts: Vec<String> = raw
        .split('/')
        .map(|seg| {
            seg.replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                .trim()
                .trim_matches('.')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        "Untitled".to_string()
    } else {
        parts.join("/")
    }
}

/// Suffix `base.ext` with ` (2)`, ` (3)`, … until the result is unique within
/// `used`, then insert into `used` and return the chosen archive path.
fn dedupe_archive_path(
    base: &str,
    ext: &str,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let mut candidate = format!("{}.{}", base, ext);
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({}).{}", base, n, ext);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

/// Suffix a SQLite destination table name with ` (2)`, ` (3)`, … until the
/// result is unique within `used`. SQLite table names allow most characters
/// inside quoted identifiers, so we only enforce uniqueness — no character
/// sanitization is applied (the UI passes `folder-tablename` style names
/// that the user explicitly chose).
fn dedupe_sqlite_table_name(base: &str, used: &mut std::collections::HashSet<String>) -> String {
    let safe_base = if base.trim().is_empty() {
        "Untitled"
    } else {
        base
    };
    let mut candidate = safe_base.to_string();
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({})", safe_base, n);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::graph_data::{
        GraphDataRequest, GraphElementRequest, GraphFieldBinding, GraphSampling, GraphViewport,
    };
    use crate::services::archive_cell::{
        archive_cell_to_json_call_count, reset_archive_cell_to_json_call_count,
    };
    use crate::models::table::{
        CreateTableFromRowsRequest, TableWindowFilter, TableWindowFilterRule, TableWindowRequest,
        TableWindowSort,
    };
    use duckdb::types::Decimal;

    #[test]
    fn benchmark_fixture_creates_requested_shape() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        db.seed_benchmark_table("benchmark-id", "Benchmark", 10_000, 20)
            .unwrap();

        let meta = db.get_dataset_meta("benchmark-id").unwrap();
        assert_eq!(meta.row_count, 10_000);
        assert_eq!(meta.col_count, 20);

        let page = db.query_table("benchmark-id", 0, 500, None, None).unwrap();
        assert_eq!(page.total_rows, 10_000);
        assert_eq!(page.rows.len(), 500);
        assert_eq!(page.columns.len(), 21);
    }

    fn benchmark_window_request(start: usize, count: usize) -> TableWindowRequest {
        TableWindowRequest {
            dataset_id: "benchmark-id".into(),
            start,
            count,
            sort: None,
            filters: Vec::new(),
            generation: 0,
        }
    }

    #[test]
    fn sample_projection_stratifies_by_all_active_categorical_roles() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "graph-strata-id",
            "Graph Strata",
            &[
                "region".into(),
                "batch".into(),
                "family".into(),
                "cost".into(),
                "m1".into(),
                "m2".into(),
            ],
            &[
                "VARCHAR".into(),
                "VARCHAR".into(),
                "VARCHAR".into(),
                "DOUBLE".into(),
                "DOUBLE".into(),
                "DOUBLE".into(),
            ],
        )
        .unwrap();

        let allowed_columns = db
            .get_user_columns("graph-strata-id")
            .unwrap()
            .into_iter()
            .map(|(name, column_type)| (name, column_type))
            .collect::<std::collections::HashMap<_, _>>();
        let allowed = allowed_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let request = GraphDataRequest {
            request_id: "req-strata".into(),
            dataset_id: "graph-strata-id".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".into(),
                    column: "region".into(),
                },
                GraphFieldBinding {
                    role: "y".into(),
                    column: "cost".into(),
                },
                GraphFieldBinding {
                    role: "group".into(),
                    column: "family".into(),
                },
                GraphFieldBinding {
                    role: "filter".into(),
                    column: "batch".into(),
                },
                GraphFieldBinding {
                    role: "multiX0".into(),
                    column: "batch".into(),
                },
                GraphFieldBinding {
                    role: "multiY0".into(),
                    column: "m1".into(),
                },
                GraphFieldBinding {
                    role: "multiY1".into(),
                    column: "m2".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "points".into(),
                summary_stat: "none".into(),
            }],
            sampling: GraphSampling::Sample { size: 32, seed: 7 },
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1280,
                height: 720,
            },
        };

        let plan = db.compile_graph_query_plan(&request, &allowed).unwrap();
        assert!(
            plan.source_sql.contains("__sp_strata_0")
                && plan.source_sql.contains("__sp_strata_1")
                && plan.source_sql.contains("__sp_strata_2"),
            "source projection must carry categorical/facet strata aliases"
        );
        assert!(
            plan.projection_sql.contains(
                "PARTITION BY CONCAT_WS('|', COALESCE(CAST(__sp_strata_0 AS VARCHAR), ''),"
            ) && plan
                .projection_sql
                .contains("COALESCE(CAST(__sp_strata_1 AS VARCHAR), '')")
                && plan
                    .projection_sql
                    .contains("COALESCE(CAST(__sp_strata_2 AS VARCHAR), '')"),
            "sample partition key must include all active categorical role aliases"
        );
    }

    #[test]
    fn graph_projection_select_is_bounded_and_preserves_exact_rows() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "graph-projection-bounded",
            "Graph Projection Bounded",
            &["region".into(), "cost".into(), "extra".into()],
            &["VARCHAR".into(), "DOUBLE".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_graph_projection_bounded\" (_row_id, region, cost, extra)
                 VALUES (1, 'North', 10.0, 100.0),
                        (2, 'South', 20.0, 200.0),
                        (3, 'East', 30.0, 300.0),
                        (4, 'West', 40.0, 400.0)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![4i64, "graph-projection-bounded"],
            )
            .unwrap();

        let allowed_columns = db
            .get_user_columns("graph-projection-bounded")
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let allowed = allowed_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let request = GraphDataRequest {
            request_id: "req-bounded-shape".into(),
            dataset_id: "graph-projection-bounded".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".into(),
                    column: "region".into(),
                },
                GraphFieldBinding {
                    role: "y".into(),
                    column: "cost".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "points".into(),
                summary_stat: "none".into(),
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1280,
                height: 720,
            },
        };

        let plan = db.compile_graph_query_plan(&request, &allowed).unwrap();
        let select_sql = db.build_graph_projection_select_sql(&plan, true);
        let mut stmt = db.conn().prepare(&select_sql).unwrap();

        let mut rows = stmt
            .query(params_from_iter(plan.projection_values.iter()))
            .unwrap();
        let mut seen = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            assert!(row.get::<_, String>(3).is_err());
            seen.push((
                row.get::<_, i64>(0).unwrap(),
                row.get::<_, String>(1).unwrap(),
                row.get::<_, f64>(2).unwrap(),
            ));
        }

        assert_eq!(seen.len(), 4);
        assert_eq!(seen[0], (1, "North".to_string(), 10.0));
        assert_eq!(seen[3], (4, "West".to_string(), 40.0));
    }

    #[test]
    fn imported_csv_supports_bounded_windows_with_stable_row_ids() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        let file_path = std::env::temp_dir().join(format!(
            "stats_playground_import_{}.csv",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&file_path, "name,amount\nalpha,10\nbeta,20\n").unwrap();

        let meta = db
            .import_csv("csv-window-id", "CSV Window", file_path.to_str().unwrap())
            .unwrap();
        let result = db.query_table_window(&TableWindowRequest {
            dataset_id: "csv-window-id".into(),
            start: 0,
            count: 10,
            sort: None,
            filters: Vec::new(),
            generation: 0,
        });
        let _ = std::fs::remove_file(file_path);
        let result = result.unwrap();

        assert_eq!(meta.row_count, 2);
        assert_eq!(meta.col_count, 2);
        assert_eq!(result.columns, vec!["_row_id", "name", "amount"]);
        assert_eq!(
            result.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!("alpha"),
                serde_json::json!(10)
            ]
        );
        assert_eq!(
            result.rows[1],
            vec![
                serde_json::json!(2),
                serde_json::json!("beta"),
                serde_json::json!(20)
            ]
        );
    }

    #[test]
    fn query_table_window_returns_only_requested_rows() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10_000, 20)
            .unwrap();

        let result = db
            .query_table_window(&benchmark_window_request(3_000, 500))
            .unwrap();

        assert_eq!(result.start, 3_000);
        assert_eq!(result.total_rows, 10_000);
        assert_eq!(result.rows.len(), 500);
        assert_eq!(result.rows[0][0], serde_json::json!(3_001));
        assert_eq!(result.generation, 0);

        let final_window = db
            .query_table_window(&benchmark_window_request(9_750, 500))
            .unwrap();
        assert_eq!(final_window.rows.len(), 250);
        assert_eq!(final_window.rows[249][0], serde_json::json!(10_000));
    }

    #[test]
    fn query_table_window_temporal_values_round_trip_through_update_cells() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "temporal-id",
            "Temporal",
            &["event_date".into(), "event_time".into()],
            &["DATE".into(), "TIMESTAMP".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_temporal_id VALUES
                    (1, DATE '2026-08-19', TIMESTAMP '2026-08-19 14:15:16.123456');
                 UPDATE _meta_datasets SET row_count = 1 WHERE id = 'temporal-id';",
            )
            .unwrap();

        let request = TableWindowRequest {
            dataset_id: "temporal-id".into(),
            start: 0,
            count: 1,
            sort: None,
            filters: Vec::new(),
            generation: 0,
        };
        let window = db.query_table_window(&request).unwrap();
        assert_eq!(window.rows[0][1], serde_json::json!("2026-08-19"));
        assert_eq!(
            window.rows[0][2],
            serde_json::json!("2026-08-19 14:15:16.123456")
        );

        db.update_cells(
            "temporal-id",
            &[
                CellUpdate {
                    row_id: 1,
                    column_name: "event_date".into(),
                    value: Some(window.rows[0][1].as_str().unwrap().into()),
                },
                CellUpdate {
                    row_id: 1,
                    column_name: "event_time".into(),
                    value: Some(window.rows[0][2].as_str().unwrap().into()),
                },
            ],
        )
        .unwrap();
    }

    #[test]
    fn query_table_window_rejects_invalid_count_and_stale_generation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();

        for count in [0, 2_001] {
            let error = db
                .query_table_window(&benchmark_window_request(0, count))
                .unwrap_err();
            assert!(matches!(error, AppError::InvalidParam(_)));
        }

        db.conn()
            .execute(
                "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                params!["benchmark-id"],
            )
            .unwrap();
        let error = db
            .query_table_window(&benchmark_window_request(0, 5))
            .unwrap_err();
        assert!(matches!(error, AppError::InvalidParam(_)));

        let wrong_kind = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Date {
                        field: "value_1".into(),
                        start: Some("2026-01-01".into()),
                        end: None,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap_err();
        assert!(matches!(wrong_kind, AppError::InvalidParam(_)));
    }

    #[test]
    fn dataset_generation_can_be_read_before_requesting_a_window() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();
        assert_eq!(db.get_dataset_generation("benchmark-id").unwrap(), 0);

        db.update_cell("benchmark-id", 1, "value_1", "99").unwrap();
        assert_eq!(db.get_dataset_generation("benchmark-id").unwrap(), 1);
        assert!(matches!(
            db.get_dataset_generation("missing").unwrap_err(),
            AppError::InvalidParam(_)
        ));
    }

    #[test]
    fn query_table_window_sorts_deterministically_and_filters_categories() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "benchmark-id",
            "Benchmark",
            &["category".into(), "amount".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_benchmark_id VALUES
                    (3, 'B', 10), (1, 'A', 10), (2, 'A', 10), (4, NULL, 20);
                 UPDATE _meta_datasets SET row_count = 4 WHERE id = 'benchmark-id';",
            )
            .unwrap();

        let result = db
            .query_table_window(&TableWindowRequest {
                dataset_id: "benchmark-id".into(),
                start: 0,
                count: 10,
                sort: Some(TableWindowSort {
                    column: "amount".into(),
                    descending: false,
                }),
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".into(),
                        selected: vec!["A".into(), "B".into()],
                        exclude: false,
                    },
                }],
                generation: 0,
            })
            .unwrap();

        let row_ids = result
            .rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(row_ids, vec![1, 2, 3]);

        let empty = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".into(),
                        selected: Vec::new(),
                        exclude: false,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap();
        assert_eq!(empty.total_rows, 0);
        assert!(empty.rows.is_empty());

        let null_category = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".into(),
                        selected: vec![String::new()],
                        exclude: false,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap();
        assert_eq!(null_category.total_rows, 1);
        assert_eq!(null_category.rows[0][0], serde_json::json!(4));

        let exclude_none = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".into(),
                        selected: Vec::new(),
                        exclude: true,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap();
        assert_eq!(exclude_none.total_rows, 4);

        let exclude_a = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".into(),
                        selected: vec!["A".into()],
                        exclude: true,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap();
        assert_eq!(exclude_a.total_rows, 2);
    }

    #[test]
    fn query_table_window_rejects_unknown_filter_columns() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();

        let error = db
            .query_table_window(&TableWindowRequest {
                filters: vec![TableWindowFilter {
                    op: "AND".into(),
                    rule: TableWindowFilterRule::Continuous {
                        field: "missing".into(),
                        min: Some(0.0),
                        max: None,
                    },
                }],
                ..benchmark_window_request(0, 10)
            })
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    fn table_mutation_invalidates_previous_window_generation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();
        let request = benchmark_window_request(0, 5);
        assert!(db.query_table_window(&request).is_ok());

        db.update_cell("benchmark-id", 1, "value_1", "99").unwrap();

        let error = db.query_table_window(&request).unwrap_err();
        assert!(matches!(error, AppError::InvalidParam(_)));
        let next = db
            .query_table_window(&TableWindowRequest {
                generation: 1,
                ..request
            })
            .unwrap();
        assert_eq!(next.generation, 1);
        assert_eq!(next.rows[0][1], serde_json::json!(99));
    }

    #[test]
    fn failed_generation_bump_rolls_back_row_mutation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 1, 1)
            .unwrap();
        db.conn()
            .execute(
                "DELETE FROM _meta_datasets WHERE id = $1",
                params!["benchmark-id"],
            )
            .unwrap();

        let error = db
            .update_cell("benchmark-id", 1, "value_1", "99")
            .unwrap_err();
        assert!(matches!(error, AppError::InvalidParam(_)));

        let value: i64 = db
            .conn()
            .query_row(
                "SELECT value_1 FROM dataset_benchmark_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, 1);
    }

    #[test]
    fn paste_rejects_invalid_typed_values_without_partial_changes() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "benchmark-id",
            "Benchmark",
            &["amount".into()],
            &["DOUBLE".into()],
        )
        .unwrap();
        db.conn()
            .execute("INSERT INTO dataset_benchmark_id VALUES (1, 1.5)", [])
            .unwrap();

        assert!(db
            .paste_at_position(
                "benchmark-id",
                0,
                0,
                &[vec!["not-a-number".into()]],
                None,
                &["DOUBLE".into()],
            )
            .is_err());

        let value: f64 = db
            .conn()
            .query_row("SELECT amount FROM dataset_benchmark_id", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, 1.5);
        assert_eq!(db.get_dataset_generation("benchmark-id").unwrap(), 0);
    }

    #[test]
    fn paste_updates_a_bounded_middle_range_and_extends_the_tail() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10_000, 1)
            .unwrap();

        db.paste_at_position(
            "benchmark-id",
            5_000,
            0,
            &[vec!["42".into()], vec!["43".into()]],
            None,
            &["BIGINT".into()],
        )
        .unwrap();
        db.paste_at_position(
            "benchmark-id",
            10_002,
            0,
            &[vec!["99".into()]],
            None,
            &["BIGINT".into()],
        )
        .unwrap();

        let middle = db
            .query_table_window(&TableWindowRequest {
                dataset_id: "benchmark-id".into(),
                start: 5_000,
                count: 2,
                sort: None,
                filters: vec![],
                generation: 2,
            })
            .unwrap();
        let tail = db
            .query_table_window(&TableWindowRequest {
                dataset_id: "benchmark-id".into(),
                start: 10_000,
                count: 3,
                sort: None,
                filters: vec![],
                generation: 2,
            })
            .unwrap();
        assert_eq!(middle.rows[0][1], serde_json::json!(42));
        assert_eq!(middle.rows[1][1], serde_json::json!(43));
        assert_eq!(tail.rows[0][1], serde_json::Value::Null);
        assert_eq!(tail.rows[1][1], serde_json::Value::Null);
        assert_eq!(tail.rows[2][1], serde_json::json!(99));
        assert_eq!(tail.total_rows, 10_003);
    }

    #[test]
    fn paste_change_set_undoes_and_redoes_existing_cells() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("history-paste-id", "History Paste", 3, 2)
            .unwrap();

        let change_set_id = db
            .paste_at_position_with_change_set(
                "history-paste-id",
                1,
                0,
                &[vec!["90".into(), "2.5".into()]],
                None,
                &["BIGINT".into(), "DOUBLE".into()],
                Some(0),
            )
            .unwrap();
        assert!(!change_set_id.is_empty());
        assert_eq!(db.get_dataset_generation("history-paste-id").unwrap(), 1);

        db.apply_change_set(&change_set_id, true).unwrap();
        let undone: (i64, f64) = db
            .conn()
            .query_row(
                "SELECT value_1, value_2 FROM dataset_history_paste_id WHERE _row_id = 2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(undone, (2, 1.0));
        assert_eq!(db.get_dataset_generation("history-paste-id").unwrap(), 2);

        db.apply_change_set(&change_set_id, false).unwrap();
        let redone: (i64, f64) = db
            .conn()
            .query_row(
                "SELECT value_1, value_2 FROM dataset_history_paste_id WHERE _row_id = 2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(redone, (90, 2.5));
        assert_eq!(db.get_dataset_generation("history-paste-id").unwrap(), 3);
    }

    #[test]
    fn delete_rows_change_set_restores_values_and_exact_row_ids() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("history-delete-id", "History Delete", 4, 2)
            .unwrap();

        let change_set_id = db
            .delete_rows_with_change_set("history-delete-id", &[2, 4], Some(0))
            .unwrap();
        assert_eq!(
            db.get_dataset_meta("history-delete-id").unwrap().row_count,
            2
        );
        assert_eq!(db.get_dataset_generation("history-delete-id").unwrap(), 1);

        db.apply_change_set(&change_set_id, true).unwrap();
        let restored: Vec<(i64, i64, f64)> = db
            .conn()
            .prepare(
                "SELECT _row_id, value_1, value_2 FROM dataset_history_delete_id ORDER BY _row_id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            restored,
            vec![(1, 1, 0.5), (2, 2, 1.0), (3, 3, 1.5), (4, 4, 2.0)]
        );
        assert_eq!(db.get_dataset_generation("history-delete-id").unwrap(), 2);

        db.apply_change_set(&change_set_id, false).unwrap();
        let remaining_ids: Vec<i64> = db
            .conn()
            .prepare("SELECT _row_id FROM dataset_history_delete_id ORDER BY _row_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining_ids, vec![1, 3]);
        assert_eq!(db.get_dataset_generation("history-delete-id").unwrap(), 3);
    }

    #[test]
    fn added_column_change_set_preserves_order_type_and_rows() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-add-column-id",
            "History Add Column",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_add_column_id (_row_id, existing) VALUES (1, 'kept')",
                [],
            )
            .unwrap();

        let change_set_id = db
            .add_column_with_change_set(
                "history-add-column-id",
                "amount",
                "DOUBLE",
                Some(0),
                Some(0),
            )
            .unwrap();
        assert_eq!(
            db.get_user_columns("history-add-column-id").unwrap(),
            vec![
                ("amount".into(), "DOUBLE".into()),
                ("existing".into(), "VARCHAR".into())
            ]
        );
        assert_eq!(
            db.get_dataset_generation("history-add-column-id").unwrap(),
            1
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("history-add-column-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );
        let existing_index: i32 = db
            .conn()
            .query_row(
                "SELECT col_index FROM _meta_columns WHERE dataset_id = 'history-add-column-id' AND col_name = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(existing_index, 0);

        db.apply_change_set(&change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("history-add-column-id").unwrap(),
            vec![
                ("amount".into(), "DOUBLE".into()),
                ("existing".into(), "VARCHAR".into())
            ]
        );
        let kept: String = db
            .conn()
            .query_row(
                "SELECT existing FROM dataset_history_add_column_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, "kept");
        assert_eq!(
            db.get_dataset_generation("history-add-column-id").unwrap(),
            3
        );
    }

    #[test]
    fn added_columns_change_set_is_one_atomic_history_action() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-add-columns-id",
            "History Add Columns",
            &["left".into(), "right".into()],
            &["VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();

        let columns = vec![
            ("first".to_string(), "DOUBLE".to_string()),
            ("second".to_string(), "DOUBLE".to_string()),
            ("third".to_string(), "DOUBLE".to_string()),
        ];
        let change_set_id = db
            .add_columns_with_change_set("history-add-columns-id", &columns, Some(1), Some(0))
            .unwrap();
        assert_eq!(
            db.get_user_columns("history-add-columns-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["left", "first", "second", "third", "right"]
        );
        assert_eq!(
            db.get_dataset_generation("history-add-columns-id").unwrap(),
            1
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("history-add-columns-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["left", "right"]
        );

        db.apply_change_set(&change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("history-add-columns-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["left", "first", "second", "third", "right"]
        );
        assert_eq!(
            db.get_dataset_generation("history-add-columns-id").unwrap(),
            3
        );
    }

    #[test]
    fn deleted_columns_change_set_restores_values_types_and_order() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-delete-columns-id",
            "History Delete Columns",
            &["left".into(), "amount".into(), "note".into()],
            &["VARCHAR".into(), "DOUBLE".into(), "VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_delete_columns_id VALUES (1, 'kept', 4.5, 'restored')",
                [],
            )
            .unwrap();

        let change_set_id = db
            .delete_columns_with_change_set(
                "history-delete-columns-id",
                &["amount".into(), "note".into()],
                Some(0),
            )
            .unwrap();
        assert_eq!(
            db.get_user_columns("history-delete-columns-id").unwrap(),
            vec![("left".into(), "VARCHAR".into())]
        );
        assert_eq!(
            db.get_dataset_generation("history-delete-columns-id")
                .unwrap(),
            1
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("history-delete-columns-id").unwrap(),
            vec![
                ("left".into(), "VARCHAR".into()),
                ("amount".into(), "DOUBLE".into()),
                ("note".into(), "VARCHAR".into()),
            ]
        );
        let restored: (String, f64, String) = db
            .conn()
            .query_row(
                "SELECT \"left\", amount, note FROM dataset_history_delete_columns_id WHERE _row_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(restored, ("kept".into(), 4.5, "restored".into()));

        db.apply_change_set(&change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("history-delete-columns-id").unwrap(),
            vec![("left".into(), "VARCHAR".into())]
        );
        assert_eq!(
            db.get_dataset_generation("history-delete-columns-id")
                .unwrap(),
            3
        );
    }

    #[test]
    fn altered_column_change_set_restores_lossy_values_name_and_type() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-alter-column-id",
            "History Alter Column",
            &["code".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_alter_column_id VALUES (1, '01')",
                [],
            )
            .unwrap();

        let change_set_id = db
            .alter_column_with_change_set(
                "history-alter-column-id",
                "code",
                "amount",
                "DOUBLE",
                Some(0),
            )
            .unwrap();
        let changed: f64 = db
            .conn()
            .query_row(
                "SELECT amount FROM dataset_history_alter_column_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(changed, 1.0);
        assert_eq!(
            db.get_user_columns("history-alter-column-id").unwrap(),
            vec![("amount".into(), "DOUBLE".into())]
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        let restored: String = db
            .conn()
            .query_row(
                "SELECT code FROM dataset_history_alter_column_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored, "01");
        assert_eq!(
            db.get_user_columns("history-alter-column-id").unwrap(),
            vec![("code".into(), "VARCHAR".into())]
        );

        db.apply_change_set(&change_set_id, false).unwrap();
        let redone: f64 = db
            .conn()
            .query_row(
                "SELECT amount FROM dataset_history_alter_column_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(redone, 1.0);
        assert_eq!(
            db.get_dataset_generation("history-alter-column-id")
                .unwrap(),
            3
        );
    }

    #[test]
    fn column_reorder_replay_is_generation_guarded_and_reversible() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-reorder-id",
            "History Reorder",
            &["first".into(), "second".into(), "third".into()],
            &["VARCHAR".into(), "VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();

        let generation = db
            .reorder_column_if_generation("history-reorder-id", 0, 2, 0)
            .unwrap();
        assert_eq!(generation, 1);
        assert_eq!(
            db.get_user_columns("history-reorder-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["second", "third", "first"]
        );

        let generation = db
            .reorder_column_if_generation("history-reorder-id", 2, 0, 1)
            .unwrap();
        assert_eq!(generation, 2);
        assert_eq!(
            db.get_user_columns("history-reorder-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );

        assert!(matches!(
            db.reorder_column_if_generation("history-reorder-id", 0, 2, 1),
            Err(AppError::InvalidParam(_))
        ));
        assert_eq!(db.get_dataset_generation("history-reorder-id").unwrap(), 2);
    }

    #[test]
    fn altered_columns_change_set_is_atomic_and_lossless_on_undo() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-alter-columns-id",
            "History Alter Columns",
            &["first".into(), "second".into()],
            &["VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_alter_columns_id VALUES (1, '01', '002')",
                [],
            )
            .unwrap();

        let change_set_id = db
            .alter_columns_type_with_change_set(
                "history-alter-columns-id",
                &["first".into(), "second".into()],
                "DOUBLE",
                Some(0),
            )
            .unwrap();
        let changed: (f64, f64) = db
            .conn()
            .query_row(
                "SELECT first, second FROM dataset_history_alter_columns_id WHERE _row_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(changed, (1.0, 2.0));
        assert_eq!(
            db.get_dataset_generation("history-alter-columns-id")
                .unwrap(),
            1
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        let restored: (String, String) = db
            .conn()
            .query_row(
                "SELECT first, second FROM dataset_history_alter_columns_id WHERE _row_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(restored, ("01".into(), "002".into()));

        db.apply_change_set(&change_set_id, false).unwrap();
        let redone: (f64, f64) = db
            .conn()
            .query_row(
                "SELECT first, second FROM dataset_history_alter_columns_id WHERE _row_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(redone, (1.0, 2.0));
        assert_eq!(
            db.get_dataset_generation("history-alter-columns-id")
                .unwrap(),
            3
        );
    }

    #[test]
    fn paste_change_set_undoes_and_redoes_created_rows() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("history-rows-id", "History Rows", 2, 1)
            .unwrap();

        let change_set_id = db
            .paste_at_position_with_change_set(
                "history-rows-id",
                4,
                0,
                &[vec!["99".into()]],
                None,
                &["BIGINT".into()],
                Some(0),
            )
            .unwrap();
        assert_eq!(db.get_dataset_meta("history-rows-id").unwrap().row_count, 5);

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(db.get_dataset_meta("history-rows-id").unwrap().row_count, 2);

        db.apply_change_set(&change_set_id, false).unwrap();
        let meta = db.get_dataset_meta("history-rows-id").unwrap();
        let value: i64 = db
            .conn()
            .query_row(
                "SELECT value_1 FROM dataset_history_rows_id WHERE _row_id = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(meta.row_count, 5);
        assert_eq!(value, 99);
        assert_eq!(db.get_dataset_generation("history-rows-id").unwrap(), 3);
    }

    #[test]
    fn paste_change_set_undoes_and_redoes_schema_changes() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-schema-id",
            "History Schema",
            &["value".into()],
            &["VARCHAR".into()],
        )
        .unwrap();

        let change_set_id = db
            .paste_at_position_with_change_set(
                "history-schema-id",
                0,
                0,
                &[vec!["42".into(), "alpha".into()]],
                Some(&["amount".into(), "label".into()]),
                &["BIGINT".into(), "VARCHAR".into()],
                Some(0),
            )
            .unwrap();
        assert_eq!(
            db.get_user_columns("history-schema-id").unwrap(),
            vec![
                ("amount".into(), "BIGINT".into()),
                ("label".into(), "VARCHAR".into()),
            ]
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("history-schema-id").unwrap(),
            vec![("value".into(), "VARCHAR".into())]
        );
        assert_eq!(
            db.get_dataset_meta("history-schema-id").unwrap().row_count,
            0
        );

        db.apply_change_set(&change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("history-schema-id").unwrap(),
            vec![
                ("amount".into(), "BIGINT".into()),
                ("label".into(), "VARCHAR".into()),
            ]
        );
        let row: (i64, String) = db
            .conn()
            .query_row(
                "SELECT amount, label FROM dataset_history_schema_id WHERE _row_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (42, "alpha".into()));
        assert_eq!(db.get_dataset_generation("history-schema-id").unwrap(), 3);
    }

    #[test]
    fn dropping_change_set_releases_snapshots_and_disables_replay() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("history-drop-id", "History Drop", 1, 1)
            .unwrap();
        let change_set_id = db
            .paste_at_position_with_change_set(
                "history-drop-id",
                0,
                0,
                &[vec!["9".into()]],
                None,
                &["BIGINT".into()],
                Some(0),
            )
            .unwrap();

        db.drop_change_set(&change_set_id).unwrap();
        assert!(matches!(
            db.apply_change_set(&change_set_id, true),
            Err(AppError::InvalidParam(_))
        ));
        let snapshot_count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE '_history_%' AND table_name NOT LIKE '_history_change_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot_count, 0);
    }

    #[test]
    fn history_paste_rejects_unsafe_types_and_quotes_header_identifiers() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table("safe-paste-id", "Safe Paste", &[], &[])
            .unwrap();

        let result = db.paste_at_position_with_change_set(
            "safe-paste-id",
            0,
            0,
            &[vec!["1".into()]],
            Some(&["quoted\"header".into()]),
            &["BIGINT); DROP TABLE _meta_datasets; --".into()],
            Some(0),
        );
        assert!(matches!(result, Err(AppError::InvalidParam(_))));
        let metadata_exists: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM _meta_datasets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(metadata_exists, 1);

        let change_set_id = db
            .paste_at_position_with_change_set(
                "safe-paste-id",
                0,
                0,
                &[vec!["ok".into()]],
                Some(&["quoted\"header".into()]),
                &["VARCHAR".into()],
                Some(0),
            )
            .unwrap();
        assert!(!change_set_id.is_empty());
        assert_eq!(
            db.get_user_columns("safe-paste-id").unwrap()[0].0,
            "quoted\"header"
        );
    }

    #[test]
    fn change_set_replay_rejects_intervening_mutations() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("stale-history-id", "Stale History", 1, 1)
            .unwrap();
        let change_set_id = db
            .paste_at_position_with_change_set(
                "stale-history-id",
                0,
                0,
                &[vec!["9".into()]],
                None,
                &["BIGINT".into()],
                Some(0),
            )
            .unwrap();
        db.update_cell("stale-history-id", 1, "value_1", "12")
            .unwrap();

        assert!(matches!(
            db.apply_change_set(&change_set_id, true),
            Err(AppError::InvalidParam(_))
        ));
        let value: i64 = db
            .conn()
            .query_row(
                "SELECT value_1 FROM dataset_stale_history_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, 12);
    }

    #[test]
    fn compact_cell_replay_rejects_intervening_mutations() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("stale-cells-id", "Stale Cells", 1, 1)
            .unwrap();
        db.update_cell("stale-cells-id", 1, "value_1", "9").unwrap();
        db.update_cell("stale-cells-id", 1, "value_1", "12")
            .unwrap();

        let replay = db.update_cells_if_generation(
            "stale-cells-id",
            &[CellUpdate {
                row_id: 1,
                column_name: "value_1".into(),
                value: Some("1".into()),
            }],
            Some(1),
        );
        assert!(matches!(replay, Err(AppError::InvalidParam(_))));
        let value: i64 = db
            .conn()
            .query_row(
                "SELECT value_1 FROM dataset_stale_cells_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, 12);
        assert_eq!(db.get_dataset_generation("stale-cells-id").unwrap(), 2);
    }

    #[test]
    fn added_rows_history_is_atomic_and_generation_guarded() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "added-rows-id",
            "Added Rows",
            &["value".into()],
            &["VARCHAR".into()],
        )
        .unwrap();

        let row_ids = db.add_rows("added-rows-id", 3).unwrap();
        assert_eq!(row_ids, vec![1, 2, 3]);
        assert_eq!(db.get_dataset_generation("added-rows-id").unwrap(), 1);
        assert_eq!(db.get_dataset_meta("added-rows-id").unwrap().row_count, 3);

        let generation = db
            .apply_added_rows("added-rows-id", &row_ids, true, 1)
            .unwrap();
        assert_eq!(generation, 2);
        assert_eq!(db.get_dataset_meta("added-rows-id").unwrap().row_count, 0);

        let generation = db
            .apply_added_rows("added-rows-id", &row_ids, false, 2)
            .unwrap();
        assert_eq!(generation, 3);
        assert_eq!(db.get_dataset_meta("added-rows-id").unwrap().row_count, 3);

        db.update_cell("added-rows-id", 1, "value", "changed")
            .unwrap();
        assert!(matches!(
            db.apply_added_rows("added-rows-id", &row_ids, true, 3),
            Err(AppError::InvalidParam(_))
        ));
        assert_eq!(db.get_dataset_meta("added-rows-id").unwrap().row_count, 3);
    }

    #[test]
    fn paste_rejects_a_stale_logical_position_before_mutating() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("stale-paste-id", "Stale Paste", 3, 1)
            .unwrap();
        db.update_cell("stale-paste-id", 1, "value_1", "7").unwrap();

        assert!(db
            .paste_at_position_if_generation(
                "stale-paste-id",
                0,
                0,
                &[vec!["99".into()]],
                None,
                &["BIGINT".into()],
                Some(0),
            )
            .is_err());

        let value: i64 = db
            .conn()
            .query_row(
                "SELECT value_1 FROM dataset_stale_paste_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, 7);
        assert_eq!(db.get_dataset_generation("stale-paste-id").unwrap(), 1);
    }

    #[test]
    fn paste_rejects_header_width_mismatch_without_mutating() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "ragged-paste-id",
            "Ragged Paste",
            &["first".into(), "second".into()],
            &["VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();

        let result = db.paste_at_position(
            "ragged-paste-id",
            0,
            0,
            &[vec!["1".into()]],
            Some(&["A".into(), "B".into()]),
            &["VARCHAR".into()],
        );

        assert!(matches!(result, Err(AppError::InvalidParam(_))));
        assert_eq!(db.get_dataset_generation("ragged-paste-id").unwrap(), 0);
        assert_eq!(db.get_dataset_meta("ragged-paste-id").unwrap().row_count, 0);
    }

    #[test]
    fn clear_cells_is_atomic_and_bumps_generation_once() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "clear-id",
            "Clear",
            &["first".into(), "second".into()],
            &["VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();
        db.paste_at_position(
            "clear-id",
            0,
            0,
            &[vec!["A".into(), "B".into()]],
            None,
            &["VARCHAR".into(), "VARCHAR".into()],
        )
        .unwrap();

        db.clear_cells(
            "clear-id",
            &[
                crate::models::table::CellPosition {
                    row_id: 1,
                    column_name: "first".into(),
                },
                crate::models::table::CellPosition {
                    row_id: 1,
                    column_name: "second".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(db.get_dataset_generation("clear-id").unwrap(), 2);

        db.update_cell("clear-id", 1, "first", "restored").unwrap();
        let generation = db.get_dataset_generation("clear-id").unwrap();
        assert!(db
            .clear_cells(
                "clear-id",
                &[
                    crate::models::table::CellPosition {
                        row_id: 1,
                        column_name: "first".into()
                    },
                    crate::models::table::CellPosition {
                        row_id: 1,
                        column_name: "missing".into()
                    },
                ],
            )
            .is_err());
        let value: String = db
            .conn()
            .query_row(
                "SELECT first FROM dataset_clear_id WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "restored");
        assert_eq!(db.get_dataset_generation("clear-id").unwrap(), generation);
    }

    #[test]
    fn update_cells_is_atomic_and_bumps_generation_once() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "update-cells-id",
            "Update Cells",
            &["first".into(), "second".into()],
            &["VARCHAR".into(), "BIGINT".into()],
        )
        .unwrap();
        db.add_row("update-cells-id").unwrap();

        db.update_cells(
            "update-cells-id",
            &[
                crate::models::table::CellUpdate {
                    row_id: 1,
                    column_name: "first".into(),
                    value: Some("restored".into()),
                },
                crate::models::table::CellUpdate {
                    row_id: 1,
                    column_name: "second".into(),
                    value: Some("42".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(db.get_dataset_generation("update-cells-id").unwrap(), 2);

        let before_failure: String = db
            .conn()
            .query_row("SELECT first FROM dataset_update_cells_id", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(db
            .update_cells(
                "update-cells-id",
                &[
                    crate::models::table::CellUpdate {
                        row_id: 1,
                        column_name: "first".into(),
                        value: Some("changed".into()),
                    },
                    crate::models::table::CellUpdate {
                        row_id: 1,
                        column_name: "missing".into(),
                        value: None,
                    },
                ],
            )
            .is_err());
        let after_failure: String = db
            .conn()
            .query_row("SELECT first FROM dataset_update_cells_id", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(after_failure, before_failure);
        assert_eq!(db.get_dataset_generation("update-cells-id").unwrap(), 2);
    }

    #[test]
    fn delete_rows_updates_count_and_generation_once() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("delete-id", "Delete", 5, 1)
            .unwrap();

        db.delete_rows("delete-id", &[2, 4]).unwrap();

        let remaining: Vec<i64> = db
            .conn()
            .prepare("SELECT _row_id FROM dataset_delete_id ORDER BY _row_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![1, 3, 5]);
        assert_eq!(db.get_dataset_meta("delete-id").unwrap().row_count, 3);
        assert_eq!(db.get_dataset_generation("delete-id").unwrap(), 1);
    }

    #[test]
    fn update_table_invalidates_left_dataset_windows() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        for (id, name) in [("left-id", "Left"), ("right-id", "Right")] {
            db.create_empty_table(
                id,
                name,
                &["key".into(), "value".into()],
                &["VARCHAR".into(), "DOUBLE".into()],
            )
            .unwrap();
        }
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_left_id VALUES (1, 'A', 1);
                 INSERT INTO dataset_right_id VALUES (1, 'A', 9);",
            )
            .unwrap();

        db.update_table("left-id", "right-id", "key", &["value".into()])
            .unwrap();

        assert_eq!(db.get_dataset_generation("left-id").unwrap(), 1);
        let value: f64 = db
            .conn()
            .query_row("SELECT value FROM dataset_left_id", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, 9.0);
    }

    #[test]
    fn query_table_window_preserves_date_null_and_left_to_right_filter_semantics() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "benchmark-id",
            "Benchmark",
            &["event_date".into(), "amount".into()],
            &["DATE".into(), "DOUBLE".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_benchmark_id VALUES
                    (1, NULL, 5),
                    (2, DATE '2026-01-15', 5),
                    (3, DATE '2026-06-15', 15),
                    (4, DATE '2027-01-15', 20);
                 UPDATE _meta_datasets SET row_count = 4 WHERE id = 'benchmark-id';",
            )
            .unwrap();

        let result = db
            .query_table_window(&TableWindowRequest {
                dataset_id: "benchmark-id".into(),
                start: 0,
                count: 10,
                sort: None,
                filters: vec![
                    TableWindowFilter {
                        op: "OR".into(),
                        rule: TableWindowFilterRule::Continuous {
                            field: "amount".into(),
                            min: Some(10.0),
                            max: None,
                        },
                    },
                    TableWindowFilter {
                        op: "OR".into(),
                        rule: TableWindowFilterRule::Date {
                            field: "event_date".into(),
                            start: Some("2026-01-01".into()),
                            end: Some("2026-01-31".into()),
                        },
                    },
                    TableWindowFilter {
                        op: "AND".into(),
                        rule: TableWindowFilterRule::Continuous {
                            field: "amount".into(),
                            min: None,
                            max: Some(15.0),
                        },
                    },
                ],
                generation: 0,
            })
            .unwrap();

        let row_ids = result
            .rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(row_ids, vec![2, 3]);
    }

    #[test]
    fn query_table_window_rejects_offset_overflow_and_unknown_sort_column() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();

        let overflow = db
            .query_table_window(&benchmark_window_request(usize::MAX, 1))
            .unwrap_err();
        assert!(matches!(overflow, AppError::InvalidParam(_)));

        let unknown_sort = db
            .query_table_window(&TableWindowRequest {
                sort: Some(TableWindowSort {
                    column: "missing".into(),
                    descending: false,
                }),
                ..benchmark_window_request(0, 1)
            })
            .unwrap_err();
        assert!(matches!(unknown_sort, AppError::InvalidParam(_)));
    }

    #[test]
    fn locate_table_row_respects_filters_and_generation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.seed_benchmark_table("benchmark-id", "Benchmark", 10, 2)
            .unwrap();
        let filters = vec![TableWindowFilter {
            op: "AND".into(),
            rule: TableWindowFilterRule::Continuous {
                field: "value_1".into(),
                min: Some(5.0),
                max: None,
            },
        }];

        assert_eq!(
            db.locate_table_row("benchmark-id", 7, &filters, 0).unwrap(),
            Some(2)
        );
        assert_eq!(
            db.locate_table_row("benchmark-id", 3, &filters, 0).unwrap(),
            None
        );
        assert!(matches!(
            db.locate_table_row("benchmark-id", 7, &filters, 1)
                .unwrap_err(),
            AppError::InvalidParam(_)
        ));
    }

    #[test]
    fn query_table_filter_values_is_bounded_and_searchable() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "benchmark-id",
            "Benchmark",
            &["category".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_benchmark_id VALUES
                    (1, 'Alpha'), (2, 'Beta'), (3, 'Alphabet'), (4, NULL);",
            )
            .unwrap();

        assert_eq!(
            db.query_table_filter_values("benchmark-id", "category", "alpha", 10, 0)
                .unwrap(),
            vec!["Alpha".to_string(), "Alphabet".to_string()]
        );
        assert_eq!(
            db.query_table_filter_values("benchmark-id", "category", "", 2, 0)
                .unwrap()
                .len(),
            2
        );
        assert!(matches!(
            db.query_table_filter_values("benchmark-id", "missing", "", 10, 0)
                .unwrap_err(),
            AppError::InvalidParam(_)
        ));
    }

    fn seed_sales_dataset(db: &DuckDbEngine) {
        db.create_empty_table(
            "sales-id",
            "Sales",
            &["region".to_string(), "revenue".to_string()],
            &["VARCHAR".to_string(), "DOUBLE".to_string()],
        )
        .unwrap();

        let rows = [
            (1_i64, "North", 120.0_f64),
            (2_i64, "South", 200.0_f64),
            (3_i64, "East", 40.0_f64),
            (4_i64, "West", 80.0_f64),
            (5_i64, "Central", 160.0_f64),
        ];

        for (row_id, region, revenue) in rows {
            db.conn()
                .execute(
                    "INSERT INTO \"dataset_sales_id\" (\"_row_id\", \"region\", \"revenue\") VALUES ($1, $2, $3)",
                    params![row_id, region, revenue],
                )
                .unwrap();
        }
    }

    fn seed_regional_sales_dataset(db: &DuckDbEngine) {
        db.create_empty_table(
            "sales-id",
            "Sales",
            &["region".to_string(), "revenue".to_string()],
            &["VARCHAR".to_string(), "DOUBLE".to_string()],
        )
        .unwrap();

        let rows = [(1_i64, "North", 120.0_f64), (2_i64, "South", 200.0_f64)];

        for (row_id, region, revenue) in rows {
            db.conn()
                .execute(
                    "INSERT INTO \"dataset_sales_id\" (\"_row_id\", \"region\", \"revenue\") VALUES ($1, $2, $3)",
                    params![row_id, region, revenue],
                )
                .unwrap();
        }

        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![2_i64, "sales-id"],
            )
            .unwrap();
    }

    fn connection_external_access_enabled(conn: &Connection) -> bool {
        let value: String = conn
            .query_row(
                "SELECT CAST(current_setting('enable_external_access') AS VARCHAR)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        value.trim().eq_ignore_ascii_case("true")
    }

    fn external_access_enabled(db: &DuckDbEngine) -> bool {
        let value: String = db
            .conn()
            .query_row(
                "SELECT CAST(current_setting('enable_external_access') AS VARCHAR)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        value.trim().eq_ignore_ascii_case("true")
    }

    fn dataset_table_exists(db: &DuckDbEngine, table_name: &str) -> bool {
        let sql = format!(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = '{}'",
            table_name
        );
        let count: i64 = db.conn().query_row(&sql, [], |row| row.get(0)).unwrap();
        count > 0
    }

    fn metadata_row_count(db: &DuckDbEngine, dataset_id: &str) -> i64 {
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM _meta_datasets WHERE id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn finalize_transaction_rolls_back_when_commit_fails() {
        let rollback_called = std::cell::Cell::new(false);

        let error = DuckDbEngine::finalize_transaction(
            || Err::<(), AppError>(AppError::Database("commit failed".into())),
            || rollback_called.set(true),
        )
        .unwrap_err();

        assert!(matches!(error, AppError::Database(message) if message == "commit failed"));
        assert!(rollback_called.get());
    }

    #[test]
    fn validate_result_column_names_rejects_empty_duplicate_and_reserved_values() {
        let empty_error =
            DuckDbEngine::validate_result_column_names(&["".to_string()]).unwrap_err();
        assert!(matches!(empty_error, AppError::InvalidParam(_)));

        let duplicate_error = DuckDbEngine::validate_result_column_names(&[
            "Region".to_string(),
            "region".to_string(),
        ])
        .unwrap_err();
        assert!(matches!(duplicate_error, AppError::InvalidParam(_)));

        let reserved_error =
            DuckDbEngine::validate_result_column_names(&["_row_id".to_string()]).unwrap_err();
        assert!(matches!(reserved_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn duckdb_value_to_json_handles_known_complex_variants_without_debug_fallback() {
        let decimal = Decimal::new(12, 2, 1234).unwrap();
        let struct_value = Value::Struct(OrderedMap::from(vec![
            ("name".to_string(), Value::Text("Ada".to_string())),
            ("score".to_string(), Value::Int(7)),
        ]));
        let string_key_map = Value::Map(OrderedMap::from(vec![
            (Value::Text("left".to_string()), Value::Int(1)),
            (Value::Text("right".to_string()), Value::Int(2)),
        ]));
        let mixed_key_map = Value::Map(OrderedMap::from(vec![
            (Value::Int(1), Value::Text("one".to_string())),
            (Value::Text("two".to_string()), Value::Int(2)),
        ]));

        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::HugeInt(123456789012345678901234567890i128)),
            serde_json::json!("123456789012345678901234567890")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::UHugeInt(u128::MAX)),
            serde_json::json!(u128::MAX.to_string())
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::UBigInt(u64::MAX)),
            serde_json::json!(u64::MAX.to_string())
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Decimal(decimal)),
            serde_json::json!("12.34")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Timestamp(TimeUnit::Microsecond, 7)),
            serde_json::json!("timestamp(Microsecond, 7)")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Time64(TimeUnit::Second, 9)),
            serde_json::json!("time64(Second, 9)")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Date32(4)),
            serde_json::json!("date32(4)")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Blob(vec![0xde, 0xad])),
            serde_json::json!("0xdead")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Geometry(vec![0xbe, 0xef])),
            serde_json::json!("0xbeef")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::List(vec![Value::Int(1), Value::Int(2)])),
            serde_json::json!([1, 2])
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Array(vec![
                Value::Text("x".to_string()),
                Value::Boolean(true)
            ])),
            serde_json::json!(["x", true])
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(struct_value),
            serde_json::json!({"name": "Ada", "score": 7})
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(string_key_map),
            serde_json::json!({"left": 1, "right": 2})
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(mixed_key_map),
            serde_json::json!([
                {"key": 1, "value": "one"},
                {"key": "two", "value": 2},
            ])
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Enum("green".to_string())),
            serde_json::json!("green")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Union(Box::new(Value::Boolean(true)))),
            serde_json::json!(true)
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Float(f32::NAN)),
            serde_json::json!("NaN")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Double(f64::INFINITY)),
            serde_json::json!("Infinity")
        );
        assert_eq!(
            DuckDbEngine::duckdb_value_to_json(Value::Double(f64::NEG_INFINITY)),
            serde_json::json!("-Infinity")
        );
    }

    #[test]
    fn dataset_names_are_unique_case_insensitively() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table("one", "Sales", &[], &[]).unwrap();

        let create_error = db.create_empty_table("two", "sales", &[], &[]).unwrap_err();
        assert!(matches!(create_error, AppError::InvalidParam(_)));

        db.create_empty_table("two", "Costs", &[], &[]).unwrap();
        let rename_error = db.rename_dataset("two", "SALES").unwrap_err();
        assert!(matches!(rename_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn transpose_table_rejects_case_insensitive_name_conflict_before_mutating_state() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "source",
            "Sales",
            &["Value".to_string()],
            &["VARCHAR".to_string()],
        )
        .unwrap();

        let err = db.transpose_table("target", "sales", "source").unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, "target"), 0);
        assert!(!dataset_table_exists(&db, "dataset_target"));
    }

    #[test]
    fn transpose_table_rejects_invalid_name_before_mutating_state() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "source",
            "Source",
            &["Value".to_string()],
            &["VARCHAR".to_string()],
        )
        .unwrap();

        let err = db
            .transpose_table("target", "Bad/Name", "source")
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, "target"), 0);
        assert!(!dataset_table_exists(&db, "dataset_target"));
    }

    #[test]
    fn dataset_name_rejects_empty_or_whitespace_only_values() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let empty_error = db.create_empty_table("one", "", &[], &[]).unwrap_err();
        assert!(matches!(empty_error, AppError::InvalidParam(_)));

        let whitespace_error = db.create_empty_table("two", "   ", &[], &[]).unwrap_err();
        assert!(matches!(whitespace_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn dataset_name_rejects_invalid_edge_characters_and_reserved_symbols() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let leading_dot_error = db
            .create_empty_table("one", ".Sales", &[], &[])
            .unwrap_err();
        assert!(matches!(leading_dot_error, AppError::InvalidParam(_)));

        let trailing_space_error = db
            .create_empty_table("two", "Sales ", &[], &[])
            .unwrap_err();
        assert!(matches!(trailing_space_error, AppError::InvalidParam(_)));

        let reserved_char_error = db
            .create_empty_table("three", "Sales/2026", &[], &[])
            .unwrap_err();
        assert!(matches!(reserved_char_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn create_empty_table_rejects_hostile_schema_without_mutating_state() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        let error = db
            .create_empty_table(
                "hostile-id",
                "Hostile",
                &["value\" INTEGER); DROP TABLE _meta_datasets; --".to_string()],
                &["INTEGER); DROP TABLE _meta_columns; --".to_string()],
            )
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, "hostile-id"), 0);
        assert!(!dataset_table_exists(&db, "dataset_hostile_id"));
        assert!(db.list_datasets().is_ok());
    }

    #[test]
    fn rename_dataset_allows_self_preserving_case_changes() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table("one", "Sales", &[], &[]).unwrap();

        db.rename_dataset("one", "SALES").unwrap();

        let meta = db.get_dataset_meta("one").unwrap();
        assert_eq!(meta.name, "SALES");
    }

    #[test]
    fn executes_visible_name_query_with_count_types_and_pagination() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_sales_dataset(&db);

        let before = external_access_enabled(&db);
        let result = db
            .execute_sql_query("SELECT region, revenue FROM Sales ORDER BY revenue", 1, 2)
            .unwrap();

        assert_eq!(
            result.columns,
            vec!["region".to_string(), "revenue".to_string()]
        );
        assert_eq!(
            result.column_types,
            vec!["VARCHAR".to_string(), "DOUBLE".to_string()]
        );
        assert_eq!(result.total_rows, 5);
        assert_eq!(result.page, 1);
        assert_eq!(result.page_size, 2);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(
            result.rows[0],
            vec![serde_json::json!("East"), serde_json::json!(40.0)]
        );
        assert_eq!(
            result.rows[1],
            vec![serde_json::json!("West"), serde_json::json!(80.0)]
        );
        assert_eq!(external_access_enabled(&db), before);
    }

    #[test]
    fn blank_dataset_does_not_block_queries_that_do_not_reference_it() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table("blank-id", "Blank", &[], &[])
            .unwrap();

        let result = db.execute_sql_query("SELECT 1 AS value", 1, 10).unwrap();

        assert_eq!(result.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[test]
    fn query_with_terminal_semicolon_can_be_previewed_and_materialized() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let preview = db
            .execute_sql_query("SELECT 1 AS value; -- finished", 1, 10)
            .unwrap();
        let created = db
            .create_table_from_sql_query("semicolon-id", "Semicolon", "SELECT 1 AS value;")
            .unwrap();

        assert_eq!(preview.rows, vec![vec![serde_json::json!(1)]]);
        assert_eq!(created.row_count, 1);
    }

    #[test]
    fn execute_sql_query_rejects_out_of_range_page_size() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let zero_error = db.execute_sql_query("SELECT 1", 1, 0).unwrap_err();
        assert!(matches!(zero_error, AppError::InvalidParam(_)));

        let oversize_error = db.execute_sql_query("SELECT 1", 1, 201).unwrap_err();
        assert!(matches!(oversize_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn execute_sql_query_rejects_offset_overflow() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let overflow_error = db.execute_sql_query("SELECT 1", usize::MAX, 2).unwrap_err();
        assert!(matches!(overflow_error, AppError::InvalidParam(_)));
    }

    #[test]
    fn execute_sql_query_exposes_visible_metadata() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_sales_dataset(&db);

        let datasets = db.list_datasets().unwrap();
        assert_eq!(datasets.len(), 1);
        assert_eq!(datasets[0].name, "Sales");

        let meta = db.get_dataset_meta("sales-id").unwrap();
        assert_eq!(meta.source_type, "manual");
        assert_eq!(meta.col_count, 2);
    }

    #[test]
    fn execute_sql_query_restores_external_access_and_cleans_up_aliases_on_failure() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_sales_dataset(&db);

        let before = external_access_enabled(&db);
        let error = db
            .execute_sql_query("SELECT CAST(region AS INTEGER) FROM Sales", 1, 2)
            .unwrap_err();
        assert!(matches!(error, AppError::Database(_)));
        assert_eq!(external_access_enabled(&db), before);
    }

    #[test]
    fn isolated_snapshot_keeps_external_access_disabled_without_mutating_live_connection() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_sales_dataset(&db);

        let live_before = external_access_enabled(&db);
        let snapshot = db.build_isolated_snapshot_connection().unwrap();

        assert!(!connection_external_access_enabled(&snapshot));
        assert_eq!(external_access_enabled(&db), live_before);

        let success = db
            .execute_sql_query("SELECT region FROM Sales ORDER BY region", 1, 1)
            .unwrap();
        assert_eq!(success.columns, vec!["region".to_string()]);
        assert_eq!(external_access_enabled(&db), live_before);

        let failure = db
            .execute_sql_query("SELECT CAST(region AS INTEGER) FROM Sales", 1, 1)
            .unwrap_err();
        assert!(matches!(failure, AppError::Database(_)));
        assert_eq!(external_access_enabled(&db), live_before);
    }

    #[test]
    fn execute_sql_query_preserves_exact_complex_types_and_json_values() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        let sql = "SELECT 12.34::DECIMAL(12,2) AS amount, TIMESTAMP '1970-01-01 00:00:01' AS created_at, [1, 2]::INTEGER[] AS numbers, struct_pack(label := 'alpha', score := 7) AS info";

        let result = db.execute_sql_query(sql, 1, 10).unwrap();

        assert_eq!(
            result.columns,
            vec![
                "amount".to_string(),
                "created_at".to_string(),
                "numbers".to_string(),
                "info".to_string()
            ]
        );
        assert_eq!(
            result.column_types,
            vec![
                "DECIMAL(12,2)".to_string(),
                "TIMESTAMP".to_string(),
                "INTEGER[]".to_string(),
                "STRUCT(\"label\" VARCHAR, score INTEGER)".to_string()
            ]
        );
        assert_eq!(result.total_rows, 1);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("12.34"));
        assert!(
            matches!(&result.rows[0][1], serde_json::Value::String(text) if text.starts_with("timestamp("))
        );
        assert_eq!(result.rows[0][2], serde_json::json!([1, 2]));
        assert_eq!(
            result.rows[0][3],
            serde_json::json!({"label": "alpha", "score": 7})
        );
    }

    #[test]
    fn create_table_from_sql_query_preserves_exact_scalar_types_and_row_insertion() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_regional_sales_dataset(&db);
        let sql = "SELECT region, CAST(SUM(revenue) AS DECIMAL(12,2)) AS total FROM Sales GROUP BY region ORDER BY region";

        let meta = db
            .create_table_from_sql_query("typed-query-id", "Typed Query", sql)
            .unwrap();

        assert_eq!(meta.source_type, "query");
        assert_eq!(meta.row_count, 2);
        assert_eq!(meta.col_count, 2);

        let table = db.query_table("typed-query-id", 0, 10, None, None).unwrap();
        assert_eq!(table.columns.first().map(String::as_str), Some("_row_id"));
        assert_eq!(
            table.column_types,
            vec![
                "INTEGER".to_string(),
                "VARCHAR".to_string(),
                "DECIMAL(12,2)".to_string()
            ]
        );
        assert_eq!(table.rows.len(), 2);

        let first_region: String = db
            .conn()
            .query_row(
                "SELECT CAST(\"region\" AS VARCHAR) FROM \"dataset_typed_query_id\" ORDER BY \"_row_id\" LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let first_total: String = db
            .conn()
            .query_row(
                "SELECT CAST(\"total\" AS VARCHAR) FROM \"dataset_typed_query_id\" ORDER BY \"_row_id\" LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let second_total: String = db
            .conn()
            .query_row(
                "SELECT CAST(\"total\" AS VARCHAR) FROM \"dataset_typed_query_id\" ORDER BY \"_row_id\" LIMIT 1 OFFSET 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(first_region, "North");
        assert_eq!(first_total, "120.00");
        assert_eq!(second_total, "200.00");
    }

    #[test]
    fn create_table_from_sql_query_rejects_reserved_row_id_name_before_mutating_state() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let error = db
            .create_table_from_sql_query(
                "reserved-result-id",
                "Reserved Result",
                "SELECT 1 AS \"_row_id\"",
            )
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert!(db.get_dataset_meta("reserved-result-id").is_err());
        assert!(!dataset_table_exists(&db, "dataset_reserved_result_id"));
    }

    #[test]
    fn create_table_from_sql_query_persists_query_metadata_and_row_id_order() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_regional_sales_dataset(&db);

        let meta = db
            .create_table_from_sql_query(
                "regional-totals-id",
                "Regional Totals",
                "SELECT region, SUM(revenue) AS total FROM Sales GROUP BY region ORDER BY region",
            )
            .unwrap();

        assert_eq!(meta.name, "Regional Totals");
        assert_eq!(meta.source_type, "query");
        assert_eq!(meta.row_count, 2);
        assert_eq!(meta.col_count, 2);

        let table = db
            .query_table("regional-totals-id", 0, 10, None, None)
            .unwrap();
        assert_eq!(table.columns.first().map(String::as_str), Some("_row_id"));
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.columns.len(), 3);

        let stored = db.get_dataset_meta("regional-totals-id").unwrap();
        assert_eq!(stored.source_type, "query");
        assert_eq!(stored.name, "Regional Totals");
    }

    #[test]
    fn create_table_from_sql_query_rolls_back_when_metadata_insert_fails() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        seed_regional_sales_dataset(&db);

        let dataset_id = "rollback-query-id";
        db.conn()
            .execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![dataset_id, 0_i32, "stale", "VARCHAR"],
            )
            .unwrap();

        let error = db
            .create_table_from_sql_query(
                dataset_id,
                "Rollback Query",
                "SELECT region, SUM(revenue) AS total FROM Sales GROUP BY region",
            )
            .unwrap_err();

        assert!(matches!(error, AppError::Database(_)));

        db.conn()
            .execute(
                "DELETE FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
            )
            .unwrap();

        assert!(db.get_dataset_meta(dataset_id).is_err());
        assert!(!dataset_table_exists(
            &db,
            &format!("dataset_{}", dataset_id.replace('-', "_"))
        ));
    }

    #[test]
    fn create_table_from_rows_persists_manual_dataset_and_typed_values() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let request = CreateTableFromRowsRequest {
            name: "Rows Typed".to_string(),
            column_names: vec!["label".to_string(), "value".to_string()],
            column_types: vec!["VARCHAR".to_string(), "DOUBLE".to_string()],
            rows: vec![
                vec![json!("alpha"), json!(1.5)],
                vec![serde_json::Value::Null, json!(2.25)],
                vec![json!("gamma"), serde_json::Value::Null],
            ],
        };

        let meta = db
            .create_table_from_rows("rows-typed-id", &request)
            .unwrap();

        assert_eq!(meta.source_type, "manual");
        assert_eq!(meta.row_count, 3);
        assert_eq!(meta.col_count, 2);

        let table = db.query_table("rows-typed-id", 0, 10, None, None).unwrap();
        assert_eq!(table.columns, vec!["_row_id", "label", "value"]);
        assert_eq!(
            table.column_types,
            vec![
                "INTEGER".to_string(),
                "VARCHAR".to_string(),
                "DOUBLE".to_string()
            ]
        );
        assert_eq!(table.rows.len(), 3);
        assert_eq!(
            table.rows,
            vec![
                vec![json!(1), json!("alpha"), json!(1.5)],
                vec![json!(2), serde_json::Value::Null, json!(2.25)],
                vec![json!(3), json!("gamma"), serde_json::Value::Null],
            ]
        );
    }

    #[test]
    fn create_table_from_rows_rejects_mismatched_row_width_without_metadata_residue() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let request = CreateTableFromRowsRequest {
            name: "Width Reject".to_string(),
            column_names: vec!["left".to_string(), "right".to_string()],
            column_types: vec!["VARCHAR".to_string(), "DOUBLE".to_string()],
            rows: vec![vec![json!("ok"), json!(1.0)], vec![json!("missing")]],
        };

        let dataset_id = "rows-width-reject-id";
        let error = db.create_table_from_rows(dataset_id, &request).unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, dataset_id), 0);
        assert!(!dataset_table_exists(
            &db,
            &format!("dataset_{}", dataset_id.replace('-', "_"))
        ));
    }

    #[test]
    fn create_table_from_rows_rejects_nested_json_values_without_metadata_residue() {
        let db = DuckDbEngine::new_in_memory().unwrap();

        let request = CreateTableFromRowsRequest {
            name: "Nested Reject".to_string(),
            column_names: vec!["label".to_string(), "value".to_string()],
            column_types: vec!["VARCHAR".to_string(), "DOUBLE".to_string()],
            rows: vec![
                vec![json!("ok"), json!(1.0)],
                vec![json!({ "nested": true }), json!(2.0)],
            ],
        };

        let dataset_id = "rows-nested-reject-id";
        let error = db.create_table_from_rows(dataset_id, &request).unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, dataset_id), 0);
        assert!(!dataset_table_exists(
            &db,
            &format!("dataset_{}", dataset_id.replace('-', "_"))
        ));
    }

    #[test]
    fn create_table_from_rows_rejects_type_incompatible_scalar_without_metadata_residue() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        let request = CreateTableFromRowsRequest {
            name: "Type Reject".to_string(),
            column_names: vec!["value".to_string()],
            column_types: vec!["DOUBLE".to_string()],
            rows: vec![vec![json!("not-a-number")]],
        };

        let dataset_id = "rows-type-reject-id";
        let error = db.create_table_from_rows(dataset_id, &request).unwrap_err();

        assert!(matches!(error, AppError::InvalidParam(_)));
        assert_eq!(metadata_row_count(&db, dataset_id), 0);
        assert!(!dataset_table_exists(
            &db,
            &format!("dataset_{}", dataset_id.replace('-', "_"))
        ));
    }

    use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateStatistic};
    use serde_json::{json, Value as JsonValue};

    fn assert_option_close(actual: Option<f64>, expected: f64) {
        let value = actual.expect("expected numeric value");
        assert!(
            (value - expected).abs() < 1e-9,
            "expected {expected}, got {value}"
        );
    }

    fn statistic_index(result: &TabulateResult, id: &str) -> usize {
        result
            .statistics
            .iter()
            .position(|statistic| statistic.id == id)
            .expect("statistic id present")
    }

    fn cell_value(
        result: &TabulateResult,
        row: usize,
        column: usize,
        statistic_id: &str,
    ) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.cells
            [((row * result.column_members.len()) + column) * statistic_count + statistic_index]
    }

    fn row_total_value(result: &TabulateResult, row: usize, statistic_id: &str) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.row_totals[row * statistic_count + statistic_index]
    }

    fn column_total_value(
        result: &TabulateResult,
        column: usize,
        statistic_id: &str,
    ) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.column_totals[column * statistic_count + statistic_index]
    }

    fn grand_total_value(result: &TabulateResult, statistic_id: &str) -> Option<f64> {
        result.grand_totals[statistic_index(result, statistic_id)]
    }

    fn make_statistic(id: &str, field: &str, kind: StatisticKind) -> TabulateStatistic {
        TabulateStatistic {
            id: id.to_string(),
            field: field.to_string(),
            kind,
            quantile: None,
        }
    }

    fn make_request(
        row_fields: Vec<&str>,
        column_fields: Vec<&str>,
        statistics: Vec<TabulateStatistic>,
    ) -> TabulateRequest {
        TabulateRequest {
            dataset_id: "tabulate_fixture".to_string(),
            row_fields: row_fields.into_iter().map(str::to_string).collect(),
            column_fields: column_fields.into_iter().map(str::to_string).collect(),
            statistics,
            include_row_totals: false,
            include_column_totals: false,
            max_result_cells: 10_000,
        }
    }

    fn repeated_count_statistics(count: usize) -> Vec<TabulateStatistic> {
        (0..count)
            .map(|index| {
                make_statistic(
                    &format!("count-sales-{index}"),
                    "sales",
                    StatisticKind::Count,
                )
            })
            .collect()
    }

    fn make_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .create_empty_table(
                "tabulate_fixture",
                "Tabulate Fixture",
                &[
                    "region".to_string(),
                    "product".to_string(),
                    "sales".to_string(),
                ],
                &[
                    "VARCHAR".to_string(),
                    "VARCHAR".to_string(),
                    "DOUBLE".to_string(),
                ],
            )
            .expect("fixture metadata");

        for (region, product, sales) in [
            (Some("East"), "A", Some("10")),
            (Some("East"), "A", Some("20")),
            (Some("East"), "B", None),
            (Some("West"), "A", Some("30")),
            (None, "A", Some("40")),
        ] {
            let row_id = engine.add_row("tabulate_fixture").expect("row id");
            if let Some(region_value) = region {
                engine
                    .update_cell("tabulate_fixture", row_id, "region", region_value)
                    .expect("region cell");
            }
            engine
                .update_cell("tabulate_fixture", row_id, "product", product)
                .expect("product cell");
            if let Some(sales_value) = sales {
                engine
                    .update_cell("tabulate_fixture", row_id, "sales", sales_value)
                    .expect("sales cell");
            }
        }

        engine
    }

    fn make_empty_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .create_empty_table(
                "tabulate_fixture",
                "Empty Tabulate Fixture",
                &[
                    "region".to_string(),
                    "product".to_string(),
                    "sales".to_string(),
                ],
                &[
                    "VARCHAR".to_string(),
                    "VARCHAR".to_string(),
                    "DOUBLE".to_string(),
                ],
            )
            .expect("fixture metadata");

        engine
    }

    fn make_typed_dimension_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .conn
            .execute_batch(
                "
                CREATE TABLE dataset_tabulate_fixture (
                    _row_id INTEGER,
                    amount DECIMAL(18, 2),
                    event_date DATE,
                    event_time TIMESTAMP,
                    duration INTERVAL
                );
                INSERT INTO dataset_tabulate_fixture VALUES
                    (1, 12.50, DATE '2026-08-13', TIMESTAMP '2026-08-13 09:10:11', INTERVAL '2 days');
                INSERT INTO _meta_datasets (id, name, source_type, row_count, col_count)
                    VALUES ('tabulate_fixture', 'Typed Fixture', 'test', 1, 4);
                INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES
                    ('tabulate_fixture', 0, 'amount', 'DECIMAL(18,2)'),
                    ('tabulate_fixture', 1, 'event_date', 'DATE'),
                    ('tabulate_fixture', 2, 'event_time', 'TIMESTAMP'),
                    ('tabulate_fixture', 3, 'duration', 'INTERVAL');
                ",
            )
            .expect("typed fixture");
        engine
    }

    #[test]
    fn tabulate_returns_normalized_row_major_cells() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("count-sales", "sales", StatisticKind::Count),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![
                vec![json!("East")],
                vec![json!("West")],
                vec![JsonValue::Null],
            ]
        );
        assert_eq!(
            result.column_members,
            vec![vec![json!("A")], vec![json!("B")]]
        );
        assert_eq!(
            result.cells,
            vec![
                Some(15.0),
                Some(2.0),
                None,
                Some(0.0),
                Some(30.0),
                Some(1.0),
                None,
                Some(0.0),
                Some(40.0),
                Some(1.0),
                None,
                Some(0.0),
            ]
        );
        assert_eq!(result.cell_count, 12);
    }

    #[test]
    fn tabulate_supports_one_axis_input() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![
                vec![json!("East")],
                vec![json!("West")],
                vec![JsonValue::Null],
            ]
        );
        assert_eq!(result.column_members, vec![Vec::<JsonValue>::new()]);
        assert_eq!(result.cells, vec![Some(2.0), Some(1.0), Some(1.0)]);
        assert_eq!(result.cell_count, 3);
    }

    #[test]
    fn tabulate_supports_no_dimensions() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec![],
            vec![],
            vec![
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("count-sales", "sales", StatisticKind::Count),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.row_members, vec![Vec::<JsonValue>::new()]);
        assert_eq!(result.column_members, vec![Vec::<JsonValue>::new()]);
        assert_eq!(result.cells, vec![Some(25.0), Some(4.0)]);
        assert_eq!(result.cell_count, 2);
    }

    #[test]
    fn tabulate_preserves_outer_to_inner_dimension_order() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region", "product"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![
                vec![json!("East"), json!("A")],
                vec![json!("East"), json!("B")],
                vec![json!("West"), json!("A")],
                vec![JsonValue::Null, json!("A")],
            ]
        );
        assert_eq!(result.column_members, vec![Vec::<JsonValue>::new()]);
        assert_eq!(
            result.cells,
            vec![Some(2.0), Some(0.0), Some(1.0), Some(1.0)]
        );
    }

    #[test]
    fn tabulate_allows_exactly_ten_thousand_cells() {
        let engine = make_fixture_engine();
        let mut request = make_request(vec![], vec![], repeated_count_statistics(10_000));
        request.max_result_cells = 10_000;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.cells.len(), 10_000);
        assert_eq!(result.cell_count, 10_000);
        assert_eq!(result.limit, 10_000);
    }

    #[test]
    fn tabulate_rejects_results_above_max_cell_limit() {
        let engine = make_fixture_engine();
        let mut request = make_request(vec![], vec![], repeated_count_statistics(10_001));
        request.max_result_cells = 10_000;

        let error = engine.tabulate(&request).expect_err("cell limit must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("10001 cells") && message.contains("limit is 10000"))
        );
    }

    #[test]
    fn tabulate_rejects_unknown_field_before_sql_preparation() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["unknown_field"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("unknown field must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown_field"))
        );
    }

    #[test]
    fn tabulate_rejects_non_numeric_field_for_mean() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec![],
            vec![make_statistic("mean-region", "region", StatisticKind::Mean)],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("non-numeric field must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("region") && message.contains("numeric"))
        );
    }

    #[test]
    fn tabulate_rejects_interval_field_for_mean() {
        let engine = make_typed_dimension_fixture_engine();
        let request = make_request(
            vec![],
            vec![],
            vec![make_statistic(
                "mean-duration",
                "duration",
                StatisticKind::Mean,
            )],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("interval must not be treated as numeric");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("duration") && message.contains("numeric"))
        );
    }

    #[test]
    fn tabulate_formats_typed_dimension_members_for_display() {
        let engine = make_typed_dimension_fixture_engine();
        let request = make_request(
            vec!["amount", "event_date", "event_time"],
            vec![],
            vec![make_statistic(
                "count-amount",
                "amount",
                StatisticKind::Count,
            )],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![vec![
                json!("12.50"),
                json!("2026-08-13"),
                json!("2026-08-13 09:10:11"),
            ]]
        );
        assert_eq!(result.cells, vec![Some(1.0)]);
    }

    #[test]
    fn tabulate_statistics() {
        let engine = make_fixture_engine();
        let mut request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("count-sales", "sales", StatisticKind::Count),
                make_statistic("missing-sales", "sales", StatisticKind::MissingCount),
                make_statistic("unique-sales", "sales", StatisticKind::UniqueCount),
                make_statistic("sum-sales", "sales", StatisticKind::Sum),
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("minimum-sales", "sales", StatisticKind::Minimum),
                make_statistic("maximum-sales", "sales", StatisticKind::Maximum),
                make_statistic("variance-sales", "sales", StatisticKind::Variance),
                make_statistic("stddev-sales", "sales", StatisticKind::StandardDeviation),
                make_statistic("median-sales", "sales", StatisticKind::Median),
                make_statistic("range-sales", "sales", StatisticKind::Range),
                TabulateStatistic {
                    id: "quantile-0-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(0.0),
                },
                TabulateStatistic {
                    id: "quantile-50-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(0.5),
                },
                TabulateStatistic {
                    id: "quantile-100-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(1.0),
                },
                make_statistic("row-pct-sales", "sales", StatisticKind::RowPercentage),
                make_statistic("column-pct-sales", "sales", StatisticKind::ColumnPercentage),
                make_statistic("total-pct-sales", "sales", StatisticKind::TotalPercentage),
            ],
        );
        request.include_row_totals = true;
        request.include_column_totals = true;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(cell_value(&result, 0, 0, "count-sales"), Some(2.0));
        assert_eq!(cell_value(&result, 0, 1, "missing-sales"), Some(1.0));
        assert_eq!(cell_value(&result, 0, 0, "unique-sales"), Some(2.0));
        assert_option_close(cell_value(&result, 0, 0, "sum-sales"), 30.0);
        assert_option_close(cell_value(&result, 0, 0, "mean-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "minimum-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "maximum-sales"), 20.0);
        assert_option_close(cell_value(&result, 0, 0, "variance-sales"), 50.0);
        assert_option_close(cell_value(&result, 0, 0, "stddev-sales"), 50.0_f64.sqrt());
        assert_option_close(cell_value(&result, 0, 0, "median-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "range-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-0-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-50-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-100-sales"), 20.0);
        assert_option_close(cell_value(&result, 0, 0, "row-pct-sales"), 1.0);
        assert_option_close(cell_value(&result, 0, 0, "column-pct-sales"), 0.5);
        assert_option_close(cell_value(&result, 0, 0, "total-pct-sales"), 0.5);
        assert_eq!(cell_value(&result, 0, 1, "column-pct-sales"), None);

        assert_option_close(row_total_value(&result, 0, "row-pct-sales"), 1.0);
        assert_option_close(row_total_value(&result, 0, "column-pct-sales"), 0.5);
        assert_option_close(row_total_value(&result, 0, "total-pct-sales"), 0.5);
        assert_option_close(column_total_value(&result, 0, "row-pct-sales"), 1.0);
        assert_option_close(column_total_value(&result, 0, "column-pct-sales"), 1.0);
        assert_option_close(column_total_value(&result, 0, "total-pct-sales"), 1.0);
        assert_eq!(column_total_value(&result, 1, "row-pct-sales"), Some(0.0));
        assert_eq!(column_total_value(&result, 1, "column-pct-sales"), None);
        assert_eq!(column_total_value(&result, 1, "total-pct-sales"), Some(0.0));
        assert_option_close(grand_total_value(&result, "row-pct-sales"), 1.0);
        assert_option_close(grand_total_value(&result, "column-pct-sales"), 1.0);
        assert_option_close(grand_total_value(&result, "total-pct-sales"), 1.0);
    }

    #[test]
    fn tabulate_percentage_statistics_without_display_totals_still_normalize_cells() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("row-pct-sales", "sales", StatisticKind::RowPercentage),
                make_statistic("column-pct-sales", "sales", StatisticKind::ColumnPercentage),
                make_statistic("total-pct-sales", "sales", StatisticKind::TotalPercentage),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_option_close(cell_value(&result, 0, 0, "row-pct-sales"), 1.0);
        assert_option_close(cell_value(&result, 0, 1, "row-pct-sales"), 0.0);
        assert_option_close(cell_value(&result, 0, 0, "column-pct-sales"), 0.5);
        assert_eq!(cell_value(&result, 0, 1, "column-pct-sales"), None);
        assert_option_close(cell_value(&result, 0, 0, "total-pct-sales"), 0.5);
        assert_option_close(cell_value(&result, 0, 1, "total-pct-sales"), 0.0);

        assert!(result.row_totals.is_empty());
        assert!(result.column_totals.is_empty());
        assert!(result.grand_totals.is_empty());
    }

    #[test]
    fn tabulate_totals_and_grand_totals_follow_flattened_contract() {
        let engine = make_fixture_engine();
        let mut request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("count-sales", "sales", StatisticKind::Count),
                make_statistic("missing-sales", "sales", StatisticKind::MissingCount),
            ],
        );
        request.include_row_totals = true;
        request.include_column_totals = true;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_totals,
            vec![
                Some(2.0),
                Some(1.0),
                Some(1.0),
                Some(0.0),
                Some(1.0),
                Some(0.0)
            ]
        );
        assert_eq!(
            result.column_totals,
            vec![Some(4.0), Some(0.0), Some(0.0), Some(1.0)]
        );
        assert_eq!(result.grand_totals, vec![Some(4.0), Some(1.0)]);
    }

    #[test]
    fn tabulate_returns_empty_shape_for_empty_dataset() {
        let engine = make_empty_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert!(result.row_members.is_empty());
        assert!(result.column_members.is_empty());
        assert!(result.cells.is_empty());
        assert_eq!(result.cell_count, 0);
    }

    #[test]
    fn tabulate_allows_same_field_in_rows_and_columns_once_each() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["product"],
            vec!["product"],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.row_members, vec![vec![json!("A")], vec![json!("B")]]);
        assert_eq!(
            result.column_members,
            vec![vec![json!("A")], vec![json!("B")]]
        );
        assert_eq!(
            result.cells,
            vec![Some(4.0), Some(0.0), Some(0.0), Some(0.0)]
        );
        assert_eq!(result.cell_count, 4);
    }

    #[test]
    fn archive_keyset_batch_does_not_call_json_cell_encoder() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "archive-batch",
            "Archive Batch",
            &["payload".to_string()],
            &["VARCHAR".to_string()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO \"dataset_archive_batch\" (\"_row_id\", \"payload\") VALUES (1, 'alpha')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 1 WHERE id = 'archive-batch'",
                [],
            )
            .unwrap();

        let plan = db.prepare_archive_keyset_read("archive-batch").unwrap();
        reset_archive_cell_to_json_call_count();
        let batch = db
            .read_archive_keyset_batch(&plan, 0, 128, 1024 * 1024, 2 * 1024 * 1024)
            .unwrap();

        assert_eq!(batch.rows.len(), 1);
        assert_eq!(archive_cell_to_json_call_count(), 0);
    }

    #[test]
    fn archive_keyset_batch_retained_estimate_exceeds_raw_string_payload() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "archive-retained",
            "Archive Retained",
            &["payload".to_string()],
            &["VARCHAR".to_string()],
        )
        .unwrap();

        let payload = "\\\"escaped\\ntext\\\"".repeat(8_000);
        db.conn()
            .execute(
                "INSERT INTO \"dataset_archive_retained\" (\"_row_id\", \"payload\") VALUES ($1, $2)",
                params![1_i64, payload.as_str()],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 1 WHERE id = 'archive-retained'",
                [],
            )
            .unwrap();

        let plan = db.prepare_archive_keyset_read("archive-retained").unwrap();
        let batch = db
            .read_archive_keyset_batch(&plan, 0, 16, 2 * 1024 * 1024, 8 * 1024 * 1024)
            .unwrap();
        assert_eq!(batch.rows.len(), 1);
        assert!(batch.retained_bytes_estimate > payload.len());
    }
}

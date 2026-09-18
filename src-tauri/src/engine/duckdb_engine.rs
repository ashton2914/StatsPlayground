use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::mem;
use std::sync::Arc;
use std::time::Instant;

use duckdb::types::{Decimal, OrderedMap, TimeUnit, Value};
use duckdb::{
    appender_params_from_iter, params, params_from_iter, Config, Connection, OptionalExt,
};
use tempfile::TempDir;

use crate::connectors::{ConnectorValue, DataConnector, ServerConnector, SqliteConnector};
use crate::engine::correlation::{correlate, CorrelationFailure, StatisticalMethod};
use crate::engine::hypothesis_test::normalize::{
    HypothesisTestRows, LongHypothesisTestRow, WideHypothesisTestRow,
};
use crate::engine::sql_query::{normalize_identifier, validate_read_only_query};
use crate::error::AppError;
use crate::models::calculated_column::{
    definition_fingerprint, display_formula_text, remap_definition, ArchivedCalculatedColumn,
    CalculatedColumnDefinitionV1, CalculatedColumnDescriptor, CalculatedColumnStatus,
    CalculatedOutputTypeV1, PreservedCalculatedColumnDefinition,
};
use crate::models::data_link::SourceObjectRef;
use crate::models::fit_y_by_x::{FitYByXPersonality, FitYByXRow, FitYByXRows};
use crate::models::graph_data::{
    BoxPlotEntry, BoxPlotOutlier, BoxPlotPacket, CorrelationMatrixCell, CorrelationMatrixPacket,
    CorrelationMethod, CorrelationUnavailableReason, GraphAggregatePacket, GraphDataRequest,
    GraphElementRequest, GraphSampling, GraphTimeSeriesOrder, GraphTimeSeriesRequest, HeatmapCell,
    HeatmapPacket, HistogramBin, HistogramPacket, SummaryEntry, SummaryPacket,
    GRAPH_VIRTUAL_SOURCE_COLUMN, GRAPH_VIRTUAL_VALUE_COLUMN,
};
use crate::models::hypothesis_test::{HypothesisTestFieldRef, HypothesisTestRoles};
use crate::models::table::{
    CellPosition, CellUpdate, CreateTableFromRowsRequest, DatasetMeta, SqlQueryResult,
    TableFilterValue, TableNavigationRequest, TableNavigationResult, TableNavigationTimings,
    TableQueryResult, TableQuerySessionRequest, TableWindowFilterRule, TableWindowRequest,
    TableWindowResult,
};
use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateResult, TabulateSessionRequest, TabulateStatistic, TabulateSparseCell, TabulateWindowRequest, TabulateWindowResult};
use crate::models::tabulate::{TabulateSparseTotal, TabulateTotalsKind, TabulateTotalsRequest, TabulateTotalsResult};
use crate::services::archive_cell::archive_export_expression;
use crate::services::calculated_column_expression::{
    compile_formula_sql, FormulaError, FormulaSqlColumn, TypedCalculatedExpression,
    TypedCalculatedOutput,
};
use crate::services::table_mutation_coordinator::{execute_table_mutation, TableMutationEffects};
use crate::services::time_series::validate_time_series_x;
use crate::services::workflow_fingerprint::{table_content_hash, TableFingerprintColumn};

/// DuckDB engine wrapper
pub struct DuckDbEngine {
    conn: Connection,
    _shared_db_dir: Arc<TempDir>,
}

pub const NATURAL_ANCHOR_STRIDE: usize = 4096;

pub(crate) struct DatasetReplacement {
    pub stable_id: String,
    pub temporary_id: String,
    pub stable_name: String,
    pub expected_generation: u64,
}

#[derive(Clone)]
pub(crate) struct ArchiveColumnPlan {
    pub column_id: String,
    pub name: String,
    pub sql_type: String,
    pub calculated: Option<crate::models::calculated_column::ArchivedCalculatedColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserColumnDescriptor {
    pub column_id: String,
    pub col_index: i32,
    pub name: String,
    pub sql_type: String,
}

enum ReplayedColumnIdentity<'a> {
    Exact(&'a str),
    LegacyGenerated,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValuedColumn {
    pub name: String,
    pub column_type: String,
    pub values: Vec<(u64, Option<f64>)>,
}

pub struct GraphProjectionStats {
    pub source_rows: u64,
    pub projected_columns: Vec<String>,
    pub projected_column_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitModelDataRow {
    pub row_index: u64,
    pub response: f64,
    pub predictors: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitModelDataSet {
    pub predictor_names: Vec<String>,
    pub used_rows: Vec<FitModelDataRow>,
    pub excluded_rows: u64,
}

struct GraphQueryPlan {
    source_sql: String,
    source_values: Vec<Value>,
    projection_sql: String,
    projection_values: Vec<Value>,
    projection_select_items: Vec<String>,
    projected_columns: Vec<String>,
    projected_column_types: Vec<String>,
    order_by_sql: String,
}

struct MaterializedQuery {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
}

fn calculated_output_sql_type(output_type: &CalculatedOutputTypeV1) -> Option<&'static str> {
    match output_type {
        CalculatedOutputTypeV1::Boolean => Some("BOOLEAN"),
        CalculatedOutputTypeV1::Continuous => Some("DOUBLE"),
        CalculatedOutputTypeV1::Integer => Some("BIGINT"),
        CalculatedOutputTypeV1::Null
        | CalculatedOutputTypeV1::Text
        | CalculatedOutputTypeV1::Unknown => None,
    }
}

fn derived_calculated_status(
    calculated: &ArchivedCalculatedColumn,
    output_column_id: &str,
    physical_type: &str,
    present_column_ids: &HashSet<String>,
) -> CalculatedColumnStatus {
    match calculated {
        ArchivedCalculatedColumn::Preserved { .. } => CalculatedColumnStatus::Unsupported,
        ArchivedCalculatedColumn::Ready { definition, state } => {
            if state.status != CalculatedColumnStatus::Ready
                || definition.output_column_id != output_column_id
                || definition_fingerprint(definition) != definition.fingerprint
                || definition
                    .dependency_column_ids
                    .iter()
                    .any(|dependency| !present_column_ids.contains(dependency))
            {
                return CalculatedColumnStatus::Broken;
            }
            if let Some(expected_type) =
                calculated_output_sql_type(&definition.inferred_output_type)
            {
                if !expected_type.eq_ignore_ascii_case(physical_type) {
                    return CalculatedColumnStatus::Broken;
                }
            }
            CalculatedColumnStatus::Ready
        }
    }
}

fn build_calculated_descriptor(
    calculated: &ArchivedCalculatedColumn,
    output_column_id: &str,
    physical_type: &str,
    present_column_ids: &HashSet<String>,
    column_names_by_id: &HashMap<String, String>,
) -> CalculatedColumnDescriptor {
    match calculated {
        ArchivedCalculatedColumn::Ready { definition, .. } => CalculatedColumnDescriptor {
            formula_id: definition.formula_id.clone(),
            schema_version: definition.schema_version.clone(),
            output_column_id: definition.output_column_id.clone(),
            display_formula_text: display_formula_text(&definition.expression, &|column_id| {
                column_names_by_id.get(column_id).cloned()
            }),
            status: derived_calculated_status(
                calculated,
                output_column_id,
                physical_type,
                present_column_ids,
            ),
            dependency_column_ids: definition.dependency_column_ids.clone(),
            inferred_output_type: definition.inferred_output_type.clone(),
            fingerprint: definition.fingerprint.clone(),
        },
        ArchivedCalculatedColumn::Preserved { definition } => CalculatedColumnDescriptor {
            formula_id: definition.formula_id.clone(),
            schema_version: definition.schema_version.clone(),
            output_column_id: definition.output_column_id.clone(),
            display_formula_text: String::new(),
            status: CalculatedColumnStatus::Unsupported,
            dependency_column_ids: Vec::new(),
            inferred_output_type: CalculatedOutputTypeV1::Unknown,
            fingerprint: String::new(),
        },
    }
}

pub(crate) struct TableQuerySessionPlan {
    pub projection: Vec<(String, String)>,
    pub where_clause: String,
    pub filter_values: Vec<Value>,
    pub order_clause: String,
}

pub(crate) struct PreparedTableQuerySessionInfo {
    pub projection: Vec<(String, String)>,
    pub total_rows: i64,
    pub measured_bytes_estimate: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedTabulateSessionInfo {
    pub row_member_count: u64,
    pub column_member_count: u64,
    pub logical_cell_count: u64,
    pub measured_bytes_estimate: usize,
}
type GroupedStatisticValues = std::collections::HashMap<(String, String), Vec<Option<f64>>>;

#[derive(Default)]
struct TabulateMemberSlice {
    members: Vec<Vec<serde_json::Value>>,
    before: Option<Vec<serde_json::Value>>,
    after: Option<Vec<serde_json::Value>>,
}

struct CorrelationRequestBinding {
    suffix: u32,
    column: String,
}

struct CorrelationRequestPlan {
    method: CorrelationMethod,
    columns: Vec<String>,
}

impl From<CorrelationMethod> for StatisticalMethod {
    fn from(value: CorrelationMethod) -> Self {
        match value {
            CorrelationMethod::Pearson => Self::Pearson,
            CorrelationMethod::Spearman => Self::Spearman,
            CorrelationMethod::Kendall => Self::Kendall,
        }
    }
}

impl From<CorrelationFailure> for CorrelationUnavailableReason {
    fn from(value: CorrelationFailure) -> Self {
        match value {
            CorrelationFailure::InsufficientData => Self::InsufficientData,
            CorrelationFailure::ZeroVariance => Self::ZeroVariance,
        }
    }
}

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

fn time_series_request<'a>(
    elements: &'a [GraphElementRequest],
) -> Result<Option<&'a GraphTimeSeriesRequest>, AppError> {
    let Some(element) = elements
        .iter()
        .find(|element| element.kind.eq_ignore_ascii_case("timeSeries"))
    else {
        return Ok(None);
    };

    Ok(element.time_series.as_ref())
}

pub(crate) struct ArchiveKeysetReadPlan {
    select_sql: String,
    pub columns: Vec<ArchiveColumnPlan>,
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

    pub fn open_secondary_connection(&self) -> Result<Connection, AppError> {
        self.conn.try_clone().map_err(AppError::from)
    }

    pub(crate) fn bump_dataset_generation(&self, dataset_id: &str) -> Result<(), AppError> {
        let generation = self.get_dataset_generation(dataset_id)?;
        let next_generation = generation
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
        self.copy_natural_anchors_between_generations(dataset_id, generation, next_generation)?;
        let changed = self.conn.execute(
            "UPDATE _meta_datasets SET generation = ? WHERE id = ?",
            params![next_generation, dataset_id],
        )?;
        if changed == 0 {
            return Err(AppError::InvalidParam(format!(
                "unknown dataset: {dataset_id}"
            )));
        }
        Ok(())
    }

    fn copy_natural_anchors_between_generations(
        &self,
        dataset_id: &str,
        source_generation: u64,
        target_generation: u64,
    ) -> Result<(), AppError> {
        let source_generation_i64 = i64::try_from(source_generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        let target_generation_i64 = i64::try_from(target_generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        self.conn.execute(
            "DELETE FROM _table_navigation_anchors WHERE dataset_id = ? AND generation = ?",
            params![dataset_id, target_generation_i64],
        )?;
        self.conn.execute(
            "INSERT INTO _table_navigation_anchors (dataset_id, generation, ordinal, row_id)
             SELECT dataset_id, ?, ordinal, row_id
             FROM _table_navigation_anchors
             WHERE dataset_id = ? AND generation = ?",
            params![target_generation_i64, dataset_id, source_generation_i64],
        )?;
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

    pub(crate) fn workflow_table_content_hash(
        &self,
        dataset_id: &str,
        expected_generation: u64,
    ) -> Result<String, AppError> {
        let generation = self.get_dataset_generation(dataset_id)?;
        if generation != expected_generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {expected_generation}, found {generation}"
            )));
        }

        let columns = self.get_user_columns(dataset_id)?;
        let fingerprint_columns = columns
            .iter()
            .map(|(name, canonical_type)| TableFingerprintColumn {
                name: name.clone(),
                canonical_type: canonical_type.clone(),
            })
            .collect::<Vec<_>>();
        let select_columns = columns
            .iter()
            .map(|(name, _)| Self::quote_identifier(name))
            .collect::<Vec<_>>()
            .join(", ");
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let query = if select_columns.is_empty() {
            format!("SELECT \"_row_id\" FROM {table_name} ORDER BY \"_row_id\" ASC")
        } else {
            format!("SELECT {select_columns} FROM {table_name} ORDER BY \"_row_id\" ASC")
        };
        let mut statement = self.conn.prepare(&query)?;
        let mut query_rows = statement.query([])?;
        let mut rows = Vec::new();
        while let Some(row) = query_rows.next()? {
            let mut values = Vec::with_capacity(columns.len());
            for column_index in 0..columns.len() {
                values.push(Self::duckdb_value_to_json(row.get(column_index)?));
            }
            rows.push(values);
        }

        if self.get_dataset_generation(dataset_id)? != expected_generation {
            return Err(AppError::InvalidParam(format!(
                "dataset {dataset_id} changed while fingerprinting"
            )));
        }
        table_content_hash(&fingerprint_columns, &rows)
    }

    fn get_dataset_generation_if_exists(&self, dataset_id: &str) -> Result<Option<u64>, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT generation FROM _meta_datasets WHERE id = $1")?;
        let mut rows = stmt.query(params![dataset_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let generation: i64 = row.get(0)?;
        u64::try_from(generation)
            .map(Some)
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
            let generation = self.get_dataset_generation(dataset_id)?;
            self.rebuild_natural_anchors(dataset_id, generation)?;
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
        let generation = self.get_dataset_generation(id)?;
        self.rebuild_natural_anchors(id, generation)?;

        Ok(())
    }

    /// Create a new in-memory DuckDB engine and initialize metadata tables
    pub fn new_in_memory() -> Result<Self, AppError> {
        let shared_db_dir = Arc::new(tempfile::tempdir()?);
        let shared_db_path = shared_db_dir.path().join("stats_playground.duckdb");
        let conn = Connection::open(&shared_db_path)?;

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
                column_id   TEXT NOT NULL DEFAULT (CAST(uuid() AS VARCHAR)),
                col_index   INTEGER,
                col_name    TEXT,
                col_type    TEXT,
                role        TEXT DEFAULT 'continuous',
                missing_count BIGINT DEFAULT 0,
                PRIMARY KEY (dataset_id, col_index),
                UNIQUE (column_id)
            );

            CREATE TABLE IF NOT EXISTS _meta_calculated_columns (
                dataset_id  TEXT NOT NULL,
                column_id   TEXT NOT NULL,
                formula_id  TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                expression_json TEXT,
                dependency_column_ids_json TEXT,
                inferred_output_type TEXT,
                fingerprint TEXT,
                archived_definition_json TEXT NOT NULL,
                PRIMARY KEY (dataset_id, column_id),
                UNIQUE (formula_id)
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
                before_column_id TEXT,
                before_name   TEXT,
                before_type   TEXT,
                before_calculated_definition_json TEXT,
                after_column_id TEXT,
                after_name    TEXT NOT NULL,
                after_type    TEXT NOT NULL,
                after_calculated_definition_json TEXT,
                after_present BOOLEAN NOT NULL DEFAULT TRUE,
                PRIMARY KEY (change_set_id, ordinal)
            );

            CREATE TABLE IF NOT EXISTS _table_navigation_anchors (
                dataset_id TEXT NOT NULL,
                generation BIGINT NOT NULL,
                ordinal    BIGINT NOT NULL,
                row_id     BIGINT NOT NULL,
                PRIMARY KEY (dataset_id, generation, ordinal)
            );
            ",
        )?;
        conn.execute(
            "ALTER TABLE _meta_calculated_columns ADD COLUMN IF NOT EXISTS schema_version TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _meta_calculated_columns ADD COLUMN IF NOT EXISTS expression_json TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _meta_calculated_columns ADD COLUMN IF NOT EXISTS dependency_column_ids_json TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _meta_calculated_columns ADD COLUMN IF NOT EXISTS inferred_output_type TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _meta_calculated_columns ADD COLUMN IF NOT EXISTS fingerprint TEXT",
            [],
        )?;
        conn.execute(
            "UPDATE _meta_calculated_columns SET schema_version = COALESCE(NULLIF(schema_version, ''), '1')",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS before_column_id TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS after_column_id TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS before_calculated_definition_json TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS after_calculated_definition_json TEXT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE _history_change_set_columns ADD COLUMN IF NOT EXISTS after_present BOOLEAN DEFAULT TRUE",
            [],
        )?;
        conn.execute(
            "UPDATE _history_change_set_columns SET after_present = TRUE WHERE after_present IS NULL",
            [],
        )?;

        Ok(Self {
            conn,
            _shared_db_dir: shared_db_dir,
        })
    }

    pub fn try_clone(&self) -> Result<DuckDbEngine, AppError> {
        Ok(Self {
            conn: self.conn.try_clone()?,
            _shared_db_dir: Arc::clone(&self._shared_db_dir),
        })
    }

    pub fn rebuild_natural_anchors(
        &self,
        dataset_id: &str,
        generation: u64,
    ) -> Result<(), AppError> {
        let current_generation = self.get_dataset_generation(dataset_id)?;
        if current_generation != generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {generation}"
            )));
        }
        let generation_i64 = i64::try_from(generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        let stride_i64 = i64::try_from(NATURAL_ANCHOR_STRIDE)
            .map_err(|_| AppError::InvalidParam("navigation anchor stride is too large".into()))?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        self.conn.execute(
            "DELETE FROM _table_navigation_anchors WHERE dataset_id = ? AND generation <> ?",
            params![dataset_id, generation_i64],
        )?;
        self.conn.execute(
            "DELETE FROM _table_navigation_anchors WHERE dataset_id = ? AND generation = ?",
            params![dataset_id, generation_i64],
        )?;
        self.conn.execute(
            &format!(
                "INSERT INTO _table_navigation_anchors (dataset_id, generation, ordinal, row_id)
                 SELECT ?, ?, ordinal, \"_row_id\"
                 FROM (
                     SELECT \"_row_id\", row_number() OVER (ORDER BY \"_row_id\" ASC) - 1 AS ordinal
                     FROM {table_name}
                 ) AS ordered_rows
                 WHERE ordinal % ? = 0"
            ),
            params![dataset_id, generation_i64, stride_i64],
        )?;

        Ok(())
    }

    fn validate_tabulate_fields(
        &self,
        dataset_id: &str,
        row_fields: &[String],
        column_fields: &[String],
        statistics: &[TabulateStatistic],
    ) -> Result<(String, std::collections::HashMap<String, String>), AppError> {
        let dataset_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_datasets WHERE id = $1",
            params![dataset_id],
            |row| row.get(0),
        )?;
        if dataset_exists == 0 {
            return Err(AppError::InvalidParam(format!(
                "Unknown dataset: {}",
                dataset_id
            )));
        }

        validate_unique_fields("row", row_fields)?;
        validate_unique_fields("column", column_fields)?;

        let table_name = Self::internal_table_name(dataset_id);
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
                dataset_id
            )));
        }

        let column_types: std::collections::HashMap<String, String> = columns.into_iter().collect();

        for field in row_fields.iter().chain(column_fields.iter()) {
            if !column_types.contains_key(field) {
                return Err(AppError::InvalidParam(format!("Unknown field: {field}",)));
            }
        }

        for statistic in statistics {
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

        Ok((table_name, column_types))
    }

    pub(crate) fn validate_tabulate_session(
        &self,
        request: &TabulateSessionRequest,
    ) -> Result<(), AppError> {
        crate::services::tabulate_service::validate_definition(
            &request.dataset_id,
            &request.row_fields,
            &request.column_fields,
            &request.statistics,
        )?;
        if self.get_dataset_generation(&request.dataset_id)? != request.source_generation {
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        self.validate_tabulate_fields(
            &request.dataset_id,
            &request.row_fields,
            &request.column_fields,
            &request.statistics,
        )?;
        Ok(())
    }

    pub(crate) fn tabulate_member_table_names(session_id: &uuid::Uuid) -> (String, String) {
        let suffix = session_id.simple();
        (
            format!("__sp_tabulate_{suffix}_rows"),
            format!("__sp_tabulate_{suffix}_columns"),
        )
    }

    fn tabulate_member_select(table_name: &str, fields: &[String]) -> String {
        if fields.is_empty() {
            return "SELECT 0::BIGINT AS ordinal".into();
        }
        let projection = fields
            .iter()
            .enumerate()
            .map(|(index, field)| format!("{} AS dimension_{index}", Self::quote_identifier(field)))
            .collect::<Vec<_>>()
            .join(", ");
        let order = (0..fields.len())
            .map(|index| format!("dimension_{index} ASC NULLS LAST"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT CAST(row_number() OVER (ORDER BY {order}) - 1 AS BIGINT) AS ordinal, members.* FROM (SELECT DISTINCT {projection} FROM {}) AS members", Self::quote_identifier(table_name))
    }

    pub(crate) fn measure_tabulate_member_indexes(
        &self,
        request: &TabulateSessionRequest,
    ) -> Result<PreparedTabulateSessionInfo, AppError> {
        self.validate_tabulate_session(request)?;
        let table = Self::internal_table_name(&request.dataset_id);
        let mut counts = Vec::with_capacity(2);
        let mut measured_bytes = 0usize;
        for fields in [&request.row_fields, &request.column_fields] {
            let members = Self::tabulate_member_select(&table, fields);
            // Conservative encoded-width accounting: 512 KiB per table/ordinal index,
            // 128 bytes per member, plus 4x (32-byte value slot + measured UTF-8 payload).
            // Only distinct keys are charged, never source rows or a Cartesian matrix.
            let widths = (0..fields.len()).map(|index| {
                format!(" + 4 * (32::HUGEINT + COALESCE(octet_length(encode(CAST(dimension_{index} AS VARCHAR))), 0))")
            }).collect::<String>();
            let sql = format!("SELECT count(*), CAST(COALESCE(SUM(128::HUGEINT{widths}), 0) AS BIGINT) FROM ({members}) AS measured_members");
            let (count, bytes): (i64, i64) = self
                .conn
                .query_row(&sql, [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            counts.push(
                u64::try_from(count)
                    .map_err(|_| AppError::InvalidParam("tabulate_member_index_budget".into()))?,
            );
            let bytes = usize::try_from(bytes)
                .map_err(|_| AppError::InvalidParam("tabulate_member_index_budget".into()))?;
            measured_bytes = measured_bytes
                .checked_add(bytes)
                .and_then(|total| total.checked_add(512 * 1024))
                .ok_or_else(|| AppError::InvalidParam("tabulate_member_index_budget".into()))?;
        }
        let logical_cell_count = counts[0]
            .checked_mul(counts[1])
            .and_then(|count| count.checked_mul(request.statistics.len() as u64))
            .ok_or_else(|| AppError::InvalidParam("tabulate_logical_size_overflow".into()))?;
        Ok(PreparedTabulateSessionInfo {
            row_member_count: counts[0],
            column_member_count: counts[1],
            logical_cell_count,
            measured_bytes_estimate: measured_bytes,
        })
    }

    pub(crate) fn prepare_tabulate_member_indexes(
        &self,
        request: &TabulateSessionRequest,
        session_id: &uuid::Uuid,
        max_bytes: usize,
    ) -> Result<PreparedTabulateSessionInfo, AppError> {
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| {
            let info = self.measure_tabulate_member_indexes(request)?;
            if info.measured_bytes_estimate > max_bytes {
                return Err(AppError::InvalidParam(
                    "tabulate_member_index_budget".into(),
                ));
            }
            let (row_table, column_table) = Self::tabulate_member_table_names(session_id);
            for (name, fields) in [
                (&row_table, &request.row_fields),
                (&column_table, &request.column_fields),
            ] {
                let select = Self::tabulate_member_select(
                    &Self::internal_table_name(&request.dataset_id),
                    fields,
                );
                self.conn.execute(
                    &format!(
                        "CREATE TEMP TABLE {} AS {select}",
                        Self::quote_identifier(name)
                    ),
                    [],
                )?;
                self.conn.execute(
                    &format!(
                        "CREATE INDEX {} ON {} (ordinal)",
                        Self::quote_identifier(&format!("{name}_ordinal_idx")),
                        Self::quote_identifier(name)
                    ),
                    [],
                )?;
            }
            self.conn.execute_batch("COMMIT")?;
            Ok(info)
        })();
        if result.is_err() {
            self.conn.execute_batch("ROLLBACK")?;
        }
        result
    }

    pub(crate) fn drop_tabulate_member_indexes(
        &self,
        session_id: &uuid::Uuid,
    ) -> Result<(), AppError> {
        let (row_table, column_table) = Self::tabulate_member_table_names(session_id);
        for name in [row_table, column_table] {
            self.conn.execute(
                &format!("DROP TABLE IF EXISTS {}", Self::quote_identifier(&name)),
                [],
            )?;
        }
        Ok(())
    }

    pub(crate) fn validate_tabulate_window_bounds(
        request: &TabulateWindowRequest,
        info: &PreparedTabulateSessionInfo,
        statistic_count: usize,
    ) -> Result<(u64, u64), AppError> {
        let invalid = || AppError::InvalidParam("tabulate_invalid_bounds".into());
        let row_end = request
            .row_start
            .checked_add(u64::from(request.row_count))
            .ok_or_else(invalid)?;
        let column_end = request
            .column_start
            .checked_add(u64::from(request.column_count))
            .ok_or_else(invalid)?;
        let cells = u64::from(request.row_count)
            .checked_mul(u64::from(request.column_count))
            .and_then(|count| count.checked_mul(statistic_count as u64))
            .ok_or_else(invalid)?;
        if request.row_count == 0
            || request.row_count > 128
            || request.column_count == 0
            || request.column_count > 64
            || cells > 16_384
            || request.row_start > info.row_member_count
            || request.column_start > info.column_member_count
        {
            return Err(invalid());
        }
        Ok((
            row_end.min(info.row_member_count),
            column_end.min(info.column_member_count),
        ))
    }

    pub(crate) fn validate_tabulate_totals_bounds(
        totals: &TabulateTotalsKind,
        info: &PreparedTabulateSessionInfo,
        statistic_count: usize,
    ) -> Result<(u64, u64), AppError> {
        let invalid = || AppError::InvalidParam("tabulate_invalid_bounds".into());
        let (start, count, cap, total) = match *totals {
            TabulateTotalsKind::Rows { start, count } => (start, count, 128, info.row_member_count),
            TabulateTotalsKind::Columns { start, count } => {
                (start, count, 64, info.column_member_count)
            }
            TabulateTotalsKind::Grand => (0, 1, 1, 1),
        };
        let end = start.checked_add(u64::from(count)).ok_or_else(invalid)?;
        let cells = u64::from(count)
            .checked_mul(statistic_count as u64)
            .ok_or_else(invalid)?;
        if count == 0 || count > cap || cells > 16_384 || start > total {
            return Err(invalid());
        }
        Ok((start, end.min(total)))
    }

    fn tabulate_member_join(fields: &[String], alias: &str) -> String {
        let predicates = fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                format!(
                    "source.{} IS NOT DISTINCT FROM {alias}.dimension_{index}",
                    Self::quote_identifier(field)
                )
            })
            .collect::<Vec<_>>();
        if predicates.is_empty() {
            "TRUE".into()
        } else {
            predicates.join(" AND ")
        }
    }

    fn query_tabulate_raw_totals(
        &self,
        definition: &TabulateSessionRequest,
        session_id: &uuid::Uuid,
        totals: &TabulateTotalsKind,
        info: &PreparedTabulateSessionInfo,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Vec<TabulateSparseTotal>, AppError> {
        check_tabulate_cancelled(cancelled)?;
        let (start, end) =
            Self::validate_tabulate_totals_bounds(totals, info, definition.statistics.len())?;
        if start == end {
            return Ok(Vec::new());
        }
        let aggregates = definition
            .statistics
            .iter()
            .map(|statistic| {
                aggregate_sql_for_field(
                    statistic,
                    &format!("source.{}", Self::quote_identifier(&statistic.field)),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let source = Self::quote_identifier(&Self::internal_table_name(&definition.dataset_id));
        let (row_table, column_table) = Self::tabulate_member_table_names(session_id);
        let selection = match totals {
            TabulateTotalsKind::Rows { .. } => Some((&definition.row_fields, row_table)),
            TabulateTotalsKind::Columns { .. } => Some((&definition.column_fields, column_table)),
            TabulateTotalsKind::Grand => None,
        };
        let mut parameters = Vec::new();
        let sql = match selection {
            Some((fields, table)) if !fields.is_empty() => {
                parameters.extend([start, end]);
                format!(
                    "WITH selected_members AS (SELECT * FROM {} WHERE ordinal >= ? AND ordinal < ?)
                     SELECT members.ordinal, {aggregates} FROM {source} AS source
                     JOIN selected_members AS members ON {}
                     GROUP BY members.ordinal ORDER BY members.ordinal",
                    Self::quote_identifier(&table),
                    Self::tabulate_member_join(fields, "members"),
                )
            }
            _ => format!("SELECT 0::UBIGINT, {aggregates} FROM {source} AS source"),
        };
        let mut statement = self.conn.prepare(&sql)?;
        check_tabulate_cancelled(cancelled)?;
        let mut rows = statement.query(params_from_iter(parameters))?;
        let mut values = Vec::new();
        while let Some(row) = rows.next()? {
            check_tabulate_cancelled(cancelled)?;
            let ordinal: u64 = row.get(0)?;
            let member_index = ordinal
                .checked_sub(start)
                .filter(|_| ordinal < end)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| AppError::Database("tabulate_invalid_ordinal".into()))?;
            for statistic_index in 0..definition.statistics.len() {
                values.push(TabulateSparseTotal {
                    member_index,
                    statistic_index: statistic_index as u32,
                    value: numeric_cell_value(row.get(statistic_index + 1)?)?,
                });
            }
        }
        check_tabulate_cancelled(cancelled)?;
        Ok(values)
    }

    pub(crate) fn query_tabulate_totals(
        &self,
        definition: &TabulateSessionRequest,
        session_id: &uuid::Uuid,
        request: &TabulateTotalsRequest,
        info: &PreparedTabulateSessionInfo,
        fingerprint: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<TabulateTotalsResult, AppError> {
        check_tabulate_cancelled(cancelled)?;
        if request.session_id != session_id.to_string()
            || request.source_generation != definition.source_generation
        {
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        self.validate_tabulate_session(definition)?;
        let mut values = self.query_tabulate_raw_totals(
            definition,
            session_id,
            &request.totals,
            info,
            cancelled,
        )?;
        let needs_grand = definition
            .statistics
            .iter()
            .any(|statistic| match statistic.kind {
                StatisticKind::RowPercentage => {
                    matches!(request.totals, TabulateTotalsKind::Columns { .. })
                }
                StatisticKind::ColumnPercentage => {
                    matches!(request.totals, TabulateTotalsKind::Rows { .. })
                }
                StatisticKind::TotalPercentage => {
                    !matches!(request.totals, TabulateTotalsKind::Grand)
                }
                _ => false,
            });
        let grand = if needs_grand && !values.is_empty() {
            self.query_tabulate_raw_totals(
                definition,
                session_id,
                &TabulateTotalsKind::Grand,
                info,
                cancelled,
            )?
        } else {
            Vec::new()
        };
        for value in &mut values {
            let kind = &definition.statistics[value.statistic_index as usize].kind;
            if is_tabulate_percentage(kind) {
                let self_total = matches!(request.totals, TabulateTotalsKind::Grand)
                    || matches!(
                        (&request.totals, kind),
                        (
                            TabulateTotalsKind::Rows { .. },
                            StatisticKind::RowPercentage
                        ) | (
                            TabulateTotalsKind::Columns { .. },
                            StatisticKind::ColumnPercentage
                        )
                    );
                let denominator = if self_total {
                    value.value
                } else {
                    grand
                        .get(value.statistic_index as usize)
                        .and_then(|total| total.value)
                };
                value.value = divide_or_null(value.value, denominator);
            }
        }
        check_tabulate_cancelled(cancelled)?;
        let mut result = TabulateTotalsResult {
            session_id: request.session_id.clone(),
            request_id: request.request_id.clone(),
            fingerprint: fingerprint.into(),
            source_generation: definition.source_generation,
            totals: request.totals.clone(),
            row_totals: Vec::new(),
            column_totals: Vec::new(),
            grand_totals: Vec::new(),
        };
        match request.totals {
            TabulateTotalsKind::Rows { .. } => result.row_totals = values,
            TabulateTotalsKind::Columns { .. } => result.column_totals = values,
            TabulateTotalsKind::Grand => {
                result.grand_totals = values.into_iter().map(|value| value.value).collect()
            }
        }
        Ok(result)
    }

    fn query_tabulate_member_slice(
        &self,
        table: &str,
        fields: &[String],
        column_types: &std::collections::HashMap<String, String>,
        start: u64,
        end: u64,
        total: u64,
    ) -> Result<TabulateMemberSlice, AppError> {
        let types = fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                column_types
                    .get(field)
                    .cloned()
                    .map(|data_type| (format!("dimension_{index}"), data_type))
                    .ok_or_else(|| AppError::InvalidParam("tabulate_stale_source".into()))
            })
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        let projection = (0..fields.len())
            .map(|index| {
                dimension_select_expression(&format!("dimension_{index}"), &types)
                    .map(|expression| format!(", {expression}"))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("");
        let sql = format!("SELECT ordinal{projection} FROM {} WHERE ordinal >= ? AND ordinal < ? ORDER BY ordinal", Self::quote_identifier(table));
        let upper = if end < total { end + 1 } else { end };
        let mut statement = self.conn.prepare(&sql)?;
        let mut rows = statement.query(params![start.saturating_sub(1), upper])?;
        let mut slice = TabulateMemberSlice::default();
        while let Some(row) = rows.next()? {
            let ordinal: u64 = row.get(0)?;
            let values = (0..fields.len())
                .map(|index| row.get::<_, Value>(index + 1).map(json_dimension_value))
                .collect::<Result<Vec<_>, _>>()?;
            if ordinal < start {
                slice.before = Some(values);
            } else if ordinal >= end {
                slice.after = Some(values);
            } else {
                slice.members.push(values);
            }
        }
        Ok(slice)
    }

    pub(crate) fn query_tabulate_window(
        &self,
        definition: &TabulateSessionRequest,
        session_id: &uuid::Uuid,
        request: &TabulateWindowRequest,
        info: &PreparedTabulateSessionInfo,
        fingerprint: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<TabulateWindowResult, AppError> {
        let check_cancelled = || {
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                Err(AppError::Cancelled("tabulate_cancelled".into()))
            } else {
                Ok(())
            }
        };
        check_cancelled()?;
        let (row_end, column_end) =
            Self::validate_tabulate_window_bounds(request, info, definition.statistics.len())?;
        if request.session_id != session_id.to_string()
            || request.source_generation != definition.source_generation
        {
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        self.validate_tabulate_session(definition)?;
        let (table_name, column_types) = self.validate_tabulate_fields(
            &definition.dataset_id,
            &definition.row_fields,
            &definition.column_fields,
            &definition.statistics,
        )?;
        let (row_table, column_table) = Self::tabulate_member_table_names(session_id);
        check_cancelled()?;
        let row_slice = self.query_tabulate_member_slice(
            &row_table,
            &definition.row_fields,
            &column_types,
            request.row_start,
            row_end,
            info.row_member_count,
        )?;
        check_cancelled()?;
        let column_slice = self.query_tabulate_member_slice(
            &column_table,
            &definition.column_fields,
            &column_types,
            request.column_start,
            column_end,
            info.column_member_count,
        )?;
        let mut cells = Vec::new();
        if !row_slice.members.is_empty() && !column_slice.members.is_empty() {
            let denominators = |kind: StatisticKind, totals: TabulateTotalsKind| {
                if definition
                    .statistics
                    .iter()
                    .any(|statistic| statistic.kind == kind)
                {
                    self.query_tabulate_raw_totals(definition, session_id, &totals, info, cancelled)
                        .map(|values| {
                            values
                                .into_iter()
                                .map(|value| {
                                    ((value.member_index, value.statistic_index), value.value)
                                })
                                .collect::<HashMap<_, _>>()
                        })
                } else {
                    Ok(HashMap::new())
                }
            };
            let row_totals = denominators(
                StatisticKind::RowPercentage,
                TabulateTotalsKind::Rows {
                    start: request.row_start,
                    count: request.row_count,
                },
            )?;
            let column_totals = denominators(
                StatisticKind::ColumnPercentage,
                TabulateTotalsKind::Columns {
                    start: request.column_start,
                    count: request.column_count,
                },
            )?;
            let grand_totals =
                denominators(StatisticKind::TotalPercentage, TabulateTotalsKind::Grand)?;
            let aggregates = definition
                .statistics
                .iter()
                .map(|statistic| {
                    aggregate_sql_for_field(
                        statistic,
                        &format!("source.{}", Self::quote_identifier(&statistic.field)),
                    )
                })
                .collect::<Result<Vec<_>, AppError>>()?
                .join(", ");
            let sql = format!(
                "WITH selected_rows AS (SELECT * FROM {} WHERE ordinal >= ? AND ordinal < ?),
                 selected_columns AS (SELECT * FROM {} WHERE ordinal >= ? AND ordinal < ?)
                 SELECT row_members.ordinal, column_members.ordinal, {aggregates}
                 FROM {} AS source
                 JOIN selected_rows AS row_members ON {}
                 JOIN selected_columns AS column_members ON {}
                 GROUP BY row_members.ordinal, column_members.ordinal
                 ORDER BY row_members.ordinal, column_members.ordinal",
                Self::quote_identifier(&row_table),
                Self::quote_identifier(&column_table),
                Self::quote_identifier(&table_name),
                Self::tabulate_member_join(&definition.row_fields, "row_members"),
                Self::tabulate_member_join(&definition.column_fields, "column_members"),
            );
            check_cancelled()?;
            let mut statement = self.conn.prepare(&sql)?;
            check_cancelled()?;
            let mut rows = statement.query(params![
                request.row_start,
                row_end,
                request.column_start,
                column_end
            ])?;
            while let Some(row) = rows.next()? {
                check_cancelled()?;
                let row_ordinal: u64 = row.get(0)?;
                let column_ordinal: u64 = row.get(1)?;
                let local_index = |ordinal: u64, start: u64, end: u64| {
                    ordinal
                        .checked_sub(start)
                        .filter(|_| ordinal < end)
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or_else(|| AppError::Database("tabulate_invalid_ordinal".into()))
                };
                let row_index = local_index(row_ordinal, request.row_start, row_end)?;
                let column_index = local_index(column_ordinal, request.column_start, column_end)?;
                for statistic_index in 0..definition.statistics.len() {
                    let value = numeric_cell_value(row.get(statistic_index + 2)?)?;
                    let denominator = match definition.statistics[statistic_index].kind {
                        StatisticKind::RowPercentage => {
                            Some(row_totals.get(&(row_index, statistic_index as u32)))
                        }
                        StatisticKind::ColumnPercentage => {
                            Some(column_totals.get(&(column_index, statistic_index as u32)))
                        }
                        StatisticKind::TotalPercentage => {
                            Some(grand_totals.get(&(0, statistic_index as u32)))
                        }
                        _ => None,
                    };
                    cells.push(TabulateSparseCell {
                        row_index,
                        column_index,
                        statistic_index: statistic_index as u32,
                        value: match denominator {
                            Some(total) => divide_or_null(value, total.copied().flatten()),
                            None => value,
                        },
                    });
                }
            }
        }
        check_cancelled()?;
        Ok(TabulateWindowResult {
            session_id: request.session_id.clone(),
            request_id: request.request_id.clone(),
            fingerprint: fingerprint.into(),
            source_generation: definition.source_generation,
            row_start: request.row_start,
            column_start: request.column_start,
            row_members: row_slice.members,
            column_members: column_slice.members,
            row_member_before: row_slice.before,
            row_member_after: row_slice.after,
            column_member_before: column_slice.before,
            column_member_after: column_slice.after,
            statistics: definition.statistics.clone(),
            cells,
            row_totals_ready: false,
            column_totals_ready: false,
            row_member_count: info.row_member_count,
            column_member_count: info.column_member_count,
        })
    }

    pub(crate) fn materialize_tabulate_table(
        &self,
        definition: &TabulateSessionRequest,
        session_id: &uuid::Uuid,
        request: &crate::models::tabulate::TabulateMaterializeRequest,
        before_commit: impl FnOnce(&Self) -> Result<(), AppError>,
    ) -> Result<DatasetMeta, AppError> {
        if request.session_id != session_id.to_string()
            || request.source_generation != definition.source_generation
            || request.statistic_labels.len() != definition.statistics.len()
            || request.statistic_labels.iter().any(|label| label.trim().is_empty())
        {
            return Err(AppError::InvalidParam("tabulate_invalid_materialization".into()));
        }
        crate::services::spprj_archive::validate_portable_basename(&request.destination_name, "Dataset name")
            .map_err(AppError::InvalidParam)?;
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let outcome = (|| {
            self.validate_tabulate_session(definition)?;
            self.validate_dataset_name(&request.destination_name, None)?;
            let (source_table, column_types) = self.validate_tabulate_fields(
                &definition.dataset_id, &definition.row_fields, &definition.column_fields, &definition.statistics,
            )?;
            let (row_table, column_table) = Self::tabulate_member_table_names(session_id);
            let mut names = Vec::new();
            let mut used = HashSet::from(["_row_id".to_string()]);
            let mut unique_name = |base: String| {
                let mut name = base.clone();
                let mut suffix = 2;
                while !used.insert(name.to_ascii_lowercase()) {
                    name = format!("{base} ({suffix})");
                    suffix += 1;
                }
                name
            };
            let mut parameters = Vec::<Value>::new();
            let mut projection = vec!["(members.ordinal + 1)::BIGINT AS \"_row_id\"".to_string()];
            for (index, field) in definition.row_fields.iter().enumerate() {
                let name = unique_name(field.clone());
                let types = HashMap::from([(format!("dimension_{index}"), column_types[field].clone())]);
                let expression = dimension_select_expression(&format!("dimension_{index}"), &types)?;
                let label = tabulate_dimension_sql_label(&expression, &column_types[field]);
                projection.push(format!("COALESCE({label}, ?) AS {}", Self::quote_identifier(&name)));
                parameters.push(Value::Text(request.missing_label.clone()));
                names.push((name, "VARCHAR"));
            }
            let member_types = definition.column_fields.iter().enumerate()
                .map(|(index, field)| (format!("dimension_{index}"), column_types[field].clone()))
                .collect::<HashMap<_, _>>();
            let member_projection = (0..definition.column_fields.len())
                .map(|index| dimension_select_expression(&format!("dimension_{index}"), &member_types).map(|value| format!(", {value}")))
                .collect::<Result<Vec<_>, _>>()?.join("");
            let mut statement = self.conn.prepare(&format!("SELECT ordinal{member_projection} FROM {} ORDER BY ordinal", Self::quote_identifier(&column_table)))?;
            let mut members = statement.query([])?;
            while let Some(member) = members.next()? {
                let ordinal: u64 = member.get(0)?;
                let labels = (0..definition.column_fields.len()).map(|index| {
                    member
                        .get::<_, Value>(index + 1)
                        .map(json_dimension_value)
                        .map(|value| tabulate_dimension_label(value, &request.missing_label))
                }).collect::<Result<Vec<_>, _>>()?;
                for (index, statistic) in definition.statistics.iter().enumerate() {
                    let mut parts = labels.clone();
                    parts.push(request.statistic_labels[index].clone());
                    parts.push(statistic.field.clone());
                    let name = unique_name(parts.join(" - "));
                    let raw = format!("MAX(cells.stat_{index}) FILTER (WHERE cells.column_ordinal = {ordinal})");
                    let value = if is_tabulate_percentage(&statistic.kind) {
                        let denominator = match statistic.kind {
                            StatisticKind::RowPercentage => format!("MAX(cells.row_total_{index})"),
                            StatisticKind::ColumnPercentage => format!("(SELECT MAX(column_total_{index}) FROM cells WHERE column_ordinal = {ordinal})"),
                            _ => format!("(SELECT MAX(grand_total_{index}) FROM cells)"),
                        };
                        format!("COALESCE({raw}, 0)::DOUBLE / NULLIF({denominator}, 0)")
                    } else if default_missing_value(&statistic.kind).is_some() {
                        format!("COALESCE({raw}, 0)::DOUBLE")
                    } else {
                        format!("CASE WHEN isfinite({raw}::DOUBLE) THEN {raw}::DOUBLE ELSE NULL END")
                    };
                    projection.push(format!("{value} AS {}", Self::quote_identifier(&name)));
                    names.push((name, "DOUBLE"));
                }
            }
            drop(members);
            drop(statement);
            let aggregates = definition.statistics.iter().enumerate().map(|(index, statistic)| {
                aggregate_sql_for_field(statistic, &format!("source.{}", Self::quote_identifier(&statistic.field)))
                    .map(|value| format!("{value} AS stat_{index}"))
            }).collect::<Result<Vec<_>, _>>()?.join(", ");
            let mut totals = Vec::new();
            for (index, statistic) in definition.statistics.iter().enumerate() {
                if is_tabulate_percentage(&statistic.kind) {
                    totals.push(format!("SUM(stat_{index}) OVER (PARTITION BY row_ordinal) AS row_total_{index}"));
                    totals.push(format!("SUM(stat_{index}) OVER (PARTITION BY column_ordinal) AS column_total_{index}"));
                    totals.push(format!("SUM(stat_{index}) OVER () AS grand_total_{index}"));
                }
            }
            let totals = if totals.is_empty() { String::new() } else { format!(", {}", totals.join(", ")) };
            let id = uuid::Uuid::new_v4().to_string();
            let output = Self::quote_identifier(&Self::internal_table_name(&id));
            let group_by = std::iter::once("members.ordinal".to_string())
                .chain((0..definition.row_fields.len()).map(|index| format!("members.dimension_{index}")))
                .collect::<Vec<_>>().join(", ");
            let sql = format!(
                "CREATE TABLE {output} AS WITH grouped AS (
                 SELECT row_members.ordinal AS row_ordinal, column_members.ordinal AS column_ordinal, {aggregates}
                 FROM {} AS source JOIN {} AS row_members ON {} JOIN {} AS column_members ON {}
                 GROUP BY row_members.ordinal, column_members.ordinal),
                 cells AS (SELECT *{totals} FROM grouped)
                 SELECT {} FROM {} AS members LEFT JOIN cells ON members.ordinal = cells.row_ordinal
                 GROUP BY {group_by} ORDER BY members.ordinal",
                Self::quote_identifier(&source_table), Self::quote_identifier(&row_table),
                Self::tabulate_member_join(&definition.row_fields, "row_members"),
                Self::quote_identifier(&column_table), Self::tabulate_member_join(&definition.column_fields, "column_members"),
                projection.join(", "), Self::quote_identifier(&row_table),
            );
            self.conn.execute(&sql, params_from_iter(parameters))?;
            for (index, (name, sql_type)) in names.iter().enumerate() {
                self.conn.execute("INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                    params![id, index as i32, name, sql_type])?;
            }
            self.conn.execute(&format!("INSERT INTO _meta_datasets (id, name, source_type, row_count, col_count) SELECT ?, ?, 'manual', count(*), ? FROM {output}"),
                params![id, request.destination_name, names.len() as i32])?;
            self.rebuild_natural_anchors(&id, 0)?;
            let meta = self.get_dataset_meta(&id)?;
            before_commit(self)?;
            let changed = self.conn.execute("UPDATE _meta_datasets SET generation = generation WHERE id = ? AND generation = ?",
                params![definition.dataset_id, definition.source_generation])
                .map_err(|_| AppError::InvalidParam("tabulate_stale_source".into()))?;
            if changed != 1 {
                return Err(AppError::InvalidParam("tabulate_stale_source".into()));
            }
            self.conn.execute_batch("COMMIT")?;
            Ok(meta)
        })();
        if outcome.is_err() {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
        outcome
    }

    pub fn tabulate(&self, request: &TabulateRequest) -> Result<TabulateResult, AppError> {
        let (table_name, column_types) = self.validate_tabulate_fields(
            &request.dataset_id, &request.row_fields, &request.column_fields, &request.statistics,
        )?;
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

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<DatasetMeta, AppError> {
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

            self.rebuild_natural_anchors(id, 0)?;

            self.get_dataset_meta(id)
        })();

        match result {
            Ok(meta) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(meta)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Get metadata for a single dataset
    pub fn get_dataset_meta(&self, id: &str) -> Result<DatasetMeta, AppError> {
        let meta = self.conn.query_row(
            "SELECT id, name, source_path, source_type, row_count, col_count, generation, created_at, updated_at FROM _meta_datasets WHERE id = $1",
            params![id],
            |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    generation: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        ).map_err(|error| match error {
            duckdb::Error::QueryReturnedNoRows => {
                AppError::InvalidParam(format!("unknown dataset: {id}"))
            }
            other => AppError::from(other),
        })?;
        Ok(meta)
    }

    /// List all datasets
    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, source_path, source_type, row_count, col_count, generation, created_at, updated_at
             FROM _meta_datasets WHERE substr(id, 1, 17) <> '__workflow_stage_' ORDER BY created_at DESC",
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
                    generation: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
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
        self.conn.execute(
            "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
            params![id],
        )?;
        self.conn.execute(
            "DELETE FROM _table_navigation_anchors WHERE dataset_id = $1",
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

            self.rebuild_natural_anchors(id, 0)?;

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
                let duckdb_value =
                    Self::json_scalar_to_duckdb_value(value, row_index + 1, column_index + 1)?;
                let validation_sql =
                    format!("SELECT {}", Self::typed_parameter_expression(column_type));
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

            self.rebuild_natural_anchors(id, 0)?;

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

        let order_clause = Self::build_table_window_order_clause(&request.sort, &allowed_columns)?;

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

    pub fn preflight_create_table_from_sql_query(
        &self,
        sql: &str,
        name: &str,
    ) -> Result<(), AppError> {
        let sql = self.validate_query_against_visible_tables(sql)?;
        let snapshot = self.build_isolated_snapshot_connection()?;
        let _ = self.collect_sql_query_schema(&snapshot, &sql)?;
        self.validate_dataset_name(name, None)?;
        Ok(())
    }

    pub fn query_table_navigation_window(
        &self,
        request: &TableNavigationRequest,
    ) -> Result<TableNavigationResult, AppError> {
        let started_at = Instant::now();
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

        let actual_user_columns = self.get_storage_user_columns(&request.dataset_id)?;
        let allowed_columns = actual_user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let (where_clause, filter_values) =
            Self::compile_table_window_filters(&request.filters, &allowed_columns)?;

        let order_clause = Self::build_table_window_order_clause(&request.sort, &allowed_columns)?;

        let navigation_columns =
            self.resolve_navigation_projection(&request.dataset_id, &request.column_ids)?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
        let count_sql = format!("SELECT COUNT(*) FROM {table_name} {where_clause}");
        let total_rows: i64 =
            self.conn
                .query_row(&count_sql, params_from_iter(filter_values.iter()), |row| {
                    row.get(0)
                })?;

        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["BIGINT".to_string()];
        columns.extend(navigation_columns.iter().map(|(name, _)| name.clone()));
        column_types.extend(
            navigation_columns
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

        let total_ms = u64::try_from(started_at.elapsed().as_millis())
            .map_err(|_| AppError::Database("table navigation timing overflowed".into()))?;

        Ok(TableNavigationResult {
            version: 1,
            request_id: request.request_id.clone(),
            dataset_id: request.dataset_id.clone(),
            generation,
            start: request.start,
            total_rows,
            total_rows_exact: true,
            session_id: request.session_id.clone(),
            columns,
            column_types,
            rows,
            timings: TableNavigationTimings {
                total_ms,
                diagnostic_json_encode_ms: None,
                diagnostic_json_bytes: None,
                diagnostic_response_ready_at_epoch_ms: None,
            },
        })
    }

    pub(crate) fn build_table_query_session_plan_on_connection(
        connection: &Connection,
        request: &TableQuerySessionRequest,
    ) -> Result<TableQuerySessionPlan, AppError> {
        let actual_user_columns =
            Self::storage_user_columns_on_connection(connection, &request.dataset_id)?;
        let allowed_columns = actual_user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let projection = Self::resolve_navigation_projection_on_connection(
            connection,
            &request.dataset_id,
            &request.column_ids,
        )?;
        let (where_clause, filter_values) =
            Self::compile_table_window_filters(&request.filters, &allowed_columns)?;
        let order_clause = Self::build_table_window_order_clause(&request.sort, &allowed_columns)?;
        Ok(TableQuerySessionPlan {
            projection,
            where_clause,
            filter_values,
            order_clause,
        })
    }

    pub(crate) fn prepare_table_query_session_on_connection(
        connection: &Connection,
        request: &TableQuerySessionRequest,
        mapping_table_name: &str,
        mapping_index_name: &str,
    ) -> Result<PreparedTableQuerySessionInfo, AppError> {
        let current_generation: i64 = connection
            .query_row(
                "SELECT generation FROM _meta_datasets WHERE id = ?",
                params![&request.dataset_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                duckdb::Error::QueryReturnedNoRows => {
                    AppError::InvalidParam(format!("unknown dataset: {}", request.dataset_id))
                }
                other => AppError::from(other),
            })?;
        let requested_generation = i64::try_from(request.generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        if current_generation != requested_generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {}",
                request.generation
            )));
        }

        let plan = Self::build_table_query_session_plan_on_connection(connection, request)?;
        Self::release_table_query_session_on_connection(
            connection,
            mapping_table_name,
            mapping_index_name,
        )?;
        let baseline_memory_bytes = Self::table_query_session_memory_bytes(connection);

        let materialize_result = (|| -> Result<PreparedTableQuerySessionInfo, AppError> {
            let mapping_table = Self::quote_identifier(mapping_table_name);
            let table_name =
                Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
            let create_sql = format!(
                "CREATE TEMP TABLE {mapping_table} AS
                 SELECT CAST(row_number() OVER ({order_clause}) - 1 AS BIGINT) AS ordinal,
                        CAST(\"_row_id\" AS BIGINT) AS row_id
                 FROM {table_name} {where_clause}",
                order_clause = plan.order_clause,
                where_clause = plan.where_clause,
            );
            connection.execute(&create_sql, params_from_iter(plan.filter_values.iter()))?;

            let total_rows: i64 = connection.query_row(
                &format!("SELECT COUNT(*) FROM {mapping_table}"),
                [],
                |row| row.get(0),
            )?;
            let mapping_index = Self::quote_identifier(mapping_index_name);
            connection.execute(
                &format!("CREATE INDEX {mapping_index} ON {mapping_table} (ordinal)"),
                [],
            )?;

            let logical_bytes_floor = Self::table_query_session_logical_bytes_floor(total_rows);
            let measured_bytes_estimate = match (
                baseline_memory_bytes,
                Self::table_query_session_memory_bytes(connection),
            ) {
                (Some(before_bytes), Some(after_bytes)) if after_bytes >= before_bytes => {
                    usize::try_from(after_bytes - before_bytes)
                        .ok()
                        .map(|delta| delta.max(logical_bytes_floor))
                        .unwrap_or(usize::MAX)
                }
                _ => logical_bytes_floor,
            };
            Ok(PreparedTableQuerySessionInfo {
                projection: plan.projection,
                total_rows,
                measured_bytes_estimate,
            })
        })();

        match materialize_result {
            Ok(info) => Ok(info),
            Err(error) => {
                let _ = Self::release_table_query_session_on_connection(
                    connection,
                    mapping_table_name,
                    mapping_index_name,
                );
                Err(error)
            }
        }
    }

    fn table_query_session_memory_bytes(connection: &Connection) -> Option<u64> {
        connection
            .query_row(
                "SELECT COALESCE(SUM(memory_usage_bytes + temporary_storage_bytes), 0) FROM duckdb_memory()",
                [],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .and_then(|bytes| u64::try_from(bytes).ok())
    }

    fn table_query_session_logical_bytes_floor(total_rows: i64) -> usize {
        usize::try_from(total_rows.max(0))
            .ok()
            .and_then(|row_count| row_count.checked_mul(std::mem::size_of::<i64>() * 2))
            .unwrap_or(usize::MAX)
    }

    pub(crate) fn query_prepared_table_navigation_window_on_connection(
        connection: &Connection,
        request: &TableNavigationRequest,
        mapping_table_name: &str,
        projection: &[(String, String)],
        total_rows: i64,
    ) -> Result<TableNavigationResult, AppError> {
        let started_at = Instant::now();
        if !(1..=2_000).contains(&request.count) {
            return Err(AppError::InvalidParam(
                "window count must be between 1 and 2000".into(),
            ));
        }

        let current_generation: i64 = connection
            .query_row(
                "SELECT generation FROM _meta_datasets WHERE id = ?",
                params![&request.dataset_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                duckdb::Error::QueryReturnedNoRows => {
                    AppError::InvalidParam(format!("unknown dataset: {}", request.dataset_id))
                }
                other => AppError::from(other),
            })?;
        let requested_generation = i64::try_from(request.generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        if current_generation != requested_generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {}",
                request.generation
            )));
        }

        let start = request.start.min(total_rows.max(0) as usize);
        let start_i64 = i64::try_from(start)
            .map_err(|_| AppError::InvalidParam("window start is too large".into()))?;
        let count_i64 = i64::try_from(request.count)
            .map_err(|_| AppError::InvalidParam("window count is too large".into()))?;
        let end_i64 = start_i64
            .checked_add(count_i64)
            .ok_or_else(|| AppError::InvalidParam("window end is too large".into()))?;

        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["BIGINT".to_string()];
        columns.extend(projection.iter().map(|(name, _)| name.clone()));
        column_types.extend(
            projection
                .iter()
                .map(|(_, column_type)| column_type.clone()),
        );

        let mapping_table = Self::quote_identifier(mapping_table_name);
        let source_alias = "source";
        let select_columns = columns
            .iter()
            .zip(column_types.iter())
            .map(|(column, column_type)| {
                let quoted = Self::quote_identifier(column);
                let qualified = format!("{source_alias}.{quoted}");
                let normalized_type = column_type.to_ascii_uppercase();
                if normalized_type.starts_with("DATE")
                    || normalized_type.starts_with("TIME")
                    || normalized_type.starts_with("INTERVAL")
                {
                    format!("CAST({qualified} AS VARCHAR) AS {quoted}")
                } else {
                    format!("{qualified} AS {quoted}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
        let query_sql = format!(
            "SELECT {select_columns}
             FROM {mapping_table} AS mapping
             JOIN {table_name} AS {source_alias} ON {source_alias}.\"_row_id\" = mapping.row_id
             WHERE mapping.ordinal >= ? AND mapping.ordinal < ?
             ORDER BY mapping.ordinal ASC"
        );
        let mut stmt = connection.prepare(&query_sql)?;
        let mut result_rows = stmt.query(params![start_i64, end_i64])?;
        let mut rows = Vec::with_capacity(request.count.min(total_rows.max(0) as usize));
        while let Some(row) = result_rows.next()? {
            let mut values = Vec::with_capacity(columns.len());
            for column_index in 0..columns.len() {
                values.push(Self::duckdb_value_to_json(row.get(column_index)?));
            }
            rows.push(values);
        }

        let total_ms = u64::try_from(started_at.elapsed().as_millis())
            .map_err(|_| AppError::Database("table navigation timing overflowed".into()))?;
        Ok(TableNavigationResult {
            version: 1,
            request_id: request.request_id.clone(),
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            start,
            total_rows,
            total_rows_exact: true,
            session_id: request.session_id.clone(),
            columns,
            column_types,
            rows,
            timings: TableNavigationTimings {
                total_ms,
                diagnostic_json_encode_ms: None,
                diagnostic_json_bytes: None,
                diagnostic_response_ready_at_epoch_ms: None,
            },
        })
    }

    pub(crate) fn release_table_query_session_on_connection(
        connection: &Connection,
        mapping_table_name: &str,
        mapping_index_name: &str,
    ) -> Result<(), AppError> {
        connection.execute(
            &format!(
                "DROP INDEX IF EXISTS {}",
                Self::quote_identifier(mapping_index_name)
            ),
            [],
        )?;
        connection.execute(
            &format!(
                "DROP TABLE IF EXISTS {}",
                Self::quote_identifier(mapping_table_name)
            ),
            [],
        )?;
        Ok(())
    }

    pub fn query_natural_navigation_window(
        connection: &Connection,
        request: &TableNavigationRequest,
    ) -> Result<TableNavigationResult, AppError> {
        let started_at = Instant::now();
        let (result, _) = Self::query_natural_navigation_window_inner(connection, request)?;
        let total_ms = u64::try_from(started_at.elapsed().as_millis())
            .map_err(|_| AppError::Database("table navigation timing overflowed".into()))?;
        Ok(TableNavigationResult {
            timings: TableNavigationTimings {
                total_ms,
                diagnostic_json_encode_ms: None,
                diagnostic_json_bytes: None,
                diagnostic_response_ready_at_epoch_ms: None,
            },
            ..result
        })
    }

    fn query_natural_navigation_window_inner(
        connection: &Connection,
        request: &TableNavigationRequest,
    ) -> Result<(TableNavigationResult, usize), AppError> {
        if !(1..=2_000).contains(&request.count) {
            return Err(AppError::InvalidParam(
                "window count must be between 1 and 2000".into(),
            ));
        }
        if request.sort.is_some() || !request.filters.is_empty() {
            return Err(AppError::InvalidParam(
                "natural navigation supports only unsorted, unfiltered requests".into(),
            ));
        }

        let generation_i64 = i64::try_from(request.generation)
            .map_err(|_| AppError::InvalidParam("dataset generation is too large".into()))?;
        let (total_rows, current_generation): (i64, i64) = connection
            .query_row(
                "SELECT row_count, generation FROM _meta_datasets WHERE id = ?",
                params![&request.dataset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| match error {
                duckdb::Error::QueryReturnedNoRows => {
                    AppError::InvalidParam(format!("unknown dataset: {}", request.dataset_id))
                }
                other => AppError::from(other),
            })?;
        if current_generation != generation_i64 {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {}",
                request.generation
            )));
        }

        let navigation_columns = Self::resolve_navigation_projection_on_connection(
            connection,
            &request.dataset_id,
            &request.column_ids,
        )?;
        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["BIGINT".to_string()];
        columns.extend(navigation_columns.iter().map(|(name, _)| name.clone()));
        column_types.extend(
            navigation_columns
                .iter()
                .map(|(_, column_type)| column_type.clone()),
        );

        let clamped_start = request.start.min(total_rows.max(0) as usize);
        let start_i64 = i64::try_from(clamped_start)
            .map_err(|_| AppError::InvalidParam("window start is too large".into()))?;
        let anchor: Option<(i64, i64)> = connection
            .query_row(
                "SELECT ordinal, row_id
                 FROM _table_navigation_anchors
                 WHERE dataset_id = ? AND generation = ? AND ordinal <= ?
                 ORDER BY ordinal DESC
                 LIMIT 1",
                params![&request.dataset_id, generation_i64, start_i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (anchor_ordinal, anchor_row_id) = match anchor {
            Some(anchor) => anchor,
            None if total_rows <= 0 => (0, i64::MAX),
            None => {
                return Err(AppError::Database(format!(
                    "natural navigation anchors are not ready for dataset {} generation {}",
                    request.dataset_id, request.generation
                )));
            }
        };
        let local_offset = usize::try_from(start_i64 - anchor_ordinal).map_err(|_| {
            AppError::Database("natural navigation local offset is negative".into())
        })?;
        if local_offset >= NATURAL_ANCHOR_STRIDE {
            return Err(AppError::Database(
                "natural navigation local offset exceeded anchor stride".into(),
            ));
        }

        let limit = i64::try_from(request.count)
            .map_err(|_| AppError::InvalidParam("window count is too large".into()))?;
        let offset = i64::try_from(local_offset)
            .map_err(|_| AppError::InvalidParam("window offset is too large".into()))?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
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
        let query_sql = Self::natural_navigation_viewport_sql(&table_name, &select_columns);
        let mut stmt = connection.prepare(&query_sql)?;
        let mut result_rows = stmt.query(params![anchor_row_id, limit, offset])?;
        let mut rows = Vec::with_capacity(request.count.min(total_rows.max(0) as usize));
        while let Some(row) = result_rows.next()? {
            let mut values = Vec::with_capacity(columns.len());
            for column_index in 0..columns.len() {
                values.push(Self::duckdb_value_to_json(row.get(column_index)?));
            }
            rows.push(values);
        }

        Ok((
            TableNavigationResult {
                version: 1,
                request_id: request.request_id.clone(),
                dataset_id: request.dataset_id.clone(),
                generation: request.generation,
                start: request.start,
                total_rows,
                total_rows_exact: true,
                session_id: request.session_id.clone(),
                columns,
                column_types,
                rows,
                timings: TableNavigationTimings {
                    total_ms: 0,
                    diagnostic_json_encode_ms: None,
                    diagnostic_json_bytes: None,
                    diagnostic_response_ready_at_epoch_ms: None,
                },
            },
            local_offset,
        ))
    }

    fn natural_navigation_viewport_sql(table_name: &str, select_columns: &str) -> String {
        format!(
            "SELECT {select_columns} FROM {table_name} WHERE \"_row_id\" >= ? ORDER BY \"_row_id\" ASC LIMIT ? OFFSET ?"
        )
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
    ) -> Result<Vec<TableFilterValue>, AppError> {
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
            "SELECT filter_value, row_count
             FROM (
                 SELECT COALESCE(CAST({column} AS VARCHAR), '') AS filter_value, COUNT(*) AS row_count
                 FROM {table}
                 WHERE strpos(lower(COALESCE(CAST({column} AS VARCHAR), '')), lower(?)) > 0
                 GROUP BY filter_value
             ) AS candidates
             ORDER BY lower(filter_value), filter_value
             LIMIT ?"
        );
        let limit = i64::try_from(limit)
            .map_err(|_| AppError::InvalidParam("filter value limit is too large".into()))?;
        let mut stmt = self.conn.prepare(&sql)?;
        let values = stmt
            .query_map(params![search, limit], |row| {
                Ok(TableFilterValue {
                    value: row.get(0)?,
                    row_count: row.get(1)?,
                })
            })?
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
            "SELECT {row_id_select}{projection} FROM ({}) AS __sp_graph_projection ORDER BY {}",
            plan.projection_sql,
            plan.order_by_sql,
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

        let y_column = role_to_column.get("y").cloned();

        let x_column = role_to_column.get("x").cloned();
        let group_column = role_to_column.get("group").cloned();
        let size_column = role_to_column.get("size").cloned();
        let z_column = role_to_column.get("z").cloned();
        let group_x_column = role_to_column.get("groupx").cloned();
        let group_y_column = role_to_column.get("groupy").cloned();
        let group_z_column = role_to_column.get("groupz").cloned();
        let wrap_column = role_to_column.get("wrap").cloned();
        let time_series = time_series_request(&request.elements)?;

        let mut multi_x_columns = request
            .fields
            .iter()
            .filter(|field| field.role.to_ascii_lowercase().starts_with("multix"))
            .map(|field| field.column.trim().to_string())
            .collect::<Vec<_>>();
        multi_x_columns.sort();
        multi_x_columns.dedup();

        let mut multi_y_columns = request
            .fields
            .iter()
            .filter(|field| field.role.to_ascii_lowercase().starts_with("multiy"))
            .map(|field| field.column.trim().to_string())
            .collect::<Vec<_>>();
        multi_y_columns.sort();
        multi_y_columns.dedup();

        if y_column.is_none() && multi_x_columns.is_empty() && multi_y_columns.is_empty() {
            return Err(AppError::InvalidParam(
                "graph request is missing role y".into(),
            ));
        }

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

        if let Some(column) = &y_column {
            validate_column(column)?;
        }
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
        for column in &multi_x_columns {
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

        let time_series_projection = if let Some(time_series_request) = time_series {
            let x_name = x_column.as_ref().ok_or_else(|| {
                AppError::InvalidParam("graph request is missing role x for time series".into())
            })?;
            let sql_type = allowed_columns
                .get(x_name.as_str())
                .copied()
                .ok_or_else(|| AppError::InvalidParam(format!("unknown graph column: {x_name}")))?;
            Some(validate_time_series_x(
                sql_type,
                &time_series_request.x_interpretation,
            )?)
        } else {
            None
        };

        let x_expr = if let (Some(column), Some(validated)) = (&x_column, time_series_projection) {
            validated.projection_sql(&Self::quote_identifier(column))
        } else {
            x_column
                .as_ref()
                .map(|column| Self::quote_identifier(column))
                .unwrap_or_else(|| "NULL".to_string())
        };
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

        let (source_sql, source_values, source_column_type) = if !multi_x_columns.is_empty() {
            let mut branches = Vec::with_capacity(multi_x_columns.len());
            let mut values = Vec::new();
            for column in &multi_x_columns {
                if let Some(bound_y) = &y_column {
                    branches.push(format!(
                        "SELECT \"_row_id\", CAST({x_col} AS DOUBLE) AS __sp_x, CAST({y_col} AS DOUBLE) AS __sp_y, {group_expr} AS __sp_group, {size_expr} AS __sp_size, CAST({z_expr} AS DOUBLE) AS __sp_z, {group_x_expr} AS __sp_groupx, {group_y_expr} AS __sp_groupy, {group_z_expr} AS __sp_groupz, {wrap_expr} AS __sp_wrap{strata_select}, ? AS {source_col} FROM {table_name} {where_clause}",
                        x_col = Self::quote_identifier(column),
                        y_col = Self::quote_identifier(bound_y),
                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                        strata_select = strata_select_sql,
                    ));
                    values.push(Value::Text(column.clone()));
                } else {
                    branches.push(format!(
                        "SELECT \"_row_id\", ? AS __sp_x, CAST({y_col} AS DOUBLE) AS __sp_y, {group_expr} AS __sp_group, {size_expr} AS __sp_size, CAST({z_expr} AS DOUBLE) AS __sp_z, {group_x_expr} AS __sp_groupx, {group_y_expr} AS __sp_groupy, {group_z_expr} AS __sp_groupz, {wrap_expr} AS __sp_wrap{strata_select}, ? AS {source_col} FROM {table_name} {where_clause}",
                        y_col = Self::quote_identifier(column),
                        source_col = Self::quote_identifier(GRAPH_VIRTUAL_SOURCE_COLUMN),
                        strata_select = strata_select_sql,
                    ));
                    values.push(Value::Text(column.clone()));
                    values.push(Value::Text(column.clone()));
                }
                values.extend(filter_values.iter().cloned());
            }
            (branches.join(" UNION ALL "), values, "VARCHAR".to_string())
        } else if !multi_y_columns.is_empty() {
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
                y_column.clone().ok_or_else(|| {
                    AppError::InvalidParam("graph request is missing role y".into())
                })?
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

        let multi_x_active = !multi_x_columns.is_empty();
        let multi_x_axis_mode = multi_x_active && y_column.is_none();
        let multi_x_merge_mode = multi_x_active && y_column.is_some();
        let multi_y_active = !multi_y_columns.is_empty();
        let melt_active = multi_x_active || multi_y_active;
        let time_series_active = time_series.is_some();
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

        let x_public = if time_series_active {
            x_column.clone().unwrap_or_else(|| "__sp_x".to_string())
        } else if multi_x_axis_mode {
            GRAPH_VIRTUAL_SOURCE_COLUMN.to_string()
        } else if multi_x_merge_mode {
            GRAPH_VIRTUAL_VALUE_COLUMN.to_string()
        } else {
            x_column.clone().unwrap_or_else(|| "__sp_x".to_string())
        };
        push_projected(
            format!("__sp_x AS {}", Self::quote_identifier(&x_public)),
            x_public,
            if time_series_active {
                "DOUBLE".to_string()
            } else if multi_x_axis_mode {
                "VARCHAR".to_string()
            } else if multi_x_merge_mode {
                "DOUBLE".to_string()
            } else {
                x_column
                    .as_ref()
                    .and_then(|column| allowed_columns.get(column.as_str()).copied())
                    .unwrap_or("VARCHAR")
                    .to_string()
            },
        );

        let y_public = if multi_x_axis_mode || multi_y_active {
            GRAPH_VIRTUAL_VALUE_COLUMN.to_string()
        } else {
            y_column
                .clone()
                .ok_or_else(|| AppError::InvalidParam("graph request is missing role y".into()))?
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

        let order_by_sql = match time_series.map(|request| request.order) {
            Some(GraphTimeSeriesOrder::TimeAscending) => {
                "\"__sp_x\" ASC NULLS LAST, \"_row_id\" ASC".to_string()
            }
            _ => "\"_row_id\" ASC".to_string(),
        };

        Ok(GraphQueryPlan {
            source_sql,
            source_values,
            projection_sql,
            projection_values,
            projection_select_items,
            projected_columns,
            projected_column_types,
            order_by_sql,
        })
    }

    pub fn collect_graph_aggregate_packets(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphAggregatePacket>, AppError> {
        let (packets, _cancelled) =
            self.collect_graph_aggregate_packets_with_cancel(request, || Ok(false))?;
        Ok(packets)
    }

    pub fn collect_graph_aggregate_packets_with_cancel<F>(
        &self,
        request: &GraphDataRequest,
        mut should_cancel: F,
    ) -> Result<(Vec<GraphAggregatePacket>, bool), AppError>
    where
        F: FnMut() -> Result<bool, AppError>,
    {
        if should_cancel()? {
            return Ok((Vec::new(), true));
        }

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

        let correlation_plan = self.resolve_correlation_request_plan(request, &allowed_columns)?;
        let exclusive_correlation = correlation_plan.is_some()
            && request
                .elements
                .iter()
                .all(|element| element.kind.eq_ignore_ascii_case("correlationMatrix"));

        if exclusive_correlation {
            let correlation_plan = correlation_plan.as_ref().ok_or_else(|| {
                AppError::InvalidParam(
                    "correlation matrix request is missing resolved bindings".to_string(),
                )
            })?;
            let packet = self.query_correlation_matrix_packet(
                request,
                &allowed_columns,
                correlation_plan,
                &mut should_cancel,
            )?;
            let Some(packet) = packet else {
                return Ok((Vec::new(), true));
            };
            return Ok((vec![GraphAggregatePacket::CorrelationMatrix(packet)], false));
        }

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
                "summary" | "points" | "line" | "normalcurve" => want_summary = true,
                _ => {}
            }
        }

        if !(want_histogram || want_heatmap || want_boxplot || want_summary) {
            if let Some(correlation_plan) = &correlation_plan {
                let packet = self.query_correlation_matrix_packet(
                    request,
                    &allowed_columns,
                    correlation_plan,
                    &mut should_cancel,
                )?;
                let Some(packet) = packet else {
                    return Ok((Vec::new(), true));
                };
                return Ok((vec![GraphAggregatePacket::CorrelationMatrix(packet)], false));
            }
            return Ok((Vec::new(), false));
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

        if let Some(correlation_plan) = &correlation_plan {
            let packet = self.query_correlation_matrix_packet(
                request,
                &allowed_columns,
                correlation_plan,
                &mut should_cancel,
            )?;
            let Some(packet) = packet else {
                return Ok((Vec::new(), true));
            };
            packets.push(GraphAggregatePacket::CorrelationMatrix(packet));
        }

        if should_cancel()? {
            return Ok((Vec::new(), true));
        }

        Ok((packets, false))
    }

    fn resolve_correlation_request_plan(
        &self,
        request: &GraphDataRequest,
        allowed_columns: &std::collections::HashMap<&str, &str>,
    ) -> Result<Option<CorrelationRequestPlan>, AppError> {
        let mut correlation_elements = request
            .elements
            .iter()
            .filter(|element| element.kind.eq_ignore_ascii_case("correlationMatrix"));
        let Some(correlation_element) = correlation_elements.next() else {
            return Ok(None);
        };
        if correlation_elements.next().is_some() {
            return Err(AppError::InvalidParam(
                "graph request can include only one correlationMatrix element".to_string(),
            ));
        }

        let mut prefix: Option<&str> = None;
        let mut bindings = Vec::<CorrelationRequestBinding>::new();
        for field in &request.fields {
            let role = field.role.trim().to_ascii_lowercase();
            let parsed_prefix = if role.starts_with("multix") {
                Some("multix")
            } else if role.starts_with("multiy") {
                Some("multiy")
            } else {
                None
            };
            let Some(parsed_prefix) = parsed_prefix else {
                continue;
            };

            match prefix {
                None => prefix = Some(parsed_prefix),
                Some(existing) if existing != parsed_prefix => {
                    return Err(AppError::InvalidParam(
                        "correlation matrix request cannot mix multiX* and multiY* roles"
                            .to_string(),
                    ));
                }
                _ => {}
            }

            let suffix_text = &role[parsed_prefix.len()..];
            let suffix = suffix_text.parse::<u32>().map_err(|_| {
                AppError::InvalidParam(format!(
                    "correlation role {} must end with a numeric suffix",
                    field.role
                ))
            })?;
            let column = field.column.trim();
            if column.is_empty() {
                return Err(AppError::InvalidParam(format!(
                    "graph field column must not be blank for role {}",
                    field.role
                )));
            }
            bindings.push(CorrelationRequestBinding {
                suffix,
                column: column.to_string(),
            });
        }

        if bindings.is_empty() {
            return Err(AppError::InvalidParam(
                "correlation matrix request requires multiX* or multiY* field bindings".to_string(),
            ));
        }

        bindings.sort_by_key(|binding| binding.suffix);

        for index in 1..bindings.len() {
            if bindings[index].suffix == bindings[index - 1].suffix {
                return Err(AppError::InvalidParam(format!(
                    "duplicate correlation binding index {}",
                    bindings[index].suffix
                )));
            }
        }

        for (expected, binding) in bindings.iter().enumerate() {
            let expected = u32::try_from(expected)
                .map_err(|_| AppError::InvalidParam("too many correlation bindings".to_string()))?;
            if binding.suffix != expected {
                return Err(AppError::InvalidParam(format!(
                    "correlation bindings must be contiguous starting at 0 (missing index {})",
                    expected
                )));
            }
        }

        if bindings.len() < 2 {
            return Err(AppError::InvalidParam(
                "correlation matrix requires at least 2 selected columns".to_string(),
            ));
        }
        if bindings.len() > 20 {
            return Err(AppError::InvalidParam(
                "correlation matrix supports at most 20 selected columns".to_string(),
            ));
        }

        let mut columns = Vec::with_capacity(bindings.len());
        let mut unique = std::collections::HashSet::with_capacity(bindings.len());
        for binding in bindings {
            if !unique.insert(binding.column.clone()) {
                return Err(AppError::InvalidParam(format!(
                    "duplicate correlation column binding: {}",
                    binding.column
                )));
            }

            let Some(column_type) = allowed_columns.get(binding.column.as_str()) else {
                return Err(AppError::InvalidParam(format!(
                    "unknown graph column: {}",
                    binding.column
                )));
            };
            if !is_numeric_type(column_type) {
                return Err(AppError::InvalidParam(format!(
                    "correlation matrix requires numeric columns: {}",
                    binding.column
                )));
            }
            columns.push(binding.column);
        }

        let method = correlation_element.correlation_method.ok_or_else(|| {
            AppError::InvalidParam(
                "correlationMatrix element must include correlationMethod".to_string(),
            )
        })?;

        Ok(Some(CorrelationRequestPlan { method, columns }))
    }

    fn query_correlation_matrix_packet<F>(
        &self,
        request: &GraphDataRequest,
        allowed_columns: &std::collections::HashMap<&str, &str>,
        correlation_plan: &CorrelationRequestPlan,
        should_cancel: &mut F,
    ) -> Result<Option<CorrelationMatrixPacket>, AppError>
    where
        F: FnMut() -> Result<bool, AppError>,
    {
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
        let (where_clause, filter_values) =
            Self::compile_table_window_filters(&request.filters, allowed_columns)?;

        let select_columns = correlation_plan
            .columns
            .iter()
            .map(|column| {
                let quoted = Self::quote_identifier(column);
                format!("CAST({quoted} AS DOUBLE) AS {quoted}")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let query_sql = format!(
            "SELECT {select_columns} FROM {table_name} {where_clause} ORDER BY \"_row_id\" ASC"
        );

        let mut per_column = vec![Vec::<Option<f64>>::new(); correlation_plan.columns.len()];
        let mut stmt = self.conn.prepare(&query_sql)?;
        let mut rows = stmt.query(params_from_iter(filter_values.iter()))?;
        while let Some(row) = rows.next()? {
            if should_cancel()? {
                return Ok(None);
            }
            for (index, values) in per_column.iter_mut().enumerate() {
                let value = row.get::<_, Value>(index)?;
                let numeric = numeric_cell_value(value)?;
                values.push(numeric.filter(|value| value.is_finite()));
            }
        }

        let method: StatisticalMethod = correlation_plan.method.into();
        let column_count = correlation_plan.columns.len();
        let mut pair_results = std::collections::HashMap::<
            (usize, usize),
            crate::engine::correlation::CorrelationResult,
        >::new();
        for left in 0..column_count {
            for right in left..column_count {
                if should_cancel()? {
                    return Ok(None);
                }
                let result = correlate(&per_column[left], &per_column[right], method);
                pair_results.insert((left, right), result);
            }
        }

        let mut cells = Vec::with_capacity(column_count * column_count);
        for y_index in 0..column_count {
            for x_index in 0..column_count {
                let key = (x_index.min(y_index), x_index.max(y_index));
                let result = pair_results.get(&key).ok_or_else(|| {
                    AppError::Database("missing pairwise correlation result".to_string())
                })?;
                cells.push(CorrelationMatrixCell {
                    x_index: u32::try_from(x_index)
                        .map_err(|_| AppError::InvalidParam("x index overflows u32".to_string()))?,
                    y_index: u32::try_from(y_index)
                        .map_err(|_| AppError::InvalidParam("y index overflows u32".to_string()))?,
                    coefficient: result.coefficient,
                    sample_count: result.sample_count,
                    unavailable_reason: result.failure.map(Into::into),
                });
            }
        }

        Ok(Some(CorrelationMatrixPacket {
            method: correlation_plan.method,
            columns: correlation_plan.columns.clone(),
            cells,
        }))
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

    pub(crate) fn compile_table_window_filters(
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

    fn build_table_window_order_clause(
        sort: &Option<crate::models::table::TableWindowSort>,
        allowed_columns: &std::collections::HashMap<&str, &str>,
    ) -> Result<String, AppError> {
        if let Some(sort) = sort {
            if sort.column != "_row_id" && !allowed_columns.contains_key(sort.column.as_str()) {
                return Err(AppError::InvalidParam(format!(
                    "unknown sort column: {}",
                    sort.column
                )));
            }
            let direction = if sort.descending { "DESC" } else { "ASC" };
            let sort_column = Self::quote_identifier(&sort.column);
            if sort.column == "_row_id" {
                Ok(format!("ORDER BY {sort_column} {direction}"))
            } else {
                Ok(format!(
                    "ORDER BY {sort_column} {direction}, \"_row_id\" ASC"
                ))
            }
        } else {
            Ok("ORDER BY \"_row_id\" ASC".to_string())
        }
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

    pub(crate) fn quote_identifier(name: &str) -> String {
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

    pub fn canonicalize_column_type_for_create(
        &self,
        column_type: &str,
    ) -> Result<String, AppError> {
        self.canonicalize_column_type(column_type)
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

    pub(crate) fn resolve_navigation_projection_on_connection(
        connection: &Connection,
        dataset_id: &str,
        column_ids: &[String],
    ) -> Result<Vec<(String, String)>, AppError> {
        let mut metadata_stmt = connection.prepare(
            "SELECT column_id, col_name, col_type FROM _meta_columns WHERE dataset_id = ? ORDER BY col_index",
        )?;
        let descriptors = metadata_stmt
            .query_map(params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut by_id = descriptors
            .iter()
            .map(|(column_id, name, column_type)| {
                (column_id.as_str(), (name.clone(), column_type.clone()))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let mut selected = Vec::with_capacity(column_ids.len());
        let mut seen = HashSet::new();
        for column_id in column_ids {
            if !seen.insert(column_id.as_str()) {
                return Err(AppError::InvalidParam(format!(
                    "duplicate navigation column id: {column_id}"
                )));
            }
            let column = by_id.remove(column_id.as_str()).ok_or_else(|| {
                AppError::InvalidParam(format!("unknown navigation column id: {column_id}"))
            })?;
            selected.push(column);
        }
        let table_name = Self::internal_table_name(dataset_id);
        let storage_columns = Self::storage_user_columns_on_connection(connection, dataset_id)?;
        let storage_by_name = storage_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        for (column_name, column_type) in &selected {
            let actual_type = storage_by_name.get(column_name.as_str()).ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "navigation projection column not found in storage table {table_name}: {column_name}"
                ))
            })?;
            if !actual_type.eq_ignore_ascii_case(column_type) {
                return Err(AppError::InvalidParam(format!(
                    "navigation projection column type mismatch for {column_name}: metadata {column_type}, storage {actual_type}"
                )));
            }
        }
        Ok(selected)
    }

    pub(crate) fn storage_user_columns_on_connection(
        connection: &Connection,
        dataset_id: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let table_name = Self::internal_table_name(dataset_id);
        let mut stmt = connection.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name <> '_row_id' ORDER BY ordinal_position",
        )?;
        Ok(stmt
            .query_map(params![table_name], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?)
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

    pub(crate) fn internal_table_name(id: &str) -> String {
        format!("dataset_{}", id.replace('-', "_"))
    }

    #[cfg(test)]
    pub(crate) fn natural_navigation_local_offset_for_test(
        &self,
        dataset_id: &str,
        generation: u64,
        start: usize,
    ) -> Result<usize, AppError> {
        let request = TableNavigationRequest {
            version: 1,
            request_id: "offset-test".to_string(),
            dataset_id: dataset_id.to_string(),
            generation,
            start,
            count: 1,
            column_ids: vec![],
            sort: None,
            filters: vec![],
            session_id: None,
            include_transport_diagnostics: false,
        };
        let (_, local_offset) = Self::query_natural_navigation_window_inner(&self.conn, &request)?;
        Ok(local_offset)
    }

    #[cfg(test)]
    pub(crate) fn explain_natural_navigation_window_for_test(
        connection: &Connection,
        request: &TableNavigationRequest,
    ) -> Result<String, AppError> {
        let navigation_columns = Self::resolve_navigation_projection_on_connection(
            connection,
            &request.dataset_id,
            &request.column_ids,
        )?;
        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["BIGINT".to_string()];
        columns.extend(navigation_columns.iter().map(|(name, _)| name.clone()));
        column_types.extend(
            navigation_columns
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
        let table_name = Self::quote_identifier(&Self::internal_table_name(&request.dataset_id));
        let sql = Self::natural_navigation_viewport_sql(&table_name, &select_columns);
        let mut statement = connection.prepare(&format!("EXPLAIN {sql}"))?;
        let mut rows = statement.query(params![0_i64, 1_i64, 0_i64])?;
        let mut lines = Vec::new();
        while let Some(row) = rows.next()? {
            let value: String = row.get(1)?;
            lines.push(value);
        }
        Ok(lines.join("\n"))
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

        for dataset in &filtered {
            let column_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset.id],
                |row| row.get(0),
            )?;
            if column_count == 0 {
                return Err(AppError::InvalidParam(format!(
                    "Dataset \"{}\" has no columns and cannot be exported",
                    dataset.name
                )));
            }
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
    pub fn import_sqlite<F, C>(
        &self,
        file_path: &str,
        on_progress: &F,
        is_cancelled: &C,
    ) -> Result<Vec<(String, DatasetMeta, usize)>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        self.import_selected_sqlite(file_path, &[], on_progress, is_cancelled)
    }

    pub fn import_selected_sqlite<F, C>(
        &self,
        file_path: &str,
        selections: &[(String, String, bool)],
        on_progress: &F,
        is_cancelled: &C,
    ) -> Result<Vec<(String, DatasetMeta, usize)>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        let connector = SqliteConnector::new(file_path);
        connector.test_connection()?;
        let source_description = std::path::Path::new(file_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::InvalidParam("SQLite file name is required".to_string()))?;
        let source_objects = connector.list_objects()?;
        let table_names = source_objects
            .iter()
            .filter(|object| object.object_type == "table")
            .map(|object| object.name.clone())
            .collect::<Vec<_>>();

        let imports: Vec<(String, String, bool)> = if selections.is_empty() {
            table_names
                .iter()
                .map(|name| (name.clone(), name.clone(), false))
                .collect()
        } else {
            selections.to_vec()
        };
        let mut plans = Vec::with_capacity(imports.len());
        for (source_name, target_name, append) in &imports {
            if !table_names.iter().any(|name| name == source_name) {
                return Err(AppError::InvalidParam(format!(
                    "SQLite table not found: {source_name}"
                )));
            }
            let columns = source_objects
                .iter()
                .find(|object| object.object_type == "table" && object.name == *source_name)
                .ok_or_else(|| {
                    AppError::InvalidParam(format!("SQLite table not found: {source_name}"))
                })?
                .columns
                .iter()
                .map(|column| (column.name.clone(), column.source_type.clone()))
                .collect::<Vec<_>>();

            if *append {
                let mut dataset_stmt = self.conn.prepare(
                    "SELECT id FROM _meta_datasets WHERE LOWER(name) = LOWER($1) LIMIT 1",
                )?;
                let mut rows = dataset_stmt.query(params![target_name])?;
                let target_id: String = rows
                    .next()?
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!(
                            "Append target dataset not found: {target_name}"
                        ))
                    })?
                    .get(0)?;
                drop(rows);
                drop(dataset_stmt);

                let mut column_stmt = self.conn.prepare(
                    "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
                )?;
                let target_columns: Vec<(String, String)> = column_stmt
                    .query_map(params![target_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                let source_columns = columns
                    .iter()
                    .map(|(name, sqlite_type)| {
                        (name.clone(), Self::map_sqlite_type(sqlite_type).to_string())
                    })
                    .collect::<Vec<_>>();
                if source_columns != target_columns {
                    return Err(AppError::InvalidParam(format!(
                        "Cannot append {source_name} to {target_name}: column names, order, and types must match"
                    )));
                }
                plans.push((
                    source_name.clone(),
                    target_name.clone(),
                    columns,
                    Some(target_id),
                ));
            } else {
                self.validate_dataset_name(target_name, None)?;
                plans.push((source_name.clone(), target_name.clone(), columns, None));
            }
        }

        let table_total = plans.len();
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let import_result = (|| -> Result<Vec<(String, DatasetMeta, usize)>, AppError> {
            let mut results = Vec::new();

            for (table_index, (src_table, target_name, columns, append_target_id)) in
                plans.iter().enumerate()
            {
                if is_cancelled() {
                    return Err(AppError::Cancelled("SQLite import cancelled".to_string()));
                }
                let id = append_target_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let table_name = format!("dataset_{}", id.replace('-', "_"));

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

                if append_target_id.is_none() {
                    self.conn.execute(
                        &format!(
                            "CREATE TABLE \"{}\" (\"_row_id\" BIGINT, {})",
                            table_name,
                            col_defs.join(", ")
                        ),
                        [],
                    )?;
                }

                // Determine target types for value conversion
                let col_types: Vec<&str> = columns
                    .iter()
                    .map(|(_, t)| Self::map_sqlite_type(t))
                    .collect();

                let col_count = columns.len();
                const BATCH_SIZE: usize = 1000;
                let total_rows = connector.row_count(src_table)?;
                let mut rows_done: usize = 0;
                on_progress(src_table, table_index, table_total, 0, total_rows);
                let starting_row_id: i64 = self.conn.query_row(
                    &format!(
                        "SELECT COALESCE(MAX(\"_row_id\"), 0) FROM {}",
                        Self::quote_identifier(&table_name)
                    ),
                    [],
                    |row| row.get(0),
                )?;
                {
                    let mut appender = self.conn.appender(&table_name)?;
                    connector.read_batches(src_table, BATCH_SIZE, &mut |batch| {
                        for row in batch.rows {
                            if is_cancelled() {
                                return Err(AppError::Cancelled(
                                    "SQLite import cancelled".to_string(),
                                ));
                            }
                            let row_id = starting_row_id
                                + i64::try_from(row.source_index).map_err(|_| {
                                    AppError::InvalidParam("SQLite row index overflow".to_string())
                                })?;
                            let mut values = Vec::with_capacity(col_count + 1);
                            values.push(Value::BigInt(row_id));
                            for (column_index, (target_type, source_value)) in
                                col_types.iter().zip(row.values).enumerate()
                            {
                                let value = Self::convert_sqlite_value(
                                    source_value,
                                    target_type,
                                    src_table,
                                    &columns[column_index].0,
                                    row.source_index,
                                )?;
                                values.push(value);
                            }
                            appender.append_row(appender_params_from_iter(values))?;
                            rows_done += 1;
                        }
                        appender.flush()?;
                        on_progress(src_table, table_index, table_total, rows_done, total_rows);
                        Ok(())
                    })?;
                    appender.flush()?;
                }

                // Get row count
                let row_count: i64 = self.conn.query_row(
                    &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                    [],
                    |row| row.get(0),
                )?;

                if append_target_id.is_some() {
                    self.conn.execute(
                    "UPDATE _meta_datasets SET row_count = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                    params![row_count, id],
                )?;
                    self.bump_dataset_generation(&id)?;
                    let generation = self.get_dataset_generation(&id)?;
                    self.rebuild_natural_anchors(&id, generation)?;
                } else {
                    let col_count_i32 = columns.len() as i32;
                    for (col_index, (col_name, sqlite_type)) in columns.iter().enumerate() {
                        let duckdb_type = Self::map_sqlite_type(sqlite_type);
                        self.conn.execute(
                        "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                        params![id, col_index as i32, col_name, duckdb_type],
                    )?;
                    }
                    self.conn.execute(
                    "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'sqlite', $4, $5)",
                    params![id, target_name, source_description, row_count, col_count_i32],
                )?;
                    self.rebuild_natural_anchors(&id, 0)?;
                }

                let meta = self.get_dataset_meta(&id)?;
                results.push((src_table.clone(), meta, rows_done));
            }

            Ok(results)
        })();

        match import_result {
            Ok(results) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(results)
            }
            Err(error) => {
                let rollback_result = self.conn.execute_batch("ROLLBACK");
                if let Err(rollback_error) = rollback_result {
                    return Err(AppError::Database(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )));
                }
                Err(error)
            }
        }
    }

    pub fn import_server_snapshot<F, C>(
        &self,
        connector: &ServerConnector,
        object: &SourceObjectRef,
        target_name: &str,
        source_description: &str,
        on_progress: &F,
        is_cancelled: &C,
    ) -> Result<(DatasetMeta, usize), AppError>
    where
        F: Fn(usize, usize),
        C: Fn() -> bool,
    {
        self.validate_dataset_name(target_name, None)?;
        let columns = connector
            .schema(object)
            .map_err(|error| AppError::Database(error.message))?;
        if columns.is_empty() {
            return Err(AppError::InvalidParam(
                "Database object must contain at least one column".to_string(),
            ));
        }
        let total_rows = connector
            .row_count(object)
            .map_err(|error| AppError::Database(error.message))?;
        let id = uuid::Uuid::new_v4().to_string();
        let table_name = format!("dataset_{}", id.replace('-', "_"));
        let column_types = columns
            .iter()
            .map(|column| {
                if connector.source_type() == "mysql" {
                    Self::map_mysql_type(&column.source_type)
                } else {
                    Self::map_postgres_type(&column.source_type)
                }
            })
            .collect::<Vec<_>>();
        let column_definitions = columns
            .iter()
            .zip(&column_types)
            .map(|(column, target_type)| {
                format!("{} {target_type}", Self::quote_identifier(&column.name))
            })
            .collect::<Vec<_>>();

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let import_result = (|| -> Result<(DatasetMeta, usize), AppError> {
            self.conn.execute(
                &format!(
                    "CREATE TABLE {} (\"_row_id\" BIGINT, {})",
                    Self::quote_identifier(&table_name),
                    column_definitions.join(", ")
                ),
                [],
            )?;
            let mut rows_done = 0_usize;
            on_progress(0, total_rows);
            {
                let mut appender = self.conn.appender(&table_name)?;
                connector.read_batches(object, 1000, &mut |batch| {
                    for row in batch.rows {
                        if is_cancelled() {
                            return Err(AppError::Cancelled(
                                "Database import cancelled".to_string(),
                            ));
                        }
                        let row_id = i64::try_from(row.source_index).map_err(|_| {
                            AppError::InvalidParam("Database row index is out of range".to_string())
                        })?;
                        let mut values = Vec::with_capacity(columns.len() + 1);
                        values.push(Value::BigInt(row_id));
                        for (column_index, (target_type, source_value)) in
                            column_types.iter().zip(row.values).enumerate()
                        {
                            values.push(Self::convert_postgres_value(
                                source_value,
                                target_type,
                                &object.name,
                                &columns[column_index].name,
                                row.source_index,
                            )?);
                        }
                        appender.append_row(appender_params_from_iter(values))?;
                        rows_done += 1;
                    }
                    appender.flush()?;
                    on_progress(rows_done, total_rows);
                    Ok(())
                })?;
                appender.flush()?;
            }

            let row_count = i64::try_from(rows_done).map_err(|_| {
                AppError::InvalidParam("Database row count is out of range".to_string())
            })?;
            for (column_index, (column, target_type)) in
                columns.iter().zip(&column_types).enumerate()
            {
                let column_index = i32::try_from(column_index).map_err(|_| {
                    AppError::InvalidParam("Database column count is out of range".to_string())
                })?;
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, column_index, column.name, target_type],
                )?;
            }
            let column_count = i32::try_from(columns.len()).map_err(|_| {
                AppError::InvalidParam("Database column count is out of range".to_string())
            })?;
            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, $4, $5, $6)",
                params![id, target_name, source_description, connector.source_type(), row_count, column_count],
            )?;
            self.rebuild_natural_anchors(&id, 0)?;
            Ok((self.get_dataset_meta(&id)?, rows_done))
        })();

        match import_result {
            Ok(result) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(result)
            }
            Err(error) => {
                let rollback_result = self.conn.execute_batch("ROLLBACK");
                if let Err(rollback_error) = rollback_result {
                    return Err(AppError::Database(format!(
                        "{error}; rollback failed: {rollback_error}"
                    )));
                }
                Err(error)
            }
        }
    }

    fn map_mysql_type(source_type: &str) -> &'static str {
        let source_type = source_type.to_ascii_lowercase();
        let base = source_type.split(['(', ' ']).next().unwrap_or("");
        match base {
            "bigint" if source_type.contains("unsigned") => "VARCHAR",
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" => {
                "BIGINT"
            }
            "float" | "double" | "real" => "DOUBLE",
            "tinyblob" | "blob" | "mediumblob" | "longblob" | "binary" | "varbinary" | "bit" => {
                "BLOB"
            }
            _ => "VARCHAR",
        }
    }

    fn map_postgres_type(source_type: &str) -> &'static str {
        match source_type.to_ascii_lowercase().as_str() {
            "smallint" | "integer" | "bigint" | "smallserial" | "serial" | "bigserial"
            | "boolean" => "BIGINT",
            "real" | "double precision" | "numeric" | "decimal" | "money" => "DOUBLE",
            "bytea" => "BLOB",
            _ => "VARCHAR",
        }
    }

    fn convert_postgres_value(
        value: ConnectorValue,
        target_type: &str,
        source_object: &str,
        source_column: &str,
        source_row: usize,
    ) -> Result<Value, AppError> {
        let conversion_error = |value: &str| {
            AppError::InvalidParam(format!(
                "Cannot convert value '{value}' in database object '{source_object}', column '{source_column}', row {source_row} to {target_type}"
            ))
        };
        match (target_type, value) {
            (_, ConnectorValue::Null) => Ok(Value::Null),
            ("BIGINT", ConnectorValue::Integer(value)) => Ok(Value::BigInt(value)),
            ("BIGINT", ConnectorValue::Real(value))
                if value.is_finite() && value.fract() == 0.0 =>
            {
                Ok(Value::BigInt(value as i64))
            }
            ("BIGINT", ConnectorValue::Text(value)) => value
                .parse::<i64>()
                .map(Value::BigInt)
                .map_err(|_| conversion_error(&value)),
            ("DOUBLE", ConnectorValue::Integer(value)) => Ok(Value::Double(value as f64)),
            ("DOUBLE", ConnectorValue::Real(value)) if value.is_finite() => {
                Ok(Value::Double(value))
            }
            ("DOUBLE", ConnectorValue::Text(value)) => value
                .parse::<f64>()
                .ok()
                .filter(|parsed| parsed.is_finite())
                .map(Value::Double)
                .ok_or_else(|| conversion_error(&value)),
            ("BLOB", ConnectorValue::Blob(value)) => Ok(Value::Blob(value)),
            ("BLOB", ConnectorValue::Text(value)) => Self::decode_postgres_bytea(&value)
                .map(Value::Blob)
                .ok_or_else(|| conversion_error("<BYTEA>")),
            (_, ConnectorValue::Integer(value)) => Ok(Value::Text(value.to_string())),
            (_, ConnectorValue::Real(value)) => Ok(Value::Text(value.to_string())),
            (_, ConnectorValue::Text(value)) => Ok(Value::Text(value)),
            (_, ConnectorValue::Blob(value)) => Ok(Value::Blob(value)),
        }
    }

    fn decode_postgres_bytea(value: &str) -> Option<Vec<u8>> {
        let hex = value.strip_prefix("\\x")?;
        if hex.len() % 2 != 0 {
            return None;
        }
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
            .collect()
    }

    /// Map SQLite column type to DuckDB type, keeping date/time types as VARCHAR
    fn map_sqlite_type(sqlite_type: &str) -> &'static str {
        let upper = sqlite_type.to_uppercase();
        if upper.contains("BLOB") {
            "BLOB"
        } else if upper.contains("INT") || upper.contains("BOOL") {
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

    fn convert_sqlite_value(
        value: ConnectorValue,
        target_type: &str,
        source_table: &str,
        source_column: &str,
        source_row: usize,
    ) -> Result<Value, AppError> {
        let conversion_error = |value: &str| {
            AppError::InvalidParam(format!(
                "Cannot convert value '{value}' in SQLite table '{source_table}', column '{source_column}', row {source_row} to {target_type}"
            ))
        };
        match (target_type, value) {
            (_, ConnectorValue::Null) => Ok(Value::Null),
            ("BLOB", ConnectorValue::Blob(value)) => Ok(Value::Blob(value)),
            ("BLOB", ConnectorValue::Text(value)) => Ok(Value::Blob(value.into_bytes())),
            ("BLOB", ConnectorValue::Integer(value)) => {
                Ok(Value::Blob(value.to_string().into_bytes()))
            }
            ("BLOB", ConnectorValue::Real(value)) => {
                Ok(Value::Blob(value.to_string().into_bytes()))
            }
            (_, ConnectorValue::Blob(value)) => {
                Err(conversion_error(&format!("<BLOB: {} bytes>", value.len())))
            }
            ("BIGINT", ConnectorValue::Integer(value)) => Ok(Value::BigInt(value)),
            ("BIGINT", ConnectorValue::Real(value))
                if value.is_finite()
                    && value.fract() == 0.0
                    && value >= i64::MIN as f64
                    && value <= i64::MAX as f64 =>
            {
                Ok(Value::BigInt(value as i64))
            }
            ("BIGINT", ConnectorValue::Real(value)) => Err(conversion_error(&value.to_string())),
            ("BIGINT", ConnectorValue::Text(value)) => value
                .trim()
                .parse::<i64>()
                .map(Value::BigInt)
                .map_err(|_| conversion_error(&value)),
            ("DOUBLE", ConnectorValue::Integer(value)) => Ok(Value::Double(value as f64)),
            ("DOUBLE", ConnectorValue::Real(value)) if value.is_finite() => {
                Ok(Value::Double(value))
            }
            ("DOUBLE", ConnectorValue::Real(value)) => Err(conversion_error(&value.to_string())),
            ("DOUBLE", ConnectorValue::Text(value)) => value
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|parsed| parsed.is_finite())
                .map(Value::Double)
                .ok_or_else(|| conversion_error(&value)),
            (_, ConnectorValue::Integer(value)) => Ok(Value::Text(value.to_string())),
            (_, ConnectorValue::Real(value)) => Ok(Value::Text(value.to_string())),
            (_, ConnectorValue::Text(value)) => Ok(Value::Text(value)),
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

        for dataset in &filtered {
            let column_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset.id],
                |row| row.get(0),
            )?;
            if column_count == 0 {
                return Err(AppError::InvalidParam(format!(
                    "Dataset \"{}\" has no columns and cannot be exported",
                    dataset.name
                )));
            }
        }

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
        self.rebuild_natural_anchors(id, 0)?;

        self.get_dataset_meta(id)
    }

    /// Add an empty row to a dataset, returns the new row_id
    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            let row_id = engine.add_row_inner(dataset_id)?;
            Ok(TableMutationEffects {
                value: row_id,
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
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
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            let row_ids = engine.add_rows_inner(dataset_id, count_i64)?;
            Ok(TableMutationEffects {
                value: row_ids,
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn add_row_inner(&self, dataset_id: &str) -> Result<i64, AppError> {
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
    }

    pub(crate) fn add_rows_inner(
        &self,
        dataset_id: &str,
        count_i64: i64,
    ) -> Result<Vec<i64>, AppError> {
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
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
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, Some(expected_generation), |engine| {
            engine.apply_added_rows_inner(dataset_id, &unique_ids, undo)?;
            let next_generation = engine
                .get_dataset_generation(dataset_id)?
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
            Ok(TableMutationEffects {
                value: next_generation,
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn apply_added_rows_inner(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
        undo: bool,
    ) -> Result<(), AppError> {
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        for chunk in row_ids.chunks(1_000) {
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
                    &format!("SELECT COUNT(*) FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
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
        Ok(())
    }

    /// Update a cell value
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        self.update_cells_if_generation(
            dataset_id,
            &[CellUpdate {
                row_id,
                column_name: column_name.to_string(),
                value: if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                },
            }],
            None,
        )
        .map(|_| ())
    }

    pub(crate) fn apply_cell_updates_inner(
        &self,
        dataset_id: &str,
        updates: &[CellUpdate],
    ) -> Result<(), AppError> {
        const MAX_CELLS: usize = 100_000;
        if updates.is_empty() {
            return Ok(());
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
        Ok(())
    }

    pub fn clear_cells(&self, dataset_id: &str, cells: &[CellPosition]) -> Result<(), AppError> {
        if cells.is_empty() {
            return Ok(());
        }
        let changed_column_ids = self.resolve_column_ids_by_name(
            dataset_id,
            cells.iter().map(|cell| cell.column_name.as_str()),
        )?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.clear_cells_inner(dataset_id, cells)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
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
        if updates.is_empty() {
            return self.get_dataset_generation(dataset_id);
        }
        let changed_column_ids = self.resolve_column_ids_by_name(
            dataset_id,
            updates.iter().map(|update| update.column_name.as_str()),
        )?;
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            engine.apply_cell_updates_inner(dataset_id, updates)?;
            let next_generation = engine
                .get_dataset_generation(dataset_id)?
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
            Ok(TableMutationEffects {
                value: next_generation,
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn clear_cells_inner(
        &self,
        dataset_id: &str,
        cells: &[CellPosition],
    ) -> Result<(), AppError> {
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
    }

    pub(crate) fn resolve_column_ids_by_name<'a>(
        &self,
        dataset_id: &str,
        column_names: impl IntoIterator<Item = &'a str>,
    ) -> Result<BTreeSet<String>, AppError> {
        let descriptors = self.get_user_column_descriptors(dataset_id)?;
        let ids_by_name = descriptors
            .into_iter()
            .map(|column| (column.name, column.column_id))
            .collect::<BTreeMap<_, _>>();
        let mut changed_column_ids = BTreeSet::new();
        for column_name in column_names {
            let column_id = ids_by_name
                .get(column_name)
                .ok_or_else(|| AppError::InvalidParam(format!("unknown column: {column_name}")))?;
            changed_column_ids.insert(column_id.clone());
        }
        Ok(changed_column_ids)
    }

    /// Delete a row by row_id
    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.delete_rows_inner(dataset_id, &[row_id])?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
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
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.delete_rows_inner(dataset_id, &unique_row_ids)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn delete_rows_inner(
        &self,
        dataset_id: &str,
        row_ids: &[i64],
    ) -> Result<(), AppError> {
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let placeholders = std::iter::repeat_n("?", row_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        self.conn.execute(
            &format!("DELETE FROM {table} WHERE \"_row_id\" IN ({placeholders})"),
            params_from_iter(row_ids.iter()),
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
    }

    pub(crate) fn all_user_column_ids(
        &self,
        dataset_id: &str,
    ) -> Result<BTreeSet<String>, AppError> {
        self.get_user_column_descriptors(dataset_id).map(|columns| {
            columns
                .into_iter()
                .map(|column| column.column_id)
                .collect::<BTreeSet<_>>()
        })
    }

    pub(crate) fn reject_calculated_column_writes<'a>(
        &self,
        dataset_id: &str,
        column_names: impl IntoIterator<Item = &'a str>,
    ) -> Result<(), AppError> {
        let calculated_names = self.calculated_column_names(dataset_id)?;
        if let Some(column_name) = column_names
            .into_iter()
            .find(|column_name| calculated_names.contains(*column_name))
        {
            return Err(AppError::InvalidParam(format!(
                "calculated output column is read-only until convert to values: {column_name}"
            )));
        }
        Ok(())
    }

    pub(crate) fn reject_calculated_dependency_removals<'a>(
        &self,
        dataset_id: &str,
        column_names: impl IntoIterator<Item = &'a str>,
    ) -> Result<(), AppError> {
        let requested_names = column_names
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let descriptors_by_name = self
            .get_user_column_descriptors(dataset_id)?
            .into_iter()
            .map(|column| (column.name.clone(), column))
            .collect::<BTreeMap<_, _>>();
        let requested_ids = requested_names
            .iter()
            .filter_map(|name| {
                descriptors_by_name
                    .get(name)
                    .map(|column| (name.as_str(), column.column_id.as_str()))
            })
            .collect::<Vec<_>>();
        if requested_ids.is_empty() {
            return Ok(());
        }
        let requested_id_set = requested_ids
            .iter()
            .map(|(_, column_id)| *column_id)
            .collect::<BTreeSet<_>>();

        for calculated in self
            .get_archived_calculated_columns_by_id(dataset_id)?
            .values()
        {
            let ArchivedCalculatedColumn::Ready { definition, .. } = calculated else {
                continue;
            };
            if requested_id_set.contains(definition.output_column_id.as_str()) {
                continue;
            }
            if let Some((column_name, _)) = requested_ids.iter().find(|(_, column_id)| {
                definition
                    .dependency_column_ids
                    .iter()
                    .any(|dependency| dependency == *column_id)
            }) {
                let dependent_name = descriptors_by_name
                    .values()
                    .find(|column| column.column_id == definition.output_column_id)
                    .map(|column| column.name.as_str())
                    .unwrap_or(definition.output_column_id.as_str());
                return Err(AppError::InvalidParam(format!(
                    "cannot delete column {column_name} because calculated dependency {dependent_name} depends on it"
                )));
            }
        }

        Ok(())
    }

    pub(crate) fn reject_calculated_column_range_writes(
        &self,
        dataset_id: &str,
        start_col: usize,
        width: usize,
    ) -> Result<(), AppError> {
        if width == 0 {
            return Ok(());
        }
        let descriptors = self.get_user_column_descriptors(dataset_id)?;
        let end = start_col
            .checked_add(width)
            .ok_or_else(|| AppError::InvalidParam("column range is too large".into()))?;
        let target_names = descriptors
            .get(start_col..end.min(descriptors.len()))
            .into_iter()
            .flatten()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>();
        self.reject_calculated_column_writes(dataset_id, target_names)
    }

    pub(crate) fn column_ids_in_range(
        &self,
        dataset_id: &str,
        start_col: usize,
        width: usize,
    ) -> Result<BTreeSet<String>, AppError> {
        if width == 0 {
            return Ok(BTreeSet::new());
        }
        let descriptors = self.get_user_column_descriptors(dataset_id)?;
        let end = start_col
            .checked_add(width)
            .ok_or_else(|| AppError::InvalidParam("column range is too large".into()))?;
        let slice = descriptors
            .get(start_col..end)
            .ok_or_else(|| AppError::Database("paste column allocation was incomplete".into()))?;
        Ok(slice
            .iter()
            .map(|column| column.column_id.clone())
            .collect())
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
        self.add_column_inner(dataset_id, col_name, col_type)?;
        self.bump_dataset_generation(dataset_id)?;
        Ok(())
    }

    pub(crate) fn add_column_inner(
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
        let names: Vec<String> = {
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

        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.reorder_column_inner(dataset_id, from, to)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: Some(BTreeSet::new()),
            })
        })
    }

    pub(crate) fn reorder_column_inner(
        &self,
        dataset_id: &str,
        from: i32,
        to: i32,
    ) -> Result<(), AppError> {
        let mut names: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )?;
            stmt.query_map(params![dataset_id], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect()
        };
        let n = names.len() as i32;

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

        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, Some(expected_generation), |engine| {
            engine.reorder_column_inner(dataset_id, from, to)?;
            let generation = engine.get_dataset_generation(dataset_id)? + 1;
            Ok(TableMutationEffects {
                value: generation,
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: Some(BTreeSet::new()),
            })
        })
    }

    /// Delete a column from a dataset
    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        self.reject_calculated_dependency_removals(dataset_id, [col_name])?;
        let changed_column_ids = self.resolve_column_ids_by_name(dataset_id, [col_name])?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.delete_column_inner(dataset_id, col_name)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn delete_column_inner(
        &self,
        dataset_id: &str,
        col_name: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table_name, col_name
            ),
            [],
        )?;

        let del_idx: i32 = self.conn.query_row(
            "SELECT col_index FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
            |row| row.get(0),
        )?;

        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = $1 AND col_index > $2",
            params![dataset_id, del_idx],
        )?;

        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count - 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Rename a column
    pub fn rename_column(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let changed_column_ids = self.resolve_column_ids_by_name(dataset_id, [old_name])?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.rename_column_inner(dataset_id, old_name, new_name)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: Some(BTreeSet::new()),
            })
        })
    }

    pub(crate) fn rename_column_inner(
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
        Ok(())
    }

    pub fn change_column_type(
        &self,
        dataset_id: &str,
        col_name: &str,
        new_type: &str,
    ) -> Result<(), AppError> {
        self.reject_calculated_column_writes(dataset_id, [col_name])?;
        let changed_column_ids = self.resolve_column_ids_by_name(dataset_id, [col_name])?;
        execute_table_mutation(self, dataset_id, None, |engine| {
            engine.change_column_type_inner(dataset_id, col_name, new_type)?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    pub(crate) fn change_column_type_inner(
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
        self.reject_calculated_column_range_writes(
            dataset_id,
            start_col,
            rows.iter().map(Vec::len).max().unwrap_or(0),
        )?;
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            engine.paste_at_position_inner(
                dataset_id,
                &table_name,
                start_row,
                start_col,
                rows,
                header_names,
                new_col_types,
            )?;
            let changed_column_ids = engine.column_ids_in_range(
                dataset_id,
                start_col,
                rows.iter().map(Vec::len).max().unwrap_or(0),
            )?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids,
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
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
        let paste_column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
        start_col
            .checked_add(paste_column_count)
            .ok_or_else(|| AppError::InvalidParam("Paste column range is too large".into()))?;
        self.reject_calculated_column_range_writes(dataset_id, start_col, paste_column_count)?;
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let change_set_id = uuid::Uuid::new_v4().to_string();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            engine.paste_at_position_inner(
                dataset_id,
                &table_name,
                start_row,
                start_col,
                rows,
                header_names,
                new_col_types,
            )?;
            let changed_column_ids =
                engine.column_ids_in_range(dataset_id, start_col, paste_column_count)?;
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids,
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
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
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let changed_column_ids = self.all_user_column_ids(dataset_id)?;
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            engine.delete_rows_inner(dataset_id, &unique_ids)?;
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
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
        let change_set_id = uuid::Uuid::new_v4().to_string();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            let column_count: i32 = engine.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
                params![dataset_id],
                |row| row.get(0),
            )?;
            let column_index = at_index.unwrap_or(column_count).clamp(0, column_count);
            let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            let column_identifier = Self::quote_identifier(col_name);
            engine.conn.execute(
                &format!(
                    "ALTER TABLE {dataset_table} ADD COLUMN {column_identifier} {column_type}"
                ),
                [],
            )?;
            engine.conn.execute(
                "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                params![dataset_id, column_index],
            )?;
            engine.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                params![dataset_id, column_index, col_name, &column_type],
            )?;
            engine.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = ?",
                params![dataset_id],
            )?;
            let inserted_column = engine
                .get_user_column_descriptors(dataset_id)?
                .into_iter()
                .find(|column| column.col_index == column_index && column.name == col_name)
                .ok_or_else(|| AppError::Database("added column metadata is missing".into()))?;
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids: BTreeSet::from([inserted_column.column_id]),
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
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
        let added_count = i32::try_from(canonical_columns.len())
            .map_err(|_| AppError::InvalidParam("too many columns".into()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            let existing_count: i32 = engine.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
                params![dataset_id],
                |row| row.get(0),
            )?;
            let first_index = at_index.unwrap_or(existing_count).clamp(0, existing_count);
            let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            for (ordinal, (name, column_type)) in canonical_columns.iter().enumerate() {
                let column_index = first_index + ordinal as i32;
                let column_identifier = Self::quote_identifier(name);
                engine.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ADD COLUMN {column_identifier} {column_type}"
                    ),
                    [],
                )?;
                engine.conn.execute(
                    "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = ? AND col_index >= ?",
                    params![dataset_id, column_index],
                )?;
                engine.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                    params![dataset_id, column_index, name, column_type],
                )?;
            }
            engine.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count + ? WHERE id = ?",
                params![added_count, dataset_id],
            )?;
            let inserted_columns = engine.get_user_column_descriptors(dataset_id)?;
            let changed_column_ids = inserted_columns
                .into_iter()
                .filter(|column| {
                    column.col_index >= first_index && column.col_index < first_index + added_count
                })
                .map(|column| column.column_id)
                .collect::<BTreeSet<_>>();
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids,
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
    }

    pub fn add_valued_columns_with_change_set(
        &self,
        dataset_id: &str,
        columns: &[ValuedColumn],
        expected_generation: u64,
    ) -> Result<(String, u64), AppError> {
        const MAX_COLUMNS: usize = 1_000;
        if columns.is_empty() || columns.len() > MAX_COLUMNS {
            return Err(AppError::InvalidParam(format!(
                "column count must be between 1 and {MAX_COLUMNS}"
            )));
        }
        let mut names = std::collections::HashSet::new();
        let canonical_columns = columns
            .iter()
            .map(|column| {
                if column.name.trim().is_empty()
                    || !names.insert(column.name.to_ascii_lowercase())
                    || column
                        .values
                        .iter()
                        .any(|(_, value)| value.is_some_and(|value| !value.is_finite()))
                {
                    return Err(AppError::InvalidParam(
                        "valued columns contain an invalid name or value".into(),
                    ));
                }
                let mut row_ids = std::collections::HashSet::new();
                if column
                    .values
                    .iter()
                    .any(|(row_id, _)| !row_ids.insert(*row_id))
                {
                    return Err(AppError::InvalidParam(format!(
                        "valued column contains duplicate row IDs: {}",
                        column.name
                    )));
                }
                self.canonicalize_column_type(&column.column_type)
                    .map(|column_type| (column, column_type))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let resolved_names = self.resolve_valued_column_names(
            dataset_id,
            &columns
                .iter()
                .map(|column| column.name.clone())
                .collect::<Vec<_>>(),
        )?;
        let added_count = i32::try_from(canonical_columns.len())
            .map_err(|_| AppError::InvalidParam("too many columns".into()))?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let replacement_name = format!("_valued_columns_{}", change_set_id.replace('-', "_"));

        execute_table_mutation(self, dataset_id, Some(expected_generation), |engine| {
            let first_index: i32 = engine.conn.query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = ?",
                params![dataset_id],
                |row| row.get(0),
            )?;
            let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            let replacement_table = Self::quote_identifier(&replacement_name);
            let added_select = canonical_columns
                .iter()
                .enumerate()
                .map(|(ordinal, (_, column_type))| {
                    format!(
                        "NULL::{column_type} AS {}",
                        Self::quote_identifier(&resolved_names[ordinal])
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            engine.conn.execute(
                &format!(
                    "CREATE TABLE {replacement_table} AS SELECT *, {added_select} FROM {dataset_table}"
                ),
                [],
            )?;
            for (ordinal, (column, column_type)) in canonical_columns.iter().enumerate() {
                let column_index = first_index + ordinal as i32;
                let resolved_name = &resolved_names[ordinal];
                let column_identifier = Self::quote_identifier(resolved_name);
                engine.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                    params![dataset_id, column_index, resolved_name, column_type],
                )?;
                let mut update = engine.conn.prepare(&format!(
                    "UPDATE {replacement_table} SET {column_identifier} = ? WHERE \"_row_id\" = ?"
                ))?;
                for (row_id, value) in &column.values {
                    if update.execute(params![value, row_id])? != 1 {
                        return Err(AppError::InvalidParam(format!(
                            "valued column references unknown row ID: {row_id}"
                        )));
                    }
                }
            }
            engine
                .conn
                .execute(&format!("DROP TABLE {dataset_table}"), [])?;
            engine.conn.execute(
                &format!(
                    "ALTER TABLE {replacement_table} RENAME TO {}",
                    Self::quote_identifier(&Self::internal_table_name(dataset_id))
                ),
                [],
            )?;
            engine.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count + ? WHERE id = ?",
                params![added_count, dataset_id],
            )?;
            let inserted_columns = engine.get_user_column_descriptors(dataset_id)?;
            let changed_column_ids = inserted_columns
                .into_iter()
                .filter(|column| {
                    column.col_index >= first_index && column.col_index < first_index + added_count
                })
                .map(|column| column.column_id)
                .collect::<BTreeSet<_>>();
            let next_generation = engine
                .get_dataset_generation(dataset_id)?
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("dataset generation is exhausted".into()))?;
            Ok(TableMutationEffects {
                value: (change_set_id.clone(), next_generation),
                changed_column_ids,
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
    }

    pub fn resolve_valued_column_names(
        &self,
        dataset_id: &str,
        requested_names: &[String],
    ) -> Result<Vec<String>, AppError> {
        if requested_names.is_empty() || requested_names.iter().any(|name| name.trim().is_empty()) {
            return Err(AppError::InvalidParam(
                "valued column names must not be empty".into(),
            ));
        }
        let existing = self
            .get_user_columns(dataset_id)?
            .into_iter()
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        for suffix in 1usize.. {
            let candidates = requested_names
                .iter()
                .map(|name| {
                    if suffix == 1 {
                        name.clone()
                    } else {
                        format!("{name}-{suffix}")
                    }
                })
                .collect::<Vec<_>>();
            let mut group_names = std::collections::HashSet::new();
            if candidates.iter().all(|candidate| {
                let canonical = candidate.to_ascii_lowercase();
                !existing.contains(&canonical) && group_names.insert(canonical)
            }) {
                return Ok(candidates);
            }
        }
        Err(AppError::InvalidParam(
            "valued column name suffix space is exhausted".into(),
        ))
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
        let existing_columns = self.get_user_column_descriptors(dataset_id)?;
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
            .filter(|column| requested_set.contains(&column.name))
            .cloned()
            .collect::<Vec<_>>();
        if deleted_columns.len() != column_names.len() {
            return Err(AppError::InvalidParam(
                "one or more columns do not exist".into(),
            ));
        }
        self.reject_calculated_dependency_removals(
            dataset_id,
            deleted_columns.iter().map(|column| column.name.as_str()),
        )?;
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let deleted_column_ids = deleted_columns
            .iter()
            .map(|column| column.column_id.clone())
            .collect::<BTreeSet<_>>();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
            for column in deleted_columns.iter().rev() {
                engine.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} DROP COLUMN {}",
                        Self::quote_identifier(&column.name)
                    ),
                    [],
                )?;
                engine.conn.execute(
                    "DELETE FROM _meta_columns WHERE dataset_id = ? AND col_name = ?",
                    params![dataset_id, &column.name],
                )?;
                engine.conn.execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ? AND column_id = ?",
                    params![dataset_id, &column.column_id],
                )?;
                engine.conn.execute(
                    "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = ? AND col_index > ?",
                    params![dataset_id, column.col_index],
                )?;
            }
            engine.conn.execute(
                "UPDATE _meta_datasets SET col_count = col_count - ? WHERE id = ?",
                params![deleted_columns.len() as i32, dataset_id],
            )?;
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids: deleted_column_ids.clone(),
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
    }

    pub fn alter_column_with_change_set(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
        new_type: &str,
        expected_generation: Option<u64>,
    ) -> Result<String, AppError> {
        let existing_columns = self.get_user_column_descriptors(dataset_id)?;
        let existing_column = existing_columns
            .iter()
            .find(|column| column.name == old_name)
            .cloned()
            .ok_or_else(|| AppError::InvalidParam(format!("unknown column: {old_name}")))?;
        if new_name != old_name
            && existing_columns
                .iter()
                .any(|column| column.name == new_name)
        {
            return Err(AppError::InvalidParam(format!(
                "column already exists: {new_name}"
            )));
        }
        let new_type = self.canonicalize_column_type(new_type)?;
        let old_type = existing_column.sql_type.clone();
        let is_calculated_output = self
            .get_archived_calculated_columns_by_id(dataset_id)?
            .contains_key(&existing_column.column_id);
        if is_calculated_output && new_type != old_type {
            return Err(AppError::InvalidParam(format!(
                "calculated output column is read-only until convert to values: {old_name}"
            )));
        }
        if new_name == old_name && new_type == old_type {
            return Err(AppError::InvalidParam("column change has no effect".into()));
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
        let change_set_id = uuid::Uuid::new_v4().to_string();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            if new_type != old_type {
                engine.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ALTER COLUMN {old_identifier} SET DATA TYPE {new_type} USING {old_identifier}::{new_type}"
                    ),
                    [],
                )?;
            }
            if new_name != old_name {
                engine.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} RENAME COLUMN {old_identifier} TO {new_identifier}"
                    ),
                    [],
                )?;
            }
            engine.conn.execute(
                "UPDATE _meta_columns SET col_name = ?, col_type = ? WHERE dataset_id = ? AND col_name = ?",
                params![new_name, &new_type, dataset_id, old_name],
            )?;
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids: BTreeSet::from([existing_column.column_id.clone()]),
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
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
        let existing_columns = self.get_user_column_descriptors(dataset_id)?;
        let changed_columns = existing_columns
            .iter()
            .filter(|column| requested.contains(&column.name))
            .cloned()
            .collect::<Vec<_>>();
        if changed_columns.len() != column_names.len() {
            return Err(AppError::InvalidParam(
                "one or more columns do not exist".into(),
            ));
        }
        let new_type = self.canonicalize_column_type(new_type)?;
        if changed_columns
            .iter()
            .any(|column| column.sql_type == new_type)
        {
            return Err(AppError::InvalidParam(
                "one or more column changes have no effect".into(),
            ));
        }
        self.reject_calculated_column_writes(
            dataset_id,
            changed_columns.iter().map(|column| column.name.as_str()),
        )?;
        let dataset_table = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        for column in &changed_columns {
            let identifier = Self::quote_identifier(&column.name);
            let failed_casts: i64 = self.conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {dataset_table} WHERE {identifier} IS NOT NULL AND TRY_CAST({identifier} AS {new_type}) IS NULL"
                ),
                [],
                |row| row.get(0),
            )?;
            if failed_casts != 0 {
                return Err(AppError::InvalidParam(format!(
                    "cannot convert {failed_casts} values in column {} to {new_type}",
                    column.name
                )));
            }
        }
        let change_set_id = uuid::Uuid::new_v4().to_string();
        let changed_column_ids = changed_columns
            .iter()
            .map(|column| column.column_id.clone())
            .collect::<BTreeSet<_>>();
        execute_table_mutation(self, dataset_id, expected_generation, |engine| {
            for column in &changed_columns {
                let identifier = Self::quote_identifier(&column.name);
                engine.conn.execute(
                    &format!(
                        "ALTER TABLE {dataset_table} ALTER COLUMN {identifier} SET DATA TYPE {new_type} USING {identifier}::{new_type}"
                    ),
                    [],
                )?;
                engine.conn.execute(
                    "UPDATE _meta_columns SET col_type = ? WHERE dataset_id = ? AND col_name = ?",
                    params![&new_type, dataset_id, &column.name],
                )?;
            }
            Ok(TableMutationEffects {
                value: change_set_id.clone(),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: Some(change_set_id.clone()),
                recompute_column_ids: None,
            })
        })
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
        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<(), AppError> {
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
                "SELECT ordinal, column_index, before_column_id, before_name, before_type, before_calculated_definition_json, after_column_id, after_name, after_type, after_calculated_definition_json, after_present FROM _history_change_set_columns WHERE change_set_id = ? ORDER BY ordinal",
            )?;
            let columns = statement
                .query_map(params![change_set_id], |row| {
                    Ok((
                        row.get::<_, i32>(0)?,
                        row.get::<_, i32>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, bool>(10)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let dataset_table = Self::quote_identifier(&Self::internal_table_name(&dataset_id));
            let assignments = columns
                .iter()
                .filter_map(
                    |(ordinal, _, _, before_name, _, _, _, after_name, _, _, after_present)| {
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

            if undo {
                for (
                    _,
                    column_index,
                    before_column_id,
                    before_name,
                    before_type,
                    _,
                    _,
                    _,
                    _,
                    _,
                    after_present,
                ) in &columns
                {
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
                        self.insert_replayed_meta_column(
                            &dataset_id,
                            *column_index,
                            before_name,
                            before_type,
                            match before_column_id.as_deref() {
                                Some(column_id) => ReplayedColumnIdentity::Exact(column_id),
                                None => ReplayedColumnIdentity::LegacyGenerated,
                            },
                        )?;
                    }
                }
                for (
                    _,
                    _,
                    _,
                    before_name,
                    before_type,
                    _,
                    _,
                    after_name,
                    after_type,
                    _,
                    after_present,
                ) in &columns
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
                for (ordinal, _, _, before_name, _, _, _, after_name, _, _, after_present) in
                    &columns
                {
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
                for (ordinal, _, _, before_name, _, _, _, after_name, _, _, after_present) in
                    &columns
                {
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
                for (_, column_index, _, before_name, _, _, _, after_name, _, _, after_present) in
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
                for (
                    _,
                    column_index,
                    _,
                    before_name,
                    _,
                    _,
                    after_column_id,
                    after_name,
                    after_type,
                    _,
                    after_present,
                ) in &columns
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
                        self.insert_replayed_meta_column(
                            &dataset_id,
                            *column_index,
                            after_name,
                            after_type,
                            match after_column_id.as_deref() {
                                Some(column_id) => ReplayedColumnIdentity::Exact(column_id),
                                None => ReplayedColumnIdentity::LegacyGenerated,
                            },
                        )?;
                    }
                }
                for (_, _, _, before_name, before_type, _, _, _, after_type, _, after_present) in
                    &columns
                {
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
                for (ordinal, _, _, before_name, _, _, _, after_name, _, _, after_present) in
                    &columns
                {
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
                for (ordinal, _, _, before_name, _, _, _, after_name, _, _, after_present) in
                    &columns
                {
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
                for (_, column_index, _, before_name, _, _, _, _, _, _, after_present) in
                    columns.iter().rev()
                {
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
            }
            self.replay_column_order(&dataset_id, &columns, undo)?;
            self.replay_calculated_history_columns(&dataset_id, &columns, undo)?;
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
            self.rebuild_natural_anchors(&dataset_id, generation + 1)?;
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

    fn replay_calculated_history_columns(
        &self,
        dataset_id: &str,
        columns: &[(
            i32,
            i32,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            bool,
        )],
        undo: bool,
    ) -> Result<(), AppError> {
        for (_, _, before_column_id, _, _, _, after_column_id, _, _, _, _) in columns {
            if let Some(column_id) = before_column_id {
                self.conn.execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ? AND column_id = ?",
                    params![dataset_id, column_id],
                )?;
            }
            if let Some(column_id) = after_column_id {
                self.conn.execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ? AND column_id = ?",
                    params![dataset_id, column_id],
                )?;
            }
        }

        for (
            _,
            _,
            before_column_id,
            _,
            _,
            before_calculated_definition_json,
            after_column_id,
            _,
            _,
            after_calculated_definition_json,
            after_present,
        ) in columns
        {
            let (target_column_id, calculated_json) = if undo {
                (
                    before_column_id.as_deref(),
                    before_calculated_definition_json.as_deref(),
                )
            } else if *after_present {
                (
                    after_column_id.as_deref(),
                    after_calculated_definition_json.as_deref(),
                )
            } else {
                (None, None)
            };

            let (Some(target_column_id), Some(calculated_json)) =
                (target_column_id, calculated_json)
            else {
                continue;
            };

            let calculated: ArchivedCalculatedColumn = serde_json::from_str(calculated_json)
                .map_err(|error| AppError::Database(error.to_string()))?;
            self.upsert_archived_calculated_column(dataset_id, target_column_id, &calculated)?;
        }

        Ok(())
    }

    fn replay_column_order(
        &self,
        dataset_id: &str,
        columns: &[(
            i32,
            i32,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            bool,
        )],
        undo: bool,
    ) -> Result<(), AppError> {
        let target_columns = columns
            .iter()
            .filter_map(
                |(
                    ordinal,
                    column_index,
                    _,
                    before_name,
                    _,
                    _,
                    _,
                    after_name,
                    _,
                    _,
                    after_present,
                )| {
                    if undo {
                        before_name.as_ref().map(|name| (name.clone(), *ordinal))
                    } else if *after_present {
                        Some((after_name.clone(), *column_index))
                    } else {
                        None
                    }
                },
            )
            .collect::<Vec<_>>();
        if target_columns.is_empty() {
            return Ok(());
        }

        let current_columns = self
            .get_user_column_descriptors(dataset_id)?
            .into_iter()
            .collect::<Vec<_>>();
        if target_columns.len() != current_columns.len() {
            return Ok(());
        }
        let current_max_index = current_columns
            .iter()
            .map(|column| column.col_index)
            .max()
            .unwrap_or(-1);
        for (ordinal, column) in current_columns.iter().enumerate() {
            let temporary_index = current_max_index
                .checked_add(1)
                .and_then(|base| base.checked_add(i32::try_from(ordinal).ok()?))
                .ok_or_else(|| {
                    AppError::InvalidParam("replayed column order is too large".into())
                })?;
            self.conn.execute(
                "UPDATE _meta_columns SET col_index = ? WHERE dataset_id = ? AND col_name = ?",
                params![temporary_index, dataset_id, &column.name],
            )?;
        }
        for (name, target_index) in target_columns {
            self.conn.execute(
                "UPDATE _meta_columns SET col_index = ? WHERE dataset_id = ? AND col_name = ?",
                params![target_index, dataset_id, name],
            )?;
        }

        Ok(())
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
                self.add_column_inner(dataset_id, &col_name, col_type)?;
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
                            .change_column_type_inner(dataset_id, col_name, detected_type)
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
                        self.rename_column_inner(dataset_id, old_name, &unique_owned)?;
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
        let existing_columns = self.get_user_column_descriptors(dataset_id)?;
        let archived_columns = self.get_archive_column_plans(dataset_id)?;
        let has_calculated_columns = archived_columns
            .iter()
            .any(|column| column.calculated.is_some());
        let schema_is_compatible = existing_columns.len() == col_names.len()
            && existing_columns
                .iter()
                .zip(col_names.iter().zip(col_types.iter()))
                .all(|(existing, (incoming_name, incoming_type))| {
                    existing.name == *incoming_name && existing.sql_type == *incoming_type
                });
        if has_calculated_columns && !schema_is_compatible {
            return Err(AppError::InvalidParam(
                "cannot restore snapshot with a UUID-incompatible calculated schema".into(),
            ));
        }

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<(), AppError> {
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

            self.conn.execute(
                "DELETE FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
            )?;
            if schema_is_compatible {
                for existing in &existing_columns {
                    self.insert_meta_column_with_id(dataset_id, existing)?;
                }
            } else {
                for (i, (col_name, col_type)) in col_names.iter().zip(col_types.iter()).enumerate()
                {
                    self.conn.execute(
                        "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                        params![dataset_id, i as i32, col_name, col_type],
                    )?;
                }
            }

            for row_data in rows {
                if row_data.is_empty() {
                    continue;
                }
                let row_id = match &row_data[0] {
                    serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
                    _ => 0,
                };

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

            if has_calculated_columns {
                self.rematerialize_all_calculated_outputs(dataset_id)?;
            }

            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;
            let col_count = col_names.len() as i32;
            self.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1, col_count = $2, generation = generation + 1 WHERE id = $3",
                params![row_count, col_count, dataset_id],
            )?;
            let generation = self.get_dataset_generation(dataset_id)?;
            self.rebuild_natural_anchors(dataset_id, generation)?;

            Ok(())
        })();

        match result {
            Ok(()) => self.conn.execute_batch("COMMIT").map_err(Into::into),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
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
        self.rebuild_natural_anchors(new_id, 0)?;

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
        self.rebuild_natural_anchors(new_id, 0)?;
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
        self.reject_calculated_column_writes(left_id, update_cols.iter().map(String::as_str))?;
        let changed_column_ids =
            self.resolve_column_ids_by_name(left_id, update_cols.iter().map(String::as_str))?;
        execute_table_mutation(self, left_id, None, |engine| {
            let left_table = format!("dataset_{}", left_id.replace('-', "_"));
            let right_table = format!("dataset_{}", right_id.replace('-', "_"));

            for col in update_cols {
                let sql = format!(
                    "UPDATE \"{}\" SET \"{}\" = R.\"{}\" FROM \"{}\" AS R \
                     WHERE \"{}\".\"{}\" = R.\"{}\"",
                    left_table, col, col, right_table, left_table, match_col, match_col
                );
                engine.conn.execute(&sql, [])?;
            }

            let row_count: i64 = engine.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", left_table),
                [],
                |row| row.get(0),
            )?;
            engine.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, left_id],
            )?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        })
    }

    /// Create an updated copy of the left dataset without mutating either input.
    pub fn copy_and_update_table(
        &self,
        new_id: &str,
        new_name: &str,
        left_id: &str,
        right_id: &str,
        match_column: &str,
        update_columns: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if new_id == left_id || new_id == right_id {
            return Err(AppError::InvalidParam(
                "derived update output must have a distinct dataset id".into(),
            ));
        }
        if match_column.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "update match column is required".into(),
            ));
        }
        if update_columns.is_empty() || update_columns.iter().any(|column| column.trim().is_empty())
        {
            return Err(AppError::InvalidParam(
                "at least one non-blank update column is required".into(),
            ));
        }
        self.reject_calculated_column_writes(left_id, update_columns.iter().map(String::as_str))?;
        let unique_update_columns = update_columns.iter().collect::<HashSet<_>>();
        if unique_update_columns.len() != update_columns.len() {
            return Err(AppError::InvalidParam(
                "update columns must be unique".into(),
            ));
        }

        let left_columns = self.get_user_columns(left_id)?;
        let right_columns = self.get_user_columns(right_id)?;
        let left_names = left_columns
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<HashSet<_>>();
        let right_names = right_columns
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<HashSet<_>>();
        for column in std::iter::once(match_column).chain(update_columns.iter().map(String::as_str))
        {
            if !left_names.contains(column) {
                return Err(AppError::InvalidParam(format!(
                    "column {column} does not exist in left dataset"
                )));
            }
            if !right_names.contains(column) {
                return Err(AppError::InvalidParam(format!(
                    "column {column} does not exist in right dataset"
                )));
            }
        }

        let left_table = Self::quote_identifier(&Self::internal_table_name(left_id));
        let select_columns = left_columns
            .iter()
            .map(|(name, _)| Self::quote_identifier(name))
            .collect::<Vec<_>>()
            .join(", ");
        self.create_table_from_query(
            new_id,
            new_name,
            "update",
            &format!("SELECT {select_columns} FROM {left_table}"),
        )?;

        let output_table = Self::quote_identifier(&Self::internal_table_name(new_id));
        let right_table = Self::quote_identifier(&Self::internal_table_name(right_id));
        let match_identifier = Self::quote_identifier(match_column);
        if let Some(source_columns) = self.compatible_calculated_source_columns(left_id, new_id)? {
            if let Err(error) = self.clone_calculated_schema_with_new_ids(new_id, &source_columns) {
                let _ = self.delete_dataset(new_id);
                return Err(error);
            }
        }
        let changed_column_ids =
            self.resolve_column_ids_by_name(new_id, update_columns.iter().map(String::as_str))?;
        let update_result = execute_table_mutation(self, new_id, None, |engine| {
            for column in update_columns {
                let column_identifier = Self::quote_identifier(column);
                engine.conn.execute(
                    &format!(
                        "UPDATE {output_table} SET {column_identifier} = source.{column_identifier} \
                         FROM {right_table} AS source \
                         WHERE {output_table}.{match_identifier} = source.{match_identifier}"
                    ),
                    [],
                )?;
            }
            let row_count: i64 = engine.conn.query_row(
                &format!("SELECT COUNT(*) FROM {output_table}"),
                [],
                |row| row.get(0),
            )?;
            engine.conn.execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, new_id],
            )?;
            Ok(TableMutationEffects {
                value: (),
                changed_column_ids: changed_column_ids.clone(),
                change_set_id: None,
                recompute_column_ids: None,
            })
        });
        if let Err(error) = update_result {
            let _ = self.delete_dataset(new_id);
            return Err(error);
        }

        self.get_dataset_meta(new_id)
    }

    /// Promote a temporary dataset or replace an existing stable dataset atomically.
    pub fn replace_dataset_atomically(
        &self,
        stable_id: &str,
        temporary_id: &str,
        stable_name: &str,
        expected_generation: u64,
    ) -> Result<DatasetMeta, AppError> {
        if stable_id.trim().is_empty() || temporary_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "stable and temporary dataset ids are required".into(),
            ));
        }
        if stable_id == temporary_id {
            return Err(AppError::InvalidParam(
                "stable and temporary dataset ids must differ".into(),
            ));
        }
        self.validate_dataset_name(stable_name, Some(stable_id))?;
        let temporary_meta = self.get_dataset_meta(temporary_id)?;
        let stable_table = Self::quote_identifier(&Self::internal_table_name(stable_id));
        let temporary_table = Self::quote_identifier(&Self::internal_table_name(temporary_id));

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<(), AppError> {
            let stable_generation = self.get_dataset_generation_if_exists(stable_id)?;
            match stable_generation {
                Some(generation) if generation != expected_generation => {
                    return Err(AppError::InvalidParam(format!(
                        "stale dataset generation: expected {generation}, received {expected_generation}"
                    )));
                }
                None if expected_generation != 0 => {
                    return Err(AppError::InvalidParam(format!(
                        "stale dataset generation: expected 0, received {expected_generation}"
                    )));
                }
                _ => {}
            }

            let preserved_calculated_columns = if stable_generation.is_some() {
                self.compatible_calculated_source_columns(stable_id, temporary_id)?
            } else {
                None
            };
            let rematerialize_calculated = preserved_calculated_columns.is_some();

            if let Some(generation) = stable_generation {
                let next_generation = generation.checked_add(1).ok_or_else(|| {
                    AppError::InvalidParam("dataset generation is exhausted".into())
                })?;
                self.conn
                    .execute(&format!("DROP TABLE {stable_table}"), [])?;
                self.conn.execute(
                    "DELETE FROM _meta_columns WHERE dataset_id = $1",
                    params![stable_id],
                )?;
                self.conn.execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
                    params![stable_id],
                )?;
                if let Some(source_columns) = preserved_calculated_columns.as_ref() {
                    self.adopt_calculated_schema_with_exact_ids(temporary_id, source_columns)?;
                }
                self.conn.execute(
                    "UPDATE _meta_columns SET dataset_id = $1 WHERE dataset_id = $2",
                    params![stable_id, temporary_id],
                )?;
                self.conn.execute(
                    "UPDATE _meta_datasets SET name = $1, source_path = $2, source_type = $3, \
                     row_count = $4, col_count = $5, generation = $6, \
                     updated_at = CAST(current_timestamp AS VARCHAR) WHERE id = $7",
                    params![
                        stable_name,
                        temporary_meta.source_path,
                        temporary_meta.source_type,
                        temporary_meta.row_count,
                        temporary_meta.col_count,
                        next_generation,
                        stable_id,
                    ],
                )?;
                self.conn.execute(
                    "DELETE FROM _meta_datasets WHERE id = $1",
                    params![temporary_id],
                )?;
            } else {
                self.conn.execute(
                    "UPDATE _meta_columns SET dataset_id = $1 WHERE dataset_id = $2",
                    params![stable_id, temporary_id],
                )?;
                self.conn.execute(
                    "UPDATE _meta_datasets SET id = $1, name = $2, generation = 0, \
                     updated_at = CAST(current_timestamp AS VARCHAR) WHERE id = $3",
                    params![stable_id, stable_name, temporary_id],
                )?;
            }
            self.conn.execute(
                "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
                params![stable_id],
            )?;
            self.conn.execute(
                "UPDATE _meta_calculated_columns SET dataset_id = $1 WHERE dataset_id = $2",
                params![stable_id, temporary_id],
            )?;

            self.conn.execute(
                &format!("ALTER TABLE {temporary_table} RENAME TO {stable_table}"),
                [],
            )?;
            if rematerialize_calculated {
                self.rematerialize_all_calculated_outputs(stable_id)?;
            }
            let generation = self.get_dataset_generation(stable_id)?;
            self.rebuild_natural_anchors(stable_id, generation)?;
            self.conn.execute(
                "DELETE FROM _table_navigation_anchors WHERE dataset_id = $1",
                params![temporary_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }

        self.get_dataset_meta(stable_id)
    }

    pub(crate) fn replace_datasets_atomically(
        &self,
        replacements: &[DatasetReplacement],
    ) -> Result<Vec<DatasetMeta>, AppError> {
        let mut stable_ids = HashSet::new();
        let mut temporary_ids = HashSet::new();
        let mut temporary_meta = Vec::with_capacity(replacements.len());
        for replacement in replacements {
            if replacement.stable_id.trim().is_empty()
                || replacement.temporary_id.trim().is_empty()
                || replacement.stable_id == replacement.temporary_id
            {
                return Err(AppError::InvalidParam(
                    "distinct stable and temporary dataset ids are required".into(),
                ));
            }
            if !stable_ids.insert(replacement.stable_id.as_str())
                || !temporary_ids.insert(replacement.temporary_id.as_str())
            {
                return Err(AppError::InvalidParam(
                    "workflow dataset replacement ids must be unique".into(),
                ));
            }
            self.validate_dataset_name(&replacement.stable_name, Some(&replacement.stable_id))?;
            temporary_meta.push(self.get_dataset_meta(&replacement.temporary_id)?);
        }

        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = replacements.iter().zip(&temporary_meta).try_for_each(
            |(replacement, meta)| -> Result<(), AppError> {
                let stable_generation =
                    self.get_dataset_generation_if_exists(&replacement.stable_id)?;
                match stable_generation {
                    Some(generation) if generation != replacement.expected_generation => {
                        return Err(AppError::InvalidParam(format!(
                            "stale dataset generation: expected {generation}, received {}",
                            replacement.expected_generation
                        )));
                    }
                    None if replacement.expected_generation != 0 => {
                        return Err(AppError::InvalidParam(format!(
                            "stale dataset generation: expected 0, received {}",
                            replacement.expected_generation
                        )));
                    }
                    _ => {}
                }

                let stable_table =
                    Self::quote_identifier(&Self::internal_table_name(&replacement.stable_id));
                let temporary_table =
                    Self::quote_identifier(&Self::internal_table_name(&replacement.temporary_id));
                let preserved_calculated_columns = if stable_generation.is_some() {
                    self.compatible_calculated_source_columns(
                        &replacement.stable_id,
                        &replacement.temporary_id,
                    )?
                } else {
                    None
                };
                let rematerialize_calculated = preserved_calculated_columns.is_some();
                if let Some(generation) = stable_generation {
                    let next_generation = generation.checked_add(1).ok_or_else(|| {
                        AppError::InvalidParam("dataset generation is exhausted".into())
                    })?;
                    self.conn
                        .execute(&format!("DROP TABLE {stable_table}"), [])?;
                    self.conn.execute(
                        "DELETE FROM _meta_columns WHERE dataset_id = $1",
                        params![replacement.stable_id],
                    )?;
                    self.conn.execute(
                        "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
                        params![replacement.stable_id],
                    )?;
                    if let Some(source_columns) = preserved_calculated_columns.as_ref() {
                        self.adopt_calculated_schema_with_exact_ids(
                            &replacement.temporary_id,
                            source_columns,
                        )?;
                    }
                    self.conn.execute(
                        "UPDATE _meta_columns SET dataset_id = $1 WHERE dataset_id = $2",
                        params![replacement.stable_id, replacement.temporary_id],
                    )?;
                    self.conn.execute(
                        "UPDATE _meta_datasets SET name = $1, source_path = $2, source_type = $3,
                         row_count = $4, col_count = $5, generation = $6,
                         updated_at = CAST(current_timestamp AS VARCHAR) WHERE id = $7",
                        params![
                            replacement.stable_name,
                            meta.source_path,
                            meta.source_type,
                            meta.row_count,
                            meta.col_count,
                            next_generation,
                            replacement.stable_id,
                        ],
                    )?;
                    self.conn.execute(
                        "DELETE FROM _meta_datasets WHERE id = $1",
                        params![replacement.temporary_id],
                    )?;
                } else {
                    self.conn.execute(
                        "UPDATE _meta_columns SET dataset_id = $1 WHERE dataset_id = $2",
                        params![replacement.stable_id, replacement.temporary_id],
                    )?;
                    self.conn.execute(
                        "UPDATE _meta_datasets SET id = $1, name = $2, generation = 0,
                         updated_at = CAST(current_timestamp AS VARCHAR) WHERE id = $3",
                        params![
                            replacement.stable_id,
                            replacement.stable_name,
                            replacement.temporary_id
                        ],
                    )?;
                }
                self.conn.execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
                    params![replacement.stable_id],
                )?;
                self.conn.execute(
                    "UPDATE _meta_calculated_columns SET dataset_id = $1 WHERE dataset_id = $2",
                    params![replacement.stable_id, replacement.temporary_id],
                )?;
                self.conn.execute(
                    &format!("ALTER TABLE {temporary_table} RENAME TO {stable_table}"),
                    [],
                )?;
                if rematerialize_calculated {
                    self.rematerialize_all_calculated_outputs(&replacement.stable_id)?;
                }
                let generation = self.get_dataset_generation(&replacement.stable_id)?;
                self.rebuild_natural_anchors(&replacement.stable_id, generation)?;
                self.conn.execute(
                    "DELETE FROM _table_navigation_anchors WHERE dataset_id = $1",
                    params![replacement.temporary_id],
                )?;
                Ok(())
            },
        );

        match result {
            Ok(()) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        replacements
            .iter()
            .map(|replacement| self.get_dataset_meta(&replacement.stable_id))
            .collect()
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

    pub(crate) fn get_user_column_descriptors(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<UserColumnDescriptor>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT column_id, col_index, col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        stmt.query_map(params![dataset_id], |row| {
            Ok(UserColumnDescriptor {
                column_id: row.get(0)?,
                col_index: row.get(1)?,
                name: row.get(2)?,
                sql_type: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)
    }

    pub(crate) fn get_archive_column_plans(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<ArchiveColumnPlan>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT columns.column_id, columns.col_name, columns.col_type, calculated.archived_definition_json
             FROM _meta_columns AS columns
             LEFT JOIN _meta_calculated_columns AS calculated
               ON calculated.dataset_id = columns.dataset_id
              AND calculated.column_id = columns.column_id
             WHERE columns.dataset_id = $1
             ORDER BY columns.col_index",
        )?;
        let mut rows = statement.query(params![dataset_id])?;
        let mut columns = Vec::new();
        while let Some(row) = rows.next()? {
            let archived_json: Option<String> = row.get(3)?;
            let calculated = match archived_json {
                Some(archived_json) => {
                    Some(serde_json::from_str(&archived_json).map_err(|error| {
                        AppError::Database(format!(
                            "invalid archived calculated column metadata: {error}"
                        ))
                    })?)
                }
                None => None,
            };
            columns.push(ArchiveColumnPlan {
                column_id: row.get(0)?,
                name: row.get(1)?,
                sql_type: row.get(2)?,
                calculated,
            });
        }
        Ok(columns)
    }

    pub(crate) fn get_archived_calculated_columns_by_id(
        &self,
        dataset_id: &str,
    ) -> Result<BTreeMap<String, ArchivedCalculatedColumn>, AppError> {
        self.get_archive_column_plans(dataset_id).map(|columns| {
            columns
                .into_iter()
                .filter_map(|column| {
                    column
                        .calculated
                        .map(|calculated| (column.column_id, calculated))
                })
                .collect()
        })
    }

    pub(crate) fn get_table_column_descriptors(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<crate::models::table::ColumnDescriptor>, AppError> {
        let columns = self.get_archive_column_plans(dataset_id)?;
        let present_column_ids = columns
            .iter()
            .map(|column| column.column_id.clone())
            .collect::<HashSet<_>>();
        let column_names_by_id = columns
            .iter()
            .map(|column| (column.column_id.clone(), column.name.clone()))
            .collect::<HashMap<_, _>>();
        Ok(columns
            .into_iter()
            .map(|column| crate::models::table::ColumnDescriptor {
                column_id: column.column_id.clone(),
                name: column.name.clone(),
                sql_type: column.sql_type.clone(),
                calculated: column.calculated.as_ref().map(|calculated| {
                    build_calculated_descriptor(
                        calculated,
                        &column.column_id,
                        &column.sql_type,
                        &present_column_ids,
                        &column_names_by_id,
                    )
                }),
            })
            .collect())
    }

    pub(crate) fn replace_archive_column_ids(
        &self,
        dataset_id: &str,
        columns: &[ArchiveColumnPlan],
    ) -> Result<(), AppError> {
        let existing_columns = self.get_user_column_descriptors(dataset_id)?;
        if existing_columns.len() != columns.len() {
            return Err(AppError::Database(format!(
                "dataset {dataset_id} column count changed during restore"
            )));
        }

        for (existing, column) in existing_columns.iter().zip(columns.iter()) {
            uuid::Uuid::parse_str(&column.column_id)
                .map_err(|_| AppError::InvalidParam("invalid column id".into()))?;
            self.conn.execute(
                "UPDATE _meta_columns SET column_id = $1 WHERE dataset_id = $2 AND col_index = $3",
                params![&column.column_id, dataset_id, existing.col_index],
            )?;
        }

        Ok(())
    }

    pub(crate) fn replace_archived_calculated_columns(
        &self,
        dataset_id: &str,
        columns: &[ArchiveColumnPlan],
    ) -> Result<(), AppError> {
        self.conn.execute(
            "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
            params![dataset_id],
        )?;

        for column in columns {
            let Some(calculated) = &column.calculated else {
                continue;
            };
            self.upsert_archived_calculated_column(dataset_id, &column.column_id, calculated)?;
        }

        Ok(())
    }

    pub(crate) fn upsert_archived_calculated_column(
        &self,
        dataset_id: &str,
        column_id: &str,
        calculated: &ArchivedCalculatedColumn,
    ) -> Result<(), AppError> {
        let (expression_json, dependency_column_ids_json, inferred_output_type, fingerprint) =
            match calculated {
                ArchivedCalculatedColumn::Ready { definition, .. } => (
                    Some(
                        serde_json::to_string(&definition.expression)
                            .map_err(|error| AppError::Database(error.to_string()))?,
                    ),
                    Some(
                        serde_json::to_string(&definition.dependency_column_ids)
                            .map_err(|error| AppError::Database(error.to_string()))?,
                    ),
                    Some(definition.inferred_output_type.as_str().to_string()),
                    Some(definition.fingerprint.clone()),
                ),
                ArchivedCalculatedColumn::Preserved { .. } => (None, None, None, None),
            };
        let archived_definition_json = serde_json::to_string(calculated)
            .map_err(|error| AppError::Database(error.to_string()))?;
        self.conn.execute(
            "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1 AND column_id = $2",
            params![dataset_id, column_id],
        )?;
        self.conn.execute(
            "INSERT INTO _meta_calculated_columns (dataset_id, column_id, formula_id, schema_version, expression_json, dependency_column_ids_json, inferred_output_type, fingerprint, archived_definition_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            params![
                dataset_id,
                column_id,
                calculated.formula_id(),
                calculated.schema_version(),
                expression_json,
                dependency_column_ids_json,
                inferred_output_type,
                fingerprint,
                archived_definition_json,
            ],
        )?;
        Ok(())
    }

    pub(crate) fn delete_calculated_metadata_by_formula_id(
        &self,
        dataset_id: &str,
        formula_id: &str,
    ) -> Result<bool, AppError> {
        let deleted = self.conn.execute(
            "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1 AND formula_id = $2",
            params![dataset_id, formula_id],
        )?;
        Ok(deleted > 0)
    }

    pub(crate) fn calculated_column_names(
        &self,
        dataset_id: &str,
    ) -> Result<HashSet<String>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT columns.col_name
             FROM _meta_columns AS columns
             INNER JOIN _meta_calculated_columns AS calculated
               ON calculated.dataset_id = columns.dataset_id
              AND calculated.column_id = columns.column_id
             WHERE columns.dataset_id = $1",
        )?;
        statement
            .query_map(params![dataset_id], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(AppError::from)
    }

    fn ready_calculated_definitions_by_output(
        &self,
        dataset_id: &str,
    ) -> Result<BTreeMap<String, CalculatedColumnDefinitionV1>, AppError> {
        let archived = self.get_archived_calculated_columns_by_id(dataset_id)?;
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

    fn rematerialize_all_calculated_outputs(&self, dataset_id: &str) -> Result<(), AppError> {
        let definitions_by_output = self.ready_calculated_definitions_by_output(dataset_id)?;
        if definitions_by_output.is_empty() {
            return Ok(());
        }

        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let sql_columns = self
            .get_user_column_descriptors(dataset_id)?
            .into_iter()
            .map(|column| FormulaSqlColumn {
                column_id: column.column_id,
                sql_type: column.sql_type,
                physical_name: column.name,
            })
            .collect::<Vec<_>>();

        let mut remaining = definitions_by_output
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut materialized = BTreeSet::new();
        while !remaining.is_empty() {
            let mut progressed = false;
            let ready = remaining
                .iter()
                .filter(|output_id| {
                    definitions_by_output
                        .get(*output_id)
                        .into_iter()
                        .flat_map(|definition| definition.dependency_column_ids.iter())
                        .all(|dependency| {
                            !definitions_by_output.contains_key(dependency)
                                || materialized.contains(dependency)
                        })
                })
                .cloned()
                .collect::<Vec<_>>();

            for output_id in ready {
                let definition = definitions_by_output.get(&output_id).ok_or_else(|| {
                    AppError::Database(format!("missing calculated definition for {output_id}"))
                })?;
                let compiled = compile_formula_sql(
                    &Self::typed_expression_from_definition(definition)?,
                    &sql_columns,
                )
                .map_err(Self::map_formula_error)?;
                let output_column = sql_columns
                    .iter()
                    .find(|column| column.column_id == output_id)
                    .ok_or_else(|| {
                        AppError::Database(format!("missing SQL column binding for {output_id}"))
                    })?;
                let identifier = Self::quote_identifier(&output_column.physical_name);
                self.conn.execute(
                    &format!(
                        "UPDATE {table_name} SET {identifier} = {}",
                        compiled.value_sql
                    ),
                    [],
                )?;
                remaining.remove(&output_id);
                materialized.insert(output_id);
                progressed = true;
            }

            if !progressed {
                return Err(AppError::InvalidParam(
                    "calculated column graph invalid: unable to resolve dependency order".into(),
                ));
            }
        }

        Ok(())
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

    fn insert_meta_column_with_id(
        &self,
        dataset_id: &str,
        column: &UserColumnDescriptor,
    ) -> Result<(), AppError> {
        uuid::Uuid::parse_str(&column.column_id)
            .map_err(|_| AppError::InvalidParam("invalid column id".into()))?;
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, column_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?, ?)",
            params![
                dataset_id,
                &column.column_id,
                column.col_index,
                &column.name,
                &column.sql_type,
            ],
        )?;
        Ok(())
    }

    fn compatible_calculated_source_columns(
        &self,
        source_dataset_id: &str,
        target_dataset_id: &str,
    ) -> Result<Option<Vec<ArchiveColumnPlan>>, AppError> {
        let source_columns = self.get_archive_column_plans(source_dataset_id)?;
        let has_calculated_columns = source_columns
            .iter()
            .any(|column| column.calculated.is_some());
        if !has_calculated_columns {
            return Ok(None);
        }

        let target_columns = self.get_user_column_descriptors(target_dataset_id)?;
        let schema_matches = source_columns.len() == target_columns.len()
            && source_columns
                .iter()
                .zip(target_columns.iter())
                .all(|(source, target)| {
                    source.name == target.name && source.sql_type == target.sql_type
                });
        if !schema_matches {
            return Err(AppError::InvalidParam(
                "cannot preserve calculated metadata across a UUID-incompatible schema".into(),
            ));
        }

        Ok(Some(source_columns))
    }

    fn adopt_calculated_schema_with_exact_ids(
        &self,
        target_dataset_id: &str,
        source_columns: &[ArchiveColumnPlan],
    ) -> Result<(), AppError> {
        self.replace_archive_column_ids(target_dataset_id, source_columns)?;
        self.replace_archived_calculated_columns(target_dataset_id, source_columns)
    }

    fn clone_calculated_schema_with_new_ids(
        &self,
        target_dataset_id: &str,
        source_columns: &[ArchiveColumnPlan],
    ) -> Result<(), AppError> {
        let target_columns = self.get_user_column_descriptors(target_dataset_id)?;
        let old_to_new_column_ids = source_columns
            .iter()
            .zip(target_columns.iter())
            .map(|(source, target)| (source.column_id.clone(), target.column_id.clone()))
            .collect::<HashMap<_, _>>();
        self.conn.execute(
            "DELETE FROM _meta_calculated_columns WHERE dataset_id = $1",
            params![target_dataset_id],
        )?;
        for (source, target) in source_columns.iter().zip(target_columns.iter()) {
            let Some(calculated) = &source.calculated else {
                continue;
            };
            let cloned = match calculated {
                ArchivedCalculatedColumn::Ready { definition, state } => {
                    ArchivedCalculatedColumn::Ready {
                        definition: remap_definition(
                            definition,
                            uuid::Uuid::new_v4().to_string(),
                            target.column_id.clone(),
                            &old_to_new_column_ids,
                        )
                        .map_err(|error| AppError::InvalidParam(error.message))?,
                        state: state.clone(),
                    }
                }
                ArchivedCalculatedColumn::Preserved { definition } => {
                    ArchivedCalculatedColumn::Preserved {
                        definition: PreservedCalculatedColumnDefinition {
                            formula_id: uuid::Uuid::new_v4().to_string(),
                            schema_version: definition.schema_version.clone(),
                            output_column_id: target.column_id.clone(),
                            archived_definition: definition.archived_definition.clone(),
                        },
                    }
                }
            };
            self.upsert_archived_calculated_column(target_dataset_id, &target.column_id, &cloned)?;
        }
        Ok(())
    }

    fn insert_replayed_meta_column(
        &self,
        dataset_id: &str,
        column_index: i32,
        column_name: &str,
        column_type: &str,
        identity: ReplayedColumnIdentity<'_>,
    ) -> Result<(), AppError> {
        match identity {
            ReplayedColumnIdentity::Exact(column_id) => self.insert_meta_column_with_id(
                dataset_id,
                &UserColumnDescriptor {
                    column_id: column_id.to_string(),
                    col_index: column_index,
                    name: column_name.to_string(),
                    sql_type: column_type.to_string(),
                },
            ),
            ReplayedColumnIdentity::LegacyGenerated => {
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES (?, ?, ?, ?)",
                    params![dataset_id, column_index, column_name, column_type],
                )?;
                Ok(())
            }
        }
    }

    /// Helper: get user columns (excluding _row_id) for a dataset (public for service layer)
    pub fn get_user_columns(&self, dataset_id: &str) -> Result<Vec<(String, String)>, AppError> {
        self.get_user_column_descriptors(dataset_id)?
            .into_iter()
            .map(|column| Ok((column.name, column.sql_type)))
            .collect::<Result<Vec<_>, AppError>>()
    }

    pub fn get_distribution_columns(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<crate::models::distribution::DistributionColumnDescriptorV1>, AppError> {
        self.get_dataset_meta(dataset_id)?;
        let mut statement = self.conn.prepare(
            "SELECT column_id, col_name, col_type, role, col_index
             FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        statement
            .query_map(params![dataset_id], |row| {
                Ok(
                    crate::models::distribution::DistributionColumnDescriptorV1 {
                        column_id: row.get(0)?,
                        name: row.get(1)?,
                        sql_type: row.get(2)?,
                        role: row.get(3)?,
                        index: row.get(4)?,
                    },
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)
    }

    pub fn read_fit_model_rows(
        &self,
        dataset_id: &str,
        generation: u64,
        response_column: &str,
        predictor_columns: &[String],
    ) -> Result<FitModelDataSet, AppError> {
        self.get_dataset_meta(dataset_id)?;

        let current_generation = self.get_dataset_generation(dataset_id)?;
        if current_generation != generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {generation}"
            )));
        }

        if predictor_columns.is_empty() {
            return Err(AppError::InvalidParam(
                "fit model requires at least one predictor column".into(),
            ));
        }

        let user_columns = self.get_user_columns(dataset_id)?;
        let column_types = user_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let response_type = column_types.get(response_column).copied().ok_or_else(|| {
            AppError::InvalidParam(format!("unknown response column: {response_column}"))
        })?;
        if !is_numeric_type(response_type) {
            return Err(AppError::InvalidParam(format!(
                "response column must be numeric: {response_column}"
            )));
        }
        let response_role = self.fit_model_column_role(dataset_id, response_column)?;
        if !response_role.eq_ignore_ascii_case("continuous") {
            return Err(AppError::InvalidParam(format!(
                "response column must be continuous: {response_column}"
            )));
        }

        let mut predictor_names = Vec::new();
        for predictor in predictor_columns {
            let predictor_type =
                column_types
                    .get(predictor.as_str())
                    .copied()
                    .ok_or_else(|| {
                        AppError::InvalidParam(format!("unknown predictor column: {predictor}"))
                    })?;
            if predictor == response_column {
                return Err(AppError::InvalidParam(
                    "response and predictor columns must be distinct".into(),
                ));
            }
            if !is_numeric_type(predictor_type) {
                return Err(AppError::InvalidParam(format!(
                    "predictor column must be numeric: {predictor}"
                )));
            }
            let predictor_role = self.fit_model_column_role(dataset_id, predictor)?;
            if !predictor_role.eq_ignore_ascii_case("continuous") {
                return Err(AppError::InvalidParam(format!(
                    "predictor column must be continuous: {predictor}"
                )));
            }
            if !predictor_names.contains(predictor) {
                predictor_names.push(predictor.clone());
            }
        }

        if predictor_names.is_empty() {
            return Err(AppError::InvalidParam(
                "fit model requires at least one predictor column".into(),
            ));
        }

        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let response_identifier = Self::quote_identifier(response_column);
        let predictor_projection = predictor_names
            .iter()
            .map(|column| Self::quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let query_sql = format!(
            "SELECT \"_row_id\", {response_identifier}, {predictor_projection} FROM {table_name}"
        );

        let mut stmt = self.conn.prepare(&query_sql)?;
        let mut query_rows = stmt.query([])?;
        let mut source_rows = 0_u64;
        let mut used_rows = Vec::new();

        while let Some(row) = query_rows.next()? {
            source_rows += 1;

            let row_index_value = row.get::<_, Value>(0)?;
            let Some(row_index) = fit_model_row_index(row_index_value) else {
                continue;
            };

            let Some(response) =
                fit_y_by_x_numeric_value(row.get::<_, Value>(1)?).filter(|value| value.is_finite())
            else {
                continue;
            };

            let mut predictors = Vec::with_capacity(predictor_names.len());
            let mut valid_row = true;
            for offset in 0..predictor_names.len() {
                let Some(value) = fit_y_by_x_numeric_value(row.get::<_, Value>(offset + 2)?)
                    .filter(|numeric| numeric.is_finite())
                else {
                    valid_row = false;
                    break;
                };
                predictors.push(value);
            }
            if !valid_row {
                continue;
            }

            used_rows.push(FitModelDataRow {
                row_index,
                response,
                predictors,
            });
        }

        let excluded_rows = source_rows
            .checked_sub(used_rows.len() as u64)
            .ok_or_else(|| AppError::Stats("fit model row accounting underflowed".into()))?;
        Ok(FitModelDataSet {
            predictor_names,
            used_rows,
            excluded_rows,
        })
    }

    pub fn read_fit_y_by_x_rows(
        &self,
        dataset_id: &str,
        response_column: &str,
        factor_column: &str,
        personality: FitYByXPersonality,
    ) -> Result<FitYByXRows, AppError> {
        self.get_dataset_meta(dataset_id)?;

        let user_columns = self.get_user_columns(dataset_id)?;
        let response_type = user_columns
            .iter()
            .find(|(name, _)| name == response_column)
            .map(|(_, column_type)| column_type.clone())
            .ok_or_else(|| {
                AppError::InvalidParam(format!("unknown response column: {response_column}"))
            })?;
        let factor_type = user_columns
            .iter()
            .find(|(name, _)| name == factor_column)
            .map(|(_, column_type)| column_type.clone())
            .ok_or_else(|| {
                AppError::InvalidParam(format!("unknown factor column: {factor_column}"))
            })?;

        if response_column == factor_column {
            return Err(AppError::InvalidParam(
                "response and factor columns must not be the same".into(),
            ));
        }
        if !is_numeric_type(&response_type) {
            return Err(AppError::InvalidParam(format!(
                "response column must be numeric: {response_column}"
            )));
        }

        let factor_role = self.fit_y_by_x_column_role(dataset_id, factor_column)?;
        match personality {
            FitYByXPersonality::Oneway => {
                if is_numeric_type(&factor_type) && factor_role.eq_ignore_ascii_case("continuous") {
                    return Err(AppError::InvalidParam(format!(
                        "oneway requires a categorical factor column: {factor_column}"
                    )));
                }
            }
            FitYByXPersonality::Bivariate => {
                if !is_numeric_type(&factor_type) || !factor_role.eq_ignore_ascii_case("continuous")
                {
                    return Err(AppError::InvalidParam(format!(
                        "bivariate requires a continuous numeric factor column: {factor_column}"
                    )));
                }
            }
        }

        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));
        let response_identifier = Self::quote_identifier(response_column);
        let factor_identifier = Self::quote_identifier(factor_column);
        let query_sql =
            format!("SELECT {response_identifier}, {factor_identifier} FROM {table_name}");

        let mut stmt = self.conn.prepare(&query_sql)?;
        let mut source_rows = 0_u64;
        let mut rows = Vec::new();
        let mut query_rows = stmt.query([])?;
        while let Some(row) = query_rows.next()? {
            source_rows += 1;

            let response_value = row.get::<_, Value>(0)?;
            let factor_value = row.get::<_, Value>(1)?;
            let response_numeric = fit_y_by_x_numeric_value(response_value);

            match personality {
                FitYByXPersonality::Oneway => {
                    let Some(y) = response_numeric.filter(|value| value.is_finite()) else {
                        continue;
                    };
                    let Some(group) = fit_y_by_x_display_value(factor_value) else {
                        continue;
                    };
                    rows.push(FitYByXRow::Oneway { y, group });
                }
                FitYByXPersonality::Bivariate => {
                    let Some(y) = response_numeric.filter(|value| value.is_finite()) else {
                        continue;
                    };
                    let Some(x) =
                        fit_y_by_x_numeric_value(factor_value).filter(|value| value.is_finite())
                    else {
                        continue;
                    };
                    rows.push(FitYByXRow::Bivariate { x, y });
                }
            }
        }

        Ok(FitYByXRows { source_rows, rows })
    }

    fn get_storage_user_columns(
        &self,
        dataset_id: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        self.get_dataset_meta(dataset_id)?;
        let internal_table_name = Self::internal_table_name(dataset_id);
        let mut stmt = self.conn.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? AND column_name <> '_row_id' ORDER BY ordinal_position",
        )?;
        stmt.query_map(params![internal_table_name], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)
    }

    fn resolve_navigation_projection(
        &self,
        dataset_id: &str,
        column_ids: &[String],
    ) -> Result<Vec<(String, String)>, AppError> {
        let actual_columns = self
            .get_storage_user_columns(dataset_id)?
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let mut stmt = self.conn.prepare(
            "SELECT column_id, col_name, col_type FROM _meta_columns WHERE dataset_id = ?",
        )?;
        let descriptors = stmt
            .query_map(params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(column_id, column_name, column_type)| (column_id, (column_name, column_type)))
            .collect::<std::collections::HashMap<_, _>>();

        let mut seen = HashSet::new();
        let mut projection = Vec::with_capacity(column_ids.len());
        for column_id in column_ids {
            if !seen.insert(column_id.as_str()) {
                return Err(AppError::InvalidParam(format!(
                    "duplicate column id: {column_id}"
                )));
            }
            let (column_name, metadata_type) = descriptors
                .get(column_id)
                .cloned()
                .ok_or_else(|| AppError::InvalidParam(format!("unknown column id: {column_id}")))?;
            let actual_type = actual_columns.get(&column_name).ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "unresolved projection column for id {column_id}: {column_name}"
                ))
            })?;
            if actual_type != &metadata_type {
                return Err(AppError::InvalidParam(format!(
                    "unresolved projection type for id {column_id}: metadata {metadata_type}, actual {actual_type}"
                )));
            }
            projection.push((column_name, metadata_type));
        }
        Ok(projection)
    }

    pub fn read_hypothesis_test_rows(
        &self,
        dataset_id: &str,
        roles: &HypothesisTestRoles,
    ) -> Result<HypothesisTestRows, AppError> {
        self.get_dataset_meta(dataset_id)?;
        let user_columns = self.get_user_columns(dataset_id)?;
        let column_type = |field: &HypothesisTestFieldRef| {
            user_columns
                .iter()
                .find(|(name, _)| name == &field.name)
                .map(|(_, column_type)| column_type.as_str())
                .ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "unknown hypothesis test column: {}",
                        field.name
                    ))
                })
        };
        let table = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        match roles {
            HypothesisTestRoles::Long {
                response,
                condition,
                subject,
            } => {
                if response.name == condition.name
                    || subject.as_ref().is_some_and(|field| {
                        field.name == response.name || field.name == condition.name
                    })
                {
                    return Err(AppError::InvalidParam(
                        "hypothesis test roles must reference different columns".into(),
                    ));
                }
                if !is_numeric_type(column_type(response)?) {
                    return Err(AppError::InvalidParam(format!(
                        "hypothesis test response must be numeric: {}",
                        response.name
                    )));
                }
                let condition_type = column_type(condition)?;
                if is_numeric_type(condition_type) || is_temporal_type(condition_type) {
                    let condition_role =
                        self.fit_y_by_x_column_role(dataset_id, &condition.name)?;
                    if !matches!(
                        condition_role.to_ascii_lowercase().as_str(),
                        "nominal" | "ordinal"
                    ) {
                        return Err(AppError::InvalidParam(format!(
                            "hypothesis test condition must be categorical: {}",
                            condition.name
                        )));
                    }
                }
                if let Some(subject) = subject {
                    column_type(subject)?;
                }

                let response = Self::quote_identifier(&response.name);
                let condition = Self::quote_identifier(&condition.name);
                let subject_projection = subject
                    .as_ref()
                    .map(|field| format!(", {}", Self::quote_identifier(&field.name)))
                    .unwrap_or_default();
                let query_sql = format!(
                    "SELECT _row_id, {response}, {condition}{subject_projection} FROM {table} ORDER BY _row_id"
                );
                let mut statement = self.conn.prepare(&query_sql)?;
                let mut query_rows = statement.query([])?;
                let mut rows = Vec::new();
                while let Some(row) = query_rows.next()? {
                    let identity =
                        fit_y_by_x_display_value(row.get::<_, Value>(0)?).ok_or_else(|| {
                            AppError::Stats("hypothesis test row identity is missing".into())
                        })?;
                    rows.push(LongHypothesisTestRow {
                        identity,
                        response: fit_y_by_x_numeric_value(row.get::<_, Value>(1)?),
                        condition: fit_y_by_x_display_value(row.get::<_, Value>(2)?),
                        subject: if subject.is_some() {
                            fit_y_by_x_display_value(row.get::<_, Value>(3)?)
                        } else {
                            None
                        },
                    });
                }
                Ok(HypothesisTestRows::Long(rows))
            }
            HypothesisTestRoles::Wide {
                measurements,
                subject,
            } => {
                if measurements.len() < 2 {
                    return Err(AppError::InvalidParam(
                        "wide hypothesis test requires at least two measurement columns".into(),
                    ));
                }
                let mut names = HashSet::new();
                for measurement in measurements {
                    if !names.insert(measurement.name.as_str()) {
                        return Err(AppError::InvalidParam(
                            "wide hypothesis test measurement columns must be unique".into(),
                        ));
                    }
                    if !is_numeric_type(column_type(measurement)?) {
                        return Err(AppError::InvalidParam(format!(
                            "hypothesis test measurement must be numeric: {}",
                            measurement.name
                        )));
                    }
                }
                if let Some(subject) = subject {
                    if names.contains(subject.name.as_str()) {
                        return Err(AppError::InvalidParam(
                            "hypothesis test subject must differ from measurements".into(),
                        ));
                    }
                    column_type(subject)?;
                }

                let measurement_projection = measurements
                    .iter()
                    .map(|field| Self::quote_identifier(&field.name))
                    .collect::<Vec<_>>()
                    .join(", ");
                let subject_projection = subject
                    .as_ref()
                    .map(|field| format!(", {}", Self::quote_identifier(&field.name)))
                    .unwrap_or_default();
                let query_sql = format!(
                    "SELECT _row_id, {measurement_projection}{subject_projection} FROM {table} ORDER BY _row_id"
                );
                let mut statement = self.conn.prepare(&query_sql)?;
                let mut query_rows = statement.query([])?;
                let mut rows = Vec::new();
                while let Some(row) = query_rows.next()? {
                    let identity =
                        fit_y_by_x_display_value(row.get::<_, Value>(0)?).ok_or_else(|| {
                            AppError::Stats("hypothesis test row identity is missing".into())
                        })?;
                    let values = (0..measurements.len())
                        .map(|index| row.get::<_, Value>(index + 1).map(fit_y_by_x_numeric_value))
                        .collect::<Result<Vec<_>, _>>()?;
                    rows.push(WideHypothesisTestRow {
                        identity,
                        subject: if subject.is_some() {
                            fit_y_by_x_display_value(row.get::<_, Value>(measurements.len() + 1)?)
                        } else {
                            None
                        },
                        measurements: values,
                    });
                }
                Ok(HypothesisTestRows::Wide {
                    conditions: measurements
                        .iter()
                        .map(|field| field.name.clone())
                        .collect(),
                    explicit_subject: subject.is_some(),
                    rows,
                })
            }
        }
    }

    fn fit_y_by_x_column_role(
        &self,
        dataset_id: &str,
        column_name: &str,
    ) -> Result<String, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT role FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2")?;
        let mut rows = stmt.query(params![dataset_id, column_name])?;
        let Some(row) = rows.next()? else {
            return Err(AppError::InvalidParam(format!(
                "unknown column role metadata: {column_name}"
            )));
        };
        row.get(0).map_err(AppError::from)
    }

    fn fit_model_column_role(
        &self,
        dataset_id: &str,
        column_name: &str,
    ) -> Result<String, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT role FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2")?;
        let mut rows = stmt.query(params![dataset_id, column_name])?;
        let Some(row) = rows.next()? else {
            return Err(AppError::InvalidParam(format!(
                "unknown column role metadata: {column_name}"
            )));
        };
        row.get(0).map_err(AppError::from)
    }

    pub(crate) fn prepare_archive_keyset_read(
        &self,
        dataset_id: &str,
    ) -> Result<ArchiveKeysetReadPlan, AppError> {
        self.get_dataset_meta(dataset_id)?;
        let columns = self.get_archive_column_plans(dataset_id)?;
        let table_name = Self::quote_identifier(&Self::internal_table_name(dataset_id));

        let select_projection = if columns.is_empty() {
            String::new()
        } else {
            format!(
                ", {}",
                columns
                    .iter()
                    .map(|column| archive_export_expression(&column.name, &column.sql_type))
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

            let row_releasable_bytes = row_bytes.saturating_sub(mem::size_of::<ArchiveBatchRow>());
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
        Value::Text(text) | Value::Enum(text) => base
            .saturating_add(mem::size_of::<String>())
            .saturating_add(text.capacity()),
        Value::Blob(bytes) | Value::Geometry(bytes) => base
            .saturating_add(mem::size_of::<Vec<u8>>())
            .saturating_add(bytes.capacity()),
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
    aggregate_sql_for_field(statistic, &field)
}

fn aggregate_sql_for_field(statistic: &TabulateStatistic, field: &str) -> Result<String, AppError> {
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

fn tabulate_dimension_label(value: serde_json::Value, missing_label: &str) -> String {
    match value {
        serde_json::Value::Null => missing_label.to_string(),
        serde_json::Value::String(text) => text,
        serde_json::Value::Number(number) => {
            if number.as_f64() == Some(0.0) {
                return "0".to_string();
            }
            let text = number.to_string();
            text.strip_suffix(".0")
                .unwrap_or(&text)
                .replace("e-0", "e-")
                .replace("e+0", "e+")
        }
        value => value.to_string(),
    }
}

fn tabulate_dimension_sql_label(expression: &str, data_type: &str) -> String {
    if is_numeric_type(data_type) {
        format!(
            "CASE WHEN {expression} = 0 THEN '0' ELSE replace(replace(regexp_replace(CAST({expression} AS VARCHAR), '\\.0$', ''), 'e-0', 'e-'), 'e+0', 'e+') END"
        )
    } else {
        format!("CAST({expression} AS VARCHAR)")
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

fn fit_y_by_x_numeric_value(value: Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::TinyInt(inner) => Some(inner as f64),
        Value::SmallInt(inner) => Some(inner as f64),
        Value::Int(inner) => Some(inner as f64),
        Value::BigInt(inner) => Some(inner as f64),
        Value::HugeInt(inner) => Some(inner as f64),
        Value::UHugeInt(inner) => Some(inner as f64),
        Value::UTinyInt(inner) => Some(inner as f64),
        Value::USmallInt(inner) => Some(inner as f64),
        Value::UInt(inner) => Some(inner as f64),
        Value::UBigInt(inner) => Some(inner as f64),
        Value::Float(inner) => Some(inner as f64),
        Value::Double(inner) => Some(inner),
        Value::Decimal(inner) => fit_y_by_x_decimal_value(inner),
        _ => None,
    }
}

fn fit_model_row_index(value: Value) -> Option<u64> {
    match value {
        Value::TinyInt(inner) if inner > 0 => Some(inner as u64),
        Value::SmallInt(inner) if inner > 0 => Some(inner as u64),
        Value::Int(inner) if inner > 0 => Some(inner as u64),
        Value::BigInt(inner) if inner > 0 => Some(inner as u64),
        Value::UTinyInt(inner) if inner > 0 => Some(inner as u64),
        Value::USmallInt(inner) if inner > 0 => Some(inner as u64),
        Value::UInt(inner) if inner > 0 => Some(inner as u64),
        Value::UBigInt(inner) if inner > 0 => Some(inner as u64),
        _ => None,
    }
}

fn fit_y_by_x_decimal_value(value: Decimal) -> Option<f64> {
    let scale_factor = 10_f64.powi(i32::from(value.scale()));
    Some((value.value() as f64) / scale_factor)
}

fn fit_y_by_x_display_value(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Boolean(inner) => Some(inner.to_string()),
        Value::TinyInt(inner) => Some(inner.to_string()),
        Value::SmallInt(inner) => Some(inner.to_string()),
        Value::Int(inner) => Some(inner.to_string()),
        Value::BigInt(inner) => Some(inner.to_string()),
        Value::HugeInt(inner) => Some(inner.to_string()),
        Value::UTinyInt(inner) => Some(inner.to_string()),
        Value::USmallInt(inner) => Some(inner.to_string()),
        Value::UInt(inner) => Some(inner.to_string()),
        Value::UBigInt(inner) => Some(inner.to_string()),
        Value::UHugeInt(inner) => Some(inner.to_string()),
        Value::Float(inner) if inner.is_finite() => Some(inner.to_string()),
        Value::Double(inner) if inner.is_finite() => Some(inner.to_string()),
        Value::Text(inner) => Some(inner),
        Value::Decimal(inner) => Some(inner.to_string()),
        Value::Date32(inner) => Some(inner.to_string()),
        Value::Time64(_, inner) => Some(inner.to_string()),
        Value::Timestamp(_, inner) => Some(inner.to_string()),
        Value::Blob(inner) => Some(
            inner
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        ),
        Value::List(inner) => Some(format!("{:?}", inner)),
        Value::Enum(inner) => Some(format!("{:?}", inner)),
        Value::Struct(inner) => Some(format!("{:?}", inner)),
        Value::Map(inner) => Some(format!("{:?}", inner)),
        Value::Array(inner) => Some(format!("{:?}", inner)),
        Value::Union(inner) => Some(format!("{:?}", inner)),
        Value::Float(_) | Value::Double(_) => None,
        other => Some(format!("{:?}", other)),
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

fn is_temporal_type(data_type: &str) -> bool {
    let data_type = data_type.to_ascii_uppercase();
    data_type.contains("DATE") || data_type.contains("TIME") || data_type.contains("TIMESTAMP")
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

fn check_tabulate_cancelled(cancelled: &std::sync::atomic::AtomicBool) -> Result<(), AppError> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        Err(AppError::Cancelled("tabulate_cancelled".into()))
    } else {
        Ok(())
    }
}

fn is_tabulate_percentage(kind: &StatisticKind) -> bool {
    matches!(
        kind,
        StatisticKind::RowPercentage
            | StatisticKind::ColumnPercentage
            | StatisticKind::TotalPercentage
    )
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
    use crate::models::fit_model::{FitModelTerm, FitModelTermKind};
    use crate::models::fit_y_by_x::{FitYByXPersonality, FitYByXRow};
    use crate::models::graph_data::{
        GraphDataRequest, GraphElementRequest, GraphFieldBinding, GraphSampling, GraphViewport,
    };
    use crate::models::table::{
        CellUpdate, CreateTableFromRowsRequest, TableFilterValue, TableNavigationRequest,
        TableWindowFilter, TableWindowFilterRule, TableWindowRequest, TableWindowSort,
    };
    use crate::services::archive_cell::{
        archive_cell_to_json_call_count, reset_archive_cell_to_json_call_count,
    };
    use crate::services::calculated_column_service::{
        CalculatedColumnService, UpsertCalculatedColumnInput,
    };
    use crate::services::data_service::DataService;
    use crate::state::AppState;
    use duckdb::types::Decimal;

    #[test]
    fn tabulate_dimension_labels_match_javascript_scalar_strings() {
        assert_eq!(tabulate_dimension_label(serde_json::json!(1.0), "Missing"), "1");
        assert_eq!(tabulate_dimension_label(serde_json::json!(1.25), "Missing"), "1.25");
        assert_eq!(tabulate_dimension_label(serde_json::json!(-0.0), "Missing"), "0");
        assert_eq!(tabulate_dimension_label(serde_json::json!(1e-7), "Missing"), "1e-7");
        assert_eq!(tabulate_dimension_label(serde_json::Value::Null, "Missing"), "Missing");

        let engine = DuckDbEngine::new_in_memory().expect("engine");
        let expression = tabulate_dimension_sql_label("value", "DOUBLE");
        let mut statement = engine
            .conn()
            .prepare(&format!("SELECT {expression} FROM (VALUES (1.0), (-0.0), (1e-7)) AS source(value)"))
            .expect("prepare labels");
        let labels = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query labels")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect labels");
        assert_eq!(labels, ["1", "0", "1e-7"]);
    }

    #[test]
    fn secondary_connection_shares_the_open_database() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine.conn().execute_batch("CREATE TABLE secondary_probe(value BIGINT); INSERT INTO secondary_probe VALUES (42);")
            .expect("seed primary connection");

        let secondary = engine.open_secondary_connection().expect("secondary connection");
        let value: i64 = secondary.query_row("SELECT value FROM secondary_probe", [], |row| row.get(0))
            .expect("read through secondary connection");

        assert_eq!(value, 42);
    }

    fn mutation_fixture_with_chain() -> (AppState, String) {
        let state = AppState::new().expect("state");
        let dataset_id = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Mutation Fixture".to_string(),
                column_names: vec!["Length".to_string(), "Width".to_string()],
                column_types: vec!["DOUBLE".to_string(), "DOUBLE".to_string()],
                rows: vec![vec![serde_json::json!(2.0), serde_json::json!(3.0)]],
            })
            .expect("seed mutation fixture")
            .id;
        let calculated = CalculatedColumnService::new(&state);
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Area".to_string(),
                formula_text: "Length * Width".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create Area formula");
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "DoubleArea".to_string(),
                formula_text: "Area * 2".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create DoubleArea formula");
        (state, dataset_id)
    }

    fn keyed_update_fixture_with_chain() -> (AppState, String, String) {
        let state = AppState::new().expect("state");
        let data = DataService::new(&state);
        let left_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Left Mutation Fixture".to_string(),
                column_names: vec!["Key".to_string(), "Length".to_string(), "Width".to_string()],
                column_types: vec![
                    "BIGINT".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(1),
                    serde_json::json!(2.0),
                    serde_json::json!(3.0),
                ]],
            })
            .expect("seed keyed left fixture")
            .id;
        let right_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Right Mutation Fixture".to_string(),
                column_names: vec![
                    "Key".to_string(),
                    "Length".to_string(),
                    "Width".to_string(),
                    "Area".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(1),
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(999.0),
                ]],
            })
            .expect("seed keyed right fixture")
            .id;
        let calculated = CalculatedColumnService::new(&state);
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: left_id.clone(),
                output_name: "Area".to_string(),
                formula_text: "Length * Width".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create keyed Area formula");
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: left_id.clone(),
                output_name: "DoubleArea".to_string(),
                formula_text: "Area * 2".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create keyed DoubleArea formula");
        (state, left_id, right_id)
    }

    fn mutation_fixture_with_chain_and_extra_source() -> (AppState, String) {
        let state = AppState::new().expect("state");
        let dataset_id = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Mutation Fixture Extra Source".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Width".to_string(),
                    "Depth".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(2.0),
                    serde_json::json!(3.0),
                    serde_json::json!(4.0),
                ]],
            })
            .expect("seed mutation fixture with extra source")
            .id;
        let calculated = CalculatedColumnService::new(&state);
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Area".to_string(),
                formula_text: "Length * Width".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create Area formula");
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "DoubleArea".to_string(),
                formula_text: "Area * 2".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create DoubleArea formula");
        (state, dataset_id)
    }

    fn create_chain_dataset_in_state(
        state: &AppState,
        name: &str,
        columns: Vec<String>,
        row: Vec<serde_json::Value>,
    ) -> String {
        let dataset_id = DataService::new(state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: name.to_string(),
                column_names: columns,
                column_types: vec!["DOUBLE".to_string(), "DOUBLE".to_string()],
                rows: vec![row],
            })
            .expect("seed chain dataset")
            .id;
        let calculated = CalculatedColumnService::new(state);
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "Area".to_string(),
                formula_text: "Length * Width".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create Area formula");
        calculated
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "DoubleArea".to_string(),
                formula_text: "Area * 2".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create DoubleArea formula");
        dataset_id
    }

    fn numeric_column_values(state: &AppState, dataset_id: &str, column_name: &str) -> Vec<f64> {
        let table = DataService::new(state)
            .query_table(dataset_id, 0, 100, None, None)
            .expect("query dataset");
        let column_index = table
            .columns
            .iter()
            .position(|candidate| candidate == column_name)
            .unwrap_or_else(|| panic!("missing column {column_name}"));
        table
            .rows
            .into_iter()
            .map(|row| {
                row[column_index]
                    .as_f64()
                    .unwrap_or_else(|| panic!("expected numeric {column_name}"))
            })
            .collect()
    }

    fn history_entry_count(state: &AppState, dataset_id: &str) -> i64 {
        let db = state.db.lock().expect("db");
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM _history_change_sets WHERE dataset_id = ?",
                params![dataset_id],
                |row| row.get(0),
            )
            .expect("count history entries")
    }

    fn archived_calculated_columns(
        state: &AppState,
        dataset_id: &str,
    ) -> BTreeMap<String, ArchivedCalculatedColumn> {
        state
            .db
            .lock()
            .expect("db")
            .get_archived_calculated_columns_by_id(dataset_id)
            .expect("archived calculated metadata")
    }

    fn archived_calculated_column_by_name(
        state: &AppState,
        dataset_id: &str,
        column_name: &str,
    ) -> ArchivedCalculatedColumn {
        let column_id = state
            .db
            .lock()
            .expect("db")
            .get_user_column_descriptors(dataset_id)
            .expect("column descriptors")
            .into_iter()
            .find(|column| column.name == column_name)
            .unwrap_or_else(|| panic!("missing calculated column {column_name}"))
            .column_id;
        archived_calculated_columns(state, dataset_id)
            .remove(&column_id)
            .unwrap_or_else(|| panic!("missing calculated metadata for {column_name}"))
    }

    fn latest_history_change_set_id(state: &AppState, dataset_id: &str) -> String {
        let db = state.db.lock().expect("db");
        db.conn()
            .query_row(
                "SELECT id FROM _history_change_sets WHERE dataset_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
                params![dataset_id],
                |row| row.get(0),
            )
            .expect("read latest change set id")
    }

    fn seed_transform_value_table(engine: &DuckDbEngine, id: &str, name: &str, values: &[i64]) {
        engine
            .create_empty_table(id, name, &["value".to_string()], &["BIGINT".to_string()])
            .expect("create transform fixture");
        for value in values {
            let row_id = engine.add_row(id).expect("add transform fixture row");
            engine
                .update_cell(id, row_id, "value", &value.to_string())
                .expect("write transform fixture value");
        }
    }

    fn read_transform_values(engine: &DuckDbEngine, id: &str) -> Vec<i64> {
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(id));
        let mut statement = engine
            .conn
            .prepare(&format!("SELECT value FROM {table} ORDER BY _row_id"))
            .expect("prepare transform fixture read");
        statement
            .query_map([], |row| row.get(0))
            .expect("query transform fixture values")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect transform fixture values")
    }

    fn read_transform_table(
        engine: &DuckDbEngine,
        id: &str,
    ) -> (Vec<String>, Vec<Vec<serde_json::Value>>) {
        let result = engine
            .query_table(id, 0, 100, None, None)
            .expect("read transform table");
        (result.columns, result.rows)
    }

    fn navigation_column_descriptors(
        engine: &DuckDbEngine,
        dataset_id: &str,
    ) -> Vec<(String, String, String)> {
        let mut statement = engine
            .conn
            .prepare(
                "SELECT column_id, col_name, col_type FROM _meta_columns WHERE dataset_id = ? ORDER BY col_index",
            )
            .expect("prepare navigation descriptor query");
        statement
            .query_map(params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query navigation descriptors")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect navigation descriptors")
    }

    fn seed_navigation_dataset(engine: &DuckDbEngine, dataset_id: &str) -> u64 {
        engine
            .create_empty_table(
                dataset_id,
                "Navigation",
                &["value".to_string(), "category".to_string()],
                &["DOUBLE".to_string(), "VARCHAR".to_string()],
            )
            .expect("create navigation fixture");

        for (value, category) in [("1.5", "alpha"), ("2.5", "beta")] {
            let row_id = engine.add_row(dataset_id).expect("add navigation row");
            engine
                .update_cell(dataset_id, row_id, "value", value)
                .expect("write navigation value");
            engine
                .update_cell(dataset_id, row_id, "category", category)
                .expect("write navigation category");
        }

        engine
            .get_dataset_generation(dataset_id)
            .expect("navigation generation")
    }

    fn seed_navigation_tie_dataset(engine: &DuckDbEngine, dataset_id: &str) -> u64 {
        engine
            .create_empty_table(
                dataset_id,
                "Navigation ties",
                &["value".to_string(), "category".to_string()],
                &["DOUBLE".to_string(), "VARCHAR".to_string()],
            )
            .expect("create navigation tie fixture");

        for (value, category) in [("2.5", "beta"), ("1.5", "alpha"), ("2.5", "gamma")] {
            let row_id = engine.add_row(dataset_id).expect("add navigation tie row");
            engine
                .update_cell(dataset_id, row_id, "value", value)
                .expect("write navigation tie value");
            engine
                .update_cell(dataset_id, row_id, "category", category)
                .expect("write navigation tie category");
        }

        engine
            .get_dataset_generation(dataset_id)
            .expect("navigation tie generation")
    }

    fn navigation_request(
        dataset_id: &str,
        generation: u64,
        column_ids: Vec<String>,
    ) -> TableNavigationRequest {
        TableNavigationRequest {
            version: 1,
            request_id: format!("req-{dataset_id}"),
            dataset_id: dataset_id.to_string(),
            generation,
            start: 0,
            count: 10,
            column_ids,
            sort: None,
            filters: vec![],
            session_id: None,
            include_transport_diagnostics: false,
        }
    }

    fn seed_natural_navigation_sparse_dataset(engine: &DuckDbEngine, dataset_id: &str) -> u64 {
        engine
            .seed_benchmark_table(dataset_id, "Natural navigation", 20_000, 1)
            .expect("seed natural navigation fixture");
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
        engine
            .conn
            .execute(
                &format!(
                    "DELETE FROM {table} WHERE _row_id BETWEEN ? AND ? OR _row_id BETWEEN ? AND ? OR _row_id BETWEEN ? AND ?"
                ),
                params![4093_i64, 4100_i64, 8191_i64, 8198_i64, 12_287_i64, 12_294_i64],
            )
            .expect("delete rows around sparse anchor boundaries");
        let retained_rows: i64 = engine
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("retained natural rows");
        engine
            .conn
            .execute(
                "UPDATE _meta_datasets SET row_count = ?, generation = generation + 1 WHERE id = ?",
                params![retained_rows, dataset_id],
            )
            .expect("publish natural navigation generation");
        engine
            .get_dataset_generation(dataset_id)
            .expect("natural navigation generation")
    }

    fn natural_navigation_request(
        dataset_id: &str,
        generation: u64,
        start: usize,
        count: usize,
    ) -> TableNavigationRequest {
        TableNavigationRequest {
            version: 1,
            request_id: format!("req-natural-{start}"),
            dataset_id: dataset_id.to_string(),
            generation,
            start,
            count,
            column_ids: vec![],
            sort: None,
            filters: vec![],
            session_id: None,
            include_transport_diagnostics: false,
        }
    }

    #[test]
    fn natural_navigation_sparse_anchors_match_row_id_order_after_boundary_deletions() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let dataset_id = "natural_sparse";
        let generation = seed_natural_navigation_sparse_dataset(&engine, dataset_id);
        let descriptors = navigation_column_descriptors(&engine, dataset_id);
        let value_id = descriptors[0].0.clone();

        engine
            .rebuild_natural_anchors(dataset_id, generation)
            .expect("rebuild natural anchors");

        for start in [
            0_usize, 1, 4090, 4095, 4096, 4097, 8188, 8192, 12_280, 19_960,
        ] {
            let expected = engine
                .query_table_window(&TableWindowRequest {
                    dataset_id: dataset_id.to_string(),
                    start,
                    count: 32,
                    sort: None,
                    filters: vec![],
                    generation,
                })
                .expect("task 4 natural-order window");
            let mut request = natural_navigation_request(dataset_id, generation, start, 32);
            request.column_ids = vec![value_id.clone()];

            let actual = DuckDbEngine::query_natural_navigation_window(engine.conn(), &request)
                .expect("task 5 anchor-backed natural navigation");

            assert_eq!(actual.total_rows, expected.total_rows);
            assert_eq!(actual.rows, expected.rows);
            assert!(
                engine
                    .natural_navigation_local_offset_for_test(dataset_id, generation, start)
                    .expect("local natural offset")
                    <= NATURAL_ANCHOR_STRIDE - 1
            );
        }
    }

    #[test]
    fn natural_navigation_uses_generation_row_count_and_has_no_count_in_viewport_plan() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let dataset_id = "natural_plan";
        let generation = seed_natural_navigation_sparse_dataset(&engine, dataset_id);
        let value_id = navigation_column_descriptors(&engine, dataset_id)[0]
            .0
            .clone();
        engine
            .rebuild_natural_anchors(dataset_id, generation)
            .expect("rebuild natural anchors");

        let mut request = natural_navigation_request(dataset_id, generation, 20_000, 16);
        request.column_ids = vec![value_id];
        let result = DuckDbEngine::query_natural_navigation_window(engine.conn(), &request)
            .expect("past-end natural navigation");

        assert_eq!(result.total_rows, 19_976);
        assert!(result.rows.is_empty());

        let plan =
            DuckDbEngine::explain_natural_navigation_window_for_test(engine.conn(), &request)
                .expect("natural navigation plan");
        assert!(!plan.to_ascii_uppercase().contains("COUNT(*)"));
    }

    #[test]
    fn natural_navigation_batch_cell_edit_publishes_matching_generation_anchors() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let dataset_id = "natural_cell_edit";
        let initial_generation = seed_natural_navigation_sparse_dataset(&engine, dataset_id);
        engine
            .rebuild_natural_anchors(dataset_id, initial_generation)
            .expect("initial anchors");
        let value_id = navigation_column_descriptors(&engine, dataset_id)[0]
            .0
            .clone();

        let next_generation = engine
            .update_cells_if_generation(
                dataset_id,
                &[
                    CellUpdate {
                        row_id: 4101,
                        column_name: "value_1".to_string(),
                        value: Some("111".to_string()),
                    },
                    CellUpdate {
                        row_id: 8199,
                        column_name: "value_1".to_string(),
                        value: Some("222".to_string()),
                    },
                ],
                Some(initial_generation),
            )
            .expect("batch cell edit");

        let mut request = natural_navigation_request(dataset_id, next_generation, 4092, 4);
        request.column_ids = vec![value_id];
        let result = DuckDbEngine::query_natural_navigation_window(engine.conn(), &request)
            .expect("natural navigation after batch cell edit");

        assert_eq!(result.generation, next_generation);
        assert_eq!(result.rows[0][0], serde_json::json!(4101));
        assert_eq!(result.rows[0][1], serde_json::json!(111));
    }

    #[test]
    fn natural_navigation_column_only_change_set_publishes_matching_generation_anchors() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let dataset_id = "natural_column_change";
        let initial_generation = seed_natural_navigation_sparse_dataset(&engine, dataset_id);
        engine
            .rebuild_natural_anchors(dataset_id, initial_generation)
            .expect("initial anchors");

        let add_change_set = engine
            .add_column_with_change_set(
                dataset_id,
                "added",
                "BIGINT",
                Some(0),
                Some(initial_generation),
            )
            .expect("add column change set");
        let after_add_generation = engine
            .get_dataset_generation(dataset_id)
            .expect("generation after add");
        let added_id = navigation_column_descriptors(&engine, dataset_id)[0]
            .0
            .clone();
        let mut after_add = natural_navigation_request(dataset_id, after_add_generation, 4095, 2);
        after_add.column_ids = vec![added_id];
        DuckDbEngine::query_natural_navigation_window(engine.conn(), &after_add)
            .expect("natural navigation after column add");

        engine
            .apply_change_set(&add_change_set, true)
            .expect("undo column add");
        let after_undo_generation = engine
            .get_dataset_generation(dataset_id)
            .expect("generation after undo");
        let value_id = navigation_column_descriptors(&engine, dataset_id)[0]
            .0
            .clone();
        let mut after_undo = natural_navigation_request(dataset_id, after_undo_generation, 4095, 2);
        after_undo.column_ids = vec![value_id];
        DuckDbEngine::query_natural_navigation_window(engine.conn(), &after_undo)
            .expect("natural navigation after column-only undo");

        engine
            .add_column_with_change_set(
                dataset_id,
                "spare",
                "BIGINT",
                None,
                Some(after_undo_generation),
            )
            .expect("add spare column before delete");
        let before_delete_generation = engine
            .get_dataset_generation(dataset_id)
            .expect("generation before delete");

        let delete_change_set = engine
            .delete_columns_with_change_set(
                dataset_id,
                &["value_1".to_string()],
                Some(before_delete_generation),
            )
            .expect("delete column change set");
        let after_delete_generation = engine
            .get_dataset_generation(dataset_id)
            .expect("generation after delete");
        let mut after_delete =
            natural_navigation_request(dataset_id, after_delete_generation, 4095, 2);
        after_delete.column_ids = vec![];
        DuckDbEngine::query_natural_navigation_window(engine.conn(), &after_delete)
            .expect("natural navigation after column delete");

        engine
            .apply_change_set(&delete_change_set, true)
            .expect("undo column delete");
        let after_restore_generation = engine
            .get_dataset_generation(dataset_id)
            .expect("generation after restore");
        let restored_value_id = navigation_column_descriptors(&engine, dataset_id)[0]
            .0
            .clone();
        let mut after_restore =
            natural_navigation_request(dataset_id, after_restore_generation, 4095, 2);
        after_restore.column_ids = vec![restored_value_id];
        DuckDbEngine::query_natural_navigation_window(engine.conn(), &after_restore)
            .expect("natural navigation after column-only restore");
    }

    #[test]
    fn natural_navigation_csv_import_rolls_back_visible_metadata_when_anchor_publication_fails() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let csv_path = std::env::temp_dir().join(format!(
            "statsplayground-natural-navigation-{}.csv",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&csv_path, "value\n1\n2\n").expect("write csv fixture");
        engine
            .conn
            .execute("DROP TABLE _table_navigation_anchors", [])
            .expect("induce anchor publication failure");

        let result = engine.import_csv(
            "natural_csv_rollback",
            "Natural CSV rollback",
            csv_path.to_str().expect("utf-8 csv fixture path"),
        );
        let _ = std::fs::remove_file(csv_path);

        assert!(result.is_err());
        assert!(engine.get_dataset_meta("natural_csv_rollback").is_err());
        assert!(engine.list_datasets().expect("list datasets").is_empty());
    }

    #[test]
    fn replace_dataset_atomically_promotes_initial_output() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        seed_transform_value_table(&engine, "temporary", "Temporary", &[2, 3]);

        let result = engine
            .replace_dataset_atomically("stable", "temporary", "Output", 0)
            .expect("promote initial output");

        assert_eq!(result.id, "stable");
        assert_eq!(result.name, "Output");
        assert_eq!(result.generation, 0);
        assert_eq!(read_transform_values(&engine, "stable"), vec![2, 3]);
        assert!(engine.get_dataset_meta("temporary").is_err());
    }

    #[test]
    fn batch_source_update_recomputes_chain_and_bumps_generation_once() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);

        data.update_cells(
            &dataset_id,
            &[CellUpdate {
                row_id: 1,
                column_name: "Length".to_string(),
                value: Some("10".to_string()),
            }],
            Some(before_generation),
        )
        .expect("update source cell");

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![60.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("next dataset generation"),
            before_generation + 1
        );
        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count + 1
        );
    }

    #[test]
    fn ordinary_change_set_replay_restores_calculated_metadata_snapshots() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        data.update_cells(
            &dataset_id,
            &[CellUpdate {
                row_id: 1,
                column_name: "Length".to_string(),
                value: Some("10".to_string()),
            }],
            Some(before_generation),
        )
        .expect("apply ordinary mutation");
        let change_set_id = latest_history_change_set_id(&state, &dataset_id);

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo ordinary mutation");
            let restored_before = db
                .get_archived_calculated_columns_by_id(&dataset_id)
                .expect("restore before metadata");
            assert_eq!(restored_before.len(), 2);
            assert!(restored_before
                .values()
                .all(|column| matches!(column, ArchivedCalculatedColumn::Ready { .. })));

            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo ordinary mutation");
            let restored_after = db
                .get_archived_calculated_columns_by_id(&dataset_id)
                .expect("restore after metadata");
            assert_eq!(restored_after.len(), 2);
            assert!(restored_after
                .values()
                .all(|column| matches!(column, ArchivedCalculatedColumn::Ready { .. })));
        }

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![60.0]
        );
    }

    #[test]
    fn calculated_mutation_change_set_paste_replay_restores_formula_metadata_and_chain_values() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.paste_at_position_with_change_set(
                &dataset_id,
                0,
                0,
                &[vec!["10".into()]],
                None,
                &["DOUBLE".into()],
                Some(before_generation),
            )
            .expect("apply history paste source mutation")
        };

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![60.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo history paste");
            let restored_before = db
                .get_archived_calculated_columns_by_id(&dataset_id)
                .expect("restore before metadata");
            assert_eq!(restored_before.len(), 2);
            assert!(restored_before
                .values()
                .all(|column| matches!(column, ArchivedCalculatedColumn::Ready { .. })));
        }

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo history paste");
            let restored_after = db
                .get_archived_calculated_columns_by_id(&dataset_id)
                .expect("restore after metadata");
            assert_eq!(restored_after.len(), 2);
            assert!(restored_after
                .values()
                .all(|column| matches!(column, ArchivedCalculatedColumn::Ready { .. })));
        }

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![60.0]
        );
    }

    #[test]
    fn calculated_mutation_add_column_change_set_replay_restores_formula_metadata_and_values() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.add_column_with_change_set(&dataset_id, "Depth", "DOUBLE", None, Some(2))
                .expect("add plain source column")
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo add column change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo add column change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_add_columns_change_set_replay_restores_formula_metadata_and_values() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.add_columns_with_change_set(
                &dataset_id,
                &[
                    ("Depth".to_string(), "DOUBLE".to_string()),
                    ("Note".to_string(), "VARCHAR".to_string()),
                ],
                None,
                Some(2),
            )
            .expect("add plain source columns")
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo add columns change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo add columns change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_add_valued_columns_change_set_replay_restores_formula_metadata_and_values(
    ) {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.add_valued_columns_with_change_set(
                &dataset_id,
                &[ValuedColumn {
                    name: "Depth".into(),
                    column_type: "DOUBLE".into(),
                    values: vec![(1, Some(4.0))],
                }],
                2,
            )
            .expect("add valued source column")
            .0
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo valued add change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo valued add change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_delete_columns_change_set_replay_restores_formula_metadata_and_values() {
        let (state, dataset_id) = mutation_fixture_with_chain_and_extra_source();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.delete_columns_with_change_set(&dataset_id, &["Depth".to_string()], Some(2))
                .expect("delete unrelated source column")
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo delete columns change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo delete columns change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_alter_column_change_set_replay_restores_formula_metadata_and_values() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.alter_column_with_change_set(&dataset_id, "Length", "LengthWhole", "BIGINT", Some(2))
                .expect("alter source column")
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo alter column change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo alter column change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_alter_columns_type_change_set_replay_restores_formula_metadata_and_values(
    ) {
        let (state, dataset_id) = mutation_fixture_with_chain_and_extra_source();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let change_set_id = {
            let db = state.db.lock().expect("db");
            db.alter_columns_type_with_change_set(
                &dataset_id,
                &["Depth".to_string()],
                "BIGINT",
                Some(2),
            )
            .expect("alter source column types")
        };

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo alter column types change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo alter column types change set");
        }
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn calculated_mutation_update_table_recomputes_chain_and_bumps_generation_once() {
        let (state, left_id, right_id) = keyed_update_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&left_id)
            .expect("left generation");

        data.update_table(&left_id, &right_id, "Key", &["Length".to_string()])
            .expect("update left source column");

        assert_eq!(numeric_column_values(&state, &left_id, "Area"), vec![30.0]);
        assert_eq!(
            numeric_column_values(&state, &left_id, "DoubleArea"),
            vec![60.0]
        );
        assert_eq!(
            data.get_dataset_generation(&left_id)
                .expect("left next generation"),
            before_generation + 1
        );
    }

    #[test]
    fn mutation_guard_coverage_change_column_type_rejects_calculated_output_before_mutation() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let error = data
            .change_column_type(&dataset_id, "Area", "VARCHAR")
            .expect_err("calculated outputs must stay read-only for type changes");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("read-only")));
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after rejected type change"),
            before_generation
        );
    }

    #[test]
    fn mutation_guard_coverage_update_table_rejects_calculated_output_before_mutation() {
        let (state, left_id, right_id) = keyed_update_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&left_id)
            .expect("left generation");

        let error = data
            .update_table(&left_id, &right_id, "Key", &["Area".to_string()])
            .expect_err("update_table must reject writes into calculated outputs");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("read-only")));
        assert_eq!(numeric_column_values(&state, &left_id, "Area"), vec![6.0]);
        assert_eq!(
            data.get_dataset_generation(&left_id)
                .expect("generation after rejected update_table"),
            before_generation
        );
    }

    #[test]
    fn mutation_guard_coverage_delete_columns_with_change_set_rejects_referenced_dependency_before_mutation(
    ) {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .delete_columns_with_change_set(&dataset_id, &["Length".to_string()], Some(2))
            .expect_err("referenced source column delete must fail before mutation");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("dependency") || message.contains("calculated"))
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after rejected delete"),
            before_generation
        );
    }

    #[test]
    fn calculated_output_name_only_rename_preserves_formula_identity_and_replays_exactly() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_area = archived_calculated_column_by_name(&state, &dataset_id, "Area");
        let before_values = numeric_column_values(&state, &dataset_id, "Area");
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let change_set_id = state
            .db
            .lock()
            .expect("db")
            .alter_column_with_change_set(&dataset_id, "Area", "RenamedArea", "DOUBLE", Some(2))
            .expect("name-only calculated output rename should be allowed");

        let after_area = archived_calculated_column_by_name(&state, &dataset_id, "RenamedArea");
        assert_eq!(after_area, before_area);
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "RenamedArea"),
            before_values
        );
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after rename"),
            before_generation + 1
        );

        {
            let db = state.db.lock().expect("db");
            db.apply_change_set(&change_set_id, true)
                .expect("undo calculated output rename");
        }
        assert_eq!(
            archived_calculated_column_by_name(&state, &dataset_id, "Area"),
            before_area
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            before_values
        );

        {
            let db = state.db.lock().expect("db");
            db.apply_change_set(&change_set_id, false)
                .expect("redo calculated output rename");
        }
        assert_eq!(
            archived_calculated_column_by_name(&state, &dataset_id, "RenamedArea"),
            before_area
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "RenamedArea"),
            before_values
        );
    }

    #[test]
    fn terminal_calculated_output_delete_change_set_removes_metadata_and_replays_exactly() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_double_area =
            archived_calculated_column_by_name(&state, &dataset_id, "DoubleArea");
        let before_values = numeric_column_values(&state, &dataset_id, "DoubleArea");
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let change_set_id = state
            .db
            .lock()
            .expect("db")
            .delete_columns_with_change_set(&dataset_id, &["DoubleArea".to_string()], Some(2))
            .expect("terminal calculated output delete should be allowed");

        let after_delete = archived_calculated_columns(&state, &dataset_id);
        assert_eq!(after_delete.len(), 1);
        assert!(DataService::new(&state)
            .query_table(&dataset_id, 0, 100, None, None)
            .expect("query after delete")
            .columns
            .iter()
            .all(|name| name != "DoubleArea"));
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after delete"),
            before_generation + 1
        );

        {
            let db = state.db.lock().expect("db");
            db.apply_change_set(&change_set_id, true)
                .expect("undo terminal calculated delete");
        }
        assert_eq!(
            archived_calculated_column_by_name(&state, &dataset_id, "DoubleArea"),
            before_double_area
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            before_values
        );

        {
            let db = state.db.lock().expect("db");
            db.apply_change_set(&change_set_id, false)
                .expect("redo terminal calculated delete");
        }
        assert_eq!(archived_calculated_columns(&state, &dataset_id).len(), 1);
        assert!(DataService::new(&state)
            .query_table(&dataset_id, 0, 100, None, None)
            .expect("query after redo")
            .columns
            .iter()
            .all(|name| name != "DoubleArea"));
    }

    #[test]
    fn calculated_output_delete_blocks_downstream_direct_and_transitive_dependents() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        CalculatedColumnService::new(&state)
            .upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.clone(),
                output_name: "QuadArea".to_string(),
                formula_text: "DoubleArea * 2".to_string(),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })
            .expect("create transitive dependent formula");
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .delete_columns_with_change_set(
                &dataset_id,
                &["Area".to_string()],
                Some(before_generation),
            )
            .expect_err("calculated output with downstream dependents must be blocked");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("dependency") && message.contains("DoubleArea"))
        );
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after rejected calculated delete"),
            before_generation
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
    }

    #[test]
    fn mutation_guard_coverage_alter_column_with_change_set_rejects_calculated_output_before_mutation(
    ) {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .alter_column_with_change_set(&dataset_id, "Area", "Area", "VARCHAR", Some(2))
            .expect_err("calculated output alter must fail before mutation");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("read-only")));
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after rejected alter"),
            before_generation
        );
    }

    #[test]
    fn mutation_guard_coverage_alter_columns_type_with_change_set_rejects_calculated_output_before_mutation(
    ) {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .alter_columns_type_with_change_set(
                &dataset_id,
                &["Area".to_string()],
                "VARCHAR",
                Some(2),
            )
            .expect_err("calculated output type change must fail before mutation");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("read-only")));
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&dataset_id)
                .expect("generation after rejected alter type"),
            before_generation
        );
    }

    #[test]
    fn mutation_guard_coverage_copy_and_update_table_rejects_calculated_output_before_mutation() {
        let (state, left_id, right_id) = keyed_update_fixture_with_chain();
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&left_id)
            .expect("left generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .copy_and_update_table(
                "copy-guard-id",
                "Copy Guard",
                &left_id,
                &right_id,
                "Key",
                &["Area".to_string()],
            )
            .expect_err("copy/update must reject writes into calculated outputs");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("read-only")));
        assert_eq!(numeric_column_values(&state, &left_id, "Area"), vec![6.0]);
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation(&left_id)
                .expect("left generation after rejected copy/update"),
            before_generation
        );
    }

    #[test]
    fn calculated_mutation_copy_and_update_table_preserves_formula_metadata_and_records_one_history_entry(
    ) {
        let (state, left_id, right_id) = keyed_update_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &left_id);
        let before_formula_ids = before_archived
            .values()
            .map(|column| column.formula_id().to_string())
            .collect::<HashSet<_>>();

        state
            .db
            .lock()
            .expect("db")
            .copy_and_update_table(
                "copy-update-id",
                "Copy Update",
                &left_id,
                &right_id,
                "Key",
                &["Length".to_string()],
            )
            .expect("copy and update calculated dataset");

        assert_eq!(
            numeric_column_values(&state, "copy-update-id", "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, "copy-update-id", "DoubleArea"),
            vec![60.0]
        );
        let copied_archived = archived_calculated_columns(&state, "copy-update-id");
        assert_eq!(copied_archived.len(), 2);
        assert!(copied_archived
            .values()
            .all(|column| matches!(column, ArchivedCalculatedColumn::Ready { .. })));
        assert!(copied_archived
            .values()
            .all(|column| !before_formula_ids.contains(column.formula_id())));
        assert_eq!(history_entry_count(&state, "copy-update-id"), 1);
        assert_eq!(
            DataService::new(&state)
                .get_dataset_generation("copy-update-id")
                .expect("copy generation"),
            1
        );
    }

    #[test]
    fn calculated_mutation_replace_datasets_atomically_preserves_formula_metadata_and_recomputes() {
        let (state, stable_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_archived = archived_calculated_columns(&state, &stable_id);
        let before_generation = data
            .get_dataset_generation(&stable_id)
            .expect("stable generation");
        let temporary_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Batch Compatible Replacement Fixture".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Width".to_string(),
                    "Area".to_string(),
                    "DoubleArea".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            })
            .expect("seed batch replacement fixture")
            .id;

        state
            .db
            .lock()
            .expect("db")
            .replace_datasets_atomically(&[DatasetReplacement {
                stable_id: stable_id.clone(),
                temporary_id: temporary_id.clone(),
                stable_name: "Mutation Fixture Replaced In Batch".to_string(),
                expected_generation: before_generation,
            }])
            .expect("replace calculated dataset in batch");

        assert_eq!(
            numeric_column_values(&state, &stable_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &stable_id, "DoubleArea"),
            vec![60.0]
        );
        assert_eq!(
            archived_calculated_columns(&state, &stable_id),
            before_archived
        );
        assert_eq!(
            data.get_dataset_generation(&stable_id)
                .expect("stable generation after batch replacement"),
            before_generation + 1
        );
        assert!(state
            .db
            .lock()
            .expect("db")
            .get_dataset_meta(&temporary_id)
            .is_err());
    }

    #[test]
    fn calculated_mutation_replace_datasets_atomically_rolls_back_all_datasets_on_incompatible_formula_schema(
    ) {
        let state = AppState::new().expect("state");
        let stable_a_id = create_chain_dataset_in_state(
            &state,
            "Stable A",
            vec!["Length".to_string(), "Width".to_string()],
            vec![serde_json::json!(2.0), serde_json::json!(3.0)],
        );
        let stable_b_id = create_chain_dataset_in_state(
            &state,
            "Stable B",
            vec!["Length".to_string(), "Width".to_string()],
            vec![serde_json::json!(2.0), serde_json::json!(3.0)],
        );
        let data = DataService::new(&state);
        let temp_a_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Batch Rollback Compatible".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Width".to_string(),
                    "Area".to_string(),
                    "DoubleArea".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            })
            .expect("seed rollback compatible temp")
            .id;
        let temp_b_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Batch Rollback Incompatible".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Depth".to_string(),
                    "Area".to_string(),
                    "DoubleArea".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            })
            .expect("seed rollback incompatible temp")
            .id;
        let before_archived_a = archived_calculated_columns(&state, &stable_a_id);
        let before_generation_a = data
            .get_dataset_generation(&stable_a_id)
            .expect("stable A generation");
        let before_archived_b = archived_calculated_columns(&state, &stable_b_id);
        let before_generation_b = data
            .get_dataset_generation(&stable_b_id)
            .expect("stable B generation");

        let error = state
            .db
            .lock()
            .expect("db")
            .replace_datasets_atomically(&[
                DatasetReplacement {
                    stable_id: stable_a_id.clone(),
                    temporary_id: temp_a_id.clone(),
                    stable_name: "Stable A Replaced".to_string(),
                    expected_generation: before_generation_a,
                },
                DatasetReplacement {
                    stable_id: stable_b_id.clone(),
                    temporary_id: temp_b_id.clone(),
                    stable_name: "Stable B Replaced".to_string(),
                    expected_generation: before_generation_b,
                },
            ])
            .expect_err("incompatible batch replacement must roll back fully");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("calculated") || message.contains("column id") || message.contains("UUID"))
        );
        assert_eq!(
            archived_calculated_columns(&state, &stable_a_id),
            before_archived_a
        );
        assert_eq!(
            archived_calculated_columns(&state, &stable_b_id),
            before_archived_b
        );
        assert_eq!(
            numeric_column_values(&state, &stable_a_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &stable_b_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            data.get_dataset_generation(&stable_a_id)
                .expect("stable A generation after rollback"),
            before_generation_a
        );
        assert_eq!(
            data.get_dataset_generation(&stable_b_id)
                .expect("stable B generation after rollback"),
            before_generation_b
        );
        assert!(state
            .db
            .lock()
            .expect("db")
            .get_dataset_meta(&temp_a_id)
            .is_ok());
        assert!(state
            .db
            .lock()
            .expect("db")
            .get_dataset_meta(&temp_b_id)
            .is_ok());
    }

    #[test]
    fn calculated_mutation_rename_preserves_formula_fingerprints_and_values_without_recomputation()
    {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            let table_name =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
            db.conn()
                .execute(&format!("UPDATE {table_name} SET Area = 777.0, DoubleArea = 888.0 WHERE _row_id = 1"), [])
                .expect("seed non-recomputed calculated values");
            db.rename_column(&dataset_id, "Area", "AreaRenamed")
                .expect("rename calculated output");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "AreaRenamed"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
    }

    #[test]
    fn calculated_mutation_reorder_preserves_formula_fingerprints_and_values_without_recomputation()
    {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let before_generation = DataService::new(&state)
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        {
            let db = state.db.lock().expect("db");
            let table_name =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
            db.conn()
                .execute(&format!("UPDATE {table_name} SET Area = 777.0, DoubleArea = 888.0 WHERE _row_id = 1"), [])
                .expect("seed non-recomputed calculated values");
            db.reorder_column_if_generation(&dataset_id, 3, 0, before_generation)
                .expect("reorder calculated output column");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
    }

    #[test]
    fn calculated_mutation_live_delete_column_rejects_dependency_before_mutation() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);

        let error = data
            .delete_column(&dataset_id, "Length")
            .expect_err("live delete_column must reject calculated dependencies");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("dependency") || message.contains("calculated"))
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after rejected live delete"),
            before_generation
        );
        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count
        );
    }

    #[test]
    fn calculated_mutation_live_delete_column_records_exact_history_and_one_generation_increment() {
        let (state, dataset_id) = mutation_fixture_with_chain_and_extra_source();
        let data = DataService::new(&state);
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);

        data.delete_column(&dataset_id, "Depth")
            .expect("delete unrelated source column");

        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count + 1
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after live delete"),
            before_generation + 1
        );
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        let change_set_id = latest_history_change_set_id(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo live delete column");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after undo live delete"),
            before_generation + 2
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo live delete column");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after redo live delete"),
            before_generation + 3
        );
    }

    #[test]
    fn calculated_mutation_live_change_column_type_recomputes_chain_and_records_exact_history() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            let table_name =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
            db.conn()
                .execute(
                    &format!(
                        "UPDATE {table_name} SET Area = 777.0, DoubleArea = 888.0 WHERE _row_id = 1"
                    ),
                    [],
                )
                .expect("seed stale calculated values before type change");
        }

        data.change_column_type(&dataset_id, "Width", "BIGINT")
            .expect("change source column type through live path");

        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count + 1
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after live type change"),
            before_generation + 1
        );
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );

        let change_set_id = latest_history_change_set_id(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo live type change");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after undo live type change"),
            before_generation + 2
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo live type change");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![6.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![12.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after redo live type change"),
            before_generation + 3
        );
    }

    #[test]
    fn calculated_mutation_live_rename_records_exact_history_without_recomputation() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            let table_name =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
            db.conn()
                .execute(
                    &format!(
                        "UPDATE {table_name} SET Area = 777.0, DoubleArea = 888.0 WHERE _row_id = 1"
                    ),
                    [],
                )
                .expect("seed non-recomputed calculated values before rename");
        }

        data.rename_column(&dataset_id, "Area", "AreaRenamed")
            .expect("rename calculated output through live path");

        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count + 1
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after live rename"),
            before_generation + 1
        );
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "AreaRenamed"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );

        let change_set_id = latest_history_change_set_id(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo live rename");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after undo live rename"),
            before_generation + 2
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo live rename");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "AreaRenamed"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after redo live rename"),
            before_generation + 3
        );
    }

    #[test]
    fn calculated_mutation_live_reorder_records_exact_history_without_recomputation() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_archived = archived_calculated_columns(&state, &dataset_id);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let before_history_count = history_entry_count(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            let table_name =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
            db.conn()
                .execute(
                    &format!(
                        "UPDATE {table_name} SET Area = 777.0, DoubleArea = 888.0 WHERE _row_id = 1"
                    ),
                    [],
                )
                .expect("seed non-recomputed calculated values before reorder");
        }

        data.reorder_column_if_generation(&dataset_id, 3, 0, before_generation)
            .expect("reorder calculated output through live path");

        assert_eq!(
            history_entry_count(&state, &dataset_id),
            before_history_count + 1
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after live reorder"),
            before_generation + 1
        );
        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );

        let change_set_id = latest_history_change_set_id(&state, &dataset_id);
        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before undo");
            db.apply_change_set(&change_set_id, true)
                .expect("undo live reorder");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
        assert_eq!(
            state
                .db
                .lock()
                .expect("db")
                .get_user_columns(&dataset_id)
                .expect("columns after undo live reorder")
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["Length", "Width", "Area", "DoubleArea"]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after undo live reorder"),
            before_generation + 2
        );

        {
            let db = state.db.lock().expect("db");
            db.conn()
                .execute(
                    "DELETE FROM _meta_calculated_columns WHERE dataset_id = ?",
                    params![&dataset_id],
                )
                .expect("clear calculated metadata before redo");
            db.apply_change_set(&change_set_id, false)
                .expect("redo live reorder");
        }

        assert_eq!(
            archived_calculated_columns(&state, &dataset_id),
            before_archived
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![777.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![888.0]
        );
        assert_eq!(
            state
                .db
                .lock()
                .expect("db")
                .get_user_columns(&dataset_id)
                .expect("columns after redo live reorder")
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["DoubleArea", "Length", "Width", "Area"]
        );
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after redo live reorder"),
            before_generation + 3
        );
    }

    #[test]
    fn calculated_mutation_replace_dataset_atomically_rejects_incompatible_calculated_uuid_schema()
    {
        let (state, stable_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let temporary_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Replacement Fixture".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Depth".to_string(),
                    "Area".to_string(),
                    "DoubleArea".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            })
            .expect("seed replacement fixture")
            .id;
        let before_generation = data
            .get_dataset_generation(&stable_id)
            .expect("stable generation");

        let error = {
            let db = state.db.lock().expect("db");
            db.replace_dataset_atomically(
                &stable_id,
                &temporary_id,
                "Mutation Fixture Refreshed",
                before_generation,
            )
            .expect_err("uuid-incompatible calculated replacement must fail")
        };

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("calculated") || message.contains("column id") || message.contains("UUID"))
        );
        assert_eq!(numeric_column_values(&state, &stable_id, "Area"), vec![6.0]);
        assert_eq!(
            data.get_dataset_generation(&stable_id)
                .expect("stable generation after rejected replacement"),
            before_generation
        );
        assert!(state
            .db
            .lock()
            .expect("db")
            .get_dataset_meta(&temporary_id)
            .is_ok());
    }

    #[test]
    fn calculated_mutation_replace_dataset_atomically_preserves_compatible_formula_schema_and_recomputes(
    ) {
        let (state, stable_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let temporary_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Compatible Replacement Fixture".to_string(),
                column_names: vec![
                    "Length".to_string(),
                    "Width".to_string(),
                    "Area".to_string(),
                    "DoubleArea".to_string(),
                ],
                column_types: vec![
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                ],
                rows: vec![vec![
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            })
            .expect("seed compatible replacement fixture")
            .id;
        let before_generation = data
            .get_dataset_generation(&stable_id)
            .expect("stable generation");

        {
            let db = state.db.lock().expect("db");
            db.replace_dataset_atomically(
                &stable_id,
                &temporary_id,
                "Mutation Fixture Refreshed",
                before_generation,
            )
            .expect("replace compatible calculated dataset");
        }

        assert_eq!(
            numeric_column_values(&state, &stable_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &stable_id, "DoubleArea"),
            vec![60.0]
        );
        {
            let db = state.db.lock().expect("db");
            let restored = db
                .get_archived_calculated_columns_by_id(&stable_id)
                .expect("preserved calculated metadata");
            assert_eq!(restored.len(), 2);
        }
        assert_eq!(
            data.get_dataset_generation(&stable_id)
                .expect("stable generation after replacement"),
            before_generation + 1
        );
    }

    #[test]
    fn calculated_mutation_restore_snapshot_preserves_compatible_formula_schema_and_recomputes() {
        let (state, dataset_id) = mutation_fixture_with_chain();
        let data = DataService::new(&state);
        let before_generation = data
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let (column_names, column_types): (Vec<_>, Vec<_>) = {
            let db = state.db.lock().expect("db");
            db.get_user_columns(&dataset_id)
                .expect("existing columns")
                .into_iter()
                .unzip()
        };

        {
            let db = state.db.lock().expect("db");
            db.restore_snapshot(
                &dataset_id,
                &column_names,
                &column_types,
                &[vec![
                    serde_json::json!(1),
                    serde_json::json!(10.0),
                    serde_json::json!(3.0),
                    serde_json::json!(0.0),
                    serde_json::json!(0.0),
                ]],
            )
            .expect("restore compatible snapshot");
        }

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Area"),
            vec![30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "DoubleArea"),
            vec![60.0]
        );
        {
            let db = state.db.lock().expect("db");
            let restored = db
                .get_archived_calculated_columns_by_id(&dataset_id)
                .expect("restored calculated metadata");
            assert_eq!(restored.len(), 2);
        }
        assert_eq!(
            data.get_dataset_generation(&dataset_id)
                .expect("generation after restore"),
            before_generation + 1
        );
    }

    #[test]
    fn replace_dataset_atomically_preserves_stable_identity_and_replaces_schema() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        seed_transform_value_table(&engine, "stable", "Output", &[1]);
        engine
            .create_empty_table(
                "temporary",
                "Temporary",
                &["replacement".to_string()],
                &["VARCHAR".to_string()],
            )
            .expect("create replacement fixture");
        let row_id = engine.add_row("temporary").expect("add replacement row");
        engine
            .update_cell("temporary", row_id, "replacement", "new")
            .expect("write replacement value");
        let generation = engine
            .get_dataset_generation("stable")
            .expect("stable generation");

        let result = engine
            .replace_dataset_atomically("stable", "temporary", "Output refreshed", generation)
            .expect("replace output");

        assert_eq!(result.id, "stable");
        assert_eq!(result.name, "Output refreshed");
        assert_eq!(result.generation, generation + 1);
        assert_eq!(
            engine.get_user_columns("stable").expect("stable columns"),
            vec![("replacement".to_string(), "VARCHAR".to_string())],
        );
        assert!(engine.get_dataset_meta("temporary").is_err());
    }

    #[test]
    fn replace_dataset_atomically_rolls_back_on_stale_generation() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        seed_transform_value_table(&engine, "stable", "Output", &[1]);
        seed_transform_value_table(&engine, "temporary", "Temporary", &[2]);
        let generation = engine
            .get_dataset_generation("stable")
            .expect("stable generation");

        let error = engine
            .replace_dataset_atomically("stable", "temporary", "Output refreshed", generation + 1)
            .expect_err("stale replacement must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
        );
        assert_eq!(read_transform_values(&engine, "stable"), vec![1]);
        assert_eq!(read_transform_values(&engine, "temporary"), vec![2]);
        assert_eq!(
            engine
                .get_dataset_generation("stable")
                .expect("unchanged stable generation"),
            generation,
        );
    }

    #[test]
    fn copy_and_update_table_leaves_both_inputs_unchanged() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        for (id, name, rows) in [
            ("left", "Left", [(1, "old"), (2, "keep")]),
            ("right", "Right", [(1, "new"), (3, "unused")]),
        ] {
            engine
                .create_empty_table(
                    id,
                    name,
                    &["id".to_string(), "status".to_string()],
                    &["BIGINT".to_string(), "VARCHAR".to_string()],
                )
                .expect("create update fixture");
            for (key, status) in rows {
                let row_id = engine.add_row(id).expect("add update fixture row");
                engine
                    .update_cell(id, row_id, "id", &key.to_string())
                    .expect("write update key");
                engine
                    .update_cell(id, row_id, "status", status)
                    .expect("write update value");
            }
        }
        let before_left = read_transform_table(&engine, "left");
        let before_right = read_transform_table(&engine, "right");

        let result = engine
            .copy_and_update_table(
                "temporary",
                "Updated copy",
                "left",
                "right",
                "id",
                &["status".to_string()],
            )
            .expect("derive updated copy");

        assert_eq!(result.id, "temporary");
        assert_eq!(read_transform_table(&engine, "left"), before_left);
        assert_eq!(read_transform_table(&engine, "right"), before_right);
        let (output_columns, output_rows) = read_transform_table(&engine, "temporary");
        let status_index = output_columns
            .iter()
            .position(|column| column == "status")
            .expect("status output column");
        assert_eq!(output_rows[0][status_index], serde_json::json!("new"));
        assert_eq!(output_rows[1][status_index], serde_json::json!("keep"));
    }

    #[test]
    fn query_table_navigation_window_returns_only_requested_columns_in_requested_order() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_dataset(&engine, "navigation_order");
        let descriptors = navigation_column_descriptors(&engine, "navigation_order");
        let value_id = descriptors[0].0.clone();
        let category_id = descriptors[1].0.clone();

        let result = engine
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-order".to_string(),
                dataset_id: "navigation_order".to_string(),
                generation,
                start: 0,
                count: 10,
                column_ids: vec![category_id, value_id],
                sort: None,
                filters: vec![],
                session_id: Some("session-order".to_string()),
                include_transport_diagnostics: false,
            })
            .expect("navigation query should succeed");

        assert_eq!(result.version, 1);
        assert_eq!(result.columns, vec!["_row_id", "category", "value"]);
        assert_eq!(result.column_types, vec!["BIGINT", "VARCHAR", "DOUBLE"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0].len(), 3);
        assert_eq!(result.request_id, "req-order");
        assert_eq!(result.session_id.as_deref(), Some("session-order"));
    }

    #[test]
    fn query_table_navigation_window_rejects_duplicate_unknown_and_stale_requests() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_dataset(&engine, "navigation_validation");
        let descriptors = navigation_column_descriptors(&engine, "navigation_validation");
        let value_id = descriptors[0].0.clone();

        let duplicate_error = engine
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-duplicate".to_string(),
                dataset_id: "navigation_validation".to_string(),
                generation,
                start: 0,
                count: 10,
                column_ids: vec![value_id.clone(), value_id.clone()],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect_err("duplicate column ids must be rejected");
        assert!(
            matches!(duplicate_error, AppError::InvalidParam(message) if message.contains("duplicate"))
        );

        let unknown_error = engine
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-unknown".to_string(),
                dataset_id: "navigation_validation".to_string(),
                generation,
                start: 0,
                count: 10,
                column_ids: vec!["missing-column".to_string()],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect_err("unknown column ids must be rejected");
        assert!(
            matches!(unknown_error, AppError::InvalidParam(message) if message.contains("unknown"))
        );

        let stale_error = engine
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-stale".to_string(),
                dataset_id: "navigation_validation".to_string(),
                generation: generation + 1,
                start: 0,
                count: 10,
                column_ids: vec![value_id],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect_err("stale generation must be rejected");
        assert!(
            matches!(stale_error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
        );
    }

    #[test]
    fn query_table_navigation_window_rejects_unresolved_projection_metadata() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_dataset(&engine, "navigation_unresolved");
        let descriptors = navigation_column_descriptors(&engine, "navigation_unresolved");
        let category_id = descriptors[1].0.clone();

        engine
            .conn
            .execute(
                "UPDATE _meta_columns SET col_name = 'missing_projection' WHERE dataset_id = ? AND column_id = ?",
                params!["navigation_unresolved", &category_id],
            )
            .expect("corrupt projection metadata");

        let error = engine
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-unresolved".to_string(),
                dataset_id: "navigation_unresolved".to_string(),
                generation,
                start: 0,
                count: 10,
                column_ids: vec![category_id],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect_err("unresolved metadata projection must be rejected");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("projection") || message.contains("column"))
        );
    }

    #[test]
    fn query_table_navigation_window_rejects_zero_and_oversized_counts() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_dataset(&engine, "navigation_count_bounds");
        let descriptors = navigation_column_descriptors(&engine, "navigation_count_bounds");
        let value_id = descriptors[0].0.clone();

        for (count, label) in [(0_usize, "zero"), (2_001_usize, "oversized")] {
            let mut request = navigation_request(
                "navigation_count_bounds",
                generation,
                vec![value_id.clone()],
            );
            request.request_id = format!("req-count-{label}");
            request.count = count;

            let error = engine
                .query_table_navigation_window(&request)
                .expect_err("out-of-range count must be rejected");
            assert!(
                matches!(error, AppError::InvalidParam(message) if message.contains("between 1 and 2000"))
            );
        }
    }

    #[test]
    fn query_table_navigation_window_clamps_past_dataset_end_without_error() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_dataset(&engine, "navigation_clamp");
        let descriptors = navigation_column_descriptors(&engine, "navigation_clamp");
        let value_id = descriptors[0].0.clone();

        let mut tail_request =
            navigation_request("navigation_clamp", generation, vec![value_id.clone()]);
        tail_request.request_id = "req-tail-clamp".to_string();
        tail_request.start = 1;
        tail_request.count = 10;
        let tail_result = engine
            .query_table_navigation_window(&tail_request)
            .expect("tail-overflow window should clamp to remaining rows");

        assert_eq!(tail_result.start, 1);
        assert_eq!(tail_result.total_rows, 2);
        assert_eq!(tail_result.rows.len(), 1);
        assert_eq!(tail_result.rows[0][0], serde_json::json!(2));

        let mut past_end_request =
            navigation_request("navigation_clamp", generation, vec![value_id]);
        past_end_request.request_id = "req-past-end-clamp".to_string();
        past_end_request.start = 20;
        past_end_request.count = 10;
        let past_end_result = engine
            .query_table_navigation_window(&past_end_request)
            .expect("past-end window should return an empty slice");

        assert_eq!(past_end_result.start, 20);
        assert_eq!(past_end_result.total_rows, 2);
        assert!(past_end_result.rows.is_empty());
    }

    #[test]
    fn query_table_navigation_window_sorts_ties_deterministically_by_row_id() {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        let generation = seed_navigation_tie_dataset(&engine, "navigation_ties");
        let descriptors = navigation_column_descriptors(&engine, "navigation_ties");
        let value_id = descriptors[0].0.clone();
        let category_id = descriptors[1].0.clone();

        let mut request =
            navigation_request("navigation_ties", generation, vec![value_id, category_id]);
        request.request_id = "req-navigation-ties".to_string();
        request.count = 3;
        request.sort = Some(TableWindowSort {
            column: "value".to_string(),
            descending: true,
        });

        let result = engine
            .query_table_navigation_window(&request)
            .expect("sorted navigation query should succeed");

        let row_ids = result
            .rows
            .iter()
            .map(|row| row[0].clone())
            .collect::<Vec<_>>();
        let categories = result
            .rows
            .iter()
            .map(|row| row[2].clone())
            .collect::<Vec<_>>();

        assert_eq!(
            row_ids,
            vec![
                serde_json::json!(1),
                serde_json::json!(3),
                serde_json::json!(2)
            ]
        );
        assert_eq!(
            categories,
            vec![
                serde_json::json!("beta"),
                serde_json::json!("gamma"),
                serde_json::json!("alpha")
            ]
        );
    }

    #[test]
    fn imports_selected_sqlite_table_and_appends_compatible_rows() {
        let path =
            std::env::temp_dir().join(format!("datalink-selected-{}.sqlite", uuid::Uuid::new_v4()));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch(
                "CREATE TABLE people (id INTEGER, name TEXT); \
                 INSERT INTO people VALUES (1, 'Ada'); \
                 CREATE TABLE ignored (id INTEGER); \
                 INSERT INTO ignored VALUES (2);",
            )
            .expect("populate SQLite fixture");
        drop(sqlite);

        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let imported = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("people".to_string(), "People".to_string(), false)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("import selected table");

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].1.name, "People");
        assert_eq!(imported[0].1.row_count, 1);
        assert_eq!(db.list_datasets().expect("list datasets").len(), 1);
        let generation_before_append = db
            .get_dataset_generation(&imported[0].1.id)
            .expect("read initial generation");

        let appended = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("people".to_string(), "People".to_string(), true)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("append compatible table");

        assert_eq!(appended.len(), 1);
        assert_eq!(appended[0].1.row_count, 2);
        assert_eq!(db.list_datasets().expect("list datasets").len(), 1);
        assert_eq!(
            db.get_dataset_generation(&imported[0].1.id)
                .expect("read appended generation"),
            generation_before_append + 1
        );

        let error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("ignored".to_string(), "People".to_string(), true)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect_err("reject incompatible append");
        assert!(error
            .to_string()
            .contains("column names, order, and types must match"));
        assert_eq!(
            db.get_dataset_meta(&imported[0].1.id)
                .expect("read unchanged dataset")
                .row_count,
            2
        );

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn streams_sqlite_rows_in_bounded_batches() {
        use std::cell::RefCell;

        let path = std::env::temp_dir().join(format!(
            "datalink-streaming-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute(
                "CREATE TABLE samples (id INTEGER, label TEXT, payload BLOB)",
                [],
            )
            .expect("create source table");
        let transaction = sqlite.transaction().expect("start fixture transaction");
        for index in 0..2_001 {
            let label = if index == 0 {
                Some("O'Reilly".to_string())
            } else if index == 1 {
                None
            } else if index == 2 {
                Some("Unicode 数据 café".to_string())
            } else if index == 3 {
                Some("x".repeat(100_000))
            } else {
                Some(format!("row-{index}"))
            };
            transaction
                .execute(
                    "INSERT INTO samples VALUES (?1, ?2, ?3)",
                    rusqlite::params![index, label, vec![1_u8, 2, 3]],
                )
                .expect("insert source row");
        }
        transaction.commit().expect("commit fixture rows");
        drop(sqlite);

        let progress = RefCell::new(Vec::new());
        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let imported = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("samples".to_string(), "Samples".to_string(), false)],
                &|_, _, _, rows_done, rows_total| {
                    if rows_done > 0 {
                        progress.borrow_mut().push((rows_done, rows_total));
                    }
                },
                &|| false,
            )
            .expect("stream source table");

        assert_eq!(imported[0].1.row_count, 2_001);
        assert_eq!(
            imported[0].1.source_path.as_deref(),
            path.file_name().and_then(|name| name.to_str())
        );
        assert_eq!(
            *progress.borrow(),
            vec![(1_000, 2_001), (2_000, 2_001), (2_001, 2_001)]
        );
        let table_name = format!("dataset_{}", imported[0].1.id.replace('-', "_"));
        let first_label: String = db
            .conn()
            .query_row(
                &format!(
                    "SELECT label FROM {} WHERE _row_id = 1",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| row.get(0),
            )
            .expect("read quoted text");
        let second_label: Option<String> = db
            .conn()
            .query_row(
                &format!(
                    "SELECT label FROM {} WHERE _row_id = 2",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| row.get(0),
            )
            .expect("read null text");
        let first_payload: Vec<u8> = db
            .conn()
            .query_row(
                &format!(
                    "SELECT payload FROM {} WHERE _row_id = 1",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| row.get(0),
            )
            .expect("read blob policy result");
        assert_eq!(first_label, "O'Reilly");
        assert_eq!(second_label, None);
        assert_eq!(first_payload, vec![1_u8, 2, 3]);
        let text_values: (String, usize) = db
            .conn()
            .query_row(
                &format!(
                    "SELECT MAX(CASE WHEN _row_id = 3 THEN label END), \
                     MAX(CASE WHEN _row_id = 4 THEN LENGTH(label) END) FROM {}",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read Unicode and long text");
        assert_eq!(text_values, ("Unicode 数据 café".to_string(), 100_000));

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn preserves_sqlite_dates_as_text_and_rolls_back_invalid_numeric_values() {
        let path =
            std::env::temp_dir().join(format!("datalink-types-{}.sqlite", uuid::Uuid::new_v4()));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch(
                "CREATE TABLE dated (occurred_on DATE, recorded_at DATETIME, amount DECIMAL(12,2)); \
                 INSERT INTO dated VALUES ('2026-09-03', '2026-09-03T14:30:15+08:00', 12.34); \
                 CREATE TABLE invalid_numbers (amount INTEGER); \
                 INSERT INTO invalid_numbers VALUES ('not-a-number');",
            )
            .expect("populate SQLite fixture");
        drop(sqlite);

        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let imported = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("dated".to_string(), "Dated".to_string(), false)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("import date values");
        let table_name = format!("dataset_{}", imported[0].1.id.replace('-', "_"));
        let values: (String, String, f64) = db
            .conn()
            .query_row(
                &format!(
                    "SELECT occurred_on, recorded_at, amount FROM {}",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read preserved dates");
        assert_eq!(values.0, "2026-09-03");
        assert_eq!(values.1, "2026-09-03T14:30:15+08:00");
        assert!((values.2 - 12.34).abs() < f64::EPSILON);

        let error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[(
                    "invalid_numbers".to_string(),
                    "Invalid Numbers".to_string(),
                    false,
                )],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect_err("reject invalid numeric value");
        assert!(error
            .to_string()
            .contains("Cannot convert value 'not-a-number'"));
        assert_eq!(db.list_datasets().expect("list datasets").len(), 1);
        let physical_invalid_tables: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables \
                 WHERE table_name LIKE 'dataset_%' AND table_name <> ?1",
                [&table_name],
                |row| row.get(0),
            )
            .expect("count invalid physical tables");
        assert_eq!(physical_invalid_tables, 0);

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn preserves_sqlite_integer_extremes_and_rejects_non_finite_reals() {
        let path = std::env::temp_dir().join(format!(
            "datalink-numeric-extremes-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute("CREATE TABLE extremes (value INTEGER)", [])
            .expect("create integer table");
        sqlite
            .execute(
                "INSERT INTO extremes VALUES (?1), (?2)",
                rusqlite::params![i64::MIN, i64::MAX],
            )
            .expect("insert integer extremes");
        sqlite
            .execute("CREATE TABLE invalid_reals (value REAL)", [])
            .expect("create real table");
        sqlite
            .execute("INSERT INTO invalid_reals VALUES (?1)", [f64::INFINITY])
            .expect("insert infinity");
        drop(sqlite);

        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let imported = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("extremes".to_string(), "Extremes".to_string(), false)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("import integer extremes");
        let table_name = format!("dataset_{}", imported[0].1.id.replace('-', "_"));
        let values: (i64, i64) = db
            .conn()
            .query_row(
                &format!(
                    "SELECT MIN(value), MAX(value) FROM {}",
                    DuckDbEngine::quote_identifier(&table_name)
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read integer extremes");
        assert_eq!(values, (i64::MIN, i64::MAX));

        let infinity_error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[(
                    "invalid_reals".to_string(),
                    "Invalid Reals".to_string(),
                    false,
                )],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect_err("reject infinity");
        assert!(infinity_error
            .to_string()
            .contains("Cannot convert value 'inf'"));
        assert_eq!(db.list_datasets().expect("list datasets").len(), 1);

        for value in [f64::NAN, f64::NEG_INFINITY] {
            let error = DuckDbEngine::convert_sqlite_value(
                ConnectorValue::Real(value),
                "DOUBLE",
                "invalid_reals",
                "value",
                1,
            )
            .expect_err("reject non-finite real");
            assert!(error.to_string().contains("Cannot convert value"));
        }

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn imports_empty_table_and_rolls_back_when_second_table_fails() {
        let path = std::env::temp_dir().join(format!(
            "datalink-atomic-multi-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch(
                "CREATE TABLE empty_values (id INTEGER, label TEXT); \
                 CREATE TABLE valid_values (id INTEGER); \
                 INSERT INTO valid_values VALUES (1); \
                 CREATE TABLE invalid_values (amount INTEGER); \
                 INSERT INTO invalid_values VALUES ('not-a-number');",
            )
            .expect("populate SQLite fixture");
        drop(sqlite);

        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let empty = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[(
                    "empty_values".to_string(),
                    "Empty Values".to_string(),
                    false,
                )],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("import empty table");
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].1.row_count, 0);
        assert_eq!(empty[0].2, 0);

        let error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[
                    (
                        "valid_values".to_string(),
                        "Valid Values".to_string(),
                        false,
                    ),
                    (
                        "invalid_values".to_string(),
                        "Invalid Values".to_string(),
                        false,
                    ),
                ],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect_err("roll back when second table fails");
        assert!(error
            .to_string()
            .contains("Cannot convert value 'not-a-number'"));

        let datasets = db.list_datasets().expect("list datasets after rollback");
        assert_eq!(datasets.len(), 1);
        assert_eq!(datasets[0].name, "Empty Values");
        assert_eq!(datasets[0].row_count, 0);

        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn cancelled_sqlite_import_rolls_back_create_and_append() {
        use std::cell::Cell;

        let path =
            std::env::temp_dir().join(format!("datalink-cancel-{}.sqlite", uuid::Uuid::new_v4()));
        let mut sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch(
                "CREATE TABLE baseline (id INTEGER, label TEXT); \
                 INSERT INTO baseline VALUES (1, 'existing'); \
                 CREATE TABLE samples (id INTEGER, label TEXT);",
            )
            .expect("create source tables");
        let transaction = sqlite.transaction().expect("start fixture transaction");
        for index in 0..2_001 {
            transaction
                .execute(
                    "INSERT INTO samples VALUES (?1, ?2)",
                    rusqlite::params![index, format!("row-{index}")],
                )
                .expect("insert source row");
        }
        transaction.commit().expect("commit fixture rows");
        drop(sqlite);

        let db = DuckDbEngine::new_in_memory().expect("create in-memory project");
        let cancel_create = Cell::new(false);
        let create_error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("samples".to_string(), "Samples".to_string(), false)],
                &|_, _, _, rows_done, _| {
                    if rows_done == 1_000 {
                        cancel_create.set(true);
                    }
                },
                &|| cancel_create.get(),
            )
            .expect_err("cancel create import");
        assert!(matches!(create_error, AppError::Cancelled(_)));
        assert!(db.list_datasets().expect("list datasets").is_empty());
        let physical_tables: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE 'dataset_%'",
                [],
                |row| row.get(0),
            )
            .expect("count physical dataset tables");
        assert_eq!(physical_tables, 0);

        let baseline = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("baseline".to_string(), "People".to_string(), false)],
                &|_, _, _, _, _| {},
                &|| false,
            )
            .expect("import append baseline");
        let dataset_id = &baseline[0].1.id;
        let generation = db
            .get_dataset_generation(dataset_id)
            .expect("read baseline generation");

        let cancel_append = Cell::new(false);
        let append_error = db
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[("samples".to_string(), "People".to_string(), true)],
                &|_, _, _, rows_done, _| {
                    if rows_done == 1_000 {
                        cancel_append.set(true);
                    }
                },
                &|| cancel_append.get(),
            )
            .expect_err("cancel append import");
        assert!(matches!(append_error, AppError::Cancelled(_)));
        assert_eq!(
            db.get_dataset_meta(dataset_id)
                .expect("read unchanged dataset")
                .row_count,
            1
        );
        assert_eq!(
            db.get_dataset_generation(dataset_id)
                .expect("read unchanged generation"),
            generation
        );

        std::fs::remove_file(path).expect("remove fixture");
    }

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

    #[test]
    fn normal_curve_requests_summary_statistics() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "normal-curve-id",
            "Normal Curve",
            &["measurement".into()],
            &["DOUBLE".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO \"dataset_normal_curve_id\" (_row_id, measurement)
                 VALUES (1, 1.0), (2, 2.0), (3, 3.0), (4, 4.0)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![4i64, "normal-curve-id"],
            )
            .unwrap();

        let request = GraphDataRequest {
            request_id: "req-normal-curve".into(),
            dataset_id: "normal-curve-id".into(),
            generation: 0,
            fields: vec![GraphFieldBinding {
                role: "y".into(),
                column: "measurement".into(),
            }],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "normalCurve".into(),
                summary_stat: "none".into(),
                correlation_method: None,
                time_series: None,
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1280,
                height: 720,
            },
        };

        let packets = db.collect_graph_aggregate_packets(&request).unwrap();
        let [GraphAggregatePacket::Summary(summary)] = packets.as_slice() else {
            panic!("normal curve must request exactly one summary packet");
        };
        assert_eq!(summary.summaries.len(), 1);
        assert_eq!(summary.summaries[0].count, 4);
        assert!((summary.summaries[0].mean - 2.5).abs() < f64::EPSILON);
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

    fn seed_fit_y_by_x_dataset(
        engine: &DuckDbEngine,
        dataset_id: &str,
        column_names: &[&str],
        column_types: &[&str],
        insert_sql: &str,
        row_count: i64,
    ) {
        engine
            .create_empty_table(
                dataset_id,
                dataset_id,
                &column_names
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect::<Vec<_>>(),
                &column_types
                    .iter()
                    .map(|column_type| (*column_type).to_string())
                    .collect::<Vec<_>>(),
            )
            .expect("fit y by x fixture metadata");
        engine
            .conn()
            .execute_batch(insert_sql)
            .expect("fit y by x fixture rows");
        engine
            .conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, dataset_id],
            )
            .expect("fit y by x fixture row count");
    }

    fn seed_fit_model_dataset(
        engine: &DuckDbEngine,
        dataset_id: &str,
        column_names: &[&str],
        column_types: &[&str],
        insert_sql: &str,
        row_count: i64,
    ) {
        engine
            .create_empty_table(
                dataset_id,
                dataset_id,
                &column_names
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect::<Vec<_>>(),
                &column_types
                    .iter()
                    .map(|column_type| (*column_type).to_string())
                    .collect::<Vec<_>>(),
            )
            .expect("fit model fixture metadata");
        engine
            .conn()
            .execute_batch(insert_sql)
            .expect("fit model fixture rows");
        engine
            .conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![row_count, dataset_id],
            )
            .expect("fit model fixture row count");
    }

    #[test]
    fn read_fit_model_rows_filters_non_finite_and_preserves_row_indexes() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-rows",
            &["Y", "A", "B", "C"],
            &["DOUBLE", "DOUBLE", "DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_fit_model_rows" (_row_id, Y, A, B, C) VALUES
                (1, 10.0, 1.0, 2.0, 'ok'),
                (2, 20.0, 2.0, 3.0, 'ok'),
                (3, NULL, 3.0, 4.0, 'missing-response'),
                (4, 40.0, NULL, 5.0, 'missing-predictor'),
                (5, 50.0, CAST('NaN' AS DOUBLE), 6.0, 'nan-predictor'),
                (6, 60.0, 6.0, CAST('inf' AS DOUBLE), 'infinite-predictor');
            "#,
            6,
        );

        let result = engine
            .read_fit_model_rows(
                "fit-model-rows",
                0,
                "Y",
                &["A".to_string(), "B".to_string(), "A".to_string()],
            )
            .expect("reader should succeed");

        assert_eq!(result.predictor_names, vec!["A", "B"]);
        assert_eq!(result.used_rows.len(), 2);
        assert_eq!(result.excluded_rows, 4);
        assert_eq!(result.used_rows[0].row_index, 1);
        assert_eq!(result.used_rows[1].row_index, 2);
    }

    #[test]
    fn read_fit_model_rows_rejects_stale_generation_before_query() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-stale-generation",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_stale_generation" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );
        engine
            .conn()
            .execute(
                "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                params!["fit-model-stale-generation"],
            )
            .expect("set generation");

        let error = engine
            .read_fit_model_rows("fit-model-stale-generation", 0, "Y", &["A".to_string()])
            .expect_err("stale generation must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("generation")));
    }

    #[test]
    fn read_fit_model_rows_rejects_missing_dataset() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");

        let error = engine
            .read_fit_model_rows("missing-dataset", 0, "Y", &["A".to_string()])
            .expect_err("unknown dataset must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown dataset"))
        );
    }

    #[test]
    fn read_fit_model_rows_rejects_unknown_column() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-unknown-column",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_unknown_column" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );

        let error = engine
            .read_fit_model_rows(
                "fit-model-unknown-column",
                0,
                "Y",
                &["A".to_string(), "missing".to_string()],
            )
            .expect_err("unknown predictor must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown predictor"))
        );
    }

    #[test]
    fn read_fit_model_rows_rejects_unknown_response_column() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-unknown-response",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_unknown_response" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );

        let error = engine
            .read_fit_model_rows(
                "fit-model-unknown-response",
                0,
                "missing_response",
                &["A".to_string()],
            )
            .expect_err("unknown response must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown response"))
        );
    }

    #[test]
    fn read_fit_model_rows_rejects_duplicate_response_and_predictor_column() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-duplicate-response",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_duplicate_response" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );

        let error = engine
            .read_fit_model_rows(
                "fit-model-duplicate-response",
                0,
                "Y",
                &["Y".to_string(), "A".to_string()],
            )
            .expect_err("response reuse must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("response") && message.contains("predictor"))
        );
    }

    #[test]
    fn read_fit_model_rows_rejects_non_continuous_modeling_columns() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-non-continuous",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_non_continuous" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );
        engine
            .conn()
            .execute(
                "UPDATE _meta_columns SET role = $1 WHERE dataset_id = $2 AND col_name = $3",
                params!["nominal", "fit-model-non-continuous", "A"],
            )
            .expect("set role");

        let error = engine
            .read_fit_model_rows("fit-model-non-continuous", 0, "Y", &["A".to_string()])
            .expect_err("non-continuous predictor must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("continuous")));
    }

    #[test]
    fn read_fit_model_rows_rejects_non_continuous_response_column() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-non-continuous-response",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_non_continuous_response" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );
        engine
            .conn()
            .execute(
                "UPDATE _meta_columns SET role = $1 WHERE dataset_id = $2 AND col_name = $3",
                params!["nominal", "fit-model-non-continuous-response", "Y"],
            )
            .expect("set role");

        let error = engine
            .read_fit_model_rows(
                "fit-model-non-continuous-response",
                0,
                "Y",
                &["A".to_string()],
            )
            .expect_err("non-continuous response must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("response") && message.contains("continuous"))
        );
    }

    #[test]
    fn fit_model_reader_selector_executes() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_model_dataset(
            &engine,
            "fit-model-selector-smoke",
            &["Y", "A"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_fit_model_selector_smoke" (_row_id, Y, A) VALUES
                (1, 1.0, 2.0);
            "#,
            1,
        );

        let result = engine
            .read_fit_model_rows("fit-model-selector-smoke", 0, "Y", &["A".to_string()])
            .expect("selector smoke read should succeed");
        assert_eq!(result.used_rows.len(), 1);
    }

    #[test]
    fn read_fit_model_rows_term_projection_dedup_happens_after_term_resolution() {
        let terms = vec![
            FitModelTerm {
                kind: FitModelTermKind::Main,
                column_names: vec!["A".into()],
                exponent: None,
            },
            FitModelTerm {
                kind: FitModelTermKind::Main,
                column_names: vec!["B".into()],
                exponent: None,
            },
            FitModelTerm {
                kind: FitModelTermKind::Interaction,
                column_names: vec!["A".into(), "B".into()],
                exponent: None,
            },
        ];
        let resolved = crate::engine::fit_model::terms::resolve_terms(&terms).expect("terms");
        let mut names = Vec::new();
        for term in &resolved {
            for name in term.column_names() {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
        }
        assert_eq!(names, vec!["A", "B"]);
    }

    #[test]
    fn read_fit_y_by_x_rows_maps_unknown_dataset_to_invalid_param() {
        let engine = DuckDbEngine::new_in_memory().unwrap();

        let error = engine
            .read_fit_y_by_x_rows(
                "missing-dataset",
                "response",
                "factor",
                FitYByXPersonality::Oneway,
            )
            .expect_err("unknown dataset must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown dataset"))
        );
    }

    #[test]
    fn read_hypothesis_test_rows_keeps_raw_missing_cells_and_identity() {
        use crate::engine::hypothesis_test::normalize::HypothesisTestRows;
        use crate::models::hypothesis_test::{HypothesisTestFieldRef, HypothesisTestRoles};

        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_y_by_x_dataset(
            &engine,
            "hypothesis-long-reader",
            &["response", "condition"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_hypothesis_long_reader" (_row_id, response, condition) VALUES
                (1, 10.0, 'A'),
                (2, NULL, 'B');
            "#,
            2,
        );
        engine.conn().execute(
            "UPDATE _meta_columns SET role = 'nominal' WHERE dataset_id = $1 AND col_name = 'condition'",
            params!["hypothesis-long-reader"],
        ).expect("set condition role");

        let rows = engine
            .read_hypothesis_test_rows(
                "hypothesis-long-reader",
                &HypothesisTestRoles::Long {
                    response: HypothesisTestFieldRef {
                        name: "response".into(),
                        field_type: "continuous".into(),
                    },
                    condition: HypothesisTestFieldRef {
                        name: "condition".into(),
                        field_type: "nominal".into(),
                    },
                    subject: None,
                },
            )
            .expect("read hypothesis test rows");

        let HypothesisTestRows::Long(rows) = rows else {
            panic!("expected long rows");
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].identity, "1");
        assert_eq!(rows[0].response, Some(10.0));
        assert_eq!(rows[1].response, None);
        assert_eq!(rows[1].condition.as_deref(), Some("B"));
    }

    #[test]
    fn read_hypothesis_test_rows_accepts_text_condition_with_default_role() {
        use crate::engine::hypothesis_test::normalize::HypothesisTestRows;
        use crate::models::hypothesis_test::{HypothesisTestFieldRef, HypothesisTestRoles};

        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_y_by_x_dataset(
            &engine,
            "hypothesis-text-condition",
            &["response", "condition"],
            &["DOUBLE", "VARCHAR"],
            r#"
            INSERT INTO "dataset_hypothesis_text_condition" (_row_id, response, condition) VALUES
                (1, 10.0, 'A');
            "#,
            1,
        );
        assert_eq!(
            engine
                .fit_y_by_x_column_role("hypothesis-text-condition", "condition")
                .unwrap(),
            "continuous"
        );

        let rows = engine
            .read_hypothesis_test_rows(
                "hypothesis-text-condition",
                &HypothesisTestRoles::Long {
                    response: HypothesisTestFieldRef {
                        name: "response".into(),
                        field_type: "continuous".into(),
                    },
                    condition: HypothesisTestFieldRef {
                        name: "condition".into(),
                        field_type: "nominal".into(),
                    },
                    subject: None,
                },
            )
            .expect("text condition should not require categorical role metadata");

        let HypothesisTestRows::Long(rows) = rows else {
            panic!("expected long rows");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].condition.as_deref(), Some("A"));
    }

    #[test]
    fn read_hypothesis_test_rows_rejects_temporal_condition_with_continuous_role() {
        use crate::models::hypothesis_test::{HypothesisTestFieldRef, HypothesisTestRoles};

        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_y_by_x_dataset(
            &engine,
            "hypothesis-temporal-condition",
            &["response", "condition"],
            &["DOUBLE", "DATE"],
            r#"
            INSERT INTO "dataset_hypothesis_temporal_condition" (_row_id, response, condition) VALUES
                (1, 10.0, DATE '2026-09-15');
            "#,
            1,
        );

        let error = engine
            .read_hypothesis_test_rows(
                "hypothesis-temporal-condition",
                &HypothesisTestRoles::Long {
                    response: HypothesisTestFieldRef {
                        name: "response".into(),
                        field_type: "continuous".into(),
                    },
                    condition: HypothesisTestFieldRef {
                        name: "condition".into(),
                        field_type: "datetime".into(),
                    },
                    subject: None,
                },
            )
            .expect_err("temporal condition should require categorical role metadata");

        assert!(matches!(
            error,
            AppError::InvalidParam(message)
                if message == "hypothesis test condition must be categorical: condition"
        ));
    }

    #[test]
    fn read_hypothesis_test_rows_rejects_numeric_condition_with_continuous_role() {
        use crate::models::hypothesis_test::{HypothesisTestFieldRef, HypothesisTestRoles};

        let engine = DuckDbEngine::new_in_memory().expect("engine");
        seed_fit_y_by_x_dataset(
            &engine,
            "hypothesis-numeric-condition",
            &["response", "condition"],
            &["DOUBLE", "DOUBLE"],
            r#"
            INSERT INTO "dataset_hypothesis_numeric_condition" (_row_id, response, condition) VALUES
                (1, 10.0, 1.0);
            "#,
            1,
        );

        let error = engine
            .read_hypothesis_test_rows(
                "hypothesis-numeric-condition",
                &HypothesisTestRoles::Long {
                    response: HypothesisTestFieldRef {
                        name: "response".into(),
                        field_type: "continuous".into(),
                    },
                    condition: HypothesisTestFieldRef {
                        name: "condition".into(),
                        field_type: "nominal".into(),
                    },
                    subject: None,
                },
            )
            .expect_err("numeric condition should require categorical role metadata");

        assert!(matches!(
            error,
            AppError::InvalidParam(message)
                if message == "hypothesis test condition must be categorical: condition"
        ));
    }

    #[test]
    fn read_fit_y_by_x_rows_keeps_decimal_and_hugeint_bivariate_rows() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        seed_fit_y_by_x_dataset(
            &engine,
            "fit-wide-bivariate",
            &["response", "factor"],
            &["DECIMAL(18,2)", "HUGEINT"],
            r#"
            INSERT INTO "dataset_fit_wide_bivariate" (_row_id, response, factor) VALUES
                (1, CAST(12.50 AS DECIMAL(18,2)), CAST(9223372036854775808 AS HUGEINT)),
                (2, CAST(15.75 AS DECIMAL(18,2)), CAST(9223372036854775810 AS HUGEINT)),
                (3, NULL, CAST(9223372036854775812 AS HUGEINT)),
                (4, CAST(18.00 AS DECIMAL(18,2)), NULL);
            "#,
            4,
        );

        let result = engine
            .read_fit_y_by_x_rows(
                "fit-wide-bivariate",
                "response",
                "factor",
                FitYByXPersonality::Bivariate,
            )
            .expect("fit y by x rows");

        assert_eq!(result.source_rows, 4);
        assert_eq!(
            result.rows,
            vec![
                FitYByXRow::Bivariate {
                    x: 9_223_372_036_854_775_808.0,
                    y: 12.5,
                },
                FitYByXRow::Bivariate {
                    x: 9_223_372_036_854_775_810.0,
                    y: 15.75,
                },
            ]
        );
    }

    #[test]
    fn read_fit_y_by_x_rows_uses_plain_wide_integer_labels_for_nominal_oneway() {
        let engine = DuckDbEngine::new_in_memory().unwrap();
        seed_fit_y_by_x_dataset(
            &engine,
            "fit-signed-wide-oneway",
            &["response", "factor"],
            &["DOUBLE", "HUGEINT"],
            r#"
            INSERT INTO "dataset_fit_signed_wide_oneway" (_row_id, response, factor) VALUES
                (1, CAST(10.25 AS DOUBLE), CAST(-9223372036854775809 AS HUGEINT)),
                (2, CAST(12.50 AS DOUBLE), CAST(9223372036854775808 AS HUGEINT)),
                (3, NULL, CAST(-9223372036854775809 AS HUGEINT)),
                (4, CAST(8.75 AS DOUBLE), NULL),
                (5, CAST(9.50 AS DOUBLE), CAST(9223372036854775808 AS HUGEINT));
            "#,
            5,
        );
        engine
            .conn()
            .execute(
                "UPDATE _meta_columns SET role = $1 WHERE dataset_id = $2 AND col_name = $3",
                params!["nominal", "fit-signed-wide-oneway", "factor"],
            )
            .expect("set nominal role");

        let result = engine
            .read_fit_y_by_x_rows(
                "fit-signed-wide-oneway",
                "response",
                "factor",
                FitYByXPersonality::Oneway,
            )
            .expect("fit y by x rows");

        assert_eq!(result.source_rows, 5);
        assert_eq!(result.rows.len(), 3);
        assert_eq!(
            result.rows,
            vec![
                FitYByXRow::Oneway {
                    y: 10.25,
                    group: "-9223372036854775809".into(),
                },
                FitYByXRow::Oneway {
                    y: 12.5,
                    group: "9223372036854775808".into(),
                },
                FitYByXRow::Oneway {
                    y: 9.5,
                    group: "9223372036854775808".into(),
                },
            ]
        );
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
                correlation_method: None,
                time_series: None,
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
                correlation_method: None,
                time_series: None,
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
    fn graph_projection_time_series_native_date_uses_epoch_projection_and_time_ascending_order() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "graph-time-series-native-date",
            "Graph Time Series Native Date",
            &["captured_on".into(), "value".into()],
            &["DATE".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_graph_time_series_native_date\" (_row_id, captured_on, value)
                 VALUES (4, DATE '2024-01-03', 40.0),
                        (1, DATE '2024-01-01', 10.0),
                        (3, DATE '2024-01-02', 30.0),
                        (2, DATE '2024-01-02', 20.0)",
                [],
            )
            .unwrap();

        let allowed_columns = db
            .get_user_columns("graph-time-series-native-date")
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let allowed = allowed_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let request = GraphDataRequest {
            request_id: "req-time-series-native-date".into(),
            dataset_id: "graph-time-series-native-date".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".into(),
                    column: "captured_on".into(),
                },
                GraphFieldBinding {
                    role: "y".into(),
                    column: "value".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "timeSeries".into(),
                summary_stat: "none".into(),
                correlation_method: None,
                time_series: Some(crate::models::graph_data::GraphTimeSeriesRequest {
                    x_interpretation:
                        crate::models::graph_data::TimeSeriesXInterpretation::NativeTemporal,
                    order: crate::models::graph_data::GraphTimeSeriesOrder::TimeAscending,
                    missing_values: crate::models::graph_data::GraphTimeSeriesMissingValues::Break,
                    marker_mode: crate::models::graph_data::GraphTimeSeriesMarkerMode::Auto,
                    connection: crate::models::graph_data::GraphTimeSeriesConnection::Line,
                }),
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1280,
                height: 720,
            },
        };

        let plan = db.compile_graph_query_plan(&request, &allowed).unwrap();
        assert!(plan.source_sql.contains("epoch_ms"));
        assert!(plan.source_sql.contains("\"captured_on\""));

        let select_sql = db.build_graph_projection_select_sql(&plan, true);
        assert!(select_sql.ends_with("ORDER BY \"__sp_x\" ASC NULLS LAST, \"_row_id\" ASC"));

        let mut stmt = db.conn().prepare(&select_sql).unwrap();
        let mut rows = stmt
            .query(params_from_iter(plan.projection_values.iter()))
            .unwrap();
        let mut seen = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            seen.push((
                row.get::<_, i64>(0).unwrap(),
                row.get::<_, f64>(1).unwrap(),
                row.get::<_, f64>(2).unwrap(),
            ));
        }

        assert_eq!(
            seen,
            vec![
                (1, 1_704_067_200_000.0, 10.0),
                (2, 1_704_153_600_000.0, 20.0),
                (3, 1_704_153_600_000.0, 30.0),
                (4, 1_704_240_000_000.0, 40.0),
            ]
        );
    }

    #[test]
    fn graph_projection_time_series_native_timestamp_variants_execute_epoch_projection() {
        let cases = [
            (
                "graph-time-series-native-timestamp",
                "dataset_graph_time_series_native_timestamp",
                "TIMESTAMP",
                "TIMESTAMP '2024-01-02 03:04:05'",
                "TIMESTAMP '2024-01-01 00:00:00'",
                1_704_067_200_000.0,
                1_704_164_645_000.0,
            ),
            (
                "graph-time-series-native-timestamptz",
                "dataset_graph_time_series_native_timestamptz",
                "TIMESTAMPTZ",
                "TIMESTAMPTZ '2024-01-02 03:04:05+00'",
                "TIMESTAMPTZ '2024-01-01 00:00:00+00'",
                1_704_067_200_000.0,
                1_704_164_645_000.0,
            ),
        ];

        for (dataset_id, table_name, sql_type, late_value, early_value, early_epoch, late_epoch) in
            cases
        {
            let db = DuckDbEngine::new_in_memory().unwrap();
            db.create_empty_table(
                dataset_id,
                "Graph Time Series Native Timestamp",
                &["captured_at".into(), "value".into()],
                &[sql_type.into(), "DOUBLE".into()],
            )
            .unwrap();
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO \"{table_name}\" (_row_id, captured_at, value)
                         VALUES (3, {late_value}, 30.0),
                                (1, {early_value}, 10.0),
                                (2, {late_value}, 20.0)"
                    ),
                    [],
                )
                .unwrap();

            let allowed_columns = db
                .get_user_columns(dataset_id)
                .unwrap()
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>();
            let allowed = allowed_columns
                .iter()
                .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
                .collect::<std::collections::HashMap<_, _>>();
            let request = GraphDataRequest {
                request_id: format!("req-{dataset_id}"),
                dataset_id: dataset_id.into(),
                generation: 0,
                fields: vec![
                    GraphFieldBinding {
                        role: "x".into(),
                        column: "captured_at".into(),
                    },
                    GraphFieldBinding {
                        role: "y".into(),
                        column: "value".into(),
                    },
                ],
                filters: Vec::new(),
                elements: vec![GraphElementRequest {
                    kind: "timeSeries".into(),
                    summary_stat: "none".into(),
                    correlation_method: None,
                    time_series: Some(crate::models::graph_data::GraphTimeSeriesRequest {
                        x_interpretation:
                            crate::models::graph_data::TimeSeriesXInterpretation::NativeTemporal,
                        order: crate::models::graph_data::GraphTimeSeriesOrder::TimeAscending,
                        missing_values:
                            crate::models::graph_data::GraphTimeSeriesMissingValues::Break,
                        marker_mode: crate::models::graph_data::GraphTimeSeriesMarkerMode::Auto,
                        connection: crate::models::graph_data::GraphTimeSeriesConnection::Line,
                    }),
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
                seen.push((
                    row.get::<_, i64>(0).unwrap(),
                    row.get::<_, f64>(1).unwrap(),
                    row.get::<_, f64>(2).unwrap(),
                ));
            }

            assert_eq!(
                seen,
                vec![
                    (1, early_epoch, 10.0),
                    (2, late_epoch, 20.0),
                    (3, late_epoch, 30.0),
                ]
            );
        }
    }

    #[test]
    fn graph_projection_time_series_text_date_uses_static_us_date_pattern_and_source_row_order() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "graph-time-series-text-date",
            "Graph Time Series Text Date",
            &["captured_text".into(), "value".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_graph_time_series_text_date\" (_row_id, captured_text, value)
                 VALUES (3, '01/02/2024', 30.0),
                        (1, '01/01/2024', 10.0),
                        (2, '01/02/2024', 20.0),
                        (4, '01/03/2024', 40.0)",
                [],
            )
            .unwrap();

        let allowed_columns = db
            .get_user_columns("graph-time-series-text-date")
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let allowed = allowed_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();

        let request = GraphDataRequest {
            request_id: "req-time-series-text-date".into(),
            dataset_id: "graph-time-series-text-date".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".into(),
                    column: "captured_text".into(),
                },
                GraphFieldBinding {
                    role: "y".into(),
                    column: "value".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "timeSeries".into(),
                summary_stat: "none".into(),
                correlation_method: None,
                time_series: Some(crate::models::graph_data::GraphTimeSeriesRequest {
                    x_interpretation:
                        crate::models::graph_data::TimeSeriesXInterpretation::TextDate {
                            format: crate::models::graph_data::TimeSeriesTextDateFormat::UsDate,
                        },
                    order: crate::models::graph_data::GraphTimeSeriesOrder::SourceRow,
                    missing_values: crate::models::graph_data::GraphTimeSeriesMissingValues::Break,
                    marker_mode: crate::models::graph_data::GraphTimeSeriesMarkerMode::Auto,
                    connection: crate::models::graph_data::GraphTimeSeriesConnection::Line,
                }),
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1280,
                height: 720,
            },
        };

        let plan = db.compile_graph_query_plan(&request, &allowed).unwrap();
        assert!(plan.source_sql.contains("%m/%d/%Y"));
        assert!(!plan.source_sql.contains("%Y-%m-%d %H:%M:%S"));
        assert!(!plan.source_sql.contains("%d/%m/%Y"));

        let select_sql = db.build_graph_projection_select_sql(&plan, true);
        assert!(select_sql.ends_with("ORDER BY \"_row_id\" ASC"));

        let mut stmt = db.conn().prepare(&select_sql).unwrap();
        let mut rows = stmt
            .query(params_from_iter(plan.projection_values.iter()))
            .unwrap();
        let mut seen = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            seen.push((
                row.get::<_, i64>(0).unwrap(),
                row.get::<_, f64>(1).unwrap(),
                row.get::<_, f64>(2).unwrap(),
            ));
        }

        assert_eq!(
            seen,
            vec![
                (1, 1_704_067_200_000.0, 10.0),
                (2, 1_704_153_600_000.0, 20.0),
                (3, 1_704_153_600_000.0, 30.0),
                (4, 1_704_240_000_000.0, 40.0),
            ]
        );
    }

    #[test]
    fn graph_projection_time_series_sequence_executes_numeric_projection_and_alias_order() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "graph-time-series-sequence",
            "Graph Time Series Sequence",
            &["sample_index".into(), "value".into()],
            &["BIGINT".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_graph_time_series_sequence\" (_row_id, sample_index, value)
                 VALUES (4, 3, 40.0),
                        (1, 1, 10.0),
                        (3, 2, 30.0),
                        (2, 2, 20.0)",
                [],
            )
            .unwrap();

        let allowed_columns = db
            .get_user_columns("graph-time-series-sequence")
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let allowed = allowed_columns
            .iter()
            .map(|(name, column_type)| (name.as_str(), column_type.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let request = GraphDataRequest {
            request_id: "req-time-series-sequence".into(),
            dataset_id: "graph-time-series-sequence".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".into(),
                    column: "sample_index".into(),
                },
                GraphFieldBinding {
                    role: "y".into(),
                    column: "value".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "timeSeries".into(),
                summary_stat: "none".into(),
                correlation_method: None,
                time_series: Some(crate::models::graph_data::GraphTimeSeriesRequest {
                    x_interpretation:
                        crate::models::graph_data::TimeSeriesXInterpretation::Sequence,
                    order: crate::models::graph_data::GraphTimeSeriesOrder::TimeAscending,
                    missing_values: crate::models::graph_data::GraphTimeSeriesMissingValues::Break,
                    marker_mode: crate::models::graph_data::GraphTimeSeriesMarkerMode::Auto,
                    connection: crate::models::graph_data::GraphTimeSeriesConnection::Line,
                }),
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
        assert!(select_sql.ends_with("ORDER BY \"__sp_x\" ASC NULLS LAST, \"_row_id\" ASC"));

        let mut stmt = db.conn().prepare(&select_sql).unwrap();
        let mut rows = stmt
            .query(params_from_iter(plan.projection_values.iter()))
            .unwrap();
        let mut seen = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            seen.push((
                row.get::<_, i64>(0).unwrap(),
                row.get::<_, f64>(1).unwrap(),
                row.get::<_, f64>(2).unwrap(),
            ));
        }

        assert_eq!(
            seen,
            vec![
                (1, 1.0, 10.0),
                (2, 2.0, 20.0),
                (3, 2.0, 30.0),
                (4, 3.0, 40.0)
            ]
        );
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
    fn correlation_matrix_cancellation_during_row_scan_returns_no_partial_packet() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "corr-cancel-row-scan",
            "Correlation Cancel Row Scan",
            &["a".into(), "b".into()],
            &["DOUBLE".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_corr_cancel_row_scan\" (_row_id, a, b)
                 VALUES
                 (1, 1.0, 2.0),
                 (2, 2.0, 4.0),
                 (3, 3.0, 6.0),
                 (4, 4.0, 8.0)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 4 WHERE id = $1",
                params!["corr-cancel-row-scan"],
            )
            .unwrap();

        let request = GraphDataRequest {
            request_id: "request-corr-cancel-row-scan".into(),
            dataset_id: "corr-cancel-row-scan".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "multiX0".into(),
                    column: "a".into(),
                },
                GraphFieldBinding {
                    role: "multiX1".into(),
                    column: "b".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "correlationMatrix".into(),
                summary_stat: "none".into(),
                correlation_method: Some(crate::models::graph_data::CorrelationMethod::Pearson),
                time_series: None,
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        };

        let mut checks = 0usize;
        let (packets, cancelled) = db
            .collect_graph_aggregate_packets_with_cancel(&request, || {
                checks = checks.saturating_add(1);
                Ok(checks >= 2)
            })
            .unwrap();

        assert!(cancelled);
        assert!(packets.is_empty());
    }

    #[test]
    fn collect_graph_aggregate_packets_with_cancel_rejects_stale_generation_for_correlation_only() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "corr-stale-aggregate-only",
            "Correlation Stale Aggregate Only",
            &["a".into(), "b".into()],
            &["DOUBLE".into(), "DOUBLE".into()],
        )
        .unwrap();

        db.conn()
            .execute(
                "INSERT INTO \"dataset_corr_stale_aggregate_only\" (_row_id, a, b)
                 VALUES
                 (1, 1.0, 2.0),
                 (2, 2.0, 4.0),
                 (3, 3.0, 6.0),
                 (4, 4.0, 8.0)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 4, generation = 1 WHERE id = $1",
                params!["corr-stale-aggregate-only"],
            )
            .unwrap();

        let request = GraphDataRequest {
            request_id: "request-corr-stale-aggregate-only".into(),
            dataset_id: "corr-stale-aggregate-only".into(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "multiX0".into(),
                    column: "a".into(),
                },
                GraphFieldBinding {
                    role: "multiX1".into(),
                    column: "b".into(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "correlationMatrix".into(),
                summary_stat: "none".into(),
                correlation_method: Some(crate::models::graph_data::CorrelationMethod::Pearson),
                time_series: None,
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        };

        let error = db
            .collect_graph_aggregate_packets_with_cancel(&request, || Ok(false))
            .expect_err("stale generation must fail");
        assert!(matches!(
            error,
            AppError::InvalidParam(message) if message.contains("stale dataset generation")
        ));
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
        assert_eq!(db.get_dataset_meta("benchmark-id").unwrap().generation, 0);

        db.update_cell("benchmark-id", 1, "value_1", "99").unwrap();
        assert_eq!(db.get_dataset_generation("benchmark-id").unwrap(), 1);
        assert_eq!(db.get_dataset_meta("benchmark-id").unwrap().generation, 1);
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
    fn valued_columns_change_set_restores_values_as_one_history_action() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-valued-columns-id",
            "History Valued Columns",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_history_valued_columns_id VALUES
                    (1, 'one'), (2, 'two'), (3, 'three');
                 UPDATE _meta_datasets SET row_count = 3 WHERE id = 'history-valued-columns-id';",
            )
            .unwrap();

        let columns = vec![
            ValuedColumn {
                name: "Predicted".into(),
                column_type: "DOUBLE".into(),
                values: vec![(1, Some(10.0)), (3, Some(30.0))],
            },
            ValuedColumn {
                name: "Residual".into(),
                column_type: "DOUBLE".into(),
                values: vec![(1, Some(-1.0)), (3, Some(1.0))],
            },
        ];
        let (change_set_id, generation) = db
            .add_valued_columns_with_change_set("history-valued-columns-id", &columns, 0)
            .unwrap();

        assert_eq!(generation, 1);
        assert_eq!(
            db.get_dataset_generation("history-valued-columns-id")
                .unwrap(),
            1
        );
        let values: Vec<(u64, Option<f64>, Option<f64>)> = db
            .conn()
            .prepare(
                "SELECT _row_id, Predicted, Residual
                 FROM dataset_history_valued_columns_id ORDER BY _row_id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            values,
            vec![
                (1, Some(10.0), Some(-1.0)),
                (2, None, None),
                (3, Some(30.0), Some(1.0))
            ]
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("history-valued-columns-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );

        db.apply_change_set(&change_set_id, false).unwrap();
        let restored: (Option<f64>, Option<f64>) = db
            .conn()
            .query_row(
                "SELECT Predicted, Residual FROM dataset_history_valued_columns_id WHERE _row_id = 3",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(restored, (Some(30.0), Some(1.0)));
        assert_eq!(
            db.get_dataset_generation("history-valued-columns-id")
                .unwrap(),
            3
        );
    }

    #[test]
    fn valued_columns_reject_stale_generation_without_mutation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-valued-stale-id",
            "History Valued Stale",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();

        let error = db
            .add_valued_columns_with_change_set(
                "history-valued-stale-id",
                &[ValuedColumn {
                    name: "Predicted".into(),
                    column_type: "DOUBLE".into(),
                    values: vec![],
                }],
                1,
            )
            .expect_err("stale generation must fail");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("generation")));
        assert_eq!(
            db.get_user_columns("history-valued-stale-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );
        assert_eq!(
            db.get_dataset_generation("history-valued-stale-id")
                .unwrap(),
            0
        );
    }

    #[test]
    fn valued_columns_apply_one_suffix_to_the_whole_conflicting_group() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-valued-suffix-id",
            "History Valued Suffix",
            &["Predicted".into()],
            &["DOUBLE".into()],
        )
        .unwrap();

        db.add_valued_columns_with_change_set(
            "history-valued-suffix-id",
            &[
                ValuedColumn {
                    name: "Predicted".into(),
                    column_type: "DOUBLE".into(),
                    values: vec![],
                },
                ValuedColumn {
                    name: "Residual".into(),
                    column_type: "DOUBLE".into(),
                    values: vec![],
                },
            ],
            0,
        )
        .unwrap();

        assert_eq!(
            db.get_user_columns("history-valued-suffix-id")
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["Predicted", "Predicted-2", "Residual-2"]
        );
    }

    #[test]
    fn valued_columns_roll_back_all_changes_when_a_row_is_missing() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-valued-rollback-id",
            "History Valued Rollback",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_valued_rollback_id VALUES (1, 'kept')",
                [],
            )
            .unwrap();

        let error = db
            .add_valued_columns_with_change_set(
                "history-valued-rollback-id",
                &[
                    ValuedColumn {
                        name: "Predicted".into(),
                        column_type: "DOUBLE".into(),
                        values: vec![(1, Some(10.0))],
                    },
                    ValuedColumn {
                        name: "Residual".into(),
                        column_type: "DOUBLE".into(),
                        values: vec![(99, Some(1.0))],
                    },
                ],
                0,
            )
            .expect_err("unknown row must roll back");

        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("row ID")));
        assert_eq!(
            db.get_user_columns("history-valued-rollback-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );
        assert_eq!(
            db.get_dataset_generation("history-valued-rollback-id")
                .unwrap(),
            0
        );
        let history_count: u64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM _history_change_sets WHERE dataset_id = 'history-valued-rollback-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(history_count, 0);
    }

    #[test]
    fn valued_column_change_set_records_and_replays_exact_column_ids() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "history-valued-identity-id",
            "History Valued Identity",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO dataset_history_valued_identity_id VALUES (1, 'kept')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 1 WHERE id = 'history-valued-identity-id'",
                [],
            )
            .unwrap();

        let existing_id = user_column_descriptors(&db, "history-valued-identity-id")[0]
            .0
            .clone();
        let (change_set_id, _) = db
            .add_valued_columns_with_change_set(
                "history-valued-identity-id",
                &[
                    ValuedColumn {
                        name: "Predicted".into(),
                        column_type: "DOUBLE".into(),
                        values: vec![(1, Some(10.0))],
                    },
                    ValuedColumn {
                        name: "Residual".into(),
                        column_type: "DOUBLE".into(),
                        values: vec![(1, Some(0.5))],
                    },
                ],
                0,
            )
            .unwrap();

        let added_columns = user_column_descriptors(&db, "history-valued-identity-id");
        let predicted_id = added_columns
            .iter()
            .find(|(_, _, name, _)| name == "Predicted")
            .unwrap()
            .0
            .clone();
        let residual_id = added_columns
            .iter()
            .find(|(_, _, name, _)| name == "Residual")
            .unwrap()
            .0
            .clone();
        let history_rows = db
            .conn()
            .prepare(
                "SELECT before_column_id, after_column_id, after_name FROM _history_change_set_columns WHERE change_set_id = ? ORDER BY ordinal",
            )
            .unwrap()
            .query_map(params![&change_set_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            history_rows,
            vec![
                (None, Some(predicted_id.clone()), "Predicted".into()),
                (None, Some(residual_id.clone()), "Residual".into()),
            ]
        );

        db.apply_change_set(&change_set_id, true).unwrap();
        let undone_columns = user_column_descriptors(&db, "history-valued-identity-id");
        assert_eq!(undone_columns.len(), 1);
        assert_eq!(undone_columns[0].0, existing_id);

        db.apply_change_set(&change_set_id, false).unwrap();
        let replayed_columns = user_column_descriptors(&db, "history-valued-identity-id");
        assert_eq!(
            replayed_columns
                .iter()
                .find(|(_, _, name, _)| name == "Predicted")
                .unwrap()
                .0,
            predicted_id
        );
        assert_eq!(
            replayed_columns
                .iter()
                .find(|(_, _, name, _)| name == "Residual")
                .unwrap()
                .0,
            residual_id
        );
    }

    #[test]
    fn delete_column_change_set_restores_exact_column_id() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "identity-delete-column-id",
            "Identity Delete Column",
            &["A".into(), "B".into()],
            &["DOUBLE".into(), "DOUBLE".into()],
        )
        .unwrap();

        let before = user_column_descriptors(&db, "identity-delete-column-id");
        let b_id = before
            .iter()
            .find(|(_, _, name, _)| name == "B")
            .unwrap()
            .0
            .clone();
        let generation = db
            .get_dataset_generation("identity-delete-column-id")
            .unwrap();

        let change_set_id = db
            .delete_columns_with_change_set(
                "identity-delete-column-id",
                &["B".to_string()],
                Some(generation),
            )
            .unwrap();
        db.apply_change_set(&change_set_id, true).unwrap();

        let restored = user_column_descriptors(&db, "identity-delete-column-id");
        assert_eq!(
            restored
                .iter()
                .find(|(_, _, name, _)| name == "B")
                .unwrap()
                .0,
            b_id
        );
    }

    #[test]
    fn add_column_change_set_redo_restores_exact_column_id() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "identity-add-column-id",
            "Identity Add Column",
            &["existing".into()],
            &["VARCHAR".into()],
        )
        .unwrap();

        let change_set_id = db
            .add_column_with_change_set(
                "identity-add-column-id",
                "amount",
                "DOUBLE",
                Some(0),
                Some(0),
            )
            .unwrap();
        let added_id = user_column_descriptors(&db, "identity-add-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "amount")
            .unwrap()
            .0;

        db.apply_change_set(&change_set_id, true).unwrap();
        db.apply_change_set(&change_set_id, false).unwrap();

        let restored_id = user_column_descriptors(&db, "identity-add-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "amount")
            .unwrap()
            .0;
        assert_eq!(restored_id, added_id);
    }

    #[test]
    fn alter_column_change_set_preserves_exact_column_id_through_undo_redo() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "identity-alter-column-id",
            "Identity Alter Column",
            &["code".into()],
            &["VARCHAR".into()],
        )
        .unwrap();
        let original_id = user_column_descriptors(&db, "identity-alter-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "code")
            .unwrap()
            .0;

        let change_set_id = db
            .alter_column_with_change_set(
                "identity-alter-column-id",
                "code",
                "amount",
                "DOUBLE",
                Some(0),
            )
            .unwrap();
        let changed_id = user_column_descriptors(&db, "identity-alter-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "amount")
            .unwrap()
            .0;
        assert_eq!(changed_id, original_id);

        db.apply_change_set(&change_set_id, true).unwrap();
        let undone_id = user_column_descriptors(&db, "identity-alter-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "code")
            .unwrap()
            .0;
        assert_eq!(undone_id, original_id);

        db.apply_change_set(&change_set_id, false).unwrap();
        let redone_id = user_column_descriptors(&db, "identity-alter-column-id")
            .into_iter()
            .find(|(_, _, name, _)| name == "amount")
            .unwrap()
            .0;
        assert_eq!(redone_id, original_id);
    }

    #[test]
    fn legacy_schema_history_replay_tolerates_missing_column_ids() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "legacy-schema-history-id",
            "Legacy Schema History",
            &["existing".into(), "removed".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .unwrap();

        let delete_generation = db
            .get_dataset_generation("legacy-schema-history-id")
            .unwrap();
        let delete_change_set_id = db
            .delete_columns_with_change_set(
                "legacy-schema-history-id",
                &["removed".to_string()],
                Some(delete_generation),
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _history_change_set_columns SET before_column_id = NULL WHERE change_set_id = ?",
                params![&delete_change_set_id],
            )
            .unwrap();

        db.apply_change_set(&delete_change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("legacy-schema-history-id").unwrap(),
            vec![
                ("existing".into(), "VARCHAR".into()),
                ("removed".into(), "DOUBLE".into()),
            ]
        );

        db.apply_change_set(&delete_change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("legacy-schema-history-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );

        let add_generation = db
            .get_dataset_generation("legacy-schema-history-id")
            .unwrap();
        let add_change_set_id = db
            .add_column_with_change_set(
                "legacy-schema-history-id",
                "added",
                "BIGINT",
                None,
                Some(add_generation),
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE _history_change_set_columns SET after_column_id = NULL WHERE change_set_id = ?",
                params![&add_change_set_id],
            )
            .unwrap();

        db.apply_change_set(&add_change_set_id, true).unwrap();
        assert_eq!(
            db.get_user_columns("legacy-schema-history-id").unwrap(),
            vec![("existing".into(), "VARCHAR".into())]
        );

        db.apply_change_set(&add_change_set_id, false).unwrap();
        assert_eq!(
            db.get_user_columns("legacy-schema-history-id").unwrap(),
            vec![
                ("existing".into(), "VARCHAR".into()),
                ("added".into(), "BIGINT".into()),
            ]
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
        let original_value_id = user_column_descriptors(&db, "history-schema-id")[0]
            .0
            .clone();

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
        let added_columns = user_column_descriptors(&db, "history-schema-id");
        let amount_id = added_columns
            .iter()
            .find(|(_, _, name, _)| name == "amount")
            .unwrap()
            .0
            .clone();
        let label_id = added_columns
            .iter()
            .find(|(_, _, name, _)| name == "label")
            .unwrap()
            .0
            .clone();
        let history_ids = db
            .conn()
            .prepare(
                "SELECT before_column_id, after_column_id, after_name FROM _history_change_set_columns WHERE change_set_id = ? ORDER BY ordinal",
            )
            .unwrap()
            .query_map(params![&change_set_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            history_ids,
            vec![
                (
                    Some(original_value_id),
                    Some(amount_id.clone()),
                    "amount".into()
                ),
                (None, Some(label_id.clone()), "label".into()),
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
        let replayed_columns = user_column_descriptors(&db, "history-schema-id");
        assert_eq!(
            replayed_columns
                .iter()
                .find(|(_, _, name, _)| name == "amount")
                .unwrap()
                .0,
            amount_id
        );
        assert_eq!(
            replayed_columns
                .iter()
                .find(|(_, _, name, _)| name == "label")
                .unwrap()
                .0,
            label_id
        );
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
                    (1, 'Alpha'), (2, 'Beta'), (3, 'Alphabet'), (4, NULL),
                    (5, 'Alpha'), (6, '');",
            )
            .unwrap();

        assert_eq!(
            db.query_table_filter_values("benchmark-id", "category", "alpha", 10, 0)
                .unwrap(),
            vec![
                TableFilterValue {
                    value: "Alpha".into(),
                    row_count: 2,
                },
                TableFilterValue {
                    value: "Alphabet".into(),
                    row_count: 1,
                },
            ]
        );
        assert_eq!(
            db.query_table_filter_values("benchmark-id", "category", "", 10, 0)
                .unwrap()
                .into_iter()
                .find(|option| option.value.is_empty()),
            Some(TableFilterValue {
                value: "".into(),
                row_count: 2,
            })
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

    #[test]
    fn query_table_filter_values_handles_a_numeric_value_column() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "stacked-id",
            "Stacked",
            &["Build".into(), "Value".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO dataset_stacked_id VALUES
                    (1, 'EV1', 10.0), (2, 'DV', 20.0), (3, 'EV1', 20.0);",
            )
            .unwrap();

        assert_eq!(
            db.query_table_filter_values("stacked-id", "Value", "", 10, 0)
                .unwrap(),
            vec![
                TableFilterValue {
                    value: "10.0".into(),
                    row_count: 1,
                },
                TableFilterValue {
                    value: "20.0".into(),
                    row_count: 2,
                },
            ]
        );
        assert_eq!(
            db.query_table_filter_values("stacked-id", "Build", "", 10, 0)
                .unwrap(),
            vec![
                TableFilterValue {
                    value: "DV".into(),
                    row_count: 1,
                },
                TableFilterValue {
                    value: "EV1".into(),
                    row_count: 2,
                },
            ]
        );
    }

    #[test]
    fn query_table_filter_values_rejects_stale_generation() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        db.create_empty_table(
            "benchmark-id",
            "Benchmark",
            &["category".into()],
            &["VARCHAR".into()],
        )
        .unwrap();

        let generation = db.get_dataset_generation("benchmark-id").unwrap();
        let error = db
            .query_table_filter_values("benchmark-id", "category", "", 10, generation + 1)
            .expect_err("stale generation must fail");

        assert!(matches!(
            error,
            AppError::InvalidParam(message) if message.contains("stale dataset generation")
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
    fn workflow_table_hash_uses_stable_rows_and_rejects_stale_generations() {
        let db = DuckDbEngine::new_in_memory().unwrap();
        let dataset_id = "workflow-hash-id";
        db.create_table_from_rows(
            dataset_id,
            &CreateTableFromRowsRequest {
                name: "Workflow Hash".to_string(),
                column_names: vec!["value".to_string()],
                column_types: vec!["DOUBLE".to_string()],
                rows: vec![vec![json!(2.0)], vec![json!(1.0)]],
            },
        )
        .unwrap();
        let generation = db.get_dataset_generation(dataset_id).unwrap();

        let first = db
            .workflow_table_content_hash(dataset_id, generation)
            .unwrap();
        assert_eq!(
            first,
            db.workflow_table_content_hash(dataset_id, generation)
                .unwrap()
        );

        db.update_cells(
            dataset_id,
            &[CellUpdate {
                row_id: 1,
                column_name: "value".to_string(),
                value: Some("3.0".to_string()),
            }],
        )
        .unwrap();
        let error = db
            .workflow_table_content_hash(dataset_id, generation)
            .unwrap_err();
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
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

    fn user_column_descriptors(
        db: &DuckDbEngine,
        dataset_id: &str,
    ) -> Vec<(String, i32, String, String)> {
        db.conn()
            .prepare(
                "SELECT column_id, col_index, col_name, col_type FROM _meta_columns WHERE dataset_id = ? ORDER BY col_index",
            )
            .unwrap()
            .query_map(params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn tabulate_member_fixture() -> (
        DuckDbEngine,
        crate::models::tabulate::TabulateSessionRequest,
    ) {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        engine.conn().execute_batch(
            "CREATE TABLE dataset_members (region VARCHAR, product BIGINT, sales DOUBLE);
             INSERT INTO dataset_members VALUES ('West', 2, 1), ('East', 1, 2), ('East', 1, 3), (NULL, NULL, 4);
             INSERT INTO _meta_datasets (id, name, source_type, row_count, col_count)
             VALUES ('members', 'Members', 'test', 4, 3);"
        ).expect("fixture");
        let request = crate::models::tabulate::TabulateSessionRequest {
            dataset_id: "members".into(),
            source_generation: engine
                .get_dataset_generation("members")
                .expect("generation"),
            row_fields: vec!["region".into(), "product".into()],
            column_fields: vec!["product".into()],
            statistics: vec![make_statistic("mean", "sales", StatisticKind::Mean)],
            include_row_totals: false,
            include_column_totals: false,
        };
        (engine, request)
    }

    #[test]
    fn tabulate_member_indexes_are_distinct_typed_zero_based_and_nulls_last() {
        let (engine, request) = tabulate_member_fixture();
        let session = uuid::Uuid::new_v4();
        let info = engine
            .prepare_tabulate_member_indexes(&request, &session, usize::MAX)
            .expect("prepare");
        assert_eq!(
            (
                info.row_member_count,
                info.column_member_count,
                info.logical_cell_count
            ),
            (3, 3, 9)
        );
        let (row_table, column_table) = DuckDbEngine::tabulate_member_table_names(&session);
        let rows = engine
            .conn()
            .prepare(&format!(
                "SELECT ordinal, dimension_0, dimension_1 FROM \"{row_table}\" ORDER BY ordinal"
            ))
            .expect("query")
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert_eq!(
            rows,
            vec![
                (0, Some("East".into()), Some(1)),
                (1, Some("West".into()), Some(2)),
                (2, None, None)
            ]
        );
        engine.drop_tabulate_member_indexes(&session).expect("drop");
        engine
            .drop_tabulate_member_indexes(&session)
            .expect("idempotent");
        for table in [row_table, column_table] {
            let count: i64 = engine
                .conn()
                .query_row(
                    "SELECT count(*) FROM duckdb_tables() WHERE table_name = ?",
                    params![table],
                    |row| row.get(0),
                )
                .expect("tables");
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn tabulate_window_exact_statistics_typed_keys_and_percentages() {
        let (engine, mut definition) = tabulate_member_fixture();
        engine
            .conn()
            .execute_batch(
                "ALTER TABLE dataset_members ADD COLUMN ordinal DOUBLE;
             ALTER TABLE dataset_members ADD COLUMN dimension_0 DATE;
             DELETE FROM dataset_members;
             INSERT INTO dataset_members VALUES
             ('East', 1, 0, 1, DATE '2026-01-01'),
             ('East', 1, 0, 3, DATE '2026-01-01'),
             ('East', 1, 0, 3, DATE '2026-01-01'),
             ('East', 1, 0, 5, DATE '2026-01-01'),
             ('East', 1, 0, NULL, DATE '2026-01-01'),
             (NULL, NULL, 0, NULL, NULL);",
            )
            .unwrap();
        definition.row_fields = vec!["dimension_0".into()];
        definition.column_fields = vec!["product".into()];
        definition.statistics = [
            StatisticKind::Count,
            StatisticKind::MissingCount,
            StatisticKind::UniqueCount,
            StatisticKind::Sum,
            StatisticKind::Mean,
            StatisticKind::StandardDeviation,
            StatisticKind::Variance,
            StatisticKind::Minimum,
            StatisticKind::Maximum,
            StatisticKind::Median,
            StatisticKind::Range,
            StatisticKind::Quantile,
            StatisticKind::RowPercentage,
            StatisticKind::ColumnPercentage,
            StatisticKind::TotalPercentage,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| TabulateStatistic {
            id: format!("stat-{index}"),
            field: "ordinal".into(),
            kind,
            quantile: Some(0.25),
        })
        .collect();
        let session = uuid::Uuid::new_v4();
        let info = engine
            .prepare_tabulate_member_indexes(&definition, &session, usize::MAX)
            .unwrap();
        let request = TabulateWindowRequest {
            request_id: "statistics".into(),
            session_id: session.to_string(),
            source_generation: definition.source_generation,
            row_start: 0,
            row_count: 2,
            column_start: 0,
            column_count: 2,
        };
        let result = engine
            .query_tabulate_window(
                &definition,
                &session,
                &request,
                &info,
                "typed",
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(
            result.row_members,
            vec![vec![json!("2026-01-01")], vec![JsonValue::Null]]
        );
        assert_eq!(
            result.column_members,
            vec![vec![json!(1)], vec![JsonValue::Null]]
        );
        let expected = [
            Some(4.0),
            Some(1.0),
            Some(3.0),
            Some(12.0),
            Some(3.0),
            Some((8.0_f64 / 3.0).sqrt()),
            Some(8.0 / 3.0),
            Some(1.0),
            Some(5.0),
            Some(3.0),
            Some(4.0),
            Some(2.5),
            Some(1.0),
            Some(1.0),
            Some(1.0),
        ];
        assert_eq!(result.cells.len(), 30);
        for (cell, expected) in result.cells[..15].iter().zip(expected) {
            assert_eq!((cell.row_index, cell.column_index), (0, 0));
            match (cell.value, expected) {
                (Some(actual), Some(expected)) => assert!((actual - expected).abs() < 1e-12),
                (actual, expected) => assert_eq!(actual, expected),
            }
        }
        assert_eq!(
            result.cells[15..]
                .iter()
                .map(|cell| cell.value)
                .collect::<Vec<_>>(),
            vec![
                Some(0.0),
                Some(1.0),
                Some(0.0),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(0.0)
            ]
        );
        assert!(!result.row_totals_ready && !result.column_totals_ready);
    }

    #[test]
    fn tabulate_member_missing_roles_have_one_member_even_on_empty_source() {
        let (engine, mut request) = tabulate_member_fixture();
        engine
            .conn()
            .execute("DELETE FROM dataset_members", [])
            .expect("empty");
        request.row_fields.clear();
        request.column_fields.clear();
        let info = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("prepare");
        assert_eq!(
            (
                info.row_member_count,
                info.column_member_count,
                info.logical_cell_count
            ),
            (1, 1, 1)
        );
        request.row_fields.push("region".into());
        let info = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("prepare empty");
        assert_eq!(
            (
                info.row_member_count,
                info.column_member_count,
                info.logical_cell_count
            ),
            (0, 1, 0)
        );
    }

    #[test]
    fn tabulate_member_bytes_measure_distinct_keys_not_source_size() {
        let (engine, request) = tabulate_member_fixture();
        let first = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("prepare");
        engine
            .conn()
            .execute(
                "INSERT INTO dataset_members SELECT 'East', 1, 10 FROM range(10000)",
                [],
            )
            .expect("duplicates");
        let repeated = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("repeat");
        assert_eq!(
            repeated.measured_bytes_estimate,
            first.measured_bytes_estimate
        );
        engine
            .conn()
            .execute(
                "INSERT INTO dataset_members VALUES (repeat('x', 10000), 5, 1)",
                [],
            )
            .expect("wide key");
        let wide = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("wide");
        assert!(wide.measured_bytes_estimate >= first.measured_bytes_estimate + 10000);
        let refused = uuid::Uuid::new_v4();
        assert!(engine
            .prepare_tabulate_member_indexes(&request, &refused, first.measured_bytes_estimate)
            .is_err());
        let (row_table, column_table) = DuckDbEngine::tabulate_member_table_names(&refused);
        let count: i64 = engine
            .conn()
            .query_row(
                "SELECT count(*) FROM duckdb_tables() WHERE table_name IN (?, ?)",
                params![row_table, column_table],
                |row| row.get(0),
            )
            .expect("tables");
        assert_eq!(count, 0);
    }

    #[test]
    fn tabulate_member_preparation_has_no_legacy_logical_cell_cap() {
        let (engine, mut request) = tabulate_member_fixture();
        engine.conn().execute("INSERT INTO dataset_members SELECT CAST(range AS VARCHAR), range, 1 FROM range(200)", []).expect("many members");
        request.row_fields = vec!["region".into()];
        let info = engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .expect("prepare");
        assert!(info.logical_cell_count > 10000);
        request.source_generation += 1;
        assert!(engine
            .prepare_tabulate_member_indexes(&request, &uuid::Uuid::new_v4(), usize::MAX)
            .is_err());
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

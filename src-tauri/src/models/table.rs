use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Serialize};

const TABLE_NAVIGATION_VERSION: u64 = 1;

fn deserialize_table_navigation_version<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u64::deserialize(deserializer)?;
    if version != TABLE_NAVIGATION_VERSION {
        return Err(D::Error::custom(format!(
            "table navigation version must be {TABLE_NAVIGATION_VERSION}, received {version}"
        )));
    }
    Ok(version)
}

/// Dataset metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMeta {
    pub id: String,
    pub name: String,
    pub source_path: Option<String>,
    pub source_type: String,
    pub row_count: i64,
    pub col_count: i32,
    pub generation: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedRowsResult {
    pub row_ids: Vec<i64>,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMutationResult {
    pub row_ids: Vec<i64>,
    pub generation: u64,
    pub row_count: usize,
    pub change_set_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefinition {
    pub name: String,
    pub column_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDescriptor {
    pub column_id: String,
    pub name: String,
    pub sql_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculated: Option<crate::models::calculated_column::CalculatedColumnDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableFromRowsRequest {
    pub name: String,
    pub column_names: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDisplayPropsWithoutIndex {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableColumn {
    pub name: String,
    #[serde(rename = "sqlType")]
    pub column_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<ColumnDisplayPropsWithoutIndex>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateManagedTableRequest {
    pub name: String,
    pub columns: Vec<CreateTableColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTableCreateColumn {
    pub col_index: usize,
    pub col_name: String,
    pub col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTableCreateResult {
    pub dataset: DatasetMeta,
    pub generation: u64,
    pub columns: Vec<ManagedTableCreateColumn>,
}

/// Column metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub col_index: i32,
    pub col_name: String,
    pub col_type: String,
    pub role: String,
    pub missing_count: i64,
}

/// Paginated table query result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQueryResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: i64,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterValue {
    pub value: String,
    pub row_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableWindowSort {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TableWindowFilterRule {
    Continuous {
        field: String,
        min: Option<f64>,
        max: Option<f64>,
    },
    Categorical {
        field: String,
        selected: Vec<String>,
        #[serde(default)]
        exclude: bool,
    },
    Date {
        field: String,
        start: Option<String>,
        end: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableWindowFilter {
    pub op: String,
    pub rule: TableWindowFilterRule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableWindowRequest {
    pub dataset_id: String,
    pub start: usize,
    pub count: usize,
    pub sort: Option<TableWindowSort>,
    pub filters: Vec<TableWindowFilter>,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableWindowResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: i64,
    pub start: usize,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuerySessionRequest {
    pub dataset_id: String,
    pub generation: u64,
    pub sort: Option<TableWindowSort>,
    pub filters: Vec<TableWindowFilter>,
    pub column_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableQuerySessionState {
    Preparing,
    Ready,
    Cancelled,
    Failed,
}

impl TableQuerySessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuerySessionStatus {
    pub session_id: String,
    pub state: TableQuerySessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNavigationRequest {
    #[serde(deserialize_with = "deserialize_table_navigation_version")]
    pub version: u64,
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub start: usize,
    pub count: usize,
    pub column_ids: Vec<String>,
    pub sort: Option<TableWindowSort>,
    pub filters: Vec<TableWindowFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub include_transport_diagnostics: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableNavigationTimings {
    pub total_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_json_encode_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_json_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_response_ready_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNavigationResult {
    pub version: u64,
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub start: usize,
    pub total_rows: i64,
    pub total_rows_exact: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub timings: TableNavigationTimings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NaturalNavigationAnchor {
    pub ordinal: i64,
    pub order_key: i128,
    pub row_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNavigationBenchmarkRequest {
    pub rows: usize,
    pub columns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNavigationBenchmarkFixture {
    pub dataset_id: String,
    pub generation: u64,
    pub total_rows: usize,
    pub column_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellPosition {
    pub row_id: i64,
    pub column_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellUpdate {
    pub row_id: i64,
    pub column_name: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteChangeSetResult {
    pub change_set_id: String,
}

/// Paginated result of an arbitrary read-only SQL query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlQueryResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: i64,
    pub page: usize,
    pub page_size: usize,
    pub execution_time_ms: u128,
}

/// Per-column display format
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFormatInfo {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// Per-column display properties (width + format + extras)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDisplayProps {
    pub col_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
    /// Open-ended bag of "additional column properties" keyed by extra-kind
    /// (e.g. "unit", "spec", "range", "notes"). The value's shape is decided
    /// by the frontend registry; backend treats it as opaque JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, serde_json::Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn navigation_request_json(version: u64) -> serde_json::Value {
        json!({
            "version": version,
            "requestId": "req-1",
            "datasetId": "dataset-1",
            "generation": 3,
            "start": 10,
            "count": 25,
            "columnIds": ["col-category", "col-value"],
            "sort": {
                "column": "_row_id",
                "descending": false
            },
            "filters": [],
            "sessionId": "session-1"
        })
    }

    #[test]
    fn query_table_navigation_window_contract_deserializes_camel_case_with_version_one() {
        let request: TableNavigationRequest = serde_json::from_value(navigation_request_json(1))
            .expect("table navigation request should deserialize");

        assert_eq!(request.version, 1);
        assert_eq!(request.request_id, "req-1");
        assert_eq!(request.dataset_id, "dataset-1");
        assert_eq!(request.column_ids, vec!["col-category", "col-value"]);
        assert_eq!(request.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn query_table_navigation_window_contract_rejects_non_one_versions() {
        for version in [0_u64, 2_u64] {
            let error =
                serde_json::from_value::<TableNavigationRequest>(navigation_request_json(version))
                    .expect_err("non-v1 navigation requests must be rejected");

            assert!(
                error.to_string().contains("version"),
                "unexpected error for version {version}: {error}"
            );
        }
    }
}

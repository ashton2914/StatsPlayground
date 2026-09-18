use serde::{Deserialize, Serialize};

/// Kinds of statistics that can be requested for a tabulate operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatisticKind {
    Count,
    MissingCount,
    UniqueCount,
    Sum,
    Mean,
    StandardDeviation,
    Variance,
    Minimum,
    Maximum,
    Median,
    Range,
    Quantile,
    RowPercentage,
    ColumnPercentage,
    TotalPercentage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateStatistic {
    pub id: String,
    pub field: String,
    pub kind: StatisticKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantile: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateRequest {
    pub dataset_id: String,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub statistics: Vec<TabulateStatistic>,
    pub include_row_totals: bool,
    pub include_column_totals: bool,
    pub max_result_cells: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateSessionRequest {
    pub dataset_id: String,
    pub source_generation: u64,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub statistics: Vec<TabulateStatistic>,
    pub include_row_totals: bool,
    pub include_column_totals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TabulateSessionState {
    Preparing,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateSessionStatus {
    pub session_id: String,
    pub fingerprint: String,
    pub source_generation: u64,
    pub state: TabulateSessionState,
    pub row_member_count: u64,
    pub column_member_count: u64,
    pub logical_cell_count: u64,
    pub measured_member_index_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateWindowRequest {
    pub request_id: String,
    pub session_id: String,
    pub source_generation: u64,
    pub row_start: u64,
    pub row_count: u32,
    pub column_start: u64,
    pub column_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateSparseCell {
    pub row_index: u32,
    pub column_index: u32,
    pub statistic_index: u32,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateWindowResult {
    pub session_id: String,
    pub request_id: String,
    pub fingerprint: String,
    pub source_generation: u64,
    pub row_start: u64,
    pub column_start: u64,
    pub row_members: Vec<Vec<serde_json::Value>>,
    pub column_members: Vec<Vec<serde_json::Value>>,
    pub row_member_before: Option<Vec<serde_json::Value>>,
    pub row_member_after: Option<Vec<serde_json::Value>>,
    pub column_member_before: Option<Vec<serde_json::Value>>,
    pub column_member_after: Option<Vec<serde_json::Value>>,
    pub statistics: Vec<TabulateStatistic>,
    pub cells: Vec<TabulateSparseCell>,
    pub row_totals_ready: bool,
    pub column_totals_ready: bool,
    pub row_member_count: u64,
    pub column_member_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TabulateTotalsKind {
    Rows { start: u64, count: u32 },
    Columns { start: u64, count: u32 },
    Grand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateTotalsRequest {
    pub request_id: String,
    pub session_id: String,
    pub source_generation: u64,
    pub totals: TabulateTotalsKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateSparseTotal {
    pub member_index: u32,
    pub statistic_index: u32,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateTotalsResult {
    pub session_id: String,
    pub request_id: String,
    pub fingerprint: String,
    pub source_generation: u64,
    pub totals: TabulateTotalsKind,
    pub row_totals: Vec<TabulateSparseTotal>,
    pub column_totals: Vec<TabulateSparseTotal>,
    pub grand_totals: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateMaterializeRequest {
    pub session_id: String,
    pub source_generation: u64,
    pub fingerprint: String,
    pub destination_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateResult {
    pub row_members: Vec<Vec<serde_json::Value>>,
    pub column_members: Vec<Vec<serde_json::Value>>,
    pub statistics: Vec<TabulateStatistic>,
    pub cells: Vec<Option<f64>>,
    pub row_totals: Vec<Option<f64>>,
    pub column_totals: Vec<Option<f64>>,
    pub grand_totals: Vec<Option<f64>>,
    pub cell_count: u64,
    pub limit: u64,
}

use serde::{Deserialize, Serialize};

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
    pub created_at: String,
    pub updated_at: String,
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

/// Per-column display properties (width + format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDisplayProps {
    pub col_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
}

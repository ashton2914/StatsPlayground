use serde::{Deserialize, Serialize};

/// Descriptive statistics for a single column
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    pub column_name: String,
    pub count: i64,
    pub missing: i64,
    pub mean: Option<f64>,
    pub median: Option<f64>,
    pub std_dev: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub q1: Option<f64>,
    pub q3: Option<f64>,
    pub unique_count: Option<i64>,
}

/// Descriptive statistics result for a whole dataset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescriptiveResult {
    pub dataset_id: String,
    pub columns: Vec<ColumnStats>,
}

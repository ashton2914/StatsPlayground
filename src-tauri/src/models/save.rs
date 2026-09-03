use std::collections::HashMap;
use std::path::PathBuf;

use crate::models::project::ProjectInfo;
use crate::models::table::{ColumnDisplayProps, DatasetMeta};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectRequest {
    pub file_path: Option<String>,
    pub history: Vec<serde_json::Value>,
    pub snapshots: Vec<serde_json::Value>,
    pub graph_builders: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_y_by_x: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_models: Vec<serde_json::Value>,
    pub tabulates: Vec<serde_json::Value>,
    #[serde(default)]
    pub distributions: Vec<serde_json::Value>,
    #[serde(default)]
    pub derived_formulas: Vec<serde_json::Value>,
    #[serde(default)]
    pub distribution_issues: Vec<serde_json::Value>,
    pub folders: Vec<String>,
    pub table_folders: HashMap<String, String>,
    pub graph_folders: HashMap<String, String>,
    #[serde(default)]
    pub fit_y_by_x_folders: HashMap<String, String>,
    #[serde(default)]
    pub fit_model_folders: HashMap<String, String>,
    pub tabulate_folders: HashMap<String, String>,
    #[serde(default)]
    pub distribution_folders: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct SaveSnapshot {
    pub current_project: ProjectInfo,
    pub destination_path: PathBuf,
    pub destination_name: String,
    pub datasets: Vec<DatasetMeta>,
    pub dataset_generations: HashMap<String, u64>,
    pub column_display: HashMap<String, Vec<ColumnDisplayProps>>,
    pub request: SaveProjectRequest,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SavePerfMetrics {
    pub plan_ms: u128,
    pub query_fetch_ms: u128,
    pub batch_encode_ms: u128,
    pub zip_write_ms: u128,
    pub zip_finish_ms: u128,
    pub sync_all_ms: u128,
    pub validation_ms: u128,
    pub replacement_ms: u128,
    pub max_retained_batch_bytes: usize,
    pub max_encoded_batch_bytes: usize,
    pub max_combined_batch_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveWriteResult {
    pub archive_bytes: u64,
    pub tables_written: usize,
    pub rows_written: usize,
    pub perf: SavePerfMetrics,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavePhase {
    Preparing,
    Table,
    Metadata,
    Compressing,
    Finalizing,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProgress {
    pub phase: SavePhase,
    pub table_index: usize,
    pub table_total: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_name: Option<String>,
    pub rows_done: usize,
    pub rows_total: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overall_progress: Option<f64>,
}

pub type SaveProgressCallback<'a> = dyn Fn(SaveProgress) + Send + Sync + 'a;

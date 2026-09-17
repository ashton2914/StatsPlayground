use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const GRAPH_NEW_DEFAULT_DOMAIN_POLICY: &str = "finite-domain-v1";
pub const GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR: f64 = 1.5;
pub const GRAPH_NEW_MAX_OVERDRAW_FACTOR: f64 = 4.0;
pub const GRAPH_NEW_MAX_LEVELS: u8 = 12;
pub const GRAPH_NEW_MAX_TILE_POINTS: u32 = 65_536;
pub const GRAPH_NEW_MAX_BATCH_ROWS: usize = 1_000_000;
pub const GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
pub const GRAPH_NEW_MAX_CONSTRUCTION_MEMORY_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewBuildRequest {
    pub request_id: String,
    pub dataset_id: String,
    pub dataset_generation: u64,
    pub x_column_id: String,
    pub y_column_id: String,
    pub max_tile_points: u32,
    pub levels: u8,
    pub batch_rows: usize,
    pub overdraw_factor: f64,
    pub construction_memory_limit_bytes: u64,
}

impl GraphNewBuildRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "graph-new requestId must not be empty".to_string(),
            ));
        }
        if self.dataset_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "graph-new datasetId must not be empty".to_string(),
            ));
        }
        if self.x_column_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "graph-new xColumnId must not be empty".to_string(),
            ));
        }
        if self.y_column_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "graph-new yColumnId must not be empty".to_string(),
            ));
        }
        if self.max_tile_points == 0 || self.max_tile_points > GRAPH_NEW_MAX_TILE_POINTS {
            return Err(AppError::InvalidParam(format!(
                "graph-new maxTilePoints must be between 1 and {GRAPH_NEW_MAX_TILE_POINTS}"
            )));
        }
        if self.levels == 0 || self.levels > GRAPH_NEW_MAX_LEVELS {
            return Err(AppError::InvalidParam(format!(
                "graph-new levels must be between 1 and {GRAPH_NEW_MAX_LEVELS}"
            )));
        }
        if self.batch_rows == 0 || self.batch_rows > GRAPH_NEW_MAX_BATCH_ROWS {
            return Err(AppError::InvalidParam(format!(
                "graph-new batchRows must be between 1 and {GRAPH_NEW_MAX_BATCH_ROWS}"
            )));
        }
        if !self.overdraw_factor.is_finite()
            || self.overdraw_factor <= 0.0
            || self.overdraw_factor > GRAPH_NEW_MAX_OVERDRAW_FACTOR
        {
            return Err(AppError::InvalidParam(format!(
                "graph-new overdrawFactor must be finite and between 0 and {GRAPH_NEW_MAX_OVERDRAW_FACTOR}"
            )));
        }
        if self.construction_memory_limit_bytes == 0
            || self.construction_memory_limit_bytes
                > GRAPH_NEW_MAX_CONSTRUCTION_MEMORY_LIMIT_BYTES
        {
            return Err(AppError::InvalidParam(format!(
                "graph-new constructionMemoryLimitBytes must be between 1 and {GRAPH_NEW_MAX_CONSTRUCTION_MEMORY_LIMIT_BYTES}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphNewBuildStage {
    Scan,
    Pyramid,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewBuildProgress {
    pub stage: GraphNewBuildStage,
    pub processed_rows: u64,
    pub finite_rows: u64,
    pub excluded_non_finite_rows: u64,
    pub batches_completed: u64,
    pub projection_query_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewLevelSummary {
    pub level: u8,
    pub tile_count: u64,
    pub retained_marks: u64,
    pub tile_bytes: u64,
    pub total_source_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewBuildSummary {
    pub processed_rows: u64,
    pub finite_rows: u64,
    pub excluded_non_finite_rows: u64,
    pub projection_query_count: u64,
    pub spool_bytes: u64,
    pub accounted_memory_bytes: u64,
    pub overview_ready_ms: u128,
    pub pyramid_complete_ms: u128,
    pub levels: Vec<GraphNewLevelSummary>,
}

#[cfg(test)]
mod tests {
    use crate::models::graph_new_data::{
        GraphNewBuildRequest, GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
    };

    #[test]
    fn build_request_requires_distinct_non_empty_column_ids() {
        let request = GraphNewBuildRequest {
            request_id: "graph-new-request".to_string(),
            dataset_id: "dataset-1".to_string(),
            dataset_generation: 7,
            x_column_id: "".to_string(),
            y_column_id: "x-column".to_string(),
            max_tile_points: 4_096,
            levels: 4,
            batch_rows: 2_048,
            overdraw_factor: GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes: GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        };

        let error = request.validate().expect_err("empty x column id must fail");
        assert!(error.to_string().contains("xColumnId"));
    }

    #[test]
    fn build_request_allows_same_axis_binding_when_ids_are_non_empty() {
        let request = GraphNewBuildRequest {
            request_id: "graph-new-request".to_string(),
            dataset_id: "dataset-1".to_string(),
            dataset_generation: 7,
            x_column_id: "shared-column".to_string(),
            y_column_id: "shared-column".to_string(),
            max_tile_points: 4_096,
            levels: 4,
            batch_rows: 2_048,
            overdraw_factor: GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes: GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        };

        request.validate().expect("same-axis request should be accepted");
    }
}
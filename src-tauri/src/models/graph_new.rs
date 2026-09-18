use serde::{Deserialize, Serialize};

use crate::error::AppError;

const MAX_FRAME_WIDTH: u32 = 3840;
const MAX_FRAME_HEIGHT: u32 = 2160;
const PROBE_FRAMES: u32 = 1;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphNewXMode { #[default] Auto, Numeric, Time, Duration, Category }

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphNewRawMode { #[default] Scatter, Line, PointsLine }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNewTimeOrigin { pub epoch_nanos: String, pub unit_nanos: u32 }

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNewAxisData {
    pub kind: GraphNewXMode,
    pub utc: bool,
    pub categories: Vec<String>,
    #[serde(default)]
    pub origin: Option<GraphNewTimeOrigin>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewAxisTick { pub value: f64, pub position: f64, pub label: Option<String> }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewAxis { pub kind: GraphNewXMode, pub utc: bool, pub ticks: Vec<GraphNewAxisTick>, pub origin: Option<GraphNewTimeOrigin> }

#[cfg(test)]
mod camera_tests {
    use super::GraphNewCameraDomain;

    #[test]
    fn graph_new_camera_domain_checks_extreme_and_tiny_spans() {
        for (min, max) in [(1e-280, 2e-280), (1e300, 1.01e300)] {
            GraphNewCameraDomain { x_min: min, x_max: max, y_min: min, y_max: max }.validate().expect("finite ordered");
        }
        for (min, max) in [(0.0, 0.0), (1.0, 0.0), (f64::NAN, 1.0), (-f64::MAX, f64::MAX), (0.0, f64::INFINITY)] {
            assert!(GraphNewCameraDomain { x_min: min, x_max: max, y_min: 0.0, y_max: 1.0 }.validate().is_err());
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNewCameraDomain {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

impl GraphNewCameraDomain {
    pub fn validate(&self) -> Result<(), AppError> {
        if [(self.x_min, self.x_max), (self.y_min, self.y_max)].iter().any(|(min, max)|
            !min.is_finite() || !max.is_finite() || min >= max || !(max - min).is_finite()) {
            return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewPlotRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNewRenderRequest {
    pub request_id: String,
    pub session_id: String,
    pub dataset_id: String,
    pub dataset_generation: u64,
    pub x_column_id: String,
    pub y_column_id: String,
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
    pub renderer_generation: u64,
    pub camera_generation: u64,
    #[serde(default)]
    pub camera_domain: Option<GraphNewCameraDomain>,
    #[serde(default)]
    pub show_mean: bool,
    #[serde(default)]
    pub x_mode: GraphNewXMode,
    #[serde(default)]
    pub raw_mode: GraphNewRawMode,
}

impl GraphNewRenderRequest {
    pub fn validate(&self) -> Result<(), AppError> {
    if let Some(domain) = self.camera_domain { domain.validate()?; }
        let valid_ids = [&self.request_id, &self.session_id, &self.dataset_id, &self.x_column_id, &self.y_column_id]
            .iter().all(|id| !id.trim().is_empty() && id.len() <= 256 && id.trim() == id.as_str());
        if !valid_ids || [self.dataset_generation, self.renderer_generation, self.camera_generation]
            .iter().any(|value| *value > 9_007_199_254_740_991)
            || self.renderer_generation == 0
            || !self.device_pixel_ratio.is_finite()
            || !(0.5..=8.0).contains(&self.device_pixel_ratio)
            || self.width < 96 || self.height < 64
            || (self.width as f64 * self.device_pixel_ratio).ceil() > MAX_FRAME_WIDTH as f64
            || (self.height as f64 * self.device_pixel_ratio).ceil() > MAX_FRAME_HEIGHT as f64
        {
            return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
        }
        Ok(())
    }

    pub fn build_request(&self) -> super::graph_new_data::GraphNewBuildRequest {
        use super::graph_new_data::*;
        GraphNewBuildRequest {
            request_id: self.request_id.clone(), dataset_id: self.dataset_id.clone(),
            dataset_generation: self.dataset_generation, x_column_id: self.x_column_id.clone(),
            y_column_id: self.y_column_id.clone(), levels: 8, max_tile_points: 4096,
            batch_rows: 16384, overdraw_factor: GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes: GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewGpuCacheStats {
    pub allocated_bytes: u64,
    pub geometry_capacity_bytes: u64,
    pub geometry_uploads: u64,
    pub geometry_hits: u64,
    pub mean_geometry_uploads: u64,
    pub mean_geometry_hits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewRenderCompletion {
    pub request_id: String,
    pub x_axis: GraphNewAxis,
    pub raw_line_available: bool,
    pub raw_line_segments: usize,
    pub raw_mode: GraphNewRawMode,
    pub processed_rows: u64,
    pub finite_rows: u64,
    pub excluded_non_finite_rows: u64,
    pub selected_marks: usize,
    pub mean_available: bool,
    pub mean_groups: Option<usize>,
    pub mean_visible: bool,
    pub exact_visible: bool,
    pub visible_rows: Option<u64>,
    pub raw_index_entries_inspected: u64,
    pub raw_blocks_inspected: u64,
    pub raw_points_inspected: u64,
    pub build_ms: f64,
    pub render_ms: f64,
    pub readback_ms: f64,
    pub width: u32,
    pub height: u32,
    pub camera_domain: GraphNewCameraDomain,
    pub plot_rect: GraphNewPlotRect,
    pub source_projection_query_count: u64,
    pub render_generation_check_count: u32,
    pub cpu_cache_hit: bool,
    pub persistent_cache_hit: bool,
    pub cpu_cache_bytes: u64,
    pub cpu_cache_reserved_bytes: u64,
    pub persistent_cache_bytes: u64,
    pub cache_evictions: u64,
    pub gpu_cache: Option<GraphNewGpuCacheStats>,
    pub process_cpu_reserved_bytes: u64,
    pub cache_cpu_hits: u64,
    pub cache_misses: u64,
    pub cache_disk_hits: u64,
    pub cache_corruptions: u64,
    pub cache_disk_write_failures: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphNewFrameFormat {
    Rgba8,
    Png,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewTransportProbeRequest {
    pub request_id: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub format: GraphNewFrameFormat,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewFrameHeader {
    pub request_id: String,
    pub dataset_generation: u64,
    pub renderer_generation: u64,
    pub camera_generation: u64,
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub format: GraphNewFrameFormat,
    pub byte_length: u64,
    pub readback_completed_at_unix_micros: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewTransportProbeCompletion {
    pub request_id: String,
    pub frames_requested: u32,
    pub frames_sent: u32,
    pub dropped_superseded_frames: u32,
    pub peak_transport_bytes: u64,
    pub maximum_queue_depth: u32,
    pub render_ms: Vec<f64>,
    pub readback_ms: Vec<f64>,
}

impl GraphNewTransportProbeRequest {
    #[cfg(test)]
    pub fn rgba8(request_id: &str, width: u32, height: u32, frames: u32) -> Self {
        Self {
            request_id: request_id.to_owned(),
            width,
            height,
            frames,
            format: GraphNewFrameFormat::Rgba8,
        }
    }

    pub fn validate(&self) -> Result<(), AppError> {
        if self.request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "graph-new request ID must not be empty".to_owned(),
            ));
        }
        if self.format != GraphNewFrameFormat::Rgba8 {
            return Err(AppError::InvalidParam(
                "graph-new transport probe supports RGBA8 only".to_owned(),
            ));
        }
        if self.width == 0 || self.width > MAX_FRAME_WIDTH {
            return Err(AppError::InvalidParam(format!(
                "graph-new frame width must be between 1 and {MAX_FRAME_WIDTH}"
            )));
        }
        if self.height == 0 || self.height > MAX_FRAME_HEIGHT {
            return Err(AppError::InvalidParam(format!(
                "graph-new frame height must be between 1 and {MAX_FRAME_HEIGHT}"
            )));
        }
        if self.frames != PROBE_FRAMES {
            return Err(AppError::InvalidParam(format!(
                "graph-new pull transport requires exactly {PROBE_FRAMES} frame per probe"
            )));
        }
        self.rgba_byte_length()?;
        Ok(())
    }

    pub fn rgba_byte_length(&self) -> Result<u64, AppError> {
        u64::from(self.width)
            .checked_mul(u64::from(self.height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new frame byte length overflow".to_owned())
            })
    }
}
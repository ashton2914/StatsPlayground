use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use duckdb::params;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::graph_new_data::{
    GraphNewBuildProgress, GraphNewBuildRequest, GraphNewBuildStage, GraphNewBuildSummary,
    GraphNewLevelSummary, GRAPH_NEW_DEFAULT_DOMAIN_POLICY,
};
use crate::state::AppState;
use crate::models::graph_new::{GraphNewRenderRequest, GraphNewRenderCompletion, GraphNewFrameHeader, GraphNewFrameFormat};
use tauri::ipc::{Channel, InvokeResponseBody};
use crate::models::graph_new::{GraphNewXMode, GraphNewAxisData, GraphNewAxis, GraphNewAxisTick};

use super::graph_new_key::{
    GraphKey, GraphKeyParts, GRAPH_NEW_RENDERER_CONTRACT_VERSION, GRAPH_NEW_TILE_FORMAT_VERSION,
};
use super::graph_new_lod::{GraphCamera, SourcePoint, TilePyramid, TilePyramidBuilder};
use super::graph_new_overlay::{
    EnabledOverlayMask, GroupedLineSegment, OverlayDictionary,
};
use super::graph_new_renderer::{GraphNewRenderer, GraphNewScene};
use super::graph_new_transport_service::SyntheticFrame;

const GRAPH_NEW_CURRENT_CHECK_BATCH_ROWS: usize = 4_096;

pub type GraphBuildProgress = GraphNewBuildProgress;

#[derive(Default)]
struct RenderOwner {
    session_id: String,
    request_id: String,
    renderer_generation: u64,
    active: bool,
    closed: bool,
    preserve_cache: bool,
}

#[derive(Default)]
pub struct GraphNewRuntime {
    owner: Mutex<RenderOwner>,
    cache: Mutex<super::graph_new_cache::GraphNewCacheCoordinator>,
}

impl GraphNewRuntime {
    pub fn release_idle_cache(&self) -> Result<(), AppError> {
        self.cache.try_lock().map_err(|_| AppError::Busy("graph_new_busy".into()))?.evict_unpinned();
        Ok(())
    }

    pub fn set_cache_directory(&self, directory: &std::path::Path) -> Result<(), AppError> {
        self.cache.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?.set_directory(directory)
    }

    pub fn cancel_request(&self, session_id: &str, request_id: &str, generation: u64) -> Result<(), AppError> {
        self.cancel_request_with_cache(session_id, request_id, generation, false)
    }

    pub fn cancel_request_with_cache(&self, session_id: &str, request_id: &str, generation: u64, preserve_cache: bool) -> Result<(), AppError> {
        validate_control_id(session_id)?;
        validate_control_id(request_id)?;
        validate_control_generation(generation)?;
        let mut owner = self.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if generation > owner.renderer_generation {
            let closed = owner.closed && owner.session_id == session_id;
            *owner = RenderOwner { session_id: session_id.into(), request_id: request_id.into(),
                renderer_generation: generation, active: false, closed, preserve_cache };
        } else if generation == owner.renderer_generation && owner.session_id == session_id && owner.request_id == request_id {
            owner.preserve_cache = preserve_cache && (owner.active || owner.preserve_cache);
            owner.active = false;
        } else {
            return Ok(());
        }
        if !preserve_cache { if let Ok(mut cache) = self.cache.try_lock() { cache.unpin(); } }
        Ok(())
    }

    pub fn close_session(&self, session_id: &str, generation: u64) -> Result<(), AppError> {
        validate_control_id(session_id)?;
        validate_control_generation(generation)?;
        let mut owner = self.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if generation > owner.renderer_generation || (generation == owner.renderer_generation && owner.session_id == session_id) {
            *owner = RenderOwner { session_id: session_id.into(), renderer_generation: generation,
                closed: true, ..Default::default() };
            if let Ok(mut cache) = self.cache.try_lock() { cache.unpin(); }
        }
        Ok(())
    }

    fn begin(&self, request: &GraphNewRenderRequest) -> Result<(), AppError> {
        request.validate()?;
        let mut owner = self.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if request.renderer_generation <= owner.renderer_generation
            || (owner.closed && owner.session_id == request.session_id) {
            return Err(AppError::Cancelled("graph_new_cancelled".into()));
        }
        *owner = RenderOwner { session_id: request.session_id.clone(), request_id: request.request_id.clone(),
            renderer_generation: request.renderer_generation, active: true, closed: false, preserve_cache: false };
        Ok(())
    }

    fn is_current(&self, request: &GraphNewRenderRequest) -> bool {
        self.owner.lock().is_ok_and(|owner| owner.active && !owner.closed
            && owner.session_id == request.session_id && owner.request_id == request.request_id
            && owner.renderer_generation == request.renderer_generation)
    }

    pub fn cancel(&self, session_id: &str, request_id: Option<&str>) -> Result<(), AppError> {
        validate_control_id(session_id)?;
        if let Some(request_id) = request_id { validate_control_id(request_id)?; }
        let mut owner = self.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if owner.session_id == session_id && request_id.is_none_or(|id| id == owner.request_id) {
            owner.active = false;
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), AppError> {
        validate_control_id(session_id)?;
        let mut owner = self.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if owner.session_id == session_id {
            owner.active = false;
            owner.closed = true;
            if let Ok(mut cache) = self.cache.try_lock() { cache.unpin(); }
        }
        Ok(())
    }
}

fn validate_control_id(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > 256 || value.trim() != value {
        return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
    }
    Ok(())
}

fn validate_control_generation(value: u64) -> Result<(), AppError> {
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
    }
    Ok(())
}

#[derive(Debug)]
pub struct GraphNewBuildResult {
    pub key: GraphKey,
    pub pyramid: TilePyramid,
    pub summary: GraphNewBuildSummary,
    pub processed_rows: u64,
    pub excluded_non_finite_rows: u64,
    pub query_count: u64,
}

pub struct GraphNewService<'a> {
    state: &'a AppState,
}

#[derive(Debug, Clone)]
struct ColumnBinding {
    column_id: String,
    name: String,
    sql_type: String,
}

impl<'a> GraphNewService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn render(&self, request: &GraphNewRenderRequest, channel: &Channel<InvokeResponseBody>) -> Result<GraphNewRenderCompletion, AppError> {
        self.render_with(request, |scene| GraphNewRenderer::render_current(scene,
            || self.state.graph_new.is_current(request)), &mut |header, rgba| {
            let envelope = serde_json::json!({ "messageType": "header", "header": header });
            channel.send(InvokeResponseBody::from(envelope.to_string()))
                .map_err(|_| AppError::Stats("graph_new_channel_closed".into()))?;
            channel.send(InvokeResponseBody::from(rgba))
                .map_err(|_| AppError::Stats("graph_new_channel_closed".into()))
        })
    }

    pub(crate) fn render_with(
        &self,
        request: &GraphNewRenderRequest,
        render: impl FnOnce(&GraphNewScene) -> Result<SyntheticFrame, AppError>,
        send: &mut impl FnMut(&GraphNewFrameHeader, Vec<u8>) -> Result<(), AppError>,
    ) -> Result<GraphNewRenderCompletion, AppError> {
        let runtime = &self.state.graph_new;
        runtime.begin(request)?;
        let mut cache = match runtime.cache.try_lock() {
            Ok(cache) => cache,
            Err(_) => {
                runtime.cancel(&request.session_id, Some(&request.request_id))?;
                return Err(AppError::Busy("graph_new_busy".into()));
            }
        };
        let result = (|| {
            let build_request = request.build_request();
            let epoch = self.state.graph_new_epoch.load(std::sync::atomic::Ordering::Acquire);
            cache.sync_epoch(epoch);
            let is_current = || runtime.is_current(request)
                && self.state.graph_new_epoch.load(std::sync::atomic::Ordering::Acquire) == epoch;
            let generation_checks = std::cell::Cell::new(0u32);
            let ensure_current = || {
                generation_checks.set(generation_checks.get() + 1);
                if !is_current() { return Err(AppError::Cancelled("graph_new_cancelled".into())); }
                self.ensure_render_current(request)
            };
            ensure_current()?;
            let key = GraphKey::canonical(&GraphKeyParts {
                dataset_id: request.dataset_id.clone(), dataset_generation: request.dataset_generation,
                x_column_id: request.x_column_id.clone(), y_column_id: request.y_column_id.clone(),
                overlay_column_id: request.overlay_column_id.clone(),
                filter_identity: None, renderer_contract_version: GRAPH_NEW_RENDERER_CONTRACT_VERSION,
                tile_format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
                domain_policy: axis_policy(request.x_mode), levels: build_request.levels,
                max_tile_points: build_request.max_tile_points,
            })?;
            let mut build_ms = 0.0;
            let mut source_projection_query_count = 0;
            let mut pending = None;
            let cpu_hit = cache.contains(&key.hash_hex);
            let mut disk_hit = false;
            if !cpu_hit {
                if request.camera_domain.is_some() {
                    return Err(AppError::Stats("graph_new_missing_cache".into()));
                }
                disk_hit = cache.restore(&key)?;
                if !disk_hit {
                    let started = Instant::now();
                    let required_disk = self.construction_disk_requirement(&build_request)?;
                    let (mut construction, disk_limit) = cache.admit_construction(
                        build_request.construction_memory_limit_bytes,
                        required_disk,
                    )?;
                    let built = self.build_with_disk_limit(&build_request, &mut |_| {}, &is_current, disk_limit, request.x_mode)?;
                    source_projection_query_count = built.query_count;
                    build_ms = started.elapsed().as_secs_f64() * 1000.0;
                    construction.retain_completed_build(&built)?;
                    cache.prepare_admission(&built)?;
                    drop(construction);
                    pending = Some(built);
                }
            }
            ensure_current()?;
            let built = pending.as_ref().or_else(|| cache.get(&key.hash_hex))
                .ok_or_else(|| AppError::Stats("graph_new_render_failed".into()))?;
            if let Some(camera) = request.camera_domain {
                validate_camera_limits(camera, built.pyramid.domain)?;
            }
            let domain = request.camera_domain.map_or(built.pyramid.domain, |camera| super::graph_new_lod::GraphDomain {
                x_min: camera.x_min, x_max: camera.x_max, y_min: camera.y_min, y_max: camera.y_max,
            });
            let enabled_groups = EnabledOverlayMask::from_hidden(
                &built.pyramid.overlay,
                &request.hidden_overlay_group_ids,
            )?;
            let mean = if request.show_mean { built.pyramid.mean_line(&|| {
                if is_current() { Ok(()) } else { Err(AppError::Cancelled("graph_new_cancelled".into())) }
            })? } else { None };
            let selection = built.pyramid.select_with_control(&GraphCamera {
                x_min: domain.x_min, x_max: domain.x_max, y_min: domain.y_min, y_max: domain.y_max,
                viewport_width: request.width, viewport_height: request.height,
                device_pixel_ratio: request.device_pixel_ratio,
            }, &|| {
                if is_current() { Ok(()) } else { Err(AppError::Cancelled("graph_new_cancelled".into())) }
            });
            let selection = match selection {
                Ok(selection) => selection,
                Err(error @ AppError::Cancelled(_)) => return Err(error),
                Err(_) => {
                    cache.reject_corrupt(&key.hash_hex);
                    return Err(AppError::Stats("graph_new_missing_cache".into()));
                }
            };
            let selected_marks = selection.selected_mark_count;
            let mut points = Vec::with_capacity(selected_marks);
            for selected in selection.tiles {
                if !is_current() { return Err(AppError::Cancelled("graph_new_cancelled".into())); }
                for (((row_id, x), y), group_code) in selected
                    .tile
                    .row_ids
                    .into_iter()
                    .zip(selected.tile.xs)
                    .zip(selected.tile.ys)
                    .zip(selected.tile.group_codes)
                {
                    points.push(SourcePoint::with_group(row_id, x, y, group_code));
                }
            }
            let raw_line = if request.raw_mode != crate::models::graph_new::GraphNewRawMode::Scatter && built.pyramid.mean_available() {
                built.pyramid.raw_line(&points, &|| if is_current() { Ok(()) } else { Err(AppError::Cancelled("graph_new_cancelled".into())) })?
            } else { None };
            let overlay_active = built.pyramid.overlay.active;
            let enabled_selected_marks = if overlay_active {
                points
                    .iter()
                    .filter(|point| enabled_groups.is_enabled(point.group_code))
                    .count()
            } else {
                selected_marks
            };
            let enabled_visible_rows = if overlay_active {
                selection.visible_rows.map(|_| enabled_selected_marks as u64)
            } else {
                selection.visible_rows
            };
            let enabled_mean_points = if overlay_active {
                mean.as_ref().map(|points| {
                    points
                        .iter()
                        .filter(|point| enabled_groups.is_enabled(point.group_code))
                        .count()
                })
            } else {
                mean.as_ref().map(|mean| mean.len())
            };
            let enabled_mean_visible = if overlay_active {
                mean.as_ref().is_some_and(|points| {
                    let mut visible = 0usize;
                    let mut current_group = None;
                    let mut group_points = 0usize;
                    for point in points.iter().filter(|point| enabled_groups.is_enabled(point.group_code)) {
                        if current_group != Some(point.group_code) {
                            if group_points >= 2 {
                                visible += group_points - 1;
                            }
                            current_group = Some(point.group_code);
                            group_points = 0;
                        }
                        group_points += 1;
                    }
                    if group_points >= 2 {
                        visible += group_points - 1;
                    }
                    visible > 0
                })
            } else {
                mean.as_ref().is_some_and(|mean| mean.len() >= 2)
            };
            let enabled_raw_segments = if overlay_active {
                raw_line
                    .as_ref()
                    .map(|segments| {
                        segments
                            .iter()
                            .filter(|segment| enabled_groups.is_enabled(segment.group_code))
                            .count()
                    })
                    .unwrap_or(0)
            } else {
                raw_line.as_ref().map_or(0, |segments| segments.len())
            };
            let x_axis = axis_ticks(&built.pyramid.x_axis, domain, request.width)?;
            let scene = GraphNewScene { width: request.width, height: request.height,
                device_pixel_ratio: request.device_pixel_ratio, domain, points,
                overlay: built.pyramid.overlay.clone(), enabled_groups, mean,
                presentation: super::graph_new_renderer::ScenePresentation {
                    raw_line: raw_line.clone(), show_points: request.raw_mode != crate::models::graph_new::GraphNewRawMode::Line,
                    x_axis: (x_axis.kind != GraphNewXMode::Numeric).then_some(x_axis.clone()),
                } };
            let (width, height) = scene.physical_size()?;
            ensure_current()?;
            let frame = render(&scene)?;
            let byte_length = u64::from(width) * u64::from(height) * 4;
            if frame.rgba.len() as u64 != byte_length {
                return Err(AppError::Stats("graph_new_render_failed".into()));
            }
            let header = GraphNewFrameHeader {
                request_id: request.request_id.clone(), dataset_generation: request.dataset_generation,
                renderer_generation: request.renderer_generation, camera_generation: request.camera_generation,
                frame_id: 1, width, height, format: GraphNewFrameFormat::Rgba8, byte_length,
                readback_completed_at_unix_micros: SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(|_| AppError::Stats("graph_new_render_failed".into()))?.as_micros() as u64,
            };
            let mut completion = GraphNewRenderCompletion { request_id: request.request_id.clone(),
                x_axis,
                raw_mode: request.raw_mode, raw_line_available: built.pyramid.mean_available(),
                raw_line_segments: enabled_raw_segments,
                overlay_groups: built.pyramid.overlay.groups.clone(),
                overlay_active: built.pyramid.overlay.active,
                hidden_overlay_groups: request.hidden_overlay_group_ids.len(),
                mean_available: built.pyramid.mean_available(), mean_groups: enabled_mean_points,
                mean_visible: enabled_mean_visible,
                exact_visible: selection.exact, visible_rows: enabled_visible_rows,
                raw_index_entries_inspected: selection.query_work.index_entries_inspected,
                raw_blocks_inspected: selection.query_work.raw_blocks_inspected,
                raw_points_inspected: selection.query_work.raw_points_inspected,
                processed_rows: built.summary.processed_rows, finite_rows: built.summary.finite_rows,
                excluded_non_finite_rows: built.summary.excluded_non_finite_rows, selected_marks: enabled_selected_marks,
                build_ms, render_ms: frame.render_ms, readback_ms: frame.readback_ms, width, height,
                camera_domain: crate::models::graph_new::GraphNewCameraDomain {
                    x_min: domain.x_min, x_max: domain.x_max, y_min: domain.y_min, y_max: domain.y_max },
                plot_rect: scene.plot_rect(), source_projection_query_count, render_generation_check_count: 0,
                cpu_cache_hit: cpu_hit, persistent_cache_hit: disk_hit, cpu_cache_bytes: 0,
                cpu_cache_reserved_bytes: 0, persistent_cache_bytes: 0, cache_evictions: 0,
                gpu_cache: GraphNewRenderer::cache_stats(), process_cpu_reserved_bytes: 0,
                cache_cpu_hits: 0, cache_misses: 0, cache_disk_hits: 0, cache_corruptions: 0, cache_disk_write_failures: 0 };
            let owner = runtime.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
            if !owner.active || owner.closed || owner.session_id != request.session_id
                || owner.request_id != request.request_id || owner.renderer_generation != request.renderer_generation {
                return Err(AppError::Cancelled("graph_new_cancelled".into()));
            }
            let db = self.state.db.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
            generation_checks.set(generation_checks.get() + 1);
            if self.state.graph_new_epoch.load(std::sync::atomic::Ordering::Acquire) != epoch
                || db.get_dataset_generation(&request.dataset_id)? != request.dataset_generation {
                cache.remove(&key.hash_hex);
                return Err(AppError::InvalidParam("graph_new_stale_dataset".into()));
            }
            completion.render_generation_check_count = generation_checks.get();
            send(&header, frame.rgba)?;
            if let Some(built) = pending { cache.insert(built)?; }
            cache.pin(&key.hash_hex);
            drop(db);
            drop(owner);
            if cache.persist(&key.hash_hex).is_err() { cache.disk_write_failures += 1; }
            completion.cpu_cache_bytes = cache.actual_cpu_bytes();
            completion.cpu_cache_reserved_bytes = cache.reserved_cpu_bytes();
            completion.persistent_cache_bytes = cache.disk_bytes;
            completion.cache_evictions = cache.evictions + cache.disk_evictions;
            completion.process_cpu_reserved_bytes = cache.process_cpu_reserved_bytes();
            completion.cache_cpu_hits = cache.hits;
            completion.cache_misses = cache.misses;
            completion.cache_disk_hits = cache.disk_hits;
            completion.cache_corruptions = cache.corruptions;
            completion.cache_disk_write_failures = cache.disk_write_failures;
            Ok(completion)
        })();
        cache.discard_admission();
        let mut owner = runtime.owner.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if (!owner.active && !owner.preserve_cache) || owner.closed { cache.unpin(); }
        if owner.session_id == request.session_id && owner.request_id == request.request_id
            && owner.renderer_generation == request.renderer_generation { owner.active = false; }
        drop(cache);
        drop(owner);
        result.map_err(safe_render_error)
    }

    fn ensure_render_current(&self, request: &GraphNewRenderRequest) -> Result<(), AppError> {
        if !self.state.graph_new.is_current(request) {
            return Err(AppError::Cancelled("graph_new_cancelled".into()));
        }
        let db = self.state.db.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        if db.get_dataset_generation(&request.dataset_id)? != request.dataset_generation {
            return Err(AppError::InvalidParam("graph_new_stale_dataset".into()));
        }
        Ok(())
    }

    pub fn build(
        &self,
        request: &GraphNewBuildRequest,
        progress_sink: &mut dyn FnMut(GraphBuildProgress),
    ) -> Result<GraphNewBuildResult, AppError> {
        self.build_with_cancel(request, progress_sink, &|| true)
    }

    pub fn build_with_cancel(
        &self,
        request: &GraphNewBuildRequest,
        progress_sink: &mut dyn FnMut(GraphBuildProgress),
        is_current: &dyn Fn() -> bool,
    ) -> Result<GraphNewBuildResult, AppError> {
        request.validate()?;
        self.ensure_current(request, is_current, "before construction admission")?;
        let required_disk = self.construction_disk_requirement(request)?;
        let (construction, disk_limit) = {
            let mut cache = self.state.graph_new.cache.try_lock().map_err(|_| AppError::Busy("graph_new_busy".into()))?;
            cache.admit_construction(request.construction_memory_limit_bytes, required_disk)?
        };
        let result = self.build_with_disk_limit(request, progress_sink, is_current, disk_limit, GraphNewXMode::Auto);
        drop(construction);
        result
    }

    fn construction_disk_requirement(&self, request: &GraphNewBuildRequest) -> Result<u64, AppError> {
        let db = self.state.db.lock().map_err(|_| AppError::Stats("graph_new_render_failed".into()))?;
        let rows: u64 = db.conn().query_row(
            "SELECT row_count FROM _meta_datasets WHERE id = $1",
            params![request.dataset_id], |row| row.get(0),
        )?;
        super::graph_new_cache::construction_disk_requirement(
            rows, request.levels, request.max_tile_points, super::graph_new_key::RetentionPolicy::Bounded,
        )
    }

    fn build_with_disk_limit(
        &self, request: &GraphNewBuildRequest, progress_sink: &mut dyn FnMut(GraphBuildProgress),
        is_current: &dyn Fn() -> bool, disk_limit: u64, x_mode: GraphNewXMode,
    ) -> Result<GraphNewBuildResult, AppError> {
        request.validate()?;
        self.ensure_current(request, is_current, "before scan")?;

        let started = Instant::now();
        let (x_column, y_column, overlay_column, read_conn) = {
            let db = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let current_generation = db.get_dataset_generation(&request.dataset_id)?;
            if current_generation != request.dataset_generation {
                return Err(AppError::InvalidParam(
                    "graph-new dataset generation is stale".to_string(),
                ));
            }
            let bindings = resolve_columns(&db, &request.dataset_id)?;
            (
                bindings.get(&request.x_column_id).cloned().ok_or_else(|| {
                    AppError::InvalidParam(
                        "graph-new xColumnId does not resolve to a dataset column".to_string(),
                    )
                })?,
                if request.x_column_id == request.y_column_id {
                    bindings.get(&request.x_column_id).cloned().ok_or_else(|| {
                        AppError::InvalidParam(
                            "graph-new yColumnId does not resolve to a dataset column".to_string(),
                        )
                    })?
                } else {
                    bindings.get(&request.y_column_id).cloned().ok_or_else(|| {
                        AppError::InvalidParam(
                            "graph-new yColumnId does not resolve to a dataset column".to_string(),
                        )
                    })?
                },
                request.overlay_column_id.as_ref().map(|column_id| {
                    bindings.get(column_id).cloned().ok_or_else(|| {
                        AppError::InvalidParam(
                            "graph-new overlayColumnId does not resolve to a dataset column"
                                .to_string(),
                        )
                    })
                }).transpose()?,
                db.open_secondary_connection()?,
            )
        };
        if !is_numeric_type(&y_column.sql_type) {
            return Err(AppError::InvalidParam(
                "graph-new yColumnId must resolve to a supported numeric column".to_string(),
            ));
        }

        let key = GraphKey::canonical(&GraphKeyParts {
            dataset_id: request.dataset_id.clone(),
            dataset_generation: request.dataset_generation,
            x_column_id: x_column.column_id.clone(),
            y_column_id: y_column.column_id.clone(),
            overlay_column_id: overlay_column.as_ref().map(|column| column.column_id.clone()),
            filter_identity: None,
            renderer_contract_version: GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: axis_policy(x_mode),
            levels: request.levels,
            max_tile_points: request.max_tile_points,
        })?;

        let resolved_mode = if x_mode == GraphNewXMode::Auto && !is_numeric_type(&x_column.sql_type) && !is_native_time(&x_column) {
            let parsed =
                parsed_x_sql(&x_column, &y_column, overlay_column.as_ref(), &request.dataset_id);
            let (duration, time): (bool, bool) = read_conn.query_row(&format!(r#"{parsed}
                SELECT coalesce(bool_and(label IS NULL OR duration IS NOT NULL), false),
                    coalesce(bool_and(label IS NULL OR time IS NOT NULL OR mdy IS NOT NULL)
                    AND (bool_and(label IS NULL OR time IS NOT NULL) OR bool_or(mdy IS NOT NULL AND mdy_hint))
                    AND NOT (coalesce(bool_or(has_offset), false) AND coalesce(bool_or((time IS NOT NULL OR mdy IS NOT NULL) AND NOT coalesce(has_offset, false)), false)), false)
                FROM parsed"#), [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            if duration { GraphNewXMode::Duration } else if time { GraphNewXMode::Time } else { GraphNewXMode::Category }
        } else { x_mode };
        let categories = if resolved_mode == GraphNewXMode::Category {
            Some(bounded_categories(&read_conn, &x_column, &request.dataset_id,
                &|| self.ensure_current(request, is_current, "during category admission"))?)
        } else { None };
        let sql = if let Some(categories) = &categories {
            category_projection_sql(
                &x_column,
                &y_column,
                overlay_column.as_ref(),
                &request.dataset_id,
                categories.len(),
            )
        } else {
            x_projection_sql(
                &x_column,
                &y_column,
                overlay_column.as_ref(),
                &request.dataset_id,
                resolved_mode,
            )
        };
        let mut statement = read_conn.prepare(&sql)?;
        let mut rows = statement.query(duckdb::params_from_iter(categories.iter().flatten()))?;
        let mut axis = GraphNewAxisData { kind: GraphNewXMode::Numeric, categories: categories.clone().unwrap_or_default(), ..Default::default() };
        let mut label_bytes = 0usize;
        let mut overlay_dictionary = overlay_column
            .as_ref()
            .map(|column| OverlayDictionary::new(&column.sql_type));
        let mut builder = TilePyramidBuilder::with_memory_limit(
            request.levels,
            request.max_tile_points,
            request.overdraw_factor,
            request.construction_memory_limit_bytes,
        )?;
        builder.limit_disk_to(disk_limit);
        builder.account_input_capacity(request.batch_rows)?;
        let mut batch = Vec::new();
        batch.try_reserve_exact(request.batch_rows).map_err(|_| {
            AppError::Busy("graph-new scan buffer allocation failed".into())
        })?;
        builder.account_input_capacity(batch.capacity())?;
        let mut batches_completed = 0u64;
        let mut rows_since_current_check = 0usize;

        self.emit_progress(
            request,
            progress_sink,
            is_current,
            GraphBuildProgress {
                stage: GraphNewBuildStage::Scan,
                processed_rows: 0,
                finite_rows: 0,
                excluded_non_finite_rows: 0,
                batches_completed: 0,
                projection_query_count: 1,
            },
        )?;

        while let Some(row) = rows.next()? {
            let row_id: i64 = row.get(0)?;
            let x: Option<f64> = row.get(1)?;
            let y: Option<f64> = row.get(2)?;
            let kind: String = row.get(3)?;
            if kind == "mixedTime" { return Err(AppError::InvalidParam("graph_new_x_unrepresentable".into())); }
            axis.kind = match kind.as_str() { "duration" => GraphNewXMode::Duration, "time" => GraphNewXMode::Time,
                "category" => GraphNewXMode::Category, _ => GraphNewXMode::Numeric };
            let overlay_missing: bool = row.get(5)?;
            let overlay_too_large: bool = row.get(6)?;
            if overlay_too_large {
                return Err(AppError::InvalidParam(
                    "graph_new_overlay_value_too_large".into(),
                ));
            }
            let overlay_label: Option<String> = row.get(7)?;
            axis.utc = row.get(8)?;
            if axis.kind == GraphNewXMode::Time {
                axis.origin = Some(crate::models::graph_new::GraphNewTimeOrigin {
                    epoch_nanos: row.get(9)?,
                    unit_nanos: row.get(10)?,
                });
            }
            if axis.kind == GraphNewXMode::Category {
                if let (Some(value), Some(label)) = (x, row.get::<_, Option<String>>(4)?) {
                    if value as usize == axis.categories.len() {
                        label_bytes += label.len() + 24;
                        if axis.categories.len() >= 16384 || label.len() > 512 || label_bytes > 1024 * 1024 {
                            return Err(AppError::InvalidParam("graph_new_x_unrepresentable".into()));
                        }
                        axis.categories.push(label);
                    }
                }
            }
            let point = if x.is_some_and(f64::is_finite) && y.is_some_and(f64::is_finite) {
                let group_code = if let Some(dictionary) = &mut overlay_dictionary {
                    dictionary.observe(if overlay_missing {
                        None
                    } else {
                        overlay_label.as_deref()
                    })?
                } else {
                    0
                };
                SourcePoint::with_group(
                    row_id,
                    x.unwrap_or(f64::NAN),
                    y.unwrap_or(f64::NAN),
                    group_code,
                )
            } else {
                SourcePoint::new(row_id, x.unwrap_or(f64::NAN), y.unwrap_or(f64::NAN))
            };
            batch.push(point);
            rows_since_current_check += 1;
            if rows_since_current_check >= GRAPH_NEW_CURRENT_CHECK_BATCH_ROWS {
                self.ensure_current(request, is_current, "during scan")?;
                rows_since_current_check = 0;
            }
            if batch.len() >= request.batch_rows {
                self.ensure_current(request, is_current, "before scan batch flush")?;
                builder.push_batch(&batch)?;
                batch.clear();
                batches_completed += 1;
                self.emit_progress(
                    request,
                    progress_sink,
                    is_current,
                    GraphBuildProgress {
                        stage: GraphNewBuildStage::Scan,
                        processed_rows: builder.total_processed_rows(),
                        finite_rows: builder.total_finite_rows(),
                        excluded_non_finite_rows: builder.total_excluded_non_finite_rows(),
                        batches_completed,
                        projection_query_count: 1,
                    },
                )?;
                rows_since_current_check = 0;
            }
        }
        if !batch.is_empty() {
            self.ensure_current(request, is_current, "before final scan batch flush")?;
            builder.push_batch(&batch)?;
            batch.clear();
            batches_completed += 1;
            self.emit_progress(
                request,
                progress_sink,
                is_current,
                GraphBuildProgress {
                    stage: GraphNewBuildStage::Scan,
                    processed_rows: builder.total_processed_rows(),
                    finite_rows: builder.total_finite_rows(),
                    excluded_non_finite_rows: builder.total_excluded_non_finite_rows(),
                    batches_completed,
                    projection_query_count: 1,
                },
            )?;
        }

        drop(batch);
        drop(rows);
        drop(statement);

        self.emit_progress(
            request,
            progress_sink,
            is_current,
            GraphBuildProgress {
                stage: GraphNewBuildStage::Pyramid,
                processed_rows: builder.total_processed_rows(),
                finite_rows: builder.total_finite_rows(),
                excluded_non_finite_rows: builder.total_excluded_non_finite_rows(),
                batches_completed,
                projection_query_count: 1,
            },
        )?;

        if let Some(dictionary) = overlay_dictionary.take() {
            builder.set_overlay(dictionary.finish());
        }

        let mut pyramid = builder.finish_with_control(&|| {
            self.ensure_current(request, is_current, "during pyramid")
        })?;
        pyramid.x_axis = axis;
        let finished_ms = started.elapsed().as_millis();
        let summary = GraphNewBuildSummary {
            processed_rows: pyramid.total_processed_rows,
            finite_rows: pyramid.total_finite_rows,
            excluded_non_finite_rows: pyramid.total_excluded_non_finite_rows,
            projection_query_count: 1,
            spool_bytes: pyramid.spool_bytes,
            accounted_memory_bytes: pyramid.accounted_memory_bytes,
            overview_ready_ms: finished_ms,
            pyramid_complete_ms: finished_ms,
            levels: pyramid
                .levels
                .iter()
                .map(|level| GraphNewLevelSummary {
                    level: level.level,
                    tile_count: level.tiles.len() as u64,
                    retained_marks: level.retained_marks,
                    tile_bytes: level.tile_bytes,
                    total_source_count: level.total_source_count,
                })
                .collect(),
        };

        self.emit_progress(
            request,
            progress_sink,
            is_current,
            GraphBuildProgress {
                stage: GraphNewBuildStage::Complete,
                processed_rows: summary.processed_rows,
                finite_rows: summary.finite_rows,
                excluded_non_finite_rows: summary.excluded_non_finite_rows,
                batches_completed,
                projection_query_count: 1,
            },
        )?;

        Ok(GraphNewBuildResult {
            key,
            processed_rows: summary.processed_rows,
            excluded_non_finite_rows: summary.excluded_non_finite_rows,
            query_count: 1,
            pyramid,
            summary,
        })
    }

    #[cfg(test)]
    pub fn build_for_test(
        &self,
        request_id: &str,
        dataset_id: &str,
        dataset_generation: u64,
        x_column_id: &str,
        y_column_id: &str,
        batch_rows: usize,
        max_tile_points: u32,
        levels: u8,
        progress_sink: &mut dyn FnMut(GraphBuildProgress),
        is_current: &dyn Fn() -> bool,
    ) -> Result<GraphNewBuildResult, AppError> {
        self.build_with_cancel(
            &GraphNewBuildRequest {
                request_id: request_id.to_string(),
                dataset_id: dataset_id.to_string(),
                dataset_generation,
                x_column_id: x_column_id.to_string(),
                y_column_id: y_column_id.to_string(),
                overlay_column_id: None,
                max_tile_points,
                levels,
                batch_rows,
                overdraw_factor: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
                construction_memory_limit_bytes:
                    crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
            },
            progress_sink,
            is_current,
        )
    }

    fn emit_progress(
        &self,
        request: &GraphNewBuildRequest,
        progress_sink: &mut dyn FnMut(GraphBuildProgress),
        is_current: &dyn Fn() -> bool,
        progress: GraphBuildProgress,
    ) -> Result<(), AppError> {
        self.ensure_current(request, is_current, "before progress callback")?;
        progress_sink(progress);
        self.ensure_current(request, is_current, "after progress callback")
    }

    fn ensure_current(
        &self,
        request: &GraphNewBuildRequest,
        is_current: &dyn Fn() -> bool,
        stage: &str,
    ) -> Result<(), AppError> {
        if !is_current() {
            return Err(AppError::Cancelled(format!(
                "graph-new build cancelled {stage}"
            )));
        }
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let generation = db.get_dataset_generation(&request.dataset_id)?;
        if generation != request.dataset_generation {
            return Err(AppError::InvalidParam(
                "graph-new stale dataset generation during build".to_string(),
            ));
        }
        Ok(())
    }
}

pub(super) fn raw_line_indices(
    points: &[SourcePoint],
    control: &dyn Fn() -> Result<(), AppError>,
) -> Result<Vec<GroupedLineSegment>, AppError> {
    let mut segments = Vec::with_capacity(points.len().saturating_sub(1));
    let mut start = 0usize;
    while start < points.len() {
        control()?;
        let mut end = start + 1;
        while end < points.len()
            && points[end - 1].row_id.checked_add(1) == Some(points[end].row_id)
        {
            if end % 4096 == 0 {
                control()?;
            }
            end += 1;
        }
        let mut per_group = BTreeMap::<u16, Vec<u32>>::new();
        for (offset, point) in points[start..end].iter().enumerate() {
            per_group
                .entry(point.group_code)
                .or_default()
                .push((start + offset) as u32);
        }
        for (group_code, indices) in &mut per_group {
            indices.sort_unstable_by(|left, right| {
                points[*left as usize]
                    .x
                    .total_cmp(&points[*right as usize].x)
                    .then_with(|| {
                        points[*left as usize]
                            .row_id
                            .cmp(&points[*right as usize].row_id)
                    })
            });
            for pair in indices.windows(2) {
                segments.push(GroupedLineSegment {
                    indices: [pair[0], pair[1]],
                    group_code: *group_code,
                });
            }
        }
        start = end;
    }
    Ok(segments)
}

fn axis_policy(mode: GraphNewXMode) -> String {
    if mode == GraphNewXMode::Auto { GRAPH_NEW_DEFAULT_DOMAIN_POLICY.into() }
    else { format!("{GRAPH_NEW_DEFAULT_DOMAIN_POLICY}-{mode:?}") }
}

fn axis_ticks(axis: &GraphNewAxisData, domain: super::graph_new_lod::GraphDomain, width: u32) -> Result<GraphNewAxis, AppError> {
    let ticks = if axis.kind == GraphNewXMode::Category {
        let start = domain.x_min.ceil().max(0.0) as usize;
        let end = (domain.x_max.floor().max(0.0) as usize + 1).min(axis.categories.len());
        let step = (end.saturating_sub(start) as f64 / ((width.saturating_sub(80) / 140).max(1).min(6)) as f64).ceil().max(1.0) as usize;
        (start..end).step_by(step).map(|index| GraphNewAxisTick { value: index as f64,
            position: super::graph_new_ticks::normalized(index as f64, domain.x_min, domain.x_max), label: Some(axis.categories[index].clone()) }).collect()
    } else {
        super::graph_new_ticks::numeric_ticks(domain.x_min, domain.x_max)?.into_iter()
            .filter(|tick| axis.origin.as_ref().is_none_or(|origin| {
                let nanos = tick.value * f64::from(origin.unit_nanos);
                (nanos - nanos.round()).abs() < 1e-6
            })).map(|tick| GraphNewAxisTick {
            value: tick.value, position: tick.position, label: None,
        }).collect()
    };
    Ok(GraphNewAxis { kind: axis.kind, utc: axis.utc, ticks, origin: axis.origin.clone() })
}

fn relative_time_projection(source: String) -> String {
    format!(r#"WITH time_source AS ({source}), origins AS (
        SELECT *, min(epoch_nanos) OVER () AS origin FROM time_source
    ), units AS (
        SELECT *, CASE WHEN bool_and((epoch_nanos - origin) % 1000000000 = 0) OVER () THEN 1000000000
            WHEN bool_and((epoch_nanos - origin) % 1000000 = 0) OVER () THEN 1000000
            WHEN bool_and((epoch_nanos - origin) % 1000 = 0) OVER () THEN 1000 ELSE 1 END AS unit FROM origins
    ), checked AS (
        SELECT *, max((epoch_nanos - origin) // unit) OVER () > 9007199254740991 AS unsupported FROM units
    ) SELECT _row_id, CASE WHEN kind = 'time' THEN CAST((epoch_nanos - origin) // unit AS DOUBLE) ELSE x END,
        y, CASE WHEN kind = 'time' AND unsupported THEN 'mixedTime' ELSE kind END, label,
        overlay_missing, overlay_too_large, overlay_label, utc, CAST(coalesce(origin, 0) AS VARCHAR), unit
        FROM checked ORDER BY _row_id"#)
}

fn bounded_categories(connection: &duckdb::Connection, column: &ColumnBinding, dataset_id: &str,
    current: &dyn Fn() -> Result<(), AppError>) -> Result<Vec<String>, AppError> {
    let table = quote_identifier(&internal_table_name(dataset_id));
    let column = quote_identifier(&column.name);
    let (minimum, maximum): (Option<i64>, Option<i64>) = connection.query_row(
        &format!("SELECT min(_row_id), max(_row_id) FROM {table}"), [], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut labels = BTreeMap::<String, i64>::new();
    let mut bytes = 0usize;
    if let (Some(mut start), Some(maximum)) = (minimum, maximum) {
        let mut statement = connection.prepare(&format!("SELECT _row_id, CASE WHEN octet_length(encode(TRY_CAST({column} AS VARCHAR))) <= 512 THEN TRY_CAST({column} AS VARCHAR) END, coalesce(octet_length(encode(TRY_CAST({column} AS VARCHAR))) > 512, false) FROM {table} WHERE _row_id >= $1 AND _row_id <= $2"))?;
        loop {
            current()?;
            let end = start.saturating_add(4095).min(maximum);
            let mut rows = statement.query(params![start, end])?;
            while let Some(row) = rows.next()? {
                if row.get::<_, bool>(2)? { return Err(AppError::InvalidParam("graph_new_x_unrepresentable".into())); }
                if let Some(label) = row.get::<_, Option<String>>(1)? {
                    let row_id: i64 = row.get(0)?;
                    if let Some(first) = labels.get_mut(&label) { *first = (*first).min(row_id); }
                    else {
                        bytes += label.len() + 128;
                        if labels.len() >= 16384 || bytes > 1024 * 1024 { return Err(AppError::InvalidParam("graph_new_x_unrepresentable".into())); }
                        labels.insert(label, row_id);
                    }
                }
            }
            if end == maximum { break; }
            start = end + 1;
        }
    }
    let mut labels: Vec<_> = labels.into_iter().collect();
    labels.sort_unstable_by_key(|(_, first)| *first);
    Ok(labels.into_iter().map(|(label, _)| label).collect())
}

fn overlay_projection_sql(overlay_column: Option<&ColumnBinding>) -> (String, String, String) {
    let Some(overlay_column) = overlay_column else {
        return ("FALSE".into(), "FALSE".into(), "NULL::VARCHAR".into());
    };
    let overlay_identifier = quote_identifier(&overlay_column.name);
    (
        format!("CASE WHEN {overlay_identifier} IS NULL THEN TRUE ELSE FALSE END"),
        format!(
            "coalesce(octet_length(encode(TRY_CAST({overlay_identifier} AS VARCHAR))) > 512, false)"
        ),
        format!(
            "CASE
                WHEN {overlay_identifier} IS NULL THEN NULL
                WHEN octet_length(encode(TRY_CAST({overlay_identifier} AS VARCHAR))) <= 512
                    THEN TRY_CAST({overlay_identifier} AS VARCHAR)
                ELSE NULL
             END"
        ),
    )
}

fn category_projection_sql(
    x_column: &ColumnBinding,
    y_column: &ColumnBinding,
    overlay_column: Option<&ColumnBinding>,
    dataset_id: &str,
    count: usize,
) -> String {
    let x_column = quote_identifier(&x_column.name);
    let y_column = quote_identifier(&y_column.name);
    let table = quote_identifier(&internal_table_name(dataset_id));
    let (overlay_missing, overlay_too_large, overlay_label) =
        overlay_projection_sql(overlay_column);
    let dictionary = if count == 0 { "SELECT NULL::VARCHAR AS label, NULL::DOUBLE AS ordinal WHERE false".into() }
        else { format!("SELECT * FROM (VALUES {}) AS entries(label, ordinal)", (0..count).map(|index| format!("(?::VARCHAR, {index}::DOUBLE)")).collect::<Vec<_>>().join(",")) };
    format!("WITH dictionary AS ({dictionary}) SELECT source._row_id, dictionary.ordinal, TRY_CAST(source.{y_column} AS DOUBLE), 'category', NULL::VARCHAR, {overlay_missing}, {overlay_too_large}, {overlay_label}, false, NULL::VARCHAR, 1::UINTEGER FROM {table} AS source LEFT JOIN dictionary ON TRY_CAST(source.{x_column} AS VARCHAR) = dictionary.label ORDER BY source._row_id")
}

fn x_projection_sql(
    x_column: &ColumnBinding,
    y_column: &ColumnBinding,
    overlay_column: Option<&ColumnBinding>,
    dataset_id: &str,
    mode: GraphNewXMode,
) -> String {
    let x_column_sql = quote_identifier(&x_column.name);
    let y_column_sql = quote_identifier(&y_column.name);
    let table = quote_identifier(&internal_table_name(dataset_id));
    let (overlay_missing, overlay_too_large, overlay_label) =
        overlay_projection_sql(overlay_column);
    if mode == GraphNewXMode::Numeric || (mode == GraphNewXMode::Auto && is_numeric_type(&x_column.sql_type)) {
        return format!("SELECT _row_id, TRY_CAST({x_column_sql} AS DOUBLE), TRY_CAST({y_column_sql} AS DOUBLE), 'numeric', NULL::VARCHAR, {overlay_missing}, {overlay_too_large}, {overlay_label}, false, NULL::VARCHAR, 1::UINTEGER FROM {table} ORDER BY _row_id");
    }
    let interpretation = match mode { GraphNewXMode::Category => "'category'", GraphNewXMode::Duration => "'duration'",
        GraphNewXMode::Time => "CASE WHEN utc AND has_naive THEN 'mixedTime' ELSE 'time' END",
        _ => "CASE WHEN all_duration THEN 'duration' WHEN all_time AND NOT (utc AND has_naive) THEN 'time' ELSE 'category' END" };
    let native_time = is_native_time(x_column);
    let native_utc = x_column.sql_type.to_ascii_uppercase().contains("TIME ZONE") || x_column.sql_type.eq_ignore_ascii_case("TIMESTAMPTZ");
    if native_time && matches!(mode, GraphNewXMode::Auto | GraphNewXMode::Time) {
        let epoch = if x_column.sql_type.eq_ignore_ascii_case("TIMESTAMP_NS") { format!("CAST(epoch_ns({x_column_sql}) AS HUGEINT)") }
            else { format!("CAST(epoch_us({x_column_sql}) AS HUGEINT) * 1000") };
        return relative_time_projection(format!("SELECT _row_id, NULL::DOUBLE AS x, TRY_CAST({y_column_sql} AS DOUBLE) AS y, 'time' AS kind, NULL::VARCHAR AS label, {overlay_missing} AS overlay_missing, {overlay_too_large} AS overlay_too_large, {overlay_label} AS overlay_label, {native_utc} AS utc, {epoch} AS epoch_nanos FROM {table}"));
    }
    let parsed = parsed_x_sql(x_column, y_column, overlay_column, dataset_id);
    relative_time_projection(format!(r#"{parsed}, interpreted AS (
            SELECT *, bool_and(label IS NULL OR duration IS NOT NULL) OVER () AS all_duration,
                (bool_and(label IS NULL OR time IS NOT NULL OR mdy IS NOT NULL) OVER ()
                    AND (bool_and(label IS NULL OR time IS NOT NULL) OVER () OR bool_or(mdy IS NOT NULL AND mdy_hint) OVER ())) AS all_time,
                coalesce(bool_or(has_offset) OVER (), false) AS utc,
                coalesce(bool_or((time IS NOT NULL OR mdy IS NOT NULL) AND NOT coalesce(has_offset, false)) OVER (), false) AS has_naive
                FROM parsed
        ), chosen AS (SELECT *, {interpretation} AS kind FROM interpreted)
        SELECT _row_id, CASE WHEN label IS NULL THEN NULL WHEN kind = 'duration' THEN duration ELSE NULL END AS x,
            y, kind, NULL::VARCHAR AS label, overlay_missing, overlay_too_large, overlay_label, utc,
            CASE WHEN kind = 'time' THEN coalesce(time, mdy) END AS epoch_nanos FROM chosen
    "#))
}

fn is_native_time(column: &ColumnBinding) -> bool {
    column.sql_type.to_ascii_uppercase().starts_with("TIMESTAMP") || column.sql_type.eq_ignore_ascii_case("DATE")
}

fn parsed_x_sql(
    x_column: &ColumnBinding,
    y_column: &ColumnBinding,
    overlay_column: Option<&ColumnBinding>,
    dataset_id: &str,
) -> String {
    let x_column_sql = quote_identifier(&x_column.name);
    let y_column_sql = quote_identifier(&y_column.name);
    let table = quote_identifier(&internal_table_name(dataset_id));
    let (overlay_missing, overlay_too_large, overlay_label) =
        overlay_projection_sql(overlay_column);
    let native = if is_native_time(x_column) { format!("CAST(epoch_us({x_column_sql}) AS HUGEINT) * 1000") } else { "NULL::HUGEINT".into() };
    let native_utc = x_column.sql_type.to_ascii_uppercase().contains("TIME ZONE") || x_column.sql_type.eq_ignore_ascii_case("TIMESTAMPTZ");
    format!(r#"
        WITH source AS (
            SELECT _row_id, CASE WHEN octet_length(encode(TRY_CAST({x_column_sql} AS VARCHAR))) > 512 THEN 'unrepresentable' ELSE TRY_CAST({x_column_sql} AS VARCHAR) END AS label,
                TRY_CAST({y_column_sql} AS DOUBLE) AS y, {overlay_missing} AS overlay_missing,
                {overlay_too_large} AS overlay_too_large, {overlay_label} AS overlay_label, {native} AS native_time FROM {table}
        ), parsed AS (
            SELECT *,
                CASE WHEN regexp_full_match(label, '[0-9]+:[0-5][0-9]:[0-5][0-9](\.[0-9]+)?')
                    THEN TRY_CAST(split_part(label, ':', 1) AS DOUBLE) * 3600
                        + TRY_CAST(split_part(label, ':', 2) AS DOUBLE) * 60
                        + TRY_CAST(split_part(label, ':', 3) AS DOUBLE)
                    WHEN regexp_full_match(label, ':[0-9]+:[0-9]+:[0-5][0-9]:[0-5][0-9](\.[0-9]+)?')
                    THEN TRY_CAST(split_part(label, ':', 2) AS DOUBLE) * 86400
                        + TRY_CAST(split_part(label, ':', 3) AS DOUBLE) * 3600
                        + TRY_CAST(split_part(label, ':', 4) AS DOUBLE) * 60
                        + TRY_CAST(split_part(label, ':', 5) AS DOUBLE) END AS duration,
                CASE WHEN native_time IS NOT NULL THEN native_time
                    WHEN regexp_full_match(label, '[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}[ T][0-9]{{2}}:[0-9]{{2}}:[0-9]{{2}}(\.[0-9]{{1,9}})?')
                    THEN CAST(epoch_us(TRY_CAST(regexp_replace(label, '\.[0-9]+', '') AS TIMESTAMP)) AS HUGEINT) * 1000
                        + CAST(rpad(split_part(regexp_extract(label, '\.[0-9]+'), '.', 2), 9, '0') AS BIGINT)
                    WHEN regexp_full_match(label, '[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}[ T][0-9]{{2}}:[0-9]{{2}}:[0-9]{{2}}(\.[0-9]{{1,9}})?(Z|[+-][0-9]{{2}}:[0-9]{{2}})')
                    THEN CAST(epoch_us(TRY_CAST(regexp_replace(label, '\.[0-9]+', '') AS TIMESTAMPTZ)) AS HUGEINT) * 1000
                        + CAST(rpad(split_part(regexp_extract(label, '\.[0-9]+'), '.', 2), 9, '0') AS BIGINT) END AS time,
                CASE WHEN regexp_full_match(label, '[0-9]{{1,2}}/[0-9]{{1,2}}/[0-9]{{4}} [0-9]{{1,2}}:[0-9]{{2}}:[0-9]{{2}} (AM|PM)')
                    THEN CAST(epoch_us(try_strptime(label, '%m/%d/%Y %I:%M:%S %p')) AS HUGEINT) * 1000 END AS mdy,
                TRY_CAST(split_part(label, '/', 2) AS INTEGER) > 12 AS mdy_hint,
                ({native_utc} OR regexp_matches(label, '(Z|[+-][0-9]{{2}}:[0-9]{{2}})$')) AS has_offset FROM source
        )
    "#)
}

fn resolve_columns(
    db: &DuckDbEngine,
    dataset_id: &str,
) -> Result<BTreeMap<String, ColumnBinding>, AppError> {
    let mut statement = db.conn().prepare(
        "SELECT column_id, col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
    )?;
    let mut rows = statement.query(params![dataset_id])?;
    let mut bindings = BTreeMap::<String, ColumnBinding>::new();
    while let Some(row) = rows.next()? {
        let binding = ColumnBinding {
            column_id: row.get(0)?,
            name: row.get(1)?,
            sql_type: row.get(2)?,
        };
        bindings.insert(binding.column_id.clone(), binding);
    }
    Ok(bindings)
}

fn validate_camera_limits(camera: crate::models::graph_new::GraphNewCameraDomain, full: super::graph_new_lod::GraphDomain) -> Result<(), AppError> {
    let mut ratios = [0.0; 2];
    for (index, (min, max, base_min, base_max)) in [
        (camera.x_min, camera.x_max, full.x_min, full.x_max),
        (camera.y_min, camera.y_max, full.y_min, full.y_max),
    ].into_iter().enumerate() {
        let base_span = base_max - base_min;
        let ratio = (max - min) / base_span;
        let center = (min - base_min) / base_span + ratio / 2.0;
        if !base_span.is_finite() || base_span <= 0.0 || !ratio.is_finite() || !center.is_finite()
            || !(0.999e-6..=4.000001).contains(&ratio) || !(-2.000001..=3.000001).contains(&center) {
            return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
        }
        ratios[index] = ratio;
    }
    if (ratios[0] / ratios[1] - 1.0).abs() > 1e-6 {
        return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
    }
    Ok(())
}

fn safe_render_error(error: AppError) -> AppError {
    match error {
        AppError::Cancelled(_) => AppError::Cancelled("graph_new_cancelled".into()),
        AppError::Busy(_) => AppError::Busy("graph_new_busy".into()),
        AppError::InvalidParam(message) if message.contains("stale") => AppError::InvalidParam("graph_new_stale_dataset".into()),
        AppError::InvalidParam(message) if message == "graph_new_x_unrepresentable" => AppError::InvalidParam(message),
        AppError::InvalidParam(_) => AppError::InvalidParam("graph_new_invalid_request".into()),
        AppError::Stats(message) if message == "graph_new_channel_closed" || message == "graph_new_missing_cache"
            || message == "graph_new_cache_pressure" => AppError::Stats(message),
        _ => AppError::Stats("graph_new_render_failed".into()),
    }
}

fn is_numeric_type(sql_type: &str) -> bool {
    matches!(
        sql_type.trim().to_ascii_uppercase().as_str(),
        "BIGINT"
            | "DOUBLE"
            | "REAL"
            | "FLOAT"
            | "INTEGER"
            | "SMALLINT"
            | "TINYINT"
            | "HUGEINT"
            | "UBIGINT"
            | "UINTEGER"
            | "USMALLINT"
            | "UTINYINT"
            | "DECIMAL"
    ) || sql_type.trim().to_ascii_uppercase().starts_with("DECIMAL(")
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn internal_table_name(dataset_id: &str) -> String {
    format!("dataset_{}", dataset_id.replace('-', "_"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use duckdb::params;

    use crate::services::graph_new_service::{GraphBuildProgress, GraphNewService};
    use crate::state::AppState;

    #[test]
    fn graph_new_persistence_fresh_transport_survives_closed_owner_and_late_controls() {
        let runtime = super::GraphNewRuntime::default();
        let mut request: super::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId": "old-request", "sessionId": "old-transport", "datasetId": "dataset",
            "datasetGeneration": 7, "xColumnId": "column-x", "yColumnId": "column-y",
            "width": 640, "height": 360, "devicePixelRatio": 1,
            "rendererGeneration": 1, "cameraGeneration": 0
        })).unwrap();
        runtime.begin(&request).unwrap();
        runtime.close_session("old-transport", 1).unwrap();
        request.renderer_generation = 2;
        assert!(matches!(runtime.begin(&request), Err(crate::error::AppError::Cancelled(_))));
        request.session_id = "fresh-transport".into();
        request.request_id = "fresh-request".into();
        runtime.begin(&request).unwrap();
        assert!(runtime.is_current(&request));
        runtime.close_session("old-transport", 1).unwrap();
        runtime.cancel_request("old-transport", "old-request", 1).unwrap();
        runtime.close("old-transport").unwrap();
        assert!(runtime.is_current(&request), "late old controls cannot close the fresh transport");
        request.renderer_generation = 3;
        runtime.begin(&request).unwrap();
        assert!(runtime.is_current(&request));
    }

    #[test]
    fn graph_new_review_extreme_completion_is_finite() {
        let state = AppState::new().unwrap();
        let (x_id, y_id) = seed_dense_dataset(&state, "extreme", 3);
        state.db.lock().unwrap().conn().execute("UPDATE dataset_extreme SET x_value=CASE _row_id WHEN 1 THEN -1e308 WHEN 2 THEN 0 ELSE 1e308 END", []).unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "requestId":"extreme","sessionId":"extreme","datasetId":"extreme","datasetGeneration":0,
            "xColumnId":x_id,"yColumnId":y_id,"width":640,"height":360,"devicePixelRatio":1,
            "rendererGeneration":1,"cameraGeneration":0,"xMode":"numeric"
        })).unwrap();
        let completion = GraphNewService::new(&state).render_with(&request, super::GraphNewRenderer::render, &mut |_, _| Ok(())).unwrap();
        assert_eq!(completion.x_axis.ticks.iter().map(|tick| tick.value).collect::<Vec<_>>(), vec![-1e308, -5e307, 0.0, 5e307, 1e308]);
        assert_eq!(completion.x_axis.ticks.iter().map(|tick| tick.position).collect::<Vec<_>>(), vec![0.0, 0.25, 0.5, 0.75, 1.0]);
        if let Ok(directory) = std::env::var("GRAPH_NEW_REVIEW_EVIDENCE") {
            std::fs::write(std::path::Path::new(&directory).join("extreme.json"), serde_json::to_vec(&serde_json::json!({"request":request,"completion":completion})).unwrap()).unwrap();
        }
    }

    #[test]
    fn graph_new_review_category_admission_precedes_materialization() {
        for mode in [crate::models::graph_new::GraphNewXMode::Category, crate::models::graph_new::GraphNewXMode::Auto] {
        for oversized in [false, true] {
            let state = AppState::new().unwrap();
            let (x_id, y_id) = seed_dense_dataset(&state, "categorylimit", 20_000);
            {
                let db = state.db.lock().unwrap();
                db.conn().execute_batch("ALTER TABLE dataset_categorylimit ALTER x_value TYPE VARCHAR USING CAST(_row_id AS VARCHAR)").unwrap();
                if oversized {
                    db.conn().execute("UPDATE dataset_categorylimit SET x_value = repeat('wide', 200000) WHERE _row_id=1", []).unwrap();
                }
                db.conn().execute("UPDATE _meta_columns SET col_type='VARCHAR' WHERE dataset_id='categorylimit' AND column_id=$1", params![x_id]).unwrap();
            }
            let request = crate::models::graph_new_data::GraphNewBuildRequest {
                request_id: "categorylimit".into(), dataset_id: "categorylimit".into(), dataset_generation: 0,
                x_column_id: x_id, y_column_id: y_id, overlay_column_id: None,
                levels: 1, max_tile_points: 4096, batch_rows: 1024,
                overdraw_factor: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
                construction_memory_limit_bytes: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
            };
            let scans = std::cell::Cell::new(0);
            let error = GraphNewService::new(&state).build_with_disk_limit(&request,
                &mut |_| scans.set(scans.get() + 1), &|| true, u64::MAX,
                mode).unwrap_err();
            assert!(error.to_string().contains("graph_new_x_unrepresentable"));
            assert_eq!(scans.get(), 0, "category admission must fail before ordered projection/pyramid materialization");
        }
        }
    }

    #[test]
    fn graph_new_review_nanosecond_identity_completion() {
        for (case, sql_type, later, earlier) in [
            ("native", "TIMESTAMP_NS", "2026-09-18 00:00:00.000000002", "2026-09-18 00:00:00.000000001"),
            ("text", "VARCHAR", "2026-09-18 00:00:00.000000002", "2026-09-18 00:00:00.000000001"),
            ("offset", "VARCHAR", "2026-09-18T08:00:00.000000002+08:00", "2026-09-18T00:00:00.000000001Z"),
            ("wide", "TIMESTAMP_NS", "2026-09-18 00:00:00.000000002", "2025-09-18 00:00:00.000000001"),
            ("wide-coarse", "TIMESTAMP_NS", "2026-09-18 00:00:00.000000001", "2025-09-18 00:00:00.000000001"),
        ] {
            let state = AppState::new().unwrap();
            let (x_id, y_id) = seed_dense_dataset(&state, "nano", 2);
            {
                let db = state.db.lock().unwrap();
                db.conn().execute_batch(&format!("ALTER TABLE dataset_nano ALTER x_value TYPE {sql_type} USING CAST(CASE _row_id WHEN 1 THEN '{later}' ELSE '{earlier}' END AS {sql_type})")).unwrap();
                db.conn().execute("UPDATE _meta_columns SET col_type=$1 WHERE dataset_id='nano' AND column_id=$2", params![sql_type, x_id]).unwrap();
            }
            let request = serde_json::from_value(serde_json::json!({
                "requestId":case,"sessionId":case,"datasetId":"nano","datasetGeneration":0,
                "xColumnId":x_id,"yColumnId":y_id,"width":640,"height":360,"devicePixelRatio":1,
                "rendererGeneration":1,"cameraGeneration":0,"rawMode":"pointsLine","showMean":true
            })).unwrap();
            if case == "wide" {
                let error = GraphNewService::new(&state).render_with(&request, |_| panic!("unsupported precision must not render"), &mut |_, _| Ok(())).unwrap_err();
                assert!(error.to_string().contains("graph_new_x_unrepresentable"));
                continue;
            }
            let completion = GraphNewService::new(&state).render_with(&request, |scene| {
                assert_eq!(scene.mean.as_ref().unwrap().len(), 2, "{case}: distinct nanoseconds must not merge");
                let indices = scene.presentation.raw_line.as_ref().unwrap();
                assert_eq!(indices.len(), 1);
                assert_eq!(
                    [
                        scene.points[indices[0].indices[0] as usize].row_id,
                        scene.points[indices[0].indices[1] as usize].row_id,
                    ],
                    [2, 1]
                );
                assert_eq!(scene.points.iter().map(|point| point.x).collect::<Vec<_>>(), vec![if case == "wide-coarse" { 31536000.0 } else { 1.0 }, 0.0]);
                super::GraphNewRenderer::render(scene)
            }, &mut |_, _| Ok(())).unwrap();
            let json = serde_json::to_value(&completion).unwrap();
            assert_eq!(json["xAxis"]["origin"]["epochNanos"], if case == "wide-coarse" { "1758153600000000001" } else { "1789689600000000001" });
            assert_eq!(json["xAxis"]["origin"]["unitNanos"], if case == "wide-coarse" { 1000000000 } else { 1 });
            if let Ok(directory) = std::env::var("GRAPH_NEW_REVIEW_EVIDENCE") {
                std::fs::write(std::path::Path::new(&directory).join(format!("nano-{case}.json")), serde_json::to_vec(&serde_json::json!({"request":request,"completion":completion})).unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn graph_new_phase1_native_raw_line_draws_blue_between_points_without_mean() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "linepixels", 2);
        let request = serde_json::from_value(serde_json::json!({
            "requestId":"pixels", "sessionId":"pixels", "datasetId":"linepixels", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":640, "height":360,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0, "rawMode":"line", "showMean":false
        })).expect("request");
        GraphNewService::new(&state).render_with(&request, |scene| {
            let frame = super::GraphNewRenderer::render(scene)?;
            let plot = scene.plot_rect();
            let center_x = plot.x + plot.width / 2;
            let center_y = plot.y + plot.height / 2;
            let blue = (center_y - 2..=center_y + 2).flat_map(|vertical| (center_x - 2..=center_x + 2).map(move |horizontal| (vertical * 640 + horizontal) as usize * 4))
                .any(|offset| frame.rgba[offset + 2] > 180 && frame.rgba[offset] < 80);
            assert!(blue, "raw line must connect the two observations without a Mean overlay");
            Ok(frame)
        }, &mut |_, _| Ok(())).expect("native raw line");
    }

    #[test]
    fn graph_new_phase1_raw_line_orders_x_ties_and_keeps_source_gaps() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "raw", 6);
        state.db.lock().expect("db").conn().execute(
            "UPDATE dataset_raw SET x_value = CASE _row_id WHEN 1 THEN 3 WHEN 2 THEN 1 WHEN 3 THEN 1 WHEN 4 THEN 2 WHEN 5 THEN 0 ELSE 4 END, y_value = CASE WHEN _row_id = 4 THEN NULL ELSE _row_id END", [],
        ).expect("unsorted data with gap");
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"raw", "sessionId":"raw", "datasetId":"raw", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":640, "height":360,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0, "rawMode":"line", "showMean":true
        })).expect("raw line mode");
        let service = GraphNewService::new(&state);
        let retained = std::cell::RefCell::new(None);
        let render = |scene: &super::GraphNewScene| {
            assert!(scene.mean.is_some(), "Mean remains independent");
            let indices = scene.presentation.raw_line.as_ref().expect("production raw ordering");
            if let Some(previous) = retained.borrow().as_ref() {
                assert!(std::sync::Arc::ptr_eq(previous, indices), "mode switches reuse the raw index cache");
            }
            *retained.borrow_mut() = Some(indices.clone());
            let rows: Vec<_> = indices
                .iter()
                .map(|segment| {
                    [
                        scene.points[segment.indices[0] as usize].row_id,
                        scene.points[segment.indices[1] as usize].row_id,
                    ]
                })
                .collect();
            assert_eq!(rows, vec![[2, 3], [3, 1], [5, 6]]);
            Ok(super::SyntheticFrame { rgba: vec![255; 640 * 360 * 4], padded_bytes_per_row: 640 * 4, render_ms: 0.0, readback_ms: 0.0 })
        };
        let cold = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        assert_eq!((cold.processed_rows, cold.finite_rows, cold.excluded_non_finite_rows), (6, 5, 1));
        assert_eq!(serde_json::to_value(cold).expect("completion")["rawLineSegments"], 3);
        request.renderer_generation = 2;
        request.raw_mode = crate::models::graph_new::GraphNewRawMode::PointsLine;
        let warm = service.render_with(&request, render, &mut |_, _| Ok(())).expect("warm");
        assert_eq!(warm.source_projection_query_count, 0);
        assert_eq!(warm.raw_line_segments, 3);
    }

    #[test]
    fn graph_new_phase1_explicit_x_mode_and_axis_metadata_survive_disk_restore() {
        let state = AppState::new().expect("state");
        let directory = tempfile::tempdir().expect("cache");
        state.set_graph_cache_directory(&directory.path().canonicalize().expect("canonical")).expect("cache");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "mode", 3);
        let service = GraphNewService::new(&state);
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"mode", "sessionId":"mode", "datasetId":"mode", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":640, "height":360,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0, "xMode":"category"
        })).expect("explicit X interpretation");
        let render = |scene: &super::GraphNewScene| {
            assert!(scene.points.iter().all(|point| point.x >= 0.0 && point.x <= 2.0));
            Ok(super::SyntheticFrame { rgba: vec![255; 640 * 360 * 4],
                padded_bytes_per_row: 640 * 4, render_ms: 0.0, readback_ms: 0.0 })
        };
        let cold = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        let json = serde_json::to_value(&cold).expect("completion");
        assert_eq!(json["xAxis"]["kind"], "category");
        assert_eq!(json["xAxis"]["ticks"].as_array().expect("ticks").len(), 3);
        state.graph_new.close_session("mode", 1).expect("close");
        state.graph_new.release_idle_cache().expect("release");
        request.session_id = "restored".into(); request.renderer_generation = 2;
        let restored = service.render_with(&request, render, &mut |_, _| Ok(())).expect("restored");
        assert!(restored.persistent_cache_hit);
        assert_eq!(restored.source_projection_query_count, 0);
        assert_eq!(serde_json::to_value(restored).expect("json")["xAxis"], json["xAxis"]);
    }

    #[test]
    fn graph_new_phase1_native_scalars_and_explicit_invalid_gaps() {
        use crate::models::graph_new::GraphNewXMode;
        for (sql_type, expression, mode, expected, kind, utc) in [
            ("BOOLEAN", "_row_id != 2", GraphNewXMode::Auto, [Some(0.0), Some(1.0), Some(0.0)], "category", false),
            ("DATE", "DATE '2025-12-22' + CAST(_row_id - 1 AS INTEGER)", GraphNewXMode::Auto, [Some(1766361600.0), Some(1766448000.0), Some(1766534400.0)], "time", false),
            ("TIMESTAMPTZ", "CAST(CASE _row_id WHEN 1 THEN '2025-12-22 08:00:00+08' WHEN 2 THEN '2025-12-22 08:00:01+08' ELSE '2025-12-22 08:00:02+08' END AS TIMESTAMPTZ)", GraphNewXMode::Auto, [Some(1766361600.0), Some(1766361601.0), Some(1766361602.0)], "time", true),
            ("VARCHAR", "CASE _row_id WHEN 1 THEN '25:00:00' WHEN 2 THEN 'invalid' ELSE '49:00:00' END", GraphNewXMode::Duration, [Some(90000.0), None, Some(176400.0)], "duration", false),
            ("VARCHAR", "CASE _row_id WHEN 1 THEN '2' WHEN 2 THEN 'invalid' ELSE '1' END", GraphNewXMode::Numeric, [Some(2.0), None, Some(1.0)], "numeric", false),
        ] {
            let state = AppState::new().expect("state");
            let (x_id, y_id) = seed_dense_dataset(&state, "scalars", 3);
            let db = state.db.lock().expect("db");
            db.conn().execute_batch(&format!("ALTER TABLE dataset_scalars ALTER x_value TYPE {sql_type} USING {expression}")).expect("typed fixture");
            db.conn().execute("UPDATE _meta_columns SET col_type=$1 WHERE dataset_id='scalars' AND column_id=$2", params![sql_type, x_id]).expect("metadata");
            let columns = super::resolve_columns(&db, "scalars").expect("bindings");
            let categories = if kind == "category" { Some(super::bounded_categories(db.conn(), &columns[&x_id], "scalars", &|| Ok(())).unwrap()) } else { None };
            let sql = if let Some(labels) = &categories {
                super::category_projection_sql(
                    &columns[&x_id],
                    &columns[&y_id],
                    None,
                    "scalars",
                    labels.len(),
                )
            } else {
                super::x_projection_sql(&columns[&x_id], &columns[&y_id], None, "scalars", mode)
            };
            let mut statement = db.conn().prepare(&sql).expect("projection");
            let rows = statement.query_map(duckdb::params_from_iter(categories.iter().flatten()), |row| {
                let kind: String = row.get(3)?;
                let mut value: Option<f64> = row.get(1)?;
                if kind == "time" {
                    let origin: String = row.get(9)?;
                    let unit: u32 = row.get(10)?;
                    value = value.map(|value| origin.parse::<f64>().unwrap() / 1e9 + value * f64::from(unit) / 1e9);
                }
                Ok((value, kind, row.get::<_, bool>(8)?))
            })
                .expect("query").collect::<Result<Vec<_>, _>>().expect("rows");
            assert_eq!(rows.iter().map(|row| row.0).collect::<Vec<_>>(), expected);
            assert!(rows.iter().all(|row| row.1 == kind && row.2 == utc));
        }
    }

    #[test]
    fn graph_new_phase1_auto_x_preserves_duration_time_and_first_seen_categories() {
        for (values, expected) in [
            (["\u{6e29}\u{5ea6}", "\u{00e9}\u{0394}", "\u{6e29}\u{5ea6}"], [0.0, 1.0, 0.0]),
            ([":0:25:00:00", ":1:01:00:00", ":0:49:30:00"], [90000.0, 90000.0, 178200.0]),
            (["12/22/2025 7:47:16 AM", "12/22/2025 7:47:17 AM", "12/23/2025 7:47:16 AM"], [1766389636.0, 1766389637.0, 1766476036.0]),
            (["2026-09-18T08:00:00+08:00", "2026-09-18T00:00:01Z", "2026-09-19T00:00:00Z"], [1789689600.0, 1789689601.0, 1789776000.0]),
            (["25:00:00", "00:00:01", "49:30:00"], [90000.0, 1.0, 178200.0]),
            (["2026-09-18 00:00:00", "2026-09-18 00:00:01", "2026-09-19 00:00:00"], [1789689600.0, 1789689601.0, 1789776000.0]),
            (["03/04/2026", "01/02/2026", "03/04/2026"], [0.0, 1.0, 0.0]),
            (["03/04/2026 7:47:16 AM", "01/02/2026 7:47:16 AM", "03/04/2026 7:47:16 AM"], [0.0, 1.0, 0.0]),
            (["2026-09-18 00:00:00", "2026-09-18T00:00:01Z", "2026-09-19 00:00:00"], [0.0, 1.0, 2.0]),
        ] {
            let state = AppState::new().expect("state");
            let (x_column_id, y_column_id) = seed_dense_dataset(&state, "typed", 3);
            {
                let db = state.db.lock().expect("db");
                db.conn().execute("ALTER TABLE dataset_typed ALTER x_value TYPE VARCHAR", []).expect("text x");
                db.conn().execute("UPDATE _meta_columns SET col_type = 'VARCHAR' WHERE dataset_id = 'typed' AND col_name = 'x_value'", []).expect("metadata");
                for (index, value) in values.iter().enumerate() {
                    db.conn().execute("UPDATE dataset_typed SET x_value = $1 WHERE _row_id = $2", params![value, index as i64 + 1]).expect("value");
                }
            }
            let request = serde_json::from_value(serde_json::json!({
                "requestId":"typed", "sessionId":"typed", "datasetId":"typed", "datasetGeneration":0,
                "xColumnId":x_column_id, "yColumnId":y_column_id, "width":640, "height":360,
                "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
            })).expect("request");
            let result = GraphNewService::new(&state).render_with(&request, |scene| {
                let mut points = scene.points.clone();
                points.sort_by_key(|point| point.row_id);
                let origin = scene.presentation.x_axis.as_ref().and_then(|axis| axis.origin.as_ref());
                assert_eq!(points.iter().map(|point| origin.map_or(point.x, |origin|
                    origin.epoch_nanos.parse::<f64>().unwrap() / 1e9 + point.x * f64::from(origin.unit_nanos) / 1e9)).collect::<Vec<_>>(), expected);
                Ok(super::SyntheticFrame { rgba: vec![255; 640 * 360 * 4],
                    padded_bytes_per_row: 640 * 4, render_ms: 0.0, readback_ms: 0.0 })
            }, &mut |_, _| Ok(())).expect("all scalar X types must render");
            assert_eq!((result.processed_rows, result.finite_rows, result.excluded_non_finite_rows), (3, 3, 0));
            if values[0] == "\u{6e29}\u{5ea6}" {
                assert_eq!(result.x_axis.ticks.iter().filter_map(|tick| tick.label.as_deref()).collect::<Vec<_>>(), vec!["\u{6e29}\u{5ea6}", "\u{00e9}\u{0394}"]);
                let db = state.db.lock().unwrap();
                let bindings = super::resolve_columns(&db, "typed").unwrap();
                let sql = super::category_projection_sql(
                    &bindings[&request.x_column_id],
                    &bindings[&request.y_column_id],
                    None,
                    "typed",
                    2,
                );
                let plan: String = db.conn().query_row(&format!("EXPLAIN {sql}"), params![values[0], values[1]], |row| row.get(1)).unwrap();
                assert!(!plan.contains("WINDOW"), "category projection must not rank full text: {plan}");
            }
            if values[0] == "2026-09-18 00:00:00" && values[1].ends_with('Z') {
                let mut explicit = request.clone();
                explicit.x_mode = crate::models::graph_new::GraphNewXMode::Time;
                explicit.renderer_generation += 1;
                let error = GraphNewService::new(&state).render_with(&explicit, |_| panic!("mixed zones cannot render as one time axis"), &mut |_, _| Ok(())).expect_err("mixed time rejected");
                assert!(error.to_string().contains("graph_new_x_unrepresentable"));
            }
        }
    }

    #[test]
    fn graph_new_completed_construction_replaces_pinned_graph_without_double_reservation() {
        use super::super::graph_new_cache::GraphNewCacheCoordinator;

        for fail_frame in [false, true] {
            let state = AppState::new().expect("state");
            let (x_column_id, y_column_id) = seed_dataset(&state, "completed-construction");
            let request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
                "requestId":"replacement", "sessionId":"session", "datasetId":"completed-construction", "datasetGeneration":0,
                "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
                "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
            })).expect("request");
            let service = GraphNewService::new(&state);
            let mut original_request = request.clone();
            original_request.y_column_id = original_request.x_column_id.clone();
            let original = service.build(&original_request.build_request(), &mut |_| {}).expect("original");
            let original_key = original.key.hash_hex.clone();
            let original_bytes = original.pyramid.cache_reservation_bytes() + 4096;
            let construction_bytes = request.build_request().construction_memory_limit_bytes;
            let pool_limit = original_bytes + construction_bytes + 1024 * 1024;
            let directory = tempfile::tempdir().expect("directory");
            let mut cache = GraphNewCacheCoordinator::new(pool_limit, 0);
            cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("directory");
            cache.insert(original).expect("insert original");
            cache.persist(&original_key).expect("persist original");
            cache.pin(&original_key);
            let original_path = directory.path().join("graph-new-derived-v1").read_dir().expect("cache root")
                .next().expect("namespace").expect("namespace entry").path().join(format!("{original_key}.gnd"));
            assert!(cache.process_cpu_reserved_bytes() + construction_bytes <= pool_limit);
            let before = cache.process_cpu_reserved_bytes();
            *state.graph_new.cache.lock().expect("cache") = cache;
            let rendered = std::cell::Cell::new(false);
            let result = service.render_with(&request, |scene| {
                rendered.set(true);
                assert!(original_path.is_file(), "previous frame disk survives through replacement rendering");
                if fail_frame { return Err(crate::error::AppError::Stats("graph_new_render_failed".into())); }
                let (width, height) = scene.physical_size()?;
                Ok(super::SyntheticFrame { rgba: vec![255; width as usize * height as usize * 4],
                    padded_bytes_per_row: width * 4, render_ms: 0.0, readback_ms: 0.0 })
            }, &mut |_, _| {
                assert!(!fail_frame);
                assert!(original_path.is_file(), "previous frame survives until replacement is sent");
                Ok(())
            });
            assert!(rendered.get(), "completed result must not retain the full construction reservation: {result:?}");
            let mut cache = state.graph_new.cache.lock().expect("cache");
            assert!(cache.get(&original_key).is_some());
            assert!(original_path.is_file());
            assert_eq!((cache.evictions, cache.disk_evictions), (0, 0));
            assert!(cache.process_cpu_reserved_bytes() <= pool_limit);
            if fail_frame {
                assert!(result.is_err());
                assert_eq!(cache.process_cpu_reserved_bytes(), before, "failed pending reservation is released");
                cache.evict_unpinned();
                assert!(cache.get(&original_key).is_some(), "failed replacement does not unpin previous graph");
            } else {
                assert_eq!(result.expect("replacement").source_projection_query_count, 1);
                assert!(cache.process_cpu_reserved_bytes() > before);
                assert!(cache.process_cpu_reserved_bytes() < construction_bytes, "construction headroom was released");
                cache.evict_unpinned();
                assert!(cache.get(&original_key).is_none(), "previous graph becomes evictable only after successful replacement");
            }
        }
    }

    #[test]
    fn graph_new_construction_pressure_service_paths_preserve_original_on_abort() {
        use super::super::graph_new_cache::{construction_disk_requirement, tests::set_disk_limit, GraphNewCacheCoordinator};
        use super::super::graph_new_key::RetentionPolicy;

        for outcome in ["standalone", "render", "failure", "cancel"] {
            let state = AppState::new().expect("state");
            *state.graph_new.cache.lock().expect("cache") = GraphNewCacheCoordinator::new(1024 * 1024 * 1024, 0);
            let directory = tempfile::tempdir().expect("directory");
            state.set_graph_cache_directory(&directory.path().canonicalize().expect("canonical")).expect("cache directory");
            let (x_column_id, y_column_id) = seed_dataset(&state, "disk-pressure");
            let (old_x, old_y) = seed_dense_dataset(&state, "evictable", 64);
            let request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
                "requestId":"replacement", "sessionId":"session", "datasetId":"disk-pressure", "datasetGeneration":0,
                "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
                "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
            })).expect("request");
            let service = GraphNewService::new(&state);
            let replacement = request.build_request();
            let mut original_request = request.clone();
            original_request.y_column_id = original_request.x_column_id.clone();
            let original = service.build(&original_request.build_request(), &mut |_| {}).expect("original");
            let original_key = original.key.clone();
            let pinned_bytes = original.pyramid.encoded_bytes() + original.pyramid.persisted_bytes();
            let mut old_request = replacement.clone();
            old_request.dataset_id = "evictable".into();
            old_request.x_column_id = old_x;
            old_request.y_column_id = old_y;
            let old = service.build(&old_request, &mut |_| {}).expect("evictable");
            let old_key = old.key.hash_hex.clone();
            let required = construction_disk_requirement(4, replacement.levels, replacement.max_tile_points, RetentionPolicy::Bounded).expect("bound");
            {
                let mut cache = state.graph_new.cache.lock().expect("cache");
                cache.insert(old).expect("old insert");
                cache.persist(&old_key).expect("old persist");
                cache.insert(original).expect("original insert");
                cache.persist(&original_key.hash_hex).expect("original persist");
                cache.pin(&original_key.hash_hex);
                set_disk_limit(&mut cache, pinned_bytes + required);
            }
            let render = |scene: &super::GraphNewScene| {
                let (width, height) = scene.physical_size()?;
                Ok(super::SyntheticFrame { rgba: vec![255; width as usize * height as usize * 4],
                    padded_bytes_per_row: width * 4, render_ms: 0.0, readback_ms: 0.0 })
            };
            if outcome == "standalone" {
                let built = service.build_with_cancel(&replacement, &mut |_| {}, &|| true).expect("standalone cold build after reclaim");
                assert_eq!(built.query_count, 1);
            } else {
                let result = service.render_with(&request, |scene| {
                    if outcome == "failure" { return Err(crate::error::AppError::Stats("graph_new_render_failed".into())); }
                    if outcome == "cancel" {
                        state.graph_new.cancel_request("session", "replacement", 1).expect("cancel replacement");
                    }
                    render(scene)
                }, &mut |_, _| {
                    assert_eq!(outcome, "render", "aborted replacement must not publish");
                    Ok(())
                });
                match outcome {
                    "render" => assert_eq!(result.expect("cold render after reclaim").source_projection_query_count, 1),
                    "cancel" => assert!(matches!(result, Err(crate::error::AppError::Cancelled(_)))),
                    _ => assert!(matches!(result, Err(crate::error::AppError::Stats(_)))),
                }
            }
            {
                let cache = state.graph_new.cache.lock().expect("cache");
                assert!(cache.disk_evictions > 0, "construction must reclaim disk");
                if outcome != "render" { assert!(cache.get(&original_key.hash_hex).is_some(), "pinned original survives"); }
            }
            if outcome == "failure" || outcome == "cancel" {
                original_request.renderer_generation = 2;
                let warm = service.render_with(&original_request, render, &mut |_, _| Ok(())).expect("original still warm");
                assert!(warm.cpu_cache_hit);
                assert_eq!(warm.source_projection_query_count, 0);
                state.graph_new.close_session("session", 2).expect("close");
                state.graph_new.release_idle_cache().expect("release residents");
                original_request.session_id = "reopen".into();
                original_request.renderer_generation = 3;
                let disk_warm = service.render_with(&original_request, render, &mut |_, _| Ok(())).expect("original disk ownership survives");
                assert!(disk_warm.persistent_cache_hit);
                assert_eq!(disk_warm.source_projection_query_count, 0);
            }
        }
    }

    #[test]
    fn graph_new_lossless_cold_build_reserves_shared_memory_before_projection() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "construction-pressure");
        *state.graph_new.cache.lock().expect("cache") = super::super::graph_new_cache::GraphNewCacheCoordinator::new(128 * 1024 * 1024, 0);
        let request = serde_json::from_value(serde_json::json!({
            "requestId":"pressure", "sessionId":"session", "datasetId":"construction-pressure", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let rendered = std::cell::Cell::new(false);
        let result = GraphNewService::new(&state).render_with(&request, |scene| {
            rendered.set(true);
            Ok(super::SyntheticFrame { rgba: vec![255; scene.width as usize * scene.height as usize * 4],
                padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0 })
        }, &mut |_, _| Ok(()));
        assert!(result.is_err(), "construction cannot reserve 512 MiB from a 128 MiB pool");
        assert!(!rendered.get());
        assert_eq!(state.graph_new.cache.lock().expect("cache").process_cpu_reserved_bytes(), 0);
    }

    #[test]
    fn graph_new_cpu_construction_failure_preserves_warm_cpu_and_disk_cache() {
        use super::super::graph_new_cache::{
            construction_disk_requirement,
            tests::{reserve_process_cpu, set_disk_limit},
            GraphNewCacheCoordinator,
        };
        use super::super::graph_new_key::RetentionPolicy;

        let state = AppState::new().expect("state");
        let (warm_x, warm_y) = seed_dataset(&state, "warm-under-pressure");
        let (cold_x, cold_y) = seed_dense_dataset(&state, "cold-under-pressure", 4);
        let service = GraphNewService::new(&state);
        let warm_request: crate::models::graph_new::GraphNewRenderRequest =
            serde_json::from_value(serde_json::json!({
                "requestId":"warm", "sessionId":"session", "datasetId":"warm-under-pressure",
                "datasetGeneration":0, "xColumnId":warm_x, "yColumnId":warm_y,
                "width":320, "height":200, "devicePixelRatio":1,
                "rendererGeneration":1, "cameraGeneration":0
            }))
            .expect("warm request");
        let warm = service
            .build(&warm_request.build_request(), &mut |_| {})
            .expect("warm graph");
        let warm_key = warm.key.hash_hex.clone();

        let directory = tempfile::tempdir().expect("directory");
        let mut constrained = GraphNewCacheCoordinator::new(1024 * 1024 * 1024, 0);
        constrained
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("cache directory");
        constrained.insert(warm).expect("warm insert");
        constrained.persist(&warm_key).expect("warm persist");
        let _occupied_process_cpu = reserve_process_cpu(&constrained, 600 * 1024 * 1024);
        let warm_path = directory
            .path()
            .join("graph-new-derived-v1")
            .read_dir()
            .expect("cache root")
            .next()
            .expect("namespace")
            .expect("namespace entry")
            .path()
            .join(format!("{warm_key}.gnd"));
        let cold_request: crate::models::graph_new::GraphNewRenderRequest =
            serde_json::from_value(serde_json::json!({
                "requestId":"cold", "sessionId":"session", "datasetId":"cold-under-pressure",
                "datasetGeneration":0, "xColumnId":cold_x, "yColumnId":cold_y,
                "width":320, "height":200, "devicePixelRatio":1,
                "rendererGeneration":2, "cameraGeneration":0
            }))
            .expect("cold request");
        let required = construction_disk_requirement(
            4,
            cold_request.build_request().levels,
            cold_request.build_request().max_tile_points,
            RetentionPolicy::Bounded,
        )
        .expect("construction bound");
        let disk_limit = constrained.disk_bytes
            + constrained
                .get(&warm_key)
                .expect("warm resident")
                .pyramid
                .encoded_bytes()
            + required
            - 1;
        set_disk_limit(&mut constrained, disk_limit);
        let before = (
            constrained.cpu_bytes,
            constrained.disk_bytes,
            constrained.evictions,
            constrained.disk_evictions,
            constrained.process_cpu_reserved_bytes(),
        );
        *state.graph_new.cache.lock().expect("cache") = constrained;

        let error = service
            .build_with_cancel(&cold_request.build_request(), &mut |_| {}, &|| true)
            .expect_err("construction CPU reservation must fail");
        assert!(matches!(error, crate::error::AppError::Stats(message)
            if message == "graph_new_cache_pressure"));
        let cache = state.graph_new.cache.lock().expect("cache");
        assert!(cache.get(&warm_key).is_some(), "warm resident must survive");
        assert!(warm_path.is_file(), "warm disk entry must survive");
        assert_eq!(
            (
                cache.cpu_bytes,
                cache.disk_bytes,
                cache.evictions,
                cache.disk_evictions,
                cache.process_cpu_reserved_bytes(),
            ),
            before,
        );
    }

    #[test]
    fn graph_new_compact_exact_above_million_preserves_every_source_point() {
        let state = AppState::new().expect("state");
        let rows = 1_000_001;
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "lossless", rows);
        state.db.lock().expect("db").conn().execute(
            "UPDATE dataset_lossless SET x_value = _row_id % 1025, y_value = _row_id % 257", [],
        ).expect("exactly representable bounds");
        let request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"above-million", "sessionId":"above-million", "datasetId":"lossless", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let built = GraphNewService::new(&state).build_with_cancel(
            &request.build_request(), &mut |_| {}, &|| true,
        ).expect("build");
        assert_eq!(built.pyramid.levels.len(), 1, "exact source must skip the deep pyramid");
        assert_eq!(built.pyramid.levels[0].retained_marks, rows);
        drop(built);
        let completion = GraphNewService::new(&state).render_with(&request, |scene| {
            assert_eq!(scene.points.len(), rows as usize, "all finite points must reach the renderer");
            scene.physical_size().expect("valid exact scene");
            assert_eq!(scene.points.first().expect("first").row_id, 1);
            assert_eq!(scene.points.last().expect("last").row_id, rows as i64);
            Ok(super::SyntheticFrame {
                rgba: vec![255; scene.width as usize * scene.height as usize * 4],
                padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
            })
        }, &mut |_, _| Ok(())).expect("exact render");
        assert_eq!(completion.selected_marks, rows as usize);
        assert!(completion.exact_visible);
        assert_eq!(completion.source_projection_query_count, 1);
    }

    #[test]
    fn graph_new_compact_exact_completion_recovers_anomaly_without_projection() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "lossless", 8194);
        state.db.lock().expect("db").conn().execute(
            "UPDATE dataset_lossless SET x_value = CASE WHEN _row_id = 8193 THEN 0.1 WHEN _row_id = 8194 THEN 1000.0 ELSE 0.0 END, y_value = CASE WHEN _row_id = 8193 THEN 0.1 WHEN _row_id = 8194 THEN 1000.0 ELSE 0.0 END", []).expect("dense anomaly");
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"raw", "sessionId":"raw-session", "datasetId":"lossless", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let render = |scene: &super::GraphNewScene| Ok(super::SyntheticFrame {
            rgba: vec![255; scene.width as usize * scene.height as usize * 4],
            padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
        });
        let service = GraphNewService::new(&state);
        let cold = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        let metadata = serde_json::to_value(&cold).expect("metadata");
        assert_eq!(metadata["exactVisible"], true);
        assert_eq!(metadata["visibleRows"], 8194);
        assert_eq!(metadata["rawIndexEntriesInspected"], 0);
        assert_eq!(metadata["rawBlocksInspected"], 0);
        assert_eq!(metadata["rawPointsInspected"], 0);
        assert_eq!(cold.source_projection_query_count, 1);
        request.renderer_generation = 2;
        request.camera_generation = 1;
        request.camera_domain = Some(crate::models::graph_new::GraphNewCameraDomain {
            x_min: 0.09, x_max: 0.11, y_min: 0.09, y_max: 0.11,
        });
        let zoomed = service.render_with(&request, |scene| {
            assert_eq!(scene.points.len(), 8194, "full source slots survive camera changes");
            assert!(scene.points.iter().any(|point| point.row_id == 8193 && point.x == 0.1 && point.y == 0.1));
            render(scene)
        }, &mut |_, _| Ok(())).expect("bounded camera");
        let metadata = serde_json::to_value(&zoomed).expect("metadata");
        assert_eq!(metadata["exactVisible"], true);
        assert_eq!(metadata["visibleRows"], 1);
        assert_eq!(metadata["selectedMarks"], 8194);
        assert_eq!(metadata["rawPointsInspected"], 0);
        assert_eq!(metadata["rawBlocksInspected"], 0);
        assert_eq!(metadata["rawIndexEntriesInspected"], 0);
        assert_eq!(zoomed.source_projection_query_count, 0);
        assert_eq!(zoomed.render_generation_check_count, 4);
    }

    #[test]
    fn graph_new_optional_cache_init_failure_keeps_service_memory_only() {
        for resolve_failure in [true, false] {
            let directory = tempfile::tempdir().expect("directory");
            let root = directory.path().canonicalize().expect("canonical");
            let blocked = root.join("private-path-not-for-diagnostics");
            std::fs::write(&blocked, b"keep").expect("blocked cache directory");
            let state = AppState::new().expect("state");
            let path = if resolve_failure { Err("private/path/resolution/error") } else { Ok(blocked.clone()) };
            let diagnostic = crate::initialize_graph_new_cache(&state, path).expect_err("safe diagnostic");
            assert_eq!(diagnostic, if resolve_failure { "path_unavailable" } else { "initialization_failed" });
            let (x_column_id, y_column_id) = seed_dataset(&state, "optional-cache");
            let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
                "requestId":"optional", "sessionId":"session", "datasetId":"optional-cache", "datasetGeneration":0,
                "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
                "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
            })).expect("request");
            let render = |scene: &super::GraphNewScene| Ok(super::SyntheticFrame {
                rgba: vec![255; scene.width as usize * scene.height as usize * 4],
                padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
            });
            let service = GraphNewService::new(&state);
            let cold = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold without persistent cache");
            assert_eq!(cold.source_projection_query_count, 1);
            assert!(!cold.persistent_cache_hit);
            request.renderer_generation = 2;
            request.camera_domain = Some(cold.camera_domain);
            let warm = service.render_with(&request, render, &mut |_, _| Ok(())).expect("memory camera render");
            assert!(warm.cpu_cache_hit && !warm.persistent_cache_hit);
            assert_eq!(warm.source_projection_query_count, 0);
            assert_eq!(state.graph_new.cache.lock().expect("cache").disk_bytes, 0);
            assert_eq!(std::fs::read(blocked).expect("blocker retained"), b"keep");
        }
    }

    #[test]
    fn graph_new_cache_completed_key_survives_close_and_cancel() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "warm-fixture");
        let service = GraphNewService::new(&state);
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"warm-1", "sessionId":"first", "datasetId":"warm-fixture", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let render = |scene: &super::GraphNewScene| {
            let (width, height) = scene.physical_size()?;
            Ok(super::SyntheticFrame {
                rgba: vec![255; width as usize * height as usize * 4],
                padded_bytes_per_row: width * 4, render_ms: 0.0, readback_ms: 0.0,
            })
        };
        let cold = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        assert_eq!(cold.source_projection_query_count, 1);
        state.graph_new.close_session("first", 1).expect("close");
        request.session_id = "second".into();
        request.renderer_generation = 2;
        let warm = service.render_with(&request, render, &mut |_, _| Ok(())).expect("warm");
        assert_eq!(warm.source_projection_query_count, 0, "completed key is not session-owned");
        assert_eq!(warm.render_generation_check_count, 4);
        state.graph_new.cancel_request("second", "warm-1", 2).expect("cancel");
        request.renderer_generation = 3;
        let warm = service.render_with(&request, render, &mut |_, _| Ok(())).expect("after cancel");
        assert_eq!(warm.source_projection_query_count, 0);
        let domain = warm.camera_domain;
        request.camera_domain = Some(crate::models::graph_new::GraphNewCameraDomain {
            x_min: domain.x_min + (domain.x_max - domain.x_min) * 0.25,
            x_max: domain.x_max - (domain.x_max - domain.x_min) * 0.25,
            y_min: domain.y_min + (domain.y_max - domain.y_min) * 0.25,
            y_max: domain.y_max - (domain.y_max - domain.y_min) * 0.25,
        });
        request.renderer_generation = 4;
        let zoomed = service.render_with(&request, render, &mut |_, _| Ok(())).expect("zoomed");
        assert!(zoomed.cpu_cache_hit && !zoomed.persistent_cache_hit);
        assert_eq!(zoomed.source_projection_query_count, 0);
        request.width = 450;
        request.height = 300;
        request.device_pixel_ratio = 2.0;
        request.renderer_generation = 5;
        let resized = service.render_with(&request, render, &mut |_, _| Ok(())).expect("resized zoom from memory");
        assert!(resized.cpu_cache_hit && !resized.persistent_cache_hit);
        assert_eq!(resized.source_projection_query_count, 0);
        assert_eq!(resized.render_generation_check_count, 4);
        assert_eq!(serde_json::to_value(resized.camera_domain).expect("resized domain"),
            serde_json::to_value(zoomed.camera_domain).expect("zoomed domain"));
        assert_eq!((resized.width, resized.height), (900, 600));
        assert!(resized.plot_rect.width > zoomed.plot_rect.width);
    }

    #[test]
    fn graph_new_cache_disk_reopen_and_database_epoch_are_real() {
        let directory = tempfile::tempdir().expect("directory");
        let state = AppState::new().expect("state");
        state.set_graph_cache_directory(&directory.path().canonicalize().expect("canonical")).expect("cache root");
        let (x_column_id, y_column_id) = seed_dataset(&state, "disk-fixture");
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"disk", "sessionId":"first", "datasetId":"disk-fixture", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let render = |scene: &super::GraphNewScene| Ok(super::SyntheticFrame {
            rgba: vec![255; scene.width as usize * scene.height as usize * 4],
            padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
        });
        let service = GraphNewService::new(&state);
        service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        state.graph_new.close_session("first", 1).expect("close");
        state.graph_new.release_idle_cache().expect("memory pressure");
        request.renderer_generation = 2; request.session_id = "second".into();
        request.camera_domain = Some(crate::models::graph_new::GraphNewCameraDomain {
            x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0,
        });
        let error = service.render_with(&request, |_| panic!("camera must not load or scan"), &mut |_, _| Ok(())).expect_err("miss");
        assert!(error.to_string().contains("graph_new_missing_cache"));
        request.renderer_generation = 3; request.camera_domain = None;
        let warm = service.render_with(&request, render, &mut |_, _| Ok(())).expect("disk warm");
        assert!(warm.persistent_cache_hit && !warm.cpu_cache_hit);
        assert_eq!(warm.source_projection_query_count, 0);
        assert_eq!(warm.render_generation_check_count, 4);
        state.reset_db().expect("new project epoch");
        let (new_x, new_y) = seed_dataset(&state, "disk-fixture");
        state.db.lock().expect("db").conn().execute(
            "UPDATE _meta_columns SET column_id = CASE WHEN column_id = $1 THEN $2 ELSE $4 END WHERE column_id IN ($1, $3)",
            params![new_x, x_column_id, new_y, y_column_id]).expect("restore identical IDs");
        request.renderer_generation = 4;
        let fresh = service.render_with(&request, render, &mut |_, _| Ok(())).expect("new epoch");
        assert!(!fresh.cpu_cache_hit && !fresh.persistent_cache_hit);
        assert_eq!(fresh.source_projection_query_count, 1);
    }

    #[test]
    fn graph_new_cache_aborted_cold_never_publishes_but_completed_key_survives_abort() {
        let directory = tempfile::tempdir().expect("directory");
        let state = AppState::new().expect("state");
        state.set_graph_cache_directory(&directory.path().canonicalize().expect("canonical")).expect("cache");
        let (x_column_id, y_column_id) = seed_dataset(&state, "abort-fixture");
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"abort", "sessionId":"session", "datasetId":"abort-fixture", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let service = GraphNewService::new(&state);
        let render = |scene: &super::GraphNewScene| Ok(super::SyntheticFrame {
            rgba: vec![255; scene.width as usize * scene.height as usize * 4],
            padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
        });
        assert!(service.render_with(&request, |scene| {
            state.graph_new.cancel_request("session", "abort", request.renderer_generation).expect("cancel"); render(scene)
        }, &mut |_, _| panic!("aborted partial must not publish")).is_err());
        {
            let cache = state.graph_new.cache.lock().expect("cache");
            assert!(cache.is_none()); assert_eq!(cache.disk_bytes, 0); assert_eq!(cache.cpu_bytes, 0);
        }
        request.renderer_generation = 2;
        service.render_with(&request, render, &mut |_, _| Ok(())).expect("completed");
        request.renderer_generation = 3;
        assert!(service.render_with(&request, |scene| {
            state.graph_new.cancel_request("session", "abort", request.renderer_generation).expect("cancel"); render(scene)
        }, &mut |_, _| panic!("aborted frame must not publish")).is_err());
        request.renderer_generation = 4;
        let reused = service.render_with(&request, render, &mut |_, _| Ok(())).expect("completed key survives");
        assert_eq!(reused.source_projection_query_count, 0);
    }

    #[test]
    fn graph_new_cache_corruption_after_restore_never_scans_on_camera() {
        use std::io::{Seek, SeekFrom, Write};
        let directory = tempfile::tempdir().expect("directory");
        let state = AppState::new().expect("state");
        state.set_graph_cache_directory(&directory.path().canonicalize().expect("canonical")).expect("cache");
        let (x_column_id, y_column_id) = seed_dataset(&state, "corrupt-live");
        let mut request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"live", "sessionId":"session", "datasetId":"corrupt-live", "datasetGeneration":0,
            "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320, "height":200,
            "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        let render = |scene: &super::GraphNewScene| Ok(super::SyntheticFrame {
            rgba: vec![255; scene.width as usize * scene.height as usize * 4],
            padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0,
        });
        let service = GraphNewService::new(&state);
        let initial = service.render_with(&request, render, &mut |_, _| Ok(())).expect("cold");
        let key = super::GraphKey::canonical(&super::GraphKeyParts {
            dataset_id: request.dataset_id.clone(), dataset_generation: 0, x_column_id, y_column_id,
            overlay_column_id: None,
            filter_identity: None,
            renderer_contract_version: super::GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: super::GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: super::GRAPH_NEW_DEFAULT_DOMAIN_POLICY.into(), levels: 8, max_tile_points: 4096,
        }).expect("key");
        {
            let mut cache = state.graph_new.cache.lock().expect("cache");
            cache.remove(&key.hash_hex);
            assert!(cache.restore(&key).expect("restored but not decoded"));
        }
        let namespace = std::fs::read_dir(directory.path().join("graph-new-derived-v1")).expect("root")
            .next().expect("namespace").expect("entry").path();
        let path = namespace.join(format!("{}.gnd", key.hash_hex));
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).expect("owned file");
        file.seek(SeekFrom::End(-33)).expect("last tile checksum"); file.write_all(&[0x55]).expect("corrupt");
        request.renderer_generation = 2; request.camera_domain = Some(initial.camera_domain);
        let error = service.render_with(&request, |_| panic!("invalid tile must not render"), &mut |_, _| Ok(())).expect_err("camera miss");
        assert!(error.to_string().contains("graph_new_missing_cache"));
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
        assert!(!path.exists());
        request.renderer_generation = 3; request.camera_domain = None;
        let rebuilt = service.render_with(&request, render, &mut |_, _| Ok(())).expect("explicit rebuild");
        assert_eq!(rebuilt.source_projection_query_count, 1);
    }

    #[test]
    fn graph_new_camera_reuses_cache_and_never_builds_on_miss() {
        use crate::models::graph_new::GraphNewRenderRequest;
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "camera-fixture", 10_000);
        let service = GraphNewService::new(&state);
        let mut value = serde_json::json!({"requestId":"camera-1", "sessionId":"camera-session",
            "datasetId":"camera-fixture", "datasetGeneration":0, "xColumnId":x_column_id,
            "yColumnId":y_column_id, "width":320, "height":200, "devicePixelRatio":1.25,
            "rendererGeneration":1, "cameraGeneration":1,
            "cameraDomain":{"xMin":0.2,"xMax":0.4,"yMin":0.2,"yMax":0.4}});
        let request: GraphNewRenderRequest = serde_json::from_value(value.clone()).expect("camera contract");
        let error = service.render_with(&request, |_| panic!("missing cache must not render"),
            &mut |_, _| panic!("missing cache must not send")).expect_err("cache miss");
        assert!(error.to_string().contains("graph_new_missing_cache"));
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
        value["rendererGeneration"] = 2.into(); value["cameraDomain"] = serde_json::Value::Null;
        let render = |scene: &super::GraphNewScene| {
            let (width, height) = scene.physical_size()?;
            Ok(super::SyntheticFrame { rgba: vec![255; width as usize * height as usize * 4],
                padded_bytes_per_row: width * 4, render_ms: 0.0, readback_ms: 0.0 })
        };
        let initial = service.render_with(&serde_json::from_value(value.clone()).expect("initial"), render, &mut |_, _| Ok(())).expect("build");
        let initial = serde_json::to_value(initial).expect("completion");
        assert_eq!(initial["sourceProjectionQueryCount"], 1);
        assert_eq!(initial["plotRect"], serde_json::json!({"x":80,"y":20,"width":300,"height":190}));
        value["rendererGeneration"] = 3.into();
        value["cameraDomain"] = serde_json::json!({"xMin":2000.0,"xMax":4000.0,"yMin":2000.0,"yMax":4000.0});
        let camera: GraphNewRenderRequest = serde_json::from_value(value.clone()).expect("camera");
        let completion = service.render_with(&camera, |scene| {
            assert_eq!(scene.domain.x_min, 2000.0);
            assert_eq!(scene.domain.y_max, 4000.0);
            assert_eq!(scene.points.len(), 10_000);
            render(scene)
        }, &mut |_, _| Ok(())).expect("cached camera");
        let completion = serde_json::to_value(completion).expect("completion");
        assert_eq!(completion["sourceProjectionQueryCount"], 0);
        assert_eq!(completion["renderGenerationCheckCount"], 4);
        assert_eq!(completion["buildMs"], 0.0);
        assert_eq!(completion["cameraDomain"], value["cameraDomain"]);
        value["rendererGeneration"] = 4.into();
        let cancelling: GraphNewRenderRequest = serde_json::from_value(value.clone()).expect("cancel");
        let error = service.render_with(&cancelling, |scene| {
            state.graph_new.cancel_request_with_cache(&cancelling.session_id, &cancelling.request_id,
                cancelling.renderer_generation, true).expect("gesture cancel");
            render(scene)
        }, &mut |_, _| panic!("cancelled camera must not send")).expect_err("cancelled");
        assert!(error.to_string().contains("graph_new_cancelled"));
        assert!(state.graph_new.cache.lock().expect("cache").is_some());
        value["rendererGeneration"] = 5.into();
        let recovered = service.render_with(&serde_json::from_value(value.clone()).expect("recover"), render,
            &mut |_, _| Ok(())).expect("reuse after cancellation");
        assert_eq!(recovered.source_projection_query_count, 0);
        value["rendererGeneration"] = 6.into();
        let mut too_far = value.clone();
        too_far["cameraDomain"] = serde_json::json!({"xMin":1e100,"xMax":2e100,"yMin":1e100,"yMax":2e100});
        let invalid = service.render_with(&serde_json::from_value(too_far).expect("limit"),
            |_| panic!("out-of-limit camera must not render"), &mut |_, _| Ok(()));
        assert!(invalid.is_err());
        state.db.lock().expect("db").conn().execute(
            "UPDATE _meta_datasets SET generation = 1 WHERE id = $1", params!["camera-fixture"]).expect("mutate");
        value["rendererGeneration"] = 7.into();
        let error = service.render_with(&serde_json::from_value(value).expect("stale"), |_| panic!("stale camera must not render"),
            &mut |_, _| panic!("stale camera must not send")).expect_err("stale");
        assert!(error.to_string().contains("graph_new_stale_dataset"));
    }

    #[test]
    fn graph_new_camera_late_preserve_cannot_override_unmount_release() {
        let runtime = super::GraphNewRuntime::default();
        let request: crate::models::graph_new::GraphNewRenderRequest = serde_json::from_value(serde_json::json!({
            "requestId":"camera", "sessionId":"camera-session", "datasetId":"dataset", "datasetGeneration":0,
            "xColumnId":"x", "yColumnId":"y", "width":320, "height":200, "devicePixelRatio":1,
            "rendererGeneration":1, "cameraGeneration":0
        })).expect("request");
        runtime.begin(&request).expect("begin");
        runtime.cancel_request_with_cache("camera-session", "camera", 1, true).expect("gesture");
        assert!(runtime.owner.lock().expect("owner").preserve_cache);
        runtime.cancel_request("camera-session", "camera", 1).expect("unmount");
        runtime.cancel_request_with_cache("camera-session", "camera", 1, true).expect("late gesture");
        assert!(!runtime.owner.lock().expect("owner").preserve_cache, "release must be terminal within a generation");
    }

    #[test]
    fn graph_new_render_ownership_fences_switch_cancel_close_and_old_requests() {
        let runtime = super::GraphNewRuntime::default();
        let make = |session: &str, generation: u64| crate::models::graph_new::GraphNewRenderRequest {
            request_id: format!("request-{generation}"), session_id: session.into(),
            dataset_id: "dataset".into(), dataset_generation: 0,
            x_column_id: "x".into(), y_column_id: "y".into(),
            width: 320, height: 200, device_pixel_ratio: 2.0,
            renderer_generation: generation, camera_generation: 0, camera_domain: None, show_mean: false,
            x_mode: Default::default(),
            raw_mode: Default::default(),
            overlay_column_id: None,
            hidden_overlay_group_ids: vec![],
        };
        let first = make("first", 1);
        let second = make("second", 2);
        runtime.begin(&first).expect("first");
        assert!(runtime.is_current(&first));
        runtime.begin(&second).expect("switch");
        assert!(!runtime.is_current(&first));
        runtime.cancel("first", Some(&first.request_id)).expect("late cancel");
        runtime.close("first").expect("late close");
        assert!(runtime.is_current(&second));
        runtime.cancel("second", Some(&second.request_id)).expect("cancel");
        assert!(!runtime.is_current(&second));
        assert!(runtime.begin(&first).is_err());
        runtime.begin(&make("second", 3)).expect("resize");
        runtime.close("second").expect("close");
        assert!(runtime.begin(&make("second", 4)).is_err());
        runtime.begin(&make("third", 5)).expect("new session");
        runtime.cancel_request("fourth", "request-6", 6).expect("cancel before admission");
        assert!(runtime.begin(&make("fourth", 6)).is_err());
        runtime.close_session("fifth", 8).expect("close before admission");
        assert!(runtime.begin(&make("fifth", 7)).is_err());
        runtime.begin(&make("sixth", 9)).expect("next session");
        runtime.close_session("third", 5).expect("late old close");
        assert!(runtime.is_current(&make("sixth", 9)));
    }

    #[test]
    fn graph_new_render_contract_bounds_and_defaults() {
        use crate::models::graph_new::GraphNewRenderRequest;
        let value = serde_json::json!({"requestId":"r", "sessionId":"s", "datasetId":"d",
            "datasetGeneration":0, "xColumnId":"x", "yColumnId":"y", "width":320,
            "height":200, "devicePixelRatio":2, "rendererGeneration":1, "cameraGeneration":0});
        let request: GraphNewRenderRequest = serde_json::from_value(value.clone()).expect("serde");
        request.validate().expect("valid");
        let build = request.build_request();
        assert_eq!((build.levels, build.max_tile_points, build.batch_rows), (8, 4096, 16384));
        assert_eq!(build.construction_memory_limit_bytes, 512 * 1024 * 1024);
        for (field, invalid) in [("width", serde_json::json!(95)), ("height", serde_json::json!(63)),
            ("devicePixelRatio", serde_json::json!(9)), ("rendererGeneration", serde_json::json!(9007199254740992u64)),
            ("requestId", serde_json::json!(" ")), ("width", serde_json::json!(3840))] {
            let mut bad = value.clone(); bad[field] = invalid;
            assert!(serde_json::from_value::<GraphNewRenderRequest>(bad).map_or(true, |request| request.validate().is_err()), "{field}");
        }
    }

    #[test]
    fn graph_new_mean_service_toggle_camera_and_binding_reuse_exact_cache() {
        let state = AppState::new().unwrap();
        let (x_column_id, y_column_id) = seed_dataset(&state, "mean-fixture");
        let service = GraphNewService::new(&state);
        let mut value = serde_json::json!({"requestId":"mean-1", "sessionId":"mean-session", "datasetId":"mean-fixture",
            "datasetGeneration":0, "xColumnId":x_column_id, "yColumnId":y_column_id, "width":320,
            "height":200, "devicePixelRatio":1, "rendererGeneration":1, "cameraGeneration":0, "showMean":true});
        let mut captured = None;
        let mut first_domain = None;
        for (generation, enabled) in [(1, true), (2, false), (3, true)] {
            value["rendererGeneration"] = generation.into();
            value["requestId"] = format!("mean-{generation}").into();
            value["showMean"] = enabled.into();
            if generation > 1 { value["cameraDomain"] = serde_json::to_value(first_domain).unwrap(); }
            let request = serde_json::from_value(value.clone()).expect("mean request must cross the real IPC contract");
            let completion = service.render_with(&request, |scene| {
                if enabled {
                    let mean = scene.mean.as_ref().expect("full mean passed to renderer");
                    if let Some(previous) = &captured { assert!(std::sync::Arc::ptr_eq(previous, mean)); }
                    else { captured = Some(mean.clone()); }
                } else { assert!(scene.mean.is_none()); }
                Ok(super::SyntheticFrame { rgba: vec![255; 320 * 200 * 4], padded_bytes_per_row: 1280, render_ms: 0.0, readback_ms: 0.0 })
            }, &mut |_, _| Ok(())).unwrap();
            first_domain = Some(completion.camera_domain);
            assert_eq!(completion.source_projection_query_count, u64::from(generation == 1));
            let completion_json = serde_json::to_value(completion).unwrap();
            assert_eq!(completion_json["meanAvailable"], true);
            assert_eq!(completion_json["meanVisible"], enabled);
            if enabled { assert_eq!(completion_json["meanGroups"], 3); }
        }
        value["rendererGeneration"] = 4.into(); value["requestId"] = "mean-swapped".into();
        value["cameraDomain"] = serde_json::Value::Null;
        value["xColumnId"] = y_column_id.into(); value["yColumnId"] = x_column_id.into();
        let swapped = service.render_with(&serde_json::from_value(value).unwrap(), |scene| {
            assert!(!std::sync::Arc::ptr_eq(captured.as_ref().unwrap(), scene.mean.as_ref().unwrap()));
            Ok(super::SyntheticFrame { rgba: vec![255; 320 * 200 * 4], padded_bytes_per_row: 1280, render_ms: 0.0, readback_ms: 0.0 })
        }, &mut |_, _| Ok(())).unwrap();
        assert_eq!(swapped.source_projection_query_count, 1);
    }

    #[test]
    fn graph_new_render_binary_cache_and_pre_send_fences() {
        use crate::models::graph_new::GraphNewRenderRequest;
        use super::super::graph_new_transport_service::SyntheticFrame;
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "render-fixture");
        let service = GraphNewService::new(&state);
        let mut request = GraphNewRenderRequest { request_id: "r1".into(), session_id: "s1".into(),
            x_mode: Default::default(),
            raw_mode: Default::default(),
            dataset_id: "render-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None, show_mean: false,
            overlay_column_id: None, hidden_overlay_group_ids: vec![] };
        let render = |scene: &super::super::graph_new_renderer::GraphNewScene| {
            assert!(state.db.try_lock().is_ok(), "render must not hold DB lock");
            assert_eq!(scene.points.len(), 3);
            Ok(SyntheticFrame { rgba: vec![255; scene.width as usize * scene.height as usize * 4], padded_bytes_per_row: scene.width * 4, render_ms: 1.0, readback_ms: 2.0 })
        };
        let mut sends = 0;
        let first = service.render_with(&request, render, &mut |header, rgba| {
            sends += 1;
            assert_eq!(header.request_id, "r1");
            assert_eq!(header.byte_length as usize, rgba.len());
            Ok(())
        }).expect("render");
        assert_eq!((first.processed_rows, first.finite_rows, first.excluded_non_finite_rows), (4, 3, 1));
        assert_eq!(sends, 1);
        request.request_id = "r2".into(); request.renderer_generation = 2; request.width = 400;
        let resized = service.render_with(&request, render, &mut |_, _| Ok(())).expect("resize");
        assert_eq!(resized.build_ms, 0.0, "resize must reuse exact-key cache");
        request.request_id = "r3".into(); request.renderer_generation = 3;
        let stale = service.render_with(&request, |scene| {
            state.db.lock().expect("db").conn().execute(
                "UPDATE _meta_datasets SET generation = 1 WHERE id = $1", params!["render-fixture"]).expect("mutate");
            render(scene)
        }, &mut |_, _| panic!("stale frame must not send"));
        assert!(stale.is_err());
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
        request.dataset_generation = 1; request.request_id = "r4".into(); request.renderer_generation = 4;
        assert!(service.render_with(&request, |scene| {
            state.graph_new.close("s1").expect("close"); render(scene)
        }, &mut |_, _| panic!("closed frame must not send")).is_err());
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
    }

    #[test]
    fn graph_new_render_error_cleanup_and_safe_recovery() {
        use crate::models::graph_new::GraphNewRenderRequest;
        use crate::error::AppError;
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "error-fixture");
        let service = GraphNewService::new(&state);
        let mut request = GraphNewRenderRequest { request_id: "error-1".into(), session_id: "error-session".into(),
            x_mode: Default::default(),
            raw_mode: Default::default(),
            dataset_id: "error-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None, show_mean: false,
            overlay_column_id: None, hidden_overlay_group_ids: vec![] };
        let error = service.render_with(&request, |_| Err(AppError::FileIO("/private/secret.db".into())),
            &mut |_, _| panic!("failed rendering must not send")).expect_err("failure");
        assert_eq!(serde_json::to_value(error).expect("error json"), "Stats error: graph_new_render_failed");
        assert!(!state.graph_new.is_current(&request));
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
        request.renderer_generation = 2; request.request_id = "error-2".into();
        let error = service.render_with(&request, super::GraphNewRenderer::render,
            &mut |header, pixels| {
                assert_eq!(pixels.len(), header.byte_length as usize);
                assert!(pixels.chunks_exact(4).any(|pixel| pixel[2] > 180 && pixel[0] < 100), "real renderer draws points");
                Err(AppError::Stats("graph_new_channel_closed".into()))
            }).expect_err("closed channel");
        assert_eq!(serde_json::to_value(error).expect("error json"), "Stats error: graph_new_channel_closed");
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
        request.renderer_generation = 3; request.request_id = "error-3".into();
        service.render_with(&request, super::GraphNewRenderer::render, &mut |_, _| Ok(())).expect("recovered");
        state.graph_new.cancel_request(&request.session_id, &request.request_id, 3).expect("view unmount");
        assert!(state.graph_new.cache.lock().expect("cache").is_some(), "unmount retains completed reusable cache");
        assert!(state.graph_new.begin(&request).is_err(), "cancelled generation remains stale");
        request.renderer_generation = 4; request.request_id = "error-4".into();
        service.render_with(&request, super::GraphNewRenderer::render, &mut |_, _| Ok(())).expect("same session remount");
        state.graph_new.cancel_request(&request.session_id, "error-3", 3).expect("late cancel");
        assert!(state.graph_new.cache.lock().expect("cache").is_some(), "late cancel preserves newer cache");
        state.graph_new.close(&request.session_id).expect("close");
        assert!(state.graph_new.cache.lock().expect("cache").is_some(), "close unpins without discarding completed geometry");
        state.graph_new.cancel_request(&request.session_id, "error-5", 5).expect("cancel after close");
        request.renderer_generation = 6; request.request_id = "error-6".into();
        assert!(state.graph_new.begin(&request).is_err(), "cancel cannot reopen a closed session");
    }

    #[test]
    fn graph_new_render_bounds_concurrent_work_and_cancels_superseded_owner() {
        use crate::models::graph_new::GraphNewRenderRequest;
        use crate::error::AppError;
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "concurrent-fixture");
        let request = GraphNewRenderRequest { request_id: "first".into(), session_id: "session".into(),
            x_mode: Default::default(),
            raw_mode: Default::default(),
            dataset_id: "concurrent-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None, show_mean: false,
            overlay_column_id: None, hidden_overlay_group_ids: vec![] };
        let (ready_send, ready_receive) = std::sync::mpsc::channel();
        let (release_send, release_receive) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let state_ref = &state;
            let request_ref = &request;
            let worker = scope.spawn(move || GraphNewService::new(state_ref).render_with(request_ref, |scene| {
                ready_send.send(()).expect("ready");
                release_receive.recv_timeout(std::time::Duration::from_secs(5)).expect("release");
                Ok(super::SyntheticFrame { rgba: vec![255; scene.width as usize * scene.height as usize * 4],
                    padded_bytes_per_row: scene.width * 4, render_ms: 0.0, readback_ms: 0.0 })
            }, &mut |_, _| panic!("superseded frame must not send")));
            ready_receive.recv_timeout(std::time::Duration::from_secs(5)).expect("render ready");
            let mut next = request.clone(); next.request_id = "second".into(); next.renderer_generation = 2;
            let error = GraphNewService::new(&state).render_with(&next, |_| panic!("second renderer must not start"),
                &mut |_, _| panic!("second frame must not send")).expect_err("bounded work");
            assert!(matches!(error, AppError::Busy(_)));
            assert!(!state.graph_new.is_current(&request));
            release_send.send(()).expect("release");
            assert!(matches!(worker.join().expect("join"), Err(AppError::Cancelled(_))));
        });
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
    }

    fn seed_dataset(state: &AppState, dataset_id: &str) -> (String, String) {
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            dataset_id,
            "Graph New Fixture",
            &["x_value".into(), "y_value".into(), "label".into()],
            &["DOUBLE".into(), "DOUBLE".into(), "VARCHAR".into()],
        )
        .expect("create table");

        let mut statement = db
            .conn()
            .prepare(
                "SELECT column_id, col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )
            .expect("prepare column query");
        let columns = statement
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");
        let x_column_id = columns[0].0.clone();
        let y_column_id = columns[1].0.clone();

        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        db.conn()
            .execute(
                &format!(
                    "INSERT INTO \"{table_name}\" (_row_id, x_value, y_value, label) VALUES (1, 0.0, 1.0, 'a'), (2, 2.0, 3.0, 'b'), (3, 4.0, NULL, 'c'), (4, 6.0, 7.0, 'd')"
                ),
                [],
            )
            .expect("insert rows");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 4 WHERE id = $1",
                params![dataset_id],
            )
            .expect("update row count");
        drop(db);

        (x_column_id, y_column_id)
    }

    fn seed_overlay_dataset(
        state: &AppState,
        dataset_id: &str,
        rows: &[(i64, f64, f64, Option<&str>)],
    ) -> (String, String, String) {
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            dataset_id,
            "Graph New Overlay Fixture",
            &["x_value".into(), "y_value".into(), "lot".into()],
            &["DOUBLE".into(), "DOUBLE".into(), "VARCHAR".into()],
        )
        .expect("create table");

        let mut statement = db
            .conn()
            .prepare(
                "SELECT column_id FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )
            .expect("prepare column query");
        let columns = statement
            .query_map(params![dataset_id], |row| row.get::<_, String>(0))
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");

        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let mut insert = db
            .conn()
            .prepare(&format!(
                "INSERT INTO \"{table_name}\" (_row_id, x_value, y_value, lot) VALUES ($1, $2, $3, $4)"
            ))
            .expect("prepare insert");
        for (row_id, x, y, lot) in rows {
            insert
                .execute(params![row_id, x, y, lot])
                .expect("insert row");
        }
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $2 WHERE id = $1",
                params![dataset_id, rows.len() as u64],
            )
            .expect("update row count");
        drop(insert);
        drop(statement);
        drop(db);

        (columns[0].clone(), columns[1].clone(), columns[2].clone())
    }

    fn seed_dense_dataset(state: &AppState, dataset_id: &str, rows: u64) -> (String, String) {
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            dataset_id,
            "Graph New Dense Fixture",
            &["x_value".into(), "y_value".into(), "label".into()],
            &["DOUBLE".into(), "DOUBLE".into(), "VARCHAR".into()],
        )
        .expect("create table");

        let mut statement = db
            .conn()
            .prepare(
                "SELECT column_id FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )
            .expect("prepare column query");
        let columns = statement
            .query_map(params![dataset_id], |row| row.get::<_, String>(0))
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");

        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        db.conn()
            .execute(
                &format!(
                    "INSERT INTO \"{table_name}\" (_row_id, x_value, y_value, label) SELECT i, CAST(i AS DOUBLE), CAST(i AS DOUBLE), 'dense' FROM range(1, {}) tbl(i)",
                    rows + 1
                ),
                [],
            )
            .expect("insert dense rows");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $2 WHERE id = $1",
                params![dataset_id, rows],
            )
            .expect("update row count");
        drop(statement);
        drop(db);

        (columns[0].clone(), columns[1].clone())
    }

    #[test]
    fn build_rejects_scan_capacity_above_memory_budget() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "graph-scan-cap", 1);
        let request = crate::models::graph_new_data::GraphNewBuildRequest {
            request_id: "scan-cap".into(),
            dataset_id: "graph-scan-cap".into(),
            dataset_generation: 0,
            x_column_id,
            y_column_id,
            overlay_column_id: None,
            batch_rows: 1_000_000,
            levels: 1,
            max_tile_points: 5,
            overdraw_factor: 1.5,
            construction_memory_limit_bytes: 4 * 1024 * 1024,
        };
        let result = GraphNewService::new(&state).build(&request, &mut |_| {});
        assert!(matches!(result, Err(crate::error::AppError::Busy(_))));
    }

    #[test]
    fn graph_new_scan_counts_source_rows_not_metadata_and_excludes_nonfinite_pairs() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "scan-counts");
        {
            let db = state.db.lock().expect("db");
            db.conn().execute("INSERT INTO dataset_scan_counts (_row_id, x_value, y_value) VALUES (5, $1, 1), (6, 1, $2), (7, $3, 1)",
                params![f64::NAN, f64::INFINITY, f64::NEG_INFINITY]).expect("nonfinite rows");
        }
        for metadata_rows in [1u64, 1000] {
            state.db.lock().expect("db").conn().execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2", params![metadata_rows, "scan-counts"]
            ).expect("stale metadata fixture");
            let result = GraphNewService::new(&state).build_for_test(
                "scan", "scan-counts", 0, &x_column_id, &y_column_id, 2, 4, 4,
                &mut |_| {}, &|| true,
            ).expect("scan actual source");
            assert_eq!((result.summary.processed_rows, result.summary.finite_rows, result.summary.excluded_non_finite_rows), (7, 3, 4));
            assert_eq!(result.query_count, 1);
            assert_eq!(result.pyramid.total_finite_rows, 3);
        }
    }

    #[test]
    fn build_streams_full_source_projection_and_reports_progress() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "graph-fixture");
        let service = GraphNewService::new(&state);
        let mut progress = Vec::<GraphBuildProgress>::new();

        let result = service
            .build_for_test(
                "graph-request",
                "graph-fixture",
                0,
                &x_column_id,
                &y_column_id,
                2,
                4,
                4,
                &mut |update| progress.push(update.clone()),
                &|| true,
            )
            .expect("build result");

        assert_eq!(result.processed_rows, 4);
        assert_eq!(result.excluded_non_finite_rows, 1);
        assert_eq!(result.query_count, 1);
        assert!(!progress.is_empty());
        assert_eq!(result.pyramid.total_finite_rows, 3);
        assert_eq!(result.summary.levels.last().map(|level| level.total_source_count), Some(3));
    }

    #[test]
    fn build_cancels_between_batches_and_rejects_stale_generation() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "graph-fixture");
        let service = GraphNewService::new(&state);

        let cancelled = AtomicBool::new(true);
        let error = service
            .build_for_test(
                "graph-request",
                "graph-fixture",
                0,
                &x_column_id,
                &y_column_id,
                1,
                4,
                4,
                &mut |_| {},
                &|| !cancelled.load(Ordering::Relaxed),
            )
            .expect_err("cancelled build must fail");
        assert!(error.to_string().contains("Cancelled"));

        let db = state.db.lock().expect("db lock");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET generation = 2 WHERE id = $1",
                params!["graph-fixture"],
            )
            .expect("update generation");
        drop(db);

        let stale = service
            .build_for_test(
                "graph-request",
                "graph-fixture",
                0,
                &x_column_id,
                &y_column_id,
                2,
                4,
                4,
                &mut |_| {},
                &|| true,
            )
            .expect_err("stale build must fail");
        assert!(stale.to_string().contains("stale"));
    }

    #[test]
    fn build_allows_same_axis_binding_for_numeric_columns() {
        let state = AppState::new().expect("state");
        let (x_column_id, _) = seed_dataset(&state, "graph-same-axis");
        let service = GraphNewService::new(&state);

        let result = service.build_for_test(
            "graph-request",
            "graph-same-axis",
            0,
            &x_column_id,
            &x_column_id,
            2,
            4,
            4,
            &mut |_| {},
            &|| true,
        );

        assert!(result.is_ok(), "same-axis bindings should build successfully");
    }

    #[test]
    fn progress_callbacks_run_without_holding_the_global_db_mutex() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "graph-progress-lock");
        let service = GraphNewService::new(&state);
        let callback_try_lock_ok = AtomicBool::new(false);

        let result = service.build_for_test(
            "graph-request",
            "graph-progress-lock",
            0,
            &x_column_id,
            &y_column_id,
            2,
            4,
            4,
            &mut |update| {
                if update.processed_rows > 0 {
                    callback_try_lock_ok.store(state.db.try_lock().is_ok(), Ordering::Relaxed);
                }
            },
            &|| true,
        );

        result.expect("build result");
        assert!(
            callback_try_lock_ok.load(Ordering::Relaxed),
            "progress callback must be able to reacquire the DB mutex"
        );
    }

    #[test]
    fn build_rechecks_dataset_generation_after_progress_callbacks() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "graph-generation-check");
        let service = GraphNewService::new(&state);
        let mutations = AtomicUsize::new(0);

        let error = service
            .build_for_test(
                "graph-request",
                "graph-generation-check",
                0,
                &x_column_id,
                &y_column_id,
                2,
                4,
                4,
                &mut |update| {
                    if update.processed_rows > 0 && mutations.fetch_add(1, Ordering::Relaxed) == 0 {
                        let db = state.db.lock().expect("db lock");
                        db.conn()
                            .execute(
                                "UPDATE _meta_datasets SET generation = generation + 1 WHERE id = $1",
                                params!["graph-generation-check"],
                            )
                            .expect("update generation");
                    }
                },
                &|| true,
            )
            .expect_err("build must fail when dataset generation changes during progress");

        assert!(error.to_string().contains("generation"));
    }

    #[test]
    fn build_batches_current_checks_instead_of_rechecking_every_projected_row() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dense_dataset(&state, "graph-batched-current", 8_192);
        let service = GraphNewService::new(&state);
        let current_checks = AtomicUsize::new(0);

        let result = service.build_for_test(
            "graph-request",
            "graph-batched-current",
            0,
            &x_column_id,
            &y_column_id,
            512,
            64,
            4,
            &mut |_| {},
            &|| {
                current_checks.fetch_add(1, Ordering::Relaxed);
                true
            },
        );

        result.expect("build result");
        assert!(
            current_checks.load(Ordering::Relaxed) <= 256,
            "current checks should stay batched, got {}",
            current_checks.load(Ordering::Relaxed)
        );
    }

    #[test]
    fn build_supports_decimal_hugeint_and_quoted_numeric_columns() {
        let state = AppState::new().expect("state");
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            "graph-quoted-types",
            "Graph Quoted Types",
            &["value \"quoted\"".into(), "huge metric".into()],
            &["DECIMAL(18,4)".into(), "HUGEINT".into()],
        )
        .expect("create table");
        let mut statement = db
            .conn()
            .prepare(
                "SELECT column_id FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )
            .expect("prepare column query");
        let columns = statement
            .query_map(params!["graph-quoted-types"], |row| row.get::<_, String>(0))
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns");
        db.conn()
            .execute(
                "INSERT INTO \"dataset_graph_quoted_types\" (_row_id, \"value \"\"quoted\"\"\", \"huge metric\") VALUES (1, 12.5000, 1701411834604692317316873037158841057), (2, 13.7500, 42)",
                [],
            )
            .expect("insert quoted numeric rows");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 2 WHERE id = $1",
                params!["graph-quoted-types"],
            )
            .expect("update row count");
        drop(statement);
        drop(db);

        let service = GraphNewService::new(&state);
        let result = service.build_for_test(
            "graph-request",
            "graph-quoted-types",
            0,
            &columns[0],
            &columns[1],
            2,
            16,
            4,
            &mut |_| {},
            &|| true,
        );

        assert!(result.is_ok(), "quoted decimal/hugeint columns should build");
    }

    #[test]
    fn overlay_projection_builds_catalog_and_counts_rows_once() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id, lot_column_id) = seed_overlay_dataset(
            &state,
            "overlay-projection",
            &[
                (1, 1.0, 5.0, Some("A")),
                (2, 2.0, 6.0, None),
                (3, 3.0, 7.0, Some("(Missing)")),
                (4, 4.0, 8.0, Some("A")),
            ],
        );
        let request = crate::models::graph_new_data::GraphNewBuildRequest {
            request_id: "overlay-projection".into(),
            dataset_id: "overlay-projection".into(),
            dataset_generation: 0,
            x_column_id,
            y_column_id,
            overlay_column_id: Some(lot_column_id.clone()),
            max_tile_points: 64,
            levels: 4,
            batch_rows: 2,
            overdraw_factor: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes:
                crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        };

        let result = GraphNewService::new(&state)
            .build(&request, &mut |_| {})
            .expect("build result");

        assert_eq!(result.query_count, 1);
        assert_eq!(result.pyramid.overlay.groups.len(), 3);
        assert_eq!(
            result
                .pyramid
                .overlay
                .groups
                .iter()
                .map(|group| group.total_rows)
                .sum::<u64>(),
            4,
        );
        assert_ne!(
            result
                .pyramid
                .overlay
                .groups
                .iter()
                .find(|group| group.missing)
                .expect("missing group")
                .id,
            result
                .pyramid
                .overlay
                .groups
                .iter()
                .find(|group| group.label == "(Missing)" && !group.missing)
                .expect("literal missing group")
                .id,
        );
    }

    #[test]
    fn overlay_projection_sql_guards_oversized_labels_before_decode() {
        let column = super::ColumnBinding {
            column_id: "overlay".into(),
            name: "lot".into(),
            sql_type: "VARCHAR".into(),
        };

        let (missing, too_large, label) = super::overlay_projection_sql(Some(&column));

        assert!(missing.contains("\"lot\" IS NULL"));
        assert!(too_large.contains("octet_length(encode(TRY_CAST(\"lot\" AS VARCHAR))) > 512"));
        assert!(label.contains("<= 512"));
        assert!(label.contains("THEN TRY_CAST(\"lot\" AS VARCHAR)"));
        assert!(label.contains("ELSE NULL"));
    }

    #[test]
    fn overlay_projection_rejects_sixty_fifth_group_without_completed_cache_admission() {
        let state = AppState::new().expect("state");
        let rows = (1..=65)
            .map(|row| {
                (
                    i64::from(row),
                    f64::from(row),
                    f64::from(row),
                    Some(format!("group-{row}")),
                )
            })
            .collect::<Vec<_>>();
        let prepared = rows
            .iter()
            .map(|(row_id, x, y, label)| (*row_id, *x, *y, label.as_deref()))
            .collect::<Vec<_>>();
        let (x_column_id, y_column_id, lot_column_id) =
            seed_overlay_dataset(&state, "overlay-too-many-groups", &prepared);
        let request = crate::models::graph_new_data::GraphNewBuildRequest {
            request_id: "overlay-too-many-groups".into(),
            dataset_id: "overlay-too-many-groups".into(),
            dataset_generation: 0,
            x_column_id,
            y_column_id,
            overlay_column_id: Some(lot_column_id),
            max_tile_points: 64,
            levels: 4,
            batch_rows: 16,
            overdraw_factor: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes:
                crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        };

        let error = GraphNewService::new(&state)
            .build(&request, &mut |_| {})
            .expect_err("sixty-fifth group must fail");

        assert!(matches!(
            error,
            crate::error::AppError::InvalidParam(message)
                if message == "graph_new_overlay_too_many_groups"
        ));
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
    }

    #[test]
    fn overlay_projection_rejects_oversized_label_without_completed_cache_admission() {
        let state = AppState::new().expect("state");
        let oversized = "x".repeat(1024 * 1024);
        let (x_column_id, y_column_id, lot_column_id) = seed_overlay_dataset(
            &state,
            "overlay-label-too-large",
            &[(1, 1.0, 1.0, Some(oversized.as_str()))],
        );
        let request = crate::models::graph_new_data::GraphNewBuildRequest {
            request_id: "overlay-label-too-large".into(),
            dataset_id: "overlay-label-too-large".into(),
            dataset_generation: 0,
            x_column_id,
            y_column_id,
            overlay_column_id: Some(lot_column_id),
            max_tile_points: 64,
            levels: 4,
            batch_rows: 16,
            overdraw_factor: crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
            construction_memory_limit_bytes:
                crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
        };

        let error = GraphNewService::new(&state)
            .build(&request, &mut |_| {})
            .expect_err("oversized label must fail");

        assert!(matches!(
            error,
            crate::error::AppError::InvalidParam(message)
                if message == "graph_new_overlay_value_too_large"
        ));
        assert!(state.graph_new.cache.lock().expect("cache").is_none());
    }

    #[test]
    fn overlay_visibility_reuses_cache_and_preserves_camera_domain() {
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id, lot_column_id) = seed_overlay_dataset(
            &state,
            "overlay-hidden-cache",
            &[
                (1, 1.0, 5.0, Some("A")),
                (2, 2.0, 6.0, None),
                (3, 3.0, 7.0, Some("(Missing)")),
                (4, 4.0, 8.0, Some("A")),
            ],
        );
        let built = GraphNewService::new(&state)
            .build(
                &crate::models::graph_new_data::GraphNewBuildRequest {
                    request_id: "overlay-hidden-build".into(),
                    dataset_id: "overlay-hidden-cache".into(),
                    dataset_generation: 0,
                    x_column_id: x_column_id.clone(),
                    y_column_id: y_column_id.clone(),
                    overlay_column_id: Some(lot_column_id.clone()),
                    max_tile_points: 64,
                    levels: 4,
                    batch_rows: 2,
                    overdraw_factor:
                        crate::models::graph_new_data::GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
                    construction_memory_limit_bytes:
                        crate::models::graph_new_data::GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
                },
                &mut |_| {},
            )
            .expect("overlay build");
        let hidden_id = built.pyramid.overlay.groups[0].id.clone();
        let expected_key = super::GraphKey::canonical(&super::GraphKeyParts {
            dataset_id: "overlay-hidden-cache".into(),
            dataset_generation: 0,
            x_column_id: x_column_id.clone(),
            y_column_id: y_column_id.clone(),
            overlay_column_id: Some(lot_column_id.clone()),
            filter_identity: None,
            renderer_contract_version: super::GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: super::GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: super::GRAPH_NEW_DEFAULT_DOMAIN_POLICY.into(),
            levels: 8,
            max_tile_points: 4096,
        })
        .expect("expected key");
        let service = GraphNewService::new(&state);
        let render = |scene: &super::GraphNewScene| {
            Ok(super::SyntheticFrame {
                rgba: vec![255; scene.width as usize * scene.height as usize * 4],
                padded_bytes_per_row: scene.width * 4,
                render_ms: 0.0,
                readback_ms: 0.0,
            })
        };
        let mut request: crate::models::graph_new::GraphNewRenderRequest =
            serde_json::from_value(serde_json::json!({
                "requestId":"overlay-hidden-1",
                "sessionId":"overlay-hidden-session",
                "datasetId":"overlay-hidden-cache",
                "datasetGeneration":0,
                "xColumnId":x_column_id,
                "yColumnId":y_column_id,
                "overlayColumnId":lot_column_id,
                "width":320,
                "height":200,
                "devicePixelRatio":1,
                "rendererGeneration":1,
                "cameraGeneration":0
            }))
            .expect("request");
        let baseline_key = super::GraphKey::canonical(&super::GraphKeyParts {
            dataset_id: request.dataset_id.clone(),
            dataset_generation: request.dataset_generation,
            x_column_id: request.x_column_id.clone(),
            y_column_id: request.y_column_id.clone(),
            overlay_column_id: request.overlay_column_id.clone(),
            filter_identity: None,
            renderer_contract_version: super::GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: super::GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: super::axis_policy(request.x_mode),
            levels: request.build_request().levels,
            max_tile_points: request.build_request().max_tile_points,
        })
        .expect("baseline key");
        let mut hidden_key_request = request.clone();
        hidden_key_request.hidden_overlay_group_ids = vec![hidden_id.clone()];
        let hidden_key = super::GraphKey::canonical(&super::GraphKeyParts {
            dataset_id: hidden_key_request.dataset_id.clone(),
            dataset_generation: hidden_key_request.dataset_generation,
            x_column_id: hidden_key_request.x_column_id.clone(),
            y_column_id: hidden_key_request.y_column_id.clone(),
            overlay_column_id: hidden_key_request.overlay_column_id.clone(),
            filter_identity: None,
            renderer_contract_version: super::GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: super::GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: super::axis_policy(hidden_key_request.x_mode),
            levels: hidden_key_request.build_request().levels,
            max_tile_points: hidden_key_request.build_request().max_tile_points,
        })
        .expect("hidden key");
        assert_eq!(baseline_key.canonical_id, hidden_key.canonical_id);
        assert_eq!(baseline_key.hash_hex, hidden_key.hash_hex);

        let cold = service
            .render_with(&request, render, &mut |_, _| Ok(()))
            .expect("cold render");
        assert_eq!(cold.source_projection_query_count, 1);
        assert!(
            state
                .graph_new
                .cache
                .lock()
                .expect("cache")
                .get(&expected_key.hash_hex)
                .is_some()
        );

        request.request_id = "overlay-hidden-2".into();
        request.renderer_generation = 2;
        request.camera_domain = Some(cold.camera_domain);
        let camera = service
            .render_with(&request, render, &mut |_, _| Ok(()))
            .expect("camera render");
        assert_eq!(camera.source_projection_query_count, 0);

        request.request_id = "overlay-hidden-3".into();
        request.renderer_generation = 3;
        request.hidden_overlay_group_ids = vec![hidden_id];
        let hidden = service
            .render_with(&request, render, &mut |_, _| Ok(()))
            .expect("hidden render");
        assert_eq!(hidden.source_projection_query_count, 0);
        assert_eq!(
            serde_json::to_value(cold.camera_domain).expect("cold domain"),
            serde_json::to_value(hidden.camera_domain).expect("hidden domain")
        );
        assert_eq!(cold.persistent_cache_bytes, hidden.persistent_cache_bytes);
        assert!(hidden.selected_marks < camera.selected_marks);
        assert!(
            state
                .graph_new
                .cache
                .lock()
                .expect("cache")
                .get(&expected_key.hash_hex)
                .is_some()
        );

        request.request_id = "overlay-hidden-4".into();
        request.renderer_generation = 4;
        request.hidden_overlay_group_ids.clear();
        let shown = service
            .render_with(&request, render, &mut |_, _| Ok(()))
            .expect("shown render");
        assert_eq!(shown.source_projection_query_count, 0);
        assert_eq!(
            serde_json::to_value(cold.camera_domain).expect("cold domain"),
            serde_json::to_value(shown.camera_domain).expect("shown domain")
        );
        assert_eq!(cold.persistent_cache_bytes, shown.persistent_cache_bytes);
        assert!(hidden.selected_marks < shown.selected_marks);
    }
}
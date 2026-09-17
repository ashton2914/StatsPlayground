use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use duckdb::params;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::graph_new_data::{
    GraphNewBuildProgress, GraphNewBuildRequest, GraphNewBuildStage, GraphNewBuildSummary,
    GraphNewLevelSummary, GRAPH_NEW_DEFAULT_DOMAIN_POLICY,
    GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES, GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
};
use crate::state::AppState;
use crate::models::graph_new::{GraphNewRenderRequest, GraphNewRenderCompletion, GraphNewFrameHeader, GraphNewFrameFormat};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::graph_new_key::{
    GraphKey, GraphKeyParts, GRAPH_NEW_RENDERER_CONTRACT_VERSION, GRAPH_NEW_TILE_FORMAT_VERSION,
};
use super::graph_new_lod::{GraphCamera, SourcePoint, TilePyramid, TilePyramidBuilder};
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
        self.render_with(request, GraphNewRenderer::render, &mut |header, rgba| {
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
                filter_identity: None, renderer_contract_version: GRAPH_NEW_RENDERER_CONTRACT_VERSION,
                tile_format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
                domain_policy: GRAPH_NEW_DEFAULT_DOMAIN_POLICY.into(), levels: build_request.levels,
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
                    let construction = cache.reserve_construction(build_request.construction_memory_limit_bytes)?;
                    let built = self.build_with_disk_limit(&build_request, &mut |_| {}, &is_current, cache.construction_disk_budget())?;
                    source_projection_query_count = built.query_count;
                    build_ms = started.elapsed().as_secs_f64() * 1000.0;
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
                for ((row_id, x), y) in selected.tile.row_ids.into_iter().zip(selected.tile.xs).zip(selected.tile.ys) {
                    points.push(SourcePoint::new(row_id, x, y));
                }
            }
            let scene = GraphNewScene { width: request.width, height: request.height,
                device_pixel_ratio: request.device_pixel_ratio, domain, points };
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
                exact_visible: selection.exact, visible_rows: selection.visible_rows,
                raw_index_entries_inspected: selection.query_work.index_entries_inspected,
                raw_blocks_inspected: selection.query_work.raw_blocks_inspected,
                raw_points_inspected: selection.query_work.raw_points_inspected,
                processed_rows: built.summary.processed_rows, finite_rows: built.summary.finite_rows,
                excluded_non_finite_rows: built.summary.excluded_non_finite_rows, selected_marks,
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
        let (construction, disk_limit) = {
            let mut cache = self.state.graph_new.cache.try_lock().map_err(|_| AppError::Busy("graph_new_busy".into()))?;
            (cache.reserve_construction(request.construction_memory_limit_bytes)?, cache.construction_disk_budget())
        };
        let result = self.build_with_disk_limit(request, progress_sink, is_current, disk_limit);
        drop(construction);
        result
    }

    fn build_with_disk_limit(
        &self, request: &GraphNewBuildRequest, progress_sink: &mut dyn FnMut(GraphBuildProgress),
        is_current: &dyn Fn() -> bool, disk_limit: u64,
    ) -> Result<GraphNewBuildResult, AppError> {
        request.validate()?;
        self.ensure_current(request, is_current, "before scan")?;

        let started = Instant::now();
        let (x_column, y_column, read_conn) = {
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
                db.open_secondary_connection()?,
            )
        };
        if !is_numeric_type(&x_column.sql_type) {
            return Err(AppError::InvalidParam(
                "graph-new xColumnId must resolve to a supported numeric column".to_string(),
            ));
        }
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
            filter_identity: None,
            renderer_contract_version: GRAPH_NEW_RENDERER_CONTRACT_VERSION,
            tile_format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
            domain_policy: GRAPH_NEW_DEFAULT_DOMAIN_POLICY.to_string(),
            levels: request.levels,
            max_tile_points: request.max_tile_points,
        })?;

        let sql = format!(
            "SELECT \"_row_id\", TRY_CAST({x_column} AS DOUBLE), TRY_CAST({y_column} AS DOUBLE) FROM {table_name}",
            x_column = quote_identifier(&x_column.name),
            y_column = quote_identifier(&y_column.name),
            table_name = quote_identifier(&internal_table_name(&request.dataset_id)),
        );
        let mut statement = read_conn.prepare(&sql)?;
        let mut rows = statement.query([])?;
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
            batch.push(SourcePoint::new(
                row_id,
                x.unwrap_or(f64::NAN),
                y.unwrap_or(f64::NAN),
            ));
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

        let pyramid = builder.finish_with_control(&|| {
            self.ensure_current(request, is_current, "during pyramid")
        })?;
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
                max_tile_points,
                levels,
                batch_rows,
                overdraw_factor: GRAPH_NEW_DEFAULT_OVERDRAW_FACTOR,
                construction_memory_limit_bytes:
                    GRAPH_NEW_DEFAULT_CONSTRUCTION_MEMORY_LIMIT_BYTES,
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
    fn graph_new_performance_first_completion_reports_unknown_camera_count_without_projection() {
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
        assert_eq!(metadata["exactVisible"], false);
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
            assert!(scene.points.is_empty(), "bounded representatives do not prove anomaly recovery");
            render(scene)
        }, &mut |_, _| Ok(())).expect("bounded camera");
        let metadata = serde_json::to_value(&zoomed).expect("metadata");
        assert_eq!(metadata["exactVisible"], false);
        assert!(metadata["visibleRows"].is_null(), "intersecting tile population is not an exact viewport count");
        assert_eq!(metadata["selectedMarks"], 0);
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
            filter_identity: None, renderer_contract_version: 1, tile_format_version: 1,
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
            assert!(!scene.points.is_empty() && scene.points.len() < 10_000);
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
            renderer_generation: generation, camera_generation: 0, camera_domain: None,
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
    fn graph_new_render_binary_cache_and_pre_send_fences() {
        use crate::models::graph_new::GraphNewRenderRequest;
        use super::super::graph_new_transport_service::SyntheticFrame;
        let state = AppState::new().expect("state");
        let (x_column_id, y_column_id) = seed_dataset(&state, "render-fixture");
        let service = GraphNewService::new(&state);
        let mut request = GraphNewRenderRequest { request_id: "r1".into(), session_id: "s1".into(),
            dataset_id: "render-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None };
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
            dataset_id: "error-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None };
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
            dataset_id: "concurrent-fixture".into(), dataset_generation: 0, x_column_id, y_column_id,
            width: 320, height: 200, device_pixel_ratio: 1.0, renderer_generation: 1, camera_generation: 0, camera_domain: None };
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
}
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::engine::duckdb_engine::ArchiveKeysetReadPlan;
use crate::error::AppError;
use crate::models::save::{
    SavePerfMetrics, SavePhase, SaveProgress, SaveProgressCallback, SaveSnapshot, SaveWriteResult,
};
use crate::models::table::ColumnDisplayProps;
use crate::services::archive_cell::{
    archive_cell_write_mode, write_archive_cell_with_mode, ArchiveCellWriteMode,
};
use crate::services::save_coordinator::SaveGuard;
use crate::services::spprj_archive::{
    self, GraphDoc, ProjectManifest, TableColumn, TableColumnFormat, TableDoc,
};
use crate::state::AppState;

const STREAM_VERSION: &str = "3.0.0";
const TABLE_DOC_VERSION: &str = "2";
const TARGET_BATCH_BYTES: usize = 6 * 1024 * 1024;
const HARD_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MIN_TARGET_BATCH_BYTES: usize = 4 * 1024 * 1024;
const TARGET_BATCH_SAFETY_MARGIN_BYTES: usize = 128 * 1024;
const ROW_LIMIT_PER_BATCH: usize = 4096;
const ENCODED_CHUNK_TARGET_BYTES: usize = 4 * 1024 * 1024;
const PROGRESS_MIN_INTERVAL_MS: u64 = 100;
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(PROGRESS_MIN_INTERVAL_MS);

#[cfg(test)]
macro_rules! run_save_test_hook {
    ($point:expr, $dataset_id:expr, $retained_batch_bytes:expr, $temp_archive_path:expr) => {
        run_test_hook(
            $point,
            SaveHookContext {
                dataset_id: $dataset_id,
                retained_batch_bytes: $retained_batch_bytes,
                temp_archive_path: $temp_archive_path,
            },
        )?
    };
}

#[cfg(not(test))]
macro_rules! run_save_test_hook {
    ($($tt:tt)*) => {};
}

enum ProgressCommand {
    Emit(SaveProgress),
    UpdateTable(SaveProgress),
}

struct ProgressDispatcher<'scope> {
    tx: Option<mpsc::Sender<ProgressCommand>>,
    handle: Option<thread::ScopedJoinHandle<'scope, ()>>,
}

impl<'scope> ProgressDispatcher<'scope> {
    fn new(
        scope: &'scope thread::Scope<'scope, '_>,
        progress_cb: Option<&'scope SaveProgressCallback<'scope>>,
    ) -> Self {
        let Some(callback) = progress_cb else {
            return Self {
                tx: None,
                handle: None,
            };
        };

        let (tx, rx) = mpsc::channel::<ProgressCommand>();
        let handle = scope.spawn(move || {
            let mut latest_progress: Option<SaveProgress> = None;
            let mut last_emit_at: Option<Instant> = None;

            loop {
                match rx.recv_timeout(HEARTBEAT_INTERVAL) {
                    Ok(ProgressCommand::Emit(progress)) => {
                        latest_progress = Some(progress.clone());
                        callback(progress);
                        last_emit_at = Some(Instant::now());
                    }
                    Ok(ProgressCommand::UpdateTable(progress)) => {
                        if let Some(previous) = latest_progress
                            .as_mut()
                            .filter(|previous| previous.phase == SavePhase::Table)
                        {
                            if progress.rows_done >= previous.rows_done {
                                previous.rows_done = progress.rows_done;
                            }
                            previous.rows_total = progress.rows_total;
                            previous.table_index = progress.table_index;
                            previous.table_total = progress.table_total;
                            previous.table_name = progress.table_name.clone();
                            previous.overall_progress = Some(
                                progress
                                    .overall_progress
                                    .unwrap_or(0.0)
                                    .max(previous.overall_progress.unwrap_or(0.0)),
                            );
                        } else {
                            latest_progress = Some(progress);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if let Some(progress) = latest_progress.clone() {
                    if last_emit_at
                        .map(|last| last.elapsed() >= HEARTBEAT_INTERVAL)
                        .unwrap_or(true)
                    {
                        callback(progress);
                        last_emit_at = Some(Instant::now());
                    }
                }
            }
        });

        Self {
            tx: Some(tx),
            handle: Some(handle),
        }
    }

    fn emit(&self, progress: SaveProgress) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(ProgressCommand::Emit(progress));
        }
    }

    fn update_table(&self, progress: SaveProgress) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(ProgressCommand::UpdateTable(progress));
        }
    }
}

impl Drop for ProgressDispatcher<'_> {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

trait ArchiveReplacer: Send + Sync {
    fn replace_archive(&self, temp_path: &Path, destination_path: &Path) -> Result<(), AppError>;
}

struct OsArchiveReplacer;

impl ArchiveReplacer for OsArchiveReplacer {
    fn replace_archive(&self, temp_path: &Path, destination_path: &Path) -> Result<(), AppError> {
        replace_archive_atomically_os(temp_path, destination_path)
    }
}

struct OwnedTempArchive {
    path: PathBuf,
}

impl OwnedTempArchive {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for OwnedTempArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn create_unique_temp_archive(
    destination_path: &Path,
) -> Result<(OwnedTempArchive, std::fs::File), AppError> {
    let parent = destination_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = destination_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project.spprj");

    for _ in 0..16 {
        let temp_path = parent.join(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((OwnedTempArchive { path: temp_path }, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }

    Err(AppError::FileIO(
        "failed to allocate a unique temporary project file".into(),
    ))
}

pub struct StreamingProjectWriter<'state, 'guard> {
    state: &'state AppState,
    _save_guard: &'guard SaveGuard<'state>,
    replacer: std::sync::Arc<dyn ArchiveReplacer>,
}

#[derive(Default)]
struct SaveRunPerf {
    plan_ms: u128,
    query_fetch_ms: u128,
    batch_encode_ms: u128,
    zip_write_ms: u128,
    zip_finish_ms: u128,
    sync_all_ms: u128,
    validation_ms: u128,
    replacement_ms: u128,
    max_retained_batch_bytes: usize,
    max_encoded_batch_bytes: usize,
    max_combined_batch_bytes: usize,
}

impl SaveRunPerf {
    fn to_model(&self) -> SavePerfMetrics {
        SavePerfMetrics {
            plan_ms: self.plan_ms,
            query_fetch_ms: self.query_fetch_ms,
            batch_encode_ms: self.batch_encode_ms,
            zip_write_ms: self.zip_write_ms,
            zip_finish_ms: self.zip_finish_ms,
            sync_all_ms: self.sync_all_ms,
            validation_ms: self.validation_ms,
            replacement_ms: self.replacement_ms,
            max_retained_batch_bytes: self.max_retained_batch_bytes,
            max_encoded_batch_bytes: self.max_encoded_batch_bytes,
            max_combined_batch_bytes: self.max_combined_batch_bytes,
        }
    }
}

#[cfg(any(test, feature = "perf-harness"))]
type SavePerfObserver = Box<dyn FnMut(SavePerfMetrics)>;

#[cfg(any(test, feature = "perf-harness"))]
thread_local! {
    static SAVE_PERF_OBSERVER: std::cell::RefCell<Option<SavePerfObserver>> = std::cell::RefCell::new(None);
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn with_save_perf_observer<T, FObserve, FRun>(observer: FObserve, run: FRun) -> T
where
    FObserve: FnMut(SavePerfMetrics) + 'static,
    FRun: FnOnce() -> T,
{
    SAVE_PERF_OBSERVER.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(observer));
    });
    let outcome = run();
    SAVE_PERF_OBSERVER.with(|slot| {
        *slot.borrow_mut() = None;
    });
    outcome
}

#[cfg(not(any(test, feature = "perf-harness")))]
pub(crate) fn with_save_perf_observer<T, FObserve, FRun>(_observer: FObserve, run: FRun) -> T
where
    FObserve: FnMut(SavePerfMetrics) + 'static,
    FRun: FnOnce() -> T,
{
    run()
}

#[cfg(any(test, feature = "perf-harness"))]
fn notify_save_perf_observer(metrics: SavePerfMetrics) {
    SAVE_PERF_OBSERVER.with(|slot| {
        if let Some(observer) = slot.borrow_mut().as_mut() {
            observer(metrics);
        }
    });
}

#[cfg(not(any(test, feature = "perf-harness")))]
fn notify_save_perf_observer(_metrics: SavePerfMetrics) {}

impl<'state, 'guard> StreamingProjectWriter<'state, 'guard> {
    pub fn new(state: &'state AppState, save_guard: &'guard SaveGuard<'state>) -> Self {
        Self {
            state,
            _save_guard: save_guard,
            replacer: std::sync::Arc::new(OsArchiveReplacer),
        }
    }

    #[cfg(test)]
    fn with_clock_and_replacer(
        state: &'state AppState,
        save_guard: &'guard SaveGuard<'state>,
        replacer: std::sync::Arc<dyn ArchiveReplacer>,
    ) -> Self {
        Self {
            state,
            _save_guard: save_guard,
            replacer,
        }
    }

    pub fn write(
        &self,
        snapshot: &SaveSnapshot,
        destination_path: &Path,
        progress_cb: Option<&SaveProgressCallback<'_>>,
    ) -> Result<SaveWriteResult, AppError> {
        if snapshot.destination_path != destination_path {
            return Err(AppError::InvalidParam(
                "snapshot destination path and writer destination path must match".to_string(),
            ));
        }
        validate_destination_path(&snapshot.destination_path)?;

        let total_rows = snapshot
            .datasets
            .iter()
            .map(|dataset| usize::try_from(dataset.row_count.max(0)).unwrap_or(usize::MAX))
            .sum::<usize>();

        let graph_docs = spprj_archive::build_graph_docs(snapshot.request.graph_builders.clone());
        let placeholder_tables = snapshot
            .datasets
            .iter()
            .map(|dataset| TableDoc {
                id: dataset.id.clone(),
                name: dataset.name.clone(),
                source_type: dataset.source_type.clone(),
                version: TABLE_DOC_VERSION.to_string(),
                columns: Vec::new(),
                rows: Vec::new(),
            })
            .collect::<Vec<_>>();
        let distributions = spprj_archive::distribution_records_from_values(
            snapshot.request.distributions.clone(),
        )?;
        let derived_formulas = spprj_archive::derived_formula_envelopes_from_values(
            snapshot.request.derived_formulas.clone(),
        )?;

        let bundle = spprj_archive::build_bundle(
            snapshot.destination_name.clone(),
            STREAM_VERSION.to_string(),
            snapshot.current_project.created_at.clone(),
            placeholder_tables,
            graph_docs,
            snapshot.request.fit_y_by_x.clone(),
            snapshot.request.fit_models.clone(),
            snapshot.request.tabulates.clone(),
            distributions,
            derived_formulas,
            snapshot.request.distribution_issues.clone(),
            snapshot.request.folders.clone(),
            &snapshot.request.table_folders,
            &snapshot.request.graph_folders,
            &snapshot.request.fit_y_by_x_folders,
            &snapshot.request.fit_model_folders,
            &snapshot.request.tabulate_folders,
            &snapshot.request.distribution_folders,
            snapshot.request.history.clone(),
            snapshot.request.snapshots.clone(),
        );

        thread::scope(|scope| {
            let mut perf = SaveRunPerf::default();
            let dispatcher = ProgressDispatcher::new(scope, progress_cb);
            dispatcher.emit(SaveProgress {
                phase: SavePhase::Preparing,
                table_index: 0,
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: 0,
                rows_total: total_rows,
                overall_progress: Some(0.0),
            });

            let (temp_archive, temp_file) = create_unique_temp_archive(&snapshot.destination_path)?;
            let temp_path = temp_archive.path();
            if let Err(error) = self.write_temp_archive(
                snapshot,
                &bundle.manifest,
                &bundle.graphs,
                &bundle.distributions,
                &bundle.derived_formulas,
                &temp_path,
                temp_file,
                total_rows,
                &dispatcher,
                &mut perf,
            ) {
                return Err(error);
            }

            let archive_bytes = std::fs::metadata(&temp_path)?.len();

            let replacement_started = Instant::now();
            if let Err(error) = self
                .replacer
                .replace_archive(&temp_path, &snapshot.destination_path)
            {
                return Err(error);
            }
            perf.replacement_ms = perf
                .replacement_ms
                .saturating_add(replacement_started.elapsed().as_millis());

            dispatcher.emit(SaveProgress {
                phase: SavePhase::Finalizing,
                table_index: snapshot.datasets.len(),
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: total_rows,
                rows_total: total_rows,
                overall_progress: Some(1.0),
            });

            let perf_metrics = perf.to_model();
            notify_save_perf_observer(perf_metrics);

            Ok(SaveWriteResult {
                archive_bytes,
                tables_written: snapshot.datasets.len(),
                rows_written: total_rows,
                perf: perf_metrics,
            })
        })
    }

    fn write_temp_archive(
        &self,
        snapshot: &SaveSnapshot,
        manifest: &ProjectManifest,
        graph_docs: &[GraphDoc],
        distribution_docs: &[spprj_archive::DistributionArchiveRecordV1],
        derived_formulas: &[spprj_archive::DerivedFormulaArchiveEnvelopeV1],
        temp_path: &Path,
        temp_file: std::fs::File,
        total_rows: usize,
        dispatcher: &ProgressDispatcher<'_>,
        perf: &mut SaveRunPerf,
    ) -> Result<(), AppError> {
        let mut zip = zip::ZipWriter::new(temp_file);
        let file_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(1));
        let dir_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        let manifest_bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::FileIO(format!("failed to serialize manifest: {e}")))?;
        zip.start_file("manifest.json", file_opts)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        zip.write_all(&manifest_bytes)?;

        for folder in &manifest.folders {
            zip.add_directory(format!("{folder}/"), dir_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        let graph_by_id: HashMap<&str, &GraphDoc> = graph_docs
            .iter()
            .map(|doc| (doc.id.as_str(), doc))
            .collect();
        let distribution_by_id = distribution_docs
            .iter()
            .map(|record| (record.analysis_id(), record))
            .collect::<HashMap<_, _>>();
        let formula_by_id = derived_formulas
            .iter()
            .map(|envelope| (envelope.body.formula_id.as_str(), envelope))
            .collect::<HashMap<_, _>>();
        let mut rows_written = 0usize;

        for (table_index, dataset) in snapshot.datasets.iter().enumerate() {
            dispatcher.emit(SaveProgress {
                phase: SavePhase::Table,
                table_index,
                table_total: snapshot.datasets.len(),
                table_name: Some(dataset.name.clone()),
                rows_done: rows_written,
                rows_total: total_rows,
                overall_progress: Some(incomplete_progress_fraction(rows_written, total_rows)),
            });

            let Some(table_ref) = manifest.tables.iter().find(|entry| entry.id == dataset.id)
            else {
                return Err(AppError::FileIO(format!(
                    "missing manifest table reference for dataset {}",
                    dataset.id
                )));
            };

            let plan_started = Instant::now();
            let plan = {
                let db = self
                    .state
                    .db
                    .lock()
                    .map_err(|e| AppError::Database(e.to_string()))?;
                db.prepare_archive_keyset_read(&dataset.id)?
            };
            perf.plan_ms = perf
                .plan_ms
                .saturating_add(plan_started.elapsed().as_millis());
            let column_write_modes = plan
                .columns
                .iter()
                .map(|(_, _, column_type)| archive_cell_write_mode(column_type))
                .collect::<Vec<_>>();

            let columns = table_columns_from_plan(&dataset.id, &plan, &snapshot.column_display);

            zip.start_file(&table_ref.file, file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_table_header(&mut zip, dataset, &columns)?;
            run_save_test_hook!(
                SaveFailurePoint::AfterHeader,
                Some(dataset.id.clone()),
                None,
                None
            );

            let mut next_row_id = 0i64;
            let mut first_row = true;
            let mut encoded_rows = Vec::new();
            let mut target_batch_bytes = TARGET_BATCH_BYTES;

            loop {
                let fetch_started = Instant::now();
                let batch = {
                    let db = self
                        .state
                        .db
                        .lock()
                        .map_err(|e| AppError::Database(e.to_string()))?;
                    db.read_archive_keyset_batch(
                        &plan,
                        next_row_id,
                        ROW_LIMIT_PER_BATCH,
                        target_batch_bytes,
                        HARD_BATCH_BYTES,
                    )?
                };
                perf.query_fetch_ms = perf
                    .query_fetch_ms
                    .saturating_add(fetch_started.elapsed().as_millis());

                if batch.rows.is_empty() {
                    break;
                }

                run_save_test_hook!(
                    SaveFailurePoint::BetweenBatches,
                    Some(dataset.id.clone()),
                    Some(batch.retained_bytes_estimate),
                    None
                );

                let encode_started = Instant::now();
                encoded_rows.clear();
                let rows_allocation_bytes =
                    batch.rows.capacity().saturating_mul(std::mem::size_of::<
                        crate::engine::duckdb_engine::ArchiveBatchRow,
                    >());
                let mut remaining_retained = batch.retained_bytes_estimate;
                let mut batch_peak_combined = 0usize;
                let mut batch_peak_encoded = 0usize;
                let mut embedded_zip_write_ms = 0u128;
                for row in batch.rows {
                    if !first_row {
                        encoded_rows.push(b',');
                    }
                    first_row = false;

                    write_streamed_row(
                        &mut encoded_rows,
                        row.row_id,
                        &row.values,
                        &column_write_modes,
                    )?;

                    let pre_flush_encoded_capacity = encoded_rows.capacity();
                    batch_peak_encoded = batch_peak_encoded.max(pre_flush_encoded_capacity);
                    let projected_with_both_buffers = combined_batch_allocation_estimate(
                        remaining_retained,
                        pre_flush_encoded_capacity,
                    );
                    batch_peak_combined = batch_peak_combined.max(projected_with_both_buffers);

                    remaining_retained = remaining_retained_after_row(
                        remaining_retained,
                        row.retained_bytes_estimate,
                    )
                    .max(rows_allocation_bytes);
                    drop(row.values);

                    if encoded_rows.len() >= ENCODED_CHUNK_TARGET_BYTES {
                        let write_started = Instant::now();
                        zip.write_all(&encoded_rows)?;
                        let write_elapsed_ms = write_started.elapsed().as_millis();
                        perf.zip_write_ms = perf.zip_write_ms.saturating_add(write_elapsed_ms);
                        embedded_zip_write_ms =
                            embedded_zip_write_ms.saturating_add(write_elapsed_ms);
                        encoded_rows = Vec::new();
                    }

                    next_row_id = row.row_id;

                    rows_written = rows_written.saturating_add(1);
                    dispatcher.update_table(SaveProgress {
                        phase: SavePhase::Table,
                        table_index,
                        table_total: snapshot.datasets.len(),
                        table_name: Some(dataset.name.clone()),
                        rows_done: rows_written,
                        rows_total: total_rows,
                        overall_progress: Some(incomplete_progress_fraction(
                            rows_written,
                            total_rows,
                        )),
                    });
                }

                perf.batch_encode_ms = perf.batch_encode_ms.saturating_add(
                    encode_started
                        .elapsed()
                        .as_millis()
                        .saturating_sub(embedded_zip_write_ms),
                );
                perf.max_retained_batch_bytes = perf
                    .max_retained_batch_bytes
                    .max(batch.retained_bytes_estimate);
                perf.max_encoded_batch_bytes = perf.max_encoded_batch_bytes.max(batch_peak_encoded);
                perf.max_combined_batch_bytes =
                    perf.max_combined_batch_bytes.max(batch_peak_combined);
                target_batch_bytes =
                    adaptive_target_batch_bytes(target_batch_bytes, batch.retained_bytes_estimate);

                let write_started = Instant::now();
                zip.write_all(&encoded_rows)?;
                perf.zip_write_ms = perf
                    .zip_write_ms
                    .saturating_add(write_started.elapsed().as_millis());
                encoded_rows = Vec::new();
            }

            zip.write_all(b"]}")?;
        }

        dispatcher.emit(SaveProgress {
            phase: SavePhase::Metadata,
            table_index: snapshot.datasets.len(),
            table_total: snapshot.datasets.len(),
            table_name: None,
            rows_done: rows_written,
            rows_total: total_rows,
            overall_progress: Some(incomplete_progress_fraction(rows_written, total_rows)),
        });

        for graph_ref in &manifest.graphs {
            if let Some(graph_doc) = graph_by_id.get(graph_ref.id.as_str()) {
                zip.start_file(&graph_ref.file, file_opts)
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
                let bytes = serde_json::to_vec(graph_doc)
                    .map_err(|e| AppError::FileIO(format!("failed to serialize graph doc: {e}")))?;
                zip.write_all(&bytes)?;
            }
        }
        for entry in &manifest.distributions {
            if let Some(record) = distribution_by_id.get(entry.analysis_id.as_str()) {
                zip.start_file(&entry.file, file_opts)
                    .map_err(|error| AppError::FileIO(error.to_string()))?;
                match record {
                    spprj_archive::DistributionArchiveRecordV1::Parsed(envelope) => {
                        serde_json::to_writer(&mut zip, envelope)
                    }
                    spprj_archive::DistributionArchiveRecordV1::UnknownVersion {
                        raw_envelope,
                        ..
                    } => serde_json::to_writer(&mut zip, raw_envelope),
                    spprj_archive::DistributionArchiveRecordV1::Corrupt { raw_text, .. } => {
                        zip.write_all(raw_text.as_bytes())?;
                        continue;
                    }
                }
                .map_err(|error| AppError::FileIO(error.to_string()))?;
            }
        }
        for entry in &manifest.derived_formulas {
            if let Some(envelope) = formula_by_id.get(entry.formula_id.as_str()) {
                zip.start_file(&entry.file, file_opts)
                    .map_err(|error| AppError::FileIO(error.to_string()))?;
                serde_json::to_writer(&mut zip, envelope)
                    .map_err(|error| AppError::FileIO(error.to_string()))?;
            }
        }

        if !snapshot.request.history.is_empty() {
            zip.start_file(".history.json", file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            serde_json::to_writer(&mut zip, &snapshot.request.history)
                .map_err(|e| AppError::FileIO(format!("failed to serialize history: {e}")))?;
        }
        if !snapshot.request.snapshots.is_empty() {
            zip.start_file(".snapshots.json", file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            serde_json::to_writer(&mut zip, &snapshot.request.snapshots)
                .map_err(|e| AppError::FileIO(format!("failed to serialize snapshots: {e}")))?;
        }

        dispatcher.emit(SaveProgress {
            phase: SavePhase::Compressing,
            table_index: snapshot.datasets.len(),
            table_total: snapshot.datasets.len(),
            table_name: None,
            rows_done: rows_written,
            rows_total: total_rows,
            overall_progress: Some(incomplete_progress_fraction(rows_written, total_rows)),
        });

        run_save_test_hook!(SaveFailurePoint::ZipFinish, None, None, None);
        let finish_started = Instant::now();
        let finished_file = zip
            .finish()
            .map_err(|e| AppError::FileIO(format!("failed to finish archive: {e}")))?;
        perf.zip_finish_ms = perf
            .zip_finish_ms
            .saturating_add(finish_started.elapsed().as_millis());

        run_save_test_hook!(SaveFailurePoint::SyncAll, None, None, None);
        let sync_started = Instant::now();
        finished_file.sync_all()?;
        perf.sync_all_ms = perf
            .sync_all_ms
            .saturating_add(sync_started.elapsed().as_millis());

        dispatcher.emit(SaveProgress {
            phase: SavePhase::Finalizing,
            table_index: snapshot.datasets.len(),
            table_total: snapshot.datasets.len(),
            table_name: None,
            rows_done: rows_written,
            rows_total: total_rows,
            overall_progress: None,
        });

        run_save_test_hook!(
            SaveFailurePoint::Validation,
            None,
            None,
            Some(temp_path.to_path_buf())
        );

        let mut expected_entries = Vec::new();
        if !snapshot.request.history.is_empty() {
            expected_entries.push(".history.json");
        }
        if !snapshot.request.snapshots.is_empty() {
            expected_entries.push(".snapshots.json");
        }
        let validation_started = Instant::now();
        spprj_archive::validate_archive_manifest_and_entries(
            temp_path,
            manifest,
            &expected_entries,
        )?;
        perf.validation_ms = perf
            .validation_ms
            .saturating_add(validation_started.elapsed().as_millis());

        Ok(())
    }
}

fn validate_destination_path(destination_path: &Path) -> Result<(), AppError> {
    let parent = destination_path.parent().ok_or_else(|| {
        AppError::InvalidParam("destination path must have a parent directory".to_string())
    })?;
    if !parent.exists() {
        return Err(AppError::InvalidParam(format!(
            "destination parent does not exist: {}",
            parent.to_string_lossy()
        )));
    }
    Ok(())
}

fn table_columns_from_plan(
    dataset_id: &str,
    plan: &ArchiveKeysetReadPlan,
    column_display: &HashMap<String, Vec<ColumnDisplayProps>>,
) -> Vec<TableColumn> {
    let display = column_display.get(dataset_id);
    plan.columns
        .iter()
        .enumerate()
        .map(|(index, (column_id, name, column_type))| {
            let props = display.and_then(|items| items.iter().find(|item| item.col_index == index));
            TableColumn {
                column_id: Some(column_id.clone()),
                name: name.clone(),
                col_type: column_type.clone(),
                width: props.and_then(|item| item.width),
                format: props.and_then(|item| {
                    item.format.as_ref().map(|format| TableColumnFormat {
                        kind: format.kind.clone(),
                        decimals: format.decimals,
                        currency: format.currency.clone(),
                    })
                }),
                extras: props.and_then(|item| item.extras.clone()),
            }
        })
        .collect()
}

fn write_table_header<W: Write>(
    writer: &mut W,
    dataset: &crate::models::table::DatasetMeta,
    columns: &[TableColumn],
) -> Result<(), AppError> {
    writer.write_all(b"{\"id\":")?;
    serde_json::to_writer(&mut *writer, &dataset.id)
        .map_err(|e| AppError::FileIO(format!("failed to write table id: {e}")))?;
    writer.write_all(b",\"name\":")?;
    serde_json::to_writer(&mut *writer, &dataset.name)
        .map_err(|e| AppError::FileIO(format!("failed to write table name: {e}")))?;
    writer.write_all(b",\"sourceType\":")?;
    serde_json::to_writer(&mut *writer, &dataset.source_type)
        .map_err(|e| AppError::FileIO(format!("failed to write table source type: {e}")))?;
    writer.write_all(b",\"version\":")?;
    serde_json::to_writer(&mut *writer, TABLE_DOC_VERSION)
        .map_err(|e| AppError::FileIO(format!("failed to write table version: {e}")))?;
    writer.write_all(b",\"columns\":")?;
    serde_json::to_writer(&mut *writer, columns)
        .map_err(|e| AppError::FileIO(format!("failed to write columns: {e}")))?;
    writer.write_all(b",\"rows\":[")?;
    Ok(())
}

fn write_streamed_row<W: Write>(
    writer: &mut W,
    row_id: i64,
    values: &[duckdb::types::Value],
    column_write_modes: &[ArchiveCellWriteMode],
) -> Result<(), AppError> {
    writer.write_all(b"[")?;
    write_archive_cell_with_mode(
        writer,
        &duckdb::types::Value::BigInt(row_id),
        ArchiveCellWriteMode::Scalar,
    )?;
    for (index, value) in values.iter().enumerate() {
        writer.write_all(b",")?;
        write_archive_cell_with_mode(writer, value, column_write_modes[index])?;
    }
    writer.write_all(b"]")?;
    Ok(())
}

fn progress_fraction(rows_done: usize, rows_total: usize) -> f64 {
    if rows_total == 0 {
        1.0
    } else {
        (rows_done as f64 / rows_total as f64).clamp(0.0, 1.0)
    }
}

fn incomplete_progress_fraction(rows_done: usize, rows_total: usize) -> f64 {
    progress_fraction(rows_done, rows_total).min(0.99)
}

fn adaptive_target_batch_bytes(
    current_target: usize,
    observed_peak_combined_bytes: usize,
) -> usize {
    if observed_peak_combined_bytes == 0 {
        return current_target;
    }

    let safe_hard_cap = HARD_BATCH_BYTES.saturating_sub(TARGET_BATCH_SAFETY_MARGIN_BYTES);
    if observed_peak_combined_bytes >= HARD_BATCH_BYTES {
        return current_target
            .saturating_sub(256 * 1024)
            .clamp(MIN_TARGET_BATCH_BYTES, safe_hard_cap);
    }

    let scaled_target = current_target
        .saturating_mul(safe_hard_cap)
        .saturating_div(observed_peak_combined_bytes.max(1));
    let bounded_target = scaled_target.clamp(MIN_TARGET_BATCH_BYTES, safe_hard_cap);
    let adjustment = bounded_target.abs_diff(current_target);

    if adjustment < 64 * 1024 {
        current_target
    } else {
        ((current_target.saturating_add(bounded_target)) / 2)
            .clamp(MIN_TARGET_BATCH_BYTES, safe_hard_cap)
    }
}

fn remaining_retained_after_row(remaining_retained: usize, row_bytes: usize) -> usize {
    remaining_retained.saturating_sub(row_bytes)
}

fn combined_batch_allocation_estimate(remaining_retained: usize, encoded_capacity: usize) -> usize {
    remaining_retained.saturating_add(encoded_capacity)
}

fn replace_archive_atomically_os(
    temp_path: &Path,
    destination_path: &Path,
) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        replace_existing_windows(temp_path, destination_path)
    }

    #[cfg(not(windows))]
    {
        // POSIX rename within the same directory is atomic and overwrites the
        // destination if it exists.
        std::fs::rename(temp_path, destination_path)?;
        Ok(())
    }
}

#[cfg(windows)]
fn replace_existing_windows(temp_path: &Path, destination_path: &Path) -> Result<(), AppError> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PATH_NOT_FOUND: i32 = 3;
    const ERROR_NOT_FOUND: i32 = 1168;

    extern "system" {
        fn ReplaceFileW(
            lp_replaced_file_name: *const u16,
            lp_replacement_file_name: *const u16,
            lp_backup_file_name: *const u16,
            dw_replace_flags: u32,
            lp_exclude: *mut c_void,
            lp_reserved: *mut c_void,
        ) -> i32;
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    let dest_wide = destination_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let temp_wide = temp_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();

    let replaced = unsafe {
        ReplaceFileW(
            dest_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        let replace_error = std::io::Error::last_os_error();
        let code = replace_error.raw_os_error().unwrap_or_default();
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND || code == ERROR_NOT_FOUND {
            let moved = unsafe {
                MoveFileExW(
                    temp_wide.as_ptr(),
                    dest_wide.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if moved == 0 {
                return Err(AppError::FileIO(
                    std::io::Error::last_os_error().to_string(),
                ));
            }
            return Ok(());
        }
        return Err(AppError::FileIO(replace_error.to_string()));
    }

    Ok(())
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SaveFailurePoint {
    AfterHeader,
    BetweenBatches,
    ZipFinish,
    SyncAll,
    Validation,
}

#[cfg(test)]
#[derive(Clone)]
struct SaveHookContext {
    dataset_id: Option<String>,
    retained_batch_bytes: Option<usize>,
    temp_archive_path: Option<PathBuf>,
}

#[cfg(test)]
type SaveTestHook = Box<dyn FnMut(SaveFailurePoint, SaveHookContext) -> Result<(), AppError>>;

#[cfg(test)]
thread_local! {
    static SAVE_TEST_HOOK: std::cell::RefCell<Option<SaveTestHook>> = std::cell::RefCell::new(None);
}

#[cfg(test)]
fn install_save_test_hook(hook: Option<SaveTestHook>) {
    SAVE_TEST_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
fn run_test_hook(point: SaveFailurePoint, context: SaveHookContext) -> Result<(), AppError> {
    SAVE_TEST_HOOK.with(|slot| {
        let mut hook_slot = slot.borrow_mut();
        if let Some(hook) = hook_slot.as_mut() {
            hook(point, context)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use duckdb::params;

    use crate::error::AppError;
    use crate::models::project::ProjectInfo;
    use crate::models::save::{SavePhase, SaveProgress, SaveProjectRequest, SaveSnapshot};
    use crate::services::spprj_archive;
    use crate::state::AppState;

    use super::{
        combined_batch_allocation_estimate, install_save_test_hook, remaining_retained_after_row,
        ArchiveReplacer, ProgressDispatcher, SaveFailurePoint, StreamingProjectWriter,
        HARD_BATCH_BYTES, HEARTBEAT_INTERVAL,
    };

    #[derive(Default)]
    struct TestReplacerState {
        calls: AtomicUsize,
        fail: AtomicUsize,
    }

    struct TestReplacer {
        state: Arc<TestReplacerState>,
    }

    impl ArchiveReplacer for TestReplacer {
        fn replace_archive(
            &self,
            temp_path: &std::path::Path,
            destination_path: &std::path::Path,
        ) -> Result<(), AppError> {
            self.state.calls.fetch_add(1, Ordering::SeqCst);
            if self.state.fail.load(Ordering::SeqCst) != 0 {
                return Err(AppError::FileIO(
                    "simulated replacement failure".to_string(),
                ));
            }
            place_temp_for_test(temp_path, destination_path)?;
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum ReplacementRaceMode {
        DestinationAppears,
        DestinationDisappears,
    }

    struct RaceReplacer {
        mode: ReplacementRaceMode,
        calls: AtomicUsize,
    }

    impl ArchiveReplacer for RaceReplacer {
        fn replace_archive(
            &self,
            temp_path: &std::path::Path,
            destination_path: &std::path::Path,
        ) -> Result<(), AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.mode {
                ReplacementRaceMode::DestinationAppears => {
                    if !destination_path.exists() {
                        std::fs::write(destination_path, b"appeared-during-race")?;
                    }
                }
                ReplacementRaceMode::DestinationDisappears => {
                    if destination_path.exists() {
                        std::fs::remove_file(destination_path)?;
                    }
                }
            }
            place_temp_for_test(temp_path, destination_path)?;
            Ok(())
        }
    }

    struct TempSizeCaptureAndAppendReplacer {
        calls: AtomicUsize,
        observed_temp_len: Arc<Mutex<Option<u64>>>,
        append_bytes: Vec<u8>,
    }

    impl ArchiveReplacer for TempSizeCaptureAndAppendReplacer {
        fn replace_archive(
            &self,
            temp_path: &std::path::Path,
            destination_path: &std::path::Path,
        ) -> Result<(), AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let temp_len = std::fs::metadata(temp_path)?.len();
            *self.observed_temp_len.lock().unwrap() = Some(temp_len);

            place_temp_for_test(temp_path, destination_path)?;

            if !self.append_bytes.is_empty() {
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(destination_path)?;
                file.write_all(&self.append_bytes)?;
                file.sync_all()?;
            }
            Ok(())
        }
    }

    struct DeleteAfterReplaceReplacer {
        calls: AtomicUsize,
    }

    impl ArchiveReplacer for DeleteAfterReplaceReplacer {
        fn replace_archive(
            &self,
            temp_path: &std::path::Path,
            destination_path: &std::path::Path,
        ) -> Result<(), AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            place_temp_for_test(temp_path, destination_path)?;
            std::fs::remove_file(destination_path)?;
            Ok(())
        }
    }

    fn place_temp_for_test(
        temp_path: &std::path::Path,
        destination_path: &std::path::Path,
    ) -> Result<(), AppError> {
        // Test seam: model "replace existing" behavior without deleting the
        // destination first. This is intentionally not an atomic guarantee.
        if destination_path.exists() {
            let bytes = std::fs::read(temp_path)?;
            std::fs::write(destination_path, bytes)?;
            std::fs::remove_file(temp_path)?;
            Ok(())
        } else {
            std::fs::rename(temp_path, destination_path)?;
            Ok(())
        }
    }

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "stats_playground_streaming_{label}_{}.spprj",
            uuid::Uuid::new_v4()
        ))
    }

    fn seed_benchmark_dataset(state: &AppState, rows: usize) -> crate::models::table::DatasetMeta {
        let db = state.db.lock().unwrap();
        db.seed_benchmark_table("stream-ds", "Stream DS", rows, 4)
            .unwrap();
        db.get_dataset_meta("stream-ds").unwrap()
    }

    fn seed_gapped_dataset(state: &AppState) -> crate::models::table::DatasetMeta {
        let db = state.db.lock().unwrap();
        db.create_empty_table(
            "gapped",
            "Gapped",
            &["value".to_string()],
            &["BIGINT".to_string()],
        )
        .unwrap();

        for row_id in [1_i64, 2, 8, 1001] {
            db.conn()
                .execute(
                    "INSERT INTO \"dataset_gapped\" (\"_row_id\", \"value\") VALUES ($1, $2)",
                    params![row_id, row_id * 10],
                )
                .unwrap();
        }
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 4 WHERE id = 'gapped'",
                [],
            )
            .unwrap();
        db.get_dataset_meta("gapped").unwrap()
    }

    fn save_snapshot(
        destination_path: &std::path::Path,
        datasets: Vec<crate::models::table::DatasetMeta>,
    ) -> SaveSnapshot {
        let dataset_generations = datasets
            .iter()
            .map(|dataset| (dataset.id.clone(), 0_u64))
            .collect();
        SaveSnapshot {
            current_project: ProjectInfo {
                name: "Streaming Project".to_string(),
                file_path: destination_path.to_string_lossy().to_string(),
                created_at: "2026-08-21T00:00:00Z".to_string(),
            },
            destination_path: destination_path.to_path_buf(),
            destination_name: "Streaming Project".to_string(),
            datasets,
            dataset_generations,
            column_display: HashMap::new(),
            request: SaveProjectRequest {
                file_path: None,
                history: vec![serde_json::json!({"event": "save"})],
                snapshots: vec![serde_json::json!({"id": "snap-1"})],
                graph_builders: vec![serde_json::json!({
                    "id": "graph-1",
                    "name": "Graph 1",
                    "graphType": "line",
                })],
                fit_y_by_x: vec![serde_json::json!({"id": "fit-1"})],
                fit_models: vec![serde_json::json!({"id": "fit-model-1"})],
                tabulates: vec![serde_json::json!({"id": "tab-1"})],
                distributions: Vec::new(),
                derived_formulas: Vec::new(),
                distribution_issues: Vec::new(),
                folders: vec!["Bench".to_string(), "Bench/Sub".to_string()],
                table_folders: HashMap::new(),
                graph_folders: HashMap::new(),
                fit_y_by_x_folders: HashMap::new(),
                fit_model_folders: HashMap::new(),
                tabulate_folders: HashMap::new(),
                distribution_folders: HashMap::new(),
            },
        }
    }

    fn truncate_archive_file(path: &std::path::Path) -> Result<(), AppError> {
        let mut bytes = std::fs::read(path)?;
        bytes.truncate(bytes.len().saturating_sub(24));
        std::fs::write(path, &bytes)?;
        Ok(())
    }

    fn remove_table_entries_from_archive(
        source_path: &std::path::Path,
        destination_path: &std::path::Path,
    ) -> Result<(), AppError> {
        let input = std::fs::File::open(source_path)?;
        let mut input_zip = zip::ZipArchive::new(input)
            .map_err(|e| AppError::FileIO(format!("failed to open archive for mutation: {e}")))?;
        let output = std::fs::File::create(destination_path)?;
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip
                .by_index(index)
                .map_err(|e| AppError::FileIO(format!("failed to read archive entry: {e}")))?;
            if entry.name().ends_with(".sptb") {
                continue;
            }
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| AppError::FileIO(format!("failed to copy archive entry: {e}")))?;
            output_zip
                .start_file(entry.name(), opts)
                .map_err(|e| AppError::FileIO(format!("failed to create archive entry: {e}")))?;
            output_zip
                .write_all(&bytes)
                .map_err(|e| AppError::FileIO(format!("failed to write archive entry: {e}")))?;
        }

        output_zip
            .finish()
            .map_err(|e| AppError::FileIO(format!("failed to finish mutated archive: {e}")))?;
        Ok(())
    }

    #[test]
    fn save_path_is_streaming() {
        let project_source = include_str!("project_service.rs");
        let save_project_body = project_source
            .split("pub fn save_project(")
            .nth(1)
            .and_then(|tail| tail.split("/// Get current project info").next())
            .expect("save_project body should be present");

        assert!(
            !save_project_body.contains("compose_table_doc("),
            "save_project must not compose full table docs per dataset"
        );

        let archive_source = include_str!("spprj_archive.rs");
        let write_archive_body = archive_source
            .split("pub fn write_project_archive(")
            .nth(1)
            .and_then(|tail| tail.split("fn write_zip_entry<").next())
            .expect("write_project_archive body should be present");

        assert!(
            !write_archive_body.contains("serde_json::to_vec(doc)"),
            "write_project_archive must not duplicate full table/graph JSON buffers"
        );
    }

    #[test]
    fn stream_writer_scales_and_keeps_batch_memory_bounded() {
        for row_count in [0usize, 1, 10, 5_000, 300_000] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, row_count);
            let destination = temp_path("scale");
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let max_batch_bytes = Arc::new(AtomicUsize::new(0));
            let max_batch_clone = Arc::clone(&max_batch_bytes);
            install_save_test_hook(Some(Box::new(move |point, context| {
                if point == SaveFailurePoint::BetweenBatches {
                    if let Some(bytes) = context.retained_batch_bytes {
                        let mut current = max_batch_clone.load(Ordering::SeqCst);
                        while bytes > current {
                            match max_batch_clone.compare_exchange(
                                current,
                                bytes,
                                Ordering::SeqCst,
                                Ordering::SeqCst,
                            ) {
                                Ok(_) => break,
                                Err(next) => current = next,
                            }
                        }
                    }
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            let result = writer
                .write(&snapshot, &destination, None)
                .expect("streaming save should succeed");
            install_save_test_hook(None);

            assert_eq!(result.tables_written, 1);
            assert_eq!(result.rows_written, row_count);
            assert!(result.archive_bytes > 0);
            assert!(max_batch_bytes.load(Ordering::SeqCst) < HARD_BATCH_BYTES);

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), row_count);
            if row_count > 0 {
                assert_eq!(reopened.tables[0].rows[0][0], serde_json::json!(1));
                assert_eq!(
                    reopened.tables[0].rows[row_count - 1][0],
                    serde_json::json!(row_count as i64)
                );
            }

            let _ = std::fs::remove_file(destination);
        }
    }

    #[test]
    fn stream_writer_preserves_gapped_row_ids_and_order() {
        let state = AppState::new().unwrap();
        let dataset = seed_gapped_dataset(&state);
        let destination = temp_path("gapped");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer.write(&snapshot, &destination, None).unwrap();

        let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
        assert_eq!(reopened.tables.len(), 1);
        let ids = reopened.tables[0]
            .rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect::<Vec<_>>();
        let values = reopened.tables[0]
            .rows
            .iter()
            .map(|row| row[1].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![1, 2, 8, 1001]);
        assert_eq!(values, vec![10, 20, 80, 10010]);

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn progress_dispatcher_heartbeats_during_non_table_phases() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_clone = Arc::clone(&events);
        let callback = |progress| events_clone.lock().unwrap().push(progress);

        thread::scope(|scope| {
            let dispatcher = ProgressDispatcher::new(scope, Some(&callback));
            dispatcher.emit(SaveProgress {
                phase: SavePhase::Metadata,
                table_index: 1,
                table_total: 1,
                table_name: None,
                rows_done: 10,
                rows_total: 10,
                overall_progress: Some(0.9),
            });
            thread::sleep(HEARTBEAT_INTERVAL * 3);
        });

        let events = events.lock().unwrap();
        assert!(events.len() >= 3);
        assert!(events
            .iter()
            .all(|event| event.phase == SavePhase::Metadata));
    }

    #[test]
    fn stream_writer_preserves_existing_destination_tmp_sibling() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 1);
        let destination = temp_path("existing-temp-sibling");
        let sibling = PathBuf::from(format!("{}.tmp", destination.to_string_lossy()));
        std::fs::write(&sibling, b"unrelated-sibling-file").unwrap();
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let guard = state.save_coordinator.begin_save().unwrap();
        StreamingProjectWriter::new(&state, &guard)
            .write(&snapshot, &destination, None)
            .unwrap();

        assert_eq!(std::fs::read(&sibling).unwrap(), b"unrelated-sibling-file");
        let _ = std::fs::remove_file(destination);
        let _ = std::fs::remove_file(sibling);
    }

    #[test]
    fn owned_temp_archive_removes_only_its_unique_file_on_drop() {
        let destination = temp_path("owned-temp-cleanup");
        let sibling = PathBuf::from(format!("{}.tmp", destination.to_string_lossy()));
        std::fs::write(&sibling, b"unrelated").unwrap();

        let owned_path = {
            let (owned, file) = super::create_unique_temp_archive(&destination).unwrap();
            let path = owned.path().to_path_buf();
            assert!(path.exists());
            drop(file);
            drop(owned);
            path
        };

        assert!(!owned_path.exists());
        assert_eq!(std::fs::read(&sibling).unwrap(), b"unrelated");
        let _ = std::fs::remove_file(sibling);
    }

    #[test]
    fn stream_writer_validation_failures_prevent_replacement_for_central_dir_and_missing_table() {
        enum ValidationMutation {
            TruncatedCentralDirectory,
            MissingTableEntry,
        }

        for mutation in [
            ValidationMutation::TruncatedCentralDirectory,
            ValidationMutation::MissingTableEntry,
        ] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 128);
            let destination = temp_path("validation-mutation");
            std::fs::write(&destination, b"destination-before-save").unwrap();
            let original_bytes = std::fs::read(&destination).unwrap();
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let replacer_state = Arc::new(TestReplacerState::default());
            let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TestReplacer {
                state: Arc::clone(&replacer_state),
            });

            install_save_test_hook(Some(Box::new(move |point, context| {
                if point == SaveFailurePoint::Validation {
                    let temp_archive_path = context.temp_archive_path.ok_or_else(|| {
                        AppError::FileIO(
                            "validation hook missing temp archive path context".to_string(),
                        )
                    })?;
                    match mutation {
                        ValidationMutation::TruncatedCentralDirectory => {
                            truncate_archive_file(&temp_archive_path)?;
                        }
                        ValidationMutation::MissingTableEntry => {
                            let rewritten = PathBuf::from(format!(
                                "{}.mut",
                                temp_archive_path.to_string_lossy()
                            ));
                            remove_table_entries_from_archive(&temp_archive_path, &rewritten)?;
                            std::fs::remove_file(&temp_archive_path)?;
                            std::fs::rename(&rewritten, &temp_archive_path)?;
                        }
                    }
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, replacer);
            let error = writer.write(&snapshot, &destination, None).unwrap_err();
            install_save_test_hook(None);

            assert!(matches!(error, AppError::FileIO(_)));
            assert_eq!(replacer_state.calls.load(Ordering::SeqCst), 0);
            assert_eq!(std::fs::read(&destination).unwrap(), original_bytes);
            assert!(!PathBuf::from(format!("{}.tmp", destination.to_string_lossy())).exists());

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_allows_read_interleaving_between_batches() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_empty_table(
                "interleave",
                "Interleave",
                &["payload".to_string()],
                &["VARCHAR".to_string()],
            )
            .unwrap();
            let payload = "x".repeat(220_000);
            for row_id in 1..=60_i64 {
                db.conn()
                    .execute(
                        "INSERT INTO \"dataset_interleave\" (\"_row_id\", \"payload\") VALUES ($1, $2)",
                        params![row_id, payload.as_str()],
                    )
                    .unwrap();
            }
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 60 WHERE id = 'interleave'",
                    [],
                )
                .unwrap();
        }

        let dataset = {
            let db = state.db.lock().unwrap();
            db.get_dataset_meta("interleave").unwrap()
        };
        let destination = temp_path("interleave");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let hook_seen = Arc::new(AtomicUsize::new(0));
        thread::scope(|scope| {
            let (reader_start_tx, reader_start_rx) = mpsc::channel::<()>();
            let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
            let state_ref = &state;

            let reader = scope.spawn(move || {
                reader_start_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("reader did not receive start signal");
                let db = state_ref.db.lock().unwrap();
                let listed = db.list_datasets().unwrap();
                assert!(!listed.is_empty());
                drop(db);
                reader_done_tx
                    .send(())
                    .expect("reader completion signal failed");
            });

            let hook_seen_clone = Arc::clone(&hook_seen);
            install_save_test_hook(Some(Box::new(move |point, _| {
                if point == SaveFailurePoint::BetweenBatches {
                    let seen = hook_seen_clone.fetch_add(1, Ordering::SeqCst);
                    if seen == 0 {
                        reader_start_tx.send(()).map_err(|e| {
                            AppError::FileIO(format!("failed to start reader: {e}"))
                        })?;
                        if reader_done_rx.recv_timeout(Duration::from_secs(5)).is_err() {
                            return Err(AppError::FileIO(
                                "reader did not complete while writer paused between batches"
                                    .to_string(),
                            ));
                        }
                    }
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            writer.write(&snapshot, &destination, None).unwrap();
            install_save_test_hook(None);
            reader.join().unwrap();
        });

        assert!(hook_seen.load(Ordering::SeqCst) >= 1);

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_is_throttled_without_sleep() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 20_000);
        let destination = temp_path("progress");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        install_save_test_hook(Some(Box::new(move |point, _| {
            if point == SaveFailurePoint::BetweenBatches {
                std::thread::sleep(Duration::from_millis(130));
            }
            Ok(())
        })));

        let progress_events: Arc<Mutex<Vec<(Instant, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((Instant::now(), event));
                }),
            )
            .unwrap();
        install_save_test_hook(None);

        let events = progress_events.lock().unwrap();
        let table_events = events
            .iter()
            .filter(|(_, event)| event.phase == SavePhase::Table)
            .cloned()
            .collect::<Vec<_>>();

        assert!(table_events.len() >= 3);
        let advancing_events = table_events
            .into_iter()
            .filter(|(_, event)| event.rows_done > 0 && event.rows_done < event.rows_total)
            .collect::<Vec<_>>();
        assert!(advancing_events.len() >= 2);

        for pair in advancing_events.windows(2) {
            let delta = pair[1].0.duration_since(pair[0].0).as_millis();
            assert!(delta >= 80);
            assert!(delta <= 320);
        }

        let phases = events
            .iter()
            .map(|(_, event)| event.phase)
            .collect::<Vec<_>>();
        assert!(phases.contains(&SavePhase::Preparing));
        assert!(phases.contains(&SavePhase::Table));
        assert!(phases.contains(&SavePhase::Metadata));
        assert!(phases.contains(&SavePhase::Compressing));
        assert!(phases.contains(&SavePhase::Finalizing));

        let preparing_idx = phases
            .iter()
            .position(|phase| *phase == SavePhase::Preparing)
            .unwrap();
        let first_table_idx = phases
            .iter()
            .position(|phase| *phase == SavePhase::Table)
            .unwrap();
        let metadata_idx = phases
            .iter()
            .position(|phase| *phase == SavePhase::Metadata)
            .unwrap();
        let compressing_idx = phases
            .iter()
            .position(|phase| *phase == SavePhase::Compressing)
            .unwrap();
        let finalizing_idx = phases
            .iter()
            .rposition(|phase| *phase == SavePhase::Finalizing)
            .unwrap();
        assert!(preparing_idx < first_table_idx);
        assert!(first_table_idx < metadata_idx);
        assert!(metadata_idx < compressing_idx);
        assert!(compressing_idx < finalizing_idx);

        let mut last_progress = 0.0_f64;
        for (_, event) in events.iter() {
            if let Some(progress) = event.overall_progress {
                assert!(progress >= last_progress);
                last_progress = progress;
            }
        }

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn combined_batch_accounting_uses_each_consumed_row_and_encoded_capacity() {
        let row_bytes = [700_000usize, 100_000, 1_300_000];
        let mut remaining_retained = row_bytes.iter().sum::<usize>();
        let mut encoded_rows = Vec::with_capacity(256_000);
        encoded_rows.extend_from_slice(b"encoded");

        assert_eq!(
            combined_batch_allocation_estimate(remaining_retained, encoded_rows.capacity()),
            row_bytes.iter().sum::<usize>() + encoded_rows.capacity()
        );

        remaining_retained = remaining_retained_after_row(remaining_retained, row_bytes[0]);

        assert_eq!(remaining_retained, 1_400_000);
        assert_eq!(
            combined_batch_allocation_estimate(remaining_retained, encoded_rows.capacity()),
            remaining_retained + encoded_rows.capacity()
        );
        assert!(encoded_rows.capacity() > encoded_rows.len());
    }

    #[test]
    fn stream_writer_progress_handles_zero_rows_and_large_time_jumps() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 0);
        let destination = temp_path("progress-zero");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let progress_events: Arc<Mutex<Vec<(Instant, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((Instant::now(), event));
                }),
            )
            .unwrap();

        let events = progress_events.lock().unwrap();
        let preparing = events
            .iter()
            .find(|(_, event)| event.phase == SavePhase::Preparing)
            .expect("preparing event should be emitted");
        assert_eq!(preparing.1.rows_total, 0);
        assert_eq!(preparing.1.overall_progress, Some(0.0));

        let finalizing = events
            .iter()
            .rfind(|(_, event)| event.phase == SavePhase::Finalizing)
            .expect("finalizing event should be emitted");
        assert_eq!(finalizing.1.rows_done, 0);
        assert_eq!(finalizing.1.rows_total, 0);
        assert_eq!(finalizing.1.overall_progress, Some(1.0));
        assert!(events[..events.len() - 1]
            .iter()
            .all(|(_, event)| event.overall_progress != Some(1.0)));

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_emits_on_advancement_checkpoints_after_large_jumps() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 8_000);
        let destination = temp_path("progress-jumps");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        install_save_test_hook(Some(Box::new(move |point, _| {
            if point == SaveFailurePoint::BetweenBatches {
                std::thread::sleep(Duration::from_millis(260));
            }
            Ok(())
        })));

        let progress_events: Arc<Mutex<Vec<(Instant, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((Instant::now(), event));
                }),
            )
            .unwrap();
        install_save_test_hook(None);

        let events = progress_events.lock().unwrap();
        let advancing_events = events
            .iter()
            .filter(|(_, event)| {
                event.phase == SavePhase::Table
                    && event.rows_done > 0
                    && event.rows_done < event.rows_total
            })
            .cloned()
            .collect::<Vec<_>>();
        assert!(advancing_events.len() >= 2);

        for pair in advancing_events.windows(2) {
            let delta = pair[1].0.duration_since(pair[0].0).as_millis();
            assert!(delta >= 80);
            assert!(delta <= 320);
        }

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_first_advancing_event_waits_for_minimum_interval() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 8_000);
        let destination = temp_path("progress-first-window");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        install_save_test_hook(Some(Box::new(move |point, _| {
            if point == SaveFailurePoint::BetweenBatches {
                std::thread::sleep(Duration::from_millis(260));
            }
            Ok(())
        })));

        let progress_events: Arc<Mutex<Vec<(Instant, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((Instant::now(), event));
                }),
            )
            .unwrap();
        install_save_test_hook(None);

        let events = progress_events.lock().unwrap();
        let first_advancing = events
            .iter()
            .find(|(_, event)| {
                event.phase == SavePhase::Table
                    && event.rows_done > 0
                    && event.rows_done < event.rows_total
            })
            .expect("expected an advancing progress event");

        let first_table = events
            .iter()
            .find(|(_, event)| event.phase == SavePhase::Table)
            .expect("expected table progress event");

        let first_delta_ms = first_advancing.0.duration_since(first_table.0).as_millis();
        assert!(first_delta_ms >= 80);
        // CI/load jitter plus larger bounded batches can delay the first
        // advancing callback while preserving heartbeat behavior.
        assert!(first_delta_ms <= 520);

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_progress_heartbeat_covers_blocking_table_work_wall_clock() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 8_000);
        let destination = temp_path("progress-heartbeat-block");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        install_save_test_hook(Some(Box::new(move |point, _| {
            if point == SaveFailurePoint::BetweenBatches {
                std::thread::sleep(Duration::from_millis(380));
            }
            Ok(())
        })));

        let progress_events: Arc<Mutex<Vec<(Instant, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((Instant::now(), event));
                }),
            )
            .unwrap();
        install_save_test_hook(None);

        let events = progress_events.lock().unwrap();
        let table_events = events
            .iter()
            .filter(|(_, event)| event.phase == SavePhase::Table)
            .map(|(ts, event)| (*ts, event.rows_done, event.rows_total))
            .collect::<Vec<_>>();
        assert!(table_events.len() >= 3);

        let mut max_gap_ms = 0u128;
        for pair in table_events.windows(2) {
            let gap_ms = pair[1].0.duration_since(pair[0].0).as_millis();
            if gap_ms > max_gap_ms {
                max_gap_ms = gap_ms;
            }
        }

        // Scheduler tolerance: prove at least one regular progress callback gap
        // remains within the required cadence while table work is active.
        assert!(
            max_gap_ms <= 320,
            "max table progress gap was {max_gap_ms}ms"
        );

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_failure_injection_preserves_destination_and_avoids_completion() {
        for point in [
            SaveFailurePoint::AfterHeader,
            SaveFailurePoint::BetweenBatches,
            SaveFailurePoint::ZipFinish,
            SaveFailurePoint::SyncAll,
            SaveFailurePoint::Validation,
        ] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 64);
            let destination = temp_path("failure");
            std::fs::write(&destination, b"original-bytes").unwrap();
            let original = std::fs::read(&destination).unwrap();

            let snapshot = save_snapshot(&destination, vec![dataset]);
            let progress_events: Arc<Mutex<Vec<crate::models::save::SaveProgress>>> =
                Arc::new(Mutex::new(Vec::new()));
            let progress_events_clone = Arc::clone(&progress_events);

            install_save_test_hook(Some(Box::new(move |hook_point, _| {
                if hook_point == point {
                    return Err(AppError::FileIO(format!(
                        "injected failure at {hook_point:?}"
                    )));
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            let error = writer
                .write(
                    &snapshot,
                    &destination,
                    Some(&|event| {
                        progress_events_clone.lock().unwrap().push(event);
                    }),
                )
                .unwrap_err();
            install_save_test_hook(None);

            assert!(matches!(error, AppError::FileIO(_)));
            let after = std::fs::read(&destination).unwrap();
            assert_eq!(after, original);
            assert!(!PathBuf::from(format!("{}.tmp", destination.to_string_lossy())).exists());

            let progress = progress_events.lock().unwrap();
            let has_completion = progress
                .iter()
                .any(|event| event.overall_progress == Some(1.0));
            assert!(!has_completion);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_replacement_failure_preserves_destination_bytes_and_cleans_temp() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 64);
        let destination = temp_path("replace-failure");
        std::fs::write(&destination, b"original-bytes").unwrap();
        let original = std::fs::read(&destination).unwrap();
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let replacer_state = Arc::new(TestReplacerState::default());
        replacer_state.fail.store(1, Ordering::SeqCst);
        let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TestReplacer {
            state: Arc::clone(&replacer_state),
        });
        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, replacer);
        let error = writer.write(&snapshot, &destination, None).unwrap_err();

        assert!(matches!(error, AppError::FileIO(_)));
        assert_eq!(replacer_state.calls.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(&destination).unwrap(), original);
        assert!(!PathBuf::from(format!("{}.tmp", destination.to_string_lossy())).exists());

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_replacer_replaces_present_and_absent_destinations() {
        for had_destination in [false, true] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 32);
            let destination = temp_path("replace-present-absent");
            if had_destination {
                std::fs::write(&destination, b"previous-bytes").unwrap();
            }
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let replacer_state = Arc::new(TestReplacerState::default());
            let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TestReplacer {
                state: Arc::clone(&replacer_state),
            });

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, replacer);
            writer.write(&snapshot, &destination, None).unwrap();

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), 32);
            assert_eq!(replacer_state.calls.load(Ordering::SeqCst), 1);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_replacer_handles_destination_appearance_and_disappearance_races() {
        for (mode, preseed_destination) in [
            (ReplacementRaceMode::DestinationAppears, false),
            (ReplacementRaceMode::DestinationDisappears, true),
        ] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 16);
            let destination = temp_path("replace-race");
            if preseed_destination {
                std::fs::write(&destination, b"existing-before-race").unwrap();
            }
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let race_replacer = Arc::new(RaceReplacer {
                mode,
                calls: AtomicUsize::new(0),
            });

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::with_clock_and_replacer(
                &state,
                &guard,
                race_replacer.clone(),
            );
            writer.write(&snapshot, &destination, None).unwrap();

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), 16);
            assert_eq!(race_replacer.calls.load(Ordering::SeqCst), 1);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_reports_archive_bytes_from_synced_temp_before_replacement() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 64);
        let destination = temp_path("replace-bytes-source");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let observed_temp_len = Arc::new(Mutex::new(None));
        let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TempSizeCaptureAndAppendReplacer {
            calls: AtomicUsize::new(0),
            observed_temp_len: Arc::clone(&observed_temp_len),
            append_bytes: b"post-replace-mutation".to_vec(),
        });

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, replacer);
        let result = writer.write(&snapshot, &destination, None).unwrap();

        let temp_len = observed_temp_len
            .lock()
            .unwrap()
            .expect("replacer should capture temp archive size before replacement");
        let destination_len = std::fs::metadata(&destination).unwrap().len();

        assert_eq!(result.archive_bytes, temp_len);
        assert!(destination_len > result.archive_bytes);

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_returns_without_post_replace_filesystem_reads() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 8);
        let destination = temp_path("replace-no-post-fs");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let replacer: Arc<dyn ArchiveReplacer> = Arc::new(DeleteAfterReplaceReplacer {
            calls: AtomicUsize::new(0),
        });

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, replacer);
        let result = writer.write(&snapshot, &destination, None).unwrap();

        assert_eq!(result.tables_written, 1);
        assert_eq!(result.rows_written, 8);
        assert!(result.archive_bytes > 0);
        assert!(!destination.exists());
    }

    #[test]
    fn stream_writer_rejects_destination_path_mismatch() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 1);
        let destination = temp_path("path-match");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let mismatch = temp_path("path-mismatch");

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        let error = writer.write(&snapshot, &mismatch, None).unwrap_err();
        assert!(matches!(error, AppError::InvalidParam(_)));

        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(&mismatch);
    }
}

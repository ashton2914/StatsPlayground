use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use duckdb::InterruptHandle;
use uuid::Uuid;

use crate::engine::duckdb_engine::{DuckDbEngine, PreparedTableQuerySessionInfo};
use crate::error::AppError;
use crate::models::table::{
    TableNavigationRequest, TableNavigationResult, TableQuerySessionRequest,
    TableQuerySessionState, TableQuerySessionStatus, TableWindowFilter, TableWindowFilterRule,
    TableWindowSort,
};

const MAX_PREPARED_SESSIONS_PER_DATASET: usize = 2;
const MAX_PREPARED_SESSION_BYTES_BUDGET: usize = 256 * 1024 * 1024;
const PREPARED_SESSION_IDLE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct TableNavigationPolicy {
    max_prepared_sessions_per_dataset: usize,
    max_measured_bytes_budget: usize,
    idle_ttl: Duration,
}

impl Default for TableNavigationPolicy {
    fn default() -> Self {
        Self {
            max_prepared_sessions_per_dataset: MAX_PREPARED_SESSIONS_PER_DATASET,
            max_measured_bytes_budget: MAX_PREPARED_SESSION_BYTES_BUDGET,
            idle_ttl: PREPARED_SESSION_IDLE_TTL,
        }
    }
}

struct TableNavigationReader {
    engine: Mutex<DuckDbEngine>,
    interrupt_handle: Arc<InterruptHandle>,
}

#[derive(Clone)]
struct PreparedSessionReadyState {
    projection: Vec<(String, String)>,
    total_rows: i64,
}

#[derive(Clone)]
enum PreparedSessionLifecycle {
    Preparing,
    Ready(PreparedSessionReadyState),
    Cancelled,
    Failed(String),
}

struct PreparedSessionEntry {
    session_id: String,
    dataset_id: String,
    generation: u64,
    signature: String,
    mapping_table_name: String,
    mapping_index_name: String,
    engine: Mutex<DuckDbEngine>,
    interrupt_handle: Arc<InterruptHandle>,
    lifecycle: Mutex<PreparedSessionLifecycle>,
    last_accessed: Mutex<Instant>,
    active_queries: AtomicUsize,
    measured_bytes_estimate: AtomicUsize,
    released: AtomicBool,
}

impl PreparedSessionEntry {
    fn new(
        session_id: String,
        dataset_id: String,
        generation: u64,
        signature: String,
        engine: DuckDbEngine,
        interrupt_handle: Arc<InterruptHandle>,
    ) -> Self {
        let mapping_table_name =
            format!("__sp_table_query_session_{}", session_id.replace('-', "_"));
        let mapping_index_name = format!(
            "__sp_table_query_session_{}_ordinal_idx",
            session_id.replace('-', "_")
        );
        Self {
            session_id,
            dataset_id,
            generation,
            signature,
            mapping_table_name,
            mapping_index_name,
            engine: Mutex::new(engine),
            interrupt_handle,
            lifecycle: Mutex::new(PreparedSessionLifecycle::Preparing),
            last_accessed: Mutex::new(Instant::now()),
            active_queries: AtomicUsize::new(0),
            measured_bytes_estimate: AtomicUsize::new(0),
            released: AtomicBool::new(false),
        }
    }

    fn touch(&self) -> Result<(), AppError> {
        *self
            .last_accessed
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))? = Instant::now();
        Ok(())
    }

    fn mark_ready(&self, info: PreparedTableQuerySessionInfo) -> Result<(), AppError> {
        self.measured_bytes_estimate
            .store(info.measured_bytes_estimate, Ordering::Relaxed);
        *self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))? =
            PreparedSessionLifecycle::Ready(PreparedSessionReadyState {
                projection: info.projection,
                total_rows: info.total_rows,
            });
        self.touch()
    }

    fn mark_cancelled(&self) -> Result<(), AppError> {
        *self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))? =
            PreparedSessionLifecycle::Cancelled;
        Ok(())
    }

    fn mark_failed(&self, message: String) -> Result<(), AppError> {
        *self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))? =
            PreparedSessionLifecycle::Failed(message);
        Ok(())
    }

    fn status(&self) -> Result<TableQuerySessionStatus, AppError> {
        let lifecycle = self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone();
        let (state, total_rows, progress) = match lifecycle {
            PreparedSessionLifecycle::Preparing => {
                (TableQuerySessionState::Preparing, None, Some(0.0))
            }
            PreparedSessionLifecycle::Ready(ready) => (
                TableQuerySessionState::Ready,
                Some(ready.total_rows),
                Some(1.0),
            ),
            PreparedSessionLifecycle::Cancelled => (TableQuerySessionState::Cancelled, None, None),
            PreparedSessionLifecycle::Failed(_) => (TableQuerySessionState::Failed, None, None),
        };
        Ok(TableQuerySessionStatus {
            session_id: self.session_id.clone(),
            state,
            total_rows,
            progress,
        })
    }

    fn ready_state(&self) -> Result<Option<PreparedSessionReadyState>, AppError> {
        let lifecycle = self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone();
        Ok(match lifecycle {
            PreparedSessionLifecycle::Ready(ready) => Some(ready),
            _ => None,
        })
    }

    fn failure_message(&self) -> Result<Option<String>, AppError> {
        let lifecycle = self
            .lifecycle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone();
        Ok(match lifecycle {
            PreparedSessionLifecycle::Failed(message) => Some(message),
            _ => None,
        })
    }

    fn last_accessed_at(&self) -> Result<Instant, AppError> {
        self.last_accessed
            .lock()
            .map(|value| *value)
            .map_err(|error| AppError::Database(error.to_string()))
    }

    fn is_expired(&self, now: Instant, idle_ttl: Duration) -> Result<bool, AppError> {
        let expired = now.saturating_duration_since(self.last_accessed_at()?) >= idle_ttl;
        Ok(expired && self.active_queries.load(Ordering::Relaxed) == 0)
    }

    fn begin_query(&self) -> Result<PreparedSessionQueryGuard<'_>, AppError> {
        self.touch()?;
        self.active_queries.fetch_add(1, Ordering::Relaxed);
        Ok(PreparedSessionQueryGuard { session: self })
    }
}

struct PreparedSessionQueryGuard<'a> {
    session: &'a PreparedSessionEntry,
}

impl Drop for PreparedSessionQueryGuard<'_> {
    fn drop(&mut self) {
        self.session.active_queries.fetch_sub(1, Ordering::Relaxed);
        let _ = self.session.touch();
    }
}

#[derive(Default)]
struct QuerySessionRegistry {
    sessions_by_id: HashMap<String, Arc<PreparedSessionEntry>>,
    session_id_by_signature: HashMap<String, String>,
    displayed_session_id_by_dataset: HashMap<String, String>,
}

struct ActiveRequestGuard<'a> {
    requests: &'a Mutex<HashMap<String, Arc<InterruptHandle>>>,
    request_id: String,
}

impl Drop for ActiveRequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.request_id);
        }
    }
}

pub struct TableNavigationService {
    readers: Vec<TableNavigationReader>,
    session_clone_source: Mutex<DuckDbEngine>,
    next_reader: AtomicUsize,
    active_requests: Mutex<HashMap<String, Arc<InterruptHandle>>>,
    query_sessions: Mutex<QuerySessionRegistry>,
    policy: TableNavigationPolicy,
}

impl TableNavigationService {
    pub fn new(engine: &DuckDbEngine, reader_count: usize) -> Result<Self, AppError> {
        Self::new_with_policy(engine, reader_count, TableNavigationPolicy::default())
    }

    fn new_with_policy(
        engine: &DuckDbEngine,
        reader_count: usize,
        policy: TableNavigationPolicy,
    ) -> Result<Self, AppError> {
        if reader_count == 0 {
            return Err(AppError::InvalidParam(
                "table navigation reader count must be at least 1".into(),
            ));
        }
        let mut readers = Vec::with_capacity(reader_count);
        for _ in 0..reader_count {
            let reader_engine = engine.try_clone()?;
            let interrupt_handle = reader_engine.conn().interrupt_handle();
            readers.push(TableNavigationReader {
                engine: Mutex::new(reader_engine),
                interrupt_handle,
            });
        }
        Ok(Self {
            readers,
            session_clone_source: Mutex::new(engine.try_clone()?),
            next_reader: AtomicUsize::new(0),
            active_requests: Mutex::new(HashMap::new()),
            query_sessions: Mutex::new(QuerySessionRegistry::default()),
            policy,
        })
    }

    pub fn prepare_table_query_session(
        &self,
        request: &TableQuerySessionRequest,
    ) -> Result<TableQuerySessionStatus, AppError> {
        if request.sort.is_none() && request.filters.is_empty() {
            return Err(AppError::InvalidParam(
                "natural-order navigation does not use prepared sessions".into(),
            ));
        }

        let signature = Self::build_query_session_signature(request)?;
        let current_generation = self.current_generation(&request.dataset_id)?;
        if current_generation != request.generation {
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {current_generation}, received {}",
                request.generation
            )));
        }

        self.sweep_released_and_expired_sessions()?;

        if let Some(reused) = self.find_session_by_signature(&signature)? {
            reused.touch()?;
            return reused.status();
        }

        let session_engine = self
            .session_clone_source
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .try_clone()?;
        let interrupt_handle = session_engine.conn().interrupt_handle();
        let session_id = Uuid::new_v4().to_string();
        let session = Arc::new(PreparedSessionEntry::new(
            session_id.clone(),
            request.dataset_id.clone(),
            request.generation,
            signature.clone(),
            session_engine,
            interrupt_handle,
        ));

        let evicted = {
            let mut registry = self
                .query_sessions
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            registry
                .session_id_by_signature
                .insert(signature, session_id.clone());
            registry
                .sessions_by_id
                .insert(session_id.clone(), Arc::clone(&session));
            let now = Instant::now();
            let victims = self.collect_dataset_quota_victims(
                &mut registry,
                &request.dataset_id,
                Some(&session_id),
                now,
            )?;
            self.collect_byte_budget_victims(&mut registry, Some(&session_id), victims, now)?
        };
        for entry in evicted {
            self.release_session_entry(entry)?;
        }

        self.spawn_prepare_session(Arc::clone(&session), request.clone());
        session.status()
    }

    pub fn get_table_query_session_status(
        &self,
        session_id: &str,
    ) -> Result<TableQuerySessionStatus, AppError> {
        self.sweep_released_and_expired_sessions()?;
        let session = self.get_session(session_id)?;
        if session.is_expired(Instant::now(), self.policy.idle_ttl)? {
            self.release_table_query_session(session_id)?;
            return Err(AppError::InvalidParam(format!(
                "unknown table query session: {session_id}"
            )));
        }
        if !self.session_generation_current(&session)? {
            self.release_table_query_session(session_id)?;
            return Err(AppError::InvalidParam(format!(
                "unknown table query session: {session_id}"
            )));
        }
        session.touch()?;
        let status = session.status()?;
        self.sweep_sessions_under_pressure(Some(session_id))?;
        Ok(status)
    }

    pub fn release_table_query_session(&self, session_id: &str) -> Result<(), AppError> {
        let session = {
            let mut registry = self
                .query_sessions
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            self.remove_session_locked(&mut registry, session_id)
        };
        if let Some(session) = session {
            self.release_session_entry(session)?;
        }
        Ok(())
    }

    pub fn query_table_navigation_window(
        &self,
        request: &TableNavigationRequest,
    ) -> Result<TableNavigationResult, AppError> {
        if Self::can_handle(request) {
            let reader_index =
                self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
            let reader = self.readers[reader_index]
                .engine
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let _active_request = self.register_active_request(
                request.request_id.clone(),
                Arc::clone(&self.readers[reader_index].interrupt_handle),
            )?;
            return DuckDbEngine::query_natural_navigation_window(reader.conn(), request)
                .map_err(|error| Self::map_interrupted_query_error(&request.request_id, error));
        }

        let session_id = request.session_id.as_deref().ok_or_else(|| {
            AppError::InvalidParam(
                "sorted or filtered navigation requires a prepared table query session".into(),
            )
        })?;
        self.sweep_released_and_expired_sessions()?;
        let session = self.get_session(session_id)?;
        if session.is_expired(Instant::now(), self.policy.idle_ttl)? {
            self.release_table_query_session(session_id)?;
            return Err(AppError::InvalidParam(format!(
                "unknown table query session: {session_id}"
            )));
        }
        if !self.session_generation_current(&session)? {
            self.release_table_query_session(session_id)?;
            return Err(AppError::InvalidParam(format!(
                "stale dataset generation: expected {}, received {}",
                self.current_generation(&request.dataset_id)?,
                request.generation
            )));
        }
        let request_signature = Self::build_navigation_request_signature(request)?;
        if request_signature != session.signature {
            return Err(AppError::InvalidParam(format!(
                "table query session {session_id} does not match the requested signature"
            )));
        }
        let Some(ready_state) = session.ready_state()? else {
            if let Some(message) = session.failure_message()? {
                return Err(AppError::Database(message));
            }
            let status = session.status()?;
            return match status.state {
                TableQuerySessionState::Preparing => Err(AppError::Busy(format!(
                    "table query session {session_id} is still preparing"
                ))),
                TableQuerySessionState::Cancelled => Err(AppError::Cancelled(format!(
                    "table query session {session_id} was cancelled"
                ))),
                TableQuerySessionState::Failed => Err(AppError::Database(format!(
                    "table query session {session_id} failed"
                ))),
                TableQuerySessionState::Ready => Err(AppError::Database(format!(
                    "table query session {session_id} is missing ready state"
                ))),
            };
        };

        let _query_guard = session.begin_query()?;
        let session_engine = session
            .engine
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let _active_request = self.register_active_request(
            request.request_id.clone(),
            Arc::clone(&session.interrupt_handle),
        )?;
        let result = DuckDbEngine::query_prepared_table_navigation_window_on_connection(
            session_engine.conn(),
            request,
            &session.mapping_table_name,
            &ready_state.projection,
            ready_state.total_rows,
        )
        .map_err(|error| Self::map_interrupted_query_error(&request.request_id, error))?;
        self.mark_displayed_session(&session)?;
        self.sweep_sessions_under_pressure(Some(session_id))?;
        Ok(result)
    }

    pub fn cancel_request(&self, request_id: &str) -> Result<(), AppError> {
        let interrupt_handle = self
            .active_requests
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .get(request_id)
            .cloned();
        if let Some(interrupt_handle) = interrupt_handle {
            interrupt_handle.interrupt();
        }
        Ok(())
    }

    pub fn can_handle(request: &TableNavigationRequest) -> bool {
        request.sort.is_none() && request.filters.is_empty()
    }

    fn current_generation(&self, dataset_id: &str) -> Result<u64, AppError> {
        self.session_clone_source
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .get_dataset_generation(dataset_id)
    }

    fn find_session_by_signature(
        &self,
        signature: &str,
    ) -> Result<Option<Arc<PreparedSessionEntry>>, AppError> {
        let mut registry = self
            .query_sessions
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(session_id) = registry.session_id_by_signature.get(signature).cloned() else {
            return Ok(None);
        };
        if let Some(session) = registry.sessions_by_id.get(&session_id).cloned() {
            if session.released.load(Ordering::Relaxed)
                || session.is_expired(Instant::now(), self.policy.idle_ttl)?
            {
                let removed = self.remove_session_locked(&mut registry, &session_id);
                drop(registry);
                if let Some(removed) = removed {
                    self.release_session_entry(removed)?;
                }
                return Ok(None);
            }
            return Ok(Some(session));
        }
        registry.session_id_by_signature.remove(signature);
        Ok(None)
    }

    fn get_session(&self, session_id: &str) -> Result<Arc<PreparedSessionEntry>, AppError> {
        self.query_sessions
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .sessions_by_id
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::InvalidParam(format!("unknown table query session: {session_id}"))
            })
    }

    fn session_generation_current(&self, session: &PreparedSessionEntry) -> Result<bool, AppError> {
        Ok(self.current_generation(&session.dataset_id)? == session.generation)
    }

    fn collect_dataset_quota_victims(
        &self,
        registry: &mut QuerySessionRegistry,
        dataset_id: &str,
        protected_session_id: Option<&str>,
        now: Instant,
    ) -> Result<Vec<Arc<PreparedSessionEntry>>, AppError> {
        let mut victims = Vec::new();
        let mut dataset_sessions = registry
            .sessions_by_id
            .values()
            .filter(|session| session.dataset_id == dataset_id)
            .cloned()
            .collect::<Vec<_>>();
        if dataset_sessions.len() <= self.policy.max_prepared_sessions_per_dataset {
            return Ok(victims);
        }
        dataset_sessions.sort_by_key(|session| session.last_accessed_at().unwrap_or(now));
        for session in dataset_sessions {
            let remaining_for_dataset = registry
                .sessions_by_id
                .values()
                .filter(|entry| entry.dataset_id == dataset_id)
                .count();
            if remaining_for_dataset <= self.policy.max_prepared_sessions_per_dataset {
                break;
            }
            if protected_session_id.is_some_and(|protected| session.session_id == protected) {
                continue;
            }
            if Self::is_displayed_session_locked(registry, &session.session_id) {
                continue;
            }
            if session.active_queries.load(Ordering::Relaxed) > 0 {
                continue;
            }
            if let Some(removed) = self.remove_session_locked(registry, &session.session_id) {
                victims.push(removed);
            }
        }
        Ok(victims)
    }

    fn collect_byte_budget_victims(
        &self,
        registry: &mut QuerySessionRegistry,
        protected_session_id: Option<&str>,
        mut victims: Vec<Arc<PreparedSessionEntry>>,
        now: Instant,
    ) -> Result<Vec<Arc<PreparedSessionEntry>>, AppError> {
        let mut retained_bytes = registry
            .sessions_by_id
            .values()
            .fold(0usize, |total, session| {
                total.saturating_add(session.measured_bytes_estimate.load(Ordering::Relaxed))
            });
        if retained_bytes <= self.policy.max_measured_bytes_budget {
            return Ok(victims);
        }

        let mut lru_sessions = registry
            .sessions_by_id
            .values()
            .cloned()
            .collect::<Vec<_>>();
        lru_sessions.sort_by_key(|session| session.last_accessed_at().unwrap_or(now));
        for session in lru_sessions {
            if retained_bytes <= self.policy.max_measured_bytes_budget {
                break;
            }
            if protected_session_id.is_some_and(|protected| session.session_id == protected) {
                continue;
            }
            if Self::is_displayed_session_locked(registry, &session.session_id) {
                continue;
            }
            if session.active_queries.load(Ordering::Relaxed) > 0 {
                continue;
            }
            if let Some(removed) = self.remove_session_locked(registry, &session.session_id) {
                retained_bytes = retained_bytes
                    .saturating_sub(removed.measured_bytes_estimate.load(Ordering::Relaxed));
                victims.push(removed);
            }
        }

        Ok(victims)
    }

    fn sweep_sessions_under_pressure(
        &self,
        protected_session_id: Option<&str>,
    ) -> Result<(), AppError> {
        self.sweep_released_and_expired_sessions()?;
        let victims = {
            let mut registry = self
                .query_sessions
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let now = Instant::now();
            let mut victims = Vec::new();
            let mut dataset_ids = registry
                .sessions_by_id
                .values()
                .map(|session| session.dataset_id.clone())
                .collect::<Vec<_>>();
            dataset_ids.sort();
            dataset_ids.dedup();
            for dataset_id in dataset_ids {
                victims.extend(self.collect_dataset_quota_victims(
                    &mut registry,
                    &dataset_id,
                    protected_session_id,
                    now,
                )?);
            }
            self.collect_byte_budget_victims(&mut registry, protected_session_id, victims, now)?
        };
        for session in victims {
            self.release_session_entry(session)?;
        }
        Ok(())
    }

    fn remove_session_locked(
        &self,
        registry: &mut QuerySessionRegistry,
        session_id: &str,
    ) -> Option<Arc<PreparedSessionEntry>> {
        let session = registry.sessions_by_id.remove(session_id)?;
        registry
            .session_id_by_signature
            .retain(|_, value| value != session_id);
        let clear_displayed = matches!(
            registry.displayed_session_id_by_dataset.get(&session.dataset_id),
            Some(displayed_session_id) if displayed_session_id == session_id
        );
        if clear_displayed {
            registry
                .displayed_session_id_by_dataset
                .remove(&session.dataset_id);
        }
        Some(session)
    }

    fn is_displayed_session_locked(registry: &QuerySessionRegistry, session_id: &str) -> bool {
        registry
            .displayed_session_id_by_dataset
            .values()
            .any(|displayed_session_id| displayed_session_id == session_id)
    }

    fn mark_displayed_session(&self, session: &PreparedSessionEntry) -> Result<(), AppError> {
        self.query_sessions
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .displayed_session_id_by_dataset
            .insert(session.dataset_id.clone(), session.session_id.clone());
        Ok(())
    }

    fn release_session_entry(&self, session: Arc<PreparedSessionEntry>) -> Result<(), AppError> {
        session.released.store(true, Ordering::Relaxed);
        session.interrupt_handle.interrupt();
        let _ = session.mark_cancelled();
        let engine = session
            .engine
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        DuckDbEngine::release_table_query_session_on_connection(
            engine.conn(),
            &session.mapping_table_name,
            &session.mapping_index_name,
        )
    }

    fn spawn_prepare_session(
        &self,
        session: Arc<PreparedSessionEntry>,
        request: TableQuerySessionRequest,
    ) {
        std::thread::spawn(move || {
            let preparation = (|| -> Result<PreparedTableQuerySessionInfo, AppError> {
                let engine = session
                    .engine
                    .lock()
                    .map_err(|error| AppError::Database(error.to_string()))?;
                DuckDbEngine::prepare_table_query_session_on_connection(
                    engine.conn(),
                    &request,
                    &session.mapping_table_name,
                    &session.mapping_index_name,
                )
            })();
            match preparation {
                Ok(info) => {
                    if session.released.load(Ordering::Relaxed) {
                        if let Ok(engine) = session.engine.lock() {
                            let _ = DuckDbEngine::release_table_query_session_on_connection(
                                engine.conn(),
                                &session.mapping_table_name,
                                &session.mapping_index_name,
                            );
                        }
                        let _ = session.mark_cancelled();
                        return;
                    }
                    let _ = session.mark_ready(info);
                }
                Err(AppError::Database(message))
                    if message.to_ascii_uppercase().contains("INTERRUPT") =>
                {
                    let _ = session.mark_cancelled();
                    if let Ok(engine) = session.engine.lock() {
                        let _ = DuckDbEngine::release_table_query_session_on_connection(
                            engine.conn(),
                            &session.mapping_table_name,
                            &session.mapping_index_name,
                        );
                    }
                }
                Err(error) => {
                    let _ = session.mark_failed(error.to_string());
                    if let Ok(engine) = session.engine.lock() {
                        let _ = DuckDbEngine::release_table_query_session_on_connection(
                            engine.conn(),
                            &session.mapping_table_name,
                            &session.mapping_index_name,
                        );
                    }
                }
            }
        });
    }

    fn build_query_session_signature(
        request: &TableQuerySessionRequest,
    ) -> Result<String, AppError> {
        let dataset_id = Self::normalize_signature_identifier(&request.dataset_id, "dataset id")?;
        let filters = Self::canonicalize_filters(&request.filters)?;
        let sort = Self::canonicalize_sort(&request.sort)?;
        let projection = request
            .column_ids
            .iter()
            .map(|column_id| Self::normalize_signature_identifier(column_id, "column id"))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        Ok(format!(
            "{}|{}|{}|{}|{}",
            dataset_id, request.generation, filters, sort, projection
        ))
    }

    fn build_navigation_request_signature(
        request: &TableNavigationRequest,
    ) -> Result<String, AppError> {
        Self::build_query_session_signature(&TableQuerySessionRequest {
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            sort: request.sort.clone(),
            filters: request.filters.clone(),
            column_ids: request.column_ids.clone(),
        })
    }

    fn normalize_signature_identifier(value: &str, label: &str) -> Result<String, AppError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidParam(format!(
                "table query session {label} must not be empty"
            )));
        }
        Ok(trimmed.to_string())
    }

    fn canonicalize_sort(sort: &Option<TableWindowSort>) -> Result<String, AppError> {
        let Some(sort) = sort else {
            return Ok("_row_id:asc".to_string());
        };
        let column = Self::normalize_signature_identifier(&sort.column, "sort column")?;
        let direction = if sort.descending { "desc" } else { "asc" };
        if column == "_row_id" {
            return Ok(format!("_row_id:{direction}"));
        }
        Ok(format!("{column}:{direction},_row_id:asc"))
    }

    fn canonicalize_filters(filters: &[TableWindowFilter]) -> Result<String, AppError> {
        let mut normalized = filters
            .iter()
            .map(Self::canonicalize_filter)
            .collect::<Result<Vec<_>, _>>()?;
        if normalized.len() > 1 {
            let first_op = normalized[0].0.clone();
            if normalized.iter().all(|(op, _)| op == &first_op) {
                normalized.sort_by(|left, right| left.1.cmp(&right.1));
            }
        }
        serde_json::to_string(&normalized)
            .map_err(|error| AppError::InvalidParam(error.to_string()))
    }

    fn canonicalize_filter(filter: &TableWindowFilter) -> Result<(String, String), AppError> {
        let op = match filter.op.trim().to_ascii_uppercase().as_str() {
            "AND" => "AND".to_string(),
            "OR" => "OR".to_string(),
            other => {
                return Err(AppError::InvalidParam(format!(
                    "unknown filter operator: {other}"
                )))
            }
        };
        let rule = match &filter.rule {
            TableWindowFilterRule::Continuous { field, min, max } => serde_json::json!({
                "kind": "continuous",
                "field": Self::normalize_signature_identifier(field, "filter field")?,
                "min": min,
                "max": max,
            }),
            TableWindowFilterRule::Categorical {
                field,
                selected,
                exclude,
            } => {
                let mut selected = selected.clone();
                selected.sort();
                selected.dedup();
                serde_json::json!({
                    "kind": "categorical",
                    "field": Self::normalize_signature_identifier(field, "filter field")?,
                    "selected": selected,
                    "exclude": exclude,
                })
            }
            TableWindowFilterRule::Date { field, start, end } => serde_json::json!({
                "kind": "date",
                "field": Self::normalize_signature_identifier(field, "filter field")?,
                "start": start,
                "end": end,
            }),
        };
        Ok((op, rule.to_string()))
    }

    fn sweep_released_and_expired_sessions(&self) -> Result<(), AppError> {
        let expired = {
            let mut registry = self
                .query_sessions
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let now = Instant::now();
            let mut session_ids = Vec::new();
            for session in registry.sessions_by_id.values() {
                if session.released.load(Ordering::Relaxed)
                    || session.is_expired(now, self.policy.idle_ttl)?
                {
                    session_ids.push(session.session_id.clone());
                }
            }
            session_ids
                .into_iter()
                .filter_map(|session_id| self.remove_session_locked(&mut registry, &session_id))
                .collect::<Vec<_>>()
        };
        for session in expired {
            self.release_session_entry(session)?;
        }
        Ok(())
    }

    fn register_active_request(
        &self,
        request_id: String,
        interrupt_handle: Arc<InterruptHandle>,
    ) -> Result<ActiveRequestGuard<'_>, AppError> {
        self.active_requests
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .insert(request_id.clone(), interrupt_handle);
        Ok(ActiveRequestGuard {
            requests: &self.active_requests,
            request_id,
        })
    }

    fn map_interrupted_query_error(request_id: &str, error: AppError) -> AppError {
        match error {
            AppError::Database(message) if message.to_ascii_uppercase().contains("INTERRUPT") => {
                AppError::Cancelled(format!(
                    "table navigation request {request_id} was cancelled"
                ))
            }
            other => other,
        }
    }

    #[cfg(test)]
    pub(crate) fn reader_count_for_test(&self) -> usize {
        self.readers.len()
    }

    #[cfg(test)]
    fn execute_interruptible_test_query(
        &self,
        request_id: &str,
        sql: &str,
    ) -> Result<(), AppError> {
        let reader_index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let reader = self.readers[reader_index]
            .engine
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let _active_request = self.register_active_request(
            request_id.to_string(),
            Arc::clone(&self.readers[reader_index].interrupt_handle),
        )?;
        reader
            .conn()
            .query_row(sql, [], |_row| Ok(()))
            .map_err(AppError::from)
            .map_err(|error| Self::map_interrupted_query_error(request_id, error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::table::{
        CreateTableFromRowsRequest, TableNavigationRequest, TableQuerySessionRequest,
        TableQuerySessionStatus, TableWindowFilter, TableWindowFilterRule, TableWindowSort,
    };
    use crate::services::data_service::DataService;
    use crate::state::AppState;
    use duckdb::params;
    use std::sync::Arc;
    use std::time::Duration;

    fn wait_for_ready_status(
        service: &TableNavigationService,
        session_id: &str,
    ) -> Result<TableQuerySessionStatus, AppError> {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let status = service.get_table_query_session_status(session_id)?;
            match status.state.as_str() {
                "ready" | "cancelled" | "failed" => return Ok(status),
                _ => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(AppError::Busy(format!(
                    "timed out waiting for table query session {session_id}"
                )));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_ready_status_without_sweep(
        service: &TableNavigationService,
        session_id: &str,
    ) -> Result<TableQuerySessionStatus, AppError> {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let status = service.get_session(session_id)?.status()?;
            match status.state.as_str() {
                "ready" | "cancelled" | "failed" => return Ok(status),
                _ => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(AppError::Busy(format!(
                    "timed out waiting for table query session {session_id}"
                )));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn set_measured_session_bytes(
        service: &TableNavigationService,
        session_id: &str,
        measured_bytes: usize,
    ) {
        service
            .get_session(session_id)
            .expect("session")
            .measured_bytes_estimate
            .store(measured_bytes, Ordering::Relaxed);
    }

    fn build_filtered_session_request(
        dataset_id: &str,
        generation: u64,
        column_ids: &[String],
    ) -> TableQuerySessionRequest {
        TableQuerySessionRequest {
            dataset_id: dataset_id.to_string(),
            generation,
            sort: Some(TableWindowSort {
                column: "value".to_string(),
                descending: true,
            }),
            filters: vec![
                TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Continuous {
                        field: "value".to_string(),
                        min: Some(10.0),
                        max: Some(25.0),
                    },
                },
                TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "category".to_string(),
                        selected: vec!["A".to_string()],
                        exclude: false,
                    },
                },
                TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Date {
                        field: "stamp".to_string(),
                        start: Some("2026-01-01".to_string()),
                        end: Some("2026-01-31".to_string()),
                    },
                },
            ],
            column_ids: column_ids.to_vec(),
        }
    }

    #[test]
    fn natural_navigation_service_builds_requested_reader_pool() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");

        let service = TableNavigationService::new(&engine, 2).expect("navigation service");

        assert_eq!(service.reader_count_for_test(), 2);
    }

    #[test]
    fn natural_navigation_state_uses_shared_service_without_global_query_mutex() {
        let state = AppState::new().expect("state");

        let state_type = std::any::type_name_of_val(&state.table_navigation);

        assert!(state_type.contains("RwLock"), "{state_type}");
        assert!(state_type.contains("Arc"), "{state_type}");
        assert!(!state_type.contains("Mutex"), "{state_type}");
    }

    #[test]
    fn natural_navigation_service_reads_tables_created_after_reader_clone_and_after_reset() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);

        let first = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "First".to_string(),
                column_names: vec!["value".to_string()],
                column_types: vec!["BIGINT".to_string()],
                rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            })
            .expect("create first table");
        let first_value_id = service
            .get_column_descriptors(&first.id)
            .expect("first columns")[0]
            .column_id
            .clone();
        let first_result = service
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-first".to_string(),
                dataset_id: first.id.clone(),
                generation: first.generation,
                start: 1,
                count: 1,
                column_ids: vec![first_value_id],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect("query first table through cloned reader");
        assert_eq!(
            first_result.rows,
            vec![vec![serde_json::json!(2), serde_json::json!(2)]]
        );

        state.reset_db().expect("reset state");
        let after_reset = DataService::new(&state)
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "After reset".to_string(),
                column_names: vec!["value".to_string()],
                column_types: vec!["BIGINT".to_string()],
                rows: vec![vec![serde_json::json!(9)]],
            })
            .expect("create table after reset");
        let reset_service = DataService::new(&state);
        let reset_value_id = reset_service
            .get_column_descriptors(&after_reset.id)
            .expect("reset columns")[0]
            .column_id
            .clone();
        let reset_result = reset_service
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-reset".to_string(),
                dataset_id: after_reset.id,
                generation: after_reset.generation,
                start: 0,
                count: 1,
                column_ids: vec![reset_value_id],
                sort: None,
                filters: vec![],
                session_id: None,
                include_transport_diagnostics: false,
            })
            .expect("query reset table through replacement cloned reader");
        assert_eq!(
            reset_result.rows,
            vec![vec![serde_json::json!(1), serde_json::json!(9)]]
        );
    }

    #[test]
    fn interrupts_obsolete_request() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        let service =
            Arc::new(TableNavigationService::new(&engine, 1).expect("navigation service"));
        let obsolete_service = Arc::clone(&service);

        let obsolete = std::thread::spawn(move || {
            obsolete_service.execute_interruptible_test_query(
                "req-obsolete",
                "select count(*) from range(10000000) t1, range(1000000) t2",
            )
        });

        std::thread::sleep(Duration::from_millis(100));
        service
            .cancel_request("req-obsolete")
            .expect("cancel obsolete request must succeed");

        let obsolete_result = obsolete.join().expect("join obsolete request thread");
        assert!(
            matches!(obsolete_result, Err(AppError::Cancelled(message)) if message.contains("req-obsolete"))
        );

        service
            .execute_interruptible_test_query("req-latest", "select 1")
            .expect("latest request should reuse the interrupted worker");
    }

    #[test]
    fn cancel_request_is_idempotent_for_unknown_and_finished_ids() {
        let engine = DuckDbEngine::new_in_memory().expect("engine");
        let service = TableNavigationService::new(&engine, 1).expect("navigation service");

        service
            .cancel_request("req-unknown")
            .expect("unknown request cancellation must be a no-op");

        service
            .execute_interruptible_test_query("req-finished", "select 1")
            .expect("finished request must complete");

        service
            .cancel_request("req-finished")
            .expect("finished request cancellation must be a no-op");
        service
            .cancel_request("req-finished")
            .expect("repeated finished request cancellation must stay idempotent");
    }

    #[test]
    fn table_query_session_prepare_reuses_signature_and_serves_exact_window() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Session dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(5),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-02"),
                    ],
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-03"),
                    ],
                    vec![
                        serde_json::json!(15),
                        serde_json::json!("B"),
                        serde_json::json!("2026-01-04"),
                    ],
                    vec![
                        serde_json::json!(10),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-05"),
                    ],
                    vec![
                        serde_json::json!(25),
                        serde_json::json!("A"),
                        serde_json::json!("2026-02-01"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let column_ids = vec![
            descriptors[2].column_id.clone(),
            descriptors[0].column_id.clone(),
        ];
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();

        let session_request =
            build_filtered_session_request(&dataset.id, dataset.generation, &column_ids);
        let prepared = navigation
            .prepare_table_query_session(&session_request)
            .expect("prepare session");
        let ready = wait_for_ready_status(&navigation, &prepared.session_id).expect("ready status");

        assert_eq!(ready.state.as_str(), "ready");
        assert_eq!(ready.total_rows, Some(3));

        let reused = navigation
            .prepare_table_query_session(&session_request)
            .expect("reuse session");
        assert_eq!(reused.session_id, prepared.session_id);

        let window = service
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-session-window".to_string(),
                dataset_id: dataset.id.clone(),
                generation: dataset.generation,
                start: 0,
                count: 3,
                column_ids,
                sort: session_request.sort.clone(),
                filters: session_request.filters.clone(),
                session_id: Some(prepared.session_id.clone()),
                include_transport_diagnostics: false,
            })
            .expect("query through session");

        assert_eq!(window.total_rows, 3);
        assert!(window.total_rows_exact);
        assert_eq!(
            window.session_id.as_deref(),
            Some(prepared.session_id.as_str())
        );
        assert_eq!(window.columns, vec!["_row_id", "stamp", "value"]);
        assert_eq!(window.rows.len(), 3);
        assert_eq!(
            window.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!("2026-01-01"),
                serde_json::json!(20)
            ]
        );
        assert_eq!(
            window.rows[1],
            vec![
                serde_json::json!(3),
                serde_json::json!("2026-01-03"),
                serde_json::json!(20)
            ]
        );
        assert_eq!(
            window.rows[2],
            vec![
                serde_json::json!(5),
                serde_json::json!("2026-01-05"),
                serde_json::json!(10)
            ]
        );
    }

    #[test]
    fn table_query_session_release_and_generation_change_invalidate_sessions() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Invalidate session dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-03"),
                    ],
                    vec![
                        serde_json::json!(10),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-05"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let column_ids = vec![descriptors[0].column_id.clone()];
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();

        let session_request =
            build_filtered_session_request(&dataset.id, dataset.generation, &column_ids);
        let prepared = navigation
            .prepare_table_query_session(&session_request)
            .expect("prepare session");
        let ready = wait_for_ready_status(&navigation, &prepared.session_id).expect("ready status");
        assert_eq!(ready.state.as_str(), "ready");

        navigation
            .release_table_query_session(&prepared.session_id)
            .expect("release session");
        assert!(matches!(
            navigation.get_table_query_session_status(&prepared.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));

        let second = navigation
            .prepare_table_query_session(&session_request)
            .expect("prepare replacement session");
        let second_ready =
            wait_for_ready_status(&navigation, &second.session_id).expect("replacement ready");
        assert_eq!(second_ready.state.as_str(), "ready");

        service
            .update_cell(&dataset.id, 1, "value", "22")
            .expect("mutate dataset");

        let new_generation = service
            .get_dataset_generation(&dataset.id)
            .expect("next generation");
        assert!(new_generation > dataset.generation);
        assert!(matches!(
            navigation.get_table_query_session_status(&second.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
    }

    #[test]
    fn table_query_session_reuses_equivalent_reordered_and_filters() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Equivalent filter dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(15),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-02"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let column_ids = vec![descriptors[0].column_id.clone()];
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();

        let first = build_filtered_session_request(&dataset.id, dataset.generation, &column_ids);
        let second = TableQuerySessionRequest {
            dataset_id: dataset.id.clone(),
            generation: dataset.generation,
            sort: first.sort.clone(),
            filters: vec![
                first.filters[2].clone(),
                first.filters[0].clone(),
                first.filters[1].clone(),
            ],
            column_ids,
        };

        let prepared_first = navigation
            .prepare_table_query_session(&first)
            .expect("prepare first session");
        let prepared_second = navigation
            .prepare_table_query_session(&second)
            .expect("prepare reordered equivalent session");

        assert_eq!(prepared_second.session_id, prepared_first.session_id);
    }

    #[test]
    fn table_query_session_status_boundary_evicts_expired_session() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Expired status dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(10),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-02"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();
        let request = build_filtered_session_request(
            &dataset.id,
            dataset.generation,
            &[descriptors[0].column_id.clone()],
        );

        let prepared = navigation
            .prepare_table_query_session(&request)
            .expect("prepare session");
        let ready = wait_for_ready_status(&navigation, &prepared.session_id).expect("ready status");
        assert_eq!(ready.state.as_str(), "ready");

        {
            let registry = navigation.query_sessions.lock().expect("registry lock");
            let session = registry
                .sessions_by_id
                .get(&prepared.session_id)
                .expect("session entry");
            *session.last_accessed.lock().expect("last accessed") =
                Instant::now() - PREPARED_SESSION_IDLE_TTL - Duration::from_secs(1);
        }

        assert!(matches!(
            navigation.get_table_query_session_status(&prepared.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
    }

    #[test]
    fn table_query_session_query_boundary_evicts_expired_session() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Expired query dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(10),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-02"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let column_ids = vec![descriptors[0].column_id.clone()];
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();
        let request = build_filtered_session_request(&dataset.id, dataset.generation, &column_ids);

        let prepared = navigation
            .prepare_table_query_session(&request)
            .expect("prepare session");
        let ready = wait_for_ready_status(&navigation, &prepared.session_id).expect("ready status");
        assert_eq!(ready.state.as_str(), "ready");

        {
            let registry = navigation.query_sessions.lock().expect("registry lock");
            let session = registry
                .sessions_by_id
                .get(&prepared.session_id)
                .expect("session entry");
            *session.last_accessed.lock().expect("last accessed") =
                Instant::now() - PREPARED_SESSION_IDLE_TTL - Duration::from_secs(1);
        }

        assert!(matches!(
            service.query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-expired-query".to_string(),
                dataset_id: dataset.id,
                generation: dataset.generation,
                start: 0,
                count: 1,
                column_ids,
                sort: request.sort.clone(),
                filters: request.filters.clone(),
                session_id: Some(prepared.session_id.clone()),
                include_transport_diagnostics: false,
            }),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
    }

    #[test]
    fn table_query_session_enforces_measured_byte_budget_with_lru_idle_eviction() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let filtered_row_count = 8_192usize;
        let logical_bytes_floor = filtered_row_count
            .checked_mul(std::mem::size_of::<i64>() * 2)
            .expect("logical bytes floor");

        let make_dataset = |name: &str| {
            let rows = (0..filtered_row_count)
                .map(|index| {
                    vec![
                        serde_json::json!(10 + (index % 10) as i64),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ]
                })
                .collect::<Vec<_>>();
            service
                .create_table_from_rows(&CreateTableFromRowsRequest {
                    name: name.to_string(),
                    column_names: vec![
                        "value".to_string(),
                        "category".to_string(),
                        "stamp".to_string(),
                    ],
                    column_types: vec![
                        "BIGINT".to_string(),
                        "VARCHAR".to_string(),
                        "DATE".to_string(),
                    ],
                    rows,
                })
                .expect("create dataset")
        };

        let first_dataset = make_dataset("Byte budget first");
        let second_dataset = make_dataset("Byte budget second");
        let third_dataset = make_dataset("Byte budget third");

        let first_columns = service
            .get_column_descriptors(&first_dataset.id)
            .expect("first columns");
        let second_columns = service
            .get_column_descriptors(&second_dataset.id)
            .expect("second columns");
        let third_columns = service
            .get_column_descriptors(&third_dataset.id)
            .expect("third columns");

        let budget = logical_bytes_floor
            .saturating_mul(2)
            .saturating_add(logical_bytes_floor / 2)
            .max(1);

        let navigation = {
            let db = state.db.lock().expect("db lock");
            TableNavigationService::new_with_policy(
                &db,
                1,
                TableNavigationPolicy {
                    max_prepared_sessions_per_dataset: MAX_PREPARED_SESSIONS_PER_DATASET,
                    max_measured_bytes_budget: budget,
                    idle_ttl: PREPARED_SESSION_IDLE_TTL,
                },
            )
            .expect("navigation service")
        };

        let first = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &first_dataset.id,
                first_dataset.generation,
                &[first_columns[0].column_id.clone()],
            ))
            .expect("prepare first");
        let _ = wait_for_ready_status_without_sweep(&navigation, &first.session_id)
            .expect("first ready");
        set_measured_session_bytes(&navigation, &first.session_id, logical_bytes_floor);
        let second = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &second_dataset.id,
                second_dataset.generation,
                &[second_columns[0].column_id.clone()],
            ))
            .expect("prepare second");
        let _ = wait_for_ready_status_without_sweep(&navigation, &second.session_id)
            .expect("second ready");
        set_measured_session_bytes(&navigation, &second.session_id, logical_bytes_floor);

        {
            let registry = navigation.query_sessions.lock().expect("registry lock");
            let first_entry = registry
                .sessions_by_id
                .get(&first.session_id)
                .expect("first entry");
            let second_entry = registry
                .sessions_by_id
                .get(&second.session_id)
                .expect("second entry");
            assert!(first_entry.measured_bytes_estimate.load(Ordering::Relaxed) > 0);
            assert!(second_entry.measured_bytes_estimate.load(Ordering::Relaxed) > 0);
            *first_entry
                .last_accessed
                .lock()
                .expect("first last accessed") = Instant::now() - Duration::from_secs(2);
            *second_entry
                .last_accessed
                .lock()
                .expect("second last accessed") = Instant::now() - Duration::from_secs(1);
        }

        let _third = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &third_dataset.id,
                third_dataset.generation,
                &[third_columns[0].column_id.clone()],
            ))
            .expect("prepare third");
        let _ = wait_for_ready_status_without_sweep(&navigation, &_third.session_id)
            .expect("third ready");
        set_measured_session_bytes(&navigation, &_third.session_id, logical_bytes_floor);
        let _ = navigation
            .get_table_query_session_status(&_third.session_id)
            .expect("third status should trigger budget eviction");

        assert!(matches!(
            navigation.get_table_query_session_status(&first.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
        assert!(navigation
            .get_table_query_session_status(&second.session_id)
            .is_ok());
    }

    #[test]
    fn table_query_session_protects_the_displayed_session_during_budget_eviction() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let filtered_row_count = 8_192usize;
        let logical_bytes_floor = filtered_row_count
            .checked_mul(std::mem::size_of::<i64>() * 2)
            .expect("logical bytes floor");

        let make_dataset = |name: &str| {
            let rows = (0..filtered_row_count)
                .map(|index| {
                    vec![
                        serde_json::json!(10 + (index % 10) as i64),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ]
                })
                .collect::<Vec<_>>();
            service
                .create_table_from_rows(&CreateTableFromRowsRequest {
                    name: name.to_string(),
                    column_names: vec![
                        "value".to_string(),
                        "category".to_string(),
                        "stamp".to_string(),
                    ],
                    column_types: vec![
                        "BIGINT".to_string(),
                        "VARCHAR".to_string(),
                        "DATE".to_string(),
                    ],
                    rows,
                })
                .expect("create dataset")
        };

        let first_dataset = make_dataset("Displayed first");
        let second_dataset = make_dataset("Displayed second");
        let third_dataset = make_dataset("Displayed third");

        let first_columns = service
            .get_column_descriptors(&first_dataset.id)
            .expect("first columns");
        let second_columns = service
            .get_column_descriptors(&second_dataset.id)
            .expect("second columns");
        let third_columns = service
            .get_column_descriptors(&third_dataset.id)
            .expect("third columns");

        let budget = logical_bytes_floor
            .saturating_mul(2)
            .saturating_add(logical_bytes_floor / 2)
            .max(1);

        let navigation = {
            let db = state.db.lock().expect("db lock");
            TableNavigationService::new_with_policy(
                &db,
                1,
                TableNavigationPolicy {
                    max_prepared_sessions_per_dataset: MAX_PREPARED_SESSIONS_PER_DATASET,
                    max_measured_bytes_budget: budget,
                    idle_ttl: PREPARED_SESSION_IDLE_TTL,
                },
            )
            .expect("navigation service")
        };

        let first = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &first_dataset.id,
                first_dataset.generation,
                &[first_columns[0].column_id.clone()],
            ))
            .expect("prepare first");
        let _ = wait_for_ready_status_without_sweep(&navigation, &first.session_id)
            .expect("first ready");
        set_measured_session_bytes(&navigation, &first.session_id, logical_bytes_floor);
        let second = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &second_dataset.id,
                second_dataset.generation,
                &[second_columns[0].column_id.clone()],
            ))
            .expect("prepare second");
        let _ = wait_for_ready_status_without_sweep(&navigation, &second.session_id)
            .expect("second ready");
        set_measured_session_bytes(&navigation, &second.session_id, logical_bytes_floor);

        let displayed_window = navigation
            .query_table_navigation_window(&TableNavigationRequest {
                version: 1,
                request_id: "req-display-first".to_string(),
                dataset_id: first_dataset.id.clone(),
                generation: first_dataset.generation,
                start: 0,
                count: 1,
                column_ids: vec![first_columns[0].column_id.clone()],
                sort: Some(TableWindowSort {
                    column: "value".to_string(),
                    descending: true,
                }),
                filters: build_filtered_session_request(
                    &first_dataset.id,
                    first_dataset.generation,
                    &[first_columns[0].column_id.clone()],
                )
                .filters,
                session_id: Some(first.session_id.clone()),
                include_transport_diagnostics: false,
            })
            .expect("displayed window");
        assert_eq!(
            displayed_window.session_id.as_deref(),
            Some(first.session_id.as_str())
        );

        {
            let registry = navigation.query_sessions.lock().expect("registry lock");
            let first_entry = registry
                .sessions_by_id
                .get(&first.session_id)
                .expect("first entry");
            let second_entry = registry
                .sessions_by_id
                .get(&second.session_id)
                .expect("second entry");
            *first_entry
                .last_accessed
                .lock()
                .expect("first last accessed") = Instant::now() - Duration::from_secs(3);
            *second_entry
                .last_accessed
                .lock()
                .expect("second last accessed") = Instant::now() - Duration::from_secs(1);
        }

        let _third = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &third_dataset.id,
                third_dataset.generation,
                &[third_columns[0].column_id.clone()],
            ))
            .expect("prepare third");
        let _ = wait_for_ready_status_without_sweep(&navigation, &_third.session_id)
            .expect("third ready");
        set_measured_session_bytes(&navigation, &_third.session_id, logical_bytes_floor);
        let _ = navigation
            .get_table_query_session_status(&_third.session_id)
            .expect("third status should trigger budget eviction");

        assert!(navigation
            .get_table_query_session_status(&first.session_id)
            .is_ok());
        assert!(matches!(
            navigation.get_table_query_session_status(&second.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
    }

    #[test]
    fn table_query_session_keeps_two_lru_sessions_per_dataset() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "LRU dataset".to_string(),
                column_names: vec![
                    "value".to_string(),
                    "category".to_string(),
                    "stamp".to_string(),
                ],
                column_types: vec![
                    "BIGINT".to_string(),
                    "VARCHAR".to_string(),
                    "DATE".to_string(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-01"),
                    ],
                    vec![
                        serde_json::json!(10),
                        serde_json::json!("A"),
                        serde_json::json!("2026-01-02"),
                    ],
                ],
            })
            .expect("create dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();

        let first = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &dataset.id,
                dataset.generation,
                &[descriptors[0].column_id.clone()],
            ))
            .expect("prepare first");
        let second = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &dataset.id,
                dataset.generation,
                &[descriptors[1].column_id.clone()],
            ))
            .expect("prepare second");
        let _ = wait_for_ready_status(&navigation, &first.session_id).expect("first ready");
        let _ = wait_for_ready_status(&navigation, &second.session_id).expect("second ready");

        let touched = navigation
            .get_table_query_session_status(&first.session_id)
            .expect("touch first");
        assert_eq!(touched.session_id, first.session_id);

        let third = navigation
            .prepare_table_query_session(&build_filtered_session_request(
                &dataset.id,
                dataset.generation,
                &[descriptors[2].column_id.clone()],
            ))
            .expect("prepare third");
        let _ = wait_for_ready_status(&navigation, &third.session_id).expect("third ready");

        assert!(navigation
            .get_table_query_session_status(&first.session_id)
            .is_ok());
        assert!(matches!(
            navigation.get_table_query_session_status(&second.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));
        assert!(navigation
            .get_table_query_session_status(&third.session_id)
            .is_ok());
    }

    #[test]
    fn table_query_session_release_cancels_preparation_and_cleans_partial_mapping() {
        let state = AppState::new().expect("state");
        {
            let db = state.db.lock().expect("db lock");
            db.seed_benchmark_table("benchmark-session", "Benchmark session", 1_000_000, 3)
                .expect("seed benchmark table");
        }
        let service = DataService::new(&state);
        let dataset = service
            .list_datasets()
            .expect("list datasets")
            .into_iter()
            .find(|entry| entry.id == "benchmark-session")
            .expect("benchmark dataset");
        let descriptors = service
            .get_column_descriptors(&dataset.id)
            .expect("descriptors");
        let navigation = state
            .table_navigation
            .read()
            .expect("navigation lock")
            .clone();
        let request = TableQuerySessionRequest {
            dataset_id: dataset.id.clone(),
            generation: dataset.generation,
            sort: Some(TableWindowSort {
                column: "value_1".to_string(),
                descending: true,
            }),
            filters: vec![],
            column_ids: vec![descriptors[0].column_id.clone()],
        };

        let prepared = navigation
            .prepare_table_query_session(&request)
            .expect("prepare session");
        assert_eq!(prepared.state.as_str(), "preparing");

        let session = {
            let registry = navigation.query_sessions.lock().expect("registry lock");
            registry
                .sessions_by_id
                .get(&prepared.session_id)
                .cloned()
                .expect("session entry")
        };

        navigation
            .release_table_query_session(&prepared.session_id)
            .expect("release session");
        std::thread::sleep(Duration::from_millis(100));

        assert!(matches!(
            navigation.get_table_query_session_status(&prepared.session_id),
            Err(AppError::InvalidParam(message)) if message.contains("unknown table query session")
        ));

        let mapping_table_count: i64 = session
            .engine
            .lock()
            .expect("session engine lock")
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'temp' AND table_name = ?",
                params![session.mapping_table_name.as_str()],
                |row| row.get(0),
            )
            .expect("mapping table count");
        assert_eq!(mapping_table_count, 0);

        let mapping_index_count: i64 = session
            .engine
            .lock()
            .expect("session engine lock")
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM duckdb_indexes() WHERE schema_name = 'temp' AND index_name = ?",
                params![session.mapping_index_name.as_str()],
                |row| row.get(0),
            )
            .expect("mapping index count");
        assert_eq!(mapping_index_count, 0);
    }
}

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use duckdb::InterruptHandle;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::engine::duckdb_engine::{DuckDbEngine, PreparedTabulateSessionInfo};
use crate::error::AppError;
use crate::models::tabulate::{
    TabulateSessionRequest, TabulateSessionState, TabulateSessionStatus,
    TabulateTotalsKind, TabulateTotalsRequest, TabulateTotalsResult,
    TabulateWindowRequest, TabulateWindowResult,
};

struct TabulateSessionPolicy {
    max_sessions_per_dataset: usize,
    max_measured_bytes: usize,
    idle_ttl: Duration,
}

impl Default for TabulateSessionPolicy {
    fn default() -> Self {
        Self {
            max_sessions_per_dataset: 2,
            max_measured_bytes: 256 * 1024 * 1024,
            idle_ttl: Duration::from_secs(300),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, AppError> {
    mutex
        .lock()
        .map_err(|_| AppError::Database("tabulate_session_lock_failed".into()))
}

pub(crate) struct TabulateSessionEntry {
    pub(crate) session_id: String,
    uuid: Uuid,
    pub(crate) request: TabulateSessionRequest,
    pub(crate) fingerprint: String,
    pub(crate) engine: Mutex<DuckDbEngine>,
    pub(crate) interrupt_handle: Arc<InterruptHandle>,
    released: AtomicBool,
    charged_bytes: AtomicUsize,
}

impl TabulateSessionEntry {
    pub(crate) fn row_table_name(&self) -> String {
        DuckDbEngine::tabulate_member_table_names(&self.uuid).0
    }
    pub(crate) fn column_table_name(&self) -> String {
        DuckDbEngine::tabulate_member_table_names(&self.uuid).1
    }
}

struct SessionRecord {
    entry: Arc<TabulateSessionEntry>,
    state: TabulateSessionState,
    info: Option<PreparedTabulateSessionInfo>,
    failure_code: Option<String>,
    leases: usize,
    active_queries: usize,
    last_used: Duration,
}

impl SessionRecord {
    fn evictable(&self) -> bool {
        self.leases == 0
            && self.active_queries == 0
            && self.state != TabulateSessionState::Preparing
    }

    fn status(&self) -> TabulateSessionStatus {
        TabulateSessionStatus {
            session_id: self.entry.session_id.clone(),
            fingerprint: self.entry.fingerprint.clone(),
            source_generation: self.entry.request.source_generation,
            state: self.state.clone(),
            row_member_count: self.info.as_ref().map_or(0, |info| info.row_member_count),
            column_member_count: self
                .info
                .as_ref()
                .map_or(0, |info| info.column_member_count),
            logical_cell_count: self.info.as_ref().map_or(0, |info| info.logical_cell_count),
            measured_member_index_bytes: self
                .info
                .as_ref()
                .map_or(0, |info| info.measured_bytes_estimate as u64),
            failure_code: self.failure_code.clone(),
        }
    }
}

#[derive(Default)]
struct TabulateSessionRegistry {
    sessions: HashMap<String, SessionRecord>,
    signatures: HashMap<String, String>,
}

struct SessionInner {
    source: Mutex<DuckDbEngine>,
    registry: Mutex<TabulateSessionRegistry>,
    active_requests: Mutex<HashMap<String, TabulateActiveRequest>>,
    preparation: Mutex<()>,
    measured_bytes: AtomicUsize,
    closed: AtomicBool,
    policy: TabulateSessionPolicy,
    clock: Arc<dyn Fn() -> Duration + Send + Sync>,
}

#[derive(Clone)]
pub struct TabulateSessionService {
    inner: Arc<SessionInner>,
}

pub(crate) struct TabulateSessionLease {
    inner: Arc<SessionInner>,
    session_id: String,
}

pub(crate) struct TabulateActiveQueryGuard {
    inner: Arc<SessionInner>,
    pub(crate) entry: Arc<TabulateSessionEntry>,
}

struct TabulateActiveRequest {
    cancelled: Arc<AtomicBool>,
    interrupt_handle: Arc<InterruptHandle>,
    running: bool,
}

struct TabulateRequestGuard {
    inner: Arc<SessionInner>,
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for TabulateRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.inner.active_requests.lock() {
            if requests
                .get(&self.request_id)
                .is_some_and(|request| Arc::ptr_eq(&request.cancelled, &self.cancelled))
            {
                requests.remove(&self.request_id);
            }
        }
    }
}

impl Drop for TabulateSessionLease {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.inner.registry.lock() {
            if let Some(record) = registry.sessions.get_mut(&self.session_id) {
                record.leases = record.leases.saturating_sub(1);
                if record.leases == 0 {
                    record.last_used = (self.inner.clock)();
                }
            }
        }
    }
}

impl Drop for TabulateActiveQueryGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.inner.registry.lock() {
            if let Some(record) = registry.sessions.get_mut(&self.entry.session_id) {
                record.active_queries = record.active_queries.saturating_sub(1);
                record.last_used = (self.inner.clock)();
            }
        }
    }
}

impl TabulateSessionService {
    pub fn new(engine: &DuckDbEngine) -> Result<Self, AppError> {
        let start = Instant::now();
        Self::with_policy_and_clock(
            engine,
            TabulateSessionPolicy::default(),
            Arc::new(move || start.elapsed()),
        )
    }

    fn with_policy_and_clock(
        engine: &DuckDbEngine,
        policy: TabulateSessionPolicy,
        clock: Arc<dyn Fn() -> Duration + Send + Sync>,
    ) -> Result<Self, AppError> {
        Ok(Self {
            inner: Arc::new(SessionInner {
                source: Mutex::new(engine.try_clone()?),
                registry: Mutex::new(TabulateSessionRegistry::default()),
                active_requests: Mutex::new(HashMap::new()),
                preparation: Mutex::new(()),
                measured_bytes: AtomicUsize::new(0),
                closed: AtomicBool::new(false),
                policy,
                clock,
            }),
        })
    }

    pub fn prepare(
        &self,
        request: &TabulateSessionRequest,
    ) -> Result<TabulateSessionStatus, AppError> {
        let (entry, fresh) = self.begin_prepare(request)?;
        {
            let mut registry = lock(&self.inner.registry)?;
            let record = registry
                .sessions
                .get_mut(&entry.session_id)
                .ok_or_else(Self::unavailable)?;
            record.leases = record
                .leases
                .checked_add(1)
                .ok_or_else(|| AppError::Busy("tabulate_session_quota".into()))?;
            record.last_used = (self.inner.clock)();
        }
        let status = self.status(&entry.session_id)?;
        if fresh {
            let service = self.clone();
            let worker_entry = Arc::clone(&entry);
            if std::thread::Builder::new()
                .name("tabulate-prepare".into())
                .spawn(move || service.complete_prepare(&worker_entry))
                .is_err()
            {
                self.release(&entry.session_id)?;
                return Err(AppError::Database("tabulate_prepare_failed".into()));
            }
        }
        Ok(status)
    }

    fn begin_prepare(
        &self,
        request: &TabulateSessionRequest,
    ) -> Result<(Arc<TabulateSessionEntry>, bool), AppError> {
        self.sweep()?;
        let source = lock(&self.inner.source)?;
        source.validate_tabulate_session(request)?;
        let stale = {
            let mut registry = lock(&self.inner.registry)?;
            let ids = registry
                .sessions
                .values()
                .filter(|record| {
                    record.entry.request.dataset_id == request.dataset_id
                        && record.entry.request.source_generation != request.source_generation
                })
                .map(|record| record.entry.session_id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| Self::remove(&mut registry, id))
                .collect::<Vec<_>>()
        };
        drop(source);
        for entry in stale {
            self.cleanup(&entry)?;
        }
        let source = lock(&self.inner.source)?;
        source.validate_tabulate_session(request)?;
        let encoded = serde_json::to_vec(request)
            .map_err(|_| AppError::InvalidParam("tabulate_invalid_definition".into()))?;
        let fingerprint = format!("tabulate-v1:{:x}", Sha256::digest(encoded));
        let mut registry = lock(&self.inner.registry)?;
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(Self::unavailable());
        }
        let existing_id = registry.signatures.get(&fingerprint).cloned();
        if let Some(record) = existing_id.and_then(|id| registry.sessions.get_mut(&id)) {
            if matches!(
                record.state,
                TabulateSessionState::Preparing | TabulateSessionState::Ready
            ) {
                record.last_used = (self.inner.clock)();
                return Ok((Arc::clone(&record.entry), false));
            }
        }
        let engine = source.try_clone()?;
        let count = registry
            .sessions
            .values()
            .filter(|record| record.entry.request.dataset_id == request.dataset_id)
            .count();
        let victim = if count >= self.inner.policy.max_sessions_per_dataset {
            let victim_id = registry
                .sessions
                .values()
                .filter(|record| {
                    record.entry.request.dataset_id == request.dataset_id && record.evictable()
                })
                .min_by_key(|record| (record.last_used, record.entry.session_id.clone()))
                .map(|record| record.entry.session_id.clone())
                .ok_or_else(|| AppError::Busy("tabulate_session_quota".into()))?;
            Self::remove(&mut registry, &victim_id)
        } else {
            None
        };
        let uuid = Uuid::new_v4();
        let session_id = uuid.to_string();
        let entry = Arc::new(TabulateSessionEntry {
            session_id: session_id.clone(),
            uuid,
            request: request.clone(),
            fingerprint: fingerprint.clone(),
            interrupt_handle: engine.conn().interrupt_handle(),
            engine: Mutex::new(engine),
            released: AtomicBool::new(false),
            charged_bytes: AtomicUsize::new(0),
        });
        registry.signatures.insert(fingerprint, session_id.clone());
        registry.sessions.insert(
            session_id,
            SessionRecord {
                entry: Arc::clone(&entry),
                state: TabulateSessionState::Preparing,
                info: None,
                failure_code: None,
                leases: 0,
                active_queries: 0,
                last_used: (self.inner.clock)(),
            },
        );
        drop(registry);
        drop(source);
        if let Some(victim) = victim {
            self.cleanup(&victim)?;
        }
        Ok((entry, true))
    }

    fn remove(
        registry: &mut TabulateSessionRegistry,
        session_id: &str,
    ) -> Option<Arc<TabulateSessionEntry>> {
        let entry = Arc::clone(&registry.sessions.get(session_id)?.entry);
        entry.released.store(true, Ordering::Release);
        entry.interrupt_handle.interrupt();
        registry.sessions.remove(session_id);
        if registry
            .signatures
            .get(&entry.fingerprint)
            .is_some_and(|id| id == session_id)
        {
            registry.signatures.remove(&entry.fingerprint);
        }
        Some(entry)
    }

    fn cleanup(&self, entry: &TabulateSessionEntry) -> Result<(), AppError> {
        let bytes = entry.charged_bytes.swap(0, Ordering::AcqRel);
        self.inner.measured_bytes.fetch_sub(bytes, Ordering::AcqRel);
        lock(&entry.engine)?.drop_tabulate_member_indexes(&entry.uuid)
    }

    fn sweep(&self) -> Result<(), AppError> {
        let now = (self.inner.clock)();
        let victims = {
            let mut registry = lock(&self.inner.registry)?;
            let ids = registry
                .sessions
                .values()
                .filter(|record| {
                    record.evictable()
                        && now.saturating_sub(record.last_used) >= self.inner.policy.idle_ttl
                })
                .map(|record| record.entry.session_id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| Self::remove(&mut registry, id))
                .collect::<Vec<_>>()
        };
        for entry in victims {
            self.cleanup(&entry)?;
        }
        Ok(())
    }

    pub fn status(&self, session_id: &str) -> Result<TabulateSessionStatus, AppError> {
        self.sweep()?;
        let entry = self.entry(session_id)?;
        if lock(&self.inner.source)?
            .get_dataset_generation(&entry.request.dataset_id)
            .ok()
            != Some(entry.request.source_generation)
        {
            self.force_release(session_id)?;
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        let registry = lock(&self.inner.registry)?;
        Ok(registry
            .sessions
            .get(session_id)
            .ok_or_else(Self::unavailable)?
            .status())
    }

    fn entry(&self, session_id: &str) -> Result<Arc<TabulateSessionEntry>, AppError> {
        lock(&self.inner.registry)?
            .sessions
            .get(session_id)
            .map(|record| Arc::clone(&record.entry))
            .ok_or_else(Self::unavailable)
    }

    fn unavailable() -> AppError {
        AppError::InvalidParam("tabulate_session_unavailable".into())
    }

    pub fn materialize_table(
        &self,
        request: &crate::models::tabulate::TabulateMaterializeRequest,
    ) -> Result<crate::models::table::DatasetMeta, AppError> {
        self.materialize_table_with_check(request, |_| Ok(()))
    }

    fn materialize_table_with_check(
        &self,
        request: &crate::models::tabulate::TabulateMaterializeRequest,
        before_commit: impl FnOnce(&DuckDbEngine) -> Result<(), AppError>,
    ) -> Result<crate::models::table::DatasetMeta, AppError> {
        let query = self.begin_query(&request.session_id, request.source_generation, &request.fingerprint)?;
        let entry = &query.entry;
        let engine = lock(&entry.engine)?;
        self.validate_window_identity(entry)?;
        engine.materialize_tabulate_table(&entry.request, &entry.uuid, request, |engine| {
            before_commit(engine)?;
            self.validate_window_identity(entry)?;
            if lock(&self.inner.source)?.get_dataset_generation(&entry.request.dataset_id).ok()
                != Some(entry.request.source_generation)
            {
                return Err(AppError::InvalidParam("tabulate_stale_source".into()));
            }
            Ok(())
        })
    }

    pub fn query_totals(
        &self,
        request: &TabulateTotalsRequest,
    ) -> Result<TabulateTotalsResult, AppError> {
        self.execute_query(
            &request.request_id,
            &request.session_id,
            request.source_generation,
            |info, statistic_count| {
                DuckDbEngine::validate_tabulate_totals_bounds(
                    &request.totals,
                    info,
                    statistic_count,
                )
                .map(|_| ())
            },
            |engine, entry, info, cancelled| {
                engine.query_tabulate_totals(
                    &entry.request,
                    &entry.uuid,
                    request,
                    info,
                    &entry.fingerprint,
                    cancelled,
                )
            },
        )
    }

    pub fn query_window(
        &self,
        request: &TabulateWindowRequest,
    ) -> Result<TabulateWindowResult, AppError> {
        self.execute_query(
            &request.request_id,
            &request.session_id,
            request.source_generation,
            |info, statistic_count| {
                DuckDbEngine::validate_tabulate_window_bounds(request, info, statistic_count)
                    .map(|_| ())
            },
            |engine, entry, info, cancelled| {
                engine.query_tabulate_window(
                    &entry.request,
                    &entry.uuid,
                    request,
                    info,
                    &entry.fingerprint,
                    cancelled,
                )
            },
        )
    }

    fn execute_query<T>(
        &self,
        request_id: &str,
        session_id: &str,
        source_generation: u64,
        validate_bounds: impl FnOnce(&PreparedTabulateSessionInfo, usize) -> Result<(), AppError>,
        query: impl FnOnce(
            &DuckDbEngine,
            &TabulateSessionEntry,
            &PreparedTabulateSessionInfo,
            &AtomicBool,
        ) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        if request_id.trim().is_empty() || request_id.len() > 256 {
            return Err(AppError::InvalidParam("tabulate_invalid_request".into()));
        }
        let entry = self.entry(session_id)?;
        let _query = self.begin_query(session_id, source_generation, &entry.fingerprint)?;
        let info = {
            let registry = lock(&self.inner.registry)?;
            let record = registry
                .sessions
                .get(session_id)
                .ok_or_else(Self::unavailable)?;
            record.info.clone().ok_or_else(Self::unavailable)?
        };
        validate_bounds(&info, entry.request.statistics.len())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut requests = lock(&self.inner.active_requests)?;
            if requests.contains_key(request_id) {
                return Err(AppError::Busy("tabulate_request_active".into()));
            }
            requests.insert(
                request_id.to_owned(),
                TabulateActiveRequest {
                    cancelled: Arc::clone(&cancelled),
                    interrupt_handle: Arc::clone(&entry.interrupt_handle),
                    running: false,
                },
            );
        }
        let active = TabulateRequestGuard {
            inner: Arc::clone(&self.inner),
            request_id: request_id.to_owned(),
            cancelled,
        };
        let engine = lock(&entry.engine)?;
        let result = (|| {
            {
                let mut requests = lock(&self.inner.active_requests)?;
                let registered = requests.get_mut(request_id).ok_or_else(Self::unavailable)?;
                if registered.cancelled.load(Ordering::Acquire) {
                    return Err(AppError::Cancelled("tabulate_cancelled".into()));
                }
                registered.running = true;
            }
            self.validate_window_identity(&entry)?;
            let result = query(&engine, &entry, &info, &active.cancelled)?;
            self.validate_window_identity(&entry)?;
            if engine
                .get_dataset_generation(&entry.request.dataset_id)
                .ok()
                != Some(entry.request.source_generation)
            {
                return Err(AppError::InvalidParam("tabulate_stale_source".into()));
            }
            Ok(result)
        })();
        let was_cancelled = {
            let mut requests = lock(&self.inner.active_requests)?;
            requests.remove(request_id);
            active.cancelled.load(Ordering::Acquire)
        };
        drop(active);
        drop(engine);
        if was_cancelled {
            Err(AppError::Cancelled("tabulate_cancelled".into()))
        } else if entry.released.load(Ordering::Acquire) {
            Err(Self::unavailable())
        } else {
            result
        }
    }

    fn validate_window_identity(&self, entry: &Arc<TabulateSessionEntry>) -> Result<(), AppError> {
        let registry = lock(&self.inner.registry)?;
        let record = registry
            .sessions
            .get(&entry.session_id)
            .ok_or_else(Self::unavailable)?;
        if entry.released.load(Ordering::Acquire) || !Arc::ptr_eq(entry, &record.entry) {
            return Err(Self::unavailable());
        }
        if registry.signatures.get(&entry.fingerprint) != Some(&entry.session_id) {
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        Ok(())
    }

    pub fn cancel_request(&self, request_id: &str) -> Result<(), AppError> {
        let requests = lock(&self.inner.active_requests)?;
        if let Some(request) = requests.get(request_id) {
            request.cancelled.store(true, Ordering::Release);
            if request.running {
                request.interrupt_handle.interrupt();
            }
        }
        Ok(())
    }

    pub fn release(&self, session_id: &str) -> Result<(), AppError> {
        let entry = {
            let mut registry = lock(&self.inner.registry)?;
            match registry.sessions.get_mut(session_id) {
                Some(record) if record.leases > 1 => {
                    record.leases -= 1;
                    record.last_used = (self.inner.clock)();
                    None
                }
                Some(_) => Self::remove(&mut registry, session_id),
                None => None,
            }
        };
        if let Some(entry) = entry {
            self.cleanup(&entry)?;
        }
        Ok(())
    }

    fn force_release(&self, session_id: &str) -> Result<(), AppError> {
        let entry = {
            let mut registry = lock(&self.inner.registry)?;
            Self::remove(&mut registry, session_id)
        };
        if let Some(entry) = entry {
            self.cleanup(&entry)?;
        }
        Ok(())
    }

    pub(crate) fn acquire_lease(&self, session_id: &str) -> Result<TabulateSessionLease, AppError> {
        self.status(session_id)?;
        let mut registry = lock(&self.inner.registry)?;
        let record = registry
            .sessions
            .get_mut(session_id)
            .ok_or_else(Self::unavailable)?;
        record.leases = record
            .leases
            .checked_add(1)
            .ok_or_else(|| AppError::Busy("tabulate_session_quota".into()))?;
        record.last_used = (self.inner.clock)();
        Ok(TabulateSessionLease {
            inner: Arc::clone(&self.inner),
            session_id: session_id.into(),
        })
    }

    pub(crate) fn begin_query(
        &self,
        session_id: &str,
        generation: u64,
        fingerprint: &str,
    ) -> Result<TabulateActiveQueryGuard, AppError> {
        self.status(session_id)?;
        let mut registry = lock(&self.inner.registry)?;
        let record = registry
            .sessions
            .get_mut(session_id)
            .ok_or_else(Self::unavailable)?;
        if generation != record.entry.request.source_generation
            || fingerprint != record.entry.fingerprint
        {
            return Err(AppError::InvalidParam("tabulate_stale_source".into()));
        }
        if record.state != TabulateSessionState::Ready {
            return Err(AppError::Busy("tabulate_session_not_ready".into()));
        }
        record.active_queries = record
            .active_queries
            .checked_add(1)
            .ok_or_else(|| AppError::Busy("tabulate_session_quota".into()))?;
        record.last_used = (self.inner.clock)();
        Ok(TabulateActiveQueryGuard {
            inner: Arc::clone(&self.inner),
            entry: Arc::clone(&record.entry),
        })
    }

    pub(crate) fn shutdown(&self) -> Result<(), AppError> {
        let entries = {
            let mut registry = lock(&self.inner.registry)?;
            self.inner.closed.store(true, Ordering::Release);
            let ids = registry.sessions.keys().cloned().collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| Self::remove(&mut registry, id))
                .collect::<Vec<_>>()
        };
        for entry in entries {
            self.cleanup(&entry)?;
        }
        Ok(())
    }

    fn admit_bytes(&self, entry: &TabulateSessionEntry, bytes: usize) -> Result<(), AppError> {
        if bytes > self.inner.policy.max_measured_bytes {
            return Err(AppError::InvalidParam(
                "tabulate_member_index_budget".into(),
            ));
        }
        let victims = {
            let mut registry = lock(&self.inner.registry)?;
            if entry.released.load(Ordering::Acquire) {
                return Err(Self::unavailable());
            }
            let available = self
                .inner
                .policy
                .max_measured_bytes
                .saturating_sub(self.inner.measured_bytes.load(Ordering::Acquire));
            let mut candidates = registry
                .sessions
                .values()
                .filter(|record| record.evictable() && record.entry.session_id != entry.session_id)
                .map(|record| (record.last_used, Arc::clone(&record.entry)))
                .collect::<Vec<_>>();
            candidates.sort_by_key(|(last_used, entry)| (*last_used, entry.session_id.clone()));
            let mut needed = bytes.saturating_sub(available);
            let mut ids = Vec::new();
            for (_, candidate) in candidates {
                if needed == 0 {
                    break;
                }
                needed = needed.saturating_sub(candidate.charged_bytes.load(Ordering::Acquire));
                ids.push(candidate.session_id.clone());
            }
            if needed > 0 {
                return Err(AppError::InvalidParam(
                    "tabulate_member_index_budget".into(),
                ));
            }
            ids.iter()
                .filter_map(|id| Self::remove(&mut registry, id))
                .collect::<Vec<_>>()
        };
        for victim in victims {
            self.cleanup(&victim)?;
        }
        let _registry = lock(&self.inner.registry)?;
        if entry.released.load(Ordering::Acquire) {
            return Err(Self::unavailable());
        }
        self.inner.measured_bytes.fetch_add(bytes, Ordering::AcqRel);
        entry.charged_bytes.store(bytes, Ordering::Release);
        Ok(())
    }

    fn complete_prepare(&self, entry: &Arc<TabulateSessionEntry>) {
        let result = (|| -> Result<PreparedTabulateSessionInfo, AppError> {
            let _preparation = lock(&self.inner.preparation)?;
            if entry.released.load(Ordering::Acquire) {
                return Err(Self::unavailable());
            }
            let measured = lock(&entry.engine)?.measure_tabulate_member_indexes(&entry.request)?;
            self.admit_bytes(entry, measured.measured_bytes_estimate)?;
            let engine = lock(&entry.engine)?;
            if entry.released.load(Ordering::Acquire) {
                return Err(Self::unavailable());
            }
            engine.prepare_tabulate_member_indexes(
                &entry.request,
                &entry.uuid,
                measured.measured_bytes_estimate,
            )
        })();
        let result = result.and_then(|info| {
            if lock(&self.inner.source)?.get_dataset_generation(&entry.request.dataset_id)?
                != entry.request.source_generation
            {
                return Err(AppError::InvalidParam("tabulate_stale_source".into()));
            }
            Ok(info)
        });
        self.publish_preparation(entry, result);
    }

    fn publish_preparation(
        &self,
        entry: &Arc<TabulateSessionEntry>,
        result: Result<PreparedTabulateSessionInfo, AppError>,
    ) {
        match result {
            Ok(info) => {
                if let Ok(mut registry) = self.inner.registry.lock() {
                    if let Some(record) = registry.sessions.get_mut(&entry.session_id) {
                        if !entry.released.load(Ordering::Acquire) {
                            record.state = TabulateSessionState::Ready;
                            record.info = Some(info);
                            record.last_used = (self.inner.clock)();
                            return;
                        }
                    }
                }
                let _ = self.cleanup(entry);
            }
            Err(error) => {
                let cleanup = self.cleanup(entry);
                if let Ok(mut registry) = self.inner.registry.lock() {
                    if let Some(record) = registry.sessions.get_mut(&entry.session_id) {
                        let code = match error {
                            AppError::InvalidParam(ref message)
                                if message.starts_with("tabulate_") =>
                            {
                                message.as_str()
                            }
                            AppError::Database(ref message)
                                if message.to_ascii_uppercase().contains("INTERRUPT") =>
                            {
                                "tabulate_cancelled"
                            }
                            AppError::Cancelled(_) => "tabulate_cancelled",
                            _ => "tabulate_prepare_failed",
                        };
                        record.state = if code == "tabulate_cancelled" {
                            TabulateSessionState::Cancelled
                        } else {
                            TabulateSessionState::Failed
                        };
                        record.failure_code = Some(
                            if cleanup.is_err() {
                                "tabulate_cleanup_failed"
                            } else {
                                code
                            }
                            .into(),
                        );
                        record.last_used = (self.inner.clock)();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::tabulate::{StatisticKind, TabulateStatistic, TabulateWindowRequest};
    use std::sync::atomic::AtomicU64;

    struct SessionHarness {
        source: DuckDbEngine,
        service: TabulateSessionService,
        milliseconds: Arc<AtomicU64>,
    }

    impl SessionHarness {
        fn new(budget: usize) -> Self {
            let source = DuckDbEngine::new_in_memory().expect("engine");
            source.conn().execute_batch(
                "CREATE TABLE dataset_session_test (region VARCHAR, product VARCHAR, sales DOUBLE);
                 INSERT INTO dataset_session_test VALUES ('East', 'A', 1), ('West', 'B', 2), (NULL, 'A', 3);
                 INSERT INTO _meta_datasets (id, name, source_type, row_count, col_count)
                 VALUES ('session-test', 'Session test', 'test', 3, 3);"
            ).expect("fixture");
            let milliseconds = Arc::new(AtomicU64::new(0));
            let clock_value = Arc::clone(&milliseconds);
            let service = TabulateSessionService::with_policy_and_clock(
                &source,
                TabulateSessionPolicy {
                    max_measured_bytes: budget,
                    ..Default::default()
                },
                Arc::new(move || Duration::from_millis(clock_value.load(Ordering::SeqCst))),
            )
            .expect("service");
            Self {
                source,
                service,
                milliseconds,
            }
        }

        fn request(&self) -> TabulateSessionRequest {
            TabulateSessionRequest {
                dataset_id: "session-test".into(),
                source_generation: self
                    .source
                    .get_dataset_generation("session-test")
                    .expect("generation"),
                row_fields: vec!["region".into()],
                column_fields: vec!["product".into()],
                statistics: vec![TabulateStatistic {
                    id: "mean".into(),
                    field: "sales".into(),
                    kind: StatisticKind::Mean,
                    quantile: None,
                }],
                include_row_totals: true,
                include_column_totals: true,
            }
        }

        fn paused(&self, request: &TabulateSessionRequest) -> Arc<TabulateSessionEntry> {
            self.service.begin_prepare(request).expect("begin").0
        }

        fn ready(&self, request: &TabulateSessionRequest) -> TabulateSessionStatus {
            let (entry, fresh) = self.service.begin_prepare(request).expect("begin");
            if fresh {
                self.service.complete_prepare(&entry);
            }
            let status = self.service.status(&entry.session_id).expect("status");
            assert_eq!(status.state, TabulateSessionState::Ready, "{status:?}");
            status
        }

        fn advance(&self, milliseconds: u64) {
            self.milliseconds.fetch_add(milliseconds, Ordering::SeqCst);
        }

        fn assert_dropped(&self, entry: &TabulateSessionEntry) {
            let engine = entry.engine.lock().expect("engine");
            let count: i64 = engine
                .conn()
                .query_row(
                    "SELECT count(*) FROM duckdb_tables() WHERE table_name IN (?, ?)",
                    duckdb::params![entry.row_table_name(), entry.column_table_name()],
                    |row| row.get(0),
                )
                .expect("tables");
            assert_eq!(count, 0);
        }
    }

    fn window_request(status: &TabulateSessionStatus) -> TabulateWindowRequest {
        TabulateWindowRequest {
            request_id: Uuid::new_v4().to_string(),
            session_id: status.session_id.clone(),
            source_generation: status.source_generation,
            row_start: 0,
            row_count: 2,
            column_start: 0,
            column_count: 2,
        }
    }

    fn materialize_request(status: &TabulateSessionStatus) -> crate::models::tabulate::TabulateMaterializeRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": status.session_id,
            "sourceGeneration": status.source_generation,
            "fingerprint": status.fingerprint,
            "destinationName": "Exported summary",
            "missingLabel": "Missing",
            "statisticLabels": ["Average", "Average", "Count"]
        })).unwrap()
    }

    fn materialize_fixture() -> (SessionHarness, TabulateSessionStatus) {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        harness.source.conn().execute_batch(
            "ALTER TABLE dataset_session_test ADD COLUMN detail VARCHAR;
             ALTER TABLE dataset_session_test ADD COLUMN channel VARCHAR;
             DELETE FROM dataset_session_test;
             INSERT INTO dataset_session_test VALUES
               ('West', 'A', NULL, 'two', 'web'),
               ('East', 'A', 2, 'one', 'web'),
               ('East', 'A', 4, 'one', 'web'),
               (NULL, NULL, 8, 'one', 'web'),
               ('East', 'Missing', 6, 'one', 'web');"
        ).unwrap();
        let mut definition = harness.request();
        definition.row_fields.push("detail".into());
        definition.column_fields.push("channel".into());
        definition.statistics.push(TabulateStatistic { id: "mean-2".into(), ..definition.statistics[0].clone() });
        definition.statistics.push(TabulateStatistic { id: "count".into(), kind: StatisticKind::Count, ..definition.statistics[0].clone() });
        let status = harness.ready(&definition);
        (harness, status)
    }

    fn assert_no_materialized_output(harness: &SessionHarness) {
        for sql in [
            "SELECT count(*) FROM _meta_datasets WHERE id <> 'session-test'",
            "SELECT count(*) FROM _meta_columns WHERE dataset_id <> 'session-test'",
            "SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE 'dataset_%' AND table_name <> 'dataset_session_test'",
            "SELECT count(*) FROM _table_navigation_anchors WHERE dataset_id <> 'session-test'",
        ] {
            let count: i64 = harness.source.conn().query_row(sql, [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{sql}");
        }
    }

    #[test]
    fn materialize_tabulate_table_exact_sparse_nested_names_types_and_metadata() {
        use serde_json::json;
        let (harness, status) = materialize_fixture();
        let meta = harness.service.materialize_table(&materialize_request(&status)).unwrap();
        assert_eq!(meta.name, "Exported summary");
        assert_eq!(meta.source_type, "manual");
        assert_eq!((meta.row_count, meta.col_count), (3, 11));
        let table = harness.source.query_table(&meta.id, 0, 10, None, None).unwrap();
        assert_eq!(table.columns, vec!["_row_id", "region", "detail",
            "A - web - Average - sales", "A - web - Average - sales (2)", "A - web - Count - sales",
            "Missing - web - Average - sales", "Missing - web - Average - sales (2)", "Missing - web - Count - sales",
            "Missing - web - Average - sales (3)", "Missing - web - Average - sales (4)", "Missing - web - Count - sales (2)"]);
        assert_eq!(&table.column_types[1..3], &["VARCHAR", "VARCHAR"]);
        assert!(table.column_types[3..].iter().all(|value| value == "DOUBLE"));
        assert_eq!(table.rows, vec![
            vec![json!(1),json!("East"),json!("one"),json!(3.0),json!(3.0),json!(2.0),json!(6.0),json!(6.0),json!(1.0),json!(null),json!(null),json!(0.0)],
            vec![json!(2),json!("West"),json!("two"),json!(null),json!(null),json!(0.0),json!(null),json!(null),json!(0.0),json!(null),json!(null),json!(0.0)],
            vec![json!(3),json!("Missing"),json!("one"),json!(null),json!(null),json!(0.0),json!(null),json!(null),json!(0.0),json!(8.0),json!(8.0),json!(1.0)],
        ]);
        let columns = harness.source.get_user_column_descriptors(&meta.id).unwrap();
        assert_eq!(columns.len(), 11);
        assert!(columns.iter().all(|column| !column.column_id.is_empty()));
        assert_eq!(harness.source.get_dataset_generation(&meta.id).unwrap(), 0);
    }

    #[test]
    fn materialize_tabulate_table_rolls_back_physical_metadata_and_anchors_on_failure() {
        let (harness, status) = materialize_fixture();
        let error = harness.service.materialize_table_with_check(&materialize_request(&status), |engine| {
            let count: i64 = engine.conn().query_row("SELECT count(*) FROM _meta_datasets WHERE name = 'Exported summary'", [], |row| row.get(0))?;
            assert_eq!(count, 1);
            Err(AppError::Database("injected_after_creation".into()))
        }).unwrap_err();
        assert!(error.to_string().contains("injected_after_creation"));
        assert_no_materialized_output(&harness);
    }

    #[test]
    fn materialize_tabulate_table_generation_change_before_commit_rolls_back() {
        let (harness, status) = materialize_fixture();
        let error = harness.service.materialize_table_with_check(&materialize_request(&status), |_| {
            harness.source.bump_dataset_generation("session-test")
        }).unwrap_err();
        assert!(error.to_string().contains("tabulate_stale_source"), "{error}");
        assert_no_materialized_output(&harness);
        assert_eq!(harness.source.get_dataset_generation("session-test").unwrap(), status.source_generation + 1);
    }

    #[test]
    fn materialize_tabulate_table_rejects_wrong_identity_not_ready_and_released() {
        let (harness, status) = materialize_fixture();
        let mut request = materialize_request(&status);
        request.fingerprint.push_str("wrong");
        assert!(harness.service.materialize_table(&request).is_err());
        request = materialize_request(&status);
        request.source_generation += 1;
        assert!(harness.service.materialize_table(&request).is_err());
        harness.service.release(&status.session_id).unwrap();
        assert!(harness.service.materialize_table(&materialize_request(&status)).is_err());
        let entry = harness.paused(&harness.request());
        let preparing = harness.service.status(&entry.session_id).unwrap();
        assert!(harness.service.materialize_table(&materialize_request(&preparing)).is_err());
        assert_no_materialized_output(&harness);
    }

    #[test]
    fn materialize_tabulate_table_exact_percentages_and_no_dimension_empty_source() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let mut definition = harness.request();
        definition.statistics = [StatisticKind::RowPercentage, StatisticKind::ColumnPercentage, StatisticKind::TotalPercentage]
            .into_iter().enumerate().map(|(index, kind)| TabulateStatistic { id: index.to_string(), kind, ..definition.statistics[0].clone() }).collect();
        let status = harness.ready(&definition);
        let meta = harness.service.materialize_table(&materialize_request(&status)).unwrap();
        let table = harness.source.query_table(&meta.id, 0, 10, None, None).unwrap();
        assert_eq!(&table.rows[0][2..5], &[serde_json::json!(1.0), serde_json::json!(0.5), serde_json::json!(1.0 / 3.0)]);
        assert_eq!(&table.rows[0][5..8], &[serde_json::json!(0.0), serde_json::json!(0.0), serde_json::json!(0.0)]);
        harness.source.conn().execute_batch("DELETE FROM dataset_session_test").unwrap();
        harness.source.bump_dataset_generation("session-test").unwrap();
        definition.source_generation += 1;
        definition.row_fields.clear();
        definition.column_fields.clear();
        definition.statistics = vec![TabulateStatistic { id: "count".into(), kind: StatisticKind::Count, ..definition.statistics[0].clone() }];
        let empty = harness.ready(&definition);
        let mut request = materialize_request(&empty);
        request.destination_name = "Empty summary".into();
        request.statistic_labels = vec!["Count".into()];
        let meta = harness.service.materialize_table(&request).unwrap();
        let table = harness.source.query_table(&meta.id, 0, 10, None, None).unwrap();
        assert_eq!(table.rows, vec![vec![serde_json::json!(1), serde_json::json!(0.0)]]);
    }

    fn assert_window_error<T: std::fmt::Debug>(result: Result<T, AppError>, code: &str) {
        let error = result.expect_err(code);
        assert!(error.to_string().contains(code), "{error}");
    }

    #[test]
    fn materialize_tabulate_table_invalid_contract_and_name_leave_no_output() {
        let (harness, status) = materialize_fixture();
        let original = materialize_request(&status);
        let mut request = original.clone();
        request.statistic_labels.pop();
        assert!(harness.service.materialize_table(&request).is_err());
        request = original.clone();
        request.statistic_labels[0] = " ".into();
        assert!(harness.service.materialize_table(&request).is_err());
        for name in ["", "../escape", "CON.txt", "trailing.", "Session test"] {
            request = original.clone();
            request.destination_name = name.into();
            assert!(harness.service.materialize_table(&request).is_err(), "{name}");
        }
        assert_no_materialized_output(&harness);
    }

    #[test]
    fn materialize_tabulate_table_quoted_labels_are_literal_values_and_identifiers() {
        let (harness, status) = materialize_fixture();
        let mut request = materialize_request(&status);
        request.missing_label = "missing' ; DROP TABLE dataset_session_test; --".into();
        request.statistic_labels[0] = "Mean\"; DROP TABLE dataset_session_test; --".into();
        let meta = harness.service.materialize_table(&request).unwrap();
        let columns = harness.source.get_user_column_descriptors(&meta.id).unwrap();
        let expected = format!("A - web - {} - sales", request.statistic_labels[0]);
        assert_eq!(columns[2].name, expected);
        let output_table = format!("dataset_{}", meta.id.replace('-', "_"));
        let missing: String = harness.source.conn().query_row(
            &format!("SELECT region FROM \"{output_table}\" WHERE _row_id = 3"),
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(missing, request.missing_label);
        let value: f64 = harness.source.conn().query_row(
            &format!("SELECT \"{}\" FROM \"{output_table}\" WHERE _row_id = 1", expected.replace('"', "\"\"")),
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(value, 3.0);
        let source_rows: i64 = harness.source.conn().query_row(
            "SELECT count(*) FROM dataset_session_test", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(source_rows, 5);
    }

    #[test]
    fn materialize_tabulate_table_exceeds_legacy_cell_limit_without_window_queries() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        harness.source.conn().execute_batch(
            "DELETE FROM dataset_session_test;
             INSERT INTO dataset_session_test
             SELECT printf('row%03d', value), printf('col%03d', value % 100), value::DOUBLE
             FROM range(101) AS generated(value);"
        ).unwrap();
        let status = harness.ready(&harness.request());
        assert_eq!(status.logical_cell_count, 10100);
        let mut request = materialize_request(&status);
        request.statistic_labels = vec!["Mean".into()];
        let meta = harness.service.materialize_table(&request).unwrap();
        assert_eq!((meta.row_count, meta.col_count), (101, 101));
        let table = harness.source.query_table(&meta.id, 100, 1, None, None).unwrap();
        assert_eq!(table.rows[0][1], serde_json::json!("row100"));
        assert_eq!(table.rows[0][2], serde_json::json!(100.0));
        assert!(table.rows[0][3..].iter().all(serde_json::Value::is_null));
    }

    #[test]
    fn tabulate_totals_percentages_ignore_tile_boundaries_and_display_flags() {
        let harness = totals_fixture();
        let mut definition = totals_definition(&harness);
        definition.include_row_totals = false;
        definition.include_column_totals = false;
        let status = harness.ready(&definition);
        for (row_start, column_start, expected) in [
            (0, 0, vec![Some(0.5), Some(0.5), Some(0.2)]),
            (0, 1, vec![Some(0.5), Some(0.5), Some(0.2)]),
            (3, 2, vec![Some(1.0), Some(1.0), Some(0.2)]),
        ] {
            let result = harness
                .service
                .query_window(&TabulateWindowRequest {
                    row_start,
                    column_start,
                    row_count: 1,
                    column_count: 1,
                    ..window_request(&status)
                })
                .unwrap();
            assert_eq!(
                result
                    .cells
                    .iter()
                    .map(|cell| cell.value)
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(!result.row_totals_ready && !result.column_totals_ready);
        }
        let wider = harness
            .service
            .query_window(&window_request(&status))
            .unwrap();
        assert_eq!(wider.cells[0].value, Some(0.5));
        assert_eq!(wider.cells[1].value, Some(0.5));
        assert_eq!(wider.cells[2].value, Some(0.2));
    }

    fn totals_fixture() -> SessionHarness {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        harness
            .source
            .conn()
            .execute_batch(
                "DELETE FROM dataset_session_test;
             INSERT INTO dataset_session_test VALUES
             ('A', 'X', 10), ('A', 'Y', 30), ('A', 'Y', NULL),
             ('B', 'X', 15), ('B', 'Y', 30),
             ('C', 'X', NULL), ('C', 'X', NULL), (NULL, NULL, 15);",
            )
            .unwrap();
        harness
    }

    fn totals_definition(harness: &SessionHarness) -> TabulateSessionRequest {
        let mut definition = harness.request();
        definition.statistics = [
            StatisticKind::RowPercentage,
            StatisticKind::ColumnPercentage,
            StatisticKind::TotalPercentage,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| TabulateStatistic {
            id: format!("pct-{index}"),
            field: "sales".into(),
            kind,
            quantile: None,
        })
        .collect();
        definition
    }

    fn totals_request(
        status: &TabulateSessionStatus,
        totals: TabulateTotalsKind,
    ) -> TabulateTotalsRequest {
        TabulateTotalsRequest {
            request_id: Uuid::new_v4().to_string(),
            session_id: status.session_id.clone(),
            source_generation: status.source_generation,
            totals,
        }
    }

    #[test]
    fn tabulate_totals_bounded_ranges_separate_arrays_and_identity() {
        let harness = totals_fixture();
        let status = harness.ready(&totals_definition(&harness));
        for (kind, expected) in [
            (
                TabulateTotalsKind::Rows { start: 1, count: 1 },
                vec![Some(1.0), Some(0.4), Some(0.4)],
            ),
            (
                TabulateTotalsKind::Columns { start: 1, count: 1 },
                vec![Some(0.4), Some(1.0), Some(0.4)],
            ),
            (
                TabulateTotalsKind::Rows { start: 3, count: 2 },
                vec![Some(1.0), Some(0.2), Some(0.2)],
            ),
            (TabulateTotalsKind::Grand, vec![Some(1.0); 3]),
        ] {
            let request = totals_request(&status, kind.clone());
            let result = harness
                .service
                .query_totals(&request)
                .expect("exact bounded totals");
            assert_eq!(result.session_id, status.session_id);
            assert_eq!(result.request_id, request.request_id);
            assert_eq!(result.fingerprint, status.fingerprint);
            assert_eq!(result.source_generation, status.source_generation);
            assert_eq!(result.totals, kind);
            let values = match kind {
                TabulateTotalsKind::Rows { .. } => {
                    assert!(result.column_totals.is_empty() && result.grand_totals.is_empty());
                    result.row_totals
                }
                TabulateTotalsKind::Columns { .. } => {
                    assert!(result.row_totals.is_empty() && result.grand_totals.is_empty());
                    result.column_totals
                }
                TabulateTotalsKind::Grand => {
                    assert!(result.row_totals.is_empty() && result.column_totals.is_empty());
                    assert_eq!(result.grand_totals, expected);
                    continue;
                }
            };
            assert_eq!(
                values.iter().map(|cell| cell.value).collect::<Vec<_>>(),
                expected
            );
            for (index, cell) in values.iter().enumerate() {
                assert_eq!((cell.member_index, cell.statistic_index), (0, index as u32));
            }
        }
    }

    #[test]
    fn tabulate_totals_zero_denominators_are_null_and_missing_groups_stay_sparse() {
        let harness = totals_fixture();
        let status = harness.ready(&totals_definition(&harness));
        let window = harness
            .service
            .query_window(&TabulateWindowRequest {
                row_start: 2,
                row_count: 1,
                column_count: 1,
                ..window_request(&status)
            })
            .unwrap();
        assert_eq!(
            window
                .cells
                .iter()
                .map(|cell| cell.value)
                .collect::<Vec<_>>(),
            vec![None, Some(0.0), Some(0.0)]
        );
        let result = harness
            .service
            .query_totals(&totals_request(
                &status,
                TabulateTotalsKind::Rows { start: 2, count: 1 },
            ))
            .unwrap();
        assert_eq!(
            result
                .row_totals
                .iter()
                .map(|cell| cell.value)
                .collect::<Vec<_>>(),
            vec![None, Some(0.0), Some(0.0)]
        );
        let missing = harness
            .service
            .query_window(&TabulateWindowRequest {
                row_start: 2,
                column_start: 1,
                row_count: 1,
                column_count: 1,
                ..window_request(&status)
            })
            .unwrap();
        assert!(missing.cells.is_empty());
        harness.service.release(&status.session_id).unwrap();
        harness
            .source
            .conn()
            .execute_batch("UPDATE dataset_session_test SET sales = NULL")
            .unwrap();
        let status = harness.ready(&totals_definition(&harness));
        let result = harness
            .service
            .query_totals(&totals_request(&status, TabulateTotalsKind::Grand))
            .unwrap();
        assert_eq!(result.grand_totals, vec![None; 3]);
    }

    #[test]
    fn tabulate_totals_reject_bounds_and_fence_stale_sessions() {
        let harness = totals_fixture();
        let status = harness.ready(&totals_definition(&harness));
        for kind in [
            TabulateTotalsKind::Rows {
                start: 0,
                count: 129,
            },
            TabulateTotalsKind::Columns {
                start: 0,
                count: 65,
            },
            TabulateTotalsKind::Rows { start: 0, count: 0 },
            TabulateTotalsKind::Columns {
                start: u64::MAX,
                count: 1,
            },
            TabulateTotalsKind::Rows { start: 5, count: 1 },
            TabulateTotalsKind::Columns { start: 4, count: 1 },
        ] {
            assert_window_error(
                harness.service.query_totals(&totals_request(&status, kind)),
                "tabulate_invalid_bounds",
            );
        }
        let mut request = totals_request(&status, TabulateTotalsKind::Grand);
        request.source_generation += 1;
        assert_window_error(
            harness.service.query_totals(&request),
            "tabulate_stale_source",
        );
        request.source_generation = status.source_generation;
        harness
            .service
            .inner
            .registry
            .lock()
            .unwrap()
            .signatures
            .clear();
        assert_window_error(
            harness.service.query_totals(&request),
            "tabulate_stale_source",
        );
        harness.service.release(&status.session_id).unwrap();
        assert_window_error(
            harness.service.query_totals(&request),
            "tabulate_session_unavailable",
        );
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tabulate_totals_exact_all_statistics_and_empty_roles() {
        let harness = totals_fixture();
        let mut definition = totals_definition(&harness);
        definition.statistics = [
            StatisticKind::Count,
            StatisticKind::MissingCount,
            StatisticKind::UniqueCount,
            StatisticKind::Sum,
            StatisticKind::Mean,
            StatisticKind::StandardDeviation,
            StatisticKind::Variance,
            StatisticKind::Minimum,
            StatisticKind::Maximum,
            StatisticKind::Median,
            StatisticKind::Range,
            StatisticKind::Quantile,
            StatisticKind::RowPercentage,
            StatisticKind::ColumnPercentage,
            StatisticKind::TotalPercentage,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| TabulateStatistic {
            id: format!("stat-{index}"),
            field: "sales".into(),
            kind,
            quantile: Some(0.25),
        })
        .collect();
        let status = harness.ready(&definition);
        for (kind, expected) in [
            (
                TabulateTotalsKind::Rows { start: 0, count: 1 },
                vec![
                    2.0,
                    1.0,
                    2.0,
                    40.0,
                    20.0,
                    200.0_f64.sqrt(),
                    200.0,
                    10.0,
                    30.0,
                    20.0,
                    20.0,
                    15.0,
                    1.0,
                    0.4,
                    0.4,
                ],
            ),
            (
                TabulateTotalsKind::Columns { start: 0, count: 1 },
                vec![
                    2.0,
                    2.0,
                    2.0,
                    25.0,
                    12.5,
                    12.5_f64.sqrt(),
                    12.5,
                    10.0,
                    15.0,
                    12.5,
                    5.0,
                    11.25,
                    0.4,
                    1.0,
                    0.4,
                ],
            ),
            (
                TabulateTotalsKind::Grand,
                vec![
                    5.0,
                    3.0,
                    3.0,
                    100.0,
                    20.0,
                    87.5_f64.sqrt(),
                    87.5,
                    10.0,
                    30.0,
                    15.0,
                    20.0,
                    15.0,
                    1.0,
                    1.0,
                    1.0,
                ],
            ),
        ] {
            let result = harness
                .service
                .query_totals(&totals_request(&status, kind))
                .unwrap();
            let actual = result
                .row_totals
                .into_iter()
                .chain(result.column_totals)
                .map(|cell| cell.value)
                .chain(result.grand_totals)
                .collect::<Vec<_>>();
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.into_iter().zip(expected) {
                assert!((actual.unwrap() - expected).abs() < 1e-12);
            }
        }
        harness.service.release(&status.session_id).unwrap();
        for (empty_rows, empty_columns) in [(true, false), (false, true), (true, true)] {
            let mut definition = definition.clone();
            if empty_rows {
                definition.row_fields.clear();
            }
            if empty_columns {
                definition.column_fields.clear();
            }
            let status = harness.ready(&definition);
            let kind = if empty_rows {
                TabulateTotalsKind::Rows { start: 0, count: 1 }
            } else {
                TabulateTotalsKind::Columns { start: 0, count: 1 }
            };
            let totals = harness
                .service
                .query_totals(&totals_request(&status, kind))
                .unwrap();
            let values = totals
                .row_totals
                .into_iter()
                .chain(totals.column_totals)
                .map(|cell| cell.value)
                .collect::<Vec<_>>();
            assert_eq!(values[0], Some(5.0));
            assert_eq!(&values[12..], &[Some(1.0); 3]);
            harness.service.release(&status.session_id).unwrap();
        }
        harness
            .source
            .conn()
            .execute_batch("DELETE FROM dataset_session_test")
            .unwrap();
        definition.row_fields.clear();
        definition.column_fields.clear();
        let status = harness.ready(&definition);
        for kind in [
            TabulateTotalsKind::Rows { start: 0, count: 1 },
            TabulateTotalsKind::Columns { start: 0, count: 1 },
            TabulateTotalsKind::Grand,
        ] {
            let totals = harness
                .service
                .query_totals(&totals_request(&status, kind))
                .unwrap();
            let values = totals
                .row_totals
                .into_iter()
                .chain(totals.column_totals)
                .map(|cell| cell.value)
                .chain(totals.grand_totals)
                .collect::<Vec<_>>();
            assert_eq!(&values[..3], &[Some(0.0); 3]);
            assert_eq!(&values[3..], &[None; 12]);
        }
    }

    #[test]
    fn tabulate_totals_numeric_budget_empty_edges_and_fingerprint_separation() {
        let harness = totals_fixture();
        let definition = totals_definition(&harness);
        let status = harness.ready(&definition);
        for kind in [
            TabulateTotalsKind::Rows { start: 4, count: 1 },
            TabulateTotalsKind::Columns { start: 3, count: 1 },
        ] {
            let result = harness
                .service
                .query_totals(&totals_request(&status, kind))
                .unwrap();
            assert!(
                result.row_totals.is_empty()
                    && result.column_totals.is_empty()
                    && result.grand_totals.is_empty()
            );
        }
        let mut other = definition.clone();
        other.statistics[0].kind = StatisticKind::Count;
        let other_status = harness.ready(&other);
        assert_ne!(status.fingerprint, other_status.fingerprint);
        let result = harness
            .service
            .query_totals(&totals_request(&other_status, TabulateTotalsKind::Grand))
            .unwrap();
        assert_eq!(result.fingerprint, other_status.fingerprint);
        assert_eq!(result.grand_totals, vec![Some(5.0), Some(1.0), Some(1.0)]);
        harness.service.release(&other_status.session_id).unwrap();
        let mut many = definition;
        many.statistics = (0..129)
            .map(|index| TabulateStatistic {
                id: format!("count-{index}"),
                field: "sales".into(),
                kind: StatisticKind::Count,
                quantile: None,
            })
            .collect();
        let many_status = harness.ready(&many);
        assert_window_error(
            harness.service.query_totals(&totals_request(
                &many_status,
                TabulateTotalsKind::Rows {
                    start: 0,
                    count: 128,
                },
            )),
            "tabulate_invalid_bounds",
        );
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tabulate_totals_running_and_queued_cancellation_share_window_registry() {
        for kind in [
            TabulateTotalsKind::Rows { start: 0, count: 1 },
            TabulateTotalsKind::Columns { start: 0, count: 1 },
            TabulateTotalsKind::Grand,
        ] {
            let harness = SessionHarness::new(256 * 1024 * 1024);
            let status = harness.ready(&harness.request());
            harness
                .source
                .conn()
                .execute_batch(
                    "DROP TABLE dataset_session_test;
                 CREATE VIEW dataset_session_test AS SELECT 'East'::VARCHAR AS region,
                 'A'::VARCHAR AS product, sin(range::DOUBLE) AS sales FROM range(1000000000);",
                )
                .unwrap();
            let request = totals_request(&status, kind);
            let service = harness.service.clone();
            let worker_request = request.clone();
            let (sender, receiver) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                sender.send(service.query_totals(&worker_request)).unwrap()
            });
            await_active(&harness.service, &request.request_id, true);
            harness.service.cancel_request("unrelated").unwrap();
            assert_window_error(
                harness.service.query_window(&TabulateWindowRequest {
                    request_id: request.request_id.clone(),
                    ..window_request(&status)
                }),
                "tabulate_request_active",
            );
            let queued_request = totals_request(&status, TabulateTotalsKind::Grand);
            let queued_id = queued_request.request_id.clone();
            let service = harness.service.clone();
            let queued = std::thread::spawn(move || service.query_totals(&queued_request));
            await_active(&harness.service, &queued_id, false);
            harness.service.cancel_request(&queued_id).unwrap();
            assert!(matches!(
                receiver.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            harness.service.cancel_request(&request.request_id).unwrap();
            assert_window_error(
                receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
                "tabulate_cancelled",
            );
            worker.join().unwrap();
            assert_window_error(queued.join().unwrap(), "tabulate_cancelled");
            assert!(harness
                .service
                .inner
                .active_requests
                .lock()
                .unwrap()
                .is_empty());
            assert_eq!(
                harness.service.inner.registry.lock().unwrap().sessions[&status.session_id]
                    .active_queries,
                0
            );
            harness
                .source
                .conn()
                .execute_batch(
                    "DROP VIEW dataset_session_test;
                 CREATE TABLE dataset_session_test AS SELECT 'East'::VARCHAR AS region,
                 'A'::VARCHAR AS product, 7.0::DOUBLE AS sales;",
                )
                .unwrap();
            let result = harness
                .service
                .query_totals(&totals_request(&status, TabulateTotalsKind::Grand))
                .unwrap();
            assert_eq!(result.grand_totals, vec![Some(7.0)]);
        }
    }

    #[test]
    fn tabulate_totals_queued_source_change_and_release_cannot_publish() {
        for release in [false, true] {
            let harness = totals_fixture();
            let status = harness.ready(&totals_definition(&harness));
            let entry = harness.service.entry(&status.session_id).unwrap();
            let engine = entry.engine.lock().unwrap();
            let request = totals_request(&status, TabulateTotalsKind::Grand);
            let service = harness.service.clone();
            let request_id = request.request_id.clone();
            let worker = std::thread::spawn(move || service.query_totals(&request));
            await_active(&harness.service, &request_id, false);
            let releaser = if release {
                let service = harness.service.clone();
                let session_id = status.session_id.clone();
                let worker = std::thread::spawn(move || service.release(&session_id));
                let deadline = Instant::now() + Duration::from_secs(10);
                while !entry.released.load(Ordering::Acquire) {
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
                Some(worker)
            } else {
                harness
                    .source
                    .bump_dataset_generation("session-test")
                    .unwrap();
                None
            };
            drop(engine);
            assert_window_error(
                worker.join().unwrap(),
                if release {
                    "tabulate_session_unavailable"
                } else {
                    "tabulate_stale_source"
                },
            );
            if let Some(worker) = releaser {
                worker.join().unwrap().unwrap();
            }
            assert!(harness
                .service
                .inner
                .active_requests
                .lock()
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn tabulate_window_exact_nested_null_duplicate_sparse_boundaries() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        harness
            .source
            .conn()
            .execute_batch(
                "ALTER TABLE dataset_session_test ADD COLUMN subregion VARCHAR;
             ALTER TABLE dataset_session_test ADD COLUMN variant VARCHAR;
             DELETE FROM dataset_session_test;
             INSERT INTO dataset_session_test VALUES
             ('A', 'X', 10, 'a', 'x'), ('A', 'X', 20, 'a', 'x'),
             ('A', 'Y', 30, 'b', 'y'), ('B', 'X', 40, 'a', 'z'),
             ('B', NULL, NULL, 'b', NULL), (NULL, 'Y', 60, NULL, 'y');",
            )
            .expect("nested fixture");
        let mut definition = harness.request();
        definition.row_fields = vec!["region".into(), "subregion".into()];
        definition.column_fields = vec!["product".into(), "variant".into()];
        definition.statistics.push(TabulateStatistic {
            id: "count".into(),
            field: "sales".into(),
            kind: StatisticKind::Count,
            quantile: None,
        });
        let status = harness.ready(&definition);
        let members = [
            serde_json::json!(["A", "a"]),
            serde_json::json!(["A", "b"]),
            serde_json::json!(["B", "a"]),
            serde_json::json!(["B", "b"]),
            serde_json::json!([null, null]),
        ];
        let columns = [
            serde_json::json!(["X", "x"]),
            serde_json::json!(["X", "z"]),
            serde_json::json!(["Y", "y"]),
            serde_json::json!([null, null]),
        ];
        for (row_start, column_start, expected) in [
            (0, 0, vec![(0, 0, 0, Some(15.0)), (0, 0, 1, Some(2.0))]),
            (
                1,
                1,
                vec![
                    (0, 1, 0, Some(30.0)),
                    (0, 1, 1, Some(1.0)),
                    (1, 0, 0, Some(40.0)),
                    (1, 0, 1, Some(1.0)),
                ],
            ),
            (
                3,
                2,
                vec![
                    (0, 1, 0, None),
                    (0, 1, 1, Some(0.0)),
                    (1, 0, 0, Some(60.0)),
                    (1, 0, 1, Some(1.0)),
                ],
            ),
            (4, 3, vec![]),
        ] {
            let request = TabulateWindowRequest {
                row_start,
                column_start,
                ..window_request(&status)
            };
            let result = harness
                .service
                .query_window(&request)
                .expect("exact window");
            let row_end = (row_start as usize + 2).min(members.len());
            let column_end = (column_start as usize + 2).min(columns.len());
            assert_eq!(
                serde_json::to_value(&result.row_members).unwrap(),
                serde_json::json!(members[row_start as usize..row_end])
            );
            assert_eq!(
                serde_json::to_value(&result.column_members).unwrap(),
                serde_json::json!(columns[column_start as usize..column_end])
            );
            assert_eq!(
                result
                    .row_member_before
                    .as_ref()
                    .map(|member| serde_json::json!(member)),
                row_start
                    .checked_sub(1)
                    .map(|index| members[index as usize].clone())
            );
            assert_eq!(
                result
                    .row_member_after
                    .as_ref()
                    .map(|member| serde_json::json!(member)),
                members.get(row_end).cloned()
            );
            assert_eq!(
                result
                    .column_member_before
                    .as_ref()
                    .map(|member| serde_json::json!(member)),
                column_start
                    .checked_sub(1)
                    .map(|index| columns[index as usize].clone())
            );
            assert_eq!(
                result
                    .column_member_after
                    .as_ref()
                    .map(|member| serde_json::json!(member)),
                columns.get(column_end).cloned()
            );
            assert_eq!(
                result
                    .cells
                    .iter()
                    .map(|cell| (
                        cell.row_index,
                        cell.column_index,
                        cell.statistic_index,
                        cell.value
                    ))
                    .collect::<Vec<_>>(),
                expected
            );
            assert_eq!(
                (result.row_start, result.column_start),
                (row_start, column_start)
            );
            assert_eq!(
                (result.row_member_count, result.column_member_count),
                (5, 4)
            );
            assert_eq!(result.fingerprint, status.fingerprint);
            assert_eq!(result.source_generation, status.source_generation);
            assert_eq!(result.request_id, request.request_id);
            assert_eq!(result.session_id, status.session_id);
            assert_eq!(result.statistics, definition.statistics);
            assert!(!result.row_totals_ready && !result.column_totals_ready);
        }
    }

    #[test]
    fn tabulate_window_deep_ordinals_are_local_and_sparse() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        harness.source.conn().execute_batch(
            "DELETE FROM dataset_session_test;
             INSERT INTO dataset_session_test SELECT printf('%06d', range), printf('%06d', range), range FROM range(10000);"
        ).unwrap();
        let status = harness.ready(&harness.request());
        let result = harness
            .service
            .query_window(&TabulateWindowRequest {
                row_start: 9998,
                column_start: 9998,
                row_count: 128,
                column_count: 64,
                ..window_request(&status)
            })
            .unwrap();
        assert_eq!(
            (result.row_member_count, result.column_member_count),
            (10000, 10000)
        );
        assert_eq!(
            (
                result.row_members.len(),
                result.column_members.len(),
                result.cells.len()
            ),
            (2, 2, 2)
        );
        assert_eq!(
            result
                .cells
                .iter()
                .map(|cell| (cell.row_index, cell.column_index, cell.value))
                .collect::<Vec<_>>(),
            vec![(0, 0, Some(9998.0)), (1, 1, Some(9999.0))]
        );
        assert!(result.row_member_after.is_none() && result.column_member_after.is_none());
    }

    #[test]
    fn tabulate_window_empty_roles_and_empty_source() {
        for (no_rows, no_columns, expected) in [
            (true, false, vec![Some(2.0), Some(2.0)]),
            (false, true, vec![Some(1.0), Some(2.0), Some(3.0)]),
            (true, true, vec![Some(2.0)]),
        ] {
            let harness = SessionHarness::new(256 * 1024 * 1024);
            let mut definition = harness.request();
            if no_rows {
                definition.row_fields.clear();
            }
            if no_columns {
                definition.column_fields.clear();
            }
            let status = harness.ready(&definition);
            let result = harness
                .service
                .query_window(&TabulateWindowRequest {
                    row_count: 128,
                    ..window_request(&status)
                })
                .unwrap();
            assert_eq!(
                result
                    .cells
                    .iter()
                    .map(|cell| cell.value)
                    .collect::<Vec<_>>(),
                expected
            );
            if no_rows {
                assert_eq!(result.row_members, vec![Vec::<serde_json::Value>::new()]);
            }
            if no_columns {
                assert_eq!(result.column_members, vec![Vec::<serde_json::Value>::new()]);
            }
        }
        for empty_roles in [false, true] {
            let harness = SessionHarness::new(256 * 1024 * 1024);
            harness
                .source
                .conn()
                .execute("DELETE FROM dataset_session_test", [])
                .unwrap();
            let mut definition = harness.request();
            if empty_roles {
                definition.row_fields.clear();
                definition.column_fields.clear();
            }
            let status = harness.ready(&definition);
            let result = harness
                .service
                .query_window(&window_request(&status))
                .unwrap();
            assert!(result.cells.is_empty());
            assert_eq!(result.row_members.len(), usize::from(empty_roles));
            assert_eq!(result.column_members.len(), usize::from(empty_roles));
        }
    }

    #[test]
    fn tabulate_window_rejects_caps_overflow_and_unknown_bounds() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let mut definition = harness.request();
        for index in 1..3 {
            let mut statistic = definition.statistics[0].clone();
            statistic.id = format!("mean-{index}");
            definition.statistics.push(statistic);
        }
        let status = harness.ready(&definition);
        let valid = window_request(&status);
        let invalid = [
            TabulateWindowRequest {
                row_count: 129,
                ..valid.clone()
            },
            TabulateWindowRequest {
                column_count: 65,
                ..valid.clone()
            },
            TabulateWindowRequest {
                row_count: 128,
                column_count: 64,
                ..valid.clone()
            },
            TabulateWindowRequest {
                row_start: u64::MAX,
                ..valid.clone()
            },
            TabulateWindowRequest {
                column_start: u64::MAX,
                ..valid.clone()
            },
            TabulateWindowRequest {
                row_start: 4,
                ..valid.clone()
            },
            TabulateWindowRequest {
                column_start: 3,
                ..valid.clone()
            },
            TabulateWindowRequest {
                row_count: 0,
                ..valid.clone()
            },
            TabulateWindowRequest {
                column_count: 0,
                ..valid.clone()
            },
        ];
        for request in invalid {
            assert_window_error(
                harness.service.query_window(&request),
                "tabulate_invalid_bounds",
            );
        }
        let edge = harness
            .service
            .query_window(&TabulateWindowRequest {
                row_start: 3,
                column_start: 2,
                ..valid
            })
            .unwrap();
        assert!(
            edge.row_members.is_empty() && edge.column_members.is_empty() && edge.cells.is_empty()
        );
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tabulate_window_rejects_stale_generation_released_and_wrong_fingerprint() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let status = harness.ready(&harness.request());
        let request = window_request(&status);
        assert_window_error(
            harness.service.query_window(&TabulateWindowRequest {
                source_generation: status.source_generation + 1,
                ..request.clone()
            }),
            "tabulate_stale_source",
        );
        assert_window_error(
            harness
                .service
                .begin_query(&status.session_id, status.source_generation, "wrong")
                .map(|_| ()),
            "tabulate_stale_source",
        );
        harness
            .service
            .inner
            .registry
            .lock()
            .unwrap()
            .signatures
            .insert(status.fingerprint.clone(), "wrong-session".into());
        assert_window_error(
            harness.service.query_window(&request),
            "tabulate_stale_source",
        );
        harness
            .service
            .inner
            .registry
            .lock()
            .unwrap()
            .signatures
            .insert(status.fingerprint.clone(), status.session_id.clone());
        harness
            .source
            .bump_dataset_generation("session-test")
            .unwrap();
        assert_window_error(
            harness.service.query_window(&request),
            "tabulate_stale_source",
        );
        assert_window_error(
            harness.service.query_window(&request),
            "tabulate_session_unavailable",
        );
        let next = harness.ready(&harness.request());
        harness.service.release(&next.session_id).unwrap();
        assert_window_error(
            harness.service.query_window(&window_request(&next)),
            "tabulate_session_unavailable",
        );
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
    }

    fn await_active(service: &TabulateSessionService, request_id: &str, running: bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if service
                .inner
                .active_requests
                .lock()
                .unwrap()
                .get(request_id)
                .is_some_and(|request| !running || request.running)
            {
                return;
            }
            assert!(Instant::now() < deadline, "request never became active");
            std::thread::yield_now();
        }
    }

    #[test]
    fn tabulate_window_cancels_expensive_query_by_id_and_cleans_up() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let status = harness.ready(&harness.request());
        harness
            .source
            .conn()
            .execute_batch(
                "DROP TABLE dataset_session_test;
             CREATE VIEW dataset_session_test AS SELECT 'East'::VARCHAR AS region,
             'A'::VARCHAR AS product, sin(range::DOUBLE) AS sales FROM range(1000000000);",
            )
            .unwrap();
        let request = window_request(&status);
        let service = harness.service.clone();
        let worker_request = request.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker =
            std::thread::spawn(move || sender.send(service.query_window(&worker_request)).unwrap());
        await_active(&harness.service, &request.request_id, true);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        harness.service.cancel_request("unrelated").unwrap();
        let queued_request = window_request(&status);
        let service = harness.service.clone();
        let queued_id = queued_request.request_id.clone();
        let queued = std::thread::spawn(move || service.query_window(&queued_request));
        await_active(&harness.service, &queued_id, false);
        harness.service.cancel_request(&queued_id).unwrap();
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        harness.service.cancel_request(&request.request_id).unwrap();
        assert_window_error(
            receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("cancellation must interrupt the running query"),
            "tabulate_cancelled",
        );
        worker.join().unwrap();
        assert_window_error(queued.join().unwrap(), "tabulate_cancelled");
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
        assert_eq!(
            harness.service.inner.registry.lock().unwrap().sessions[&status.session_id]
                .active_queries,
            0
        );
        harness.source.conn().execute_batch(
            "DROP VIEW dataset_session_test;
             CREATE TABLE dataset_session_test AS SELECT 'East'::VARCHAR AS region, 'A'::VARCHAR AS product, 7.0::DOUBLE AS sales;"
        ).unwrap();
        harness.service.cancel_request(&request.request_id).unwrap();
        let result = harness.service.query_window(&request).unwrap();
        assert_eq!(result.cells[0].value, Some(7.0));
    }

    #[test]
    fn tabulate_window_queued_cancellation_and_duplicate_id_are_isolated() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let status = harness.ready(&harness.request());
        let entry = harness.service.entry(&status.session_id).unwrap();
        let engine = entry.engine.lock().unwrap();
        let request = window_request(&status);
        let service = harness.service.clone();
        let worker_request = request.clone();
        let worker = std::thread::spawn(move || service.query_window(&worker_request));
        await_active(&harness.service, &request.request_id, false);
        assert_window_error(
            harness.service.query_window(&request),
            "tabulate_request_active",
        );
        harness.service.cancel_request(&request.request_id).unwrap();
        drop(engine);
        assert_window_error(worker.join().unwrap(), "tabulate_cancelled");
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
        assert!(harness.service.query_window(&request).is_ok());
    }

    #[test]
    fn tabulate_window_completed_guard_cannot_remove_reused_request_id() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let status = harness.ready(&harness.request());
        let entry = harness.service.entry(&status.session_id).unwrap();
        let old = TabulateRequestGuard {
            inner: Arc::clone(&harness.service.inner),
            request_id: "reused".into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let replacement = Arc::new(AtomicBool::new(false));
        harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .insert(
                "reused".into(),
                TabulateActiveRequest {
                    cancelled: Arc::clone(&replacement),
                    interrupt_handle: Arc::clone(&entry.interrupt_handle),
                    running: false,
                },
            );
        drop(old);
        harness.service.cancel_request("reused").unwrap();
        assert!(
            replacement.load(Ordering::Acquire),
            "late cleanup removed the replacement request"
        );
        harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .clear();
    }

    #[test]
    fn tabulate_window_queued_source_change_and_release_cannot_publish() {
        for release in [false, true] {
            let harness = SessionHarness::new(256 * 1024 * 1024);
            let status = harness.ready(&harness.request());
            let entry = harness.service.entry(&status.session_id).unwrap();
            let engine = entry.engine.lock().unwrap();
            let request = window_request(&status);
            let service = harness.service.clone();
            let worker_request = request.clone();
            let worker = std::thread::spawn(move || service.query_window(&worker_request));
            await_active(&harness.service, &request.request_id, false);
            let releaser = if release {
                let service = harness.service.clone();
                let session_id = status.session_id.clone();
                let worker = std::thread::spawn(move || service.release(&session_id));
                let deadline = Instant::now() + Duration::from_secs(10);
                while !entry.released.load(Ordering::Acquire) {
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
                Some(worker)
            } else {
                harness
                    .source
                    .bump_dataset_generation("session-test")
                    .unwrap();
                None
            };
            drop(engine);
            assert_window_error(
                worker.join().unwrap(),
                if release {
                    "tabulate_session_unavailable"
                } else {
                    "tabulate_stale_source"
                },
            );
            if let Some(worker) = releaser {
                worker.join().unwrap().unwrap();
            }
            assert!(harness
                .service
                .inner
                .active_requests
                .lock()
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn tabulate_window_sql_failure_removes_request_and_allows_retry() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let status = harness.ready(&harness.request());
        let entry = harness.service.entry(&status.session_id).unwrap();
        entry
            .engine
            .lock()
            .unwrap()
            .drop_tabulate_member_indexes(&entry.uuid)
            .unwrap();
        let request = window_request(&status);
        assert!(harness.service.query_window(&request).is_err());
        assert!(harness
            .service
            .inner
            .active_requests
            .lock()
            .unwrap()
            .is_empty());
        entry
            .engine
            .lock()
            .unwrap()
            .prepare_tabulate_member_indexes(&entry.request, &entry.uuid, usize::MAX)
            .unwrap();
        assert!(harness.service.query_window(&request).is_ok());
    }

    #[test]
    fn reuses_complete_fingerprint_and_does_not_reuse_changed_definition() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let first = harness.ready(&request);
        let reused = harness.ready(&request);
        assert_eq!(first.session_id, reused.session_id);
        assert_eq!(
            (
                first.row_member_count,
                first.column_member_count,
                first.logical_cell_count
            ),
            (3, 2, 6)
        );
        assert!(first.measured_member_index_bytes > 0);
        let mut variants = Vec::new();
        let mut changed = request.clone();
        changed.include_row_totals = false;
        variants.push(changed);
        let mut changed = request.clone();
        changed.include_column_totals = false;
        variants.push(changed);
        let mut changed = request.clone();
        changed.statistics[0].kind = StatisticKind::Sum;
        variants.push(changed);
        let mut changed = request.clone();
        changed.statistics[0].id = "other".into();
        variants.push(changed);
        let mut changed = request.clone();
        changed.row_fields = vec!["product".into()];
        variants.push(changed);
        let mut changed = request.clone();
        changed.column_fields.clear();
        variants.push(changed);
        let mut changed = request.clone();
        changed.statistics[0].quantile = Some(0.25);
        variants.push(changed);
        for changed in variants {
            assert_ne!(harness.ready(&changed).fingerprint, first.fingerprint);
        }
    }

    #[test]
    fn generation_mismatch_rejects_and_invalidates_existing_session() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let first = harness.ready(&request);
        harness
            .source
            .bump_dataset_generation("session-test")
            .expect("bump");
        assert!(harness.service.prepare(&request).is_err());
        assert!(harness.service.status(&first.session_id).is_err());
        let next = harness.ready(&harness.request());
        assert_ne!(first.fingerprint, next.fingerprint);
    }

    #[test]
    fn generation_mismatch_revokes_all_client_leases() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let first = harness.service.prepare(&request).expect("first prepare");
        let second = harness.service.prepare(&request).expect("second prepare");
        assert_eq!(first.session_id, second.session_id);
        harness
            .source
            .bump_dataset_generation("session-test")
            .expect("bump");

        assert!(harness.service.status(&first.session_id).is_err());
        assert!(harness.service.entry(&first.session_id).is_err());
    }

    #[test]
    fn evicts_lru_at_two_sessions_and_preserves_leases() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let mut request = harness.request();
        let first = harness.ready(&request);
        let lease = harness
            .service
            .acquire_lease(&first.session_id)
            .expect("lease");
        harness.advance(1);
        request.include_row_totals = false;
        let second_entry = harness.paused(&request);
        harness.service.complete_prepare(&second_entry);
        harness.advance(1);
        request.include_column_totals = false;
        let third = harness.ready(&request);
        assert!(harness.service.status(&second_entry.session_id).is_err());
        harness.assert_dropped(&second_entry);
        assert!(harness.service.status(&first.session_id).is_ok());
        let other_lease = harness
            .service
            .acquire_lease(&third.session_id)
            .expect("lease");
        request.statistics[0].id = "fourth".into();
        assert!(harness.service.prepare(&request).is_err());
        drop((lease, other_lease));
    }

    #[test]
    fn measured_byte_pressure_evicts_unleased_but_refuses_pinned_overflow() {
        let probe = SessionHarness::new(usize::MAX);
        let bytes = probe.ready(&probe.request()).measured_member_index_bytes as usize;
        let harness = SessionHarness::new(bytes);
        let mut request = harness.request();
        let first_entry = harness.paused(&request);
        harness.service.complete_prepare(&first_entry);
        request.include_row_totals = false;
        let second = harness.ready(&request);
        assert!(harness.service.status(&first_entry.session_id).is_err());
        harness.assert_dropped(&first_entry);
        let _lease = harness
            .service
            .acquire_lease(&second.session_id)
            .expect("lease");
        request.include_column_totals = false;
        let refused = harness.paused(&request);
        harness.service.complete_prepare(&refused);
        let status = harness
            .service
            .status(&refused.session_id)
            .expect("failed status");
        assert_eq!(status.state, TabulateSessionState::Failed);
        assert_eq!(
            status.failure_code.as_deref(),
            Some("tabulate_member_index_budget")
        );
        assert_eq!(status.measured_member_index_bytes, 0);
        harness.assert_dropped(&refused);
        assert_eq!(
            harness
                .service
                .status(&second.session_id)
                .expect("pinned")
                .state,
            TabulateSessionState::Ready
        );
    }

    #[test]
    fn oversized_single_index_is_never_ready() {
        let harness = SessionHarness::new(1);
        let entry = harness.paused(&harness.request());
        harness.service.complete_prepare(&entry);
        let status = harness.service.status(&entry.session_id).expect("failed");
        assert_eq!(
            status.failure_code.as_deref(),
            Some("tabulate_member_index_budget")
        );
        assert_eq!(status.state, TabulateSessionState::Failed);
        harness.assert_dropped(&entry);
    }

    #[test]
    fn cleanup_failure_releases_measured_byte_charge() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let entry = harness.paused(&request);
        harness.service.complete_prepare(&entry);
        assert!(harness.service.inner.measured_bytes.load(Ordering::Acquire) > 0);
        let poison_entry = Arc::clone(&entry);
        let poison = std::thread::spawn(move || {
            let _engine = poison_entry.engine.lock().expect("engine");
            panic!("poison engine lock");
        });
        assert!(poison.join().is_err());

        assert!(harness.service.cleanup(&entry).is_err());
        assert_eq!(
            harness.service.inner.measured_bytes.load(Ordering::Acquire),
            0
        );
    }

    #[test]
    fn expires_at_exactly_five_minutes_and_status_polling_does_not_extend_idle() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let entry = harness.paused(&harness.request());
        harness.service.complete_prepare(&entry);
        harness.advance(299_999);
        assert!(harness.service.status(&entry.session_id).is_ok());
        harness.advance(1);
        assert!(harness.service.status(&entry.session_id).is_err());
        harness.assert_dropped(&entry);
    }

    #[test]
    fn last_lease_drop_starts_idle_timer_and_reacquire_protects_again() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let ready = harness.ready(&harness.request());
        let first = harness
            .service
            .acquire_lease(&ready.session_id)
            .expect("lease");
        let second = harness
            .service
            .acquire_lease(&ready.session_id)
            .expect("lease");
        harness.advance(600_000);
        drop(first);
        assert!(harness.service.status(&ready.session_id).is_ok());
        drop(second);
        harness.advance(299_999);
        let third = harness
            .service
            .acquire_lease(&ready.session_id)
            .expect("reacquire");
        harness.advance(600_000);
        assert!(harness.service.status(&ready.session_id).is_ok());
        drop(third);
        harness.advance(300_000);
        assert!(harness.service.status(&ready.session_id).is_err());
    }

    #[test]
    fn active_query_survives_expiry_and_checks_identity() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let ready = harness.ready(&harness.request());
        assert!(harness
            .service
            .begin_query(
                &ready.session_id,
                ready.source_generation + 1,
                &ready.fingerprint
            )
            .is_err());
        assert!(harness
            .service
            .begin_query(&ready.session_id, ready.source_generation, "wrong")
            .is_err());
        let query = harness
            .service
            .begin_query(
                &ready.session_id,
                ready.source_generation,
                &ready.fingerprint,
            )
            .expect("query");
        harness.advance(600_000);
        assert!(harness.service.status(&ready.session_id).is_ok());
        drop(query);
        harness.advance(299_999);
        assert!(harness.service.status(&ready.session_id).is_ok());
        harness.advance(1);
        assert!(harness.service.status(&ready.session_id).is_err());
    }

    #[test]
    fn explicit_release_drops_tables_and_identity_even_with_a_lease() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let entry = harness.paused(&request);
        harness.service.complete_prepare(&entry);
        let lease = harness
            .service
            .acquire_lease(&entry.session_id)
            .expect("lease");
        harness.service.release(&entry.session_id).expect("release");
        harness
            .service
            .release(&entry.session_id)
            .expect("idempotent release");
        assert!(harness.service.status(&entry.session_id).is_err());
        harness.assert_dropped(&entry);
        drop(lease);
        assert_ne!(harness.ready(&request).session_id, entry.session_id);
    }

    #[test]
    fn repeated_public_prepare_requires_matching_releases() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let first = harness.service.prepare(&request).expect("first prepare");
        let second = harness.service.prepare(&request).expect("second prepare");
        assert_eq!(first.session_id, second.session_id);

        harness
            .service
            .release(&first.session_id)
            .expect("first release");
        assert!(harness.service.status(&first.session_id).is_ok());

        harness
            .service
            .release(&first.session_id)
            .expect("last release");
        assert!(harness.service.status(&first.session_id).is_err());
    }

    #[test]
    fn release_during_prepare_cannot_resurrect_session() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let entry = harness.paused(&request);
        harness.service.release(&entry.session_id).expect("release");
        harness.service.complete_prepare(&entry);
        assert!(harness.service.status(&entry.session_id).is_err());
        harness.assert_dropped(&entry);
        assert_ne!(harness.ready(&request).session_id, entry.session_id);
    }

    #[test]
    fn invalid_definition_is_rejected_before_registry_admission() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let mut request = harness.request();
        request.statistics.clear();
        assert!(harness.service.prepare(&request).is_err());
        request = harness.request();
        request.row_fields.push("region".into());
        assert!(harness.service.prepare(&request).is_err());
        request = harness.request();
        request.statistics[0].field = "region".into();
        assert!(harness.service.prepare(&request).is_err());
        request = harness.request();
        request.row_fields = vec!["region\"; DROP TABLE _meta_datasets; --".into()];
        assert!(harness.service.prepare(&request).is_err());
        assert!(harness
            .source
            .get_dataset_generation("session-test")
            .is_ok());
    }

    #[test]
    fn late_publication_after_materialization_cannot_resurrect_or_erase_replacement() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let request = harness.request();
        let entry = harness.paused(&request);
        let info = entry
            .engine
            .lock()
            .expect("engine")
            .prepare_tabulate_member_indexes(&request, &entry.uuid, usize::MAX)
            .expect("materialize");
        harness.service.release(&entry.session_id).expect("release");
        let replacement = harness.ready(&request);
        harness.service.publish_preparation(&entry, Ok(info));
        assert!(harness.service.status(&entry.session_id).is_err());
        harness.assert_dropped(&entry);
        assert_eq!(harness.ready(&request).session_id, replacement.session_id);
    }

    #[test]
    fn app_state_reset_revokes_old_registry_and_preserves_navigation_independence() {
        let state = crate::state::AppState::new().expect("state");
        let old_service = Arc::clone(&state.tabulate_sessions.read().expect("service"));
        let old_navigation = Arc::clone(&state.table_navigation.read().expect("navigation"));
        state.reset_db().expect("reset");
        let new_service = Arc::clone(&state.tabulate_sessions.read().expect("service"));
        assert!(!Arc::ptr_eq(&old_service, &new_service));
        assert!(old_service.inner.closed.load(Ordering::Acquire));
        assert!(!new_service.inner.closed.load(Ordering::Acquire));
        assert!(!Arc::ptr_eq(
            &old_navigation,
            &state.table_navigation.read().expect("navigation")
        ));
    }

    #[test]
    fn concurrent_prepare_reserves_one_identity() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers = (0..8)
            .map(|_| {
                let service = harness.service.clone();
                let request = harness.request();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    service.begin_prepare(&request).expect("prepare")
                })
            })
            .collect::<Vec<_>>();
        let entries = workers
            .into_iter()
            .map(|worker| worker.join().expect("join"))
            .collect::<Vec<_>>();
        assert_eq!(entries.iter().filter(|(_, fresh)| *fresh).count(), 1);
        assert!(entries
            .iter()
            .all(|(entry, _)| entry.session_id == entries[0].0.session_id));
        harness.service.complete_prepare(&entries[0].0);
        assert_eq!(
            harness
                .service
                .status(&entries[0].0.session_id)
                .expect("status")
                .state,
            TabulateSessionState::Ready
        );
    }

    #[test]
    fn public_prepare_worker_publishes_ready_and_shutdown_reclaims_all() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let preparing = harness
            .service
            .prepare(&harness.request())
            .expect("prepare");
        assert_eq!(preparing.state, TabulateSessionState::Preparing);
        let entry = harness.service.entry(&preparing.session_id).expect("entry");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = harness
                .service
                .status(&preparing.session_id)
                .expect("status");
            if status.state == TabulateSessionState::Ready {
                break;
            }
            assert_eq!(status.state, TabulateSessionState::Preparing, "{status:?}");
            assert!(Instant::now() < deadline, "preparation timed out");
            std::thread::yield_now();
        }
        harness.service.shutdown().expect("shutdown");
        assert!(harness.service.status(&entry.session_id).is_err());
        assert!(harness.service.prepare(&harness.request()).is_err());
        harness.assert_dropped(&entry);
        assert_eq!(
            harness.service.inner.measured_bytes.load(Ordering::Acquire),
            0
        );
    }

    #[test]
    fn new_generation_reclaims_stale_leased_sessions_before_quota_admission() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let mut request = harness.request();
        let first = harness.ready(&request);
        let _first_lease = harness
            .service
            .acquire_lease(&first.session_id)
            .expect("lease");
        request.include_row_totals = false;
        let second = harness.ready(&request);
        let _second_lease = harness
            .service
            .acquire_lease(&second.session_id)
            .expect("lease");
        harness
            .source
            .bump_dataset_generation("session-test")
            .expect("bump");
        let replacement = harness.ready(&harness.request());
        assert_ne!(replacement.source_generation, first.source_generation);
        assert!(harness.service.entry(&first.session_id).is_err());
        assert!(harness.service.entry(&second.session_id).is_err());
    }

    #[test]
    fn release_removes_identity_before_waiting_for_engine_and_late_worker() {
        let harness = SessionHarness::new(256 * 1024 * 1024);
        let entry = harness.paused(&harness.request());
        let engine = entry.engine.lock().expect("hold engine");
        let releasing_service = harness.service.clone();
        let session_id = entry.session_id.clone();
        let release = std::thread::spawn(move || releasing_service.release(&session_id));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entry.released.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "release waited before invalidating"
            );
            std::thread::yield_now();
        }
        assert!(harness.service.entry(&entry.session_id).is_err());
        let worker_service = harness.service.clone();
        let worker_entry = Arc::clone(&entry);
        let worker = std::thread::spawn(move || worker_service.complete_prepare(&worker_entry));
        drop(engine);
        release.join().expect("release join").expect("release");
        worker.join().expect("worker join");
        harness.assert_dropped(&entry);
        assert!(harness.service.status(&entry.session_id).is_err());
    }
}

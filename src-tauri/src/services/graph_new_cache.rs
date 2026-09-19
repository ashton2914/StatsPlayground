use std::collections::BTreeMap;
use std::fs::{self, File, Metadata};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use super::graph_new_key::{GraphKey, RetentionPolicy};
use super::graph_new_lod::TilePyramid;
use super::graph_new_service::GraphNewBuildResult;
use crate::error::AppError;

pub const DEFAULT_PROCESS_BYTES: u64 = 1024 * 1024 * 1024;
pub const DEFAULT_GPU_BYTES: u64 = 256 * 1024 * 1024;
pub const DEFAULT_DISK_BYTES: u64 = 1024 * 1024 * 1024;

struct MemoryPool {
    used: AtomicU64,
    limit: u64,
}

pub(super) struct MemoryReservation {
    pool: Arc<MemoryPool>,
    bytes: u64,
}

impl MemoryReservation {
    fn new(pool: Arc<MemoryPool>, bytes: u64) -> Result<Self, AppError> {
        pool.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|total| *total <= pool.limit)
            })
            .map_err(|_| cache_pressure())?;
        Ok(Self { pool, bytes })
    }

    pub(super) fn retain_completed_build(&mut self, built: &GraphNewBuildResult) -> Result<(), AppError> {
        let bytes = built.pyramid.resident_bytes()
            .checked_add(built.pyramid.decoded_bytes())
            .and_then(|bytes| bytes.checked_add(4096))
            .ok_or_else(cache_pressure)?;
        let released = self.bytes.checked_sub(bytes).ok_or_else(cache_pressure)?;
        self.pool.used.fetch_sub(released, Ordering::AcqRel);
        self.bytes = bytes;
        Ok(())
    }
}

impl Drop for MemoryReservation {
    fn drop(&mut self) {
        self.pool.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

struct DiskGraph {
    bytes: u64,
    touched: u64,
    identity: Metadata,
    _reservation: MemoryReservation,
}

struct ResidentGraph {
    built: GraphNewBuildResult,
    bytes: u64,
    touched: u64,
    _reservation: MemoryReservation,
}

pub struct GraphNewCacheCoordinator {
    entries: BTreeMap<String, ResidentGraph>,
    pinned: Option<String>,
    clock: u64,
    cpu_limit: u64,
    pub cpu_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    directory: Option<PathBuf>,
    owner: Option<CacheOwner>,
    disk: BTreeMap<String, DiskGraph>,
    disk_limit: u64,
    pub disk_bytes: u64,
    pub disk_hits: u64,
    pub disk_evictions: u64,
    pub corruptions: u64,
    pub disk_write_failures: u64,
    epoch: u64,
    pool: Arc<MemoryPool>,
    pending: Option<(String, MemoryReservation)>,
}

impl Default for GraphNewCacheCoordinator {
    fn default() -> Self {
        static POOL: OnceLock<Arc<MemoryPool>> = OnceLock::new();
        let mut cache = Self::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.pool = POOL
            .get_or_init(|| {
                Arc::new(MemoryPool {
                    used: AtomicU64::new(0),
                    limit: DEFAULT_PROCESS_BYTES - DEFAULT_GPU_BYTES,
                })
            })
            .clone();
        cache
    }
}

impl GraphNewCacheCoordinator {
    pub fn new(process_bytes: u64, gpu_reservation: u64) -> Self {
        Self {
            entries: BTreeMap::new(),
            pinned: None,
            clock: 0,
            cpu_limit: process_bytes.saturating_sub(gpu_reservation),
            cpu_bytes: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
            directory: None,
            owner: None,
            disk: BTreeMap::new(),
            disk_limit: DEFAULT_DISK_BYTES,
            disk_bytes: 0,
            disk_hits: 0,
            disk_evictions: 0,
            corruptions: 0,
            disk_write_failures: 0,
            epoch: 0,
            pool: Arc::new(MemoryPool {
                used: AtomicU64::new(0),
                limit: process_bytes.saturating_sub(gpu_reservation),
            }),
            pending: None,
        }
    }

    pub fn contains(&mut self, key: &str) -> bool {
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(key) {
            entry.touched = self.clock;
            self.hits += 1;
            true
        } else {
            self.misses += 1;
            false
        }
    }

    pub fn get(&self, key: &str) -> Option<&GraphNewBuildResult> {
        self.entries.get(key).map(|entry| &entry.built)
    }

    pub(super) fn admit_construction(
        &mut self,
        cpu_bytes: u64,
        required_disk: u64,
    ) -> Result<(MemoryReservation, u64), AppError> {
        self.ensure_construction_disk_feasible(required_disk)?;
        if cpu_bytes > self.cpu_limit {
            return Err(cache_pressure());
        }
        let local_used = self.reserved_cpu_bytes()
            .checked_add(self.pending.as_ref().map_or(0, |(_, reservation)| reservation.bytes))
            .ok_or_else(cache_pressure)?;
        let mut candidates = self.entries.iter()
            .filter(|(key, _)| self.pinned.as_ref() != Some(key))
            .map(|(key, entry)| (key.clone(), entry._reservation.bytes, entry.touched))
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| (left.2, &left.0).cmp(&(right.2, &right.0)));
        let (victim_count, additional) = loop {
            let used = self.pool.used.load(Ordering::Acquire);
            let mut reclaimed = 0u64;
            let mut victim_count = 0;
            while used.checked_sub(reclaimed).and_then(|bytes| bytes.checked_add(cpu_bytes))
                .is_none_or(|bytes| bytes > self.pool.limit)
                || local_used.checked_sub(reclaimed).and_then(|bytes| bytes.checked_add(cpu_bytes))
                    .is_none_or(|bytes| bytes > self.cpu_limit)
            {
                let Some((_, bytes, _)) = candidates.get(victim_count) else {
                    return Err(cache_pressure());
                };
                reclaimed = reclaimed.checked_add(*bytes).ok_or_else(cache_pressure)?;
                victim_count += 1;
            }
            let additional = cpu_bytes.saturating_sub(reclaimed);
            let reserved = used.checked_add(additional).ok_or_else(cache_pressure)?;
            if self.pool.used.compare_exchange(used, reserved, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                break (victim_count, additional);
            }
        };
        let mut reservation = MemoryReservation { pool: self.pool.clone(), bytes: additional };
        for (key, _, _) in candidates.iter().take(victim_count) {
            if let Some(mut entry) = self.entries.remove(key) {
                self.cpu_bytes -= entry.bytes;
                reservation.bytes += entry._reservation.bytes;
                entry._reservation.bytes = 0;
                self.evictions += 1;
            }
        }
        let surplus = reservation.bytes - cpu_bytes;
        self.pool.used.fetch_sub(surplus, Ordering::AcqRel);
        reservation.bytes = cpu_bytes;
        let disk_limit = self.construction_disk_budget(required_disk)?;
        Ok((reservation, disk_limit))
    }

    fn ensure_construction_disk_feasible(&self, required: u64) -> Result<(), AppError> {
        let pinned_live = self.pinned.as_ref().and_then(|key| self.entries.get(key))
            .map_or(0, |entry| entry.built.pyramid.encoded_bytes());
        let pinned_disk = self.pinned.as_ref().and_then(|key| self.disk.get(key))
            .map_or(0, |entry| entry.bytes);
        if pinned_live.checked_add(pinned_disk)
            .and_then(|bytes| bytes.checked_add(required))
            .is_none_or(|bytes| bytes > self.disk_limit) {
            return Err(cache_pressure());
        }
        Ok(())
    }

    fn construction_disk_budget(&mut self, required: u64) -> Result<u64, AppError> {
        self.ensure_construction_disk_feasible(required)?;
        loop {
            let available = self.disk_limit.saturating_sub(self.disk_bytes)
                .saturating_sub(self.live_file_bytes());
            if required <= available {
                return Ok(available);
            }
            if let Some(victim) = self.disk_victim() {
                self.remove_disk(&victim)?;
                self.disk_evictions += 1;
                continue;
            }
            let victim = self.entries.iter()
                .filter(|(key, entry)| self.pinned.as_ref() != Some(key)
                    && entry.built.pyramid.encoded_bytes() > 0)
                .min_by_key(|(key, entry)| (entry.touched, *key))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else { return Err(cache_pressure()); };
            self.remove(&victim);
            self.evictions += 1;
        }
    }

    pub fn insert(&mut self, built: GraphNewBuildResult) -> Result<(), AppError> {
        self.prepare_admission(&built)?;
        let (_, reservation) = self.pending.take().ok_or_else(cache_pressure)?;
        let bytes = built.pyramid.cache_reservation_bytes() + 4096;
        let key = built.key.hash_hex.clone();
        self.remove(&key);
        self.clock += 1;
        self.cpu_bytes += bytes;
        self.entries.insert(
            key,
            ResidentGraph {
                built,
                bytes,
                touched: self.clock,
                _reservation: reservation,
            },
        );
        Ok(())
    }

    pub fn prepare_admission(&mut self, built: &GraphNewBuildResult) -> Result<(), AppError> {
        if built.pyramid.raw_store.is_some() != (built.key.retention_policy == super::graph_new_key::RetentionPolicy::Lossless) {
            return Err(AppError::Stats("graph_new_cache_mode_mismatch".into()));
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|(key, _)| key == &built.key.hash_hex)
        {
            return Ok(());
        }
        self.pending = None;
        let bytes = built.pyramid.cache_reservation_bytes() + 4096;
        if bytes > self.cpu_limit {
            return Err(AppError::Stats("graph_new_cache_pressure".into()));
        }
        let encoded = built.pyramid.encoded_bytes();
        if encoded > self.disk_limit {
            return Err(cache_pressure());
        }
        while self.reserved_cpu_bytes() + bytes > self.cpu_limit
            || self.live_file_bytes() + self.disk_bytes + encoded > self.disk_limit
        {
            if self.live_file_bytes() + self.disk_bytes + encoded > self.disk_limit {
                if let Some(victim) = self.disk_victim() {
                    self.remove_disk(&victim)?;
                    self.disk_evictions += 1;
                    continue;
                }
            }
            let victim = self
                .entries
                .iter()
                .filter(|(key, _)| self.pinned.as_ref() != Some(key))
                .min_by_key(|(key, entry)| (entry.touched, *key))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else {
                return Err(AppError::Stats("graph_new_cache_pressure".into()));
            };
            self.remove(&victim);
            self.evictions += 1;
        }
        loop {
            match MemoryReservation::new(self.pool.clone(), bytes) {
                Ok(reservation) => {
                    self.pending = Some((built.key.hash_hex.clone(), reservation));
                    return Ok(());
                }
                Err(_) => {
                    let victim = self
                        .entries
                        .iter()
                        .filter(|(key, _)| self.pinned.as_ref() != Some(key))
                        .min_by_key(|(key, entry)| (entry.touched, *key))
                        .map(|(key, _)| key.clone());
                    let Some(victim) = victim else {
                        return Err(cache_pressure());
                    };
                    self.remove(&victim);
                    self.evictions += 1;
                }
            }
        }
    }

    pub fn discard_admission(&mut self) {
        self.pending = None;
    }

    pub fn process_cpu_reserved_bytes(&self) -> u64 {
        self.pool.used.load(Ordering::Acquire)
    }

    pub fn sync_epoch(&mut self, epoch: u64) {
        if self.epoch != epoch {
            self.invalidate();
            if !self.disk.is_empty() {
                self.directory = None;
                self.disk.clear();
            }
            self.disk_bytes = 0;
            self.epoch = epoch;
        }
    }

    pub fn pin(&mut self, key: &str) {
        self.pinned = Some(key.into());
    }
    pub fn unpin(&mut self) {
        self.pinned = None;
    }

    pub fn evict_unpinned(&mut self) {
        let keys = self
            .entries
            .keys()
            .filter(|key| self.pinned.as_ref() != Some(key))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove(&key);
            self.evictions += 1;
        }
    }

    pub fn reserved_cpu_bytes(&self) -> u64 {
        self.cpu_bytes + self.disk.len() as u64 * 1024
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.cpu_bytes -= entry.bytes;
        }
        if self.pinned.as_deref() == Some(key) {
            self.pinned = None;
        }
    }

    pub fn reject_corrupt(&mut self, key: &str) {
        self.corruptions += 1;
        self.remove(key);
        let _ = self.remove_disk(key);
    }

    pub fn actual_cpu_bytes(&self) -> u64 {
        self.entries
            .values()
            .map(|entry| {
                entry.built.pyramid.resident_bytes() + entry.built.pyramid.decoded_bytes() + 4096
            })
            .sum::<u64>()
            + self.disk.len() as u64 * 1024
    }

    fn live_file_bytes(&self) -> u64 {
        self.entries
            .values()
            .map(|entry| entry.built.pyramid.encoded_bytes())
            .fold(0, u64::saturating_add)
    }

    pub fn set_directory(&mut self, base: &Path) -> Result<(), AppError> {
        if !cfg!(unix) || self.directory.is_some() {
            return Err(cache_path_error());
        }
        ensure_directory(base)?;
        let root = base.join("graph-new-derived-v1");
        ensure_directory(&root)?;
        let root_handle = anchored_directory(&root)?;
        retire_orphans(&root_handle);
        let directory = tempfile::Builder::new()
            .prefix("lifetime-")
            .tempdir_in(&root)
            .map_err(|_| cache_path_error())?
            .keep();
        let owner = CacheOwner::new(root_handle, &directory)?;
        self.owner = Some(owner);
        self.directory = Some(directory);
        Ok(())
    }

    fn disk_path(&self, key: &str) -> Result<PathBuf, AppError> {
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(cache_path_error());
        }
        let directory = self.directory.as_ref().ok_or_else(cache_path_error)?;
        validate_directory(directory)?;
        self.owner.as_ref().ok_or_else(cache_path_error)?.validate_path(directory)?;
        Ok(directory.join(format!("{key}.gnd")))
    }

    pub fn persist(&mut self, key: &str) -> Result<(), AppError> {
        if self.directory.is_none() {
            return Ok(());
        }
        if let Some(entry) = self.disk.get(key) {
            if self.disk_path(key).and_then(|_| self.owner.as_ref().ok_or_else(cache_path_error)?.open(key, &entry.identity)).is_ok() {
                return Ok(());
            }
            self.retire_disk(key);
        }
        let graph = self.entries.get(key).ok_or_else(cache_path_error)?;
        let required = graph.built.pyramid.persisted_bytes();
        while self.live_file_bytes() + self.disk_bytes + required > self.disk_limit
            || self.reserved_cpu_bytes() + 1024 > self.cpu_limit
        {
            let victim = self.disk_victim();
            let Some(victim) = victim else {
                return Err(cache_pressure());
            };
            self.remove_disk(&victim)?;
            self.disk_evictions += 1;
        }
        self.disk_path(key)?;
        let reservation = MemoryReservation::new(self.pool.clone(), 1024)?;
        let owner = self.owner.as_mut().ok_or_else(cache_path_error)?;
        let mut file = owner.create(key)?;
        let identity = file.metadata().map_err(|_| cache_path_error())?;
        let result = self.entries
            .get(key)
            .ok_or_else(cache_path_error)?
            .built
            .pyramid
            .write_cache(&mut file, key);
        if let Err(error) = result {
            let _ = owner.remove(key, &identity);
            return Err(error);
        }
        let identity = file.metadata().map_err(|_| cache_path_error())?;
        self.disk_bytes += identity.len();
        self.disk.insert(
            key.into(),
            DiskGraph {
                bytes: identity.len(),
                touched: self.clock,
                identity,
                _reservation: reservation,
            },
        );
        Ok(())
    }

    pub fn restore(&mut self, key: &GraphKey) -> Result<bool, AppError> {
        let Some(entry) = self.disk.get(&key.hash_hex) else {
            return Ok(false);
        };
        match self.disk_path(&key.hash_hex) {
            Ok(_) => {},
            Err(_) => {
                self.retire_disk(&key.hash_hex);
                return Ok(false);
            }
        };
        let file = match self.owner.as_ref().ok_or_else(cache_path_error)?.open(&key.hash_hex, &entry.identity) {
            Ok(file) => file,
            Err(_) => {
                self.retire_disk(&key.hash_hex);
                return Ok(false);
            }
        };
        self.evict_unpinned();
        let available = self.cpu_limit.saturating_sub(self.reserved_cpu_bytes());
        if available < 8 * 1024 * 1024 + 4096 {
            return Ok(false);
        }
        let available = available.min(self.pool.limit.saturating_sub(self.pool.used.load(Ordering::Acquire)));
        let restore_limit = (available / 2).min(320 * 1024 * 1024);
        let validation = match MemoryReservation::new(self.pool.clone(), restore_limit) {
            Ok(reservation) => reservation,
            Err(_) => return Ok(false),
        };
        let pyramid = match TilePyramid::read_cache_with_policy(file, &key.hash_hex, restore_limit, self.disk_limit, key.retention_policy)
        {
            Ok(pyramid) => pyramid,
            Err(AppError::Stats(message)) if message == "graph_new_cache_pressure" => {
                return Ok(false)
            }
            Err(AppError::Stats(message)) if message == "graph_new_overlay_cache_incompatible" => {
                return Ok(false)
            }
            Err(_) => {
                self.corruptions += 1;
                self.remove_disk(&key.hash_hex)?;
                return Ok(false);
            }
        };
        let summary = crate::models::graph_new_data::GraphNewBuildSummary {
            processed_rows: pyramid.total_processed_rows,
            finite_rows: pyramid.total_finite_rows,
            excluded_non_finite_rows: pyramid.total_excluded_non_finite_rows,
            projection_query_count: 0,
            spool_bytes: 0,
            accounted_memory_bytes: pyramid.resident_bytes(),
            overview_ready_ms: 0,
            pyramid_complete_ms: 0,
            levels: pyramid
                .levels
                .iter()
                .map(
                    |level| crate::models::graph_new_data::GraphNewLevelSummary {
                        level: level.level,
                        tile_count: level.tiles.len() as u64,
                        retained_marks: level.retained_marks,
                        tile_bytes: level.tile_bytes,
                        total_source_count: level.total_source_count,
                    },
                )
                .collect(),
        };
        let built = GraphNewBuildResult {
            key: key.clone(),
            processed_rows: summary.processed_rows,
            excluded_non_finite_rows: summary.excluded_non_finite_rows,
            query_count: 0,
            pyramid,
            summary,
        };
        if self.insert(built).is_err() {
            return Ok(false);
        }
        drop(validation);
        self.disk_hits += 1;
        if let Some(entry) = self.disk.get_mut(&key.hash_hex) {
            entry.touched = self.clock;
        }
        Ok(true)
    }

    fn remove_disk(&mut self, key: &str) -> Result<(), AppError> {
        if let Some(entry) = self.disk.get(key) {
            let owned = self.disk_path(key).and_then(|_| {
                self.owner.as_ref().ok_or_else(cache_path_error)?.open(key, &entry.identity)
            });
            let Ok(_file) = owned else {
                self.retire_disk(key);
                return Ok(());
            };
            self.owner.as_ref().ok_or_else(cache_path_error)?.remove(key, &entry.identity)?;
        }
        self.retire_disk(key);
        Ok(())
    }

    fn retire_disk(&mut self, key: &str) {
        if let Some(entry) = self.disk.remove(key) {
            self.disk_bytes -= entry.bytes;
        }
    }

    fn disk_victim(&self) -> Option<String> {
        self.disk
            .iter()
            .filter(|(key, _)| self.pinned.as_ref() != Some(key))
            .min_by_key(|(key, entry)| (entry.touched, *key))
            .map(|(key, _)| key.clone())
    }

    pub fn invalidate(&mut self) {
        self.pending = None;
        self.entries.clear();
        self.cpu_bytes = 0;
        self.pinned = None;
        for key in self.disk.keys().cloned().collect::<Vec<_>>() {
            let _ = self.remove_disk(&key);
        }
    }

    #[cfg(test)]
    pub fn is_none(&self) -> bool {
        self.entries.is_empty()
    }
    #[cfg(test)]
    pub fn is_some(&self) -> bool {
        !self.entries.is_empty()
    }
}

impl Drop for GraphNewCacheCoordinator {
    fn drop(&mut self) {
        self.invalidate();
        if let Some(owner) = self.owner.take() {
            owner.retire();
        }
    }
}

#[cfg(unix)]
struct CacheOwner {
    root: File,
    directory: File,
    marker: File,
    name: std::ffi::OsString,
    records: usize,
}

#[cfg(not(unix))]
struct CacheOwner;

#[cfg(unix)]
fn anchored_directory(path: &Path) -> Result<File, AppError> {
    use rustix::fs::{openat, Mode, OFlags};
    validate_directory(path)?;
    let mut current = File::open("/").map_err(|_| cache_path_error())?;
    for component in path.components() {
        if let Component::Normal(name) = component {
            current = openat(&current, name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
        }
    }
    Ok(current)
}

#[cfg(unix)]
impl CacheOwner {
    fn new(root: File, path: &Path) -> Result<Self, AppError> {
        use rustix::fs::{openat, Mode, OFlags};
        use std::io::Write;
        use std::os::unix::fs::MetadataExt;
        let name = path.file_name().ok_or_else(cache_path_error)?.to_owned();
        let directory = openat(&root, &name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
        rustix::fs::fchmod(&directory, Mode::RUSR | Mode::WUSR | Mode::XUSR)
            .map_err(|_| cache_path_error())?;
        let identity = directory.metadata().map_err(|_| cache_path_error())?;
        let mut marker = openat(&directory, "owner-v1", OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR).map(File::from).map_err(|_| cache_path_error())?;
        marker.try_lock().map_err(|_| cache_path_error())?;
        writeln!(marker, "graph-new-owner-v1 {} {}", identity.dev(), identity.ino()).map_err(|_| cache_path_error())?;
        marker.sync_all().map_err(|_| cache_path_error())?;
        Ok(Self { root, directory, marker, name, records: 0 })
    }

    fn validate_path(&self, path: &Path) -> Result<(), AppError> {
        use std::os::unix::fs::MetadataExt;
        let current = anchored_directory(path)?.metadata().map_err(|_| cache_path_error())?;
        let owned = self.directory.metadata().map_err(|_| cache_path_error())?;
        if current.dev() != owned.dev() || current.ino() != owned.ino() { return Err(cache_path_error()); }
        Ok(())
    }

    fn create(&mut self, key: &str) -> Result<File, AppError> {
        use rustix::fs::{openat, Mode, OFlags};
        use std::io::Write;
        use std::os::unix::fs::MetadataExt;
        if self.records >= 1024 { return Err(cache_pressure()); }
        let marker_identity = self.marker.metadata().map_err(|_| cache_path_error())?;
        let _marker = open_anchored_owned(&self.directory, "owner-v1", &marker_identity)?;
        let file = openat(&self.directory, format!("{key}.gnd"), OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR).map(File::from).map_err(|_| cache_path_error())?;
        let identity = file.metadata().map_err(|_| cache_path_error())?;
        writeln!(self.marker, "{key} {} {}", identity.dev(), identity.ino()).map_err(|_| cache_path_error())?;
        self.marker.sync_all().map_err(|_| cache_path_error())?;
        self.records += 1;
        Ok(file)
    }

    fn open(&self, key: &str, identity: &Metadata) -> Result<File, AppError> {
        open_anchored_owned(&self.directory, &format!("{key}.gnd"), identity)
    }

    fn remove(&self, key: &str, identity: &Metadata) -> Result<(), AppError> {
        let _file = self.open(key, identity)?;
        rustix::fs::unlinkat(&self.directory, format!("{key}.gnd"), rustix::fs::AtFlags::empty())
            .map_err(|_| cache_path_error())
    }

    fn retire(self) {
        let Self { root, directory, marker, name, .. } = self;
        drop(marker);
        drop(directory);
        let mut remaining_bytes = DEFAULT_DISK_BYTES;
        let _ = retire_namespace(&root, &name, &mut remaining_bytes);
    }
}

#[cfg(unix)]
fn retire_orphans(root: &File) {
    let mut remaining_bytes = DEFAULT_DISK_BYTES;
    let Ok(entries) = rustix::fs::Dir::read_from(root) else { return; };
    for entry in entries.take(64).flatten() {
        let name = entry.file_name().to_bytes();
        if name.starts_with(b"lifetime-") {
            let _ = retire_namespace(root, entry.file_name(), &mut remaining_bytes);
        }
    }
}

#[cfg(unix)]
fn retire_namespace(root: &File, name: impl rustix::path::Arg + Copy, remaining_bytes: &mut u64) -> Result<(), AppError> {
    use rustix::fs::{openat, statat, unlinkat, AtFlags, Mode, OFlags};
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let directory = openat(root, name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
    let identity = directory.metadata().map_err(|_| cache_path_error())?;
    let marker = openat(&directory, "owner-v1", OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
    let marker_identity = marker.metadata().map_err(|_| cache_path_error())?;
    if !marker_identity.is_file() || marker_identity.nlink() != 1 || identity.mode() & 0o077 != 0 {
        return Err(cache_path_error());
    }
    marker.try_lock().map_err(|_| cache_path_error())?;
    let mut content = String::new();
    (&marker).take(128 * 1024 + 1).read_to_string(&mut content).map_err(|_| cache_path_error())?;
    let mut lines = content.lines();
    if content.len() > 128 * 1024 || !content.ends_with('\n')
        || lines.next() != Some(format!("graph-new-owner-v1 {} {}", identity.dev(), identity.ino()).as_str()) {
        return Err(cache_path_error());
    }
    let mut records = BTreeMap::new();
    for (index, line) in lines.enumerate() {
        let parts = line.split(' ').collect::<Vec<_>>();
        if index >= 1024 || parts.len() != 3 || parts[0].len() != 64
            || !parts[0].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(cache_path_error());
        }
        let device = parts[1].parse::<u64>().map_err(|_| cache_path_error())?;
        let inode = parts[2].parse::<u64>().map_err(|_| cache_path_error())?;
        records.insert(format!("{}.gnd", parts[0]), (device, inode));
    }
    let mut owned_files = Vec::new();
    let mut bytes = 0u64;
    let entries = rustix::fs::Dir::read_from(&directory).map_err(|_| cache_path_error())?;
    for (index, entry) in entries.take(1028).enumerate() {
        let entry = entry.map_err(|_| cache_path_error())?;
        if index >= 1027 { return Err(cache_path_error()); }
        if matches!(entry.file_name().to_bytes(), b"." | b".." | b"owner-v1") { continue; }
        let filename = entry.file_name().to_str().map_err(|_| cache_path_error())?;
        let (device, inode) = records.get(filename).ok_or_else(cache_path_error)?;
        let file = openat(&directory, entry.file_name(), OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
        let metadata = file.metadata().map_err(|_| cache_path_error())?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.dev() != *device || metadata.ino() != *inode {
            return Err(cache_path_error());
        }
        bytes = bytes.checked_add(metadata.len()).ok_or_else(cache_path_error)?;
        if bytes > *remaining_bytes { return Err(cache_pressure()); }
        owned_files.push((filename.to_owned(), metadata));
    }
    for (filename, metadata) in &owned_files {
        let _file = open_anchored_owned(&directory, filename, metadata)?;
        unlinkat(&directory, filename, AtFlags::empty()).map_err(|_| cache_path_error())?;
        *remaining_bytes -= metadata.len();
    }
    let current = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| cache_path_error())?;
    let current_marker = statat(&directory, "owner-v1", AtFlags::SYMLINK_NOFOLLOW).map_err(|_| cache_path_error())?;
    if current.st_ino != identity.ino() || current.st_dev as u64 != identity.dev()
        || current_marker.st_ino != marker_identity.ino() || current_marker.st_dev as u64 != marker_identity.dev()
        || current_marker.st_nlink != 1 {
        return Err(cache_path_error());
    }
    unlinkat(&directory, "owner-v1", AtFlags::empty()).map_err(|_| cache_path_error())?;
    unlinkat(root, name, AtFlags::REMOVEDIR).map_err(|_| cache_path_error())
}

#[cfg(not(unix))]
fn anchored_directory(_: &Path) -> Result<File, AppError> { Err(cache_path_error()) }
#[cfg(not(unix))]
fn retire_orphans(_: &File) {}
#[cfg(not(unix))]
impl CacheOwner {
    fn new(_: File, _: &Path) -> Result<Self, AppError> { Err(cache_path_error()) }
    fn validate_path(&self, _: &Path) -> Result<(), AppError> { Err(cache_path_error()) }
    fn create(&mut self, _: &str) -> Result<File, AppError> { Err(cache_path_error()) }
    fn open(&self, _: &str, _: &Metadata) -> Result<File, AppError> { Err(cache_path_error()) }
    fn remove(&self, _: &str, _: &Metadata) -> Result<(), AppError> { Err(cache_path_error()) }
    fn retire(self) {}
}

#[cfg(unix)]
fn open_anchored_owned(directory: &File, name: &str, identity: &Metadata) -> Result<File, AppError> {
    use rustix::fs::{openat, statat, AtFlags, Mode, OFlags};
    use std::os::unix::fs::MetadataExt;
    let file = openat(directory, name, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty()).map(File::from).map_err(|_| cache_path_error())?;
    let opened = file.metadata().map_err(|_| cache_path_error())?;
    let current = statat(directory, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| cache_path_error())?;
    if !opened.is_file() || opened.nlink() != 1 || current.st_nlink != 1
        || opened.dev() != identity.dev() || opened.ino() != identity.ino()
        || current.st_ino != opened.ino() || current.st_dev as u64 != opened.dev() {
        return Err(cache_path_error());
    }
    Ok(file)
}

fn cache_path_error() -> AppError {
    AppError::FileIO("graph_new_cache_path_rejected".into())
}
fn cache_pressure() -> AppError {
    AppError::Stats("graph_new_cache_pressure".into())
}

/// Conservative admission bound, not a measurement: every metadata row is assumed finite
/// and tiles maximally occupied. This may reject clustered/non-finite data that would fit.
/// Includes overlapping source spool, buckets, raw records (lossless), and encoded output;
/// persistent copies are admitted separately. No scan or build retry is needed.
pub(super) fn construction_disk_requirement(
    rows: u64, levels: u8, max_tile_points: u32, policy: RetentionPolicy,
) -> Result<u64, AppError> {
    use crate::models::graph_new_data::{GRAPH_NEW_MAX_LEVELS, GRAPH_NEW_MAX_TILE_POINTS};
    if levels == 0 || levels > GRAPH_NEW_MAX_LEVELS
        || max_tile_points == 0 || max_tile_points > GRAPH_NEW_MAX_TILE_POINTS {
        return Err(cache_pressure());
    }
    let bounded_spool_bytes = (std::mem::size_of::<i64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<u16>()) as u64;
    let bounded_bucket_bytes = (std::mem::size_of::<u32>()
        + std::mem::size_of::<u32>()) as u64
        + bounded_spool_bytes;
    let tile_point_bytes = (std::mem::size_of::<i64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<f64>()
        + std::mem::size_of::<u16>()
        + std::mem::size_of::<u32>()) as u64;
    let record_bytes = if policy == RetentionPolicy::Lossless {
        bounded_spool_bytes
            .checked_add(bounded_bucket_bytes)
            .and_then(|bytes| bytes.checked_add(32))
            .ok_or_else(cache_pressure)?
    } else {
        bounded_spool_bytes
            .checked_add(bounded_bucket_bytes)
            .ok_or_else(cache_pressure)?
    };
    let mut required = rows.checked_mul(record_bytes).ok_or_else(cache_pressure)?;
    for level in 0..levels {
        let tiles = rows.min(1u64 << (2 * u32::from(level)));
        let marks = if level + 1 == levels {
            let limit = max_tile_points.min(if policy == RetentionPolicy::Lossless { 128 } else { 4096 });
            rows.min(tiles.checked_mul(u64::from(limit)).ok_or_else(cache_pressure)?)
        } else { tiles };
        required = tiles.checked_mul(128)
            .and_then(|bytes| marks.checked_mul(tile_point_bytes).and_then(|marks| bytes.checked_add(marks)))
            .and_then(|bytes| required.checked_add(bytes)).ok_or_else(cache_pressure)?;
    }
    Ok(required)
}

fn validate_directory(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(cache_path_error());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(cache_path_error());
        }
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| cache_path_error())?;
        if redirected(&metadata) || !metadata.is_dir() {
            return Err(cache_path_error());
        }
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(cache_path_error());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(cache_path_error());
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !redirected(&metadata) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| cache_path_error())?
            }
            _ => return Err(cache_path_error()),
        }
    }
    validate_directory(path)
}

fn redirected(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    metadata.file_type().is_symlink()
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::graph_new_key::{GraphKey, GraphKeyParts};
    use super::super::graph_new_lod::{SourcePoint, TilePyramidBuilder};
    use super::*;

    #[test]
    fn graph_new_recovery_crashed_namespace_is_retired_without_touching_live_owner() {
        const CHILD_ROOT: &str = "GRAPH_NEW_RECOVERY_CHILD_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let mut cache = GraphNewCacheCoordinator::default();
            cache.set_directory(Path::new(&root)).expect("child directory");
            let graph = built(0);
            let key = graph.key.hash_hex.clone();
            cache.insert(graph).expect("child graph");
            cache.persist(&key).expect("child derived file");
            std::process::exit(0);
        }
        let temporary = tempfile::tempdir().expect("temporary");
        let root = temporary.path().canonicalize().expect("canonical");
        let mut live = GraphNewCacheCoordinator::new(1024 * 1024, 0);
        live.set_directory(&root).expect("live directory");
        let live_path = live.directory.clone().expect("live path");
        let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "services::graph_new_cache::tests::graph_new_recovery_crashed_namespace_is_retired_without_touching_live_owner", "--nocapture"])
            .env(CHILD_ROOT, &root)
            .status().expect("child");
        assert!(status.success());
        let namespaces = || fs::read_dir(root.join("graph-new-derived-v1")).expect("root")
            .filter_map(Result::ok).filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .count();
        assert_eq!(namespaces(), 2);
        let mut restarted = GraphNewCacheCoordinator::new(1024 * 1024, 0);
        restarted.set_directory(&root).expect("restart directory");
        assert!(live_path.is_dir(), "live owner must survive another process startup");
        assert_eq!(namespaces(), 2, "retire the crashed namespace, never reuse its IDs");
    }

    pub(in crate::services) fn set_disk_limit(cache: &mut GraphNewCacheCoordinator, bytes: u64) {
        cache.disk_limit = bytes;
    }

    #[test]
    fn graph_new_recovery_drop_skips_replaced_directory() {
        let temporary = tempfile::tempdir().expect("temporary");
        let root = temporary.path().canonicalize().expect("canonical");
        let mut cache = GraphNewCacheCoordinator::default();
        cache.set_directory(&root).expect("directory");
        let namespace = cache.directory.clone().expect("namespace");
        fs::rename(&namespace, root.join("moved")).expect("move original");
        fs::create_dir(&namespace).expect("replacement");
        drop(cache);
        assert!(namespace.is_dir(), "replacement is not owned");
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_recovery_orphan_rejects_unknown_linked_replaced_and_oversized_entries() {
        use std::os::unix::fs::symlink;
        for mode in ["unknown", "symlink", "hardlink", "replaced", "oversized", "marker"] {
            let temporary = tempfile::tempdir().expect("temporary");
            let root = temporary.path().canonicalize().expect("canonical");
            let mut cache = GraphNewCacheCoordinator::default();
            cache.set_directory(&root).expect("directory");
            let graph = built(0);
            let key = graph.key.hash_hex.clone();
            cache.insert(graph).expect("graph");
            cache.persist(&key).expect("file");
            let path = cache.disk_path(&key).expect("path");
            let namespace = cache.directory.take().expect("namespace");
            let owner = cache.owner.take().expect("owner");
            drop(owner);
            cache.disk.clear();
            cache.disk_bytes = 0;
            match mode {
                "unknown" => fs::write(namespace.join("notes.txt"), b"keep").expect("unknown"),
                "symlink" => {
                    fs::rename(&path, root.join("original")).expect("move");
                    symlink(root.join("original"), &path).expect("link");
                }
                "hardlink" => fs::hard_link(&path, root.join("external")).expect("hardlink"),
                "replaced" => {
                    fs::rename(&path, root.join("original")).expect("move");
                    fs::write(&path, b"keep replacement").expect("replacement");
                }
                "oversized" => File::options().write(true).open(&path).expect("file")
                    .set_len(DEFAULT_DISK_BYTES + 1).expect("sparse length"),
                _ => fs::write(namespace.join("owner-v1"), b"broken marker").expect("marker"),
            }
            let before = fs::symlink_metadata(&path).expect("before");
            let mut restarted = GraphNewCacheCoordinator::default();
            restarted.set_directory(&root).expect("memory remains usable");
            assert!(namespace.exists() && path.symlink_metadata().is_ok(), "{mode}");
            assert_eq!(fs::symlink_metadata(&path).expect("after").len(), before.len(), "{mode}");
        }
    }

    #[test]
    fn graph_new_recovery_initialization_failure_keeps_memory_cache_usable() {
        let temporary = tempfile::tempdir().expect("temporary");
        let blocked = temporary.path().join("file");
        fs::write(&blocked, b"not a directory").expect("blocked");
        let mut cache = GraphNewCacheCoordinator::default();
        assert!(cache.set_directory(&blocked).is_err());
        let graph = built(0);
        let key = graph.key.hash_hex.clone();
        cache.insert(graph).expect("memory insert");
        cache.persist(&key).expect("optional persistence");
        assert!(cache.get(&key).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_recovery_startup_bounds_namespace_metadata_work() {
        let temporary = tempfile::tempdir().expect("temporary");
        let root = temporary.path().canonicalize().expect("canonical");
        let mut owners = Vec::new();
        for _ in 0..70 {
            let mut cache = GraphNewCacheCoordinator::default();
            cache.set_directory(&root).expect("live namespace");
            owners.push(cache);
        }
        for mut cache in owners {
            drop(cache.owner.take());
            cache.directory = None;
        }
        let mut restarted = GraphNewCacheCoordinator::default();
        restarted.set_directory(&root).expect("bounded restart");
        let remaining = fs::read_dir(root.join("graph-new-derived-v1")).expect("root").count();
        assert!((7..71).contains(&remaining), "at most 64 old namespace entries per initialization: {remaining}");
    }

    pub(in crate::services) fn reserve_process_cpu(
        cache: &GraphNewCacheCoordinator,
        bytes: u64,
    ) -> MemoryReservation {
        MemoryReservation::new(cache.pool.clone(), bytes).expect("process CPU fixture")
    }

    fn built(generation: u64) -> GraphNewBuildResult {
        let key = GraphKey::canonical(&GraphKeyParts {
            dataset_id: "fixture".into(),
            dataset_generation: generation,
            x_column_id: "x".into(),
            y_column_id: "y".into(),
            overlay_column_id: None,
            filter_identity: None,
            renderer_contract_version: 1,
            tile_format_version: 1,
            domain_policy: "finite-domain-v1".into(),
            levels: 2,
            max_tile_points: 16,
        })
        .expect("key");
        let mut builder = TilePyramidBuilder::new(2, 16, 1.5).expect("builder");
        builder
            .push_batch(&[SourcePoint::new(1, 2.0, 3.0), SourcePoint::new(2, 4.0, 5.0)])
            .expect("points");
        let pyramid = builder.finish().expect("pyramid");
        let summary = crate::models::graph_new_data::GraphNewBuildSummary {
            processed_rows: 2,
            finite_rows: 2,
            excluded_non_finite_rows: 0,
            projection_query_count: 1,
            spool_bytes: pyramid.spool_bytes,
            accounted_memory_bytes: pyramid.accounted_memory_bytes,
            overview_ready_ms: 0,
            pyramid_complete_ms: 0,
            levels: Vec::new(),
        };
        GraphNewBuildResult {
            key,
            pyramid,
            summary,
            processed_rows: 2,
            excluded_non_finite_rows: 0,
            query_count: 1,
        }
    }

    fn reserve_representative_exact(cache: &mut GraphNewCacheCoordinator, key: &str) {
        let entry = cache.entries.get_mut(key).expect("resident exact key");
        let bytes = 227_627_328;
        let extra = bytes - entry.bytes;
        let mut reservation = MemoryReservation::new(cache.pool.clone(), extra).expect("representative exact reservation");
        entry._reservation.bytes += extra;
        reservation.bytes = 0;
        entry.bytes = bytes;
        cache.cpu_bytes += extra;
    }

    #[test]
    fn graph_new_cache_construction_replaces_minimal_exact_lru_at_default_limit() {
        for pin_oldest in [false, true] {
            let directory = tempfile::tempdir().expect("directory");
            let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("directory");
            let mut keys = Vec::new();
            for generation in 0..2 {
                let graph = built(generation);
                let key = graph.key.hash_hex.clone();
                cache.insert(graph).expect("warm exact graph");
                reserve_representative_exact(&mut cache, &key);
                cache.persist(&key).expect("warm disk graph");
                keys.push(key);
            }
            if pin_oldest { cache.pin(&keys[0]); }
            let replacement = built(2);
            let replacement_key = replacement.key.hash_hex.clone();
            assert!(!keys.contains(&replacement_key));
            let required = construction_disk_requirement(2, 2, 16, RetentionPolicy::Bounded).expect("disk bound");
            let disk_bytes = cache.disk_bytes;
            let (mut construction, _) = cache.admit_construction(512 * 1024 * 1024, required)
                .expect("third exact key fits by transferring one unpinned CPU reservation");
            let victim = usize::from(pin_oldest);
            assert!(cache.get(&keys[victim]).is_none());
            assert!(cache.get(&keys[1 - victim]).is_some());
            assert_eq!(cache.evictions, 1);
            assert_eq!(cache.disk_evictions, 0);
            assert_eq!(cache.disk_bytes, disk_bytes);
            assert_eq!(cache.process_cpu_reserved_bytes(), cache.reserved_cpu_bytes() + construction.bytes);
            assert!(cache.process_cpu_reserved_bytes() <= 768 * 1024 * 1024);
            for key in &keys { assert!(cache.disk_path(key).expect("path").is_file()); }
            construction.retain_completed_build(&replacement).expect("completed build");
            cache.insert(replacement).expect("retain third exact key");
            drop(construction);
            reserve_representative_exact(&mut cache, &replacement_key);
            assert_eq!(cache.entries.len(), 2);
            assert!(cache.get(&replacement_key).is_some());
            if pin_oldest { assert_eq!(cache.pinned.as_deref(), Some(keys[0].as_str())); }
            assert_eq!(cache.process_cpu_reserved_bytes(), cache.reserved_cpu_bytes());
            cache.invalidate();
            assert_eq!(cache.process_cpu_reserved_bytes(), 0);
        }
    }

    #[test]
    fn graph_new_cache_construction_impossible_cpu_keeps_all_warm_state() {
        for pressure in ["oversized", "external", "pending", "pinned"] {
            let directory = tempfile::tempdir().expect("directory");
            let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("directory");
            let mut keys = Vec::new();
            for generation in 0..2 {
                let graph = built(generation);
                let key = graph.key.hash_hex.clone();
                cache.insert(graph).expect("warm graph");
                reserve_representative_exact(&mut cache, &key);
                cache.persist(&key).expect("warm disk");
                keys.push(key);
            }
            cache.pin(&keys[0]);
            let mut other = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            other.pool = cache.pool.clone();
            let held_bytes = if matches!(pressure, "external" | "pending") { 64 * 1024 * 1024 } else { 0 };
            let held = MemoryReservation::new(cache.pool.clone(), held_bytes).expect("held CPU");
            if pressure == "pending" {
                cache.pending = Some(("pending-key".into(), held));
            } else {
                other.pending = Some(("external-key".into(), held));
            }
            let before = (cache.cpu_bytes, cache.disk_bytes, cache.process_cpu_reserved_bytes(),
                cache.evictions, cache.disk_evictions, cache.hits, cache.misses, cache.clock);
            let files = keys.iter().map(|key| fs::read(cache.disk_path(key).expect("path")).expect("file")).collect::<Vec<_>>();
            cache.disk_limit = cache.live_file_bytes() + cache.disk_bytes;
            let requested = match pressure {
                "oversized" => u64::MAX,
                "pinned" => 600 * 1024 * 1024,
                _ => 512 * 1024 * 1024,
            };
            assert!(matches!(cache.admit_construction(requested, 1), Err(AppError::Stats(message)) if message == "graph_new_cache_pressure"));
            assert_eq!(before, (cache.cpu_bytes, cache.disk_bytes, cache.process_cpu_reserved_bytes(),
                cache.evictions, cache.disk_evictions, cache.hits, cache.misses, cache.clock), "{pressure}");
            assert_eq!(cache.pinned.as_deref(), Some(keys[0].as_str()));
            assert_eq!(cache.pending.is_some(), pressure == "pending");
            for (key, bytes) in keys.iter().zip(files) {
                assert!(cache.get(key).is_some(), "{pressure}");
                assert_eq!(fs::read(cache.disk_path(key).expect("path")).expect("file"), bytes);
            }
        }
    }

    #[test]
    fn graph_new_cache_construction_shared_pool_transfer_does_not_overcommit() {
        for _ in 0..16 {
            let mut first = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            let mut second = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            second.pool = first.pool.clone();
            let pool = first.pool.clone();
            let first_key = built(0).key.hash_hex;
            let second_key = built(1).key.hash_hex;
            first.insert(built(0)).expect("first");
            second.insert(built(1)).expect("second");
            reserve_representative_exact(&mut first, &first_key);
            reserve_representative_exact(&mut second, &second_key);
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let results = std::thread::scope(|scope| {
                let handles = [(first, first_key), (second, second_key)].into_iter().map(|(mut cache, key)| {
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        let admission = cache.admit_construction(512 * 1024 * 1024, 0);
                        barrier.wait();
                        assert!(cache.process_cpu_reserved_bytes() <= cache.pool.limit);
                        assert_eq!(cache.get(&key).is_some(), admission.is_err());
                        assert_eq!(cache.evictions, u64::from(admission.is_ok()));
                        let succeeded = admission.is_ok();
                        drop(admission);
                        succeeded
                    })
                }).collect::<Vec<_>>();
                handles.into_iter().map(|handle| handle.join().expect("admission worker")).collect::<Vec<_>>()
            });
            assert_eq!(results.iter().filter(|succeeded| **succeeded).count(), 1);
            assert_eq!(pool.used.load(Ordering::Acquire), 0, "all transferred claims released exactly once");
        }
    }

    #[test]
    fn graph_new_cache_construction_pressure_reclaims_disk_before_second_cold_build() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let first = built(0);
        let first_key = first.key.hash_hex.clone();
        cache.insert(first).expect("first");
        cache.persist(&first_key).expect("persist first");
        let first_path = cache.disk_path(&first_key).expect("path");
        cache.remove(&first_key);
        cache.disk_limit = 600;

        let mut builder = TilePyramidBuilder::new(2, 16, 1.5).expect("builder");
        builder.limit_disk_to(cache.construction_disk_budget(
            construction_disk_requirement(2, 2, 16, RetentionPolicy::Bounded).expect("bound")
        ).expect("construction admission"));
        builder.push_batch(&[SourcePoint::new(1, 2.0, 3.0), SourcePoint::new(2, 4.0, 5.0)])
            .expect("second scan fits after reclaim");
        let pyramid = builder.finish().expect("second cold build fits after reclaim");
        assert_eq!(pyramid.total_finite_rows, 2);
        assert_eq!(cache.disk_evictions, 1);
        assert!(!first_path.exists());
        assert!(cache.disk_bytes + pyramid.encoded_bytes() <= cache.disk_limit);
    }

    #[test]
    fn graph_new_cache_construction_bound_covers_both_retention_peaks() {
        for (policy, two_row_bytes) in [(RetentionPolicy::Bounded, 594), (RetentionPolicy::Lossless, 658)] {
            assert_eq!(construction_disk_requirement(2, 2, 16, policy).expect("bound"), two_row_bytes);
            assert_eq!(construction_disk_requirement(0, 2, 16, policy).expect("empty"), 0);
            assert!(construction_disk_requirement(u64::MAX, 2, 16, policy).is_err());
            for rows in [2, 4097] {
                let required = construction_disk_requirement(rows, 2, 16, policy).expect("bound");
                for finite in [true, false] {
                    let mut builder = match policy {
                        RetentionPolicy::Bounded => TilePyramidBuilder::new(2, 16, 1.5),
                        RetentionPolicy::Lossless => TilePyramidBuilder::lossless(2, 16, 1.5),
                    }.expect("builder");
                    builder.limit_disk_to(required);
                    for ordinal in 0..rows {
                        builder.push_batch(&[SourcePoint::new(ordinal as i64 + 1,
                            if finite { (ordinal % 64) as f64 } else { f64::NAN },
                            (ordinal / 64) as f64)]).expect("scan within bound");
                    }
                    let pyramid = builder.finish().expect("spool, buckets, raw and output fit together");
                    assert_eq!(pyramid.total_processed_rows, rows);
                    assert_eq!(pyramid.raw_store.is_some(), policy == RetentionPolicy::Lossless);
                    assert!(pyramid.encoded_bytes() <= required);
                }
            }
        }
        assert!(construction_disk_requirement(1, u8::MAX, 16, RetentionPolicy::Bounded).is_err());
    }

    #[test]
    fn graph_new_cache_construction_no_pressure_preserves_warm_entries() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let first_key = built(0).key.hash_hex;
        let second_key = built(1).key.hash_hex;
        for generation in 0..2 {
            let graph = built(generation);
            let key = graph.key.hash_hex.clone();
            cache.insert(graph).expect("insert");
            cache.persist(&key).expect("persist");
        }
        cache.pin(&first_key);
        let disk_bytes = cache.disk_bytes;
        let cpu_bytes = cache.cpu_bytes;
        assert!(cache.construction_disk_budget(580).expect("free space") >= 580);
        assert_eq!((cache.disk_bytes, cache.cpu_bytes), (disk_bytes, cpu_bytes));
        assert_eq!((cache.evictions, cache.disk_evictions), (0, 0));
        for key in [first_key, second_key] {
            assert!(cache.contains(&key));
            assert!(cache.disk_path(&key).expect("path").exists());
        }
    }

    #[test]
    fn graph_new_cache_construction_pressure_stops_after_required_lru_reclaim() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let mut keys = Vec::new();
        for generation in 0..3 {
            let graph = built(generation);
            let key = graph.key.hash_hex.clone();
            cache.insert(graph).expect("insert");
            cache.persist(&key).expect("persist");
            cache.remove(&key);
            keys.push(key);
        }
        cache.pin(&keys[0]);
        cache.disk_limit = cache.disk_bytes + 580 - cache.disk[&keys[1]].bytes;
        assert_eq!(cache.construction_disk_budget(580).expect("reclaim one"), 580);
        assert!(cache.disk.contains_key(&keys[0]));
        assert!(!cache.disk.contains_key(&keys[1]));
        assert!(cache.disk.contains_key(&keys[2]));
        assert_eq!(cache.disk_evictions, 1);
    }

    #[test]
    fn graph_new_cache_construction_impossible_request_keeps_pinned_and_eligible_files() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let first = built(0);
        let first_key = first.key.hash_hex.clone();
        let pinned_live = first.pyramid.encoded_bytes();
        cache.insert(first).expect("first");
        cache.persist(&first_key).expect("persist first");
        cache.pin(&first_key);
        let second = built(1);
        let second_key = second.key.hash_hex.clone();
        cache.insert(second).expect("second");
        cache.persist(&second_key).expect("persist second");
        cache.disk_limit = pinned_live + cache.disk[&first_key].bytes + 579;
        for required in [580, u64::MAX] {
            assert!(matches!(cache.construction_disk_budget(required), Err(AppError::Stats(message))
                if message == "graph_new_cache_pressure"));
            assert_eq!((cache.evictions, cache.disk_evictions), (0, 0));
            assert_eq!(cache.pinned.as_deref(), Some(first_key.as_str()));
            for key in [&first_key, &second_key] {
                assert!(cache.get(key).is_some());
                assert!(cache.disk_path(key).expect("path").exists());
            }
        }
    }

    #[test]
    fn graph_new_cache_missing_file_pressure_admission_retires_accounting() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        fs::remove_file(cache.disk_path(&key.hash_hex).expect("path")).expect("external cleanup");
        cache.remove(&key.hash_hex);
        cache.disk_limit = built(1).pyramid.encoded_bytes();
        cache.insert(built(1)).expect("admission after external cleanup");
        assert_eq!(cache.disk_bytes, 0);
        assert!(cache.disk.is_empty());
        assert_eq!(cache.process_cpu_reserved_bytes(), cache.cpu_bytes);
    }

    #[test]
    fn graph_new_lossless_raw_and_derived_roundtrip_fit_scaled_disk_budget() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("directory");
        cache.disk_limit = 1_000_000;
        let mut graph = built(0);
        let parts = GraphKeyParts {
            dataset_id: "fixture".into(), dataset_generation: 0,
            x_column_id: "x".into(), y_column_id: "y".into(), overlay_column_id: None, filter_identity: None,
            renderer_contract_version: 1, tile_format_version: 1,
            domain_policy: "finite-domain-v1".into(), levels: 2, max_tile_points: 4096,
        };
        graph.key = GraphKey::lossless(&parts).expect("key");
        let bounded_key = GraphKey::canonical(&parts).expect("bounded key");
        assert_ne!(graph.key.hash_hex, bounded_key.hash_hex);
        let mut builder = TilePyramidBuilder::lossless(2, 4096, 1.5).expect("builder");
        for ordinal in 0..10_000 {
            builder.push_batch(&[SourcePoint::new(ordinal + 1, (ordinal % 100) as f64, (ordinal / 100) as f64)]).expect("point");
        }
        graph.pyramid = builder.finish().expect("pyramid");
        graph.summary.processed_rows = 10_000;
        graph.summary.finite_rows = 10_000;
        graph.processed_rows = 10_000;
        let key = graph.key.clone();
        cache.insert(graph).expect("admit");
        cache.persist(&key.hash_hex).expect("raw plus derived and persistent copy must fit");
        let research_file = cache.disk_path(&key.hash_hex).expect("research path");
        let disk_bytes = cache.disk_bytes;
        assert!(!cache.restore(&bounded_key).expect("bounded cache miss"));
        assert!(research_file.exists(), "mode miss must not delete a different cache");
        assert_eq!(cache.disk_bytes, disk_bytes);
        assert!(cache.live_file_bytes() + cache.disk_bytes <= cache.disk_limit);
        cache.remove(&key.hash_hex);
        assert!(cache.restore(&key).expect("restore"));
        assert_eq!(cache.get(&key.hash_hex).expect("graph").pyramid.raw_store.as_ref().expect("lossless store").finite_count, 10_000);
    }

    #[test]
    fn graph_new_performance_first_rejects_mixed_cache_modes() {
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        let mut graph = built(0);
        let mut builder = TilePyramidBuilder::lossless(2, 16, 1.5).expect("research builder");
        builder.push_batch(&[SourcePoint::new(1, 2.0, 3.0), SourcePoint::new(2, 4.0, 5.0)]).expect("points");
        graph.pyramid = builder.finish().expect("research pyramid");
        assert!(cache.insert(graph).is_err(), "bounded key must reject raw-index payload");
        assert_eq!(cache.process_cpu_reserved_bytes(), 0);
    }

    #[test]
    fn graph_new_cache_missing_file_restore_and_persist_retire_stale_record() {
        for restore in [true, false] {
            let directory = tempfile::tempdir().expect("directory");
            let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
            cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
            let key = built(0).key;
            cache.insert(built(0)).expect("insert");
            cache.persist(&key.hash_hex).expect("persist");
            let path = cache.disk_path(&key.hash_hex).expect("path");
            fs::remove_file(&path).expect("external cleanup");
            if restore {
                cache.remove(&key.hash_hex);
                assert!(!cache.restore(&key).expect("safe miss"));
                assert!(cache.disk.is_empty());
                assert_eq!(cache.disk_bytes, 0);
                assert_eq!(cache.process_cpu_reserved_bytes(), 0);
                cache.insert(built(0)).expect("rebuild");
            }
            cache.persist(&key.hash_hex).expect("persist again");
            assert!(path.is_file());
            cache.remove(&key.hash_hex);
            assert!(cache.restore(&key).expect("restored replacement cache"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_cache_hostile_entries_retire_without_deletion() {
        use std::os::unix::fs::symlink;
        for replacement in ["file", "symlink", "hardlink", "directory"] {
            for operation in ["pressure", "construction", "restore", "persist", "epoch"] {
                let directory = tempfile::tempdir().expect("directory");
                let root = directory.path().canonicalize().expect("canonical");
                let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
                cache.set_directory(&root).expect("dir");
                let key = built(0).key;
                cache.insert(built(0)).expect("insert");
                cache.persist(&key.hash_hex).expect("persist");
                let path = cache.disk_path(&key.hash_hex).expect("path");
                fs::rename(&path, root.join("original")).expect("retain original inode");
                let outside = root.join("project.spprj");
                fs::write(&outside, b"keep").expect("project");
                match replacement {
                    "file" => fs::write(&path, b"keep").expect("replacement"),
                    "symlink" => symlink(&outside, &path).expect("symlink"),
                    "hardlink" => fs::hard_link(&outside, &path).expect("hardlink"),
                    _ => fs::create_dir(&path).expect("directory"),
                }
                match operation {
                    "construction" => {
                        cache.remove(&key.hash_hex);
                        cache.disk_limit = 580;
                        assert_eq!(cache.construction_disk_budget(580).expect("safe reclaim"), 580);
                    }
                    "pressure" => {
                        cache.remove(&key.hash_hex);
                        cache.disk_limit = built(1).pyramid.encoded_bytes();
                        cache.insert(built(1)).expect("admit past unusable record");
                    }
                    "restore" => {
                        cache.remove(&key.hash_hex);
                        assert!(!cache.restore(&key).expect("safe miss"));
                    }
                    "persist" => assert!(cache.persist(&key.hash_hex).is_err()),
                    _ => cache.sync_epoch(1),
                }
                assert_eq!(cache.disk_bytes, 0, "{replacement}/{operation}");
                assert!(cache.disk.is_empty());
                assert_eq!(cache.process_cpu_reserved_bytes(), cache.cpu_bytes);
                drop(cache);
                assert!(path.symlink_metadata().is_ok(), "{replacement}/{operation}");
                assert_eq!(fs::read(&outside).expect("project survives"), b"keep");
                if replacement != "directory" {
                    assert_eq!(fs::read(&path).expect("replacement survives"), b"keep");
                }
            }
        }
    }

    #[test]
    fn graph_new_cache_epoch_zeroes_accounting_after_cleanup_failure() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        let namespace = cache.directory.clone().expect("namespace");
        fs::rename(&namespace, directory.path().join("moved")).expect("external move");
        cache.sync_epoch(1);
        assert_eq!(cache.disk_bytes, 0);
        assert_eq!(cache.cpu_bytes, 0);
        assert_eq!(cache.process_cpu_reserved_bytes(), 0);
        assert!(cache.disk.is_empty());
    }

    #[test]
    fn graph_new_cache_streamed_disk_roundtrip_and_generation_miss() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::default();
        cache
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("cache dir");
        let graph = built(0);
        let key = graph.key.clone();
        cache.insert(graph).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        cache.remove(&key.hash_hex);
        assert!(cache.restore(&key).expect("restore"));
        assert_eq!(
            cache
                .get(&key.hash_hex)
                .expect("graph")
                .pyramid
                .total_finite_rows,
            2
        );
        assert!(!cache.restore(&built(1).key).expect("generation miss"));
        assert_eq!(cache.disk_hits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_cache_epoch_zeroes_accounting_after_unlink_failure() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::new(DEFAULT_PROCESS_BYTES, DEFAULT_GPU_BYTES);
        cache.set_directory(&directory.path().canonicalize().expect("canonical")).expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        let namespace = cache.directory.clone().expect("namespace");
        let permissions = fs::metadata(&namespace).expect("metadata").permissions();
        fs::set_permissions(&namespace, fs::Permissions::from_mode(0o500)).expect("read only");
        let failed = cache.remove_disk(&key.hash_hex).is_err();
        cache.sync_epoch(1);
        fs::set_permissions(&namespace, permissions).expect("restore permissions");
        assert!(failed, "fixture must reject owned-file unlink");
        assert!(cache.directory.is_none());
        assert_eq!(cache.disk_bytes, 0);
        assert_eq!(cache.process_cpu_reserved_bytes(), 0);
        assert!(cache.disk.is_empty());
    }

    #[test]
    fn graph_new_cache_lru_pins_and_aggregate_pressure() {
        let bytes = built(0).pyramid.cache_reservation_bytes() + 4096;
        let mut cache = GraphNewCacheCoordinator::new(bytes * 2 + 100, 100);
        let first = built(0);
        let first_key = first.key.hash_hex.clone();
        let second = built(1);
        let second_key = second.key.hash_hex.clone();
        cache.insert(first).expect("first");
        cache.pin(&first_key);
        cache.insert(second).expect("second");
        cache.insert(built(2)).expect("evict unpinned second");
        assert!(cache.get(&first_key).is_some());
        assert!(cache.get(&second_key).is_none());
        assert_eq!(cache.evictions, 1);
        assert!(cache.cpu_bytes + 100 <= bytes * 2 + 100);
        let mut tiny = GraphNewCacheCoordinator::new(bytes + 100, 100);
        tiny.insert(built(0)).expect("first");
        tiny.pin(&first_key);
        assert!(tiny.insert(built(1)).is_err());
        assert!(tiny.get(&first_key).is_some());
    }

    #[test]
    fn graph_new_cache_shared_process_reservations_cannot_overcommit() {
        let bytes = built(0).pyramid.cache_reservation_bytes() + 4096;
        let mut first = GraphNewCacheCoordinator::new(bytes * 2, 0);
        let mut second = GraphNewCacheCoordinator::new(bytes * 2, 0);
        second.pool = first.pool.clone();
        let first_key = built(0).key.hash_hex;
        let second_key = built(1).key.hash_hex;
        first.insert(built(0)).expect("first");
        first.pin(&first_key);
        second.insert(built(1)).expect("second");
        second.pin(&second_key);
        assert!(second.insert(built(2)).is_err());
        assert_eq!(
            first.pool.used.load(std::sync::atomic::Ordering::Acquire),
            bytes * 2
        );
        first.unpin();
        first.evict_unpinned();
        second.insert(built(2)).expect("released capacity reusable");
        drop(second);
        assert_eq!(
            first.pool.used.load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }

    #[test]
    fn graph_new_cache_corruption_deletes_only_owned_file() {
        use std::io::{Seek, SeekFrom, Write};
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::default();
        cache
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        let path = cache.disk_path(&key.hash_hex).expect("owned path");
        let unrelated = path.parent().expect("parent").join("project.spprj");
        std::fs::write(&unrelated, b"project data").expect("unrelated");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("file");
        file.seek(SeekFrom::Start(12)).expect("seek");
        file.write_all(b"corrupt").expect("corrupt");
        cache.remove(&key.hash_hex);
        assert!(!cache.restore(&key).expect("safe miss"));
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(unrelated).expect("project survives"),
            b"project data"
        );
    }

    #[test]
    fn graph_new_cache_rejects_valid_checksum_with_bad_schema_or_count() {
        use sha2::{Digest, Sha256};
        for schema in [true, false] {
            let directory = tempfile::tempdir().expect("directory");
            let mut cache = GraphNewCacheCoordinator::default();
            cache
                .set_directory(&directory.path().canonicalize().expect("canonical"))
                .expect("dir");
            let key = built(0).key;
            cache.insert(built(0)).expect("insert");
            cache.persist(&key.hash_hex).expect("persist");
            let path = cache.disk_path(&key.hash_hex).expect("path");
            let mut bytes = std::fs::read(&path).expect("bytes");
            if schema {
                bytes[7] = b'9';
            } else {
                bytes[152..160].copy_from_slice(&u64::MAX.to_le_bytes());
            }
            let payload = bytes.len() - 32;
            let digest = Sha256::digest(&bytes[..payload]);
            bytes[payload..].copy_from_slice(&digest);
            std::fs::write(&path, bytes).expect("invalid fixture");
            cache.remove(&key.hash_hex);
            assert!(!cache.restore(&key).expect("invalid miss"));
            assert!(!path.exists());
            assert_eq!(cache.corruptions, 1);
        }
    }

    #[test]
    fn graph_new_cache_disk_budget_is_separate_finite_and_pinned() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::default();
        cache
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("dir");
        let first = built(0);
        let key = first.key.clone();
        cache.disk_limit = first.pyramid.encoded_bytes() + first.pyramid.persisted_bytes();
        cache.insert(first).expect("insert");
        cache.pin(&key.hash_hex);
        cache.persist(&key.hash_hex).expect("fits exactly");
        assert!(cache.insert(built(1)).is_err());
        assert!(cache.get(&key.hash_hex).is_some());
        cache.unpin();
        cache.evict_unpinned();
        cache.disk_limit = cache.disk_bytes + built(1).pyramid.persisted_bytes();
        let second_key = built(1).key.hash_hex;
        cache.insert(built(1)).expect("second");
        cache.persist(&second_key).expect("evict first disk");
        assert_eq!(cache.disk_evictions, 1);
        assert!(cache.disk_bytes + cache.live_file_bytes() <= cache.disk_limit);
    }

    #[test]
    fn graph_new_cache_restore_pressure_is_not_corruption() {
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::default();
        cache
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        let path = cache.disk_path(&key.hash_hex).expect("path");
        cache.remove(&key.hash_hex);
        cache.cpu_limit = 8 * 1024 * 1024 + 6144;
        assert!(!cache.restore(&key).expect("pressure miss"));
        assert_eq!(
            cache.corruptions, 0,
            "valid file is not corrupt merely because metadata cannot fit"
        );
        assert!(path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_cache_rejects_replaced_namespace_and_hardlinked_entries() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().expect("directory");
        let mut cache = GraphNewCacheCoordinator::default();
        cache
            .set_directory(&directory.path().canonicalize().expect("canonical"))
            .expect("dir");
        let key = built(0).key;
        cache.insert(built(0)).expect("insert");
        cache.persist(&key.hash_hex).expect("persist");
        let path = cache.disk_path(&key.hash_hex).expect("path");
        let external_link = directory.path().join("linked-project");
        std::fs::hard_link(&path, &external_link).expect("hardlink");
        cache.remove(&key.hash_hex);
        assert!(!cache.restore(&key).expect("hardlink rejected"));
        assert!(external_link.exists() && path.exists());
        let namespace = path.parent().expect("namespace").to_path_buf();
        let moved = directory.path().join("moved");
        std::fs::rename(&namespace, &moved).expect("move");
        symlink(&moved, &namespace).expect("replace namespace");
        assert!(cache.disk_path(&key.hash_hex).is_err());
        drop(cache);
        assert!(external_link.exists());
        assert!(moved.join(format!("{}.gnd", key.hash_hex)).exists());
    }

    #[cfg(unix)]
    #[test]
    fn graph_new_cache_rejects_symlinks_and_path_keys() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().expect("directory");
        let root = directory.path().canonicalize().expect("canonical");
        let outside = tempfile::tempdir().expect("outside");
        let link = root.join("link");
        symlink(outside.path(), &link).expect("symlink");
        let mut cache = GraphNewCacheCoordinator::default();
        assert!(cache.set_directory(&link.join("child")).is_err());
        cache.set_directory(&root).expect("root");
        assert!(cache.disk_path("../../project.spprj").is_err());
        let key = built(0).key;
        let path = cache.disk_path(&key.hash_hex).expect("path");
        let victim = outside.path().join("victim");
        std::fs::write(&victim, b"keep").expect("victim");
        symlink(&victim, &path).expect("entry link");
        assert!(!cache.restore(&key).expect("miss"));
        assert!(path
            .symlink_metadata()
            .expect("link retained")
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(victim).expect("untouched"), b"keep");
    }
}

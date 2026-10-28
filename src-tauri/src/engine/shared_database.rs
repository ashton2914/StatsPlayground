use std::ops::Deref;
use std::sync::{Arc, Mutex, MutexGuard};

use super::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

struct DatabaseSlot {
    engine: Option<DuckDbEngine>,
    native_epoch: Option<u64>,
}

/// Existing services and native commits borrow the same engine through this slot.
/// The writer is moved on installation; no second writable connection is opened.
#[derive(Clone)]
pub struct SharedDatabase {
    inner: Arc<Mutex<DatabaseSlot>>,
}

pub struct DatabaseGuard<'a> {
    slot: MutexGuard<'a, DatabaseSlot>,
}

fn unavailable() -> AppError {
    AppError::Database("project_writer_unavailable".into())
}
fn closed() -> AppError {
    AppError::InvalidParam("project_closed".into())
}

impl SharedDatabase {
    pub fn temporary(engine: DuckDbEngine) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DatabaseSlot {
                engine: Some(engine),
                native_epoch: None,
            })),
        }
    }

    pub(crate) fn native(engine: DuckDbEngine, epoch: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DatabaseSlot {
                engine: Some(engine),
                native_epoch: Some(epoch),
            })),
        }
    }

    pub fn lock(&self) -> Result<DatabaseGuard<'_>, AppError> {
        let slot = self.inner.lock().map_err(|_| unavailable())?;
        if slot.engine.is_none() {
            return Err(closed());
        }
        Ok(DatabaseGuard { slot })
    }

    #[cfg(test)]
    pub fn try_lock(&self) -> Result<DatabaseGuard<'_>, AppError> {
        let slot = self.inner.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => AppError::Busy("project_writer_busy".into()),
            std::sync::TryLockError::Poisoned(_) => unavailable(),
        })?;
        if slot.engine.is_none() {
            return Err(closed());
        }
        Ok(DatabaseGuard { slot })
    }

    pub fn into_inner(self) -> Result<DuckDbEngine, AppError> {
        let mutex = Arc::try_unwrap(self.inner)
            .map_err(|_| AppError::Busy("project_writer_shared".into()))?;
        let slot = mutex.into_inner().map_err(|_| unavailable())?;
        if slot.native_epoch.is_some() {
            return Err(AppError::InvalidParam(
                "project_native_lifecycle_required".into(),
            ));
        }
        slot.engine.ok_or_else(closed)
    }

    pub(crate) fn transfer_native_to(
        &self,
        destination: &Self,
        epoch: u64,
    ) -> Result<(), AppError> {
        if Arc::ptr_eq(&self.inner, &destination.inner) {
            return Err(AppError::InvalidParam(
                "project_writer_already_installed".into(),
            ));
        }
        fn transfer(
            source: &mut DatabaseSlot,
            destination: &mut DatabaseSlot,
            epoch: u64,
        ) -> Result<Option<DuckDbEngine>, AppError> {
            if source.native_epoch != Some(epoch) || source.engine.is_none() {
                return Err(closed());
            }
            if destination.native_epoch.is_some() {
                return Err(AppError::Busy("project_previous_session_open".into()));
            }
            let previous = destination.engine.take();
            destination.engine = source.engine.take();
            destination.native_epoch = Some(epoch);
            source.native_epoch = None;
            Ok(previous)
        }
        // A stable lock order also covers concurrent installation attempts.
        let previous = if Arc::as_ptr(&self.inner) < Arc::as_ptr(&destination.inner) {
            let mut source = self.inner.lock().map_err(|_| unavailable())?;
            let mut target = destination.inner.lock().map_err(|_| unavailable())?;
            transfer(&mut source, &mut target, epoch)?
        } else {
            let mut target = destination.inner.lock().map_err(|_| unavailable())?;
            let mut source = self.inner.lock().map_err(|_| unavailable())?;
            transfer(&mut source, &mut target, epoch)?
        };
        drop(previous);
        Ok(())
    }

    pub(crate) fn install_temporary(&self, engine: DuckDbEngine) -> Result<(), AppError> {
        let mut slot = self.inner.lock().map_err(|_| unavailable())?;
        if slot.native_epoch.is_some() { return Err(AppError::Busy("project_previous_session_open".into())); }
        slot.engine = Some(engine);
        Ok(())
    }

    pub(crate) fn has_native_epoch(&self, epoch: u64) -> Result<bool, AppError> {
        let slot = self.inner.lock().map_err(|_| unavailable())?;
        Ok(slot.native_epoch == Some(epoch) && slot.engine.is_some())
    }

    pub(crate) fn clear_native(&self, epoch: u64) -> Result<(), AppError> {
        let engine = {
            let mut slot = self.inner.lock().map_err(|_| unavailable())?;
            // A retired owner must never clear its replacement's engine.
            if slot.native_epoch != Some(epoch) {
                return Ok(());
            }
            slot.native_epoch = None;
            slot.engine.take()
        };
        drop(engine);
        Ok(())
    }
}

impl DatabaseGuard<'_> {
    pub(crate) fn native_epoch(&self) -> Option<u64> {
        self.slot.native_epoch
    }

    pub(crate) fn replace_temporary(&mut self, engine: DuckDbEngine) -> Result<(), AppError> {
        if self.slot.native_epoch.is_some() {
            return Err(AppError::InvalidParam(
                "project_native_lifecycle_required".into(),
            ));
        }
        self.slot.engine = Some(engine);
        Ok(())
    }
}

impl Deref for DatabaseGuard<'_> {
    type Target = DuckDbEngine;
    fn deref(&self) -> &Self::Target {
        self.slot.engine.as_ref().expect("validated database guard")
    }
}

use std::sync::{Mutex, RwLock};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project::ProjectInfo;

pub struct AppState {
    pub db: Mutex<DuckDbEngine>,
    pub project: RwLock<Option<ProjectInfo>>,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let engine = DuckDbEngine::new_in_memory()?;
        Ok(Self {
            db: Mutex::new(engine),
            project: RwLock::new(None),
        })
    }

    /// Reset DuckDB engine (for opening a new/different project)
    pub fn reset_db(&self) -> Result<(), AppError> {
        let mut db = self.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        *db = DuckDbEngine::new_in_memory()?;
        Ok(())
    }
}

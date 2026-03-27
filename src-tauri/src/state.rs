use std::sync::Mutex;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

pub struct AppState {
    pub db: Mutex<DuckDbEngine>,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let engine = DuckDbEngine::new_in_memory()?;
        Ok(Self {
            db: Mutex::new(engine),
        })
    }
}

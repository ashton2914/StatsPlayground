use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::table::ColumnDisplayProps;
use crate::services::save_coordinator::SaveCoordinator;
use crate::services::workflow_executor::WorkflowRunCommitPacket;

#[derive(Clone, Debug)]
pub struct WorkflowRunJournalEntry {
    pub project_path: String,
    pub staging_ids: Vec<String>,
    pub packet: Option<WorkflowRunCommitPacket>,
}

pub struct AppState {
    pub graph_new: crate::services::graph_new_service::GraphNewRuntime,
    pub graph_new_epoch: AtomicU64,
    pub db: Mutex<DuckDbEngine>,
    pub project: RwLock<Option<ProjectInfo>>,
    /// Per-dataset column display properties (dataset_id → vec of props)
    pub column_display: Mutex<HashMap<String, Vec<ColumnDisplayProps>>>,
    pub save_coordinator: SaveCoordinator,
    pub workflow_run_journal: Mutex<HashMap<String, WorkflowRunJournalEntry>>,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let engine = DuckDbEngine::new_in_memory()?;
        Ok(Self {
            graph_new: Default::default(),
            graph_new_epoch: AtomicU64::new(0),
            db: Mutex::new(engine),
            project: RwLock::new(None),
            column_display: Mutex::new(HashMap::new()),
            save_coordinator: SaveCoordinator::new(),
            workflow_run_journal: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_graph_cache_directory(&self, directory: &std::path::Path) -> Result<(), AppError> {
        self.graph_new.set_cache_directory(directory)
    }

    /// Reset DuckDB engine (for opening a new/different project)
    pub fn reset_db(&self) -> Result<(), AppError> {
        let mut db = self
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *db = DuckDbEngine::new_in_memory()?;
        self.graph_new_epoch.fetch_add(1, Ordering::AcqRel);
        // Clear column display props
        let mut display = self
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        display.clear();
        Ok(())
    }
}

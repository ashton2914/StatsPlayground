use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::mcp::broker::McpCommandBroker;
use crate::mcp::server::McpServerRuntime;
use crate::models::project::ProjectInfo;
use crate::models::table::ColumnDisplayProps;
use crate::services::path_authorization_service::PathAuthorizationService;
use crate::services::save_coordinator::SaveCoordinator;
use crate::services::table_navigation_service::TableNavigationService;
use crate::services::workflow_executor::WorkflowRunCommitPacket;

const TABLE_NAVIGATION_READER_COUNT: usize = 2;

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
    pub table_navigation: RwLock<Arc<TableNavigationService>>,
    pub project: RwLock<Option<ProjectInfo>>,
    /// Per-dataset column display properties (dataset_id → vec of props)
    pub column_display: Mutex<HashMap<String, Vec<ColumnDisplayProps>>>,
    pub path_authorization: Mutex<PathAuthorizationService>,
    pub save_coordinator: SaveCoordinator,
    pub workflow_run_journal: Mutex<HashMap<String, WorkflowRunJournalEntry>>,
    pub mcp_command_broker: McpCommandBroker,
    pub mcp_server: McpServerRuntime,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let engine = DuckDbEngine::new_in_memory()?;
        let table_navigation = TableNavigationService::new(&engine, TABLE_NAVIGATION_READER_COUNT)?;
        Ok(Self {
            graph_new: Default::default(),
            graph_new_epoch: AtomicU64::new(0),
            db: Mutex::new(engine),
            table_navigation: RwLock::new(Arc::new(table_navigation)),
            project: RwLock::new(None),
            column_display: Mutex::new(HashMap::new()),
            path_authorization: Mutex::new(PathAuthorizationService::default()),
            save_coordinator: SaveCoordinator::new(),
            workflow_run_journal: Mutex::new(HashMap::new()),
            mcp_command_broker: McpCommandBroker::new(),
            mcp_server: McpServerRuntime::new(),
        })
    }

    pub fn set_graph_cache_directory(&self, directory: &std::path::Path) -> Result<(), AppError> {
        self.graph_new.set_cache_directory(directory)
    }

    /// Reset DuckDB engine (for opening a new/different project)
    pub fn reset_db(&self) -> Result<(), AppError> {
        let replacement_engine = DuckDbEngine::new_in_memory()?;
        let replacement_navigation =
            TableNavigationService::new(&replacement_engine, TABLE_NAVIGATION_READER_COUNT)?;
        let mut db = self
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut table_navigation = self
            .table_navigation
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *db = replacement_engine;
        *table_navigation = Arc::new(replacement_navigation);
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

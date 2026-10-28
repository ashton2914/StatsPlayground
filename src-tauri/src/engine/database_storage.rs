use std::path::PathBuf;
use std::sync::Arc;

use tempfile::TempDir;

/// Shared by every connection; only legacy temporary databases auto-delete.
pub enum DatabaseStorage {
    Temporary(Arc<TempDir>),
    RecoverableDraft(PathBuf),
    PersistentProject(PathBuf),
}

impl DatabaseStorage {
    pub fn path(&self) -> PathBuf {
        match self {
            Self::Temporary(directory) => directory.path().join("stats_playground.duckdb"),
            Self::RecoverableDraft(path) | Self::PersistentProject(path) => path.clone(),
        }
    }
}

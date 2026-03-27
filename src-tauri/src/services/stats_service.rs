use crate::error::AppError;
use crate::models::stats::{ColumnStats, DescriptiveResult};
use crate::state::AppState;

pub struct StatsService<'a> {
    state: &'a AppState,
}

impl<'a> StatsService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn get_column_stats(&self, dataset_id: &str, column_name: &str) -> Result<ColumnStats, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.column_stats(dataset_id, column_name)
    }

    pub fn get_descriptive_stats(&self, dataset_id: &str) -> Result<DescriptiveResult, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.descriptive_stats(dataset_id)
    }
}

use crate::error::AppError;
use crate::state::AppState;

pub struct IoService<'a> {
    state: &'a AppState,
}

impl<'a> IoService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.export_csv(dataset_id, output_path)
    }
}

use crate::error::AppError;
use crate::models::table::DatasetMeta;
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

    pub fn import_sqlite<F>(&self, file_path: &str, on_progress: F) -> Result<Vec<DatasetMeta>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let results = db.import_sqlite(file_path, &on_progress)?;
        Ok(results.into_iter().map(|(_, meta)| meta).collect())
    }

    pub fn export_sqlite(&self, output_path: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.export_sqlite(output_path)
    }
}

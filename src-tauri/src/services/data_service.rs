use crate::error::AppError;
use crate::models::table::{DatasetMeta, TableQueryResult};
use crate::state::AppState;

pub struct DataService<'a> {
    state: &'a AppState,
}

impl<'a> DataService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn import_csv(&self, file_path: &str) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled")
            .to_string();
        db.import_csv(&id, &name, file_path)
    }

    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.list_datasets()
    }

    pub fn delete_dataset(&self, dataset_id: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_dataset(dataset_id)
    }

    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.query_table(dataset_id, page, page_size, sort_by, sort_order)
    }
}

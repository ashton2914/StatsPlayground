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

    pub fn create_table(
        &self,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.create_empty_table(&id, name, column_names, column_types)
    }

    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.add_row(dataset_id)
    }

    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.update_cell(dataset_id, row_id, column_name, value)
    }

    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_row(dataset_id, row_id)
    }

    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_dataset(dataset_id, new_name)
    }

    pub fn add_column(&self, dataset_id: &str, col_name: &str, col_type: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.add_column(dataset_id, col_name, col_type)
    }

    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_column(dataset_id, col_name)
    }

    pub fn rename_column(&self, dataset_id: &str, old_name: &str, new_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_column(dataset_id, old_name, new_name)
    }

    pub fn change_column_type(&self, dataset_id: &str, col_name: &str, new_type: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.change_column_type(dataset_id, col_name, new_type)
    }

    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        col_types: &[String],
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.paste_at_position(dataset_id, start_row, start_col, rows, header_names, col_types)
    }
}

use crate::error::AppError;
use crate::models::data_link::{PreviewResult, SourceColumn, SourceObject};

pub enum ConnectorValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

pub struct ConnectorRow {
    pub source_index: usize,
    pub values: Vec<ConnectorValue>,
}

pub struct ConnectorBatch {
    pub rows: Vec<ConnectorRow>,
}

pub trait DataConnector {
    fn test_connection(&self) -> Result<(), AppError>;
    fn list_objects(&self) -> Result<Vec<SourceObject>, AppError>;
    fn schema(&self, object_name: &str) -> Result<Vec<SourceColumn>, AppError>;
    fn preview(&self, object_name: &str, limit: usize) -> Result<PreviewResult, AppError>;
    fn row_count(&self, object_name: &str) -> Result<usize, AppError>;
    fn read_rows(
        &self,
        object_name: &str,
        visitor: &mut dyn FnMut(usize, Vec<ConnectorValue>) -> Result<(), AppError>,
    ) -> Result<(), AppError>;

    fn read_batches(
        &self,
        object_name: &str,
        batch_size: usize,
        visitor: &mut dyn FnMut(ConnectorBatch) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if batch_size == 0 {
            return Err(AppError::InvalidParam(
                "Connector batch size must be greater than zero".to_string(),
            ));
        }

        let mut rows = Vec::with_capacity(batch_size);
        self.read_rows(object_name, &mut |source_index, values| {
            rows.push(ConnectorRow {
                source_index,
                values,
            });
            if rows.len() == batch_size {
                visitor(ConnectorBatch {
                    rows: std::mem::take(&mut rows),
                })?;
                rows = Vec::with_capacity(batch_size);
            }
            Ok(())
        })?;
        if !rows.is_empty() {
            visitor(ConnectorBatch { rows })?;
        }
        Ok(())
    }
}

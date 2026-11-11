use serde::Serialize;

use crate::models::mcp::McpCommandError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Graph request failed ({code})", code = .0.code)]
    GraphData(GraphDataError),

    #[error("Database error: {0}")]
    Database(String),

    #[error("File I/O error: {0}")]
    FileIO(String),

    #[error("Stats error: {0}")]
    Stats(String),

    #[error("Invalid parameter: {0}")]
    InvalidParam(String),

    #[error("Busy: {0}")]
    Busy(String),

    #[error("Read-only: {0}")]
    ReadOnly(String),

    #[error("Cancelled: {0}")]
    Cancelled(String),

    #[error("Application command error [{code}]: {message}", code = .0.code, message = .0.message)]
    ApplicationCommand(McpCommandError),
}

// Tauri commands require errors to be serializable
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::GraphData(error) => error.serialize(serializer),
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

impl From<duckdb::Error> for AppError {
    fn from(e: duckdb::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::FileIO(e.to_string())
    }
}

impl AppError {
    pub(crate) fn graph_numeric_column(column: &str, role: &str) -> Self {
        Self::GraphData(GraphDataError {
            code: "graphNumericColumnRequired",
            column: Some(column.into()),
            role: Some(role.into()),
        })
    }

    pub(crate) fn into_graph_error(self) -> Self {
        if matches!(self, Self::GraphData(_)) {
            return self;
        }
        eprintln!("graph_data_request_failed: {self}");
        Self::GraphData(GraphDataError {
            code: "graphQueryFailed",
            column: None,
            role: None,
        })
    }
}

#[cfg(test)]
mod graph_error_tests {
    use super::*;

    #[test]
    fn graph_error_boundary_keeps_only_safe_parameters() {
        let numeric = AppError::graph_numeric_column("Net_Sales", "y").into_graph_error();
        assert_eq!(
            serde_json::to_value(numeric).unwrap(),
            serde_json::json!({"code":"graphNumericColumnRequired","column":"Net_Sales","role":"y"})
        );
        for error in [
            AppError::Database("SELECT CAST(Net_Sales AS DOUBLE) FROM dataset_sales __sp_x".into()),
            AppError::InvalidParam("unknown graph column: private".into()),
        ] {
            assert_eq!(
                serde_json::to_value(error.into_graph_error()).unwrap(),
                serde_json::json!({"code":"graphQueryFailed"})
            );
        }
        assert_eq!(
            serde_json::to_value(AppError::InvalidParam("ordinary error".into())).unwrap(),
            "Invalid parameter: ordinary error"
        );
    }
}

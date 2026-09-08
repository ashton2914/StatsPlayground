use crate::connectors::{ConnectorBatch, MySqlConnector, PostgresConnector};
use crate::error::AppError;
use crate::models::data_link::{
    ConnectionCredentials, ConnectionDefinition, ConnectorKind, DataLinkError,
    DataLinkErrorCategory, PreviewResult, SourceColumn, SourceObjectRef,
};

pub enum ServerConnector {
    PostgreSql(PostgresConnector),
    MySql(MySqlConnector),
}

impl ServerConnector {
    pub fn new(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<Self, DataLinkError> {
        match definition.connector {
            ConnectorKind::PostgreSql => {
                PostgresConnector::new(definition, credentials).map(Self::PostgreSql)
            }
            ConnectorKind::MySql => MySqlConnector::new(definition, credentials).map(Self::MySql),
            _ => Err(DataLinkError::new(
                DataLinkErrorCategory::Query,
                "Unsupported server database connector",
            )),
        }
    }

    pub fn source_type(&self) -> &'static str {
        match self {
            Self::PostgreSql(_) => "postgresql",
            Self::MySql(_) => "mysql",
        }
    }

    pub fn test_connection(&self) -> Result<(), DataLinkError> {
        match self {
            Self::PostgreSql(connector) => connector.test_connection(),
            Self::MySql(connector) => connector.test_connection(),
        }
    }

    pub fn list_objects(&self) -> Result<Vec<SourceObjectRef>, DataLinkError> {
        match self {
            Self::PostgreSql(connector) => connector.list_objects(),
            Self::MySql(connector) => connector.list_objects(),
        }
    }

    pub fn schema(&self, object: &SourceObjectRef) -> Result<Vec<SourceColumn>, DataLinkError> {
        match self {
            Self::PostgreSql(connector) => connector.schema(object),
            Self::MySql(connector) => connector.schema(object),
        }
    }

    pub fn preview(
        &self,
        object: &SourceObjectRef,
        limit: usize,
    ) -> Result<PreviewResult, DataLinkError> {
        match self {
            Self::PostgreSql(connector) => connector.preview(object, limit),
            Self::MySql(connector) => connector.preview(object, limit),
        }
    }

    pub fn row_count(&self, object: &SourceObjectRef) -> Result<usize, DataLinkError> {
        match self {
            Self::PostgreSql(connector) => connector.row_count(object),
            Self::MySql(connector) => connector.row_count(object),
        }
    }

    pub fn read_batches(
        &self,
        object: &SourceObjectRef,
        batch_size: usize,
        visitor: &mut dyn FnMut(ConnectorBatch) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        match self {
            Self::PostgreSql(connector) => connector.read_batches(object, batch_size, visitor),
            Self::MySql(connector) => connector.read_batches(object, batch_size, visitor),
        }
    }
}

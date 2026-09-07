use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorKind {
    Sqlite,
    #[serde(rename = "postgresql")]
    PostgreSql,
    #[serde(rename = "mysql")]
    MySql,
    SqlServer,
    Odbc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationType {
    UsernamePassword,
    Windows,
    EntraId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    Disabled,
    Required,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDefinition {
    pub connector: ConnectorKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub authentication_type: AuthenticationType,
    pub tls_mode: TlsMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_root_certificate_pem: Option<String>,
    pub connect_timeout_seconds: u32,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceObjectType {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceObjectRef {
    pub catalog: Option<String>,
    pub schema: Option<String>,
    pub name: String,
    pub object_type: SourceObjectType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCapabilities {
    pub supports_views: bool,
    pub supports_primary_keys: bool,
    pub supports_custom_query: bool,
    pub supports_cancellation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DataLinkErrorCategory {
    Network,
    Authentication,
    Tls,
    Permission,
    Query,
    Conversion,
    Storage,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct DataLinkError {
    pub category: DataLinkErrorCategory,
    pub message: String,
}

impl DataLinkError {
    pub fn new(category: DataLinkErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceColumn {
    pub name: String,
    pub source_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub precision: Option<u32>,
    pub scale: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceObject {
    pub name: String,
    pub object_type: String,
    pub columns: Vec<SourceColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub object_name: String,
    pub columns: Vec<SourceColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqliteImportSelection {
    pub source_name: String,
    pub target_name: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTableSummary {
    pub source_name: String,
    pub target_name: String,
    pub action: String,
    pub rows_written: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub status: String,
    pub imported: Vec<ImportTableSummary>,
    pub skipped: Vec<ImportTableSummary>,
    pub failed_table: Option<String>,
    pub error: Option<String>,
    pub total_rows_written: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_connection_contract_uses_camel_case_without_credentials() {
        let definition = ConnectionDefinition {
            connector: ConnectorKind::PostgreSql,
            host: "127.0.0.1".to_string(),
            port: 55432,
            database: "statsplayground_test".to_string(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            tls_root_certificate_pem: None,
            connect_timeout_seconds: 10,
        };

        let value = serde_json::to_value(definition).expect("serialize connection definition");
        assert_eq!(value["connector"], "postgresql");
        assert_eq!(value["authenticationType"], "usernamePassword");
        assert_eq!(value["connectTimeoutSeconds"], 10);
        assert!(value.get("password").is_none());
        let restored: ConnectionDefinition = serde_json::from_value(value)
            .expect("accept legacy connection without a CA certificate");
        assert!(restored.tls_root_certificate_pem.is_none());
    }

    #[test]
    fn data_link_error_serializes_as_a_structured_response() {
        let error = DataLinkError::new(
            DataLinkErrorCategory::Authentication,
            "PostgreSQL authentication failed",
        );

        let value = serde_json::to_value(error).expect("serialize DataLink error");
        assert_eq!(value["category"], "authentication");
        assert_eq!(value["message"], "PostgreSQL authentication failed");
    }
}

use std::time::Duration;

use fallible_iterator::FallibleIterator;
use postgres::config::SslMode;
use postgres::{Config, NoTls};
use postgres_native_tls::MakeTlsConnector;

use crate::connectors::{ConnectorBatch, ConnectorRow, ConnectorValue};
use crate::error::AppError;
use crate::models::data_link::{
    AuthenticationType, ConnectionCredentials, ConnectionDefinition, ConnectorKind, DataLinkError,
    DataLinkErrorCategory, PreviewResult, SourceColumn, SourceObjectRef, SourceObjectType, TlsMode,
};

const MAX_PREVIEW_ROWS: usize = 100;

pub struct PostgresConnector {
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
}

impl PostgresConnector {
    pub fn new(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<Self, DataLinkError> {
        Self::validate(&definition, &credentials)?;
        Ok(Self {
            definition,
            credentials,
        })
    }

    pub fn test_connection(&self) -> Result<(), DataLinkError> {
        let mut client = self.connect()?;
        client
            .simple_query("SELECT 1")
            .map_err(|error| Self::query_error(&error))?;
        Ok(())
    }

    pub fn list_objects(&self) -> Result<Vec<SourceObjectRef>, DataLinkError> {
        let mut client = self.connect()?;
        let rows = client
            .query(
                "SELECT table_catalog, table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                   AND table_type IN ('BASE TABLE', 'VIEW') \
                   AND has_schema_privilege(table_schema, 'USAGE') \
                 ORDER BY table_schema, table_name",
                &[],
            )
            .map_err(|error| Self::query_error(&error))?;

        rows.into_iter()
            .map(|row| {
                let table_type: String = row
                    .try_get("table_type")
                    .map_err(|_| Self::conversion_error("Invalid object type metadata"))?;
                let object_type = match table_type.as_str() {
                    "BASE TABLE" => SourceObjectType::Table,
                    "VIEW" => SourceObjectType::View,
                    _ => {
                        return Err(Self::conversion_error(format!(
                            "Unsupported object type: {table_type}"
                        )))
                    }
                };
                Ok(SourceObjectRef {
                    catalog: row
                        .try_get("table_catalog")
                        .map_err(|_| Self::conversion_error("Invalid object catalog metadata"))?,
                    schema: row
                        .try_get("table_schema")
                        .map_err(|_| Self::conversion_error("Invalid object schema metadata"))?,
                    name: row
                        .try_get("table_name")
                        .map_err(|_| Self::conversion_error("Invalid object name metadata"))?,
                    object_type,
                })
            })
            .collect()
    }

    pub fn schema(&self, object: &SourceObjectRef) -> Result<Vec<SourceColumn>, DataLinkError> {
        let catalog = object
            .catalog
            .as_deref()
            .unwrap_or(&self.definition.database);
        let schema = object
            .schema
            .as_deref()
            .ok_or_else(|| Self::query_failure("PostgreSQL schema is required"))?;
        if catalog != self.definition.database {
            return Err(Self::query_failure(
                "PostgreSQL object catalog must match the connected database",
            ));
        }
        if object.name.trim().is_empty() {
            return Err(Self::query_failure("PostgreSQL object name is required"));
        }

        let mut client = self.connect()?;
        let rows = client
            .query(
                "SELECT c.column_name, c.data_type, c.is_nullable, \
                        c.numeric_precision, c.numeric_scale, \
                        EXISTS ( \
                            SELECT 1 \
                                                        FROM pg_catalog.pg_class cls \
                                                        JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace \
                                                        JOIN pg_catalog.pg_index idx \
                                                            ON idx.indrelid = cls.oid AND idx.indisprimary \
                                                        JOIN pg_catalog.pg_attribute attr \
                                                            ON attr.attrelid = cls.oid \
                                                         AND attr.attnum = ANY(idx.indkey) \
                                                        WHERE ns.nspname = c.table_schema \
                                                            AND cls.relname = c.table_name \
                                                            AND attr.attname = c.column_name \
                        ) AS primary_key \
                 FROM information_schema.columns c \
                 WHERE c.table_catalog = $1 \
                   AND c.table_schema = $2 \
                   AND c.table_name = $3 \
                   AND has_schema_privilege(c.table_schema, 'USAGE') \
                 ORDER BY c.ordinal_position",
                &[&catalog, &schema, &object.name],
            )
            .map_err(|error| Self::query_error(&error))?;

        if rows.is_empty() {
            return Err(Self::query_failure(
                "PostgreSQL object does not exist or is not accessible",
            ));
        }

        rows.into_iter()
            .map(|row| {
                let precision = Self::optional_u32(&row, "numeric_precision")?;
                let scale = Self::optional_u32(&row, "numeric_scale")?;
                Ok(SourceColumn {
                    name: row
                        .try_get("column_name")
                        .map_err(|_| Self::conversion_error("Invalid column name metadata"))?,
                    source_type: row
                        .try_get("data_type")
                        .map_err(|_| Self::conversion_error("Invalid column type metadata"))?,
                    nullable: row
                        .try_get::<_, String>("is_nullable")
                        .map_err(|_| Self::conversion_error("Invalid nullability metadata"))?
                        == "YES",
                    primary_key: row
                        .try_get("primary_key")
                        .map_err(|_| Self::conversion_error("Invalid primary-key metadata"))?,
                    precision,
                    scale,
                })
            })
            .collect()
    }

    pub fn preview(
        &self,
        object: &SourceObjectRef,
        limit: usize,
    ) -> Result<PreviewResult, DataLinkError> {
        if limit == 0 {
            return Err(Self::query_failure(
                "PostgreSQL preview limit must be greater than zero",
            ));
        }
        let columns = self.schema(object)?;
        let schema = object
            .schema
            .as_deref()
            .ok_or_else(|| Self::query_failure("PostgreSQL schema is required"))?;
        let row_limit = limit.min(MAX_PREVIEW_ROWS);
        let fetch_limit = i64::try_from(row_limit + 1)
            .map_err(|_| Self::query_failure("PostgreSQL preview limit is too large"))?;
        let qualified_name = format!(
            "{}.{}",
            Self::quote_identifier(schema),
            Self::quote_identifier(&object.name)
        );
        let query = format!(
            "SELECT to_jsonb(preview_row) AS row_data \
             FROM (SELECT * FROM {qualified_name} LIMIT $1) AS preview_row"
        );

        let mut client = self.connect()?;
        let query_rows = client
            .query(&query, &[&fetch_limit])
            .map_err(|error| Self::query_error(&error))?;
        let truncated = query_rows.len() > row_limit;
        let mut rows = Vec::with_capacity(query_rows.len().min(row_limit));
        for row in query_rows.into_iter().take(row_limit) {
            let value: serde_json::Value = row
                .try_get("row_data")
                .map_err(|_| Self::conversion_error("Invalid preview row"))?;
            let object_value = value
                .as_object()
                .ok_or_else(|| Self::conversion_error("PostgreSQL preview row is not an object"))?;
            rows.push(
                columns
                    .iter()
                    .map(|column| {
                        object_value
                            .get(&column.name)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect(),
            );
        }

        Ok(PreviewResult {
            object_name: format!("{schema}.{}", object.name),
            columns,
            rows,
            truncated,
        })
    }

    pub fn row_count(&self, object: &SourceObjectRef) -> Result<usize, DataLinkError> {
        let qualified_name = self.qualified_name(object)?;
        let mut client = self.connect()?;
        let count: i64 = client
            .query_one(&format!("SELECT COUNT(*) FROM {qualified_name}"), &[])
            .map_err(|error| Self::query_error(&error))?
            .try_get(0)
            .map_err(|_| Self::conversion_error("Invalid PostgreSQL row count"))?;
        usize::try_from(count)
            .map_err(|_| Self::conversion_error("PostgreSQL row count is out of range"))
    }

    pub fn read_batches(
        &self,
        object: &SourceObjectRef,
        batch_size: usize,
        visitor: &mut dyn FnMut(ConnectorBatch) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if batch_size == 0 {
            return Err(AppError::InvalidParam(
                "PostgreSQL batch size must be greater than zero".to_string(),
            ));
        }
        let columns = self.schema(object).map_err(Self::app_error)?;
        let qualified_name = self.qualified_name(object).map_err(Self::app_error)?;
        let query =
            format!("SELECT to_jsonb(source_row) AS row_data FROM {qualified_name} AS source_row");
        let mut client = self.connect().map_err(Self::app_error)?;
        let mut rows = client
            .query_raw(
                &query,
                std::iter::empty::<&(dyn postgres::types::ToSql + Sync)>(),
            )
            .map_err(|error| Self::app_error(Self::query_error(&error)))?;
        let mut batch = Vec::with_capacity(batch_size);
        let mut source_index = 0_usize;
        while let Some(row) = rows
            .next()
            .map_err(|error| Self::app_error(Self::query_error(&error)))?
        {
            let value: serde_json::Value = row
                .try_get("row_data")
                .map_err(|_| Self::app_error(Self::conversion_error("Invalid import row")))?;
            let object_value = value.as_object().ok_or_else(|| {
                Self::app_error(Self::conversion_error(
                    "PostgreSQL import row is not an object",
                ))
            })?;
            source_index += 1;
            let values = columns
                .iter()
                .map(|column| {
                    Self::connector_value(
                        object_value
                            .get(&column.name)
                            .unwrap_or(&serde_json::Value::Null),
                    )
                })
                .collect::<Vec<_>>();
            batch.push(ConnectorRow {
                source_index,
                values,
            });
            if batch.len() == batch_size {
                visitor(ConnectorBatch {
                    rows: std::mem::take(&mut batch),
                })?;
                batch = Vec::with_capacity(batch_size);
            }
        }
        if !batch.is_empty() {
            visitor(ConnectorBatch { rows: batch })?;
        }
        Ok(())
    }

    fn qualified_name(&self, object: &SourceObjectRef) -> Result<String, DataLinkError> {
        let catalog = object
            .catalog
            .as_deref()
            .unwrap_or(&self.definition.database);
        let schema = object
            .schema
            .as_deref()
            .ok_or_else(|| Self::query_failure("PostgreSQL schema is required"))?;
        if catalog != self.definition.database {
            return Err(Self::query_failure(
                "PostgreSQL object catalog must match the connected database",
            ));
        }
        if object.name.trim().is_empty() {
            return Err(Self::query_failure("PostgreSQL object name is required"));
        }
        Ok(format!(
            "{}.{}",
            Self::quote_identifier(schema),
            Self::quote_identifier(&object.name)
        ))
    }

    fn connector_value(value: &serde_json::Value) -> ConnectorValue {
        match value {
            serde_json::Value::Null => ConnectorValue::Null,
            serde_json::Value::Bool(value) => ConnectorValue::Integer(i64::from(*value)),
            serde_json::Value::Number(value) => value
                .as_i64()
                .map(ConnectorValue::Integer)
                .or_else(|| value.as_f64().map(ConnectorValue::Real))
                .unwrap_or_else(|| ConnectorValue::Text(value.to_string())),
            serde_json::Value::String(value) => ConnectorValue::Text(value.clone()),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                ConnectorValue::Text(value.to_string())
            }
        }
    }

    fn app_error(error: DataLinkError) -> AppError {
        match error.category {
            DataLinkErrorCategory::Cancelled => AppError::Cancelled(error.message),
            DataLinkErrorCategory::Conversion => AppError::InvalidParam(error.message),
            _ => AppError::Database(error.message),
        }
    }

    fn quote_identifier(identifier: &str) -> String {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }

    fn optional_u32(row: &postgres::Row, column: &str) -> Result<Option<u32>, DataLinkError> {
        row.try_get::<_, Option<i32>>(column)
            .map_err(|_| Self::conversion_error("Invalid numeric metadata"))?
            .map(|value| {
                u32::try_from(value).map_err(|_| {
                    Self::conversion_error("PostgreSQL numeric metadata cannot be negative")
                })
            })
            .transpose()
    }

    fn connect(&self) -> Result<postgres::Client, DataLinkError> {
        let mut config = Config::new();
        config
            .host(&self.definition.host)
            .port(self.definition.port)
            .dbname(&self.definition.database)
            .user(&self.credentials.username)
            .password(&self.credentials.password)
            .connect_timeout(Duration::from_secs(u64::from(
                self.definition.connect_timeout_seconds,
            )));

        if self.definition.tls_mode == TlsMode::Disabled {
            config.ssl_mode(SslMode::Disable);
            return config
                .connect(NoTls)
                .map_err(|error| Self::connection_error(&error));
        }
        config.ssl_mode(SslMode::Require);
        let connector = self.tls_connector()?;
        config
            .connect(MakeTlsConnector::new(connector))
            .map_err(|error| Self::connection_error(&error))
    }

    fn tls_connector(&self) -> Result<native_tls::TlsConnector, DataLinkError> {
        let mut builder = native_tls::TlsConnector::builder();
        builder.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
        if matches!(self.definition.tls_mode, TlsMode::VerifyCa | TlsMode::VerifyFull) {
            if let Some(pem) = self.definition.tls_root_certificate_pem.as_deref() {
                for certificate in Self::root_certificates(pem)? {
                    builder.add_root_certificate(certificate);
                }
            }
        }
        match self.definition.tls_mode {
            TlsMode::Required => {
                builder.danger_accept_invalid_certs(true);
                builder.danger_accept_invalid_hostnames(true);
            }
            TlsMode::VerifyCa => {
                builder.danger_accept_invalid_hostnames(true);
            }
            TlsMode::VerifyFull => {}
            TlsMode::Disabled => {
                return Err(DataLinkError::new(
                    DataLinkErrorCategory::Tls,
                    "TLS is disabled for this PostgreSQL connection",
                ));
            }
        }
        builder.build().map_err(|_| {
            DataLinkError::new(
                DataLinkErrorCategory::Tls,
                "Could not configure PostgreSQL TLS",
            )
        })
    }

    fn root_certificates(pem: &str) -> Result<Vec<native_tls::Certificate>, DataLinkError> {
        let invalid_certificate = || DataLinkError::new(
            DataLinkErrorCategory::Tls,
            "Invalid PostgreSQL CA certificate; provide PEM certificates only (maximum 256 KiB)",
        );
        if pem.len() > 256 * 1024 {
            return Err(invalid_certificate());
        }
        let mut reader = std::io::Cursor::new(pem.as_bytes());
        let mut certificates = Vec::new();
        for item in rustls_pemfile::read_all(&mut reader) {
            match item.map_err(|_| invalid_certificate())? {
                rustls_pemfile::Item::X509Certificate(der) => {
                    certificates.push(native_tls::Certificate::from_der(der.as_ref())
                        .map_err(|_| invalid_certificate())?);
                }
                _ => return Err(invalid_certificate()),
            }
        }
        if certificates.is_empty() {
            return Err(invalid_certificate());
        }
        Ok(certificates)
    }

    fn validate(
        definition: &ConnectionDefinition,
        credentials: &ConnectionCredentials,
    ) -> Result<(), DataLinkError> {
        if definition.connector != ConnectorKind::PostgreSql {
            return Err(Self::query_failure(
                "PostgreSQL connector requires connector=postgresql",
            ));
        }
        if definition.authentication_type != AuthenticationType::UsernamePassword {
            return Err(Self::query_failure(
                "PostgreSQL currently supports username/password authentication only",
            ));
        }
        if definition.host.trim().is_empty() {
            return Err(Self::query_failure("PostgreSQL host is required"));
        }
        if definition.database.trim().is_empty() {
            return Err(Self::query_failure("PostgreSQL database is required"));
        }
        if credentials.username.trim().is_empty() {
            return Err(Self::query_failure("PostgreSQL username is required"));
        }
        if credentials.password.is_empty() {
            return Err(Self::query_failure("PostgreSQL password is required"));
        }
        if !(1..=300).contains(&definition.connect_timeout_seconds) {
            return Err(Self::query_failure(
                "PostgreSQL connection timeout must be between 1 and 300 seconds",
            ));
        }
        Ok(())
    }

    fn connection_error(error: &postgres::Error) -> DataLinkError {
        if error.to_string() == "error performing TLS handshake" {
            return DataLinkError::new(
                DataLinkErrorCategory::Tls,
                "PostgreSQL TLS negotiation or certificate verification failed",
            );
        }
        if let Some(database_error) = error.as_db_error() {
            let code = database_error.code().code();
            if code.starts_with("28") {
                return DataLinkError::new(
                    DataLinkErrorCategory::Authentication,
                    "PostgreSQL authentication failed",
                );
            }
            return Self::query_error(error);
        }
        DataLinkError::new(
            DataLinkErrorCategory::Network,
            "Could not reach the PostgreSQL server",
        )
    }

    fn query_error(error: &postgres::Error) -> DataLinkError {
        let category = error
            .as_db_error()
            .map(|database_error| database_error.code().code())
            .filter(|code| *code == "42501")
            .map(|_| DataLinkErrorCategory::Permission)
            .unwrap_or(DataLinkErrorCategory::Query);
        let message = if category == DataLinkErrorCategory::Permission {
            "PostgreSQL permission was denied"
        } else {
            "PostgreSQL request failed"
        };
        DataLinkError::new(category, message)
    }

    fn query_failure(message: impl Into<String>) -> DataLinkError {
        DataLinkError::new(DataLinkErrorCategory::Query, message)
    }

    fn conversion_error(message: impl Into<String>) -> DataLinkError {
        DataLinkError::new(DataLinkErrorCategory::Conversion, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_definition() -> ConnectionDefinition {
        ConnectionDefinition {
            connector: ConnectorKind::PostgreSql,
            host: "127.0.0.1".to_string(),
            port: 55432,
            database: "statsplayground_test".to_string(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            tls_root_certificate_pem: None,
            connect_timeout_seconds: 5,
        }
    }

    fn fixture_credentials(password: &str) -> ConnectionCredentials {
        ConnectionCredentials {
            username: "stats_reader".to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn rejects_invalid_timeout() {
        let mut definition = fixture_definition();
        definition.connect_timeout_seconds = 0;
        let timeout_error = PostgresConnector::new(definition, fixture_credentials("unused"))
            .err()
            .expect("reject zero timeout");
        assert_eq!(timeout_error.category, DataLinkErrorCategory::Query);
        assert!(timeout_error.to_string().contains("between 1 and 300"));
    }

    #[test]
    fn builds_supported_tls_modes() {
        for mode in [TlsMode::Required, TlsMode::VerifyCa, TlsMode::VerifyFull] {
            let mut definition = fixture_definition();
            definition.tls_mode = mode;
            let connector = PostgresConnector::new(definition, fixture_credentials("unused"))
                .expect("create connector");
            connector.tls_connector().expect("build TLS connector");
        }
    }

    #[test]
    fn credentials_do_not_implement_debug_or_serialization() {
        let connector = PostgresConnector::new(
            fixture_definition(),
            fixture_credentials("session-only-secret"),
        )
        .expect("create connector");

        assert_eq!(connector.credentials.username, "stats_reader");
    }

    #[test]
    fn rejects_invalid_root_certificates_without_exposing_input() {
        for pem in [
            String::new(),
            "not-a-certificate-secret".to_string(),
            "-----BEGIN CERTIFICATE-----\nbm90LWEtdmFsaWQtY2VydA==\n-----END CERTIFICATE-----".to_string(),
            "x".repeat(256 * 1024 + 1),
        ] {
            let mut definition = fixture_definition();
            definition.tls_mode = TlsMode::VerifyFull;
            definition.tls_root_certificate_pem = Some(pem);
            let connector = PostgresConnector::new(definition, fixture_credentials("unused"))
                .expect("create connector");
            let error = connector.tls_connector().err().expect("reject invalid CA");
            assert_eq!(error.category, DataLinkErrorCategory::Tls);
            assert!(!error.message.contains("not-a-certificate-secret"));
        }
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn connects_to_configured_postgresql_fixture() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let connector =
            PostgresConnector::new(fixture_definition(), fixture_credentials(&password))
                .expect("create connector");

        connector.test_connection().expect("connect to fixture");
    }

    fn tls_fixture_certificate(name: &str) -> String {
        let directory = std::env::var("STATSPG_TEST_POSTGRES_TLS_CERT_DIR")
            .expect("STATSPG_TEST_POSTGRES_TLS_CERT_DIR must contain the fixture public CA files");
        std::fs::read_to_string(std::path::Path::new(&directory).join(name))
            .expect("read public fixture CA")
    }

    fn tls_fixture_definition(mode: TlsMode, host: &str) -> ConnectionDefinition {
        let mut definition = fixture_definition();
        definition.host = host.to_string();
        definition.port = 16434;
        if matches!(mode, TlsMode::VerifyCa | TlsMode::VerifyFull) {
            definition.tls_root_certificate_pem = Some(tls_fixture_certificate("ca.pem"));
        }
        definition.tls_mode = mode;
        definition
    }

    #[test]
    #[ignore = "requires the isolated postgresql-tls fixture and its public CA files"]
    fn tls_fixture_modes_encrypt_connections() {
        for (mode, host) in [
            (TlsMode::Required, "127.0.0.1"),
            (TlsMode::VerifyCa, "127.0.0.1"),
            (TlsMode::VerifyFull, "localhost"),
        ] {
            let connector = PostgresConnector::new(
                tls_fixture_definition(mode, host),
                fixture_credentials("stats_reader_local_only"),
            ).expect("create TLS connector");
            let mut client = connector.connect().expect("connect with TLS");
            let row = client.query_one(
                "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &[],
            ).expect("inspect transport encryption");
            assert!(row.get::<_, bool>("ssl"));
            assert!(matches!(row.get::<_, String>("version").as_str(), "TLSv1.2" | "TLSv1.3"));
        }
    }

    #[test]
    #[ignore = "requires the isolated postgresql-tls fixture and its public CA files"]
    fn tls_fixture_rejects_untrusted_ca_and_wrong_hostname() {
        for mode in [TlsMode::VerifyCa, TlsMode::VerifyFull] {
            for certificate in [None, Some(tls_fixture_certificate("other-ca.pem"))] {
                let mut definition = tls_fixture_definition(mode.clone(), "localhost");
                definition.tls_root_certificate_pem = certificate;
                let connector = PostgresConnector::new(definition, fixture_credentials("stats_reader_local_only"))
                    .expect("create untrusted connector");
                let error = connector.test_connection().expect_err("reject untrusted CA");
                assert_eq!(error.category, DataLinkErrorCategory::Tls);
                assert!(!error.message.contains("stats_reader_local_only"));
            }
        }
        let connector = PostgresConnector::new(
            tls_fixture_definition(TlsMode::VerifyFull, "127.0.0.1"),
            fixture_credentials("stats_reader_local_only"),
        ).expect("create hostname mismatch connector");
        let error = connector.test_connection().expect_err("reject hostname mismatch");
        assert_eq!(error.category, DataLinkErrorCategory::Tls);
    }

    #[test]
    #[ignore = "requires the isolated postgresql-tls fixture and its public CA files"]
    fn tls_fixture_rejects_plaintext_without_downgrade() {
        for mode in [TlsMode::Required, TlsMode::VerifyCa, TlsMode::VerifyFull] {
            let mut definition = tls_fixture_definition(mode, "localhost");
            definition.port = 16435;
            let connector = PostgresConnector::new(definition, fixture_credentials("stats_reader_local_only"))
                .expect("create connector requiring TLS");
            let error = connector.test_connection().expect_err("reject plaintext server");
            assert_eq!(error.category, DataLinkErrorCategory::Tls);
        }
        let mut definition = tls_fixture_definition(TlsMode::Disabled, "127.0.0.1");
        definition.port = 16435;
        let connector = PostgresConnector::new(definition, fixture_credentials("stats_reader_local_only"))
            .expect("create explicitly plaintext connector");
        let mut client = connector.connect().expect("connect without TLS only when requested");
        let row = client.query_one("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &[])
            .expect("inspect plaintext transport");
        assert!(!row.get::<_, bool>("ssl"));
    }

    #[test]
    #[ignore = "requires the isolated postgresql-tls fixture and its public CA files"]
    fn tls_fixture_preserves_authentication_and_network_errors() {
        let connector = PostgresConnector::new(
            tls_fixture_definition(TlsMode::VerifyFull, "localhost"),
            fixture_credentials("must-not-appear-in-errors"),
        ).expect("create connector with incorrect password");
        let error = connector.test_connection().expect_err("reject incorrect password");
        assert_eq!(error.category, DataLinkErrorCategory::Authentication);
        assert!(!error.message.contains("must-not-appear-in-errors"));
        let mut definition = tls_fixture_definition(TlsMode::VerifyFull, "127.0.0.1");
        let unused_port = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve unused port");
        definition.port = unused_port.local_addr().expect("local address").port();
        drop(unused_port);
        let connector = PostgresConnector::new(definition, fixture_credentials("unused"))
            .expect("create unreachable connector");
        let error = connector.test_connection().expect_err("reject unreachable server");
        assert_eq!(error.category, DataLinkErrorCategory::Network);
    }

    #[test]
    #[ignore = "requires the isolated postgresql-tls fixture and its public CA files"]
    fn tls_fixture_discovers_previews_and_imports_snapshots() {
        let definition = tls_fixture_definition(TlsMode::VerifyFull, "localhost");
        let credentials = fixture_credentials("stats_reader_local_only");
        let connector = PostgresConnector::new(definition.clone(), credentials.clone())
            .expect("create verified connector");
        let objects = connector.list_objects().expect("discover over TLS");
        assert_eq!(objects.len(), 4);
        let state = crate::state::AppState::new().expect("create app state");
        let service = crate::services::io_service::IoService::new(&state);
        for (name, row_count) in [("customers", 3), ("measurements", 100_000)] {
            let object = objects.iter().find(|object| object.name == name).expect("find fixture object");
            let preview = connector.preview(object, 100).expect("preview over TLS");
            assert_eq!(preview.rows.len(), row_count.min(100));
            let summary = service.import_postgres_snapshot(
                definition.clone(), credentials.clone(), object.clone(), name, |_, _| {}, || false,
            ).expect("import verified TLS snapshot");
            assert_eq!(summary.status, "completed");
            assert_eq!(summary.total_rows_written, row_count);
        }
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn discovers_only_objects_visible_to_the_fixture_reader() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let connector =
            PostgresConnector::new(fixture_definition(), fixture_credentials(&password))
                .expect("create connector");

        let objects = connector.list_objects().expect("discover objects");
        assert_eq!(objects.len(), 4);
        assert!(objects.iter().all(|object| {
            object.catalog.as_deref() == Some("statsplayground_test")
                && object.schema.as_deref() == Some("datalink")
        }));
        assert!(objects.iter().any(|object| {
            object.name == "customer_summary" && object.object_type == SourceObjectType::View
        }));
        assert!(!objects.iter().any(|object| object.name == "secrets"));
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn discovers_fixture_column_metadata() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let connector =
            PostgresConnector::new(fixture_definition(), fixture_credentials(&password))
                .expect("create connector");
        let object = SourceObjectRef {
            catalog: Some("statsplayground_test".to_string()),
            schema: Some("datalink".to_string()),
            name: "customers".to_string(),
            object_type: SourceObjectType::Table,
        };

        let columns = connector.schema(&object).expect("discover columns");
        assert_eq!(columns.len(), 9);
        let id = columns
            .iter()
            .find(|column| column.name == "customer_id")
            .expect("customer_id column");
        assert!(id.primary_key);
        assert!(!id.nullable);
        let lifetime_value = columns
            .iter()
            .find(|column| column.name == "lifetime_value")
            .expect("lifetime_value column");
        assert_eq!(lifetime_value.precision, Some(18));
        assert_eq!(lifetime_value.scale, Some(4));
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn previews_fixture_rows_with_a_hard_limit() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let connector =
            PostgresConnector::new(fixture_definition(), fixture_credentials(&password))
                .expect("create connector");
        let object = SourceObjectRef {
            catalog: Some("statsplayground_test".to_string()),
            schema: Some("datalink".to_string()),
            name: "measurements".to_string(),
            object_type: SourceObjectType::Table,
        };

        let preview = connector.preview(&object, 500).expect("preview rows");
        assert_eq!(preview.object_name, "datalink.measurements");
        assert_eq!(preview.rows.len(), MAX_PREVIEW_ROWS);
        assert!(preview.truncated);
        assert_eq!(preview.rows[0].len(), preview.columns.len());
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn classifies_fixture_failures_without_exposing_credentials() {
        let fixture_password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let secret = "must-not-appear-in-errors";
        let authentication_error =
            PostgresConnector::new(fixture_definition(), fixture_credentials(secret))
                .expect("create authentication connector")
                .test_connection()
                .expect_err("reject incorrect password");
        assert_eq!(
            authentication_error.category,
            DataLinkErrorCategory::Authentication
        );
        assert!(!serde_json::to_string(&authentication_error)
            .expect("serialize authentication error")
            .contains(secret));

        let mut unreachable_definition = fixture_definition();
        unreachable_definition.port = 55431;
        let network_error =
            PostgresConnector::new(unreachable_definition, fixture_credentials("unused"))
                .expect("create network connector")
                .test_connection()
                .expect_err("reject unreachable port");
        assert_eq!(network_error.category, DataLinkErrorCategory::Network);

        let mut missing_database_definition = fixture_definition();
        missing_database_definition.database = "missing_database".to_string();
        let database_error = PostgresConnector::new(
            missing_database_definition,
            fixture_credentials(&fixture_password),
        )
        .expect("create database connector")
        .test_connection()
        .expect_err("reject missing database");
        assert_eq!(database_error.category, DataLinkErrorCategory::Query);

        let connector =
            PostgresConnector::new(fixture_definition(), fixture_credentials(&fixture_password))
                .expect("create fixture connector");
        let mut client = connector.connect().expect("connect to fixture");
        let permission_driver_error = client
            .query("SELECT * FROM private_data.secrets", &[])
            .expect_err("deny protected schema");
        let permission_error = PostgresConnector::query_error(&permission_driver_error);
        assert_eq!(permission_error.category, DataLinkErrorCategory::Permission);

        let missing_object = SourceObjectRef {
            catalog: Some("statsplayground_test".to_string()),
            schema: Some("datalink".to_string()),
            name: "missing_object".to_string(),
            object_type: SourceObjectType::Table,
        };
        let object_error = connector
            .schema(&missing_object)
            .expect_err("reject missing object");
        assert_eq!(object_error.category, DataLinkErrorCategory::Query);
    }
}

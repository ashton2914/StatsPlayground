use std::{io::Write, time::Duration};

use mysql::{prelude::Queryable, Conn, OptsBuilder, SslOpts};

use crate::connectors::{ConnectorBatch, ConnectorRow, ConnectorValue};
use crate::error::AppError;
use crate::models::data_link::{
    AuthenticationType, ConnectionCredentials, ConnectionDefinition, ConnectorKind, DataLinkError,
    DataLinkErrorCategory, PreviewResult, SourceColumn, SourceObjectRef, SourceObjectType, TlsMode,
};

pub struct MySqlConnector {
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
}

impl MySqlConnector {
    pub fn new(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<Self, DataLinkError> {
        if definition.connector != ConnectorKind::MySql
            || definition.authentication_type != AuthenticationType::UsernamePassword
        {
            return Err(Self::failure(
                "MySQL requires username/password authentication and connector=mysql",
            ));
        }
        if definition.host.trim().is_empty()
            || definition.database.trim().is_empty()
            || credentials.username.trim().is_empty()
            || credentials.password.is_empty()
            || definition.port == 0
            || !(1..=300).contains(&definition.connect_timeout_seconds)
        {
            return Err(Self::failure("MySQL requires host, port, database, username, password and a timeout between 1 and 300 seconds"));
        }
        Ok(Self {
            definition,
            credentials,
        })
    }

    pub fn test_connection(&self) -> Result<(), DataLinkError> {
        self.connect()?
            .query_drop("SELECT 1")
            .map_err(Self::driver_error)
    }

    pub fn list_objects(&self) -> Result<Vec<SourceObjectRef>, DataLinkError> {
        let rows: Vec<(String, String)> = self.connect()?.exec(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_NAME",
            (&self.definition.database,),
        ).map_err(Self::driver_error)?;
        Ok(rows
            .into_iter()
            .map(|(name, kind)| SourceObjectRef {
                catalog: Some(self.definition.database.clone()),
                schema: Some(self.definition.database.clone()),
                name,
                object_type: if kind == "VIEW" {
                    SourceObjectType::View
                } else {
                    SourceObjectType::Table
                },
            })
            .collect())
    }

    pub fn schema(&self, object: &SourceObjectRef) -> Result<Vec<SourceColumn>, DataLinkError> {
        self.qualified_name(object)?;
        let rows: Vec<mysql::Row> = self.connect()?.exec(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, NUMERIC_PRECISION, NUMERIC_SCALE FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (&self.definition.database, &object.name),
        ).map_err(Self::driver_error)?;
        if rows.is_empty() {
            return Err(Self::failure(
                "MySQL object does not exist or is not accessible",
            ));
        }
        rows.into_iter()
            .map(|row| {
                let (name, source_type, nullable, key, precision, scale): (
                    String,
                    String,
                    String,
                    String,
                    Option<u32>,
                    Option<u32>,
                ) = mysql::from_row_opt(row).map_err(|_| Self::conversion_error())?;
                Ok(SourceColumn {
                    name,
                    source_type,
                    nullable: nullable == "YES",
                    primary_key: key == "PRI",
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
            return Err(Self::failure(
                "MySQL preview limit must be greater than zero",
            ));
        }
        let columns = self.schema(object)?;
        let qualified = self.qualified_name(object)?;
        let limit = limit.min(100);
        let rows: Vec<mysql::Row> = self
            .connect()?
            .exec(
                format!("SELECT * FROM {qualified} LIMIT ?"),
                ((limit + 1) as u64,),
            )
            .map_err(Self::driver_error)?;
        let truncated = rows.len() > limit;
        let rows = rows
            .into_iter()
            .take(limit)
            .map(|row| {
                Self::row_values(row, &columns).map(|values| {
                    values
                        .into_iter()
                        .map(|value| match value {
                            ConnectorValue::Null => serde_json::Value::Null,
                            ConnectorValue::Integer(value)
                                if value.unsigned_abs() <= 9_007_199_254_740_991 =>
                            {
                                serde_json::json!(value)
                            }
                            ConnectorValue::Integer(value) => serde_json::json!(value.to_string()),
                            ConnectorValue::Real(value) => serde_json::json!(value),
                            ConnectorValue::Text(value) => serde_json::json!(value),
                            ConnectorValue::Blob(value) => {
                                serde_json::json!(format!("<BLOB: {} bytes>", value.len()))
                            }
                        })
                        .collect()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PreviewResult {
            object_name: format!("{}.{}", self.definition.database, object.name),
            columns,
            rows,
            truncated,
        })
    }

    pub fn row_count(&self, object: &SourceObjectRef) -> Result<usize, DataLinkError> {
        let qualified = self.qualified_name(object)?;
        let count: Option<u64> = self
            .connect()?
            .query_first(format!("SELECT COUNT(*) FROM {qualified}"))
            .map_err(Self::driver_error)?;
        usize::try_from(count.ok_or_else(Self::conversion_error)?)
            .map_err(|_| Self::conversion_error())
    }

    pub fn read_batches(
        &self,
        object: &SourceObjectRef,
        batch_size: usize,
        visitor: &mut dyn FnMut(ConnectorBatch) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if batch_size == 0 {
            return Err(AppError::InvalidParam(
                "MySQL batch size must be greater than zero".into(),
            ));
        }
        let columns = self.schema(object).map_err(Self::app_error)?;
        let qualified = self.qualified_name(object).map_err(Self::app_error)?;
        let mut client = self.connect().map_err(Self::app_error)?;
        let rows = client
            .query_iter(format!("SELECT * FROM {qualified}"))
            .map_err(|error| Self::app_error(Self::driver_error(error)))?;
        let mut batch = Vec::with_capacity(batch_size);
        for (index, row) in rows.enumerate() {
            let row = row.map_err(|error| Self::app_error(Self::driver_error(error)))?;
            batch.push(ConnectorRow {
                source_index: index + 1,
                values: Self::row_values(row, &columns).map_err(Self::app_error)?,
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
        if object
            .catalog
            .as_ref()
            .is_some_and(|catalog| catalog != &self.definition.database)
            || object
                .schema
                .as_ref()
                .is_some_and(|schema| schema != &self.definition.database)
            || object.name.trim().is_empty()
            || object.name.contains('\0')
        {
            return Err(Self::failure(
                "MySQL object must belong to the connected database and have a valid name",
            ));
        }
        Ok(format!(
            "{}.{}",
            Self::quote_identifier(&self.definition.database),
            Self::quote_identifier(&object.name)
        ))
    }

    fn quote_identifier(identifier: &str) -> String {
        format!("`{}`", identifier.replace('`', "``"))
    }

    fn row_values(
        row: mysql::Row,
        columns: &[SourceColumn],
    ) -> Result<Vec<ConnectorValue>, DataLinkError> {
        if row.len() != columns.len() {
            return Err(Self::conversion_error());
        }
        columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                Self::connector_value(
                    row.as_ref(index).ok_or_else(Self::conversion_error)?,
                    &column.source_type,
                )
            })
            .collect()
    }

    fn connector_value(
        value: &mysql::Value,
        source_type: &str,
    ) -> Result<ConnectorValue, DataLinkError> {
        Ok(match value {
            mysql::Value::NULL => ConnectorValue::Null,
            mysql::Value::Int(value) => ConnectorValue::Integer(*value),
            mysql::Value::UInt(value) => i64::try_from(*value)
                .map(ConnectorValue::Integer)
                .unwrap_or_else(|_| ConnectorValue::Text(value.to_string())),
            mysql::Value::Float(value) => ConnectorValue::Real(f64::from(*value)),
            mysql::Value::Double(value) => ConnectorValue::Real(*value),
            mysql::Value::Bytes(value) => {
                let kind = source_type.to_ascii_lowercase();
                if kind.contains("blob")
                    || kind.starts_with("binary")
                    || kind.starts_with("varbinary")
                    || kind.starts_with("bit(")
                {
                    ConnectorValue::Blob(value.clone())
                } else {
                    ConnectorValue::Text(
                        String::from_utf8(value.clone()).map_err(|_| Self::conversion_error())?,
                    )
                }
            }
            mysql::Value::Date(year, month, day, hour, minute, second, microsecond) => {
                let text = if source_type.eq_ignore_ascii_case("date") {
                    format!("{year:04}-{month:02}-{day:02}")
                } else {
                    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{microsecond:06}")
                };
                ConnectorValue::Text(text)
            }
            mysql::Value::Time(negative, days, hours, minutes, seconds, microseconds) => {
                ConnectorValue::Text(format!(
                    "{}{:02}:{minutes:02}:{seconds:02}.{microseconds:06}",
                    if *negative { "-" } else { "" },
                    u64::from(*days) * 24 + u64::from(*hours),
                ))
            }
        })
    }

    fn conversion_error() -> DataLinkError {
        DataLinkError::new(
            DataLinkErrorCategory::Conversion,
            "MySQL value or metadata could not be converted without data loss",
        )
    }

    fn app_error(error: DataLinkError) -> AppError {
        AppError::Database(error.message)
    }

    fn connect(&self) -> Result<Conn, DataLinkError> {
        let (ssl_options, _certificate_file) = self.tls_options()?;
        let timeout = Duration::from_secs(u64::from(self.definition.connect_timeout_seconds));
        let options = OptsBuilder::default()
            .ip_or_hostname(Some(self.definition.host.clone()))
            .tcp_port(self.definition.port)
            .db_name(Some(self.definition.database.clone()))
            .user(Some(self.credentials.username.clone()))
            .pass(Some(self.credentials.password.clone()))
            .ssl_opts(ssl_options)
            .prefer_socket(false)
            .tcp_connect_timeout(Some(timeout))
            .read_timeout(Some(timeout))
            .write_timeout(Some(timeout));
        Conn::new(options).map_err(Self::driver_error)
    }

    fn tls_options(
        &self,
    ) -> Result<(Option<SslOpts>, Option<tempfile::NamedTempFile>), DataLinkError> {
        if self.definition.tls_mode == TlsMode::Disabled {
            return Ok((None, None));
        }
        let mut options = SslOpts::default();
        match self.definition.tls_mode {
            TlsMode::Required => {
                options = options
                    .with_danger_accept_invalid_certs(true)
                    .with_danger_skip_domain_validation(true);
            }
            TlsMode::VerifyCa => options = options.with_danger_skip_domain_validation(true),
            TlsMode::VerifyFull => {}
            TlsMode::Disabled => return Ok((None, None)),
        }
        let mut certificate_file = None;
        if matches!(
            self.definition.tls_mode,
            TlsMode::VerifyCa | TlsMode::VerifyFull
        ) {
            if let Some(pem) = self.definition.tls_root_certificate_pem.as_deref() {
                Self::validate_root_certificates(pem)?;
                let storage_error = |_| {
                    DataLinkError::new(
                        DataLinkErrorCategory::Storage,
                        "Could not prepare the temporary MySQL CA certificate",
                    )
                };
                let mut file = tempfile::Builder::new()
                    .prefix("statsplayground-mysql-ca-")
                    .suffix(".pem")
                    .tempfile()
                    .map_err(storage_error)?;
                file.write_all(pem.as_bytes()).map_err(storage_error)?;
                file.flush().map_err(storage_error)?;
                options = options.with_root_cert_path(Some(file.path().to_path_buf()));
                certificate_file = Some(file);
            }
        }
        Ok((Some(options), certificate_file))
    }

    fn validate_root_certificates(pem: &str) -> Result<(), DataLinkError> {
        let invalid = || {
            DataLinkError::new(
                DataLinkErrorCategory::Tls,
                "Invalid MySQL CA certificate; provide PEM certificates only (maximum 256 KiB)",
            )
        };
        if pem.len() > 256 * 1024 {
            return Err(invalid());
        }
        let mut reader = std::io::Cursor::new(pem.as_bytes());
        let mut count = 0;
        for item in rustls_pemfile::read_all(&mut reader) {
            match item.map_err(|_| invalid())? {
                rustls_pemfile::Item::X509Certificate(der) => {
                    native_tls::Certificate::from_der(der.as_ref()).map_err(|_| invalid())?;
                    count += 1;
                }
                _ => return Err(invalid()),
            }
        }
        if count == 0 {
            return Err(invalid());
        }
        Ok(())
    }

    fn failure(message: &str) -> DataLinkError {
        DataLinkError::new(DataLinkErrorCategory::Query, message)
    }

    fn driver_error(error: mysql::Error) -> DataLinkError {
        let (category, message) = match error {
            mysql::Error::TlsError(_)
            | mysql::Error::DriverError(mysql::DriverError::TlsNotSupported) => (
                DataLinkErrorCategory::Tls,
                "MySQL TLS negotiation or certificate verification failed",
            ),
            mysql::Error::MySqlError(error) => match error.code {
                3159 => (
                    DataLinkErrorCategory::Tls,
                    "MySQL server requires a secure connection",
                ),
                1045 | 1698 => (
                    DataLinkErrorCategory::Authentication,
                    "MySQL authentication failed",
                ),
                1044 | 1142 | 1143 | 1227 => {
                    (DataLinkErrorCategory::Permission, "MySQL permission denied")
                }
                _ => (
                    DataLinkErrorCategory::Query,
                    "MySQL query failed; check database, object and permissions",
                ),
            },
            _ => (
                DataLinkErrorCategory::Network,
                "Could not communicate with the MySQL server",
            ),
        };
        DataLinkError::new(category, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> ConnectionDefinition {
        ConnectionDefinition {
            connector: ConnectorKind::MySql,
            host: "127.0.0.1".into(),
            port: 53306,
            database: "statsplayground_test".into(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            tls_root_certificate_pem: None,
            connect_timeout_seconds: 10,
        }
    }

    fn credentials() -> ConnectionCredentials {
        ConnectionCredentials {
            username: "reader".into(),
            password: "test-only".into(),
        }
    }

    #[test]
    #[ignore = "requires the local MySQL fixture and STATSPG_TEST_MYSQL_PASSWORD"]
    fn mysql_fixture_discovery_preview_batches_and_permissions() {
        let credentials = ConnectionCredentials {
            username: "stats_reader".into(),
            password: std::env::var("STATSPG_TEST_MYSQL_PASSWORD").expect("fixture password"),
        };
        let connector = MySqlConnector::new(definition(), credentials.clone()).expect("connector");
        connector.test_connection().expect("connect over TCP");
        let objects = connector.list_objects().expect("discover objects");
        assert_eq!(objects.len(), 6);
        let object = |name: &str| {
            objects
                .iter()
                .find(|object| object.name == name)
                .expect("fixture object")
        };
        let customers = connector
            .preview(object("customers"), 100)
            .expect("customers");
        assert_eq!(customers.rows.len(), 3);
        assert_eq!(customers.rows[0][1], "\u{5f20}\u{4e09}");
        assert!(customers.columns[0].primary_key);
        assert!(!customers.columns[1].nullable);
        assert!(customers.rows[2][2].is_null());
        let types = connector
            .preview(object("type_samples"), 100)
            .expect("type samples");
        assert_eq!(types.rows[0][1], "18446744073709551615");
        assert_eq!(types.rows[1][1], "9007199254740993");
        assert_eq!(types.rows[0][2], "123456789012345678901.123456789");
        assert_eq!(types.rows[0][3], "<BLOB: 4 bytes>");
        assert_eq!(types.rows[0][5], "-25:02:03.123456");
        assert_eq!(types.columns[2].precision, Some(30));
        assert_eq!(types.columns[2].scale, Some(9));
        assert!(connector
            .preview(object("empty_table"), 100)
            .expect("empty")
            .rows
            .is_empty());
        assert_eq!(
            connector
                .preview(object("odd`table"), 100)
                .expect("quoted name")
                .rows[0][0],
            42
        );
        assert_eq!(
            object("measurement_summary").object_type,
            SourceObjectType::View
        );
        assert_eq!(
            connector
                .preview(object("measurement_summary"), 100)
                .expect("view")
                .rows
                .len(),
            5
        );
        let preview = connector
            .preview(object("measurements"), 999)
            .expect("limited preview");
        assert_eq!(preview.rows.len(), 100);
        assert!(preview.truncated);
        assert_eq!(
            connector.row_count(object("measurements")).expect("count"),
            100_000
        );
        let mut count = 0;
        connector
            .read_batches(object("measurements"), 777, &mut |batch| {
                assert!(batch.rows.len() <= 777);
                assert_eq!(batch.rows[0].source_index, count + 1);
                count += batch.rows.len();
                Ok(())
            })
            .expect("stream bounded batches");
        assert_eq!(count, 100_000);
        let error = connector
            .connect()
            .expect("reader")
            .query_drop("INSERT INTO empty_table VALUES (1, 'denied')")
            .expect_err("read only");
        assert_eq!(
            MySqlConnector::driver_error(error).category,
            DataLinkErrorCategory::Permission
        );
        let error = connector
            .connect()
            .expect("reader")
            .query_drop("SELECT * FROM statsplayground_private.secrets")
            .expect_err("private database");
        assert_eq!(
            MySqlConnector::driver_error(error).category,
            DataLinkErrorCategory::Permission
        );
        let wrong = ConnectionCredentials {
            password: "deliberately-wrong".into(),
            ..credentials
        };
        assert_eq!(
            MySqlConnector::new(definition(), wrong)
                .expect("valid configuration")
                .test_connection()
                .expect_err("bad password")
                .category,
            DataLinkErrorCategory::Authentication
        );
    }

    #[test]
    fn mysql_preserves_unsigned_decimal_binary_and_quotes_identifiers() {
        assert!(
            matches!(MySqlConnector::connector_value(&mysql::Value::UInt(u64::MAX), "bigint unsigned").expect("unsigned"), ConnectorValue::Text(value) if value == u64::MAX.to_string())
        );
        assert!(
            matches!(MySqlConnector::connector_value(&mysql::Value::Bytes(b"1234567890.123456789".to_vec()), "decimal(30,9)").expect("decimal"), ConnectorValue::Text(value) if value == "1234567890.123456789")
        );
        assert!(
            matches!(MySqlConnector::connector_value(&mysql::Value::Bytes(vec![0, 255]), "blob").expect("binary"), ConnectorValue::Blob(value) if value == vec![0, 255])
        );
        assert_eq!(MySqlConnector::quote_identifier("odd`name"), "`odd``name`");
    }

    fn tls_fixture_definition(mode: TlsMode, host: &str) -> ConnectionDefinition {
        let mut definition = definition();
        definition.host = host.into();
        definition.port = 53307;
        if matches!(mode, TlsMode::VerifyCa | TlsMode::VerifyFull) {
            definition.tls_root_certificate_pem = Some(tls_fixture_certificate("ca.pem"));
        }
        definition.tls_mode = mode;
        definition
    }

    fn tls_fixture_certificate(name: &str) -> String {
        let directory =
            std::env::var("STATSPG_TEST_MYSQL_TLS_CERT_DIR").expect("public CA directory");
        std::fs::read_to_string(std::path::Path::new(&directory).join(name)).expect("public CA")
    }

    fn tls_fixture_credentials() -> ConnectionCredentials {
        ConnectionCredentials {
            username: "stats_reader".into(),
            password: "stats_reader_local_only".into(),
        }
    }

    #[test]
    #[ignore = "requires mysql-tls fixture and STATSPG_TEST_MYSQL_TLS_CERT_DIR"]
    fn mysql_tls_modes_encrypt_and_clean_up_public_ca() {
        for (mode, host) in [
            (TlsMode::Required, "127.0.0.1"),
            (TlsMode::VerifyCa, "127.0.0.1"),
            (TlsMode::VerifyFull, "localhost"),
        ] {
            let connector = MySqlConnector::new(
                tls_fixture_definition(mode, host),
                tls_fixture_credentials(),
            )
            .expect("connector");
            let mut client = connector.connect().expect("TLS connection");
            let (_, cipher): (String, String) = client
                .query_first("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
                .expect("cipher query")
                .expect("cipher");
            assert!(!cipher.is_empty());
            let (_, version): (String, String) = client
                .query_first("SHOW SESSION STATUS LIKE 'Ssl_version'")
                .expect("version query")
                .expect("version");
            assert!(matches!(version.as_str(), "TLSv1.2" | "TLSv1.3"));
            let (options, file) = connector.tls_options().expect("options");
            if let Some(file) = file {
                let path = file.path().to_path_buf();
                assert_eq!(options.expect("TLS").root_cert_path(), Some(path.as_path()));
                assert!(path.exists());
                drop(file);
                assert!(!path.exists());
            }
        }
        let mut definition = tls_fixture_definition(TlsMode::VerifyFull, "localhost");
        definition.tls_root_certificate_pem = Some(format!(
            "{}\n{}",
            tls_fixture_certificate("other-ca.pem"),
            tls_fixture_certificate("ca.pem")
        ));
        MySqlConnector::new(definition, tls_fixture_credentials())
            .expect("CA bundle")
            .test_connection()
            .expect("multiple CA certificates");
    }

    #[test]
    #[ignore = "requires mysql-tls fixture and STATSPG_TEST_MYSQL_TLS_CERT_DIR"]
    fn mysql_tls_rejects_untrusted_ca_and_hostname() {
        for mode in [TlsMode::VerifyCa, TlsMode::VerifyFull] {
            for certificate in [None, Some(tls_fixture_certificate("other-ca.pem"))] {
                let mut definition = tls_fixture_definition(mode.clone(), "localhost");
                definition.tls_root_certificate_pem = certificate;
                let error = MySqlConnector::new(definition, tls_fixture_credentials())
                    .expect("connector")
                    .test_connection()
                    .expect_err("untrusted CA");
                assert_eq!(error.category, DataLinkErrorCategory::Tls);
                assert!(!error.message.contains("stats_reader_local_only"));
                assert!(!error.message.contains("statsplayground-mysql-ca-"));
            }
        }
        let error = MySqlConnector::new(
            tls_fixture_definition(TlsMode::VerifyFull, "127.0.0.1"),
            tls_fixture_credentials(),
        )
        .expect("connector")
        .test_connection()
        .expect_err("wrong hostname");
        assert_eq!(error.category, DataLinkErrorCategory::Tls);
    }

    #[test]
    #[ignore = "requires mysql-tls fixture and STATSPG_TEST_MYSQL_TLS_CERT_DIR"]
    fn mysql_tls_rejects_downgrade_and_preserves_error_categories() {
        for mode in [TlsMode::Required, TlsMode::VerifyCa, TlsMode::VerifyFull] {
            let mut definition = tls_fixture_definition(mode, "localhost");
            definition.port = 53308;
            let error = MySqlConnector::new(definition, tls_fixture_credentials())
                .expect("connector")
                .test_connection()
                .expect_err("no plaintext fallback");
            assert_eq!(error.category, DataLinkErrorCategory::Tls);
        }
        let mut definition = tls_fixture_definition(TlsMode::Disabled, "127.0.0.1");
        let error = MySqlConnector::new(definition.clone(), tls_fixture_credentials())
            .expect("connector")
            .test_connection()
            .expect_err("TLS server forbids plaintext");
        assert_eq!(error.category, DataLinkErrorCategory::Tls);
        definition.port = 53308;
        let mut client = MySqlConnector::new(definition, tls_fixture_credentials())
            .expect("connector")
            .connect()
            .expect("explicit plaintext");
        let (_, cipher): (String, String) = client
            .query_first("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
            .expect("cipher query")
            .expect("cipher");
        assert!(cipher.is_empty());
        let mut credentials = tls_fixture_credentials();
        credentials.password = "must-not-appear-in-errors".into();
        let error = MySqlConnector::new(
            tls_fixture_definition(TlsMode::VerifyFull, "localhost"),
            credentials,
        )
        .expect("connector")
        .test_connection()
        .expect_err("wrong password");
        assert_eq!(error.category, DataLinkErrorCategory::Authentication);
        assert!(!error.message.contains("must-not-appear-in-errors"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let mut definition = tls_fixture_definition(TlsMode::VerifyFull, "127.0.0.1");
        definition.port = listener.local_addr().expect("address").port();
        drop(listener);
        let error = MySqlConnector::new(definition, tls_fixture_credentials())
            .expect("connector")
            .test_connection()
            .expect_err("unreachable server");
        assert_eq!(error.category, DataLinkErrorCategory::Network);
    }

    #[test]
    #[ignore = "requires mysql-tls fixture and STATSPG_TEST_MYSQL_TLS_CERT_DIR"]
    fn mysql_tls_discovers_previews_and_imports() {
        let definition = tls_fixture_definition(TlsMode::VerifyFull, "localhost");
        let credentials = tls_fixture_credentials();
        let connector =
            MySqlConnector::new(definition.clone(), credentials.clone()).expect("connector");
        let objects = connector.list_objects().expect("discover TLS objects");
        assert_eq!(objects.len(), 6);
        let state = crate::state::AppState::new().expect("app state");
        let service = crate::services::io_service::IoService::new(&state);
        for (name, count) in [
            ("customers", 3),
            ("measurements", 100_000),
            ("type_samples", 2),
        ] {
            let object = objects
                .iter()
                .find(|object| object.name == name)
                .expect("object");
            let preview = connector.preview(object, 100).expect("TLS preview");
            assert_eq!(preview.rows.len(), count.min(100));
            let summary = service
                .import_server_snapshot(
                    definition.clone(),
                    credentials.clone(),
                    object.clone(),
                    name,
                    |_, _| {},
                    || false,
                )
                .expect("TLS import");
            assert_eq!(summary.total_rows_written, count);
        }
        let database = state.db.lock().expect("database");
        let datasets = database.list_datasets().expect("datasets");
        assert!(datasets
            .iter()
            .all(|dataset| dataset.source_type == "mysql"));
        let types = datasets
            .iter()
            .find(|dataset| dataset.name == "type_samples")
            .expect("types");
        let values = database
            .query_table(&types.id, 0, 10, Some("id"), Some("asc"))
            .expect("imported values");
        assert_eq!(values.rows[0][2], "18446744073709551615");
        assert_eq!(values.rows[0][3], "123456789012345678901.123456789");
    }

    #[test]
    fn mysql_rejects_invalid_parameters_and_configures_tls_modes() {
        assert!(MySqlConnector::new(definition(), credentials()).is_ok());
        let mut invalid = definition();
        invalid.port = 0;
        assert!(MySqlConnector::new(invalid, credentials()).is_err());
        for mode in [
            TlsMode::Disabled,
            TlsMode::Required,
            TlsMode::VerifyCa,
            TlsMode::VerifyFull,
        ] {
            let mut definition = definition();
            definition.tls_mode = mode.clone();
            let connector = MySqlConnector::new(definition, credentials()).expect("connector");
            let (options, file) = connector.tls_options().expect("TLS options");
            assert!(file.is_none());
            if mode == TlsMode::Disabled {
                assert!(options.is_none());
            } else {
                let options = options.expect("TLS required");
                assert_eq!(options.accept_invalid_certs(), mode == TlsMode::Required);
                assert_eq!(
                    options.skip_domain_validation(),
                    mode != TlsMode::VerifyFull
                );
            }
        }
    }

    #[test]
    fn mysql_rejects_invalid_ca_before_connecting() {
        for pem in [
            String::new(),
            "invalid".into(),
            "x".repeat(256 * 1024 + 1),
            "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----".into(),
        ] {
            let mut definition = definition();
            definition.tls_mode = TlsMode::VerifyFull;
            definition.tls_root_certificate_pem = Some(pem);
            let connector = MySqlConnector::new(definition, credentials()).expect("connector");
            assert_eq!(
                connector.tls_options().err().expect("invalid CA").category,
                DataLinkErrorCategory::Tls
            );
        }
    }
}

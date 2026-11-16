use std::{
    collections::{BTreeMap, HashMap},
    ffi::{c_char, c_void, CStr, CString},
    fs,
    path::{Path, PathBuf},
    ptr,
    sync::Mutex,
};

use duckdb::{ffi, params, Connection};
use serde::Deserialize;

use crate::{
    error::AppError,
    models::data_link::{ConnectorKind, ResolvedDataLinkBinding, SessionSecret},
};

const SUPPORTED_TARGETS: [&str; 5] = [
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
];
const POSTGRES_PROBE_ALIAS: &str = "__datalink_1";
const POSTGRES_PROBE_BINDER_SQL: &str = "SELECT * FROM __datalink_1 LIMIT 0";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerExtension {
    Sqlite,
    PostgreSql,
}

impl ScannerExtension {
    fn resource_name(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::PostgreSql => "postgres",
        }
    }

    fn load_statement(self) -> &'static str {
        match self {
            Self::Sqlite => "LOAD sqlite",
            Self::PostgreSql => "LOAD postgres",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerResourceManifest {
    pub duckdb_version: String,
    pub targets: BTreeMap<String, ScannerTargetArtifacts>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScannerTargetArtifacts {
    pub sqlite: ScannerArtifact,
    pub postgres: ScannerArtifact,
}

#[derive(Debug, Deserialize)]
pub struct ScannerArtifact {
    pub url: String,
    pub sha256: String,
}

impl ScannerResourceManifest {
    pub fn load(path: &Path) -> Result<Self, AppError> {
        let text = fs::read_to_string(path)?;
        let manifest: Self = serde_json::from_str(&text).map_err(|error| {
            AppError::InvalidParam(format!("invalid scanner manifest: {error}"))
        })?;
        let actual_targets = manifest
            .targets
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if actual_targets != SUPPORTED_TARGETS {
            return Err(AppError::InvalidParam(
                "scanner manifest must contain every supported target".into(),
            ));
        }
        for artifacts in manifest.targets.values() {
            for artifact in [&artifacts.sqlite, &artifacts.postgres] {
                if !artifact.url.starts_with("https://")
                    || artifact.sha256.len() != 64
                    || !artifact
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(AppError::InvalidParam(
                        "scanner artifact requires HTTPS and exact lowercase SHA-256".into(),
                    ));
                }
            }
        }
        Ok(manifest)
    }
}

enum BoundBindingValue {
    Text(String),
    Unsigned(u16),
    Path,
}

pub struct NativeBindingPlan {
    pub debug_sql: String,
    pub relation_alias: String,
    scanner_function: Option<&'static str>,
    parameter_kinds: Vec<&'static str>,
    scanner_parameters: Vec<String>,
    values: Vec<BoundBindingValue>,
}

impl NativeBindingPlan {
    pub fn bound_secret_count(&self) -> usize {
        self.values.len()
    }

    pub fn scanner_function(&self) -> &'static str {
        self.scanner_function.unwrap_or("")
    }

    pub fn structured_parameter_kinds(&self) -> Vec<&'static str> {
        self.parameter_kinds.clone()
    }

    pub fn exercises_complete_relation(&self) -> bool {
        self.scanner_function.is_some()
            && !self.relation_alias.is_empty()
            && self.scanner_parameters.len() == 3
            && self.parameter_kinds
                == [
                    "endpoint", "catalog", "schema", "object", "username", "password",
                ]
    }
}

fn validate_relation_alias(alias: &str) -> Result<(), AppError> {
    let suffix = alias.strip_prefix("__datalink_").ok_or_else(|| {
        AppError::InvalidParam("DataLink relation alias is not application-owned".into())
    })?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::InvalidParam(
            "DataLink relation alias is not application-owned".into(),
        ));
    }
    Ok(())
}

pub fn build_native_binding_plan(
    binding: &ResolvedDataLinkBinding,
    secret: &SessionSecret,
) -> Result<NativeBindingPlan, AppError> {
    validate_relation_alias(&binding.relation_alias)?;
    if binding.connector == ConnectorKind::MySql {
        return Err(AppError::InvalidParam(
            "MySQL persistent DataLinks are not supported".into(),
        ));
    }
    let relation_alias = binding.relation_alias.clone();
    match (&binding.connector, secret) {
        (ConnectorKind::PostgreSql, SessionSecret::UsernamePassword { username, password }) => {
            let host = binding.host.clone().ok_or_else(|| {
                AppError::InvalidParam("PostgreSQL DataLink endpoint host is missing".into())
            })?;
            let port = binding.port.ok_or_else(|| {
                AppError::InvalidParam("PostgreSQL DataLink endpoint port is missing".into())
            })?;
            let catalog = binding.catalog.clone().ok_or_else(|| {
                AppError::InvalidParam("PostgreSQL DataLink catalog is missing".into())
            })?;
            let schema = binding.schema.clone().ok_or_else(|| {
                AppError::InvalidParam("PostgreSQL DataLink schema is missing".into())
            })?;
            Ok(NativeBindingPlan {
                debug_sql: "CREATE OR REPLACE TEMPORARY SECRET (TYPE postgres, HOST ?, PORT ?, DATABASE ?, USER ?, PASSWORD ?)".into(),
                relation_alias,
                scanner_function: Some("postgres_scan_pushdown"),
                parameter_kinds: vec![
                    "endpoint", "catalog", "schema", "object", "username", "password",
                ],
                scanner_parameters: vec![String::new(), schema, binding.object.clone()],
                values: vec![
                    BoundBindingValue::Text(host),
                    BoundBindingValue::Unsigned(port),
                    BoundBindingValue::Text(catalog),
                    BoundBindingValue::Text(username.clone()),
                    BoundBindingValue::Text(password.clone()),
                ],
            })
        }
        (ConnectorKind::Sqlite, SessionSecret::SqliteGrant { file_path, .. }) => {
            let path = file_path
                .to_str()
                .ok_or_else(|| {
                    AppError::InvalidParam("SQLite grant path is not valid UTF-8".into())
                })?
                .to_owned();
            Ok(NativeBindingPlan {
                debug_sql: "sqlite_scan(?, ?)".into(),
                relation_alias,
                scanner_function: Some("sqlite_scan"),
                parameter_kinds: vec!["path", "object"],
                scanner_parameters: vec![path, binding.object.clone()],
                values: vec![BoundBindingValue::Path],
            })
        }
        _ => Err(AppError::InvalidParam(
            "DataLink connector does not match the session secret type".into(),
        )),
    }
}

#[derive(Clone)]
struct RegisteredRelation {
    scanner_function: &'static str,
    parameters: Vec<String>,
}

#[derive(Clone)]
struct ReplacementScanInvocation {
    alias: String,
    scanner_function: &'static str,
    parameters: Vec<String>,
}

#[derive(Default)]
struct ReplacementRegistry {
    relations: Mutex<HashMap<String, RegisteredRelation>>,
    invocations: Mutex<Vec<ReplacementScanInvocation>>,
}

unsafe extern "C" fn replacement_scan_callback(
    info: ffi::duckdb_replacement_scan_info,
    table_name: *const c_char,
    data: *mut c_void,
) {
    if info.is_null() || table_name.is_null() || data.is_null() {
        return;
    }
    let registry = unsafe { &*(data as *const ReplacementRegistry) };
    let Ok(table_name) = unsafe { CStr::from_ptr(table_name) }.to_str() else {
        return;
    };
    let Ok(relations) = registry.relations.lock() else {
        return;
    };
    let Some(relation) = relations.get(table_name).cloned() else {
        return;
    };
    drop(relations);
    let Ok(mut invocations) = registry.invocations.lock() else {
        return;
    };
    invocations.push(ReplacementScanInvocation {
        alias: table_name.to_owned(),
        scanner_function: relation.scanner_function,
        parameters: relation.parameters.clone(),
    });
    drop(invocations);
    let Ok(function_name) = CString::new(relation.scanner_function) else {
        return;
    };
    unsafe {
        ffi::duckdb_replacement_scan_set_function_name(info, function_name.as_ptr());
    }
    for parameter in &relation.parameters {
        let Ok(parameter) = CString::new(parameter.as_str()) else {
            return;
        };
        let value = unsafe { ffi::duckdb_create_varchar(parameter.as_ptr()) };
        if value.is_null() {
            return;
        }
        unsafe {
            ffi::duckdb_replacement_scan_add_parameter(info, value);
            ffi::duckdb_destroy_value(&mut { value });
        }
    }
}

unsafe extern "C" fn destroy_replacement_registry(data: *mut c_void) {
    if !data.is_null() {
        drop(unsafe { Box::from_raw(data as *mut ReplacementRegistry) });
    }
}

struct RawDatabase {
    handle: ffi::duckdb_database,
}

impl Drop for RawDatabase {
    fn drop(&mut self) {
        unsafe {
            ffi::duckdb_close(&mut self.handle);
        }
    }
}

fn open_raw_database(
    resource_dir: &Path,
) -> Result<(RawDatabase, *mut ReplacementRegistry), AppError> {
    let resource_dir = resource_dir
        .to_str()
        .ok_or_else(|| AppError::FileIO("packaged scanner directory is not valid UTF-8".into()))?;
    let settings = [
        ("autoinstall_known_extensions", "false"),
        ("autoload_known_extensions", "false"),
        ("enable_external_access", "true"),
        ("extension_directory", resource_dir),
    ];
    unsafe {
        let mut config = ptr::null_mut();
        if ffi::duckdb_create_config(&mut config) != ffi::DuckDBSuccess {
            return Err(AppError::Database("failed to create DuckDB config".into()));
        }
        for (name, value) in settings {
            let name = CString::new(name)
                .map_err(|_| AppError::InvalidParam("invalid DuckDB setting name".into()))?;
            let value = CString::new(value)
                .map_err(|_| AppError::InvalidParam("invalid DuckDB setting value".into()))?;
            if ffi::duckdb_set_config(config, name.as_ptr(), value.as_ptr()) != ffi::DuckDBSuccess {
                ffi::duckdb_destroy_config(&mut config);
                return Err(AppError::Database("failed to configure DuckDB".into()));
            }
        }
        let memory = CString::new(":memory:")
            .map_err(|_| AppError::InvalidParam("invalid in-memory database path".into()))?;
        let mut handle = ptr::null_mut();
        let mut error = ptr::null_mut();
        let state = ffi::duckdb_open_ext(memory.as_ptr(), &mut handle, config, &mut error);
        ffi::duckdb_destroy_config(&mut config);
        if state != ffi::DuckDBSuccess {
            let message = if error.is_null() {
                "failed to open isolated DuckDB database".into()
            } else {
                let message = CStr::from_ptr(error).to_string_lossy().into_owned();
                ffi::duckdb_free(error.cast());
                message
            };
            return Err(AppError::Database(message));
        }
        let registry = Box::into_raw(Box::<ReplacementRegistry>::default());
        ffi::duckdb_add_replacement_scan(
            handle,
            Some(replacement_scan_callback),
            registry.cast(),
            Some(destroy_replacement_registry),
        );
        Ok((RawDatabase { handle }, registry))
    }
}

pub struct DataLinkQueryRuntime {
    connection: Connection,
    database: RawDatabase,
    replacement_registry: *mut ReplacementRegistry,
    resource_dir: PathBuf,
}

pub struct ServerBindingProbeEvidence {
    pub scanner_function: &'static str,
    pub parameter_count: usize,
    pub secret_selector: String,
    pub schema: String,
    pub object: String,
    pub expected_connection_failure: bool,
}

impl DataLinkQueryRuntime {
    pub fn open(resource_dir: &Path) -> Result<Self, AppError> {
        if !resource_dir.is_dir() {
            return Err(AppError::FileIO(
                "packaged DuckDB extension directory is unavailable".into(),
            ));
        }
        let (database, replacement_registry) = open_raw_database(resource_dir)?;
        let connection = unsafe { Connection::open_from_raw(database.handle) }?;
        Ok(Self {
            connection,
            database,
            replacement_registry,
            resource_dir: resource_dir.to_path_buf(),
        })
    }

    pub fn load_extension(&self, extension: ScannerExtension) -> Result<(), AppError> {
        let extension_path = self
            .resource_dir
            .join(format!("{}.duckdb_extension", extension.resource_name()));
        if !extension_path.is_file() {
            return Err(AppError::FileIO(format!(
                "packaged {} scanner is unavailable",
                extension.resource_name()
            )));
        }
        self.connection.execute_batch(extension.load_statement())?;
        Ok(())
    }

    pub fn bind_relation(
        &self,
        binding: &ResolvedDataLinkBinding,
        secret: &SessionSecret,
    ) -> Result<(), AppError> {
        let plan = build_native_binding_plan(binding, secret)?;
        match plan.values.as_slice() {
            [BoundBindingValue::Path] => self.register_replacement_relation(plan),
            [BoundBindingValue::Text(host), BoundBindingValue::Unsigned(port), BoundBindingValue::Text(catalog), BoundBindingValue::Text(username), BoundBindingValue::Text(password)] =>
            {
                self.connection.execute(
                    &plan.debug_sql,
                    params![host, i64::from(*port), catalog, username, password],
                )?;
                self.register_replacement_relation(plan)
            }
            _ => Err(AppError::InvalidParam(
                "invalid structured DataLink binding plan".into(),
            )),
        }
    }

    fn register_replacement_relation(&self, plan: NativeBindingPlan) -> Result<(), AppError> {
        let registry = unsafe { self.replacement_registry.as_ref() }.ok_or_else(|| {
            AppError::Database("DuckDB replacement registry is unavailable".into())
        })?;
        let mut relations = registry.relations.lock().map_err(|_| {
            AppError::Database("DuckDB replacement registry lock is poisoned".into())
        })?;
        relations.insert(
            plan.relation_alias,
            RegisteredRelation {
                scanner_function: plan
                    .scanner_function
                    .ok_or_else(|| AppError::InvalidParam("scanner function is missing".into()))?,
                parameters: plan.scanner_parameters,
            },
        );
        Ok(())
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn probe_server_binding(
        &self,
        binding: &ResolvedDataLinkBinding,
    ) -> Result<ServerBindingProbeEvidence, AppError> {
        if binding.connector != ConnectorKind::PostgreSql {
            return Err(AppError::InvalidParam(
                "server binding probe requires PostgreSQL".into(),
            ));
        }
        if binding.relation_alias != POSTGRES_PROBE_ALIAS {
            return Err(AppError::InvalidParam(
                "PostgreSQL binder probe requires its fixed application-owned alias".into(),
            ));
        }
        let registry = unsafe { self.replacement_registry.as_ref() }.ok_or_else(|| {
            AppError::Database("DuckDB replacement registry is unavailable".into())
        })?;
        registry
            .invocations
            .lock()
            .map_err(|_| {
                AppError::Database("DuckDB replacement invocation lock is poisoned".into())
            })?
            .clear();

        let prepare_error = match self.connection.prepare(POSTGRES_PROBE_BINDER_SQL) {
            Ok(_) => {
                return Err(AppError::InvalidParam(
                    "server scanner unexpectedly bound without a source connection".into(),
                ))
            }
            Err(error) => error.to_string(),
        };
        let normalized_error = prepare_error.to_ascii_lowercase();
        let expected_connection_failure = [
            "connection",
            "connect",
            "network",
            "socket",
            "refused",
            "i/o error",
            "io error",
        ]
        .iter()
        .any(|marker| normalized_error.contains(marker))
            && !["binder error", "catalog error", "no function matches"]
                .iter()
                .any(|marker| normalized_error.contains(marker));
        if !expected_connection_failure {
            return Err(AppError::InvalidParam(format!(
                "server alias did not reach an expected scanner connection failure: {prepare_error}"
            )));
        }

        let invocation = registry
            .invocations
            .lock()
            .map_err(|_| {
                AppError::Database("DuckDB replacement invocation lock is poisoned".into())
            })?
            .iter()
            .find(|invocation| invocation.alias == binding.relation_alias)
            .cloned()
            .ok_or_else(|| {
                AppError::InvalidParam(
                    "DuckDB did not invoke the registered replacement scan".into(),
                )
            })?;
        if invocation.parameters.len() != 3 {
            return Err(AppError::InvalidParam(
                "server scanner replacement has invalid parameter arity".into(),
            ));
        }
        let expected_function = "postgres_scan_pushdown";
        if invocation.scanner_function != expected_function
            || invocation.parameters[0] != ""
            || binding.schema.as_deref() != Some(invocation.parameters[1].as_str())
            || binding.object != invocation.parameters[2]
        {
            return Err(AppError::InvalidParam(
                "server scanner replacement identity does not match the binding".into(),
            ));
        }

        Ok(ServerBindingProbeEvidence {
            scanner_function: invocation.scanner_function,
            parameter_count: invocation.parameters.len(),
            secret_selector: invocation.parameters[0].clone(),
            schema: invocation.parameters[1].clone(),
            object: invocation.parameters[2].clone(),
            expected_connection_failure,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredicateExecutionLocation {
    ScannerLocalPushdown,
    DuckDbFilter,
}

impl PredicateExecutionLocation {
    pub fn probe_label(self) -> &'static str {
        match self {
            Self::ScannerLocalPushdown => "scanner-local pushdown",
            Self::DuckDbFilter => "DuckDB FILTER above scanner",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushdownEvidence {
    pub projection_pushdown: bool,
    pub predicate_execution: PredicateExecutionLocation,
}

struct PlanNode {
    operator: String,
    properties: Vec<String>,
}

fn plan_line_label(line: &str) -> String {
    line.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '│' | '┌' | '┐' | '└' | '┘' | '─' | '├' | '┤' | '┬' | '┴' | '┼'
            )
    })
    .trim()
    .to_ascii_uppercase()
}

fn parse_plan_nodes(plan: &str) -> Result<Vec<PlanNode>, AppError> {
    let lines = plan.lines().collect::<Vec<_>>();
    let mut nodes = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let is_open = line.contains('┌') && line.contains('┐');
        if !is_open {
            index += 1;
            continue;
        }

        let start = index;
        index += 1;
        while index < lines.len() {
            if lines[index].contains('┌') && lines[index].contains('┐') {
                return Err(AppError::InvalidParam(
                    "query plan contains malformed node boundaries".into(),
                ));
            }
            if lines[index].contains('└') && lines[index].contains('┘') {
                break;
            }
            index += 1;
        }
        if index == lines.len() {
            return Err(AppError::InvalidParam(
                "query plan contains malformed node boundaries".into(),
            ));
        }

        let labels = lines[start..=index]
            .iter()
            .map(|node_line| plan_line_label(node_line))
            .filter(|label| !label.is_empty())
            .collect::<Vec<_>>();
        let operator = labels.first().cloned().ok_or_else(|| {
            AppError::InvalidParam("query plan contains a node without an operator".into())
        })?;
        nodes.push(PlanNode {
            operator,
            properties: labels.into_iter().skip(1).collect(),
        });
        index += 1;
    }
    Ok(nodes)
}

pub fn verify_pushdown_evidence(plan: &str) -> Result<PushdownEvidence, AppError> {
    let nodes = parse_plan_nodes(plan)?;
    if nodes.iter().any(|node| {
        matches!(
            node.operator.as_str(),
            "CREATE_TABLE_AS" | "BATCH_INSERT" | "PHYSICAL_INSERT" | "COPY_TO_FILE"
        )
    }) {
        return Err(AppError::InvalidParam(
            "query plan contains complete source-object staging evidence".into(),
        ));
    }

    let scanner_index = nodes.iter().position(|node| {
        matches!(
            node.operator.as_str(),
            "SQLITE_SCAN" | "POSTGRES_SCAN" | "POSTGRES_SCAN_PUSHDOWN"
        )
    });
    let Some(scanner_index) = scanner_index else {
        return Err(AppError::InvalidParam(
            "query plan contains no scanner evidence".into(),
        ));
    };
    let scanner_node = &nodes[scanner_index];
    let has_projection = scanner_node
        .properties
        .iter()
        .any(|property| property == "PROJECTIONS" || property.starts_with("PROJECTIONS:"));
    if !has_projection {
        return Err(AppError::InvalidParam(
            "scanner node contains no projection pushdown evidence".into(),
        ));
    }

    let has_scanner_filter = scanner_node
        .properties
        .iter()
        .any(|property| property == "FILTERS" || property.starts_with("FILTERS:"));
    let predicate_execution = if has_scanner_filter {
        PredicateExecutionLocation::ScannerLocalPushdown
    } else if nodes[..scanner_index]
        .iter()
        .any(|node| node.operator == "FILTER")
    {
        PredicateExecutionLocation::DuckDbFilter
    } else {
        return Err(AppError::InvalidParam(
            "query plan contains no predicate execution evidence".into(),
        ));
    };

    Ok(PushdownEvidence {
        projection_pushdown: true,
        predicate_execution,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use crate::models::data_link::{ConnectorKind, ResolvedDataLinkBinding, SessionSecret};
    use duckdb::params;

    use super::{
        build_native_binding_plan, verify_pushdown_evidence, DataLinkQueryRuntime,
        PredicateExecutionLocation, ScannerExtension,
    };

    fn fixture_binding(connector: ConnectorKind) -> ResolvedDataLinkBinding {
        ResolvedDataLinkBinding {
            data_link_id: "link-1".into(),
            connector,
            host: Some("db.internal".into()),
            port: Some(5432),
            catalog: Some("analytics".into()),
            schema: Some("public".into()),
            object: "orders".into(),
            relation_alias: "__datalink_0".into(),
        }
    }

    fn runtime_with_sqlite_extension(test_name: &str) -> (DataLinkQueryRuntime, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("macos", "x86_64") => "x86_64-apple-darwin",
            ("windows", "aarch64") => "aarch64-pc-windows-msvc",
            ("windows", "x86_64") => "x86_64-pc-windows-msvc",
            ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
            (os, arch) => panic!("unsupported SQLite scanner test host: {os}-{arch}"),
        };
        let resource_dir = root
            .join("resources")
            .join("duckdb_extensions")
            .join(target);
        let fixture_dir = root
            .join("target")
            .join("data-link-query-runtime-tests")
            .join(test_name);
        fs::create_dir_all(&fixture_dir).expect("create SQLite binding fixture directory");
        let runtime = DataLinkQueryRuntime::open(&resource_dir).expect("open test runtime");
        runtime
            .load_extension(ScannerExtension::Sqlite)
            .expect("load packaged SQLite scanner");
        (runtime, fixture_dir)
    }

    fn write_sqlite_orders(path: &PathBuf, amount: i64) {
        if path.exists() {
            fs::remove_file(path).expect("remove prior SQLite fixture");
        }
        let connection = rusqlite::Connection::open(path).expect("open SQLite fixture");
        connection
            .execute_batch(&format!(
                "CREATE TABLE external_orders(order_id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);
                 INSERT INTO external_orders VALUES (1, {amount});"
            ))
            .expect("write SQLite fixture");
    }

    fn sqlite_binding(alias: &str) -> ResolvedDataLinkBinding {
        ResolvedDataLinkBinding {
            data_link_id: alias.into(),
            connector: ConnectorKind::Sqlite,
            host: None,
            port: None,
            catalog: None,
            schema: None,
            object: "external_orders".into(),
            relation_alias: alias.into(),
        }
    }

    fn sqlite_secret(path: PathBuf) -> SessionSecret {
        SessionSecret::SqliteGrant {
            file_path: path,
            fingerprint: "sha256:test".into(),
        }
    }

    #[test]
    fn postgres_bindings_select_distinct_backend_owned_secrets() {
        let (runtime, fixture_dir) = runtime_with_sqlite_extension("postgres-secret-isolation");
        runtime
            .load_extension(ScannerExtension::PostgreSql)
            .expect("load packaged PostgreSQL scanner");
        let mut first = fixture_binding(ConnectorKind::PostgreSql);
        first.relation_alias = "__datalink_1".into();
        first.host = Some("first.internal".into());
        first.catalog = Some("first_catalog".into());
        let mut second = fixture_binding(ConnectorKind::PostgreSql);
        second.relation_alias = "__datalink_2".into();
        second.host = Some("second.internal".into());
        second.catalog = Some("second_catalog".into());

        runtime
            .bind_relation(
                &first,
                &SessionSecret::UsernamePassword {
                    username: "first_reader".into(),
                    password: "<fixture-password>".into(),
                },
            )
            .expect("bind first PostgreSQL relation");
        runtime
            .bind_relation(
                &second,
                &SessionSecret::UsernamePassword {
                    username: "second_reader".into(),
                    password: "<fixture-password>".into(),
                },
            )
            .expect("bind second PostgreSQL relation");

        let registry = unsafe {
            runtime
                .replacement_registry
                .as_ref()
                .expect("replacement registry")
        };
        let relations = registry.relations.lock().expect("relation registry");
        let first_secret = &relations["__datalink_1"].parameters[0];
        let second_secret = &relations["__datalink_2"].parameters[0];
        assert_ne!(first_secret, second_secret);
        assert!(first_secret.starts_with("__statsplayground_pg_secret_"));
        assert!(second_secret.starts_with("__statsplayground_pg_secret_"));
        for user_value in [
            "first", "second", "internal", "catalog", "reader", "password", "public", "orders",
        ] {
            assert!(!first_secret.contains(user_value));
            assert!(!second_secret.contains(user_value));
        }
        drop(relations);
        let secret_count: i64 = runtime
            .connection()
            .query_row(
                "SELECT count(*) FROM duckdb_secrets()
                 WHERE name LIKE '__statsplayground_pg_secret_%'",
                [],
                |row| row.get(0),
            )
            .expect("count distinct PostgreSQL runtime secrets");
        assert_eq!(secret_count, 2);
        fs::remove_dir_all(fixture_dir).expect("remove fixture directory");
    }

    #[test]
    fn postgres_rebind_and_removal_retire_prior_backend_owned_secrets() {
        let (runtime, fixture_dir) = runtime_with_sqlite_extension("postgres-secret-lifecycle");
        runtime
            .load_extension(ScannerExtension::PostgreSql)
            .expect("load packaged PostgreSQL scanner");
        let mut binding = fixture_binding(ConnectorKind::PostgreSql);
        binding.relation_alias = "__datalink_1".into();

        runtime
            .bind_relation(
                &binding,
                &SessionSecret::UsernamePassword {
                    username: "first_reader".into(),
                    password: "<fixture-password>".into(),
                },
            )
            .expect("bind initial PostgreSQL relation");
        let first_secret = {
            let registry = unsafe {
                runtime
                    .replacement_registry
                    .as_ref()
                    .expect("replacement registry")
            };
            registry.relations.lock().expect("relation registry")["__datalink_1"].parameters[0]
                .clone()
        };

        binding.host = Some("replacement.internal".into());
        runtime
            .bind_relation(
                &binding,
                &SessionSecret::UsernamePassword {
                    username: "replacement_reader".into(),
                    password: "<fixture-password>".into(),
                },
            )
            .expect("rebind PostgreSQL relation");
        let current_secret = {
            let registry = unsafe {
                runtime
                    .replacement_registry
                    .as_ref()
                    .expect("replacement registry")
            };
            registry.relations.lock().expect("relation registry")["__datalink_1"].parameters[0]
                .clone()
        };
        assert_ne!(first_secret, current_secret);
        let secret_count: i64 = runtime
            .connection()
            .query_row(
                "SELECT count(*) FROM duckdb_secrets()
                 WHERE name LIKE '__statsplayground_pg_secret_%'",
                [],
                |row| row.get(0),
            )
            .expect("count PostgreSQL runtime secrets after rebind");
        assert_eq!(secret_count, 1);

        runtime
            .unbind_relation("__datalink_1")
            .expect("remove PostgreSQL relation");
        let secret_count: i64 = runtime
            .connection()
            .query_row(
                "SELECT count(*) FROM duckdb_secrets()
                 WHERE name LIKE '__statsplayground_pg_secret_%'",
                [],
                |row| row.get(0),
            )
            .expect("count PostgreSQL runtime secrets after removal");
        assert_eq!(secret_count, 0);

        runtime
            .bind_relation(
                &binding,
                &SessionSecret::UsernamePassword {
                    username: "third_reader".into(),
                    password: "<fixture-password>".into(),
                },
            )
            .expect("bind PostgreSQL relation after removal");
        let final_secret = {
            let registry = unsafe {
                runtime
                    .replacement_registry
                    .as_ref()
                    .expect("replacement registry")
            };
            registry.relations.lock().expect("relation registry")
                ["__datalink_1"]
                .parameters[0]
                .clone()
        };
        assert_ne!(final_secret, first_secret);
        assert_ne!(final_secret, current_secret);
        runtime
            .unbind_relation("__datalink_1")
            .expect("remove rebound PostgreSQL relation");
        let secret_count: i64 = runtime
            .connection()
            .query_row(
                "SELECT count(*) FROM duckdb_secrets()
                 WHERE name LIKE '__statsplayground_pg_secret_%'",
                [],
                |row| row.get(0),
            )
            .expect("count PostgreSQL runtime secrets after final removal");
        assert_eq!(secret_count, 0);
        fs::remove_dir_all(fixture_dir).expect("remove fixture directory");
    }

    #[test]
    fn sqlite_binding_keeps_project_table_with_same_source_object_name_distinct() {
        let (runtime, fixture_dir) = runtime_with_sqlite_extension("project-name-collision");
        let source_path = fixture_dir.join("source.sqlite");
        write_sqlite_orders(&source_path, 250);
        runtime
            .connection()
            .execute_batch(
                "CREATE TABLE external_orders(order_id INTEGER, amount INTEGER);
                     INSERT INTO external_orders VALUES (1, 25);",
            )
            .expect("create colliding project table");

        runtime
            .bind_relation(&sqlite_binding("__datalink_0"), &sqlite_secret(source_path))
            .expect("bind selected SQLite relation");

        let source_amount: i64 = runtime
            .connection()
            .query_row("SELECT amount FROM __datalink_0", [], |row| row.get(0))
            .expect("query scanner alias");
        let project_amount: i64 = runtime
            .connection()
            .query_row("SELECT amount FROM external_orders", [], |row| row.get(0))
            .expect("query project table");
        assert_eq!(source_amount, 250);
        assert_eq!(project_amount, 25);
        fs::remove_dir_all(fixture_dir).expect("remove fixture directory");
    }

    #[test]
    fn sqlite_bindings_with_same_source_object_name_keep_distinct_aliases() {
        let (runtime, fixture_dir) = runtime_with_sqlite_extension("two-link-name-collision");
        let first_path = fixture_dir.join("first.sqlite");
        let second_path = fixture_dir.join("second.sqlite");
        write_sqlite_orders(&first_path, 250);
        write_sqlite_orders(&second_path, 500);

        runtime
            .bind_relation(&sqlite_binding("__datalink_0"), &sqlite_secret(first_path))
            .expect("bind first SQLite relation");
        runtime
            .bind_relation(&sqlite_binding("__datalink_1"), &sqlite_secret(second_path))
            .expect("bind second SQLite relation");

        let amounts: (i64, i64) = runtime
            .connection()
            .query_row(
                "SELECT first.amount, second.amount
                     FROM __datalink_0 first
                     CROSS JOIN __datalink_1 second",
                params![],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query distinct scanner aliases");
        assert_eq!(amounts, (250, 500));
        fs::remove_dir_all(fixture_dir).expect("remove fixture directory");
    }

    #[test]
    fn binding_contract_keeps_server_secrets_out_of_sql_text() {
        let binding = fixture_binding(ConnectorKind::PostgreSql);
        let secret = SessionSecret::UsernamePassword {
            username: "reader".into(),
            password: "<fixture-password>".into(),
        };

        let plan = build_native_binding_plan(&binding, &secret)
            .expect("build PostgreSQL native binding plan");

        assert!(!plan.debug_sql.contains("reader"));
        assert!(!plan.debug_sql.contains("not-serialized"));
        assert!(!plan.debug_sql.contains("connection_string"));
        assert_eq!(plan.relation_alias, "__datalink_0");
        assert_eq!(plan.scanner_function(), "postgres_scan_pushdown");
        assert_eq!(
            plan.structured_parameter_kinds(),
            ["endpoint", "catalog", "schema", "object", "username", "password"]
        );
        assert!(plan.exercises_complete_relation());
    }

    #[test]
    fn persistent_datalink_binding_rejects_deferred_mysql_connector() {
        let mut binding = fixture_binding(ConnectorKind::MySql);
        binding.port = Some(3306);
        let secret = SessionSecret::UsernamePassword {
            username: "reader".into(),
            password: "<fixture-password>".into(),
        };

        let error = match build_native_binding_plan(&binding, &secret) {
            Ok(_) => panic!("deferred MySQL connector produced a persistent DataLink plan"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("not supported"));
    }

    #[test]
    fn binding_contract_keeps_sqlite_path_out_of_sql_text() {
        let binding = fixture_binding(ConnectorKind::Sqlite);
        let secret = SessionSecret::SqliteGrant {
            file_path: PathBuf::from("/private/source.sqlite"),
            fingerprint: "sha256:fixture".into(),
        };

        let plan =
            build_native_binding_plan(&binding, &secret).expect("build SQLite native binding plan");

        assert!(!plan.debug_sql.contains("/private/source.sqlite"));
        assert!(!plan.debug_sql.contains("sha256:fixture"));
        assert_eq!(plan.bound_secret_count(), 1);
    }

    #[test]
    fn binding_contract_rejects_connector_secret_mismatch() {
        let binding = fixture_binding(ConnectorKind::PostgreSql);
        let secret = SessionSecret::SqliteGrant {
            file_path: PathBuf::from("source.sqlite"),
            fingerprint: "sha256:fixture".into(),
        };

        let error = match build_native_binding_plan(&binding, &secret) {
            Ok(_) => panic!("accepted SQLite grant for PostgreSQL"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn pushdown_classifies_scanner_local_predicate_execution() {
        let plan = "┌──────── SQLITE_SCAN ────────┐\n│ Projections: order_id      │\n│ Filters: amount>100        │\n└────────────────────────────┘";
        let evidence = verify_pushdown_evidence(plan).expect("accept scanner pushdown evidence");

        assert!(evidence.projection_pushdown);
        assert_eq!(
            evidence.predicate_execution,
            PredicateExecutionLocation::ScannerLocalPushdown
        );
    }

    #[test]
    fn separate_filter_is_duckdb_side_not_source_predicate_pushdown() {
        let plan = "┌──────── PROJECTION ─────────┐
│ order_id                   │
└────────────────────────────┘
┌────────── FILTER ──────────┐
│ amount > 100               │
└────────────────────────────┘
┌──────── SQLITE_SCAN ────────┐
│ Projections: order_id       │
└─────────────────────────────┘";

        let evidence =
            verify_pushdown_evidence(plan).expect("accept supported DuckDB filter above scanner");

        assert!(evidence.projection_pushdown);
        assert_eq!(
            evidence.predicate_execution,
            PredicateExecutionLocation::DuckDbFilter
        );
        assert_ne!(
            evidence.predicate_execution,
            PredicateExecutionLocation::ScannerLocalPushdown
        );
    }

    #[test]
    fn pushdown_rejects_plan_without_direct_scanner_access() {
        let error = verify_pushdown_evidence(
            "┌────────── FILTER ──────────┐
│ amount > 100               │
└────────────────────────────┘
┌────────── SEQ_SCAN ────────┐
│ Projections: order_id      │
└────────────────────────────┘",
        )
        .expect_err("reject plan without scanner");

        assert!(error.to_string().contains("no scanner"));
    }

    #[test]
    fn pushdown_rejects_projection_only_above_scanner() {
        let plan = "┌──────── PROJECTION ─────────┐
│ order_id                   │
└────────────────────────────┘
┌────────── FILTER ──────────┐
│ amount > 100               │
└────────────────────────────┘
┌──────── SQLITE_SCAN ────────┐
│ Table: external_orders      │
└─────────────────────────────┘";

        let error =
            verify_pushdown_evidence(plan).expect_err("reject non-scanner-local projection");

        assert!(error.to_string().contains("projection pushdown"));
    }

    #[test]
    fn pushdown_rejects_complete_source_object_staging() {
        let plan = "┌────── CREATE_TABLE_AS ──────┐
│ staged_external_orders     │
└────────────────────────────┘
┌──────── SQLITE_SCAN ────────┐
│ Table: external_orders      │
│ Projections: order_id       │
│ Filters: amount > 100       │
└─────────────────────────────┘";

        let error =
            verify_pushdown_evidence(plan).expect_err("reject complete source-object staging");

        assert!(error.to_string().contains("staging"));
    }

    #[test]
    fn pushdown_rejects_missing_predicate_execution_evidence() {
        let plan = "┌──────── SQLITE_SCAN ────────┐
│ Table: external_orders      │
│ Projections: order_id       │
└─────────────────────────────┘";

        let error = verify_pushdown_evidence(plan)
            .expect_err("reject plan without predicate execution evidence");

        assert!(error.to_string().contains("predicate execution"));
    }

    #[test]
    fn pushdown_rejects_filter_below_scanner() {
        let plan = "┌──────── SQLITE_SCAN ────────┐
│ Table: external_orders      │
│ Projections: order_id       │
└─────────────────────────────┘
┌────────── FILTER ──────────┐
│ amount > 100               │
└────────────────────────────┘";

        let error = verify_pushdown_evidence(plan).expect_err("reject filter below scanner");

        assert!(error.to_string().contains("predicate execution"));
    }

    #[test]
    fn pushdown_does_not_treat_filter_identifiers_as_predicate_evidence() {
        let plan = "┌──────── SQLITE_SCAN ────────┐
│ Table: filtered_orders      │
│ Projections: filter_status  │
└─────────────────────────────┘";

        let error = verify_pushdown_evidence(plan)
            .expect_err("reject identifier substrings as predicate evidence");

        assert!(error.to_string().contains("predicate execution"));
    }

    #[test]
    fn pushdown_fails_closed_when_scanner_boundary_is_unterminated() {
        let plan = "┌──────── SQLITE_SCAN ────────┐
│ Table: external_orders      │
│ Projections: order_id       │
┌────────── FILTER ──────────┐
│ amount > 100               │
└────────────────────────────┘";

        let error = verify_pushdown_evidence(plan).expect_err("reject malformed scanner boundary");

        assert!(error.to_string().contains("malformed"));
    }
}

use std::{
    fs,
    path::{Path, PathBuf},
};

use duckdb::params;
use stats_playground_lib::datalink_scanner_probe_api::{
    build_native_binding_plan, verify_pushdown_evidence, ConnectorKind, DataLinkQueryRuntime,
    ResolvedDataLinkBinding, ScannerExtension, ScannerResourceManifest, SessionSecret,
};

fn current_target() -> Result<&'static str, Box<dyn std::error::Error>> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("windows", "aarch64") => Ok("aarch64-pc-windows-msvc"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        (os, arch) => Err(format!("unsupported probe host: {os}-{arch}").into()),
    }
}

fn sqlite_binding(alias: &str) -> ResolvedDataLinkBinding {
    ResolvedDataLinkBinding {
        data_link_id: format!("{alias}-probe"),
        connector: ConnectorKind::Sqlite,
        host: None,
        port: None,
        catalog: None,
        schema: None,
        object: "external_orders".into(),
        relation_alias: alias.into(),
    }
}

fn postgres_binding(alias: &str) -> ResolvedDataLinkBinding {
    ResolvedDataLinkBinding {
        data_link_id: format!("{alias}-probe"),
        connector: ConnectorKind::PostgreSql,
        host: Some("127.0.0.1".into()),
        port: Some(5432),
        catalog: Some("probe".into()),
        schema: Some("public".into()),
        object: "orders".into(),
        relation_alias: alias.into(),
    }
}

fn build_sqlite_fixture(path: &Path, amounts: &[i64]) -> Result<(), Box<dyn std::error::Error>> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    let connection = rusqlite::Connection::open(path)?;
    connection.execute_batch(
        "CREATE TABLE external_orders(order_id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);",
    )?;
    for (index, amount) in amounts.iter().enumerate() {
        connection.execute(
            "INSERT INTO external_orders VALUES (?, ?)",
            rusqlite::params![index as i64 + 1, amount],
        )?;
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target = current_target()?;
    let manifest = ScannerResourceManifest::load(&root.join("duckdb-extensions.json"))?;
    if manifest.duckdb_version != "1.5.5" || manifest.targets.len() != 5 {
        return Err("scanner manifest does not prove every supported target".into());
    }

    let resource_dir = root
        .join("resources")
        .join("duckdb_extensions")
        .join(target);
    let runtime = DataLinkQueryRuntime::open(&resource_dir)?;
    for extension in [ScannerExtension::Sqlite, ScannerExtension::PostgreSql] {
        runtime.load_extension(extension)?;
    }
    println!("PASS offline scanner load: SQLite and PostgreSQL packaged resources");

    let probe_dir = root.join("target").join("datalink-scanner-probe");
    fs::create_dir_all(&probe_dir)?;
    let sqlite_path = probe_dir.join("source.sqlite");
    build_sqlite_fixture(&sqlite_path, &[25, 250, 500])?;
    let second_sqlite_path = probe_dir.join("second-source.sqlite");
    build_sqlite_fixture(&second_sqlite_path, &[750])?;

    let sqlite_secret = SessionSecret::SqliteGrant {
        file_path: sqlite_path.clone(),
        fingerprint: "probe-fingerprint".into(),
    };
    runtime.connection().execute_batch(
        "CREATE TABLE external_orders(order_id INTEGER NOT NULL, amount INTEGER NOT NULL);
         INSERT INTO external_orders VALUES (1, 5);",
    )?;
    runtime.bind_relation(&sqlite_binding("__datalink_0"), &sqlite_secret)?;
    runtime.bind_relation(
        &sqlite_binding("__datalink_2"),
        &SessionSecret::SqliteGrant {
            file_path: second_sqlite_path.clone(),
            fingerprint: "second-probe-fingerprint".into(),
        },
    )?;
    let collision_amounts: (i64, i64, i64) = runtime.connection().query_row(
        "SELECT project.amount, first_link.amount, second_link.amount
         FROM external_orders project
         JOIN __datalink_0 first_link USING (order_id)
         JOIN __datalink_2 second_link USING (order_id)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if collision_amounts != (5, 25, 750) {
        return Err("SQLite alias collision isolation returned the wrong rows".into());
    }
    println!(
        "PASS SQLite alias isolation: project table and two DataLinks share one source object name"
    );

    runtime.connection().execute_batch(
        "CREATE TABLE project_rows(order_id INTEGER NOT NULL, project_label VARCHAR NOT NULL);
         INSERT INTO project_rows VALUES (2, 'project');",
    )?;
    let joined: String = runtime.connection().query_row(
        "SELECT project_label
         FROM project_rows
         JOIN __datalink_0 USING (order_id)
         WHERE __datalink_0.amount > ?",
        params![100],
        |row| row.get(0),
    )?;
    if joined != "project" {
        return Err("mixed project/DataLink join returned the wrong row".into());
    }
    println!("PASS mixed project/DataLink join: one scanner-backed row");

    let credentials = SessionSecret::UsernamePassword {
        username: "probe-reader".into(),
        password: "<fixture-password>".into(),
    };
    let binding = postgres_binding("__datalink_1");
    let plan = build_native_binding_plan(&binding, &credentials)?;
    if plan.debug_sql.contains("probe-reader")
        || plan.debug_sql.contains("probe-password")
        || plan.bound_secret_count() != 5
        || !plan.exercises_complete_relation()
    {
        return Err("PostgreSQL relation escaped complete structured binding".into());
    }
    runtime.bind_relation(&binding, &credentials)?;
    let evidence = runtime.probe_server_binding(&binding)?;
    if evidence.scanner_function != plan.scanner_function()
        || evidence.parameter_count != 3
        || evidence.secret_selector != ""
        || evidence.schema != "public"
        || evidence.object != "orders"
        || !evidence.expected_connection_failure
    {
        return Err("PostgreSQL alias did not reach the expected scanner binder".into());
    }
    println!(
        "PASS PostgreSQL alias binder resolution: scanner/arity/secret/schema/object validated before expected connection failure"
    );

    let mut statement = runtime.connection().prepare(
        "EXPLAIN SELECT external.order_id
         FROM __datalink_0 AS external
         WHERE external.amount > 100",
    )?;
    let rows = statement.query_map([], |row: &duckdb::Row<'_>| -> duckdb::Result<String> {
        let key: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok(format!("{key}\n{value}"))
    })?;
    let mut explain = String::new();
    for row in rows {
        explain.push_str(&row?);
        explain.push('\n');
    }
    let evidence = verify_pushdown_evidence(&explain)?;
    if !evidence.projection_pushdown {
        return Err("SQLite scanner plan has no scanner-local projection evidence".into());
    }
    println!("PASS projection pushdown: requested columns are inside the SQLite scanner node");
    println!(
        "PASS predicate execution location: {}",
        evidence.predicate_execution.probe_label()
    );

    fs::remove_file(sqlite_path)?;
    fs::remove_file(second_sqlite_path)?;
    fs::remove_dir(probe_dir)?;
    Ok(())
}

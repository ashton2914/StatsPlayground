use std::io::Read;
use std::path::Path;

use duckdb::{params, Connection};

use crate::error::AppError;
use crate::models::project_persistence::ProjectHeader;

pub const FORMAT_VERSION: &str = "5.0.0";
const CAPABILITY: u32 = 1;
const APPLICATION_ID: &str = "statsplayground.project";

#[derive(Debug, PartialEq, Eq)]
pub enum ProjectFormat {
    DuckDb,
    LegacyZip,
    LegacyJson,
}

pub fn detect_project_format(path: &Path) -> Result<ProjectFormat, AppError> {
    let mut header = [0_u8; 4096];
    let size = std::fs::File::open(path)?.read(&mut header)?;
    let bytes = &header[..size];
    if size >= 12 && &bytes[8..12] == b"DUCK" {
        return Ok(ProjectFormat::DuckDb);
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Ok(ProjectFormat::LegacyZip);
    }
    let json = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if json.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{') {
        return Ok(ProjectFormat::LegacyJson);
    }
    Err(AppError::InvalidParam("project_format_unrecognized".into()))
}

pub fn physical_storage_version(path: &Path) -> Result<String, AppError> {
    let mut header = [0_u8; 20];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    if &header[8..12] != b"DUCK" {
        return Err(AppError::InvalidParam("project_format_unrecognized".into()));
    }
    let mut version = [0_u8; 8];
    version.copy_from_slice(&header[12..20]);
    Ok(u64::from_le_bytes(version).to_string())
}

pub fn create_header(conn: &Connection, storage_version: &str) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE _project_header (
            singleton BOOLEAN PRIMARY KEY CHECK(singleton),
            application_id VARCHAR NOT NULL,
            project_id VARCHAR NOT NULL,
            format_version VARCHAR NOT NULL,
            minimum_reader UINTEGER NOT NULL,
            minimum_writer UINTEGER NOT NULL,
            committed_revision UBIGINT NOT NULL,
            created_at VARCHAR NOT NULL,
            engine_version VARCHAR NOT NULL,
            storage_version VARCHAR NOT NULL
        )",
    )?;
    conn.execute_batch(
        "CREATE TABLE _project_commit_receipts (
            project_id VARCHAR NOT NULL, operation_id VARCHAR NOT NULL,
            request_digest VARCHAR NOT NULL, result_json VARCHAR NOT NULL,
            PRIMARY KEY(project_id, operation_id)
        );
        CREATE TABLE _project_cancelled_operations (
            project_id VARCHAR NOT NULL, operation_id VARCHAR NOT NULL,
            PRIMARY KEY(project_id, operation_id)
        );
        CREATE TABLE _project_staging (
            operation_id VARCHAR NOT NULL, table_id VARCHAR PRIMARY KEY
        );
        CREATE TABLE _project_output_events (
            id VARCHAR PRIMARY KEY, dataset_id VARCHAR NOT NULL,
            operation VARCHAR NOT NULL, generation UBIGINT NOT NULL
        );
        CREATE TABLE _project_cell_history_columns (
            change_set_id VARCHAR NOT NULL, ordinal UINTEGER NOT NULL,
            column_id VARCHAR NOT NULL, column_name VARCHAR NOT NULL,
            snapshot_table VARCHAR NOT NULL,
            PRIMARY KEY(change_set_id, ordinal)
        );
        CREATE TABLE _project_documents (
            id VARCHAR PRIMARY KEY, revision UBIGINT NOT NULL,
            schema_version UINTEGER NOT NULL, body_json VARCHAR NOT NULL
        );
        CREATE TABLE _project_directory (
            id VARCHAR PRIMARY KEY, kind VARCHAR NOT NULL, name VARCHAR NOT NULL,
            folder VARCHAR NOT NULL, revision UBIGINT NOT NULL,
            dependencies_json VARCHAR NOT NULL
        );
        CREATE TABLE _project_document_subtypes (
            id VARCHAR PRIMARY KEY, analysis_kind VARCHAR NOT NULL
        );
        CREATE INDEX _project_directory_order ON _project_directory(kind, id);
        CREATE TABLE _project_settings (
            key VARCHAR PRIMARY KEY, revision UBIGINT NOT NULL, value_json VARCHAR NOT NULL
        )",
    )?;
    conn.execute(
        "INSERT INTO _project_header VALUES
         (TRUE, ?, ?, ?, ?, ?, 0, CAST(current_timestamp AS VARCHAR), ?, ?)",
        params![APPLICATION_ID, uuid::Uuid::new_v4().to_string(), FORMAT_VERSION,
            CAPABILITY, CAPABILITY, conn.version()?, storage_version],
    )?;
    Ok(())
}

/// No DDL or data backfills are allowed when validating an existing project.
pub fn read_header(conn: &Connection, writable: bool) -> Result<ProjectHeader, AppError> {
    let count: i64 = conn.query_row("SELECT count(*) FROM _project_header", [], |r| r.get(0))
        .map_err(|_| AppError::InvalidParam("project_header_missing".into()))?;
    if count != 1 {
        return Err(AppError::InvalidParam("project_header_invalid".into()));
    }
    let (application, header) = conn.query_row(
        "SELECT application_id, project_id, format_version, minimum_reader, minimum_writer,
                committed_revision, created_at, engine_version, storage_version
         FROM _project_header WHERE singleton = TRUE",
        [],
        |r| Ok((r.get::<_, String>(0)?, ProjectHeader {
            project_id: r.get(1)?, format_version: r.get(2)?, minimum_reader: r.get(3)?,
            minimum_writer: r.get(4)?, committed_revision: r.get(5)?, created_at: r.get(6)?,
            engine_version: r.get(7)?, storage_version: r.get(8)?,
        })),
    )?;
    if application != APPLICATION_ID || uuid::Uuid::parse_str(&header.project_id).is_err() {
        return Err(AppError::InvalidParam("project_header_invalid".into()));
    }
    if header.format_version != FORMAT_VERSION || header.minimum_reader > CAPABILITY
        || (writable && header.minimum_writer > CAPABILITY) {
        return Err(AppError::InvalidParam("project_version_unsupported".into()));
    }
    Ok(header)
}

pub fn require_v5_capability() -> Result<(), AppError> {
    if cfg!(feature = "project-v5") {
        Ok(())
    } else {
        Err(AppError::InvalidParam("project_v5_not_enabled".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_database_format_detection_is_bounded_and_capability_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample");
        std::fs::write(&path, b"PK\x03\x04payload").unwrap();
        assert_eq!(detect_project_format(&path).unwrap(), ProjectFormat::LegacyZip);
        std::fs::write(&path, b" \n {\"name\":\"old\"}").unwrap();
        assert_eq!(detect_project_format(&path).unwrap(), ProjectFormat::LegacyJson);
        std::fs::write(&path, b"not a project").unwrap();
        assert!(detect_project_format(&path).is_err());
        assert_eq!(require_v5_capability().is_ok(), cfg!(feature = "project-v5"));
    }
}

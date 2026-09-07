use crate::connectors::{DataConnector, PostgresConnector, ServerConnector, SqliteConnector};
use crate::error::AppError;
use crate::models::data_link::{
    ConnectionCredentials, ConnectionDefinition, DataLinkError, PreviewResult, SourceColumn,
    SourceObject, SourceObjectRef,
};

pub struct DataLinkService;

impl DataLinkService {
    pub fn test_server_connection(definition: ConnectionDefinition, credentials: ConnectionCredentials) -> Result<(), DataLinkError> {
        ServerConnector::new(definition, credentials)?.test_connection()
    }

    pub fn list_server_objects(definition: ConnectionDefinition, credentials: ConnectionCredentials) -> Result<Vec<SourceObjectRef>, DataLinkError> {
        ServerConnector::new(definition, credentials)?.list_objects()
    }

    pub fn get_server_schema(definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef) -> Result<Vec<SourceColumn>, DataLinkError> {
        ServerConnector::new(definition, credentials)?.schema(&object)
    }

    pub fn preview_server_object(definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, limit: usize) -> Result<PreviewResult, DataLinkError> {
        ServerConnector::new(definition, credentials)?.preview(&object, limit)
    }

    pub fn test_postgres_connection(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<(), DataLinkError> {
        PostgresConnector::new(definition, credentials)?.test_connection()
    }

    pub fn list_postgres_objects(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<Vec<SourceObjectRef>, DataLinkError> {
        PostgresConnector::new(definition, credentials)?.list_objects()
    }

    pub fn get_postgres_schema(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
        object: SourceObjectRef,
    ) -> Result<Vec<SourceColumn>, DataLinkError> {
        PostgresConnector::new(definition, credentials)?.schema(&object)
    }

    pub fn preview_postgres_object(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
        object: SourceObjectRef,
        limit: usize,
    ) -> Result<PreviewResult, DataLinkError> {
        PostgresConnector::new(definition, credentials)?.preview(&object, limit)
    }

    pub fn list_sqlite_objects(file_path: &str) -> Result<Vec<SourceObject>, AppError> {
        let connector = SqliteConnector::new(file_path);
        connector.test_connection()?;
        connector.list_objects()
    }

    pub fn preview_sqlite_object(
        file_path: &str,
        object_name: &str,
        limit: usize,
    ) -> Result<PreviewResult, AppError> {
        SqliteConnector::new(file_path).preview(object_name, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!("datalink-{}.sqlite", uuid::Uuid::new_v4()))
    }

    #[test]
    fn discovers_tables_views_and_columns() {
        let path = fixture_path();
        let connection = rusqlite::Connection::open(&path).expect("create fixture");
        connection
            .execute_batch(
                "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
                 CREATE VIEW people_view AS SELECT name FROM people;",
            )
            .expect("create objects");
        drop(connection);

        let objects = DataLinkService::list_sqlite_objects(path.to_str().expect("fixture path"))
            .expect("discover objects");

        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].name, "people");
        assert!(objects[0].columns[0].primary_key);
        assert!(!objects[0].columns[1].nullable);
        assert_eq!(objects[1].object_type, "view");
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn previews_with_a_hard_limit_and_safe_blob_representation() {
        let path = fixture_path();
        let connection = rusqlite::Connection::open(&path).expect("create fixture");
        connection
            .execute("CREATE TABLE samples (value TEXT, payload BLOB)", [])
            .expect("create table");
        for index in 0..105 {
            connection
                .execute(
                    "INSERT INTO samples VALUES (?1, ?2)",
                    rusqlite::params![format!("row-{index}"), vec![1_u8, 2, 3]],
                )
                .expect("insert row");
        }
        drop(connection);

        let preview = DataLinkService::preview_sqlite_object(
            path.to_str().expect("fixture path"),
            "samples",
            500,
        )
        .expect("preview object");

        assert_eq!(preview.rows.len(), 100);
        assert!(preview.truncated);
        assert_eq!(preview.rows[0][1], "<BLOB: 3 bytes>");
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn empty_database_has_no_source_objects() {
        let path = fixture_path();
        let sqlite = rusqlite::Connection::open(&path).expect("create empty SQLite fixture");
        drop(sqlite);

        let objects = DataLinkService::list_sqlite_objects(path.to_str().expect("fixture path"))
            .expect("list empty database");

        assert!(objects.is_empty());
        std::fs::remove_file(path).expect("remove fixture");
    }
}

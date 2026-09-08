use std::path::Path;

use rusqlite::types::ValueRef;

use crate::connectors::{ConnectorValue, DataConnector};
use crate::error::AppError;
use crate::models::data_link::{PreviewResult, SourceColumn, SourceObject};

const MAX_PREVIEW_ROWS: usize = 100;

pub struct SqliteConnector<'a> {
    file_path: &'a str,
}

impl<'a> SqliteConnector<'a> {
    pub fn new(file_path: &'a str) -> Self {
        Self { file_path }
    }

    fn open(&self) -> Result<rusqlite::Connection, AppError> {
        if self.file_path.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "SQLite path is required".to_string(),
            ));
        }
        let path = Path::new(self.file_path);
        let canonical_path = path.canonicalize().map_err(|_| {
            AppError::FileIO("Selected SQLite file does not exist or is not readable".to_string())
        })?;
        if !canonical_path.is_file() {
            return Err(AppError::FileIO(
                "Selected SQLite path is not a file".to_string(),
            ));
        }
        Ok(rusqlite::Connection::open_with_flags(
            canonical_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    }

    fn read_columns(
        connection: &rusqlite::Connection,
        object_name: &str,
    ) -> Result<Vec<SourceColumn>, AppError> {
        let quoted_name = Self::quote_identifier(object_name);
        let mut statement = connection.prepare(&format!("PRAGMA table_info({quoted_name})"))?;
        let columns = statement
            .query_map([], |row| {
                Ok(SourceColumn {
                    name: row.get(1)?,
                    source_type: row.get(2)?,
                    nullable: row.get::<_, i32>(3)? == 0,
                    primary_key: row.get::<_, i32>(5)? > 0,
                    precision: None,
                    scale: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(columns)
    }

    fn object_exists(
        connection: &rusqlite::Connection,
        object_name: &str,
    ) -> Result<bool, AppError> {
        Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name = ?1 AND name NOT LIKE 'sqlite_%')",
            [object_name],
            |row| row.get(0),
        )?)
    }

    fn quote_identifier(identifier: &str) -> String {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }

    fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
        match value {
            ValueRef::Null => serde_json::Value::Null,
            ValueRef::Integer(value) => value.into(),
            ValueRef::Real(value) => value.into(),
            ValueRef::Text(value) => String::from_utf8_lossy(value).into_owned().into(),
            ValueRef::Blob(value) => format!("<BLOB: {} bytes>", value.len()).into(),
        }
    }
}

impl DataConnector for SqliteConnector<'_> {
    fn test_connection(&self) -> Result<(), AppError> {
        self.open().map(drop)
    }

    fn list_objects(&self) -> Result<Vec<SourceObject>, AppError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let entries = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        entries
            .into_iter()
            .map(|(name, object_type)| {
                Ok(SourceObject {
                    columns: Self::read_columns(&connection, &name)?,
                    name,
                    object_type,
                })
            })
            .collect()
    }

    fn schema(&self, object_name: &str) -> Result<Vec<SourceColumn>, AppError> {
        let connection = self.open()?;
        if !Self::object_exists(&connection, object_name)? {
            return Err(AppError::InvalidParam(format!(
                "SQLite object not found: {object_name}"
            )));
        }
        Self::read_columns(&connection, object_name)
    }

    fn preview(&self, object_name: &str, limit: usize) -> Result<PreviewResult, AppError> {
        let connection = self.open()?;
        if !Self::object_exists(&connection, object_name)? {
            return Err(AppError::InvalidParam(format!(
                "SQLite object not found: {object_name}"
            )));
        }

        let columns = Self::read_columns(&connection, object_name)?;
        let preview_limit = limit.clamp(1, MAX_PREVIEW_ROWS);
        let query = format!(
            "SELECT * FROM {} LIMIT ?1",
            Self::quote_identifier(object_name)
        );
        let mut statement = connection.prepare(&query)?;
        let column_count = statement.column_count();
        let mut rows = statement.query([preview_limit + 1])?;
        let mut result_rows = Vec::new();
        while let Some(row) = rows.next()? {
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                values.push(Self::value_to_json(row.get_ref(index)?));
            }
            result_rows.push(values);
        }

        let truncated = result_rows.len() > preview_limit;
        result_rows.truncate(preview_limit);
        Ok(PreviewResult {
            object_name: object_name.to_string(),
            columns,
            rows: result_rows,
            truncated,
        })
    }

    fn row_count(&self, object_name: &str) -> Result<usize, AppError> {
        let connection = self.open()?;
        if !Self::object_exists(&connection, object_name)? {
            return Err(AppError::InvalidParam(format!(
                "SQLite object not found: {object_name}"
            )));
        }
        let count: i64 = connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM {}",
                Self::quote_identifier(object_name)
            ),
            [],
            |row| row.get(0),
        )?;
        usize::try_from(count)
            .map_err(|_| AppError::InvalidParam(format!("SQLite row count is invalid: {count}")))
    }

    fn read_rows(
        &self,
        object_name: &str,
        visitor: &mut dyn FnMut(usize, Vec<ConnectorValue>) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let connection = self.open()?;
        if !Self::object_exists(&connection, object_name)? {
            return Err(AppError::InvalidParam(format!(
                "SQLite object not found: {object_name}"
            )));
        }
        let columns = Self::read_columns(&connection, object_name)?;
        let column_names = columns
            .iter()
            .map(|column| Self::quote_identifier(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection.prepare(&format!(
            "SELECT {column_names} FROM {}",
            Self::quote_identifier(object_name)
        ))?;
        let mut rows = statement.query([])?;
        let mut row_index = 0_usize;
        while let Some(row) = rows.next()? {
            row_index += 1;
            let mut values = Vec::with_capacity(columns.len());
            for column_index in 0..columns.len() {
                values.push(match row.get_ref(column_index)? {
                    ValueRef::Null => ConnectorValue::Null,
                    ValueRef::Integer(value) => ConnectorValue::Integer(value),
                    ValueRef::Real(value) => ConnectorValue::Real(value),
                    ValueRef::Text(value) => {
                        ConnectorValue::Text(String::from_utf8_lossy(value).into_owned())
                    }
                    ValueRef::Blob(value) => ConnectorValue::Blob(value.to_vec()),
                });
            }
            visitor(row_index, values)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_and_directory_paths() {
        let missing =
            std::env::temp_dir().join(format!("datalink-missing-{}.sqlite", uuid::Uuid::new_v4()));
        let missing_error = SqliteConnector::new(missing.to_str().expect("missing path"))
            .test_connection()
            .expect_err("reject missing path");
        assert!(matches!(missing_error, AppError::FileIO(_)));

        let directory = std::env::temp_dir();
        let directory_error = SqliteConnector::new(directory.to_str().expect("temp path"))
            .test_connection()
            .expect_err("reject directory path");
        assert!(matches!(directory_error, AppError::FileIO(_)));
    }

    #[test]
    fn opens_canonical_sqlite_path_read_only() {
        let path =
            std::env::temp_dir().join(format!("datalink-readonly-{}.sqlite", uuid::Uuid::new_v4()));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute("CREATE TABLE samples (id INTEGER)", [])
            .expect("create source table");
        drop(sqlite);

        let connector = SqliteConnector::new(path.to_str().expect("fixture path"));
        let read_only = connector.open().expect("open read-only connection");
        let write_error = read_only
            .execute("INSERT INTO samples VALUES (1)", [])
            .expect_err("read-only connection must reject writes");
        assert!(write_error.to_string().contains("readonly"));

        drop(read_only);
        std::fs::remove_file(path).expect("remove fixture");
    }
}

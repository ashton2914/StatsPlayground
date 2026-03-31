use duckdb::{Connection, params};

use crate::error::AppError;
use crate::models::table::{DatasetMeta, TableQueryResult};

/// DuckDB engine wrapper
pub struct DuckDbEngine {
    conn: Connection,
}

impl DuckDbEngine {
    /// Get a reference to the underlying connection
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Create a new in-memory DuckDB engine and initialize metadata tables
    pub fn new_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS _meta_datasets (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                source_path TEXT,
                source_type TEXT,
                row_count   BIGINT DEFAULT 0,
                col_count   INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR)),
                updated_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR))
            );

            CREATE TABLE IF NOT EXISTS _meta_columns (
                dataset_id  TEXT,
                col_index   INTEGER,
                col_name    TEXT,
                col_type    TEXT,
                role        TEXT DEFAULT 'continuous',
                missing_count BIGINT DEFAULT 0,
                PRIMARY KEY (dataset_id, col_index)
            );
            ",
        )?;

        Ok(Self { conn })
    }

    /// Import a CSV file as a new dataset
    pub fn import_csv(&self, id: &str, name: &str, file_path: &str) -> Result<DatasetMeta, AppError> {
        let table_name = format!("dataset_{}", id.replace('-', "_"));

        // Create table from CSV using DuckDB's read_csv
        let create_sql = format!(
            "CREATE TABLE \"{}\" AS SELECT * FROM read_csv($1, auto_detect=true)",
            table_name
        );
        self.conn.execute(&create_sql, params![file_path])?;

        // Get row count
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info
        let mut col_stmt = self.conn.prepare(
            &format!("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position")
        )?;

        let col_count: i32 = {
            let mut rows = col_stmt.query(params![table_name])?;
            let mut count = 0i32;
            let mut col_index = 0i32;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(0)?;
                let col_type: String = row.get(1)?;
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index, col_name, col_type],
                )?;
                col_index += 1;
                count += 1;
            }
            count
        };

        // Insert dataset metadata
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'csv', $4, $5)",
            params![id, name, file_path, row_count, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Get metadata for a single dataset
    pub fn get_dataset_meta(&self, id: &str) -> Result<DatasetMeta, AppError> {
        let meta = self.conn.query_row(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets WHERE id = $1",
            params![id],
            |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )?;
        Ok(meta)
    }

    /// List all datasets
    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets ORDER BY created_at DESC",
        )?;

        let datasets = stmt
            .query_map([], |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(datasets)
    }

    /// Delete a dataset and its metadata
    pub fn delete_dataset(&self, id: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", id.replace('-', "_"));
        self.conn.execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;
        self.conn.execute("DELETE FROM _meta_columns WHERE dataset_id = $1", params![id])?;
        self.conn.execute("DELETE FROM _meta_datasets WHERE id = $1", params![id])?;
        Ok(())
    }

    /// Query a dataset table with pagination
    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let offset = page * page_size;

        // Get total rows
        let total_rows: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info from metadata (avoids DuckDB panic on unexecuted statements)
        let mut col_stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
        )?;
        let col_info: Vec<(String, String)> = col_stmt
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // _row_id + user columns
        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["INTEGER".to_string()];
        for (name, typ) in &col_info {
            columns.push(name.clone());
            column_types.push(typ.clone());
        }

        // Build SELECT with explicit column list
        let select_cols = columns.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");

        // Build query with optional sorting
        let order_clause = match sort_by {
            Some(col) => {
                let dir = sort_order.unwrap_or("asc");
                let dir = if dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
                format!("ORDER BY \"{}\" {}", col, dir)
            }
            None => String::new(),
        };

        let query = format!(
            "SELECT {} FROM \"{}\" {} LIMIT {} OFFSET {}",
            select_cols, table_name, order_clause, page_size, offset
        );

        // Execute and fetch rows
        let mut stmt = self.conn.prepare(&query)?;
        let mut rows_data: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows = stmt.query([])?;
        let column_count = columns.len();

        while let Some(row) = rows.next()? {
            let mut row_values: Vec<serde_json::Value> = Vec::new();
            for i in 0..column_count {
                let value: duckdb::types::Value = row.get(i)?;
                let json_val = match value {
                    duckdb::types::Value::Null => serde_json::Value::Null,
                    duckdb::types::Value::Boolean(b) => serde_json::Value::Bool(b),
                    duckdb::types::Value::TinyInt(n) => serde_json::json!(n),
                    duckdb::types::Value::SmallInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Int(n) => serde_json::json!(n),
                    duckdb::types::Value::BigInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Float(f) => serde_json::json!(f),
                    duckdb::types::Value::Double(f) => serde_json::json!(f),
                    duckdb::types::Value::Text(s) => serde_json::Value::String(s),
                    _ => serde_json::Value::String(format!("{:?}", value)),
                };
                row_values.push(json_val);
            }
            rows_data.push(row_values);
        }

        Ok(TableQueryResult {
            columns,
            column_types,
            rows: rows_data,
            total_rows,
            page,
            page_size,
        })
    }

    /// Export a dataset to CSV
    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        self.conn.execute(
            &format!("COPY \"{}\" TO $1 (HEADER, DELIMITER ',')", table_name),
            params![output_path],
        )?;
        Ok(())
    }

    /// Export all datasets as CSV files packed into a ZIP archive
    pub fn export_csv_zip(&self, output_path: &str) -> Result<(), AppError> {
        use std::io::Write;

        let datasets = self.list_datasets()?;
        if datasets.is_empty() {
            return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
        }

        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for ds in &datasets {
            let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

            // Get user column names (exclude _row_id)
            let mut col_stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
            )?;
            let col_names: Vec<String> = col_stmt
                .query_map(params![ds.id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;

            if col_names.is_empty() {
                continue;
            }

            let select_cols = col_names.iter()
                .map(|c| format!("CAST(\"{}\" AS VARCHAR) AS \"{}\"", c, c))
                .collect::<Vec<_>>()
                .join(", ");

            // Query all data
            let sql = format!("SELECT {} FROM \"{}\"", select_cols, table_name);
            let mut stmt = self.conn.prepare(&sql)?;
            let col_count = col_names.len();
            let mut rows = stmt.query([])?;

            // Build CSV content in memory
            let mut csv_buf = Vec::new();
            // Header
            writeln!(&mut csv_buf, "{}", col_names.join(","))
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            // Data rows
            while let Some(row) = rows.next()? {
                let mut parts = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let val: Option<String> = row.get(i)?;
                    match val {
                        Some(v) => {
                            if v.contains(',') || v.contains('"') || v.contains('\n') {
                                parts.push(format!("\"{}\"", v.replace('"', "\"\"")));
                            } else {
                                parts.push(v);
                            }
                        }
                        None => parts.push(String::new()),
                    }
                }
                writeln!(&mut csv_buf, "{}", parts.join(","))
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
            }

            // Sanitize file name
            let file_name = format!("{}.csv", ds.name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"));
            zip.start_file(&file_name, options)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            zip.write_all(&csv_buf)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    }

    /// Import all tables from a SQLite database as datasets
    pub fn import_sqlite<F>(&self, file_path: &str, on_progress: &F) -> Result<Vec<(String, DatasetMeta)>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        use rusqlite::types::ValueRef;

        // Open SQLite file directly with rusqlite (bypasses DuckDB's scanner type issues)
        let sqlite_conn = rusqlite::Connection::open_with_flags(
            file_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;

        // List user tables
        let mut table_stmt = sqlite_conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )?;
        let table_names: Vec<String> = table_stmt.query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(table_stmt);

        let table_total = table_names.len();

        let mut results = Vec::new();

        for (table_index, src_table) in table_names.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            let table_name = format!("dataset_{}", id.replace('-', "_"));

            // Get column info via PRAGMA table_info
            let mut pragma_stmt = sqlite_conn.prepare(
                &format!("PRAGMA table_info(\"{}\")", src_table)
            )?;
            let columns: Vec<(String, String)> = pragma_stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?, // column name
                    row.get::<_, String>(2)?, // column type
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
            drop(pragma_stmt);

            if columns.is_empty() {
                continue;
            }

            // Map SQLite types to DuckDB types (date/time types -> VARCHAR)
            let col_defs: Vec<String> = columns.iter().map(|(name, sqlite_type)| {
                let duckdb_type = Self::map_sqlite_type(sqlite_type);
                format!("\"{}\" {}", name, duckdb_type)
            }).collect();

            self.conn.execute(
                &format!(
                    "CREATE TABLE \"{}\" (\"_row_id\" BIGINT, {})",
                    table_name, col_defs.join(", ")
                ),
                [],
            )?;

            // Determine target types for value conversion
            let col_types: Vec<&str> = columns.iter()
                .map(|(_, t)| Self::map_sqlite_type(t))
                .collect();

            // Read ALL data from SQLite into memory first, then batch-insert into DuckDB.
            // This avoids holding the DuckDB mutex while doing slow SQLite I/O.
            let col_count = columns.len();
            on_progress(src_table, table_index, table_total, 0, 0); // signal: reading started
            let all_rows: Vec<Vec<String>> = {
                let col_names_sql = columns.iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let select_sql = format!("SELECT {} FROM \"{}\"", col_names_sql, src_table);
                let mut data_stmt = sqlite_conn.prepare(&select_sql)?;
                let mut rows = data_stmt.query([])?;
                let mut collected = Vec::new();

                while let Some(row) = rows.next()? {
                    let mut row_vals = Vec::with_capacity(col_count);
                    for i in 0..col_count {
                        let val_ref = row.get_ref(i)?;
                        let s = match val_ref {
                            ValueRef::Null => "\0NULL\0".to_string(),
                            ValueRef::Integer(v) => v.to_string(),
                            ValueRef::Real(v) => v.to_string(),
                            ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
                            ValueRef::Blob(_) => "\0NULL\0".to_string(),
                        };
                        row_vals.push(s);
                    }
                    collected.push(row_vals);
                }
                collected
            };

            // Batch INSERT using VALUES lists (1000 rows per batch for speed)
            const BATCH_SIZE: usize = 1000;
            let total_rows = all_rows.len();
            let mut rows_done: usize = 0;
            on_progress(src_table, table_index, table_total, 0, total_rows);
            self.conn.execute_batch("BEGIN TRANSACTION")?;

            for chunk in all_rows.chunks(BATCH_SIZE) {
                let mut values_parts: Vec<String> = Vec::with_capacity(chunk.len());
                for (batch_idx, row_vals) in chunk.iter().enumerate() {
                    let row_id = values_parts.len(); // placeholder, will compute below
                    let _ = row_id; // suppress warning
                    let mut col_parts: Vec<String> = Vec::with_capacity(col_count + 1);
                    // _row_id will be added via a subquery
                    for (ci, val) in row_vals.iter().enumerate() {
                        if val == "\0NULL\0" {
                            col_parts.push("NULL".to_string());
                        } else {
                            match col_types[ci] {
                                "BIGINT" => {
                                    match val.parse::<i64>() {
                                        Ok(v) => col_parts.push(v.to_string()),
                                        Err(_) => col_parts.push("NULL".to_string()),
                                    }
                                }
                                "DOUBLE" => {
                                    match val.parse::<f64>() {
                                        Ok(_) => col_parts.push(val.clone()),
                                        Err(_) => col_parts.push("NULL".to_string()),
                                    }
                                }
                                _ => { // VARCHAR
                                    col_parts.push(format!("'{}'", val.replace('\'', "''")));
                                }
                            }
                        }
                    }
                    let _ = batch_idx;
                    values_parts.push(format!("({})", col_parts.join(", ")));
                }

                // Use INSERT with row_number() to generate _row_id
                let col_aliases = columns.iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let insert_sql = format!(
                    "INSERT INTO \"{}\" SELECT row_number() OVER () + (SELECT COALESCE(MAX(\"_row_id\"), 0) FROM \"{}\"), {} FROM (VALUES {}) AS t({})",
                    table_name, table_name, col_aliases, values_parts.join(", "), col_aliases
                );
                self.conn.execute_batch(&insert_sql)?;
                rows_done += chunk.len();
                on_progress(src_table, table_index, table_total, rows_done, total_rows);
            }

            self.conn.execute_batch("COMMIT")?;

            // Get row count
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;

            // Insert column metadata
            let col_count_i32 = columns.len() as i32;
            for (col_index, (col_name, sqlite_type)) in columns.iter().enumerate() {
                let duckdb_type = Self::map_sqlite_type(sqlite_type);
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index as i32, col_name, duckdb_type],
                )?;
            }

            // Insert dataset metadata
            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'sqlite', $4, $5)",
                params![id, src_table, file_path, row_count, col_count_i32],
            )?;

            let meta = self.get_dataset_meta(&id)?;
            results.push((src_table.clone(), meta));
        }

        Ok(results)
    }

    /// Map SQLite column type to DuckDB type, keeping date/time types as VARCHAR
    fn map_sqlite_type(sqlite_type: &str) -> &'static str {
        let upper = sqlite_type.to_uppercase();
        if upper.contains("INT") || upper.contains("BOOL") {
            "BIGINT"
        } else if upper.contains("REAL") || upper.contains("FLOA")
            || upper.contains("DOUB") || upper.contains("NUMERIC")
            || upper.contains("DECIMAL") {
            "DOUBLE"
        } else {
            "VARCHAR"
        }
    }

    /// Export all datasets to a SQLite database file
    pub fn export_sqlite(&self, output_path: &str) -> Result<(), AppError> {
        // Install and load the sqlite extension
        self.conn.execute_batch("INSTALL sqlite; LOAD sqlite;")?;

        // Delete existing file if present (so we get a fresh database)
        let _ = std::fs::remove_file(output_path);

        // Detach if previously attached (from a failed attempt)
        let _ = self.conn.execute_batch("DETACH IF EXISTS _sqlite_dst;");

        // Attach the output SQLite database
        self.conn.execute(
            &format!("ATTACH '{}' AS _sqlite_dst (TYPE sqlite)", output_path.replace('\'', "''")),
            [],
        )?;

        let result = (|| -> Result<(), AppError> {
            // Get all datasets
            let datasets = self.list_datasets()?;

            for ds in &datasets {
                let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

                // Get user column names (exclude _row_id)
                let mut col_stmt = self.conn.prepare(
                    "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
                )?;
                let col_names: Vec<String> = col_stmt
                    .query_map(params![ds.id], |row| row.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;

                if col_names.is_empty() {
                    continue;
                }

                let select_cols = col_names.iter().map(|c| format!("\"{}\" ", c)).collect::<Vec<_>>().join(", ");

                // Create the table in the destination SQLite database
                self.conn.execute(
                    &format!(
                        "CREATE TABLE _sqlite_dst.\"{}\" AS SELECT {} FROM \"{}\"",
                        ds.name, select_cols, table_name
                    ),
                    [],
                )?;
            }

            Ok(())
        })();

        // Always detach
        let _ = self.conn.execute_batch("DETACH _sqlite_dst;");

        result
    }

    /// Get basic descriptive stats for a numeric column
    pub fn column_stats(&self, dataset_id: &str, column_name: &str) -> Result<crate::models::stats::ColumnStats, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        let stats = self.conn.query_row(
            &format!(
                "SELECT
                    COUNT(*) as cnt,
                    COUNT(*) - COUNT(\"{col}\") as missing,
                    AVG(\"{col}\") as mean_val,
                    MEDIAN(\"{col}\") as median_val,
                    STDDEV_SAMP(\"{col}\") as std_val,
                    MIN(\"{col}\") as min_val,
                    MAX(\"{col}\") as max_val,
                    QUANTILE_CONT(\"{col}\", 0.25) as q1_val,
                    QUANTILE_CONT(\"{col}\", 0.75) as q3_val,
                    COUNT(DISTINCT \"{col}\") as unique_cnt
                FROM \"{table}\"",
                col = column_name,
                table = table_name
            ),
            [],
            |row| {
                Ok(crate::models::stats::ColumnStats {
                    column_name: column_name.to_string(),
                    count: row.get(0)?,
                    missing: row.get(1)?,
                    mean: row.get(2)?,
                    median: row.get(3)?,
                    std_dev: row.get(4)?,
                    min: row.get(5)?,
                    max: row.get(6)?,
                    q1: row.get(7)?,
                    q3: row.get(8)?,
                    unique_count: row.get(9)?,
                })
            },
        )?;

        Ok(stats)
    }

    /// Get descriptive stats for all numeric columns in a dataset
    pub fn descriptive_stats(&self, dataset_id: &str) -> Result<crate::models::stats::DescriptiveResult, AppError> {
        // Get column list
        let mut stmt = self.conn.prepare(
            "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
        )?;

        let col_names: Vec<String> = stmt
            .query_map(params![dataset_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut columns = Vec::new();
        for col_name in &col_names {
            match self.column_stats(dataset_id, col_name) {
                Ok(stats) => columns.push(stats),
                Err(_) => continue, // Skip non-numeric columns
            }
        }

        Ok(crate::models::stats::DescriptiveResult {
            dataset_id: dataset_id.to_string(),
            columns,
        })
    }

    /// Create an empty dataset with specified columns (columns may be empty)
    pub fn create_empty_table(
        &self,
        id: &str,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if column_names.len() != column_types.len() {
            return Err(AppError::InvalidParam("Column names and types length mismatch".into()));
        }

        let table_name = format!("dataset_{}", id.replace('-', "_"));

        // Build column definitions
        let col_defs: Vec<String> = column_names
            .iter()
            .zip(column_types.iter())
            .map(|(name, typ)| format!("\"{}\" {}", name, typ))
            .collect();

        // Add a hidden row_id column for row identification
        let create_sql = if col_defs.is_empty() {
            format!("CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0)", table_name)
        } else {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Register column metadata
        for (i, (col_name, col_type)) in column_names.iter().zip(column_types.iter()).enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![id, i as i32, col_name, col_type],
            )?;
        }

        // Insert dataset metadata
        let col_count = column_names.len() as i32;
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, NULL, 'manual', 0, $3)",
            params![id, name, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Add an empty row to a dataset, returns the new row_id
    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Get next row_id
        let max_id: Option<i64> = self.conn.query_row(
            &format!("SELECT MAX(\"_row_id\") FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        ).unwrap_or(None);
        let new_id = max_id.unwrap_or(0) + 1;

        // Insert row with only _row_id set (other columns NULL)
        self.conn.execute(
            &format!("INSERT INTO \"{}\" (\"_row_id\") VALUES ($1)", table_name),
            params![new_id],
        )?;

        // Update row count in metadata
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count, dataset_id],
        )?;

        Ok(new_id)
    }

    /// Update a cell value
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        if value.is_empty() {
            // Set to NULL when clearing
            let update_sql = format!(
                "UPDATE \"{}\" SET \"{}\" = NULL WHERE \"_row_id\" = $1",
                table_name, column_name
            );
            self.conn.execute(&update_sql, params![row_id])?;
        } else {
            let update_sql = format!(
                "UPDATE \"{}\" SET \"{}\" = $1 WHERE \"_row_id\" = $2",
                table_name, column_name
            );
            self.conn.execute(&update_sql, params![value, row_id])?;
        }
        Ok(())
    }

    /// Delete a row by row_id
    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        self.conn.execute(
            &format!("DELETE FROM \"{}\" WHERE \"_row_id\" = $1", table_name),
            params![row_id],
        )?;

        // Update row count
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count, dataset_id],
        )?;
        Ok(())
    }

    /// Rename a dataset
    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE _meta_datasets SET name = $1 WHERE id = $2",
            params![new_name, dataset_id],
        )?;
        Ok(())
    }

    /// Add a column to a dataset
    pub fn add_column(&self, dataset_id: &str, col_name: &str, col_type: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // ALTER TABLE to add column
        self.conn.execute(
            &format!("ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}", table_name, col_name, col_type),
            [],
        )?;

        // Get current max col_index
        let max_idx: Option<i32> = self.conn.query_row(
            "SELECT MAX(col_index) FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
            |row| row.get(0),
        ).unwrap_or(None);
        let new_idx = max_idx.unwrap_or(-1) + 1;

        // Insert column metadata
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
            params![dataset_id, new_idx, col_name, col_type],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Delete a column from a dataset
    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // ALTER TABLE to drop column
        self.conn.execute(
            &format!("ALTER TABLE \"{}\" DROP COLUMN \"{}\"", table_name, col_name),
            [],
        )?;

        // Get the index of the deleted column
        let del_idx: i32 = self.conn.query_row(
            "SELECT col_index FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
            |row| row.get(0),
        )?;

        // Delete column metadata
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
        )?;

        // Re-index remaining columns
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = $1 AND col_index > $2",
            params![dataset_id, del_idx],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count - 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Rename a column
    pub fn rename_column(&self, dataset_id: &str, old_name: &str, new_name: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        self.conn.execute(
            &format!("ALTER TABLE \"{}\" RENAME COLUMN \"{}\" TO \"{}\"", table_name, old_name, new_name),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_name = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![new_name, dataset_id, old_name],
        )?;

        Ok(())
    }

    pub fn change_column_type(&self, dataset_id: &str, col_name: &str, new_type: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Pre-validate: check if all non-null values can be cast to the new type
        let check_sql = format!(
            "SELECT COUNT(*) FROM \"{}\" WHERE \"{}\" IS NOT NULL AND TRY_CAST(\"{}\" AS {}) IS NULL",
            table_name, col_name, col_name, new_type
        );
        let fail_count: i64 = self.conn.query_row(&check_sql, [], |row| row.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;

        if fail_count > 0 {
            return Err(AppError::InvalidParam(
                format!("无法将列 \"{}\" 转换为 {}：有 {} 个值无法转换", col_name, new_type, fail_count)
            ));
        }

        self.conn.execute(
            &format!("ALTER TABLE \"{}\" ALTER COLUMN \"{}\" SET DATA TYPE {} USING \"{}\"::{}",
                table_name, col_name, new_type, col_name, new_type),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_type = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![new_type, dataset_id, col_name],
        )?;

        Ok(())
    }

    /// Paste data at a specific position in the dataset.
    /// Creates missing columns/rows as needed, updates cells.
    /// If `header_names` is provided, renames target columns to those names.
    /// For existing empty columns, changes type to detected type.
    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // 1. Get existing columns
        let mut stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
        )?;
        let existing_cols: Vec<(String, String)> = stmt
            .query_map(params![dataset_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        let num_paste_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut all_col_names: Vec<String> = existing_cols.iter().map(|(n, _)| n.clone()).collect();

        // 2. Determine target column names; create new columns if needed
        let mut paste_col_names: Vec<String> = Vec::new();
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                paste_col_names.push(existing_cols[target_idx].0.clone());
            } else {
                let col_type = new_col_types.get(c).map(|s| s.as_str()).unwrap_or("VARCHAR");
                let col_name = if let Some(names) = header_names {
                    let name = names.get(c).map(|s| s.trim()).unwrap_or("");
                    if name.is_empty() {
                        Self::generate_col_name(&all_col_names)
                    } else {
                        name.to_string()
                    }
                } else {
                    Self::generate_col_name(&all_col_names)
                };
                self.add_column(dataset_id, &col_name, col_type)?;
                all_col_names.push(col_name.clone());
                paste_col_names.push(col_name);
            }
        }

        // 3. For existing target columns with no data, change type to detected type
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                let (ref col_name, ref existing_type) = existing_cols[target_idx];
                let detected_type = new_col_types.get(c).map(|s| s.as_str()).unwrap_or("VARCHAR");
                if existing_type != detected_type {
                    // Check if column has any non-null data
                    let has_data: i64 = self.conn.query_row(
                        &format!("SELECT COUNT(*) FROM \"{}\" WHERE \"{}\" IS NOT NULL", table_name, col_name),
                        [],
                        |row| row.get(0),
                    )?;
                    if has_data == 0 {
                        // Safe to change type
                        let _ = self.change_column_type(dataset_id, col_name, detected_type);
                    }
                }
            }
        }

        // 4. Handle header renames for existing columns
        if let Some(names) = header_names {
            for (c, new_name) in names.iter().enumerate() {
                let target_idx = start_col + c;
                if target_idx < existing_cols.len() {
                    let old_name = &paste_col_names[c];
                    let trimmed = new_name.trim();
                    if !trimmed.is_empty() && old_name != trimmed {
                        self.rename_column(dataset_id, old_name, trimmed)?;
                        paste_col_names[c] = trimmed.to_string();
                    }
                }
            }
        }

        // 5. Get existing row_ids in order
        let mut row_stmt = self.conn.prepare(
            &format!("SELECT \"_row_id\" FROM \"{}\" ORDER BY \"_row_id\"", table_name)
        )?;
        let existing_row_ids: Vec<i64> = row_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        // 6. Paste each row
        for (r, row_data) in rows.iter().enumerate() {
            let target_row_idx = start_row + r;
            let row_id: i64;

            if target_row_idx < existing_row_ids.len() {
                row_id = existing_row_ids[target_row_idx];
            } else {
                row_id = self.add_row(dataset_id)?;
            }

            for (c, value) in row_data.iter().enumerate() {
                if c < paste_col_names.len() && !value.is_empty() {
                    self.update_cell(dataset_id, row_id, &paste_col_names[c], value)?;
                }
            }
        }

        // 7. Update metadata counts
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        Ok(())
    }

    fn generate_col_name(existing: &[String]) -> String {
        let mut i = 1;
        loop {
            let name = format!("列{}", i);
            if !existing.contains(&name) {
                return name;
            }
            i += 1;
        }
    }

    /// Restore a table from a full snapshot (columns, types, rows).
    /// Drops all existing data and recreates the table with the given schema and data.
    pub fn restore_snapshot(
        &self,
        dataset_id: &str,
        col_names: &[String],
        col_types: &[String],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Drop and recreate the table
        self.conn.execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;

        let col_defs: Vec<String> = col_names
            .iter()
            .zip(col_types.iter())
            .map(|(name, typ)| format!("\"{}\" {}", name, typ))
            .collect();

        let create_sql = if col_defs.is_empty() {
            format!("CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0)", table_name)
        } else {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Rebuild _meta_columns
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
        )?;
        for (i, (col_name, col_type)) in col_names.iter().zip(col_types.iter()).enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![dataset_id, i as i32, col_name, col_type],
            )?;
        }

        // Insert rows — each row includes _row_id as first element followed by column values
        for row_data in rows {
            if row_data.is_empty() {
                continue;
            }
            // First element is _row_id
            let row_id = match &row_data[0] {
                serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
                _ => 0,
            };

            // Build column list and values for non-null columns
            let mut insert_cols = vec!["\"_row_id\"".to_string()];
            let mut insert_vals = vec![row_id.to_string()];

            for (i, col_name) in col_names.iter().enumerate() {
                let val = row_data.get(i + 1).unwrap_or(&serde_json::Value::Null);
                if val.is_null() {
                    continue;
                }
                insert_cols.push(format!("\"{}\"", col_name));
                match val {
                    serde_json::Value::Bool(b) => insert_vals.push(b.to_string()),
                    serde_json::Value::Number(n) => insert_vals.push(n.to_string()),
                    serde_json::Value::String(s) => {
                        insert_vals.push(format!("'{}'", s.replace('\'', "''")));
                    }
                    _ => insert_vals.push(format!("'{}'", val.to_string().replace('\'', "''"))),
                }
            }

            let sql = format!(
                "INSERT INTO \"{}\" ({}) VALUES ({})",
                table_name,
                insert_cols.join(", "),
                insert_vals.join(", ")
            );
            self.conn.execute(&sql, [])?;
        }

        // Update metadata counts
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count = col_names.len() as i32;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        Ok(())
    }
}

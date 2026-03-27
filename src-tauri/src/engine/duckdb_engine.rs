use duckdb::{Connection, params};

use crate::error::AppError;
use crate::models::table::{DatasetMeta, TableQueryResult};

/// DuckDB engine wrapper
pub struct DuckDbEngine {
    conn: Connection,
}

impl DuckDbEngine {
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

        // Build query with optional sorting
        let order_clause = match sort_by {
            Some(col) => {
                let dir = sort_order.unwrap_or("asc");
                // Validate sort direction
                let dir = if dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
                format!("ORDER BY \"{}\" {}", col, dir)
            }
            None => String::new(),
        };

        let query = format!(
            "SELECT * FROM \"{}\" {} LIMIT {} OFFSET {}",
            table_name, order_clause, page_size, offset
        );

        let mut stmt = self.conn.prepare(&query)?;
        let column_count = stmt.column_count();

        // Get column names and types
        let columns: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).map_or("?".to_string(), |v| v.to_string()))
            .collect();

        let column_types: Vec<String> = (0..column_count)
            .map(|i| stmt.column_type(i).to_string())
            .collect();

        // Fetch rows as JSON values
        let mut rows_data: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows = stmt.query([])?;

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
}

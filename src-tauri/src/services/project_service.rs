use std::fs;

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::table::{ColumnDisplayProps, ColumnFormatInfo};
use crate::state::AppState;

pub struct ProjectService<'a> {
    state: &'a AppState,
}

/// .spprj file format: JSON containing project metadata + dataset list
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpprjFile {
    name: String,
    version: String,
    created_at: String,
    datasets: Vec<SpprjDataset>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpprjDataset {
    id: String,
    name: String,
    source_type: String,
    columns: Vec<SpprjColumn>,
    rows: Vec<Vec<serde_json::Value>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpprjColumn {
    name: String,
    col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<SpprjColumnFormat>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpprjColumnFormat {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
}

impl<'a> ProjectService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    /// Initialize a new in-memory project (no file on disk)
    pub fn init_project(&self) -> Result<ProjectInfo, AppError> {
        self.state.reset_db()?;

        let now = chrono_now();
        let project = ProjectInfo {
            name: "未命名项目".to_string(),
            file_path: String::new(),
            created_at: now,
        };

        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Create a new project at the specified path
    pub fn create_project(&self, name: &str, file_path: &str) -> Result<ProjectInfo, AppError> {
        // Reset DuckDB for fresh project
        self.state.reset_db()?;

        let now = chrono_now();
        let project = ProjectInfo {
            name: name.to_string(),
            file_path: file_path.to_string(),
            created_at: now.clone(),
        };

        // Save initial empty project file
        let spprj = SpprjFile {
            name: name.to_string(),
            version: "0.1.0".to_string(),
            created_at: now,
            datasets: vec![],
        };

        let json = serde_json::to_string_pretty(&spprj)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        fs::write(file_path, json)?;

        // Update project state
        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Open an existing project from a .spprj file
    pub fn open_project(&self, file_path: &str) -> Result<ProjectInfo, AppError> {
        let content = fs::read_to_string(file_path)?;
        let spprj: SpprjFile = serde_json::from_str(&content)
            .map_err(|e| AppError::FileIO(format!("Invalid project file: {}", e)))?;

        // Reset DuckDB and restore data
        self.state.reset_db()?;
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;

        // Restore each dataset
        for ds in &spprj.datasets {
            let col_names: Vec<String> = ds.columns.iter().map(|c| c.name.clone()).collect();
            let col_types: Vec<String> = ds.columns.iter().map(|c| c.col_type.clone()).collect();
            db.create_empty_table(&ds.id, &ds.name, &col_names, &col_types)?;

            // Insert rows
            for row in &ds.rows {
                // Build insert with _row_id + data columns
                let all_cols: Vec<String> = std::iter::once("\"_row_id\"".to_string())
                    .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
                    .collect();
                // Use raw SQL for variable column count
                let values_str: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => "NULL".to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                    serde_json::Value::Bool(b) => b.to_string(),
                    _ => format!("'{}'", v.to_string().replace('\'', "''")),
                }).collect();

                let raw_sql = format!(
                    "INSERT INTO \"dataset_{}\" ({}) VALUES ({})",
                    ds.id.replace('-', "_"),
                    all_cols.join(", "),
                    values_str.join(", ")
                );
                let _ = db.conn().execute(&raw_sql, []);
            }

            // Update row count
            let row_count: i64 = db.conn().query_row(
                &format!("SELECT COUNT(*) FROM \"dataset_{}\"", ds.id.replace('-', "_")),
                [],
                |row| row.get(0),
            )?;
            db.conn().execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                duckdb::params![row_count, ds.id],
            )?;

            // Restore column display properties
            let mut display_props: Vec<ColumnDisplayProps> = Vec::new();
            for (i, col) in ds.columns.iter().enumerate() {
                if col.width.is_some() || col.format.is_some() {
                    display_props.push(ColumnDisplayProps {
                        col_index: i,
                        width: col.width,
                        format: col.format.as_ref().map(|f| ColumnFormatInfo {
                            kind: f.kind.clone(),
                            decimals: f.decimals,
                            currency: f.currency.clone(),
                        }),
                    });
                }
            }
            if !display_props.is_empty() {
                let mut display = self.state.column_display.lock()
                    .map_err(|e| AppError::Database(e.to_string()))?;
                display.insert(ds.id.clone(), display_props);
            }
        }

        let project = ProjectInfo {
            name: spprj.name,
            file_path: file_path.to_string(),
            created_at: spprj.created_at,
        };

        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Save current project state to disk
    pub fn save_project(&self, file_path: Option<&str>) -> Result<(), AppError> {
        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let project = proj.as_mut()
            .ok_or_else(|| AppError::InvalidParam("No project is open".into()))?;

        // If a file_path is provided (first-time save), update the project
        if let Some(fp) = file_path {
            project.file_path = fp.to_string();
            // Derive name from filename
            if let Some(stem) = std::path::Path::new(fp).file_stem().and_then(|s| s.to_str()) {
                project.name = stem.to_string();
            }
        }

        if project.file_path.is_empty() {
            return Err(AppError::InvalidParam("Project has no file path".into()));
        }

        let save_path = project.file_path.clone();
        let save_name = project.name.clone();
        let save_created_at = project.created_at.clone();
        drop(proj); // release write lock before reading db

        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let display = self.state.column_display.lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let datasets = db.list_datasets()?;

        let mut spprj_datasets = Vec::new();
        for ds in &datasets {
            let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

            // Get columns
            let mut col_stmt = db.conn().prepare(
                "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
            )?;
            let base_columns: Vec<(String, String)> = col_stmt
                .query_map(duckdb::params![ds.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            // Merge display props into columns
            let ds_display = display.get(&ds.id);
            let columns: Vec<SpprjColumn> = base_columns.iter().enumerate().map(|(i, (name, col_type))| {
                let dp = ds_display.and_then(|v| v.iter().find(|p| p.col_index == i));
                SpprjColumn {
                    name: name.clone(),
                    col_type: col_type.clone(),
                    width: dp.and_then(|p| p.width),
                    format: dp.and_then(|p| p.format.as_ref()).map(|f| SpprjColumnFormat {
                        kind: f.kind.clone(),
                        decimals: f.decimals,
                        currency: f.currency.clone(),
                    }),
                }
            }).collect();

            let col_names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();

            // Get all rows (including _row_id)
            let select_cols = std::iter::once("\"_row_id\"".to_string())
                .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
                .collect::<Vec<_>>()
                .join(", ");
            let query = format!("SELECT {} FROM \"{}\" ORDER BY \"_row_id\"", select_cols, table_name);
            let mut stmt = db.conn().prepare(&query)?;
            let total_cols = 1 + col_names.len(); // _row_id + data columns

            let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
            let mut result_rows = stmt.query([])?;
            while let Some(row) = result_rows.next()? {
                let mut row_values = Vec::new();
                for i in 0..total_cols {
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
                rows.push(row_values);
            }

            spprj_datasets.push(SpprjDataset {
                id: ds.id.clone(),
                name: ds.name.clone(),
                source_type: ds.source_type.clone(),
                columns,
                rows,
            });
        }

        let spprj = SpprjFile {
            name: save_name,
            version: "0.1.0".to_string(),
            created_at: save_created_at,
            datasets: spprj_datasets,
        };

        let json = serde_json::to_string_pretty(&spprj)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        fs::write(&save_path, json)?;

        Ok(())
    }

    /// Get current project info
    pub fn get_current_project(&self) -> Result<Option<ProjectInfo>, AppError> {
        let proj = self.state.project.read()
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(proj.clone())
    }
}

fn chrono_now() -> String {
    // Simple UTC timestamp without chrono dependency
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_default()
}

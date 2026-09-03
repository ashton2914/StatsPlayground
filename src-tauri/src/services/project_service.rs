use crate::error::AppError;
use crate::models::distribution::{DistributionIssueV1, DistributionLoadStatusV1};
use crate::models::project::{DatasetNameMigration, DocumentNameMigration, ProjectInfo};
use crate::models::save::{
    SaveProgressCallback, SaveProjectRequest, SaveSnapshot, SaveWriteResult,
};
use crate::models::table::{ColumnDisplayProps, ColumnFormatInfo};
use crate::services::archive_cell::{
    archive_cell_to_json, archive_export_expression, is_archive_scalar_type,
};
use crate::services::spprj_archive::{
    self, DerivedFormulaDocV1, DistributionDocV1, GraphDoc, ProjectBundle, TableColumn,
    TableColumnFormat, TableDoc,
};
use crate::services::streaming_project_writer::StreamingProjectWriter;
use crate::state::AppState;
use duckdb::appender_params_from_iter;
use duckdb::types::Value as DuckValue;

pub struct ProjectService<'a> {
    state: &'a AppState,
}

/// Result of opening a project, including restored history/snapshot data,
/// graph builder configurations, and folder layout. Field names mirror the
/// frontend API shape so this refactor is transparent to TypeScript callers.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResult {
    pub project: ProjectInfo,
    #[serde(default)]
    pub history: Vec<serde_json::Value>,
    #[serde(default)]
    pub snapshots: Vec<serde_json::Value>,
    #[serde(default)]
    pub graph_builders: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_y_by_x: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_models: Vec<serde_json::Value>,
    #[serde(default)]
    pub tabulates: Vec<serde_json::Value>,
    #[serde(default)]
    pub distributions: Vec<DistributionDocV1>,
    #[serde(default)]
    pub derived_formulas: Vec<DerivedFormulaDocV1>,
    #[serde(default)]
    pub distribution_issues: Vec<DistributionIssueV1>,
    /// All folder paths that exist in the project (including empty ones).
    #[serde(default)]
    pub folders: Vec<String>,
    /// `datasetId -> folder path` (root datasets are simply absent from the map).
    #[serde(default)]
    pub table_folders: std::collections::HashMap<String, String>,
    /// `graphId -> folder path`.
    #[serde(default)]
    pub graph_folders: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub fit_y_by_x_folders: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub fit_model_folders: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub document_name_migrations: Vec<DocumentNameMigration>,
    #[serde(default)]
    pub dataset_name_migrations: Vec<DatasetNameMigration>,
    #[serde(default)]
    pub requires_migration: bool,
    /// `tabulateId -> folder path`.
    #[serde(default)]
    pub tabulate_folders: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub distribution_folders: std::collections::HashMap<String, String>,
}

const SPPRJ_VERSION: &str = "3.0.0";

fn push_distribution_issue(issues: &mut Vec<DistributionIssueV1>, issue: DistributionIssueV1) {
    if !issues.contains(&issue) {
        issues.push(issue);
    }
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn seed_save_project(
    state: &AppState,
    rows: usize,
    columns: usize,
) -> Result<String, AppError> {
    let archive_path = std::env::temp_dir().join(format!(
        "stats_playground_save_current_{}.spprj",
        uuid::Uuid::new_v4()
    ));
    let archive_path_string = archive_path.to_string_lossy().to_string();

    ProjectService::new(state).create_project("Save Current Baseline", &archive_path_string)?;
    state
        .db
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?
        .seed_benchmark_table(
            "save-current-baseline",
            "Save Current Baseline",
            rows,
            columns,
        )?;

    Ok(archive_path_string)
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
            name: "Untitled Project".to_string(),
            file_path: String::new(),
            created_at: now,
        };

        let mut proj = self
            .state
            .project
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Create a new project at the specified path. Writes an empty archive to
    /// disk so the file exists for subsequent saves.
    pub fn create_project(&self, name: &str, file_path: &str) -> Result<ProjectInfo, AppError> {
        self.state.reset_db()?;

        let now = chrono_now();
        let project = ProjectInfo {
            name: name.to_string(),
            file_path: file_path.to_string(),
            created_at: now.clone(),
        };

        let empty_folders: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let bundle = spprj_archive::build_bundle(
            name.to_string(),
            SPPRJ_VERSION.to_string(),
            now,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            &empty_folders,
            &empty_folders,
            &empty_folders,
            &empty_folders,
            &empty_folders,
            &empty_folders,
            Vec::new(),
            Vec::new(),
        );
        spprj_archive::write_project_archive(&bundle, file_path)?;

        let mut proj = self
            .state
            .project
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Open an existing `.spprj` file. Auto-detects the new ZIP container vs
    /// the legacy single-file JSON format.
    pub fn open_project(
        &self,
        file_path: &str,
        progress_cb: Option<&dyn Fn(usize, usize, &str, usize, usize)>,
    ) -> Result<OpenProjectResult, AppError> {
        let mut bundle = spprj_archive::read_project_file(file_path)?;
        let dataset_name_migrations = normalize_duplicate_dataset_names(&mut bundle.tables);

        let staged_state = AppState::new()?;
        let total = bundle.tables.len();
        {
            let staged_service = ProjectService::new(&staged_state);
            for (idx, doc) in bundle.tables.iter().enumerate() {
                if let Some(cb) = &progress_cb {
                    cb(idx, total, &doc.name, 0, doc.rows.len());
                }
                let row_progress = |rows_done, rows_total| {
                    if let Some(cb) = &progress_cb {
                        cb(idx, total, &doc.name, rows_done, rows_total);
                    }
                };
                staged_service.restore_table_doc_with_progress(doc, Some(&row_progress))?;
            }
        }

        let project = ProjectInfo {
            name: bundle.manifest.name.clone(),
            file_path: file_path.to_string(),
            created_at: bundle.manifest.created_at.clone(),
        };

        let table_folders = match &bundle.manifest.table_folders {
            Some(assignments) => assignments.clone(),
            None => derive_folders_from_entries(&bundle.manifest.tables, "tables"),
        };
        let graph_folders = match &bundle.manifest.graph_folders {
            Some(assignments) => assignments.clone(),
            None => derive_folders_from_entries(&bundle.manifest.graphs, "graphs"),
        };
        let fit_y_by_x_folders = bundle.manifest.fit_y_by_x_folders.clone();
        let fit_model_folders = bundle.manifest.fit_model_folders.clone();
        let tabulate_folders = bundle.manifest.tabulate_folders.clone();
        let distribution_folders = bundle.manifest.distribution_folders.clone();
        let mut distribution_issues = bundle
            .manifest
            .distribution_issues
            .iter()
            .filter_map(|issue| serde_json::from_value(issue.clone()).ok())
            .collect::<Vec<DistributionIssueV1>>();
        let dataset_ids = {
            let db = staged_state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            db.list_datasets()?
                .into_iter()
                .map(|dataset| dataset.id)
                .collect::<std::collections::HashSet<_>>()
        };
        let distribution_entries = bundle
            .manifest
            .distributions
            .iter()
            .map(|entry| (entry.analysis_id.as_str(), entry))
            .collect::<std::collections::HashMap<_, _>>();
        let distributions = bundle
            .distributions
            .iter()
            .map(|record| match record {
                spprj_archive::DistributionArchiveRecordV1::Parsed(envelope) => {
                    let mut doc = envelope.body.clone();
                    doc.load_status = DistributionLoadStatusV1::Ready;
                    if !dataset_ids.contains(&doc.source_dataset_id) {
                        doc.load_status = DistributionLoadStatusV1::MissingSource;
                        doc.status = "unavailable".to_string();
                        push_distribution_issue(
                            &mut distribution_issues,
                            DistributionIssueV1 {
                            analysis_id: doc.analysis_id.clone(),
                            kind: DistributionLoadStatusV1::MissingSource,
                            message_key: "distribution.issue.missingSource".to_string(),
                            schema_version: doc.schema_version.clone(),
                            source_dataset_id: Some(doc.source_dataset_id.clone()),
                            },
                        );
                    }
                    doc
                }
                spprj_archive::DistributionArchiveRecordV1::UnknownVersion {
                    analysis_id,
                    schema_version,
                    raw_envelope,
                } => {
                    let entry = distribution_entries.get(analysis_id.as_str());
                    let body = raw_envelope.get("body").unwrap_or(raw_envelope);
                    let source_dataset_id = body
                        .get("sourceDatasetId")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    push_distribution_issue(
                        &mut distribution_issues,
                        DistributionIssueV1 {
                        analysis_id: analysis_id.clone(),
                        kind: DistributionLoadStatusV1::UnknownVersion,
                        message_key: "distribution.issue.unknownVersion".to_string(),
                        schema_version: schema_version.clone(),
                            source_dataset_id: (!source_dataset_id.is_empty())
                                .then(|| source_dataset_id.clone()),
                        },
                    );
                    DistributionDocV1 {
                        schema_version: schema_version.clone(),
                        analysis_id: analysis_id.clone(),
                        name: entry.map(|value| value.name.clone()).unwrap_or_default(),
                        source_dataset_id,
                        status: "unavailable".to_string(),
                        config_revision: 1,
                        current_config: body
                            .get("currentConfig")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({})),
                        load_status: DistributionLoadStatusV1::UnknownVersion,
                        raw_envelope: Some(raw_envelope.clone()),
                        raw_text: None,
                    }
                }
                spprj_archive::DistributionArchiveRecordV1::Corrupt {
                    analysis_id,
                    raw_text,
                } => {
                    let entry = distribution_entries.get(analysis_id.as_str());
                    push_distribution_issue(
                        &mut distribution_issues,
                        DistributionIssueV1 {
                        analysis_id: analysis_id.clone(),
                        kind: DistributionLoadStatusV1::Corrupt,
                        message_key: "distribution.issue.corrupt".to_string(),
                        schema_version: "unknown".to_string(),
                        source_dataset_id: None,
                        },
                    );
                    DistributionDocV1 {
                        schema_version: "unknown".to_string(),
                        analysis_id: analysis_id.clone(),
                        name: entry.map(|value| value.name.clone()).unwrap_or_default(),
                        source_dataset_id: String::new(),
                        status: "unavailable".to_string(),
                        config_revision: 1,
                        current_config: serde_json::json!({}),
                        load_status: DistributionLoadStatusV1::Corrupt,
                        raw_envelope: None,
                        raw_text: Some(raw_text.clone()),
                    }
                }
            })
            .collect();
        let derived_formulas = bundle
            .derived_formulas
            .iter()
            .map(|envelope| envelope.body.clone())
            .collect();
        let folders = bundle.manifest.folders.clone();

        // Re-pack graph docs into the opaque JSON shape the frontend
        // understands. The body map stored on disk no longer carries named
        // keys (they live on GraphDoc itself to avoid duplicate JSON keys),
        // so re-inject `id` / `name`. Folder is intentionally NOT injected
        // into the body — it flows via the separate `graphFolders` map.
        let graph_builders = bundle
            .graphs
            .into_iter()
            .map(|mut g| {
                g.body
                    .insert("id".to_string(), serde_json::Value::String(g.id.clone()));
                if !g.name.is_empty() {
                    g.body.insert(
                        "name".to_string(),
                        serde_json::Value::String(g.name.clone()),
                    );
                }
                serde_json::Value::Object(g.body)
            })
            .collect();

        let staged_db = staged_state
            .db
            .into_inner()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let staged_display = staged_state
            .column_display
            .into_inner()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut live_db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut live_display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut live_project = self
            .state
            .project
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *live_db = staged_db;
        *live_display = staged_display;
        *live_project = Some(project.clone());
        if let Some(cb) = &progress_cb {
            cb(total, total, "完成", 0, 0);
        }

        Ok(OpenProjectResult {
            project,
            history: bundle.history,
            snapshots: bundle.snapshots,
            graph_builders,
            fit_y_by_x: bundle.fit_y_by_x,
            fit_models: bundle.fit_models,
            tabulates: bundle.tabulates,
            distributions,
            derived_formulas,
            distribution_issues,
            folders,
            table_folders,
            graph_folders,
            fit_y_by_x_folders,
            fit_model_folders,
            document_name_migrations: Vec::new(),
            dataset_name_migrations,
            requires_migration: false,
            tabulate_folders,
            distribution_folders,
        })
    }

    /// Save the current project state to disk as a ZIP archive using the
    /// streaming writer pipeline.
    pub fn save_project(
        &self,
        request: SaveProjectRequest,
        progress_cb: Option<&SaveProgressCallback<'_>>,
    ) -> Result<ProjectInfo, AppError> {
        self.save_project_with_write_impl(
            request,
            progress_cb,
            |snapshot, destination_path, progress_cb, save_guard| {
                let writer = StreamingProjectWriter::new(self.state, save_guard);
                writer.write(snapshot, destination_path, progress_cb)
            },
        )
    }

    fn save_project_with_write_impl<F>(
        &self,
        request: SaveProjectRequest,
        progress_cb: Option<&SaveProgressCallback<'_>>,
        write_impl: F,
    ) -> Result<ProjectInfo, AppError>
    where
        F: FnOnce(
            &SaveSnapshot,
            &std::path::Path,
            Option<&SaveProgressCallback<'_>>,
            &crate::services::save_coordinator::SaveGuard<'_>,
        ) -> Result<SaveWriteResult, AppError>,
    {
        let save_guard = self.state.save_coordinator.begin_save()?;

        let current_project = self
            .state
            .project
            .read()
            .map_err(|e| AppError::Database(e.to_string()))?
            .clone()
            .ok_or_else(|| AppError::InvalidParam("No project is open".into()))?;

        let destination_path_string = request
            .file_path
            .clone()
            .unwrap_or_else(|| current_project.file_path.clone());
        if destination_path_string.is_empty() {
            return Err(AppError::InvalidParam("Project has no file path".into()));
        }

        let snapshot = self.capture_save_snapshot(current_project.clone(), request.clone())?;
        write_impl(
            &snapshot,
            &snapshot.destination_path,
            progress_cb,
            &save_guard,
        )?;

        let mut project_guard = self
            .state
            .project
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let project = project_guard
            .as_mut()
            .ok_or_else(|| AppError::InvalidParam("No project is open".into()))?;

        if request.file_path.is_some() {
            project.file_path = snapshot.destination_path.to_string_lossy().to_string();
            project.name = snapshot.destination_name;
        }

        Ok(project.clone())
    }

    fn capture_save_snapshot(
        &self,
        current_project: ProjectInfo,
        request: SaveProjectRequest,
    ) -> Result<SaveSnapshot, AppError> {
        let destination_path_string = request
            .file_path
            .clone()
            .unwrap_or_else(|| current_project.file_path.clone());
        let destination_path = std::path::PathBuf::from(destination_path_string);
        let destination_name = if request.file_path.is_some() {
            destination_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(|stem| stem.to_string())
                .unwrap_or_else(|| current_project.name.clone())
        } else {
            current_project.name.clone()
        };

        let (datasets, dataset_generations) = {
            let db = self
                .state
                .db
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            let datasets = db.list_datasets()?;
            let mut dataset_generations = std::collections::HashMap::with_capacity(datasets.len());
            for dataset in &datasets {
                dataset_generations
                    .insert(dataset.id.clone(), db.get_dataset_generation(&dataset.id)?);
            }
            (datasets, dataset_generations)
        };
        let column_display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?
            .clone();

        Ok(SaveSnapshot {
            current_project,
            destination_path,
            destination_name,
            datasets,
            dataset_generations,
            column_display,
            request,
        })
    }

    /// Get current project info
    pub fn get_current_project(&self) -> Result<Option<ProjectInfo>, AppError> {
        let proj = self
            .state
            .project
            .read()
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(proj.clone())
    }

    // ------------------------------------------------------------------
    // Per-dataset compose / restore — used by both project save/load AND
    // the standalone export/import commands. Centralizing these here keeps
    // the on-disk shape of a `.sptb` file in lock-step with what's stored
    // inside the project archive.
    // ------------------------------------------------------------------

    /// Build a `TableDoc` snapshot of a single dataset from the live DB +
    /// in-memory display props.
    pub fn compose_table_doc(&self, dataset_id: &str) -> Result<TableDoc, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let meta = db.get_dataset_meta(dataset_id)?;
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        let mut col_stmt = db.conn().prepare(
            "SELECT column_id, col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let base_columns: Vec<(String, String, String)> = col_stmt
            .query_map(duckdb::params![dataset_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let ds_display = display.get(dataset_id);
        let columns: Vec<TableColumn> = base_columns
            .iter()
            .enumerate()
            .map(|(i, (column_id, name, col_type))| {
                let dp = ds_display.and_then(|v| v.iter().find(|p| p.col_index == i));
                TableColumn {
                    column_id: Some(column_id.clone()),
                    name: name.clone(),
                    col_type: col_type.clone(),
                    width: dp.and_then(|p| p.width),
                    format: dp
                        .and_then(|p| p.format.as_ref())
                        .map(|f| TableColumnFormat {
                            kind: f.kind.clone(),
                            decimals: f.decimals,
                            currency: f.currency.clone(),
                        }),
                    extras: dp.and_then(|p| p.extras.clone()),
                }
            })
            .collect();

        let col_names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();

        // SELECT _row_id + every visible column. _row_id stays at index 0 in
        // the saved row arrays so restore can write it back verbatim.
        let select_cols = std::iter::once("\"_row_id\"".to_string())
            .chain(
                columns
                    .iter()
                    .map(|column| archive_export_expression(&column.name, &column.col_type)),
            )
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT {} FROM \"{}\" ORDER BY \"_row_id\"",
            select_cols, table_name
        );
        let mut stmt = db.conn().prepare(&query)?;
        let total_cols = 1 + col_names.len();

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut result_rows = stmt.query([])?;
        while let Some(row) = result_rows.next()? {
            let mut row_values = Vec::with_capacity(total_cols);
            let row_id: DuckValue = row.get(0)?;
            row_values.push(archive_cell_to_json(&row_id, "BIGINT")?);
            for (column_index, column) in columns.iter().enumerate() {
                let value: DuckValue = row.get(column_index + 1)?;
                row_values.push(archive_cell_to_json(&value, &column.col_type)?);
            }
            rows.push(row_values);
        }

        Ok(TableDoc {
            id: dataset_id.to_string(),
            name: meta.name,
            source_type: meta.source_type,
            version: "3".to_string(),
            columns,
            rows,
        })
    }

    /// Insert (or skip if already present) a `TableDoc` into the live DB and
    /// register its column display props. Returns the dataset id actually used
    /// (caller may want a fresh id when importing — see `import_table`).
    pub fn restore_table_doc(&self, doc: &TableDoc) -> Result<String, AppError> {
        self.restore_table_doc_with_progress(doc, None)
    }

    pub fn restore_table_doc_with_progress(
        &self,
        doc: &TableDoc,
        progress_cb: Option<&dyn Fn(usize, usize)>,
    ) -> Result<String, AppError> {
        if doc.version != "1" && doc.version != "2" && doc.version != "3" {
            return Err(AppError::InvalidParam(format!(
                "unsupported table document version: {}",
                doc.version
            )));
        }

        let expected_row_width = doc.columns.len() + 1;
        if doc.rows.iter().any(|row| row.len() != expected_row_width) {
            return Err(AppError::InvalidParam(format!(
                "table rows must contain exactly {expected_row_width} values"
            )));
        }

        let mut row_ids = std::collections::HashSet::with_capacity(doc.rows.len());
        for row in &doc.rows {
            let row_id = row[0]
                .as_i64()
                .ok_or_else(|| AppError::InvalidParam("table row IDs must be integers".into()))?;
            if row_id <= 0 {
                return Err(AppError::InvalidParam(
                    "table row IDs must be positive".into(),
                ));
            }
            if !row_ids.insert(row_id) {
                return Err(AppError::InvalidParam(
                    "table row IDs must be unique".into(),
                ));
            }
        }

        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let col_names: Vec<String> = doc.columns.iter().map(|c| c.name.clone()).collect();
        let col_types: Vec<String> = doc.columns.iter().map(|c| c.col_type.clone()).collect();
        db.conn().execute_batch("BEGIN TRANSACTION")?;
        let restore_result = (|| -> Result<(), AppError> {
            db.create_empty_table(&doc.id, &doc.name, &col_names, &col_types)?;
            for (index, column) in doc.columns.iter().enumerate() {
                if let Some(column_id) = &column.column_id {
                    db.conn().execute(
                        "UPDATE _meta_columns SET column_id = $1 WHERE dataset_id = $2 AND col_index = $3",
                        duckdb::params![column_id, &doc.id, index as i32],
                    )?;
                }
            }
            let canonical_columns = db.get_user_columns(&doc.id)?;

            if !doc.rows.is_empty() {
                let table_name = format!("dataset_{}", doc.id.replace('-', "_"));
                let mut appender = db.conn().appender(&table_name)?;
                let rows_total = doc.rows.len();

                for (row_index, row) in doc.rows.iter().enumerate() {
                    let values = row
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            let column_type = index
                                .checked_sub(1)
                                .map(|column_index| canonical_columns[column_index].1.as_str());
                            let decode_v2_tag = index > 0
                                && (doc.version == "2" || doc.version == "3")
                                && !is_archive_scalar_type(&canonical_columns[index - 1].1);
                            json_to_duckdb_param(value, decode_v2_tag, column_type)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    appender.append_row(appender_params_from_iter(values))?;
                    let rows_done = row_index + 1;
                    if rows_done % 5_000 == 0 || rows_done == rows_total {
                        if let Some(cb) = progress_cb {
                            cb(rows_done, rows_total);
                        }
                    }
                }
                appender.flush()?;
            }

            let table_ident = quote_identifier(&format!("dataset_{}", doc.id.replace('-', "_")));
            let row_count: i64 =
                db.conn()
                    .query_row(&format!("SELECT COUNT(*) FROM {table_ident}"), [], |row| {
                        row.get(0)
                    })?;
            db.conn().execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                duckdb::params![row_count, doc.id],
            )?;
            Ok(())
        })();

        match restore_result {
            Ok(()) => db.conn().execute_batch("COMMIT")?,
            Err(error) => {
                let _ = db.conn().execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        // Re-register column display props.
        let mut display_props: Vec<ColumnDisplayProps> = Vec::new();
        for (i, col) in doc.columns.iter().enumerate() {
            if col.width.is_some() || col.format.is_some() || col.extras.is_some() {
                display_props.push(ColumnDisplayProps {
                    col_index: i,
                    width: col.width,
                    format: col.format.as_ref().map(|f| ColumnFormatInfo {
                        kind: f.kind.clone(),
                        decimals: f.decimals,
                        currency: f.currency.clone(),
                    }),
                    extras: col.extras.clone(),
                });
            }
        }
        if !display_props.is_empty() {
            let mut display = self
                .state
                .column_display
                .lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            display.insert(doc.id.clone(), display_props);
        }

        Ok(doc.id.clone())
    }

    // ------------------------------------------------------------------
    // Standalone .sptb / .spgh IO — for "share / export single table",
    // "import a .sptb into the current project", etc.
    // ------------------------------------------------------------------

    /// Export a single dataset to a standalone `.sptb` file on disk.
    pub fn export_table(&self, dataset_id: &str, file_path: &str) -> Result<(), AppError> {
        let doc = self.compose_table_doc(dataset_id)?;
        spprj_archive::write_table_file(&doc, file_path)
    }

    /// Export multiple datasets as `.sptb` files packaged into a ZIP archive.
    /// Each entry in `archive_paths` maps a dataset id to the `.sptb` file's
    /// path inside the zip (the `.sptb` extension is added automatically and
    /// duplicates are auto-suffixed with ` (2)`, ` (3)`, …). Datasets not
    /// present in the map fall back to the dataset's plain name at the zip
    /// root. Per issue #7 the `.sptb` body itself carries no folder info —
    /// the folder is encoded purely by the file's path inside the zip.
    pub fn export_tables_sptb_zip(
        &self,
        dataset_ids: &[String],
        archive_paths: &std::collections::HashMap<String, String>,
        output_path: &str,
    ) -> Result<(), AppError> {
        use std::io::Write;

        if dataset_ids.is_empty() {
            return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
        }
        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

        for id in dataset_ids {
            // Skip silently if the id no longer exists rather than aborting
            // the whole export — a half-stale UI list shouldn't lose the
            // rest of the bundle.
            let doc = match self.compose_table_doc(id) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let bytes =
                serde_json::to_vec_pretty(&doc).map_err(|e| AppError::FileIO(e.to_string()))?;
            let raw = archive_paths
                .get(id)
                .cloned()
                .unwrap_or_else(|| doc.name.clone());
            let safe = sanitize_zip_path(&raw);
            let entry = dedupe_zip_path(&safe, "sptb", &mut used);
            zip.start_file(&entry, options)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            zip.write_all(&bytes)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }
        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    }

    /// Import a `.sptb` file from disk into the current project. Always
    /// allocates a fresh dataset id to avoid colliding with anything already
    /// loaded; returns the new id. Per issue #7 the `.sptb` body carries no
    /// folder info — the caller decides where to place the imported table
    /// (defaults to project root).
    pub fn import_table(&self, file_path: &str) -> Result<String, AppError> {
        let mut doc = spprj_archive::read_table_file(file_path)?;
        // Re-issue id to avoid collision with existing datasets in the project.
        let new_id = uuid::Uuid::new_v4().to_string();
        doc.id = new_id.clone();
        self.restore_table_doc(&doc)?;
        Ok(new_id)
    }

    /// Export an arbitrary graph builder config (opaque to backend) as a
    /// standalone `.spgh` file on disk. Per issue #7 the body is folder-free.
    pub fn export_graph(&self, graph: serde_json::Value, file_path: &str) -> Result<(), AppError> {
        let (id, name, body) = lift_graph_meta(graph);
        let doc = GraphDoc {
            id,
            name,
            version: "1".to_string(),
            body,
        };
        spprj_archive::write_graph_file(&doc, file_path)
    }

    /// Read a `.spgh` file off disk and return its body as the same opaque
    /// JSON shape the frontend uses for graph_builders. `id` and `name` are
    /// re-injected into the body for frontend convenience; folder is NOT
    /// (the imported graph lands wherever the caller decides).
    pub fn import_graph(&self, file_path: &str) -> Result<serde_json::Value, AppError> {
        let doc = spprj_archive::read_graph_file(file_path)?;
        let mut body = doc.body;
        body.insert("id".to_string(), serde_json::Value::String(doc.id));
        if !doc.name.is_empty() {
            body.insert("name".to_string(), serde_json::Value::String(doc.name));
        }
        Ok(serde_json::Value::Object(body))
    }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn json_to_duckdb_param(
    value: &serde_json::Value,
    decode_v2_tag: bool,
    column_type: Option<&str>,
) -> Result<DuckValue, AppError> {
    match value {
        serde_json::Value::Null => Ok(DuckValue::Null),
        serde_json::Value::Bool(value) => Ok(DuckValue::Boolean(*value)),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(DuckValue::BigInt(value))
            } else if let Some(value) = value.as_u64() {
                Ok(DuckValue::UBigInt(value))
            } else {
                Ok(DuckValue::Double(value.as_f64().unwrap_or_default()))
            }
        }
        serde_json::Value::String(value) => archive_string_param(value, column_type),
        serde_json::Value::Object(object) if decode_v2_tag && object.len() == 1 => {
            if let Some(value) = object
                .get("$duckdbValue")
                .and_then(serde_json::Value::as_str)
            {
                archive_string_param(value, column_type)
            } else {
                Ok(DuckValue::Text(value.to_string()))
            }
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            Ok(DuckValue::Text(value.to_string()))
        }
    }
}

fn archive_string_param(value: &str, column_type: Option<&str>) -> Result<DuckValue, AppError> {
    if column_type.is_some_and(|column_type| column_type.trim().eq_ignore_ascii_case("BLOB")) {
        if !value.len().is_multiple_of(2) {
            return Err(AppError::InvalidParam(
                "archived BLOB hex has odd length".into(),
            ));
        }
        let bytes = (0..value.len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| {
                    AppError::InvalidParam("archived BLOB contains invalid hex".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DuckValue::Blob(bytes))
    } else {
        Ok(DuckValue::Text(value.to_string()))
    }
}

/// Convert a list of opaque graph-builder JSON objects (frontend shape) into
/// `GraphDoc`s suitable for the archive. Ensures every doc has a stable id
/// and preserves the display name so the writer can place files at the right
/// paths inside the archive. Folder routing is handled OUT-OF-BAND via the
/// `graph_folders` map (issue #7) — any legacy in-body `folder` field is
/// silently stripped by `lift_graph_meta`.
fn compose_graph_docs(raw: Vec<serde_json::Value>) -> Vec<GraphDoc> {
    raw.into_iter()
        .enumerate()
        .map(|(idx, value)| {
            let (id, name, body) = lift_graph_meta(value);
            let id = if id.is_empty() {
                format!("graph_{}", idx)
            } else {
                id
            };
            GraphDoc {
                id,
                name,
                version: "1".to_string(),
                body,
            }
        })
        .collect()
}

/// Pull `id` (or `builderId`) and `name` out of an opaque graph-builder
/// object. id / name / version / folder are *removed* from the returned body
/// so the GraphDoc that flattens it won't emit duplicate JSON keys on
/// serialization, and so legacy in-body folder hints can never override the
/// path-derived folder.
fn lift_graph_meta(
    raw: serde_json::Value,
) -> (String, String, serde_json::Map<String, serde_json::Value>) {
    let mut map = match raw {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            map.remove("builderId")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_default();
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    map.remove("version");
    map.remove("folder"); // issue #7: folder lives only on archive paths.
    (id, name, map)
}

fn derive_folders_from_entries<T>(
    entries: &[T],
    container_prefix: &str,
) -> std::collections::HashMap<String, String>
where
    T: EntryFolderRef,
{
    let mut folders = std::collections::HashMap::new();
    for entry in entries {
        if let Some(folder) = folder_from_entry_path(entry.file(), container_prefix) {
            folders.insert(entry.id().to_string(), folder);
        }
    }
    folders
}

fn folder_from_entry_path(file: &str, container_prefix: &str) -> Option<String> {
    let parent = spprj_archive::parent_folder(file)?;
    if parent == container_prefix {
        None
    } else if parent.starts_with(&format!("{}/", container_prefix)) {
        let stripped = &parent[container_prefix.len() + 1..];
        if stripped.is_empty() {
            None
        } else {
            Some(stripped.to_string())
        }
    } else if parent.is_empty() {
        None
    } else {
        Some(parent)
    }
}

trait EntryFolderRef {
    fn id(&self) -> &str;
    fn file(&self) -> &str;
}

impl EntryFolderRef for spprj_archive::TableEntryRef {
    fn id(&self) -> &str {
        &self.id
    }
    fn file(&self) -> &str {
        &self.file
    }
}

impl EntryFolderRef for spprj_archive::GraphEntryRef {
    fn id(&self) -> &str {
        &self.id
    }
    fn file(&self) -> &str {
        &self.file
    }
}

fn chrono_now() -> String {
    // Simple UTC timestamp without chrono dependency
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_default()
}

// Mark the bundle type as used: `ProjectBundle` is constructed exclusively via
// `spprj_archive::build_bundle` and consumed by `write_project_archive` /
// `read_project_file`, so it's referenced here only to silence dead-code
// analysis when the export commands are pruned by feature flags.
#[allow(dead_code)]
fn _bundle_compile_check(_b: ProjectBundle) {}

/// Sanitize a path destined for a ZIP archive. Forward slashes are kept as
/// folder separators; per-segment characters illegal on Windows are replaced
/// with `_`; leading/trailing dots and whitespace are trimmed per segment.
fn sanitize_zip_path(raw: &str) -> String {
    let parts: Vec<String> = raw
        .split('/')
        .map(|seg| {
            seg.replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                .trim()
                .trim_matches('.')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        "Untitled".to_string()
    } else {
        parts.join("/")
    }
}

/// Suffix `base.ext` with ` (2)`, ` (3)`, … until unique within `used`.
fn dedupe_zip_path(base: &str, ext: &str, used: &mut std::collections::HashSet<String>) -> String {
    let mut candidate = format!("{}.{}", base, ext);
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({}).{}", base, n, ext);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn normalize_duplicate_dataset_names(docs: &mut [TableDoc]) -> Vec<DatasetNameMigration> {
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut migrations = Vec::new();

    for doc in docs.iter_mut() {
        let original_name = doc.name.clone();
        if used_names.insert(original_name.to_lowercase()) {
            continue;
        }

        let mut suffix = 2;
        loop {
            let candidate = format!("{} ({})", original_name, suffix);
            if used_names.insert(candidate.to_lowercase()) {
                doc.name = candidate.clone();
                migrations.push(DatasetNameMigration {
                    dataset_id: doc.id.clone(),
                    old_name: original_name.clone(),
                    new_name: candidate,
                });
                break;
            }
            suffix += 1;
        }
    }

    migrations
}

#[cfg(test)]
mod tests {
    use super::{folder_from_entry_path, normalize_duplicate_dataset_names, ProjectService};
    use crate::error::AppError;
    use crate::models::project::ProjectInfo;
    use crate::models::save::SaveProjectRequest;
    use crate::models::table::{ColumnDisplayProps, ColumnFormatInfo};
    use crate::services::spprj_archive::{self, TableColumn, TableDoc};
    use crate::state::AppState;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};

    fn source_between(source: &str, start: &str, end: &str) -> String {
        let start_idx = source
            .find(start)
            .unwrap_or_else(|| panic!("missing start marker: {start}"));
        let rest = &source[start_idx..];
        let end_idx = rest
            .find(end)
            .unwrap_or_else(|| panic!("missing end marker: {end}"));
        rest[..end_idx].to_string()
    }

    fn table_doc(id: &str, name: &str) -> TableDoc {
        TableDoc {
            id: id.into(),
            name: name.into(),
            source_type: "manual".into(),
            version: "1".into(),
            columns: vec![],
            rows: vec![],
        }
    }

    fn save_request(
        file_path: Option<String>,
        history: Vec<serde_json::Value>,
        snapshots: Vec<serde_json::Value>,
        graph_builders: Vec<serde_json::Value>,
        fit_y_by_x: Vec<serde_json::Value>,
        tabulates: Vec<serde_json::Value>,
        folders: Vec<String>,
        table_folders: HashMap<String, String>,
        graph_folders: HashMap<String, String>,
        fit_y_by_x_folders: HashMap<String, String>,
        tabulate_folders: HashMap<String, String>,
    ) -> SaveProjectRequest {
        SaveProjectRequest {
            file_path,
            history,
            snapshots,
            graph_builders,
            fit_y_by_x,
            fit_models: Vec::new(),
            tabulates,
            distributions: Vec::new(),
            derived_formulas: Vec::new(),
            distribution_issues: Vec::new(),
            folders,
            table_folders,
            graph_folders,
            fit_y_by_x_folders,
            fit_model_folders: HashMap::new(),
            tabulate_folders,
            distribution_folders: HashMap::new(),
        }
    }

    fn empty_save_request(file_path: Option<String>) -> SaveProjectRequest {
        save_request(
            file_path,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
    }

    #[test]
    fn legacy_container_roots_do_not_become_ui_folders() {
        assert_eq!(folder_from_entry_path("tables/123.sptb", "tables"), None);
        assert_eq!(folder_from_entry_path("graphs/456.spgh", "graphs"), None);
    }

    #[test]
    fn direct_v2_folder_names_do_not_match_legacy_container_prefixes() {
        assert_eq!(
            folder_from_entry_path("tablesBackup/123.sptb", "tables"),
            Some("tablesBackup".to_string())
        );
        assert_eq!(
            folder_from_entry_path("graphsArchive/456.spgh", "graphs"),
            Some("graphsArchive".to_string())
        );
    }

    #[test]
    fn nested_legacy_paths_still_derive_user_folders() {
        assert_eq!(
            folder_from_entry_path("tables/Raw/123.sptb", "tables"),
            Some("Raw".to_string())
        );
        assert_eq!(
            folder_from_entry_path("graphs/Reports/456.spgh", "graphs"),
            Some("Reports".to_string())
        );
    }

    #[test]
    fn v2_paths_keep_direct_parent_folders() {
        assert_eq!(
            folder_from_entry_path("Raw/123.sptb", "tables"),
            Some("Raw".to_string())
        );
        assert_eq!(
            folder_from_entry_path("Reports/456.spgh", "graphs"),
            Some("Reports".to_string())
        );
    }

    #[test]
    fn normalizes_legacy_duplicate_dataset_names_in_manifest_order() {
        let mut docs = vec![
            table_doc("one", "Sales"),
            table_doc("two", "sales"),
            table_doc("three", "Sales"),
        ];

        let migrations = normalize_duplicate_dataset_names(&mut docs);

        assert_eq!(docs[0].name, "Sales");
        assert_eq!(docs[1].name, "sales (2)");
        assert_eq!(docs[2].name, "Sales (3)");
        assert_eq!(migrations.len(), 2);
        assert_eq!(migrations[0].dataset_id, "two");
        assert_eq!(migrations[0].old_name, "sales");
        assert_eq!(migrations[0].new_name, "sales (2)");
        assert_eq!(migrations[1].dataset_id, "three");
        assert_eq!(migrations[1].old_name, "Sales");
        assert_eq!(migrations[1].new_name, "Sales (3)");
    }

    #[test]
    fn complex_query_table_document_restores_without_losing_values() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_table_from_sql_query(
                "complex-id",
                "Complex",
                "SELECT 12.34::DECIMAL(12,2) AS amount, TIMESTAMP '2026-08-13 10:11:12' AS created_at, [1, 2]::INTEGER[] AS numbers, struct_pack(label := 'alpha', score := 7) AS info, from_hex('dead') AS payload",
            )
            .unwrap();
        }

        let service = ProjectService::new(&state);
        let doc = service.compose_table_doc("complex-id").unwrap();
        state.reset_db().unwrap();
        service.restore_table_doc(&doc).unwrap();

        let db = state.db.lock().unwrap();
        let restored: (String, String, String, String, String) = db
            .conn()
            .query_row(
                "SELECT CAST(amount AS VARCHAR), CAST(created_at AS VARCHAR), CAST(numbers AS VARCHAR), CAST(info AS VARCHAR), hex(payload) FROM dataset_complex_id",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();

        assert_eq!(restored.0, "12.34");
        assert_eq!(restored.1, "2026-08-13 10:11:12");
        assert_eq!(restored.2, "[1, 2]");
        assert_eq!(restored.3, "{'label': alpha, 'score': 7}");
        assert_eq!(restored.4, "DEAD");

        let preview = db
            .execute_sql_query(
                "SELECT amount, created_at, numbers, info, payload FROM Complex",
                1,
                10,
            )
            .unwrap();
        assert_eq!(preview.total_rows, 1);
        assert_eq!(preview.rows[0][0], serde_json::json!("12.34"));
        assert_eq!(preview.rows[0][2], serde_json::json!([1, 2]));
        assert_eq!(
            preview.rows[0][3],
            serde_json::json!({"label": "alpha", "score": 7})
        );
        assert_eq!(preview.rows[0][4], serde_json::json!("0xdead"));
    }

    #[test]
    fn imported_csv_saves_into_project_archive() {
        let state = AppState::new().unwrap();
        let file_path = std::env::temp_dir().join(format!(
            "stats_playground_project_import_{}.csv",
            uuid::Uuid::new_v4()
        ));
        let project_path = std::env::temp_dir().join(format!(
            "stats_playground_csv_project_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&file_path, "name,amount\nalpha,10\nbeta,20\n").unwrap();
        {
            let db = state.db.lock().unwrap();
            db.import_csv("csv-project-id", "CSV Project", file_path.to_str().unwrap())
                .unwrap();
        }
        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "CSV Project".into(),
            file_path: String::new(),
            created_at: "2026-08-19T00:00:00Z".into(),
        });

        let service = ProjectService::new(&state);
        let doc = service.compose_table_doc("csv-project-id");
        let _ = std::fs::remove_file(file_path);
        let doc = doc.unwrap();

        assert_eq!(doc.columns.len(), 2);
        assert_eq!(doc.columns[0].name, "name");
        assert_eq!(doc.columns[1].name, "amount");
        assert_eq!(
            doc.rows,
            vec![
                vec![
                    serde_json::json!(1),
                    serde_json::json!("alpha"),
                    serde_json::json!(10)
                ],
                vec![
                    serde_json::json!(2),
                    serde_json::json!("beta"),
                    serde_json::json!(20)
                ],
            ]
        );

        service
            .save_project(
                empty_save_request(project_path.to_str().map(|path| path.to_string())),
                None,
            )
            .unwrap();
        let bundle = spprj_archive::read_project_file(project_path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(project_path);

        assert_eq!(bundle.tables.len(), 1);
        assert_eq!(bundle.tables[0].id, "csv-project-id");
        assert_eq!(bundle.tables[0].rows, doc.rows);
    }

    #[test]
    fn large_table_restore_reports_batched_progress_and_preserves_values() {
        let state = AppState::new().unwrap();
        let row_count = 12_001usize;
        let doc = TableDoc {
            id: "large-restore".into(),
            name: "Large Restore".into(),
            source_type: "manual".into(),
            version: "2".into(),
            columns: vec![TableColumn {
                column_id: None,
                name: "value".into(),
                col_type: "BIGINT".into(),
                width: None,
                format: None,
                extras: None,
            }],
            rows: (1..=row_count)
                .map(|value| vec![serde_json::json!(value), serde_json::json!(value * 10)])
                .collect(),
        };
        let progress = RefCell::new(Vec::new());

        ProjectService::new(&state)
            .restore_table_doc_with_progress(
                &doc,
                Some(&|rows_done, rows_total| {
                    progress.borrow_mut().push((rows_done, rows_total));
                }),
            )
            .unwrap();

        assert_eq!(
            progress.into_inner(),
            vec![
                (5_000, row_count),
                (10_000, row_count),
                (row_count, row_count)
            ]
        );
        let db = state.db.lock().unwrap();
        let first: (i64, i64) = db
            .conn()
            .query_row(
                "SELECT _row_id, value FROM dataset_large_restore ORDER BY _row_id LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let last: (i64, i64) = db
            .conn()
            .query_row(
                "SELECT _row_id, value FROM dataset_large_restore ORDER BY _row_id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(first, (1, 10));
        assert_eq!(last, (row_count as i64, (row_count * 10) as i64));
    }

    #[test]
    fn restore_accepts_v3_table_docs_with_tagged_cells() {
        let state = AppState::new().unwrap();
        let doc = TableDoc {
            id: "v3-table".into(),
            name: "V3 Table".into(),
            source_type: "manual".into(),
            version: "3".into(),
            columns: vec![TableColumn {
                column_id: None,
                name: "order_date".into(),
                col_type: "DATE".into(),
                width: None,
                format: None,
                extras: None,
            }],
            rows: vec![vec![
                serde_json::json!(1),
                serde_json::json!({ "$duckdbValue": "2025-05-10" }),
            ]],
        };

        ProjectService::new(&state).restore_table_doc(&doc).unwrap();

        let db = state.db.lock().unwrap();
        let restored: String = db
            .conn()
            .query_row(
                "SELECT CAST(order_date AS VARCHAR) FROM dataset_v3_table WHERE _row_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored, "2025-05-10");
    }

    #[test]
    fn restore_rejects_non_positive_and_duplicate_row_ids() {
        for rows in [
            vec![vec![serde_json::json!(0), serde_json::json!(10)]],
            vec![
                vec![serde_json::json!(1), serde_json::json!(10)],
                vec![serde_json::json!(1), serde_json::json!(20)],
            ],
        ] {
            let state = AppState::new().unwrap();
            let doc = TableDoc {
                id: "invalid-row-ids".into(),
                name: "Invalid Row IDs".into(),
                source_type: "manual".into(),
                version: "2".into(),
                columns: vec![TableColumn {
                    column_id: None,
                    name: "value".into(),
                    col_type: "BIGINT".into(),
                    width: None,
                    format: None,
                    extras: None,
                }],
                rows,
            };

            let error = ProjectService::new(&state)
                .restore_table_doc(&doc)
                .unwrap_err();
            assert!(matches!(error, AppError::InvalidParam(_)));
            assert!(state.db.lock().unwrap().list_datasets().unwrap().is_empty());
        }
    }

    #[test]
    fn ordinary_save_preserves_manifest_project_name() {
        let state = AppState::new().unwrap();
        let destination = std::env::temp_dir().join(format!(
            "renamed_project_file_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Quarterly".into(),
            file_path: destination.to_string_lossy().to_string(),
            created_at: "2026-08-24T00:00:00Z".into(),
        });

        ProjectService::new(&state)
            .save_project(empty_save_request(None), None)
            .unwrap();

        let bundle = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
        assert_eq!(bundle.manifest.name, "Quarterly");
        assert_eq!(
            state.project.read().unwrap().as_ref().unwrap().name,
            "Quarterly"
        );

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn v1_struct_cell_that_looks_like_v2_tag_restores_as_struct() {
        let state = AppState::new().unwrap();
        let service = ProjectService::new(&state);
        let doc = TableDoc {
            id: "legacy-struct".into(),
            name: "Legacy Struct".into(),
            source_type: "manual".into(),
            version: "1".into(),
            columns: vec![TableColumn {
                column_id: None,
                name: "payload".into(),
                col_type: "STRUCT(\"$duckdbValue\" VARCHAR)".into(),
                width: None,
                format: None,
                extras: None,
            }],
            rows: vec![vec![
                serde_json::json!(1),
                serde_json::json!({"$duckdbValue": "original"}),
            ]],
        };

        service.restore_table_doc(&doc).unwrap();

        let db = state.db.lock().unwrap();
        let value: String = db
            .conn()
            .query_row(
                "SELECT payload.\"$duckdbValue\" FROM dataset_legacy_struct",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "original");
    }

    #[test]
    fn malformed_table_document_does_not_leave_partial_dataset() {
        let state = AppState::new().unwrap();
        let service = ProjectService::new(&state);
        let mut doc = table_doc("malformed-id", "Malformed");
        doc.columns.push(TableColumn {
            column_id: None,
            name: "value".into(),
            col_type: "INTEGER".into(),
            width: None,
            format: None,
            extras: None,
        });
        doc.rows.push(vec![serde_json::json!(1)]);

        assert!(service.restore_table_doc(&doc).is_err());

        let db = state.db.lock().unwrap();
        assert!(db.get_dataset_meta("malformed-id").is_err());
    }

    #[test]
    fn unsupported_table_document_version_is_rejected_without_mutation() {
        let state = AppState::new().unwrap();
        let service = ProjectService::new(&state);
        let mut doc = table_doc("future-id", "Future");
        doc.version = "4".into();

        assert!(matches!(
            service.restore_table_doc(&doc),
            Err(crate::error::AppError::InvalidParam(_))
        ));
        let db = state.db.lock().unwrap();
        assert!(db.get_dataset_meta("future-id").is_err());
    }

    #[test]
    fn save_project_round_trips_complex_values_and_project_metadata() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_table_from_sql_query(
                "preserve-id",
                "Preserve Fixture",
                "SELECT 1 AS row_num, NULL::BLOB AS payload, NULL::DECIMAL(12,2) AS amount, NULL::TIMESTAMP AS created_at, NULL::INTEGER[] AS numbers, NULL::STRUCT(label VARCHAR, score INTEGER) AS info \
                 UNION ALL \
                 SELECT 2 AS row_num, from_hex('DEADBEEF') AS payload, 1234.56::DECIMAL(12,2) AS amount, TIMESTAMP '2026-08-21 01:02:03' AS created_at, [3, 4, 5]::INTEGER[] AS numbers, struct_pack(label := 'beta', score := 9) AS info",
            )
            .unwrap();
        }

        let mut extras = BTreeMap::new();
        extras.insert("unit".to_string(), serde_json::json!("USD"));
        extras.insert(
            "notes".to_string(),
            serde_json::json!({"precision": "cents"}),
        );
        state.column_display.lock().unwrap().insert(
            "preserve-id".to_string(),
            vec![
                ColumnDisplayProps {
                    col_index: 2,
                    width: Some(180.0),
                    format: Some(ColumnFormatInfo {
                        kind: "currency".into(),
                        decimals: Some(2),
                        currency: Some("USD".into()),
                    }),
                    extras: Some(extras),
                },
                ColumnDisplayProps {
                    col_index: 3,
                    width: Some(220.0),
                    format: Some(ColumnFormatInfo {
                        kind: "datetime".into(),
                        decimals: None,
                        currency: None,
                    }),
                    extras: None,
                },
            ],
        );

        let project_path = std::env::temp_dir().join(format!(
            "stats_playground_save_preserve_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Save Preserve".into(),
            file_path: project_path.to_string_lossy().to_string(),
            created_at: "2026-08-21T00:00:00Z".into(),
        });

        let history = vec![serde_json::json!({
            "kind": "edit",
            "datasetId": "preserve-id",
            "description": "Updated amount",
        })];
        let snapshots = vec![serde_json::json!({
            "id": "snapshot-1",
            "datasetId": "preserve-id",
            "rows": [1, 2],
        })];
        let graph_builders = vec![serde_json::json!({
            "id": "graph-1",
            "name": "Amount Trend",
            "graphType": "line",
            "xField": "row_num",
            "yField": "amount",
            "meta": { "owner": "qa" }
        })];
        let fit_y_by_x = vec![serde_json::json!({
            "id": "fit-1",
            "sourceDatasetId": "preserve-id",
            "response": { "name": "amount", "type": "continuous" },
            "factor": { "name": "category", "type": "nominal" }
        })];
        let tabulates = vec![serde_json::json!({
            "id": "tab-1",
            "name": "Summary",
            "sourceDatasetId": "preserve-id",
            "rowFields": ["row_num"],
            "columnFields": [],
            "statistics": ["sum"]
        })];
        let folders = vec!["Analysis".to_string(), "Analysis/Yearly".to_string()];
        let table_folders =
            HashMap::from([("preserve-id".to_string(), "Analysis/Yearly".to_string())]);
        let graph_folders = HashMap::from([("graph-1".to_string(), "Analysis".to_string())]);
        let fit_y_by_x_folders = HashMap::from([("fit-1".to_string(), "Analysis".to_string())]);
        let tabulate_folders =
            HashMap::from([("tab-1".to_string(), "Analysis/Yearly".to_string())]);

        let service = ProjectService::new(&state);
        service
            .save_project(
                save_request(
                    None,
                    history.clone(),
                    snapshots.clone(),
                    graph_builders.clone(),
                    fit_y_by_x.clone(),
                    tabulates.clone(),
                    folders.clone(),
                    table_folders.clone(),
                    graph_folders.clone(),
                    fit_y_by_x_folders.clone(),
                    tabulate_folders.clone(),
                ),
                None,
            )
            .unwrap();

        let reopened_state = AppState::new().unwrap();
        let reopened = ProjectService::new(&reopened_state)
            .open_project(project_path.to_str().unwrap(), None)
            .unwrap();

        assert_eq!(reopened.history, history);
        assert_eq!(reopened.snapshots, snapshots);
        assert_eq!(reopened.graph_builders, graph_builders);
        assert_eq!(reopened.fit_y_by_x, fit_y_by_x);
        assert_eq!(reopened.tabulates, tabulates);
        assert_eq!(reopened.folders, folders);
        assert_eq!(reopened.table_folders, table_folders);
        assert_eq!(reopened.graph_folders, graph_folders);
        assert_eq!(reopened.fit_y_by_x_folders, fit_y_by_x_folders);
        assert_eq!(reopened.tabulate_folders, tabulate_folders);
        assert!(reopened.document_name_migrations.is_empty());
        assert!(!reopened.requires_migration);

        let restored_display = reopened_state.column_display.lock().unwrap();
        let restored_props = restored_display.get("preserve-id").unwrap();
        assert_eq!(restored_props.len(), 2);
        assert_eq!(restored_props[0].col_index, 2);
        assert_eq!(restored_props[0].width, Some(180.0));
        assert_eq!(restored_props[0].format.as_ref().unwrap().kind, "currency");
        assert_eq!(
            restored_props[0]
                .extras
                .as_ref()
                .and_then(|extras| extras.get("unit")),
            Some(&serde_json::json!("USD"))
        );

        let db = reopened_state.db.lock().unwrap();
        let restored: Vec<(
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = {
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT _row_id, hex(payload), CAST(amount AS VARCHAR), CAST(created_at AS VARCHAR), CAST(numbers AS VARCHAR), CAST(info AS VARCHAR) FROM dataset_preserve_id ORDER BY _row_id",
                )
                .unwrap();
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };

        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0], (1, None, None, None, None, None));
        assert_eq!(restored[1].0, 2);
        assert_eq!(restored[1].1.as_deref(), Some("DEADBEEF"));
        assert_eq!(restored[1].2.as_deref(), Some("1234.56"));
        assert_eq!(restored[1].3.as_deref(), Some("2026-08-21 01:02:03"));
        assert_eq!(restored[1].4.as_deref(), Some("[3, 4, 5]"));
        assert_eq!(
            restored[1].5.as_deref(),
            Some("{'label': beta, 'score': 9}")
        );

        let preview = db
            .execute_sql_query(
                "SELECT payload, amount, created_at, numbers, info FROM \"Preserve Fixture\" ORDER BY row_num",
                1,
                2,
            )
            .unwrap();
        assert_eq!(preview.total_rows, 2);
        assert_eq!(preview.rows[0][0], serde_json::Value::Null);
        assert_eq!(preview.rows[1][0], serde_json::json!("0xdeadbeef"));
        assert_eq!(preview.rows[1][1], serde_json::json!("1234.56"));
        assert_eq!(preview.rows[1][3], serde_json::json!([3, 4, 5]));
        assert_eq!(
            preview.rows[1][4],
            serde_json::json!({"label": "beta", "score": 9})
        );

        let _ = std::fs::remove_file(project_path);
    }

    #[test]
    fn save_project_failure_preserves_existing_archive_bytes() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.seed_benchmark_table("failure-id", "Failure Fixture", 10, 4)
                .unwrap();
        }

        let project_path = std::env::temp_dir().join(format!(
            "stats_playground_save_failure_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Failure Fixture".into(),
            file_path: project_path.to_string_lossy().to_string(),
            created_at: "2026-08-21T00:00:00Z".into(),
        });

        let service = ProjectService::new(&state);
        service
            .save_project(empty_save_request(None), None)
            .unwrap();

        let before = std::fs::read(&project_path).unwrap();
        let invalid_save_as_path = std::env::temp_dir()
            .join(format!(
                "stats_playground_missing_parent_{}",
                uuid::Uuid::new_v4()
            ))
            .join("save_failure.spprj");

        let error = service
            .save_project(
                empty_save_request(Some(invalid_save_as_path.to_string_lossy().to_string())),
                None,
            )
            .unwrap_err();
        assert!(
            matches!(&error, crate::error::AppError::InvalidParam(message) if message.contains("destination parent does not exist"))
        );

        let after = std::fs::read(&project_path).unwrap();
        assert_eq!(after, before);

        let _ = std::fs::remove_file(project_path);
    }

    #[test]
    fn save_as_failure_preserves_existing_project_identity() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.seed_benchmark_table("save-as-failure-id", "Save As Failure", 5, 2)
                .unwrap();
        }

        let original_path = std::env::temp_dir().join(format!(
            "stats_playground_save_as_original_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        let new_path = std::env::temp_dir()
            .join(format!(
                "stats_playground_missing_parent_{}",
                uuid::Uuid::new_v4()
            ))
            .join("save_as_new.spprj");

        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Original Save As Project".to_string(),
            file_path: original_path.to_string_lossy().to_string(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
        });

        let service = ProjectService::new(&state);
        service
            .save_project(empty_save_request(None), None)
            .unwrap();

        let save_result = service.save_project(
            empty_save_request(Some(new_path.to_string_lossy().to_string())),
            None,
        );

        assert!(save_result.is_err());
        let current = state
            .project
            .read()
            .unwrap()
            .clone()
            .expect("project should remain set");
        assert_eq!(current.file_path, original_path.to_string_lossy());
        assert_eq!(current.name, "Original Save As Project");

        let _ = std::fs::remove_file(original_path);
    }

    #[test]
    fn save_as_success_commits_project_identity_to_new_destination() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.seed_benchmark_table("save-as-success-id", "Save As Success", 3, 2)
                .unwrap();
        }

        let original_path = std::env::temp_dir().join(format!(
            "stats_playground_save_as_success_original_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        let new_path = std::env::temp_dir().join(format!(
            "stats_playground_save_as_success_new_{}.spprj",
            uuid::Uuid::new_v4()
        ));

        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Before Save As".to_string(),
            file_path: original_path.to_string_lossy().to_string(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
        });

        let service = ProjectService::new(&state);
        service
            .save_project(empty_save_request(None), None)
            .unwrap();

        service
            .save_project(
                empty_save_request(Some(new_path.to_string_lossy().to_string())),
                None,
            )
            .unwrap();

        let current = state
            .project
            .read()
            .unwrap()
            .clone()
            .expect("project should remain set");
        assert_eq!(current.file_path, new_path.to_string_lossy());
        assert_eq!(
            current.name,
            new_path.file_stem().unwrap().to_string_lossy()
        );
        assert!(spprj_archive::read_project_file(new_path.to_str().unwrap()).is_ok());

        let _ = std::fs::remove_file(original_path);
        let _ = std::fs::remove_file(new_path);
    }

    #[test]
    fn save_snapshot_captures_all_dataset_generations_while_listing_datasets() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.seed_benchmark_table("save-gen-one", "Save Gen One", 2, 2)
                .unwrap();
            db.seed_benchmark_table("save-gen-two", "Save Gen Two", 2, 2)
                .unwrap();
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET generation = 11 WHERE id = 'save-gen-one'",
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET generation = 42 WHERE id = 'save-gen-two'",
                    [],
                )
                .unwrap();
        }

        let destination = std::env::temp_dir().join(format!(
            "stats_playground_save_generations_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        let current_project = ProjectInfo {
            name: "Save Generations".to_string(),
            file_path: destination.to_string_lossy().to_string(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
        };
        *state.project.write().unwrap() = Some(current_project.clone());

        let service = ProjectService::new(&state);
        let snapshot = service
            .capture_save_snapshot(current_project, empty_save_request(None))
            .unwrap();

        assert_eq!(snapshot.datasets.len(), 2);
        assert_eq!(snapshot.dataset_generations.len(), 2);
        assert_eq!(
            snapshot.dataset_generations.get("save-gen-one"),
            Some(&11_u64)
        );
        assert_eq!(
            snapshot.dataset_generations.get("save-gen-two"),
            Some(&42_u64)
        );

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn save_as_writer_failure_preserves_existing_project_identity_and_destination() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.seed_benchmark_table("save-as-writer-failure", "Save As Writer Failure", 3, 2)
                .unwrap();
        }

        let original_path = std::env::temp_dir().join(format!(
            "stats_playground_save_as_writer_fail_original_{}.spprj",
            uuid::Uuid::new_v4()
        ));
        let new_path = std::env::temp_dir().join(format!(
            "stats_playground_save_as_writer_fail_new_{}.spprj",
            uuid::Uuid::new_v4()
        ));

        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Before Writer Failure".to_string(),
            file_path: original_path.to_string_lossy().to_string(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
        });

        let service = ProjectService::new(&state);
        service
            .save_project(empty_save_request(None), None)
            .unwrap();

        let failure = service.save_project_with_write_impl(
            empty_save_request(Some(new_path.to_string_lossy().to_string())),
            None,
            |_snapshot, _destination_path, _progress_cb, _save_guard| {
                Err(AppError::FileIO(
                    "injected writer validation/placement failure".to_string(),
                ))
            },
        );
        assert!(
            matches!(failure, Err(AppError::FileIO(message)) if message.contains("injected writer validation/placement failure"))
        );

        let current = state
            .project
            .read()
            .unwrap()
            .clone()
            .expect("project should remain set");
        assert_eq!(current.file_path, original_path.to_string_lossy());
        assert_eq!(current.name, "Before Writer Failure");
        assert!(spprj_archive::read_project_file(original_path.to_str().unwrap()).is_ok());

        let _ = std::fs::remove_file(original_path);
        let _ = std::fs::remove_file(new_path);
    }

    #[test]
    fn save_pipeline_begins_save_guard_before_metadata_snapshot_and_delegates_to_streaming_writer()
    {
        let source = include_str!("project_service.rs");
        let body = source_between(
            source,
            "pub fn save_project(",
            "/// Get current project info",
        );

        assert!(
            body.contains("self.state.save_coordinator.begin_save()"),
            "save_project must acquire SaveGuard before reading mutable metadata"
        );
        assert!(
            body.contains("SaveSnapshot"),
            "save_project must construct a stable SaveSnapshot"
        );
        assert!(
            body.contains("StreamingProjectWriter"),
            "save_project must delegate archive writing to StreamingProjectWriter"
        );
        assert!(
            !body.contains("read_project_file"),
            "save_project must not introduce post-placement read_project_file failure paths"
        );
    }

    #[test]
    fn save_pipeline_snapshot_captures_required_state_fields() {
        let source = include_str!("project_service.rs");
        let body = source_between(
            source,
            "pub fn save_project(",
            "/// Get current project info",
        );

        assert!(body.contains("datasets"));
        assert!(body.contains("dataset_generations"));
        assert!(body.contains("column_display"));
        assert!(body.contains("request"));
    }

    #[test]
    fn failed_project_open_preserves_existing_project_and_database() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_empty_table("original-id", "Original", &[], &[])
                .unwrap();
        }
        *state.project.write().unwrap() = Some(ProjectInfo {
            name: "Original Project".into(),
            file_path: "original.spprj".into(),
            created_at: "before".into(),
        });

        let valid = table_doc("valid-id", "Valid");
        let mut malformed = table_doc("bad-id", "Bad");
        malformed.columns.push(TableColumn {
            column_id: None,
            name: "value".into(),
            col_type: "INTEGER".into(),
            width: None,
            format: None,
            extras: None,
        });
        malformed.rows.push(vec![serde_json::json!(1)]);
        let folders = HashMap::new();
        let bundle = spprj_archive::build_bundle(
            "Incoming".into(),
            "3.0.0".into(),
            "after".into(),
            vec![valid, malformed],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            &folders,
            &folders,
            &folders,
            &folders,
            &folders,
            &folders,
            vec![],
            vec![],
        );
        let file_path =
            std::env::temp_dir().join(format!("sp_failed_open_{}.spprj", uuid::Uuid::new_v4()));
        spprj_archive::write_project_archive(&bundle, file_path.to_str().unwrap()).unwrap();

        let service = ProjectService::new(&state);
        let result = service.open_project(file_path.to_str().unwrap(), None);
        let _ = std::fs::remove_file(file_path);

        assert!(result.is_err());
        let db = state.db.lock().unwrap();
        assert!(db.get_dataset_meta("original-id").is_ok());
        assert!(db.get_dataset_meta("valid-id").is_err());
        drop(db);
        assert_eq!(
            state.project.read().unwrap().as_ref().unwrap().name,
            "Original Project"
        );
    }
}

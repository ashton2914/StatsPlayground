use crate::error::AppError;
use crate::models::project_persistence::{ProjectCommit, ProjectWriteContext};
use crate::models::table::DatasetMeta;
use crate::services::project_catalog::ProjectCatalog;
use crate::services::project_database::ProjectDatabase;
use duckdb::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCsvImport {
    pub name: String,
    pub source_path: String,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSqlOutput {
    pub name: String,
    pub sql: String,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTransformCreate {
    pub draft: crate::services::table_transform_domain::TableTransformDraft,
    pub inputs: Vec<crate::services::table_transform_service::TableTransformInputBinding>,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTransformRun {
    pub definition: crate::services::table_transform_domain::TableTransformDefinition,
    pub binding: crate::services::table_transform_service::TableTransformProjectBinding,
    pub input_bindings: Option<Vec<crate::services::table_transform_service::TableTransformInputBinding>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSqliteImport {
    pub source_path: String,
    pub selections: Vec<crate::models::data_link::SqliteImportSelection>,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServerImport {
    pub connection_id: String,
    pub object: crate::models::data_link::SourceObjectRef,
    pub target_name: String,
    pub source_description: String,
    pub folder: String,
}

pub(crate) struct SourceStamp {
    identity: same_file::Handle,
    length: u64,
    modified: std::time::SystemTime,
}
impl SourceStamp {
    pub(crate) fn read(path: &Path) -> Result<Self, AppError> {
        let identity = same_file::Handle::from_path(path)?;
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(AppError::InvalidParam("import_source_not_file".into()));
        }
        Ok(Self {
            identity,
            length: metadata.len(),
            modified: metadata.modified()?,
        })
    }
    pub(crate) fn verify(&self, path: &Path) -> Result<(), AppError> {
        let after = Self::read(path)?;
        if self.identity != after.identity
            || self.length != after.length
            || self.modified != after.modified
        {
            return Err(AppError::InvalidParam("import_source_changed".into()));
        }
        Ok(())
    }
}

impl ProjectDatabase {
    #[cfg(test)]
    pub(crate) fn import_project_server_snapshot<F, C>(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectServerImport,
        connector: &crate::connectors::ServerConnector,
        on_progress: F,
        cancelled: C,
    ) -> Result<ProjectCommit<(DatasetMeta, usize)>, AppError>
    where
        F: Fn(usize, usize),
        C: Fn() -> bool,
    {
        self.import_project_server_snapshot_with_result(context,request,connector,on_progress,cancelled,|result|result)
    }

    pub(crate) fn import_project_server_snapshot_with_result<T,F,C,M>(
        &self,context:&ProjectWriteContext,request:&ProjectServerImport,connector:&crate::connectors::ServerConnector,on_progress:F,cancelled:C,project:M,
    )->Result<ProjectCommit<T>,AppError>
    where T:Serialize+serde::de::DeserializeOwned,F:Fn(usize,usize),C:Fn()->bool,M:FnOnce((DatasetMeta,usize))->T {
        self.commit_with_effects(context, &("import_server", request), |engine| {
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            if request.connection_id.trim().is_empty() {
                return Err(AppError::InvalidParam(
                    "import_connection_identity_required".into(),
                ));
            }
            let (meta, written) = engine.import_server_snapshot_in_transaction(
                connector,
                &request.object,
                &request.target_name,
                &request.source_description,
                &on_progress,
                &cancelled,
            )?;
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            let event=ProjectCatalog::new(engine).publish_new_table(&meta, &request.folder)?;
            engine.conn().execute(
                "INSERT INTO _project_output_events VALUES (?, ?, 'import_server', ?)",
                params![event.id, &meta.id, meta.generation],
            )?;
            Ok(crate::services::project_transaction::CommitEffects {
                dataset_ids: vec![meta.id.clone()],
                document_ids: vec![],
                setting_ids: vec![],
                value: project((meta, written)),
            })
        })
    }

    #[cfg(test)]
    pub fn import_project_sqlite<F, C>(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectSqliteImport,
        on_progress: F,
        cancelled: C,
    ) -> Result<ProjectCommit<Vec<(String, DatasetMeta, usize)>>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        self.import_project_sqlite_with_result(context,request,on_progress,cancelled,|results|results)
    }

    pub(crate) fn import_project_sqlite_with_result<T,F,C,M>(
        &self,context:&ProjectWriteContext,request:&ProjectSqliteImport,on_progress:F,cancelled:C,project:M,
    )->Result<ProjectCommit<T>,AppError>
    where T:Serialize+serde::de::DeserializeOwned,F:Fn(&str,usize,usize,usize,usize),C:Fn()->bool,M:FnOnce(Vec<(String,DatasetMeta,usize)>)->T {
        use crate::services::project_transaction::CommitEffects;
        use duckdb::OptionalExt;
        self.commit_with_effects(context, &("import_sqlite", request), |engine| {
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            let mut selections = Vec::new();
            let mut targets = std::collections::HashSet::new();
            for selection in &request.selections {
                if selection.action == "skip" {
                    continue;
                }
                if !["create", "append"].contains(&selection.action.as_str())
                    || !targets.insert(selection.target_name.to_lowercase())
                {
                    return Err(AppError::InvalidParam("import_selection_invalid".into()));
                }
                if selection.action == "append" {
                    let target: String = engine.conn().query_row(
                        "SELECT id FROM _meta_datasets WHERE LOWER(name)=LOWER(?) LIMIT 1",
                        [&selection.target_name],
                        |row| row.get(0),
                    )?;
                    if !context
                        .dataset_generations
                        .iter()
                        .any(|dataset| dataset.id == target)
                    {
                        return Err(AppError::InvalidParam(
                            "project_dataset_precondition_required".into(),
                        ));
                    }
                }
                selections.push((
                    selection.source_name.clone(),
                    selection.target_name.clone(),
                    selection.action == "append",
                ));
            }
            if selections.is_empty() {
                return Ok(CommitEffects {
                    value: project(vec![]),
                    dataset_ids: vec![],
                    document_ids: vec![],
                    setting_ids: vec![],
                });
            }
            let path = Path::new(&request.source_path);
            let stamp = SourceStamp::read(path)?;
            let monitor = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let version: i64 = monitor.query_row("PRAGMA data_version", [], |row| row.get(0))?;
            let results = engine.import_selected_sqlite_in_transaction(
                &request.source_path,
                &selections,
                &on_progress,
                &cancelled,
            )?;
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            let after: i64 = monitor.query_row("PRAGMA data_version", [], |row| row.get(0))?;
            if version != after {
                return Err(AppError::InvalidParam("import_source_changed".into()));
            }
            stamp.verify(path)?;
            let catalog = ProjectCatalog::new(engine);
            for ((_, meta, _), (_, _, append)) in results.iter().zip(&selections) {
                let folder: Option<String> = engine
                    .conn()
                    .query_row(
                        "SELECT folder FROM _project_directory WHERE id=?",
                        [&meta.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let marker=if *append {
                    catalog.publish_table(meta, folder.as_deref().ok_or_else(||AppError::InvalidParam("project_table_directory_required".into()))?)?;
                    uuid::Uuid::new_v4().to_string()
                } else {catalog.publish_new_table(meta,&request.folder)?.id};
                engine.conn().execute(
                    "INSERT INTO _project_output_events VALUES (?, ?, 'import_sqlite', ?)",
                    params![marker, &meta.id, meta.generation],
                )?;
            }
            Ok(CommitEffects {
                dataset_ids: results.iter().map(|(_, meta, _)| meta.id.clone()).collect(),
                document_ids: vec![],
                setting_ids: vec![],
                value: project(results),
            })
        })
    }

    pub fn create_project_transform(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectTransformCreate,
    ) -> Result<
        ProjectCommit<crate::services::table_transform_service::TableTransformCommandResult>,
        AppError,
    > {
        use crate::models::project_persistence::*;
        use crate::services::table_transform_service::{
            TableTransformProjectBinding, TableTransformRunStatus, TableTransformService,
        };
        self.commit_with_effects(context, &("create_transform", request), |engine| {
            if request.inputs.iter().any(|input| {
                !context
                    .dataset_generations
                    .iter()
                    .any(|dataset| dataset.id == input.table_document_id)
            }) {
                return Err(AppError::InvalidParam(
                    "project_dataset_precondition_required".into(),
                ));
            }
            let catalog = ProjectCatalog::new(engine);
            let setting = catalog.get_setting("lineage")?;
            let mut lineage = match &setting {
                Some((_, json)) => serde_json::from_value(json.clone())
                    .map_err(|_| AppError::InvalidParam("project_lineage_invalid".into()))?,
                None => crate::services::workflow_domain::ProjectLineageGraph::default(),
            };
            let service = TableTransformService::new(engine);
            let definition = service.build_definition_from_draft(
                &request.draft,
                &request.inputs,
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
            )?;
            let binding = TableTransformProjectBinding {
                definition_id: definition.id.clone(),
                definition_revision: definition.revision,
                inputs: request.inputs.clone(),
                output_generation: 0,
            };
            let execution = service.run_in_transaction(&definition, &binding, &mut lineage)?;
            if execution.status != TableTransformRunStatus::Succeeded {
                return Err(AppError::InvalidParam(
                    execution
                        .error
                        .clone()
                        .unwrap_or_else(|| "project_transform_blocked".into()),
                ));
            }
            let output = execution
                .output
                .as_ref()
                .ok_or_else(|| AppError::Database("project_transform_output_missing".into()))?;
            let event=catalog.publish_new_table(output, &request.folder)?;
            catalog.apply_patch(&ProjectRecordPatch {
                documents: vec![DocumentWrite {
                    expected_revision: None,
                    document: ProjectDocumentBody {
                        summary: ProjectDocumentSummary {
                            id: definition.id.clone(),
                            kind: ProjectDocumentKind::Transform,
                            analysis_kind: None,
                            name: definition.name.clone(),
                            folder: request.folder.clone(),
                            revision: 1,
                            dependencies: request
                                .inputs
                                .iter()
                                .map(|i| i.table_document_id.clone())
                                .collect(),
                        },
                        schema_version: 1,
                        body: serde_json::to_value(&definition).map_err(|_| {
                            AppError::InvalidParam("project_transform_invalid".into())
                        })?,
                    },
                }],
                settings: vec![
                    ProjectSettingWrite {
                        key: "lineage".into(),
                        expected_revision: setting.map(|(revision, _)| revision),
                        value: serde_json::to_value(&lineage).map_err(|_| {
                            AppError::InvalidParam("project_lineage_invalid".into())
                        })?,
                    },
                    ProjectSettingWrite {
                        key: format!("transformBinding:{}", definition.id),
                        expected_revision: None,
                        value: serde_json::to_value(crate::services::table_transform_service::PersistedTableTransformBinding::from_execution(&execution)).map_err(|_| {
                            AppError::InvalidParam("project_binding_invalid".into())
                        })?,
                    },
                ],
                ..Default::default()
            })?;
            engine.conn().execute(
                "INSERT INTO _project_output_events VALUES (?, ?, 'transform', ?)",
                params![
                    event.id,
                    &output.id,
                    output.generation
                ],
            )?;
            Ok(crate::services::project_transaction::CommitEffects {
                dataset_ids: vec![output.id.clone()],
                document_ids: vec![definition.id.clone(), output.id.clone()],
                setting_ids: vec![
                    "lineage".into(),
                    format!("transformBinding:{}", definition.id),
                ],
                value: crate::services::table_transform_service::TableTransformCommandResult {
                    definition,
                    execution,
                    lineage_graph: lineage,
                },
            })
        })
    }

    pub fn run_project_transform(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectTransformRun,
    ) -> Result<ProjectCommit<crate::services::table_transform_service::TableTransformCommandResult>,AppError> {
        use crate::models::project_persistence::*;
        use crate::services::table_transform_service::{PersistedTableTransformBinding,TableTransformCommandResult,TableTransformService};
        self.commit_with_effects(context,&("run_transform",request),|engine| {
            let revision=context.document_revisions.iter().find(|item|item.id==request.definition.id)
                .ok_or_else(||AppError::InvalidParam("project_document_precondition_required".into()))?.revision;
            let catalog=ProjectCatalog::new(engine);
            let mut document=catalog.get_document(&request.definition.id,revision)?;
            if document.summary.kind!=ProjectDocumentKind::Transform||document.body!=serde_json::to_value(&request.definition).map_err(|error|AppError::InvalidParam(error.to_string()))? {
                return Err(AppError::InvalidParam("project_transform_definition_stale".into()));
            }
            let binding_key=format!("transformBinding:{}",request.definition.id);
            let saved=catalog.get_setting(&binding_key)?.ok_or_else(||AppError::InvalidParam("project_transform_binding_missing".into()))?;
            let persisted:PersistedTableTransformBinding=serde_json::from_value(saved.1).map_err(|_|AppError::InvalidParam("project_transform_binding_invalid".into()))?;
            if persisted.binding!=request.binding {return Err(AppError::InvalidParam("project_transform_binding_stale".into()));}
            let mut binding=persisted.binding;
            if let Some(inputs)=&request.input_bindings {binding.inputs=inputs.clone();}
            for id in binding.inputs.iter().map(|input|input.table_document_id.as_str()).chain(std::iter::once(request.definition.output.table_document_id.as_str())) {
                if !context.dataset_generations.iter().any(|item|item.id==id) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
            }
            let lineage_setting=catalog.get_setting("lineage")?;
            let mut lineage=match lineage_setting.as_ref().filter(|(_,value)|!value.is_null()) {
                Some((_,value))=>serde_json::from_value(value.clone()).map_err(|_|AppError::InvalidParam("project_lineage_invalid".into()))?,
                None=>crate::services::workflow_domain::ProjectLineageGraph::default(),
            };
            // The persisted binding describes the last run; native undo or direct
            // output edits can advance the generation guarded by this request.
            binding.output_generation=engine.get_dataset_generation(&request.definition.output.table_document_id)?;
            let execution=TableTransformService::new(engine).run_in_transaction(&request.definition,&binding,&mut lineage)?;
            let dependencies:Vec<String>=binding.inputs.iter().map(|input|input.table_document_id.clone()).collect();
            let mut patch=ProjectRecordPatch::default();
            if dependencies!=document.summary.dependencies {
                document.summary.dependencies=dependencies;document.summary.revision=revision.checked_add(1).ok_or_else(||AppError::InvalidParam("project_document_revision_exhausted".into()))?;
                patch.documents.push(DocumentWrite{expected_revision:Some(revision),document});
            }
            patch.settings=vec![
                ProjectSettingWrite{key:"lineage".into(),expected_revision:lineage_setting.map(|(revision,_)|revision),value:serde_json::to_value(&lineage).map_err(|error|AppError::InvalidParam(error.to_string()))?},
                ProjectSettingWrite{key:binding_key.clone(),expected_revision:Some(saved.0),value:serde_json::to_value(PersistedTableTransformBinding::from_execution(&execution)).map_err(|error|AppError::InvalidParam(error.to_string()))?},
            ];
            catalog.apply_patch(&patch)?;
            if let Some(output)=&execution.output {
                engine.conn().execute("INSERT INTO _project_output_events VALUES (?, ?, 'transform', ?)",params![uuid::Uuid::new_v4().to_string(),&output.id,output.generation])?;
            }
            Ok(crate::services::project_transaction::CommitEffects{
                dataset_ids:vec![request.definition.output.table_document_id.clone()],
                document_ids:patch.documents.iter().map(|write|write.document.summary.id.clone()).collect(),
                setting_ids:vec!["lineage".into(),binding_key],
                value:TableTransformCommandResult{definition:request.definition.clone(),execution,lineage_graph:lineage},
            })
        })
    }

    pub fn materialize_project_sql(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectSqlOutput,
    ) -> Result<ProjectCommit<DatasetMeta>, AppError> {
        self.commit_with_effects(context, &("materialize_sql", request), |engine| {
            let id = uuid::Uuid::new_v4().to_string();
            let name = crate::services::data_service::DataService::resolve_create_dataset_name(
                engine,
                &request.name,
            )?;
            let meta =
                engine.create_table_from_sql_query_in_transaction(&id, &name, &request.sql)?;
            let event=ProjectCatalog::new(engine).publish_new_table(&meta, &request.folder)?;
            engine.conn().execute(
                "INSERT INTO _project_output_events VALUES (?, ?, 'materialize_sql', ?)",
                params![event.id, &id, meta.generation],
            )?;
            Ok(crate::services::project_transaction::CommitEffects {
                dataset_ids: vec![meta.id.clone()],
                document_ids: vec![],
                setting_ids: vec![],
                value: meta,
            })
        })
    }

    pub fn import_project_csv(
        &self,
        context: &ProjectWriteContext,
        request: &ProjectCsvImport,
        cancelled: impl Fn() -> bool,
    ) -> Result<ProjectCommit<DatasetMeta>, AppError> {
        self.commit_with_effects(context, &("import_csv", request), |engine| {
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            let path = Path::new(&request.source_path);
            let stamp = SourceStamp::read(path)?;
            let id = uuid::Uuid::new_v4().to_string();
            let name = crate::services::data_service::DataService::resolve_create_dataset_name(
                engine,
                &request.name,
            )?;
            let meta = engine.import_csv_in_transaction(&id, &name, &request.source_path)?;
            if cancelled() {
                return Err(AppError::Cancelled("import_cancelled".into()));
            }
            stamp.verify(path)?;
            let event=ProjectCatalog::new(engine).publish_new_table(&meta, &request.folder)?;
            engine.conn().execute(
                "INSERT INTO _project_output_events VALUES (?, ?, 'import_csv', ?)",
                params![event.id, &id, meta.generation],
            )?;
            Ok(crate::services::project_transaction::CommitEffects {
                dataset_ids: vec![meta.id.clone()],
                document_ids: vec![],
                setting_ids: vec![],
                value: meta,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::project_persistence::{
        CatalogPageRequest, HistoryPageRequest, ProjectWriteContext,
    };
    use crate::services::project_catalog::ProjectCatalog;
    use crate::services::project_database::ProjectDatabase;

    fn context(db: &ProjectDatabase, id: &str) -> ProjectWriteContext {
        ProjectWriteContext {
            operation_id: id.into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: db.committed_revision().unwrap(),
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        }
    }

    #[test]
    fn project_v5_outputs_server_cancel_precedes_source_access() {
        use crate::models::data_link::*;
        let connector = crate::connectors::ServerConnector::new(
            ConnectionDefinition {
                connector: ConnectorKind::PostgreSql,
                host: "127.0.0.1".into(),
                port: 5432,
                database: "fixture".into(),
                authentication_type: AuthenticationType::UsernamePassword,
                tls_mode: TlsMode::Disabled,
                tls_root_certificate_pem: None,
                connect_timeout_seconds: 1,
            },
            ConnectionCredentials {
                username: "fixture".into(),
                password: "unused-fixture".into(),
            },
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("server.spprj"), false).unwrap();
        // Missing schema fails locally if the connector is incorrectly accessed.
        let request = ProjectServerImport {
            connection_id: "fixture".into(),
            object: SourceObjectRef {
                catalog: None,
                schema: None,
                name: "table".into(),
                object_type: SourceObjectType::Table,
            },
            target_name: "Imported".into(),
            source_description: "fixture".into(),
            folder: String::new(),
        };
        let result = db.import_project_server_snapshot(
            &context(&db, "cancel-server"),
            &request,
            &connector,
            |_, _| {},
            || true,
        );
        assert!(matches!(result, Err(AppError::Cancelled(_))));
        assert_eq!(db.committed_revision().unwrap(), 0);
    }

    #[test]
    fn project_v5_outputs_sqlite_import_and_conversion_failure_are_atomic() {
        use crate::models::data_link::SqliteImportSelection;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        let sqlite = rusqlite::Connection::open(&source).unwrap();
        sqlite.execute_batch("CREATE TABLE good(value INTEGER); INSERT INTO good VALUES (9007199254740993); CREATE TABLE bad(value INTEGER); INSERT INTO bad VALUES ('not-a-number')").unwrap();
        let db = ProjectDatabase::create(&dir.path().join("project.spprj"), false).unwrap();
        let mut request = ProjectSqliteImport {
            source_path: source.to_string_lossy().into(),
            folder: "SQLite".into(),
            selections: vec![
                SqliteImportSelection {
                    source_name: "good".into(),
                    target_name: "Good".into(),
                    action: "create".into(),
                },
                SqliteImportSelection {
                    source_name: "bad".into(),
                    target_name: "Bad".into(),
                    action: "create".into(),
                },
            ],
        };
        assert!(db
            .import_project_sqlite(
                &context(&db, "invalid"),
                &request,
                |_, _, _, _, _| {},
                || false
            )
            .is_err());
        db.with_reader(db.epoch(), |e| {
            assert!(e.list_datasets()?.is_empty());
            Ok(())
        })
        .unwrap();
        assert_eq!(db.committed_revision().unwrap(), 0);
        request.selections.pop();
        let result = db
            .import_project_sqlite(
                &context(&db, "valid"),
                &request,
                |_, _, _, _, _| {},
                || false,
            )
            .unwrap();
        assert_eq!(result.value.len(), 1);
        assert_eq!(result.value[0].1.row_count, 1);
        assert_eq!(result.changed_dataset_generations.len(), 1);
        assert_eq!(result.changed_history_entries.iter().filter(|entry|entry.operation=="create_table").count(),1,"new SQLite tables require lifecycle history");
        db.with_reader(db.epoch(),|engine| {
            let page=ProjectCatalog::new(engine).list_history(&HistoryPageRequest{dataset_id:Some(result.value[0].1.id.clone()),after:None,limit:200})?;
            assert_eq!(page.items.len(),1,"output marker and creation event must share one history identity");
            assert_eq!(page.items[0].operation,"create_table");Ok(())
        }).unwrap();

        db.with_reader(db.epoch(), |e| {
            let table = crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(
                &crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(
                    &result.value[0].1.id,
                ),
            );
            let value: i64 =
                e.conn()
                    .query_row(&format!("SELECT value FROM {table}"), [], |r| r.get(0))?;
            assert_eq!(value, 9007199254740993);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_outputs_transform_publishes_definition_binding_lineage_and_table() {
        use crate::services::table_transform_domain::{
            SortColumn, SortDirection, TableTransformDraft, TableTransformOperation,
        };
        use crate::services::table_transform_service::TableTransformInputBinding;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transform.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let input = db
            .materialize_project_sql(
                &context(&db, "seed"),
                &ProjectSqlOutput {
                    name: "Source".into(),
                    sql:
                        "SELECT 3 AS value UNION ALL SELECT 1 AS value UNION ALL SELECT 2 AS value"
                            .into(),
                    folder: String::new(),
                },
            )
            .unwrap();
        let request = ProjectTransformCreate {
            draft: TableTransformDraft {
                name: "Sort values".into(),
                output_name: "Sorted".into(),
                operation: TableTransformOperation::Sort {
                    sort_columns: vec![SortColumn {
                        column: "value".into(),
                        direction: SortDirection::Ascending,
                    }],
                },
            },
            inputs: vec![TableTransformInputBinding {
                role: "source".into(),
                table_document_id: input.value.id,
            }],
            folder: "Derived".into(),
        };
        let mut transform_context = context(&db, "transform");
        transform_context.dataset_generations = input.changed_dataset_generations.clone();
        let output = db
            .create_project_transform(&transform_context, &request)
            .unwrap();
        assert_eq!(
            output.value.definition.id,
            output.value.execution.definition_id
        );
        assert!(!output.value.lineage_graph.nodes.is_empty());
        let id = output.value.execution.output.as_ref().unwrap().id.clone();
        db.commit_records(
            &context(&db, "later-lineage"),
            &crate::models::project_persistence::ProjectRecordPatch {
                settings: vec![crate::models::project_persistence::ProjectSettingWrite {
                    key: "lineage".into(),
                    expected_revision: Some(1),
                    value: serde_json::to_value(
                        crate::services::workflow_domain::ProjectLineageGraph::default(),
                    )
                    .unwrap(),
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let replay = db
            .create_project_transform(&transform_context, &request)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&replay.value).unwrap(),
            serde_json::to_value(&output.value).unwrap()
        );
        db.shutdown().unwrap();
        let db = ProjectDatabase::open(&path, false).unwrap();
        db.with_reader(db.epoch(), |e| {
            assert_eq!(e.list_datasets()?.len(), 2);
            let catalog = ProjectCatalog::new(e);
            assert!(catalog.get_setting("lineage")?.is_some());
            let binding = catalog
                .get_setting(&format!("transformBinding:{}", output.value.definition.id))?
                .unwrap();
            assert_eq!(
                binding.1["lastRun"]["status"],
                serde_json::json!("succeeded")
            );
            assert!(binding.1["schemaReports"].is_array());
            assert_eq!(
                catalog
                    .get_document(&output.value.definition.id, 1)?
                    .summary
                    .name,
                "Sort values"
            );
            let table = crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(
                &crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&id),
            );
            let mut statement = e
                .conn()
                .prepare(&format!("SELECT value FROM {table} ORDER BY _row_id"))?;
            let values = statement
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(values, vec![1, 2, 3]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_navigation_uses_saved_counts_and_anchors_for_initial_windows() {
        use crate::engine::duckdb_engine::{reset_full_anchor_rebuild_counter,full_anchor_rebuild_counter,reset_window_full_count_counter,window_full_count_counter};
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("navigation.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        let source=db.with_engine(|engine|{
            engine.seed_benchmark_table("source","Values",10000,1)?;
            let meta=engine.get_dataset_meta("source")?;ProjectCatalog::new(engine).publish_table(&meta,"")?;Ok(meta)
        }).unwrap();
        db.shutdown().unwrap();let db=ProjectDatabase::open(&path,false).unwrap();
        reset_full_anchor_rebuild_counter();reset_window_full_count_counter();
        db.with_reader(db.epoch(),|engine|{
            for start in [0,9995,4093,0] {
                let result=engine.query_table_window(&crate::models::table::TableWindowRequest{dataset_id:source.id.clone(),start,count:5,sort:None,filters:vec![],generation:source.generation})?;
                assert_eq!(result.total_rows,10000);assert_eq!(result.rows.len(),5);
                let values:Vec<i64>=result.rows.iter().map(|row|row[1].as_i64().unwrap()).collect();
                assert_eq!(values,(start as i64+1..start as i64+6).collect::<Vec<_>>());
            }
            Ok(())
        }).unwrap();
        let mut mutation=context(&db,"insert-and-edit");
        mutation.dataset_generations=vec![crate::models::project_persistence::DatasetGeneration{id:source.id.clone(),generation:0}];
        let edited=db.commit_with_effects(&mutation,&("insert-near-start",&source.id),|engine|{
            let added=crate::services::table_delta_mutation::add_rows_compact_in_transaction(engine,&source.id,1,Some(2),0)?;
            crate::services::project_cell_mutation::update_cells_compact_in_transaction(engine,&source.id,&[crate::models::table::CellUpdate{row_id:added.row_ids[0],column_name:"value_1".into(),value:Some("99".into())}],added.generation)?;
            Ok(crate::services::project_transaction::CommitEffects{value:(),dataset_ids:vec![source.id.clone()],document_ids:vec![],setting_ids:vec![]})
        }).unwrap();
        let generation=edited.changed_dataset_generations[0].generation;
        db.with_reader(db.epoch(),|engine|{
            let request=crate::models::table::TableWindowRequest{dataset_id:source.id.clone(),start:0,count:3,sort:None,filters:vec![],generation};
            let result=engine.query_table_window(&request)?;
            assert_eq!(result.total_rows,10001);
            assert_eq!(result.rows.iter().map(|row|row[1].as_i64().unwrap()).collect::<Vec<_>>(),vec![1,99,2]);
            let mut stale=request.clone();stale.generation=0;assert!(engine.query_table_window(&stale).is_err());
            Ok(())
        }).unwrap();
        assert_eq!(window_full_count_counter(),0,"native natural windows must use committed counts instead of recounting rows");
        assert_eq!(full_anchor_rebuild_counter(),0,"persisted anchors must be reused after reopen");
    }

    #[test]
    fn project_v5_transform_rerun_rebind_receipts_survive_reopen() {
        use crate::models::project_persistence::DocumentRevision;
        use crate::services::table_transform_domain::{SortColumn,SortDirection,TableTransformDraft,TableTransformOperation};
        use crate::services::table_transform_service::TableTransformInputBinding;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("rerun.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        let source=db.materialize_project_sql(&context(&db,"seed-a"),&ProjectSqlOutput{name:"A".into(),sql:"SELECT 2 AS value UNION ALL SELECT 1 AS value".into(),folder:String::new()}).unwrap();
        let other=db.materialize_project_sql(&context(&db,"seed-b"),&ProjectSqlOutput{name:"B".into(),sql:"SELECT 9 AS value UNION ALL SELECT 7 AS value".into(),folder:String::new()}).unwrap();
        let mut create=context(&db,"create");create.dataset_generations=source.changed_dataset_generations.clone();
        let created=db.create_project_transform(&create,&ProjectTransformCreate{draft:TableTransformDraft{name:"Sort".into(),output_name:"Sorted".into(),operation:TableTransformOperation::Sort{sort_columns:vec![SortColumn{column:"value".into(),direction:SortDirection::Ascending}]}},inputs:vec![TableTransformInputBinding{role:"source".into(),table_document_id:source.value.id.clone()}],folder:String::new()}).unwrap();
        let request=ProjectTransformRun{definition:created.value.definition.clone(),binding:created.value.execution.binding.clone(),input_bindings:None};
        let mut run=context(&db,"rerun");run.dataset_generations=source.changed_dataset_generations.clone();run.dataset_generations.extend(created.changed_dataset_generations.clone());run.document_revisions=vec![DocumentRevision{id:request.definition.id.clone(),revision:1}];
        let refreshed=db.run_project_transform(&run,&request).unwrap();
        assert!(refreshed.value.execution.binding.output_generation>request.binding.output_generation);
        assert_eq!(refreshed.value.definition.output.table_document_id,request.definition.output.table_document_id);
        assert_eq!(serde_json::to_value(db.run_project_transform(&run,&request).unwrap()).unwrap(),serde_json::to_value(&refreshed).unwrap());
        let rebound_request=ProjectTransformRun{definition:request.definition.clone(),binding:refreshed.value.execution.binding.clone(),input_bindings:Some(vec![TableTransformInputBinding{role:"source".into(),table_document_id:other.value.id.clone()}])};
        let mut rebind=context(&db,"rebind");rebind.dataset_generations=other.changed_dataset_generations.clone();rebind.dataset_generations.extend(refreshed.changed_dataset_generations.clone());rebind.document_revisions=run.document_revisions.clone();
        let rebound=db.run_project_transform(&rebind,&rebound_request).unwrap();
        assert_eq!(rebound.changed_directory_entries.iter().find(|item|item.id==request.definition.id).unwrap().dependencies,vec![other.value.id.clone()]);
        let mut stale=context(&db,"stale-binding");stale.dataset_generations=source.changed_dataset_generations.clone();stale.dataset_generations.extend(rebound.changed_dataset_generations.clone());stale.document_revisions=vec![DocumentRevision{id:request.definition.id.clone(),revision:2}];
        let revision=db.header().unwrap().committed_revision;
        assert!(db.run_project_transform(&stale,&request).is_err());assert_eq!(db.header().unwrap().committed_revision,revision);
        let incompatible=db.materialize_project_sql(&context(&db,"incompatible"),&ProjectSqlOutput{name:"Missing value".into(),sql:"SELECT 1 AS other".into(),folder:String::new()}).unwrap();
        let blocked_request=ProjectTransformRun{definition:request.definition.clone(),binding:rebound.value.execution.binding.clone(),input_bindings:Some(vec![TableTransformInputBinding{role:"source".into(),table_document_id:incompatible.value.id.clone()}])};
        let mut blocked_context=context(&db,"blocked");blocked_context.dataset_generations=incompatible.changed_dataset_generations.clone();blocked_context.dataset_generations.extend(rebound.changed_dataset_generations.clone());blocked_context.document_revisions=stale.document_revisions.clone();
        let blocked=db.run_project_transform(&blocked_context,&blocked_request).unwrap();
        assert_eq!(blocked.value.execution.status,crate::services::table_transform_service::TableTransformRunStatus::Blocked);
        assert_eq!(blocked.value.execution.binding.output_generation,rebound.value.execution.binding.output_generation);
        assert!(blocked.value.execution.output.is_none());
        db.shutdown().unwrap();let db=ProjectDatabase::open(&path,false).unwrap();
        db.with_reader(db.epoch(),|engine|{
            let catalog=ProjectCatalog::new(engine);let saved=catalog.get_setting(&format!("transformBinding:{}",request.definition.id))?.unwrap();
            assert_eq!(saved.1["lastRun"]["status"],"blocked");assert_eq!(saved.1["inputs"][0]["tableDocumentId"],incompatible.value.id);
            let table=crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&request.definition.output.table_document_id));
            let value:i64=engine.conn().query_row(&format!("SELECT value FROM {table} ORDER BY _row_id LIMIT 1"),[],|row|row.get(0))?;assert_eq!(value,7);Ok(())
        }).unwrap();
        rebind.expected_epoch=db.epoch();
        let replay=db.run_project_transform(&rebind,&rebound_request).unwrap();assert_eq!(replay.committed_revision,rebound.committed_revision);
    }

    #[test]
    fn project_v5_outputs_sql_materialization_reopens_and_invalid_query_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sql.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let request = ProjectSqlOutput {
            name: "Computed".into(),
            sql: "SELECT 9007199254740993::BIGINT AS exact, DATE '2024-02-29' AS day".into(),
            folder: "Results".into(),
        };
        let result = db
            .materialize_project_sql(&context(&db, "query"), &request)
            .unwrap();
        assert_eq!(result.value.row_count, 1);
        let mut bad = request.clone();
        bad.name = "Invalid".into();
        bad.sql = "SELECT * FROM _project_header".into();
        assert!(db
            .materialize_project_sql(&context(&db, "invalid-query"), &bad)
            .is_err());
        assert_eq!(db.committed_revision().unwrap(), 1);
        db.shutdown().unwrap();
        let db = ProjectDatabase::open(&path, false).unwrap();
        db.with_reader(db.epoch(), |e| {
            assert_eq!(e.list_datasets()?.len(), 1);
            let table = crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(
                &crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&result.value.id),
            );
            let actual: (i64, String) = e.conn().query_row(
                &format!("SELECT exact,CAST(day AS VARCHAR) FROM {table}"),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(actual, (9007199254740993, "2024-02-29".into()));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_outputs_csv_import_is_atomic_and_replays_without_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.spprj");
        let csv = dir.path().join("input.csv");
        std::fs::write(&csv, "integer,label\n9007199254740993,中文\n2,other\n").unwrap();
        let db = ProjectDatabase::create(&path, false).unwrap();
        let mut ctx = context(&db, "import");
        let request = ProjectCsvImport {
            name: "数据".into(),
            source_path: csv.to_string_lossy().into(),
            folder: "Imports/中文".into(),
        };
        let first = db.import_project_csv(&ctx, &request, || false).unwrap();
        assert_eq!(first.committed_revision, 1);
        assert_eq!(first.value.row_count, 2);
        assert_eq!(first.changed_dataset_generations.len(), 1);
        assert_eq!(first.changed_dataset_generations[0].id, first.value.id);
        let id = first.value.id.clone();
        std::fs::remove_file(&csv).unwrap();
        db.shutdown().unwrap();
        let db = ProjectDatabase::open(&path, false).unwrap();
        ctx.expected_epoch = db.epoch();
        let replay = db.import_project_csv(&ctx, &request, || true).unwrap();
        assert_eq!(replay.value.id, id);
        assert_eq!(
            replay.changed_dataset_generations,
            first.changed_dataset_generations
        );
        assert_eq!(db.committed_revision().unwrap(), 1);
        db.with_reader(db.epoch(), |e| {
            assert_eq!(e.list_datasets()?.len(), 1);
            let catalog = ProjectCatalog::new(e);
            let page = catalog.list(&CatalogPageRequest::default())?;
            assert_eq!(
                page.items.iter().find(|s| s.id == id).unwrap().folder,
                "Imports/中文"
            );
            let history = catalog.list_history(&HistoryPageRequest {
                dataset_id: Some(id.clone()),
                after: None,
                limit: 10,
            })?;
            assert_eq!(history.items.len(), 1);
            assert_eq!(history.items[0].operation, "create_table");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_outputs_cancel_or_changed_source_publishes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let csv = dir.path().join("input.csv");
        std::fs::write(&csv, "value\n1\n").unwrap();
        let db = ProjectDatabase::create(&dir.path().join("project.spprj"), false).unwrap();
        let request = ProjectCsvImport {
            name: "Data".into(),
            source_path: csv.to_string_lossy().into(),
            folder: "Imports".into(),
        };
        assert!(db
            .import_project_csv(&context(&db, "cancel"), &request, || true)
            .is_err());
        let calls = std::cell::Cell::new(0);
        assert!(db
            .import_project_csv(&context(&db, "source-change"), &request, || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    std::fs::write(&csv, "value\n100000\n").unwrap();
                }
                false
            })
            .is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
        db.with_reader(db.epoch(), |e| {
            assert!(e.list_datasets()?.is_empty());
            assert!(ProjectCatalog::new(e)
                .list(&CatalogPageRequest::default())?
                .items
                .is_empty());
            Ok(())
        })
        .unwrap();
    }
}

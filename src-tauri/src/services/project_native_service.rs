use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::project_persistence::*;
use crate::services::project_catalog::ProjectCatalog;
use crate::services::project_database::ProjectDatabase;
use crate::services::project_schema;
use crate::services::table_navigation_service::TableNavigationService;
use crate::services::tabulate_session_service::TabulateSessionService;
use crate::state::AppState;

pub(crate) struct NativeProjectService<'a> {
    state: &'a AppState,
}

impl<'a> NativeProjectService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn open(&self, path: &Path, read_only: bool) -> Result<ProjectOpenSummary, AppError> {
        project_schema::require_v5_capability()?;
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        let span=crate::perf_project_v5_ui::operation_span(crate::perf_project_v5_ui::ProbeScenario::Catalog,None,Some(path));
        let result=self.open_enabled(path, read_only);
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        crate::perf_project_v5_ui::finish_span(span,&result);
        result
    }

    pub(crate) fn publish_migrated_with_hook(&self,temporary:tempfile::TempPath,path:&Path,project:ProjectInfo,expected_owner:Option<u64>,before_publish:&dyn Fn()->Result<(),AppError>,before_reopen:&dyn Fn()->Result<(),AppError>)->Result<ProjectOpenSummary,AppError> {
        project_schema::require_v5_capability()?;
        let _ownership=self.state.project_transition.lock().map_err(|_|AppError::Busy("project_transition_unavailable".into()))?;
        let current_owner=self.state.project_database.read().map_err(|_|AppError::Busy("project_transition_unavailable".into()))?.as_ref().map(|database|database.epoch());
        if current_owner!=expected_owner {return Err(AppError::InvalidParam("project_migration_session_changed".into()));}
        let transition=self.state.save_coordinator.begin_save()?;
        before_publish()?;
        temporary.persist_noclobber(path).map_err(|e|AppError::FileIO(e.error.to_string()))?;
        let installed=(|| {
            #[cfg(unix)] std::fs::File::open(path.parent().filter(|p|!p.as_os_str().is_empty()).unwrap_or(Path::new(".")))?.sync_all()?;
            before_reopen()?;
            let database=Arc::new(ProjectDatabase::open(path,false)?);
            self.publish_database(database,Some(project),&transition)
        })();
        installed.map_err(|error|AppError::FileIO(format!("{} {error}",super::project_migration::MIGRATION_PUBLISHED_PREFIX)))
    }

    fn open_enabled(&self, path: &Path, read_only: bool) -> Result<ProjectOpenSummary, AppError> {
        let _ownership = self
            .state
            .project_transition
            .lock()
            .map_err(|_| AppError::Busy("project_transition_unavailable".into()))?;
        let database = Arc::new(ProjectDatabase::open(path, read_only)?);
        let transition = self.state.save_coordinator.begin_save()?;
        self.publish_database(database, None, &transition)
    }

    fn publish_database(
        &self,
        database: Arc<ProjectDatabase>,
        project: Option<ProjectInfo>,
        _transition: &crate::services::save_coordinator::SaveGuard<'_>,
    ) -> Result<ProjectOpenSummary, AppError> {
        let path = database.path();
        let read_only = database.is_read_only();
        let epoch = database.epoch();
        let header = database.header()?;
        let directory = database.with_reader(epoch, |engine| {
            let catalog = ProjectCatalog::new(engine);
            catalog.validate_metadata()?;
            catalog.list(&CatalogPageRequest::default())
        })?;
        if !read_only {
            database.recover_staged_operations(epoch)?;
        }
        let project = project.unwrap_or(ProjectInfo {
            name: path
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| AppError::InvalidParam("project_path_invalid".into()))?
                .to_string(),
            file_path: database
                .path()
                .to_str()
                .ok_or_else(|| AppError::InvalidParam("project_path_invalid".into()))?
                .to_string(),
            created_at: header.created_at.clone(),
        });
        let (navigation, tabulate) = database.with_engine(|engine| {
            Ok((
                Arc::new(TableNavigationService::new(engine, 2)?),
                Arc::new(TabulateSessionService::new(engine)?),
            ))
        })?;
        let datasets = database.with_reader(epoch, |engine| {
            let catalog = ProjectCatalog::new(engine);
            directory
                .items
                .iter()
                .filter(|item| item.kind == ProjectDocumentKind::Table)
                .map(|item| catalog.describe_table(&item.id))
                .collect::<Result<Vec<_>, _>>()
        })?;
        // Stage all validation/readers before acquiring the publication locks.
        let mut live_database = self
            .state
            .project_database
            .write()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut live_navigation = self
            .state
            .table_navigation
            .write()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut live_tabulate = self
            .state
            .tabulate_sessions
            .write()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut live_project = self
            .state
            .project
            .write()
            .map_err(|error| AppError::Database(error.to_string()))?;
        self.state.graph_new_epoch.fetch_add(1, Ordering::AcqRel);
        self.state.graph_new.shutdown()?;
        live_navigation.shutdown()?;
        live_tabulate.shutdown()?;
        if let Some(previous) = live_database.as_ref() {
            if let Err(error) = previous.prepare_close(previous.epoch()) {
                // A refused close keeps its writer; restore read services for that session.
                let (navigation, tabulate) = previous.with_engine(|engine| {
                    Ok((
                        Arc::new(TableNavigationService::new(engine, 2)?),
                        Arc::new(TabulateSessionService::new(engine)?),
                    ))
                })?;
                *live_navigation = navigation;
                *live_tabulate = tabulate;
                self.state.graph_new.resume_previous()?;
                return Err(error);
            }
        }
        database.install_writer(&self.state.db)?;
        self.state.graph_new.resume();
        *live_navigation = navigation;
        *live_tabulate = tabulate;
        display.clear();
        *live_project = Some(project.clone());
        *live_database = Some(database);
        self.state.save_coordinator.require_native_context();
        self.state.graph_new_epoch.fetch_add(1, Ordering::AcqRel);
        Ok(ProjectOpenSummary {
            project,
            settings_revision: header.committed_revision,
            header,
            epoch,
            writable: !read_only,
            directory,
            datasets,
        })
    }

    pub fn create_draft(&self, root: &Path) -> Result<ProjectOpenSummary, AppError> {
        project_schema::require_v5_capability()?;
        self.create_draft_enabled(root)
    }
    fn create_draft_enabled(&self, root: &Path) -> Result<ProjectOpenSummary, AppError> {
        let _ownership = self
            .state
            .project_transition
            .lock()
            .map_err(|_| AppError::Busy("project_transition_unavailable".into()))?;
        let database = Arc::new(super::project_drafts::ProjectDraftRegistry::create(root)?);
        let project = ProjectInfo {
            name: "Untitled".into(),
            file_path: String::new(),
            created_at: database.header()?.created_at,
        };
        let transition = self.state.save_coordinator.begin_save()?;
        self.publish_database(database, Some(project), &transition)
    }
    pub fn recover_draft(
        &self,
        root: &Path,
        recovery_id: &str,
    ) -> Result<ProjectOpenSummary, AppError> {
        project_schema::require_v5_capability()?;
        let _ownership = self
            .state
            .project_transition
            .lock()
            .map_err(|_| AppError::Busy("project_transition_unavailable".into()))?;
        let path = super::project_drafts::ProjectDraftRegistry::resolve(root, recovery_id)?;
        let database = Arc::new(ProjectDatabase::open(&path, false)?);
        let project = ProjectInfo {
            name: "Untitled".into(),
            file_path: String::new(),
            created_at: database.header()?.created_at,
        };
        let transition = self.state.save_coordinator.begin_save()?;
        self.publish_database(database, Some(project), &transition)
    }
    pub fn checkpoint(&self, epoch: u64, expected_revision: u64) -> Result<bool, AppError> {
        project_schema::require_v5_capability()?;
        self.database(epoch)?
            .checkpoint_if_revision(epoch, expected_revision)
    }

    pub fn close(&self, epoch: u64) -> Result<(), AppError> {
        project_schema::require_v5_capability()?;
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        let span=crate::perf_project_v5_ui::operation_span(crate::perf_project_v5_ui::ProbeScenario::Close,Some(epoch),None);
        let result=self.close_enabled(epoch);
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        crate::perf_project_v5_ui::finish_span(span,&result);
        result
    }
    fn close_enabled(&self, epoch: u64) -> Result<(), AppError> {
        let _ownership = self
            .state
            .project_transition
            .lock()
            .map_err(|_| AppError::Busy("project_transition_unavailable".into()))?;
        let transition = self.state.save_coordinator.begin_save()?;
        self.retire_database(epoch, &transition)?;
        self.state.save_coordinator.release_native_context();
        Ok(())
    }
    fn retire_database(
        &self,
        epoch: u64,
        _transition: &crate::services::save_coordinator::SaveGuard<'_>,
    ) -> Result<(), AppError> {
        let replacement = crate::engine::duckdb_engine::DuckDbEngine::new_in_memory()?;
        let navigation = Arc::new(TableNavigationService::new(&replacement, 2)?);
        let tabulate = Arc::new(TabulateSessionService::new(&replacement)?);
        let mut database = self
            .state
            .project_database
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let previous = database
            .as_ref()
            .ok_or_else(|| AppError::InvalidParam("project_native_session_required".into()))?;
        if previous.epoch() != epoch {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        let mut live_navigation = self
            .state
            .table_navigation
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut live_tabulate = self
            .state
            .tabulate_sessions
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut project = self
            .state
            .project
            .write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        self.state.graph_new_epoch.fetch_add(1, Ordering::AcqRel);
        self.state.graph_new.shutdown()?;
        live_navigation.shutdown()?;
        live_tabulate.shutdown()?;
        if let Err(error) = previous.prepare_close(epoch) {
            let restored = previous.with_engine(|engine| {
                Ok((
                    Arc::new(TableNavigationService::new(engine, 2)?),
                    Arc::new(TabulateSessionService::new(engine)?),
                ))
            })?;
            *live_navigation = restored.0;
            *live_tabulate = restored.1;
            self.state.graph_new.resume_previous()?;
            return Err(error);
        }
        self.state.db.install_temporary(replacement)?;
        *live_navigation = navigation;
        *live_tabulate = tabulate;
        display.clear();
        *project = None;
        *database = None;
        self.state.graph_new.resume();
        Ok(())
    }
    pub fn snapshot(
        &self,
        epoch: u64,
        destination: &Path,
        first_naming: bool,
    ) -> Result<ProjectSnapshotOutcome, AppError> {
        project_schema::require_v5_capability()?;
        self.snapshot_enabled(epoch, destination, first_naming)
    }
    fn snapshot_enabled(
        &self,
        epoch: u64,
        destination: &Path,
        first_naming: bool,
    ) -> Result<ProjectSnapshotOutcome, AppError> {
        let _ownership = self
            .state
            .project_transition
            .lock()
            .map_err(|_| AppError::Busy("project_transition_unavailable".into()))?;
        let transition = self.state.save_coordinator.begin_save()?;
        let source = self.database(epoch)?;
        let previous_project = self
            .state
            .project
            .read()
            .map_err(|e| AppError::Database(e.to_string()))?
            .clone()
            .ok_or_else(|| AppError::InvalidParam("project_native_session_required".into()))?;
        if first_naming != previous_project.file_path.is_empty() {
            return Err(AppError::InvalidParam(
                "project_snapshot_naming_mode_invalid".into(),
            ));
        }
        if destination.exists() && same_file::is_same_file(source.path(), destination)? {
            return Err(AppError::InvalidParam(
                "project_snapshot_alias_destination".into(),
            ));
        }
        self.retire_database(epoch, &transition)?;
        let snapshot = super::project_snapshot::ProjectSnapshotService::save_as(
            &source,
            destination,
            first_naming,
        );
        let failure = match snapshot {
            Ok(database) => match self.publish_database(Arc::new(database), None, &transition) {
                Ok(summary) => {
                    return Ok(ProjectSnapshotOutcome {
                        active: Some(summary),
                        error: None,
                        destination_published: true,
                    })
                }
                Err(error) => super::project_snapshot::SnapshotFailure {
                    error,
                    destination_published: true,
                },
            },
            Err(failure) => failure,
        };
        let recovered =
            ProjectDatabase::open(source.path(), source.is_read_only()).and_then(|database| {
                self.publish_database(Arc::new(database), Some(previous_project), &transition)
            });
        let (active, message) = match recovered {
            Ok(summary) => (Some(summary), failure.error.to_string()),
            Err(recovery) => {
                self.state.save_coordinator.release_native_context();
                (
                    None,
                    format!("{}; project_recovery_failed: {}", failure.error, recovery),
                )
            }
        };
        Ok(ProjectSnapshotOutcome {
            active,
            error: Some(message),
            destination_published: failure.destination_published,
        })
    }

    pub fn database(&self, epoch: u64) -> Result<Arc<ProjectDatabase>, AppError> {
        let database = self
            .state
            .project_database
            .read()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone()
            .ok_or_else(|| AppError::InvalidParam("project_native_session_required".into()))?;
        if database.epoch() != epoch {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        Ok(database)
    }

    pub fn list_catalog(
        &self,
        epoch: u64,
        request: &CatalogPageRequest,
    ) -> Result<CatalogPage, AppError> {
        self.database(epoch)?
            .with_reader(epoch, |engine| ProjectCatalog::new(engine).list(request))
    }

    pub fn get_document(
        &self,
        epoch: u64,
        id: &str,
        expected_revision: u64,
    ) -> Result<ProjectDocumentBody, AppError> {
        self.database(epoch)?.with_reader(epoch, |engine| {
            ProjectCatalog::new(engine).get_document(id, expected_revision)
        })
    }

    pub fn list_history(
        &self,
        epoch: u64,
        request: &HistoryPageRequest,
    ) -> Result<ProjectHistoryPage, AppError> {
        self.database(epoch)?.with_reader(epoch, |engine| {
            ProjectCatalog::new(engine).list_history(request)
        })
    }

    pub fn commit_records(
        &self,
        context: &ProjectWriteContext,
        patch: &ProjectRecordPatch,
    ) -> Result<ProjectCommit<()>, AppError> {
        self.database(context.expected_epoch)?
            .commit_records(context, patch)
    }

    pub fn import_sptb(&self,context:&ProjectWriteContext,file_path:&str,cancelled:impl Fn()->bool)->Result<ProjectCommit<ProjectTableImportResult>,AppError> {
        self.database(context.expected_epoch)?.import_project_table_file(context,file_path,cancelled)
    }

    pub fn import_file(
        &self,
        context: &ProjectWriteContext,
        file_path: &str,
    ) -> Result<ProjectCommit<crate::models::table::DatasetMeta>, AppError> {
        let stem = Path::new(file_path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("untitled");
        let name =
            crate::services::spprj_archive::normalize_unsafe_portable_basename(stem, "untitled");
        self.database(context.expected_epoch)?.import_project_csv(
            context,
            &crate::services::project_output::ProjectCsvImport {
                source_path: file_path.into(),
                name,
                folder: String::new(),
            },
            || false,
        )
    }

    // Keeps connector progress/cancellation and ownership inputs explicit.
    #[allow(clippy::too_many_arguments)]
    pub fn import_server<F, C>(
        &self,
        context: &ProjectWriteContext,
        definition: crate::models::data_link::ConnectionDefinition,
        credentials: crate::models::data_link::ConnectionCredentials,
        object: crate::models::data_link::SourceObjectRef,
        target_name: &str,
        on_progress: F,
        cancelled: C,
    ) -> Result<ProjectCommit<crate::models::data_link::ImportSummary>, AppError>
    where F: Fn(usize,usize), C: Fn()->bool {
        use sha2::{Digest,Sha256};
        use crate::models::data_link::{ImportSummary,ImportTableSummary};
        // Source identity excludes the password; only its hash enters the receipt digest.
        let identity=serde_json::to_vec(&(&definition,&credentials.username))
            .map_err(|_|AppError::InvalidParam("import_connection_identity_invalid".into()))?;
        let source_name=object.schema.as_ref().map(|schema|format!("{schema}.{}",object.name)).unwrap_or_else(||object.name.clone());
        let request=crate::services::project_output::ProjectServerImport {
            connection_id:format!("{:x}",Sha256::digest(identity)),
            source_description:format!("{}.{source_name}",definition.database),
            object,target_name:target_name.trim().into(),folder:String::new(),
        };
        let database=self.database(context.expected_epoch)?;
        if let Some(commit)=database.preflight_commit::<ImportSummary,_>(context,&("import_server",&request))? {return Ok(commit);}
        let connector=crate::connectors::ServerConnector::new(definition,credentials)
            .map_err(|error|AppError::Database(error.message))?;
        database.import_project_server_snapshot_with_result(context,&request,&connector,on_progress,cancelled,|(_,rows_written)|ImportSummary {
            status:"completed".into(),imported:vec![ImportTableSummary {source_name,target_name:request.target_name.clone(),action:"create".into(),rows_written}],
            skipped:vec![],failed_table:None,error:None,total_rows_written:rows_written,
        })
    }

    pub fn import_sqlite<F, C>(
        &self,
        context: &ProjectWriteContext,
        file_path: &str,
        selections: &[crate::models::data_link::SqliteImportSelection],
        on_progress: F,
        cancelled: C,
    ) -> Result<ProjectCommit<crate::models::data_link::ImportSummary>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        use crate::models::data_link::{ImportSummary, ImportTableSummary};
        self
            .database(context.expected_epoch)?
            .import_project_sqlite_with_result(
                context,
                &crate::services::project_output::ProjectSqliteImport {
                    source_path: file_path.into(),
                    selections: selections.to_vec(),
                    folder: String::new(),
                },
                on_progress,
                cancelled,
                |results| {
            let imported = results
                .into_iter()
                .zip(
                    selections
                        .iter()
                        .filter(|selection| selection.action != "skip"),
                )
                .map(
                    |((source_name, _, rows_written), selection)| ImportTableSummary {
                        source_name,
                        target_name: selection.target_name.clone(),
                        action: selection.action.clone(),
                        rows_written,
                    },
                )
                .collect::<Vec<_>>();
            let skipped = selections
                .iter()
                .filter(|selection| selection.action == "skip")
                .map(|selection| ImportTableSummary {
                    source_name: selection.source_name.clone(),
                    target_name: selection.target_name.clone(),
                    action: selection.action.clone(),
                    rows_written: 0,
                })
                .collect();
            ImportSummary {
                status: "completed".into(),
                total_rows_written: imported.iter().map(|table| table.rows_written).sum(),
                imported,
                skipped,
                failed_table: None,
                error: None,
            }
                },
            )
    }

    pub fn create_transform(
        &self,
        context: &ProjectWriteContext,
        draft: &crate::services::table_transform_domain::TableTransformDraft,
        inputs: &[crate::services::table_transform_service::TableTransformInputBinding],
    ) -> Result<
        ProjectCommit<crate::services::table_transform_service::TableTransformCommandResult>,
        AppError,
    > {
        self.database(context.expected_epoch)?
            .create_project_transform(
                context,
                &crate::services::project_output::ProjectTransformCreate {
                    draft: draft.clone(),
                    inputs: inputs.to_vec(),
                    folder: String::new(),
                },
            )
    }

    pub fn run_transform(
        &self,
        context: &ProjectWriteContext,
        definition: &crate::services::table_transform_domain::TableTransformDefinition,
        binding: &crate::services::table_transform_service::TableTransformProjectBinding,
        input_bindings: Option<
            &[crate::services::table_transform_service::TableTransformInputBinding],
        >,
    ) -> Result<
        ProjectCommit<crate::services::table_transform_service::TableTransformCommandResult>,
        AppError,
    > {
        self.database(context.expected_epoch)?
            .run_project_transform(
                context,
                &crate::services::project_output::ProjectTransformRun {
                    definition: definition.clone(),
                    binding: binding.clone(),
                    input_bindings: input_bindings.map(|inputs| inputs.to_vec()),
                },
            )
    }

    pub fn materialize_sql(
        &self,
        context: &ProjectWriteContext,
        sql: &str,
        name: &str,
    ) -> Result<ProjectCommit<crate::models::table::DatasetMeta>, AppError> {
        self.database(context.expected_epoch)?
            .materialize_project_sql(
                context,
                &crate::services::project_output::ProjectSqlOutput {
                    name: name.into(),
                    sql: sql.into(),
                    folder: String::new(),
                },
            )
    }

    pub fn create_managed_table(
        &self,
        context: &ProjectWriteContext,
        request: &crate::models::table::CreateManagedTableRequest,
    ) -> Result<ProjectCommit<crate::models::table::ManagedTableCreateResult>, AppError> {
        self.create_managed_table_with_result(context,request,"create_managed_table",|result|result)
    }

    fn create_managed_table_with_result<T,M>(
        &self,context:&ProjectWriteContext,request:&crate::models::table::CreateManagedTableRequest,command:&str,project:M,
    )->Result<ProjectCommit<T>,AppError>
    where T:serde::Serialize+serde::de::DeserializeOwned,M:FnOnce(crate::models::table::ManagedTableCreateResult)->T {
        use crate::models::table::ManagedTableCreateResult;
        self.database(context.expected_epoch)?.commit_with_effects(
            context,
            &(command, request),
            |engine| {
                let (resolved, display, columns) =
                    crate::services::data_service::DataService::prepare_managed_table(
                        engine, request,
                    )?;
                let id = uuid::Uuid::new_v4().to_string();
                let dataset = if resolved.column_names.is_empty() {
                    engine.create_empty_table(&id, &resolved.name, &[], &[])?
                } else {
                    engine.create_table_from_rows_in_transaction(&id, &resolved)?
                };
                let catalog = ProjectCatalog::new(engine);
                catalog.publish_new_table(&dataset, "")?;
                let setting_ids = if display.is_empty() {
                    vec![]
                } else {
                    let key = format!("display:{id}");
                    catalog.apply_patch(&ProjectRecordPatch {
                        settings: vec![ProjectSettingWrite {
                            key: key.clone(),
                            expected_revision: None,
                            value: serde_json::to_value(display)
                                .map_err(|error| AppError::InvalidParam(error.to_string()))?,
                        }],
                        ..Default::default()
                    })?;
                    vec![key]
                };
                Ok(crate::services::project_transaction::CommitEffects {
                    value: project(ManagedTableCreateResult {
                        generation: dataset.generation,
                        dataset,
                        columns,
                    }),
                    dataset_ids: vec![id.clone()],
                    document_ids: vec![id],
                    setting_ids,
                })
            },
        )
    }

    pub fn create_table_from_rows(
        &self,
        context: &ProjectWriteContext,
        request: &crate::models::table::CreateTableFromRowsRequest,
    ) -> Result<ProjectCommit<crate::models::table::DatasetMeta>, AppError> {
        if request.column_names.len() != request.column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }
        let managed = crate::models::table::CreateManagedTableRequest {
            name: request.name.clone(),
            columns: request
                .column_names
                .iter()
                .zip(&request.column_types)
                .map(|(name, kind)| crate::models::table::CreateTableColumn {
                    name: name.clone(),
                    column_type: kind.clone(),
                    display: None,
                })
                .collect(),
            rows: request.rows.clone(),
        };
        self.create_managed_table_with_result(context,&managed,"create_table_from_rows",|result|result.dataset)
    }

    pub fn workflow_run_state(&self,epoch:u64,workflow_id:&str,workflow_revision:u64)->Result<ProjectWorkflowRunState,AppError> {
        self.database(epoch)?.with_reader(epoch,|engine|super::project_workflow_runs::read_state(engine,workflow_id,workflow_revision))
    }

    pub fn get_setting(
        &self,
        epoch: u64,
        key: &str,
    ) -> Result<Option<ProjectSettingRecord>, AppError> {
        if key.is_empty() {
            return Err(AppError::InvalidParam("project_setting_key_invalid".into()));
        }
        self.database(epoch)?.with_reader(epoch, |engine| {
            let Some((revision,mut value))=ProjectCatalog::new(engine).get_setting(key)? else {return Ok(None);};
            if let Some(dataset) = key.strip_prefix("display:") {
                value=serde_json::to_value(super::project_column_settings::read(engine,dataset)?).map_err(|_|AppError::InvalidParam("project_display_setting_invalid".into()))?;
            }
            if let Some(dataset) = key.strip_prefix("filter:") {
                value=super::project_column_filters::effective(engine,dataset,value)?;
            }
            if key=="lineage"&&!value.is_null() {
                use crate::services::workflow_domain::{LineageNode,ProjectLineageGraph,validate_lineage_graph};
                let graph:ProjectLineageGraph=serde_json::from_value(value.clone()).map_err(|_|AppError::InvalidParam("project_setting_invalid".into()))?;
                // Missing source documents remain catalog validity information.
                let declared=graph.nodes.iter().filter_map(|node|match node {LineageNode::Artifact(node)=>Some(node.document_ref.clone()),LineageNode::Operation(node)=>node.document_ref.clone()}).collect();
                validate_lineage_graph(&graph,&declared)?;
                // Normalize omitted defaults without dropping extension properties.
                let fields=value.as_object_mut().expect("validated lineage object");
                fields.entry("name").or_insert(serde_json::json!(graph.name));
                fields.entry("graphVersion").or_insert(serde_json::json!(graph.graph_version));
                fields.entry("graphHash").or_insert(serde_json::json!(graph.graph_hash));
                fields.entry("nodes").or_insert(serde_json::json!([]));
                fields.entry("edges").or_insert(serde_json::json!([]));
            }
            if let Some(id)=key.strip_prefix("transformBinding:").filter(|_|!value.is_null()) {
                let binding:crate::services::table_transform_service::PersistedTableTransformBinding=serde_json::from_value(value.clone()).map_err(|_|AppError::InvalidParam("project_setting_invalid".into()))?;
                if binding.binding.definition_id!=id {return Err(AppError::InvalidParam("project_setting_invalid".into()));}
                let fields=value.as_object_mut().expect("validated binding object");
                fields.entry("inputs").or_insert(serde_json::json!([]));
                fields.entry("schemaReports").or_insert(serde_json::json!([]));
            }
            Ok(Some(ProjectSettingRecord {key:key.into(),revision,value}))
        })
    }

    pub fn column_display_props(
        &self,
        epoch: u64,
        dataset_id: &str,
    ) -> Result<Vec<crate::models::table::ColumnDisplayProps>, AppError> {
        self.database(epoch)?.with_reader(epoch, |engine| {
            super::project_column_settings::read(engine,dataset_id)
        })
    }

    pub fn rename_dataset(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        new_name: &str,
    ) -> Result<ProjectCommit<()>, AppError> {
        if !context
            .dataset_generations
            .iter()
            .any(|dataset| dataset.id == dataset_id)
        {
            return Err(AppError::InvalidParam(
                "project_dataset_precondition_required".into(),
            ));
        }
        self.database(context.expected_epoch)?.commit_with_effects(
            context,
            &("rename_dataset", dataset_id, new_name),
            |engine| {
                let catalog = ProjectCatalog::new(engine);
                let summary = catalog.summary(dataset_id)?;
                if summary.kind != ProjectDocumentKind::Table {
                    return Err(AppError::InvalidParam("project_table_required".into()));
                }
                catalog.apply_patch(&ProjectRecordPatch {
                    directory_moves: vec![DirectoryMove {
                        id: dataset_id.into(),
                        expected_revision: summary.revision,
                        folder: summary.folder,
                        name: Some(new_name.into()),
                    }],
                    ..Default::default()
                })?;
                Ok(crate::services::project_transaction::CommitEffects {
                    value: (),
                    dataset_ids: vec![dataset_id.into()],
                    document_ids: vec![dataset_id.into()],
                    setting_ids: vec![],
                })
            },
        )
    }

    pub fn set_column_display_props(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        column_ids: &[String],
        props: &[crate::models::table::ColumnDisplayProps],
    ) -> Result<ProjectCommit<()>, AppError> {
        if !context
            .dataset_generations
            .iter()
            .any(|dataset| dataset.id == dataset_id)
        {
            return Err(AppError::InvalidParam(
                "project_dataset_precondition_required".into(),
            ));
        }
        self.database(context.expected_epoch)?.commit_with_effects(
            context,
            &("set_column_display_props", dataset_id, column_ids, props),
            |engine| {
                let columns = engine.get_table_column_descriptors(dataset_id)?;
                if columns
                    .iter()
                    .map(|column| &column.column_id)
                    .ne(column_ids.iter())
                {
                    return Err(AppError::InvalidParam(
                        "project_column_identity_stale".into(),
                    ));
                }
                let mut seen = std::collections::HashSet::new();
                for prop in props {
                    if prop.col_index >= columns.len() || !seen.insert(prop.col_index) {
                        return Err(AppError::InvalidParam(
                            "invalid display column index".into(),
                        ));
                    }
                    crate::services::data_service::DataService::validate_display_without_index(
                        &crate::models::table::ColumnDisplayPropsWithoutIndex {
                            width: prop.width,
                            format: prop.format.clone(),
                            extras: prop.extras.clone(),
                        },
                    )?;
                }
                let catalog = ProjectCatalog::new(engine);
                let key = format!("display:{dataset_id}");
                let expected_revision = catalog.get_setting(&key)?.map(|setting| setting.0);
                catalog.apply_patch(&ProjectRecordPatch {
                    settings: vec![ProjectSettingWrite {
                        key: key.clone(),
                        expected_revision,
                        value: super::project_column_settings::replacement(engine,dataset_id,props)?,
                    }],
                    ..Default::default()
                })?;
                Ok(crate::services::project_transaction::CommitEffects {
                    value: (),
                    dataset_ids: vec![dataset_id.into()],
                    document_ids: vec![],
                    setting_ids: vec![key],
                })
            },
        )
    }

    fn commit_table_change<T: serde::Serialize + serde::de::DeserializeOwned>(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        expected_generation: u64,
        request: &impl serde::Serialize,
        apply: impl FnOnce(&crate::engine::duckdb_engine::DuckDbEngine) -> Result<T, AppError>,
    ) -> Result<ProjectCommit<T>, AppError> {
        if !context
            .dataset_generations
            .iter()
            .any(|dataset| dataset.id == dataset_id && dataset.generation == expected_generation)
        {
            return Err(AppError::InvalidParam(
                "project_dataset_precondition_required".into(),
            ));
        }
        self.database(context.expected_epoch)?
            .commit_with_effects(context, request, |engine| {
                Ok(crate::services::project_transaction::CommitEffects {
                    value: apply(engine)?,
                    dataset_ids: vec![dataset_id.into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            })
    }

    pub fn paste(&self,context:&ProjectWriteContext,request:&ProjectPasteRequest)->Result<ProjectCommit<crate::models::table::PasteChangeSetResult>,AppError> {
        self.commit_column_schema(context,&request.dataset_id,request.expected_generation,&("paste_at_position_with_change_set",request),|engine| {
            super::project_paste::paste_in_transaction(engine,request)
        })
    }

    pub fn resolve_operation(&self,context:&ProjectWriteContext)->Result<ProjectOperationResolution,AppError> {
        self.database(context.expected_epoch)?.resolve_operation(context)
    }

    pub fn run_workflow(
        &self,context:&ProjectWriteContext,request:&super::workflow_executor::WorkflowRunRequest,folder:&str,
    )->Result<ProjectCommit<super::workflow_executor::WorkflowRunCommitPacket>,AppError> {
        let database=self.database(context.expected_epoch)?;
        if let Some(receipt)=database.preflight_commit(context,&("run_workflow",request,folder))? {return Ok(receipt);}
        database.with_engine(|engine| {
            let revision=context.document_revisions.iter().find(|item|item.id==request.workflow.id).ok_or_else(||AppError::InvalidParam("project_document_precondition_required".into()))?.revision;
            let document=ProjectCatalog::new(engine).get_document(&request.workflow.id,revision)?;
            if document.summary.kind!=ProjectDocumentKind::Workflow || document.summary.folder!=folder || document.body!=serde_json::to_value(&request.workflow).map_err(|e|AppError::InvalidParam(e.to_string()))? {return Err(AppError::InvalidParam("project_workflow_definition_stale".into()));}
            super::workflow_executor::validate_native_bindings(request)?;
            for input in &request.input_bindings {
                if !context.dataset_generations.iter().any(|item|item.id==input.table_document_id) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
            }
            use duckdb::OptionalExt;
            for output in &request.output_bindings {
                let current:Option<(String,u64)>=engine.conn().query_row("SELECT kind,revision FROM _project_directory WHERE id=?",[&output.artifact_document_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((kind,revision))=current {
                    if !context.document_revisions.iter().any(|item|item.id==output.artifact_document_id&&item.revision==revision) {return Err(AppError::InvalidParam("project_document_precondition_required".into()));}
                    if kind=="table"&&!context.dataset_generations.iter().any(|item|item.id==output.artifact_document_id) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
                }
            }
            Ok(())
        })?;
        super::workflow_executor::WorkflowExecutor::new(self.state).execute_native(&database,context,request,folder)
    }

    pub fn materialize_tabulate(
        &self,context:&ProjectWriteContext,request:&crate::models::tabulate::TabulateMaterializeRequest,
    )->Result<ProjectCommit<crate::models::table::DatasetMeta>,AppError> {
        self.database(context.expected_epoch)?.commit_with_effects(context,&("materialize_tabulate_table",request),|engine| {
            let sessions=self.state.tabulate_sessions.read().map_err(|e|AppError::Database(e.to_string()))?.clone();
            sessions.with_materialization_definition(request,|definition,budget| {
                if !context.dataset_generations.iter().any(|source|source.id==definition.dataset_id&&source.generation==definition.source_generation) {
                    return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));
                }
                let id=uuid::Uuid::parse_str(&request.session_id).map_err(|_|AppError::InvalidParam("tabulate_session_unavailable".into()))?;
                engine.prepare_tabulate_member_indexes_in_transaction(definition,&id,budget)?;
                let meta=engine.materialize_tabulate_table_in_transaction(definition,&id,request,|_|Ok(()))?;
                engine.drop_tabulate_member_indexes(&id)?;
                let event=ProjectCatalog::new(engine).publish_new_table(&meta,"")?;
                engine.conn().execute("INSERT INTO _project_output_events VALUES (?, ?, 'tabulate', ?)",duckdb::params![event.id,&meta.id,meta.generation])?;
                Ok(super::project_transaction::CommitEffects {dataset_ids:vec![meta.id.clone()],document_ids:vec![],setting_ids:vec![],value:meta})
            })
        })
    }

    pub fn save_fit_model_columns(
        &self,context:&ProjectWriteContext,request:&crate::models::fit_model::SaveFitModelColumnsRequest,
    )->Result<ProjectCommit<crate::models::fit_model::SaveFitModelColumnsResult>,AppError> {
        self.commit_column_schema(context,&request.dataset_id,request.expected_generation,&("save_fit_model_columns",request),|engine| {
            super::fit_model_service::save_columns_in_transaction(engine,request)
        })
    }

    pub fn delete_dataset(&self,context:&ProjectWriteContext,dataset_id:&str)->Result<ProjectCommit<()>,AppError> {
        if !context.dataset_generations.iter().any(|item|item.id==dataset_id) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
        self.database(context.expected_epoch)?.commit_with_effects(context,&("delete_dataset",dataset_id),|engine| {
            super::project_table_lifecycle::retire_storage(engine,dataset_id)?;
            let event=super::project_table_lifecycle::record_deletion(engine,dataset_id)?;
            let effects=super::project_table_retirement::retire_metadata(engine,&event)?;
            Ok(super::project_transaction::CommitEffects {value:(),dataset_ids:vec![],document_ids:effects.document_ids,setting_ids:effects.setting_ids})
        })
    }

    pub fn history_frontier(&self,epoch:u64,dataset:Option<&str>,undo:bool)->Result<ProjectHistoryFrontier,AppError> {
        self.database(epoch)?.with_reader(epoch,|engine|super::project_history_frontier::frontier(engine,dataset,undo))
    }

    pub fn table_lifecycle_event(&self,epoch:u64,id:&str)->Result<ProjectTableLifecycleEvent,AppError> {
        self.database(epoch)?.with_reader(epoch,|engine|super::project_table_lifecycle::get_event(engine,id)?.ok_or_else(||AppError::InvalidParam("project_lifecycle_event_missing".into())))
    }

    pub fn apply_table_lifecycle(&self,context:&ProjectWriteContext,id:&str,event_revision:u64,undo:bool)->Result<ProjectCommit<()>,AppError> {
        self.database(context.expected_epoch)?.commit_with_effects(context,&("apply_project_table_lifecycle",id,event_revision,undo),|engine| {
            let event=super::project_table_lifecycle::authorize_replay(engine,id,event_revision,undo)?;
            let active_before=(event.operation=="create_table")==event.applied;
            if active_before&&!context.dataset_generations.iter().any(|item|item.id==event.dataset_id) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
            let activate=(event.operation=="delete_table")==undo;
            let effects=if activate {
                super::project_table_lifecycle::restore_storage(engine,&event.dataset_id)?;
                super::project_table_retirement::restore_metadata(engine,&event)?
            } else {
                super::project_table_lifecycle::retire_storage(engine,&event.dataset_id)?;
                super::project_table_retirement::retire_metadata(engine,&event)?
            };
            super::project_table_lifecycle::mark_replayed(engine,&event,undo)?;
            Ok(super::project_transaction::CommitEffects {value:(),dataset_ids:if activate {vec![event.dataset_id]} else {vec![]},document_ids:effects.document_ids,setting_ids:effects.setting_ids})
        })
    }

    pub fn alter_column(
        &self,context:&ProjectWriteContext,dataset_id:&str,old_name:&str,new_name:&str,new_type:&str,expected_generation:u64,
    )->Result<ProjectCommit<String>,AppError> {
        self.commit_column_schema(context,dataset_id,expected_generation,&("alter_column_with_change_set",dataset_id,old_name,new_name,new_type,expected_generation),|engine| {
            let column=engine.get_user_column_descriptors(dataset_id)?.into_iter().find(|column|column.name==old_name).ok_or_else(||AppError::InvalidParam(format!("unknown column: {old_name}")))?;
            if column.sql_type==engine.canonicalize_column_type_for_create(new_type)? {
                super::table_delta_mutation::rename_column_compact_in_transaction(engine,dataset_id,old_name,new_name,expected_generation)
            } else {engine.alter_column_with_change_set_in_transaction(dataset_id,old_name,new_name,new_type,Some(expected_generation),true)}
        })
    }

    pub fn alter_column_types(
        &self,context:&ProjectWriteContext,dataset_id:&str,column_names:&[String],new_type:&str,expected_generation:u64,
    )->Result<ProjectCommit<String>,AppError> {
        self.commit_column_schema(context,dataset_id,expected_generation,&("alter_columns_type_with_change_set",dataset_id,column_names,new_type,expected_generation),|engine|engine.alter_columns_type_with_change_set_in_transaction(dataset_id,column_names,new_type,Some(expected_generation),true))
    }

    fn commit_column_schema<T:serde::Serialize+serde::de::DeserializeOwned>(
        &self,context:&ProjectWriteContext,dataset_id:&str,expected_generation:u64,request:&impl serde::Serialize,
        apply:impl FnOnce(&crate::engine::duckdb_engine::DuckDbEngine)->Result<T,AppError>,
    )->Result<ProjectCommit<T>,AppError> {
        if !context.dataset_generations.iter().any(|item|item.id==dataset_id&&item.generation==expected_generation) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
        self.database(context.expected_epoch)?.commit_with_effects(context,request,|engine| {
            let before=super::project_column_settings::schema_signature(engine,dataset_id)?;
            let display=super::project_column_settings::stabilize(engine,dataset_id)?;
            let filters=super::project_column_filters::capture(engine,dataset_id)?;
            let value=apply(engine)?;
            let filter=if before!=super::project_column_settings::schema_signature(engine,dataset_id)? {super::project_column_filters::publish(engine,filters)?} else {None};
            Ok(super::project_transaction::CommitEffects {value,dataset_ids:vec![dataset_id.into()],document_ids:vec![],setting_ids:display.into_iter().chain(filter).collect()})
        })
    }

    pub fn upsert_calculated_column(
        &self, context: &ProjectWriteContext, input: &super::calculated_column_service::UpsertCalculatedColumnInput,
    ) -> Result<ProjectCommit<crate::models::calculated_column::CalculatedColumnMutationResult>, AppError> {
        let generation=input.expected_generation.or_else(||context.dataset_generations.iter().find(|item|item.id==input.dataset_id).map(|item|item.generation)).ok_or_else(||AppError::InvalidParam("project_dataset_precondition_required".into()))?;
        if !context.dataset_generations.iter().any(|item|item.id==input.dataset_id&&item.generation==generation) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
        self.database(context.expected_epoch)?.commit_with_effects(context,&("upsert_calculated_column",input),|engine| {
            let display=super::project_column_settings::stabilize(engine,&input.dataset_id)?;
            let before=super::project_column_settings::schema_signature(engine,&input.dataset_id)?;
            let filters=super::project_column_filters::capture(engine,&input.dataset_id)?;
            let value=super::calculated_column_service::CalculatedColumnService::new(self.state).upsert_in_transaction(engine,input)?;
            let filter=if before!=super::project_column_settings::schema_signature(engine,&input.dataset_id)? {super::project_column_filters::publish(engine,filters)?} else {None};
            Ok(super::project_transaction::CommitEffects {value,dataset_ids:vec![input.dataset_id.clone()],document_ids:vec![],setting_ids:display.into_iter().chain(filter).collect()})
        })
    }

    pub fn convert_calculated_column_to_values(
        &self,context:&ProjectWriteContext,dataset_id:&str,column_id:&str,expected_generation:u64,
    ) -> Result<ProjectCommit<crate::models::calculated_column::CalculatedColumnMutationResult>,AppError> {
        self.commit_table_change(context,dataset_id,expected_generation,&("convert_calculated_column_to_values",dataset_id,column_id,expected_generation),|engine| {
            super::table_delta_mutation::convert_calculated_compact_in_transaction(engine,dataset_id,column_id,expected_generation)
        })
    }

    pub fn reorder_columns(
        &self,context:&ProjectWriteContext,dataset_id:&str,from:i32,to:i32,expected_generation:u64,
    ) -> Result<ProjectCommit<u64>,AppError> {
        if !context.dataset_generations.iter().any(|item|item.id==dataset_id&&item.generation==expected_generation) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
        self.database(context.expected_epoch)?.commit_with_effects(context,&("reorder_column_if_generation",dataset_id,from,to,expected_generation),|engine| {
            let setting=super::project_column_settings::stabilize(engine,dataset_id)?;
            let value=super::table_delta_mutation::reorder_columns_compact_in_transaction(engine,dataset_id,from,to,expected_generation)?;
            Ok(super::project_transaction::CommitEffects {value,dataset_ids:vec![dataset_id.into()],document_ids:vec![],setting_ids:setting.into_iter().collect()})
        })
    }

    pub fn delete_columns(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        columns: &[crate::models::table::ColumnDescriptor],
        expected_generation: u64,
    ) -> Result<ProjectCommit<crate::models::table::ColumnMutationResult>, AppError> {
        if !context.dataset_generations.iter().any(|item|item.id==dataset_id&&item.generation==expected_generation) {return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));}
        self.database(context.expected_epoch)?.commit_with_effects(context,&("delete_columns_with_change_set",dataset_id,columns,expected_generation),|engine| {
            let existing=engine.get_user_column_descriptors(dataset_id)?;
            let resolved=columns.iter().map(|column|existing.iter().find(|current|current.column_id==column.column_id&&current.name==column.name&&current.sql_type==column.sql_type).cloned().ok_or_else(||AppError::InvalidParam("one or more column descriptors are stale or mismatched".into()))).collect::<Result<Vec<_>,_>>()?;
            let display=super::project_column_settings::stabilize(engine,dataset_id)?;
            let filters=super::project_column_filters::capture(engine,dataset_id)?;
            let value=super::table_delta_mutation::delete_columns_compact_in_transaction(engine,dataset_id,&resolved,expected_generation)?;
            let filter=super::project_column_filters::publish(engine,filters)?;
            Ok(super::project_transaction::CommitEffects {value,dataset_ids:vec![dataset_id.into()],document_ids:vec![],setting_ids:display.into_iter().chain(filter).collect()})
        })
    }

    pub fn add_columns(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        columns: &[crate::models::table::ColumnDescriptor],
        at_index: Option<i32>,
        expected_generation: u64,
    ) -> Result<ProjectCommit<crate::models::table::ColumnMutationResult>, AppError> {
        if !context.dataset_generations.iter().any(|item|item.id==dataset_id&&item.generation==expected_generation) {
            return Err(AppError::InvalidParam("project_dataset_precondition_required".into()));
        }
        self.database(context.expected_epoch)?.commit_with_effects(context,&("add_columns_with_change_set",dataset_id,columns,at_index,expected_generation),|engine| {
            if columns.iter().any(|column|column.calculated.is_some()) {return Err(AppError::InvalidParam("physical column addition does not accept calculated descriptors".into()));}
            let count=i32::try_from(engine.get_user_column_descriptors(dataset_id)?.len()).map_err(|_|AppError::InvalidParam("column count is too large".into()))?;
            let at=at_index.unwrap_or(count);
            let descriptors=columns.iter().enumerate().map(|(offset,column)| {
                let col_index=at.checked_add(i32::try_from(offset).map_err(|_|AppError::InvalidParam("column count is too large".into()))?).ok_or_else(||AppError::InvalidParam("column insertion index overflowed".into()))?;
                Ok(crate::engine::duckdb_engine::UserColumnDescriptor {column_id:column.column_id.clone(),col_index,name:column.name.clone(),sql_type:column.sql_type.clone()})
            }).collect::<Result<Vec<_>,AppError>>()?;
            let setting=super::project_column_settings::stabilize(engine,dataset_id)?;
            let value=super::table_delta_mutation::add_columns_compact_in_transaction(engine,dataset_id,&descriptors,at,expected_generation)?;
            Ok(super::project_transaction::CommitEffects {value,dataset_ids:vec![dataset_id.into()],document_ids:vec![],setting_ids:setting.into_iter().collect()})
        })
    }

    pub fn add_rows(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        count: usize,
        before_row_id: Option<i64>,
        expected_generation: u64,
    ) -> Result<ProjectCommit<crate::models::table::RowMutationResult>, AppError> {
        self.commit_table_change(
            context,
            dataset_id,
            expected_generation,
            &(
                "add_rows",
                dataset_id,
                count,
                before_row_id,
                expected_generation,
            ),
            |engine| {
                crate::services::table_delta_mutation::add_rows_compact_in_transaction(
                    engine,
                    dataset_id,
                    count,
                    before_row_id,
                    expected_generation,
                )
            },
        )
    }

    pub fn delete_rows(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        row_ids: &[i64],
        expected_generation: u64,
    ) -> Result<ProjectCommit<crate::models::table::RowMutationResult>, AppError> {
        self.commit_table_change(
            context,
            dataset_id,
            expected_generation,
            &(
                "delete_rows_with_change_set",
                dataset_id,
                row_ids,
                expected_generation,
            ),
            |engine| {
                crate::services::table_delta_mutation::delete_rows_compact_in_transaction(
                    engine,
                    dataset_id,
                    row_ids,
                    expected_generation,
                )
            },
        )
    }

    pub fn apply_change_set(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        change_set_id: &str,
        undo: bool,
    ) -> Result<ProjectCommit<()>, AppError> {
        use duckdb::OptionalExt;
        context
            .dataset_generations
            .iter()
            .find(|dataset| dataset.id == dataset_id)
            .map(|dataset| dataset.generation)
            .ok_or_else(|| {
                AppError::InvalidParam("project_dataset_precondition_required".into())
            })?;
        self.database(context.expected_epoch)?.commit_with_effects(
            context,
            &("apply_table_change_set", dataset_id, change_set_id, undo),
            |engine| {
                let owner: Option<String> = engine
                    .conn()
                    .query_row(
                        "SELECT dataset_id FROM _history_change_sets WHERE id=?",
                        [change_set_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if owner.as_deref() != Some(dataset_id) {
                    return Err(AppError::InvalidParam(
                        "project_history_dataset_mismatch".into(),
                    ));
                }
                super::project_table_lifecycle::authorize_regular_replay(engine,dataset_id,change_set_id,undo)?;
                let before=super::project_column_settings::schema_signature(engine,dataset_id)?;
                let display=super::project_column_settings::stabilize(engine,dataset_id)?;
                let filters=super::project_column_filters::capture(engine,dataset_id)?;
                engine.apply_change_set_in_transaction(change_set_id, undo)?;
                let filter=if before!=super::project_column_settings::schema_signature(engine,dataset_id)? {super::project_column_filters::publish(engine,filters)?} else {None};
                Ok(super::project_transaction::CommitEffects {value:(),dataset_ids:vec![dataset_id.into()],document_ids:vec![],setting_ids:display.into_iter().chain(filter).collect()})
            },
        )
    }

    fn mutate_cells<T: serde::Serialize + serde::de::DeserializeOwned>(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        updates: &[crate::models::table::CellUpdate],
        expected_generation: Option<u64>,
        command: &str,
        result: impl FnOnce(u64) -> T,
    ) -> Result<ProjectCommit<T>, AppError> {
        let generation = context
            .dataset_generations
            .iter()
            .find(|dataset| dataset.id == dataset_id)
            .map(|dataset| dataset.generation)
            .ok_or_else(|| {
                AppError::InvalidParam("project_dataset_precondition_required".into())
            })?;
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err(AppError::InvalidParam(
                "project_dataset_precondition_mismatch".into(),
            ));
        }
        self.database(context.expected_epoch)?.commit_with_effects(
            context,
            &(command, dataset_id, updates, expected_generation),
            |engine| {
                engine.reject_calculated_column_writes(
                    dataset_id,
                    updates.iter().map(|update| update.column_name.as_str()),
                )?;
                if !updates.is_empty() {
                    crate::services::project_cell_mutation::update_cells_compact_in_transaction(engine,dataset_id,updates,generation)?;
                }
                let committed_generation=engine.get_dataset_generation(dataset_id)?;
                Ok(crate::services::project_transaction::CommitEffects {
                    value: result(committed_generation),
                    dataset_ids: vec![dataset_id.into()],
                    document_ids: vec![],
                    setting_ids: vec![],
                })
            },
        )
    }

    pub fn update_cells(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        updates: &[crate::models::table::CellUpdate],
        expected_generation: Option<u64>,
    ) -> Result<ProjectCommit<u64>, AppError> {
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        let span=(dataset_id=="perf-data").then(||crate::perf_project_v5_ui::operation_span(crate::perf_project_v5_ui::ProbeScenario::Edit,Some(context.expected_epoch),None)).flatten();
        let result=self.mutate_cells(
            context,dataset_id,updates,expected_generation,"update_cells",|generation| generation,
        );
        #[cfg(all(feature="project-v5",feature="perf-harness"))]
        crate::perf_project_v5_ui::finish_span(span,&result);
        result
    }

    pub fn clear_cells(
        &self,
        context: &ProjectWriteContext,
        dataset_id: &str,
        cells: &[crate::models::table::CellPosition],
    ) -> Result<ProjectCommit<()>, AppError> {
        let updates = cells
            .iter()
            .map(|cell| crate::models::table::CellUpdate {
                row_id: cell.row_id,
                column_name: cell.column_name.clone(),
                value: None,
            })
            .collect::<Vec<_>>();
        self.mutate_cells(context, dataset_id, &updates, None, "clear_cells", |_| ())
    }

    pub fn status(&self, epoch: u64) -> Result<ProjectPersistenceStatus, AppError> {
        let database = self.database(epoch)?;
        Ok(ProjectPersistenceStatus {
            epoch,
            committed_revision: database.committed_revision()?,
            writable: !database.is_read_only(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::duckdb_engine::{
        full_anchor_rebuild_counter, reset_full_anchor_rebuild_counter,
    };
    use crate::models::project_persistence::*;
    use crate::services::project_catalog::ProjectCatalog;
    use crate::services::project_database::ProjectDatabase;
    use crate::services::{project_table_restore, table_mutation_coordinator};
    use crate::state::AppState;
    use duckdb::params;

    fn fixture(path: &std::path::Path) {
        let db = ProjectDatabase::create(path, false).unwrap();
        db.with_engine(|engine| {
            engine.conn().execute_batch("INSERT INTO _meta_datasets(id,name,source_type,row_count,col_count) VALUES ('table','Huge table','manual',10000000,20)")?;
            let catalog = ProjectCatalog::new(engine);
            catalog.publish_table(&catalog.describe_table("table")?, "Data")?;
            engine.conn().execute("INSERT INTO _project_documents VALUES ('report',1,1,?)", ["unparsed-body".repeat(100000)])?;
            engine.conn().execute_batch("INSERT INTO _project_directory VALUES ('report','report','Report','Data',1,'[]');
                CREATE TABLE _history_before_00000000_0000_0000_0000_000000000001 AS SELECT 1 AS _row_id,repeat('x', 2000000) AS value;
                INSERT INTO _history_change_sets(id,dataset_id,applied,generation,storage_kind) VALUES ('00000000-0000-0000-0000-000000000001','table',TRUE,0,'full');
                INSERT INTO _history_timeline VALUES ('00000000-0000-0000-0000-000000000001','table',0,'full','bulk_edit',0,1,0,TRUE,repeat('unparsed-schema',100000),'[]')")?;
            engine.conn().execute("INSERT INTO _project_settings VALUES ('filter:table',1,?)", params!["[]"])?;
            Ok(())
        }).unwrap();
        db.shutdown().unwrap();
    }

    #[test]
    fn project_v5_lifecycle_refused_close_restores_read_services_and_keeps_active_path() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("active.spprj");
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let opened = service.open_enabled(&path, false).unwrap();
        let database = service.database(opened.epoch).unwrap();
        let retained_engine = database.with_engine(|engine| engine.try_clone()).unwrap();
        let previous_navigation = state.table_navigation.read().unwrap().clone();
        assert!(service
            .close_enabled(opened.epoch)
            .unwrap_err()
            .to_string()
            .contains("project_readers_still_active"));
        assert_eq!(
            state.project.read().unwrap().as_ref().unwrap().file_path,
            opened.project.file_path
        );
        assert!(service.database(opened.epoch).unwrap().header().is_ok());
        assert_eq!(database.checkpoint_count(), 0);
        assert!(previous_navigation
            .get_table_query_session_status("retired")
            .unwrap_err()
            .to_string()
            .contains("table_navigation_closed"));
        assert!(!state
            .table_navigation
            .read()
            .unwrap()
            .get_table_query_session_status("unknown")
            .unwrap_err()
            .to_string()
            .contains("table_navigation_closed"));
        drop(retained_engine);
        service.close_enabled(opened.epoch).unwrap();
        assert_eq!(database.checkpoint_count(), 1);
        ProjectDatabase::open(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
    }

    #[test]
    fn project_v5_navigation_repairs_only_requested_dataset_once_and_persists_manifest() {
        use crate::engine::duckdb_engine::{
            full_anchor_rebuild_counter, reset_full_anchor_rebuild_counter,
        };
        use crate::models::table::TableWindowRequest;
        use crate::services::data_service::DataService;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("repair.spprj");
        let database = ProjectDatabase::create(&path, false).unwrap();
        database.with_engine(|engine| {
            for id in ["selected", "other"] {
                engine.seed_benchmark_table(id, id, 10000, 1)?;
                ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta(id)?, "")?;
            }
            engine.conn().execute_batch("DELETE FROM _table_navigation_anchors; DELETE FROM _table_navigation_anchor_manifests")?;
            Ok(())
        }).unwrap();
        database.shutdown().unwrap();
        reset_full_anchor_rebuild_counter();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let opened = service.open_enabled(&path, false).unwrap();
        assert_eq!(
            full_anchor_rebuild_counter(),
            0,
            "open must not repair any dataset"
        );
        for start in [4093, 9995, 0] {
            let result = DataService::new(&state)
                .query_table_window(&TableWindowRequest {
                    dataset_id: "selected".into(),
                    start,
                    count: 5,
                    sort: None,
                    filters: vec![],
                    generation: 0,
                })
                .unwrap();
            assert_eq!(result.rows[0][1].as_i64().unwrap(), start as i64 + 1);
            assert_eq!(result.total_rows, 10000);
        }
        assert_eq!(full_anchor_rebuild_counter(), 1);
        service.database(opened.epoch).unwrap().with_engine(|engine| {
            assert_eq!(engine.conn().query_row("SELECT count(*) FROM _table_navigation_anchor_manifests WHERE dataset_id='other'", [], |row| row.get::<_,i64>(0))?, 0);
            Ok(())
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();
        let readonly = service.open_enabled(&path, true).unwrap();
        DataService::new(&state)
            .query_table_window(&TableWindowRequest {
                dataset_id: "selected".into(),
                start: 9995,
                count: 5,
                sort: None,
                filters: vec![],
                generation: 0,
            })
            .unwrap();
        let error = DataService::new(&state)
            .query_table_window(&TableWindowRequest {
                dataset_id: "other".into(),
                start: 0,
                count: 5,
                sort: None,
                filters: vec![],
                generation: 0,
            })
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("project_navigation_repair_requires_writable"),
            "{error}"
        );
        assert_eq!(full_anchor_rebuild_counter(), 1);
        service.close_enabled(readonly.epoch).unwrap();
    }

    #[test]
    fn project_v5_lifecycle_native_draft_snapshot_close_and_reopen() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("drafts");
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let draft = service.create_draft_enabled(&registry).unwrap();
        assert!(draft.project.file_path.is_empty());
        let named_path = root.path().join("named.spprj");
        let named = service
            .snapshot_enabled(draft.epoch, &named_path, true)
            .unwrap();
        assert!(named.error.is_none());
        let named = named.active.unwrap();
        assert_eq!(named.header.project_id, draft.header.project_id);
        assert_ne!(named.epoch, draft.epoch);
        assert_eq!(
            state.project.read().unwrap().as_ref().unwrap().file_path,
            std::fs::canonicalize(&named_path)
                .unwrap()
                .to_str()
                .unwrap()
        );
        let copy = service
            .snapshot_enabled(named.epoch, &root.path().join("copy.spprj"), false)
            .unwrap()
            .active
            .unwrap();
        assert_ne!(copy.header.project_id, named.header.project_id);
        service.close_enabled(copy.epoch).unwrap();
        assert!(state.project.read().unwrap().is_none());
        assert!(state.project_database.read().unwrap().is_none());
        assert!(state.save_coordinator.mutation_permit().is_ok());
        ProjectDatabase::open(&named_path, false)
            .unwrap()
            .shutdown()
            .unwrap();
    }

    #[test]
    fn project_v5_lifecycle_failed_snapshot_restores_source_with_fresh_epoch() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.spprj");
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let previous = service.open_enabled(&path, false).unwrap();
        let result = service
            .snapshot_enabled(
                previous.epoch,
                &root.path().join("missing/dest.spprj"),
                false,
            )
            .unwrap();
        assert!(result.error.is_some());
        assert!(!result.destination_published);
        let recovered = result.active.unwrap();
        assert_eq!(recovered.project.file_path, previous.project.file_path);
        assert_eq!(recovered.header.project_id, previous.header.project_id);
        assert_ne!(recovered.epoch, previous.epoch);
        assert!(service.database(previous.epoch).is_err());
        assert!(service.database(recovered.epoch).is_ok());
    }

    #[test]
    fn project_v5_lifecycle_switch_retires_retained_navigation_owner() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.spprj");
        let second = dir.path().join("second.spprj");
        ProjectDatabase::create(&first, false)
            .unwrap()
            .shutdown()
            .unwrap();
        ProjectDatabase::create(&second, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        service.open_enabled(&first, false).unwrap();
        let navigation = state.table_navigation.read().unwrap().clone();
        service.open_enabled(&second, false).unwrap();
        let error = navigation
            .get_table_query_session_status("retired")
            .unwrap_err()
            .to_string();
        assert!(error.contains("table_navigation_closed"), "{error}");
        ProjectDatabase::open(&first, false)
            .unwrap()
            .shutdown()
            .unwrap();
    }

    #[test]
    fn project_v5_open_metadata_only_payload_and_zero_forbidden_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("native.spprj");
        fixture(&path);
        let original_bytes = std::fs::read(&path).unwrap();
        let state = AppState::new().unwrap();
        project_table_restore::reset_completed_append_count();
        reset_full_anchor_rebuild_counter();
        table_mutation_coordinator::reset_full_before_table_copy_counter();
        let summary = NativeProjectService::new(&state)
            .open_enabled(&path, false)
            .unwrap();
        assert_eq!(summary.directory.items.len(), 3);
        assert_eq!(summary.header.format_version, "5.0.0");
        assert!(summary.writable);
        assert_eq!(
            NativeProjectService::new(&state)
                .list_history(
                    summary.epoch,
                    &HistoryPageRequest {
                        dataset_id: Some("table".into()),
                        after: None,
                        limit: 10
                    }
                )
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(
            state.save_coordinator.mutation_permit().is_err(),
            "legacy mutation entrypoints require a native write context"
        );
        assert!(serde_json::to_vec(&summary).unwrap().len() < 16_384);
        assert_eq!(project_table_restore::completed_append_count(), 0);
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(
            table_mutation_coordinator::full_before_table_copy_counter(),
            0
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            original_bytes,
            "metadata-only open must not rewrite the project"
        );
        let live = NativeProjectService::new(&state)
            .database(summary.epoch)
            .unwrap();
        assert_eq!(
            live.with_reader(summary.epoch, |engine| ProjectCatalog::new(engine)
                .describe_table("table"))
                .unwrap()
                .row_count,
            10_000_000
        );
        assert!(
            live.with_reader(summary.epoch, |engine| ProjectCatalog::new(engine)
                .get_document("report", 1))
                .is_err(),
            "opening must defer body parsing"
        );
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .conn()
                .query_row("SELECT project_id FROM _project_header", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            summary.header.project_id
        );
    }

    #[test]
    fn project_v5_open_malformed_catalog_preserves_live_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("malformed.spprj");
        fixture(&path);
        let invalid = ProjectDatabase::open(&path, false).unwrap();
        invalid
            .with_engine(|engine| {
                engine.conn().execute_batch(
                    "UPDATE _project_directory SET kind='future' WHERE id='report'",
                )?;
                Ok(())
            })
            .unwrap();
        invalid.shutdown().unwrap();
        let state = AppState::new().unwrap();
        state
            .db
            .lock()
            .unwrap()
            .conn()
            .execute_batch("CREATE TABLE live_sentinel AS SELECT 123 AS value")
            .unwrap();
        assert!(NativeProjectService::new(&state)
            .open_enabled(&path, false)
            .is_err());
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .conn()
                .query_row("SELECT value FROM live_sentinel", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            123
        );
        assert!(state.project.read().unwrap().is_none());
    }

    #[test]
    fn project_v5_open_rejects_legacy_archive_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("native.spprj");
        fixture(&path);
        let state = AppState::new().unwrap();
        NativeProjectService::new(&state)
            .open_enabled(&path, false)
            .unwrap();
        let request:crate::models::save::SaveProjectRequest = serde_json::from_value(serde_json::json!({
            "history":[],"snapshots":[],"graphBuilders":[],"reports":[],"tabulates":[],"folders":[],
            "tableFolders":{},"graphFolders":{},"reportFolders":{},"tabulateFolders":{}
        })).unwrap();
        let error = crate::services::project_service::ProjectService::new(&state)
            .save_project(request, None)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("project_native_write_context_required"));
        assert_eq!(
            crate::services::project_schema::detect_project_format(&path).unwrap(),
            crate::services::project_schema::ProjectFormat::DuckDb
        );
    }

    #[test]
    fn project_v5_table_edits_share_native_transaction_and_replay_receipt() {
        use crate::models::table::{CellPosition, CellUpdate};
        use crate::services::project_output::ProjectCsvImport;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edits.spprj");
        let csv = dir.path().join("input.csv");
        std::fs::write(&csv, "value\n1\n2\n").unwrap();
        let db = ProjectDatabase::create(&path, false).unwrap();
        let seed = ProjectWriteContext {
            operation_id: "seed".into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        let table = db
            .import_project_csv(
                &seed,
                &ProjectCsvImport {
                    name: "Data".into(),
                    source_path: csv.to_str().unwrap().into(),
                    folder: "".into(),
                },
                || false,
            )
            .unwrap()
            .value;
        db.shutdown().unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let summary = service.open_enabled(&path, false).unwrap();
        let live = service.database(summary.epoch).unwrap();
        let quoted = crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(
            &crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&table.id),
        );
        let row_id: i64 = live
            .with_reader(summary.epoch, |engine| {
                Ok(engine.conn().query_row(
                    &format!("SELECT min(_row_id) FROM {quoted}"),
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        reset_full_anchor_rebuild_counter();
        table_mutation_coordinator::reset_full_before_table_copy_counter();
        let context = ProjectWriteContext {
            operation_id: "cell".into(),
            expected_project_id: summary.header.project_id.clone(),
            expected_epoch: summary.epoch,
            expected_revision: summary.header.committed_revision,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![DatasetGeneration {
                id: table.id.clone(),
                generation: table.generation,
            }],
        };
        let updates = vec![CellUpdate {
            row_id,
            column_name: "value".into(),
            value: Some("17".into()),
        }];
        let committed = service
            .update_cells(&context, &table.id, &updates, Some(table.generation))
            .unwrap();
        let replay = service
            .update_cells(&context, &table.id, &updates, Some(table.generation))
            .unwrap();
        assert_eq!(committed.committed_revision, replay.committed_revision);
        assert_eq!(committed.value, table.generation + 1);
        let receipt_json = serde_json::to_value(&committed).unwrap();
        assert_eq!(
            receipt_json["changedHistoryEntries"][0]["datasetId"],
            table.id
        );
        assert_eq!(
            receipt_json["changedHistoryEntries"][0]["operation"],
            "update_cells"
        );
        assert!(receipt_json["changedHistoryEntries"][0]["id"]
            .as_str()
            .is_some());
        assert_eq!(
            committed.changed_dataset_generations[0].generation,
            table.generation + 1
        );
        assert_eq!(
            live.with_reader(summary.epoch, |engine| Ok(engine.conn().query_row(
                "SELECT count(*) FROM _history_timeline",
                [],
                |row| row.get::<_, i64>(0)
            )?))
            .unwrap(),
            1
        );
        let mut next = context.clone();
        next.operation_id = "clear".into();
        next.expected_revision = committed.committed_revision;
        next.dataset_generations[0].generation = committed.value;
        let cleared = service
            .clear_cells(
                &next,
                &table.id,
                &[CellPosition {
                    row_id,
                    column_name: "value".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            cleared.changed_dataset_generations[0].generation,
            table.generation + 2
        );
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(
            table_mutation_coordinator::full_before_table_copy_counter(),
            0
        );
        let clear_history = cleared.changed_history_entries[0].id.clone();
        next.operation_id = "undo-clear".into();
        next.expected_revision = cleared.committed_revision;
        next.dataset_generations[0].generation = cleared.changed_dataset_generations[0].generation;
        let undone = service
            .apply_change_set(&next, &table.id, &clear_history, true)
            .unwrap();
        assert!(
            undone.changed_history_entries.is_empty(),
            "replay must not create another undo entry"
        );
        assert_eq!(
            live.with_reader(summary.epoch, |engine| Ok(engine.conn().query_row(
                &format!("SELECT value FROM {quoted} WHERE _row_id=?"),
                [row_id],
                |row| row.get::<_, i64>(0)
            )?))
            .unwrap(),
            17
        );
        next.operation_id = "redo-clear".into();
        next.expected_revision = undone.committed_revision;
        next.dataset_generations[0].generation = undone.changed_dataset_generations[0].generation;
        service
            .apply_change_set(&next, &table.id, &clear_history, false)
            .unwrap();
        assert_eq!(full_anchor_rebuild_counter(), 0);
        assert_eq!(
            table_mutation_coordinator::full_before_table_copy_counter(),
            0
        );
        drop(live);
        drop(service);
        drop(state);
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        assert_eq!(
            reopened
                .with_reader(reopened.epoch(), |engine| Ok(engine.conn().query_row(
                    &format!("SELECT value FROM {quoted} WHERE _row_id=?"),
                    [row_id],
                    |row| row.get::<_, Option<i64>>(0)
                )?))
                .unwrap(),
            None
        );
    }

    #[test]
    fn project_v5_table_rows_are_atomic_and_undoable_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table", "Table", &["value".into()], &["BIGINT".into()])?;
            ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?, "")
        })
        .unwrap();
        db.shutdown().unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let summary = service.open_enabled(&path, false).unwrap();
        let mut context = ProjectWriteContext {
            operation_id: "add".into(),
            expected_project_id: summary.header.project_id,
            expected_epoch: summary.epoch,
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![DatasetGeneration {
                id: "table".into(),
                generation: 0,
            }],
        };
        let added = service.add_rows(&context, "table", 3, None, 0).unwrap();
        assert_eq!(added.value.row_count, 3);
        context.operation_id = "delete".into();
        context.expected_revision = added.committed_revision;
        context.dataset_generations[0].generation = added.value.generation;
        let deleted = service
            .delete_rows(
                &context,
                "table",
                &[added.value.row_ids[1]],
                added.value.generation,
            )
            .unwrap();
        assert_eq!(deleted.value.row_count, 2);
        let change_set = deleted.value.change_set_id;
        drop(service);
        drop(state);
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        reopened
            .with_engine(|engine| engine.apply_change_set(&change_set, true))
            .unwrap();
        assert_eq!(
            reopened
                .with_reader(reopened.epoch(), |engine| engine.get_dataset_meta("table"))
                .unwrap()
                .row_count,
            3
        );
    }

    #[test]
    fn project_v5_public_receipt_create_rows_matches_normal_command_value() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("public-row-receipt.spprj");
        ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let context=ProjectWriteContext {operation_id:"create-public".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let request=crate::models::table::CreateTableFromRowsRequest {name:"Created".into(),column_names:vec!["value".into()],column_types:vec!["BIGINT".into()],rows:vec![vec![serde_json::json!(73)]]};
        crate::services::project_transaction::inject_commit_failure_for_test(2);
        assert!(service.create_table_from_rows(&context,&request).is_err());
        let resolved=serde_json::to_value(service.resolve_operation(&context).unwrap()).unwrap();
        assert_eq!(resolved["commit"]["value"]["name"],"Created","outcome resolution must return DatasetMeta, matching the public create command");
        let retry=service.create_table_from_rows(&context,&request).unwrap();
        assert_eq!(resolved["commit"]["value"],serde_json::to_value(&retry.value).unwrap());
        assert_eq!(retry.committed_revision,1);
        let event=retry.changed_history_entries.iter().find(|entry|entry.operation=="create_table").expect("managed creation must publish an executable lifecycle receipt");
        assert_eq!(event.dataset_id,retry.value.id);
        let lifecycle=service.table_lifecycle_event(opened.epoch,&event.id).unwrap();
        let mut replay=context.clone();replay.operation_id="undo-create".into();replay.expected_revision=1;replay.dataset_generations=retry.changed_dataset_generations.clone();
        service.apply_table_lifecycle(&replay,&event.id,lifecycle.revision,true).unwrap();
        assert!(service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.list_datasets()).unwrap().is_empty());
        let lifecycle=service.table_lifecycle_event(opened.epoch,&event.id).unwrap();
        replay.operation_id="redo-create".into();replay.expected_revision=2;replay.dataset_generations.clear();
        service.apply_table_lifecycle(&replay,&event.id,lifecycle.revision,false).unwrap();

        assert_eq!(service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.list_datasets()).unwrap().len(),1);
    }

    #[test]
    fn project_v5_public_receipt_sqlite_import_matches_summary_after_source_is_removed() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("public-import-receipt.spprj");let source=root.path().join("source.sqlite");
        let sqlite=rusqlite::Connection::open(&source).unwrap();sqlite.execute_batch("CREATE TABLE source(value INTEGER); INSERT INTO source VALUES(1),(2)").unwrap();drop(sqlite);
        ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let context=ProjectWriteContext {operation_id:"import-public".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let selections=vec![crate::models::data_link::SqliteImportSelection {source_name:"source".into(),target_name:"Imported".into(),action:"create".into()}];
        crate::services::project_transaction::inject_commit_failure_for_test(2);
        assert!(service.import_sqlite(&context,source.to_str().unwrap(),&selections,|_,_,_,_,_|{},||false).is_err());
        let resolved=serde_json::to_value(service.resolve_operation(&context).unwrap()).unwrap();
        assert_eq!(resolved["commit"]["value"]["status"],"completed","outcome resolution must return the public ImportSummary");
        assert_eq!(resolved["commit"]["value"]["totalRowsWritten"],2);
        std::fs::remove_file(&source).unwrap();
        let retry=service.import_sqlite(&context,source.to_str().unwrap(),&selections,|_,_,_,_,_|panic!("replayed import read source"),||panic!("replayed import read source")).unwrap();
        assert_eq!(resolved["commit"]["value"],serde_json::to_value(&retry.value).unwrap());
        assert_eq!(retry.committed_revision,1);
    }

    #[test]
    fn project_v5_native_server_import_cancellation_and_preflight_do_not_access_source() {
        use crate::models::data_link::*;
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("server.spprj");
        ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
        let state=AppState::new().unwrap();
        let service=NativeProjectService::new(&state);
        let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"cancelled-server".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let definition=ConnectionDefinition {connector:ConnectorKind::PostgreSql,host:"127.0.0.1".into(),port:5432,database:"fixture".into(),authentication_type:AuthenticationType::UsernamePassword,tls_mode:TlsMode::Disabled,tls_root_certificate_pem:None,connect_timeout_seconds:1};
        let credentials=ConnectionCredentials {username:"fixture".into(),password:"unused-fixture".into()};
        let object=SourceObjectRef {catalog:None,schema:None,name:"missing".into(),object_type:SourceObjectType::Table};
        let error=service.import_server(&context,definition.clone(),credentials.clone(),object.clone(),"Imported",|_,_|{},||true).unwrap_err();
        assert!(matches!(error,AppError::Cancelled(_)),"{error}");
        assert_eq!(service.database(opened.epoch).unwrap().committed_revision().unwrap(),0);
        context.expected_revision=99;
        let error=service.import_server(&context,definition,ConnectionCredentials {username:credentials.username,password:String::new()},object,"Imported",|_,_|{},||false).unwrap_err();
        assert!(error.to_string().contains("revision_stale"),"preflight must precede connector validation: {error}");
    }

    #[test]
    fn project_v5_native_server_import_replays_receipt_without_credentials_and_fences_source() {
        use crate::models::data_link::*;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("server-replay.spprj");
        ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);
        let opened=service.open_enabled(&path,false).unwrap();
        let context=ProjectWriteContext {operation_id:"server-replay".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let definition=ConnectionDefinition {connector:ConnectorKind::PostgreSql,host:"127.0.0.1".into(),port:5432,database:"fixture".into(),authentication_type:AuthenticationType::UsernamePassword,tls_mode:TlsMode::Disabled,tls_root_certificate_pem:None,connect_timeout_seconds:1};
        let object=SourceObjectRef {catalog:None,schema:Some("public".into()),name:"values".into(),object_type:SourceObjectType::Table};
        let request=crate::services::project_output::ProjectServerImport {
            connection_id:"e6b810e07aad82980a529dfff63318c6d42991c594ca0fef5ed7a583450efe89".into(),object:object.clone(),target_name:"Imported".into(),source_description:"fixture.public.values".into(),folder:String::new(),
        };
        let db=service.database(opened.epoch).unwrap();
        // Seed an already committed writer outcome; no external server is needed
        // to prove that a lost acknowledgement never reconnects to its source.
        crate::services::project_transaction::inject_commit_failure_for_test(2);
        let lost=db.commit_with_effects(&context,&("import_server",&request),|engine| {
            let meta=engine.create_table_from_rows_in_transaction("saved-output",&crate::models::table::CreateTableFromRowsRequest {name:"Imported".into(),column_names:vec!["value".into()],column_types:vec!["BIGINT".into()],rows:vec![vec![serde_json::json!(73)]]})?;
            ProjectCatalog::new(engine).publish_table(&meta,"")?;
            Ok(crate::services::project_transaction::CommitEffects {dataset_ids:vec![meta.id.clone()],document_ids:vec![],setting_ids:vec![],value:ImportSummary {status:"completed".into(),imported:vec![ImportTableSummary {source_name:"public.values".into(),target_name:"Imported".into(),action:"create".into(),rows_written:1}],skipped:vec![],failed_table:None,error:None,total_rows_written:1}})
        });
        assert!(lost.is_err());assert_eq!(db.committed_revision().unwrap(),1);
        let credentials=ConnectionCredentials {username:"fixture".into(),password:String::new()};
        let replay=service.import_server(&context,definition.clone(),credentials.clone(),object.clone(),"Imported",|_,_|panic!("replay read source"),||panic!("replay accessed connector")).unwrap();
        assert_eq!(replay.committed_revision,1);assert_eq!(replay.value.total_rows_written,1);assert_eq!(replay.value.imported[0].source_name,"public.values");
        let mut changed=definition;changed.host="different-source".into();
        let error=service.import_server(&context,changed,credentials,object,"Imported",|_,_|{},||false).unwrap_err();
        assert!(error.to_string().contains("operation_id_reused"),"{error}");
        assert_eq!(db.committed_revision().unwrap(),1);
        assert_eq!(db.with_reader(db.epoch(),|engine|Ok(engine.conn().query_row("SELECT value FROM dataset_saved_output",[],|row|row.get::<_,i64>(0))?)).unwrap(),73);
    }

    #[test]
    fn project_v5_import_and_sql_keep_names_and_replay_without_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("imports.spprj");
        let csv = dir.path().join("input.csv");
        std::fs::write(&csv, "value\n1\n2\n").unwrap();
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let summary = service.open_enabled(&path, false).unwrap();
        let mut context = ProjectWriteContext {
            operation_id: "import".into(),
            expected_project_id: summary.header.project_id,
            expected_epoch: summary.epoch,
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        let first = service
            .import_file(&context, csv.to_str().unwrap())
            .unwrap();
        assert_eq!(first.value.name, "input");
        assert_eq!(
            serde_json::to_value(&first).unwrap()["changedDirectoryEntries"][0]["id"],
            first.value.id
        );
        std::fs::remove_file(&csv).unwrap();
        let replay = service
            .import_file(&context, csv.to_str().unwrap())
            .unwrap();
        assert_eq!(first.value.id, replay.value.id);
        assert_eq!(first.committed_revision, replay.committed_revision);
        std::fs::write(&csv, "value\n3\n4\n").unwrap();
        context.operation_id = "import-again".into();
        context.expected_revision = first.committed_revision;
        let second = service
            .import_file(&context, csv.to_str().unwrap())
            .unwrap();
        assert_eq!(second.value.name, "input-2");
        context.operation_id = "sql".into();
        context.expected_revision = second.committed_revision;
        let sql = service
            .materialize_sql(&context, "SELECT 7 AS value", "input")
            .unwrap();
        assert_eq!(sql.value.name, "input-3");
        assert_eq!(sql.value.row_count, 1);
        assert_eq!(
            service
                .list_catalog(summary.epoch, &CatalogPageRequest::default())
                .unwrap()
                .items
                .len(),
            3
        );
    }

    #[test]
    fn project_v5_added_rows_materialize_formula_defaults_on_creation_and_redo() {
        use crate::services::calculated_column_service::UpsertCalculatedColumnInput;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("formula-defaults.spprj");let db=ProjectDatabase::create(&path,false).unwrap();db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();let mut context=ProjectWriteContext{operation_id:"default".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        for (index,(name,formula)) in [("DefaultValue","COALESCE([A], 0) + 1"),("ConstantValue","7")].iter().enumerate() {context.operation_id=format!("formula-{index}");let result=service.upsert_calculated_column(&context,&UpsertCalculatedColumnInput{dataset_id:"table".into(),output_name:(*name).into(),formula_text:(*formula).into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(index as u64)}).unwrap();context.expected_revision=result.committed_revision;context.dataset_generations[0].generation=index as u64+1;}
        context.operation_id="add-rows".into();crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();let added=service.add_rows(&context,"table",2,None,2).unwrap();assert_eq!(added.value.row_count,2);assert_eq!(serde_json::to_value(&added).unwrap()["changedDatasetMetadata"][0]["rowCount"],2);assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        let check=|engine:&crate::engine::duckdb_engine::DuckDbEngine|->Result<(),AppError> {let rows=engine.conn().prepare("SELECT DefaultValue,ConstantValue FROM dataset_table ORDER BY _row_id")?.query_map([],|row|Ok((row.get::<_,Option<f64>>(0)?,row.get::<_,Option<i64>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(rows,vec![(Some(1.0),Some(7)),(Some(1.0),Some(7))]);Ok(())};
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,check).unwrap();context.expected_revision=added.committed_revision;context.dataset_generations[0].generation=3;context.operation_id="undo-added".into();let undo=service.apply_change_set(&context,"table",&added.value.change_set_id,true).unwrap();assert_eq!(serde_json::to_value(&undo).unwrap()["changedDatasetMetadata"][0]["rowCount"],0);
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=4;context.operation_id="redo-added".into();service.apply_change_set(&context,"table",&added.value.change_set_id,false).unwrap();service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,check).unwrap();
    }

    #[test]
    fn project_v5_compound_paste_promotes_empty_column_without_copy() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("empty-type-paste.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        let column_ids=db.with_engine(|engine| {
            engine.create_empty_table("table","Table",&["A".into()],&["VARCHAR".into()])?;
            engine.conn().execute("INSERT INTO dataset_table (_row_id) VALUES (1)",[])?;
            engine.conn().execute("UPDATE _meta_datasets SET row_count=1 WHERE id='table'",[])?;
            engine.rebuild_natural_anchors("table",0)?;
            ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")?;
            Ok(engine.get_user_column_descriptors("table")?.into_iter().map(|c|c.column_id).collect())
        }).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"promote".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        let request=ProjectPasteRequest {dataset_id:"table".into(),start_row:0,start_col:0,rows:vec![vec!["1.5".into()]],header_names:None,col_types:vec!["DOUBLE".into()],expected_generation:0,row_ids:None,column_ids};
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let pasted=service.paste(&context,&request).unwrap();
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {assert_eq!(engine.get_user_column_descriptors("table")?[0].sql_type,"DOUBLE");Ok(())}).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        context.expected_revision=pasted.committed_revision;context.dataset_generations[0].generation=pasted.value.generation.unwrap();context.operation_id="undo-promote".into();
        let undo=service.apply_change_set(&context,"table",&pasted.value.change_set_id,true).unwrap();
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {assert_eq!(engine.get_user_column_descriptors("table")?[0].sql_type,"VARCHAR");let value:Option<String>=engine.conn().query_row("SELECT A FROM dataset_table",[],|r|r.get(0))?;assert_eq!(value,None);Ok(())}).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=undo.changed_dataset_generations[0].generation;context.operation_id="redo-promote".into();
        service.apply_change_set(&context,"table",&pasted.value.change_set_id,false).unwrap();
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {assert_eq!(engine.get_user_column_descriptors("table")?[0].sql_type,"DOUBLE");let value:f64=engine.conn().query_row("SELECT A FROM dataset_table",[],|r|r.get(0))?;assert_eq!(value,1.5);Ok(())}).unwrap();
    }

    #[test]
    fn project_v5_compound_paste_is_one_reopened_undo_step() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("compound-paste.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let seed=ProjectWriteContext{operation_id:"seed-created-table".into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:0,request_digest:String::new(),dataset_generations:vec![],document_revisions:vec![]};
        let column_ids = db.commit_with_effects(&seed,&"seed",|engine| {
            engine.create_empty_table("table", "Table", &["A".into()], &["DOUBLE".into()])?;
            engine.conn().execute("INSERT INTO dataset_table (_row_id,A) VALUES (1,10),(2,20)", [])?;
            engine.conn().execute("UPDATE _meta_datasets SET row_count=2 WHERE id='table'", [])?;
            engine.rebuild_natural_anchors("table", 0)?;
            ProjectCatalog::new(engine).publish_new_table(&engine.get_dataset_meta("table")?, "")?;
            Ok(super::super::project_transaction::CommitEffects{value:engine.get_user_column_descriptors("table")?.into_iter().map(|c| c.column_id).collect(),dataset_ids:vec!["table".into()],document_ids:vec![],setting_ids:vec![]})
        }).unwrap().value;
        db.prepare_close(db.epoch()).unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let opened = service.open_enabled(&path, false).unwrap();
        let mut context = ProjectWriteContext { operation_id: "compound".into(), expected_project_id: opened.header.project_id, expected_epoch: opened.epoch, expected_revision: opened.header.committed_revision, request_digest: String::new(), document_revisions: vec![], dataset_generations: vec![DatasetGeneration { id: "table".into(), generation: 0 }] };
        let request = ProjectPasteRequest { dataset_id: "table".into(), start_row: 1, start_col: 0, rows: vec![vec!["21".into(), "x".into()], vec!["31".into(), "y".into()]], header_names: Some(vec!["a".into(), "Added".into()]), col_types: vec!["DOUBLE".into(), "VARCHAR".into()], expected_generation: 0, row_ids: None, column_ids };
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let mut invalid = request.clone();
        invalid.rows[0][0] = "not a number".into();
        context.operation_id = "invalid-compound".into();
        assert!(service.paste(&context, &invalid).is_err());
        service.database(opened.epoch).unwrap().with_reader(opened.epoch, |engine| {
            let meta = engine.get_dataset_meta("table")?;
            assert_eq!((meta.generation,meta.row_count,meta.col_count),(0,2,1));
            assert_eq!(engine.get_user_column_descriptors("table")?[0].name,"A");
            let count:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_timeline",[],|r|r.get(0))?;
            assert_eq!(count,0); Ok(())
        }).unwrap();
        context.operation_id = "compound".into();
        let pasted = service.paste(&context, &request).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(), 0);
        assert_eq!(pasted.changed_history_entries.len(), 1);
        assert_eq!(pasted.changed_history_entries[0].operation, "paste");
        assert_eq!(pasted.value.row_count, Some(3));
        assert_eq!(pasted.value.column_count, Some(2));
        assert_eq!(service.paste(&context, &request).unwrap().value.change_set_id, pasted.value.change_set_id);
        let history = service.list_history(opened.epoch, &HistoryPageRequest { dataset_id: Some("table".into()), after: None, limit: 1 }).unwrap();
        assert_eq!(history.items.len(),1); assert!(history.next_cursor.is_some());
        context.expected_revision = pasted.committed_revision;
        context.dataset_generations[0].generation = pasted.value.generation.unwrap();
        context.operation_id = "undo-compound".into();
        let undo = service.apply_change_set(&context, "table", &pasted.value.change_set_id, true).unwrap();
        service.database(opened.epoch).unwrap().with_reader(opened.epoch, |engine| {
            assert_eq!(engine.get_user_column_descriptors("table")?.into_iter().map(|c| c.name).collect::<Vec<_>>(), vec!["A"]);
            let values = engine.conn().prepare("SELECT A FROM dataset_table ORDER BY _row_id")?.query_map([], |r| r.get::<_, f64>(0))?.collect::<Result<Vec<_>, _>>()?;
            assert_eq!(values, vec![10.0, 20.0]); Ok(())
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();
        let reopened = service.open_enabled(&path, false).unwrap();
        context.expected_epoch = reopened.epoch;
        context.expected_revision = undo.committed_revision;
        context.dataset_generations[0].generation = undo.changed_dataset_generations[0].generation;
        context.operation_id = "redo-compound".into();
        let redo = service.apply_change_set(&context, "table", &pasted.value.change_set_id, false).unwrap();
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch, |engine| {
            assert_eq!(engine.get_user_column_descriptors("table")?.into_iter().map(|c| c.name).collect::<Vec<_>>(), vec!["a", "Added"]);
            let values = engine.conn().prepare(&format!("SELECT a,Added FROM dataset_table ORDER BY {},_row_id", crate::engine::duckdb_engine::NATURAL_ORDER_SQL))?.query_map([], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, Option<String>>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            assert_eq!(values, vec![(10.0, None), (21.0, Some("x".into())), (31.0, Some("y".into()))]); Ok(())
        }).unwrap();
        context.expected_revision=redo.committed_revision;
        context.dataset_generations[0].generation=redo.changed_dataset_generations[0].generation;
        context.operation_id="undo-before-new-branch".into();
        let undo=service.apply_change_set(&context,"table",&pasted.value.change_set_id,true).unwrap();
        context.expected_revision=undo.committed_revision;
        context.dataset_generations[0].generation=undo.changed_dataset_generations[0].generation;
        context.operation_id="new-branch".into();
        service.update_cells(&context,"table",&[crate::models::table::CellUpdate { row_id:1,column_name:"A".into(),value:Some("99".into()) }],Some(context.dataset_generations[0].generation)).unwrap();
        let history=service.list_history(reopened.epoch,&HistoryPageRequest { dataset_id:Some("table".into()),after:None,limit:100 }).unwrap();
        assert_eq!(history.items.len(),2); assert!(history.items.iter().all(|entry|entry.id!=pasted.value.change_set_id));
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {
            let groups:i64=engine.conn().query_row("SELECT COUNT(*) FROM _project_history_groups",[],|r|r.get(0))?;
            assert_eq!(groups,0); Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_paste_uses_explicit_row_identity_and_compact_history() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("paste.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine|{engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"VARCHAR".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A,B) VALUES (1,1,'x'),(2,2,'y'),(3,3,'z')",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=3 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let columns=service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.get_user_column_descriptors("table")).unwrap();
        let mut context=ProjectWriteContext{operation_id:"paste".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        let mut request=ProjectPasteRequest{dataset_id:"table".into(),start_row:0,start_col:0,rows:vec![vec!["30".into()],vec!["10".into()]],header_names:None,col_types:vec!["DOUBLE".into()],expected_generation:0,row_ids:Some(vec![3,1]),column_ids:columns.iter().map(|column|column.column_id.clone()).collect()};
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();let pasted=service.paste(&context,&request).unwrap();assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);assert_eq!(pasted.value.generation,Some(1));assert_eq!(pasted.value.row_count,Some(3));assert_eq!(pasted.value.column_count,Some(2));assert_eq!(pasted.changed_history_entries.len(),1);
        assert_eq!(service.paste(&context,&request).unwrap().value.change_set_id,pasted.value.change_set_id);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {let values=engine.conn().prepare("SELECT A FROM dataset_table ORDER BY _row_id")?.query_map([],|row|row.get::<_,f64>(0))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(values,vec![10.0,2.0,30.0]);Ok(())}).unwrap();
        context.expected_revision=pasted.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="stale-columns".into();request.expected_generation=1;request.column_ids.reverse();assert!(service.paste(&context,&request).unwrap_err().to_string().contains("project_columns_stale"));
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.operation_id="undo-paste".into();let undo=service.apply_change_set(&context,"table",&pasted.value.change_set_id,true).unwrap();
        context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="natural-paste".into();request.column_ids.reverse();request.expected_generation=2;request.start_row=1;request.row_ids=None;request.rows=vec![vec!["200".into()]];request.col_types=vec!["INTEGER".into()];
        let natural=service.paste(&context,&request).unwrap();assert_eq!(natural.value.generation,Some(3));service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {let values=engine.conn().prepare("SELECT A FROM dataset_table ORDER BY _row_id")?.query_map([],|row|row.get::<_,f64>(0))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(values,vec![1.0,200.0,3.0]);Ok(())}).unwrap();
    }

    #[test]
    fn project_v5_sparse_formula_edits_preserve_per_output_row_scope() {
        use crate::services::calculated_column_service::UpsertCalculatedColumnInput;
        use crate::models::table::CellUpdate;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("sparse-formulas.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into(),"B".into(),"C".into()],&["DOUBLE".into(),"DOUBLE".into(),"VARCHAR".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A,B,C) VALUES (1,1,10,'x'),(2,2,20,'y'),(3,3,30,'z')",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=3 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"formula-0".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        for (index,(name,formula)) in [("DoubleA","[A] * 2"),("DoubleB","[B] * 2"),("Both","[A] + [B]"),("Same","[A] + [B]")].iter().enumerate() {
            context.operation_id=format!("formula-{index}");let input=UpsertCalculatedColumnInput {dataset_id:"table".into(),output_name:(*name).into(),formula_text:(*formula).into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(index as u64)};
            let result=service.upsert_calculated_column(&context,&input).unwrap();context.expected_revision=result.committed_revision;context.dataset_generations[0].generation=index as u64+1;
        }
        context.operation_id="sparse-edit".into();crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let edited=service.update_cells(&context,"table",&[CellUpdate{row_id:1,column_name:"A".into(),value:Some("5".into())},CellUpdate{row_id:2,column_name:"B".into(),value:Some("50".into())}],Some(4)).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {
            let snapshots=engine.conn().prepare("SELECT column_name,snapshot_table FROM _project_cell_history_columns WHERE change_set_id=?")?.query_map([&edited.changed_history_entries[0].id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            let mut counts=std::collections::BTreeMap::new();for (name,snapshot) in snapshots {let count:i64=engine.conn().query_row(&format!("SELECT COUNT(*) FROM {}",crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&snapshot)),[],|row|row.get(0))?;counts.insert(name,count);}
            assert_eq!(counts,std::collections::BTreeMap::from([("A".into(),1),("B".into(),1),("DoubleA".into(),1),("DoubleB".into(),1),("Both".into(),2),("Same".into(),2)]));
            let rows=engine.conn().prepare("SELECT DoubleA,DoubleB,\"Both\",Same FROM dataset_table ORDER BY _row_id")?.query_map([],|row|Ok((row.get::<_,f64>(0)?,row.get::<_,f64>(1)?,row.get::<_,f64>(2)?,row.get::<_,f64>(3)?)))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(rows,vec![(10.0,20.0,15.0,15.0),(4.0,100.0,52.0,52.0),(6.0,60.0,33.0,33.0)]);
            Ok(())
        }).unwrap();
        let history=service.list_history(opened.epoch,&HistoryPageRequest{dataset_id:Some("table".into()),after:None,limit:100}).unwrap();assert!(history.items.iter().any(|entry|entry.id==edited.changed_history_entries[0].id&&entry.applied&&entry.generation==5));
    }

    #[test]
    fn project_v5_formula_cell_edit_captures_only_affected_rows_and_reopens_undo() {
        use crate::services::calculated_column_service::UpsertCalculatedColumnInput;
        use crate::models::table::CellUpdate;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("formula-cells.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"VARCHAR".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A,B) VALUES (1,1.7,'one'),(2,3,'two')",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=2 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"twice".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        let mut input=UpsertCalculatedColumnInput {dataset_id:"table".into(),output_name:"Twice".into(),formula_text:"[A] * 2".into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(0)};
        let twice=service.upsert_calculated_column(&context,&input).unwrap();context.expected_revision=twice.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="downstream".into();input.output_name="Downstream".into();input.formula_text="[Twice] + 1".into();input.expected_generation=Some(1);
        let downstream=service.upsert_calculated_column(&context,&input).unwrap();context.expected_revision=downstream.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="edit".into();
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let edited=service.update_cells(&context,"table",&[CellUpdate{row_id:1,column_name:"A".into(),value:Some("2.1".into())}],Some(2)).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0,"a formula-dependent cell edit must not copy a full table");
        let id=&edited.changed_history_entries[0].id;
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {
            let kind:String=engine.conn().query_row("SELECT storage_kind FROM _history_change_sets WHERE id=?",[id],|row|row.get(0))?;assert_eq!(kind,"cell_delta");
            let snapshots=engine.conn().prepare("SELECT snapshot_table FROM _project_cell_history_columns WHERE change_set_id=?")?.query_map([id],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(snapshots.len(),3);
            for snapshot in snapshots {let count:i64=engine.conn().query_row(&format!("SELECT COUNT(*) FROM {}",crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&snapshot)),[],|row|row.get(0))?;assert_eq!(count,1);}
            let values:(f64,f64)=engine.conn().query_row("SELECT Twice,Downstream FROM dataset_table WHERE _row_id=1",[],|row|Ok((row.get(0)?,row.get(1)?)))?;assert_eq!(values,(4.2,5.2));
            let untouched:(f64,f64,String)=engine.conn().query_row("SELECT Twice,Downstream,B FROM dataset_table WHERE _row_id=2",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;assert_eq!(untouched,(6.0,7.0,"two".into()));Ok(())
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=edited.committed_revision;context.dataset_generations[0].generation=3;context.operation_id="undo-cell".into();service.apply_change_set(&context,"table",id,true).unwrap();
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {let values:(f64,f64,f64)=engine.conn().query_row("SELECT A,Twice,Downstream FROM dataset_table WHERE _row_id=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;assert_eq!(values,(1.7,3.4,4.4));Ok(())}).unwrap();
    }

    #[test]
    fn project_v5_public_table_lifecycle_reopens_and_replays_undo_without_row_copies() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("public-lifecycle.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let old_change=db.with_engine(|engine| {
            engine.create_empty_table("table","Protected table",&["value".into()],&["BIGINT".into()])?;
            let added=crate::services::table_delta_mutation::add_rows_compact(engine,"table",1,None,0)?;
            engine.conn().execute("UPDATE dataset_table SET value=9007199254740993 WHERE _row_id=1",[])?;
            ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"Data")?;
            engine.conn().execute_batch(r#"INSERT INTO _project_directory VALUES ('graph','graph','Graph','Data',7,'["table"]'); INSERT INTO _project_documents VALUES ('graph',7,1,'unparsed-public-graph')"#)?;
            Ok(added.change_set_id)
        }).unwrap();db.shutdown().unwrap();drop(db);
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"delete".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration {id:"table".into(),generation:1}]};
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();crate::engine::duckdb_engine::reset_full_anchor_rebuild_counter();
        let deleted=service.delete_dataset(&context,"table").unwrap();
        let entry=deleted.changed_history_entries.iter().find(|entry|entry.operation=="delete_table").expect("delete acknowledgement must publish its lifecycle history event");
        assert_eq!(serde_json::to_value(entry).unwrap()["datasetName"],"Protected table");
        let event_id=entry.id.clone();
        let history=service.list_history(opened.epoch,&HistoryPageRequest {dataset_id:Some("table".into()),after:None,limit:1000}).unwrap();
        assert_eq!(history.items.iter().filter(|entry|entry.id==event_id).count(),1,"history pages must expose exactly one lifecycle event");
        let event=service.table_lifecycle_event(opened.epoch,&event_id).unwrap();
        assert_eq!(serde_json::to_value(&event).unwrap()["datasetId"],"table");assert_eq!(event.operation,"delete_table");assert!(serde_json::to_value(&event).unwrap().get("datasetGeneration").is_some_and(serde_json::Value::is_null),"selected hidden event must return an explicit null active generation");
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();
        context.expected_epoch=reopened.epoch;context.expected_revision=deleted.committed_revision;context.dataset_generations.clear();context.operation_id="undo-failed".into();
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(service.apply_table_lifecycle(&context,&event_id,1,true).is_err());
        assert!(service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|engine.get_dataset_meta("table")).is_err());
        context.operation_id="undo-lost-ack".into();crate::services::project_transaction::inject_commit_failure_for_test(2);
        assert!(service.apply_table_lifecycle(&context,&event_id,1,true).is_err());
        let outcome=serde_json::to_value(service.resolve_operation(&context).unwrap()).unwrap();assert!(outcome["commit"]["value"].is_null());
        let restored=service.apply_table_lifecycle(&context,&event_id,1,true).unwrap();assert_eq!(restored.committed_revision,2);
        let entry=restored.changed_history_entries.iter().find(|entry|entry.id==event_id).expect("undo acknowledgement must publish the advanced lifecycle event");assert!(!entry.applied);
        let event=service.table_lifecycle_event(reopened.epoch,&event_id).unwrap();assert_eq!(event.revision,2);assert!(!event.applied);assert_eq!(serde_json::to_value(&event).unwrap()["datasetGeneration"],2,"selected event and active generation must come from one native read snapshot");
        let generation=service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {let value:i64=engine.conn().query_row("SELECT value FROM dataset_table",[],|row|row.get(0))?;assert_eq!(value,9007199254740993);let body:String=engine.conn().query_row("SELECT body_json FROM _project_documents WHERE id='graph'",[],|row|row.get(0))?;assert_eq!(body,"unparsed-public-graph");assert_eq!(ProjectCatalog::new(engine).summary("graph")?.revision,8);Ok(engine.get_dataset_meta("table")?.generation)}).unwrap();
        context.operation_id="stale-event".into();context.expected_revision=2;context.dataset_generations=vec![DatasetGeneration {id:"table".into(),generation}];
        assert!(service.apply_table_lifecycle(&context,&event_id,1,false).unwrap_err().to_string().contains("event_stale"));
        context.operation_id="undo-old-row".into();let undone=service.apply_change_set(&context,"table",&old_change,true).unwrap();
        context.expected_revision=undone.committed_revision;context.dataset_generations[0].generation=undone.changed_dataset_generations[0].generation;context.operation_id="redo-old-row".into();let redone=service.apply_change_set(&context,"table",&old_change,false).unwrap();
        context.expected_revision=redone.committed_revision;context.dataset_generations[0].generation=redone.changed_dataset_generations[0].generation;context.operation_id="redo-delete".into();
        let hidden=service.apply_table_lifecycle(&context,&event_id,2,false).unwrap();assert!(hidden.deleted_directory_ids.contains(&"table".into()));
        assert_eq!(service.table_lifecycle_event(reopened.epoch,&event_id).unwrap().revision,3);
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);assert_eq!(crate::engine::duckdb_engine::full_anchor_rebuild_counter(),0);
    }

    #[test]
    fn project_v5_table_deletion_is_atomic_replayable_and_metadata_driven() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("delete-table.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;engine.create_empty_table("keep","Keep",&["A".into()],&["DOUBLE".into()])?;
            crate::services::table_delta_mutation::add_rows_compact(engine,"table",1,None,0)?;
            let catalog=ProjectCatalog::new(engine);for id in ["table","keep"] {catalog.publish_table(&engine.get_dataset_meta(id)?,"")?;}
            catalog.apply_patch(&ProjectRecordPatch {documents:vec![DocumentWrite {expected_revision:None,document:ProjectDocumentBody {summary:ProjectDocumentSummary{id:"graph".into(),kind:ProjectDocumentKind::Graph,name:"Graph".into(),folder:"".into(),revision:1,dependencies:vec!["table".into()],analysis_kind:None},schema_version:1,body:serde_json::json!({"id":"graph","name":"Graph"})}}],settings:vec![ProjectSettingWrite{key:"filter:table".into(),expected_revision:None,value:serde_json::json!([])}],..Default::default()})?;
            engine.conn().execute("UPDATE _project_documents SET body_json='malformed' WHERE id='graph'",[])?;Ok(())
        }).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let context=ProjectWriteContext {operation_id:"delete-table".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:1}]};
        let deleted=service.delete_dataset(&context,"table").unwrap();assert!(deleted.deleted_directory_ids.contains(&"table".into()));assert!(deleted.deleted_directory_ids.contains(&"graph".into()));assert!(deleted.changed_dataset_generations.is_empty());
        assert_eq!(service.delete_dataset(&context,"table").unwrap().committed_revision,deleted.committed_revision);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {assert_eq!(engine.list_datasets()?.len(),1);let count:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_change_sets WHERE dataset_id='table'",[],|r|r.get(0))?;assert_eq!(count,1,"deletion keeps owned history for lifecycle undo");Ok(())}).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();let page=service.list_catalog(reopened.epoch,&CatalogPageRequest::default()).unwrap();assert_eq!(page.items.len(),1);assert_eq!(page.items[0].id,"keep");
    }

    #[test]
    fn project_v5_column_type_recomputes_only_dependent_outputs_and_reopens_undo() {
        use crate::services::calculated_column_service::UpsertCalculatedColumnInput;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("dependent-types.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"VARCHAR".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A,B) VALUES (1,1.7,'preserve')",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=1 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"twice".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        let mut input=UpsertCalculatedColumnInput {dataset_id:"table".into(),output_name:"Twice".into(),formula_text:"[A] * 2".into(),at_index:None,output_column_id:None,formula_id:None,expected_generation:Some(0)};
        let twice=service.upsert_calculated_column(&context,&input).unwrap();context.expected_revision=twice.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="downstream".into();
        input.output_name="Downstream".into();input.formula_text="[Twice] + 1".into();input.expected_generation=Some(1);
        let downstream=service.upsert_calculated_column(&context,&input).unwrap();context.expected_revision=downstream.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="rename-source".into();
        let renamed=service.alter_column(&context,"table","A","Renamed","DOUBLE",2).unwrap();context.expected_revision=renamed.committed_revision;context.dataset_generations[0].generation=3;context.operation_id="cast-source".into();
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let cast=service.alter_column_types(&context,"table",&["Renamed".into()],"INTEGER",3).unwrap();assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {
            let values:(f64,f64,String)=engine.conn().query_row("SELECT Twice,Downstream,B FROM dataset_table",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;assert_eq!(values,(4.0,5.0,"preserve".into()));
            let count:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_change_set_columns WHERE change_set_id=?",[&cast.value],|r|r.get(0))?;assert_eq!(count,3);
            crate::services::table_history_archive::validate_history_timeline(&engine.archive_unified_history()?)
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=cast.committed_revision;context.dataset_generations[0].generation=4;context.operation_id="undo-source-cast".into();
        service.apply_change_set(&context,"table",&cast.value,true).unwrap();
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {let values:(f64,f64,f64,String)=engine.conn().query_row("SELECT Renamed,Twice,Downstream,B FROM dataset_table",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;assert_eq!(values,(1.7,3.4,4.4,"preserve".into()));Ok(())}).unwrap();
    }

    #[test]
    fn project_v5_column_alteration_tracks_filters_values_and_reopened_history() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("alter.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"VARCHAR".into()])?;
            engine.conn().execute("INSERT INTO dataset_table (_row_id,A,B) VALUES (1,1.7,'preserve')",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=1 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;
            let catalog=ProjectCatalog::new(engine);catalog.publish_table(&engine.get_dataset_meta("table")?,"")?;
            catalog.apply_patch(&ProjectRecordPatch {settings:vec![ProjectSettingWrite {key:"filter:table".into(),expected_revision:None,value:serde_json::json!([{"id":"filter","op":"AND","rule":{"kind":"continuous","field":{"name":"A","type":"continuous"},"min":1,"max":null}}])}],..Default::default()})
        }).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"rename".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let renamed=service.alter_column(&context,"table","A","Renamed","DOUBLE",0).unwrap();
        assert_eq!(renamed.changed_history_entries[0].operation,"rename_column");assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        assert_eq!(serde_json::to_value(&renamed).unwrap()["changedFilterSettings"][0]["value"][0]["rule"]["field"]["name"],"Renamed");
        assert_eq!(service.alter_column(&context,"table","A","Renamed","DOUBLE",0).unwrap().value,renamed.value);
        context.expected_revision=renamed.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="cast".into();
        let cast=service.alter_column_types(&context,"table",&["Renamed".into()],"INTEGER",1).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {
            let unrelated:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_change_set_columns WHERE change_set_id=? AND before_name='B'",[&cast.value],|r|r.get(0))?;assert_eq!(unrelated,0);
            crate::services::table_history_archive::validate_history_timeline(&engine.archive_unified_history()?)
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=cast.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="undo-cast".into();
        let undo=service.apply_change_set(&context,"table",&cast.value,true).unwrap();
        service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine| {let values:(f64,String)=engine.conn().query_row("SELECT Renamed,B FROM dataset_table",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(values,(1.7,"preserve".into()));Ok(())}).unwrap();
        context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=3;context.operation_id="undo-rename".into();
        let undo=service.apply_change_set(&context,"table",&renamed.value,true).unwrap();assert_eq!(serde_json::to_value(&undo).unwrap()["changedFilterSettings"][0]["value"][0]["rule"]["field"]["name"],"A");
        context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=4;context.operation_id="invalid-cast".into();
        assert!(service.alter_column_types(&context,"table",&["B".into()],"INTEGER",4).is_err());
        context.operation_id="cast-text".into();
        let text=service.alter_column_types(&context,"table",&["A".into()],"VARCHAR",4).unwrap();
        assert_eq!(serde_json::to_value(&text).unwrap()["changedFilterSettings"][0]["value"],serde_json::json!([]),"numeric filters must be inactive after conversion to text");
        context.expected_revision=text.committed_revision;context.dataset_generations[0].generation=5;context.operation_id="undo-text".into();
        let undo=service.apply_change_set(&context,"table",&text.value,true).unwrap();assert_eq!(serde_json::to_value(undo).unwrap()["changedFilterSettings"][0]["value"][0]["rule"]["field"]["name"],"A");
    }

    #[test]
    fn project_v5_calculated_column_commits_replay_rollback_and_reopened_undo() {
        use crate::services::calculated_column_service::{UpsertCalculatedColumnInput,install_test_materialization_failure_after_metadata};
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("calculated.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine|{engine.create_empty_table("table","Table",&["A".into()],&["DOUBLE".into()])?;engine.conn().execute("INSERT INTO dataset_table (_row_id,A) VALUES (1, 3)",[])?;engine.conn().execute("UPDATE _meta_datasets SET row_count=1 WHERE id='table'",[])?;engine.rebuild_natural_anchors("table",0)?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"formula".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration{id:"table".into(),generation:0}]};
        let input=UpsertCalculatedColumnInput{dataset_id:"table".into(),output_name:"Twice".into(),formula_text:"[A] * 2".into(),at_index:Some(0),output_column_id:None,formula_id:None,expected_generation:Some(0)};
        install_test_materialization_failure_after_metadata(Some(1));
        assert!(service.upsert_calculated_column(&context,&input).is_err());
        assert_eq!(service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.get_user_columns("table")).unwrap().len(),1);
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let created=service.upsert_calculated_column(&context,&input).unwrap();
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0,"formula edits must snapshot only affected columns");
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {let unrelated:i64=engine.conn().query_row("SELECT COUNT(*) FROM _history_change_set_columns WHERE change_set_id=? AND before_name='A'",[&created.value.change_set_id],|r|r.get(0))?;assert_eq!(unrelated,0);Ok(())}).unwrap();
        assert_eq!(created.value.dataset_generation,1);assert_eq!(created.changed_history_entries.len(),1);
        let replay=service.upsert_calculated_column(&context,&input).unwrap();assert_eq!(created.value.column_id,replay.value.column_id);assert_eq!(created.committed_revision,replay.committed_revision);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {let value:f64=engine.conn().query_row("SELECT Twice FROM dataset_table",[],|r|r.get(0))?;assert_eq!(value,6.0);Ok(())}).unwrap();
        context.expected_revision=created.committed_revision;context.operation_id="values".into();context.dataset_generations[0].generation=1;
        let values=service.convert_calculated_column_to_values(&context,"table",&created.value.column_id,1).unwrap();assert!(values.value.calculated.is_none());assert_eq!(values.value.dataset_generation,2);
        assert_eq!(values.changed_history_entries[0].operation,"convert_calculated");
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {let archive=engine.archive_unified_history()?;assert!(archive.entries.iter().find(|item|item.change_set_id==values.value.change_set_id).unwrap().snapshots.is_empty());Ok(())}).unwrap();
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|crate::services::table_history_archive::validate_history_timeline(&engine.archive_unified_history()?)).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();context.expected_epoch=reopened.epoch;context.expected_revision=values.committed_revision;context.operation_id="undo-values".into();context.dataset_generations[0].generation=2;
        service.apply_change_set(&context,"table",&values.value.change_set_id,true).unwrap();
        let descriptors=service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|engine.get_table_column_descriptors("table")).unwrap();assert!(descriptors.iter().find(|column|column.column_id==created.value.column_id).unwrap().calculated.is_some());
    }

    #[test]
    fn project_v5_column_reorder_is_metadata_only_and_replayable_after_reopen() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("reorder.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine|{engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"DOUBLE".into()])?;ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")}).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"reorder".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration {id:"table".into(),generation:0}]};
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let reordered=service.reorder_columns(&context,"table",0,1,0).unwrap();assert_eq!(reordered.value,1);
        assert_eq!(reordered.changed_history_entries.len(),1);assert_eq!(reordered.changed_history_entries[0].operation,"reorder_columns");
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        let names=service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.get_user_columns("table")).unwrap();assert_eq!(names[0].0,"B");
        let replay=service.reorder_columns(&context,"table",0,1,0).unwrap();assert_eq!(replay.changed_history_entries[0].id,reordered.changed_history_entries[0].id);
        service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine| {
            let (delta,snapshots)=engine.archive_delta_history()?;
            crate::services::spprj_archive::validate_delta_history_contract(&delta,&snapshots)?;
            let archive=engine.archive_unified_history()?;
            crate::services::table_history_archive::validate_history_timeline(&archive)?;
            assert!(snapshots.is_empty());assert!(archive.entries[0].snapshots.is_empty());
            Ok(())
        }).unwrap();
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();
        context.expected_epoch=reopened.epoch;context.expected_revision=reordered.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="undo-reorder".into();
        let undo=service.apply_change_set(&context,"table",&reordered.changed_history_entries[0].id,true).unwrap();
        let names=service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|engine.get_user_columns("table")).unwrap();assert_eq!(names[0].0,"A");
        context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="redo-reorder".into();
        let redone=service.apply_change_set(&context,"table",&reordered.changed_history_entries[0].id,false).unwrap();
        let names=service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|engine.get_user_columns("table")).unwrap();assert_eq!(names[0].0,"B");
        context.expected_revision=redone.committed_revision;context.dataset_generations[0].generation=3;context.operation_id="undo-again".into();
        let undone=service.apply_change_set(&context,"table",&reordered.changed_history_entries[0].id,true).unwrap();
        context.expected_revision=undone.committed_revision;context.dataset_generations[0].generation=4;context.operation_id="new-row-branch".into();
        service.add_rows(&context,"table",1,None,4).unwrap();
        let exists:bool=service.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _history_change_sets WHERE id=?)",[&reordered.changed_history_entries[0].id],|row|row.get(0))?)).unwrap();
        assert!(!exists,"new edits must retire the abandoned reorder redo branch");
    }

    #[test]
    fn project_v5_column_deletion_filters_and_display_follow_reopened_undo() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("delete-columns.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"DOUBLE".into()])?;
            let catalog=ProjectCatalog::new(engine);catalog.publish_table(&engine.get_dataset_meta("table")?,"")?;
            catalog.apply_patch(&ProjectRecordPatch {settings:vec![
                ProjectSettingWrite {key:"display:table".into(),expected_revision:None,value:serde_json::json!([{"colIndex":1,"width":222}])},
                ProjectSettingWrite {key:"filter:table".into(),expected_revision:None,value:serde_json::json!([{"id":"filter","op":"AND","rule":{"kind":"continuous","field":{"name":"B","type":"continuous"},"min":1,"max":null}}])}
            ],..Default::default()})
        }).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let columns=service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|engine.get_table_column_descriptors("table")).unwrap();
        let removed_id=columns[1].column_id.clone();
        let mut context=ProjectWriteContext {operation_id:"delete-columns".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration {id:"table".into(),generation:0}]};
        let deleted=service.delete_columns(&context,"table",&columns[1..],0).unwrap();assert_eq!(deleted.value.column_count,1);
        assert_eq!(service.get_setting(opened.epoch,"filter:table").unwrap().unwrap().value,serde_json::json!([]));
        assert!(service.column_display_props(opened.epoch,"table").unwrap().is_empty());
        let receipt=serde_json::to_value(&deleted).unwrap();assert_eq!(receipt["changedFilterSettings"][0]["value"],serde_json::json!([]));
        let raw=service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|Ok(ProjectCatalog::new(engine).get_setting("filter:table")?.unwrap().1)).unwrap();
        assert_eq!(raw[0]["rule"]["field"]["columnId"],removed_id);
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();
        context.expected_epoch=reopened.epoch;context.expected_revision=deleted.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="undo-deletion".into();
        let undo=service.apply_change_set(&context,"table",&deleted.value.change_set_id,true).unwrap();
        let filters=service.get_setting(reopened.epoch,"filter:table").unwrap().unwrap().value;
        assert_eq!(filters[0]["rule"]["field"]["columnId"],removed_id);
        assert_eq!(serde_json::to_value(undo).unwrap()["changedFilterSettings"][0]["value"],filters);
        let display=service.column_display_props(reopened.epoch,"table").unwrap();assert_eq!(display[0].col_index,1);assert_eq!(display[0].width,Some(222.0));
    }

    #[test]
    fn project_v5_column_addition_preserves_display_identity_replay_and_reopened_undo() {
        use crate::models::table::ColumnDescriptor;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("columns.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        db.with_engine(|engine| {
            engine.create_empty_table("table","Table",&["A".into(),"B".into()],&["DOUBLE".into(),"DOUBLE".into()])?;
            let catalog=ProjectCatalog::new(engine);catalog.publish_table(&engine.get_dataset_meta("table")?,"")?;
            catalog.apply_patch(&ProjectRecordPatch {settings:vec![ProjectSettingWrite {key:"display:table".into(),expected_revision:None,value:serde_json::json!([{"colIndex":0,"width":111},{"colIndex":1,"width":222}])}],..Default::default()})
        }).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();
        let mut context=ProjectWriteContext {operation_id:"add-columns".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![DatasetGeneration {id:"table".into(),generation:0}]};
        let column=ColumnDescriptor {column_id:uuid::Uuid::new_v4().to_string(),name:"Inserted".into(),sql_type:"VARCHAR".into(),calculated:None};
        let mut rejected=context.clone();rejected.operation_id="invalid-column".into();
        let mut invalid=column.clone();invalid.name="A".into();
        assert!(service.add_columns(&rejected,"table",&[invalid],Some(1),0).is_err());
        assert!(service.database(opened.epoch).unwrap().with_reader(opened.epoch,|engine|Ok(ProjectCatalog::new(engine).get_setting("display:table")?.unwrap().1.is_array())).unwrap(),"failed schema changes must roll back the positional setting conversion");
        assert_eq!(service.database(opened.epoch).unwrap().committed_revision().unwrap(),0);
        crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
        let added=service.add_columns(&context,"table",&[column.clone()],Some(1),0).unwrap();
        assert_eq!(added.value.column_count,3);assert_eq!(added.value.generation,1);
        assert_eq!(added.changed_setting_revisions[0].key,"display:table");
        let props=service.column_display_props(opened.epoch,"table").unwrap();
        assert_eq!(props[0].col_index,0);assert_eq!(props[0].width,Some(111.0));assert_eq!(props[1].col_index,2);assert_eq!(props[1].width,Some(222.0));
        let replay=service.add_columns(&context,"table",&[column],Some(1),0).unwrap();
        assert_eq!(added.value.change_set_id,replay.value.change_set_id);
        assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(),0);
        service.close_enabled(opened.epoch).unwrap();let reopened=service.open_enabled(&path,false).unwrap();
        context.expected_epoch=reopened.epoch;context.expected_revision=added.committed_revision;context.dataset_generations[0].generation=1;context.operation_id="undo-columns".into();
        let undo=service.apply_change_set(&context,"table",&added.value.change_set_id,true).unwrap();
        let props=service.column_display_props(reopened.epoch,"table").unwrap();assert_eq!(props[1].col_index,1);assert_eq!(props[1].width,Some(222.0));
        context.expected_revision=undo.committed_revision;context.dataset_generations[0].generation=2;context.operation_id="redo-columns".into();
        service.apply_change_set(&context,"table",&added.value.change_set_id,false).unwrap();
        assert_eq!(service.column_display_props(reopened.epoch,"table").unwrap()[1].col_index,2);
    }

    #[test]
    fn project_v5_managed_creation_commits_rows_display_and_metadata_once() {
        use crate::models::table::{
            ColumnDisplayPropsWithoutIndex, CreateManagedTableRequest, CreateTableColumn,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed.spprj");
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let summary = service.open_enabled(&path, false).unwrap();
        let context = ProjectWriteContext {
            operation_id: "managed".into(),
            expected_project_id: summary.header.project_id,
            expected_epoch: summary.epoch,
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        let request = CreateManagedTableRequest {
            name: "Manual".into(),
            columns: vec![CreateTableColumn {
                name: "value".into(),
                column_type: "DOUBLE".into(),
                display: Some(ColumnDisplayPropsWithoutIndex {
                    width: Some(144.0),
                    format: None,
                    extras: None,
                }),
            }],
            rows: vec![vec![serde_json::json!(1.25)], vec![serde_json::Value::Null]],
        };
        let created = service.create_managed_table(&context, &request).unwrap();
        assert_eq!(created.value.dataset.row_count, 2);
        assert_eq!(created.value.columns[0].width, Some(144.0));
        let replay = service.create_managed_table(&context, &request).unwrap();
        assert_eq!(replay.value.dataset.id, created.value.dataset.id);
        let setting = service
            .database(summary.epoch)
            .unwrap()
            .with_reader(summary.epoch, |engine| {
                ProjectCatalog::new(engine)
                    .get_setting(&format!("display:{}", created.value.dataset.id))
            })
            .unwrap()
            .unwrap();
        assert_eq!(setting.0, 1);
        assert_eq!(setting.1[0]["width"], serde_json::json!(144.0));
        let mut invalid = request.clone();
        invalid.columns[0].display.as_mut().unwrap().width = Some(-1.0);
        let mut rejected = context.clone();
        rejected.operation_id = "invalid".into();
        rejected.expected_revision = created.committed_revision;
        assert!(service.create_managed_table(&rejected, &invalid).is_err());
        assert_eq!(
            service.status(summary.epoch).unwrap().committed_revision,
            created.committed_revision
        );
        assert_eq!(
            service
                .list_catalog(summary.epoch, &CatalogPageRequest::default())
                .unwrap()
                .items
                .len(),
            1
        );
        let mut row_context = context.clone();
        row_context.operation_id = "rows".into();
        row_context.expected_revision = created.committed_revision;
        let rows = service
            .create_table_from_rows(
                &row_context,
                &crate::models::table::CreateTableFromRowsRequest {
                    name: "Rows".into(),
                    column_names: vec!["value".into()],
                    column_types: vec!["BIGINT".into()],
                    rows: vec![vec![serde_json::json!(3)]],
                },
            )
            .unwrap();
        assert_eq!(rows.value.row_count, 1);
        assert_eq!(rows.changed_directory_entries[0].id, rows.value.id);
        assert_eq!(
            service
                .column_display_props(summary.epoch, &created.value.dataset.id)
                .unwrap()[0]
                .width,
            Some(144.0)
        );
        let columns = service
            .database(summary.epoch)
            .unwrap()
            .with_reader(summary.epoch, |engine| {
                engine.get_table_column_descriptors(&created.value.dataset.id)
            })
            .unwrap();
        let ids = columns
            .iter()
            .map(|column| column.column_id.clone())
            .collect::<Vec<_>>();
        let mut display_context = context.clone();
        display_context.operation_id = "display".into();
        display_context.expected_revision = rows.committed_revision;
        display_context.dataset_generations =
            vec![crate::models::project_persistence::DatasetGeneration {
                id: created.value.dataset.id.clone(),
                generation: created.value.generation,
            }];
        let props = vec![crate::models::table::ColumnDisplayProps {
            col_index: 0,
            width: Some(177.0),
            format: None,
            extras: None,
        }];
        let displayed = service
            .set_column_display_props(&display_context, &created.value.dataset.id, &ids, &props)
            .unwrap();
        assert_eq!(displayed.changed_setting_revisions[0].revision, 2);
        service
            .set_column_display_props(&display_context, &created.value.dataset.id, &ids, &props)
            .unwrap();
        assert_eq!(
            service
                .column_display_props(summary.epoch, &created.value.dataset.id)
                .unwrap()[0]
                .width,
            Some(177.0)
        );
        display_context.operation_id = "stale-column".into();
        display_context.expected_revision = displayed.committed_revision;
        assert!(service
            .set_column_display_props(
                &display_context,
                &created.value.dataset.id,
                &["removed-column".into()],
                &props
            )
            .is_err());
        display_context.operation_id = "invalid-width".into();
        let mut invalid = props.clone();
        invalid[0].width = Some(-1.0);
        assert!(service
            .set_column_display_props(&display_context, &created.value.dataset.id, &ids, &invalid)
            .is_err());
        assert_eq!(
            service.status(summary.epoch).unwrap().committed_revision,
            displayed.committed_revision
        );
        let display_record = service
            .get_setting(
                summary.epoch,
                &format!("display:{}", created.value.dataset.id),
            )
            .unwrap()
            .unwrap();
        assert_eq!(display_record.revision, 2);
        assert_eq!(display_record.value[0]["width"], serde_json::json!(177.0));
        assert!(service
            .get_setting(summary.epoch, "filter:missing")
            .unwrap()
            .is_none());
        assert!(service.get_setting(summary.epoch + 1, "lineage").is_err());

        let mut rename_context = display_context.clone();
        rename_context.operation_id = "rename-table".into();
        let renamed = service
            .rename_dataset(&rename_context, &created.value.dataset.id, "Renamed manual")
            .unwrap();
        assert_eq!(renamed.changed_directory_entries[0].name, "Renamed manual");
        assert_eq!(
            renamed.changed_dataset_generations[0].generation,
            created.value.generation
        );
        service
            .rename_dataset(&rename_context, &created.value.dataset.id, "Renamed manual")
            .unwrap();
    }

    #[test]
    fn project_v5_sqlite_route_replays_after_source_removal_and_guards_append() {
        use crate::models::data_link::SqliteImportSelection;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.spprj");
        let source = dir.path().join("source.sqlite");
        let sqlite = rusqlite::Connection::open(&source).unwrap();
        sqlite
            .execute_batch("CREATE TABLE input(value INTEGER); INSERT INTO input VALUES (31),(41)")
            .unwrap();
        drop(sqlite);
        ProjectDatabase::create(&path, false)
            .unwrap()
            .shutdown()
            .unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let opened = service.open_enabled(&path, false).unwrap();
        let mut context = ProjectWriteContext {
            operation_id: "sqlite-create".into(),
            expected_project_id: opened.header.project_id,
            expected_epoch: opened.epoch,
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        let selections = vec![SqliteImportSelection {
            source_name: "input".into(),
            target_name: "Imported".into(),
            action: "create".into(),
        }];
        let created = service
            .import_sqlite(
                &context,
                source.to_str().unwrap(),
                &selections,
                |_, _, _, _, _| {},
                || false,
            )
            .unwrap();
        assert_eq!(created.value.total_rows_written, 2);
        let table = created
            .changed_directory_entries
            .iter()
            .find(|entry| entry.kind == ProjectDocumentKind::Table)
            .unwrap();
        let append = vec![SqliteImportSelection {
            action: "append".into(),
            ..selections[0].clone()
        }];
        context.operation_id = "missing-generation".into();
        context.expected_revision = created.committed_revision;
        assert!(service
            .import_sqlite(
                &context,
                source.to_str().unwrap(),
                &append,
                |_, _, _, _, _| {},
                || false
            )
            .is_err());
        context.operation_id = "sqlite-append".into();
        context.dataset_generations = created.changed_dataset_generations.clone();
        let appended = service
            .import_sqlite(
                &context,
                source.to_str().unwrap(),
                &append,
                |_, _, _, _, _| {},
                || false,
            )
            .unwrap();
        assert_eq!(appended.value.imported[0].action, "append");
        assert_eq!(appended.value.total_rows_written, 2);
        service
            .database(opened.epoch)
            .unwrap()
            .with_reader(opened.epoch, |engine| {
                assert_eq!(
                    engine
                        .list_datasets()?
                        .iter()
                        .find(|dataset| dataset.id == table.id)
                        .unwrap()
                        .row_count,
                    4
                );
                Ok(())
            })
            .unwrap();
        let mut cancelled = context.clone();
        cancelled.operation_id = "cancelled".into();
        cancelled.expected_revision = appended.committed_revision;
        cancelled.dataset_generations = appended.changed_dataset_generations.clone();
        assert!(matches!(
            service.import_sqlite(
                &cancelled,
                source.to_str().unwrap(),
                &append,
                |_, _, _, _, _| {},
                || true
            ),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(
            service.status(opened.epoch).unwrap().committed_revision,
            appended.committed_revision
        );
        std::fs::remove_file(&source).unwrap();
        let replay = service
            .import_sqlite(
                &context,
                source.to_str().unwrap(),
                &append,
                |_, _, _, _, _| panic!("receipt must not read source"),
                || false,
            )
            .unwrap();
        assert_eq!(replay.value, appended.value);
        assert_eq!(replay.committed_revision, appended.committed_revision);
    }

    #[test]
    fn project_v5_setting_read_validates_selected_lineage_lazily() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.spprj");
        let database = ProjectDatabase::create(&path, false).unwrap();
        let context = ProjectWriteContext {
            operation_id: "invalid-lineage".into(),
            expected_project_id: database.header().unwrap().project_id,
            expected_epoch: database.epoch(),
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        database
            .commit_records(
                &context,
                &ProjectRecordPatch {
                    settings: vec![ProjectSettingWrite {
                        key: "lineage".into(),
                        expected_revision: None,
                        value: serde_json::json!({"nodes":"invalid"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        database.shutdown().unwrap();
        let state = AppState::new().unwrap();
        let service = NativeProjectService::new(&state);
        let opened = service.open_enabled(&path, false).unwrap();
        assert_eq!(
            opened.header.committed_revision, 1,
            "invalid unselected value must not force eager setting loading at open"
        );
        assert!(service.get_setting(opened.epoch, "lineage").is_err());
        assert!(service
            .get_setting(opened.epoch, "filter:missing")
            .unwrap()
            .is_none());
        assert_eq!(service.status(opened.epoch).unwrap().committed_revision, 1);
        let next = ProjectWriteContext {
            operation_id: "minimal-lineage".into(),
            expected_project_id: opened.header.project_id.clone(),
            expected_epoch: opened.epoch,
            expected_revision: 1,
            ..context
        };
        service.commit_records(&next, &ProjectRecordPatch {
            settings: vec![ProjectSettingWrite {
                key: "lineage".into(), expected_revision: Some(1),
                value: serde_json::json!({"id":"project-lineage","extension":{"keep":true}}),
            }, ProjectSettingWrite {
                key: "transformBinding:transform".into(), expected_revision: None,
                value: serde_json::json!({"definitionId":"transform","definitionRevision":1,"outputGeneration":0,"extension":true}),
            }],
            ..Default::default()
        }).unwrap();
        let lineage = service
            .get_setting(opened.epoch, "lineage")
            .unwrap()
            .unwrap();
        assert_eq!(lineage.value["nodes"], serde_json::json!([]));
        assert_eq!(lineage.value["edges"], serde_json::json!([]));
        assert_eq!(lineage.value["name"], "");
        assert_eq!(lineage.value["graphVersion"], 0);
        assert_eq!(lineage.value["graphHash"], "");
        assert_eq!(lineage.value["extension"]["keep"], true);
        let binding = service
            .get_setting(opened.epoch, "transformBinding:transform")
            .unwrap()
            .unwrap();
        assert_eq!(binding.value["inputs"], serde_json::json!([]));
        assert_eq!(binding.value["schemaReports"], serde_json::json!([]));
        assert_eq!(binding.value["extension"], true);
        assert_eq!(service.status(opened.epoch).unwrap().committed_revision, 2);
    }

    #[test]
    fn project_v5_open_requires_explicit_capability() {
        let state = AppState::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("native.spprj");
        fixture(&path);
        let result = NativeProjectService::new(&state).open(&path, true);
        assert_eq!(result.is_ok(), cfg!(feature = "project-v5"));
        if let Ok(summary) = result {
            assert!(!summary.writable);
        }
    }
    #[test]
    fn project_v5_fit_columns_commit_replay_rollback_and_reopened_history() {
        use crate::models::fit_model::SaveFitModelColumnsRequest;
        let root=tempfile::tempdir().unwrap();let path=root.path().join("fit.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        let context=ProjectWriteContext{operation_id:"seed-fit".into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:0,request_digest:String::new(),dataset_generations:vec![],document_revisions:vec![]};
        let meta=db.materialize_project_sql(&context,&crate::services::project_output::ProjectSqlOutput{name:"Fit source".into(),sql:"SELECT 1.0 AS X,4.9 AS Y UNION ALL SELECT 2.0,7.2 UNION ALL SELECT 3.0,8.9 UNION ALL SELECT 4.0,11.2 UNION ALL SELECT 5.0,12.9 UNION ALL SELECT 6.0,15.2 UNION ALL SELECT 7.0,16.9 UNION ALL SELECT 8.0,19.2 UNION ALL SELECT NULL,22.0".into(),folder:String::new()}).unwrap().value;
        db.shutdown().unwrap();let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();let live=service.database(opened.epoch).unwrap();
        let request:SaveFitModelColumnsRequest=serde_json::from_value(serde_json::json!({"datasetId":meta.id,"expectedGeneration":0,"modelName":"Linear","responseColumn":"Y","terms":[{"kind":"main","columnNames":["X"]}],"centeringMethod":"none","confidenceLevel":0.95,"metrics":["predicted","residual"]})).unwrap();
        let write=ProjectWriteContext{operation_id:"fit-output".into(),expected_epoch:opened.epoch,expected_revision:opened.header.committed_revision,dataset_generations:vec![DatasetGeneration{id:meta.id.clone(),generation:0}],..context};
        let history_before=live.with_engine(|e|Ok(ProjectCatalog::new(e).list_history(&HistoryPageRequest{after:None,limit:10,dataset_id:None})?.items.len())).unwrap();
        crate::services::project_transaction::inject_commit_failure_for_test(1);assert!(service.save_fit_model_columns(&write,&request).is_err());
        live.with_engine(|engine|{assert_eq!(engine.get_user_columns(&meta.id)?.len(),2);assert_eq!(ProjectCatalog::new(engine).list_history(&HistoryPageRequest{after:None,limit:10,dataset_id:None})?.items.len(),history_before);Ok(())}).unwrap();
        table_mutation_coordinator::reset_full_before_table_copy_counter();let saved=service.save_fit_model_columns(&write,&request).unwrap();assert_eq!(saved.value.columns.len(),2);assert_eq!(table_mutation_coordinator::full_before_table_copy_counter(),0);
        assert_eq!(serde_json::to_value(service.save_fit_model_columns(&write,&request).unwrap()).unwrap(),serde_json::to_value(&saved).unwrap());
        live.with_engine(|engine|{let table=crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&meta.id));let count:i64=engine.conn().query_row(&format!("SELECT COUNT(*) FROM {table} WHERE \"Linear Predicted\" IS NOT NULL AND \"Linear Residual\" IS NOT NULL"),[],|r|r.get(0))?;assert_eq!(count,8);let copied:i64=engine.conn().query_row("SELECT COUNT(*) FROM information_schema.columns WHERE table_name=(SELECT snapshot_table FROM _history_delta_change_sets WHERE id=?)",[&saved.value.change_set_id],|r|r.get(0))?;assert_eq!(copied,3);assert!(engine.archive_unified_history().is_ok());Ok(())}).unwrap();
        drop(live);service.close_enabled(opened.epoch).unwrap();let opened=service.open_enabled(&path,false).unwrap();let live=service.database(opened.epoch).unwrap();
        let undo=ProjectWriteContext{operation_id:"undo-fit".into(),expected_epoch:opened.epoch,expected_revision:opened.header.committed_revision,dataset_generations:vec![DatasetGeneration{id:meta.id.clone(),generation:1}],..write.clone()};
        service.apply_change_set(&undo,&meta.id,&saved.value.change_set_id,true).unwrap();live.with_engine(|e|{assert_eq!(e.get_user_columns(&meta.id)?.len(),2);Ok(())}).unwrap();
        let redo=ProjectWriteContext{operation_id:"redo-fit".into(),expected_revision:live.header().unwrap().committed_revision,dataset_generations:vec![DatasetGeneration{id:meta.id.clone(),generation:2}],..undo};service.apply_change_set(&redo,&meta.id,&saved.value.change_set_id,false).unwrap();
        live.with_engine(|e|{let table=crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&meta.id));let count:i64=e.conn().query_row(&format!("SELECT COUNT(*) FROM {table} WHERE \"Linear Predicted\" IS NOT NULL"),[],|r|r.get(0))?;assert_eq!(count,8);assert_eq!(e.get_user_columns(&meta.id)?.len(),4);Ok(())}).unwrap();
        drop(live);service.close_enabled(opened.epoch).unwrap();
    }

    #[test]
    fn project_v5_tabulate_output_atomic_replay_after_session_release() {
        use crate::models::tabulate::{TabulateSessionRequest,TabulateMaterializeRequest,TabulateSessionState};
        let root=tempfile::tempdir().unwrap();let path=root.path().join("tabulate.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let seed=ProjectWriteContext{operation_id:"seed-tabulate".into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:0,request_digest:String::new(),dataset_generations:vec![],document_revisions:vec![]};
        let meta=db.materialize_project_sql(&seed,&crate::services::project_output::ProjectSqlOutput{name:"Source".into(),sql:"SELECT 'West' AS Region,'A' AS Product,2.0 AS Sales UNION ALL SELECT 'West','A',4.0 UNION ALL SELECT 'East','B',8.0".into(),folder:String::new()}).unwrap().value;db.shutdown().unwrap();
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();let live=service.database(opened.epoch).unwrap();let tabulate=state.tabulate_sessions.read().unwrap().clone();
        let definition:TabulateSessionRequest=serde_json::from_value(serde_json::json!({"datasetId":meta.id,"sourceGeneration":0,"rowFields":["Region"],"columnFields":["Product"],"statistics":[{"id":"mean","field":"Sales","kind":"mean"}],"includeRowTotals":false,"includeColumnTotals":false})).unwrap();
        let mut status=tabulate.prepare(&definition).unwrap();let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
        while status.state==TabulateSessionState::Preparing && std::time::Instant::now()<deadline {std::thread::sleep(std::time::Duration::from_millis(5));status=tabulate.status(&status.session_id).unwrap();}
        assert_eq!(status.state,TabulateSessionState::Ready);
        let request:TabulateMaterializeRequest=serde_json::from_value(serde_json::json!({"sessionId":status.session_id,"sourceGeneration":0,"fingerprint":status.fingerprint,"destinationName":"Native summary","missingLabel":"Missing","statisticLabels":["Mean"]})).unwrap();
        let write=ProjectWriteContext{operation_id:"tabulate-output".into(),expected_epoch:opened.epoch,expected_revision:opened.header.committed_revision,dataset_generations:vec![DatasetGeneration{id:meta.id.clone(),generation:0}],..seed};
        let missing=ProjectWriteContext{operation_id:"missing-source".into(),dataset_generations:vec![],..write.clone()};assert!(service.materialize_tabulate(&missing,&request).unwrap_err().to_string().contains("project_dataset_precondition_required"));
        let stale=crate::models::tabulate::TabulateMaterializeRequest{source_generation:1,..request.clone()};assert!(service.materialize_tabulate(&write,&stale).unwrap_err().to_string().contains("tabulate_stale_source"));
        crate::services::project_transaction::inject_commit_failure_for_test(1);assert!(service.materialize_tabulate(&write,&request).unwrap_err().to_string().contains("injected_before_commit"));assert_eq!(live.with_engine(|e|e.list_datasets()).unwrap().len(),1);
        let output=service.materialize_tabulate(&write,&request).unwrap();assert_eq!(output.value.row_count,2);assert_eq!(output.value.col_count,3);assert_eq!(output.changed_dataset_metadata.len(),2);assert!(output.changed_dataset_metadata.iter().any(|table|table.id==meta.id&&table.generation==0));
        tabulate.release(&status.session_id).unwrap();assert_eq!(serde_json::to_value(service.materialize_tabulate(&write,&request).unwrap()).unwrap(),serde_json::to_value(&output).unwrap());
        live.with_engine(|e|{let scratch:i64=e.conn().query_row("SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE '__sp_tabulate_%'",[],|r|r.get(0))?;assert_eq!(scratch,0);Ok(())}).unwrap();
        drop(live);drop(tabulate);service.close_enabled(opened.epoch).unwrap();let opened=service.open_enabled(&path,false).unwrap();let live=service.database(opened.epoch).unwrap();
        live.with_engine(|e|{let table=crate::engine::duckdb_engine::DuckDbEngine::quote_identifier(&crate::engine::duckdb_engine::DuckDbEngine::internal_table_name(&output.value.id));let mut stmt=e.conn().prepare(&format!("SELECT \"Region\",\"A - Mean - Sales\",\"B - Mean - Sales\" FROM {table} ORDER BY Region"))?;let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<f64>>(1)?,r.get::<_,Option<f64>>(2)?)))?.collect::<Result<Vec<_>,_>>()?;assert_eq!(rows,vec![("East".into(),None,Some(8.0)),("West".into(),Some(3.0),None)]);Ok(())}).unwrap();drop(live);service.close_enabled(opened.epoch).unwrap();
    }

    #[test]
    fn project_v5_native_workflow_uses_authoritative_body_and_replays_lost_ack() {
        use crate::services::workflow_domain::{WorkflowDefinition,WorkflowInputBinding,WorkflowOutputBinding,WorkflowRunStatus};
        use crate::services::workflow_executor::WorkflowRunRequest;
        let root=tempfile::tempdir().unwrap();let path=root.path().join("workflow-native.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        let seed=ProjectWriteContext{operation_id:"workflow-source".into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:0,request_digest:String::new(),dataset_generations:vec![],document_revisions:vec![]};
        let source=db.materialize_project_sql(&seed,&crate::services::project_output::ProjectSqlOutput{name:"Source".into(),sql:"SELECT 1::BIGINT AS value UNION ALL SELECT 2 UNION ALL SELECT 3".into(),folder:String::new()}).unwrap().value;db.shutdown().unwrap();
        let workflow: WorkflowDefinition = serde_json::from_value(serde_json::json!({
            "id": "workflow-graph",
            "name": "Graph workflow",
            "formatVersion": "1",
            "revision": 1,
            "inputSlots": [{
                "id": "input-source",
                "name": "Source",
                "outputPort": { "id": "input-source:out", "name": "output", "payloadKind": "table" },
                "schemaContract": {
                    "schemaFingerprint": "schema-hash",
                    "columns": [{
                        "name": "value",
                        "canonicalDuckdbType": "BIGINT",
                        "required": true,
                        "requiredByOperationIds": ["operation-graph"]
                    }]
                }
            }],
            "operations": [{
                "id": "operation-graph",
                "kind": "graphGeneration",
                "schemaVersion": "1",
                "configuration": {
                    "mode": "2d",
                    "activeState": {
                        "encoding": { "x": { "name": "value", "type": "continuous" } },
                        "multiX": [], "multiY": [], "elements": [], "smootherLambda": 0.5
                    },
                    "filters": [],
                    "sampling": { "mode": "full" },
                    "groupThemeSlots": {}
                },
                "inputPorts": [{ "id": "operation-graph:in", "name": "source", "payloadKind": "table" }],
                "outputPorts": [{ "id": "operation-graph:out", "name": "result", "payloadKind": "graph" }]
            }],
            "edges": [
                {
                    "id": "edge-input",
                    "kind": "consumes",
                    "source": { "nodeId": "input-source", "portId": "input-source:out" },
                    "target": { "nodeId": "operation-graph", "portId": "operation-graph:in" }
                },
                {
                    "id": "edge-output",
                    "kind": "produces",
                    "source": { "nodeId": "operation-graph", "portId": "operation-graph:out" },
                    "target": { "nodeId": "output-graph", "portId": "output-graph:in" }
                }
            ],
            "outputDeclarations": [{
                "id": "output-graph",
                "name": "Stable graph",
                "inputPort": { "id": "output-graph:in", "name": "input", "payloadKind": "graph" },
                "outputPort": { "id": "output-graph:out", "name": "output", "payloadKind": "graph" },
                "sourceEndpoint": { "nodeId": "operation-graph", "portId": "operation-graph:out" },
                "artifactKind": "graph"
            }]
        }))
        .expect("workflow fixture");
        let state=AppState::new().unwrap();let service=NativeProjectService::new(&state);let opened=service.open_enabled(&path,false).unwrap();let live=service.database(opened.epoch).unwrap();
        let save=ProjectWriteContext{operation_id:"workflow-definition".into(),expected_epoch:opened.epoch,expected_revision:opened.header.committed_revision,..seed};
        let summary=ProjectDocumentSummary{id:workflow.id.clone(),kind:ProjectDocumentKind::Workflow,name:workflow.name.clone(),folder:String::new(),revision:1,dependencies:vec![],analysis_kind:None};
        service.commit_records(&save,&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:None,document:ProjectDocumentBody{summary:summary.clone(),schema_version:1,body:serde_json::to_value(&workflow).unwrap()}}],..Default::default()}).unwrap();
        let request=WorkflowRunRequest{workflow:workflow.clone(),input_bindings:vec![WorkflowInputBinding{slot_id:"input-source".into(),table_document_id:source.id.clone()}],output_bindings:vec![WorkflowOutputBinding{declaration_id:"output-graph".into(),artifact_document_id:"native-graph".into()}],seed:42,previous_runs:vec![]};
        let context=ProjectWriteContext{operation_id:"native-run".into(),expected_revision:live.header().unwrap().committed_revision,dataset_generations:vec![DatasetGeneration{id:source.id.clone(),generation:0}],document_revisions:vec![DocumentRevision{id:workflow.id.clone(),revision:1}],..save.clone()};
        let mut forged=request.clone();forged.workflow.name="Uncommitted definition".into();assert!(service.run_workflow(&context,&forged,"").unwrap_err().to_string().contains("project_workflow_definition_stale"));
        crate::services::project_transaction::inject_commit_failure_for_test(1);assert!(service.run_workflow(&context,&request,"").unwrap_err().to_string().contains("injected_before_commit"));
        live.with_engine(|engine|{assert!(ProjectCatalog::new(engine).get_document("native-graph",1).is_err());let staged:i64=engine.conn().query_row("SELECT COUNT(*) FROM _project_staging",[],|r|r.get(0))?;assert_eq!(staged,0);Ok(())}).unwrap();
        crate::services::project_transaction::inject_commit_failure_for_test(2);assert!(service.run_workflow(&context,&request,"").unwrap_err().to_string().contains("injected_lost_ack"));
        let committed=service.run_workflow(&context,&request,"").unwrap();assert_eq!(committed.value.run.status,WorkflowRunStatus::Succeeded);assert_eq!(committed.value.documents.len(),1);
        live.with_engine(|engine|{let graph=ProjectCatalog::new(engine).get_document("native-graph",1)?;assert_eq!(graph.body["sourceDatasetId"],source.id);let run=ProjectCatalog::new(engine).get_setting(&format!("workflowRun:{}",committed.value.run.id))?.unwrap();assert_eq!(run.1,serde_json::to_value(&committed.value).unwrap());Ok(())}).unwrap();
        let state_summary=service.workflow_run_state(opened.epoch,&workflow.id,1).unwrap();assert_eq!(state_summary.total_count,1);assert_eq!(state_summary.latest_run_id.as_deref(),Some(committed.value.run.id.as_str()));assert_eq!(state_summary.latest_output_bindings.unwrap()[0].artifact_document_id,"native-graph");
        live.with_engine(|engine|{let indexed:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_workflow_runs')",[],|r|r.get(0))?;assert!(indexed);Ok(())}).unwrap();
        let mut untrusted=request.clone();let mut fake_baseline=committed.value.run.clone();fake_baseline.output_fingerprints[0].content_hash="forged-client-baseline".into();untrusted.previous_runs=vec![fake_baseline];
        let rerun_context=ProjectWriteContext{operation_id:"native-rerun".into(),expected_revision:live.header().unwrap().committed_revision,document_revisions:vec![DocumentRevision{id:workflow.id.clone(),revision:1},DocumentRevision{id:"native-graph".into(),revision:1}],..context.clone()};
        let rerun=service.run_workflow(&rerun_context,&untrusted,"").unwrap();assert_eq!(rerun.value.run.status,WorkflowRunStatus::Succeeded);assert_eq!(rerun.value.run.determinism_baseline_run_id.as_deref(),Some(committed.value.run.id.as_str()));
        let mut broken=workflow.clone();broken.revision=2;broken.operations[0].configuration=None;
        let definition_update=ProjectWriteContext{operation_id:"break-definition".into(),expected_revision:live.header().unwrap().committed_revision,document_revisions:vec![DocumentRevision{id:workflow.id.clone(),revision:1}],dataset_generations:vec![],..context.clone()};
        service.commit_records(&definition_update,&ProjectRecordPatch{documents:vec![DocumentWrite{expected_revision:Some(1),document:ProjectDocumentBody{summary:ProjectDocumentSummary{revision:2,..summary.clone()},schema_version:1,body:serde_json::to_value(&broken).unwrap()}}],..Default::default()}).unwrap();
        let failed_request=WorkflowRunRequest{workflow:broken,..request.clone()};let failed_context=ProjectWriteContext{operation_id:"failed-run".into(),expected_revision:live.header().unwrap().committed_revision,document_revisions:vec![DocumentRevision{id:workflow.id.clone(),revision:2},DocumentRevision{id:"native-graph".into(),revision:2}],..context.clone()};
        crate::services::project_transaction::inject_commit_failure_for_test(2);assert!(service.run_workflow(&failed_context,&failed_request,"").unwrap_err().to_string().contains("injected_lost_ack"));
        let failed=service.run_workflow(&failed_context,&failed_request,"").unwrap();assert_eq!(failed.value.run.status,WorkflowRunStatus::Failed);assert!(failed.value.documents.is_empty());
        live.with_engine(|engine|{assert!(ProjectCatalog::new(engine).get_document("native-graph",2).is_ok());assert!(ProjectCatalog::new(engine).get_document("native-graph",3).is_err());let run=ProjectCatalog::new(engine).get_setting(&format!("workflowRun:{}",failed.value.run.id))?.unwrap();assert_eq!(run.1,serde_json::to_value(&failed.value).unwrap());Ok(())}).unwrap();
        let state_summary=service.workflow_run_state(opened.epoch,&workflow.id,1).unwrap();assert_eq!(state_summary.total_count,3);assert_eq!(state_summary.latest_run_id.as_deref(),Some(rerun.value.run.id.as_str()));assert_eq!(service.workflow_run_state(opened.epoch,&workflow.id,2).unwrap().latest_run_id.as_deref(),Some(failed.value.run.id.as_str()));
        drop(live);service.close_enabled(opened.epoch).unwrap();let opened=service.open_enabled(&path,false).unwrap();let replay=service.run_workflow(&ProjectWriteContext{expected_epoch:opened.epoch,..context},&request,"").unwrap();assert_eq!(replay.value.commit_id,committed.value.commit_id);service.close_enabled(opened.epoch).unwrap();
    }

}

#[cfg(all(test,feature="project-v5"))]
mod live_server_fixture_tests {
    use super::*;
    use crate::engine::duckdb_engine::DuckDbEngine;
    use crate::models::data_link::*;
    use crate::services::project_database::ProjectDatabase;

    #[test]
    #[ignore = "requires authorized project-v5-servers Docker fixtures"]
    fn project_v5_live_server_fixtures_import_cancel_receipt_and_reopen() {
        assert_eq!(std::env::var("STATSPG_NATIVE_SERVER_FIXTURES").as_deref(),Ok("1"),"start the reviewed temporary fixtures explicitly");
        for (connector,port,schema) in [(ConnectorKind::PostgreSql,55432,"public"),(ConnectorKind::MySql,53306,"statsplayground_test")] {
            let dir=tempfile::tempdir().unwrap();let path=dir.path().join("native.spprj");ProjectDatabase::create(&path,false).unwrap().shutdown().unwrap();
            let state=crate::state::AppState::new().unwrap();let native=NativeProjectService::new(&state);let opened=native.open(&path,false).unwrap();let db=native.database(opened.epoch).unwrap();
            let definition=ConnectionDefinition{connector,host:"127.0.0.1".into(),port,database:"statsplayground_test".into(),authentication_type:AuthenticationType::UsernamePassword,tls_mode:TlsMode::Disabled,tls_root_certificate_pem:None,connect_timeout_seconds:5};
            let credentials=ConnectionCredentials{username:"stats_reader".into(),password:"issue282-test-only-reader".into()};
            let object=|name:&str|SourceObjectRef{catalog:Some("statsplayground_test".into()),schema:Some(schema.into()),name:name.into(),object_type:SourceObjectType::Table};
            let context=ProjectWriteContext{operation_id:"small".into(),expected_project_id:opened.header.project_id,expected_epoch:opened.epoch,expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
            crate::services::project_transaction::inject_commit_failure_for_test(2);
            assert!(native.import_server(&context,definition.clone(),credentials.clone(),object("native_small"),"Small",|_,_|{},||false).unwrap_err().to_string().contains("injected_lost_ack"));
            let receipt=native.import_server(&context,definition.clone(),ConnectionCredentials{username:credentials.username.clone(),password:String::new()},object("native_small"),"Small",|_,_|{},||false).unwrap();
            assert_eq!(receipt.value.total_rows_written,3);let small_id=receipt.changed_dataset_generations[0].id.clone();
            let verify=|epoch|native.database(epoch).unwrap().with_reader(epoch,|engine|{
                let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&small_id));
                let value:(String,String,String,bool)=engine.conn().query_row(&format!("SELECT CAST(id AS VARCHAR),CAST(amount AS VARCHAR),label,optional_value IS NULL FROM {table} WHERE id=9007199254740993"),[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
                assert_eq!(value,("9007199254740993".into(),"123456789.12345678".into(),"中文".into(),true));Ok(())
            }).unwrap();verify(opened.epoch);
            let cancelled=std::cell::Cell::new(false);let large_context=ProjectWriteContext{operation_id:"large".into(),expected_revision:receipt.committed_revision,..context.clone()};
            let error=native.import_server(&large_context,definition.clone(),credentials.clone(),object("native_large"),"Large",|done,_|{if done>0 {cancelled.set(true);}},||cancelled.get()).unwrap_err();
            assert!(matches!(error,AppError::Cancelled(_)));assert!(cancelled.get());assert_eq!(db.committed_revision().unwrap(),receipt.committed_revision);assert_eq!(db.with_reader(opened.epoch,|engine|engine.list_datasets()).unwrap().len(),1);
            let large=native.import_server(&large_context,definition,credentials,object("native_large"),"Large",|_,_|{},||false).unwrap();assert_eq!(large.value.total_rows_written,10000);
            native.close(opened.epoch).unwrap();let reopened=native.open(&path,true).unwrap();verify(reopened.epoch);assert_eq!(native.database(reopened.epoch).unwrap().with_reader(reopened.epoch,|engine|engine.list_datasets()).unwrap().len(),2);native.close(reopened.epoch).unwrap();
        }
    }
}

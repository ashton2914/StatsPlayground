//! JSON-lines fixture exercising the installed native session from frontend tests.
//! Compiled only with both the persistence and explicit harness features.
use std::io::{BufRead, Write};
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::{
    CatalogPageRequest, ProjectRecordPatch, ProjectWriteContext,
};
use crate::models::table::{CellPosition, CellUpdate};
use crate::services::project_catalog::ProjectCatalog;
use crate::services::project_database::ProjectDatabase;
use crate::services::project_native_service::NativeProjectService;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(tag = "command", rename_all_fields = "camelCase")]
enum Mutation {
    #[serde(rename="run_workflow")]
    RunWorkflow {request:crate::services::workflow_executor::WorkflowRunRequest,folder:String},
    #[serde(rename="materialize_tabulate_table")]
    MaterializeTabulate {request:crate::models::tabulate::TabulateMaterializeRequest},
    #[serde(rename="save_fit_model_columns")]
    SaveFitColumns {request:crate::models::fit_model::SaveFitModelColumnsRequest},
    #[serde(rename="capture_project_data_snapshot")]
    CaptureDataSnapshot {id:String,name:String,created_at:String},
    #[serde(rename="restore_project_data_snapshot")]
    RestoreDataSnapshot {id:String,expected_revision:u64},
    #[serde(rename="delete_project_data_snapshot")]
    DeleteDataSnapshot {id:String,expected_revision:u64},
    #[serde(rename="add_rows")]
    AddRows {dataset_id:String,count:usize,before_row_id:Option<i64>,expected_generation:u64},
    #[serde(rename="paste_at_position_with_change_set")]
    Paste {dataset_id:String,start_row:usize,start_col:usize,rows:Vec<Vec<String>>,header_names:Option<Vec<String>>,col_types:Vec<String>,expected_generation:u64,row_ids:Option<Vec<i64>>,column_ids:Vec<String>},
    #[serde(rename="apply_project_table_lifecycle")]
    ReplayLifecycle {event_id:String,event_revision:u64,undo:bool},
    #[serde(rename="delete_dataset")]
    DeleteDataset {dataset_id:String},
    #[serde(rename="alter_column_with_change_set")]
    AlterColumn {dataset_id:String,old_name:String,new_name:String,new_type:String,expected_generation:u64},
    #[serde(rename="alter_columns_type_with_change_set")]
    AlterTypes {dataset_id:String,column_names:Vec<String>,new_type:String,expected_generation:u64},
    #[serde(rename="upsert_calculated_column")]
    UpsertCalculated {request:crate::models::calculated_column::UpsertCalculatedColumnRequest},
    #[serde(rename="convert_calculated_column_to_values")]
    ConvertCalculated {dataset_id:String,column_id:String,expected_generation:u64},
    #[serde(rename = "reorder_column_if_generation")]
    ReorderColumns {dataset_id:String,from:i32,to:i32,expected_generation:u64},
    #[serde(rename = "delete_columns_with_change_set")]
    DeleteColumns {dataset_id:String,columns:Vec<crate::models::table::ColumnDescriptor>,expected_generation:u64},
    #[serde(rename = "add_columns_with_change_set")]
    AddColumns {
        dataset_id: String,
        columns: Vec<crate::models::table::ColumnDescriptor>,
        at_index: Option<i32>,
        expected_generation: u64,
    },
    #[serde(rename = "create_managed_table")]
    CreateManagedTable {
        request: crate::models::table::CreateManagedTableRequest,
    },
    #[serde(rename = "create_table_from_rows")]
    CreateTableFromRows {
        request: crate::models::table::CreateTableFromRowsRequest,
    },
    #[serde(rename = "set_column_display_props")]
    SetDisplay {
        dataset_id: String,
        column_ids: Vec<String>,
        props: Vec<crate::models::table::ColumnDisplayProps>,
    },
    #[serde(rename = "rename_dataset")]
    RenameDataset {
        dataset_id: String,
        new_name: String,
    },
    #[serde(rename = "import_selected_sqlite")]
    ImportSqlite {
        file_path: String,
        selections: Vec<crate::models::data_link::SqliteImportSelection>,
    },
    #[serde(rename = "create_table_transform")]
    CreateTransform {
        draft: crate::services::table_transform_domain::TableTransformDraft,
        input_bindings: Vec<crate::services::table_transform_service::TableTransformInputBinding>,
    },
    #[serde(rename = "run_table_transform")]
    RunTransform {
        definition:crate::services::table_transform_domain::TableTransformDefinition,
        binding:crate::services::table_transform_service::TableTransformProjectBinding,
    },
    #[serde(rename = "rebind_table_transform")]
    RebindTransform {
        definition:crate::services::table_transform_domain::TableTransformDefinition,
        binding:crate::services::table_transform_service::TableTransformProjectBinding,
        input_bindings:Vec<crate::services::table_transform_service::TableTransformInputBinding>,
    },
    #[serde(rename = "import_table")]
    ImportTable {file_path:String},
    #[serde(rename = "import_file")]
    ImportFile { file_path: String },
    #[serde(rename = "update_cells")]
    UpdateCells {
        dataset_id: String,
        updates: Vec<CellUpdate>,
        expected_generation: Option<u64>,
    },
    #[serde(rename = "clear_cells")]
    ClearCells {
        dataset_id: String,
        cells: Vec<CellPosition>,
    },
    #[serde(rename = "apply_table_change_set")]
    Replay {
        dataset_id: String,
        change_set_id: String,
        undo: bool,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Resolve {context:ProjectWriteContext},
    Header,
    Export {epoch:u64,kind:String,request:Value},
    Open {file_path:String,read_only:bool},
    MigrationPreflight {source_path:String,destination_path:Option<String>},
    Migrate {source_path:String,destination_path:String,migration_id:String},
    Close {epoch:u64},
    Checkpoint {epoch:u64,expected_revision:u64},
    TableLifecycleEvent {event_id:String},
    HistoryFrontier {undo:bool},
    ProjectSetting {
        key: String,
    },
    Catalog {
        #[serde(default)]
        page: CatalogPageRequest,
    },
    Document {
        document_id: String,
        revision: u64,
    },
    Setting {
        key: String,
    },
    Datasets,
    TableWindow {request:crate::models::table::TableWindowRequest},
    Display {
        dataset_id: String,
    },
    Columns {
        dataset_id: String,
    },
    WorkflowRunState {workflow_id:String,workflow_revision:u64},
    TabulatePrepare {definition:crate::models::tabulate::TabulateSessionRequest},
    TabulateStatus {session_id:String},
    TabulateRelease {session_id:String},
    DataSnapshots {after:Option<String>,limit:usize},
    Commit {
        context: ProjectWriteContext,
        patch: ProjectRecordPatch,
    },
    Mutation {
        context: ProjectWriteContext,
        operation: Mutation,
    },
    Generation {
        dataset_id: String,
    },
    FirstValue {
        dataset_id: String,
        column_name:Option<String>,
    },
    Reopen,
}

fn encode(value: impl serde::Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|error| AppError::InvalidParam(error.to_string()))
}

fn dispatch(
    state: &mut AppState,
    epoch: &mut u64,
    request: Request,
) -> Result<Value, AppError> {
    match request {
        Request::Export{epoch,kind,request}=>{
            let _lease=crate::services::project_export::acquire_export_project(state,Some(epoch))?;
            let path=request.get(if kind=="export_table"{"filePath"}else{"outputPath"}).and_then(Value::as_str).ok_or_else(||AppError::InvalidParam("export path required".into()))?;
            let ids:Option<Vec<String>>=serde_json::from_value(request.get("datasetIds").cloned().unwrap_or(Value::Null)).map_err(|error|AppError::InvalidParam(error.to_string()))?;
            let mapping=|key:&str|->Result<std::collections::HashMap<String,String>,AppError>{serde_json::from_value::<Option<std::collections::HashMap<String,String>>>(request.get(key).cloned().unwrap_or(Value::Null)).map(|value|value.unwrap_or_default()).map_err(|error|AppError::InvalidParam(error.to_string()))};
            let dataset=||request.get("datasetId").and_then(Value::as_str).ok_or_else(||AppError::InvalidParam("export dataset required".into()));
            let io=crate::services::io_service::IoService::new(state);
            match kind.as_str() {
                "export_csv"=>io.export_csv(dataset()?,path)?,
                "export_sqlite"=>io.export_sqlite(path)?,
                "export_sqlite_subset"=>io.export_sqlite_subset(path,ids.as_deref(),&mapping("nameOverrides")?)?,
                "export_csv_zip"=>io.export_csv_zip(path)?,
                "export_csv_zip_subset"=>io.export_csv_zip_subset(path,ids.as_deref(),&mapping("archivePaths")?)?,
                "export_table"=>crate::services::project_service::ProjectService::new(state).export_table(dataset()?,path)?,
                "export_tables_sptb_zip"=>crate::services::project_service::ProjectService::new(state).export_tables_sptb_zip(ids.as_deref().ok_or_else(||AppError::InvalidParam("export datasets required".into()))?,&mapping("archivePaths")?,path)?,
                _=>return Err(AppError::InvalidParam("unknown export kind".into())),
            }
            Ok(Value::Null)
        },
        Request::MigrationPreflight{source_path,destination_path}=>encode(crate::services::project_migration::ProjectMigrationService::preflight(Path::new(&source_path),destination_path.as_deref().map(Path::new))?),
        Request::Migrate{source_path,destination_path,migration_id}=>{
            let outcome=crate::commands::project_commands::migrate_project_v5_entry(state,&source_path,&destination_path,&migration_id,&|_,_,_,_,_|{})?;
            if let Some(summary)=outcome.active.as_ref() {*epoch=summary.epoch;}
            encode(outcome)
        },
        Request::Open{file_path,read_only}=>{
            let summary=NativeProjectService::new(state).open(Path::new(&file_path),read_only)?;
            *epoch=summary.epoch;encode(summary)
        },
        Request::Checkpoint{epoch,expected_revision}=>encode(NativeProjectService::new(state).checkpoint(epoch,expected_revision)?),
        Request::Close{epoch}=>encode(NativeProjectService::new(state).close(epoch)?),
        Request::DataSnapshots {after,limit}=>encode(NativeProjectService::new(state).database(*epoch)?.list_data_snapshots(*epoch,after.as_deref(),limit)?),
        Request::ProjectSetting { key } => {
            encode(NativeProjectService::new(state).get_setting(*epoch, &key)?)
        }
        Request::Resolve {context}=>encode(NativeProjectService::new(state).resolve_operation(&context)?),
        Request::HistoryFrontier{undo}=>encode(NativeProjectService::new(state).history_frontier(*epoch,None,undo)?),
        Request::TableLifecycleEvent{event_id}=>encode(NativeProjectService::new(state).table_lifecycle_event(*epoch,&event_id)?),
        Request::Header => {
            let database = NativeProjectService::new(state).database(*epoch)?;
            Ok(json!({ "header": database.header()?, "epoch": *epoch }))
        }
        Request::Catalog { page } => {
            encode(NativeProjectService::new(state).list_catalog(*epoch, &page)?)
        }
        Request::Document {
            document_id,
            revision,
        } => {
            encode(NativeProjectService::new(state).get_document(*epoch, &document_id, revision)?)
        }
        Request::WorkflowRunState{workflow_id,workflow_revision}=>encode(NativeProjectService::new(state).workflow_run_state(*epoch,&workflow_id,workflow_revision)?),
        Request::TabulatePrepare{definition}=>encode(state.tabulate_sessions.read().map_err(|e|AppError::Database(e.to_string()))?.prepare(&definition)?),
        Request::TabulateStatus{session_id}=>encode(state.tabulate_sessions.read().map_err(|e|AppError::Database(e.to_string()))?.status(&session_id)?),
        Request::TabulateRelease{session_id}=>encode(state.tabulate_sessions.read().map_err(|e|AppError::Database(e.to_string()))?.release(&session_id)?),
        Request::Columns { dataset_id } => NativeProjectService::new(state)
            .database(*epoch)?
            .with_reader(*epoch, |engine| {
                encode(engine.get_table_column_descriptors(&dataset_id)?)
            }),
        Request::TableWindow{request}=>encode(crate::commands::data_commands::query_table_window_entry(state,&request)?),
        Request::Datasets => NativeProjectService::new(state)
            .database(*epoch)?
            .with_reader(*epoch, |engine| encode(engine.list_datasets()?)),
        Request::Display { dataset_id } => {
            encode(NativeProjectService::new(state).column_display_props(*epoch, &dataset_id)?)
        }
        Request::Setting { key } => NativeProjectService::new(state)
            .database(*epoch)?
            .with_reader(*epoch, |engine| {
                encode(ProjectCatalog::new(engine).get_setting(&key)?)
            }),
        Request::Commit { context, patch } => {
            encode(NativeProjectService::new(state).commit_records(&context, &patch)?)
        }
        Request::Mutation { context, operation } => {
            let service = NativeProjectService::new(state);
            match operation {
                Mutation::RunWorkflow{request,folder}=>encode(service.run_workflow(&context,&request,&folder)?),
                Mutation::MaterializeTabulate{request}=>encode(service.materialize_tabulate(&context,&request)?),
                Mutation::SaveFitColumns{request}=>encode(service.save_fit_model_columns(&context,&request)?),
                Mutation::CaptureDataSnapshot {id,name,created_at}=>encode(service.database(context.expected_epoch)?.capture_data_snapshot(&context,&id,&name,&created_at)?),
                Mutation::RestoreDataSnapshot {id,expected_revision}=>encode(service.database(context.expected_epoch)?.restore_data_snapshot(&context,&id,expected_revision)?),
                Mutation::DeleteDataSnapshot {id,expected_revision}=>encode(service.database(context.expected_epoch)?.delete_data_snapshot(&context,&id,expected_revision)?),
                Mutation::AddRows{dataset_id,count,before_row_id,expected_generation}=>encode(service.add_rows(&context,&dataset_id,count,before_row_id,expected_generation)?),
                Mutation::Paste{dataset_id,start_row,start_col,rows,header_names,col_types,expected_generation,row_ids,column_ids}=>encode(service.paste(&context,&crate::models::project_persistence::ProjectPasteRequest{dataset_id,start_row,start_col,rows,header_names,col_types,expected_generation,row_ids,column_ids})?),
                Mutation::ReplayLifecycle {event_id,event_revision,undo}=>encode(service.apply_table_lifecycle(&context,&event_id,event_revision,undo)?),
                Mutation::ImportTable {file_path}=>encode(service.import_sptb(&context,&file_path,||false)?),
                Mutation::DeleteDataset {dataset_id}=>encode(service.delete_dataset(&context,&dataset_id)?),
                Mutation::AlterColumn {dataset_id,old_name,new_name,new_type,expected_generation}=>encode(service.alter_column(&context,&dataset_id,&old_name,&new_name,&new_type,expected_generation)?),
                Mutation::AlterTypes {dataset_id,column_names,new_type,expected_generation}=>encode(service.alter_column_types(&context,&dataset_id,&column_names,&new_type,expected_generation)?),
                Mutation::UpsertCalculated {request}=>encode(service.upsert_calculated_column(&context,&crate::services::calculated_column_service::UpsertCalculatedColumnInput {dataset_id:request.dataset_id,output_name:request.output_name,formula_text:request.formula_text,at_index:request.at_index,output_column_id:request.output_column_id,formula_id:request.formula_id,expected_generation:request.expected_generation})?),
                Mutation::ConvertCalculated {dataset_id,column_id,expected_generation}=>encode(service.convert_calculated_column_to_values(&context,&dataset_id,&column_id,expected_generation)?),
                Mutation::ReorderColumns {dataset_id,from,to,expected_generation}=>encode(service.reorder_columns(&context,&dataset_id,from,to,expected_generation)?),
                Mutation::DeleteColumns {dataset_id,columns,expected_generation}=>encode(service.delete_columns(&context,&dataset_id,&columns,expected_generation)?),
                Mutation::AddColumns {dataset_id,columns,at_index,expected_generation}=>encode(service.add_columns(&context,&dataset_id,&columns,at_index,expected_generation)?),
                Mutation::CreateManagedTable { request } => {
                    encode(service.create_managed_table(&context, &request)?)
                }
                Mutation::CreateTableFromRows { request } => {
                    encode(service.create_table_from_rows(&context, &request)?)
                }
                Mutation::SetDisplay {
                    dataset_id,
                    column_ids,
                    props,
                } => encode(service.set_column_display_props(
                    &context,
                    &dataset_id,
                    &column_ids,
                    &props,
                )?),
                Mutation::RenameDataset {
                    dataset_id,
                    new_name,
                } => encode(service.rename_dataset(&context, &dataset_id, &new_name)?),
                Mutation::ImportSqlite {
                    file_path,
                    selections,
                } => encode(service.import_sqlite(
                    &context,
                    &file_path,
                    &selections,
                    |_, _, _, _, _| {},
                    || false,
                )?),
                Mutation::RunTransform{definition,binding}=>encode(NativeProjectService::new(state).run_transform(&context,&definition,&binding,None)?),
                Mutation::RebindTransform{definition,binding,input_bindings}=>encode(NativeProjectService::new(state).run_transform(&context,&definition,&binding,Some(&input_bindings))?),
                Mutation::CreateTransform {
                    draft,
                    input_bindings,
                } => encode(service.create_transform(&context, &draft, &input_bindings)?),
                Mutation::ImportFile { file_path } => {
                    encode(service.import_file(&context, &file_path)?)
                }
                Mutation::UpdateCells {
                    dataset_id,
                    updates,
                    expected_generation,
                } => encode(service.update_cells(
                    &context,
                    &dataset_id,
                    &updates,
                    expected_generation,
                )?),
                Mutation::ClearCells { dataset_id, cells } => {
                    encode(service.clear_cells(&context, &dataset_id, &cells)?)
                }
                Mutation::Replay {
                    dataset_id,
                    change_set_id,
                    undo,
                } => {
                    encode(service.apply_change_set(&context, &dataset_id, &change_set_id, undo)?)
                }
            }
        }
        Request::Generation { dataset_id } => NativeProjectService::new(state)
            .database(*epoch)?
            .with_reader(*epoch, |engine| {
                encode(engine.get_dataset_generation(&dataset_id)?)
            }),
        Request::FirstValue { dataset_id,column_name } => NativeProjectService::new(state)
            .database(*epoch)?
            .with_reader(*epoch, |engine| {
                let table =
                    DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset_id));
                let column=column_name.unwrap_or_else(||"value".into());
                if !engine.get_user_columns(&dataset_id)?.iter().any(|(name,_)|name==&column) {return Err(AppError::InvalidParam("unknown fixture column".into()));}
                let column=DuckDbEngine::quote_identifier(&column);
                let (row_id, value): (i64, Option<f64>) = engine.conn().query_row(
                    &format!("SELECT _row_id,CAST({column} AS DOUBLE) FROM {table} ORDER BY _row_id LIMIT 1"),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok(json!({ "rowId":row_id,"value":value }))
            }),
        Request::Reopen => {
            let path=NativeProjectService::new(state).database(*epoch)?.path().to_owned();
            let previous = std::mem::replace(state, AppState::new()?);
            drop(previous);
            let summary = NativeProjectService::new(state).open(&path, false)?;
            *epoch = summary.epoch;
            encode(summary)
        }
    }
}

pub fn serve(path: &Path) -> Result<(), String> {
    if !path.exists() {
        let created = ProjectDatabase::create(path, false).map_err(|error| error.to_string())?;
        created.shutdown().map_err(|error| error.to_string())?;
    }
    let mut state = AppState::new().map_err(|error| error.to_string())?;
    let mut epoch = NativeProjectService::new(&state)
        .open(path, false)
        .map_err(|error| error.to_string())?
        .epoch;
    let input = std::io::stdin();
    let mut output = std::io::stdout().lock();
    for line in input.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        let envelope: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        let id = envelope.get("id").cloned().unwrap_or(Value::Null);
        let result = serde_json::from_value::<Request>(envelope)
            .map_err(|error| AppError::InvalidParam(error.to_string()))
            .and_then(|request| dispatch(&mut state, &mut epoch, request));
        let response = match result {
            Ok(value) => json!({ "id": id, "ok": value }),
            Err(error) => json!({ "id": id, "error": error.to_string() }),
        };
        writeln!(output, "{response}").map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
    }
    NativeProjectService::new(&state)
        .database(epoch)
        .map_err(|error| error.to_string())?
        .shutdown()
        .map_err(|error| error.to_string())
}

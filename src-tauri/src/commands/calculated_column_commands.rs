use tauri::{Emitter,State};
use crate::models::project_persistence::{ProjectWriteContext,ProjectMutationResult};

use crate::commands::data_commands::acquire_mutation_permit;
use crate::error::AppError;
use crate::models::calculated_column::{
    CalculatedColumnDescriptor, CalculatedColumnMutationResult, CalculatedColumnValidation,
    UpsertCalculatedColumnRequest, ValidateCalculatedColumnRequest,
};
use crate::services::calculated_column_service::{
    CalculatedColumnService, ConvertCalculatedColumnToValuesInput, UpsertCalculatedColumnInput,
};
use crate::services::data_service::DataService;
use crate::state::AppState;

fn map_request(request: &ValidateCalculatedColumnRequest) -> UpsertCalculatedColumnInput {
    UpsertCalculatedColumnInput {
        dataset_id: request.dataset_id.clone(),
        output_name: request.output_name.clone(),
        formula_text: request.formula_text.clone(),
        at_index: request.at_index,
        output_column_id: request.output_column_id.clone(),
        formula_id: request.formula_id.clone(),
        expected_generation: request.expected_generation,
    }
}

fn map_upsert_request(request: &UpsertCalculatedColumnRequest) -> UpsertCalculatedColumnInput {
    UpsertCalculatedColumnInput {
        dataset_id: request.dataset_id.clone(),
        output_name: request.output_name.clone(),
        formula_text: request.formula_text.clone(),
        at_index: request.at_index,
        output_column_id: request.output_column_id.clone(),
        formula_id: request.formula_id.clone(),
        expected_generation: request.expected_generation,
    }
}

fn resolve_calculated_descriptor(
    state: &AppState,
    dataset_id: &str,
    column_id: &str,
) -> Result<CalculatedColumnDescriptor, AppError> {
    DataService::new(state)
        .get_column_descriptors(dataset_id)?
        .into_iter()
        .find(|descriptor| descriptor.column_id == column_id)
        .and_then(|descriptor| descriptor.calculated)
        .ok_or_else(|| AppError::InvalidParam(format!("unknown calculated column id: {column_id}")))
}

#[tauri::command]
pub fn validate_calculated_column(
    state: State<'_, AppState>,
    request: ValidateCalculatedColumnRequest,
) -> Result<CalculatedColumnValidation, AppError> {
    let service = CalculatedColumnService::new(&state);
    service.validate(&map_request(&request))
}

#[tauri::command(async)]
pub fn upsert_calculated_column(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    request: UpsertCalculatedColumnRequest,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<CalculatedColumnMutationResult>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).upsert_calculated_column(&context,&map_upsert_request(&request))?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = CalculatedColumnService::new(&state);
    service.upsert(&map_upsert_request(&request)).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn convert_calculated_column_to_values(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    column_id: String,
    expected_generation: u64,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<CalculatedColumnMutationResult>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).convert_calculated_column_to_values(&context,&dataset_id,&column_id,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let descriptor = resolve_calculated_descriptor(state.inner(), &dataset_id, &column_id)?;
    let service = CalculatedColumnService::new(&state);
    let (output_column_id, dataset_generation, change_set_id) =
        service.convert_to_values(&ConvertCalculatedColumnToValuesInput {
            dataset_id,
            formula_id: descriptor.formula_id.clone(),
            expected_generation: Some(expected_generation),
        })?;
    Ok(ProjectMutationResult::Legacy(CalculatedColumnMutationResult {
        column_id: output_column_id,
        dataset_generation,
        change_set_id,
        calculated: None,
        diagnostics: Vec::new(),
        warning_count: Default::default(),
    }))
}

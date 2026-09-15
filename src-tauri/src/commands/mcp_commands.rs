use tauri::State;

use crate::error::AppError;
use crate::models::mcp::{McpAuditEntry, McpBrokerCompletion, McpBrokerUpdate, McpServerStatus};
use crate::state::AppState;

#[tauri::command(async)]
pub async fn start_mcp_server(state: State<'_, AppState>) -> Result<McpServerStatus, AppError> {
    state
        .mcp_server
        .start(state.mcp_command_broker.clone())
        .await
}

#[tauri::command(async)]
pub async fn stop_mcp_server(state: State<'_, AppState>) -> Result<(), AppError> {
    state.mcp_server.stop().await
}

#[tauri::command]
pub fn get_mcp_server_status(state: State<'_, AppState>) -> Result<McpServerStatus, AppError> {
    state.mcp_server.status()
}

#[tauri::command]
pub fn list_mcp_audit_entries(state: State<'_, AppState>) -> Result<Vec<McpAuditEntry>, AppError> {
    state.mcp_server.audit_entries()
}

#[tauri::command]
pub fn register_application_command_dispatcher(state: State<'_, AppState>) -> Result<(), AppError> {
    state.mcp_command_broker.register_dispatcher()
}

#[tauri::command]
pub fn complete_application_command(
    state: State<'_, AppState>,
    update: McpBrokerUpdate,
) -> Result<bool, AppError> {
    match update.into_progress_or_completion() {
        Ok(progress) => state.mcp_command_broker.record_progress(progress),
        Err(McpBrokerCompletion {
            request_id,
            response,
        }) => state
            .mcp_command_broker
            .complete_application_command(McpBrokerCompletion {
                request_id,
                response,
            }),
    }
}

#[tauri::command]
pub fn unregister_application_command_dispatcher(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.mcp_command_broker.unregister_dispatcher()
}

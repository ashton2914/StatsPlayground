use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::AppError;
use crate::models::graph_new::{
    GraphNewTransportProbeCompletion, GraphNewTransportProbeRequest, GraphNewRenderRequest, GraphNewRenderCompletion,
};
use crate::services::graph_new_transport_service::GraphNewTransportService;
use crate::services::graph_new_service::GraphNewService;
use crate::state::AppState;

#[tauri::command(async)]
pub fn render_graph_new(
    state: tauri::State<'_, AppState>,
    request: GraphNewRenderRequest,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<GraphNewRenderCompletion, AppError> {
    GraphNewService::new(&state).render(&request, &on_frame)
}

#[tauri::command(async)]
pub fn cancel_graph_new(state: tauri::State<'_, AppState>, session_id: String, request_id: String, renderer_generation: u64, preserve_cache: Option<bool>) -> Result<(), AppError> {
    if preserve_cache.unwrap_or(false) {
        state.graph_new.cancel_request_with_cache(&session_id, &request_id, renderer_generation, true)
    } else {
        state.graph_new.cancel_request(&session_id, &request_id, renderer_generation)
    }
}

#[tauri::command(async)]
pub fn close_graph_new(state: tauri::State<'_, AppState>, session_id: String, renderer_generation: u64) -> Result<(), AppError> {
    state.graph_new.close_session(&session_id, renderer_generation)
}

#[tauri::command(async)]
pub fn probe_graph_new_transport(
    request: GraphNewTransportProbeRequest,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<GraphNewTransportProbeCompletion, AppError> {
    let service = GraphNewTransportService::new();
    service.probe(&request, &on_frame)
}

#[cfg(test)]
mod tests {
    #[test]
    fn probe_command_is_async_and_delegates_to_the_service() {
        let source = include_str!("graph_new_commands.rs");
        let function_start = source
            .find(concat!("pub fn probe_graph_new_", "transport("))
            .expect("probe command must exist");
        let before_function = &source[..function_start];
        let function_body = &source[function_start..];

        assert!(before_function
            .trim_end()
            .ends_with(concat!("#[tauri::command", "(async)]")));
        assert!(function_body.contains(concat!("GraphNewTransport", "Service::new()")));
        assert!(function_body.contains(concat!("service.probe", "(&request, &on_frame)")));
    }
}
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};

use crate::error::AppError;
use crate::models::graph_data::{GraphDataCompletion, GraphDataRequest};
use crate::services::graph_data_service::GraphDataService;
use crate::state::AppState;

#[tauri::command(async)]
pub fn stream_graph_data(
    state: State<'_, AppState>,
    request: GraphDataRequest,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<GraphDataCompletion, AppError> {
    let service = GraphDataService::new(&state);
    service.stream(&request, &on_chunk)
}

#[tauri::command]
pub fn cancel_graph_data(state: State<'_, AppState>, request_id: String) -> Result<(), AppError> {
    let service = GraphDataService::new(&state);
    service.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn stream_command_is_marked_async() {
        let source = include_str!("graph_data_commands.rs");
        let stream_start = source
            .find("pub fn stream_graph_data(")
            .expect("stream_graph_data command must exist");
        let command_attribute = &source[..stream_start];

        assert!(
            command_attribute
                .trim_end()
                .ends_with("#[tauri::command(async)]"),
            "stream_graph_data must use async command scheduling"
        );
    }
}

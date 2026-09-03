use crate::error::AppError;
use crate::models::fit_model::{FitModelRequest, FitModelResult};
use crate::services::fit_model_service::FitModelService;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn fit_model(
    state: State<'_, AppState>,
    request: FitModelRequest,
) -> Result<FitModelResult, AppError> {
    FitModelService::new(&state).run(request)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::models::fit_model::{
        FitModelCenteringMethod, FitModelNotComputableReason, FitModelNotComputableResult,
        FitModelRequest, FitModelResult, FitModelTerm, FitModelTermKind,
    };

    use super::fit_model;

    #[test]
    fn command_signature_is_request_to_result_delegate() {
        let source = include_str!("fit_model_commands.rs");
        let start = source
            .find("pub fn fit_model(")
            .expect("fit_model command must exist");
        let signature = &source[start
            ..source[start..]
                .find(") ->")
                .map(|offset| start + offset + 1)
                .expect("fit_model command signature must include return type")];

        assert!(signature.contains("state: State<'_, AppState>"));
        assert!(signature.contains("request: FitModelRequest"));
        assert!(source.contains("FitModelService::new(&state).run(request)"));
    }

    #[test]
    fn request_and_result_use_camel_case_ipc_shape() {
        let _command = fit_model;
        let request: FitModelRequest = serde_json::from_value(json!({
            "datasetId": "ds1",
            "generation": 7,
            "responseColumn": "Y",
            "terms": [
                { "kind": "main", "columnNames": ["A"] },
                { "kind": "main", "columnNames": ["B"] },
                { "kind": "interaction", "columnNames": ["A", "B"] }
            ],
            "centeringMethod": "mean",
            "confidenceLevel": 0.95
        }))
        .expect("request should deserialize");

        assert_eq!(request.generation, 7);
        assert_eq!(request.centering_method, FitModelCenteringMethod::Mean);
        assert_eq!(
            request.terms[2],
            FitModelTerm {
                kind: FitModelTermKind::Interaction,
                column_names: vec!["A".into(), "B".into()],
                exponent: None,
            }
        );

        let value = serde_json::to_value(FitModelResult::NotComputable(FitModelNotComputableResult {
            reason: FitModelNotComputableReason::InsufficientRows,
            used_rows: 2,
            excluded_rows: 4,
        }))
        .expect("response should serialize");

        assert_eq!(value["kind"], "notComputable");
        assert_eq!(value["usedRows"], 2);
        assert_eq!(value["excludedRows"], 4);
        assert_eq!(value["reason"], "insufficientRows");
    }

    #[test]
    fn lib_registers_fit_model_command() {
        let source = include_str!("../lib.rs");
        assert!(
            source.contains("commands::fit_model_commands::fit_model,"),
            "lib.rs must register fit_model command in generate_handler"
        );
    }
}

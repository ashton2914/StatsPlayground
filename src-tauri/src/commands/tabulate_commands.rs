use tauri::State;

use crate::error::AppError;
use crate::models::tabulate::{
    TabulateRequest, TabulateResult, TabulateSessionRequest, TabulateSessionStatus,
};
use crate::services::tabulate_service::TabulateService;
use crate::state::AppState;

#[tauri::command]
pub fn tabulate(
    state: State<'_, AppState>,
    request: TabulateRequest,
) -> Result<TabulateResult, AppError> {
    TabulateService::new(&state).run(request)
}

#[tauri::command]
pub fn prepare_tabulate_session(
    state: State<'_, AppState>,
    request: TabulateSessionRequest,
) -> Result<TabulateSessionStatus, AppError> {
    let service = state
        .tabulate_sessions
        .read()
        .map_err(|error| AppError::Database(error.to_string()))?
        .clone();
    service.prepare(&request)
}

#[tauri::command]
pub fn get_tabulate_session_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<TabulateSessionStatus, AppError> {
    let service = state
        .tabulate_sessions
        .read()
        .map_err(|error| AppError::Database(error.to_string()))?
        .clone();
    service.status(&session_id)
}

#[tauri::command]
pub fn release_tabulate_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let service = state
        .tabulate_sessions
        .read()
        .map_err(|error| AppError::Database(error.to_string()))?
        .clone();
    service.release(&session_id)
}

#[cfg(test)]
mod tests {
    use crate::models::tabulate::{
        StatisticKind, TabulateMaterializeRequest, TabulateRequest, TabulateResult,
        TabulateSessionRequest, TabulateSessionState, TabulateSparseCell,
        TabulateSparseTotal, TabulateStatistic, TabulateTotalsKind, TabulateTotalsResult,
        TabulateWindowResult,
    };

    #[test]
    fn tabulate_session_contract_serializes_bounded_camel_case_values() {
        let request = TabulateSessionRequest {
            dataset_id: "dataset-1".into(),
            source_generation: 7,
            row_fields: vec!["region".into()],
            column_fields: vec!["product".into()],
            statistics: vec![TabulateStatistic {
                id: "mean-sales".into(),
                field: "sales".into(),
                kind: StatisticKind::Mean,
                quantile: None,
            }],
            include_row_totals: true,
            include_column_totals: true,
        };

        let request_json = serde_json::to_value(request).expect("serialize request");
        assert_eq!(request_json["sourceGeneration"], 7);
        assert!(request_json.get("maxResultCells").is_none());
        assert_eq!(
            serde_json::to_value(TabulateSessionState::Ready).expect("serialize state"),
            "ready"
        );

        let cell = TabulateSparseCell {
            row_index: 2,
            column_index: 3,
            statistic_index: 1,
            value: Some(4.5),
        };
        let cell_json = serde_json::to_value(cell).expect("serialize sparse cell");
        assert_eq!(cell_json["rowIndex"], 2);
        assert_eq!(cell_json["columnIndex"], 3);
        assert_eq!(cell_json["statisticIndex"], 1);

        let window = TabulateWindowResult {
            session_id: "session-1".into(),
            request_id: "request-1".into(),
            fingerprint: "fingerprint-1".into(),
            source_generation: 7,
            row_start: 10,
            column_start: 20,
            row_members: vec![vec![serde_json::json!("East")]],
            column_members: vec![vec![serde_json::json!("A")]],
            row_member_before: None,
            row_member_after: None,
            column_member_before: None,
            column_member_after: None,
            statistics: vec![],
            cells: vec![],
            row_totals_ready: true,
            column_totals_ready: false,
            row_member_count: 1_000,
            column_member_count: 2_000,
        };
        let window_json = serde_json::to_value(window).expect("serialize window");
        assert_eq!(window_json["rowStart"], 10);
        assert_eq!(window_json["columnStart"], 20);
        assert_eq!(window_json["rowMemberCount"], 1_000);
        assert_eq!(window_json["columnMemberCount"], 2_000);

        let totals = TabulateTotalsResult {
            session_id: "session-1".into(),
            request_id: "request-2".into(),
            fingerprint: "fingerprint-1".into(),
            source_generation: 7,
            totals: TabulateTotalsKind::Rows {
                start: 10,
                count: 2,
            },
            row_totals: vec![TabulateSparseTotal {
                member_index: 0,
                statistic_index: 1,
                value: Some(4.5),
            }],
            column_totals: vec![],
            grand_totals: vec![],
        };
        let totals_json = serde_json::to_value(totals).expect("serialize totals");
        assert_eq!(totals_json["totals"]["kind"], "rows");
        assert_eq!(totals_json["totals"]["start"], 10);
        assert_eq!(totals_json["rowTotals"][0]["memberIndex"], 0);

        let materialize = TabulateMaterializeRequest {
            session_id: "session-1".into(),
            source_generation: 7,
            fingerprint: "fingerprint-1".into(),
            destination_name: "Sales Summary".into(),
        };
        let materialize_json =
            serde_json::to_value(materialize).expect("serialize materialize request");
        assert_eq!(materialize_json["destinationName"], "Sales Summary");
    }

    #[test]
    fn tabulate_contract_serializes_camel_case_fields_and_enum_values() {
        let request = TabulateRequest {
            dataset_id: "dataset-1".into(),
            row_fields: vec!["region".into()],
            column_fields: vec!["product".into()],
            statistics: vec![TabulateStatistic {
                id: "std-dev-sales".into(),
                field: "sales".into(),
                kind: StatisticKind::StandardDeviation,
                quantile: None,
            }],
            include_row_totals: true,
            include_column_totals: false,
            max_result_cells: 10_000,
        };

        let request_json = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(request_json["datasetId"], "dataset-1");
        assert_eq!(request_json["rowFields"][0], "region");
        assert_eq!(request_json["columnFields"][0], "product");
        assert_eq!(request_json["includeRowTotals"], true);
        assert_eq!(request_json["includeColumnTotals"], false);
        assert_eq!(request_json["maxResultCells"], 10_000);
        assert_eq!(request_json["statistics"][0]["kind"], "standardDeviation");

        let result = TabulateResult {
            row_members: vec![vec![serde_json::json!("East")]],
            column_members: vec![vec![serde_json::json!("A")]],
            statistics: vec![TabulateStatistic {
                id: "std-dev-sales".into(),
                field: "sales".into(),
                kind: StatisticKind::StandardDeviation,
                quantile: None,
            }],
            cells: vec![Some(1.5)],
            row_totals: vec![Some(1.5)],
            column_totals: vec![Some(1.5)],
            grand_totals: vec![Some(1.5)],
            cell_count: 1,
            limit: 10_000,
        };

        let result_json = serde_json::to_value(&result).expect("serialize result");
        assert_eq!(result_json["rowMembers"][0][0], "East");
        assert_eq!(result_json["columnMembers"][0][0], "A");
        assert_eq!(result_json["cells"][0], 1.5);
        assert_eq!(result_json["cellCount"], 1);
        assert_eq!(result_json["limit"], 10_000);
        assert_eq!(result_json["statistics"][0]["kind"], "standardDeviation");
    }
}

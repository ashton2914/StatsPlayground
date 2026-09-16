use serde::Deserialize;
use serde_json::Value;

use crate::models::project::ProjectInfo;
use crate::models::save::SaveProjectRequest;
use crate::models::table::{ColumnDisplayProps, CreateManagedTableRequest, TableWindowRequest};
use crate::services::data_service::DataService;
use crate::services::project_service::{OpenProjectResult, ProjectService};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityFixture {
    dataset_id_token: String,
    table_seed: CreateManagedTableRequest,
    save_payloads: ArtifactParitySavePayloads,
    nondeterministic_policy: ArtifactParityNondeterministicPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParitySavePayloads {
    ui: Value,
    mcp: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityNondeterministicPolicy {
    strip_fields: Vec<String>,
    uuid_like: String,
}

struct ReopenedStateSnapshot {
    open_result: OpenProjectResult,
    columns: Vec<(String, String)>,
    display: Vec<ColumnDisplayProps>,
    rows: Vec<Vec<Value>>,
}

fn load_fixture() -> ArtifactParityFixture {
    serde_json::from_str(include_str!(
        "../../../contracts/mcp/artifact-parity.v1.json"
    ))
    .expect("valid artifact parity fixture")
}

fn replace_string_token(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(text) => {
            if text == from {
                *text = to.to_string();
            }
        }
        Value::Array(items) => {
            for item in items {
                replace_string_token(item, from, to);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                replace_string_token(child, from, to);
            }
        }
        _ => {}
    }
}

fn seed_dataset(state: &AppState, table_seed: &CreateManagedTableRequest) -> String {
    let result = DataService::new(state)
        .create_managed_table_outcome(table_seed)
        .expect("seed managed table");
    result.dataset.id
}

fn build_save_request(
    template: &Value,
    dataset_token: &str,
    dataset_id: &str,
) -> SaveProjectRequest {
    let mut value = template.clone();
    replace_string_token(&mut value, dataset_token, dataset_id);
    serde_json::from_value(value)
        .expect("fixture save payload should deserialize to SaveProjectRequest")
}

fn build_archive_path(prefix: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "statsplayground_task12_{}_{}.spprj",
            prefix,
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string()
}

fn save_then_reopen(
    save_payload: &Value,
    table_seed: &CreateManagedTableRequest,
    dataset_token: &str,
    archive_path: &str,
) -> ReopenedStateSnapshot {
    let state = AppState::new().expect("app state");
    let dataset_id = seed_dataset(&state, table_seed);

    *state.project.write().expect("project write lock") = Some(ProjectInfo {
        name: "Task12 Artifact Parity".to_string(),
        file_path: archive_path.to_string(),
        created_at: "2026-09-16T00:00:00.000Z".to_string(),
    });

    let request = build_save_request(save_payload, dataset_token, &dataset_id);
    ProjectService::new(&state)
        .save_project(request, None)
        .expect("save project");

    let reopened_state = AppState::new().expect("reopened app state");
    let open_result = ProjectService::new(&reopened_state)
        .open_project(archive_path, None)
        .expect("reopen project");

    let data_service = DataService::new(&reopened_state);
    let datasets = data_service.list_datasets().expect("list datasets");
    assert_eq!(
        datasets.len(),
        1,
        "fixture should reopen with exactly one dataset"
    );
    let dataset = datasets[0].clone();
    let columns = data_service
        .get_columns(&dataset.id)
        .expect("fetch reopened columns");

    let table_window = data_service
        .query_table_window(&TableWindowRequest {
            dataset_id: dataset.id.clone(),
            start: 0,
            count: 100,
            sort: None,
            filters: Vec::new(),
            generation: dataset.generation,
        })
        .expect("query reopened rows");

    let display = reopened_state
        .column_display
        .lock()
        .expect("display lock")
        .get(&dataset.id)
        .cloned()
        .unwrap_or_default();

    ReopenedStateSnapshot {
        open_result,
        columns,
        display,
        rows: table_window.rows,
    }
}

fn normalize_for_comparison(mut value: Value, strip_fields: &[String], replacement: &str) -> Value {
    fn recurse(value: &mut Value, strip_fields: &[String], replacement: &str) {
        match value {
            Value::Object(map) => {
                let keys = map.keys().cloned().collect::<Vec<_>>();
                for key in keys {
                    if strip_fields.iter().any(|field| field == &key) {
                        map.remove(&key);
                        continue;
                    }
                    if let Some(child) = map.get_mut(&key) {
                        recurse(child, strip_fields, replacement);
                    }
                }
            }
            Value::Array(values) => {
                for child in values {
                    recurse(child, strip_fields, replacement);
                }
            }
            Value::String(text) => {
                if uuid::Uuid::parse_str(text).is_ok() {
                    *text = replacement.to_string();
                }
            }
            _ => {}
        }
    }

    recurse(&mut value, strip_fields, replacement);
    value
}

fn expected_display_from_seed(table_seed: &CreateManagedTableRequest) -> Vec<ColumnDisplayProps> {
    let mut expected = Vec::new();
    for (index, column) in table_seed.columns.iter().enumerate() {
        if let Some(display) = &column.display {
            expected.push(ColumnDisplayProps {
                col_index: index,
                width: display.width,
                format: display.format.clone(),
                extras: display.extras.clone(),
            });
        }
    }
    expected
}

fn normalize_rows_for_seed_comparison(
    rows: &[Vec<Value>],
    expected_business_column_count: usize,
) -> Vec<Vec<Value>> {
    rows.iter()
        .map(|row| {
            if row.len() == expected_business_column_count + 1 {
                row[1..].to_vec()
            } else {
                row.clone()
            }
        })
        .collect()
}

#[test]
fn archive_round_trip_matches_fixture_business_state_for_ui_and_mcp_save_payloads() {
    let fixture = load_fixture();
    let ui_archive = build_archive_path("ui");
    let mcp_archive = build_archive_path("mcp");

    let ui = save_then_reopen(
        &fixture.save_payloads.ui,
        &fixture.table_seed,
        &fixture.dataset_id_token,
        &ui_archive,
    );
    let mcp = save_then_reopen(
        &fixture.save_payloads.mcp,
        &fixture.table_seed,
        &fixture.dataset_id_token,
        &mcp_archive,
    );

    let expected_display = expected_display_from_seed(&fixture.table_seed);
    let expected_column_count = fixture.table_seed.columns.len();
    let ui_rows = normalize_rows_for_seed_comparison(&ui.rows, expected_column_count);
    let mcp_rows = normalize_rows_for_seed_comparison(&mcp.rows, expected_column_count);
    assert_eq!(
        ui_rows, fixture.table_seed.rows,
        "UI round-trip must preserve table row order and values"
    );
    assert_eq!(
        mcp_rows, fixture.table_seed.rows,
        "MCP round-trip must preserve table row order and values"
    );
    assert_eq!(ui.columns[0].1, "DOUBLE");
    assert_eq!(ui.columns[1].1, "VARCHAR");
    assert_eq!(mcp.columns[0].1, "DOUBLE");
    assert_eq!(mcp.columns[1].1, "VARCHAR");
    let ui_display = serde_json::to_value(&ui.display).expect("serialize UI display");
    let mcp_display = serde_json::to_value(&mcp.display).expect("serialize MCP display");
    let expected_display_value =
        serde_json::to_value(&expected_display).expect("serialize expected display");
    assert_eq!(
        ui_display, expected_display_value,
        "UI round-trip must preserve display width/format/extras"
    );
    assert_eq!(
        mcp_display, expected_display_value,
        "MCP round-trip must preserve display width/format/extras"
    );

    let ui_value = serde_json::to_value(ui.open_result).expect("serialize UI open result");
    let mcp_value = serde_json::to_value(mcp.open_result).expect("serialize MCP open result");

    let normalized_ui = normalize_for_comparison(
        ui_value,
        &fixture.nondeterministic_policy.strip_fields,
        &fixture.nondeterministic_policy.uuid_like,
    );
    let normalized_mcp = normalize_for_comparison(
        mcp_value,
        &fixture.nondeterministic_policy.strip_fields,
        &fixture.nondeterministic_policy.uuid_like,
    );

    assert_eq!(
        normalized_ui, normalized_mcp,
        "UI and MCP save/open business payloads should match after fixture-declared nondeterministic normalization"
    );

    let _ = std::fs::remove_file(ui_archive);
    let _ = std::fs::remove_file(mcp_archive);
}

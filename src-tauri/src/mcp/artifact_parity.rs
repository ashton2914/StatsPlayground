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
    canonical_save_payload: Value,
    documents: ArtifactParityFixtureDocuments,
    nondeterministic_policy: ArtifactParityNondeterministicPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityFixtureDocuments {
    table_transform: Value,
    tabulate: ArtifactParityFixtureTabulate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityFixtureTabulate {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityNondeterministicPolicy {
    strip_fields: Vec<String>,
    uuid_like: String,
}

struct ReopenedStateSnapshot {
    dataset_id: String,
    transform_output_dataset_id: Option<String>,
    open_result: OpenProjectResult,
    columns: Vec<(String, String)>,
    display: Vec<ColumnDisplayProps>,
    rows: Vec<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalOpenResultFixture {
    canonical_open_project_result: Value,
}

const CANONICAL_ARCHIVE_PATH: &str = "/tmp/task12-canonical-open.spprj";
const CANONICAL_PRIMARY_DATASET_ID: &str = "table-main";
const CANONICAL_TRANSFORM_OUTPUT_DATASET_ID: &str = "table-transform-output-1";

fn load_fixture() -> ArtifactParityFixture {
    serde_json::from_str(include_str!(
        "../../../contracts/mcp/artifact-parity.v1.json"
    ))
    .expect("valid artifact parity fixture")
}

fn load_canonical_open_result_fixture() -> CanonicalOpenResultFixture {
    serde_json::from_str(include_str!(
        "../../../contracts/mcp/artifact-parity-open-result.v1.json"
    ))
    .expect("valid artifact parity canonical open-result fixture")
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
            if let Some(child) = map.remove(from) {
                map.insert(to.to_string(), child);
            }
            for child in map.values_mut() {
                replace_string_token(child, from, to);
            }
        }
        _ => {}
    }
}

fn is_ascii_uuid_like(candidate: &str) -> bool {
    if candidate.len() != 36 {
        return false;
    }
    for (index, byte) in candidate.bytes().enumerate() {
        let is_hyphen = matches!(index, 8 | 13 | 18 | 23);
        if is_hyphen {
            if byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn replace_uuid_like_substrings(text: &str, placeholder: &str) -> String {
    if text.len() < 36 {
        return text.to_string();
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let remaining = text.len() - cursor;
        if remaining >= 36 {
            let candidate = &text[cursor..cursor + 36];
            if is_ascii_uuid_like(candidate) {
                output.push_str(placeholder);
                cursor += 36;
                continue;
            }
        }
        let ch = text[cursor..].chars().next().expect("valid utf-8");
        output.push(ch);
        cursor += ch.len_utf8();
    }
    output
}

fn normalize_open_result_nondeterminism(value: &mut Value, uuid_placeholder: &str) {
    match value {
        Value::String(text) => {
            *text = replace_uuid_like_substrings(text, uuid_placeholder);
        }
        Value::Array(items) => {
            for item in items {
                normalize_open_result_nondeterminism(item, uuid_placeholder);
            }
        }
        Value::Object(map) => {
            if let Some(graph_hash) = map.get_mut("graphHash") {
                *graph_hash = Value::String("<lineage-graph-hash>".to_string());
            }
            for child in map.values_mut() {
                normalize_open_result_nondeterminism(child, uuid_placeholder);
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
    archive_path: &str,
    transform_output_dataset_id: Option<&str>,
) -> SaveProjectRequest {
    let mut value = template.clone();
    replace_string_token(&mut value, dataset_token, dataset_id);
    replace_string_token(&mut value, "table-main", dataset_id);

    if let Some(output_id) = transform_output_dataset_id {
        replace_string_token(&mut value, "table-transform-output-1", output_id);
    }

    if let Value::Object(map) = &mut value {
        map.insert(
            "filePath".to_string(),
            Value::String(archive_path.to_string()),
        );
    }
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
    let transform_output_dataset_id = if save_payload
        .get("tableTransformBindings")
        .and_then(Value::as_array)
        .map(|bindings| !bindings.is_empty())
        .unwrap_or(false)
    {
        Some(seed_dataset(&state, table_seed))
    } else {
        None
    };

    *state.project.write().expect("project write lock") = Some(ProjectInfo {
        name: "Task12 Artifact Parity".to_string(),
        file_path: archive_path.to_string(),
        created_at: "2026-09-16T00:00:00.000Z".to_string(),
    });

    let request = build_save_request(
        save_payload,
        dataset_token,
        &dataset_id,
        archive_path,
        transform_output_dataset_id.as_deref(),
    );
    ProjectService::new(&state)
        .save_project(request, None)
        .expect("save project");

    let reopened_state = AppState::new().expect("reopened app state");
    let open_result = ProjectService::new(&reopened_state)
        .open_project(archive_path, None)
        .expect("reopen project");

    let data_service = DataService::new(&reopened_state);
    let datasets = data_service.list_datasets().expect("list datasets");
    let dataset = datasets
        .iter()
        .find(|entry| entry.id == dataset_id)
        .cloned()
        .expect("reopened primary dataset must exist");
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
        dataset_id,
        transform_output_dataset_id,
        open_result,
        columns,
        display,
        rows: table_window.rows,
    }
}

fn normalize_open_result_for_contract(
    open_result: &OpenProjectResult,
    dataset_id: &str,
    archive_path: &str,
    transform_output_dataset_id: Option<&str>,
    uuid_placeholder: &str,
) -> Value {
    let mut value = serde_json::to_value(open_result).expect("serialize open result");
    if let Some(stem) = std::path::Path::new(archive_path)
        .file_stem()
        .and_then(|file_name| file_name.to_str())
    {
        replace_string_token(&mut value, stem, "Task12 Artifact Parity");
    }
    replace_string_token(&mut value, archive_path, CANONICAL_ARCHIVE_PATH);
    replace_string_token(&mut value, dataset_id, CANONICAL_PRIMARY_DATASET_ID);
    if let Some(output_id) = transform_output_dataset_id {
        replace_string_token(&mut value, output_id, CANONICAL_TRANSFORM_OUTPUT_DATASET_ID);
    }
    normalize_open_result_nondeterminism(&mut value, uuid_placeholder);
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

fn value_field_as_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected string field '{key}'"))
}

#[test]
fn archive_round_trip_from_canonical_payload_preserves_business_state() {
    let fixture = load_fixture();
    let canonical_open_fixture = load_canonical_open_result_fixture();
    let archive_path = build_archive_path("canonical");

    let reopened = save_then_reopen(
        &fixture.canonical_save_payload,
        &fixture.table_seed,
        &fixture.dataset_id_token,
        &archive_path,
    );

    let expected_display = expected_display_from_seed(&fixture.table_seed);
    let expected_column_count = fixture.table_seed.columns.len();
    let reopened_rows = normalize_rows_for_seed_comparison(&reopened.rows, expected_column_count);
    assert_eq!(
        reopened_rows, fixture.table_seed.rows,
        "Round-trip must preserve table row order and values"
    );
    assert_eq!(reopened.columns[0].1, "DOUBLE");
    assert_eq!(reopened.columns[1].1, "VARCHAR");
    let reopened_display = serde_json::to_value(&reopened.display).expect("serialize display");
    let expected_display_value =
        serde_json::to_value(&expected_display).expect("serialize expected display");
    assert_eq!(
        reopened_display, expected_display_value,
        "Round-trip must preserve display width/format/extras"
    );

    let normalized_open_result = normalize_open_result_for_contract(
        &reopened.open_result,
        &reopened.dataset_id,
        &archive_path,
        reopened.transform_output_dataset_id.as_deref(),
        &fixture.nondeterministic_policy.uuid_like,
    );
    assert_eq!(
        normalized_open_result, canonical_open_fixture.canonical_open_project_result,
        "Round-trip reopen result must match canonical open contract"
    );

    let analyses = &reopened.open_result.analyses;
    assert_eq!(
        analyses.len(),
        4,
        "Round-trip must preserve all four analyses"
    );
    let mut kinds = analyses
        .iter()
        .map(|analysis| value_field_as_str(analysis, "analysisKind").to_string())
        .collect::<Vec<_>>();
    kinds.sort();
    assert_eq!(
        kinds,
        vec!["distribution", "fitModel", "fitYByX", "hypothesisTest"],
        "Round-trip must preserve the expected analysis kinds"
    );

    assert_eq!(
        reopened.open_result.table_transforms.len(),
        1,
        "Round-trip must preserve exactly one table transform"
    );
    assert_eq!(
        reopened.open_result.table_transforms[0].id,
        value_field_as_str(&fixture.documents.table_transform, "id"),
        "Round-trip table transform id must match fixture"
    );

    assert_eq!(
        reopened.open_result.table_transform_bindings.len(),
        1,
        "Round-trip must preserve exactly one table transform binding"
    );
    assert_eq!(
        reopened.open_result.table_transform_bindings[0].definition_id,
        value_field_as_str(&fixture.documents.table_transform, "id"),
        "Round-trip binding must reference the fixture transform id"
    );

    assert_eq!(reopened.open_result.tabulates.len(), 1);
    assert_eq!(
        value_field_as_str(&reopened.open_result.tabulates[0], "id"),
        fixture.documents.tabulate.id
    );
    assert_eq!(reopened.open_result.graph_builders.len(), 1);
    assert_eq!(
        value_field_as_str(&reopened.open_result.graph_builders[0], "id"),
        "graph-1"
    );
    assert_eq!(reopened.open_result.reports.len(), 1);
    assert_eq!(
        value_field_as_str(&reopened.open_result.reports[0], "id"),
        "report-1"
    );

    assert!(reopened
        .open_result
        .folders
        .iter()
        .any(|folder| folder == "Analysis"));
    assert_eq!(
        reopened
            .open_result
            .table_folders
            .get(&reopened.dataset_id)
            .map(String::as_str),
        Some("Analysis")
    );
    assert_eq!(
        reopened
            .open_result
            .graph_folders
            .get("graph-1")
            .map(String::as_str),
        Some("Analysis")
    );
    assert_eq!(
        reopened
            .open_result
            .tabulate_folders
            .get("tabulate-1")
            .map(String::as_str),
        Some("Analysis")
    );
    assert_eq!(
        reopened
            .open_result
            .report_folders
            .get("report-1")
            .map(String::as_str),
        Some("Analysis")
    );
    for analysis in analyses {
        let id = value_field_as_str(analysis, "id");
        assert_eq!(
            reopened
                .open_result
                .analysis_folders
                .get(id)
                .map(String::as_str),
            Some("Analysis"),
            "Round-trip analysis folder must be preserved"
        );
    }

    assert_eq!(
        fixture.nondeterministic_policy.strip_fields.is_empty(),
        false,
        "Fixture must continue declaring nondeterministic fields"
    );
    assert!(!fixture.nondeterministic_policy.uuid_like.is_empty());

    let _ = std::fs::remove_file(archive_path);
}

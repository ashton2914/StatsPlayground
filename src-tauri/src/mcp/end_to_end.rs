use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::mcp::broker::{ApplicationCommandEventEmitter, McpCommandBroker};
use crate::mcp::security::{
    enforce_http_limits, require_bearer, BearerToken, McpHttpLimitsState, McpHttpSecurityState,
};
use crate::mcp::tools::StatsPlaygroundMcpServer;
use crate::models::mcp::{
    ApplicationCommandEnvelope, ApplicationCommandRequestEvent, ApplicationCommandResponse,
    McpBrokerCompletion, McpCommandBrokerConfig, McpCommandResult,
};

static HTTP_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

struct TestServerHandle {
    endpoint: String,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServerHandle {
    async fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(Duration::from_secs(2), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}

async fn start_test_server<E: ApplicationCommandEventEmitter>(
    broker: McpCommandBroker<E>,
) -> TestServerHandle {
    let token = BearerToken::generate();
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let address = listener.local_addr().expect("listener local addr");
    let security_state = McpHttpSecurityState::new(token.clone());
    let limits_state = McpHttpLimitsState::default();
    let server = StatsPlaygroundMcpServer::new(broker, Default::default());

    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([
            format!("127.0.0.1:{}", address.port()),
            format!("localhost:{}", address.port()),
        ])
        .with_allowed_origins([
            "tauri://localhost".to_string(),
            "http://localhost".to_string(),
            format!("http://localhost:{}", address.port()),
            format!("http://127.0.0.1:{}", address.port()),
        ])
        .with_max_request_body_bytes(MAX_REQUEST_BODY_BYTES)
        .with_legacy_session_mode(true)
        .with_json_response(true);
    let service: StreamableHttpService<StatsPlaygroundMcpServer<E>, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(server.clone()), Default::default(), config);
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(from_fn_with_state(
            limits_state.clone(),
            enforce_http_limits,
        ))
        .layer(from_fn_with_state(security_state, require_bearer));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    tokio::task::yield_now().await;

    TestServerHandle {
        endpoint: format!("http://127.0.0.1:{}/mcp", address.port()),
        token: token.expose_for_management(),
        shutdown: Some(shutdown_tx),
        task,
    }
}

#[derive(Clone, Default)]
struct RecordingEmitter {
    requests: Arc<Mutex<Vec<ApplicationCommandRequestEvent>>>,
    cancels: Arc<Mutex<Vec<String>>>,
}

impl RecordingEmitter {
    fn next_request_after(&self, previous_count: usize) -> ApplicationCommandRequestEvent {
        for _ in 0..500 {
            let maybe = self
                .requests
                .lock()
                .expect("recording emitter lock")
                .get(previous_count)
                .cloned();
            if let Some(event) = maybe {
                return event;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("timed out waiting for broker request event");
    }
}

impl ApplicationCommandEventEmitter for RecordingEmitter {
    fn emit_application_command_request(
        &self,
        event: ApplicationCommandRequestEvent,
    ) -> Result<(), crate::error::AppError> {
        self.requests
            .lock()
            .expect("recording emitter lock")
            .push(event);
        Ok(())
    }

    fn emit_application_command_cancel(
        &self,
        request_id: String,
    ) -> Result<(), crate::error::AppError> {
        self.cancels
            .lock()
            .expect("recording emitter lock")
            .push(request_id);
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactParityFixture {
    projection_cases: Vec<ProjectionCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionCase {
    id: String,
    tool_name: String,
    raw_arguments: Map<String, Value>,
    expected_envelope: ApplicationCommandEnvelope,
}

fn load_fixture() -> ArtifactParityFixture {
    serde_json::from_str(include_str!(
        "../../../contracts/mcp/artifact-parity.v1.json"
    ))
    .expect("valid artifact parity fixture")
}

fn find_case<'a>(fixture: &'a ArtifactParityFixture, id: &str) -> &'a ProjectionCase {
    fixture
        .projection_cases
        .iter()
        .find(|entry| entry.id == id)
        .unwrap_or_else(|| panic!("missing projection case {id}"))
}

fn decode_sse_body(body: &str) -> String {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_chunked_body(body: &str) -> String {
    let mut rest = body;
    let mut decoded = String::new();
    while let Some((size_text, after_size)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_text.trim(), 16).expect("chunk size");
        if size == 0 {
            break;
        }
        let (chunk, after_chunk) = after_size.split_at(size);
        decoded.push_str(chunk);
        rest = after_chunk.strip_prefix("\r\n").expect("chunk delimiter");
    }
    decoded
}

fn post_json_with_session(
    endpoint: &str,
    token: Option<&str>,
    session_id: Option<&str>,
    body: Value,
) -> (u16, Value, Option<String>) {
    let without_scheme = endpoint.strip_prefix("http://").expect("loopback endpoint");
    let (authority, path) = without_scheme.split_once('/').expect("endpoint path");
    let payload = serde_json::to_vec(&body).expect("json body");

    let mut request = format!(
        "POST /{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-11-25\r\nContent-Length: {}\r\nConnection: close\r\n",
        path,
        authority,
        payload.len()
    );
    if let Some(value) = token {
        request.push_str(&format!("Authorization: Bearer {}\r\n", value));
    }
    if let Some(value) = session_id {
        request.push_str(&format!("Mcp-Session-Id: {}\r\n", value));
    }
    request.push_str("\r\n");

    let mut stream = TcpStream::connect(authority).expect("connect mcp server");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream.write_all(request.as_bytes()).expect("write request");
    stream.write_all(&payload).expect("write payload");

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(error)
                if (error.kind() == ErrorKind::WouldBlock
                    || error.kind() == ErrorKind::TimedOut)
                    && !response.is_empty() =>
            {
                break
            }
            Err(error) => panic!("read response: {error}"),
        }
    }

    let response_text = String::from_utf8(response).expect("utf8 response");
    let (head, body) = response_text
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("http response: {response_text:?}"));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    let session = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("mcp-session-id")
            .then(|| value.trim().to_string())
    });
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        decode_chunked_body(body)
    } else {
        body.to_string()
    };
    let body = if head
        .to_ascii_lowercase()
        .contains("content-type: text/event-stream")
    {
        decode_sse_body(&body)
    } else {
        body
    };
    let parsed = if body.trim().is_empty() {
        json!(null)
    } else if status != 200 {
        json!({ "raw": body })
    } else {
        serde_json::from_str(&body).expect("json response body")
    };
    (status, parsed, session)
}

fn initialize_session(endpoint: &str, token: &str) -> String {
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "task-13-e2e", "version": "0.0.0" }
        }
    });
    let (status, body, session_id) =
        post_json_with_session(endpoint, Some(token), None, initialize);
    assert_eq!(status, 200, "{body:?}");
    assert_eq!(body["jsonrpc"], "2.0");
    session_id.expect("session id")
}

fn call_tool(
    endpoint: &str,
    token: &str,
    session_id: &str,
    request_id: i64,
    tool_name: &str,
    arguments: Map<String, Value>,
) -> (u16, Value) {
    let payload = json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        }
    });
    let (status, body, _) =
        post_json_with_session(endpoint, Some(token), Some(session_id), payload);
    (status, body)
}

fn success_response_for(command: &str, revision: u64) -> ApplicationCommandResponse {
    let data = match command {
        "project.inspect" => json!({
            "project": {
                "name": "Task13",
                "createdAt": "2026-09-16T00:00:00.000Z",
                "fileName": "task13.spprj",
                "hasProjectPath": true
            },
            "dirty": true,
            "readOnly": false,
            "projectRevision": revision,
            "counts": {
                "tables": 1,
                "tableTransforms": 1,
                "graphs": 1,
                "analyses": 4,
                "tabulates": 1,
                "reports": 1
            }
        }),
        "table.create" => json!({
            "dataset": {
                "id": "table-main",
                "name": "Main Table",
                "sourceType": "manual",
                "rowCount": 2,
                "colCount": 2,
                "generation": 1,
                "createdAt": "2026-09-16T00:00:00.000Z",
                "updatedAt": "2026-09-16T00:00:00.000Z",
                "sourceName": Value::Null
            },
            "generation": 1,
            "columns": [
                { "colIndex": 0, "colName": "width", "colType": "DOUBLE" },
                { "colIndex": 1, "colName": "build", "colType": "VARCHAR" }
            ]
        }),
        "project.save" => json!({
            "name": "Task13",
            "createdAt": "2026-09-16T00:00:00.000Z",
            "fileName": "task13.spprj",
            "hasProjectPath": true
        }),
        "table.exportCsv" => json!({
            "targetStatus": "createNew"
        }),
        "snapshot.create" => json!({
            "snapshotId": "snapshot-1",
            "snapshotName": "Snapshot 1",
            "createdAt": "2026-09-16T00:00:00.000Z"
        }),
        other => panic!("unexpected command for e2e completion: {other}"),
    };

    ApplicationCommandResponse::Success(McpCommandResult {
        changed: command != "project.inspect" && command != "table.exportCsv",
        project_revision: revision,
        data,
        warnings: vec![],
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_end_to_end_dispatches_exact_envelopes_with_correlation() {
    let _guard = HTTP_TEST_LOCK.lock().await;

    let fixture = load_fixture();
    let inspect_case = ProjectionCase {
        id: "project.inspect".to_string(),
        tool_name: "statsplayground_project_inspect".to_string(),
        raw_arguments: Map::new(),
        expected_envelope: ApplicationCommandEnvelope {
            command_type: "project.inspect".to_string(),
            input: json!({}),
            control: None,
        },
    };
    let table_case = find_case(&fixture, "table.create");
    let save_case = find_case(&fixture, "project.save");
    let csv_case = find_case(&fixture, "table.exportCsv");
    let snapshot_case = find_case(&fixture, "snapshot.create");

    let emitter = RecordingEmitter::default();
    let broker =
        McpCommandBroker::new_for_tests(emitter.clone(), McpCommandBrokerConfig::default());
    broker.register_dispatcher().expect("register dispatcher");

    let mut server = start_test_server(broker.clone()).await;
    let session_id = initialize_session(&server.endpoint, &server.token);

    let ordered: [&ProjectionCase; 5] = [
        &inspect_case,
        table_case,
        save_case,
        csv_case,
        snapshot_case,
    ];

    for (index, case) in ordered.iter().enumerate() {
        let previous = emitter
            .requests
            .lock()
            .expect("recording emitter lock")
            .len();
        let endpoint = server.endpoint.clone();
        let token = server.token.clone();
        let session = session_id.clone();
        let tool_name = case.tool_name.clone();
        let arguments = case.raw_arguments.clone();
        let call_handle = std::thread::spawn(move || {
            call_tool(
                &endpoint,
                &token,
                &session,
                10 + index as i64,
                &tool_name,
                arguments,
            )
        });

        let event = emitter.next_request_after(previous);

        assert_eq!(
            event.command, case.expected_envelope,
            "projection mismatch for {}",
            case.id
        );
        assert!(event.request_id.starts_with("mcp-"));

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: event.request_id.clone(),
                response: success_response_for(&event.command.command_type, 21 + index as u64),
            })
            .expect("complete broker request");

        let (status_code, body) = call_handle.join().expect("tools/call response");

        assert_eq!(status_code, 200, "{body:?}");
        assert_eq!(body["result"]["isError"], false, "{body:?}");
        assert_eq!(
            body["result"]["structuredContent"]["requestId"],
            Value::String(event.request_id.clone())
        );
    }

    server.stop().await;
    broker
        .unregister_dispatcher()
        .expect("unregister dispatcher");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_end_to_end_surfaces_app_not_ready_before_dispatcher_registration() {
    let _guard = HTTP_TEST_LOCK.lock().await;

    let emitter = RecordingEmitter::default();
    let broker = McpCommandBroker::new_for_tests(emitter, McpCommandBrokerConfig::default());
    let mut server = start_test_server(broker).await;
    let session_id = initialize_session(&server.endpoint, &server.token);

    let (status_code, body) = call_tool(
        &server.endpoint,
        &server.token,
        &session_id,
        99,
        "statsplayground_project_inspect",
        Map::new(),
    );

    assert_eq!(status_code, 200, "{body:?}");
    assert_eq!(body["result"]["isError"], true, "{body:?}");
    assert_eq!(
        body["result"]["structuredContent"]["code"],
        Value::String("app_not_ready".to_string())
    );

    server.stop().await;
}

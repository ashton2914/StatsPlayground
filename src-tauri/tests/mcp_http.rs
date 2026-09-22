use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};
use stats_playground_lib::mcp::server::{McpSettings, McpStartConfiguration};
use stats_playground_lib::state::AppState;

static HTTP_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn post_json(
    endpoint: &str,
    token: Option<&str>,
    origin: Option<&str>,
    host: Option<&str>,
    body: Value,
) -> (u16, Value) {
    let response = post_json_with_session(endpoint, token, origin, host, None, body);
    (response.0, response.1)
}

fn post_json_with_session(
    endpoint: &str,
    token: Option<&str>,
    origin: Option<&str>,
    host: Option<&str>,
    session_id: Option<&str>,
    body: Value,
) -> (u16, Value, Option<String>) {
    post_json_with_session_attempt(endpoint, token, origin, host, session_id, body, 0)
}

fn post_json_with_session_attempt(
    endpoint: &str,
    token: Option<&str>,
    origin: Option<&str>,
    host: Option<&str>,
    session_id: Option<&str>,
    body: Value,
    attempt: usize,
) -> (u16, Value, Option<String>) {
    let without_scheme = endpoint.strip_prefix("http://").expect("loopback endpoint");
    let (authority, path) = without_scheme.split_once('/').expect("endpoint path");
    let host_header = host.unwrap_or(authority);
    let payload = serde_json::to_vec(&body).expect("json body");
    let mut request = format!(
        "POST /{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-11-25\r\nContent-Length: {}\r\nConnection: close\r\n",
        path,
        host_header,
        payload.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {}\r\n", token));
    }
    if let Some(origin) = origin {
        request.push_str(&format!("Origin: {}\r\n", origin));
    }
    if let Some(session_id) = session_id {
        request.push_str(&format!("Mcp-Session-Id: {}\r\n", session_id));
    }
    request.push_str("\r\n");

    let mut stream = TcpStream::connect(authority).expect("connect to MCP server");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream.write_all(request.as_bytes()).expect("write headers");
    stream.write_all(&payload).expect("write body");

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
            Err(error)
                if error.kind() == ErrorKind::ConnectionReset
                    && response.is_empty()
                    && attempt < 10 =>
            {
                std::thread::sleep(Duration::from_millis(10));
                return post_json_with_session_attempt(
                    endpoint,
                    token,
                    origin,
                    host,
                    session_id,
                    body,
                    attempt + 1,
                );
            }
            Err(error) => panic!("read response: {error}"),
        }
    }
    let response_text = String::from_utf8(response).expect("utf8 response");
    if response_text.is_empty() && attempt < 10 {
        std::thread::sleep(Duration::from_millis(10));
        return post_json_with_session_attempt(
            endpoint,
            token,
            origin,
            host,
            session_id,
            body,
            attempt + 1,
        );
    }
    let (head, body) = response_text
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("http response: {response_text:?}"));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    let session_id = head.lines().find_map(|line| {
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
    let body = if body.trim().is_empty() {
        json!(null)
    } else if status != 200 {
        json!({ "raw": body })
    } else {
        serde_json::from_str(&body).expect("json response body")
    };
    (status, body, session_id)
}

fn post_raw(endpoint: &str, token: &str, body: Vec<u8>) -> u16 {
    let without_scheme = endpoint.strip_prefix("http://").expect("loopback endpoint");
    let (authority, path) = without_scheme.split_once('/').expect("endpoint path");
    let request = format!(
        "POST /{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-11-25\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        authority,
        token,
        body.len()
    );
    let mut stream = TcpStream::connect(authority).expect("connect to MCP server");
    stream.write_all(request.as_bytes()).expect("write headers");
    stream.write_all(&body).expect("write body");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code")
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_starts_with_saved_configuration_and_serves_initialize() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let initial = state.mcp_server.status().expect("initial status");
    assert_eq!(initial.state, "stopped");
    assert!(initial.endpoint.is_none());
    assert!(initial.token.is_none());

    let reserved_port = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("reserve port")
        .local_addr()
        .expect("reserved address")
        .port();
    let settings = McpSettings {
        port: reserved_port,
        token: "p".repeat(32),
    };
    let first = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::from_settings(settings.clone()),
        )
        .await
        .expect("start");
    assert_eq!(first.state, "running");
    assert_eq!(
        first.endpoint,
        Some(format!("http://127.0.0.1:{reserved_port}/mcp"))
    );
    assert_eq!(first.token, Some(settings.token.clone()));
    let first_endpoint = first.endpoint.as_deref().expect("endpoint");
    let first_token = first.token.as_deref().expect("token");

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "task-10-test", "version": "0.0.0" }
        }
    });
    let (unauthorized_status, _) = post_json(first_endpoint, None, None, None, initialize.clone());
    assert_eq!(unauthorized_status, 401);
    let (invalid_origin_status, _) = post_json(
        first_endpoint,
        Some(first_token),
        Some("https://attacker.example"),
        None,
        initialize.clone(),
    );
    assert_eq!(invalid_origin_status, 403);
    let (ok_status, ok_body) = post_json(first_endpoint, Some(first_token), None, None, initialize);
    assert_eq!(ok_status, 200);
    assert_eq!(ok_body["jsonrpc"], "2.0");

    state.mcp_server.stop().await.expect("stop");
    let stopped = state.mcp_server.status().expect("stopped status");
    assert_eq!(stopped.state, "stopped");
    assert!(stopped.token.is_none());
    let stopped_connect = TcpStream::connect(
        first_endpoint
            .strip_prefix("http://")
            .unwrap()
            .trim_end_matches("/mcp"),
    );
    assert!(stopped_connect.is_err());

    let second = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::from_settings(settings.clone()),
        )
        .await
        .expect("restart");
    assert_eq!(
        second.endpoint,
        Some(format!("http://127.0.0.1:{reserved_port}/mcp"))
    );
    assert_eq!(second.token, Some(settings.token));
    state.mcp_server.stop().await.expect("final stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_starts_transiently_with_a_new_token_after_restart() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let first = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("first transient start");
    let first_token = first.token.expect("first token");
    state.mcp_server.stop().await.expect("first stop");

    let second = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("second transient start");
    assert_ne!(second.token.as_deref(), Some(first_token.as_str()));
    state.mcp_server.stop().await.expect("second stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_starts_fail_when_configured_port_is_occupied() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy port");
    let port = listener.local_addr().expect("occupied address").port();
    let state = AppState::new().expect("state");
    let result = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::from_settings(McpSettings {
                port,
                token: "o".repeat(32),
            }),
        )
        .await;

    assert!(result.is_err());
    assert_eq!(state.mcp_server.status().expect("status").state, "stopped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_starts_never_publish_multiple_servers() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let (left, right) = tokio::join!(
        state.mcp_server.start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient()
        ),
        state.mcp_server.start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient()
        ),
    );
    let endpoints: std::collections::BTreeSet<_> = [left, right]
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|status| status.endpoint)
        .collect();
    assert_eq!(endpoints.len(), 1);
    state.mcp_server.stop().await.expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_lists_exact_tool_catalog() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let status = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("start");
    let endpoint = status.endpoint.as_deref().expect("endpoint");
    let token = status.token.as_deref().expect("token");
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "task-10-test", "version": "0.0.0" }
        }
    });
    let (initialize_status, _, session_id) =
        post_json_with_session(endpoint, Some(token), None, None, None, initialize);
    assert_eq!(initialize_status, 200);
    let list_tools = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
    let (list_status, list_body, _) = post_json_with_session(
        endpoint,
        Some(token),
        None,
        None,
        session_id.as_deref(),
        list_tools,
    );
    assert_eq!(list_status, 200, "{list_body:?}");
    let tools = list_body["result"]["tools"]
        .as_array()
        .expect("tools array");
    assert_eq!(tools.len(), 22);
    assert_eq!(tools[0]["name"], "statsplayground_project_inspect");
    state.mcp_server.stop().await.expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_tools_call_returns_standard_tool_response() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let status = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("start");
    let endpoint = status.endpoint.as_deref().expect("endpoint");
    let token = status.token.as_deref().expect("token");
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "task-10-test", "version": "0.0.0" }
        }
    });
    let (initialize_status, _, session_id) =
        post_json_with_session(endpoint, Some(token), None, None, None, initialize);
    assert_eq!(initialize_status, 200);
    let call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "statsplayground_project_inspect",
            "arguments": {}
        }
    });
    let (call_status, call_body, _) = post_json_with_session(
        endpoint,
        Some(token),
        None,
        None,
        session_id.as_deref(),
        call,
    );
    assert_eq!(call_status, 200, "{call_body:?}");
    assert!(call_body["result"]["content"].is_array(), "{call_body:?}");
    assert_eq!(call_body["result"]["isError"], true, "{call_body:?}");
    state.mcp_server.stop().await.expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_rejects_oversized_request_bodies() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let status = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("start");
    let endpoint = status.endpoint.as_deref().expect("endpoint");
    let token = status.token.as_deref().expect("token");
    let oversized = vec![b' '; 1024 * 1024 + 1];
    let status = post_raw(endpoint, token, oversized);
    assert_eq!(status, 413);
    state.mcp_server.stop().await.expect("stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_http_rate_limit_returns_too_many_requests() {
    let _guard = HTTP_TEST_LOCK.lock().await;
    let state = AppState::new().expect("state");
    let status = state
        .mcp_server
        .start(
            state.mcp_command_broker.clone(),
            McpStartConfiguration::transient(),
        )
        .await
        .expect("start");
    let endpoint = status.endpoint.as_deref().expect("endpoint");
    let token = status.token.as_deref().expect("token");

    for _ in 0..120 {
        let status = post_raw(endpoint, token, b"{}".to_vec());
        assert_ne!(status, 429);
    }
    assert_eq!(post_raw(endpoint, token, b"{}".to_vec()), 429);

    state.mcp_server.stop().await.expect("stop");
}

#[test]
fn mcp_tool_catalog_is_exact_unique_and_schema_backed() {
    let catalog = stats_playground_lib::mcp::tools::tool_catalog();
    let names: Vec<_> = catalog.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "statsplayground_project_inspect",
            "statsplayground_table_list",
            "statsplayground_table_describe",
            "statsplayground_document_list",
            "statsplayground_document_get",
            "statsplayground_table_create",
            "statsplayground_table_transform_create",
            "statsplayground_table_transform_run",
            "statsplayground_sql_create_table",
            "statsplayground_table_export_csv",
            "statsplayground_tabulate_create",
            "statsplayground_tabulate_run",
            "statsplayground_tabulate_to_table",
            "statsplayground_graph_create",
            "statsplayground_graph_update",
            "statsplayground_analysis_create",
            "statsplayground_analysis_update",
            "statsplayground_analysis_run",
            "statsplayground_report_create",
            "statsplayground_report_update",
            "statsplayground_project_save",
            "statsplayground_snapshot_create",
        ]
    );
    let unique: std::collections::BTreeSet<_> = names.iter().copied().collect();
    assert_eq!(unique.len(), 22);
    for tool in catalog {
        assert!(
            tool.name.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || character == '_'
                    || character == '-'
            }),
            "tool name must satisfy [a-z0-9_-]+: {}",
            tool.name
        );
        assert_eq!(tool.input_schema["type"], "object");
        assert_eq!(tool.output_schema["type"], "object");
        assert!(!tool.name.contains("resource"));
        assert!(!tool.name.contains("prompt"));
        assert!(!tool.name.contains("task"));
        assert!(!tool.name.contains("sampling"));
        assert!(!tool.name.contains("restore"));
        assert!(!tool.name.contains("delete"));
    }
}

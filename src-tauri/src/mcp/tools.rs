use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::mcp::broker::{ApplicationCommandEventEmitter, McpCancellationToken, McpCommandBroker};
use crate::models::mcp::{ApplicationCommandEnvelope, McpAuditEntry, McpCommandError};

const TOOL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct McpToolCatalogEntry {
    pub name: String,
    pub command: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub output_schema: Value,
    pub read_only: bool,
}

#[derive(Clone, Default)]
pub struct McpAuditLog {
    inner: Arc<std::sync::Mutex<VecDeque<McpAuditEntry>>>,
}

impl McpAuditLog {
    pub fn push(&self, entry: McpAuditEntry) -> Result<(), AppError> {
        let mut entries = self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        entries.push_back(entry);
        while entries.len() > 100 {
            entries.pop_front();
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<McpAuditEntry>, AppError> {
        self.inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
            .map(|entries| entries.iter().cloned().collect())
    }

    pub fn clear(&self) -> Result<(), AppError> {
        self.inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clear();
        Ok(())
    }
}

macro_rules! passthrough_dto {
    ($($input:ident => $output:ident),+ $(,)?) => {
        $(
            #[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
            #[serde(rename_all = "camelCase")]
            pub struct $input {
                #[serde(flatten)]
                pub fields: BTreeMap<String, Value>,
            }

            #[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
            #[serde(rename_all = "camelCase")]
            pub struct $output {
                pub request_id: String,
                pub command: String,
                pub changed: bool,
                pub project_revision: u64,
                pub data: Value,
                pub warnings: Vec<Value>,
            }
        )+
    };
}

passthrough_dto!(
    ProjectInspectToolInput => ProjectInspectToolOutput,
    TableListToolInput => TableListToolOutput,
    TableDescribeToolInput => TableDescribeToolOutput,
    DocumentListToolInput => DocumentListToolOutput,
    DocumentGetToolInput => DocumentGetToolOutput,
    TableCreateToolInput => TableCreateToolOutput,
    TableTransformCreateToolInput => TableTransformCreateToolOutput,
    TableTransformRunToolInput => TableTransformRunToolOutput,
    SqlCreateTableToolInput => SqlCreateTableToolOutput,
    TableExportCsvToolInput => TableExportCsvToolOutput,
    TabulateCreateToolInput => TabulateCreateToolOutput,
    TabulateRunToolInput => TabulateRunToolOutput,
    TabulateToTableToolInput => TabulateToTableToolOutput,
    GraphCreateToolInput => GraphCreateToolOutput,
    GraphUpdateToolInput => GraphUpdateToolOutput,
    AnalysisCreateToolInput => AnalysisCreateToolOutput,
    AnalysisUpdateToolInput => AnalysisUpdateToolOutput,
    AnalysisRunToolInput => AnalysisRunToolOutput,
    ReportCreateToolInput => ReportCreateToolOutput,
    ReportUpdateToolInput => ReportUpdateToolOutput,
    ProjectSaveToolInput => ProjectSaveToolOutput,
    SnapshotCreateToolInput => SnapshotCreateToolOutput,
);

#[derive(Clone)]
pub struct StatsPlaygroundMcpServer<
    E: ApplicationCommandEventEmitter = crate::mcp::broker::TauriApplicationCommandEventEmitter,
> {
    broker: McpCommandBroker<E>,
    audit_log: McpAuditLog,
}

impl<E: ApplicationCommandEventEmitter> StatsPlaygroundMcpServer<E> {
    pub fn new(broker: McpCommandBroker<E>, audit_log: McpAuditLog) -> Self {
        Self { broker, audit_log }
    }

    async fn call_catalog_tool(
        &self,
        request: CallToolRequestParams,
    ) -> Result<CallToolResponse, McpError> {
        let Some(entry) = tool_catalog()
            .into_iter()
            .find(|entry| entry.name == request.name.as_ref())
        else {
            return Err(McpError::method_not_found::<
                rmcp::model::CallToolRequestMethod,
            >());
        };
        let request_started = Instant::now();
        let mut input = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));
        if contains_trusted_confirmation(&input) {
            return Err(McpError::invalid_params(
                "tool arguments must not include confirmation flags",
                None,
            ));
        }
        let control = input
            .as_object_mut()
            .and_then(|object| object.remove("control"));
        let envelope = ApplicationCommandEnvelope {
            command_type: entry.command.to_string(),
            input,
            control,
        };
        let request_id_hint = format!("mcp-http-{}", request_started.elapsed().as_nanos());
        let _ = self.audit_log.push(McpAuditEntry {
            request_id: request_id_hint.clone(),
            timestamp: current_timestamp(),
            tool: entry.name.clone(),
            status: "queued".to_string(),
            duration_ms: None,
            error_code: None,
        });
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();
        let result = self
            .broker
            .dispatch(envelope, TOOL_TIMEOUT, progress_tx, token)
            .await;
        match result {
            Ok(response) => {
                let structured = json!({
                    "requestId": response.request_id,
                    "command": entry.command,
                    "changed": response.changed,
                    "projectRevision": response.project_revision,
                    "data": sanitize_value(response.data),
                    "warnings": sanitize_value(json!(response.warnings)),
                });
                let _ = self.audit_log.push(McpAuditEntry {
                    request_id: structured["requestId"]
                        .as_str()
                        .unwrap_or(&request_id_hint)
                        .to_string(),
                    timestamp: current_timestamp(),
                    tool: entry.name,
                    status: "succeeded".to_string(),
                    duration_ms: Some(request_started.elapsed().as_millis() as u64),
                    error_code: None,
                });
                Ok(CallToolResult::structured(structured).into())
            }
            Err(error) => {
                let command_error = command_error_from_app_error(error);
                let structured = sanitize_value(json!({
                    "requestId": request_id_hint,
                    "code": command_error.code,
                    "message": command_error.message,
                    "retryable": command_error.retryable,
                    "details": command_error.details,
                }));
                let _ = self.audit_log.push(McpAuditEntry {
                    request_id: structured["requestId"]
                        .as_str()
                        .unwrap_or("mcp-http-error")
                        .to_string(),
                    timestamp: current_timestamp(),
                    tool: entry.name,
                    status: "failed".to_string(),
                    duration_ms: Some(request_started.elapsed().as_millis() as u64),
                    error_code: structured["code"].as_str().map(ToOwned::to_owned),
                });
                Ok(CallToolResult::structured_error(structured).into())
            }
        }
    }
}

impl<E: ApplicationCommandEventEmitter> ServerHandler for StatsPlaygroundMcpServer<E> {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "StatsPlayground",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(ProtocolVersion::known_up_to(&ProtocolVersion::V_2025_11_25))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(
            tool_catalog()
                .into_iter()
                .map(catalog_entry_to_tool)
                .collect(),
        ))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tool_catalog()
            .into_iter()
            .find(|entry| entry.name == name)
            .map(catalog_entry_to_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        self.call_catalog_tool(request).await
    }
}

pub fn tool_catalog() -> Vec<McpToolCatalogEntry> {
    vec![
        entry::<ProjectInspectToolInput, ProjectInspectToolOutput>(
            "statsplayground.project.inspect",
            "project.inspect",
            "Inspect the current project",
            true,
        ),
        entry::<TableListToolInput, TableListToolOutput>(
            "statsplayground.table.list",
            "table.list",
            "List project tables",
            true,
        ),
        entry::<TableDescribeToolInput, TableDescribeToolOutput>(
            "statsplayground.table.describe",
            "table.describe",
            "Describe one table",
            true,
        ),
        entry::<DocumentListToolInput, DocumentListToolOutput>(
            "statsplayground.document.list",
            "document.list",
            "List project documents",
            true,
        ),
        entry::<DocumentGetToolInput, DocumentGetToolOutput>(
            "statsplayground.document.get",
            "document.get",
            "Get a project document",
            true,
        ),
        entry::<TableCreateToolInput, TableCreateToolOutput>(
            "statsplayground.table.create",
            "table.create",
            "Create a managed table",
            false,
        ),
        entry::<TableTransformCreateToolInput, TableTransformCreateToolOutput>(
            "statsplayground.table.transform.create",
            "tableTransform.create",
            "Create a table transform",
            false,
        ),
        entry::<TableTransformRunToolInput, TableTransformRunToolOutput>(
            "statsplayground.table.transform.run",
            "tableTransform.run",
            "Run a table transform",
            false,
        ),
        entry::<SqlCreateTableToolInput, SqlCreateTableToolOutput>(
            "statsplayground.sql.create_table",
            "sql.createTable",
            "Create a table from read-only SQL",
            false,
        ),
        entry::<TableExportCsvToolInput, TableExportCsvToolOutput>(
            "statsplayground.table.export_csv",
            "table.exportCsv",
            "Export a table as CSV",
            false,
        ),
        entry::<TabulateCreateToolInput, TabulateCreateToolOutput>(
            "statsplayground.tabulate.create",
            "tabulate.create",
            "Create a Tabulate document",
            false,
        ),
        entry::<TabulateRunToolInput, TabulateRunToolOutput>(
            "statsplayground.tabulate.run",
            "tabulate.run",
            "Run a Tabulate document",
            false,
        ),
        entry::<TabulateToTableToolInput, TabulateToTableToolOutput>(
            "statsplayground.tabulate.to_table",
            "tabulate.exportTable",
            "Create a table from Tabulate",
            false,
        ),
        entry::<GraphCreateToolInput, GraphCreateToolOutput>(
            "statsplayground.graph.create",
            "graph.create",
            "Create a Graph Builder document",
            false,
        ),
        entry::<GraphUpdateToolInput, GraphUpdateToolOutput>(
            "statsplayground.graph.update",
            "graph.update",
            "Update a Graph Builder document",
            false,
        ),
        entry::<AnalysisCreateToolInput, AnalysisCreateToolOutput>(
            "statsplayground.analysis.create",
            "analysis.create",
            "Create an Analysis document",
            false,
        ),
        entry::<AnalysisUpdateToolInput, AnalysisUpdateToolOutput>(
            "statsplayground.analysis.update",
            "analysis.update",
            "Update an Analysis document",
            false,
        ),
        entry::<AnalysisRunToolInput, AnalysisRunToolOutput>(
            "statsplayground.analysis.run",
            "analysis.run",
            "Run an Analysis document",
            false,
        ),
        entry::<ReportCreateToolInput, ReportCreateToolOutput>(
            "statsplayground.report.create",
            "report.create",
            "Create a Report document",
            false,
        ),
        entry::<ReportUpdateToolInput, ReportUpdateToolOutput>(
            "statsplayground.report.update",
            "report.update",
            "Update a Report document",
            false,
        ),
        entry::<ProjectSaveToolInput, ProjectSaveToolOutput>(
            "statsplayground.project.save",
            "project.save",
            "Save the current project",
            false,
        ),
        entry::<SnapshotCreateToolInput, SnapshotCreateToolOutput>(
            "statsplayground.snapshot.create",
            "snapshot.create",
            "Create a project snapshot",
            false,
        ),
    ]
}

fn entry<I, O>(
    name: &'static str,
    command: &'static str,
    description: &'static str,
    read_only: bool,
) -> McpToolCatalogEntry
where
    I: JsonSchema,
    O: JsonSchema,
{
    McpToolCatalogEntry {
        name: name.to_string(),
        command,
        description,
        input_schema: schema_value::<I>(),
        output_schema: schema_value::<O>(),
        read_only,
    }
}

fn schema_value<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).unwrap_or_else(|_| json!({ "type": "object" }))
}

fn catalog_entry_to_tool(entry: McpToolCatalogEntry) -> Tool {
    let input_schema = json_object(entry.input_schema);
    let output_schema = json_object(entry.output_schema);
    Tool::new(entry.name, entry.description, Arc::new(input_schema))
        .with_raw_output_schema(Arc::new(output_schema))
        .with_annotations(
            ToolAnnotations::new()
                .read_only(entry.read_only)
                .destructive(false)
                .open_world(false),
        )
}

fn json_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

fn contains_trusted_confirmation(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("confirmed")
                || key.eq_ignore_ascii_case("overwriteConfirmed")
                || contains_trusted_confirmation(value)
        }),
        Value::Array(values) => values.iter().any(contains_trusted_confirmation),
        _ => false,
    }
}

fn command_error_from_app_error(error: AppError) -> McpCommandError {
    match error {
        AppError::ApplicationCommand(command_error) => sanitize_command_error(command_error),
        AppError::Busy(message) if message.contains("queue") => McpCommandError {
            code: "queue_full".to_string(),
            message: sanitize_text(&message),
            retryable: true,
            details: None,
        },
        AppError::Busy(message) if message.contains("timeout") => McpCommandError {
            code: "timeout".to_string(),
            message: sanitize_text(&message),
            retryable: true,
            details: None,
        },
        AppError::Busy(message) => McpCommandError {
            code: "app_not_ready".to_string(),
            message: sanitize_text(&message),
            retryable: true,
            details: None,
        },
        AppError::Cancelled(message) => McpCommandError {
            code: "cancelled".to_string(),
            message: sanitize_text(&message),
            retryable: true,
            details: None,
        },
        AppError::InvalidParam(message) => McpCommandError {
            code: "invalid_input".to_string(),
            message: sanitize_text(&message),
            retryable: false,
            details: None,
        },
        AppError::ReadOnly(message) => McpCommandError {
            code: "read_only".to_string(),
            message: sanitize_text(&message),
            retryable: false,
            details: None,
        },
        AppError::Database(_) | AppError::FileIO(_) | AppError::Stats(_) => McpCommandError {
            code: "execution_failed".to_string(),
            message: "Application command failed".to_string(),
            retryable: false,
            details: None,
        },
    }
}

fn sanitize_command_error(error: McpCommandError) -> McpCommandError {
    McpCommandError {
        code: sanitize_text(&error.code),
        message: sanitize_text(&error.message),
        retryable: error.retryable,
        details: error.details.map(sanitize_value),
    }
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(sanitize_text(&text)),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_value).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .filter(|(key, _)| {
                    !key.eq_ignore_ascii_case("token") && !key.eq_ignore_ascii_case("authorization")
                })
                .map(|(key, value)| (sanitize_text(&key), sanitize_value(value)))
                .collect(),
        ),
        other => other,
    }
}

fn sanitize_text(text: &str) -> String {
    if text.contains("Bearer ")
        || text.starts_with('/')
        || text.contains("/Users/")
        || text.contains("\\\\")
    {
        "[redacted]".to_string()
    } else {
        text.to_string()
    }
}

fn current_timestamp() -> String {
    format!("{:?}", std::time::SystemTime::now())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::models::mcp::{
        ApplicationCommandRequestEvent, ApplicationCommandResponse, McpBrokerCompletion,
        McpCommandBrokerConfig, McpCommandResult,
    };
    use rmcp::model::{CallToolRequestParams, CallToolResponse};

    #[derive(Clone, Default)]
    struct RecordingEmitter {
        requests: Arc<Mutex<Vec<ApplicationCommandRequestEvent>>>,
        cancellations: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingEmitter {
        fn requests(&self) -> Vec<ApplicationCommandRequestEvent> {
            self.requests.lock().expect("test request lock").clone()
        }
    }

    impl ApplicationCommandEventEmitter for RecordingEmitter {
        fn emit_application_command_request(
            &self,
            event: ApplicationCommandRequestEvent,
        ) -> Result<(), AppError> {
            self.requests.lock().expect("test request lock").push(event);
            Ok(())
        }

        fn emit_application_command_cancel(&self, request_id: String) -> Result<(), AppError> {
            self.cancellations
                .lock()
                .expect("test cancel lock")
                .push(request_id);
            Ok(())
        }
    }

    fn test_broker() -> (McpCommandBroker<RecordingEmitter>, RecordingEmitter) {
        let emitter = RecordingEmitter::default();
        let broker = McpCommandBroker::new_for_tests(
            emitter.clone(),
            McpCommandBrokerConfig {
                max_pending: 4,
                max_concurrent: 2,
                ..McpCommandBrokerConfig::default()
            },
        );
        broker
            .register_dispatcher()
            .expect("register test dispatcher");
        (broker, emitter)
    }

    #[test]
    fn catalog_contains_exactly_twenty_two_unique_statsplayground_tools() {
        let catalog = tool_catalog();
        let names: BTreeSet<_> = catalog.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(catalog.len(), 22);
        assert_eq!(names.len(), 22);
        assert!(names
            .iter()
            .all(|name| name.starts_with("statsplayground.")));
    }

    #[test]
    fn catalog_schemas_are_objects() {
        for entry in tool_catalog() {
            assert_eq!(entry.input_schema["type"], "object");
            assert_eq!(entry.output_schema["type"], "object");
        }
    }

    #[tokio::test]
    async fn tool_call_projects_arguments_to_application_command_broker() {
        let (broker, emitter) = test_broker();
        let server = StatsPlaygroundMcpServer::new(broker.clone(), McpAuditLog::default());
        let mut arguments = Map::new();
        arguments.insert("tableId".to_string(), json!("table-1"));
        arguments.insert("control".to_string(), json!({ "requestReason": "test" }));
        let pending = tokio::spawn({
            let server = server.clone();
            async move {
                server
                    .call_catalog_tool(
                        CallToolRequestParams::new("statsplayground.table.describe")
                            .with_arguments(arguments),
                    )
                    .await
            }
        });

        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request = emitter.requests()[0].clone();
        assert_eq!(request.command.command_type, "table.describe");
        assert_eq!(request.command.input, json!({ "tableId": "table-1" }));
        assert_eq!(
            request.command.control,
            Some(json!({ "requestReason": "test" }))
        );

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: request.request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 9,
                    data: json!({ "columns": 3 }),
                    warnings: vec![],
                }),
            })
            .expect("complete application command");
        let response = pending.await.expect("tool task").expect("tool response");
        let CallToolResponse::Complete(response) = response else {
            panic!("expected complete tool response");
        };
        let structured = response
            .structured_content
            .expect("structured tool response");
        assert_eq!(structured["command"], "table.describe");
        assert_eq!(structured["data"], json!({ "columns": 3 }));
    }

    #[tokio::test]
    async fn tool_call_rejects_request_supplied_confirmation_flags_before_dispatch() {
        let (broker, emitter) = test_broker();
        let server = StatsPlaygroundMcpServer::new(broker, McpAuditLog::default());
        let mut arguments = Map::new();
        arguments.insert("overwriteConfirmed".to_string(), json!(true));

        let result = server
            .call_catalog_tool(
                CallToolRequestParams::new("statsplayground.table.export_csv")
                    .with_arguments(arguments),
            )
            .await;

        assert!(result.is_err());
        assert!(emitter.requests().is_empty());
    }
}

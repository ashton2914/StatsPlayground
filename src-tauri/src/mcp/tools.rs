use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
    PaginatedRequestParams, ProgressNotificationParam, ProgressToken, ProtocolVersion,
    ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use schemars::{schema_for, JsonSchema};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

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

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCommandResult<T> {
    pub request_id: String,
    pub command: String,
    pub changed: bool,
    pub project_revision: u64,
    pub data: T,
    pub warnings: Vec<CommandWarning>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationControl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_project_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSummary {
    pub name: String,
    pub created_at: String,
    pub file_name: Option<String>,
    pub has_project_path: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInspectToolInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_capabilities: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCapabilitiesTable {
    pub list: bool,
    pub describe: bool,
    pub describe_preview: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCapabilitiesDocument {
    pub list: bool,
    pub get: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCapabilitiesProject {
    pub inspect: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCapabilities {
    pub table: ProjectCapabilitiesTable,
    pub document: ProjectCapabilitiesDocument,
    pub project: ProjectCapabilitiesProject,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCounts {
    pub tables: u64,
    pub table_transforms: u64,
    pub graphs: u64,
    pub analyses: u64,
    pub tabulates: u64,
    pub reports: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInspectResultData {
    pub project: Option<ProjectSummary>,
    pub dirty: bool,
    pub read_only: bool,
    pub project_revision: u64,
    pub counts: ProjectCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProjectCapabilities>,
}

pub type ProjectInspectToolOutput = ToolCommandResult<ProjectInspectResultData>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSaveToolInput {}

pub type ProjectSaveToolOutput = ToolCommandResult<ProjectSummary>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableListToolInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableListItem {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub row_count: u64,
    pub col_count: u64,
    pub generation: u64,
    pub created_at: String,
    pub updated_at: String,
    pub source_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableListResultData {
    pub items: Vec<TableListItem>,
    pub next_cursor: Option<String>,
}

pub type TableListToolOutput = ToolCommandResult<TableListResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TablePreviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    pub limit: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableDescribeToolInput {
    pub dataset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<TablePreviewRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnFormatInfo {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnDisplayPropsWithoutIndex {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTableColumn {
    pub name: String,
    pub sql_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<ColumnDisplayPropsWithoutIndex>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateManagedTableRequest {
    pub name: String,
    pub columns: Vec<CreateTableColumn>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableCreateToolInput {
    pub request: CreateManagedTableRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<TablePreviewRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableDescribeColumn {
    pub col_index: u64,
    pub col_name: String,
    pub col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ColumnFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TablePreviewCell {
    pub col_index: u64,
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TablePreviewRow {
    pub row_index: u64,
    pub cells: Vec<TablePreviewCell>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TablePreviewResult {
    pub offset: u64,
    pub limit: u64,
    pub total_rows: u64,
    pub rows: Vec<TablePreviewRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableDescribeResultData {
    pub dataset: TableListItem,
    pub generation: u64,
    pub columns: Vec<TableDescribeColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<TablePreviewResult>,
}

pub type TableDescribeToolOutput = ToolCommandResult<TableDescribeResultData>;
pub type TableCreateToolOutput = ToolCommandResult<TableDescribeResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectDocumentKind {
    TableTransform,
    Graph,
    Analysis,
    Tabulate,
    Report,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentListToolInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProjectDocumentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocumentSummary {
    pub kind: ProjectDocumentKind,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocumentListResultData {
    pub items: Vec<ProjectDocumentSummary>,
    pub next_cursor: Option<String>,
}

pub type DocumentListToolOutput = ToolCommandResult<ProjectDocumentListResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentGetToolInput {
    pub kind: ProjectDocumentKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocumentGetResultData {
    pub kind: ProjectDocumentKind,
    pub id: String,
    pub document: ProjectDocument,
}

pub type DocumentGetToolOutput = ToolCommandResult<ProjectDocumentGetResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum ProjectDocument {
    TableTransform(TableTransformDefinition),
    Graph(GraphBuilderItem),
    Analysis(AnalysisDocument),
    Tabulate(TabulateItem),
    Report(ReportItem),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformInputBinding {
    pub role: String,
    pub table_document_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortColumn {
    pub column: String,
    pub direction: SortDirection,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SummaryStatistic {
    N,
    Mean,
    Std,
    Min,
    Max,
    Sum,
    Median,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum JoinType {
    Inner,
    Left,
    Right,
    Full,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TableFilterLogicalOperator {
    And,
    Or,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TableFilterComparisonOperator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TableFilterScalar {
    String { value: String },
    Number { value: String },
    Boolean { value: bool },
    Null,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TableFilterExpression {
    Logical {
        operator: TableFilterLogicalOperator,
        left: Box<TableFilterExpression>,
        right: Box<TableFilterExpression>,
    },
    Not {
        expression: Box<TableFilterExpression>,
    },
    Comparison {
        column: String,
        operator: TableFilterComparisonOperator,
        value: TableFilterScalar,
    },
    IsNull {
        column: String,
        negated: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TableTransformOperation {
    Sort {
        sort_columns: Vec<SortColumn>,
    },
    Subset {
        columns: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<TableFilterExpression>,
    },
    Transpose,
    Stack {
        stack_columns: Vec<String>,
        id_columns: Vec<String>,
    },
    Split {
        split_column: String,
        value_column: String,
        id_columns: Vec<String>,
    },
    Summary {
        statistic_columns: Vec<String>,
        group_columns: Vec<String>,
        statistics: Vec<SummaryStatistic>,
    },
    Join {
        join_type: JoinType,
        left_key: String,
        right_key: String,
    },
    Update {
        match_column: String,
        update_columns: Vec<String>,
    },
    Concatenate {
        source_count: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformDraft {
    pub name: String,
    pub output_name: String,
    pub operation: TableTransformOperation,
    pub input_bindings: Vec<TableTransformInputBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformCreateToolInput {
    pub draft: TableTransformDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformRunToolInput {
    pub transform_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaColumnRequirement {
    pub name: String,
    pub canonical_duckdb_type: String,
    pub required: bool,
    pub required_by_operation_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_extras: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaContract {
    pub schema_fingerprint: String,
    pub columns: Vec<SchemaColumnRequirement>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformInputSlot {
    pub role: String,
    pub schema_contract: SchemaContract,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformOutput {
    pub table_document_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformDefinition {
    pub id: String,
    pub name: String,
    pub format_version: String,
    pub revision: u64,
    pub operation: TableTransformOperation,
    pub input_slots: Vec<TableTransformInputSlot>,
    pub output: TableTransformOutput,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformProjectBinding {
    pub definition_id: String,
    pub definition_revision: u64,
    pub inputs: Vec<TableTransformInputBinding>,
    pub output_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TableTransformRunStatus {
    Succeeded,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaValidationIssue {
    pub column_name: String,
    pub expected_type: String,
    pub actual_type: String,
    pub affected_operation_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaAttributeMismatch {
    pub column_name: String,
    pub attribute_name: String,
    pub expected_value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_value: Option<Value>,
    pub affected_operation_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaValidationReport {
    pub missing_columns: Vec<SchemaValidationIssue>,
    pub type_mismatches: Vec<SchemaValidationIssue>,
    pub attribute_mismatches: Vec<SchemaAttributeMismatch>,
    pub extra_columns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformRoleSchemaReport {
    pub role: String,
    pub report: SchemaValidationReport,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformRunState {
    pub definition_revision: u64,
    pub status: TableTransformRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformBindingState {
    pub definition_id: String,
    pub definition_revision: u64,
    pub inputs: Vec<TableTransformInputBinding>,
    pub output_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<TableTransformRunState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_reports: Option<Vec<TableTransformRoleSchemaReport>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformExecutionResult {
    pub definition_id: String,
    pub status: TableTransformRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<DatasetMeta>,
    pub schema_reports: Vec<TableTransformRoleSchemaReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub binding: TableTransformProjectBinding,
    pub run_state: TableTransformRunState,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableTransformCommandData {
    pub execution: TableTransformExecutionResult,
    pub definition: Option<TableTransformDefinition>,
    pub binding: Option<TableTransformBindingState>,
    pub output_table: Option<TableDescribeResultData>,
    pub target_dataset_generation: Option<u64>,
}

pub type TableTransformCreateToolOutput = ToolCommandResult<TableTransformCommandData>;
pub type TableTransformRunToolOutput = ToolCommandResult<TableTransformCommandData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlCreateTableToolInput {
    pub sql: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlCreateTableResultData {
    pub dataset_id: String,
    pub dataset_name: String,
    pub output_table: Option<TableDescribeResultData>,
}

pub type SqlCreateTableToolOutput = ToolCommandResult<SqlCreateTableResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableExportCsvToolInput {
    pub dataset_id: String,
    pub root_id: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TableExportTargetStatus {
    CreateNew,
    OverwriteExisting,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableExportCsvResultData {
    pub target_status: TableExportTargetStatus,
}

pub type TableExportCsvToolOutput = ToolCommandResult<TableExportCsvResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TabulateStatisticKind {
    Count,
    MissingCount,
    UniqueCount,
    Sum,
    Mean,
    StandardDeviation,
    Variance,
    Minimum,
    Maximum,
    Median,
    Range,
    Quantile,
    RowPercentage,
    ColumnPercentage,
    TotalPercentage,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateStatistic {
    pub id: String,
    pub field: String,
    pub kind: TabulateStatisticKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantile: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateItem {
    pub id: String,
    pub name: String,
    pub source_dataset_id: String,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub statistics: Vec<TabulateStatistic>,
    pub include_row_totals: bool,
    pub include_column_totals: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateRequest {
    pub dataset_id: String,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub statistics: Vec<TabulateStatistic>,
    pub include_row_totals: bool,
    pub include_column_totals: bool,
    pub max_result_cells: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateResult {
    pub row_members: Vec<Vec<Value>>,
    pub column_members: Vec<Vec<Value>>,
    pub statistics: Vec<TabulateStatistic>,
    pub cells: Vec<Option<f64>>,
    pub row_totals: Vec<Option<f64>>,
    pub column_totals: Vec<Option<f64>>,
    pub grand_totals: Vec<Option<f64>>,
    pub cell_count: u64,
    pub limit: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateCreateToolInput {
    pub source_dataset_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateCreateResultData {
    pub item: TabulateItem,
}

pub type TabulateCreateToolOutput = ToolCommandResult<TabulateCreateResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateRunToolInput {
    pub tabulate_id: String,
    pub request: TabulateRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateRunResultData {
    pub tabulate_id: String,
    pub request_fingerprint: String,
    pub source_generation: u64,
    pub completed_at: String,
    pub result: TabulateResult,
    pub cache_valid: bool,
}

pub type TabulateRunToolOutput = ToolCommandResult<TabulateRunResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateToTableToolInput {
    pub tabulate_id: String,
    pub request: TabulateRequest,
    pub table_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabulateToTableResultData {
    pub output_table: Option<TableDescribeResultData>,
    pub reran: bool,
    pub request_fingerprint: String,
    pub source_generation: u64,
}

pub type TabulateToTableToolOutput = ToolCommandResult<TabulateToTableResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphCreateToolInput {
    pub source_dataset_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FieldMeasurementType {
    Continuous,
    Nominal,
    Ordinal,
    Datetime,
    Id,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_id: Option<String>,
    pub name: String,
    pub r#type: FieldMeasurementType,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChartElementKind {
    Points,
    Line,
    Bar,
    Heatmap,
    CorrelationMatrix,
    Histogram,
    NormalCurve,
    Boxplot,
    Smoother,
    Fitline,
    Surface,
    Contour3d,
    Scatter3d,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CorrelationMethod {
    Pearson,
    Spearman,
    Kendall,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartElement {
    pub kind: ChartElementKind,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_method: Option<CorrelationMethod>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FilterLogicalOperator {
    #[serde(rename = "AND")]
    And,
    #[serde(rename = "OR")]
    Or,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphFilterRule {
    Continuous {
        field: FieldRef,
        min: Option<f64>,
        max: Option<f64>,
    },
    Categorical {
        field: FieldRef,
        selected: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude: Option<bool>,
    },
    Date {
        field: FieldRef,
        start: Option<String>,
        end: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphFilterRuleItem {
    pub id: String,
    pub op: FilterLogicalOperator,
    pub rule: GraphFilterRule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceLineStyle {
    Solid,
    Dashed,
    Dotted,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceLine {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub label: String,
    pub style: ReferenceLineStyle,
    pub color: String,
    pub width: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AxisConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick_interval: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inverse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minor_tick_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_axis_line: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick_position: Option<String>,
    #[serde(flatten)]
    pub extras: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph2dState {
    pub encoding: BTreeMap<String, FieldRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transposed: Option<bool>,
    pub multi_x: Vec<FieldRef>,
    pub multi_y: Vec<FieldRef>,
    pub elements: Vec<ChartElement>,
    pub smoother_lambda: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_styles: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_groups: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_lines_y: Option<Vec<ReferenceLine>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_lines_x: Option<Vec<ReferenceLine>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_spec_lines_y: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_spec_lines_x: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_spec_lines: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_axis: Option<AxisConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_axis: Option<AxisConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph3dState {
    pub encoding: BTreeMap<String, FieldRef>,
    pub elements: Vec<ChartElement>,
    pub smoother_lambda: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_styles: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_groups: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultivariateGraphState {
    pub columns: Vec<FieldRef>,
    pub chart_type: String,
    pub correlation_method: CorrelationMethod,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphModeStates {
    pub two_d: Graph2dState,
    pub three_d: Graph3dState,
    pub multivariate: MultivariateGraphState,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphSampling {
    Full,
    Sample { size: u64, seed: u64 },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GraphBuilderMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
    Multivariate,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphBuilderItem {
    pub id: String,
    pub name: String,
    pub source_dataset_id: String,
    pub mode: GraphBuilderMode,
    pub mode_states: GraphModeStates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling: Option<GraphSampling>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_theme_slots: Option<BTreeMap<String, BTreeMap<String, u64>>>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphUpdateToolInput {
    pub graph_id: String,
    pub expected_document_revision: u64,
    pub definition: GraphBuilderItem,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphCommandResultData {
    pub item: GraphBuilderItem,
    pub document_revision: u64,
}

pub type GraphCreateToolOutput = ToolCommandResult<GraphCommandResultData>;
pub type GraphUpdateToolOutput = ToolCommandResult<GraphCommandResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedGraphConfig {
    pub mode: GraphBuilderMode,
    pub mode_states: GraphModeStates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling: Option<GraphSampling>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_theme_slots: Option<BTreeMap<String, BTreeMap<String, u64>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Vec<GraphFilterRuleItem>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpecLimitsOverride {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DistributionFitKind {
    Normal,
    Lognormal,
    Exponential,
    Gamma,
    Weibull,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisConfig {
    pub confidence_level: f64,
    pub spec_limits: BTreeMap<String, SpecLimitsOverride>,
    pub fit_distributions: Vec<DistributionFitKind>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionGraphs {
    pub overview: EmbeddedGraphConfig,
    pub box_plot: EmbeddedGraphConfig,
    pub ecdf: EmbeddedGraphConfig,
    pub normal_quantile: EmbeddedGraphConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisCreateDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub responses: Vec<FieldRef>,
    pub weight: Option<FieldRef>,
    pub frequency: Option<FieldRef>,
    pub by: Vec<FieldRef>,
    pub nested_subgroup: Option<FieldRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<DistributionAnalysisConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphs: Option<DistributionGraphs>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisUpdateDraft {
    pub responses: Vec<FieldRef>,
    pub weight: Option<FieldRef>,
    pub frequency: Option<FieldRef>,
    pub by: Vec<FieldRef>,
    pub nested_subgroup: Option<FieldRef>,
    pub analysis: DistributionAnalysisConfig,
    pub graphs: DistributionGraphs,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisCreateDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub response: FieldRef,
    pub factor: FieldRef,
    pub confidence_level: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<EmbeddedGraphConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisUpdateDraft {
    pub response: FieldRef,
    pub factor: FieldRef,
    pub confidence_level: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<EmbeddedGraphConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FitModelConstruct {
    Manual,
    FullFactorial,
    FactorialToDegree { degree: u64 },
    ResponseSurface,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FitModelTerm {
    Main {
        column_names: Vec<String>,
    },
    Interaction {
        column_names: Vec<String>,
    },
    Power {
        column_names: Vec<String>,
        exponent: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FitModelCenteringMethod {
    None,
    Mean,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisCreateDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub response: FieldRef,
    pub construct: FitModelConstruct,
    pub terms: Vec<FitModelTerm>,
    pub centering_method: FitModelCenteringMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_level: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisUpdateDraft {
    pub response: FieldRef,
    pub construct: FitModelConstruct,
    pub terms: Vec<FitModelTerm>,
    pub centering_method: FitModelCenteringMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_level: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "layout",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HypothesisTestRoles {
    Long {
        response: FieldRef,
        condition: FieldRef,
        subject: Option<FieldRef>,
    },
    Wide {
        measurements: Vec<FieldRef>,
        subject: Option<FieldRef>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestMethodId {
    StudentTwoSampleT,
    WelchTwoSampleT,
    MannWhitneyU,
    OneWayAnova,
    WelchAnova,
    KruskalWallis,
    PairedT,
    WilcoxonSignedRank,
    RandomizedBlockAnova,
    Friedman,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestManualSelection {
    pub method_id: HypothesisTestMethodId,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestStudyDesign {
    Independent,
    PairedOrBlocked,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestSelectionMode {
    Automatic,
    Guided,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestAlternative {
    TwoSided,
    Less,
    Greater,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestPostHoc {
    Automatic,
    Off,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisDefinition {
    pub kind: String,
    pub roles: HypothesisTestRoles,
    pub study_design: HypothesisTestStudyDesign,
    pub selection_mode: HypothesisTestSelectionMode,
    pub manual_selection: Option<HypothesisTestManualSelection>,
    pub alternative: HypothesisTestAlternative,
    pub alpha: f64,
    pub confidence_level: f64,
    pub level_order: Vec<String>,
    pub reference_level: Option<String>,
    pub post_hoc: HypothesisTestPostHoc,
    pub selector_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestResultTab {
    Results,
    Diagnostics,
    Audit,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestCollapsedSection {
    MethodEvidence,
    Sensitivity,
    PostHoc,
    Exclusions,
    Audit,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestGraphPresentation {
    pub show_raw_data: bool,
    pub show_intervals: bool,
    pub show_diagnostics: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestTableSort {
    pub key: String,
    pub direction: SortDirection,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisPresentation {
    pub schema_version: u64,
    pub layout: String,
    pub active_result_tab: HypothesisTestResultTab,
    pub collapsed_sections: Vec<HypothesisTestCollapsedSection>,
    pub graphs: HypothesisTestGraphPresentation,
    pub table_sort: Option<HypothesisTestTableSort>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisCreateDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub definition: HypothesisTestAnalysisDefinition,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisUpdateDraft {
    pub definition: HypothesisTestAnalysisDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<HypothesisTestAnalysisPresentation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisCreateInput {
    pub source_dataset_id: String,
    pub draft: DistributionAnalysisCreateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisCreateInput {
    pub source_dataset_id: String,
    pub draft: FitYByXAnalysisCreateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisCreateInput {
    pub source_dataset_id: String,
    pub draft: FitModelAnalysisCreateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisCreateInput {
    pub source_dataset_id: String,
    pub draft: HypothesisTestAnalysisCreateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "analysisKind", rename_all = "camelCase")]
pub enum AnalysisCreateToolInput {
    Distribution(DistributionAnalysisCreateInput),
    FitYByX(FitYByXAnalysisCreateInput),
    FitModel(FitModelAnalysisCreateInput),
    HypothesisTest(HypothesisTestAnalysisCreateInput),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisUpdateInput {
    pub analysis_id: String,
    pub expected_config_revision: u64,
    pub draft: DistributionAnalysisUpdateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisUpdateInput {
    pub analysis_id: String,
    pub expected_config_revision: u64,
    pub draft: FitYByXAnalysisUpdateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisUpdateInput {
    pub analysis_id: String,
    pub expected_config_revision: u64,
    pub draft: FitModelAnalysisUpdateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisTestAnalysisUpdateInput {
    pub analysis_id: String,
    pub expected_config_revision: u64,
    pub draft: HypothesisTestAnalysisUpdateDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "analysisKind", rename_all = "camelCase")]
pub enum AnalysisUpdateToolInput {
    Distribution(DistributionAnalysisUpdateInput),
    FitYByX(FitYByXAnalysisUpdateInput),
    FitModel(FitModelAnalysisUpdateInput),
    HypothesisTest(HypothesisTestAnalysisUpdateInput),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FitYByXPersonality {
    Oneway,
    Bivariate,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisDefinition {
    pub kind: String,
    pub responses: Vec<FieldRef>,
    pub weight: Option<FieldRef>,
    pub frequency: Option<FieldRef>,
    pub by: Vec<FieldRef>,
    pub nested_subgroup: Option<FieldRef>,
    pub analysis: DistributionAnalysisConfig,
    pub graphs: DistributionGraphs,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisDefinition {
    pub kind: String,
    pub response: FieldRef,
    pub factor: FieldRef,
    pub personality: FitYByXPersonality,
    pub confidence_level: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelLoadIssue {
    pub code: String,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisDefinition {
    pub kind: String,
    pub response: FieldRef,
    pub construct: FitModelConstruct,
    pub terms: Vec<FitModelTerm>,
    pub centering_method: FitModelCenteringMethod,
    pub confidence_level: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_issue: Option<FitModelLoadIssue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum AnalysisDefinition {
    Distribution(DistributionAnalysisDefinition),
    FitYByX(FitYByXAnalysisDefinition),
    FitModel(FitModelAnalysisDefinition),
    HypothesisTest(HypothesisTestAnalysisDefinition),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionAnalysisPresentation {
    pub schema_version: u64,
    pub layout: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitYByXAnalysisPresentation {
    pub schema_version: u64,
    pub layout: String,
    pub graph: EmbeddedGraphConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitModelAnalysisPresentation {
    pub schema_version: u64,
    pub layout: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum AnalysisPresentation {
    Distribution(DistributionAnalysisPresentation),
    FitYByX(FitYByXAnalysisPresentation),
    FitModel(FitModelAnalysisPresentation),
    HypothesisTest(HypothesisTestAnalysisPresentation),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisSource {
    pub dataset_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisDocument {
    pub schema_version: u64,
    pub document_type: String,
    pub id: String,
    pub name: String,
    pub analysis_kind: String,
    pub config_revision: u64,
    pub source: AnalysisSource,
    pub definition: AnalysisDefinition,
    pub presentation: AnalysisPresentation,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisCommandResultData {
    pub item: AnalysisDocument,
}

pub type AnalysisCreateToolOutput = ToolCommandResult<AnalysisCommandResultData>;
pub type AnalysisUpdateToolOutput = ToolCommandResult<AnalysisCommandResultData>;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRunToolInput {
    pub analysis_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetMeta {
    pub id: String,
    pub name: String,
    pub source_path: Option<String>,
    pub source_type: String,
    pub row_count: u64,
    pub col_count: u64,
    pub generation: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisKind {
    Distribution,
    FitYByX,
    FitModel,
    HypothesisTest,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AnalysisExecutionState {
    Idle,
    Loading {
        analysis_kind: AnalysisKind,
        analysis_id: String,
        dataset_id: String,
        config_revision: u64,
        request: Option<BTreeMap<String, Value>>,
    },
    Success {
        analysis_kind: AnalysisKind,
        analysis_id: String,
        dataset_id: String,
        config_revision: u64,
        request: BTreeMap<String, Value>,
        result: BTreeMap<String, Value>,
    },
    Error {
        analysis_kind: AnalysisKind,
        analysis_id: String,
        dataset_id: String,
        config_revision: u64,
        request: Option<BTreeMap<String, Value>>,
        error: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRunResultData {
    pub item: AnalysisDocument,
    pub definition: AnalysisDefinition,
    pub dataset: DatasetMeta,
    pub state: AnalysisExecutionState,
}

pub type AnalysisRunToolOutput = ToolCommandResult<AnalysisRunResultData>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportCreateToolInput {}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportUpdateToolInput {
    pub report_id: String,
    pub expected_document_revision: u64,
    pub markdown: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportItem {
    pub schema_version: u64,
    pub id: String,
    pub name: String,
    pub markdown: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportCommandResultData {
    pub item: ReportItem,
    pub document_revision: u64,
}

pub type ReportCreateToolOutput = ToolCommandResult<ReportCommandResultData>;
pub type ReportUpdateToolOutput = ToolCommandResult<ReportCommandResultData>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotCreateToolInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotCreateResultData {
    pub snapshot_id: Option<String>,
    pub snapshot_name: Option<String>,
    pub created_at: Option<String>,
}

pub type SnapshotCreateToolOutput = ToolCommandResult<SnapshotCreateResultData>;

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
        context: Option<RequestContext<RoleServer>>,
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
        input = validate_tool_input(entry.command, input)?;
        let control = match control {
            Some(control) => Some(normalize_json::<MutationControl>(control)?),
            None => None,
        };
        let envelope = ApplicationCommandEnvelope {
            command_type: entry.command.to_string(),
            input,
            control,
        };
        let request_id = format!("mcp-{}", Uuid::new_v4());
        let _ = self.audit_log.push(McpAuditEntry {
            request_id: request_id.clone(),
            timestamp: current_timestamp(),
            tool: entry.name.clone(),
            status: "queued".to_string(),
            duration_ms: None,
            error_code: None,
        });
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();
        let cancellation_task = context.as_ref().map(|context| {
            let request_cancellation = context.ct.clone();
            let token = token.clone();
            tokio::spawn(async move {
                request_cancellation.cancelled().await;
                token.cancel();
            })
        });
        let progress_task = context.as_ref().and_then(|context| {
            let progress_token = context.meta.get_progress_token()?;
            let peer = context.peer.clone();
            Some(tokio::spawn(async move {
                let mut sequence = 0.0;
                while let Some(progress) = progress_rx.recv().await {
                    sequence += 1.0;
                    let params = progress_notification(progress_token.clone(), progress, sequence);
                    if peer.notify_progress(params).await.is_err() {
                        break;
                    }
                }
            }))
        });
        let result = self
            .broker
            .dispatch_with_request_id(
                request_id.clone(),
                envelope,
                TOOL_TIMEOUT,
                progress_tx,
                token,
            )
            .await;
        if let Some(task) = cancellation_task {
            task.abort();
        }
        if let Some(task) = progress_task {
            let _ = task.await;
        }
        match result {
            Ok(response) => {
                let structured = sanitize_value(
                    serialize_tool_output(entry.command, response)
                        .map_err(|error| McpError::internal_error(error.to_string(), None))?,
                );
                let _ = self.audit_log.push(McpAuditEntry {
                    request_id: structured["requestId"]
                        .as_str()
                        .unwrap_or(&request_id)
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
                let request_id = command_error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("requestId"))
                    .and_then(Value::as_str)
                    .unwrap_or(&request_id)
                    .to_string();
                let structured = sanitize_value(json!({
                    "requestId": request_id,
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
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        self.call_catalog_tool(request, Some(context)).await
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

fn normalize_json<T>(value: Value) -> Result<Value, McpError>
where
    T: DeserializeOwned + Serialize,
{
    let decoded = serde_json::from_value::<T>(value)
        .map_err(|error| McpError::invalid_params(format!("invalid tool input: {error}"), None))?;
    serde_json::to_value(decoded)
        .map_err(|error| McpError::invalid_params(format!("invalid tool input: {error}"), None))
}

fn validate_tool_input(command: &str, value: Value) -> Result<Value, McpError> {
    match command {
        "project.inspect" => normalize_json::<ProjectInspectToolInput>(value),
        "project.save" => normalize_json::<ProjectSaveToolInput>(value),
        "table.list" => normalize_json::<TableListToolInput>(value),
        "table.describe" => normalize_json::<TableDescribeToolInput>(value),
        "document.list" => normalize_json::<DocumentListToolInput>(value),
        "document.get" => normalize_json::<DocumentGetToolInput>(value),
        "table.create" => normalize_json::<TableCreateToolInput>(value),
        "tableTransform.create" => normalize_json::<TableTransformCreateToolInput>(value),
        "tableTransform.run" => normalize_json::<TableTransformRunToolInput>(value),
        "sql.createTable" => normalize_json::<SqlCreateTableToolInput>(value),
        "table.exportCsv" => normalize_json::<TableExportCsvToolInput>(value),
        "tabulate.create" => normalize_json::<TabulateCreateToolInput>(value),
        "tabulate.run" => normalize_json::<TabulateRunToolInput>(value),
        "tabulate.exportTable" => normalize_json::<TabulateToTableToolInput>(value),
        "graph.create" => normalize_json::<GraphCreateToolInput>(value),
        "graph.update" => normalize_json::<GraphUpdateToolInput>(value),
        "analysis.create" => normalize_json::<AnalysisCreateToolInput>(value),
        "analysis.update" => normalize_json::<AnalysisUpdateToolInput>(value),
        "analysis.run" => normalize_json::<AnalysisRunToolInput>(value),
        "report.create" => normalize_json::<ReportCreateToolInput>(value),
        "report.update" => normalize_json::<ReportUpdateToolInput>(value),
        "snapshot.create" => normalize_json::<SnapshotCreateToolInput>(value),
        _ => Ok(value),
    }
}

fn serialize_output<T>(
    command: &str,
    response: crate::models::mcp::McpCommandResponse,
) -> Result<Value, AppError>
where
    T: DeserializeOwned + Serialize,
{
    let warnings = response
        .warnings
        .into_iter()
        .map(|warning| CommandWarning {
            code: warning.code,
            message: warning.message,
        })
        .collect();
    let data = serde_json::from_value::<T>(response.data).map_err(|error| {
        AppError::Stats(format!("invalid response payload for {command}: {error}"))
    })?;
    serde_json::to_value(ToolCommandResult {
        request_id: response.request_id,
        command: command.to_string(),
        changed: response.changed,
        project_revision: response.project_revision,
        data,
        warnings,
    })
    .map_err(|error| {
        AppError::Stats(format!(
            "failed to encode MCP response for {command}: {error}"
        ))
    })
}

fn serialize_tool_output(
    command: &str,
    response: crate::models::mcp::McpCommandResponse,
) -> Result<Value, AppError> {
    match command {
        "project.inspect" => serialize_output::<ProjectInspectResultData>(command, response),
        "project.save" => serialize_output::<ProjectSummary>(command, response),
        "table.list" => serialize_output::<TableListResultData>(command, response),
        "table.describe" | "table.create" => {
            serialize_output::<TableDescribeResultData>(command, response)
        }
        "document.list" => serialize_output::<ProjectDocumentListResultData>(command, response),
        "document.get" => serialize_output::<ProjectDocumentGetResultData>(command, response),
        "tableTransform.create" | "tableTransform.run" => {
            serialize_output::<TableTransformCommandData>(command, response)
        }
        "sql.createTable" => serialize_output::<SqlCreateTableResultData>(command, response),
        "table.exportCsv" => serialize_output::<TableExportCsvResultData>(command, response),
        "tabulate.create" => serialize_output::<TabulateCreateResultData>(command, response),
        "tabulate.run" => serialize_output::<TabulateRunResultData>(command, response),
        "tabulate.exportTable" => serialize_output::<TabulateToTableResultData>(command, response),
        "graph.create" | "graph.update" => {
            serialize_output::<GraphCommandResultData>(command, response)
        }
        "analysis.create" | "analysis.update" => {
            serialize_output::<AnalysisCommandResultData>(command, response)
        }
        "analysis.run" => serialize_output::<AnalysisRunResultData>(command, response),
        "report.create" | "report.update" => {
            serialize_output::<ReportCommandResultData>(command, response)
        }
        "snapshot.create" => serialize_output::<SnapshotCreateResultData>(command, response),
        other => Err(AppError::Stats(format!(
            "unsupported MCP command output contract: {other}"
        ))),
    }
}

fn schema_value<T: JsonSchema>() -> Value {
    let schema =
        serde_json::to_value(schema_for!(T)).unwrap_or_else(|_| json!({ "type": "object" }));
    let definitions = schema
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut expanded = expand_schema_refs(&schema, &definitions, &mut Vec::new());
    if let Some(object) = expanded.as_object_mut() {
        object.remove("$schema");
        if !definitions.is_empty() {
            object.insert("$defs".to_string(), Value::Object(definitions));
        }
        object
            .entry("type".to_string())
            .or_insert_with(|| json!("object"));
    }
    expanded
}

fn expand_schema_refs(
    schema: &Value,
    definitions: &Map<String, Value>,
    expanding: &mut Vec<String>,
) -> Value {
    match schema {
        Value::Object(object) => {
            let definition_name = object
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| reference.strip_prefix("#/$defs/"));
            if let Some(definition_name) = definition_name {
                if let Some(definition) = definitions.get(definition_name) {
                    if expanding.iter().any(|name| name == definition_name) {
                        return schema.clone();
                    }
                    expanding.push(definition_name.to_string());
                    let expanded = expand_schema_refs(definition, definitions, expanding);
                    expanding.pop();
                    return expanded;
                }
            }
            Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| key.as_str() != "$defs")
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            expand_schema_refs(value, definitions, expanding),
                        )
                    })
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| expand_schema_refs(value, definitions, expanding))
                .collect(),
        ),
        _ => schema.clone(),
    }
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
        || is_windows_absolute_path(text)
    {
        "[redacted]".to_string()
    } else {
        text.to_string()
    }
}

fn is_windows_absolute_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn current_timestamp() -> String {
    format!("{:?}", std::time::SystemTime::now())
}

fn progress_notification(
    progress_token: ProgressToken,
    progress: crate::models::mcp::ApplicationCommandProgress,
    sequence: f64,
) -> ProgressNotificationParam {
    let message = progress.message.unwrap_or(progress.stage);
    match progress.percent {
        Some(percent) => ProgressNotificationParam::new(progress_token, percent.clamp(0.0, 100.0))
            .with_total(100.0)
            .with_message(message),
        None => ProgressNotificationParam::new(progress_token, sequence).with_message(message),
    }
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

    fn find_schema_property<'a>(schema: &'a Value, property: &str) -> Option<&'a Value> {
        match schema {
            Value::Object(object) => object
                .get("properties")
                .and_then(Value::as_object)
                .and_then(|properties| properties.get(property))
                .or_else(|| {
                    object
                        .iter()
                        .filter(|(key, _)| key.as_str() != "$defs")
                        .find_map(|(_, value)| find_schema_property(value, property))
                }),
            Value::Array(values) => values
                .iter()
                .find_map(|value| find_schema_property(value, property)),
            _ => None,
        }
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
            assert_eq!(
                entry.input_schema["type"], "object",
                "{} input schema: {}",
                entry.name, entry.input_schema
            );
            assert_eq!(
                entry.output_schema["type"], "object",
                "{} output schema: {}",
                entry.name, entry.output_schema
            );
        }
    }

    #[test]
    fn table_create_schema_is_typed_and_rejects_unknown_top_level_fields() {
        let entry = tool_catalog()
            .into_iter()
            .find(|entry| entry.name == "statsplayground.table.create")
            .expect("table.create entry");

        assert_eq!(entry.input_schema["required"], json!(["request"]));
        assert_eq!(
            entry.input_schema["properties"]["request"]["required"],
            json!(["name", "columns", "rows"])
        );
        assert_eq!(
            entry.input_schema["properties"]["request"]["properties"]["columns"]["items"]
                ["required"],
            json!(["name", "sqlType"])
        );
        let currency_schema = find_schema_property(&entry.input_schema, "currency")
            .expect("currency display property schema");
        assert!(
            currency_schema["type"] == json!("string")
                || currency_schema["type"]
                    .as_array()
                    .is_some_and(|types| types.contains(&json!("string")))
                || currency_schema["anyOf"]
                    .as_array()
                    .is_some_and(|variants| variants
                        .iter()
                        .any(|variant| variant["type"] == "string")),
            "currency schema: {currency_schema}"
        );

        let invalid = serde_json::from_value::<TableCreateToolInput>(json!({
            "request": {
                "name": "Example",
                "columns": [],
                "rows": []
            },
            "unexpected": true
        }));
        assert!(
            invalid.is_err(),
            "flattened catch-all input accepted unexpected fields"
        );
    }

    #[test]
    fn project_save_rejects_save_as_paths() {
        assert!(serde_json::from_value::<ProjectSaveToolInput>(json!({})).is_ok());
        assert!(serde_json::from_value::<ProjectSaveToolInput>(json!({
            "filePath": "exports/project.spprj"
        }))
        .is_err());
    }

    #[test]
    fn sanitizer_redacts_windows_absolute_paths() {
        assert_eq!(sanitize_text(r"C:\Users\person\data.csv"), "[redacted]");
        assert_eq!(sanitize_text("relative/data.csv"), "relative/data.csv");
    }

    #[test]
    fn analysis_create_schema_is_discriminated_by_kind() {
        let entry = tool_catalog()
            .into_iter()
            .find(|entry| entry.name == "statsplayground.analysis.create")
            .expect("analysis.create entry");

        let variants = entry.input_schema["oneOf"]
            .as_array()
            .expect("analysis create oneOf variants");
        assert_eq!(variants.len(), 4);
        assert!(variants.iter().any(|variant| {
            variant["properties"]["analysisKind"]["const"] == json!("distribution")
                && variant["required"]
                    .as_array()
                    .is_some_and(|required| required.contains(&json!("draft")))
        }));

        let invalid = serde_json::from_value::<AnalysisCreateToolInput>(json!({
            "analysisKind": "distribution",
            "sourceDatasetId": "dataset-1"
        }));
        assert!(
            invalid.is_err(),
            "analysis.create accepted a missing draft payload"
        );
    }

    #[test]
    fn table_describe_output_schema_is_family_specific() {
        let entry = tool_catalog()
            .into_iter()
            .find(|entry| entry.name == "statsplayground.table.describe")
            .expect("table.describe entry");

        assert_eq!(
            entry.output_schema["properties"]["data"]["required"],
            json!(["dataset", "generation", "columns"])
        );
        let cells_schema = find_schema_property(&entry.output_schema, "cells")
            .expect("table preview cells schema");
        assert_eq!(
            cells_schema["items"]["required"],
            json!(["colIndex", "value"])
        );
    }

    #[test]
    fn transform_and_graph_inputs_publish_concrete_domain_schemas() {
        let catalog = tool_catalog();
        let transform = catalog
            .iter()
            .find(|entry| entry.name == "statsplayground.table.transform.create")
            .expect("table transform create entry");
        let operation = find_schema_property(&transform.input_schema, "operation")
            .expect("transform operation schema");
        assert!(operation["oneOf"].as_array().is_some_and(|variants| {
            variants
                .iter()
                .any(|variant| variant["properties"]["kind"]["const"] == json!("sort"))
        }));

        let graph = catalog
            .iter()
            .find(|entry| entry.name == "statsplayground.graph.update")
            .expect("graph update entry");
        let definition = find_schema_property(&graph.input_schema, "definition")
            .expect("graph definition schema");
        assert_eq!(
            definition["required"],
            json!([
                "id",
                "name",
                "sourceDatasetId",
                "mode",
                "modeStates",
                "createdAt"
            ])
        );
    }

    #[tokio::test]
    async fn tool_call_projects_arguments_to_application_command_broker() {
        let (broker, emitter) = test_broker();
        let audit_log = McpAuditLog::default();
        let server = StatsPlaygroundMcpServer::new(broker.clone(), audit_log.clone());
        let mut arguments = Map::new();
        arguments.insert("datasetId".to_string(), json!("table-1"));
        arguments.insert(
            "control".to_string(),
            json!({ "expectedProjectRevision": 8 }),
        );
        let pending = tokio::spawn({
            let server = server.clone();
            async move {
                server
                    .call_catalog_tool(
                        CallToolRequestParams::new("statsplayground.table.describe")
                            .with_arguments(arguments),
                        None,
                    )
                    .await
            }
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while emitter.requests().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("tool request dispatch");
        let request = emitter.requests()[0].clone();
        assert_eq!(request.command.command_type, "table.describe");
        assert_eq!(request.command.input, json!({ "datasetId": "table-1" }));
        assert_eq!(
            request.command.control,
            Some(json!({ "expectedProjectRevision": 8 }))
        );

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: request.request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 9,
                    data: json!({
                        "dataset": {
                            "id": "table-1",
                            "name": "Example",
                            "sourceType": "managed",
                            "rowCount": 0,
                            "colCount": 0,
                            "generation": 1,
                            "createdAt": "2026-09-16T00:00:00Z",
                            "updatedAt": "2026-09-16T00:00:00Z",
                            "sourceName": null
                        },
                        "generation": 1,
                        "columns": []
                    }),
                    warnings: vec![],
                }),
            })
            .expect("complete application command");
        let response = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("tool response completion")
            .expect("tool task")
            .expect("tool response");
        let CallToolResponse::Complete(response) = response else {
            panic!("expected complete tool response");
        };
        let structured = response
            .structured_content
            .expect("structured tool response");
        assert_eq!(structured["command"], "table.describe");
        assert_eq!(structured["data"]["dataset"]["id"], "table-1");
        assert_eq!(structured["data"]["columns"], json!([]));
        assert_eq!(response.is_error, Some(false));
        assert_eq!(response.content.len(), 1);
        let Some(text) = response.content[0].as_text() else {
            panic!("expected text content block");
        };
        let parsed_text: Value = serde_json::from_str(&text.text).expect("json text block");
        assert_eq!(parsed_text, structured);
        let audit_entries = audit_log.list().expect("audit entries");
        assert_eq!(audit_entries.len(), 2);
        assert!(audit_entries
            .iter()
            .all(|entry| entry.request_id == request.request_id));
        assert_eq!(audit_entries[0].status, "queued");
        assert_eq!(audit_entries[1].status, "succeeded");
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
                None,
            )
            .await;

        assert!(result.is_err());
        assert!(emitter.requests().is_empty());
    }

    #[test]
    fn structured_error_response_has_equivalent_json_text_block() {
        let structured = json!({
            "requestId": "mcp-123",
            "code": "execution_failed",
            "message": "Application command failed",
            "retryable": false,
            "details": { "kind": "test" }
        });

        let result = CallToolResult::structured_error(structured.clone());

        assert_eq!(result.structured_content, Some(structured.clone()));
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 1);
        let Some(text) = result.content[0].as_text() else {
            panic!("expected text content block");
        };
        let parsed_text: Value = serde_json::from_str(&text.text).expect("json text block");
        assert_eq!(parsed_text, structured);
    }
}

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::services::spprj_archive::{ProjectDocumentRef, TableColumn};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidParam(message.into())
}

pub const DEFAULT_PROJECT_LINEAGE_GRAPH_ID: &str = "project-lineage";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLineageGraph {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub nodes: Vec<LineageNode>,
    #[serde(default)]
    pub edges: Vec<LineageEdge>,
}

impl Default for ProjectLineageGraph {
    fn default() -> Self {
        Self {
            id: DEFAULT_PROJECT_LINEAGE_GRAPH_ID.to_string(),
            name: String::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }
}

pub fn project_lineage_graph_is_default(graph: &ProjectLineageGraph) -> bool {
    graph.id == DEFAULT_PROJECT_LINEAGE_GRAPH_ID
        && graph.name.is_empty()
        && graph.nodes.is_empty()
        && graph.edges.is_empty()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "nodeType", rename_all = "camelCase")]
pub enum LineageNode {
    Artifact(ArtifactNode),
    Operation(OperationNode),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactNode {
    pub id: String,
    pub document_ref: ProjectDocumentRef,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<String>,
    pub artifact_kind: ArtifactKind,
    pub input_port: LineagePort,
    pub output_port: LineagePort,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialized_by_workflow_run_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationNode {
    pub id: String,
    pub kind: OperationKind,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_ref: Option<ProjectDocumentRef>,
    #[serde(default)]
    pub input_ports: Vec<LineagePort>,
    #[serde(default)]
    pub output_ports: Vec<LineagePort>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineagePort {
    pub id: String,
    pub name: String,
    pub payload_kind: PortPayloadKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum LineageEdgeKind {
    Consumes,
    Produces,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineageEdge {
    pub id: String,
    pub kind: LineageEdgeKind,
    pub source: LineageEndpoint,
    pub target: LineageEndpoint,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineageEndpoint {
    pub node_id: String,
    pub port_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PortPayloadKind {
    Any,
    Table,
    Graph,
    FitYByX,
    Tabulate,
    Snapshot,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    Table,
    Graph,
    FitYByX,
    Tabulate,
    Snapshot,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    Import,
    SqlQuery,
    GraphGeneration,
    FitYByX,
    Tabulate,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LogicalFolderKind {
    Project,
    Workflow,
    WorkflowRun,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalFolder {
    pub id: String,
    pub name: String,
    pub kind: LogicalFolderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub format_version: String,
    pub revision: u64,
    #[serde(default)]
    pub input_slots: Vec<InputSlot>,
    #[serde(default)]
    pub operations: Vec<WorkflowOperationNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub output_declarations: Vec<OutputDeclaration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<WorkflowLayout>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputSlot {
    pub id: String,
    pub name: String,
    pub output_port: WorkflowPort,
    pub schema_contract: SchemaContract,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_document_ref: Option<ProjectDocumentRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOperationNode {
    pub id: String,
    pub kind: OperationKind,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Value>,
    #[serde(default)]
    pub input_ports: Vec<WorkflowPort>,
    #[serde(default)]
    pub output_ports: Vec<WorkflowPort>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPort {
    pub id: String,
    pub name: String,
    pub payload_kind: PortPayloadKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEndpoint {
    pub node_id: String,
    pub port_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowEdgeKind {
    Consumes,
    Produces,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub kind: WorkflowEdgeKind,
    pub source: WorkflowEndpoint,
    pub target: WorkflowEndpoint,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputDeclaration {
    pub id: String,
    pub name: String,
    pub input_port: WorkflowPort,
    pub output_port: WorkflowPort,
    pub source_endpoint: WorkflowEndpoint,
    pub artifact_kind: ArtifactKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLayout {
    #[serde(default)]
    pub node_positions: Vec<WorkflowNodePosition>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodePosition {
    pub node_id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaContract {
    pub schema_fingerprint: String,
    #[serde(default)]
    pub columns: Vec<SchemaColumnRequirement>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumnRequirement {
    pub name: String,
    pub canonical_duckdb_type: String,
    pub required: bool,
    #[serde(default)]
    pub required_by_operation_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaValidationReport {
    #[serde(default)]
    pub missing_columns: Vec<SchemaValidationIssue>,
    #[serde(default)]
    pub type_mismatches: Vec<SchemaValidationIssue>,
    #[serde(default)]
    pub extra_columns: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaValidationIssue {
    pub column_name: String,
    pub expected_type: String,
    pub actual_type: String,
    #[serde(default)]
    pub affected_operation_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInputBinding {
    pub slot_id: String,
    pub table_document_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOutputBinding {
    pub declaration_id: String,
    pub artifact_document_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeRunRecord {
    pub node_id: String,
    pub status: WorkflowRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunError {
    pub code: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub status: WorkflowRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub input_bindings: Vec<WorkflowInputBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_validation_report: Option<SchemaValidationReport>,
    #[serde(default)]
    pub node_results: Vec<WorkflowNodeRunRecord>,
    #[serde(default)]
    pub output_bindings: Vec<WorkflowOutputBinding>,
    #[serde(default)]
    pub errors: Vec<WorkflowRunError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExtractionRequest {
    pub workflow_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub format_version: String,
    pub revision: u64,
    pub graph: ProjectLineageGraph,
    #[serde(default)]
    pub selected_node_ids: Vec<String>,
    #[serde(default)]
    pub selected_edge_ids: Vec<String>,
    #[serde(default)]
    pub table_schemas: Vec<WorkflowSourceTable>,
    #[serde(default)]
    pub operation_column_requirements: Vec<WorkflowOperationInputSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<WorkflowLayout>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSourceTable {
    pub artifact_node_id: String,
    #[serde(default)]
    pub columns: Vec<TableColumn>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOperationInputSchema {
    pub operation_id: String,
    pub input_port_id: String,
    #[serde(default)]
    pub required_column_names: Vec<String>,
}

pub fn extract_workflow(request: WorkflowExtractionRequest) -> Result<WorkflowDefinition, AppError> {
    if request.workflow_id.trim().is_empty() {
        return Err(invalid("workflow id is required"));
    }
    if request.name.trim().is_empty() {
        return Err(invalid("workflow name is required"));
    }
    if request.selected_node_ids.is_empty() {
        return Err(invalid("workflow selection must include at least one node"));
    }

    let graph_index = GraphIndex::build(&request.graph)?;
    let selected_node_ids = unique_non_empty_ids(&request.selected_node_ids, "selected node")?;
    let selected_edge_ids = unique_non_empty_ids(&request.selected_edge_ids, "selected edge")?;

    let mut selected_operations = Vec::new();
    let mut selected_artifacts = Vec::new();

    for node_id in &selected_node_ids {
        match graph_index.node(node_id.as_str()) {
            Some(LineageNodeRef::Operation(operation)) => selected_operations.push(operation),
            Some(LineageNodeRef::Artifact(artifact)) => selected_artifacts.push(artifact),
            None => {
                return Err(invalid(format!(
                    "selected node {} does not exist in the lineage graph",
                    node_id
                )));
            }
        }
    }

    if selected_operations.is_empty() {
        return Err(invalid("workflow selection must include at least one operation"));
    }

    selected_operations.sort_by(|left, right| left.id.cmp(&right.id));
    selected_artifacts.sort_by(|left, right| left.id.cmp(&right.id));

    let mut operation_local_ids = HashMap::new();
    for (index, operation) in selected_operations.iter().enumerate() {
        operation_local_ids.insert(
            operation.id.clone(),
            format!("workflow-operation-{}", index + 1),
        );
    }

    let mut output_local_ids = HashMap::new();
    for (index, artifact) in selected_artifacts.iter().enumerate() {
        output_local_ids.insert(
            artifact.id.clone(),
            format!("workflow-output-{}", index + 1),
        );
    }

    let selected_node_id_set: HashSet<String> = selected_node_ids.iter().cloned().collect();
    let mut selected_internal_edges = Vec::new();
    for edge_id in &selected_edge_ids {
        let edge = graph_index
            .edge(edge_id.as_str())
            .ok_or_else(|| invalid(format!("selected edge {} does not exist in the lineage graph", edge_id)))?;
        if !selected_node_id_set.contains(edge.source.node_id.as_str())
            || !selected_node_id_set.contains(edge.target.node_id.as_str())
        {
            return Err(invalid(format!(
                "selected edge {} must connect only selected nodes",
                edge.id
            )));
        }
        selected_internal_edges.push(edge);
    }

    let table_schemas_by_artifact: HashMap<String, Vec<TableColumn>> = request
        .table_schemas
        .iter()
        .map(|table| (table.artifact_node_id.clone(), table.columns.clone()))
        .collect();
    let requirements_by_binding = build_requirement_map(&request.operation_column_requirements);

    let external_dependencies = collect_external_dependencies(
        &request.graph,
        &selected_node_id_set,
        &graph_index,
    )?;
    let input_slots = build_input_slots(
        &external_dependencies,
        &table_schemas_by_artifact,
        &requirements_by_binding,
        &operation_local_ids,
    )?;

    let input_slot_local_ids: HashMap<String, String> = input_slots
        .iter()
        .map(|slot| (slot.original_artifact_id.clone(), slot.slot.id.clone()))
        .collect();
    let value_remap = build_value_remap(
        &external_dependencies,
        &input_slot_local_ids,
        &selected_artifacts,
        &output_local_ids,
    );

    let operations = selected_operations
        .iter()
        .map(|operation| {
            Ok(WorkflowOperationNode {
                id: operation_local_ids
                    .get(operation.id.as_str())
                    .cloned()
                    .ok_or_else(|| invalid(format!("missing workflow-local id for operation {}", operation.id)))?,
                kind: operation.kind.clone(),
                schema_version: operation.schema_version.clone(),
                configuration: operation
                    .configuration
                    .clone()
                    .map(|value| remap_value_ids(value, &value_remap)),
                input_ports: operation
                    .input_ports
                    .iter()
                    .map(|port| WorkflowPort {
                        id: port.id.clone(),
                        name: port.name.clone(),
                        payload_kind: port.payload_kind.clone(),
                    })
                    .collect(),
                output_ports: operation
                    .output_ports
                    .iter()
                    .map(|port| WorkflowPort {
                        id: port.id.clone(),
                        name: port.name.clone(),
                        payload_kind: port.payload_kind.clone(),
                    })
                    .collect(),
            })
        })
        .collect::<std::result::Result<Vec<_>, AppError>>()?;

    let output_declarations = build_output_declarations(
        &selected_artifacts,
        &selected_internal_edges,
        &operation_local_ids,
        &output_local_ids,
    )?;
    let workflow_edges = build_workflow_edges(
        &input_slots,
        &external_dependencies,
        &selected_internal_edges,
        &operation_local_ids,
        &output_local_ids,
    )?;

    let workflow = WorkflowDefinition {
        id: request.workflow_id,
        name: request.name,
        description: request.description,
        format_version: request.format_version,
        revision: request.revision,
        input_slots: input_slots.into_iter().map(|slot| slot.slot).collect(),
        operations,
        edges: workflow_edges,
        output_declarations,
        layout: request.layout,
    };

    validate_extracted_workflow(&workflow)?;
    Ok(workflow)
}

pub fn canonical_duckdb_type(raw_type: &str) -> String {
    let normalized = raw_type
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();

    match normalized.as_str() {
        "INT" | "INTEGER" | "SIGNED" | "INT4" => "INTEGER".to_string(),
        "BIGINT" | "INT8" | "LONG" => "BIGINT".to_string(),
        "SMALLINT" | "INT2" => "SMALLINT".to_string(),
        "TINYINT" | "INT1" => "TINYINT".to_string(),
        "DOUBLE PRECISION" | "FLOAT8" | "DOUBLE" => "DOUBLE".to_string(),
        "REAL" | "FLOAT4" => "REAL".to_string(),
        "BOOL" | "BOOLEAN" => "BOOLEAN".to_string(),
        "CHARACTER VARYING" | "VARCHAR" | "TEXT" | "STRING" => "VARCHAR".to_string(),
        other => other.to_string(),
    }
}

pub fn schema_fingerprint(columns: &[SchemaColumnRequirement]) -> String {
    let mut pairs = columns
        .iter()
        .map(|column| {
            (
                column.name.clone(),
                canonical_duckdb_type(column.canonical_duckdb_type.as_str()),
            )
        })
        .collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.cmp(right));

    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET_BASIS;
    for (name, data_type) in pairs {
        for byte in name.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(PRIME);
        }
        hash ^= u64::from(0u8);
        hash = hash.wrapping_mul(PRIME);
        for byte in data_type.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(PRIME);
        }
    }

    format!("{hash:016x}")
}

pub fn validate_schema_contract(
    contract: &SchemaContract,
    actual_columns: &[TableColumn],
) -> SchemaValidationReport {
    let mut actual_by_name = HashMap::new();
    for column in actual_columns {
        actual_by_name.insert(column.name.clone(), canonical_duckdb_type(column.col_type.as_str()));
    }

    let mut missing_columns = Vec::new();
    let mut type_mismatches = Vec::new();
    let required_names = contract
        .columns
        .iter()
        .filter(|column| column.required)
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();

    for column in &contract.columns {
        if !column.required {
            continue;
        }

        let expected_type = canonical_duckdb_type(column.canonical_duckdb_type.as_str());
        match actual_by_name.get(column.name.as_str()) {
            None => missing_columns.push(SchemaValidationIssue {
                column_name: column.name.clone(),
                expected_type,
                actual_type: String::new(),
                affected_operation_ids: column.required_by_operation_ids.clone(),
            }),
            Some(actual_type) if actual_type != &expected_type => {
                type_mismatches.push(SchemaValidationIssue {
                    column_name: column.name.clone(),
                    expected_type,
                    actual_type: actual_type.clone(),
                    affected_operation_ids: column.required_by_operation_ids.clone(),
                });
            }
            Some(_) => {}
        }
    }

    let mut extra_columns = actual_columns
        .iter()
        .filter_map(|column| (!required_names.contains(column.name.as_str())).then_some(column.name.clone()))
        .collect::<Vec<_>>();
    extra_columns.sort();

    SchemaValidationReport {
        missing_columns,
        type_mismatches,
        extra_columns,
    }
}

#[derive(Clone)]
struct ExtractedInputSlot {
    original_artifact_id: String,
    slot: InputSlot,
}

#[derive(Clone, Copy)]
struct ExternalDependency<'a> {
    edge: &'a LineageEdge,
    source_artifact: &'a ArtifactNode,
    target_operation: &'a OperationNode,
}

struct GraphIndex<'a> {
    artifacts: HashMap<&'a str, &'a ArtifactNode>,
    operations: HashMap<&'a str, &'a OperationNode>,
    edges: HashMap<&'a str, &'a LineageEdge>,
}

impl<'a> GraphIndex<'a> {
    fn build(graph: &'a ProjectLineageGraph) -> Result<Self, AppError> {
        let mut artifacts = HashMap::new();
        let mut operations = HashMap::new();
        let mut edges = HashMap::new();

        for node in &graph.nodes {
            match node {
                LineageNode::Artifact(artifact) => {
                    if artifacts.insert(artifact.id.as_str(), artifact).is_some() {
                        return Err(invalid(format!("duplicate artifact node id: {}", artifact.id)));
                    }
                }
                LineageNode::Operation(operation) => {
                    if operations.insert(operation.id.as_str(), operation).is_some() {
                        return Err(invalid(format!("duplicate operation node id: {}", operation.id)));
                    }
                }
            }
        }

        for edge in &graph.edges {
            if edges.insert(edge.id.as_str(), edge).is_some() {
                return Err(invalid(format!("duplicate edge id: {}", edge.id)));
            }
        }

        Ok(Self {
            artifacts,
            operations,
            edges,
        })
    }

    fn node(&self, node_id: &str) -> Option<LineageNodeRef<'a>> {
        if let Some(artifact) = self.artifacts.get(node_id) {
            return Some(LineageNodeRef::Artifact(*artifact));
        }

        self.operations
            .get(node_id)
            .copied()
            .map(LineageNodeRef::Operation)
    }

    fn edge(&self, edge_id: &str) -> Option<&'a LineageEdge> {
        self.edges.get(edge_id).copied()
    }

    fn artifact(&self, node_id: &str) -> Option<&'a ArtifactNode> {
        self.artifacts.get(node_id).copied()
    }

    fn operation(&self, node_id: &str) -> Option<&'a OperationNode> {
        self.operations.get(node_id).copied()
    }
}

fn unique_non_empty_ids(values: &[String], label: &str) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for value in values {
        if value.trim().is_empty() {
            return Err(invalid(format!("{} id is required", label)));
        }
        if seen.insert(value.clone()) {
            unique.push(value.clone());
        }
    }
    Ok(unique)
}

fn build_requirement_map(
    requirements: &[WorkflowOperationInputSchema],
) -> HashMap<(String, String), Vec<String>> {
    let mut map = HashMap::new();
    for requirement in requirements {
        let key = (
            requirement.operation_id.clone(),
            requirement.input_port_id.clone(),
        );
        let entry = map.entry(key).or_insert_with(Vec::new);
        for column_name in &requirement.required_column_names {
            if !entry.contains(column_name) {
                entry.push(column_name.clone());
            }
        }
    }
    map
}

fn collect_external_dependencies<'a>(
    graph: &'a ProjectLineageGraph,
    selected_node_ids: &HashSet<String>,
    index: &GraphIndex<'a>,
) -> Result<Vec<ExternalDependency<'a>>, AppError> {
    let mut dependencies = Vec::new();

    for edge in &graph.edges {
        if edge.kind != LineageEdgeKind::Consumes {
            continue;
        }
        if !selected_node_ids.contains(edge.target.node_id.as_str())
            || selected_node_ids.contains(edge.source.node_id.as_str())
        {
            continue;
        }

        let source_artifact = index.artifact(edge.source.node_id.as_str()).ok_or_else(|| {
            invalid(format!(
                "unresolved external dependency: missing artifact node {}",
                edge.source.node_id
            ))
        })?;
        let target_operation = index.operation(edge.target.node_id.as_str()).ok_or_else(|| {
            invalid(format!(
                "unresolved external dependency: missing operation node {}",
                edge.target.node_id
            ))
        })?;
        if source_artifact.artifact_kind != ArtifactKind::Table {
            return Err(invalid(format!(
                "non-table external dependency is not supported for workflow extraction: {}",
                source_artifact.id
            )));
        }

        dependencies.push(ExternalDependency {
            edge,
            source_artifact,
            target_operation,
        });
    }

    dependencies.sort_by(|left, right| {
        left.source_artifact
            .id
            .cmp(&right.source_artifact.id)
            .then(left.target_operation.id.cmp(&right.target_operation.id))
            .then(left.edge.target.port_id.cmp(&right.edge.target.port_id))
    });

    Ok(dependencies)
}

fn build_input_slots(
    dependencies: &[ExternalDependency<'_>],
    table_schemas_by_artifact: &HashMap<String, Vec<TableColumn>>,
    requirements_by_binding: &HashMap<(String, String), Vec<String>>,
    operation_local_ids: &HashMap<String, String>,
) -> Result<Vec<ExtractedInputSlot>, AppError> {
    let mut slot_ids_by_artifact = HashMap::new();
    let mut columns_by_artifact: HashMap<String, HashMap<String, SchemaColumnAccumulator>> =
        HashMap::new();
    let mut slot_names_by_artifact = HashMap::new();

    for dependency in dependencies {
        let artifact_id = dependency.source_artifact.id.clone();
        let slot_index = slot_ids_by_artifact.len() + 1;
        slot_ids_by_artifact
            .entry(artifact_id.clone())
            .or_insert_with(|| format!("workflow-input-{}", slot_index));
        slot_names_by_artifact
            .entry(artifact_id.clone())
            .or_insert_with(|| dependency.source_artifact.name.clone());

        let schema = table_schemas_by_artifact.get(artifact_id.as_str()).ok_or_else(|| {
            invalid(format!(
                "unresolved external dependency: missing source schema for artifact {}",
                artifact_id
            ))
        })?;
        let required_column_names = requirements_by_binding
            .get(&(dependency.target_operation.id.clone(), dependency.edge.target.port_id.clone()))
            .cloned()
            .unwrap_or_default();

        for required_column_name in required_column_names {
            let source_column = schema
                .iter()
                .find(|column| column.name == required_column_name)
                .ok_or_else(|| {
                    invalid(format!(
                        "source table {} is missing required column {}",
                        artifact_id, required_column_name
                    ))
                })?;
            let canonical_type = canonical_duckdb_type(source_column.col_type.as_str());
            let operation_local_id = operation_local_ids
                .get(dependency.target_operation.id.as_str())
                .cloned()
                .ok_or_else(|| {
                    invalid(format!(
                        "missing workflow-local id for operation {}",
                        dependency.target_operation.id
                    ))
                })?;

            let column_entry = columns_by_artifact
                .entry(artifact_id.clone())
                .or_default()
                .entry(required_column_name.clone())
                .or_insert_with(|| SchemaColumnAccumulator {
                    canonical_duckdb_type: canonical_type.clone(),
                    required_by_operation_ids: HashSet::new(),
                });

            if column_entry.canonical_duckdb_type != canonical_type {
                return Err(invalid(format!(
                    "conflicting canonical DuckDB types for required column {} on artifact {}",
                    required_column_name, artifact_id
                )));
            }
            column_entry
                .required_by_operation_ids
                .insert(operation_local_id);
        }
    }

    if slot_ids_by_artifact.is_empty() {
        return Err(invalid(
            "workflow extraction requires at least one external table dependency",
        ));
    }

    let mut artifact_ids = slot_ids_by_artifact.keys().cloned().collect::<Vec<_>>();
    artifact_ids.sort();

    let mut input_slots = Vec::new();
    for artifact_id in artifact_ids {
        let slot_id = slot_ids_by_artifact
            .get(artifact_id.as_str())
            .cloned()
            .ok_or_else(|| invalid(format!("missing slot id for artifact {}", artifact_id)))?;
        let slot_name = slot_names_by_artifact
            .get(artifact_id.as_str())
            .cloned()
            .ok_or_else(|| invalid(format!("missing slot name for artifact {}", artifact_id)))?;
        let output_port = workflow_input_slot_output_port(slot_id.as_str());
        let mut columns = columns_by_artifact
            .remove(artifact_id.as_str())
            .unwrap_or_default()
            .into_iter()
            .map(|(name, accumulator)| {
                let mut required_by_operation_ids =
                    accumulator.required_by_operation_ids.into_iter().collect::<Vec<_>>();
                required_by_operation_ids.sort();
                SchemaColumnRequirement {
                    name,
                    canonical_duckdb_type: accumulator.canonical_duckdb_type,
                    required: true,
                    required_by_operation_ids,
                }
            })
            .collect::<Vec<_>>();
        columns.sort_by(|left, right| left.name.cmp(&right.name));

        input_slots.push(ExtractedInputSlot {
            original_artifact_id: artifact_id,
            slot: InputSlot {
                id: slot_id,
                name: slot_name,
                output_port,
                schema_contract: SchemaContract {
                    schema_fingerprint: schema_fingerprint(&columns),
                    columns,
                },
                source_document_ref: None,
            },
        });
    }

    Ok(input_slots)
}

fn build_value_remap(
    external_dependencies: &[ExternalDependency<'_>],
    input_slot_local_ids: &HashMap<String, String>,
    selected_artifacts: &[&ArtifactNode],
    output_local_ids: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut remap = HashMap::new();

    for dependency in external_dependencies {
        if let Some(local_id) = input_slot_local_ids.get(dependency.source_artifact.id.as_str()) {
            remap.insert(dependency.source_artifact.id.clone(), local_id.clone());
            remap.insert(dependency.source_artifact.document_ref.id.clone(), local_id.clone());
        }
    }

    for artifact in selected_artifacts {
        if let Some(local_id) = output_local_ids.get(artifact.id.as_str()) {
            remap.insert(artifact.id.clone(), local_id.clone());
            remap.insert(artifact.document_ref.id.clone(), local_id.clone());
        }
    }

    remap
}

fn remap_value_ids(value: Value, remap: &HashMap<String, String>) -> Value {
    match value {
        Value::String(string) => remap
            .get(string.as_str())
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::String(string)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|entry| remap_value_ids(entry, remap))
                .collect(),
        ),
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, entry)| (key, remap_value_ids(entry, remap)))
                .collect(),
        ),
        other => other,
    }
}

fn build_output_declarations(
    selected_artifacts: &[&ArtifactNode],
    selected_internal_edges: &[&LineageEdge],
    operation_local_ids: &HashMap<String, String>,
    output_local_ids: &HashMap<String, String>,
) -> Result<Vec<OutputDeclaration>, AppError> {
    let producer_edge_by_artifact = selected_internal_edges
        .iter()
        .filter(|edge| edge.kind == LineageEdgeKind::Produces)
        .map(|edge| (edge.target.node_id.as_str(), *edge))
        .collect::<HashMap<_, _>>();

    let mut declarations = Vec::new();
    for artifact in selected_artifacts {
        let producer_edge = producer_edge_by_artifact.get(artifact.id.as_str()).ok_or_else(|| {
            invalid(format!(
                "selected artifact {} does not have a selected producer edge",
                artifact.id
            ))
        })?;
        let source_operation_id = operation_local_ids
            .get(producer_edge.source.node_id.as_str())
            .cloned()
            .ok_or_else(|| {
                invalid(format!(
                    "selected artifact {} is produced by an unselected operation {}",
                    artifact.id, producer_edge.source.node_id
                ))
            })?;

        declarations.push(OutputDeclaration {
            id: output_local_ids
                .get(artifact.id.as_str())
                .cloned()
                .ok_or_else(|| invalid(format!("missing output id for artifact {}", artifact.id)))?,
            name: artifact.name.clone(),
            input_port: workflow_output_input_port(
                output_local_ids
                    .get(artifact.id.as_str())
                    .ok_or_else(|| invalid(format!("missing output id for artifact {}", artifact.id)))?,
                &artifact.artifact_kind,
            ),
            output_port: workflow_output_output_port(
                output_local_ids
                    .get(artifact.id.as_str())
                    .ok_or_else(|| invalid(format!("missing output id for artifact {}", artifact.id)))?,
                &artifact.artifact_kind,
            ),
            source_endpoint: WorkflowEndpoint {
                node_id: source_operation_id,
                port_id: producer_edge.source.port_id.clone(),
            },
            artifact_kind: artifact.artifact_kind.clone(),
        });
    }

    Ok(declarations)
}

fn build_workflow_edges(
    input_slots: &[ExtractedInputSlot],
    external_dependencies: &[ExternalDependency<'_>],
    selected_internal_edges: &[&LineageEdge],
    operation_local_ids: &HashMap<String, String>,
    output_local_ids: &HashMap<String, String>,
) -> Result<Vec<WorkflowEdge>, AppError> {
    let mut slot_ids_by_artifact = HashMap::new();
    for slot in input_slots {
        slot_ids_by_artifact.insert(slot.original_artifact_id.clone(), slot.slot.id.clone());
    }

    let mut workflow_edges = Vec::new();
    let mut next_index = 1usize;

    for dependency in external_dependencies {
        workflow_edges.push(WorkflowEdge {
            id: format!("workflow-edge-{}", next_index),
            kind: WorkflowEdgeKind::Consumes,
            source: WorkflowEndpoint {
                node_id: slot_ids_by_artifact
                    .get(dependency.source_artifact.id.as_str())
                    .cloned()
                    .ok_or_else(|| {
                        invalid(format!(
                            "missing input slot for external artifact {}",
                            dependency.source_artifact.id
                        ))
                    })?,
                port_id: workflow_input_slot_output_port_id(
                    slot_ids_by_artifact
                        .get(dependency.source_artifact.id.as_str())
                        .ok_or_else(|| {
                            invalid(format!(
                                "missing input slot for external artifact {}",
                                dependency.source_artifact.id
                            ))
                        })?,
                ),
            },
            target: WorkflowEndpoint {
                node_id: operation_local_ids
                    .get(dependency.target_operation.id.as_str())
                    .cloned()
                    .ok_or_else(|| {
                        invalid(format!(
                            "missing workflow-local id for operation {}",
                            dependency.target_operation.id
                        ))
                    })?,
                port_id: dependency.edge.target.port_id.clone(),
            },
        });
        next_index += 1;
    }

    for edge in selected_internal_edges {
        match edge.kind {
            LineageEdgeKind::Consumes => workflow_edges.push(WorkflowEdge {
                id: format!("workflow-edge-{}", next_index),
                kind: WorkflowEdgeKind::Consumes,
                source: WorkflowEndpoint {
                    node_id: output_local_ids
                        .get(edge.source.node_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            invalid(format!(
                                "missing workflow-local output id for artifact {}",
                                edge.source.node_id
                            ))
                        })?,
                        port_id: workflow_output_output_port_id(
                            output_local_ids
                                .get(edge.source.node_id.as_str())
                                .ok_or_else(|| {
                                    invalid(format!(
                                        "missing workflow-local output id for artifact {}",
                                        edge.source.node_id
                                    ))
                                })?,
                        ),
                },
                target: WorkflowEndpoint {
                    node_id: operation_local_ids
                        .get(edge.target.node_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            invalid(format!(
                                "missing workflow-local id for operation {}",
                                edge.target.node_id
                            ))
                        })?,
                    port_id: edge.target.port_id.clone(),
                },
            }),
            LineageEdgeKind::Produces => workflow_edges.push(WorkflowEdge {
                id: format!("workflow-edge-{}", next_index),
                kind: WorkflowEdgeKind::Produces,
                source: WorkflowEndpoint {
                    node_id: operation_local_ids
                        .get(edge.source.node_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            invalid(format!(
                                "missing workflow-local id for operation {}",
                                edge.source.node_id
                            ))
                        })?,
                    port_id: edge.source.port_id.clone(),
                },
                target: WorkflowEndpoint {
                    node_id: output_local_ids
                        .get(edge.target.node_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            invalid(format!(
                                "missing workflow-local output id for artifact {}",
                                edge.target.node_id
                            ))
                        })?,
                        port_id: workflow_output_input_port_id(
                            output_local_ids
                                .get(edge.target.node_id.as_str())
                                .ok_or_else(|| {
                                    invalid(format!(
                                        "missing workflow-local output id for artifact {}",
                                        edge.target.node_id
                                    ))
                                })?,
                        ),
                },
            }),
        }
        next_index += 1;
    }

    Ok(workflow_edges)
}

fn validate_extracted_workflow(workflow: &WorkflowDefinition) -> Result<(), AppError> {
    if workflow.input_slots.is_empty() {
        return Err(invalid("workflow must contain at least one input slot"));
    }

    let mut seen_node_ids = HashSet::new();
    let mut seen_port_ids = HashSet::new();
    let mut input_slot_output_ports = HashMap::new();
    let mut operation_input_ports = HashMap::new();
    let mut operation_output_ports = HashMap::new();
    let mut output_input_ports = HashMap::new();
    let mut output_output_ports = HashMap::new();
    for input_slot in &workflow.input_slots {
        if !seen_node_ids.insert(input_slot.id.as_str()) {
            return Err(invalid(format!("duplicate workflow node id: {}", input_slot.id)));
        }
        register_workflow_boundary_port(
            &input_slot.id,
            &input_slot.output_port,
            PortRole::Output,
            PortPayloadKind::Table,
            &mut seen_port_ids,
            "input slot",
        )?;
        input_slot_output_ports.insert(input_slot.id.as_str(), input_slot.output_port.clone());
    }
    for operation in &workflow.operations {
        if !seen_node_ids.insert(operation.id.as_str()) {
            return Err(invalid(format!("duplicate workflow node id: {}", operation.id)));
        }
        operation_input_ports.insert(
            operation.id.as_str(),
            operation
                .input_ports
                .iter()
                .map(|port| port.id.as_str())
                .collect::<HashSet<_>>(),
        );
        operation_output_ports.insert(
            operation.id.as_str(),
            operation
                .output_ports
                .iter()
                .map(|port| port.id.as_str())
                .collect::<HashSet<_>>(),
        );
    }
    for output in &workflow.output_declarations {
        if !seen_node_ids.insert(output.id.as_str()) {
            return Err(invalid(format!("duplicate workflow node id: {}", output.id)));
        }
        let expected_payload_kind = artifact_kind_to_payload_kind(&output.artifact_kind);
        register_workflow_boundary_port(
            &output.id,
            &output.input_port,
            PortRole::Input,
            expected_payload_kind.clone(),
            &mut seen_port_ids,
            "workflow output",
        )?;
        register_workflow_boundary_port(
            &output.id,
            &output.output_port,
            PortRole::Output,
            expected_payload_kind.clone(),
            &mut seen_port_ids,
            "workflow output",
        )?;
        output_input_ports.insert(output.id.as_str(), output.input_port.clone());
        output_output_ports.insert(output.id.as_str(), output.output_port.clone());
        let output_ports = operation_output_ports
            .get(output.source_endpoint.node_id.as_str())
            .ok_or_else(|| {
                invalid(format!(
                    "output declaration {} references missing operation {}",
                    output.id, output.source_endpoint.node_id
                ))
            })?;
        if !output_ports.contains(output.source_endpoint.port_id.as_str()) {
            return Err(invalid(format!(
                "output declaration {} references missing operation output port {}",
                output.id, output.source_endpoint.port_id
            )));
        }
        let source_payload_kind = workflow_operation_output_payload_kind(
            workflow,
            output.source_endpoint.node_id.as_str(),
            output.source_endpoint.port_id.as_str(),
        )?;
        if !payload_kinds_match(source_payload_kind, output.input_port.payload_kind.clone()) {
            return Err(invalid(format!(
                "output declaration {} has incompatible input payload kind",
                output.id
            )));
        }
    }

    let input_slot_ids = workflow
        .input_slots
        .iter()
        .map(|slot| slot.id.as_str())
        .collect::<HashSet<_>>();
    let output_ids = workflow
        .output_declarations
        .iter()
        .map(|output| output.id.as_str())
        .collect::<HashSet<_>>();
    let operation_ids = workflow
        .operations
        .iter()
        .map(|operation| operation.id.as_str())
        .collect::<HashSet<_>>();

    let mut edge_ids = HashSet::new();
    let mut indegree = seen_node_ids
        .iter()
        .map(|node_id| (*node_id, 0usize))
        .collect::<HashMap<_, _>>();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut undirected: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut producer_counts: HashMap<&str, usize> = HashMap::new();

    for edge in &workflow.edges {
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(invalid(format!("duplicate workflow edge id: {}", edge.id)));
        }

        match edge.kind {
            WorkflowEdgeKind::Consumes => {
                if !operation_ids.contains(edge.target.node_id.as_str()) {
                    return Err(invalid(format!(
                        "workflow consumes edge {} targets missing operation {}",
                        edge.id, edge.target.node_id
                    )));
                }
                let allowed_source = input_slot_ids.contains(edge.source.node_id.as_str())
                    || output_ids.contains(edge.source.node_id.as_str());
                if !allowed_source {
                    return Err(invalid(format!(
                        "workflow consumes edge {} has invalid source {}",
                        edge.id, edge.source.node_id
                    )));
                }
                let source_payload_kind = if input_slot_ids.contains(edge.source.node_id.as_str()) {
                    let source_port = input_slot_output_ports
                        .get(edge.source.node_id.as_str())
                        .ok_or_else(|| {
                            invalid(format!(
                                "workflow consumes edge {} sources missing input slot {}",
                                edge.id, edge.source.node_id
                            ))
                        })?;
                    if edge.source.port_id != source_port.id {
                        return Err(invalid(format!(
                            "workflow consumes edge {} sources missing input slot output port {}",
                            edge.id, edge.source.port_id
                        )));
                    }
                    source_port.payload_kind.clone()
                } else {
                    let source_port = output_output_ports
                        .get(edge.source.node_id.as_str())
                        .ok_or_else(|| {
                            invalid(format!(
                                "workflow consumes edge {} sources missing workflow output {}",
                                edge.id, edge.source.node_id
                            ))
                        })?;
                    if edge.source.port_id != source_port.id {
                        return Err(invalid(format!(
                            "workflow consumes edge {} sources missing workflow output port {}",
                            edge.id, edge.source.port_id
                        )));
                    }
                    source_port.payload_kind.clone()
                };
                let target_ports = operation_input_ports
                    .get(edge.target.node_id.as_str())
                    .ok_or_else(|| {
                        invalid(format!(
                            "workflow consumes edge {} targets missing operation {}",
                            edge.id, edge.target.node_id
                        ))
                    })?;
                if !target_ports.contains(edge.target.port_id.as_str()) {
                    return Err(invalid(format!(
                        "workflow consumes edge {} targets missing input port {}",
                        edge.id, edge.target.port_id
                    )));
                }
                let target_payload_kind = workflow_operation_input_payload_kind(
                    workflow,
                    edge.target.node_id.as_str(),
                    edge.target.port_id.as_str(),
                )?;
                if !payload_kinds_match(source_payload_kind, target_payload_kind) {
                    return Err(invalid(format!(
                        "workflow consumes edge {} has incompatible payload kinds",
                        edge.id
                    )));
                }
            }
            WorkflowEdgeKind::Produces => {
                if !operation_ids.contains(edge.source.node_id.as_str()) {
                    return Err(invalid(format!(
                        "workflow produces edge {} sources missing operation {}",
                        edge.id, edge.source.node_id
                    )));
                }
                if !output_ids.contains(edge.target.node_id.as_str()) {
                    return Err(invalid(format!(
                        "workflow produces edge {} targets missing output {}",
                        edge.id, edge.target.node_id
                    )));
                }
                let source_ports = operation_output_ports
                    .get(edge.source.node_id.as_str())
                    .ok_or_else(|| {
                        invalid(format!(
                            "workflow produces edge {} sources missing operation {}",
                            edge.id, edge.source.node_id
                        ))
                    })?;
                if !source_ports.contains(edge.source.port_id.as_str()) {
                    return Err(invalid(format!(
                        "workflow produces edge {} sources missing output port {}",
                        edge.id, edge.source.port_id
                    )));
                }
                let target_port = output_input_ports
                    .get(edge.target.node_id.as_str())
                    .ok_or_else(|| {
                        invalid(format!(
                            "workflow produces edge {} targets missing workflow output {}",
                            edge.id, edge.target.node_id
                        ))
                    })?;
                if edge.target.port_id != target_port.id {
                    return Err(invalid(format!(
                        "workflow produces edge {} targets missing workflow output input port {}",
                        edge.id, edge.target.port_id
                    )));
                }
                let source_payload_kind = workflow_operation_output_payload_kind(
                    workflow,
                    edge.source.node_id.as_str(),
                    edge.source.port_id.as_str(),
                )?;
                if !payload_kinds_match(source_payload_kind, target_port.payload_kind.clone()) {
                    return Err(invalid(format!(
                        "workflow produces edge {} has incompatible payload kinds",
                        edge.id
                    )));
                }
                *producer_counts.entry(edge.target.node_id.as_str()).or_insert(0) += 1;
            }
        }

        adjacency
            .entry(edge.source.node_id.as_str())
            .or_default()
            .push(edge.target.node_id.as_str());
        *indegree
            .entry(edge.target.node_id.as_str())
            .or_insert(0) += 1;

        undirected
            .entry(edge.source.node_id.as_str())
            .or_default()
            .push(edge.target.node_id.as_str());
        undirected
            .entry(edge.target.node_id.as_str())
            .or_default()
            .push(edge.source.node_id.as_str());
    }

    for output in &workflow.output_declarations {
        if producer_counts.get(output.id.as_str()).copied().unwrap_or_default() != 1 {
            return Err(invalid(format!(
                "workflow output {} must have exactly one producer",
                output.id
            )));
        }
    }

    let mut queue = indegree
        .iter()
        .filter_map(|(node_id, degree)| (*degree == 0).then_some(*node_id))
        .collect::<VecDeque<_>>();
    let mut visited = 0usize;
    let mut indegree_remaining = indegree.clone();
    while let Some(node_id) = queue.pop_front() {
        visited += 1;
        if let Some(neighbors) = adjacency.get(node_id) {
            for neighbor in neighbors {
                let degree = indegree_remaining.get_mut(neighbor).ok_or_else(|| {
                    invalid(format!("missing workflow indegree for node {}", neighbor))
                })?;
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(neighbor);
                }
            }
        }
    }
    if visited != seen_node_ids.len() {
        return Err(invalid("workflow graph contains a cycle"));
    }

    let first_input = workflow
        .input_slots
        .first()
        .ok_or_else(|| invalid("workflow must contain at least one input slot"))?;
    let mut connected_visit = vec![first_input.id.as_str()];
    let mut connected_seen = HashSet::new();
    while let Some(node_id) = connected_visit.pop() {
        if !connected_seen.insert(node_id) {
            continue;
        }
        if let Some(neighbors) = undirected.get(node_id) {
            for neighbor in neighbors {
                connected_visit.push(*neighbor);
            }
        }
    }
    if connected_seen.len() != seen_node_ids.len() {
        return Err(invalid("workflow selection is disconnected"));
    }

    let mut reachable = HashSet::new();
    let mut frontier = workflow
        .input_slots
        .iter()
        .map(|slot| slot.id.as_str())
        .collect::<VecDeque<_>>();
    while let Some(node_id) = frontier.pop_front() {
        if !reachable.insert(node_id) {
            continue;
        }
        if let Some(neighbors) = adjacency.get(node_id) {
            for neighbor in neighbors {
                frontier.push_back(*neighbor);
            }
        }
    }
    for operation in &workflow.operations {
        if !reachable.contains(operation.id.as_str()) {
            return Err(invalid(
                "workflow selection contains an orphan operation that is not reachable from an input slot",
            ));
        }
    }

    Ok(())
}

#[derive(Default)]
struct SchemaColumnAccumulator {
    canonical_duckdb_type: String,
    required_by_operation_ids: HashSet<String>,
}

pub fn validate_lineage_graph(
    graph: &ProjectLineageGraph,
    known_documents: &HashSet<ProjectDocumentRef>,
) -> Result<(), AppError> {
    if graph.id.trim().is_empty() {
        return Err(invalid("lineage graph id is required"));
    }

    let mut node_ids = HashSet::new();
    let mut artifact_nodes: HashMap<&str, &ArtifactNode> = HashMap::new();
    let mut artifact_ports: HashMap<&str, ArtifactPortIndex> = HashMap::new();
    let mut operation_nodes: HashMap<&str, &OperationNode> = HashMap::new();
    let mut operation_ports: HashMap<&str, OperationPortIndex> = HashMap::new();
    let mut seen_port_ids = HashSet::new();

    for node in &graph.nodes {
        match node {
            LineageNode::Artifact(artifact) => {
                if artifact.id.trim().is_empty() {
                    return Err(invalid("artifact node id is required"));
                }
                if !node_ids.insert(artifact.id.as_str()) {
                    return Err(invalid(format!("duplicate node id: {}", artifact.id)));
                }
                if !known_documents.contains(&artifact.document_ref) {
                    return Err(invalid(format!(
                        "missing project document reference for artifact node {}",
                        artifact.id
                    )));
                }

                let mut artifact_port_index = ArtifactPortIndex::default();
                register_artifact_port(
                    &artifact.id,
                    &artifact.artifact_kind,
                    &artifact.input_port,
                    PortRole::Input,
                    &mut seen_port_ids,
                    &mut artifact_port_index,
                )?;
                register_artifact_port(
                    &artifact.id,
                    &artifact.artifact_kind,
                    &artifact.output_port,
                    PortRole::Output,
                    &mut seen_port_ids,
                    &mut artifact_port_index,
                )?;
                artifact_ports.insert(artifact.id.as_str(), artifact_port_index);

                artifact_nodes.insert(artifact.id.as_str(), artifact);
            }
            LineageNode::Operation(operation) => {
                if operation.id.trim().is_empty() {
                    return Err(invalid("operation node id is required"));
                }
                if !node_ids.insert(operation.id.as_str()) {
                    return Err(invalid(format!("duplicate node id: {}", operation.id)));
                }
                if let Some(document_ref) = &operation.document_ref {
                    if !known_documents.contains(document_ref) {
                        return Err(invalid(format!(
                            "missing project document reference for operation node {}",
                            operation.id
                        )));
                    }
                }

                let mut port_index = OperationPortIndex::default();
                for port in &operation.input_ports {
                    register_operation_port(
                        &operation.id,
                        port,
                        PortRole::Input,
                        &mut seen_port_ids,
                        &mut port_index,
                    )?;
                }
                for port in &operation.output_ports {
                    register_operation_port(
                        &operation.id,
                        port,
                        PortRole::Output,
                        &mut seen_port_ids,
                        &mut port_index,
                    )?;
                }
                operation_ports.insert(operation.id.as_str(), port_index);
                operation_nodes.insert(operation.id.as_str(), operation);
            }
        }
    }

    let mut edge_ids = HashSet::new();
    let mut producer_counts: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut indegree: HashMap<&str, usize> = HashMap::new();

    for node_id in &node_ids {
        indegree.insert(*node_id, 0);
    }

    for edge in &graph.edges {
        if edge.id.trim().is_empty() {
            return Err(invalid("edge id is required"));
        }
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(invalid(format!("duplicate edge id: {}", edge.id)));
        }

        let source_node = node_by_id(
            &artifact_nodes,
            &operation_nodes,
            edge.source.node_id.as_str(),
        )
        .ok_or_else(|| invalid(format!("dangling source endpoint: {}", edge.source.node_id)))?;
        let target_node = node_by_id(
            &artifact_nodes,
            &operation_nodes,
            edge.target.node_id.as_str(),
        )
        .ok_or_else(|| invalid(format!("dangling target endpoint: {}", edge.target.node_id)))?;

        match edge.kind {
            LineageEdgeKind::Consumes => {
                let source_artifact = expect_artifact(source_node, "consumes")?;
                let target_operation = expect_operation(target_node, "consumes")?;
                let source_port_kind = artifact_ports
                    .get(source_artifact.id.as_str())
                    .and_then(|ports| ports.output_port.as_ref())
                    .ok_or_else(|| {
                        invalid(format!(
                            "missing output port on artifact {}",
                            source_artifact.id
                        ))
                    })?;
                if edge.source.port_id != source_port_kind.id {
                    return Err(invalid(format!(
                        "dangling source port {} on artifact {}",
                        edge.source.port_id, source_artifact.id
                    )));
                }
                let target_port_kind = operation_ports
                    .get(target_operation.id.as_str())
                    .and_then(|ports| ports.input_ports.get(edge.target.port_id.as_str()))
                    .cloned()
                    .ok_or_else(|| {
                        invalid(format!(
                            "dangling target port {} on operation {}",
                            edge.target.port_id, target_operation.id
                        ))
                    })?;

                if !payload_kinds_match(
                    source_port_kind.payload_kind.clone(),
                    target_port_kind,
                ) {
                    return Err(invalid(format!(
                        "invalid port payload direction for edge {}",
                        edge.id
                    )));
                }

                adjacency
                    .entry(source_artifact.id.as_str())
                    .or_default()
                    .push(target_operation.id.as_str());
                *indegree.entry(target_operation.id.as_str()).or_default() += 1;
            }
            LineageEdgeKind::Produces => {
                let source_operation = expect_operation(source_node, "produces")?;
                let target_artifact = expect_artifact(target_node, "produces")?;
                let source_port_kind = operation_ports
                    .get(source_operation.id.as_str())
                    .and_then(|ports| ports.output_ports.get(edge.source.port_id.as_str()))
                    .cloned()
                    .ok_or_else(|| {
                        invalid(format!(
                            "dangling source port {} on operation {}",
                            edge.source.port_id, source_operation.id
                        ))
                    })?;
                let target_port_kind = artifact_ports
                    .get(target_artifact.id.as_str())
                    .and_then(|ports| ports.input_port.as_ref())
                    .ok_or_else(|| {
                        invalid(format!(
                            "missing input port on artifact {}",
                            target_artifact.id
                        ))
                    })?;
                if edge.target.port_id != target_port_kind.id {
                    return Err(invalid(format!(
                        "dangling target port {} on artifact {}",
                        edge.target.port_id, target_artifact.id
                    )));
                }

                if !payload_kinds_match(
                    source_port_kind,
                    target_port_kind.payload_kind.clone(),
                ) {
                    return Err(invalid(format!(
                        "invalid port payload direction for edge {}",
                        edge.id
                    )));
                }

                let producer_count = producer_counts
                    .entry(target_artifact.id.as_str())
                    .or_insert(0);
                *producer_count += 1;
                if *producer_count > 1 {
                    return Err(invalid(format!(
                        "artifact node {} has more than one producer",
                        target_artifact.id
                    )));
                }

                adjacency
                    .entry(source_operation.id.as_str())
                    .or_default()
                    .push(target_artifact.id.as_str());
                *indegree.entry(target_artifact.id.as_str()).or_default() += 1;
            }
        }
    }

    let mut queue: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(node_id, degree)| (*degree == 0).then_some(*node_id))
        .collect();
    let mut visited = 0usize;

    while let Some(node_id) = queue.pop_front() {
        visited += 1;
        if let Some(neighbors) = adjacency.get(node_id) {
            for neighbor in neighbors {
                let degree = indegree
                    .get_mut(neighbor)
                    .ok_or_else(|| invalid(format!("missing indegree for node {}", neighbor)))?;
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(neighbor);
                }
            }
        }
    }

    if visited != indegree.len() {
        return Err(invalid("lineage graph contains a cycle"));
    }

    Ok(())
}

pub fn validate_logical_folders(folders: &[LogicalFolder]) -> Result<(), AppError> {
    let mut seen_ids = HashSet::new();
    let mut parent_by_id: HashMap<&str, &str> = HashMap::new();

    for folder in folders {
        if folder.id.trim().is_empty() {
            return Err(invalid("folder id is required"));
        }
        if !seen_ids.insert(folder.id.as_str()) {
            return Err(invalid(format!("duplicate folder id: {}", folder.id)));
        }
        if let Some(parent_id) = folder.parent_folder_id.as_deref() {
            parent_by_id.insert(folder.id.as_str(), parent_id);
        }
    }

    for folder in folders {
        if let Some(parent_id) = folder.parent_folder_id.as_deref() {
            if !seen_ids.contains(parent_id) {
                return Err(invalid(format!(
                    "missing parent folder {} for folder {}",
                    parent_id, folder.id
                )));
            }
        }
    }

    let mut visit_state: HashMap<&str, VisitState> = HashMap::new();
    for folder in folders {
        if has_folder_cycle(folder.id.as_str(), &parent_by_id, &mut visit_state)? {
            return Err(invalid("logical folder graph contains a cycle"));
        }
    }

    Ok(())
}

pub fn validate_workflow_definitions(workflows: &[WorkflowDefinition]) -> Result<(), AppError> {
    let mut seen_ids = HashSet::new();

    for workflow in workflows {
        if workflow.id.trim().is_empty() {
            return Err(invalid("workflow id is required"));
        }
        if !seen_ids.insert(workflow.id.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate workflow id: {}", workflow.id)));
        }
        validate_extracted_workflow(workflow)?;
    }

    Ok(())
}

pub fn validate_workflow_runs(
    runs: &[WorkflowRun],
    workflows: &[WorkflowDefinition],
    folders: &[LogicalFolder],
) -> Result<(), AppError> {
    let mut revisions_by_workflow: HashMap<&str, HashSet<u64>> = HashMap::new();
    for workflow in workflows {
        revisions_by_workflow
            .entry(workflow.id.as_str())
            .or_default()
            .insert(workflow.revision);
    }

    let folder_ids = folders
        .iter()
        .map(|folder| folder.id.as_str())
        .collect::<HashSet<_>>();
    let mut seen_run_ids = HashSet::new();

    for run in runs {
        if run.id.trim().is_empty() {
            return Err(invalid("run id is required"));
        }
        if !seen_run_ids.insert(run.id.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate run id: {}", run.id)));
        }

        let revisions = revisions_by_workflow.get(run.workflow_id.as_str()).ok_or_else(|| {
            invalid(format!(
                "run {} references missing workflow {}",
                run.id, run.workflow_id
            ))
        })?;

        if !revisions.contains(&run.workflow_revision) {
            return Err(invalid(format!(
                "run {} references missing workflow revision {}",
                run.id, run.workflow_revision
            )));
        }

        if let Some(parent_folder_id) = run.parent_folder_id.as_deref() {
            if !folder_ids.contains(parent_folder_id) {
                return Err(invalid(format!(
                    "run {} references missing parent folder {}",
                    run.id, parent_folder_id
                )));
            }
        }

        let mut input_slot_ids = HashSet::new();
        for binding in &run.input_bindings {
            if binding.slot_id.trim().is_empty() {
                return Err(invalid(format!(
                    "run {} contains an input binding with an empty slot id",
                    run.id
                )));
            }
            if !input_slot_ids.insert(binding.slot_id.to_ascii_lowercase()) {
                return Err(invalid(format!(
                    "run {} contains duplicate input binding slot {}",
                    run.id, binding.slot_id
                )));
            }
        }

        let mut output_declaration_ids = HashSet::new();
        for binding in &run.output_bindings {
            if binding.declaration_id.trim().is_empty() {
                return Err(invalid(format!(
                    "run {} contains an output binding with an empty declaration id",
                    run.id
                )));
            }
            if !output_declaration_ids.insert(binding.declaration_id.to_ascii_lowercase()) {
                return Err(invalid(format!(
                    "run {} contains duplicate output binding declaration {}",
                    run.id, binding.declaration_id
                )));
            }
        }
    }

    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PortRole {
    Input,
    Output,
}

#[derive(Default)]
struct OperationPortIndex {
    input_ports: HashMap<String, PortPayloadKind>,
    output_ports: HashMap<String, PortPayloadKind>,
}

#[derive(Default)]
struct ArtifactPortIndex {
    input_port: Option<LineagePort>,
    output_port: Option<LineagePort>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VisitState {
    Visiting,
    Visited,
}

fn register_operation_port(
    operation_id: &str,
    port: &LineagePort,
    role: PortRole,
    seen_port_ids: &mut HashSet<String>,
    port_index: &mut OperationPortIndex,
) -> Result<(), AppError> {
    if port.id.trim().is_empty() {
        return Err(invalid(format!(
            "port id is required on operation {}",
            operation_id
        )));
    }
    if !seen_port_ids.insert(port.id.clone()) {
        return Err(invalid(format!("duplicate port id: {}", port.id)));
    }

    match role {
        PortRole::Input => {
            if port_index
                .input_ports
                .insert(port.id.clone(), port.payload_kind.clone())
                .is_some()
            {
                return Err(invalid(format!(
                    "duplicate input port id {} on operation {}",
                    port.id, operation_id
                )));
            }
        }
        PortRole::Output => {
            if port_index
                .output_ports
                .insert(port.id.clone(), port.payload_kind.clone())
                .is_some()
            {
                return Err(invalid(format!(
                    "duplicate output port id {} on operation {}",
                    port.id, operation_id
                )));
            }
        }
    }

    Ok(())
}

fn register_artifact_port(
    artifact_id: &str,
    artifact_kind: &ArtifactKind,
    port: &LineagePort,
    _role: PortRole,
    seen_port_ids: &mut HashSet<String>,
    port_index: &mut ArtifactPortIndex,
) -> Result<(), AppError> {
    if port.id.trim().is_empty() {
        return Err(invalid(format!(
            "port id is required on artifact {}",
            artifact_id
        )));
    }
    if !seen_port_ids.insert(port.id.clone()) {
        return Err(invalid(format!("duplicate port id: {}", port.id)));
    }

    let expected_kind = artifact_kind_to_payload_kind(artifact_kind);

    if port.payload_kind != expected_kind {
        return Err(invalid(format!(
            "artifact {} port {} has unexpected payload kind",
            artifact_id, port.id
        )));
    }

    match _role {
        PortRole::Input => {
            if port_index.input_port.replace(port.clone()).is_some() {
                return Err(invalid(format!(
                    "duplicate input port id {} on artifact {}",
                    port.id, artifact_id
                )));
            }
        }
        PortRole::Output => {
            if port_index.output_port.replace(port.clone()).is_some() {
                return Err(invalid(format!(
                    "duplicate output port id {} on artifact {}",
                    port.id, artifact_id
                )));
            }
        }
    }

    Ok(())
}

fn payload_kinds_match(expected: PortPayloadKind, actual: PortPayloadKind) -> bool {
    expected == PortPayloadKind::Any || actual == PortPayloadKind::Any || expected == actual
}

fn workflow_input_slot_output_port_id(slot_id: &str) -> String {
    format!("{}:output", slot_id)
}

fn workflow_output_input_port_id(output_id: &str) -> String {
    format!("{}:input", output_id)
}

fn workflow_output_output_port_id(output_id: &str) -> String {
    format!("{}:output", output_id)
}

fn workflow_input_slot_output_port(slot_id: &str) -> WorkflowPort {
    WorkflowPort {
        id: workflow_input_slot_output_port_id(slot_id),
        name: "output".to_string(),
        payload_kind: PortPayloadKind::Table,
    }
}

fn workflow_output_input_port(output_id: &str, artifact_kind: &ArtifactKind) -> WorkflowPort {
    WorkflowPort {
        id: workflow_output_input_port_id(output_id),
        name: "input".to_string(),
        payload_kind: artifact_kind_to_payload_kind(artifact_kind),
    }
}

fn workflow_output_output_port(output_id: &str, artifact_kind: &ArtifactKind) -> WorkflowPort {
    WorkflowPort {
        id: workflow_output_output_port_id(output_id),
        name: "output".to_string(),
        payload_kind: artifact_kind_to_payload_kind(artifact_kind),
    }
}

fn artifact_kind_to_payload_kind(kind: &ArtifactKind) -> PortPayloadKind {
    match kind {
        ArtifactKind::Table => PortPayloadKind::Table,
        ArtifactKind::Graph => PortPayloadKind::Graph,
        ArtifactKind::FitYByX => PortPayloadKind::FitYByX,
        ArtifactKind::Tabulate => PortPayloadKind::Tabulate,
        ArtifactKind::Snapshot => PortPayloadKind::Snapshot,
    }
}

fn register_workflow_boundary_port(
    node_id: &str,
    port: &WorkflowPort,
    role: PortRole,
    expected_payload_kind: PortPayloadKind,
    seen_port_ids: &mut HashSet<String>,
    node_label: &str,
) -> Result<(), AppError> {
    if port.id.trim().is_empty() {
        return Err(invalid(format!(
            "port id is required on {} {}",
            node_label, node_id
        )));
    }
    if !seen_port_ids.insert(port.id.clone()) {
        return Err(invalid(format!("duplicate port id: {}", port.id)));
    }

    let expected_name = match role {
        PortRole::Input => "input",
        PortRole::Output => "output",
    };
    if port.name != expected_name {
        return Err(invalid(format!(
            "{} {} must declare a {} port named {}",
            node_label, node_id, expected_name, expected_name
        )));
    }
    if port.payload_kind != expected_payload_kind {
        return Err(invalid(format!(
            "{} {} port {} has unexpected payload kind",
            node_label, node_id, port.id
        )));
    }

    Ok(())
}

fn workflow_operation_input_payload_kind(
    workflow: &WorkflowDefinition,
    operation_id: &str,
    port_id: &str,
) -> Result<PortPayloadKind, AppError> {
    workflow
        .operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .and_then(|operation| operation.input_ports.iter().find(|port| port.id == port_id))
        .map(|port| port.payload_kind.clone())
        .ok_or_else(|| {
            invalid(format!(
                "missing input port {} on workflow operation {}",
                port_id, operation_id
            ))
        })
}

fn workflow_operation_output_payload_kind(
    workflow: &WorkflowDefinition,
    operation_id: &str,
    port_id: &str,
) -> Result<PortPayloadKind, AppError> {
    workflow
        .operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .and_then(|operation| operation.output_ports.iter().find(|port| port.id == port_id))
        .map(|port| port.payload_kind.clone())
        .ok_or_else(|| {
            invalid(format!(
                "missing output port {} on workflow operation {}",
                port_id, operation_id
            ))
        })
}

fn node_by_id<'a>(
    artifacts: &'a HashMap<&'a str, &'a ArtifactNode>,
    operations: &'a HashMap<&'a str, &'a OperationNode>,
    node_id: &str,
) -> Option<LineageNodeRef<'a>> {
    if let Some(artifact) = artifacts.get(node_id) {
        return Some(LineageNodeRef::Artifact(*artifact));
    }
    operations.get(node_id).copied().map(LineageNodeRef::Operation)
}

fn expect_artifact<'a>(node: LineageNodeRef<'a>, context: &str) -> Result<&'a ArtifactNode, AppError> {
    match node {
        LineageNodeRef::Artifact(artifact) => Ok(artifact),
        LineageNodeRef::Operation(operation) => Err(invalid(format!(
            "invalid edge direction for {} edge: expected artifact node but found operation {}",
            context, operation.id
        ))),
    }
}

fn expect_operation<'a>(
    node: LineageNodeRef<'a>,
    context: &str,
) -> Result<&'a OperationNode, AppError> {
    match node {
        LineageNodeRef::Operation(operation) => Ok(operation),
        LineageNodeRef::Artifact(artifact) => Err(invalid(format!(
            "invalid edge direction for {} edge: expected operation node but found artifact {}",
            context, artifact.id
        ))),
    }
}

fn has_folder_cycle<'a>(
    folder_id: &'a str,
    parent_by_id: &HashMap<&'a str, &'a str>,
    visit_state: &mut HashMap<&'a str, VisitState>,
) -> Result<bool, AppError> {
    match visit_state.get(folder_id) {
        Some(VisitState::Visited) => return Ok(false),
        Some(VisitState::Visiting) => return Ok(true),
        None => {}
    }

    visit_state.insert(folder_id, VisitState::Visiting);
    if let Some(parent_id) = parent_by_id.get(folder_id) {
        if has_folder_cycle(parent_id, parent_by_id, visit_state)? {
            return Ok(true);
        }
    }
    visit_state.insert(folder_id, VisitState::Visited);
    Ok(false)
}

enum LineageNodeRef<'a> {
    Artifact(&'a ArtifactNode),
    Operation(&'a OperationNode),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    use serde_json::json;

    use crate::error::AppError;
    use crate::services::spprj_archive::{ProjectDocumentKind, ProjectDocumentRef, TableColumn};

    fn table_ref(id: &str) -> ProjectDocumentRef {
        ProjectDocumentRef {
            kind: ProjectDocumentKind::Table,
            id: id.to_string(),
        }
    }

    fn graph_ref(id: &str) -> ProjectDocumentRef {
        ProjectDocumentRef {
            kind: ProjectDocumentKind::Graph,
            id: id.to_string(),
        }
    }

    fn fit_ref(id: &str) -> ProjectDocumentRef {
        ProjectDocumentRef {
            kind: ProjectDocumentKind::FitYByX,
            id: id.to_string(),
        }
    }

    fn table_column(name: &str, col_type: &str) -> TableColumn {
        TableColumn {
            name: name.to_string(),
            col_type: col_type.to_string(),
            width: None,
            format: None,
            extras: None,
        }
    }

    fn valid_project_lineage_graph() -> ProjectLineageGraph {
        ProjectLineageGraph {
            id: "lineage-graph-1".to_string(),
            name: "Lineage Graph".to_string(),
            nodes: vec![
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-table-1".to_string(),
                    document_ref: table_ref("table-1"),
                    name: "Table A".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::Table,
                    input_port: LineagePort {
                        id: "table-input".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    output_port: LineagePort {
                        id: "source-output".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    materialized_by_workflow_run_id: None,
                }),
                LineageNode::Operation(OperationNode {
                    id: "operation-graph-1".to_string(),
                    kind: OperationKind::GraphGeneration,
                    schema_version: "1".to_string(),
                    configuration: Some(json!({"mode": "scatter"})),
                    document_ref: None,
                    input_ports: vec![LineagePort {
                        id: "op-in-1".to_string(),
                        name: "source".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    }],
                    output_ports: vec![LineagePort {
                        id: "op-out-1".to_string(),
                        name: "result".to_string(),
                        payload_kind: PortPayloadKind::Graph,
                    }],
                }),
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-graph-1".to_string(),
                    document_ref: graph_ref("graph-1"),
                    name: "Graph A".to_string(),
                    parent_folder_id: Some("folder-1".to_string()),
                    artifact_kind: ArtifactKind::Graph,
                    input_port: LineagePort {
                        id: "artifact-input".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Graph,
                    },
                    output_port: LineagePort {
                        id: "artifact-output".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Graph,
                    },
                    materialized_by_workflow_run_id: None,
                }),
            ],
            edges: vec![
                LineageEdge {
                    id: "edge-1".to_string(),
                    kind: LineageEdgeKind::Consumes,
                    source: LineageEndpoint {
                        node_id: "artifact-table-1".to_string(),
                        port_id: "source-output".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "operation-graph-1".to_string(),
                        port_id: "op-in-1".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-2".to_string(),
                    kind: LineageEdgeKind::Produces,
                    source: LineageEndpoint {
                        node_id: "operation-graph-1".to_string(),
                        port_id: "op-out-1".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "artifact-graph-1".to_string(),
                        port_id: "artifact-input".to_string(),
                    },
                },
            ],
        }
    }

    fn workflow_extraction_graph() -> ProjectLineageGraph {
        ProjectLineageGraph {
            id: "lineage-graph-workflow".to_string(),
            name: "Workflow Source Graph".to_string(),
            nodes: vec![
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-table-source-a".to_string(),
                    document_ref: table_ref("table-source-a"),
                    name: "Source A".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::Table,
                    input_port: LineagePort {
                        id: "artifact-table-source-a-in".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    output_port: LineagePort {
                        id: "artifact-table-source-a-out".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    materialized_by_workflow_run_id: None,
                }),
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-table-source-b".to_string(),
                    document_ref: table_ref("table-source-b"),
                    name: "Source B".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::Table,
                    input_port: LineagePort {
                        id: "artifact-table-source-b-in".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    output_port: LineagePort {
                        id: "artifact-table-source-b-out".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    materialized_by_workflow_run_id: None,
                }),
                LineageNode::Operation(OperationNode {
                    id: "operation-sql-1".to_string(),
                    kind: OperationKind::SqlQuery,
                    schema_version: "1".to_string(),
                    configuration: Some(json!({
                        "sourceDatasetId": "table-source-a",
                        "sourceDocumentRef": {"kind": "table", "id": "table-source-a"}
                    })),
                    document_ref: None,
                    input_ports: vec![LineagePort {
                        id: "operation-sql-1-in-source".to_string(),
                        name: "source".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    }],
                    output_ports: vec![LineagePort {
                        id: "operation-sql-1-out-table".to_string(),
                        name: "result".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    }],
                }),
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-table-joined".to_string(),
                    document_ref: table_ref("table-joined"),
                    name: "Joined Table".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::Table,
                    input_port: LineagePort {
                        id: "artifact-table-joined-in".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    output_port: LineagePort {
                        id: "artifact-table-joined-out".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    materialized_by_workflow_run_id: None,
                }),
                LineageNode::Operation(OperationNode {
                    id: "operation-fit-1".to_string(),
                    kind: OperationKind::FitYByX,
                    schema_version: "1".to_string(),
                    configuration: Some(json!({
                        "datasetId": "table-joined",
                        "xColumn": "height",
                        "yColumn": "weight"
                    })),
                    document_ref: Some(fit_ref("fit-1")),
                    input_ports: vec![LineagePort {
                        id: "operation-fit-1-in-source".to_string(),
                        name: "source".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    }],
                    output_ports: vec![LineagePort {
                        id: "operation-fit-1-out-fit".to_string(),
                        name: "result".to_string(),
                        payload_kind: PortPayloadKind::FitYByX,
                    }],
                }),
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-fit-1".to_string(),
                    document_ref: fit_ref("fit-1"),
                    name: "Fit Result".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::FitYByX,
                    input_port: LineagePort {
                        id: "artifact-fit-1-in".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::FitYByX,
                    },
                    output_port: LineagePort {
                        id: "artifact-fit-1-out".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::FitYByX,
                    },
                    materialized_by_workflow_run_id: None,
                }),
                LineageNode::Operation(OperationNode {
                    id: "operation-join-1".to_string(),
                    kind: OperationKind::SqlQuery,
                    schema_version: "1".to_string(),
                    configuration: Some(json!({
                        "leftSourceDatasetId": "table-source-a",
                        "rightSourceDatasetId": "table-source-b"
                    })),
                    document_ref: None,
                    input_ports: vec![
                        LineagePort {
                            id: "operation-join-1-in-left".to_string(),
                            name: "left".to_string(),
                            payload_kind: PortPayloadKind::Table,
                        },
                        LineagePort {
                            id: "operation-join-1-in-right".to_string(),
                            name: "right".to_string(),
                            payload_kind: PortPayloadKind::Table,
                        },
                    ],
                    output_ports: vec![LineagePort {
                        id: "operation-join-1-out-table".to_string(),
                        name: "result".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    }],
                }),
                LineageNode::Artifact(ArtifactNode {
                    id: "artifact-join-output".to_string(),
                    document_ref: table_ref("table-join-output"),
                    name: "Join Output".to_string(),
                    parent_folder_id: None,
                    artifact_kind: ArtifactKind::Table,
                    input_port: LineagePort {
                        id: "artifact-join-output-in".to_string(),
                        name: "input".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    output_port: LineagePort {
                        id: "artifact-join-output-out".to_string(),
                        name: "output".to_string(),
                        payload_kind: PortPayloadKind::Table,
                    },
                    materialized_by_workflow_run_id: None,
                }),
            ],
            edges: vec![
                LineageEdge {
                    id: "edge-a-sql".to_string(),
                    kind: LineageEdgeKind::Consumes,
                    source: LineageEndpoint {
                        node_id: "artifact-table-source-a".to_string(),
                        port_id: "artifact-table-source-a-out".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "operation-sql-1".to_string(),
                        port_id: "operation-sql-1-in-source".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-sql-table".to_string(),
                    kind: LineageEdgeKind::Produces,
                    source: LineageEndpoint {
                        node_id: "operation-sql-1".to_string(),
                        port_id: "operation-sql-1-out-table".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "artifact-table-joined".to_string(),
                        port_id: "artifact-table-joined-in".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-table-fit".to_string(),
                    kind: LineageEdgeKind::Consumes,
                    source: LineageEndpoint {
                        node_id: "artifact-table-joined".to_string(),
                        port_id: "artifact-table-joined-out".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "operation-fit-1".to_string(),
                        port_id: "operation-fit-1-in-source".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-fit-output".to_string(),
                    kind: LineageEdgeKind::Produces,
                    source: LineageEndpoint {
                        node_id: "operation-fit-1".to_string(),
                        port_id: "operation-fit-1-out-fit".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "artifact-fit-1".to_string(),
                        port_id: "artifact-fit-1-in".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-a-join".to_string(),
                    kind: LineageEdgeKind::Consumes,
                    source: LineageEndpoint {
                        node_id: "artifact-table-source-a".to_string(),
                        port_id: "artifact-table-source-a-out".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "operation-join-1".to_string(),
                        port_id: "operation-join-1-in-left".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-b-join".to_string(),
                    kind: LineageEdgeKind::Consumes,
                    source: LineageEndpoint {
                        node_id: "artifact-table-source-b".to_string(),
                        port_id: "artifact-table-source-b-out".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "operation-join-1".to_string(),
                        port_id: "operation-join-1-in-right".to_string(),
                    },
                },
                LineageEdge {
                    id: "edge-join-output".to_string(),
                    kind: LineageEdgeKind::Produces,
                    source: LineageEndpoint {
                        node_id: "operation-join-1".to_string(),
                        port_id: "operation-join-1-out-table".to_string(),
                    },
                    target: LineageEndpoint {
                        node_id: "artifact-join-output".to_string(),
                        port_id: "artifact-join-output-in".to_string(),
                    },
                },
            ],
        }
    }

    fn extraction_request(
        graph: ProjectLineageGraph,
        selected_node_ids: &[&str],
        selected_edge_ids: &[&str],
        table_schemas: Vec<WorkflowSourceTable>,
        operation_column_requirements: Vec<WorkflowOperationInputSchema>,
    ) -> WorkflowExtractionRequest {
        WorkflowExtractionRequest {
            workflow_id: "workflow-1".to_string(),
            name: "Reusable Workflow".to_string(),
            description: Some("Selection extracted from lineage".to_string()),
            format_version: "1".to_string(),
            revision: 1,
            graph,
            selected_node_ids: selected_node_ids.iter().map(|id| (*id).to_string()).collect(),
            selected_edge_ids: selected_edge_ids.iter().map(|id| (*id).to_string()).collect(),
            table_schemas,
            operation_column_requirements,
            layout: None,
        }
    }

    #[test]
    fn extract_workflow_converts_external_table_dependency_into_input_slot() {
        let workflow = extract_workflow(extraction_request(
            workflow_extraction_graph(),
            &["operation-sql-1", "artifact-table-joined", "operation-fit-1", "artifact-fit-1"],
            &["edge-sql-table", "edge-table-fit", "edge-fit-output"],
            vec![WorkflowSourceTable {
                artifact_node_id: "artifact-table-source-a".to_string(),
                columns: vec![
                    table_column("height", "INTEGER"),
                    table_column("weight", "DOUBLE"),
                    table_column("ignored", "VARCHAR"),
                ],
            }],
            vec![
                WorkflowOperationInputSchema {
                    operation_id: "operation-sql-1".to_string(),
                    input_port_id: "operation-sql-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-fit-1".to_string(),
                    input_port_id: "operation-fit-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
            ],
        ))
        .expect("workflow extracts");

        assert_eq!(workflow.input_slots.len(), 1);
        assert_eq!(workflow.operations.len(), 2);
        assert_eq!(workflow.output_declarations.len(), 2);
        assert_eq!(workflow.input_slots[0].schema_contract.columns.len(), 2);
        assert_eq!(workflow.input_slots[0].source_document_ref, None);
    }

    #[test]
    fn extract_workflow_creates_two_input_slots_for_two_external_tables() {
        let workflow = extract_workflow(extraction_request(
            workflow_extraction_graph(),
            &["operation-join-1", "artifact-join-output"],
            &["edge-join-output"],
            vec![
                WorkflowSourceTable {
                    artifact_node_id: "artifact-table-source-a".to_string(),
                    columns: vec![table_column("left_key", "INT")],
                },
                WorkflowSourceTable {
                    artifact_node_id: "artifact-table-source-b".to_string(),
                    columns: vec![table_column("right_key", "INTEGER")],
                },
            ],
            vec![
                WorkflowOperationInputSchema {
                    operation_id: "operation-join-1".to_string(),
                    input_port_id: "operation-join-1-in-left".to_string(),
                    required_column_names: vec!["left_key".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-join-1".to_string(),
                    input_port_id: "operation-join-1-in-right".to_string(),
                    required_column_names: vec!["right_key".to_string()],
                },
            ],
        ))
        .expect("two-slot workflow extracts");

        assert_eq!(workflow.input_slots.len(), 2);
        assert_eq!(workflow.input_slots[0].schema_contract.columns[0].canonical_duckdb_type, "INTEGER");
        assert_eq!(workflow.input_slots[1].schema_contract.columns[0].canonical_duckdb_type, "INTEGER");
    }

    #[test]
    fn extract_workflow_rejects_non_table_external_dependencies() {
        let mut graph = workflow_extraction_graph();
        graph.nodes.push(LineageNode::Artifact(ArtifactNode {
            id: "artifact-graph-external".to_string(),
            document_ref: graph_ref("graph-external"),
            name: "External Graph".to_string(),
            parent_folder_id: None,
            artifact_kind: ArtifactKind::Graph,
            input_port: LineagePort {
                id: "artifact-graph-external-in".to_string(),
                name: "input".to_string(),
                payload_kind: PortPayloadKind::Graph,
            },
            output_port: LineagePort {
                id: "artifact-graph-external-out".to_string(),
                name: "output".to_string(),
                payload_kind: PortPayloadKind::Graph,
            },
            materialized_by_workflow_run_id: None,
        }));
        graph.edges.push(LineageEdge {
            id: "edge-graph-fit".to_string(),
            kind: LineageEdgeKind::Consumes,
            source: LineageEndpoint {
                node_id: "artifact-graph-external".to_string(),
                port_id: "artifact-graph-external-out".to_string(),
            },
            target: LineageEndpoint {
                node_id: "operation-fit-1".to_string(),
                port_id: "operation-fit-1-in-source".to_string(),
            },
        });

        let err = extract_workflow(extraction_request(
            graph,
            &["operation-fit-1", "artifact-fit-1"],
            &["edge-fit-output"],
            vec![],
            vec![],
        ))
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("non-table external dependency")));
    }

    #[test]
    fn extract_workflow_rejects_unresolved_external_dependencies() {
        let mut graph = workflow_extraction_graph();
        graph.edges[0].source.node_id = "missing-artifact".to_string();

        let err = extract_workflow(extraction_request(
            graph,
            &["operation-sql-1", "artifact-table-joined"],
            &["edge-sql-table"],
            vec![],
            vec![],
        ))
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("unresolved external dependency")));
    }

    #[test]
    fn extract_workflow_rejects_disconnected_selected_operations() {
        let err = extract_workflow(extraction_request(
            workflow_extraction_graph(),
            &["operation-fit-1", "artifact-fit-1", "operation-join-1", "artifact-join-output"],
            &["edge-fit-output", "edge-join-output"],
            vec![
                WorkflowSourceTable {
                    artifact_node_id: "artifact-table-joined".to_string(),
                    columns: vec![
                        table_column("height", "INTEGER"),
                        table_column("weight", "DOUBLE"),
                    ],
                },
                WorkflowSourceTable {
                    artifact_node_id: "artifact-table-source-a".to_string(),
                    columns: vec![table_column("left_key", "INTEGER")],
                },
                WorkflowSourceTable {
                    artifact_node_id: "artifact-table-source-b".to_string(),
                    columns: vec![table_column("right_key", "INTEGER")],
                },
            ],
            vec![
                WorkflowOperationInputSchema {
                    operation_id: "operation-fit-1".to_string(),
                    input_port_id: "operation-fit-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-join-1".to_string(),
                    input_port_id: "operation-join-1-in-left".to_string(),
                    required_column_names: vec!["left_key".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-join-1".to_string(),
                    input_port_id: "operation-join-1-in-right".to_string(),
                    required_column_names: vec!["right_key".to_string()],
                },
            ],
        ))
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("disconnected") || message.contains("reachable") || message.contains("orphan")));
    }

    #[test]
    fn extract_workflow_rejects_cycles() {
        let mut graph = workflow_extraction_graph();
        graph.edges.push(LineageEdge {
            id: "edge-fit-back-to-sql".to_string(),
            kind: LineageEdgeKind::Consumes,
            source: LineageEndpoint {
                node_id: "artifact-table-joined".to_string(),
                port_id: "artifact-table-joined-out".to_string(),
            },
            target: LineageEndpoint {
                node_id: "operation-sql-1".to_string(),
                port_id: "operation-sql-1-in-source".to_string(),
            },
        });

        let err = extract_workflow(extraction_request(
            graph,
            &["operation-sql-1", "artifact-table-joined"],
            &["edge-sql-table", "edge-fit-back-to-sql"],
            vec![WorkflowSourceTable {
                artifact_node_id: "artifact-table-source-a".to_string(),
                columns: vec![table_column("height", "INTEGER")],
            }],
            vec![WorkflowOperationInputSchema {
                operation_id: "operation-sql-1".to_string(),
                input_port_id: "operation-sql-1-in-source".to_string(),
                required_column_names: vec!["height".to_string()],
            }],
        ))
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("cycle")));
    }

    #[test]
    fn extract_workflow_serialization_omits_concrete_project_table_ids() {
        let workflow = extract_workflow(extraction_request(
            workflow_extraction_graph(),
            &["operation-sql-1", "artifact-table-joined", "operation-fit-1", "artifact-fit-1"],
            &["edge-sql-table", "edge-table-fit", "edge-fit-output"],
            vec![WorkflowSourceTable {
                artifact_node_id: "artifact-table-source-a".to_string(),
                columns: vec![
                    table_column("height", "INTEGER"),
                    table_column("weight", "DOUBLE"),
                ],
            }],
            vec![
                WorkflowOperationInputSchema {
                    operation_id: "operation-sql-1".to_string(),
                    input_port_id: "operation-sql-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-fit-1".to_string(),
                    input_port_id: "operation-fit-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
            ],
        ))
        .expect("workflow extracts");

        let serialized = serde_json::to_string(&workflow).expect("workflow serializes");
        assert!(!serialized.contains("\"table-source-a\""));
        assert!(!serialized.contains("\"artifact-table-source-a\""));
        assert!(!serialized.contains("\"table-joined\""));
        assert!(!serialized.contains("\"artifact-table-joined\""));
        assert!(!serialized.contains("\"fit-1\""));
        assert!(!serialized.contains("\"artifact-fit-1\""));
    }

    #[test]
    fn validate_extracted_workflow_rejects_malformed_boundary_endpoint_port_ids() {
        let workflow = extract_workflow(extraction_request(
            workflow_extraction_graph(),
            &["operation-sql-1", "artifact-table-joined", "operation-fit-1", "artifact-fit-1"],
            &["edge-sql-table", "edge-table-fit", "edge-fit-output"],
            vec![WorkflowSourceTable {
                artifact_node_id: "artifact-table-source-a".to_string(),
                columns: vec![
                    table_column("height", "INTEGER"),
                    table_column("weight", "DOUBLE"),
                ],
            }],
            vec![
                WorkflowOperationInputSchema {
                    operation_id: "operation-sql-1".to_string(),
                    input_port_id: "operation-sql-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
                WorkflowOperationInputSchema {
                    operation_id: "operation-fit-1".to_string(),
                    input_port_id: "operation-fit-1-in-source".to_string(),
                    required_column_names: vec!["height".to_string(), "weight".to_string()],
                },
            ],
        ))
        .expect("workflow extracts");

        let consumes_index = workflow
            .edges
            .iter()
            .position(|edge| edge.kind == WorkflowEdgeKind::Consumes && edge.source.node_id == workflow.input_slots[0].id)
            .expect("input slot consumes edge exists");
        let mut malformed_input_slot_edge = workflow.clone();
        malformed_input_slot_edge.edges[consumes_index].source.port_id = "malformed-input-slot-output".to_string();

        let err = validate_extracted_workflow(&malformed_input_slot_edge).unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("input slot") && message.contains("port")));

        let produces_index = workflow
            .edges
            .iter()
            .position(|edge| edge.kind == WorkflowEdgeKind::Produces && edge.target.node_id == workflow.output_declarations[0].id)
            .expect("output produces edge exists");
        let mut malformed_output_edge = workflow;
        malformed_output_edge.edges[produces_index].target.port_id = "malformed-output-input".to_string();

        let err = validate_extracted_workflow(&malformed_output_edge).unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("output") && message.contains("port")));
    }

    #[test]
    fn canonical_duckdb_type_normalizes_common_aliases() {
        assert_eq!(canonical_duckdb_type("INT"), "INTEGER");
        assert_eq!(canonical_duckdb_type("integer"), "INTEGER");
        assert_eq!(canonical_duckdb_type(" double precision "), "DOUBLE");
    }

    #[test]
    fn schema_fingerprint_is_deterministic_independent_of_column_order() {
        let left = vec![
            SchemaColumnRequirement {
                name: "weight".to_string(),
                canonical_duckdb_type: "DOUBLE".to_string(),
                required: true,
                required_by_operation_ids: vec!["operation-fit-1".to_string()],
            },
            SchemaColumnRequirement {
                name: "height".to_string(),
                canonical_duckdb_type: "INTEGER".to_string(),
                required: true,
                required_by_operation_ids: vec!["operation-sql-1".to_string()],
            },
        ];
        let right = vec![left[1].clone(), left[0].clone()];

        assert_eq!(schema_fingerprint(&left), schema_fingerprint(&right));
    }

    #[test]
    fn validate_schema_contract_accepts_exact_schema() {
        let contract = SchemaContract {
            schema_fingerprint: "unused".to_string(),
            columns: vec![
                SchemaColumnRequirement {
                    name: "height".to_string(),
                    canonical_duckdb_type: "INTEGER".to_string(),
                    required: true,
                    required_by_operation_ids: vec!["operation-sql-1".to_string()],
                },
                SchemaColumnRequirement {
                    name: "weight".to_string(),
                    canonical_duckdb_type: "DOUBLE".to_string(),
                    required: true,
                    required_by_operation_ids: vec!["operation-fit-1".to_string()],
                },
            ],
        };

        let report = validate_schema_contract(
            &contract,
            &[
                table_column("height", "INT"),
                table_column("weight", "DOUBLE PRECISION"),
            ],
        );

        assert!(report.missing_columns.is_empty());
        assert!(report.type_mismatches.is_empty());
        assert!(report.extra_columns.is_empty());
    }

    #[test]
    fn validate_schema_contract_reports_extra_missing_and_mismatched_columns() {
        let contract = SchemaContract {
            schema_fingerprint: "unused".to_string(),
            columns: vec![
                SchemaColumnRequirement {
                    name: "height".to_string(),
                    canonical_duckdb_type: "INTEGER".to_string(),
                    required: true,
                    required_by_operation_ids: vec!["operation-sql-1".to_string()],
                },
                SchemaColumnRequirement {
                    name: "weight".to_string(),
                    canonical_duckdb_type: "DOUBLE".to_string(),
                    required: true,
                    required_by_operation_ids: vec!["operation-fit-1".to_string()],
                },
            ],
        };

        let report = validate_schema_contract(
            &contract,
            &[
                table_column("height", "VARCHAR"),
                table_column("bonus", "BOOLEAN"),
            ],
        );

        assert_eq!(report.extra_columns, vec!["bonus".to_string()]);
        assert_eq!(report.missing_columns.len(), 1);
        assert_eq!(report.missing_columns[0].column_name, "weight");
        assert_eq!(report.missing_columns[0].affected_operation_ids, vec!["operation-fit-1".to_string()]);
        assert_eq!(report.type_mismatches.len(), 1);
        assert_eq!(report.type_mismatches[0].column_name, "height");
        assert_eq!(report.type_mismatches[0].affected_operation_ids, vec!["operation-sql-1".to_string()]);
    }

    fn docs(ids: &[ProjectDocumentRef]) -> HashSet<ProjectDocumentRef> {
        ids.iter().cloned().collect()
    }

    #[test]
    fn validates_a_table_to_operation_to_graph_chain() {
        let graph = valid_project_lineage_graph();
        let refs = docs(&[table_ref("table-1"), graph_ref("graph-1")]);

        validate_lineage_graph(&graph, &refs).expect("valid lineage graph");
    }

    #[test]
    fn rejects_missing_artifact_source_port() {
        let mut graph = valid_project_lineage_graph();
        graph.edges[0].source.port_id = "missing-artifact-output".to_string();

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("port")));
    }

    #[test]
    fn rejects_wrong_role_artifact_target_port() {
        let mut graph = valid_project_lineage_graph();
        graph.edges[1].target.port_id = "artifact-output".to_string();

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("port")));
    }

    #[test]
    fn rejects_duplicate_node_ids() {
        let mut graph = valid_project_lineage_graph();
        graph.nodes.push(LineageNode::Artifact(ArtifactNode {
            id: "artifact-table-1".to_string(),
            document_ref: table_ref("table-2"),
            name: "Duplicate node".to_string(),
            parent_folder_id: None,
            artifact_kind: ArtifactKind::Table,
            input_port: LineagePort {
                id: "table-input-2".to_string(),
                name: "input".to_string(),
                payload_kind: PortPayloadKind::Table,
            },
            output_port: LineagePort {
                id: "source-output-2".to_string(),
                name: "output".to_string(),
                payload_kind: PortPayloadKind::Table,
            },
            materialized_by_workflow_run_id: None,
        }));

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("node")));
    }

    #[test]
    fn rejects_duplicate_edge_ids() {
        let mut graph = valid_project_lineage_graph();
        graph.edges.push(LineageEdge {
            id: "edge-1".to_string(),
            kind: LineageEdgeKind::Produces,
            source: LineageEndpoint {
                node_id: "operation-graph-1".to_string(),
                port_id: "op-out-1".to_string(),
            },
            target: LineageEndpoint {
                node_id: "artifact-graph-1".to_string(),
                port_id: "artifact-input-2".to_string(),
            },
        });

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("edge")));
    }

    #[test]
    fn rejects_duplicate_port_ids() {
        let mut graph = valid_project_lineage_graph();
        graph.nodes[1] = LineageNode::Operation(OperationNode {
            id: "operation-graph-1".to_string(),
            kind: OperationKind::GraphGeneration,
            schema_version: "1".to_string(),
            configuration: Some(json!({"mode": "scatter"})),
            document_ref: None,
            input_ports: vec![LineagePort {
                id: "shared-port".to_string(),
                name: "source".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
            output_ports: vec![LineagePort {
                id: "shared-port".to_string(),
                name: "result".to_string(),
                payload_kind: PortPayloadKind::Graph,
            }],
        });

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("port")));
    }

    #[test]
    fn rejects_dangling_endpoints() {
        let mut graph = valid_project_lineage_graph();
        graph.edges[0].target.node_id = "missing-operation".to_string();

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("endpoint")));
    }

    #[test]
    fn rejects_invalid_bipartite_direction() {
        let mut graph = valid_project_lineage_graph();
        graph.edges[0].kind = LineageEdgeKind::Produces;

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("direction")));
    }

    #[test]
    fn rejects_duplicate_artifact_producers() {
        let mut graph = valid_project_lineage_graph();
        graph.nodes.push(LineageNode::Operation(OperationNode {
            id: "operation-graph-2".to_string(),
            kind: OperationKind::GraphGeneration,
            schema_version: "1".to_string(),
            configuration: Some(json!({"mode": "scatter"})),
            document_ref: None,
            input_ports: vec![LineagePort {
                id: "op-in-2".to_string(),
                name: "source".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
            output_ports: vec![LineagePort {
                id: "op-out-2".to_string(),
                name: "result".to_string(),
                payload_kind: PortPayloadKind::Graph,
            }],
        }));
        graph.edges.push(LineageEdge {
            id: "edge-3".to_string(),
            kind: LineageEdgeKind::Produces,
            source: LineageEndpoint {
                node_id: "operation-graph-2".to_string(),
                port_id: "op-out-2".to_string(),
            },
            target: LineageEndpoint {
                node_id: "artifact-graph-1".to_string(),
                port_id: "artifact-input".to_string(),
            },
        });

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("producer")));
    }

    #[test]
    fn rejects_graph_cycles() {
        let mut graph = valid_project_lineage_graph();
        graph.nodes.push(LineageNode::Operation(OperationNode {
            id: "operation-graph-2".to_string(),
            kind: OperationKind::GraphGeneration,
            schema_version: "1".to_string(),
            configuration: Some(json!({"mode": "scatter"})),
            document_ref: None,
            input_ports: vec![LineagePort {
                id: "op-in-2".to_string(),
                name: "source".to_string(),
                payload_kind: PortPayloadKind::Graph,
            }],
            output_ports: vec![LineagePort {
                id: "op-out-2".to_string(),
                name: "result".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
        }));
        graph.edges.push(LineageEdge {
            id: "edge-3".to_string(),
            kind: LineageEdgeKind::Consumes,
            source: LineageEndpoint {
                node_id: "artifact-graph-1".to_string(),
                port_id: "artifact-output".to_string(),
            },
            target: LineageEndpoint {
                node_id: "operation-graph-2".to_string(),
                port_id: "op-in-2".to_string(),
            },
        });
        graph.edges.push(LineageEdge {
            id: "edge-4".to_string(),
            kind: LineageEdgeKind::Produces,
            source: LineageEndpoint {
                node_id: "operation-graph-2".to_string(),
                port_id: "op-out-2".to_string(),
            },
            target: LineageEndpoint {
                node_id: "artifact-table-1".to_string(),
                port_id: "table-input".to_string(),
            },
        });

        let err = validate_lineage_graph(&graph, &docs(&[table_ref("table-1"), graph_ref("graph-1")]))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("cycle")));
    }

    #[test]
    fn rejects_folder_cycles() {
        let folders = vec![
            LogicalFolder {
                id: "folder-a".to_string(),
                name: "A".to_string(),
                kind: LogicalFolderKind::WorkflowRun,
                parent_folder_id: Some("folder-b".to_string()),
            },
            LogicalFolder {
                id: "folder-b".to_string(),
                name: "B".to_string(),
                kind: LogicalFolderKind::WorkflowRun,
                parent_folder_id: Some("folder-a".to_string()),
            },
        ];

        let err = validate_logical_folders(&folders).unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("folder")));
    }

    #[test]
    fn rejects_runs_pointing_at_missing_workflow_revision() {
        let workflows = vec![WorkflowDefinition {
            id: "workflow-1".to_string(),
            name: "Workflow 1".to_string(),
            description: None,
            format_version: "1".to_string(),
            revision: 7,
            input_slots: vec![],
            operations: vec![],
            edges: vec![],
            output_declarations: vec![],
            layout: None,
        }];
        let runs = vec![WorkflowRun {
            id: "run-1".to_string(),
            workflow_id: "workflow-1".to_string(),
            workflow_revision: 8,
            status: WorkflowRunStatus::Pending,
            started_at: None,
            completed_at: None,
            input_bindings: vec![],
            schema_validation_report: None,
            node_results: vec![],
            output_bindings: vec![],
            errors: vec![],
            parent_folder_id: Some("folder-a".to_string()),
        }];

        let err = validate_workflow_runs(&runs, &workflows, &[]).unwrap_err();
        assert!(matches!(err, AppError::InvalidParam(message) if message.contains("revision")));
    }

    #[test]
    fn workflow_and_contract_dtos_default_optional_collections() {
        let workflow = WorkflowDefinition {
            id: "workflow-1".to_string(),
            name: "Workflow 1".to_string(),
            description: None,
            format_version: "1".to_string(),
            revision: 1,
            input_slots: vec![],
            operations: vec![],
            edges: vec![],
            output_declarations: vec![],
            layout: None,
        };
        let schema_contract = SchemaContract {
            schema_fingerprint: "deadbeef".to_string(),
            columns: vec![],
        };
        let logical_folder = LogicalFolder {
            id: "folder-1".to_string(),
            name: "Run 1".to_string(),
            kind: LogicalFolderKind::WorkflowRun,
            parent_folder_id: None,
        };
        let run = WorkflowRun {
            id: "run-1".to_string(),
            workflow_id: "workflow-1".to_string(),
            workflow_revision: 1,
            status: WorkflowRunStatus::Pending,
            started_at: None,
            completed_at: None,
            input_bindings: vec![],
            schema_validation_report: None,
            node_results: vec![],
            output_bindings: vec![],
            errors: vec![],
            parent_folder_id: None,
        };

        let workflow_json = serde_json::to_value(&workflow).unwrap();
        let schema_json = serde_json::to_value(&schema_contract).unwrap();
        let folder_json = serde_json::to_value(&logical_folder).unwrap();
        let run_json = serde_json::to_value(&run).unwrap();

        assert_eq!(workflow_json["inputSlots"], json!([]));
        assert_eq!(workflow_json["operations"], json!([]));
        assert_eq!(workflow_json["edges"], json!([]));
        assert_eq!(workflow_json["outputDeclarations"], json!([]));
        assert_eq!(schema_json["columns"], json!([]));
        assert_eq!(folder_json["parentFolderId"], serde_json::Value::Null);
        assert_eq!(run_json["inputBindings"], json!([]));
        assert_eq!(run_json["nodeResults"], json!([]));
        assert_eq!(run_json["outputBindings"], json!([]));
        assert_eq!(run_json["errors"], json!([]));
    }
}

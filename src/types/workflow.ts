export type ProjectDocumentKind =
  | "table"
  | "tableTransform"
  | "graph"
  | "analysis"
  | "distribution"
  | "fitYByX"
  | "tabulate"
  | "report"
  | "snapshot";

export interface ProjectDocumentRef {
  kind: ProjectDocumentKind;
  id: string;
}

export type PortPayloadKind =
  | "any"
  | "table"
  | "tableTransform"
  | "graph"
  | "analysis"
  | "distribution"
  | "fitYByX"
  | "tabulate"
  | "report"
  | "snapshot";

export type ArtifactKind = Exclude<PortPayloadKind, "any">;

export type OperationKind =
  | "import"
  | "sqlQuery"
  | "tableTransform"
  | "graphGeneration"
  | "analysisExecution"
  | "fitYByX"
  | "tabulate"
  | "reportComposition";

export type WorkflowSemanticExtraKind = "valueOrder" | "spec";

export interface TableColumnConsumption {
  name: string;
  requiredExtraKinds: WorkflowSemanticExtraKind[];
}

export interface TableInputRequirement {
  columns: TableColumnConsumption[];
  completeSchema: boolean;
}

export interface LineagePort {
  id: string;
  name: string;
  payloadKind: PortPayloadKind;
  tableRequirement?: TableInputRequirement;
}

export interface ArtifactNode {
  nodeType: "artifact";
  id: string;
  documentRef: ProjectDocumentRef;
  name: string;
  parentFolderId?: string;
  artifactKind: ArtifactKind;
  inputPort: LineagePort;
  outputPort: LineagePort;
  materializedByWorkflowRunId?: string;
}

export interface OperationNode {
  nodeType: "operation";
  id: string;
  kind: OperationKind;
  schemaVersion: string;
  configuration?: unknown;
  documentRef?: ProjectDocumentRef;
  inputPorts: LineagePort[];
  outputPorts: LineagePort[];
}

export type LineageNode = ArtifactNode | OperationNode;
export type LineageEdgeKind = "consumes" | "produces";

export interface LineageEndpoint {
  nodeId: string;
  portId: string;
}

export interface LineageEdge {
  id: string;
  kind: LineageEdgeKind;
  source: LineageEndpoint;
  target: LineageEndpoint;
}

export interface ProjectLineageGraph {
  id: string;
  name: string;
  graphVersion: number;
  graphHash: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface WorkflowTableColumn {
  name: string;
  colType: string;
  extras?: Record<string, unknown>;
}

export interface WorkflowSourceTable {
  artifactNodeId: string;
  columns: WorkflowTableColumn[];
}

export interface WorkflowOperationInputSchema {
  operationId: string;
  inputPortId: string;
  columns: TableColumnConsumption[];
  completeSchema: boolean;
}

export interface WorkflowExtractionRequest {
  workflowId: string;
  name: string;
  description?: string;
  formatVersion: string;
  revision: number;
  graph: ProjectLineageGraph;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  tableSchemas: WorkflowSourceTable[];
  operationColumnRequirements: WorkflowOperationInputSchema[];
  layout?: WorkflowLayout;
}

export type LogicalFolderKind = "project" | "workflow" | "workflowRun";

export interface LogicalFolder {
  id: string;
  name: string;
  kind: LogicalFolderKind;
  parentFolderId?: string;
}

export interface WorkflowPort {
  id: string;
  name: string;
  payloadKind: PortPayloadKind;
}

export interface SchemaColumnRequirement {
  name: string;
  canonicalDuckdbType: string;
  required: boolean;
  requiredByOperationIds: string[];
  requiredExtras?: Record<string, unknown>;
}

export interface SchemaContract {
  schemaFingerprint: string;
  columns: SchemaColumnRequirement[];
}

export interface InputSlot {
  id: string;
  name: string;
  outputPort: WorkflowPort;
  schemaContract: SchemaContract;
  sourceDocumentRef?: ProjectDocumentRef;
}

export interface WorkflowOperationNode {
  id: string;
  kind: OperationKind;
  schemaVersion: string;
  configuration?: unknown;
  inputPorts: WorkflowPort[];
  outputPorts: WorkflowPort[];
}

export interface WorkflowEndpoint {
  nodeId: string;
  portId: string;
}

export type WorkflowEdgeKind = "consumes" | "produces";

export interface WorkflowEdge {
  id: string;
  kind: WorkflowEdgeKind;
  source: WorkflowEndpoint;
  target: WorkflowEndpoint;
}

export interface OutputDeclaration {
  id: string;
  name: string;
  inputPort: WorkflowPort;
  outputPort: WorkflowPort;
  sourceEndpoint: WorkflowEndpoint;
  artifactKind: ArtifactKind;
}

export interface WorkflowNodePosition {
  nodeId: string;
  x: number;
  y: number;
}

export interface WorkflowLayout {
  nodePositions: WorkflowNodePosition[];
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  formatVersion: string;
  revision: number;
  inputSlots: InputSlot[];
  operations: WorkflowOperationNode[];
  edges: WorkflowEdge[];
  outputDeclarations: OutputDeclaration[];
  layout?: WorkflowLayout;
}

export interface SchemaValidationIssue {
  columnName: string;
  expectedType: string;
  actualType: string;
  affectedOperationIds: string[];
}

export interface SchemaAttributeMismatch {
  columnName: string;
  attributeName: string;
  expectedValue: unknown;
  actualValue?: unknown;
  affectedOperationIds: string[];
}

export interface SchemaValidationReport {
  missingColumns: SchemaValidationIssue[];
  typeMismatches: SchemaValidationIssue[];
  attributeMismatches: SchemaAttributeMismatch[];
  extraColumns: string[];
}

export interface WorkflowInputBinding {
  slotId: string;
  tableDocumentId: string;
}

export interface WorkflowOutputBinding {
  declarationId: string;
  artifactDocumentId: string;
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

export interface WorkflowNodeRunRecord {
  nodeId: string;
  status: WorkflowRunStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRunError {
  code: string;
  message: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowRevision: number;
  status: WorkflowRunStatus;
  startedAt?: string;
  completedAt?: string;
  inputBindings: WorkflowInputBinding[];
  schemaValidationReport?: SchemaValidationReport;
  nodeResults: WorkflowNodeRunRecord[];
  outputBindings: WorkflowOutputBinding[];
  errors: WorkflowRunError[];
  parentFolderId?: string;
}

export interface WorkflowEntryRef {
  id: string;
  name: string;
  revision: number;
  file: string;
}

export interface ProjectWorkflowManifestFields {
  workflowFiles: WorkflowEntryRef[];
  logicalFolders: LogicalFolder[];
  workflowRuns: WorkflowRun[];
  lineageGraph?: ProjectLineageGraph;
}
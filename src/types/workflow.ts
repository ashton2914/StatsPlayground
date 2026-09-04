export type ProjectDocumentKind =
  | "table"
  | "graph"
  | "fitYByX"
  | "tabulate"
  | "snapshot";

export interface ProjectDocumentRef {
  kind: ProjectDocumentKind;
  id: string;
}

export type PortPayloadKind =
  | "any"
  | "table"
  | "graph"
  | "fitYByX"
  | "tabulate"
  | "snapshot";

export type ArtifactKind = Exclude<PortPayloadKind, "any">;

export type OperationKind =
  | "import"
  | "sqlQuery"
  | "graphGeneration"
  | "fitYByX"
  | "tabulate";

export interface LineagePort {
  id: string;
  name: string;
  payloadKind: PortPayloadKind;
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
  nodes: LineageNode[];
  edges: LineageEdge[];
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

export interface SchemaValidationReport {
  missingColumns: SchemaValidationIssue[];
  typeMismatches: SchemaValidationIssue[];
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
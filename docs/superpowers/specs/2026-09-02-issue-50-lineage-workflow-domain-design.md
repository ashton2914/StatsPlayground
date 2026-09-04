# Issue #50 Project Lineage and Workflow Domain Design

**Status:** Approved design
**Date:** 2026-09-02
**Branch:** `feat/issue-50-workflow`
**Related work:** Issue #51 project relationship metadata

## Purpose

StatsPlayground must understand and display the complete logical lineage of files in a project: where data came from, which operation consumed it, which artifacts that operation produced, and how those relationships continue through branches and joins.

Users must also be able to select part of that lineage and save it as a reusable Workflow. A Workflow starts from one or more tables, records the required input schemas, validates replacement tables before execution, and materializes every intermediate and final result into an isolated project folder for each run.

## Scope

The approved implementation scope for the next step is Phase 1 only. It extends Issue #51 with the domain model, validation, archive persistence, and compatibility projection required by future Workflow execution and visualization.

This phase does not implement the complete Workflow executor or graph editor. Those features will consume this model without requiring another persistence migration.

Phases 2 through 4 document expected consumers and evolution constraints for the model. They are roadmap context, not implementation commitments under the current Phase 1 scope.

## Core Decision: Two Graph Layers

The project uses two related but distinct graph models:

1. `ProjectLineageGraph` records facts about concrete project artifacts and the operations that produced or consumed them.
2. `WorkflowDefinition` records a reusable processing template. It contains no concrete project table IDs and uses typed input slots instead.

`WorkflowRun` binds a Workflow version to concrete project tables and records one execution. Keeping facts, templates, and executions separate prevents project identity, template identity, and run state from contaminating each other.

## Project Lineage Graph

The lineage graph is a directed bipartite graph. It does not represent processing as an ambiguous direct edge between two files.

### Artifact Nodes

`ArtifactNode` represents a concrete persisted project artifact:

- Table
- Graph
- Fit Y by X or other analysis document
- Tabulate document
- Snapshot
- Future persisted report or operation output

Each artifact node contains:

- Stable node ID
- `ProjectDocumentRef` with document kind and stable document ID
- Display name
- Optional logical `parentFolderId`
- Artifact kind
- Materialization metadata when produced by a Workflow run

### Operation Nodes

`OperationNode` represents a processing action rather than a file:

- Import
- SQL query
- Graph generation
- Fit Y by X
- Tabulate
- Future registered processing operations

Each operation node contains:

- Stable node ID
- Operation kind and operation schema version
- Input and output port declarations
- Reference to, or embedded snapshot of, the operation configuration
- Optional project document reference when an existing document owns that configuration

### Lineage Edges

Every edge has a stable ID and typed endpoints containing `nodeId` and `portId`.

- `consumes`: `ArtifactNode -> OperationNode`
- `produces`: `OperationNode -> ArtifactNode`

This permits one-to-many branches and many-to-one operations without adding special edge types. A chain such as `Table A -> SQL -> Table B -> Fit -> Analysis.spf` is represented explicitly.

### Issue #51 Compatibility

The current Issue #51 `relationships` collection remains temporarily available as a compatibility projection. It is generated from `ProjectLineageGraph` and is not an independent source of truth.

Existing `sourceDatasetId` fields bootstrap lineage as follows:

1. Create or locate the source Table artifact.
2. Create an operation node associated with the consuming document.
3. Add a `consumes` edge from the Table to the operation.
4. Add a `produces` edge from the operation to the persisted document artifact.

Blank source IDs remain ignored. Dangling document references remain invalid.

## Workflow Definition

A Workflow is created by manually selecting a connected group of lineage nodes and edges.

External incoming Table artifacts become `InputSlot` values. Any external incoming dependency that is not a Table makes the selection invalid. Concrete project IDs are removed from copied operation configurations and replaced with Workflow-local node, port, and slot references.

A `WorkflowDefinition` contains:

- Stable Workflow ID
- Name and optional description
- Independent `formatVersion`
- Workflow revision
- `InputSlot[]`
- Workflow-local `OperationNode[]`
- Typed `WorkflowEdge[]`
- `OutputDeclaration[]`
- Saved layout metadata for visualization

Every operation must be reachable from at least one input slot. The graph must contain at least one Table input slot and must not contain orphan nodes.

### Inputs and Outputs

All Workflow roots are one or more Table input slots. Multi-table operations use separate named input ports.

All intermediate and terminal artifacts are declared as materialized outputs. This preserves inspectability and allows downstream project work to continue from any stage of a run.

## Input Schema Contract

Each `InputSlot` stores a `SchemaContract` derived from only the columns actually referenced by the selected processing chain. Unused columns from the original table do not become requirements.

Each required column records:

- Exact column name
- Canonical DuckDB data type
- `required: true`
- IDs of operations that require the column, for diagnostics

The contract also stores a deterministic `schemaFingerprint` for quick comparison. Per-column validation remains authoritative; a fingerprint mismatch alone is not an error result.

### Version 1 Matching Rules

- Required column names match exactly.
- Types match after normalization to canonical DuckDB types. Textual aliases such as `INT` and `INTEGER` are not treated as different types.
- Replacement tables may contain extra columns.
- Nullability and null values are handled by individual operations and are not part of the version 1 structural contract.
- All input slots are validated before any operation starts.
- Any invalid input prevents the run from starting or creating materialized artifacts.

Validation reports list missing columns, type mismatches, and affected operation IDs. The model reserves room for future safe type coercion and explicit user column mappings without enabling them in version 1.

## Workflow Runs

Every execution creates a new immutable `WorkflowRun` record containing:

- Stable run ID
- Workflow ID and exact revision
- Start and completion timestamps
- Overall status
- Input slot to concrete Table ID bindings
- Full schema validation report
- Per-node execution records
- Output port to materialized artifact mappings
- Structured errors safe to expose through Tauri IPC

Node statuses are `pending`, `running`, `succeeded`, `failed`, or `blocked`.

When a node fails, all dependent downstream nodes become `blocked`. Independent branches continue. Completed artifacts remain available, and the overall run is marked `failed`.

## Logical Result Folders

Workflow results use project-level logical folders rather than operating-system directories. Existing ZIP entry paths do not move.

The project view presents:

```text
Workflow Runs/
  Workflow A/
    Run 2026-09-02 14-30/
      Intermediate Table
      Final Table
      Analysis.spf
      Graph.spgh
```

`ProjectFolder` has a stable ID, name, folder kind, and optional parent folder ID. Project document references gain an optional `parentFolderId`. Every run receives a distinct folder under its Workflow folder, and every materialized artifact from that run points to it.

The folder hierarchy is presentation and organization metadata. Lineage continues to use stable node and document IDs, so moving or renaming a folder does not alter processing relationships.

## Persistence and Compatibility

The `.spprj` manifest gains additive, default-empty fields:

- `lineageGraph`
- `workflows`
- `logicalFolders`
- `workflowRuns`

The existing `folders: string[]` field remains unchanged because it is already part of the archive contract for legacy UI paths. `logicalFolders` carries the stable-ID hierarchy used by Workflow runs; replacing the existing field with structured objects would break compatibility.

Workflow definitions are separately versioned documents indexed by the manifest. New fields use Serde defaults so existing archives load with empty lineage, Workflow, folder, and run collections.

The archive version does not change solely for additive optional metadata. A future incompatible physical layout or changed meaning of existing fields requires an archive version increase.

New readers validate the new collections when present. Existing archive safety rules remain in force: manifest references are authoritative, stable IDs are unique, indexed payloads must exist, and names must remain consistent with indexed documents.

Older application versions are not expected to preserve unknown Workflow metadata after opening and resaving a newer project. This is forward-compatibility behavior, not backward compatibility.

## Validation Rules

Before save and after load, validate:

- Unique graph, node, edge, port, Workflow, folder, and run IDs
- Existing edge endpoints and ports
- `Artifact -> Operation` direction for `consumes`
- `Operation -> Artifact` direction for `produces`
- Compatible port payload kinds
- Existing referenced project documents
- Exactly one producer for each produced materialized artifact
- Valid folder parents and no folder cycles
- Existing Workflow and revision for every run

Additionally, every Workflow must:

- Have at least one Table input slot
- Be acyclic
- Have every operation reachable from an input slot
- Contain no unresolved external dependencies
- Use valid operation kinds and configuration versions
- Have unique input and output port bindings

The project lineage model should also be acyclic for newly generated relationships. If future in-place mutation must be represented, it will require artifact version nodes rather than introducing a cycle between one mutable artifact identity and an operation.

## Ownership Boundaries

### Rust Backend

Rust owns:

- Lineage construction and normalization
- Legacy relationship projection
- Selection-to-Workflow extraction
- Schema contract derivation and validation
- DAG and referential validation
- Archive serialization and deserialization
- Future execution scheduling and materialization

All service methods return `Result<T, AppError>`. IPC handlers remain thin and delegate to services.

### TypeScript Frontend

TypeScript types mirror Rust DTOs in camelCase. A future Workflow Zustand store owns loaded graph data, node selection, saved Workflows, schema validation results, and run progress.

React owns rendering and interaction only. The Workflow view will be added beside Files and Snapshots. `@xyflow/react` is the recommended node-edge interaction library; ECharts remains dedicated to statistical charts.

## Error Handling

Malformed persisted graphs fail archive validation with an `InvalidParam` or archive-specific mapped `AppError`, including the invalid stable ID without exposing filesystem paths.

Schema preflight failure is a normal validation result, not an execution exception. Runtime node failures are captured in `WorkflowRun` and returned as structured status while unexpected database or file failures also map to the appropriate `AppError` variant.

## Delivery Phases

### Phase 1: Domain Foundation

- Replace Issue #51's direct relationship authority with the typed lineage graph.
- Generate the compatibility `relationships` projection.
- Add Workflow, schema contract, folder, and run DTOs.
- Add graph and Workflow validation.
- Persist and round-trip all new structures.
- Keep all collections empty by default for legacy projects.

### Phase 2: Lineage Visualization and Workflow Capture

- Add the Workflow activity-bar entry and graph view.
- Render complete project lineage.
- Support manual connected-subgraph selection.
- Save a valid selection as a Workflow.
- Display logical Workflow and run folders in the project tree.

### Phase 3: Execution

- Bind concrete tables to input slots.
- Run schema preflight.
- Schedule ready nodes in topological order.
- Continue independent branches after failures.
- Materialize all outputs into a new run folder.
- Persist run status and artifact lineage.

### Phase 4: Compatibility Enhancements

- Add safe type compatibility rules.
- Add explicit column mapping UI and persistence.
- Add operation-specific schema constraints where needed.

## Test Strategy

Phase 1 uses test-driven development and adds focused Rust tests for:

- Legacy project default loading
- Existing `sourceDatasetId` lineage bootstrapping
- Multi-input, branching, and multi-stage lineage
- Legacy relationship projection
- Duplicate and dangling node, edge, port, folder, Workflow, and run references
- Edge direction and port compatibility
- Workflow cycle and orphan rejection
- Selected subgraph conversion to Table input slots
- Non-Table external dependency rejection
- Minimal required-column schema derivation
- Strict schema success, missing-column failure, type mismatch, and extra-column success
- ZIP round-trip persistence without changing existing indexed document behavior

Frontend contract tests will verify Rust/TypeScript field parity before Phase 2. Full frontend build and focused Rust archive tests remain required validation gates.

## Acceptance Criteria for the Foundation

The domain foundation is complete when:

1. A project can persist and reload a validated multi-stage lineage graph that answers source, consumer, producer, and downstream queries.
2. Existing Issue #51 relationships can be derived from that graph without becoming a second authority.
3. A connected selected subgraph can be represented as a project-independent Workflow with one or more Table input slots.
4. Each input slot carries a deterministic strict schema contract for the columns actually required by the selected chain.
5. Workflow runs and their materialized artifacts can be assigned to stable logical folders without changing existing archive entry paths.
6. Older `.spprj` archives continue to load with empty defaults.
7. Malformed graphs, workflows, folders, and run references are rejected before use.
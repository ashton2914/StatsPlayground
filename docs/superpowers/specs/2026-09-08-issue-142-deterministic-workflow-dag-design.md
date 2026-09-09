# Issue 142 Deterministic Workflow DAG Design

## Purpose

StatsPlayground must represent, persist, inspect, and repeatedly execute complete project workflows rather than treating Workflow as a Graph Builder selection shortcut.

A workflow may contain branches, joins, and multiple document kinds. Representative paths include:

- Table -> Graph
- Table -> Analysis
- Table -> Tabulate -> Table
- Table -> Table Transform -> Table -> Analysis -> Report
- Table -> Graph + Analysis + Tabulate -> Report

For the same Workflow revision, input content, persisted random seed, and engine version, repeated execution must produce the same normalized business-output fingerprints.

## Current Failure

The current model can express a `Consumes` edge from a Table artifact to a Graph Generation operation and can attach a schema contract to the resulting Workflow input slot. However, `useWorkflowStore.lineageGraph` is loaded when a project opens while Graph Builder state continues to change in `useGraphBuilderStore`. Workflow extraction therefore may inspect a stale operation configuration instead of the current downstream document.

The existing project relationship builder is also narrower than the required workflow model. It primarily reconstructs Table-as-source relationships for Graph, Fit Y by X, and Tabulate targets. Analysis documents, Table-producing operations, Report composition, multi-input operations, and complete multi-hop dependencies do not share one authoritative port graph. `WorkflowRun` is persisted as a record type, but there is no general deterministic topological executor or atomic multi-node commit protocol.

## Decisions

### State authority

Current project documents are authoritative. The project dependency graph is a deterministic projection of those documents.

The dependency graph is persisted in `.spprj` for portability, inspection, migration, and audit, but it is not an independently editable source of truth. On project load, StatsPlayground rebuilds the graph from current documents and compares its normalized hash with the persisted graph. A missing or stale graph is replaced by the rebuilt projection and marks the project for migration.

### Repeated-run outputs

Workflow outputs have stable project document identities. A successful rerun atomically replaces their business content rather than creating an unbounded set of duplicate documents.

Every execution also creates an immutable `WorkflowRun` snapshot containing the Workflow revision, input bindings, input fingerprints, normalized configuration fingerprint, random seed, engine version, output fingerprints, timing metadata, and final status.

### Transaction boundary

A Workflow run is all-or-nothing. Intermediate Tables and documents remain hidden in staging until all operations succeed and all output contracts validate. A failed run removes staging state and leaves the previous successful project outputs unchanged.

### Determinism standard

Determinism is measured through normalized business-content fingerprints, not byte-identical project archives. Audit fields such as execution timestamps and elapsed time do not participate in output fingerprints.

Randomized operations must persist and reuse an explicit seed. Operations that depend on an unpinned clock, external mutable service, unstable ordering, or another unrecorded input are not deterministic and cannot participate in a repeatable Workflow unless their adapter captures that dependency as an input.

### Table-producing results

Analysis and Tabulate operations do not implicitly become Tables. An operation that supports downstream tabular use declares an explicit Table output port with its own schema contract. This keeps presentation artifacts separate from data artifacts and makes downstream requirements auditable.

## Canonical Dependency Model

### Nodes

The graph distinguishes operations from artifacts.

Artifact kinds include:

- Table
- Graph
- Analysis
- Tabulate
- Report
- Snapshot
- Legacy Fit Y by X during migration

Operation kinds include:

- Import
- SQL Query
- Table Transform
- Graph Generation
- Analysis Execution
- Tabulate
- Report Composition

Each operation has a versioned configuration and typed input/output ports. The model does not assume a single input, a single output, or Table-only edges.

### Ports and edges

Every port has:

- A stable ID within the owning operation or artifact.
- A payload kind.
- Optional schema requirements for Table payloads.
- Cardinality rules.

`Consumes` edges connect artifact output ports to operation input ports. `Produces` edges connect operation output ports to artifact input ports. A Table requirement is bound to the exact target operation input port, not merely to an operation or source document.

This supports branching, joining, multiple final outputs, and paths in which an operation exposes both a presentation artifact and a Table artifact.

### Typed operation adapters

Each executable operation kind registers a typed adapter. An adapter owns:

- Parsing and validating its versioned configuration.
- Resolving current input document references.
- Declaring input and output ports.
- Deriving only the columns and semantic extras actually consumed at each Table input port.
- Producing a normalized configuration used for fingerprinting.
- Declaring whether the operation is executable in Workflow.
- Dispatching to the existing Rust-authoritative service implementation.

Graph Generation derives requirements from only its active mode plus active filters. Inactive 2D, 3D, or multivariate state does not constrain the input schema. Analysis adapters derive requirements from each Analysis definition. Tabulate derives row, column, statistics, weight, and filter requirements. Report Composition consumes the document references actually embedded in the report.

An operation with no registered adapter, an unknown adapter version, an unresolved input, or an indeterminate consumed-column set blocks Workflow extraction with a precise operation and port error.

## Live Project Graph Projection

A pure projection service receives current document snapshots from the existing project stores and returns a normalized `ProjectDependencyGraph`.

The projection:

1. Creates one artifact node per current project document.
2. Uses each registered adapter to create operation nodes and typed ports.
3. Connects source document references to operation input ports.
4. Connects operation output ports to their produced artifacts.
5. Sorts nodes, ports, and edges by stable IDs before hashing or serialization.
6. Rejects duplicate IDs, unresolved references, invalid payload connections, and cycles where the project model requires a DAG.

Workflow selection, extraction, project save, and dependency visualization all consume this projection. They do not read a separately mutable lineage snapshot.

The persisted `.spprj` graph includes a graph schema version and normalized graph hash. Load-time rebuild prevents old archives or stale in-memory state from silently controlling new Workflow extraction.

## Workflow Extraction

Workflow extraction freezes a selected subgraph into a versioned `WorkflowDefinition`.

For every external dependency entering the selected subgraph, extraction creates one Workflow input slot per source artifact. If the same source feeds multiple selected operations, the slot contract is the union of their port-specific requirements. Each required column records the Workflow-local operation IDs that consume it.

Only consumed columns constrain compatibility. Unconsumed columns may be absent, added, or have different types. Only semantic extras consumed by the downstream adapter are copied into `requiredExtras`.

If an operation cannot determine its requirements, extraction fails. It must never broaden the contract to all source columns and must never persist an empty contract as if it were valid.

Stable Workflow output IDs are assigned during extraction and persist across runs of the same Workflow revision. Changing topology, operation configuration, ports, or output identity creates a new Workflow revision.

## Deterministic Execution

### Planning

The Rust planner validates the frozen Workflow before execution:

- Every input slot is bound exactly once unless the port declares optional cardinality.
- Bound artifact payload kinds match the slot ports.
- Table schemas satisfy consumed-column contracts.
- Every operation kind and schema version has an executor.
- Every edge references an existing compatible port.
- The selected graph is acyclic.

The planner uses a stable topological order. When multiple nodes are ready, the lexicographically smaller stable node ID runs first. This removes iteration-order differences from execution and fingerprinting.

### Input freeze

At run start, the coordinator records each bound input's stable document ID, data generation, normalized schema fingerprint, and normalized content fingerprint. Reads carry the frozen generation. If an input changes before commit, the run fails as stale and publishes no output.

### Staging

Table-producing operations write to run-scoped DuckDB staging names. Document-producing operations build a run-scoped staging bundle whose references point to stable Workflow output identities.

Analysis remains Rust-authoritative and follows the Analysis persistence standard: definitions and presentation state are persisted, while statistical computation is performed by registered Rust services. A materialized Analysis Table output exists only when the Analysis adapter explicitly declares and executes that output port.

### Commit and rollback

After all operations complete, the coordinator validates output payload kinds, schemas, references, and fingerprints. It then atomically swaps staged Tables into their stable output identities and emits one commit packet for all document outputs and the final immutable `WorkflowRun`.

The frontend applies the commit packet through one Workflow commit coordinator before clearing the busy state. No intermediate document is made visible. Startup recovery removes abandoned staging data and never promotes a run that lacks a completed commit marker.

### Fingerprints

Table fingerprints include normalized column definitions, required semantic metadata, deterministic row ordering, null representation, and canonical value encoding. An operation that does not define stable row ordering must add a stable ordering key before its output can be fingerprinted as deterministic.

Document fingerprints use canonical JSON with sorted object keys and stable array ordering where order is not semantically meaningful. Runtime timestamps, elapsed time, UI-only transient state, and caches are excluded.

For a previous successful run with the same Workflow revision, input fingerprints, configuration fingerprint, seed, and engine version, differing output fingerprints produce a `determinismViolation` failure. The new outputs are not committed.

## Project Archive Contract

The `.spprj` archive persists:

- Current project documents.
- The normalized project dependency graph, graph schema version, and graph hash.
- Versioned Workflow definitions.
- Stable Workflow output identity mappings.
- Immutable WorkflowRun manifests.
- No run-scoped staging data.

Archive validation checks document references, graph endpoints, operation adapter versions, Workflow revision references, output identity uniqueness, and completed run fingerprints.

Legacy archives without a graph hash rebuild the graph from documents. Legacy saved Workflows with empty input contracts are not silently treated as valid. They are marked `requiresReextraction` and cannot run until recreated from the current project graph.

## Error Handling

Errors identify the owning Workflow, operation, port, and document without exposing absolute paths. Categories include:

- Unsupported operation or adapter version.
- Unresolved document reference.
- Invalid edge or payload kind.
- Indeterminate consumed columns.
- Input schema mismatch.
- Stale input generation.
- Operation execution failure.
- Output contract violation.
- Determinism violation.
- Atomic commit or recovery failure.

The last successful outputs remain visible after every failed run. Raw backend exceptions stay internal and map to `AppError` variants.

## Delivery Phases and Commit Boundaries

### Phase 0: Design baseline

Commit this approved design independently from code changes.

### Phase 1: Live dependency projection

Add the typed adapter contracts and a pure current-document-to-DAG projection. Replace Workflow selection's dependency source with that projection. Keep loaded legacy lineage only as migration input.

### Phase 2: Port-level schema contracts

Derive consumed columns and semantic extras through adapters. Complete the saved input schema inspector and reject empty or indeterminate contracts. Add realistic current-store integration coverage rather than configuration-only fixtures.

### Phase 3: Whole-project graph persistence

Extend project document, artifact, operation, port, and edge contracts for Analysis, Table-producing operations, and Report Composition. Persist the graph version/hash and rebuild it on load. Cover multi-hop, branch, join, and Report embed relationships.

### Phase 4: Deterministic planner and run protocol

Implement stable topological planning, input freezes, explicit seeds, canonical fingerprints, output identity mappings, and immutable WorkflowRun manifests without publishing partial outputs.

### Phase 5: Atomic executors

Connect data-producing operations to DuckDB staging and document-producing operations to the staging bundle. Deliver data-operation executors and document-operation executors as separate commits because each has an independent failure and review boundary.

### Phase 6: Recovery and end-to-end stability

Add abandoned-run recovery, deterministic rerun checks, `.spprj` save/open/rerun coverage, and full UI acceptance. Verify a representative chain that branches through Graph, Analysis, and Tabulate, materializes a downstream Table, and joins those artifacts into a Report.

Every implementation phase follows RED -> GREEN -> affected suites -> production build and Rust verification -> bounded diff review -> one conventional commit. Existing uncommitted Issue 142 code is incorporated only when its owning phase is complete and independently passing.

## Acceptance Criteria

- Saving a Workflow always uses current document state, including unsaved Graph/Analysis/Tabulate/Report edits.
- A Table input schema lists exactly the union of columns and semantic extras consumed by downstream operation input ports.
- Inactive Graph modes and unconsumed source columns do not constrain a Workflow input.
- Multi-hop, branching, joining, multiple outputs, and Report composition survive `.spprj` save/open unchanged.
- Unsupported or indeterminate operations fail extraction before a runnable Workflow is persisted.
- A failed run leaves every prior successful output unchanged.
- A successful rerun updates the same stable output document identities.
- Equal Workflow revision, input fingerprints, seed, configuration fingerprint, and engine version produce equal normalized output fingerprints.
- A fingerprint difference under equal deterministic inputs is reported and not committed.
- Old Workflows with empty contracts are visibly blocked and require re-extraction.
- Frontend production build, focused component/contract suites, Rust tests, archive tests, and deterministic end-to-end tests pass before manual acceptance.

## Out of Scope

- Distributed execution across machines.
- Concurrent execution of independent Workflow branches in the first implementation.
- Automatic execution triggered by every source-table edit.
- Silent best-effort execution of unsupported operations.
- Treating approximate statistical equality as deterministic equality.
# Issue #50 Lineage and Workflow Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 project-lineage, reusable Workflow, schema-contract, logical-folder, and run-record foundation on top of Issue #51.

**Architecture:** Add a focused Rust domain module containing serializable DTOs and pure validation/extraction functions. Keep `.spprj` archive indexing and ZIP I/O in `spprj_archive.rs`; make its legacy `relationships` field a projection of the new lineage graph. Mirror the persisted contract in TypeScript without adding the Phase 2 UI or Phase 3 executor.

**Tech Stack:** Rust 2021, Serde/serde_json, Tauri `AppError`, ZIP archive service, TypeScript strict mode, Vite.

**Spec:** `docs/superpowers/specs/2026-09-02-issue-50-lineage-workflow-domain-design.md`

## Global Constraints

- Phase 1 only: no Workflow UI, graph editor, scheduler, or operation execution.
- Preserve `.spprj` archive version `4.0.0`; all new manifest fields use empty Serde defaults.
- Preserve existing `folders: string[]`; stable Workflow result hierarchy uses additive `logicalFolders`.
- Preserve `relationships` for compatibility, but derive it from `ProjectLineageGraph`.
- Workflow roots are one or more Table input slots and Workflow graphs must be acyclic.
- Version 1 schema matching requires exact names and canonical DuckDB types while allowing extra columns.
- Rust service failures return `Result<T, AppError>` and never use `unwrap()`/`expect()` in production code.
- Existing user changes in `project_service.rs` and `spprj_archive.rs` are the Issue #51 baseline and must be evolved, not discarded.

---

### Task 1: Domain DTOs and Graph Validation

**Files:**
- Create: `src-tauri/src/services/workflow_domain.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Interfaces:**
- Produces: `ProjectLineageGraph`, `LineageNode`, `ArtifactNode`, `OperationNode`, `LineagePort`, `LineageEdge`, `LineageEndpoint`, `LineageEdgeKind`, `PortPayloadKind`.
- Produces: `validate_lineage_graph(&ProjectLineageGraph, &HashSet<ProjectDocumentRef>) -> Result<(), AppError>`.
- Produces: Workflow, schema, logical-folder, and run DTOs with Serde camelCase and empty defaults where collections are optional.

- [ ] **Step 1: Write failing unit tests in `workflow_domain.rs`**

Cover a valid `Table -> Operation -> Graph` graph, duplicate node/edge/port IDs, dangling endpoints, invalid bipartite direction, duplicate artifact producers, graph cycles, folder cycles, and run references to missing Workflow revisions.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`

Expected: compilation fails because the domain types and validators do not exist.

- [ ] **Step 3: Implement minimal DTOs and validators**

Use a tagged `LineageNode` enum with artifact and operation variants. Validate IDs with `HashSet`, resolve endpoints through a node/port index, enforce edge direction, count producers, and detect cycles with Kahn's algorithm. Keep all functions pure and independent of ZIP I/O.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`

Expected: all `workflow_domain` tests pass.

- [ ] **Step 5: Commit**

Commit only the module and module registration with `feat(workflow): add lineage domain model`.

### Task 2: Build Concrete Project Lineage and Legacy Projection

**Files:**
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: `GraphDoc`, fit/tabulate JSON bodies, manifest document references.
- Produces: `build_project_lineage(...) -> ProjectLineageGraph` for current Table, Graph, Fit Y by X, and Tabulate artifacts.
- Produces: `project_relationships_from_lineage(&ProjectLineageGraph) -> Vec<ProjectRelationship>`.

- [ ] **Step 1: Write failing archive tests**

Add tests proving one source table creates `Table -> graph operation -> Graph`, Fit Y by X and Tabulate chains; blank `sourceDatasetId` creates no operation; branching consumers share one Table artifact; projection recreates one `dataSource` relationship per concrete source/target pair; dangling source IDs fail validation.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::lineage`

Expected: tests fail because `ProjectManifest` has no `lineageGraph` and relationships are still built directly.

- [ ] **Step 3: Implement lineage construction and projection**

Add default `lineage_graph` to `ProjectManifest`. Create deterministic node, operation, port, and edge IDs from document kind/ID so repeated saves are stable. Build operations only for persisted consumers with nonblank sources. Generate `relationships` by traversing `Artifact -> Operation -> Artifact`, deduplicate, and sort by kind/ID.

- [ ] **Step 4: Validate graph before returning `build_bundle`**

Build the set of manifest-indexed `ProjectDocumentRef` values, call `validate_lineage_graph`, then derive compatibility relationships from the validated graph.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive`

Expected: all archive tests pass, including existing #51 tests.

- [ ] **Step 6: Commit**

Commit the domain and archive changes with `feat(project): persist typed lineage graph`.

### Task 3: Workflow Extraction and Strict Schema Contracts

**Files:**
- Modify: `src-tauri/src/services/workflow_domain.rs`

**Interfaces:**
- Produces: `extract_workflow(request: WorkflowExtractionRequest) -> Result<WorkflowDefinition, AppError>`.
- Produces: `canonical_duckdb_type(&str) -> String`.
- Produces: `schema_fingerprint(&[SchemaColumnRequirement]) -> String`.
- Produces: `validate_schema_contract(&SchemaContract, &[TableColumn]) -> SchemaValidationReport`.

- [ ] **Step 1: Write failing extraction tests**

Cover manual connected selection, external Table conversion to an input slot, two external Tables feeding one operation, non-Table external dependency rejection, unresolved dependency rejection, disconnected/orphan selection rejection, cycle rejection, and absence of concrete project table IDs in the serialized Workflow.

- [ ] **Step 2: Write failing schema tests**

Cover minimal required columns from an operation-to-column requirement map, canonical aliases (`INT`/`INTEGER`), deterministic fingerprints independent of input order, valid exact schema, allowed extra columns, missing columns, and type mismatches with affected operation IDs.

- [ ] **Step 3: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`

Expected: extraction and schema tests fail because the functions are absent.

- [ ] **Step 4: Implement extraction and schema validation**

Copy selected operations and internal artifact nodes into Workflow-local IDs. Convert incoming external Table artifacts into deduplicated `InputSlot` values. Build required columns only from the supplied operation requirement map and source `TableDoc.columns`. Use a small deterministic FNV-1a fingerprint over sorted `name\0canonicalType` pairs; the per-column report remains authoritative.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`

Expected: all domain tests pass.

- [ ] **Step 6: Commit**

Commit with `feat(workflow): add extraction and schema contracts`.

### Task 4: Archive Workflow Documents, Runs, and Logical Folders

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`

**Interfaces:**
- Adds manifest fields: `workflowFiles`, `logicalFolders`, `workflowRuns`.
- Adds bundle field: `workflows: Vec<WorkflowDefinition>`.
- Uses archive entries: `workflows/<workflow-id>.json`, indexed by `WorkflowEntryRef` with ID, name, revision, and file.

- [ ] **Step 1: Write failing backward-compatibility and round-trip tests**

Cover default-empty loading from old manifest JSON, build/write/read round trip of lineage plus a Workflow document, logical folders, and run metadata; missing Workflow entry; body/index ID or revision mismatch; duplicate Workflow IDs; invalid folder/run references; and archive validation opening each indexed Workflow JSON.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive`

Expected: tests fail because Workflow entries and bundle payloads are not persisted.

- [ ] **Step 3: Implement regular archive read/write and validation**

Allocate stable internal Workflow paths from IDs, serialize Workflow definitions as separate JSON entries, load only manifest-indexed workflows, validate body/index identity, and call the pure domain collection validator before write and after read.

- [ ] **Step 4: Update streaming save integration**

Ensure the streaming writer preserves the same manifest fields and writes indexed Workflow entries. Keep existing table streaming and flat data paths unchanged.

- [ ] **Step 5: Update all bundle/manifest literals**

Initialize new fields with empty defaults in legacy loaders, empty project creation, project service tests, and streaming writer tests. Do not alter unrelated project state or frontend return contracts in Phase 1.

- [ ] **Step 6: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive`

Then run: `cargo test --manifest-path src-tauri/Cargo.toml streaming_project_writer`

Expected: both focused suites pass.

- [ ] **Step 7: Commit**

Commit with `feat(project): archive workflow domain metadata`.

### Task 5: TypeScript Contract and Final Verification

**Files:**
- Create: `src/types/workflow.ts`
- Create: `tests/workflowDomainContract.test.ts`

**Interfaces:**
- Mirrors every persisted Rust Workflow/lineage/folder/run DTO in camelCase.
- Does not introduce a service, store, component, or dependency in Phase 1.

- [ ] **Step 1: Write failing contract test**

The test imports representative TypeScript values, serializes them, and asserts the discriminants and camelCase keys expected by Rust (`nodeType`, `lineageGraph`, `workflowFiles`, `logicalFolders`, `workflowRuns`, `schemaFingerprint`, and `parentFolderId`).

- [ ] **Step 2: Verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workflowDomainContract.test.ts`

Expected: compile failure because `src/types/workflow.ts` does not exist.

- [ ] **Step 3: Add strict TypeScript mirrors**

Use discriminated unions for lineage nodes and execution statuses. Use `unknown` for opaque operation configuration. Keep names and optionality aligned with Serde output.

- [ ] **Step 4: Verify focused contract and frontend build**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workflowDomainContract.test.ts`

Run: `npx vite build`

Expected: contract test and Vite build pass.

- [ ] **Step 5: Run final backend verification**

Run from `src-tauri/`: `cargo fmt --check -- src/services/workflow_domain.rs src/services/spprj_archive.rs src/services/project_service.rs src/services/streaming_project_writer.rs`

Run: `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`

Run: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive`

Run: `cargo test --manifest-path src-tauri/Cargo.toml streaming_project_writer`

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

Run: `git diff --check`

Expected: all commands exit 0 with no test failures or warnings.

- [ ] **Step 6: Review requirements and commit**

Compare the final diff against every Phase 1 acceptance criterion in the spec. Commit only the TypeScript contract/test and any necessary final local corrections with `test(workflow): verify persisted domain contract`.

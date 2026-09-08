# Deterministic Workflow DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live, project-wide dependency DAG and a deterministic, atomic Workflow runner for multi-hop Table, Table Transform, Graph, Analysis, Tabulate, and Report flows.

**Architecture:** Current project documents remain authoritative. Typed adapters project them into a normalized port graph used by Workflow extraction. Rust validates and persists the graph, plans stable topological execution, fingerprints inputs/configuration/outputs, and atomically publishes staged outputs. Stable output IDs are refreshed while immutable run manifests retain audit evidence.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, Tauri v2, Rust 2021, DuckDB, serde, sha2, Playwright Component Testing.

**Approved Spec:** `docs/superpowers/specs/2026-09-08-issue-142-deterministic-workflow-dag-design.md`

## Global Constraints

- Current documents are authoritative; persisted lineage is a versioned, hash-verified projection.
- Contracts contain only columns and semantic extras consumed at the exact downstream port.
- Unknown operation kinds, adapter versions, references, or requirements block extraction and execution.
- Rust remains the statistical compute authority; Analysis persists definition and presentation only.
- Analysis registry, TypeScript, archive, and Rust validation stay in exact parity.
- Runs preserve stable output IDs, append immutable manifests, and publish no partial result.
- Equal Workflow revision, inputs, normalized configuration, seed, and engine version require equal output fingerprints.
- Consume Issue 89's `.sptbtf` contracts and executor; do not duplicate its nine operations.
- Use parameterized DuckDB statements and validated identifiers.
- Run all commands from `/Users/ashton/git/ashton2914/StatsPlayground-issue-142`.
- Every task uses observed RED, minimal GREEN, regressions, `git diff --check`, and one Conventional Commit.

## Task 1: Live Project Dependency Projection

**Files**

- Create: `src/workflow/operationAdapters.ts`
- Create: `src/workflow/projectDependencyGraph.ts`
- Modify: `src/types/workflow.ts`
- Modify: `src/types/report.ts`
- Test: `tests/workflowProjectDependencyGraph.test.ts`
- Test: `tests/workflowUiContract.test.ts`

**Interfaces:** `ProjectDocumentSnapshot`, `WorkflowOperationAdapter<T>`, `TableInputRequirement`, `buildProjectDependencyGraph(snapshot)`, and canonical graph hash input.

- [ ] Write a failing fixture with Table -> Graph, Table -> Analysis, Table -> Tabulate, and Graph + Analysis + Tabulate -> Report. Assert typed ports and `consumes`/`produces` edges. Mutate the Graph's active encoding and assert a fresh projection changes without mutating the first.
- [ ] Run RED: `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowProjectDependencyGraph.test.ts`. Expected: missing adapter/projection APIs.
- [ ] Add `tableTransform`, `graph`, `analysis`, `tabulate`, and `report` document/operation kinds plus typed payload ports.
- [ ] Add `TableColumnConsumption { name, requiredExtraKinds }` and `TableInputRequirement { columns, completeSchema }`.
- [ ] Register Graph, Analysis, Tabulate, and Report adapters. Graph reads only active mode/filters. Analysis reads registered-kind fields. Tabulate reads row/column/statistic fields. Report consumes parsed embeds and requires a complete schema only for directly embedded Tables.
- [ ] Sort nodes, ports, and edges by stable ID. Reject duplicate IDs, unresolved embeds, incompatible payloads, and unsupported Analysis kinds.
- [ ] Run GREEN and adjacent checks:
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowProjectDependencyGraph.test.ts`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowUiContract.test.ts`, and
  `npm run test:analysis:contracts`.
- [ ] Commit: `feat(workflow): project live document dependencies`.

## Task 2: Port Requirements And Schema Inspector

**Files**

- Modify: `src/components/Workspace.tsx`
- Modify: `src/utils/workflowSchema.ts`
- Modify: `src/stores/useWorkflowStore.ts`
- Modify: `src/components/workflow/WorkflowView.tsx`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Test: `tests/workflowUiContract.test.ts`
- Test: `tests/workflowDomainContract.test.ts`
- Test: `tests/e2e/WorkflowView.spec.tsx`

**Interfaces:** `deriveWorkflowOperationInputSchemas(graph, selectedNodeIds)` and persisted input `SchemaContract` inspection.

- [ ] Add a failing regression where active Graph 2D consumes `batch`, `yield`, and filter `site`, while inactive modes reference other columns. Change active Y to `temperature`; only the second contract changes.
- [ ] Run RED: `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowUiContract.test.ts`. Expected: stale lineage configuration or absent port requirements.
- [ ] In `Workspace`, snapshot current document stores and rebuild the dependency graph at save-selection time. Use it for selected edges, external inputs, requirements, and extraction. Loaded lineage is migration input only.
- [ ] Send explicit `(operationId, inputPortId, columns, completeSchema)` requirements to Rust. `build_input_slots` copies only declared columns and each column's declared extras. Missing/empty non-complete consumption returns `InvalidParam`.
- [ ] Finish the existing schema inspector patch. Double-click/Enter/Space opens; Escape/close dismisses. Show persisted column, canonical type, required properties, and local consumers, never current source metadata.
- [ ] Run GREEN:
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowUiContract.test.ts`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowDomainContract.test.ts`,
  `PLAYWRIGHT_CHANNEL=chrome npm exec -- playwright test --config=playwright-ct.config.ts tests/e2e/WorkflowView.spec.tsx --grep "schema"`,
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_domain`, and
  `npm run build`.
- [ ] Commit: `fix(workflow): derive input contracts from live consumers`.

## Task 3: Versioned Whole-Project Graph Persistence

**Files**

- Modify: `src/types/workflow.ts`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Create: `tests/workflowProjectContracts.test.ts`
- Test: `tests/analysisProjectContracts.test.ts`
- Test: Rust `spprj_archive` tests

**Interfaces:** `graphVersion`, `graphHash`, canonical graph bytes, load migration, and archive reference validation.

- [ ] Write failing round-trip tests covering Table -> Analysis, Table -> Tabulate -> Table, and Graph + Analysis + Tabulate -> Report.
- [ ] Add legacy-without-hash and stale-hash tests. Both rebuild from documents and return `requiresMigration = true`.
- [ ] Run RED: `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::workflow_graph`.
- [ ] Add graph version 2 and SHA-256 hashing using existing `sha2`. Canonicalize recursive JSON keys and sort nodes, ports, edges, columns, and extras.
- [ ] Persist defaulted graph version/hash/body. Validate Analysis, Report, and Table Transform references, dangling endpoints, duplicate stable outputs, and graph/document disagreement.
- [ ] Derive the graph after document load. Missing/stale metadata returns the rebuilt graph; persisted graph configuration never overrides documents.
- [ ] Run GREEN:
  `cargo test --manifest-path src-tauri/Cargo.toml spprj_archive`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowProjectContracts.test.ts`,
  `npm run test:analysis:typecheck`,
  `npm run test:analysis:contracts`, and
  `npm run build`.
- [ ] Commit: `feat(project): persist verified workflow dependency graph`.

## Task 4: Planner, Run Manifest, And Fingerprints

**Files**

- Create: `src-tauri/src/services/workflow_planner.rs`
- Create: `src-tauri/src/services/workflow_fingerprint.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src/types/workflow.ts`
- Test: `tests/workflowDomainContract.test.ts`
- Test: Rust tests in both new modules

**Interfaces:** `WorkflowExecutionPlan`, immutable `WorkflowRun`, canonical JSON/document hashes, Table content hash, and determinism comparison.

- [ ] Write failing tests proving shuffled insertion order yields the same operation order. A cycle returns path-safe `InvalidParam` naming involved IDs.
- [ ] Write failing hash tests: reordered JSON hashes equally; semantic changes differ; audit timestamps are excluded. Table hashes differ on schema, row order, null placement, or values.
- [ ] Run RED: `cargo test --manifest-path src-tauri/Cargo.toml workflow_planner` and `cargo test --manifest-path src-tauri/Cargo.toml workflow_fingerprint`.
- [ ] Plan with a `BTreeSet<String>` ready queue. Validate endpoints, payloads, cardinality, contracts, adapter versions, and stable output IDs before returning.
- [ ] Freeze Workflow ID/revision, input generation/hash, output identities, normalized configuration hash, seed, and engine version.
- [ ] Extend run records with configuration, input, and output hashes plus optional `determinismBaselineRunId`. Legacy runs deserialize as non-comparable; never fabricate hashes.
- [ ] Encode Table values with type tags, lengths, and distinct null markers. Read by stable internal row identity; unordered operations must define ordering.
- [ ] Run GREEN:
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_planner`,
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_fingerprint`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowDomainContract.test.ts`, and
  `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Commit: `feat(workflow): plan deterministic workflow runs`.

## Task 5: Atomic Table-Producing Executors

**Prerequisite:** Issue 89 must expose its approved `TableTransformDefinition`, input binding, stable output ID, schema preflight, and staged/atomic service. Integrate reviewed commits only after explicit repository authorization. Do not recreate its nine operation definitions.

**Files**

- Create: `src-tauri/src/services/workflow_executor.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/table_transform_service.rs` after Issue 89 integration
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/state.rs`
- Test: Rust `workflow_executor` and Issue 89 service tests

- [ ] Add failing one-input, two-input, and ordered multi-input Workflow tests using Sort/Stack, Join, and Concatenate. Staging tables must not appear in project listings.
- [ ] Seed existing outputs, fail downstream execution, and assert unchanged content/generation with no staging remains. Change input generation after planning and assert commit fencing.
- [ ] Run RED: `cargo test --manifest-path src-tauri/Cargo.toml workflow_executor::tests::table`.
- [ ] Acquire one mutation permit per run. Every Table operation receives validated sources and an executor-owned staging ID. Dropping an uncommitted session removes metadata and physical tables.
- [ ] Validate all staged schemas/hashes first. One DuckDB transaction replaces stable bodies/metadata, increments each generation once, records completion, and removes staging. Any error rolls all outputs back.
- [ ] Run GREEN:
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_executor::tests::table`,
  `cargo test --manifest-path src-tauri/Cargo.toml table_transform_service`,
  `cargo test --manifest-path src-tauri/Cargo.toml data_service`, and
  `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- [ ] Commit: `feat(workflow): stage atomic table operations`.

## Task 6: Graph, Analysis, Tabulate, And Report Executors

**Files**

- Create: `src-tauri/src/services/workflow_document_executor.rs`
- Modify: `src-tauri/src/services/workflow_executor.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/services/fit_y_by_x_service.rs`
- Modify: `src-tauri/src/services/tabulate_service.rs`
- Modify: `src/types/workflow.ts`
- Modify: `src/components/analysis/analysisExecutors.ts`
- Test: Rust `workflow_document_executor` tests
- Test: `tests/analysisExecution.test.ts`
- Test: `tests/workflowDocumentExecution.test.ts`

- [ ] Write failing reference-remap tests: stable Table C feeds Graph, Analysis, and Tabulate, then all feed Report. Results keep declared IDs and reference only bindings/stable outputs, never local slot or staging IDs.
- [ ] Write failing compute tests. Distribution, Fit Y by X, and Tabulate execute under frozen generation and record normalized validation-result hashes. Analysis persistence remains definition/presentation only.
- [ ] Run RED: `cargo test --manifest-path src-tauri/Cargo.toml workflow_document_executor` and `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowDocumentExecution.test.ts`.
- [ ] Add a serde-tagged Rust/TypeScript `WorkflowDocumentCommit` union for Graph, Analysis, Tabulate, and Report. Validate exact schema versions and remap references through the plan.
- [ ] Graph validates source/config. Analysis calls existing Rust statistical services. Tabulate calls `TabulateService` and may stage an explicit Table output. Report parses and validates every remapped embed and stages canonical markdown.
- [ ] Run GREEN:
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_document_executor`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowDocumentExecution.test.ts`,
  `npm run test:analysis`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/tabulateResult.test.ts`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts`, and
  `npm run build`.
- [ ] Commit: `feat(workflow): execute project document operations`.

## Task 7: Run IPC, Atomic Visible Commit, And Recovery

**Files**

- Create: `src/components/workflow/workflowRunCommit.ts`
- Modify: `src-tauri/src/commands/project_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/workflow_executor.rs`
- Modify: `src/services/projectService.ts`
- Modify: `src/stores/useWorkflowStore.ts`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Modify: `src/stores/useAnalysisStore.ts`
- Modify: `src/stores/useTabulateStore.ts`
- Modify: `src/stores/useReportStore.ts`
- Modify: `src/components/workflow/WorkflowView.tsx`
- Test: `tests/workflowRunCommit.test.ts`
- Test: `tests/workflowProjectContracts.test.ts`
- Test: `tests/e2e/WorkflowView.spec.tsx`

- [ ] Write failing IPC/commit tests. One coordinator validates IDs/references, applies all stable documents, appends one run, refreshes datasets once, marks dirty once, and exposes no intermediate state.
- [ ] Write failing UI tests for `pending -> running -> succeeded`, failed-run preservation/error, stable output IDs, and immutable run history.
- [ ] Run RED: `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowRunCommit.test.ts` and targeted `WorkflowView.spec.tsx` tests.
- [ ] Add async `run_workflow`, delegate to `WorkflowExecutor`, register in `generate_handler!`, and add typed `projectService.runWorkflow`.
- [ ] Implement one frontend commit coordinator outside views. Keep the Workflow busy until Graph, Analysis, Tabulate, Report, run, and dataset refresh are applied.
- [ ] Write a backend-owned run journal before publication. Mark committed after DuckDB commit and packet completion. Open clears abandoned staging and returns unapplied committed packets. Stable commit IDs make replay idempotent.
- [ ] Run GREEN:
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowRunCommit.test.ts`,
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowProjectContracts.test.ts`,
  targeted `WorkflowView.spec.tsx`,
  `cargo test --manifest-path src-tauri/Cargo.toml workflow_executor`, and
  `npm run build`.
- [ ] Commit: `feat(workflow): commit and recover atomic runs`.

## Task 8: Deterministic Rerun Acceptance

**Files**

- Create: `tests/workflowDeterminism.test.ts`
- Create: `tests/e2e/WorkflowDeterminism.spec.tsx`
- Modify: `tests/workflowProjectContracts.test.ts`
- Modify: Rust tests in `src-tauri/src/services/spprj_archive.rs`
- Modify: Rust tests in `src-tauri/src/services/workflow_executor.rs`
- Modify: `docs/spec.md`
- Modify: `docs/troubleshooting.md`

- [ ] Build the representative fixture: Table A + B -> Join -> stable Table C -> Graph/Distribution/Tabulate -> explicit stable Table D -> Report containing all outputs. Use fixed rows, order, and seed.
- [ ] Run twice unchanged. Assert stable output IDs, equal output hashes, distinct run IDs, and second-run baseline linkage. Change one input and assert hashes change but IDs do not; revert and recover original hashes.
- [ ] Save, close, reopen, verify graph hash/edges, rerun, and assert equal hashes and resolved Report embeds.
- [ ] Inject downstream failure and assert no stable output changes. A test-only unstable adapter records `determinismViolation` and does not publish differing staging output.
- [ ] Open a legacy archive without graph metadata and an old Workflow with an empty contract. Assert graph migration and `requiresReextraction` blocking.
- [ ] Run complete verification:
  `npm exec -- tsx --tsconfig tsconfig.app.json tests/workflowDeterminism.test.ts`,
  `PLAYWRIGHT_CHANNEL=chrome npm exec -- playwright test --config=playwright-ct.config.ts tests/e2e/WorkflowDeterminism.spec.tsx`,
  `npm run test:analysis`,
  `npm run test:fit-model`,
  `npm run test:distribution`,
  `npm run build`,
  `cargo test --manifest-path src-tauri/Cargo.toml`, and
  `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- [ ] Manually verify live Graph edits produce exact contracts; the branch/join/report Workflow reruns with stable IDs; incompatible bindings block publication; save/open/rerun preserves hashes.
- [ ] Commit: `test(workflow): prove deterministic project reruns`.

## Per-Task Commit Gate

Before every commit:

```sh
git --no-pager diff --no-ext-diff --stat
git --no-pager diff --no-ext-diff --check
git status --short
```

Stage only files listed by that task. Do not include unrelated user changes or generated output. Do not push without explicit authorization.

## Plan Self-Review

- [ ] Every approved acceptance criterion maps to an executable check.
- [ ] TypeScript and Rust names match across IPC and persisted DTOs.
- [ ] Analysis changes include typecheck, contracts, UI, and archive parity gates.
- [ ] Table Transform definitions/execution come from Issue 89, not duplication.
- [ ] Every production behavior starts with an observed failing test.
- [ ] Manual acceptance follows the complete automated gate.
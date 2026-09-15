# Issue 188 MCP Application Command Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose StatsPlayground's existing project workflows through a secure localhost MCP server while UI and MCP invoke the same typed application commands and create behaviorally equivalent artifacts.

**Architecture:** A TypeScript application-command dispatcher owns complete user intents across Zustand and existing Tauri services. An authenticated Rust broker correlates MCP calls with that frontend dispatcher, while the official pinned `rmcp` Streamable HTTP server supplies transport, typed schemas, and structured results. Mutations share one FIFO queue, revision and idempotency controls, canonical constructors, and existing save/export/statistical paths.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, Tauri v2, Rust 2021, Tokio, DuckDB, `rmcp` 3.3.0, Axum, Schemars, Playwright component tests, `tsx` contract tests.

**Spec:** `docs/superpowers/specs/2026-09-15-issue-188-mcp-application-command-layer-design.md`

## Global Constraints

- Work only in `StatsPlayground.worktrees/188-mcp-command-layer` on `issue/188-mcp-command-layer`; never implement directly on `dev`.
- Follow `.github/copilot-instructions.md`; for Analysis files also follow `docs/analysis-development-standard.md` and `.github/instructions/analysis-development.instructions.md`.
- MCP never reads or drives DOM elements; UI dialogs and MCP adapters call the same application commands.
- MCP-created artifacts use canonical constructors, stores, Rust services, dirty/history/revision handling, and serializers; no MCP-only document schema, defaults, validation, or statistical implementation.
- Table inputs and inspection preserve `width`, `format.kind`, `format.decimals`, `format.currency`, and opaque `extras`, including `unit`, `spec`, `range`, `notes`, and `valueOrder`.
- MCP is default-off, manually started, bound only to `127.0.0.1` on an OS-assigned port, and uses a new high-entropy bearer token on every start.
- Never expose absolute paths or tokens through MCP results, audit logs, project documents, or errors.
- File writes accept only a runtime-authorized `rootId` plus validated relative path; reject traversal and symlink escape and confirm overwrite in-app.
- Phase 1 controls only the open app/project and does not expose project open/close, Save As, import, deletion, Snapshot restore, Resources, Prompts, Sampling, Tasks, or a Skills runtime.
- SQL-to-Table reuses the existing AST allowlist and supports one read-only result query; never add keyword-only SQL validation.
- Phase 1 exposes exactly the 22 tools in the approved catalog: 5 discovery, 5 Table/SQL, 10 document, and 2 project-lifecycle tools.
- Tool calls wait synchronously for completion but retain explicit queued/running/awaiting-confirmation/committing/terminal lifecycle, progress, cancellation, timeout, and uncertain-outcome semantics.
- Every behavior change follows red-green-refactor; after each task run its focused checks before the broader affected gate.
- Rust production code returns `Result<T, AppError>` and contains no `unwrap()` or `expect()`.
- Each task ends in a focused conventional commit; do not push or create a pull request before manual acceptance.

---

### Task 1: Typed Command Protocol And Deterministic Mutation Runtime

**Files:**
- Create: `src/applicationCommands/types.ts`
- Create: `src/applicationCommands/policy.ts`
- Create: `src/applicationCommands/runtime.ts`
- Create: `src/stores/useWorkspaceSelectionStore.ts`
- Test: `tests/applicationCommandRuntime.test.ts`
- Test: `tests/workspaceSelectionStore.test.ts`

**Interfaces:**
- Produces: `ApplicationCommand`, `ApplicationCommandType`, `CommandResult<T>`, `CommandError`, `MutationControl`, `CommandPolicy`, `CommandExecutionContext`, `CommandProgress`, and `ApplicationCommandRuntime.execute(command, actor, context?)`.
- Produces: `useWorkspaceSelectionStore` with `selection`, `activate(kind, id)`, `clear()`, and `load(selection)`.
- Consumes: existing `WorkspaceDocumentSelection`, `selectWorkspaceDocument`, and `createEmptyWorkspaceDocumentSelection` from `src/components/analysis/analysisWorkspaceLifecycle.ts`.

- [ ] **Step 1: Write failing runtime tests**

```ts
import assert from "node:assert/strict";
import { createApplicationCommandRuntime } from "@/applicationCommands/runtime";

const runtime = createApplicationCommandRuntime({ initialRevision: 4 });
runtime.register("test.mutate", async () => ({ changed: true, data: { id: "a" }, warnings: [] }));

const first = await runtime.execute({
  type: "test.mutate",
  input: {},
  control: { expectedProjectRevision: 4, idempotencyKey: "create-a" },
}, { kind: "mcp", sessionId: "s1" });
const duplicate = await runtime.execute({
  type: "test.mutate",
  input: {},
  control: { expectedProjectRevision: 4, idempotencyKey: "create-a" },
}, { kind: "mcp", sessionId: "s1" });

assert.equal(first.projectRevision, 5);
assert.deepEqual(duplicate, first);
await assert.rejects(
  runtime.execute({ type: "test.mutate", input: {}, control: { expectedProjectRevision: 4 } }, { kind: "ui" }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "revision_conflict",
);
```

Add separate assertions that two asynchronous mutations finish in FIFO order, read commands do not increment revision, a denied policy never calls the handler, and idempotency keys are isolated by MCP session. Assert queued cancellation never calls the handler, running cancellation reaches the handler's `AbortSignal`, and cancellation after `context.beginCommit()` cannot interrupt the final commit or misreport it as rolled back.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceSelectionStore.test.ts
```

Expected: FAIL because the command runtime and selection store do not exist.

- [ ] **Step 3: Implement the minimal protocol and runtime**

Define the shared envelopes before domain variants are added:

```ts
export interface MutationControl {
  expectedProjectRevision?: number;
  idempotencyKey?: string;
}

export type CommandActor =
  | { kind: "ui" }
  | { kind: "mcp"; sessionId: string; clientId?: string };

export interface CommandResult<T> {
  requestId: string;
  command: string;
  changed: boolean;
  projectRevision: number;
  data: T;
  warnings: Array<{ code: string; message: string }>;
}

export interface CommandExecutionContext {
  signal: AbortSignal;
  reportProgress(progress: CommandProgress): void;
  beginCommit(): void;
}

export class CommandExecutionError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) { super(message); }
}
```

Use a promise tail for FIFO mutation serialization. Check `expectedProjectRevision` inside the queued critical section, cache successful results by `${sessionId}:${idempotencyKey}`, and increment revision only when `changed` is true. Track `queued`, `running`, `awaiting-confirmation`, `committing`, and terminal states. Cancellation aborts queued work immediately and signals cooperative running handlers, but cannot abort after `beginCommit()`. Keep policy metadata in `policy.ts`; never trust a command input field as confirmation.

Move all active document IDs into `useWorkspaceSelectionStore` while preserving the existing selection helper semantics. Do not move menu/panel state.

- [ ] **Step 4: Re-run focused tests and build**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceSelectionStore.test.ts
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/applicationCommands src/stores/useWorkspaceSelectionStore.ts tests/applicationCommandRuntime.test.ts tests/workspaceSelectionStore.test.ts
git commit -m "feat(commands): add deterministic application command runtime"
```

### Task 2: Project Snapshot Assembly And Read Commands

**Files:**
- Create: `src/applicationCommands/projectSnapshot.ts`
- Create: `src/applicationCommands/projectCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useProjectStore.ts`
- Test: `tests/applicationCommandProject.test.ts`
- Test: `tests/workspaceSelectionStore.test.ts`

**Interfaces:**
- Consumes: Task 1 `ApplicationCommandRuntime` and `useWorkspaceSelectionStore`.
- Produces: `buildSaveProjectRequest(filePath?)`, `inspectProject(input)`, `listProjectTables(input)`, `describeProjectTable(input)`, `listProjectDocuments(input)`, and `getProjectDocument(input)`.
- Produces sanitized DTOs that contain stable IDs and relative/project-safe metadata but no `ProjectInfo.filePath` or `DatasetMeta.sourcePath`.

- [ ] **Step 1: Write failing project command tests**

Test that `project.inspect` returns dirty/read-only/revision and counts, `table.list` paginates stably by ID, `table.describe` includes column display properties and caps preview rows, and `document.get` returns all supported document kinds without absolute paths.

```ts
const result = await handlers.projectInspect({ includeCapabilities: true });
assert.equal(result.dirty, true);
assert.equal(result.projectRevision, 7);
assert.equal(JSON.stringify(result).includes("/Users/"), false);
```

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandProject.test.ts
```

Expected: FAIL because project snapshot and read handlers do not exist.

- [ ] **Step 3: Extract snapshot assembly and implement sanitized reads**

Move the complete `SaveProjectRequest` assembly now embedded in `handleSave` into a pure `buildSaveProjectRequest`. It must read current graph builders, analyses, tabulates, reports, folders, filters, workflows, runs, transforms, history, and snapshots from their stores at call time.

Add `setDirty(dirty: boolean)` and `resetRevision()` only where open/close lifecycle requires them; application mutations continue to use `markDirty()` through handlers. Update `Workspace` to consume the shared selection store and snapshot builder without changing visible behavior.

Implement bounded read inputs:

```ts
interface TableDescribeInput {
  datasetId: string;
  preview?: { offset?: number; limit: number };
}
```

Reject `limit < 1` or `limit > 200`. Join `getColumns`, `getColumnDisplayProps`, `getDatasetGeneration`, and optional `queryTableWindow` by `colIndex`.

- [ ] **Step 4: Run focused project and existing save tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandProject.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
npx tsx --tsconfig tsconfig.app.json tests/saveReadOnly.test.ts
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/applicationCommands src/components/Workspace.tsx src/stores/useProjectStore.ts tests/applicationCommandProject.test.ts tests/workspaceSelectionStore.test.ts
git commit -m "refactor(project): centralize project command snapshots"
```

### Task 3: Atomic Table Creation With Complete Column Properties

**Files:**
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/applicationCommands/tableCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Test: `tests/applicationCommandTable.test.ts`
- Test: Rust unit tests in `src-tauri/src/services/data_service.rs`

**Interfaces:**
- Produces: `CreateManagedTableRequest { name, columns, rows }` with `CreateTableColumn.display?: ColumnDisplayPropsWithoutIndex`.
- Produces: Rust `DataService::create_managed_table(request) -> Result<DatasetMeta, AppError>` and Tauri `create_managed_table`.
- Produces: application commands `table.create`, `table.list`, and `table.describe` using the canonical Rust transaction.

- [ ] **Step 1: Add failing Rust atomicity tests**

Create a request with values plus width, numeric format, currency, registered extras, and unknown opaque extras. Assert the dataset and exact `column_display` entries exist after success. Add a malformed-row test and a forced display-validation failure test asserting neither `_meta_datasets` nor `column_display` changes.

```rust
assert_eq!(display[0].width, Some(144.0));
assert_eq!(display[0].format.as_ref().and_then(|value| value.decimals), Some(3));
assert_eq!(display[0].extras.as_ref().unwrap()["unit"], serde_json::json!({"symbol": "mm"}));
```

- [ ] **Step 2: Run Rust test and verify RED**

```bash
cd src-tauri && cargo test create_managed_table -- --nocapture
```

Expected: FAIL because `create_managed_table` is absent.

- [ ] **Step 3: Implement one Rust service transaction**

Validate column counts, unique names, supported SQL types, finite positive widths, format fields, and JSON-safe extras before mutation. Create the table and metadata in the existing DuckDB transaction, then update `AppState.column_display` only after database commit. If the in-memory display update can fail, stage it before commit or compensate by deleting the newly created dataset through a service method tested here.

Keep existing `create_table` and `create_table_from_rows` as compatibility wrappers that call `create_managed_table` with default display input.

- [ ] **Step 4: Add failing TypeScript parity test**

Assert a UI actor and MCP actor invoking the same `table.create` command send identical `CreateManagedTableRequest`, produce the same normalized result, mark dirty, record one history entry, activate the Table, and increment revision once.

- [ ] **Step 5: Implement the Table handler and migrate manual creation**

`table.create` calls only `dataService.createManagedTable`, refreshes datasets, activates the returned ID, marks dirty, records history, and returns the refreshed schema/display contract. Change `handleCreateTable` and SQL/Tabulate callers later to use this handler rather than direct service/store mutation.

- [ ] **Step 6: Run focused and archive round-trip checks**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTable.test.ts
cd src-tauri && cargo test create_managed_table -- --nocapture
cd src-tauri && cargo test save_project_round_trips_complex_values_and_project_metadata -- --nocapture
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/types/data.ts src/services/dataService.ts src/applicationCommands src/components/Workspace.tsx src-tauri/src/models/table.rs src-tauri/src/services/data_service.rs src-tauri/src/commands/data_commands.rs src-tauri/src/lib.rs tests/applicationCommandTable.test.ts
git commit -m "feat(table): create tables with atomic column properties"
```

### Task 4: Table Transform And SQL-To-Table Commands

**Files:**
- Create: `src/applicationCommands/tableTransformCommands.ts`
- Create: `src/applicationCommands/sqlCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/SqlQueryDialog.tsx`
- Modify: `src/stores/useTableTransformStore.ts`
- Test: `tests/applicationCommandTableTransform.test.ts`
- Test: `tests/applicationCommandSql.test.ts`

**Interfaces:**
- Consumes: canonical Task 3 Table commit behavior and existing `tableTransformService`/SQL service calls.
- Produces: `tableTransform.create`, `tableTransform.run`, and `sql.createTable` commands.

- [ ] **Step 1: Write failing Transform command tests**

Assert `tableTransform.create` calls `createAndRun` once, stores the returned definition/binding, refreshes the output Table, marks dirty/history/selection once, and rejects stale expected revision before backend work. Assert `tableTransform.run` reuses `rerun` and reports the target dataset generation.

- [ ] **Step 2: Run Transform test and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTableTransform.test.ts
```

- [ ] **Step 3: Implement Transform handlers and migrate Workspace**

Keep transform execution authority in `useTableTransformStore` and Rust `TableTransformService`; the application handler coordinates the full workspace effect. Replace `Workspace` dialog confirmation callbacks with command execution.

- [ ] **Step 4: Write failing SQL command tests**

Test one managed-table query, rejection propagation for multiple statements/external relations, and canonical post-create dirty/history/selection behavior. Verify the handler never accepts preview rows as creation input.

- [ ] **Step 5: Implement SQL handler and migrate `SqlQueryDialog`**

`sql.createTable` calls the existing `create_table_from_sql_query` service, then routes the resulting dataset through the same post-create coordinator used by `table.create`. Do not duplicate `validate_read_only_query`; Rust remains authoritative.

- [ ] **Step 6: Run focused and existing safety tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTableTransform.test.ts
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandSql.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
cd src-tauri && cargo test sql_query -- --nocapture
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/applicationCommands src/components/Workspace.tsx src/components/SqlQueryDialog.tsx src/stores/useTableTransformStore.ts tests/applicationCommandTableTransform.test.ts tests/applicationCommandSql.test.ts
git commit -m "refactor(commands): share transform and SQL table workflows"
```

### Task 5: Tabulate Creation, Execution, And Table Export

**Files:**
- Create: `src/applicationCommands/tabulateCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `src/stores/useTabulateStore.ts`
- Test: `tests/applicationCommandTabulate.test.ts`
- Test: `tests/tabulateResult.test.ts`

**Interfaces:**
- Produces: `tabulate.create`, `tabulate.run`, and `tabulate.exportTable`.
- Produces: a runtime-only `latestResultsById` state containing request fingerprint, source generation, result, and completion time; it is not added to `.spprj`.
- Consumes: `buildTabulateExportRequest` and Task 3 canonical Table creation.

- [ ] **Step 1: Write failing Tabulate lifecycle tests**

Assert creation uses the canonical item defaults, run caches only a result whose request fingerprint and source generation still match, and export reruns when the cached result is absent or stale. Assert exported column properties use canonical Table defaults and the Table becomes active.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTabulate.test.ts
```

- [ ] **Step 3: Implement runtime result state and handlers**

Keep persisted Tabulate definitions unchanged. Move the debounced run body and `handleExport` orchestration into commands; `TabulateView` requests commands and renders store-backed runtime results. Preserve `buildTabulateExportRequest` as the sole row/column conversion function.

- [ ] **Step 4: Run focused and existing Tabulate tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTabulate.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tabulateResult.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/applicationCommands src/components/Workspace.tsx src/components/tabulate/TabulateView.tsx src/stores/useTabulateStore.ts tests/applicationCommandTabulate.test.ts tests/tabulateResult.test.ts
git commit -m "refactor(tabulate): route lifecycle through application commands"
```

### Task 6: Graph And Report Commands

**Files:**
- Create: `src/applicationCommands/graphCommands.ts`
- Create: `src/applicationCommands/reportCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Modify: `src/stores/useReportStore.ts`
- Test: `tests/applicationCommandGraph.test.ts`
- Test: `tests/applicationCommandReport.test.ts`

**Interfaces:**
- Produces: `graph.create`, `graph.update`, `report.create`, and `report.update`.
- Consumes: `normalizeGraphBuilderItem`, `parseReportMarkdown`, and existing graph/report stores.

- [ ] **Step 1: Write failing Graph tests**

Test canonical mode defaults, normalization of every update, stale revision rejection, exactly one dirty/history/revision update, and full-definition parity between UI and MCP actors.

- [ ] **Step 2: Implement Graph commands and migrate update callbacks**

Add an application-level document revision map rather than changing the persisted `.spgh` schema. Every `graph.update` accepts a full canonical Graph definition plus expected document revision, normalizes it, stores it, and returns the next revision. Adapt `GraphBuilderView` setters to issue that command.

- [ ] **Step 3: Write failing Report tests**

Test canonical create, Markdown update, project-reference validation, stale document revision rejection, and history coalescing. The command must reject embeds that reference missing project objects using `extractReportDependencies`.

- [ ] **Step 4: Implement Report commands and migrate Workspace**

Move the delayed history coalescer out of `Workspace` into `reportCommands.ts`. Keep transient timers runtime-only and flush them before save, selection change, and dispatcher shutdown.

- [ ] **Step 5: Run focused and neighboring tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandGraph.test.ts
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderMode.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/applicationCommands src/components/Workspace.tsx src/components/graphBuilder/GraphBuilderView.tsx src/stores/useGraphBuilderStore.ts src/stores/useReportStore.ts tests/applicationCommandGraph.test.ts tests/applicationCommandReport.test.ts
git commit -m "refactor(documents): share graph and report commands"
```

### Task 7: Registered Analysis Commands And Stale-Safe Runtime Results

**Files:**
- Create: `src/applicationCommands/analysisCommands.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/analysis/useAnalysisExecution.ts`
- Modify: `src/stores/useAnalysisStore.ts`
- Test: `tests/applicationCommandAnalysis.test.ts`
- Test: `tests/analysisKindRegistry.test.ts`
- Test: `tests/analysisExecution.test.ts`

**Interfaces:**
- Produces: `analysis.create`, `analysis.update`, and `analysis.run` for every `AnalysisKind` in `contracts/analysis/kinds.v1.json`.
- Consumes: `analysisKindDescriptors`, kind adapters, `createAnalysisExecutionController`, and the full existing kind/document/config/dataset/generation/request stale fence.

- [ ] **Step 1: Extend the registry contract with failing command-coverage assertions**

For every manifest kind, assert there is a create adapter, update validator, execution adapter, MCP schema projection, and command test fixture. Assert an unknown kind is rejected rather than entering a generic fallback.

- [ ] **Step 2: Run Analysis registry test and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
```

- [ ] **Step 3: Write failing create/update/run tests**

Test one fixture per registered kind. Verify canonical constructors and defaults, `configRevision` increments, source binding remains ID-based, and stale execution results are masked. MCP and UI actors must produce normalized-equal `AnalysisDocument` values after removing UUID/timestamps.

- [ ] **Step 4: Implement Analysis commands without a frontend stats fallback**

Move kind-specific Workspace create orchestration behind descriptor-owned adapters. Reuse `createAnalysisExecutionController`; expose a non-hook execution entry that shares its stale-fence logic with `useAnalysisExecution`. Store runtime results only where the current Analysis UI already stores them; do not persist calculated statistics.

- [ ] **Step 5: Run the complete Analysis gate**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandAnalysis.test.ts
npm run test:analysis
npm run build
```

Expected: all commands exit 0; there is no unregistered Analysis kind.

- [ ] **Step 6: Commit**

```bash
git add contracts/analysis src/applicationCommands src/components/Workspace.tsx src/components/analysis src/stores/useAnalysisStore.ts src/types/analysis.ts tests/applicationCommandAnalysis.test.ts tests/analysisKindRegistry.test.ts tests/analysisExecution.test.ts
git commit -m "refactor(analysis): expose registered application commands"
```

### Task 8: Save, Snapshot, Authorized CSV Export, And Confirmation Policy

**Files:**
- Create: `src/applicationCommands/ioCommands.ts`
- Modify: `src/applicationCommands/projectCommands.ts`
- Modify: `src/applicationCommands/policy.ts`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/services/ioService.ts`
- Create: `src/services/mcpManagementService.ts`
- Create: `src-tauri/src/services/path_authorization_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/io_commands.rs`
- Test: `tests/applicationCommandSaveSnapshot.test.ts`
- Test: Rust unit tests in `src-tauri/src/services/path_authorization_service.rs`

**Interfaces:**
- Produces: `project.save`, `snapshot.create`, and `table.exportCsv`.
- Produces: Rust `authorize_output_root(path) -> rootId`, `resolve_output(rootId, relativePath) -> PathBuf`, and `revoke_output_root(rootId)`; only Rust stores absolute root paths.
- Produces: policy result `allow | requireConfirmation` and confirmation resolution keyed by `requestId`.

- [ ] **Step 1: Write failing save/snapshot tests**

Assert save uses `buildSaveProjectRequest`, flushes pending Report history, returns `project_path_required` without a current destination, and does not expose the destination path. Assert Snapshot invokes the same existing `useHistoryStore.createSnapshot` behavior as the camera button; do not expand Snapshot semantics in this Issue.

- [ ] **Step 2: Write failing Rust path authorization tests**

Cover absolute relative-path rejection, `..`, missing root ID, existing symlink escape, safe nested new file, revoked root, and overwrite classification. Use `tempfile::TempDir`; never rely on machine-specific paths.

- [ ] **Step 3: Run and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandSaveSnapshot.test.ts
cd src-tauri && cargo test path_authorization_service -- --nocapture
```

- [ ] **Step 4: Implement runtime-only root grants and authorized export**

Store `HashMap<RootId, CanonicalPath>` only in Rust MCP runtime state. Return `{ rootId, displayName }`, never the canonical path. Resolve the existing parent and each symlink before joining a new filename. Add `export_csv_authorized(dataset_id, root_id, relative_path)` that delegates bytes/formatting to the existing CSV exporter.

- [ ] **Step 5: Implement command policy confirmation**

Classify normal create/run/save/snapshot as allowed. `table.exportCsv` requires confirmation only when the resolved target exists. Confirmation state belongs to the command runtime and cannot be supplied by `input`. Deny returns `user_denied`; stop cancels pending confirmations.

- [ ] **Step 6: Migrate save, camera Snapshot, and CSV UI paths**

All three UI entry points invoke the same commands used later by MCP. A UI-selected export directory is registered with Rust, then the command receives only `rootId` and filename.

- [ ] **Step 7: Run focused and existing lifecycle tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandSaveSnapshot.test.ts
npx tsx --tsconfig tsconfig.app.json tests/historyTimeline.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
cd src-tauri && cargo test path_authorization_service -- --nocapture
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/applicationCommands src/components/Workspace.tsx src/services/ioService.ts src/services/mcpManagementService.ts src-tauri/src/services src-tauri/src/commands/io_commands.rs tests/applicationCommandSaveSnapshot.test.ts
git commit -m "feat(io): authorize shared project export commands"
```

### Task 9: Rust Correlated Frontend Command Broker

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`
- Create: `src-tauri/src/mcp/broker.rs`
- Create: `src-tauri/src/models/mcp.rs`
- Create: `src-tauri/src/commands/mcp_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/services/applicationCommandBridge.ts`
- Test: Rust unit tests in `src-tauri/src/mcp/broker.rs`
- Test: `tests/applicationCommandBridge.test.ts`

**Interfaces:**
- Produces: `McpCommandBroker::dispatch(command, timeout, progress_sender, cancellation_token) -> Result<McpCommandResponse, AppError>`.
- Produces Tauri commands: `register_application_command_dispatcher`, `complete_application_command`, and `unregister_application_command_dispatcher`.
- Produces event `application-command-request` carrying `{ requestId, command }`.

- [ ] **Step 1: Write failing broker lifecycle tests**

Test not-ready rejection, bounded queue rejection, request/result correlation, progress correlation, timeout cleanup, queued cancellation, cooperative running cancellation, ignored unknown/late responses, unregister cancellation, and timeout/cancellation after `committing` returning or recording the final committed outcome. Use Tokio paused time where possible.

- [ ] **Step 2: Run broker tests and verify RED**

```bash
cd src-tauri && cargo test mcp::broker -- --nocapture
```

- [ ] **Step 3: Implement broker with bounded pending requests**

Use a pending-entry map keyed by request ID, an atomic ready flag, and a bounded semaphore. Each entry owns completion, progress, cancellation, timeout, and lifecycle state. Emit only sanitized commands through `AppHandle::emit`. Frontend progress/state events update the matching entry, and `complete_application_command` resolves it exactly once. Map poisoned locks and closed channels into `AppError`, never `unwrap()`.

- [ ] **Step 4: Write failing frontend bridge test**

Inject fake `listen` and `invoke` functions. Assert registration happens once, each event enters `ApplicationCommandRuntime.execute`, progress/state updates are correlated back to Rust, success and structured errors complete the matching request, cancellation reaches the execution context, and disposal unregisters the dispatcher.

- [ ] **Step 5: Implement and mount the frontend bridge**

Mount once at the Workspace/app-shell boundary after stores are ready. Do not mount it inside a document view. Keep event names and payload types in one shared TypeScript module.

- [ ] **Step 6: Run focused broker and frontend tests**

```bash
cd src-tauri && cargo test mcp::broker -- --nocapture
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandBridge.test.ts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp src-tauri/src/models/mcp.rs src-tauri/src/commands/mcp_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/models/mod.rs src-tauri/src/state.rs src-tauri/src/lib.rs src/services/applicationCommandBridge.ts tests/applicationCommandBridge.test.ts
git commit -m "feat(mcp): add correlated frontend command broker"
```

### Task 10: Official RMCP Server, Typed Tools, And HTTP Security

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/mcp/server.rs`
- Create: `src-tauri/src/mcp/tools.rs`
- Create: `src-tauri/src/mcp/security.rs`
- Modify: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/models/mcp.rs`
- Modify: `src-tauri/src/commands/mcp_commands.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit tests colocated in `server.rs`, `tools.rs`, and `security.rs`
- Test: `src-tauri/tests/mcp_http.rs`

**Interfaces:**
- Produces: `start_mcp_server() -> McpServerStatus`, `stop_mcp_server()`, `get_mcp_server_status()`, and `list_mcp_audit_entries()`.
- Produces a single `/mcp` Streamable HTTP endpoint and all Phase 1 `statsplayground.*` tools.
- Consumes: Task 9 broker and Task 8 path authorization/confirmation state.

- [ ] **Step 1: Pin dependencies and write failing transport tests**

Add exact dependencies:

```toml
rmcp = { version = "=3.3.0", features = ["server", "transport-streamable-http-server"] }
axum = "0.8"
schemars = "1"
rand = "0.9"
base64 = "0.22"
subtle = "2"
```

Write HTTP tests for loopback bind, random port, token rotation, unauthenticated initialize rejection, invalid Origin 403, missing Origin acceptance for native clients, valid initialize, tools/list, tools/call, body limit, concurrency/queue limit, and clean stop.

- [ ] **Step 2: Run HTTP tests and verify RED**

```bash
cd src-tauri && cargo test --test mcp_http -- --nocapture
```

- [ ] **Step 3: Implement lifecycle and security middleware**

Generate 32 random bytes and encode URL-safe without padding. Compare bearer tokens in constant time. Bind `TcpListener` to `127.0.0.1:0`; report only loopback endpoint and token through the in-app management command. Reject every present Origin except explicitly allowed local management origins; do not add wildcard CORS.

Store server task, cancellation token, token hash/value, port, connections, queue/running counts, per-command timeout policy, audit ring, grants, and confirmations in non-serialized runtime state. Stop must invalidate token before awaiting server shutdown and cancel every request not yet in `committing`.

- [ ] **Step 4: Define typed tool schemas and error mapping**

Each `#[tool]` argument/result derives `Serialize`, `Deserialize`, and `JsonSchema`. Tool handlers only project MCP DTOs to `ApplicationCommand`, call the broker, forward negotiated progress/cancellation, and map results. Return business failures as `CallToolResult::error` with serialized `CommandError`; reserve `McpError::invalid_params` for schema/envelope failures. A timeout before commit returns `timeout`; after commit begins it must return or retain a discoverable final result keyed by the idempotency key rather than claim rollback.

Implement exactly all 22 tools in the catalog in the spec; no Resources, Prompts, Tasks, open/close/import/delete/restore tools.

- [ ] **Step 5: Add schema catalog assertions**

Assert exact unique tool names, object input schemas, output schemas, no forbidden tool names, and coverage of every command adapter. Assert result content contains both `structuredContent` and equivalent JSON text.

- [ ] **Step 6: Run Rust security and quality gates**

```bash
cd src-tauri && cargo fmt --check
cd src-tauri && cargo test mcp:: -- --nocapture
cd src-tauri && cargo test --test mcp_http -- --nocapture
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo build
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/mcp src-tauri/src/models/mcp.rs src-tauri/src/commands/mcp_commands.rs src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/tests/mcp_http.rs
git commit -m "feat(mcp): serve authenticated Streamable HTTP tools"
```

### Task 11: AI Management Store, Menu, Activity View, And Skills Placeholder

**Files:**
- Create: `src/types/mcp.ts`
- Create: `src/stores/useMcpStore.ts`
- Create: `src/components/ai/AiActivityView.tsx`
- Create: `src/components/ai/McpServerPanel.tsx`
- Create: `src/components/ai/SkillsPlaceholder.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Test: `tests/mcpStore.test.ts`
- Create: `tests/mcpManagement.spec.tsx`
- Create: `tests/McpManagementHarness.tsx`

**Interfaces:**
- Consumes: Task 10 management service/status/audit commands and Task 8 root authorization/confirmation commands.
- Produces: transient `useMcpStore` lifecycle, audit, grant summaries, queue state, and confirmation actions.

- [ ] **Step 1: Write failing store tests**

Test initial `stopped`, start transition, fresh token/status, stop clearing token/audit/connections/confirmations, failed start recovery, root grant/revoke, Allow/Deny request correlation, and queued/running progress updates. Assert no browser persistence API is called.

- [ ] **Step 2: Implement the transient MCP store**

Use dependency injection around `mcpManagementService` for tests. Do not use Zustand `persist`. Poll status only while the AI view is visible or consume a bounded Tauri status event; clean up timers/listeners on unmount.

- [ ] **Step 3: Write failing Playwright component tests**

Verify the panel shows stopped/starting/running/stopping states, masks the token, copies endpoint/token/client config only on explicit buttons, manages grants, renders bounded audit rows with queued/running progress, and exposes Allow/Deny for pending confirmations. Verify Skills is clearly unavailable and contains no enable/install controls.

- [ ] **Step 4: Implement menu and activity surfaces**

Add top-level `AI` menu entries `MCP Server...` and `Skills...`. Add one AI activity icon using the existing icon library and a tooltip. Opening either route selects the AI activity view and the relevant subview. Keep cards un-nested, compact, and consistent with the operational desktop UI.

- [ ] **Step 5: Run focused UI tests and build**

```bash
npx tsx --tsconfig tsconfig.app.json tests/mcpStore.test.ts
npx playwright test -c playwright-ct.config.ts tests/mcpManagement.spec.tsx
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/types/mcp.ts src/stores/useMcpStore.ts src/components/ai src/components/Workspace.tsx src/App.css src/i18n tests/mcpStore.test.ts tests/mcpManagement.spec.tsx tests/McpManagementHarness.tsx
git commit -m "feat(ai): add MCP management and Skills placeholder"
```

### Task 12: Cross-Entry Artifact Equivalence And Save/Reopen Coverage

**Files:**
- Create: `tests/applicationCommandAdapterParity.test.ts`
- Create: `tests/mcpArtifactParity.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/tableTransformContract.test.ts`
- Modify: `tests/reportProjectContracts.test.ts`
- Modify: `src-tauri/src/services/project_service.rs` tests only if a missing archive invariant is exposed

**Interfaces:**
- Consumes: complete UI adapter, MCP adapter, command runtime, serializers, and reopen services.
- Produces: normalization helpers that remove only UUID/timestamp/duration fields and compare all business fields.

- [ ] **Step 1: Write failing adapter-projection tests**

For every Phase 1 mutation, construct equivalent UI-form input and MCP input and assert both project to the exact same `ApplicationCommand`. Fail if an adapter adds defaults independently.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandAdapterParity.test.ts
```

- [ ] **Step 3: Implement only missing adapter normalization**

Move any differing default or input normalization into the canonical command handler/constructor. Do not weaken assertions or add an MCP compatibility transform after command creation.

- [ ] **Step 4: Add artifact round-trip parity cases**

Cover Table data plus all display/extras, Transform, Tabulate, Tabulate-to-Table, Graph, every registered Analysis kind, Report, SQL-to-Table, save, Snapshot, and CSV. Save UI-created and MCP-created projects, reopen, remove only nondeterministic fields, compare structures, then run/edit each document through existing UI/service APIs.

- [ ] **Step 5: Run parity and archive gates**

```bash
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandAdapterParity.test.ts
npx tsx --tsconfig tsconfig.app.json tests/mcpArtifactParity.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportProjectContracts.test.ts
cd src-tauri && cargo test project_service -- --nocapture
npm run test:analysis
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add tests/applicationCommandAdapterParity.test.ts tests/mcpArtifactParity.test.ts tests/analysisProjectContracts.test.ts tests/tableTransformContract.test.ts tests/reportProjectContracts.test.ts src-tauri/src/services/project_service.rs
git commit -m "test(mcp): prove human and AI artifact equivalence"
```

### Task 13: End-To-End Hardening, Documentation, And Final Gates

**Files:**
- Create: `tests/mcpEndToEnd.spec.tsx`
- Create: `tests/McpEndToEndHarness.tsx`
- Modify: `package.json`
- Modify: `docs/development.md`
- Modify: `docs/troubleshooting.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `npm run test:mcp` as the single frontend/contract MCP gate.
- Consumes: running Tauri MCP lifecycle, real HTTP client fixture, frontend bridge, and all Phase 1 commands.

- [ ] **Step 1: Add the failing aggregate MCP script and end-to-end test**

Define `test:mcp` to run command runtime, domain command, bridge, parity, store/component, and Rust HTTP tests through repository-compatible commands. The end-to-end harness must execute:

```text
start server -> initialize authenticated MCP client -> inspect project
-> create Table with extras -> create/run documents -> save
-> reopen through application test harness -> inspect equivalent artifacts
-> export CSV through authorized root -> create Snapshot -> stop server
```

Also assert wrong token, hostile Origin, stale revision, traversal, denied overwrite, timeout, cancellation, queue saturation, and app-not-ready behavior.

- [ ] **Step 2: Run end-to-end test and verify RED**

```bash
npx playwright test -c playwright-ct.config.ts tests/mcpEndToEnd.spec.tsx
```

Expected: FAIL at the first unimplemented integration boundary, not from fixture setup.

- [ ] **Step 3: Repair integration boundaries without adding new scope**

Fix only wiring, schema, lifecycle, and error-mapping defects revealed by the test. Do not add deferred tools. Confirm stop clears token, grants, connections, audit, and pending confirmation state.

- [ ] **Step 4: Document connection and security behavior**

Document manual server start, endpoint/token copying, generic Streamable HTTP client configuration, authorized export roots, token rotation, troubleshooting `app_not_ready`/401/403/revision conflict, and Phase 1 exclusions. Do not publish a real token or machine path in examples.

- [ ] **Step 5: Run fresh complete verification**

```bash
npm run test:mcp
npm run test:analysis
npm run build
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo test
cd src-tauri && cargo build
git diff --check
```

Expected: every command exits 0 with zero test failures and zero Clippy warnings.

- [ ] **Step 6: Perform desktop manual acceptance preparation**

Run:

```bash
npm run tauri dev
```

Provide the user an acceptance checklist covering manual UI and MCP creation parity, Table extras, save/reopen, SQL/Tabulate-to-Table, Graph/Analysis/Report editing, authorized CSV, Snapshot, token rotation, invalid-token/Origin rejection, overwrite confirmation, and service stop. Keep the process running until the user has tested it.

- [ ] **Step 7: Commit after automated verification**

```bash
git add package.json docs/development.md docs/troubleshooting.md README.md tests/mcpEndToEnd.spec.tsx tests/McpEndToEndHarness.tsx
git commit -m "docs(mcp): add integration and client guidance"
```

Do not push or create the pull request yet. Stop at the GitHub development-flow manual acceptance gate. After explicit acceptance, rerun the full verification on the exact tree, obtain independent review, commit any review repairs, then push and create a PR targeting `dev` with `Closes #188` and exact cleanup metadata.

## Plan Completion Check

Before implementation begins, verify:

- All 22 spec tools map to one application command and one task above.
- Every manual UI entry point in scope is migrated before MCP transport is considered complete.
- Table display/extras parity is covered at command, Rust transaction, archive, and end-to-end levels.
- Analysis retains Rust statistical authority and the complete stale fence.
- Queued/running/committing transitions, progress, timeout, cancellation, and uncertain post-commit outcomes have deterministic tests.
- Snapshot intentionally preserves current manual semantics rather than silently broadening the feature.
- Absolute paths remain confined to Rust runtime authorization state.
- No deferred Phase 1 capability appears in tool catalog, tests, UI claims, or docs.
# Issue 232 Lazy Viewport Tabulate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tabulate's fixed 10,000-cell full-matrix runtime with exact screen-sized aggregate queries, two-axis logical virtualization, bounded caches, and backend-direct export for datasets with at least 10,000,000 source rows.

**Architecture:** A backend Tabulate session materializes only stable row-member and column-member ordinal indexes. Exact aggregate cells and totals are queried lazily for bounded viewport tiles, while a Tabulate-specific frontend controller applies request epochs, cancellation, adjacent prefetch, bounded LRU caching, and a virtualized two-axis renderer. Complete-result export remains exact but executes directly in DuckDB instead of crossing Tauri IPC as a full matrix.

**Tech Stack:** Rust 2021, Tauri v2, DuckDB, serde, React 19, TypeScript, Zustand, Playwright Component Testing, Node assertion tests.

**Spec:** `docs/superpowers/specs/2026-09-18-lazy-viewport-tabulate-design.md`

**Issue:** https://github.com/ashton2914/StatsPlayground/issues/232

## Global Constraints

- Exact statistics only: no sampling, approximation, top-N fallback, or silent truncation.
- The complete Cartesian result matrix must never be allocated by an interactive production path.
- Total logical-cell count is informational and has no fixed admission cap.
- Each response accepts at most 128 row members, 64 column members, and 16,384 numeric cells.
- At most two prepared Tabulate sessions may exist per dataset.
- Active Tabulate member indexes share a measured 256 MiB budget.
- An inactive session expires after exactly five minutes when no query is active.
- Session identity includes dataset ID, source generation, and the complete statistical request fingerprint.
- Member order stays deterministic with nulls last; missing combinations retain the current statistic-specific null/zero semantics.
- Percentages always use complete exact row, column, or grand denominators, never visible-tile denominators.
- Runtime sessions, indexes, tiles, totals, and failures are not persisted in `.spprj`.
- Rust commands return `Result<T, AppError>` without production `unwrap()` or `expect()`.
- SQL uses backend-owned templates plus metadata-validated quoted identifiers; user values never become SQL fragments.
- UI, Report, Application Commands, Workflow, MCP, and export must migrate before removing the legacy full-result contract.
- P95 claims require at least 30 settled samples and identify backend, IPC, frontend, WebView, and whole-process layers separately.
- macOS WebKit and Windows WebView2 require separate live acceptance.
- Follow the GitHub Issue lifecycle: use an isolated sibling worktree from confirmed `origin/dev`, publish and read back the investigation comment before creating it, and do not commit or push until manual acceptance.

---

## File Structure

### Backend

- Modify `src-tauri/src/models/tabulate.rs`: session, window, sparse-cell, totals, cancellation, and materialization contracts.
- Create `src-tauri/src/services/tabulate_session_service.rs`: registry, quotas, lifecycle, cancellation, expiry, and generation fences.
- Modify `src-tauri/src/services/tabulate_service.rs`: shared definition validation and temporary legacy compatibility only.
- Modify `src-tauri/src/services/mod.rs`: expose the session service.
- Modify `src-tauri/src/state.rs`: construct and own one application-lifetime Tabulate session service.
- Modify `src-tauri/src/engine/duckdb_engine.rs`: member indexes, exact tile/totals SQL, measured bytes, and atomic result-table materialization.
- Modify `src-tauri/src/commands/tabulate_commands.rs`: thin commands for every new operation.
- Modify `src-tauri/src/commands/mod.rs` and `src-tauri/src/lib.rs`: command exposure and registration.
- Modify `src-tauri/src/services/workflow_executor.rs` and `src-tauri/src/services/workflow_document_executor.rs`: bounded session-summary execution.
- Modify `src-tauri/src/mcp/tools.rs`: bounded tool schemas and parity dispatch.
- Modify `src-tauri/src/perf_harness.rs`: deterministic large Tabulate fixtures and layered measurements.

### Frontend

- Modify `src/types/tabulate.ts`: mirror the new camelCase contracts and remove `maxResultCells` from the new request.
- Modify `src/services/tabulateService.ts`: typed prepare/status/window/totals/cancel/release/materialize wrappers.
- Create `src/components/tabulate/tabulateViewport.ts`: pure two-axis window math, boundary-aware hierarchy spans, and response validation.
- Create `src/components/tabulate/tabulateTileCache.ts`: bounded generation/fingerprint-aware LRU for tiles and totals.
- Create `src/components/tabulate/tabulateTileScheduler.ts`: latest-request-wins foreground scheduling, cancellation, and one-ring prefetch.
- Create `src/components/tabulate/useTabulateSession.ts`: mounted session lifecycle and stale-result fences.
- Modify `src/components/tabulate/TabulateResultTable.tsx`: bounded virtual grid renderer.
- Modify `src/components/tabulate/TabulateView.tsx`: session orchestration, logical positions, loading/error states, and backend export.
- Modify `src/components/tabulate/tabulate.css`: stable two-axis viewport, sticky hierarchy labels, placeholders, and logical scrollbars.
- Modify `src/stores/useTabulateStore.ts`: remove complete-result retention; keep durable definitions only.
- Modify `src/applicationCommands/types.ts` and `src/applicationCommands/tabulateCommands.ts`: bounded run summaries and backend materialization.
- Modify `src/components/report/TabulateReportEmbed.tsx`: read-only virtualized session lifecycle.
- Modify `src/workflow/operationAdapters.ts` only if the schema version or normalized runtime output changes; saved Tabulate definition shape must remain unchanged.
- Modify `src/i18n/locales/en.json` and `src/i18n/locales/zh-CN.json`: preparation, tile, cancellation, expiry, resource, and retry copy.

### Tests And Harnesses

- Create `tests/tabulateViewport.test.ts`.
- Create `tests/tabulateTileCache.test.ts`.
- Create `tests/tabulateTileScheduler.test.ts`.
- Create `tests/TabulateVirtualHarness.tsx`.
- Create `tests/tabulateVirtual.spec.tsx`.
- Modify `tests/tabulateResult.test.ts`.
- Modify `tests/applicationCommandTabulate.test.ts`.
- Modify `tests/applicationCommandAdapterParity.test.ts`.
- Modify `tests/mcpArtifactParity.test.ts`.
- Modify `tests/reportView.spec.tsx` and its harness only where Tabulate embed behavior is asserted.
- Add Rust tests inline with the owning service and engine modules.

---

### Task 1: Lock The Versioned Session And Window Contracts

**Files:**
- Modify: `src-tauri/src/models/tabulate.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Modify: `src/types/tabulate.ts`
- Modify: `src/services/tabulateService.ts`
- Test: inline command serialization tests in `src-tauri/src/commands/tabulate_commands.rs`
- Test: `tests/tabulateResult.test.ts`

**Interfaces:**
- Produces: `TabulateSessionRequest`, `TabulateSessionStatus`, `TabulateSessionState`
- Produces: `TabulateWindowRequest`, `TabulateWindowResult`, `TabulateSparseCell`
- Produces: `TabulateTotalsRequest`, `TabulateTotalsResult`, `TabulateTotalsKind`
- Produces: `TabulateMaterializeRequest`
- Produces TS methods: `prepare`, `getStatus`, `queryWindow`, `queryTotals`, `cancelRequest`, `release`, `materializeTable`

- [ ] **Step 1: Write failing Rust serialization tests**

Assert the new request has no `maxResultCells`, enum states are camelCase, sparse
cells carry local row/column/statistic indexes, and counts serialize as integers:

```rust
let request = TabulateSessionRequest {
    dataset_id: "dataset-1".into(),
    source_generation: 7,
    row_fields: vec!["region".into()],
    column_fields: vec!["product".into()],
    statistics: vec![mean_statistic()],
    include_row_totals: true,
    include_column_totals: true,
};
let json = serde_json::to_value(request).expect("serialize request");
assert_eq!(json["sourceGeneration"], 7);
assert!(json.get("maxResultCells").is_none());
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run from `src-tauri/`:

```bash
cargo test tabulate_session_contract -- --nocapture
```

Expected: compilation fails because the session types do not exist. Confirm the
GREEN command later reports one executed test; zero tests is not valid evidence.

- [ ] **Step 3: Define exact Rust models**

Use these required fields:

```rust
pub struct TabulateWindowRequest {
    pub request_id: String,
    pub session_id: String,
    pub source_generation: u64,
    pub row_start: u64,
    pub row_count: u32,
    pub column_start: u64,
    pub column_count: u32,
}

pub struct TabulateSparseCell {
    pub row_index: u32,
    pub column_index: u32,
    pub statistic_index: u32,
    pub value: Option<f64>,
}
```

`TabulateWindowResult` includes `session_id`, `request_id`, `fingerprint`,
`source_generation`, requested starts, member slices, statistics, sparse cells,
row/column totals readiness, and exact global row/column counts. Define totals as
`Rows { start, count } | Columns { start, count } | Grand` with separate result
arrays and the same fingerprint/generation fences.

- [ ] **Step 4: Mirror the contracts in TypeScript and add service wrappers**

Use `invoke<T>()` for:

```ts
prepare: (request: TabulateSessionRequest) =>
  invoke<TabulateSessionStatus>("prepare_tabulate_session", { request }),
queryWindow: (request: TabulateWindowRequest) =>
  invoke<TabulateWindowResult>("query_tabulate_window", { request }),
cancelRequest: (requestId: string) =>
  invoke<void>("cancel_tabulate_request", { requestId }),
```

Add the remaining status, totals, release, and materialization wrappers with the
exact command names from the spec.

- [ ] **Step 5: Add frontend source-contract assertions**

Assert every Rust command has one TS wrapper, the new `TabulateSessionRequest`
contains no `maxResultCells`, and no new full `cells: Array<number | null>` result
is introduced.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
cargo test commands::tabulate_commands::tests
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateResult.test.ts
```

Expected: all command serialization and contract assertions pass.

- [ ] **Step 7: Review checkpoint**

Run `git --no-pager diff --no-ext-diff --check` on Task 1 files. Verify every
field has identical Rust serde and TypeScript camelCase spelling. Do not commit.

---

### Task 2: Build The Member-Index Session Registry

**Files:**
- Create: `src-tauri/src/services/tabulate_session_service.rs`
- Modify: `src-tauri/src/services/tabulate_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline tests in `tabulate_session_service.rs` and `duckdb_engine.rs`

**Interfaces:**
- Produces: `TabulateSessionService::prepare`, `status`, `release`
- Produces engine methods: `prepare_tabulate_member_indexes`, `drop_tabulate_member_indexes`
- Consumes: Task 1 session request/status contracts
- Later tasks consume: `TabulateSessionEntry` lookup and active-query guard

- [ ] **Step 1: Write failing lifecycle and quota tests**

Cover session reuse by fingerprint, source-generation mismatch, two-session
per-dataset eviction, 256 MiB measured-byte pressure, five-minute idle expiry,
active-query expiry protection, explicit release, and late preparation after
release. Use a test policy constructor and a controllable clock rather than
sleeping.

```rust
#[test]
fn release_during_prepare_cannot_resurrect_session() {
    let harness = SessionHarness::new();
    let status = harness.prepare_paused(request());
    harness.service.release(&status.session_id).expect("release");
    harness.finish_prepare();
    assert_unknown_session(&harness.service, &status.session_id);
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test services::tabulate_session_service::tests -- --nocapture
```

Expected: compilation fails because the service does not exist.

- [ ] **Step 3: Implement member-index preparation**

Create backend-UUID-derived temporary row and column member tables. Each table
stores a stable zero-based `ordinal` plus canonical dimension columns. Use
`SELECT DISTINCT ... ORDER BY ... NULLS LAST` and a window row number. A missing
dimension role creates exactly one ordinal with no dimension columns.

Return:

```rust
pub struct PreparedTabulateSessionInfo {
    pub row_member_count: u64,
    pub column_member_count: u64,
    pub logical_cell_count: u64,
    pub measured_bytes_estimate: usize,
}
```

Use checked multiplication for logical cells. Measure index storage from DuckDB
storage metadata or a conservative encoded-width estimate documented in the
code; never report the source table size as session bytes.

- [ ] **Step 4: Implement the registry and ownership rules**

Follow the proven `TableNavigationService` structure: cloned engines,
`InterruptHandle`, active-query guards, atomic released state, signature lookup,
LRU/TTL eviction, and drop-on-release. Keep Tabulate's registry independent so
raw table sessions and aggregate sessions cannot overwrite each other's state.

- [ ] **Step 5: Add thin commands and AppState ownership**

Register `prepare_tabulate_session`, `get_tabulate_session_status`, and
`release_tabulate_session`. Commands delegate only; lifecycle and validation stay
in the service.

- [ ] **Step 6: Run focused lifecycle tests and build**

Run:

```bash
cargo test services::tabulate_session_service::tests -- --nocapture
cargo test engine::duckdb_engine::tests::tabulate_member -- --nocapture
cargo build
```

Expected: focused tests execute nonzero cases and pass; backend builds.

- [ ] **Step 7: Review checkpoint**

Inspect only Task 2 diffs. Verify every release path interrupts first, removes
registry identity, drops temporary objects, and prevents late resurrection. Do
not commit.

---

### Task 3: Query Exact Sparse Viewport Tiles

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/tabulate_session_service.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Test: inline engine and service tests

**Interfaces:**
- Produces: `TabulateSessionService::query_window`
- Produces: `DuckDbEngine::query_tabulate_window`
- Produces: `TabulateSessionService::cancel_request`
- Consumes: Task 2 member-index tables and Task 1 window types

- [ ] **Step 1: Write failing exact-window tests**

Use a fixture containing nested row/column dimensions, null keys, sparse missing
combinations, duplicate source rows, and at least two statistics. Assert first,
middle, deep, and final windows return exact global/member ordinals and only
actual sparse cells. Add no-row, no-column, and both-empty role cases.

```rust
assert_eq!(result.row_start, 2);
assert_eq!(result.column_start, 1);
assert_eq!(result.row_members.len(), 2);
assert_eq!(result.column_members.len(), 2);
assert_eq!(result.cells, vec![
    sparse(0, 0, 0, Some(30.0)),
    sparse(0, 0, 1, Some(1.0)),
]);
```

- [ ] **Step 2: Add failing bound, stale, and cancellation tests**

Reject row count above 128, column count above 64, response cell product above
16,384, overflowed ranges, starts beyond known counts, wrong generation, and
wrong session fingerprint. Start a deliberately expensive query, cancel by
request ID, and require the stable cancelled error with no retained active entry.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cargo test tabulate_window -- --nocapture
```

Expected: new behavior tests fail because tile query/cancellation is absent.

- [ ] **Step 4: Implement exact selected-member SQL**

Read bounded member slices by ordinal. Join source rows to those slices using
one `IS NOT DISTINCT FROM` predicate per dimension, group by selected row and
column ordinals, and evaluate the existing backend-owned aggregate expressions.
Return local tile indexes (`global - start`) so payload integers stay bounded.
Do not loop over the row-by-column Cartesian product in Rust.

- [ ] **Step 5: Add active-request cancellation and error mapping**

Register request ID to the session engine's interrupt handle before query and
remove it with an RAII guard. Map an interrupted DuckDB error to the stable
cancelled diagnostic only for the matching request ID.

- [ ] **Step 6: Run focused and existing statistic tests**

Run:

```bash
cargo test tabulate_window -- --nocapture
cargo test engine::duckdb_engine::tests::tabulate_statistics -- --nocapture
```

Expected: exact tile/cancellation tests and legacy statistic-oracle tests pass.

- [ ] **Step 7: Review checkpoint**

Prove from the SQL and Rust loops that work never allocates
`rowMemberCount * columnMemberCount * statisticCount`. Do not commit.

---

### Task 4: Add Lazy Exact Totals And Percentage Denominators

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/tabulate_session_service.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Test: inline engine and service tests

**Interfaces:**
- Produces: `TabulateSessionService::query_totals`
- Produces: `DuckDbEngine::query_tabulate_totals`
- Extends: window queries with exact percentage values

- [ ] **Step 1: Write failing percentage isolation tests**

Build a fixture where the visible tile contains only half of a row and half of a
column. Assert row, column, and total percentages use complete denominators and
therefore differ from visible-only percentages. Include zero denominators,
missing values, and null members.

- [ ] **Step 2: Write failing bounded-total tests**

Assert row totals return only the requested row range, column totals return only
the requested column range, grand totals return exactly one statistic vector,
and totals cache identity distinguishes kind/start/count/fingerprint/generation.

- [ ] **Step 3: Run the focused tests and verify RED**

Run `cargo test tabulate_totals -- --nocapture`.

Expected: tests fail because bounded totals do not exist.

- [ ] **Step 4: Implement exact totals and denominator reuse**

Join only the requested member slice for row or column totals. Compute the grand
total independently. For percentage cells, obtain complete denominators through
the same session-scoped totals path; never sum visible numerators. Return null
for zero denominators and `1.0` for mathematically applicable nonzero total slots.

- [ ] **Step 5: Run all Tabulate semantic tests**

Run:

```bash
cargo test tabulate_statistics -- --nocapture
cargo test tabulate_totals -- --nocapture
```

Expected: all statistic kinds, totals, and percentages match the pre-migration
oracle on bounded fixtures.

- [ ] **Step 6: Review checkpoint**

Trace each percentage kind to its exact denominator query and confirm no tile
boundary can change a value. Do not commit.

---

### Task 5: Build Pure Two-Axis Windowing, Cache, And Scheduler Primitives

**Files:**
- Create: `src/components/tabulate/tabulateViewport.ts`
- Create: `src/components/tabulate/tabulateTileCache.ts`
- Create: `src/components/tabulate/tabulateTileScheduler.ts`
- Create: `tests/tabulateViewport.test.ts`
- Create: `tests/tabulateTileCache.test.ts`
- Create: `tests/tabulateTileScheduler.test.ts`

**Interfaces:**
- Produces: `calculateTabulateWindow(input): TabulateWindowRange`
- Produces: `buildVisibleHeaderSpans(members, boundaryContext): HeaderSpan[]`
- Produces: `TabulateTileCache`
- Produces: `TabulateTileScheduler`
- Consumes: Task 1 TS contracts

- [ ] **Step 1: Write failing viewport math tests**

Cover row and column clamp, many-statistic response reduction, final short
windows, one synthetic role member, deep logical positions above browser pixel
limits, resize, and exact 16,384-cell request bound.

```ts
assert.deepEqual(calculateTabulateWindow({
  rowStart: 999_990,
  columnStart: 99_990,
  rowMemberCount: 1_000_000,
  columnMemberCount: 100_000,
  statisticCount: 8,
  visibleRows: 40,
  visibleColumns: 12,
}), {
  rowStart: 999_990,
  rowCount: 10,
  columnStart: 99_990,
  columnCount: 10,
});
```

- [ ] **Step 2: Write failing hierarchy-boundary tests**

Provide a viewport starting in the middle of a repeated outer member. Assert the
first visible header knows it continues from the left/top and does not display a
false new group boundary.

- [ ] **Step 3: Write failing cache and scheduler tests**

Cover LRU byte/entry eviction, separate tile/totals namespaces, generation and
fingerprint invalidation, pinned foreground tile survival, duplicate-request
coalescing, one-ring-only prefetch, dropped pending work, cancellation, and stale
completion rejection.

- [ ] **Step 4: Run tests and verify RED**

Run:

```bash
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateViewport.test.ts
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateTileCache.test.ts
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateTileScheduler.test.ts
```

Expected: imports fail because the primitives do not exist.

- [ ] **Step 5: Implement the pure primitives**

Use logical indexes rather than full-size DOM spacers. Cache keys contain
session/fingerprint/generation/start/count/statistic count. Scheduler foreground
requests supersede old foreground requests and call `cancelRequest`; prefetch may
never delay foreground work.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the three commands from Step 4. Expected: all pass.

- [ ] **Step 7: Review checkpoint**

Confirm no primitive imports React, Zustand, or Tauri and every collection has a
declared bound. Do not commit.

---

### Task 6: Integrate The Session Controller And Virtual Result Grid

**Files:**
- Create: `src/components/tabulate/useTabulateSession.ts`
- Modify: `src/components/tabulate/TabulateResultTable.tsx`
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `src/components/tabulate/tabulate.css`
- Modify: `src/stores/useTabulateStore.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Create: `tests/TabulateVirtualHarness.tsx`
- Create: `tests/tabulateVirtual.spec.tsx`
- Modify: `tests/tabulateResult.test.ts`

**Interfaces:**
- Produces: `useTabulateSession(definition, datasetGeneration, presentation)`
- Produces: bounded `TabulateResultTable` virtual-grid props
- Consumes: Tasks 1 and 5 contracts/primitives

- [ ] **Step 1: Write failing component tests**

Mount a 1,000,000-row-member by 100,000-column-member mocked session. Assert the
DOM contains only visible plus overscan cells, vertical and horizontal logical
navigation requests the expected tile, sticky nested headers retain boundary
continuity, totals load separately, and resize changes the requested window
without resetting logical position.

- [ ] **Step 2: Add failing stale/error/release tests**

Delay old tile A, navigate to tile B, complete B then A, and assert A never
renders. Cover cancellation, source-generation change, session expiry/reprepare,
resource refusal copy, retry, unmount release, and definition-change release.

- [ ] **Step 3: Run focused CT and verify RED**

Run with isolated output:

```bash
npx playwright test -c playwright-ct.config.ts tests/tabulateVirtual.spec.tsx \
  --output=test-results/issue232-tabulate-virtual-red --reporter=line
```

Expected: tests fail because the virtual controller/grid are absent. Never use
the shared default Playwright output directory.

- [ ] **Step 4: Implement `useTabulateSession`**

Debounce definition changes by the existing 250 ms. Prepare/poll a session,
track one local epoch, request the calculated foreground tile and needed totals,
schedule bounded neighbors, and release on replacement/unmount. Keep runtime
state local; remove complete `TabulateResult` retention from Zustand.

- [ ] **Step 5: Replace full `<table>` rendering with a bounded virtual grid**

Render stable row-header tracks, statistic-column tracks, visible members,
placeholders, sticky nested labels, optional totals, and logical scrollbars.
Preserve formatting, visible-depth controls, keyboard semantics, and accessible
roles/labels. Do not nest cards or change the existing Tabulate workspace layout.

- [ ] **Step 6: Add localized states**

Add exact EN/ZH keys for preparing indexes, loading visible cells, loading
totals, cancelled, stale source, session expired, member-index budget, timeout,
retry, and high-cardinality guidance.

- [ ] **Step 7: Run focused tests and frontend checks**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/tabulateVirtual.spec.tsx \
  --output=test-results/issue232-tabulate-virtual-green --reporter=line
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateResult.test.ts
npx tsc -p tsconfig.app.json --noEmit
npx vite build
```

Expected: CT, pure test, typecheck, and build pass.

- [ ] **Step 8: Review checkpoint**

Inspect screenshots at desktop and narrow widths. Verify no overlap, no full-grid
DOM, stable dimensions during loading, and no `TabulateResult.cells` state in
the production UI path. Do not commit.

---

### Task 7: Materialize Complete Results Directly In DuckDB

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/tabulate_session_service.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/applicationCommands/tabulateCommands.ts`
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `tests/applicationCommandTabulate.test.ts`
- Test: inline Rust engine/service tests

**Interfaces:**
- Produces: `TabulateSessionService::materialize_table`
- Produces: `DuckDbEngine::materialize_tabulate_table`
- Replaces frontend `buildTabulateExportRequest` complete-matrix dependency

- [ ] **Step 1: Write failing atomic materialization tests**

Export a sparse nested-dimension fixture and assert exact flattened column names,
duplicate suffixes, missing labels, row order, numeric values, nulls, metadata,
and source type. Inject failure after physical-table creation and assert both
table and metadata roll back. Change source generation before commit and assert
no output remains.

- [ ] **Step 2: Run focused Rust tests and verify RED**

Run `cargo test materialize_tabulate_table -- --nocapture`.

Expected: compilation or behavior failure because backend materialization is absent.

- [ ] **Step 3: Implement one backend transaction**

Validate the ready session/fingerprint/generation, derive the existing localized
column labels from explicit request inputs, and create the managed dataset from
exact grouped SQL inside one transaction. Do not issue one window query per tile
and do not send source rows or aggregate cells through the frontend.

- [ ] **Step 4: Migrate the Application Command export handler**

Replace `buildTabulateExportRequest` plus `table.create` with one typed
`materializeTable` call. Preserve cancellation before commit, `beginCommit`,
warnings, `reran`, request fingerprint, generation reporting, history, refresh,
navigation, read-only guard, and filename policy.

- [ ] **Step 5: Run backend and Application Command tests**

Run:

```bash
cargo test materialize_tabulate_table -- --nocapture
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/applicationCommandTabulate.test.ts
npx vite build
```

Expected: atomic backend and command behavior pass.

- [ ] **Step 6: Review checkpoint**

Search production frontend code for `buildTabulateExportRequest`; it may remain
only for legacy tests during migration and must not be called by export. Do not commit.

---

### Task 8: Migrate Reports, Workflow, Application Commands, And MCP

**Files:**
- Modify: `src/components/report/TabulateReportEmbed.tsx`
- Modify: `src/applicationCommands/types.ts`
- Modify: `src/applicationCommands/tabulateCommands.ts`
- Modify: `src/applicationCommands/applicationRuntime.ts`
- Modify: `src-tauri/src/services/workflow_executor.rs`
- Modify: `src-tauri/src/services/workflow_document_executor.rs`
- Modify: `src-tauri/src/mcp/tools.rs`
- Modify: `tests/applicationCommandTabulate.test.ts`
- Modify: `tests/applicationCommandAdapterParity.test.ts`
- Modify: `tests/mcpArtifactParity.test.ts`
- Modify: `tests/reportView.spec.tsx`

**Interfaces:**
- Changes: `TabulateRunResult.result` to `TabulateRunResult.session`
- Preserves: `tabulate.exportTable` as the complete-result automation command
- Consumes: session controller and backend materialization from Tasks 6-7

- [ ] **Step 1: Write failing bounded-output contract tests**

Assert `tabulate.run` returns session ID/status/counts/fingerprint/generation but
no member arrays or cell arrays. Assert MCP JSON schema has no `maxResultCells`
and no complete `cells` output. Assert workflow execution records the same
bounded summary.

- [ ] **Step 2: Write failing report lifecycle tests**

Mount a read-only Tabulate report, navigate both axes, and assert bounded DOM,
exact visible values, disabled export, and release on unmount. Assert project
read-only state does not prevent navigation.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/applicationCommandTabulate.test.ts
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/applicationCommandAdapterParity.test.ts
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/mcpArtifactParity.test.ts
npx playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx \
  --grep="Tabulate" --output=test-results/issue232-report-red --reporter=line
```

Expected: bounded-output and report-session assertions fail.

- [ ] **Step 4: Migrate command and workflow outputs**

Update TypeScript and Rust mirrored types together. `tabulate.run` prepares or
reuses a session and returns its summary. Workflow document execution must not
serialize a complete result. Keep saved operation configuration schema version
`1` unless the persisted definition itself changes; runtime output alone does
not justify a persistence migration.

- [ ] **Step 5: Migrate MCP schemas and dispatch parity**

Update `TabulateRunToolInput/Output` and `TabulateToTableToolInput/Output` so MCP
uses bounded run summaries and backend export. Preserve deny-unknown-fields,
camelCase, command-name parity, cancellation, and warning envelopes.

- [ ] **Step 6: Migrate the report embed**

Use the same `useTabulateSession` controller with `presentation="readOnly"`.
Never instantiate the legacy full-result command. Release the report-owned
session on dependency change or unmount.

- [ ] **Step 7: Run focused migration tests and builds**

Repeat Step 3 with `issue232-report-green`, then run:

```bash
cargo test workflow -- --nocapture
cargo test mcp -- --nocapture
npx tsc -p tsconfig.app.json --noEmit
npx vite build
```

Expected: all affected automation/report contracts pass.

- [ ] **Step 8: Review checkpoint**

Search `src/` and `src-tauri/src/` for full-result consumers. Every production
interactive, report, workflow, MCP, and export path must be migrated before Task
9. Do not commit.

---

### Task 9: Remove The Fixed Limit And Close Compatibility Gaps

**Files:**
- Modify: `src-tauri/src/models/tabulate.rs`
- Modify: `src-tauri/src/services/tabulate_service.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/commands/tabulate_commands.rs`
- Modify: `src/types/tabulate.ts`
- Modify: `src/services/tabulateService.ts`
- Modify: `src/stores/useTabulateStore.ts`
- Modify: `src/components/tabulate/tabulateResult.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: affected legacy tests

**Interfaces:**
- Removes: `MAX_RESULT_CELLS`, `max_result_cells`, full `TabulateResult.cells`
  from production runtime contracts
- Preserves: durable `TabulateItem` archive shape and existing statistical oracle

- [ ] **Step 1: Add failing absence and persistence tests**

Assert production source contains no `MAX_RESULT_CELLS`, `maxResultCells: 10000`,
or user-facing 10,000-cell limit copy. Round-trip an existing project fixture and
assert its Tabulate definitions and folder placement remain byte-semantically
equivalent with no session fields added.

- [ ] **Step 2: Run the focused checks and verify RED**

Run the Tabulate source-contract test and focused project archive tests.

Expected: old cap and legacy full-result references make the assertions fail.

- [ ] **Step 3: Remove the legacy full-result runtime**

Delete the fixed-cap validation and monolithic production command after the Task
8 consumer audit is clean. Retain pure formatting/index helpers only when still
used by virtual tiles or export naming. Remove complete-result Zustand cache and
obsolete too-large UI state.

- [ ] **Step 4: Preserve project and read-only lifecycle behavior**

Verify New/Open/Close/reset clears mounted runtime sessions through component
unmount, not archive mutation. Existing `.spprj` Tabulate definitions require no
schema bump. Read-only projects can view/navigate but cannot edit definitions or export.

- [ ] **Step 5: Run compatibility tests**

Run:

```bash
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/tabulateResult.test.ts
TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx tests/applicationCommandTabulate.test.ts
cargo test tabulate -- --nocapture
cargo test spprj_archive -- --nocapture
npx vite build
```

Expected: no fixed limit remains and existing project/statistic semantics pass.

- [ ] **Step 6: Review checkpoint**

Run bounded searches for removed symbols and inspect the scoped diff. Do not
commit; manual acceptance remains ahead.

---

### Task 10: Add The 10M Performance Matrix And Resource Regressions

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Create: `scripts/runTabulateViewportBenchmark.mjs`
- Create: `scripts/tabulateViewportBenchmarkCore.mjs`
- Create: `scripts/tabulateViewportBenchmarkCore.test.mjs`
- Modify: `docs/performance.md`

**Interfaces:**
- Produces deterministic benchmark JSON with source, logical-grid, tile, totals,
  payload, memory, cancellation, and timing evidence
- Consumes the production session/window/totals commands

- [ ] **Step 1: Write failing benchmark-core tests**

Validate fixture arguments, require exactly 10,000,000 source rows and the
100,000/1,000,000/10,000,000 logical-cell tiers, reject missing sample arrays,
compute P50/P95 only from at least 30 settled samples, and keep RSS distinct from
member-index bytes.

- [ ] **Step 2: Run benchmark-core tests and verify RED**

Run `node --test scripts/tabulateViewportBenchmarkCore.test.mjs`.

Expected: module-not-found or missing-validation failure.

- [ ] **Step 3: Implement deterministic fixture and measurements**

Generate source data inside DuckDB so the benchmark does not copy a 10M-row
artifact into Git. Record:

```json
{
  "sourceRows": 10000000,
  "rowMembers": 1000,
  "columnMembers": 1000,
  "statisticCount": 1,
  "logicalCells": 1000000,
  "nonemptyGroups": 1000000,
  "memberIndexBytes": 0,
  "wholeProcessRssBytes": 0,
  "tilePayloadBytes": [],
  "backendTileMs": [],
  "ipcRoundTripMs": [],
  "visibleInteractionMs": []
}
```

Also record preparation, totals, cancellation latency, exact returned cells, and
whether the 10M tier completed or produced an expected controlled refusal.

- [ ] **Step 4: Add resource-failure regressions**

Use test policies to force member-index budget, session quota, timeout,
cancellation, and eviction. Assert stable errors, dropped temporary objects, no
partial ready result, and successful recovery with a smaller request.

- [ ] **Step 5: Run script tests and a bounded smoke benchmark**

Run:

```bash
node --test scripts/tabulateViewportBenchmarkCore.test.mjs
node scripts/runTabulateViewportBenchmark.mjs --source-rows=100000 --logical-cells=100000 --samples=3
```

Expected: deterministic validation passes and smoke output is schema-valid. The
smoke run is not P95 or 10M qualification evidence.

- [ ] **Step 6: Document evidence boundaries**

Update `docs/performance.md` with exact layer definitions, fixture provenance,
sample-count requirement, platform separation, and the rule that a controlled
10M-tier refusal is acceptable but truncation/false success is not.

- [ ] **Step 7: Review checkpoint**

Verify generated benchmark outputs are ignored and no source data enters Git.
Do not run the full qualification matrix until correctness and review fixes are
frozen, so the retained evidence describes final source.

---

### Task 11: Final Automated Verification And Independent Review

**Files:**
- Verify all Issue 232 files; modify only defects caused by Tasks 1-10.

**Interfaces:**
- Proves the complete Issue contract before manual acceptance

- [ ] **Step 1: Run every focused TypeScript test**

Run all Tabulate viewport/cache/scheduler/result/Application Command/MCP parity
tests with `TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx`.

Expected: every focused script exits 0.

- [ ] **Step 2: Run isolated Playwright component suites**

Run Tabulate virtual and Report suites with unique output directories under
`test-results/issue232-*`.

Expected: all cases pass and retained screenshots show no overlap or blank grid.

- [ ] **Step 3: Run frontend gates**

```bash
npx tsc -p tsconfig.app.json --noEmit
npx vite build
```

Expected: both exit 0.

- [ ] **Step 4: Run backend gates**

From `src-tauri/`:

```bash
cargo test tabulate -- --nocapture
cargo test workflow -- --nocapture
cargo test mcp -- --nocapture
cargo build
cargo clippy --all-targets --all-features -- -D warnings
```

Expected: all affected tests/builds pass. If repository-wide Clippy has a
pre-existing baseline, capture exact diagnostics and require zero new Issue 232
diagnostics rather than rewriting unrelated files.

- [ ] **Step 5: Freeze source and run the full performance matrix once**

Record source hashes, then execute 10M source rows against 100k, 1M, and 10M
logical-cell tiers with at least 30 settled samples for any reported P95. Verify
source hashes remain unchanged after measurement.

- [ ] **Step 6: Dispatch independent code review**

Provide Issue #232, the approved spec, confirmed base SHA, actual diff including
untracked files, test evidence, and performance artifacts. Fix every Critical or
Important finding and rerun affected focused/full gates. Repeat review after any
material behavioral repair.

- [ ] **Step 7: Inspect final scope**

Run bounded diff stat first, then file-specific diffs. Require `git diff --check`,
no secrets/generated data, no unrelated files, and no staged changes. Preserve
the user's primary checkout and all unrelated worktrees.

---

### Task 12: Native Acceptance, Publication, And Lifecycle Completion

**Files:**
- No planned source edits; repair only acceptance failures attributable to Issue 232.

**Interfaces:**
- Completes the GitHub Issue lifecycle after user acceptance

- [ ] **Step 1: Start the exact Issue worktree build**

Launch Tauri bound explicitly to the Issue 232 worktree. Verify frontend source,
executable path, process cwd, title, and port before presenting it.

- [ ] **Step 2: Run the manual acceptance checklist**

On macOS WebKit verify:

- Open 10M-row source fixtures at the 100k and 1M logical-cell tiers.
- Navigate first/middle/deep/final positions on both axes.
- Confirm exact cells, nested headers, nulls, percentages, totals, resize, retry,
  source mutation, and cancellation.
- Confirm DOM remains bounded and interaction does not freeze.
- Export to Table and compare exact values/names against the statistical oracle.
- Open the same Tabulate in a Report and verify read-only virtual navigation.
- Exercise the 10M logical-cell tier and accept exact navigation or the declared
  controlled refusal only.

- [ ] **Step 3: Obtain explicit user acceptance**

Stop here until the user confirms manual acceptance. Do not commit, push, or
create a pull request before that response.

- [ ] **Step 4: Run fresh verification on the accepted tree**

Repeat required frontend/backend focused gates and source-hash checks. Stage only
Issue 232 files and inspect the staged diff.

- [ ] **Step 5: Commit, push, and create the pull request**

After acceptance, create Conventional Commits on the feature branch, push without
force, and open a PR to the user-confirmed target branch with `Closes #232`, exact
verification, acceptance, head SHA, worktree path, and disposable ignore allowlist.
Verify local head equals GitHub PR head. Do not merge automatically.

- [ ] **Step 6: Complete Windows acceptance before merge qualification**

Run the same live viewport/resource checklist on Windows WebView2 and attach
separate evidence. Do not reuse macOS timings as Windows qualification.

- [ ] **Step 7: Verify merge and clean up only when separately authorized**

After the user reports merge, verify GitHub `merged=true`, target-branch
containment, and Issue closure. Inspect tracked/untracked/ignored worktree state
against PR cleanup metadata. Remove the worktree and local branch only after an
explicit cleanup request; never delete the remote branch automatically.
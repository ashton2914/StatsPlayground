# 10M-Row Table Random Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide JMP-like direct navigation to any position in a managed table containing at least 10,000,000 rows while keeping frontend work, memory, and settled latency bounded.

**Architecture:** Replace physical-height vertical scrolling with a bounded logical rail and stable viewport slots. Natural order uses generation-bound sparse `_row_id` anchors with bounded local offset; filtered and sorted order uses cancellable backend query sessions that materialize an ordinal-to-row-ID mapping once. Cloned DuckDB read connections, latest-wins scheduling, visible-column projection, and bounded caches prevent obsolete work and payload size from scaling with the full table.

**Tech Stack:** React 19, TypeScript 5.7, Playwright Component Testing, Tauri v2, Rust 2021, DuckDB 1.10505.0, Zustand-compatible component state, existing Node/TS test convention.

**Spec:** `docs/superpowers/specs/2026-09-17-10m-row-table-random-navigation-design.md`

**Issue:** https://github.com/ashton2914/StatsPlayground/issues/224

## Global Constraints

- Release acceptance workload is at least 10,000,000 rows.
- Scroll-drag visual feedback P95 is no more than 16 ms.
- Natural-order cold random jump P95 is no more than 100 ms after drag settles.
- Cached random jump P95 is no more than 50 ms.
- A prepared filtered/sorted session random jump P95 is no more than 200 ms.
- Never render a vertical spacer proportional to total row count.
- Keep at most one active viewport request and one latest pending target per table.
- Keep the existing semantic DOM table, editing, selection, formatting, calculated-column, history, and generation-fence behavior.
- Use parameterized SQL values and metadata-validated quoted identifiers only.
- Return `Result<T, AppError>` from Rust production paths; do not use `unwrap()` or `expect()` outside tests.
- Do not add Canvas, WebGL, or `wgpu` table rendering in this plan.
- Binary transport is measurement-gated: retain bounded JSON unless encode, transfer, or decode exceeds 20% of the uncached-jump budget.
- Work on a dedicated Issue branch in the canonical sibling worktree, never directly on `dev`.

---

## File Structure

### New Frontend Files

- `src/utils/tableScrollModel.ts`: pure ratio, logical-position, wheel, keyboard, clamping, and slot-count calculations.
- `src/utils/tableNavigationScheduler.ts`: latest-wins settle timer, active request identity, pending target replacement, and cancellation callbacks without React dependencies.
- `src/components/table/LogicalVerticalScrollbar.tsx`: accessible vertical rail that maps pointer/keyboard input to logical positions.
- `src/components/table/TableViewportRows.tsx`: stable slot-keyed loaded and placeholder row rendering extracted from `DataTableView`.
- `tests/tableScrollModel.test.ts`: pure logical-scroll regressions through 10,000,000 rows.
- `tests/tableNavigationScheduler.test.ts`: deterministic fake-clock scheduler regressions.
- `tests/LogicalTableNavigationHarness.tsx`: component harness for logical rail, placeholders, slot reuse, edit, and selection checks.
- `tests/logicalTableNavigation.spec.tsx`: Playwright component acceptance for distant and bidirectional navigation.

### New Backend Files

- `src-tauri/src/services/table_navigation_service.rs`: cloned read workers, interrupt handles, sparse natural anchors, query-session lifecycle, bounded session eviction, and window execution.

### Modified Files

- `src/types/data.ts`: versioned navigation request/result, session, timing, and cancellation contracts.
- `src/services/dataService.ts`: typed wrappers for navigation, session preparation/release, and request cancellation.
- `src/utils/tableViewport.ts`: retain selection helpers but remove physical-height window calculation from the production path.
- `src/utils/tableWindowCache.ts`: include projected columns and session identity in keys; enforce row and byte budgets.
- `src/components/DataTableView.tsx`: compose the logical rail, scheduler, cache, and extracted viewport rows; preserve product actions.
- `src/App.css`: size the rail and stable slots without total-row-height styles.
- `src-tauri/src/models/table.rs`: Rust mirrors of the navigation IPC contracts.
- `src-tauri/src/models/mod.rs`: export new table navigation types when required by the current module pattern.
- `src-tauri/src/engine/duckdb_engine.rs`: clone connections, maintain metadata row counts, build/query sparse anchors, create/query/drop ordinal mappings, and project visible columns.
- `src-tauri/src/services/mod.rs`: register `table_navigation_service`.
- `src-tauri/src/state.rs`: own `TableNavigationService` and recreate it with every engine reset.
- `src-tauri/src/services/data_service.rs`: delegate table-navigation operations.
- `src-tauri/src/commands/data_commands.rs`: expose thin async Tauri navigation commands.
- `src-tauri/src/lib.rs`: register every new command.
- `src-tauri/src/perf_harness.rs`: add a table-navigation operation and stage timings.
- `docs/performance.md`: record the 10M-row command, machine profile, P50/P95 positions, stage timing, and transport decision.
- `tests/tableViewport.test.ts`, `tests/tableWindowCache.test.ts`, `tests/dataTableScroll.spec.tsx`, `tests/DataTableScrollHarness.tsx`: migrate existing expectations to logical navigation.

---

### Task 1: Establish The 10M-Row Measurement Gate

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`
- Test: inline tests in `src-tauri/src/perf_harness.rs`

**Interfaces:**
- Produces: `Operation::TableNavigation` parsed from `table-navigation`.
- Produces: `TableNavigationPerformanceReport` fields `positionPercent`, `targetStart`, `lockWaitMs`, `countMs`, `anchorMs`, `queryMs`, `encodeMs`, `totalMs`, `resultRows`, and `transferredBytes`.
- Produces: release command accepting `--rows 10000000 --columns 20 --operation table-navigation --position-percent <0|50|90|99|100>`.

- [ ] **Step 1: Write failing option-parser and report-shape tests**

Add tests that parse:

```rust
let options = Options::parse_from([
    "performance_baseline",
    "--rows", "10000000",
    "--columns", "20",
    "--operation", "table-navigation",
    "--position-percent", "99",
])?;
assert_eq!(options.operation, Operation::TableNavigation);
assert_eq!(options.position_percent, Some(99));
```

Reject percentages above 100 and reject `--position-percent` for unrelated operations.

- [ ] **Step 2: Run the focused Rust test and verify failure**

Run:

```bash
cd src-tauri && cargo test perf_harness::tests::parses_table_navigation_operation
```

Expected: FAIL because `TableNavigation` and `position_percent` do not exist.

- [ ] **Step 3: Add the operation and stage report without changing production queries**

Seed the existing deterministic table, calculate `target_start` from the requested percentage, execute the current `query_table_window`, serialize the result once with `serde_json::to_vec`, and report the measured stages. Keep setup time separate.

- [ ] **Step 4: Run focused tests and a bounded baseline**

Run:

```bash
cd src-tauri && cargo test perf_harness::tests
cargo run --release --example performance_baseline --features perf-harness -- --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Expected: tests PASS; the final command prints one JSON report and exposes the pre-change deep-jump baseline.

- [ ] **Step 5: Record the baseline and commit**

Add the command, machine/OS, release profile, target position, and stage values to `docs/performance.md`.

```bash
git add src-tauri/src/perf_harness.rs docs/performance.md
git commit -m "test(data): baseline 10m row table navigation"
```

---

### Task 2: Add The Pure Logical Scroll Model

**Files:**
- Create: `src/utils/tableScrollModel.ts`
- Create: `tests/tableScrollModel.test.ts`

**Interfaces:**
- Produces: `LogicalScrollMetrics { totalRows: number; visibleRows: number; logicalStart: number }`.
- Produces: `logicalStartFromRatio(ratio: number, totalRows: number, visibleRows: number): number`.
- Produces: `ratioFromLogicalStart(logicalStart: number, totalRows: number, visibleRows: number): number`.
- Produces: `moveLogicalStart(metrics: LogicalScrollMetrics, rowDelta: number): number`.
- Produces: `viewportSlotCount(viewportHeight: number, rowHeight: number, overscanRows: number): number`.

- [ ] **Step 1: Write failing pure tests**

Cover zero rows, fewer rows than the viewport, 10,000,000-row positions at 0%, 50%, 90%, 99%, and 100%, round-trip error of at most one row, negative/greater-than-one ratio clamping, zoom-derived row heights, wheel deltas, Page Up/Down, Home, and End.

Use exact assertions such as:

```ts
assert.equal(logicalStartFromRatio(1, 10_000_000, 40), 9_999_960);
assert.ok(Math.abs(
  logicalStartFromRatio(
    ratioFromLogicalStart(8_500_000, 10_000_000, 40),
    10_000_000,
    40,
  ) - 8_500_000,
) <= 1);
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableScrollModel.test.ts
```

Expected: FAIL because `tableScrollModel.ts` does not exist.

- [ ] **Step 3: Implement the four pure functions**

Use finite-number guards, integer row outputs, and `Math.max(0, totalRows - visibleRows)` as the only maximum logical start. Do not multiply total rows by row height.

- [ ] **Step 4: Run focused tests and build**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableScrollModel.test.ts
npm run build
```

Expected: PASS and production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/utils/tableScrollModel.ts tests/tableScrollModel.test.ts
git commit -m "feat(data): add logical table scroll model"
```

---

### Task 3: Add The Logical Rail And Stable Viewport Slots

**Files:**
- Create: `src/components/table/LogicalVerticalScrollbar.tsx`
- Create: `src/components/table/TableViewportRows.tsx`
- Create: `tests/LogicalTableNavigationHarness.tsx`
- Create: `tests/logicalTableNavigation.spec.tsx`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/App.css`
- Modify: `tests/dataTableScroll.spec.tsx`
- Modify: `tests/DataTableScrollHarness.tsx`

**Interfaces:**
- Consumes: Task 2 logical-scroll functions.
- Produces: `LogicalVerticalScrollbarProps { totalRows; visibleRows; logicalStart; onLogicalStartChange; onInteractionEnd; disabled }`.
- Produces: `TableViewportRowsProps` containing `slotCount`, `logicalStart`, loaded window identity, visible columns, row interaction state, and existing cell callbacks.
- Produces: slot DOM keys `slot-0` through `slot-(slotCount - 1)` independent of logical row numbers.

- [ ] **Step 1: Write failing component tests**

Mount a 10,000,000-row harness with 40 visible slots. Assert:

- the table body has no element whose computed or inline height scales to 270,000,000 px;
- dragging the rail to 90% synchronously displays target row headers near 9,000,000 with inert placeholders;
- the same `data-viewport-slot="0"` element survives a jump from top to 99%;
- placeholder cells cannot enter edit mode;
- loaded rows replace placeholders without changing row height;
- wheel, Home, End, Page Up, and Page Down update logical position;
- selection/edit state remains attached to its logical row after slot reuse.

- [ ] **Step 2: Run the component test and verify failure**

```bash
npx playwright test -c playwright-ct.config.ts tests/logicalTableNavigation.spec.tsx
```

Expected: FAIL because the rail and slot components do not exist.

- [ ] **Step 3: Implement the rail and extract slot rendering**

Use an accessible `role="scrollbar"` rail with `aria-valuemin="0"`, `aria-valuemax={maxLogicalStart}`, `aria-valuenow={logicalStart}`, pointer capture, and keyboard handling. Keep the existing horizontal native scroll container. Move row rendering from `DataTableView` into `TableViewportRows`; each slot derives `logicalRow = logicalStart + slotIndex` and looks up loaded data by absolute row.

- [ ] **Step 4: Remove production vertical spacer heights**

Delete the top/bottom `<td height={logicalRows * ROW_HEIGHT}>` path. Keep fixed-height row slots and existing horizontal column spacers. Preserve row headers and the add-row affordance.

- [ ] **Step 5: Run focused UI regressions and build**

```bash
npx playwright test -c playwright-ct.config.ts tests/logicalTableNavigation.spec.tsx tests/dataTableScroll.spec.tsx
npm run build
```

Expected: all component tests PASS and build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/table src/components/DataTableView.tsx src/App.css tests/LogicalTableNavigationHarness.tsx tests/logicalTableNavigation.spec.tsx tests/dataTableScroll.spec.tsx tests/DataTableScrollHarness.tsx
git commit -m "feat(data): render tables through logical viewport slots"
```

---

### Task 4: Add Versioned Navigation IPC And Visible-Column Windows

**Files:**
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline tests in `src-tauri/src/engine/duckdb_engine.rs` and `src-tauri/src/commands/mutation_guard_coverage.rs`

**Interfaces:**
- Produces mirrored Rust/TypeScript `TableNavigationRequest` with fields `version: 1`, `requestId`, `datasetId`, `generation`, `start`, `count`, `columnIds`, `sort`, `filters`, and `sessionId`.
- Produces mirrored `TableNavigationResult` with fields `version: 1`, `requestId`, `datasetId`, `generation`, `start`, `totalRows`, `totalRowsExact`, `sessionId`, `columns`, `columnTypes`, `rows`, and `timings`.
- Produces `dataService.queryTableNavigationWindow(request): Promise<TableNavigationResult>`.
- Produces Tauri command `query_table_navigation_window(request)` registered in `tauri::generate_handler!`.

- [ ] **Step 1: Add failing Rust contract tests**

Deserialize a camelCase request containing stable column IDs. Assert version 0 and 2 are rejected, unknown/duplicate IDs are rejected, `_row_id` is included exactly once, response columns follow requested order, and only requested user columns are returned.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
cd src-tauri && cargo test query_table_navigation_window
```

Expected: FAIL because the contracts and engine method do not exist.

- [ ] **Step 3: Add mirrored contracts and the thin command path**

Keep existing `TableWindowRequest` temporarily for compatibility. Add the new service wrapper and command registration in one slice so no unregistered IPC API exists.

- [ ] **Step 4: Implement metadata-validated projection**

Resolve `columnIds` through `_meta_columns`, reject IDs outside the dataset, quote resolved names through the existing identifier helper, and bind all filter values as parameters. Return `_row_id` first followed by requested columns.

- [ ] **Step 5: Run Rust tests, frontend build, and registration coverage**

```bash
cd src-tauri && cargo test query_table_navigation_window
cd .. && npm run build
```

Expected: focused tests PASS; TypeScript/Rust contracts agree; command registration coverage passes.

- [ ] **Step 6: Commit**

```bash
git add src/types/data.ts src/services/dataService.ts src-tauri/src/models/table.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/data_service.rs src-tauri/src/commands/data_commands.rs src-tauri/src/lib.rs src-tauri/src/commands/mutation_guard_coverage.rs
git commit -m "feat(data): add visible-column table navigation IPC"
```

---

### Task 5: Implement Sparse Natural-Order Anchors

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/table_navigation_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Test: inline tests in `src-tauri/src/engine/duckdb_engine.rs` and `src-tauri/src/services/table_navigation_service.rs`

**Interfaces:**
- Produces metadata table `_table_navigation_anchors(dataset_id, generation, ordinal, row_id)` with primary key `(dataset_id, generation, ordinal)`.
- Produces constant `NATURAL_ANCHOR_STRIDE: usize = 4096`.
- Produces `DuckDbEngine::rebuild_natural_anchors(dataset_id, generation) -> Result<(), AppError>`.
- Produces `DuckDbEngine::query_natural_navigation_window(connection, request) -> Result<TableNavigationResult, AppError>`.
- Produces `DuckDbEngine::try_clone() -> Result<DuckDbEngine, AppError>` using `Connection::try_clone()`.
- Produces `TableNavigationService::new(engine: &DuckDbEngine, reader_count: usize) -> Result<Self, AppError>` with two readers in production.

- [ ] **Step 1: Write failing sparse-anchor tests**

Seed at least 20,000 rows, delete rows around and between anchors, and assert targets before/at/after each gap return the same logical rows as `ORDER BY _row_id LIMIT/OFFSET`. Assert the local offset executed after selecting an anchor never exceeds 4095. Assert metadata `row_count` supplies `totalRows` without `COUNT(*)` in the viewport query plan.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
cd src-tauri && cargo test natural_navigation
```

Expected: FAIL because anchors and cloned readers do not exist.

- [ ] **Step 3: Add anchor schema and set-based rebuild**

Build anchors with a parameterized `INSERT ... SELECT` over `row_number() OVER (ORDER BY _row_id) - 1`, retaining every 4096th ordinal. Delete only the target dataset's stale anchor generations. Integrate rebuild into table creation/import and structural row mutations before publishing the new generation as ready for navigation.

- [ ] **Step 4: Implement bounded seek**

Find the greatest anchor ordinal no larger than `request.start`, then query `_row_id >= anchor.row_id` with `LIMIT request.count OFFSET request.start - anchor.ordinal`. Handle start zero and end clamping. Use generation-bound metadata row count.

- [ ] **Step 5: Add cloned readers to application state**

Construct `TableNavigationService` from `DuckDbEngine::try_clone()` after metadata initialization. On `reset_db`, build the replacement engine and replacement navigation service before swapping either into state, so partial reset cannot leave mismatched databases.

- [ ] **Step 6: Run focused Rust tests and the 10M benchmark**

```bash
cd src-tauri && cargo test natural_navigation
cargo run --release --example performance_baseline --features perf-harness -- --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Expected: correctness tests PASS; the 99% query uses metadata count and bounded local offset; total P95 target is evaluated against 100 ms.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/table_navigation_service.rs src-tauri/src/services/mod.rs src-tauri/src/state.rs src-tauri/src/services/data_service.rs
git commit -m "feat(data): seek table windows through sparse row anchors"
```

---

### Task 6: Add Latest-Wins Scheduling And DuckDB Interruption

**Files:**
- Create: `src/utils/tableNavigationScheduler.ts`
- Create: `tests/tableNavigationScheduler.test.ts`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src-tauri/src/services/table_navigation_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/dataService.ts`
- Test: inline tests in `src-tauri/src/services/table_navigation_service.rs`

**Interfaces:**
- Produces: `TableNavigationScheduler` constructor accepting `settleMs: 75`, `start(request)`, `cancel(requestId)`, and fake-clock dependencies.
- Produces: `dataService.cancelTableNavigationRequest(requestId): Promise<void>`.
- Produces: Tauri command `cancel_table_navigation_request(request_id)`.
- Consumes: DuckDB `Connection::interrupt_handle()` for each cloned read worker.

- [ ] **Step 1: Write failing scheduler tests with a fake clock**

Assert 100 drag updates start no data request before 75 ms, settling starts only the final target, a new target cancels the active request, one active plus one pending is never exceeded, cancellation completion does not surface as an error, and a dataset-generation change cancels both active and pending work.

- [ ] **Step 2: Write failing Rust interruption tests**

Start a deliberately expensive test query on a cloned connection, cancel by request ID, and assert its interrupt handle terminates the query and releases the worker for the latest request. Assert cancelling an unknown/already-finished ID is idempotent.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableNavigationScheduler.test.ts
cd src-tauri && cargo test table_navigation_service::tests::interrupts_obsolete_request
```

Expected: both fail because scheduler and cancellation APIs do not exist.

- [ ] **Step 4: Implement frontend settle scheduling**

Update placeholders every animation frame, but call `queryTableNavigationWindow` only on pointer release or after 75 ms without a new logical target. When replacing an active request, invoke cancellation before recording the next request as active.

- [ ] **Step 5: Implement backend request registry and interruption**

Register `requestId -> worker interrupt handle` only while a query is active. Remove it in a scope guard on success, failure, or cancellation. Map the known interrupted-query result to a non-user-facing cancelled result; preserve other DuckDB errors as `AppError::Database`.

- [ ] **Step 6: Run scheduler, component, Rust, and build checks**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableNavigationScheduler.test.ts
npx playwright test -c playwright-ct.config.ts tests/logicalTableNavigation.spec.tsx
cd src-tauri && cargo test table_navigation_service
cd .. && npm run build
```

Expected: all checks PASS; instrumentation proves no more than one active and one latest pending request.

- [ ] **Step 7: Commit**

```bash
git add src/utils/tableNavigationScheduler.ts tests/tableNavigationScheduler.test.ts src/components/DataTableView.tsx src-tauri/src/services/table_navigation_service.rs src-tauri/src/commands/data_commands.rs src-tauri/src/lib.rs src/services/dataService.ts
git commit -m "feat(data): prioritize latest table navigation request"
```

---

### Task 7: Add Filtered And Sorted Ordinal Query Sessions

**Files:**
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/table_navigation_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/components/DataTableView.tsx`
- Test: inline Rust tests and `tests/logicalTableNavigation.spec.tsx`

**Interfaces:**
- Produces mirrored `TableQuerySessionRequest { datasetId; generation; sort; filters; columnIds }`.
- Produces mirrored `TableQuerySessionStatus { sessionId; state: "preparing" | "ready" | "cancelled" | "failed"; totalRows: number | null; progress: number | null }`.
- Produces commands `prepare_table_query_session`, `get_table_query_session_status`, and `release_table_query_session`.
- Produces session key from dataset ID, generation, canonical serialized filters, deterministic sort plus `_row_id`, and projected column IDs.
- Produces temporary mapping columns `ordinal BIGINT` and `row_id BIGINT`, with ordinal zero-based and unique.

- [ ] **Step 1: Write failing query-session tests**

Cover deterministic duplicate sort values, combined continuous/categorical/date filters, 0/50/90/99/100% windows, exact count stored once, session reuse for identical signatures, distinct sessions for changed generation/filter/sort/columns, release, cancellation, idle expiry, LRU eviction, and mutation invalidation.

- [ ] **Step 2: Run focused Rust tests and verify failure**

```bash
cd src-tauri && cargo test table_query_session
```

Expected: FAIL because query sessions do not exist.

- [ ] **Step 3: Implement canonical signatures and dedicated session connections**

Bind each preparing/ready session to one cloned connection because DuckDB temporary tables are connection-local. Materialize the mapping with `row_number() OVER (<validated sort>, _row_id) - 1`. Store count from the materialized mapping, create an ART index on `ordinal`, and query windows by bounded ordinal range joined back to the managed table by `_row_id`.

- [ ] **Step 4: Add bounded lifecycle and progress states**

Allow at most two prepared sessions per table and enforce a measured byte estimate. Evict least-recently-used idle sessions, never the active displayed session. Cancel preparation with the connection interrupt handle. Publish `ready` only after mapping, count, and index succeed; drop partial temporary objects on failure.

- [ ] **Step 5: Wire frontend session preparation**

Natural order uses no session. A non-empty filter or sort prepares/reuses a session, keeps coherent placeholders while preparing, switches the logical rail to the session's exact count only when ready, and releases superseded sessions. Never show rows from the previous signature under the new signature.

- [ ] **Step 6: Run Rust, component, and existing filter tests**

```bash
cd src-tauri && cargo test table_query_session
cd .. && npx playwright test -c playwright-ct.config.ts tests/logicalTableNavigation.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts
npm run build
```

Expected: all checks PASS; prepared-session jumps meet correctness at all target positions.

- [ ] **Step 7: Commit**

```bash
git add src/types/data.ts src/services/dataService.ts src-tauri/src/models/table.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/table_navigation_service.rs src-tauri/src/commands/data_commands.rs src-tauri/src/lib.rs src/components/DataTableView.tsx tests/logicalTableNavigation.spec.tsx
git commit -m "feat(data): index filtered table navigation sessions"
```

---

### Task 8: Make Cache Keys Column/Session-Aware And Run The Transport Gate

**Files:**
- Modify: `src/utils/tableWindowCache.ts`
- Modify: `tests/tableWindowCache.test.ts`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`

**Interfaces:**
- Produces cache constructor `TableWindowCache({ maxRows: 5_000, maxBytes: 64 * 1024 * 1024 })`.
- Produces cache key containing dataset ID, generation, query-session ID/signature, aligned start, count, ordered column IDs, and transport version.
- Produces diagnostics `retainedRows`, `estimatedBytes`, `entryCount`, `cacheHit`, `encodeMs`, `decodeMs`, and `transferredBytes`.

- [ ] **Step 1: Write failing cache tests**

Assert windows with different column sets or session IDs never alias, overlapping immutable row arrays are not duplicated within one entry, both row and byte limits evict LRU entries, the active window can be pinned during pressure, generation invalidation clears incompatible entries, and neighbor prefetch never evicts the active target.

- [ ] **Step 2: Run the cache test and verify failure**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableWindowCache.test.ts
```

Expected: FAIL because the cache has no column/session/byte identity.

- [ ] **Step 3: Implement bounded column/session-aware caching and low-priority prefetch**

Estimate retained bytes from scalar payloads and array capacities using one documented conservative helper. Prefetch only immediate aligned neighbors after the active window is painted; cancel prefetch on direct navigation.

- [ ] **Step 4: Add transport timings to the release harness**

Measure backend encode, actual serialized bytes, frontend decode in the desktop component harness, and first painted cells for 20-column and 200-column workloads. Record each as a share of the 100 ms uncached natural-jump budget.

- [ ] **Step 5: Apply the binary transport decision rule**

If encode, transfer, or decode is greater than 20 ms P95, stop before implementation and create a separately reviewed binary Arrow IPC design/plan; do not improvise a protocol inside this task. If all three are at or below 20 ms P95, retain versioned bounded JSON and record the measured decision in `docs/performance.md`.

- [ ] **Step 6: Run focused tests, build, and release measurements**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableWindowCache.test.ts
npm run build
cd src-tauri && cargo run --release --example performance_baseline --features perf-harness -- --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Expected: tests/build PASS and the transport decision is supported by recorded P95 values.

- [ ] **Step 7: Commit the JSON path or stop at the explicit binary gate**

For a passing JSON gate:

```bash
git add src/utils/tableWindowCache.ts tests/tableWindowCache.test.ts src/components/DataTableView.tsx src-tauri/src/perf_harness.rs docs/performance.md
git commit -m "perf(data): bound table navigation cache and transport"
```

---

### Task 9: Complete Regression, Performance, And Cross-Platform Acceptance

**Files:**
- Modify: `tests/logicalTableNavigation.spec.tsx`
- Modify: `docs/performance.md`
- Modify: `docs/troubleshooting.md` only if an observed platform-specific limitation needs a user-facing remedy.

**Interfaces:**
- Consumes every previous task.
- Produces final acceptance evidence for Windows WebView2 and macOS WKWebView.
- Produces a table of P50/P95 stage timings at 0%, 50%, 90%, 99%, and 100% for natural order and one prepared filtered/sorted session.

- [ ] **Step 1: Add the final interaction matrix**

Cover mouse thumb drag, trackpad, wheel, Home/End, Page Up/Down, zoom, row/column/cell selection, edit commit/cancel, calculated-column read-only behavior, filter, sort, project switch, insert/delete, undo/redo, stale generation, session cancellation, and rapid bidirectional navigation.

- [ ] **Step 2: Run all table-focused frontend tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableScrollModel.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableNavigationScheduler.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableWindowCache.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/dataTableLoadGuards.test.ts
npx playwright test -c playwright-ct.config.ts tests/logicalTableNavigation.spec.tsx tests/dataTableScroll.spec.tsx tests/dataTableSplitters.spec.tsx
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run backend focused and full gates**

```bash
cd src-tauri
cargo test table_navigation
cargo test
cargo build
cargo clippy -- -D warnings
```

Expected: focused and repository-required gates pass. Record any unrelated pre-existing clippy baseline separately; do not modify unrelated files.

- [ ] **Step 4: Run release benchmarks at every target position**

Run the 10M-row command for 0, 50, 90, 99, and 100 percent on Windows and macOS. Run at least 20 iterations after one warm-up, report P50/P95, and verify active request count never exceeds one with one latest pending target.

- [ ] **Step 5: Perform manual acceptance**

Open a 10M-row table and verify no blank body, immediate target row-number feedback, coherent loaded values, correct editing/selection after slot reuse, and stable filtered/sorted navigation after session preparation on both platforms.

- [ ] **Step 6: Update evidence and run final diff checks**

```bash
git diff --check
```

Inspect bounded status and source-file diffs. Confirm no generated benchmark database, cache, credentials, absolute paths, or unrelated user changes are staged.

- [ ] **Step 7: Commit final acceptance evidence**

```bash
git add tests/logicalTableNavigation.spec.tsx docs/performance.md docs/troubleshooting.md
git commit -m "test(data): verify 10m row table navigation"
```

Omit `docs/troubleshooting.md` from `git add` when Task 9 did not change it.

---

## Completion Criteria

- The table uses a bounded logical vertical rail and stable viewport slots.
- No production vertical spacer height scales with total rows.
- Natural-order windows use generation metadata plus sparse anchor seek with local offset at most 4095.
- Filtered/sorted windows use a reusable deterministic ordinal query session.
- Obsolete running DuckDB reads are interrupted and only the latest settled target is issued.
- Window payloads contain `_row_id` plus visible requested columns only.
- Cache rows, bytes, sessions, read workers, active requests, and pending targets are all bounded.
- Every mutation and project reset invalidates incompatible anchors, sessions, requests, and cache entries.
- Release measurements meet the 16/50/100/200 ms contracts or the failing slice remains unmerged.
- Windows WebView2 and macOS WKWebView manual acceptance pass.
- Existing table behavior and required repository verification remain green.
# Issue 237 Baseline Test Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `dev` Rust and Playwright component-test baselines without weakening mutation policy, stale-generation fencing, or visual regression coverage.

**Architecture:** Treat the six findings in Issue #237 as independent slices with their own RED/GREEN cycle and commit. Production fixes remain in `DataTableView`; invalid fixtures and platform assets stay test-only. The component-registration symptom is first isolated from concurrent Playwright port/cache collisions before any repository code is changed.

**Tech Stack:** Tauri v2, Rust, React 19, TypeScript, Zustand, Playwright Component Testing, Vite.

**Spec:** GitHub Issue [#237](https://github.com/ashton2914/StatsPlayground/issues/237)

## Global Constraints

- Base and PR target are `origin/dev`; implementation branch is `issue/237-baseline-test-reliability`.
- Preserve command mutation classifications according to actual side effects; do not classify commands merely to satisfy set equality.
- Preserve table stale-generation and request-token fencing.
- Do not use retries, arbitrary waits, larger timeouts, or test weakening.
- Do not commit `.cache/`, `node_modules`, unreviewed generated assets, or investigation artifacts.
- Every production behavior change requires a focused RED before implementation and focused GREEN afterward.
- Keep the six slices independently reviewable and use Conventional Commits with the required Copilot co-author trailer.

---

### Task 1: Restore Graph-new Command Classification Coverage

**Files:**
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Read: `src-tauri/src/commands/graph_new_commands.rs`
- Read: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `command_classes() -> HashMap<&'static str, CommandClass>`
- Produces: one classification entry for every Graph-new command registered in `tauri::generate_handler!`

- [ ] **Step 1: Run the exact coverage test and record RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  commands::mutation_guard_coverage::tests::command_classification_covers_every_registered_handler \
  -- --exact --test-threads=1
```

Expected: FAIL with the four `commands::graph_new_commands::*` handlers present in the registered set but absent from `command_classes()`.

- [ ] **Step 2: Add classifications based on side effects**

Add these exact entries to `command_classes()`:

```rust
(
    "commands::graph_new_commands::probe_graph_new_transport",
    CommandClass::ReadOnly,
),
(
    "commands::graph_new_commands::render_graph_new",
    CommandClass::ReadOnly,
),
(
    "commands::graph_new_commands::cancel_graph_new",
    CommandClass::Mutation,
),
(
    "commands::graph_new_commands::close_graph_new",
    CommandClass::Mutation,
),
```

Rationale: probe/render do not mutate persisted project or dataset state; cancel/close mutate the Graph-new runtime registry/session lifecycle.

- [ ] **Step 3: Run focused GREEN**

Run the Step 1 command.

Expected: PASS, with the registered and classified command sets exactly equal.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mutation_guard_coverage.rs
git commit -m "test(commands): classify graph-new handlers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Reload the First Real DataTable Filter State

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Test: `tests/dataTableCounts.spec.tsx`
- Read: `tests/DataTableCountsHarness.tsx`

**Interfaces:**
- Consumes: `loadedFilterKeyRef`, `buildTableQuerySignature(...)`, `load(filters, start)`
- Produces: exactly one load for the first real filter/sort signature after a dataset-generation load

- [ ] **Step 1: Strengthen the failing test around request count**

Extend `DataTableCountsHarness` telemetry, if not already exposed, so the filtered and zero-match tests can assert that the first filter signature caused a `queryTableWindow` request. Keep the existing displayed-row assertions:

```ts
await expect(component.getByLabel("Status dimensions"))
  .toHaveText("24 / 100 rows × 2 cols");
await expect(component.getByText("Displayed rows").locator(".."))
  .toContainText("24");
```

Add the corresponding zero-match assertion:

```ts
await expect(component.getByLabel("Status dimensions"))
  .toHaveText("0 / 100 rows × 2 cols");
```

- [ ] **Step 2: Run RED**

```bash
PLAYWRIGHT_CT_PORT=3210 npx playwright test -c playwright-ct.config.ts \
  tests/dataTableCounts.spec.tsx \
  --workers=1 \
  --output=.cache/issue237/data-table-counts-red
```

Expected: filtered cases retain `100 / 100 rows × 2 cols`; the first filter request is absent.

- [ ] **Step 3: Replace the one-shot skip flag with signature-based deduplication**

In `DataTableView`, remove the `skipFilterReloadRef` early-return protocol. After the dataset-generation effect calls:

```ts
void load(tableFiltersRef.current, 0);
```

let the filter effect compute the query signature and rely on `loadedFilterKeyRef.current` to suppress only a truly duplicate request:

```ts
const queryKey = buildTableQuerySignature(
  serializeTableWindowFilters(tableFilters),
  tableSort,
);
if (queryKey === loadedFilterKeyRef.current) return;
void invalidateScheduledNavigation({ datasetId, generation: datasetGeneration });
setLogicalStart(0);
void load(tableFilters, 0);
```

Do not add a timeout or a second synthetic filter mutation.

- [ ] **Step 4: Run focused GREEN**

Run the Step 2 command.

Expected: all `dataTableCounts.spec.tsx` tests pass; filtered counts are correct on first render and delayed generation-1 responses cannot overwrite generation 2.

- [ ] **Step 5: Commit**

```bash
git add src/components/DataTableView.tsx tests/DataTableCountsHarness.tsx tests/dataTableCounts.spec.tsx
git commit -m "fix(table): load initial filter state" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Repair the Same-Dataset Property Manager Fixture

**Files:**
- Modify: `tests/DataTableViewPropertyManagerHarness.tsx`
- Test: `tests/e2e/DistributionWorkspace.spec.tsx`
- Test: `tests/tablePropertyManagerRequest.test.ts`

**Interfaces:**
- Consumes: `createTableRenderLoadToken`, `shouldConsumeTablePropertyManagerRequest`
- Produces: a fixture whose V1 and V2 metadata have the same dataset ID and distinct generations

- [ ] **Step 1: Record RED with the current invalid fixture**

```bash
PLAYWRIGHT_CT_PORT=3211 npx playwright test -c playwright-ct.config.ts \
  tests/e2e/DistributionWorkspace.spec.tsx \
  -g "DataTableView waits for refreshed same-dataset data and display props before acknowledging a property-manager request" \
  --workers=1 \
  --output=.cache/issue237/property-manager-red
```

Expected: FAIL because `refresh-load-issued` remains `no`.

- [ ] **Step 2: Correct V2 identity without weakening assertions**

Define V2 with the same stable identity:

```ts
const DATASET_V2: DatasetMeta = {
  ...DATASET_V1,
  generation: 2,
  rowCount: 2,
  updatedAt: "2026-09-14T00:01:00.000Z",
};
```

Keep the mounted prop as `datasetId={DATASET_V1.id}`. Do not change the request ID, request dataset ID, or token-consumption assertions.

- [ ] **Step 3: Run focused GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tablePropertyManagerRequest.test.ts
PLAYWRIGHT_CT_PORT=3211 npx playwright test -c playwright-ct.config.ts \
  tests/e2e/DistributionWorkspace.spec.tsx \
  -g "DataTableView waits for refreshed same-dataset data and display props before acknowledging a property-manager request" \
  --workers=1 \
  --output=.cache/issue237/property-manager-green
```

Expected: refresh data and display-props requests are both issued; the Property Manager request is acknowledged only after both deferred results resolve.

- [ ] **Step 4: Commit**

```bash
git add tests/DataTableViewPropertyManagerHarness.tsx tests/e2e/DistributionWorkspace.spec.tsx tests/tablePropertyManagerRequest.test.ts
git commit -m "test(table): model same-dataset property refresh" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Preserve Calculated Column Drafts Across Generation Changes

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/components/CalculatedColumnDialog.tsx` only if descriptor normalization requires it
- Test: `tests/calculatedColumn.spec.tsx`
- Read: `tests/CalculatedColumnHarness.tsx`

**Interfaces:**
- Consumes: dialog `generation` prop and `generationChanged` reducer action
- Produces: an open dialog whose draft survives generation changes, becomes stale, and requires successful revalidation before Apply

- [ ] **Step 1: Run the two production RED cases individually**

```bash
PLAYWRIGHT_CT_PORT=3212 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  -g "preserves the draft on stale generation" \
  --workers=1 \
  --output=.cache/issue237/calculated-stale-red

PLAYWRIGHT_CT_PORT=3213 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  -g "refreshes calculated descriptors and window state after undo and redo revisions" \
  --workers=1 \
  --output=.cache/issue237/calculated-history-red
```

Expected: stale-generation loses the textbox/dialog; undo/redo fails to present refreshed names/formulas.

- [ ] **Step 2: Stop closing the dialog on generation-only changes**

In the `[datasetGeneration, datasetId, load]` effect, preserve `calculatedDialog` when `datasetId` is unchanged. Continue clearing it when the component switches to a different dataset or when the referenced output column no longer exists.

Use the dialog's existing effect:

```ts
if (editorState.generation !== generation) {
  dispatch({ type: "generationChanged", generation });
  setValidatedKey(null);
  setRequiresRevalidation(true);
}
```

as the stale transition. Do not retain a previous successful validation across generations.

- [ ] **Step 3: Normalize refreshed descriptors without replacing the draft**

After refreshed descriptors arrive, map dependency IDs to their new names when displaying a persisted formula. Keep the user's current draft text unchanged until the user explicitly reloads or edits it; the stale state must block Apply until validation at the new generation succeeds.

- [ ] **Step 4: Run focused GREEN**

Run the two Step 1 commands, then:

```bash
PLAYWRIGHT_CT_PORT=3214 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  -g "normalizes renamed source columns|preserves the draft on stale generation|refreshes calculated descriptors" \
  --workers=1 \
  --output=.cache/issue237/calculated-focused-green
```

Expected: all three cases pass in one isolated CT invocation.

- [ ] **Step 5: Commit**

```bash
git add src/components/DataTableView.tsx src/components/CalculatedColumnDialog.tsx tests/calculatedColumn.spec.tsx
git commit -m "fix(table): preserve calculated drafts on refresh" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Isolate Playwright CT Runner State

**Files:**
- Modify only if evidence requires it: `playwright-ct.config.ts`
- Modify only if evidence requires it: repository test scripts or CI workflow that launches CT
- Test: `tests/calculatedColumn.spec.tsx`

**Interfaces:**
- Consumes: `PLAYWRIGHT_CT_PORT`, Playwright CT Vite cache/output paths
- Produces: repeatable single-run and concurrent-run behavior without component registration collisions

- [ ] **Step 1: Run a clean single-process control**

```bash
rm -rf .cache/issue237/ct-control
PLAYWRIGHT_CT_PORT=3220 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  -g "normalizes renamed source columns|preserves the draft on stale generation|refreshes calculated descriptors" \
  --workers=1 \
  --repeat-each=3 \
  --output=.cache/issue237/ct-control
```

Expected after Task 4: no `Unregistered component` error and no dev-server disconnect.

- [ ] **Step 2: Test the collision hypothesis**

Launch two CT commands concurrently only in separate shell sessions:

```bash
PLAYWRIGHT_CT_PORT=3221 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx -g "normalizes renamed source columns" \
  --output=.cache/issue237/ct-a
```

```bash
PLAYWRIGHT_CT_PORT=3222 npx playwright test -c playwright-ct.config.ts \
  tests/dataTableCounts.spec.tsx \
  --output=.cache/issue237/ct-b
```

Expected: both pass when ports and output directories are unique.

- [ ] **Step 3: Apply only the evidence-backed infrastructure fix**

If the control passes and only shared-port/shared-output runs fail, update repository scripts/CI callers so concurrent CT invocations must provide unique `PLAYWRIGHT_CT_PORT` and `--output` values; do not change component code. If the clean control still fails, capture the first `Unregistered component` stack and fix the component registration/import boundary it names before proceeding.

- [ ] **Step 4: Verify no masking**

```bash
PLAYWRIGHT_CT_PORT=3223 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  --workers=1 \
  --repeat-each=2 \
  --output=.cache/issue237/calculated-repeat
```

Expected: PASS without retries, timeout changes, or dev-server reconnect logic.

- [ ] **Step 5: Commit only if repository files changed**

```bash
git add playwright-ct.config.ts package.json .github/workflows
git commit -m "test(ct): isolate component test runners" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no repository change is needed, add a verified comment to Issue #237 explaining that the symptom came from simultaneous investigation commands sharing CT runtime state, and create no empty commit.

---

### Task 6: Add the Reviewed macOS Workflow Snapshot

**Files:**
- Create: `tests/e2e/WorkflowView.spec.tsx-snapshots/workflow-view-darwin.png`
- Read: `tests/e2e/WorkflowView.spec.tsx`
- Compare: `tests/e2e/WorkflowView.spec.tsx-snapshots/workflow-view-win32.png`

**Interfaces:**
- Consumes: Playwright's default platform-specific snapshot naming
- Produces: reviewed Windows and macOS baselines for the same deterministic workflow fixture

- [ ] **Step 1: Record RED and generate the candidate**

```bash
PLAYWRIGHT_CT_PORT=3230 npx playwright test -c playwright-ct.config.ts \
  tests/e2e/WorkflowView.spec.tsx \
  -g "renders workflow navigation and connected nodes" \
  --workers=1 \
  --output=.cache/issue237/workflow-red
```

Expected: FAIL because `workflow-view-darwin.png` is absent; Playwright writes the candidate.

- [ ] **Step 2: Review the generated image**

Open the generated `workflow-view-darwin.png` and confirm:

- heading is `Analyze yield`;
- dataset option is `Current measurements`;
- two workflow nodes and one connecting path are visible;
- no clipping, blank region, error UI, or missing font/icon appears;
- differences from `workflow-view-win32.png` are limited to platform text rasterization/layout.

- [ ] **Step 3: Run GREEN**

```bash
PLAYWRIGHT_CT_PORT=3230 npx playwright test -c playwright-ct.config.ts \
  tests/e2e/WorkflowView.spec.tsx \
  -g "renders workflow navigation and connected nodes" \
  --workers=1 \
  --output=.cache/issue237/workflow-green
```

Expected: PASS without `--update-snapshots`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/WorkflowView.spec.tsx-snapshots/workflow-view-darwin.png
git commit -m "test(workflow): add macOS visual baseline" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Run Integrated Gates and Independent Review

**Files:**
- Verify: all files changed by Tasks 1-6
- Update: Issue #237 with any Task 5 diagnostic ruling

**Interfaces:**
- Consumes: all task commits
- Produces: a reviewable branch with full baseline evidence

- [ ] **Step 1: Run focused aggregate gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  commands::mutation_guard_coverage::tests::command_classification_covers_every_registered_handler \
  -- --exact --test-threads=1

npx tsx --tsconfig tsconfig.app.json tests/tablePropertyManagerRequest.test.ts

PLAYWRIGHT_CT_PORT=3240 npx playwright test -c playwright-ct.config.ts \
  tests/calculatedColumn.spec.tsx \
  tests/dataTableCounts.spec.tsx \
  tests/e2e/DistributionWorkspace.spec.tsx \
  tests/e2e/WorkflowView.spec.tsx \
  --workers=1 \
  --output=.cache/issue237/focused-final
```

Expected: all pass.

- [ ] **Step 2: Run full repository gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
PLAYWRIGHT_CT_PORT=3241 npx playwright test -c playwright-ct.config.ts \
  --output=.cache/issue237/full-ct
npx tsc -b
npx vite build
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
git diff --check origin/dev...HEAD
```

Expected: zero failures. Existing compiler warnings may remain but no new warning may be introduced by Issue #237.

- [ ] **Step 3: Inspect status and diff**

```bash
git status --short --branch
git diff --stat origin/dev...HEAD
git diff --name-only origin/dev...HEAD
```

Expected: only Issue #237 source, tests, plan, and reviewed snapshot are tracked; `.cache/` and `node_modules` remain untracked/ignored and unstaged.

- [ ] **Step 4: Request independent review**

Provide the reviewer:

- Issue #237 URL;
- base SHA `1245f9213f900d77da57af4a8e691d8b5fcc5d43`;
- all task commits;
- full diff including untracked status;
- focused and full verification output;
- explicit focus on filter-load deduplication, dialog stale fencing, Graph-new command classes, and test-only fixture correctness.

Fix all Critical/Important findings and rerun the affected gates.

- [ ] **Step 5: Prepare manual acceptance**

Launch the app from this worktree and ask the user to verify:

1. first application of a table filter immediately updates displayed rows;
2. an open Calculated Column draft survives a generation-changing refresh and requires revalidation;
3. undo/redo refreshes renamed dependency labels/formulas;
4. Table Property Manager opens only after refreshed table data and display props are ready.

Stop after requesting manual acceptance. Do not push or create a PR until the user explicitly accepts.

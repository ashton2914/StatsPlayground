# Dataset-Global Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every dataset one authoritative Filter shared by its Table and all standalone Graph Builders, persisted in `.spprj`, with deterministic migration from legacy graph-local filters.

**Architecture:** A Zustand store owns `datasetId -> FilterRuleItem[]` at runtime. Table and standalone Graph Builder views subscribe to that store, while a separate `GraphRuntimeItem` type preserves frozen filters only for embedded Analysis graphs. The project manifest becomes the persisted authority; Rust validates current payloads and migrates legacy `.spgh` filters during open.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, Node `tsx` contract tests, Playwright Component Testing, Tauri v2, Rust, Serde, ZIP `.spprj` archives.

**Spec:** `docs/superpowers/specs/2026-09-14-dataset-global-filter-design.md`

## Global Constraints

- One dataset has exactly one live Filter authority; standalone graph-local Filter divergence is not supported.
- `GraphBuilderItem` and new standalone `.spgh` exports must not persist `filters`.
- `EmbeddedGraphConfig` retains frozen `filters` for Analysis graphs and must not subscribe to the dataset store.
- Canonical no-filter state is `[]`; empty entries are omitted from persisted `datasetFilters`.
- Conflicting legacy Graph filters resolve to `[]`, return one conflict dataset ID, warn the user, and mark the project dirty.
- Different dataset IDs remain isolated.
- Filter mutation is blocked while the project is read-only and marks the project dirty only after a real change.
- Invalid persisted Filter payloads fail project open before any query reaches DuckDB.
- Preserve existing filter predicate, SQL serialization, categorical exclusion, and graph sampling behavior.
- Follow the Analysis development gate because `Workspace.tsx` and `spprj_archive.rs` are touched; embedded Analysis behavior must remain unchanged.
- Work only in `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/fix-issue-198-dataset-filters` on `fix/issue-198-dataset-filters`.
- Do not commit, push, or create a pull request before explicit manual acceptance, even though ordinary TDD plans often commit after each task.

---

## File Structure

**Create**

- `src/stores/useDatasetFilterStore.ts`: dataset-keyed runtime authority, immutable cloning, lifecycle actions, and canonical persisted snapshot.
- `tests/datasetFilterStore.test.ts`: store independence, no-op detection, read-only rejection, rename, load, delete, reset, and persistence pruning.
- `tests/datasetFilterViews.test.ts`: Table/standalone Graph ownership and request propagation contracts, including Analysis boundary protection.
- `tests/workspaceDatasetFilters.test.ts`: save/open/close/delete/rename/migration-warning Workspace contracts.

**Modify**

- `src/types/graphBuilder.ts`: remove `filters` from standalone `GraphBuilderItem`; introduce `GraphRuntimeItem`; retain filters on `EmbeddedGraphConfig`.
- `src/components/graphBuilder/graphBuilderMode.ts`: strip legacy filters from normalized standalone items while preserving them for embedded runtime items.
- `src/components/graphBuilder/GraphRuntime.tsx`: accept `GraphRuntimeItem` so embedded filters remain legal.
- `src/components/graphBuilder/useGraphDataPipeline.ts`: derive requests from `GraphRuntimeItem`; no semantic filter change.
- `src/components/graphBuilder/GraphBuilderView.tsx`: subscribe by `dataset.id`, edit the dataset Filter, and pass an injected runtime item to `GraphRuntime`.
- `src/components/DataTableView.tsx`: replace local Filter state/reset with the dataset store and keep panel layout local.
- `src/components/Workspace.tsx`: save/load/reset/delete/rename lifecycle, conflict toast, and migration dirty state.
- `src/services/projectService.ts`: add typed `datasetFilters` to save IPC.
- `src/types/project.ts`: add restored filters and migration conflicts to open IPC.
- `src-tauri/src/models/save.rs`: carry typed project Filter maps into the save snapshot.
- `src-tauri/src/services/streaming_project_writer.rs`: write the Filter map into `ProjectManifest`.
- `src-tauri/src/services/project_service.rs`: return restored filters/conflicts and fold conflict migration into `requires_migration`.
- `src-tauri/src/services/spprj_archive.rs`: persisted Filter models, validation, manifest field, and legacy graph migration.
- `src/i18n/locales/en.ts` and every sibling locale module found beside it: localized legacy conflict warning with dataset display names.
- Existing tests whose `GraphBuilderItem` fixtures intentionally model standalone graphs: remove their graph-local `filters`; embedded fixtures remain unchanged.

---

### Task 1: Dataset Filter Store

**Files:**
- Create: `src/stores/useDatasetFilterStore.ts`
- Create: `tests/datasetFilterStore.test.ts`

**Interfaces:**
- Produces: `DatasetFilterMap = Record<string, FilterRuleItem[]>`
- Produces: `createDatasetFilterStore(): StoreApi<DatasetFilterState>` for isolated tests.
- Produces: `useDatasetFilterStore` for React and imperative Workspace access.
- Produces actions:

```ts
interface DatasetFilterState {
  byDataset: DatasetFilterMap;
  replaceFilters(datasetId: string, filters: readonly FilterRuleItem[]): boolean;
  removeDataset(datasetId: string): boolean;
  renameColumn(datasetId: string, oldName: string, newName: string): boolean;
  loadFromProject(filters: DatasetFilterMap): void;
  reset(): void;
  toProjectPayload(): DatasetFilterMap;
}
```

- [ ] **Step 1: Write the failing store tests**

Cover independent datasets, immutable input cloning, no-op replacement, deletion isolation, column rename, complete load replacement, reset, empty-entry omission, and read-only rejection.

```ts
const store = createDatasetFilterStore();
store.getState().replaceFilters("table-a", [continuousRule("flt-a", "Length", 1, 5)]);
store.getState().replaceFilters("table-b", [categoricalRule("flt-b", "Build", ["DV"])]);

assert.deepEqual(store.getState().byDataset["table-a"], [
  continuousRule("flt-a", "Length", 1, 5),
]);
assert.deepEqual(store.getState().byDataset["table-b"], [
  categoricalRule("flt-b", "Build", ["DV"]),
]);
assert.equal(store.getState().replaceFilters("table-a", store.getState().byDataset["table-a"]), false);
assert.deepEqual(store.getState().toProjectPayload(), {
  "table-a": [continuousRule("flt-a", "Length", 1, 5)],
  "table-b": [categoricalRule("flt-b", "Build", ["DV"])],
});
```

For read-only, set `useProjectStore.setState({ readOnly: true })`, call `replaceFilters`, and assert the established `assertProjectMutable` error. Restore project-store state in `finally`.

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterStore.test.ts
```

Expected: FAIL because `createDatasetFilterStore` and `useDatasetFilterStore` do not exist.

- [ ] **Step 3: Implement the minimal store**

Use `createStore` plus `create`/`useStore` in the same style as existing Zustand stores. Clone rule arrays and nested `field`/value arrays at the store boundary. Compare complete arrays structurally before changing state, so identical `FilterPanel` emissions return `false`.

```ts
export type DatasetFilterMap = Record<string, FilterRuleItem[]>;

export function createDatasetFilterStore() {
  return createStore<DatasetFilterState>((set, get) => ({
    byDataset: {},
    replaceFilters: (datasetId, filters) => {
      assertProjectMutable(useProjectStore.getState().readOnly);
      const next = cloneFilters(filters);
      const current = get().byDataset[datasetId] ?? [];
      if (filtersEqual(current, next)) return false;
      set((state) => {
        const byDataset = { ...state.byDataset };
        if (next.length === 0) delete byDataset[datasetId];
        else byDataset[datasetId] = next;
        return { byDataset };
      });
      return true;
    },
    // removeDataset, renameColumn, loadFromProject, reset, toProjectPayload
  }));
}
```

`renameColumn` changes only `rule.field.name === oldName`, retains `columnId`, type, values, op, ID, and height, and returns whether anything changed.

- [ ] **Step 4: Run the store test and verify GREEN**

Run the same command. Expected: PASS with a single success line and exit code 0.

- [ ] **Step 5: Checkpoint without committing**

Run:

```bash
git --no-pager diff --no-ext-diff --check -- src/stores/useDatasetFilterStore.ts tests/datasetFilterStore.test.ts
```

Expected: exit code 0. Keep changes uncommitted until manual acceptance.

---

### Task 2: Separate Standalone Graph Persistence From Runtime Filters

**Files:**
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/components/graphBuilder/graphBuilderMode.ts`
- Modify: `src/components/graphBuilder/GraphRuntime.tsx`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `tests/graphDataPipeline.test.ts`
- Modify: relevant embedded graph tests such as `tests/graphRuntime.test.ts` and `tests/distributionGraphEmbedding.test.ts`

**Interfaces:**
- Consumes: `FilterRuleItem[]` from Task 1.
- Produces:

```ts
export interface GraphBuilderItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  mode: GraphBuilderMode;
  modeStates: GraphModeStates;
  sampling?: GraphSampling;
  groupThemeSlots?: GroupThemeSlots;
  createdAt: string;
}

export type GraphRuntimeItem = GraphBuilderItem & {
  filters?: FilterRuleItem[];
};

export type EmbeddedGraphConfig = Pick<
  GraphBuilderItem,
  "mode" | "modeStates" | "sampling" | "groupThemeSlots"
> & { filters?: FilterRuleItem[] };
```

- Produces: `normalizeGraphBuilderItem(input): GraphBuilderItem`, always stripping legacy `filters`.
- Produces: `createEmbeddedGraphItem(input): GraphRuntimeItem`, preserving cloned embedded filters.

- [ ] **Step 1: Add failing type/runtime boundary tests**

Add assertions that:

1. Normalizing a standalone legacy item with `filters` returns no own `filters` property.
2. Creating an embedded item preserves a cloned frozen Filter.
3. `deriveGraphRequestParts()` still serializes runtime filters and includes their fields.
4. A TypeScript fixture cannot assign `filters` to `GraphBuilderItem`, while it can assign them to `GraphRuntimeItem` and `EmbeddedGraphConfig`.

```ts
const normalized = normalizeGraphBuilderItem({ ...legacyGraph, filters: [rule] });
assert.equal(Object.hasOwn(normalized, "filters"), false);

const embedded = createEmbeddedGraphItem({
  id: "analysis-graph:1",
  name: "Frozen",
  sourceDatasetId: "table-a",
  config: { ...config, filters: [rule] },
  createdAt: new Date(0).toISOString(),
});
assert.deepEqual(embedded.filters, [rule]);
assert.notEqual(embedded.filters, config.filters);
```

- [ ] **Step 2: Run the narrow graph tests and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npx tsc -p tests/tsconfig.analysis-typecheck.json
```

Expected: at least the standalone normalization assertion fails because current `GraphBuilderItem` retains `filters`.

- [ ] **Step 3: Implement the type split and normalization boundary**

Remove the property from `GraphBuilderItem`. In `normalizeGraphBuilderItem`, do not spread or copy `filters`. In `createEmbeddedGraphItem`, capture `input.config.filters`, normalize the standalone base, then return a `GraphRuntimeItem` with a cloned `filters` property only when the embedded config supplied one.

Change `GraphRuntimeProps.item`, `useGraphDataPipeline(item, ...)`, `deriveFields(item)`, and `deriveGraphRequestParts(item)` to consume `GraphRuntimeItem`. Do not alter serialization order or operator semantics.

- [ ] **Step 4: Run graph tests and verify GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionGraphEmbedding.test.ts
npx tsc -p tests/tsconfig.analysis-typecheck.json
```

Expected: all commands exit 0; embedded Analysis filters remain accepted.

- [ ] **Step 5: Checkpoint without committing**

Run scoped `git diff --check` for the touched files. Keep changes uncommitted.

---

### Task 3: Connect Table And Standalone Graph Views To One Dataset Filter

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Create: `tests/datasetFilterViews.test.ts`
- Modify: `tests/tableViewport.test.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: `useDatasetFilterStore`, `GraphRuntimeItem`.
- Produces: both Filter panels read `byDataset[datasetId] ?? []` and call `replaceFilters(datasetId, next)`.
- Produces: standalone Graph runtime item equals `{ ...item, filters }` only in memory.

- [ ] **Step 1: Write failing ownership and propagation tests**

The test must prove behavior, not only symbol presence:

1. Seed one dataset Filter, remount a lightweight store consumer, and verify it observes the same array.
2. Create two standalone Graph runtime items from the same dataset Filter and assert `deriveGraphRequestParts()` produces identical filters and filter fields.
3. Replace from the second consumer and assert Table serialization plus both Graph requests change.
4. A Graph for another dataset remains unchanged.
5. Source-contract assertions reject `useState<FilterRuleItem[]>` and `setTableFilters([])` in `DataTableView`, reject `updateItem(item.id, { filters` in `GraphBuilderView`, and require the dataset store subscription in both files.

```ts
const shared = store.getState().byDataset["table-a"] ?? [];
const graphOne = deriveGraphRequestParts({ ...graphBase("g1", "table-a"), filters: shared });
const graphTwo = deriveGraphRequestParts({ ...graphBase("g2", "table-a"), filters: shared });
assert.deepEqual(graphOne.filters, graphTwo.filters);
assert.deepEqual(
  serializeTableWindowFilters(shared).map((entry) => entry.rule),
  graphOne.filters.map((entry) => entry.rule),
);
```

- [ ] **Step 2: Run the view contract and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterViews.test.ts
```

Expected: FAIL because both views still own local/graph-item filters.

- [ ] **Step 3: Replace `DataTableView` local Filter ownership**

Subscribe by dataset ID:

```ts
const tableFilters = useDatasetFilterStore(
  (state) => state.byDataset[datasetId] ?? EMPTY_FILTERS,
);
const replaceDatasetFilters = useDatasetFilterStore((state) => state.replaceFilters);
const handleTableFiltersChange = useCallback((next: FilterRuleItem[]) => {
  if (readOnly) return;
  if (replaceDatasetFilters(datasetId, next)) markDirty();
}, [datasetId, markDirty, readOnly, replaceDatasetFilters]);
```

Use a module-level frozen `EMPTY_FILTERS` to avoid a new-array selector result. Keep `tableFiltersRef` synchronized for async loading, but delete mount-time Filter clearing and load the current dataset rules when `datasetId` changes. Preserve `showTableFilters` and `tableFilterWidth` as local state.

- [ ] **Step 4: Replace `GraphBuilderView` graph-item ownership**

Subscribe using `dataset.id`, wrap replacement with the same read-only/no-op dirty rules, and create an in-memory runtime item:

```ts
const filters = useDatasetFilterStore(
  (state) => state.byDataset[dataset.id] ?? EMPTY_FILTERS,
);
const runtimeItem = useMemo<GraphRuntimeItem>(
  () => ({ ...item, filters }),
  [filters, item],
);
```

Pass `runtimeItem` to `GraphRuntime`; pass `filters` and the dataset action to `FilterPanel`. Do not call `updateItem` for Filter changes.

- [ ] **Step 5: Run focused Table/Graph validation and verify GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterViews.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npx tsx --tsconfig tsconfig.app.json tests/filterExclusion.test.ts
```

Expected: all pass. The viewport test must still show reload at row zero after a Filter identity change.

- [ ] **Step 6: Checkpoint without committing**

Run scoped `git diff --check`. Keep changes uncommitted.

---

### Task 4: Wire Project And Dataset Lifecycle In Workspace

**Files:**
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Modify: `src/components/Workspace.tsx`
- Create: `tests/workspaceDatasetFilters.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: `DatasetFilterMap`, store actions from Task 1.
- Produces save field: `datasetFilters: DatasetFilterMap`.
- Produces open fields:

```ts
datasetFilters: DatasetFilterMap;
datasetFilterMigrationConflicts: string[];
```

- [ ] **Step 1: Write failing Workspace lifecycle contracts**

Extract the relevant handler bodies using the existing `extractFunctionBody` test pattern and assert:

- save calls `useDatasetFilterStore.getState().toProjectPayload()` at invocation time;
- open resets then loads `result.datasetFilters` before graph/project views are restored;
- close resets the store;
- successful dataset deletion removes only that dataset's Filter;
- column rename calls `renameColumn(activeDatasetId, oldName, newName)`;
- conflict IDs resolve to dataset display names, show a localized toast, and participate in migration dirty state.

Also update the save-lifecycle fixture so the exact `datasetFilters` payload survives `useProjectStore.saveProject()` unchanged.

- [ ] **Step 2: Run the Workspace test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceDatasetFilters.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: the first command fails on missing lifecycle calls; the second initially fails after making `datasetFilters` required in `SaveProjectRequest` until fixtures are updated.

- [ ] **Step 3: Add typed IPC fields**

Import `DatasetFilterMap` as a type in `projectService.ts` and `project.ts`. Add required empty-map defaults to every test/open fixture rather than making current results ambiguous.

- [ ] **Step 4: Implement Workspace lifecycle**

Use imperative state at save time:

```ts
const datasetFilters = useDatasetFilterStore.getState().toProjectPayload();
await saveProject({
  // existing fields
  datasetFilters,
});
```

At open, call `reset()` before project restoration and `loadFromProject(result.datasetFilters)` before graph items can render. At close/reset call `reset()`. After successful dataset deletion call `removeDataset(id)`. In `onColumnRenamed`, call `renameColumn` alongside existing graph/analysis field migration and rely on the table mutation's existing dirty mark rather than marking twice.

Conflict handling must reuse the established migration flow: `result.requiresMigration` marks dirty, while a non-empty `datasetFilterMigrationConflicts` adds the localized toast after names are available.

- [ ] **Step 5: Run Workspace and save lifecycle tests and verify GREEN**

Run the two Step 2 commands plus:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceRenameFailure.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisLifecycle.test.ts
```

Expected: all exit 0.

- [ ] **Step 6: Checkpoint without committing**

Run scoped `git diff --check`. Keep changes uncommitted.

---

### Task 5: Persist And Validate Dataset Filters In `.spprj`

**Files:**
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes camelCase JSON matching `FilterRuleItem`.
- Produces Rust models:

```rust
pub type DatasetFilters = HashMap<String, Vec<ProjectFilterRuleItem>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilterRuleItem {
    pub id: String,
    pub op: ProjectFilterOp,
    pub rule: ProjectFilterRule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectFilterRule {
    Continuous { field: ProjectFilterField, min: Option<f64>, max: Option<f64> },
    Categorical {
        field: ProjectFilterField,
        selected: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        exclude: bool,
    },
    Date { field: ProjectFilterField, start: Option<String>, end: Option<String> },
}
```

`ProjectFilterField.field_type` must serialize as `type` and accept only `continuous | nominal | ordinal | datetime | id`; names and IDs must be non-empty, operators only `AND | OR`, numeric values finite, height finite and positive, and date strings non-empty when present.

- [ ] **Step 1: Add failing Rust archive tests**

Add focused tests in `spprj_archive.rs` for:

1. manifest save/read round-trip of continuous, categorical exclusion, and date rules;
2. missing `datasetFilters` deserializing to an empty map;
3. empty dataset entries not being written;
4. invalid field name/type, operator, NaN/infinite bound, non-positive height, and wrong rule value shape returning the established invalid archive `AppError` before table import.

Use `serde_json::json!` fixtures and inspect `manifest.json` from the in-memory/archive helper already used by neighboring tests.

- [ ] **Step 2: Run one new Rust test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::dataset_filters_round_trip -- --exact
```

Expected: compile/test failure because `ProjectManifest.dataset_filters` does not exist.

- [ ] **Step 3: Add typed models and validation**

Place the project Filter model beside `ProjectManifest` in `spprj_archive.rs`. Add:

```rust
#[serde(default, skip_serializing_if = "HashMap::is_empty")]
pub dataset_filters: DatasetFilters,
```

Centralize `validate_dataset_filters(&DatasetFilters) -> Result<(), AppError>` and call it from the established archive manifest/entry validation path. Return the same invalid-archive error category and path-safe context used by neighboring validators.

Canonicalize save input by removing empty arrays before constructing the manifest.

- [ ] **Step 4: Carry the field through save/open**

Add `dataset_filters` with `#[serde(default)]` to `SaveProjectRequest`; because `SaveSnapshot` owns the request, no duplicate snapshot field is needed. Pass the map through `StreamingProjectWriter` into `ProjectManifest`, and return `bundle.manifest.dataset_filters.clone()` in `OpenProjectResult`.

Update every direct `ProjectManifest { ... }` and `OpenProjectResult { ... }` construction with an empty/default field. Prefer `Default` helper use only if already established; do not hide unrelated required fields.

- [ ] **Step 5: Run focused Rust tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::dataset_filters_round_trip -- --exact
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::manifest_without_dataset_filters_opens_empty -- --exact
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::invalid_dataset_filters_are_rejected -- --exact
```

Expected: all pass with exit code 0.

- [ ] **Step 6: Checkpoint without committing**

Format only touched Rust files using scoped `rustfmt` invocation supported by the repo, inspect the touched-file diff stat first, then run scoped `git diff --check`. Keep changes uncommitted.

---

### Task 6: Migrate Legacy Graph Filters And Surface Conflicts

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src/components/Workspace.tsx`
- Modify: all locale modules under `src/i18n/locales/`
- Modify: `tests/workspaceDatasetFilters.test.ts`

**Interfaces:**
- Produces:

```rust
pub struct DatasetFilterMigration {
    pub dataset_filters: DatasetFilters,
    pub conflicts: Vec<String>,
    pub changed: bool,
}

pub fn migrate_legacy_graph_filters(
    manifest_filters: &DatasetFilters,
    graphs: &mut [GraphDoc],
) -> Result<DatasetFilterMigration, AppError>;
```

- Produces open result field `dataset_filter_migration_conflicts: Vec<String>`.

- [ ] **Step 1: Add failing migration matrix tests**

Build graph docs with `sourceDatasetId` and complete `filters` arrays. Cover:

- one graph with non-empty filters adopts that array;
- one graph with `[]` resolves to no persisted map entry but removes the legacy property;
- multiple exact arrays adopt once;
- differing arrays, including empty versus non-empty, resolve to canonical `[]` and one conflict ID;
- datasets with current manifest authority keep it and only strip obsolete graph fields;
- different datasets migrate independently;
- all migrated graph bodies lose `filters`;
- order, op, ID, field identity, selected values, exclusion, and height participate in equality.

```rust
let migrated = migrate_legacy_graph_filters(&HashMap::new(), &mut graphs)?;
assert_eq!(migrated.conflicts, vec!["table-a"]);
assert!(!migrated.dataset_filters.contains_key("table-a"));
assert!(graphs.iter().all(|graph| !graph.body.contains_key("filters")));
```

- [ ] **Step 2: Run a conflict test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::conflicting_legacy_graph_filters_clear_dataset -- --exact
```

Expected: FAIL because the migration function and conflict field do not exist.

- [ ] **Step 3: Implement deterministic migration**

For each graph, remove `filters` from its body after validating it as an array of typed rules. Group complete arrays by non-empty `sourceDatasetId`. If the manifest already has a non-empty authority for that dataset, keep it. Otherwise apply the three mutually exclusive spec cases. Sort and deduplicate conflict IDs for deterministic IPC.

Call migration in `ProjectService::open_project` after archive validation/read and before building the frontend graph list. Set:

```rust
let requires_migration = requires_archive_migration(&bundle.manifest.version)
    || graph_requires_migration
    || filter_migration.changed;
```

Return the migrated mapping and conflict list.

- [ ] **Step 4: Add localized warning**

Add one leaf key with equivalent meaning in every locale: conflicting legacy Graph filters for the named datasets were cleared and the project needs to be saved. Reuse the locale parity test pattern. In Workspace, resolve IDs against refreshed dataset metadata; fall back to IDs only when a display name is unavailable, and never display filesystem paths.

- [ ] **Step 5: Run migration and Workspace tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::legacy_graph_filters_migrate -- --exact
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive::tests::conflicting_legacy_graph_filters_clear_dataset -- --exact
npx tsx --tsconfig tsconfig.app.json tests/workspaceDatasetFilters.test.ts
npx tsx --tsconfig tsconfig.app.json tests/localeParity.test.ts
```

If the locale parity test has a different existing filename, use the actual parity test identified under `tests/*Locale*.test.ts` and record that exact command in the task ledger before execution.

- [ ] **Step 6: Checkpoint without committing**

Run scoped `git diff --check`. Keep changes uncommitted.

---

### Task 7: Standalone Import/Export And Analysis Regression Boundary

**Files:**
- Modify: graph import/export helpers identified from `Workspace.tsx` and `useGraphBuilderStore.ts`
- Modify: `tests/graphDataPipeline.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/distributionGraphEmbedding.test.ts`
- Modify: `tests/workspaceDatasetFilters.test.ts`

**Interfaces:**
- Consumes: standalone `GraphBuilderItem` without filters and embedded `GraphRuntimeItem` with optional frozen filters.
- Produces: imported legacy standalone graph is normalized without mutating the destination dataset Filter.
- Produces: exported standalone graph has no `filters` property.

- [ ] **Step 1: Add failing import/export boundary tests**

Assert that:

- exporting a standalone graph built from the current dataset Filter omits `filters`;
- importing a legacy `.spgh` body containing `filters` strips it and leaves `useDatasetFilterStore` unchanged;
- deleting a Graph does not delete its dataset Filter;
- creating another Graph for the dataset immediately uses the existing dataset Filter;
- an embedded Distribution/Analysis graph retains its frozen Filter and does not read from `useDatasetFilterStore`.

- [ ] **Step 2: Run the narrow tests and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceDatasetFilters.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionGraphEmbedding.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
```

Expected: the new standalone import/export assertions fail until normalization is used at every boundary.

- [ ] **Step 3: Normalize standalone boundaries**

Route project load, standalone import, store insertion, and export through `normalizeGraphBuilderItem`. Never pass `runtimeItem` to persistence APIs. Do not import `useDatasetFilterStore` into Analysis adapters, Distribution presentation, or embedded graph factories.

- [ ] **Step 4: Run focused regressions and verify GREEN**

Run the Step 2 commands plus:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
```

Expected: all pass.

- [ ] **Step 5: Checkpoint without committing**

Run scoped `git diff --check`. Keep changes uncommitted.

---

### Task 8: Full Verification, Independent Review, And Manual Acceptance

**Files:**
- Modify only files required to repair findings attributable to Tasks 1-7.
- Update this plan's checkboxes and validation notes as tasks complete.

**Interfaces:**
- Consumes the complete uncommitted Issue #198 implementation.
- Produces verification evidence and a runnable Tauri acceptance build; no commit/PR yet.

- [ ] **Step 1: Run the complete focused frontend set**

```bash
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterViews.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceDatasetFilters.test.ts
npx tsx --tsconfig tsconfig.app.json tests/filterExclusion.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: every command exits 0.

- [ ] **Step 2: Run required Analysis and production frontend gates**

```bash
npm run test:analysis
npm run build
```

Expected: Analysis contracts/typecheck/UI pass; `tsc -b && vite build` exits 0.

- [ ] **Step 3: Run backend gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

Expected: zero failed Rust tests and zero Clippy warnings.

- [ ] **Step 4: Inspect intended scope**

Run:

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat
git --no-pager diff --no-ext-diff --check
```

Then inspect content diffs only for the named source/test/docs files, excluding dependency locks and generated outputs. Expected: no unrelated files, secrets, caches, or generated artifacts.

- [ ] **Step 5: Dispatch independent review**

Give the reviewer Issue #198 acceptance criteria, the approved spec, base SHA `f594fbc`, current uncommitted diff, and explicit focus on:

- accidental second Filter authority;
- standalone versus embedded graph boundary;
- read-only and dirty semantics;
- migration determinism and validation bypasses;
- project lifecycle ordering;
- missing Analysis/archive regressions.

Repair every Critical or Important finding with a new RED/GREEN cycle, rerun affected focused tests, then repeat review if behavior or architecture changes.

- [ ] **Step 6: Start the exact worktree's Tauri app**

Run with worktree binding:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/fix-issue-198-dataset-filters run tauri -- dev
```

Verify the frontend source path, Vite port, Rust executable path, and running process all belong to this worktree before presenting it.

- [ ] **Step 7: Give the manual acceptance checklist and stop at the gate**

Ask the user to verify:

1. Add a Table Filter, switch to Graph and back, and confirm it remains displayed/applied.
2. Open two Graph Builders for one dataset; edit Filter from each view and confirm Table plus both Graphs update immediately.
3. Confirm a second dataset is unaffected.
4. Save, close, reopen, and confirm the Filter restores.
5. During save/read-only state, confirm Filter controls cannot mutate project state.
6. Open a prepared conflicting legacy project and confirm only conflicted dataset Filters clear, a warning appears, and the project is dirty.
7. Confirm an embedded Analysis graph still renders with its frozen configuration.

Do not commit, push, or create the pull request until the user explicitly reports manual acceptance.

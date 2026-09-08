# Fit Y by X Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Fit Y by X analysis for one continuous response and one categorical factor, rendered through a reusable Graph Builder runtime.

**Architecture:** A dedicated Fit Y by X document owns analysis semantics and a canonical embedded Graph Builder configuration. Pure factories materialize that configuration as a current `GraphBuilderItem`; both interactive Graph Builder and Fit Y by X mount the same extracted read-only runtime. Fit Y by X documents and folder assignments persist inline in the project manifest.

**Tech Stack:** React 19, TypeScript, Zustand, ECharts/Graph Core, Tauri v2, Rust, serde, existing esbuild-based Node tests.

**Spec:** `docs/superpowers/specs/2026-08-30-issue-71-fit-y-by-x-design.md` (Approved)

## Global Constraints

- First release accepts exactly one continuous `Y, Response` and one nominal or ordinal `X, Factor`.
- Points and Box Plot are enabled by default and use full-data sampling.
- Fit Y by X must use Graph Builder's normalization, request pipeline, Graph Core transforms, loading states, and renderer.
- Do not register an embedded analysis graph in `useGraphBuilderStore` or show a duplicate graph document.
- Do not add inferential statistics, new ECharts transforms, or new Rust graph-data commands.
- Persist `fitYByX` and `fitYByXFolders` in `manifest.json` with backward-compatible serde defaults.
- All new user-facing strings must be present in `en.json`, `zh-CN.json`, `zh-TW.json`, and `vi.json`.
- Follow red-green-refactor: every production behavior begins with a test that fails for the expected missing behavior.
- Do not stage the line-ending-only `src-tauri/gen/schemas/*.json` status entries.

---

### Task 1: Analysis Types, Role Validation, And Embedded Graph Factory

**Files:**
- Create: `src/types/fitYByX.ts`
- Create: `src/components/fitYByX/fitYByXConfig.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/types/index.ts`
- Modify: `src/components/graphBuilder/graphBuilderMode.ts`
- Test: `tests/fitYByXConfig.test.ts`

**Interfaces:**
- Produces: `EmbeddedGraphConfig`, `FitYByXItem`, role validation helpers, `createDefaultFitYByXGraphConfig`, `createFitYByXItem`, and `createEmbeddedGraphItem`.
- Consumes: `FieldRef`, `GraphBuilderItem`, and existing Graph Builder default-state factories.

- [ ] **Step 1: Write the failing configuration test**

Create `tests/fitYByXConfig.test.ts` with real objects and assertions equivalent to:

```ts
import assert from "node:assert/strict";

import {
  canAssignFitYByXRole,
  createDefaultFitYByXGraphConfig,
  createFitYByXItem,
  validateFitYByXRoles,
} from "../src/components/fitYByX/fitYByXConfig.ts";
import {
  createEmbeddedGraphItem,
  normalizeGraphBuilderItem,
} from "../src/components/graphBuilder/graphBuilderMode.ts";

const response = { name: "height", type: "continuous" as const };
const factor = { name: "site", type: "nominal" as const };
const ordinal = { name: "batch", type: "ordinal" as const };

assert.equal(canAssignFitYByXRole("response", response), true);
assert.equal(canAssignFitYByXRole("factor", factor), true);
assert.equal(canAssignFitYByXRole("factor", ordinal), true);
assert.equal(canAssignFitYByXRole("response", factor), "invalidResponse");
assert.equal(canAssignFitYByXRole("factor", response), "invalidFactor");
assert.equal(canAssignFitYByXRole("factor", response, response), "duplicateRole");
assert.deepEqual(validateFitYByXRoles({ response, factor }), { ok: true });

const config = createDefaultFitYByXGraphConfig({ response, factor });
assert.equal(config.mode, "2d");
assert.deepEqual(config.modeStates.twoD.encoding, { x: factor, y: response });
assert.deepEqual(config.modeStates.twoD.multiX, []);
assert.deepEqual(config.modeStates.twoD.multiY, []);
assert.deepEqual(config.modeStates.twoD.elements, [
  { kind: "points", enabled: true },
  { kind: "boxplot", enabled: true },
]);
assert.deepEqual(config.filters, []);
assert.deepEqual(config.sampling, { mode: "full" });

const before = structuredClone(config);
const graphItem = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: "table-1",
  config,
  createdAt: "2026-08-30T00:00:00.000Z",
});
assert.deepEqual(config, before);
assert.deepEqual(normalizeGraphBuilderItem(graphItem), graphItem);

const item = createFitYByXItem({
  id: "fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: "table-1",
  response,
  factor,
  createdAt: "2026-08-30T00:00:00.000Z",
});
assert.deepEqual(item.graph, config);
```

Also assert every missing-role and duplicate-role error. Represent a physically numeric but nominal factor as `FieldRef.type === "nominal"` and verify it is accepted.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
$out = Join-Path $env:TEMP "fitYByXConfig.test.mjs"
npx esbuild tests/fitYByXConfig.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: bundling fails because the Fit Y by X modules and exports do not exist.

- [ ] **Step 3: Add the persisted types and pure helpers**

In `src/types/graphBuilder.ts` add:

```ts
export type EmbeddedGraphConfig = Pick<
  GraphBuilderItem,
  "mode" | "modeStates" | "filters" | "sampling"
>;
```

In `src/types/fitYByX.ts` define:

```ts
import type { FieldRef } from "@/graphCore";
import type { EmbeddedGraphConfig } from "./graphBuilder";

export interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}
```

In `fitYByXConfig.ts` define:

```ts
export type FitYByXRole = "response" | "factor";
export type FitYByXValidationError =
  | "missingResponse"
  | "missingFactor"
  | "duplicateRole"
  | "invalidResponse"
  | "invalidFactor";

export function canAssignFitYByXRole(
  role: FitYByXRole,
  field: FieldRef,
  other?: FieldRef,
): true | FitYByXValidationError;

export function validateFitYByXRoles(input: {
  response?: FieldRef;
  factor?: FieldRef;
}): { ok: true } | { ok: false; error: FitYByXValidationError };
```

Compare duplicate roles by field name. Response accepts only `continuous`;
factor accepts only `nominal` or `ordinal`. Build the 2D state from
`createDefaultGraph2DState()`, replace `encoding` and `elements`, and reuse the
existing 3D and Multivariate defaults.

`createEmbeddedGraphItem` must deep-copy nested config arrays and maps before
passing the result through `normalizeGraphBuilderItem`. Export the new types
through `src/types/index.ts`.

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command. Expected: all assertions pass.

- [ ] **Step 5: Run adjacent Graph Builder regression coverage**

```powershell
$out = Join-Path $env:TEMP "graphBuilderMode.test.mjs"
npx esbuild tests/graphBuilderMode.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: existing mode normalization remains green.

- [ ] **Step 6: Commit the contract**

```powershell
git add src/types/fitYByX.ts src/types/graphBuilder.ts src/types/index.ts src/components/fitYByX/fitYByXConfig.ts src/components/graphBuilder/graphBuilderMode.ts tests/fitYByXConfig.test.ts
git commit -m "feat(analysis): define Fit Y by X configuration"
```

---

### Task 2: Fit Y By X Store And Folder Assignments

**Files:**
- Create: `src/stores/useFitYByXStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/index.ts`
- Test: `tests/fitYByXStore.test.ts`
- Test: `tests/folderStore.fitYByX.test.ts`

**Interfaces:**
- Consumes: `FitYByXItem`, `createFitYByXItem`, and `assertProjectMutable`.
- Produces: `useFitYByXStore` and `fitYByXFolders` folder actions consumed by persistence and Workspace.

- [ ] **Step 1: Write failing store tests**

Cover this public shape:

```ts
interface FitYByXStore {
  items: FitYByXItem[];
  counter: number;
  addItem: (item: FitYByXItem) => void;
  updateItem: (id: string, patch: Partial<FitYByXItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: FitYByXItem[]) => void;
  reset: () => void;
  nextName: () => string;
}
```

Assertions must prove add/update/rename/delete/reset, source-table cascade,
read-only rejection, and counter recovery from loaded names matching
`/^Fit Y by X (\d+)$/`. Folder tests must prove load, move, folder rename,
folder deletion, and pruning for a `fitYByXFolders` entry.

- [ ] **Step 2: Run both tests and verify RED**

```powershell
foreach ($test in @("fitYByXStore", "folderStore.fitYByX")) {
  $out = Join-Path $env:TEMP "$test.test.mjs"
  npx esbuild "tests/$test.test.ts" --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
  node $out
  Remove-Item $out -Force
}
```

Expected: missing store exports and folder members.

- [ ] **Step 3: Implement the store**

Mirror `useTabulateStore` lifecycle and mutability guards. Normalize loaded
items by rebuilding `graph` with the Task 1 factory boundary while preserving
valid persisted IDs, names, role fields, and timestamps. Do not place these
items in `useGraphBuilderStore`.

- [ ] **Step 4: Extend the folder store**

Add:

```ts
fitYByXFolders: Record<string, string>;
setFitYByXFolder: (id: string, folder: string | null) => void;
```

Extend folder rename/delete and `pruneAssignments` to transform the new map.
Change every `pruneAssignments` call signature to include valid Fit Y by X IDs.
Export the new store from `src/stores/index.ts`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: both tests pass.

- [ ] **Step 6: Commit store behavior**

```powershell
git add src/stores/useFitYByXStore.ts src/stores/useFolderStore.ts src/stores/index.ts tests/fitYByXStore.test.ts tests/folderStore.fitYByX.test.ts
git commit -m "feat(analysis): store Fit Y by X documents"
```

---

### Task 3: Project Manifest Save And Open

**Files:**
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`

**Interfaces:**
- Consumes: `FitYByXItem[]` and `fitYByXFolders` as opaque project data.
- Produces: camelCase IPC fields `fitYByX` and `fitYByXFolders`, backed by Rust `fit_y_by_x` and `fit_y_by_x_folders`.

- [ ] **Step 1: Add failing frontend project-contract assertions**

Extend the `SaveProjectRequest` fixture in
`tests/useProjectStore.saveLifecycle.test.ts`:

```ts
fitYByX: [{ id: "fit-1", sourceDatasetId: "table-1" }],
fitYByXFolders: { "fit-1": "Analyses" },
```

Assert the complete object reaches `projectService.save` unchanged during the
existing save lifecycle and retry paths.

- [ ] **Step 2: Add failing Rust archive tests**

In `spprj_archive.rs`, add tests that:

```rust
let fit = serde_json::json!({
    "id": "fit-1",
    "sourceDatasetId": "table-1",
    "response": { "name": "height", "type": "continuous" },
    "factor": { "name": "site", "type": "nominal" }
});
```

Round-trip `fit` and `{ "fit-1": "Analyses" }` through the archive. Add a
legacy manifest fixture without either key and assert both loaded collections
are empty.

- [ ] **Step 3: Verify RED on both boundaries**

```powershell
$out = Join-Path $env:TEMP "useProjectStore.saveLifecycle.test.mjs"
npx esbuild tests/useProjectStore.saveLifecycle.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force

Push-Location src-tauri
cargo test spprj_archive
Pop-Location
```

Expected: TypeScript fails on missing request fields and Rust fails on missing
manifest fields or arguments.

- [ ] **Step 4: Add TypeScript and Rust contract fields**

Add to `OpenProjectResult` and `SaveProjectRequest`:

```ts
fitYByX: unknown[];
fitYByXFolders: Record<string, string>;
```

Add to Rust request, open result, bundle, and manifest structs:

```rust
#[serde(default)]
pub fit_y_by_x: Vec<serde_json::Value>,
#[serde(default)]
pub fit_y_by_x_folders: HashMap<String, String>,
```

Thread both values through `ProjectService::create_project`,
`StreamingProjectWriter::write`, `build_bundle`, zip read, and legacy JSON read.
Use empty collections for new projects and preserve payload JSON without Rust
interpretation.

- [ ] **Step 5: Verify GREEN and compile both applications**

Run the Step 3 commands, then:

```powershell
npx vite build
Push-Location src-tauri
cargo test project_service
cargo check
Pop-Location
```

Expected: focused tests, frontend build, and Rust checks pass.

- [ ] **Step 6: Commit persistence**

```powershell
git add src/types/project.ts src/services/projectService.ts tests/useProjectStore.saveLifecycle.test.ts src-tauri/src/models/save.rs src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/services/streaming_project_writer.rs
git commit -m "feat(project): persist Fit Y by X documents"
```

---

### Task 4: Extract The Shared Graph Runtime

**Files:**
- Create: `src/components/graphBuilder/graphRuntimeModel.ts`
- Create: `src/components/graphBuilder/GraphRuntime.tsx`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/index.ts`
- Test: `tests/graphRuntime.test.ts`
- Test: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: a complete normalized `GraphBuilderItem` and `DatasetMeta`.
- Produces: `GraphRuntime`, which owns request execution and rendering but never writes the Graph Builder store.

- [ ] **Step 1: Write the failing runtime contract test**

Create `tests/graphRuntime.test.ts`. Build one interactive graph item and one
Fit Y by X item materialized with `createEmbeddedGraphItem`. Assert:

```ts
assert.deepEqual(
  deriveGraphRequestParts(interactiveItem),
  deriveGraphRequestParts(embeddedItem),
);
assert.deepEqual(
  buildGraphRuntimeModel(interactiveItem, metadata),
  buildGraphRuntimeModel(embeddedItem, metadata),
);
```

Read `GraphRuntime.tsx` as source and assert it does not import
`useGraphBuilderStore`. Extend `graphDataPipeline.test.ts` with equivalent-item
request assertions so request fields, elements, filters, and full sampling are
identical.

- [ ] **Step 2: Run runtime and pipeline tests and verify RED**

```powershell
foreach ($test in @("graphRuntime", "graphDataPipeline")) {
  $out = Join-Path $env:TEMP "$test.test.mjs"
  npx esbuild "tests/$test.test.ts" --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
  node $out
  Remove-Item $out -Force
}
```

Expected: `GraphRuntime` and `buildGraphRuntimeModel` do not exist.

- [ ] **Step 3: Extract pure runtime-model derivation**

Move the non-React derivation currently embedded in `GraphBuilderView` into:

```ts
export interface GraphRuntimeMeltInfo {
  slot: "x" | "y";
  cols: FieldRef[];
  mode: "axis" | "merge";
  varField: FieldRef;
  valField: FieldRef;
}

export interface GraphRuntimeMetadata {
  columns: ColumnMeta[];
  displayProps: ColumnDisplayProps[];
}

export function buildGraphRuntimeModel(
  item: GraphBuilderItem,
  metadata: GraphRuntimeMetadata,
): {
  effectiveEncoding: GraphSpec["encoding"];
  spec: GraphSpec;
  meltInfo: GraphRuntimeMeltInfo | null;
};
```

Use the exact existing Graph Builder derivation for effective encoding,
elements, axes, group styles, hidden groups, references, and melt metadata.
Import `ColumnMeta`, `ColumnDisplayProps`, and `DatasetMeta` from
`@/types/data`, `GraphSpec` and `FieldRef` from `@/graphCore`, and
`ScatterPointPick` from `@/graphCore/transform`. Do not fork a Fit Y by X
branch in this function.

- [ ] **Step 4: Extract the read-only React runtime**

Create:

```ts
export interface GraphRuntimeProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
  showPointBudgetAction?: boolean;
  onRequestSampleMode?: () => void;
  onPointPick?: (pick: ScatterPointPick) => void;
  brushMode?: boolean;
  onBrushSelect?: (picks: ScatterPointPick[]) => void;
}
```

Move metadata loading, `ResizeObserver` viewport state,
`useGraphDataPipeline`, progress/error overlays, raw-point notice, and Graph or
Chart3D dispatch into `GraphRuntime`. Keep field rails, role slots, filters,
layers, axis dialogs, and all store mutation callbacks in `GraphBuilderView`.
Pass optional interaction callbacks from the interactive shell.

- [ ] **Step 5: Replace the old render region in GraphBuilderView**

Mount `GraphRuntime` with the current item and interaction callbacks. Remove
only logic now owned by the runtime. Verify that `GraphBuilderView` remains the
sole component importing `useGraphBuilderStore` in this pair.

- [ ] **Step 6: Verify GREEN and guard existing graph behavior**

Run the Step 2 tests, then:

```powershell
$out = Join-Path $env:TEMP "graphBuilderMode.test.mjs"
npx esbuild tests/graphBuilderMode.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
npx vite build
```

Expected: runtime, request pipeline, mode regression, and build pass.

- [ ] **Step 7: Commit the runtime boundary**

```powershell
git add src/components/graphBuilder/graphRuntimeModel.ts src/components/graphBuilder/GraphRuntime.tsx src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/index.ts tests/graphRuntime.test.ts tests/graphDataPipeline.test.ts
git commit -m "refactor(graph): extract reusable graph runtime"
```

---

### Task 5: Role Dialog And Analysis View

**Files:**
- Create: `src/components/fitYByX/FitYByXRoleDialog.tsx`
- Create: `src/components/fitYByX/FitYByXRoleZone.tsx`
- Create: `src/components/fitYByX/FitYByXView.tsx`
- Create: `src/components/fitYByX/fitYByX.css`
- Create: `src/components/fitYByX/index.ts`
- Test: `tests/fitYByXDialog.test.ts`

**Interfaces:**
- Consumes: Task 1 validators/factories, column metadata services, `GraphRuntime`, and a source dataset.
- Produces: a controlled role dialog returning a `FitYByXItem` definition and a read-only analysis view.

- [ ] **Step 1: Write failing dialog/view contract tests**

Use pure exported dialog-state helpers for behavior assertions and source-level
checks only for component wiring. Cover:

```ts
assignFitYByXField(state, "response", response);
assignFitYByXField(state, "factor", factor);
filterFitYByXFields(fields, "nominal");
```

Assert invalid drops preserve the previous assignment and return a validation
error; valid roles enable creation; duplicate columns are rejected; search
matches name, SQL type, and modeling role. Assert `FitYByXView.tsx` mounts
`GraphRuntime`, materializes an ID prefixed `fit-y-by-x-graph:`, handles a
missing dataset, and contains no `useGraphBuilderStore` import.

- [ ] **Step 2: Run the test and verify RED**

```powershell
$out = Join-Path $env:TEMP "fitYByXDialog.test.mjs"
npx esbuild tests/fitYByXDialog.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: dialog state and components do not exist.

- [ ] **Step 3: Implement controlled role assignment**

Define dialog props:

```ts
interface FitYByXRoleDialogProps {
  dataset: DatasetMeta;
  defaultName: string;
  onCancel: () => void;
  onCreate: (item: FitYByXItem) => void;
}
```

Load `dataService.getColumns(dataset.id)` and
`dataService.getColumnDisplayProps(dataset.id)`. Reuse the searchable list and
role-zone interaction patterns from Tabulate while keeping Fit Y by X state
local until Create. Give the dialog `role="dialog"`, an accessible title,
announced validation (`role="alert"`), and disabled Create while invalid.

- [ ] **Step 4: Implement the analysis view**

Define:

```ts
interface FitYByXViewProps {
  item: FitYByXItem;
  dataset: DatasetMeta | undefined;
}
```

Render name, source, response, and factor. For an available source, materialize
a graph with:

```tsx
<GraphRuntime
  item={createEmbeddedGraphItem({
    id: `fit-y-by-x-graph:${item.id}`,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    config: item.graph,
    createdAt: item.createdAt,
  })}
  dataset={dataset}
/>
```

For a missing source, render the standard unavailable-document state and do
not mount the runtime.

- [ ] **Step 5: Verify GREEN and build**

Run the Step 2 command and `npx vite build`. Expected: test and build pass.

- [ ] **Step 6: Commit the analysis UI**

```powershell
git add src/components/fitYByX tests/fitYByXDialog.test.ts
git commit -m "feat(analysis): add Fit Y by X role dialog"
```

---

### Task 6: Workspace Integration, Localization, And Final Verification

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/workspaceFitYByX.test.ts`

**Interfaces:**
- Consumes: Fit Y by X store, folder map, dialog, view, and persisted project fields.
- Produces: Analysis menu entry, document lifecycle, tree rows, active selection, and save/open wiring.

- [ ] **Step 1: Write the failing Workspace contract test**

Create `tests/workspaceFitYByX.test.ts` using the repository's TypeScript AST
source-check pattern. Assert that Workspace:

- imports `useFitYByXStore`, `FitYByXRoleDialog`, and `FitYByXView`;
- adds `menu.fitYByX` under the Analysis menu;
- writes both `fitYByX` and `fitYByXFolders` in the save request;
- loads and resets the Fit Y by X store on project open/close;
- deletes dependent analyses when a source table is deleted;
- supports Fit Y by X selection, rename, delete, drag-to-folder, and main-pane dispatch;
- clears `activeFitYByXId` when selecting a table, graph, or tabulate.

Parse all four locale JSON files and assert the menu, dialog, validation,
history, source-missing, and document labels exist.

- [ ] **Step 2: Run the test and verify RED**

```powershell
$out = Join-Path $env:TEMP "workspaceFitYByX.test.mjs"
npx esbuild tests/workspaceFitYByX.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: Workspace and locale assertions fail.

- [ ] **Step 3: Wire creation and active-document selection**

Add `activeFitYByXId` and `showFitYByXDialog`. The menu action opens the dialog
only when a source table is active. On Create, call `nextName`, create/add the
item, clear active table/graph/tabulate IDs, select the new analysis, and add
the normal history entry.

Every table, graph, and tabulate selection branch must clear the analysis ID;
analysis selection must clear the other three IDs. Render `FitYByXView` before
the active-table fallback.

- [ ] **Step 4: Wire tree and lifecycle operations**

Extend `DragPayload` and context-menu unions with `{ kind: "fitYByX"; id:
string }`. Group analysis documents by `fitYByXFolders`, render active rows,
and route folder drops, rename, and delete through their tested stores.

On source-table deletion, call `deleteByDataset` and clear an active analysis
whose `sourceDatasetId` matches. On project close/reset clear the store and
active ID. On open load `result.fitYByX ?? []` and
`result.fitYByXFolders ?? {}`. Include current store items and folder map in
every save payload.

- [ ] **Step 5: Add all locale strings**

Add consistent keys to all four locales:

```json
{
  "menu": { "fitYByX": "Fit Y by X" },
  "fitYByX": {
    "title": "Fit Y by X",
    "response": "Y, Response",
    "factor": "X, Factor",
    "create": "Create",
    "cancel": "Cancel",
    "search": "Search columns",
    "sourceMissing": "Source data table is unavailable",
    "validation": {
      "missingResponse": "Choose a continuous response",
      "missingFactor": "Choose a nominal or ordinal factor",
      "duplicateRole": "Response and factor must use different columns",
      "invalidResponse": "Response must be continuous",
      "invalidFactor": "Factor must be nominal or ordinal"
    }
  }
}
```

Translate values for `zh-CN`, `zh-TW`, and `vi`; keep keys identical. Add the
corresponding history and workspace document labels following existing locale
structure.

- [ ] **Step 6: Run focused and adjacent tests and verify GREEN**

Run the Step 2 command and bundle/run:

```powershell
$tests = @(
  "fitYByXConfig",
  "fitYByXStore",
  "folderStore.fitYByX",
  "graphRuntime",
  "fitYByXDialog",
  "useProjectStore.saveLifecycle",
  "graphBuilderMode",
  "graphDataPipeline",
  "tabulateResult"
)
foreach ($test in $tests) {
  $out = Join-Path $env:TEMP "$test.test.mjs"
  npx esbuild "tests/$test.test.ts" --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
  node $out
  Remove-Item $out -Force
}
```

Expected: all focused and adjacent tests pass.

- [ ] **Step 7: Run full automated verification**

```powershell
npx vite build 2>&1 | Select-Object -Last 3
Push-Location src-tauri
cargo test
cargo clippy -- -D warnings
Pop-Location
```

Expected: frontend build, Rust tests, and clippy pass without warnings.

- [ ] **Step 8: Perform the Tauri smoke test**

```powershell
npm run tauri dev
```

Verify: valid and invalid role assignment, cancel without mutation, document
creation, Points and Box Plot rendering, selection switching, rename, folder
movement, source-table cascade deletion, read-only viewing, and save/reopen.
Stop the dev process after the check.

- [ ] **Step 9: Commit Workspace integration**

```powershell
git add src/components/Workspace.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/workspaceFitYByX.test.ts
git commit -m "feat(analysis): integrate Fit Y by X workspace"
```

- [ ] **Step 10: Review final branch scope**

```powershell
git status --short --branch
git diff dev...HEAD --stat
git log --oneline dev..HEAD
```

Expected: only Issue 71 implementation and its design/plan commits are present;
generated schema line-ending entries remain unstaged and have no content diff.
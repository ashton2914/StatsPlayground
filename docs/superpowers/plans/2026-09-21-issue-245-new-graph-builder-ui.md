# Issue 245 New Graph Builder UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor New Graph Builder to use Old Graph Builder's UI structure and drag/drop interaction model while preserving the independent native renderer and current persisted contracts.

**Architecture:** Extract small callback-driven Graph Builder presentation primitives for field drag payloads, the field palette, drop slots, shell sections, Layer cards, and inspector sections. Old Graph Builder retains its existing ECharts/runtime/store behavior behind an adapter; New Graph Builder maps its single-value document and native-render state into the same primitives. Unsupported New Graph Builder capabilities remain visible-disabled and never mutate state or invoke IPC.

**Tech Stack:** React 19, TypeScript, Zustand, Playwright Component Testing, Vite, Tauri v2, Rust/wgpu native graph renderer.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-245-new-graph-builder-ui-design.md`

## Global Constraints

- Base and PR target are latest `origin/dev` -> `dev`; implementation branch is `issue/245-new-graph-builder-ui`.
- Work only in `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/245-new-graph-builder-ui`.
- Preserve the existing `GraphBuilderNewDocument` version-2 shape; X, Y, and Overlay remain one column ID each.
- Do not modify the Rust native renderer or IPC contract unless a failing boundary test proves the approved UI cannot be implemented without it.
- Any source column may bind to X or Y. A nonnumeric Y persists but must not issue a native render request.
- Old Graph Builder behavior must remain unchanged.
- Placeholder controls are visible-disabled and have an unavailable explanation; they never mutate state, mark dirty, or invoke IPC.
- Use stable `columnId` values for drag identity; duplicate display names must remain distinct.
- Use repository i18n and theme variables; do not add a second hard-coded Graph Builder theme.
- Follow TDD: retain the observed RED failure before each production slice, then run the smallest GREEN selector.
- Do not commit task slices before manual acceptance. The Issue lifecycle requires one reviewed commit only after the user accepts the running application.
- Every command must be explicitly bound to the Issue 245 worktree.

## File Structure

### New shared units

- `src/components/graphBuilder/shared/graphBuilderDragPayload.ts`
  - Owns the versioned graph-field drag payload and strict decoding.
- `src/components/graphBuilder/shared/GraphBuilderChrome.tsx`
  - Owns store-agnostic field palette, drop-slot, toolbar-section, rail-section, Layer-card, and inspector-section presentation primitives.
- `src/components/graphBuilder/shared/graphBuilderChrome.css`
  - Owns only the styles required by those shared primitives; it reuses current `gb-*` and application theme variables.
- `tests/graphBuilderSharedContracts.test.ts`
  - Proves payload validation and duplicate-name identity.
- `tests/GraphBuilderSharedHarness.tsx`
  - Component-test harness for palette, drop slots, and disabled placeholders.
- `tests/graphBuilderShared.spec.tsx`
  - Proves shared primitive drag/drop, clear, disabled, and accessible behavior.

### Existing files to modify

- `src/components/graphBuilder/GraphBuilderView.tsx`
  - Replaces local palette/slot/section markup with shared primitives while retaining all Old Graph Builder state and callbacks.
- `src/components/graphBuilder/graphBuilder.css`
  - Removes only declarations moved unchanged into the shared stylesheet and keeps Old-specific runtime styling.
- `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
  - Becomes the New adapter for shared chrome, free single-value X/Y binding, Layers, Legend Overlay drop, and placeholder controls.
- `src/components/graphBuilderNew/GraphBuilderNewView.css`
  - Keeps native-canvas and Graph-new-specific state styling; removes the separate form-layout vocabulary.
- `src/components/graphBuilderNew/GraphNewOverlayLegend.tsx`
  - Remains the group-list authority and is mounted inside the shared inspector section.
- `tests/GraphBuilderNewHarness.tsx`
  - Adds helpers/fixtures needed to test unsupported Y, drag/drop, Layer controls, and placeholder call isolation.
- `tests/graphBuilderNew.spec.tsx`
  - Migrates select-based assertions to the approved UI and adds Issue 245 behavior.
- `tests/graphBuilderSplitters.spec.tsx`
  - Protects Old Graph Builder rail/layout behavior after extraction.
- `src/i18n/locales/en.json`
- `src/i18n/locales/zh-CN.json`
- `src/i18n/locales/zh-TW.json`
- `src/i18n/locales/vi.json`
  - Add the New Graph Builder unsupported/placeholder/slot copy with locale parity.

---

### Task 1: Shared drag payload and presentation primitives

**Files:**
- Create: `src/components/graphBuilder/shared/graphBuilderDragPayload.ts`
- Create: `src/components/graphBuilder/shared/GraphBuilderChrome.tsx`
- Create: `src/components/graphBuilder/shared/graphBuilderChrome.css`
- Create: `tests/graphBuilderSharedContracts.test.ts`
- Create: `tests/GraphBuilderSharedHarness.tsx`
- Create: `tests/graphBuilderShared.spec.tsx`

**Interfaces:**
- Produces:

```ts
export const GRAPH_FIELD_DRAG_MIME =
  "application/x-statsplayground-graph-fields+json";

export interface GraphBuilderDragField {
  columnId: string;
  name: string;
  sqlType: string;
}

export function encodeGraphBuilderDragFields(
  fields: readonly GraphBuilderDragField[],
): string;

export function decodeGraphBuilderDragFields(
  value: string,
): GraphBuilderDragField[] | null;

export interface GraphFieldPaletteItem extends GraphBuilderDragField {
  typeLabel: string;
  unavailable?: boolean;
}

export interface GraphDropSlotBinding {
  columnId: string;
  label: string;
  unavailable?: boolean;
}
```

- `GraphFieldPalette` receives ordered items plus `disabled`.
- `GraphDropSlot` receives `slot`, `label`, one optional binding, `disabled`,
  `required`, `orientation`, `onDropFields`, `onClear`, and optional settings.
- `GraphBuilderToolbarSection`, `GraphBuilderRailSection`, `GraphLayerCard`,
  and `GraphInspectorSection` provide structure only.

- [x] **Step 1: Write strict payload RED tests**

```ts
import assert from "node:assert/strict";
import {
  decodeGraphBuilderDragFields,
  encodeGraphBuilderDragFields,
} from "../src/components/graphBuilder/shared/graphBuilderDragPayload";

const duplicateNames = [
  { columnId: "first-id", name: "Voltage", sqlType: "DOUBLE" },
  { columnId: "second-id", name: "Voltage", sqlType: "DOUBLE" },
];

assert.deepEqual(
  decodeGraphBuilderDragFields(encodeGraphBuilderDragFields(duplicateNames)),
  duplicateNames,
);
assert.equal(decodeGraphBuilderDragFields("{}"), null);
assert.equal(decodeGraphBuilderDragFields('{"version":1,"fields":[]}'), null);
assert.equal(
  decodeGraphBuilderDragFields(
    '{"version":1,"fields":[{"columnId":"","name":"X","sqlType":"DOUBLE"}]}',
  ),
  null,
);
```

- [x] **Step 2: Run the payload test and retain RED evidence**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSharedContracts.test.ts
```

Expected: FAIL because the shared module does not exist.

- [x] **Step 3: Implement strict version-1 encoding and decoding**

Implement JSON parsing with exact guards:

```ts
interface GraphBuilderDragEnvelope {
  version: 1;
  fields: GraphBuilderDragField[];
}

export function encodeGraphBuilderDragFields(
  fields: readonly GraphBuilderDragField[],
): string {
  const decoded = validateFields(fields);
  if (!decoded) throw new Error("graph_builder_invalid_drag_fields");
  return JSON.stringify({ version: 1, fields: decoded });
}
```

Reject malformed JSON, unknown versions, empty arrays, duplicate IDs, blank or
over-256-byte IDs, blank names, and blank SQL types. Return `null`; do not
silently synthesize identity from a display name.

- [x] **Step 4: Run the payload test GREEN**

Run the same command. Expected: PASS with all assertions executed.

- [x] **Step 5: Write shared component RED tests**

Mount `GraphBuilderSharedHarness` and assert:

```ts
await component.getByRole("button", { name: "Drag Voltage" })
  .dragTo(component.getByTestId("graph-slot-x"));
await expect(component.getByTestId("last-drop")).toHaveText("first-id");

await component.getByRole("button", { name: "Clear X" }).click();
await expect(component.getByTestId("clear-count")).toHaveText("1");

await expect(component.getByRole("button", { name: "Start Over" }))
  .toBeDisabled();
await expect(component.getByRole("button", { name: "Start Over" }))
  .toHaveAttribute("title", "Not yet available in New Graph Builder");
```

Also prove a disabled palette and disabled slot do not invoke callbacks.

- [x] **Step 6: Run the shared component selector and retain RED evidence**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-shared-red \
  tests/graphBuilderShared.spec.tsx
```

Expected: FAIL because shared component exports are missing.

- [x] **Step 7: Implement the minimal shared components**

Use semantic buttons and fieldsets, set both
`GRAPH_FIELD_DRAG_MIME` and `text/plain`, decode the custom MIME first, and
prevent default only for valid enabled drops. Keep all state in the harness;
the production components only emit callbacks.

- [x] **Step 8: Run Task 1 GREEN checks**

Run the payload and shared component commands with output
`test-results/issue-245-shared-green`. Expected: both PASS.

- [x] **Step 9: Review checkpoint**

Inspect:

```bash
git --no-pager diff --no-ext-diff --stat
git --no-pager diff --no-ext-diff -- \
  src/components/graphBuilder/shared \
  tests/graphBuilderSharedContracts.test.ts \
  tests/GraphBuilderSharedHarness.tsx \
  tests/graphBuilderShared.spec.tsx
```

Do not commit before manual acceptance.

---

### Task 2: Old Graph Builder adapter with behavior preservation

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `tests/graphBuilderSplitters.spec.tsx`
- Test: `tests/graphBuilderShared.spec.tsx`

**Interfaces:**
- Consumes Task 1 `GraphFieldPalette`, `GraphDropSlot`,
  `GraphBuilderToolbarSection`, `GraphBuilderRailSection`,
  `GraphLayerCard`, and `GraphInspectorSection`.
- Produces the current Old Graph Builder behavior through shared chrome,
  without changing its store/runtime interfaces.

- [x] **Step 1: Add a structural RED assertion**

Extend the Old Graph Builder harness coverage to require:

```ts
await expect(component.getByTestId("graph-field-palette")).toBeVisible();
await expect(component.getByTestId("graph-slot-x")).toBeVisible();
await expect(component.getByTestId("graph-slot-y")).toBeVisible();
await expect(component.getByTestId("graph-layers-panel")).toBeVisible();
await expect(component.getByTestId("graph-inspector-panel")).toBeVisible();
```

Also retain existing splitter resize/reset assertions.

- [x] **Step 2: Run focused Old Graph Builder RED**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-old-red \
  tests/graphBuilderSplitters.spec.tsx
```

Expected: FAIL on missing shared structural test IDs, not on baseline splitter
behavior.

- [x] **Step 3: Replace only local presentation markup**

In `GraphBuilderView.tsx`:

- map current `columns` to `GraphFieldPaletteItem`;
- preserve current selected-column visuals;
- map decoded shared drag fields back to the existing `FieldRef` routing;
- replace local `Slot` markup with `GraphDropSlot` while retaining multi-field,
  manager, context-menu, required, orientation, and reject-flash props;
- wrap existing Layer and Legend/Style content with shared section components;
- keep all current store calls, graph queueing, runtime, filter, sampling,
  cursor, mode, axis, and context-menu logic in `GraphBuilderView`.

Do not change the semantics of `routeDropToSlot`, `handleDropOnSlot`,
`resolveCanvasDropSlot`, or visual-slot transpose logic.

- [x] **Step 4: Move only common CSS**

Move unchanged structural declarations into `graphBuilderChrome.css`.
Retain Old-only selectors for splitters, filter panel, graph runtime,
multivariate, 3D, options, and context menus in `graphBuilder.css`.

- [x] **Step 5: Run Old Graph Builder GREEN**

Run the Task 2 selector with output `test-results/issue-245-old-green`.
Expected: PASS.

- [x] **Step 6: Run focused non-component Old contracts**

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSlotLayout.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAxisInteractions.test.ts
```

Expected: all PASS; if an exact filename differs, locate the repository's
existing test that imports the named production module and use that file
instead of creating a substitute.

- [x] **Step 7: Review checkpoint**

Verify the diff contains presentation extraction only and no changes to Old
Graph Builder state transitions. Do not commit.

---

### Task 3: New Graph Builder shell and free single-value X/Y binding

**Files:**
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `tests/GraphBuilderNewHarness.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`

**Interfaces:**
- Consumes Task 1 shared chrome and the unchanged
  `useGraphBuilderNewStore.setColumns(id, xColumnId, yColumnId)`.
- Produces X/Y slot callbacks:

```ts
function bindAxis(
  axis: "x" | "y",
  fields: readonly GraphBuilderDragField[],
): void;

function clearAxis(axis: "x" | "y"): void;
```

- [x] **Step 1: Replace select-driven tests with drag/drop RED tests**

Add helpers that drag the palette item identified by column ID:

```ts
await component.getByTestId("graph-field-column-label")
  .dragTo(component.getByTestId("graph-slot-y"));

await expect(component.getByTestId("selected-columns"))
  .toContainText('"yColumnId":"column-label"');
await expect(component.getByTestId("render-metrics"))
  .toContainText('"renders":0');
await expect(component.getByRole("status"))
  .toHaveText("The native renderer does not support this field combination yet.");
```

Cover:

- any scalar column into X;
- text column into Y;
- replacement of an occupied X/Y slot;
- clear action;
- duplicate-name identity;
- read-only/save-disabled drag and clear;
- removed persisted field display.

- [x] **Step 2: Run focused New Graph Builder RED**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-axis-red \
  tests/graphBuilderNew.spec.tsx \
  --grep "Issue 245 axis slots"
```

Expected: FAIL because the current UI exposes selects and rejects nonnumeric Y.

- [x] **Step 3: Implement the Old-style New shell**

Replace the header/form layout with:

- shared toolbar;
- left field palette and Layers rail;
- Group X placeholder;
- Y slot, native canvas, and Group Y placeholder;
- X slot;
- right Legend/Style inspector;
- existing native host status in a non-intrusive status area.

Keep dataset/session validity effects and transport cleanup unchanged.

- [x] **Step 4: Implement free X/Y binding guards**

Use every loaded descriptor in both X and Y palette/drop validation. Keep
`numericColumnIds` only for the native-render eligibility guard:

```ts
const supportedNativePair = Boolean(
  session.xColumnId
  && session.yColumnId
  && xColumnIds.has(session.xColumnId)
  && numericColumnIds.has(session.yColumnId),
);
```

When X/Y both exist but `supportedNativePair` is false because Y is
nonnumeric, render the localized unsupported-combination status and do not
mount `GraphNewCanvas`.

- [x] **Step 5: Add locale copy**

Add exact keys for:

- X, Y, Group X, Group Y slot labels;
- clear action;
- native unsupported combination;
- unavailable New Graph Builder capability;
- field palette and inspector section labels.

Maintain equivalent meaning in all four locale files.

- [x] **Step 6: Run Task 3 GREEN**

Run the exact Task 3 grep with output `test-results/issue-245-axis-green`.
Expected: PASS.

- [x] **Step 7: Run stale/read-only/persistence regressions**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-axis-regression \
  tests/graphBuilderNew.spec.tsx \
  --grep "persistence|field visibility|source"
```

Expected: PASS after updating selectors to the shared slot UI without weakening
their behavioral assertions.

- [x] **Step 8: Review checkpoint**

Confirm no persisted type or Rust request shape changed. Do not commit.

---

### Task 4: Functional Layers, X interpretation, and Mean

**Files:**
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `tests/GraphBuilderNewHarness.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`
- Modify: locale files from Task 3

**Interfaces:**
- Consumes unchanged store operations:

```ts
setModes(id: string, xMode: GraphNewXMode, rawMode: GraphNewRawMode): void;
setMean(id: string, showMean: boolean): void;
```

- Produces pure mappings colocated with the New adapter:

```ts
type GraphNewActiveLayer = "points" | "line" | "timeSeries";

function activeLayersFor(
  rawMode: GraphNewRawMode,
  xMode: GraphNewXMode,
): ReadonlySet<GraphNewActiveLayer>;

function rawModeForLayers(
  layers: ReadonlySet<GraphNewActiveLayer>,
): GraphNewRawMode;
```

- [x] **Step 1: Add mapping RED tests**

Assert:

```ts
assert.equal(rawModeForLayers(new Set(["points"])), "scatter");
assert.equal(rawModeForLayers(new Set(["line"])), "line");
assert.equal(rawModeForLayers(new Set(["points", "line"])), "pointsLine");
```

Add component assertions that the last raw geometry cannot be removed and that
unsupported Add Layer choices are disabled.

- [x] **Step 2: Run the Layer RED selector**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-layers-red \
  tests/graphBuilderNew.spec.tsx \
  --grep "Issue 245 layers"
```

Expected: FAIL because Layer cards do not own these controls.

- [x] **Step 3: Implement supported Layer cards**

Render Points and/or Line cards from `rawMode`. Map add/remove actions back to
the exact existing modes. Render Time Series settings when X interpretation is
time or duration; selecting Time Series sets a temporal X mode and guarantees
Line is active.

Move:

- X interpretation into the X-slot settings content;
- Mean checkbox into the supported Layer settings.

Keep current camera rules: raw-mode and Mean changes preserve camera; X-mode
changes reset it through existing store behavior.

- [x] **Step 4: Implement unavailable Add Layer entries**

Display Bar, Smoother, Fit Line, Box Plot, Histogram, Normal Curve, 3D, Surface,
Contour, and other current Old Graph Builder choices as disabled. Their click
handlers must be absent, not no-op success handlers.

- [x] **Step 5: Run Task 4 GREEN and camera regressions**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-layers-green \
  tests/graphBuilderNew.spec.tsx \
  --grep "Issue 245 layers|phase1 typed X|mean overlay"
```

Expected: PASS.

- [x] **Step 6: Review checkpoint**

Inspect requests before and after Layer changes and confirm only existing
`rawMode`, `xMode`, and `showMean` fields differ. Do not commit.

---

### Task 5: Legend Overlay drop target and disabled feature surface

**Files:**
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `src/components/graphBuilderNew/GraphNewOverlayLegend.tsx`
- Modify: `tests/GraphBuilderNewHarness.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`
- Modify: locale files from Task 3

**Interfaces:**
- Consumes unchanged:

```ts
setOverlay(id: string, overlayColumnId: string | null): void;
setHiddenOverlayGroups(id: string, ids: string[]): void;
```

- Produces one Overlay `GraphDropSlot` in Legend plus the current
  `GraphNewOverlayLegend` group list.

- [x] **Step 1: Add Overlay and placeholder RED tests**

Replace Overlay-select setup with:

```ts
await component.getByTestId("graph-field-lot-column")
  .dragTo(component.getByTestId("graph-slot-overlay"));
await expect(component.getByRole("group", { name: "Overlay legend" }))
  .toBeVisible();
```

Assert all approved placeholders are visible-disabled and retain explanatory
titles. Record render metrics and dirty state before attempting interaction;
assert neither changes.

- [x] **Step 2: Run Task 5 RED**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-inspector-red \
  tests/graphBuilderNew.spec.tsx \
  --grep "Overlay legend|Issue 245 placeholders"
```

Expected: FAIL because Overlay is still select-driven and placeholders are
absent.

- [x] **Step 3: Move Overlay into Legend**

Mount the Overlay drop slot above `GraphNewOverlayLegend`. Clearing/replacing
must route only through `setOverlay`, preserving existing hidden-group reset
and camera behavior.

- [x] **Step 4: Render complete disabled surface**

Add the visible-disabled toolbar, Group X/Y, Style, axis-settings affordances,
and unsupported Layer options defined by the spec. Use actual `disabled`
attributes and localized titles.

- [x] **Step 5: Preserve Legend group behavior**

Keep backend colors, localized missing label, exact counts, sorted hidden IDs,
read-only disabling, and the existing 64-group bounded scroll region.

- [x] **Step 6: Run Task 5 GREEN**

Run the Task 5 selector with output
`test-results/issue-245-inspector-green`. Expected: PASS.

- [x] **Step 7: Run all Overlay regressions**

```bash
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-overlay-regression \
  tests/graphBuilderNew.spec.tsx \
  --grep "Overlay|overlay"
```

Expected: PASS with no select-based setup remaining.

- [x] **Step 8: Review checkpoint**

Confirm placeholder interactions create no store patch, dirty transition, or
render request. Do not commit.

---

### Task 6: Visual acceptance build and full verification

**Files:**
- Modify as required by failures: only files already listed in Tasks 1-5
- Test: `tests/graphBuilderShared.spec.tsx`
- Test: `tests/graphBuilderNew.spec.tsx`
- Test: `tests/graphBuilderSplitters.spec.tsx`
- Documentation: update this plan's checkboxes and evidence notes only

**Interfaces:**
- Consumes the complete approved UI implementation.
- Produces a running Tauri application and acceptance checklist; no commit or
  PR before user acceptance.

- [x] **Step 1: Run shared and New Graph Builder contracts**

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSharedContracts.test.ts
npx playwright test -c playwright-ct.config.ts \
  --output test-results/issue-245-final-ct \
  tests/graphBuilderShared.spec.tsx \
  tests/graphBuilderNew.spec.tsx \
  tests/graphBuilderSplitters.spec.tsx
```

Expected: all tests execute and pass; zero-test success is not accepted.

- [x] **Step 2: Run affected TypeScript contracts**

```bash
npx tsc -p tests/tsconfig.contracts.json
```

Expected: exit 0.

- [x] **Step 3: Run the frontend production build**

```bash
npx vite build
```

Expected: exit 0 with production assets generated.

- [x] **Step 4: Run Rust gates only if cross-boundary files changed**

If `git diff --name-only origin/dev...HEAD` or the working-tree diff contains
`src-tauri/`, `src/services/graphNewService.ts`, or a graph-new request type,
run from `src-tauri/`:

```bash
cargo build
cargo clippy -- -D warnings
cargo test graph_new
```

Otherwise record that the approved UI-only change did not touch the Rust/IPC
boundary.

- [x] **Step 5: Run repository hygiene checks**

```bash
git diff --check
git --no-pager diff --no-ext-diff --stat
git --no-pager status --short --branch
```

Expected: only intended source, tests, locale, spec, and plan files.

- [x] **Step 6: Request independent code review**

Provide Issue 245 requirements, base SHA `fd54b9bc5e0755df838ce4e9600ff1b65ac14b71`,
the complete unstaged/staged diff, focused test evidence, and review focus:
Old behavior preservation, unsupported-Y IPC isolation, placeholder no-op
safety, read-only behavior, and locale/accessibility parity.

Fix every blocking finding and rerun affected selectors plus the frontend
build.

- [x] **Step 7: Start the Issue 245 acceptance build**

Run with the worktree explicitly bound:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/245-new-graph-builder-ui run tauri -- dev
```

Verify:

- Vite responds on the reported localhost URL;
- the native process path belongs to the Issue 245 worktree or its explicitly
  selected isolated Cargo target;
- the running frontend source belongs to the Issue 245 worktree.

- [x] **Step 8: Present the manual acceptance checklist**

Ask the user to verify:

1. visual parity with current Old Graph Builder;
2. drag any column into X or Y;
3. nonnumeric Y remains bound and shows unsupported state;
4. Points, Line, Time Series, X interpretation, and Mean work;
5. Overlay assignment and Legend visibility work;
6. every deferred control is visible-disabled;
7. Old Graph Builder still behaves normally.

Stop at manual acceptance. Do not commit, push, or create a pull request until
the user explicitly accepts the running application.

## Verification Evidence

- Shared drag-payload and Graph Builder contract tests: passed.
- Playwright component suite: 93 passed, 0 failed.
- Application and contract TypeScript checks: passed.
- Vite production build: passed with existing chunk-size warnings only.
- `git diff --check`: passed.
- Independent review findings were addressed and re-verified.
- Acceptance build is running from this worktree at `http://localhost:1423/`
  with native binary `target-issue245/debug/stats-playground`.
- No Rust, IPC service, or persisted document contract files changed, so Rust
  build/clippy/test gates were not required for this UI-only diff.
- Phase 1 was manually accepted on 2026-09-21.

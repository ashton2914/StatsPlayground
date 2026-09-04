# Issue 64 Graph Theme Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every grouped Graph Builder mark a project-persistent theme identity that survives all layer, data-pipeline, renderer, and navigation transitions.

**Architecture:** Persist append-only group-to-slot assignments per grouping field on `GraphBuilderItem`. Resolve a complete per-group style map from those slots and the current Palette list, then require every 2D and 3D renderer path to consume that map by group key rather than current group or series order.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, ECharts/echarts-gl, direct Node assertion tests, Vite 6.

**Spec:** `docs/superpowers/specs/2026-08-27-issue-64-graph-theme-identity-design.md`

## Global Constraints

- Colors are stable visual identifiers, not decorative defaults.
- Slot assignment must survive layer add/remove/reorder, hidden groups, filters, sampling, frame rebuilds, navigation, 2D/3D switching, and project save/load.
- Palette edits may update colors but must not change group-to-slot assignment.
- Explicit `groupStyles` override automatic styles per mark.
- Value Order changes display order only, never identity.
- Do not persist resolved automatic RGB values.
- Do not change the Rust archive schema or graph-data IPC protocol.
- Old and malformed project JSON must load without failure.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Persistent Theme Identity Model

**Files:**
- Create: `src/components/graphBuilder/graphThemeIdentity.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Replace coverage in: `tests/graphGroupOrder.test.ts`
- Create: `tests/graphThemeIdentity.test.ts`

**Interfaces:**
- Produces: `GroupThemeSlots = Record<string, Record<string, number>>`.
- Produces: `normalizeGroupThemeSlots(value: unknown): GroupThemeSlots`.
- Produces: `reconcileGroupThemeSlots(current, fieldName, activeKeys): GroupThemeSlots`.
- Produces: `groupThemeSlot(slots, fieldName, groupKey, fallbackIndex): number`.
- Preserves: `resolveStableGroupKeys()` for deterministic active/legend order.

- [ ] **Step 1: Write identity allocation tests**

Create `tests/graphThemeIdentity.test.ts` with assertions equivalent to:

```ts
import assert from "node:assert/strict";
import {
  groupThemeSlot,
  normalizeGroupThemeSlots,
  reconcileGroupThemeSlots,
} from "../src/components/graphBuilder/graphThemeIdentity.ts";

const initial = reconcileGroupThemeSlots(undefined, "Build", ["EV", "EV1", "EV2", "TC1.6"]);
assert.deepEqual(initial.Build, { EV: 0, EV1: 1, EV2: 2, "TC1.6": 3 });

const missingMiddle = reconcileGroupThemeSlots(initial, "Build", ["EV", "EV1", "TC1.6"]);
assert.deepEqual(missingMiddle, initial);
assert.equal(groupThemeSlot(missingMiddle, "Build", "TC1.6", 2), 3);

const appended = reconcileGroupThemeSlots(missingMiddle, "Build", ["EV", "NEW", "TC1.6"]);
assert.equal(appended.Build.NEW, 4);
assert.equal(appended.Build["TC1.6"], 3);

const otherField = reconcileGroupThemeSlots(appended, "Site", ["EV"]);
assert.equal(otherField.Build.EV, 0);
assert.equal(otherField.Site.EV, 0);

assert.deepEqual(
  normalizeGroupThemeSlots({ Build: { EV: 0, EV1: -1, EV2: 0, TC: 2.5, Good: 3 } }),
  { Build: { EV: 0, Good: 3 } },
);
```

Also assert that blank strings and `DEFAULT_GROUP_KEY` are not persisted, valid maps preserve object identity when reconciliation makes no changes, and the lowest unused slot is allocated.

- [ ] **Step 2: Run the new test and verify red**

Run:

```powershell
npx esbuild tests/graphThemeIdentity.test.ts --bundle --platform=node --format=esm --outfile=tests/graphThemeIdentity.bundle.mjs
node tests/graphThemeIdentity.bundle.mjs
Remove-Item tests/graphThemeIdentity.bundle.mjs -Force
```

Expected: bundling fails because `graphThemeIdentity.ts` does not exist.

- [ ] **Step 3: Implement the pure identity module and types**

Add to `src/types/graphBuilder.ts`:

```ts
export type GroupThemeSlots = Record<string, Record<string, number>>;

export interface GraphBuilderItem {
  groupThemeSlots?: GroupThemeSlots;
}
```

Implement the pure helpers. Normalization must iterate fields and groups in object order, accept only non-empty field/group names, reject `DEFAULT_GROUP_KEY`, and retain only unique non-negative integer slots. Reconciliation must clone only when adding assignments; allocate with a `lowestUnusedSlot(Set<number>)` helper.

- [ ] **Step 4: Normalize loaded and updated items**

Update `normalizeItem()` in `useGraphBuilderStore.ts`:

```ts
function normalizeItem(item: GraphBuilderItem): GraphBuilderItem {
  const groupThemeSlots = normalizeGroupThemeSlots(item.groupThemeSlots);
  return {
    ...item,
    sampling: normalizeSampling(item.sampling),
    groupThemeSlots: Object.keys(groupThemeSlots).length > 0 ? groupThemeSlots : undefined,
  };
}
```

This keeps malformed opaque JSON from reaching renderers.

- [ ] **Step 5: Run focused tests**

Run the new identity test and existing `graphGroupOrder.test.ts` through the same esbuild/node harness. Expected: both pass and generated bundles are removed.

---

### Task 2: Graph Builder Owns And Persists Slot Assignment

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphGroupOrder.ts`
- Test: `tests/graphThemeIdentity.test.ts`
- Test: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: `reconcileGroupThemeSlots()` and `groupThemeSlot()` from Task 1.
- Produces: complete `effectiveStyles` keyed by active group, with automatic colors selected by persistent slot.
- Persists: `GraphBuilderItem.groupThemeSlots` via the existing `updateItem()` path.

- [ ] **Step 1: Add Palette-resolution and remount tests**

Extend `graphThemeIdentity.test.ts` with a pure resolver exported from `GraphBuilderView`'s current style logic or, preferably, moved into `graphThemeIdentity.ts`:

```ts
export function buildEffectiveGroupStyles(
  activeKeys: readonly string[],
  slots: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  userStyles: GroupStyleMap,
  customPalettes: readonly CustomPalette[],
  hasBoxplot: boolean,
): GroupStyleMap;
```

Assert:

```ts
const before = buildEffectiveGroupStyles(
  ["EV", "EV1", "EV2", "TC1.6"], slots, "Build", {}, [], true,
);
const afterRemount = buildEffectiveGroupStyles(
  ["EV", "EV1", "TC1.6"], slots, "Build", {}, [], true,
);
assert.deepEqual(afterRemount["TC1.6"], before["TC1.6"]);
```

Add a custom Palette case where changing Palette colors changes resolved colors but `groupThemeSlot()` remains unchanged. Add a partial user override case proving only the overridden mark wins.

- [ ] **Step 2: Verify the tests fail for the current index-based style builder**

Run `graphThemeIdentity.test.ts`. Expected: FAIL because no exported slot-based effective style builder exists.

- [ ] **Step 3: Replace the component-local registry**

In `GraphBuilderView.tsx`:

- Define `groupingField = encoding.color || encoding.overlay`.
- Discover active keys for that field from raw chunks, aggregate packets, and `frame.dictionaries.group` using `resolveStableGroupKeys()`.
- Remove `groupSlotRegistryRef` and `mergeStableGroupSlots()` usage.
- Compute `resolvedThemeSlots = reconcileGroupThemeSlots(item.groupThemeSlots, groupingField?.name, activeKeys)`.
- Build automatic styles with `groupThemeSlot()` rather than `groupKeys.forEach(... idx)`.
- Keep legend iteration limited to active keys.

Persist only actual changes:

```ts
useEffect(() => {
  if (readOnly || resolvedThemeSlots === item.groupThemeSlots) return;
  updateItem(item.id, { groupThemeSlots: resolvedThemeSlots });
  markDirty();
}, [item.id, item.groupThemeSlots, resolvedThemeSlots, readOnly, updateItem, markDirty]);
```

Use the repository's actual read-only selector/prop at this location; do not call `updateItem()` in read-only mode because it invokes `assertProjectMutable()`.

- [ ] **Step 4: Preserve save/load identity**

Extend `useProjectStore.saveLifecycle.test.ts` with a Graph Builder item containing:

```ts
groupThemeSlots: { Build: { EV: 0, EV1: 1, EV2: 2, "TC1.6": 3 } }
```

Assert the opened item and captured save request preserve the map exactly. The backend remains unchanged because `graphBuilders` is opaque JSON.

- [ ] **Step 5: Run focused tests**

Run `graphThemeIdentity.test.ts`, `graphGroupOrder.test.ts`, and `useProjectStore.saveLifecycle.test.ts` with their established Node harnesses. Expected: all pass.

---

### Task 3: Enforce The Unified 2D Renderer Contract

**Files:**
- Modify: `src/graphCore/transform.ts`
- Test: `tests/transformAggregatePackets.test.ts`
- Test: `tests/graphLayerConfig.test.ts`

**Interfaces:**
- Consumes: complete `GraphSpec.styles` for every active grouped key.
- Produces: every grouped 2D series with explicit colors derived from `spec.styles[groupKey]`.
- Must not use current series index as color identity.

- [ ] **Step 1: Add a layer-order and missing-group matrix**

In `transformAggregatePackets.test.ts`, create fixed complete styles for `EV`, `EV1`, `EV2`, and `TC1.6` with unmistakable line/fill/point/gradient colors. Build equivalent options for these element configurations:

```ts
["boxplot"]
["boxplot", "points"]
["points", "boxplot"]
["line", "bar", "smoother", "fitline"]
["histogram", "points"]
["heatmap"]
```

Use production-shaped aggregate-only and frame-backed data where `EV2` is absent from one frame. For every emitted series belonging to `TC1.6`, assert its item/line/area color equals the matching mark from `spec.styles["TC1.6"]` regardless of configuration order.

- [ ] **Step 2: Verify red on bypassing paths**

Run the transform aggregate test. Expected: at least heatmap or another direct `theme.categorical[colorIndex]` path fails its concrete style assertion.

- [ ] **Step 3: Route every grouped 2D element through resolved styles**

In `transform.ts`, centralize lookup near `colorIndexOf()`:

```ts
const resolvedStyleFor = (groupKey: string) => {
  const fallbackColor = theme.categorical[colorIndexOf(groupKey) % theme.categorical.length];
  return resolveGroupStyle(groupKey, fallbackColor, !!grouping, theme, spec.styles);
};
```

Replace grouped element-local direct Palette access with the corresponding `line`, `fill`, `point`, or `gradient` mark from this helper. Keep fallback behavior for callers outside Graph Builder and preserve ungrouped defaults.

Ensure these paths are covered explicitly: packet and legacy boxplot/outliers, frame scatter, standard points/line/bar, histogram, smoother, fitline/confidence band, heatmap/correlation heatmap where grouping applies, and legend swatches.

- [ ] **Step 4: Run 2D regression tests**

Run:

```powershell
npx esbuild tests/transformAggregatePackets.test.ts --bundle --platform=node --format=esm --outfile=tests/transformAggregatePackets.bundle.mjs
node tests/transformAggregatePackets.bundle.mjs
Remove-Item tests/transformAggregatePackets.bundle.mjs -Force

npx esbuild tests/graphLayerConfig.test.ts --bundle --platform=node --format=esm --outfile=tests/graphLayerConfig.bundle.mjs
node tests/graphLayerConfig.bundle.mjs
Remove-Item tests/graphLayerConfig.bundle.mjs -Force
```

Expected: both pass with no generated files left behind.

---

### Task 4: Enforce The Unified 3D And Lifecycle Contract

**Files:**
- Modify: `src/graphCore/threeD.ts`
- Modify only if required by the tested contract: `src/graphCore/Chart3D.tsx`
- Test: `tests/threeD.test.ts`
- Test: `tests/graphThemeIdentity.test.ts`

**Interfaces:**
- Consumes: the same complete `GraphSpec.styles` map used by 2D.
- Produces: scatter3d, surface, contour3d, and 3D error visuals whose colors are keyed by group identity, independent of frame encounter order.

- [ ] **Step 1: Add 3D rebuild tests**

In `threeD.test.ts`, build two equivalent frames with reversed `dictionaries.group` and raw chunk encounter order. Supply fixed styles for `EV`, `EV1`, `EV2`, and `TC1.6`; omit `EV2` from one frame. Assert concrete colors for:

```ts
["scatter3d"]
["surface"]
["contour3d"]
["surface", "scatter3d"]
["scatter3d", "surface", "contour3d"]
```

For each configuration, `TC1.6` must retain its gradient/line identity. Rebuilding 2D then 3D then 2D from the same spec must produce the same per-group color map.

- [ ] **Step 2: Verify red on encounter-order dependence**

Run `threeD.test.ts`. Expected: a frame/group-order case fails before renderer cleanup.

- [ ] **Step 3: Remove renderer-local color identity decisions**

In `threeD.ts`, keep local group order only for series ordering. Resolve each group's color directly from `spec.styles[groupKey]`; use existing fallback only for non-Graph Builder callers that do not provide styles. Ensure surface, scatter, contour, error bars, and bands all use the same keyed style.

No `Chart3D` state should retain theme identity. It may continue rebuilding/disposal with `notMerge=true` because identity now travels in the spec.

- [ ] **Step 4: Run 3D and identity tests**

Run `threeD.test.ts` and `graphThemeIdentity.test.ts` through esbuild/node. Expected: both pass and bundles are removed.

---

### Task 5: End-To-End Verification And Issue Evidence

**Files:**
- Modify only if failures identify a contract gap: files from Tasks 1-4.
- Verify: all focused tests above.

**Interfaces:**
- Consumes: persistent slot identity and unified renderer contract.
- Produces: evidence suitable for issue 64 showing stable colors across every reported transition.

- [ ] **Step 1: Run the full focused matrix**

Run and clean bundles for:

```text
tests/graphThemeIdentity.test.ts
tests/graphGroupOrder.test.ts
tests/transformAggregatePackets.test.ts
tests/threeD.test.ts
tests/graphLayerConfig.test.ts
tests/useProjectStore.saveLifecycle.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
npx vite build 2>&1 | Select-Object -Last 10
```

Expected: exit 0 and `built in` output.

Also run `npx tsc -b --pretty false`. If the branch still has the known unrelated `correlationMatrix`/`rawPoints.ts` errors, record them verbatim and confirm no diagnostics point to the new identity module or changed code regions.

- [ ] **Step 3: Manually reproduce issue 64 transitions**

Start `npm run tauri -- dev` and verify one graph with at least four groups, including a group that is absent from one layer:

1. Record group colors with boxplot only.
2. Add points, remove points, and reverse layer order.
3. Hide/unhide a middle group.
4. Switch Full/Sample and apply/remove a filter.
5. Open another 3D Graph Builder and return.
6. Open a Table and return.
7. Toggle current graph between 2D and 3D where valid.
8. Save, close, reopen, and compare colors.
9. Edit a custom Palette: colors should update, but every group must retain its slot-relative identity.

Expected: no group exchanges color identity during any transition.

- [ ] **Step 4: Review final diff**

Confirm:

- `groupSlotRegistryRef` is gone.
- `groupThemeSlots` is the only automatic identity owner.
- no automatic RGB values are persisted in `groupStyles`.
- all grouped renderer paths set explicit colors.
- no Rust or IPC schema change exists.
- temporary bundles and build artifacts are not tracked.

- [ ] **Step 5: Prepare issue update**

Summarize the root cause, persistent identity model, renderer coverage, automated test results, and manual transition matrix. Do not post or commit until the user explicitly requests it.

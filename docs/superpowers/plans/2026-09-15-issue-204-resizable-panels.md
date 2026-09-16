# Issue 204 Resizable Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every major panel boundary named in Issue 204 one bounded, persistent, pointer- and keyboard-accessible resize behavior.

**Architecture:** A controlled `PanelSplitter` normalizes pointer, keyboard, reset, and ARIA behavior while each owning layout retains pane rendering and responsive rules. A Zustand `useLayoutPreferencesStore` persists only committed numeric sizes in one defensive versioned `localStorage` record; consumers keep transient drag values locally and clamp them to current container bounds.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, CSS flex/grid, Playwright Component Testing 1.55, Node/tsx tests.

**Spec:** `docs/superpowers/specs/2026-09-15-issue-204-resizable-panels-design.md`

## Global Constraints

- Do not add a third-party resizing dependency or touch Rust/Tauri/DuckDB code.
- Use storage key `sp-layout-preferences-v1` and the exact closed `LayoutPanelId` union from the spec.
- Pointer moves update only local component state; persist only on commit or reset.
- Every separator supports pointer capture, clamping, double-click reset, Enter reset, Arrow step 8, Shift+Arrow step 32, Home/End, and complete separator ARIA semantics.
- Preserve existing defaults and bounds for Graph Builder, Data Table, and History/Snapshot.
- Preserve existing Analysis and Tabulate narrow layouts and hide desktop splitters there.
- Keep project state clean: layout changes never call `markDirty` and never enter `.spprj` payloads.
- Follow TDD for every production behavior: run the named focused test red before implementation and green afterward.
- Do not commit or push unless Ashton explicitly requests it.

---

### Task 1: Shared Splitter And Layout Preference Store

**Files:**
- Create: `src/components/layout/PanelSplitter.tsx`
- Create: `src/components/layout/panelSplitter.css`
- Create: `src/components/layout/index.ts`
- Create: `src/stores/useLayoutPreferencesStore.ts`
- Create: `tests/PanelSplitterHarness.tsx`
- Create: `tests/panelSplitter.spec.tsx`
- Create: `tests/layoutPreferencesStore.test.ts`

**Interfaces:**
- Produces: `PanelSplitterOrientation`, `PanelSplitterProps`, and `PanelSplitter` with the exact prop contract in the spec.
- Produces: `LayoutPanelId`, `LayoutPreferences`, `readLayoutPreferences(storage)`, `useLayoutPreferencesStore`, `setPanelSize(id, value)`, and `resetPanelSize(id)`.
- Storage defaults are consumer-owned; the store returns `undefined` for an unset ID.

- [ ] **Step 1: Write failing preference-store tests**

Cover a valid versioned object, rejection of unknown/non-finite entries, malformed JSON, throwing storage, one persisted setter call, and reset removal. Use an in-memory `Storage` implementation and import the pure parser before testing the Zustand actions.

```ts
assert.deepEqual(readLayoutPreferences(storage), {
  "workspace.sidebar": 320,
  "history.stack": 60,
});
useLayoutPreferencesStore.getState().setPanelSize("workspace.sidebar", 336);
assert.equal(readPersisted()["workspace.sidebar"], 336);
```

- [ ] **Step 2: Run the store test red**

Run: `npx tsx --tsconfig tsconfig.app.json tests/layoutPreferencesStore.test.ts`

Expected: FAIL because `useLayoutPreferencesStore.ts` does not exist.

- [ ] **Step 3: Implement the defensive layout preference store**

Define the exact ID union, validate `version === 1`, retain only known finite numeric values, catch all storage failures, and write `{ version: 1, sizes }`. Zustand actions update memory even when persistence fails.

- [ ] **Step 4: Run the store test green**

Run: `npx tsx --tsconfig tsconfig.app.json tests/layoutPreferencesStore.test.ts`

Expected: PASS with a final success marker and exit code 0.

- [ ] **Step 5: Write failing PanelSplitter component tests**

Mount a stateful module-level harness and assert vertical/horizontal pointer deltas, `direction=-1`, min/max clamps, one commit on pointerup, cancellation cleanup, double-click/Enter reset, active-axis Arrow and Shift+Arrow increments, Home/End, role, orientation, and current/min/max ARIA values.

```tsx
await expect(component.getByRole("separator", { name: "Resize test panel" }))
  .toHaveAttribute("aria-valuenow", "240");
await separator.press("Shift+ArrowRight");
await expect(separator).toHaveAttribute("aria-valuenow", "272");
```

- [ ] **Step 6: Run the component test red**

Run: `npx playwright test -c playwright-ct.config.ts tests/panelSplitter.spec.tsx`

Expected: FAIL because `PanelSplitter` does not exist.

- [ ] **Step 7: Implement the controlled PanelSplitter**

Use pointer capture on the separator, refs for drag origin/latest value, one `finishDrag(commit)` cleanup path, `useEffect` unmount cleanup, axis-specific keyboard handling, and a clamping helper. Render a focusable separator with all required ARIA attributes; import shared CSS through `src/components/layout/index.ts` or the component module.

- [ ] **Step 8: Run both Task 1 tests green**

Run: `npx tsx --tsconfig tsconfig.app.json tests/layoutPreferencesStore.test.ts && npx playwright test -c playwright-ct.config.ts tests/panelSplitter.spec.tsx`

Expected: all tests pass with exit code 0.

### Task 2: Workspace And Workflow Global Side Panel

**Files:**
- Create: `src/components/layout/WorkspaceFrame.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/App.css`
- Create: `tests/WorkspaceFrameHarness.tsx`
- Create: `tests/workspaceFrame.spec.tsx`

**Interfaces:**
- Consumes: `PanelSplitter` and `useLayoutPreferencesStore` from Task 1.
- Produces: `WorkspaceFrame({ activityBar, sidePanel, children })`, the production owner of `workspace.sidebar`.
- Workspace sizing: default 240px, minimum 200px, maximum `min(480px, containerWidth * 0.4)`.

- [ ] **Step 1: Write the failing WorkspaceFrame geometry test**

Mount the real production frame in a fixed-width harness. Assert the 240px initial side panel, pointer resize, persisted remount value, maximum at 40% of container width, double-click reset, and that main content retains the remaining width.

- [ ] **Step 2: Run the WorkspaceFrame test red**

Run: `npx playwright test -c playwright-ct.config.ts tests/workspaceFrame.spec.tsx`

Expected: FAIL because `WorkspaceFrame` does not exist.

- [ ] **Step 3: Implement and integrate WorkspaceFrame**

Observe the `.workspace` container with `ResizeObserver`, clamp the local width on measurement changes, render the vertical separator between side panel and main content, and commit/reset through `workspace.sidebar`. Replace only Workspace's outer activity/side/main layout markup; keep every existing tab and main-view branch unchanged. Remove `.side-panel { width: 240px; }` in favor of the controlled inline CSS variable or flex basis.

- [ ] **Step 4: Run focused Workspace tests green**

Run: `npx playwright test -c playwright-ct.config.ts tests/workspaceFrame.spec.tsx && npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts`

Expected: frame and existing Workspace contracts pass.

### Task 3: Analysis Summary And Results Boundary

**Files:**
- Modify: `src/components/analysis/presentation/AnalysisShell.tsx`
- Modify: `src/components/analysis/presentation/analysisPresentation.css`
- Modify: `tests/AnalysisShellHarness.tsx`
- Modify: `tests/analysisShell.spec.tsx`

**Interfaces:**
- Consumes: Task 1 splitter/store.
- Owns: `analysis.summary`, default 280px, minimum 240px, maximum `min(480px, shellWidth * 0.45)`.
- Preserves: existing `resultsRef`, summary semantics, Edit Inputs behavior, and single-column narrow breakpoint.

- [ ] **Step 1: Add failing AnalysisShell resize tests**

Extend the existing harness with a stable container width and a controllable narrow viewport. Assert desktop resize and persisted remount, 45% clamp, result readability, required separator semantics, and absence of the separator at the existing narrow breakpoint.

- [ ] **Step 2: Run the AnalysisShell test red**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisShell.spec.tsx`

Expected: new separator assertions fail while the two existing tests still pass.

- [ ] **Step 3: Implement AnalysisShell resizing**

Add a shell ref and container measurement, local summary width, store initialization/commit/reset, and a conditional `PanelSplitter`. Change the desktop grid to `var(--analysis-summary-width) auto minmax(0, 1fr)` with a zero-layout-width splitter track; retain the existing narrow single-column rule and hide/omit the splitter under that mode.

- [ ] **Step 4: Run the scoped Analysis UI gate green**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisShell.spec.tsx && npm run test:analysis:ui`

Expected: all Analysis UI tests pass.

### Task 4: Tabulate Three-Pane Layout

**Files:**
- Create: `src/components/tabulate/TabulateLayout.tsx`
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `src/components/tabulate/tabulate.css`
- Create: `tests/TabulateLayoutHarness.tsx`
- Create: `tests/tabulateLayout.spec.tsx`

**Interfaces:**
- Consumes: Task 1 splitter/store.
- Produces: `TabulateLayout({ fields, configuration, results, narrow })` used by `TabulateView`.
- Owns: `tabulate.fields` at 300/240/420px and `tabulate.configuration` at 360/320/520px; result minimum is 320px.

- [ ] **Step 1: Write failing TabulateLayout tests**

Mount the production layout at desktop and narrow widths. Assert two separators on desktop, independent resize/persistence/reset, result width at least 320px after extreme drags, dynamic re-clamp after container shrink, and zero separators in narrow mode.

- [ ] **Step 2: Run the Tabulate layout test red**

Run: `npx playwright test -c playwright-ct.config.ts tests/tabulateLayout.spec.tsx`

Expected: FAIL because `TabulateLayout` does not exist.

- [ ] **Step 3: Implement and integrate TabulateLayout**

Move only the three top-level pane wrappers from `TabulateView` into slots passed to `TabulateLayout`. Observe container width and compute maxima so `fields + configuration + splitter tracks + 320px results` fits. Preserve the current `isNarrow` and `showFieldsOnNarrow` behavior; when narrow, render the existing collapsed layout without splitters and do not modify stored desktop values.

- [ ] **Step 4: Run focused Tabulate tests green**

Run: `npx playwright test -c playwright-ct.config.ts tests/tabulateLayout.spec.tsx && npx tsx --tsconfig tsconfig.app.json tests/tabulateResult.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts`

Expected: layout, helper, and Workspace wiring tests pass.

### Task 5: Graph Builder Splitter Migration

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Create: `tests/GraphBuilderSplittersHarness.tsx`
- Create: `tests/graphBuilderSplitters.spec.tsx`

**Interfaces:**
- Consumes: Task 1 splitter/store.
- Owns: `graphBuilder.filter`, `graphBuilder.leftRail`, `graphBuilder.rightRail`, and `graphBuilder.leftStack`.
- Preserves: width bounds 160-500px, left-stack bounds 15-85%, existing defaults, and right-rail `direction=-1` behavior.

- [ ] **Step 1: Write failing Graph Builder splitter tests**

Create a module-level harness that exercises the same four production-controlled splitter configurations. Assert left/right direction, pixel and percentage units, persistence, and reset. Add a source contract assertion that `startSideResize`, `startLeftRowResize`, `document.addEventListener("mousemove"`, and legacy `.gb-splitter` elements are absent after migration.

- [ ] **Step 2: Run the Graph Builder tests red**

Run: `npx playwright test -c playwright-ct.config.ts tests/graphBuilderSplitters.spec.tsx && npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSlotLayout.test.ts`

Expected: new migration assertions fail against the legacy handlers.

- [ ] **Step 3: Replace all Graph Builder resize handlers**

Initialize the four local states from preferences, replace splitter divs with `PanelSplitter`, commit/reset through the matching IDs, use `direction=-1` for the right rail, and remove only obsolete splitter CSS/handlers. Do not change graph requests, slots, drag/drop, rendering, or loading behavior.

- [ ] **Step 4: Run focused Graph Builder tests green**

Run: `npx playwright test -c playwright-ct.config.ts tests/graphBuilderSplitters.spec.tsx && npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSlotLayout.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts`

Expected: splitter and existing Graph Builder contracts pass.

### Task 6: Data Table Panel Splitter Migration

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/App.css`
- Modify: `tests/DataTableViewPropertyManagerHarness.tsx`
- Create: `tests/dataTableSplitters.spec.tsx`

**Interfaces:**
- Consumes: Task 1 splitter/store.
- Owns: `table.filter` default 260px with bounds 200-500px, and `table.columns` default 200px with bounds 120-600px.
- Preserves: columns collapse behavior, table virtualization, filter behavior, and property-manager refresh behavior.

- [ ] **Step 1: Write failing Data Table splitter tests**

Extend the production DataTable harness only as needed to expose Filter and Columns. Assert both separator labels, bounds, committed remount values, and double-click reset. Add a migration assertion that the two inline `document` mouse-listener blocks and legacy splitter divs are absent.

- [ ] **Step 2: Run the Data Table tests red**

Run: `npx playwright test -c playwright-ct.config.ts tests/dataTableSplitters.spec.tsx`

Expected: new separator/migration assertions fail against the legacy implementation.

- [ ] **Step 3: Replace Data Table resize handlers**

Initialize local widths from the preference store, replace both splitter divs with `PanelSplitter`, preserve collapsed Columns behavior, and remove obsolete `.sp-cols-panel-splitter` rules only after no consumer remains. Keep table column resizing separate and untouched.

- [ ] **Step 4: Run focused Data Table tests green**

Run: `npx playwright test -c playwright-ct.config.ts tests/dataTableSplitters.spec.tsx tests/tablePropertyManagerRequest.test.ts && npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts`

Expected: splitter, property-manager, and viewport tests pass.

### Task 7: History And Snapshot Splitter Migration

**Files:**
- Modify: `src/components/HistoryPanel.tsx`
- Modify: `src/App.css`
- Create: `tests/HistoryPanelHarness.tsx`
- Create: `tests/historyPanel.spec.tsx`

**Interfaces:**
- Consumes: Task 1 splitter/store.
- Owns: `history.stack`, default 60%, minimum 15%, maximum 85%.
- Preserves: history timeline, snapshot actions, menus, and section rendering.

- [ ] **Step 1: Write failing HistoryPanel resize tests**

Mount the production panel with deterministic store fixtures. Assert the horizontal separator, 15-85% clamp, persisted remount, reset to 60%, keyboard behavior, and that both sections remain visible. Add a migration assertion that `handleDividerMouseDown`, `draggingRef`, and document mouse listeners are absent.

- [ ] **Step 2: Run the HistoryPanel test red**

Run: `npx playwright test -c playwright-ct.config.ts tests/historyPanel.spec.tsx`

Expected: separator and migration assertions fail against the legacy mouse handler.

- [ ] **Step 3: Replace HistoryPanel resize handling**

Remove `draggingRef` and the document listener lifecycle, initialize `historyPct` from preferences, render `PanelSplitter orientation="horizontal" unit="%"`, and preserve the two existing flex bases.

- [ ] **Step 4: Run focused History tests green**

Run: `npx playwright test -c playwright-ct.config.ts tests/historyPanel.spec.tsx && npx tsx --tsconfig tsconfig.app.json tests/historyTimeline.test.ts`

Expected: panel and timeline tests pass.

### Task 8: Integrated Acceptance And Cleanup

**Files:**
- Modify only files already touched when a validation failure proves a local defect.
- Verify: all files from Tasks 1-7.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one verified Issue 204 branch with no duplicate panel-resize handlers.

- [ ] **Step 1: Run the combined new component suite**

Run: `npx playwright test -c playwright-ct.config.ts tests/panelSplitter.spec.tsx tests/workspaceFrame.spec.tsx tests/analysisShell.spec.tsx tests/tabulateLayout.spec.tsx tests/graphBuilderSplitters.spec.tsx tests/dataTableSplitters.spec.tsx tests/historyPanel.spec.tsx`

Expected: all new and extended component tests pass.

- [ ] **Step 2: Run preference and adjacent contract tests**

Run: `npx tsx --tsconfig tsconfig.app.json tests/layoutPreferencesStore.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts && npx tsx --tsconfig tsconfig.app.json tests/tabulateResult.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphBuilderSlotLayout.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts && npx tsx --tsconfig tsconfig.app.json tests/tableViewport.test.ts && npx tsx --tsconfig tsconfig.app.json tests/historyTimeline.test.ts`

Expected: all contract tests pass.

- [ ] **Step 3: Run the Analysis UI gate and production build**

Run: `npm run test:analysis:ui && npm run build`

Expected: both commands exit 0 with no TypeScript or Vite build errors.

- [ ] **Step 4: Audit removal and requirements**

Search touched owners for `startSideResize`, `startLeftRowResize`, `handleDividerMouseDown`, resize-only `document.addEventListener("mousemove"`, `.gb-splitter`, and `.sp-cols-panel-splitter`. Confirm no migrated resize path remains and every `LayoutPanelId` has exactly one owning consumer.

- [ ] **Step 5: Request final whole-branch code review**

Provide the reviewer the approved spec, this plan, the complete diff from baseline `bdad63deecd13811eed99810808cbbda01c5842a`, and fresh Task 8 validation results. Resolve every critical or important finding, then rerun the affected focused tests and the production build.
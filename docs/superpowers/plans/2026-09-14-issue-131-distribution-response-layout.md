# Issue 131 Distribution Response Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Distribution Analysis as an outer By-group tree containing independent response report trees and isolated per-response graphs.

**Architecture:** Keep the existing Rust `groups[].yResults[]` and graph packets as the statistical authority. Add a pure TypeScript graph-frame selector for one backend group and response, then make `DistributionAnalysisResults` render the selected graph beside the matching response's existing report blocks through shared Analysis primitives.

**Tech Stack:** React 19, TypeScript, Playwright Component Testing, ECharts graph frames, Tauri-provided Distribution payloads.

**Spec:** `docs/superpowers/specs/2026-09-14-issue-131-distribution-response-layout-design.md`

## Global Constraints

- Visible order is `By Group → Response → Distribution / Overall / Continuous Fit / Process Capability` when By is configured.
- Without By, Response is the outermost visible result node.
- Every Distribution graph contains only its current response and current group.
- Preserve backend group order: all-data Overall first, then By values, including Missing.
- React must not recompute bins, quartiles, fit curves, capability indices, or intervals.
- Keep the Analysis document, presentation, and `.spprj` archive schemas unchanged.
- Axis settings remain shared persisted presentation state and do not increment `configRevision`.
- Use only shared `AnalysisFrame`, `AnalysisStack`, `AnalysisText`, `AnalysisTable`, and `AnalysisGraph` presentation primitives.

---

### Task 1: Select One Response And Group Graph Frame

**Files:**
- Modify: `src/graphCore/distributionAdapter.ts`
- Test: `tests/distributionGraphAdapter.test.ts`

**Interfaces:**
- Consumes: `DistributionGroupResult`, `DistributionReportResponse["graphFrames"]`, and existing aggregate packet types.
- Produces: `getDistributionGroupName(group: DistributionGroupResult): string` and `getDistributionResponseCompositeGraphFrame(response, group): GraphDataFrame` where `response` is `Pick<DistributionReportResponse, "graphFrames">` plus response/group identity arguments.

- [ ] **Step 1: Expand the adapter fixture to two responses and two groups**

Add DIM1 and DIM2 histogram bins, fitted curves, and box entries for `Overall` and `Site=A`. Preserve the current aggregate packet shapes and use backend-compatible identities:

```ts
const overallGroup: DistributionGroupResult = {
  groupKey: [],
  groupNames: [],
  yResults: [],
};
const siteAGroup: DistributionGroupResult = {
  groupKey: [{ kind: "text", value: "A" }],
  groupNames: ["Site"],
  yResults: [],
};
```

- [ ] **Step 2: Write failing isolation assertions**

Assert that selecting DIM2 + Site=A returns exactly one DIM2 Site=A histogram bin, fitted curve, and box entry; contains no DIM1 or Overall packets; keeps normalized `__sp_variable__` category semantics; and does not mutate either source frame.

Also select a missing response/group pair and assert the result is a valid frame with no non-empty aggregate packets.

- [ ] **Step 3: Run the adapter test and verify RED**

Run:

```bash
npm run test:distribution:adapter
```

Expected: FAIL because the response/group frame selector and group-name helper do not exist.

- [ ] **Step 4: Implement stable group identity and packet filtering**

Implement backend-compatible values without localized display formatting:

```ts
export function getDistributionGroupName(group: DistributionGroupResult): string {
  if (group.groupKey.length === 0) return "Overall";
  return group.groupNames
    .map((name, index) => `${name}=${graphGroupValue(group.groupKey[index])}`)
    .join(", ");
}
```

The private `graphGroupValue` maps missing to `Missing`, date-time to
`String(utcMillis)`, and boolean/number/text to `String(value)`, matching Rust
`graph_group_value`.

Add a selector with an explicit interface:

```ts
export function getDistributionResponseCompositeGraphFrame(
  response: Pick<DistributionReportResponse, "graphFrames">,
  responseName: string,
  group: DistributionGroupResult,
): GraphDataFrame;
```

Filter histogram bins and box entries by `sourceColumn === responseName`,
`category === groupName`, and `group === seriesName`. Filter fitted curves by
`sourceColumn === responseName` and `group === seriesName`, where `seriesName`
is `responseName` for Overall and `${responseName} | ${groupName}` otherwise.
Recompute packet metadata (`binCount`, `totalCount`, min/max, bin width) from
the retained backend bins only; this is frame metadata maintenance, not
statistical recomputation. Drop empty fitted-curve packets and normalize the
filtered histogram/box categories through the existing composite helper.

- [ ] **Step 5: Run the adapter test and verify GREEN**

Run:

```bash
npm run test:distribution:adapter
```

Expected: PASS with response/group isolation and source immutability proven.

- [ ] **Step 6: Run focused type and graph regressions**

Run:

```bash
npm run test:distribution:typecheck
npm run test:distribution:contracts
```

Expected: both commands exit 0.

---

### Task 2: Render The Confirmed By-Group And Response Tree

**Files:**
- Create: `src/components/analysis/renderers/DistributionAnalysisReportTree.tsx`
- Modify: `src/components/analysis/renderers/DistributionAnalysisResults.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `tests/AnalysisViewHarness.tsx`
- Test: `tests/analysisView.spec.tsx`
- Test: `tests/distributionReportWiring.test.ts`

**Interfaces:**
- Consumes: successful `DistributionReportResponse`, persisted Distribution graph definitions, `DatasetMeta`, Analysis graph runtime, and `onGraphConfigChange`.
- Produces: `DistributionAnalysisReportTree` that directly composes shared Analysis primitives and renders each response with an isolated graph and response-owned report sections.

- [ ] **Step 1: Add a multi-response/no-By harness mode**

Extend `AnalysisViewHarnessProps["mode"]` with `"multiResponse"`. Build a
document with `301A-F01`, `301A-F02`, and `301A-F03`, and a response whose
single ungrouped `DistributionGroupResult` contains three `yResults`. Give each
response distinct quantile values and graph packet `sourceColumn` values.

Enhance the test graph renderer with stable outputs keyed by the embedded graph
item ID:

```tsx
<output data-testid={`graph-sources:${graphItem.id}`}>
  {collectGraphSources(externalDataState?.frame).join(",")}
</output>
```

- [ ] **Step 2: Write the no-By structure test**

Assert:

- top-level result frames are exactly `301A-F01`, `301A-F02`, `301A-F03`;
- no comma-joined response frame and no `Statistical Report` frame exists;
- each response contains one `Distribution` graph and one `Overall` section;
- each graph output contains only the matching response source;
- the first-response-only `n = ..., mean = ...` prose is absent.

- [ ] **Step 3: Add a multi-response/By harness mode and failing test**

Extend the harness with `"multiResponseBy"`. Add groups in this exact backend
order: ungrouped Overall, `Site=A`, `Site=B`, Missing. Each group contains all
three responses and graph packets with matching backend group/category names.

Assert the outermost frames are `Overall`, `Site = A`, `Site = B`, `Site =
Missing`; each contains the same three response frames in definition order;
and every graph is isolated to its owning response and group.

- [ ] **Step 4: Run the component tests and verify RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree"
```

Expected: FAIL because the current renderer creates one combined graph and a
separate group-first report frame.

- [ ] **Step 5: Expose response-owned report section composition**

Refactor `DistributionReport.tsx` without changing table content. Export a
focused component:

```ts
export interface DistributionResponseReportProps {
  result: DistributionYResultV1;
}

export function DistributionResponseReport(
  props: DistributionResponseReportProps,
): JSX.Element;
```

It renders `Overall` around Quantiles, Location, and Variation, followed by
Continuous Fit frames and Process Capability. Keep standalone legacy report
blocks on the existing `DistributionReport` path only; the Analysis tree uses
the nested `result.blocks` that already own response identity.

- [ ] **Step 6: Implement `DistributionAnalysisReportTree`**

Render groups only when `item.definition.analysis.by.length > 0`; otherwise
render the first ungrouped group's responses directly. For each response:

- key by `groupIdentity + yColumn.columnId`;
- build one graph item whose ID includes both stable identities;
- call `createDistributionGraphBuilderConfig` with `[response field]`;
- map execution success through `getDistributionResponseCompositeGraphFrame`;
- render `AnalysisGraph title="Distribution"` followed by
  `DistributionResponseReport`.

Use the response definition's field object matched by `yColumn.columnId` first,
then fall back to a unique name match. If neither resolves, render localized
unavailable text and do not borrow another response's graph configuration.

- [ ] **Step 7: Replace the global graph/text/report composition**

In `DistributionAnalysisResults.tsx`, keep `AnalysisShell`, execution state,
axis-dialog wiring, loading/error states, and graph persistence callbacks.
Remove the comma-joined response document frame, the one global graph, the
first-result prose summary, and the global Statistical Report frame. Delegate
successful result composition to `DistributionAnalysisReportTree`.

The shared axis dialog remains one document-level dialog because all response
graphs derive from the same persisted presentation settings.

- [ ] **Step 8: Strengthen source contracts**

Update `distributionReportWiring.test.ts` to require
`DistributionAnalysisReportTree`, `DistributionResponseReport`, and direct use
of shared Analysis primitives. Continue rejecting raw `<table>`, `<details>`,
legacy Distribution view/store imports, and frontend statistical computation.

- [ ] **Step 9: Run component and report tests and verify GREEN**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree|configRevision-only changes|Distribution response axis"
npm run test:distribution:report
```

Expected: all selected component tests and report wiring pass.

- [ ] **Step 10: Run the full Analysis component suite**

Run:

```bash
npm run test:analysis:ui
```

Expected: all Analysis component tests pass with no shared-primitive regression.

---

### Task 3: Visual Acceptance And Full Regression Gate

**Files:**
- Modify: `tests/analysisView.spec.tsx`
- Modify only if required by captured evidence: `src/components/analysis/analysis.css`

**Interfaces:**
- Consumes: the response tree from Task 2.
- Produces: desktop and narrow-width visual evidence that nested frames and graphs remain bounded and usable.

- [ ] **Step 1: Add desktop and narrow-width layout assertions**

For `multiResponseBy`, set desktop and narrow viewports and assert each expanded
graph/table is contained by its response frame, text has no horizontal overflow,
and sibling response frames keep stable width after collapsing one response.

- [ ] **Step 2: Run visual assertions and verify their current result**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree.*layout"
```

If the new assertion fails because of clipping or overflow, retain the failure
as RED evidence and proceed to Step 3. If it passes with existing shared CSS,
do not modify CSS.

- [ ] **Step 3: Apply the smallest evidence-driven CSS correction when needed**

Limit any change to response-tree containment and narrow-width sizing in
`analysis.css`. Do not introduce a parallel Distribution presentation system,
nested decorative cards, viewport-scaled font sizes, or negative letter spacing.

- [ ] **Step 4: Re-run visual assertions**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree.*layout"
```

Expected: desktop and narrow-width assertions pass.

- [ ] **Step 5: Run the complete required gates**

Run:

```bash
npm run test:analysis
npm run test:distribution
npm run build
git diff --check
```

Expected: every command exits 0 with no failures or whitespace errors.

- [ ] **Step 6: Inspect final scope**

Confirm the diff contains only the approved spec/plan, focused adapter,
Distribution Analysis presentation, harness/tests, and evidence-driven CSS if
needed. Confirm there are no generated snapshots, caches, secrets, or unrelated
changes.

- [ ] **Step 7: Request independent review**

Dispatch a reviewer with Issue #131, the approved spec, base SHA `0765096`, and
the complete uncommitted diff. Fix every Critical or Important finding and
rerun the affected focused and full gates.

- [ ] **Step 8: Start manual acceptance build**

Launch the isolated worktree with:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/131-distrubution run tauri -- dev
```

Verify the process and frontend source belong to this worktree, then provide the
runtime URL and an acceptance checklist covering no-By, By, graph isolation,
collapse behavior, and persisted axis settings. Stop for user acceptance before
commit, push, or pull request creation.
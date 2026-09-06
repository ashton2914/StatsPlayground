# Analysis Composition Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Sample Distribution Analysis from recursive Frame, Table, Graph, Text, and Stack components.

**Architecture:** `src/components/analysis/presentation/` owns the reusable Analysis presentation vocabulary. Table and Graph compose the same Frame implementation; analysis modules only arrange components and map live backend results into their props. Compatibility exports preserve existing statistical callers during the sample migration.

**Tech Stack:** React 19, TypeScript, Playwright Component Testing, GraphRuntime, CSS

**Spec:** `docs/superpowers/specs/2026-09-04-analysis-composition-primitives-design.md`

## Global Constraints

- Rust execution results remain authoritative; do not add frontend statistical calculations.
- Do not change the `.span` persistence schema or persist runtime results.
- All framed hierarchy uses one `AnalysisFrame` implementation with a `6px` radius.
- `AnalysisGraph` renders `GraphRuntime` by default and preserves its interaction props.
- Migrate only the Sample Distribution Analysis and its Process Capability presentation.

---

### Task 1: Reusable Analysis Presentation Components

**Files:**
- Create: `src/components/analysis/presentation/AnalysisFrame.tsx`
- Create: `src/components/analysis/presentation/AnalysisTable.tsx`
- Create: `src/components/analysis/presentation/AnalysisGraph.tsx`
- Create: `src/components/analysis/presentation/AnalysisText.tsx`
- Create: `src/components/analysis/presentation/AnalysisStack.tsx`
- Create: `src/components/analysis/presentation/analysisPresentation.css`
- Create: `src/components/analysis/presentation/index.ts`
- Test: `tests/analysisPresentation.spec.tsx`

**Interfaces:**
- Produces: `AnalysisFrame({ title, children, defaultExpanded?, ...sectionProps })`
- Produces: `AnalysisTable({ title, columns, rows, width?, ariaLabel? })`
- Produces: `AnalysisGraph({ title, runtimeProps, renderGraph?, children? })`
- Produces: `AnalysisText({ children, ...paragraphProps })`
- Produces: `AnalysisStack({ direction?, children, ...divProps })`

- [ ] **Step 1: Write failing component tests**

Mount nested frames and assert that both titles render, collapsing the child
does not collapse the parent, `aria-expanded` changes, each `AnalysisTable`
owns one table, and numeric cells align right. Mount `AnalysisGraph` with a
render override and assert it receives the exact `item`, `dataset`,
`externalDataState`, `minPanelHeight`, and interaction callback references.

- [ ] **Step 2: Verify the tests fail for missing exports**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisPresentation.spec.tsx`

Expected: FAIL because `src/components/analysis/presentation` does not exist.

- [ ] **Step 3: Implement the minimal primitives**

Use a native button in the Frame title bar:

```tsx
const [expanded, setExpanded] = useState(defaultExpanded);
return (
  <section className="analysis-ui-frame" {...sectionProps}>
    <button
      aria-expanded={expanded}
      className="analysis-ui-frame-title"
      type="button"
      onClick={() => setExpanded((value) => !value)}
    >
      <span aria-hidden="true" className="analysis-ui-disclosure" />
      <span>{title}</span>
    </button>
    {expanded && <div className="analysis-ui-frame-body">{children}</div>}
  </section>
);
```

`AnalysisTable` composes that Frame around semantic table markup.
`AnalysisGraph` composes it around `GraphRuntime` and spreads `runtimeProps`
without translating axis or interaction behavior. `AnalysisText` remains
borderless. `AnalysisStack` applies only layout classes.

- [ ] **Step 4: Verify primitive tests pass**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisPresentation.spec.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/components/analysis/presentation tests/analysisPresentation.spec.tsx
git commit -m "feat(analysis): add composition primitives"
```

### Task 2: Migrate the Sample Analysis Composition

**Files:**
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `src/components/analysis/analysis.css`
- Modify: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: all presentation exports from Task 1.
- Preserves: `AnalysisViewRuntime.renderGraph` test seam and existing live execution fencing.

- [ ] **Step 1: Change the Sample structure test first**

Assert the top-level order remains graph, text, tables, process-capabilities.
Assert the response, Graph, Summary Statistical, and Process Capabilities are
all `.analysis-ui-frame` instances. Assert the graph frame contains two graph
roles and that toggling Summary Statistical hides its tables without hiding
Graph or Process Capabilities.

- [ ] **Step 2: Verify the new hierarchy assertions fail**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "configRevision-only changes"`

Expected: FAIL because the Sample still uses page-specific frame markup.

- [ ] **Step 3: Compose the Sample from primitives**

Replace the root article and Graph section with `AnalysisFrame`. Replace the
summary paragraph with `AnalysisText`, direct flex wrappers with
`AnalysisStack`, summary sections with nested `AnalysisFrame`, tables with
`AnalysisTable`, and graph rendering with `AnalysisGraph`. Keep graph item
creation, backend external frame mapping, and all execution state unchanged.

- [ ] **Step 4: Remove obsolete page-owned frame CSS and verify**

Delete `.analysis-frame`, `.analysis-frame-title`, and document frame visual
rules after their final consumers migrate. Keep only workspace geometry and
the graph composite layout in `analysis.css`.

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/components/analysis/AnalysisView.tsx src/components/analysis/analysis.css tests/analysisView.spec.tsx
git commit -m "refactor(analysis): compose sample from primitives"
```

### Task 3: Capability Compatibility Migration and Verification

**Files:**
- Modify: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: `src/components/statistical/StatisticalTable.tsx`
- Modify: `src/components/statistical/statisticalTable.css`
- Modify: `src/components/statistical/index.ts`
- Modify: `tests/statisticalTable.spec.tsx`
- Modify: `tests/distributionReportWiring.test.ts`

**Interfaces:**
- Consumes: `AnalysisFrame`, `AnalysisTable`, and `AnalysisStack` from Task 1.
- Preserves: `StatisticalSection`, `StatisticalTableList`, and `StatisticalTableFrame` compatibility exports.

- [ ] **Step 1: Add failing compatibility assertions**

Assert the three statistical exports render canonical
`.analysis-ui-frame`/`.analysis-ui-table` markup. Update the capability wiring
test to require `AnalysisTable` composition and continue forbidding raw
`<table>` and `<caption>` markup in `ProcessCapabilityReport.tsx`.

- [ ] **Step 2: Verify compatibility assertions fail**

Run: `npx playwright test -c playwright-ct.config.ts tests/statisticalTable.spec.tsx`

Expected: FAIL because statistical components still own separate frame DOM.

- [ ] **Step 3: Delegate compatibility exports and migrate capability tables**

Make existing statistical exports thin adapters over the Analysis primitives.
Change the five capability tables to `AnalysisTable` leaves. Remove duplicate
statistical frame/title/table CSS after confirming no remaining consumers need
it.

- [ ] **Step 4: Run focused and production verification**

```powershell
npx playwright test -c playwright-ct.config.ts tests/analysisPresentation.spec.tsx tests/statisticalTable.spec.tsx tests/analysisView.spec.tsx
node --test tests/distributionReportWiring.test.ts
npx vite build
```

Expected: all tests pass and Vite exits with code 0.

- [ ] **Step 5: Commit**

```powershell
git add -- src/components/distribution/ProcessCapabilityReport.tsx src/components/statistical tests/statisticalTable.spec.tsx tests/distributionReportWiring.test.ts
git commit -m "refactor(analysis): unify capability presentation"
```
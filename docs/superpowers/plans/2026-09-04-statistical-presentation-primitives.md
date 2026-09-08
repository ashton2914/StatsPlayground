# Statistical Presentation Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and adopt stable reusable framed-table components for current and future statistical analyses.

**Architecture:** Shared components own all frame and table markup and styling. Domain reports map Rust response objects into table models and never override shared internals with page-scoped selectors.

**Tech Stack:** React 19, TypeScript, CSS, Playwright Component Testing

**Spec:** `docs/superpowers/specs/2026-09-04-statistical-presentation-primitives-design.md`

## Global Constraints

- Rust remains the sole authority for computed values.
- One table frame contains exactly one table.
- Width presets never stretch tables to viewport width.
- Consumers must not restyle shared table internals with descendant selectors.
- Existing `.span` persistence remains definition-only.

---

### Task 1: Shared Statistical Components

**Files:**
- Create: `src/components/statistical/StatisticalTable.tsx`
- Create: `src/components/statistical/statisticalTable.css`
- Create: `src/components/statistical/index.ts`
- Test: `tests/statisticalTable.spec.tsx`

**Interfaces:**
- Produces: `StatisticalTableModel`, `StatisticalTableFrame`, `StatisticalSection`

- [x] **Step 1: Write the failing component test**

Assert that each frame has one title and one table, numeric cells are marked, and compact/standard/wide widths resolve to stable CSS classes.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/statisticalTable.spec.tsx`

- [x] **Step 3: Implement the shared primitives**

Define semantic columns and rows, render one table per frame, and place all visual rules in `statisticalTable.css`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npx playwright test -c playwright-ct.config.ts tests/statisticalTable.spec.tsx`

### Task 2: Process Capability Migration

**Files:**
- Modify: `src/components/distribution/ProcessCapabilityReport.tsx`
- Test: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: `StatisticalTableModel`, `StatisticalTableFrame`
- Produces: process capability output rendered exclusively through shared frames

- [x] **Step 1: Add failing assertions**

Assert that Specification, Process Summary, Within Capability, Overall Capability, and Nonconformance each use one shared table frame.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "configRevision-only changes"`

- [x] **Step 3: Convert capability output to shared table models**

Keep existing backend values and formatting behavior; replace captions and raw tables with shared frame components.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same filtered command.

### Task 3: Analysis Summary Migration

**Files:**
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `src/components/analysis/analysis.css`
- Test: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: shared statistical primitives
- Produces: Quantiles, Location, and Variation with the same frame contract as capability tables

- [x] **Step 1: Assert all Analysis tables use shared frames**

Require eight shared frames and forbid legacy `analysis-table-frame` markup.

- [x] **Step 2: Run the focused test and verify RED**

Run the filtered Analysis component test.

- [x] **Step 3: Replace Analysis-local table markup and CSS**

Map backend quantile and summary values to models and remove table-internal descendant overrides from `analysis.css`.

- [x] **Step 4: Run focused tests and build**

Run the shared primitive test, filtered Analysis test, and `npx vite build`.
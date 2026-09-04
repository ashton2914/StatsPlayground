# Stable Graph Layer Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep existing group colors unchanged when a points layer is added or removed.

**Architecture:** Add a small pure group-order helper shared by Graph Builder's legend/style resolution. Build the candidate set from raw dictionaries and aggregate discoveries, then apply explicit Value Order followed by deterministic lexical ordering.

**Tech Stack:** TypeScript 5.7, React 19, Node assert regression tests, Vite.

## Global Constraints

- Do not persist automatically assigned colors.
- Preserve explicit group style overrides and explicit Value Order.
- Do not change the Rust/Tauri graph-data protocol.

---

### Task 1: Stabilize Group Color Slots

**Files:**
- Create: `src/components/graphBuilder/graphGroupOrder.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Create: `tests/graphGroupOrder.test.ts`

**Interfaces:**
- Produces: `resolveStableGroupKeys(discoveredValues, dictionaryValues, valueOrder): string[]`
- Consumes: group values discovered from aggregate packets, `frame.dictionaries.group`, and the grouping column's Value Order.

- [ ] **Step 1: Write the failing test**

Assert that conflicting raw and aggregate encounter orders resolve to the same lexical order, while explicit Value Order remains first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild tests/graphGroupOrder.test.ts --bundle --platform=node --format=esm --outfile=tests/graphGroupOrder.bundle.js; node tests/graphGroupOrder.bundle.js`

Expected: FAIL because `graphGroupOrder.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement candidate normalization, deduplication, lexical sorting, and explicit-order precedence. Use it in `GraphBuilderView` when deriving `groupKeys`.

- [ ] **Step 4: Run focused and project verification**

Run the focused test, `npx tsc -b`, and `npx vite build`.

- [ ] **Step 5: Commit**

Commit with `fix(graph): keep layer colors stable`.

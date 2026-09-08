# Issue 135 Graph Builder Axis Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one or many continuous columns dropped on Graph Builder X use the same column-label-X/value-Y pipeline and prevent the single-column distribution split plot.

**Architecture:** Preserve a non-empty `multiX` as the canonical state for continuous variable columns assigned to X. Request derivation and runtime modeling activate melt for `multiX.length >= 1`; ordinary categorical X and direct variable Y encodings remain unchanged, while legacy Analysis `multiY` remains compatible.

**Tech Stack:** React 19, TypeScript 5.7, Node `assert`, Vite 6, ECharts 5.6, Tauri 2

**Spec:** `docs/superpowers/specs/2026-09-08-issue-135-graph-builder-axis-semantics-design.md`

## Global Constraints

- Y represents measured variable values; X represents attributes identifying or grouping those values.
- One-column and multi-column continuous X assignments use the same state, request, and runtime path.
- Categorical or ordinal X remains a direct X attribute.
- Direct continuous Y remains a direct Y variable.
- Existing Analysis and saved-project `multiY` compatibility remains supported.
- Do not commit, push, or create a pull request before manual acceptance.

---

### Task 1: Canonical X State And Legacy Migration

**Files:**
- Modify: `src/components/graphBuilder/graphBuilderMode.ts`
- Test: `tests/graphBuilderMode.test.ts`

**Interfaces:**
- Consumes: `Graph2DState.encoding`, `Graph2DState.multiX`, enabled `ChartElement[]`
- Produces: normalized state where a non-empty `multiX` may contain one field and an unambiguous legacy continuous-X-only distribution migrates to `multiX`

- [x] **Step 1: Replace the rejected Issue 135 test with failing canonical-state tests**

Add assertions that normalization preserves:

```ts
multiX: [continuous("measurement")]
encoding: {}
```

and migrates a legacy interactive distribution state from:

```ts
encoding: { x: continuous("measurement") }
multiX: []
```

to the same one-element `multiX` state. Also assert categorical X plus continuous Y is unchanged and migrated normalization is idempotent.

- [x] **Step 2: Run the focused mode test and verify RED**

Run:

```bash
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphBuilderMode.test.ts
```

Expected: FAIL because the current normalizer collapses one-element `multiX` to `encoding.x`.

- [x] **Step 3: Implement canonical state normalization**

Change X normalization so a non-empty `multiX` is preserved. Add a narrowly-scoped migration predicate for interactive 2D items whose ID does not start with `analysis-graph:` or `fit-y-by-x-graph:`, with one continuous `encoding.x`, no `encoding.y`, and an enabled distribution element (`histogram`, `normalCurve`, or `boxplot`); move that field to `multiX` and remove `encoding.x`. Remove the rejected Analysis-ID `preserveSingleMultiY` exception from the previous attempt and restore the existing `multiY` compatibility behavior.

- [x] **Step 4: Re-run the focused mode test and verify GREEN**

Run the command from Step 2. Expected: `graphBuilderMode migration tests passed`.

---

### Task 2: Unified Request And Runtime Melt

**Files:**
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `src/components/graphBuilder/graphRuntimeModel.ts`
- Test: `tests/graphDataPipeline.test.ts`
- Test: `tests/graphRuntime.test.ts`

**Interfaces:**
- Consumes: normalized `GraphBuilderItem` with `modeStates.twoD.multiX: FieldRef[]`
- Produces: `multiX0...` request bindings and `GraphRuntimeMeltInfo` for every non-empty `multiX`

- [x] **Step 1: Write failing request and runtime equivalence tests**

For one-column and two-column `multiX` items, assert:

```ts
deriveFields(single) === [{ role: "multiX0", column: "measurement" }]
```

and both runtime models use:

```ts
effectiveEncoding.x = { name: "__sp_variable__", type: "nominal" }
effectiveEncoding.y = { name: "__sp_value__", type: "continuous" }
```

Assert the one-column request is executable and its value order contains exactly `measurement`.

- [x] **Step 2: Run both tests and verify RED**

Run:

```bash
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
```

Expected: FAIL because both modules currently require `multiX.length >= 2`.

- [x] **Step 3: Lower only the X melt thresholds**

In request derivation and runtime modeling, replace the `multiX.length >= 2` activation rule with `multiX.length >= 1`. Keep `multiY` compatibility thresholds unchanged unless an existing contract requires otherwise. Update `canExecuteGraphRequest` so one `multiX0` binding is executable.

- [x] **Step 4: Re-run both tests and verify GREEN**

Run the commands from Step 2. Expected: both scripts exit 0.

---

### Task 3: Consistent Interactive X Drop And Final Verification

**Files:**
- Create: `src/components/graphBuilder/graphBuilderDropRouting.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Test: `tests/graphBuilderDropRouting.test.ts`
- Test: `tests/transformAggregatePackets.test.ts`

**Interfaces:**
- Consumes: parsed drag fields and target `GraphSlotKey`
- Produces: one routing decision where every numeric X drop calls the multi-field state transition, including one field

- [x] **Step 1: Extract and test the pure drop-routing decision**

Create `decideGraphBuilderDropRoute(slot: GraphSlotKey, fields: FieldRef[], inMulti: boolean)` in `graphBuilderDropRouting.ts`. It returns `"multi"` for any non-empty all-continuous X field list or an append into an existing numeric multi list, `"single"` for categorical X or ordinary Y drops, and `"reject"` for invalid mixed numeric/non-numeric multi-axis drops. Add `tests/graphBuilderDropRouting.test.ts` proving single and multiple continuous X fields both return `"multi"`.

- [x] **Step 2: Run the routing test and verify RED**

Run:

```bash
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts
```

Expected: FAIL before the helper and unified route exist.

- [x] **Step 3: Route continuous X drops through `setMultiAtSlot`**

Use the pure decision in `routeDropToSlot`. For X plus continuous fields, call `setMultiAtSlot("x", mergedFields)` whether the list contains one or many fields. Preserve append behavior, rejection feedback, non-axis first-field behavior, categorical X direct binding, and direct Y binding. Update stale comments that claim one-element multi state must collapse.

- [x] **Step 4: Run focused and adjacent verification**

Run:

```bash
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphBuilderMode.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
npm exec -- tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npm run build
git diff --check
```

Expected: all commands exit 0; the build may retain existing chunk-size and mixed-import warnings.

- [ ] **Step 5: Inspect and launch manual acceptance**

Verify only intended source, test, design, and plan files are changed. Start Tauri from the Issue worktree, confirm port 1420 and the desktop process cwd belong to `StatsPlayground-issue-135`, then reproduce Issue 135 with one and multiple continuous columns dropped on X. The first acceptance run exposed `graph request is missing role y` for one-column `multiX` because the backend query planner still required two columns to activate melt projection.

- [x] Add a failing Rust integration test for one-column `multiX` raw chunks and boxplot aggregation.
- [x] Verify RED with the observed `InvalidParam("graph request is missing role y")` failure.
- [x] Make non-empty `multiX` activate validation, melt SQL, and projection metadata consistently in the DuckDB query planner.
- [x] Verify GREEN, preserve the existing multi-column contract, run all 585 Rust tests, rerun the affected frontend suite and production build, and confirm zero diagnostics plus `diff --check`.
- [ ] Re-test one-column and multi-column X behavior in the rebuilt Tauri acceptance instance before commit, push, or PR.

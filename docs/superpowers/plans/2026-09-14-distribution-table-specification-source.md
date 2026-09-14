# Distribution Table Specification Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Table column properties the sole source of Distribution specification limits, warn before saving responses without capability limits, and hand users directly to the relevant Table property editor.

**Architecture:** Enrich Distribution field metadata with `ColumnDisplayProps.extras`, then keep the save decision inside `DistributionDialog`. Workspace coordinates a dataset-scoped, one-shot request that `DataTableView` consumes only after its matching Table and display properties are loaded; persisted and runtime analysis-level specification maps remain empty compatibility containers.

**Tech Stack:** React 19, TypeScript 5.7, Playwright Component Testing, Zustand, Tauri v2, Rust, DuckDB

**Spec:** `docs/superpowers/specs/2026-09-14-distribution-table-specification-source-design.md`

## Global Constraints

- A finite Table-property LSL or USL enables Process Capability; Target alone does not.
- `ColumnDisplayProps.extras.spec` is the only specification source used by the Distribution UI.
- New, edited, migrated, and runtime Distribution values keep `analysis.specLimits` as `{}` for schema compatibility.
- Legacy analysis-level values are ignored and are never copied into Table properties.
- Rust remains the statistical authority and independently resolves each response's Table specification.
- Display-property load failures block Distribution create/edit instead of being interpreted as missing specifications.
- Workspace continues to own only canonical Analysis documents; do not restore a legacy Distribution store or lifecycle.
- Do not change capability formulas, report presentation, archive schema version, or backend wire fields.
- Do not commit, push, or create a pull request before user manual acceptance.

---

### Task 1: Table Specification Metadata And Empty Override Contract

**Files:**
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/useDistributionReport.ts`
- Modify: `src/components/analysis/analysisExecutors.ts`
- Modify: `src/components/analysis/adapters/distributionAnalysisAdapter.ts`
- Modify: `src/components/analysis/distributionAnalysisMigration.ts`
- Modify: `tests/distributionConfig.test.ts`
- Modify: `tests/distributionReportState.test.ts`
- Modify: `tests/analysisExecution.test.ts`
- Modify: `tests/distributionAnalysisAdapter.test.ts`
- Modify: `tests/distributionAnalysisMigration.test.ts`

**Interfaces:**
- Consumes: `ColumnDisplayProps.extras` indexed by source `colIndex`.
- Produces: `DistributionFieldInfo.colIndex: number` and `DistributionFieldInfo.extras?: Record<string, unknown>`.
- Produces: `hasDistributionCapabilitySpec(field): boolean`.
- Produces: `findResponsesMissingCapabilitySpecs(responses, fields): DistributionFieldInfo[]`.
- Produces: all editor, patch, migration, executor, and runtime request paths with `specLimits: {}`.

```ts
export interface DistributionFieldInfo {
  name: string;
  sqlType: string;
  integerCompatible: boolean;
  colIndex: number;
  extras?: Record<string, unknown>;
  field: FieldRef;
}

export function hasDistributionCapabilitySpec(field: DistributionFieldInfo): boolean;

export function findResponsesMissingCapabilitySpecs(
  responses: readonly FieldRef[],
  fields: readonly DistributionFieldInfo[],
): DistributionFieldInfo[];
```

- [ ] **Step 1: Write failing pure-contract tests**

Add literal cases to `tests/distributionConfig.test.ts` proving finite one-sided and two-sided limits pass, while absent specs, Target-only specs, strings, `NaN`, and infinities fail. Assert missing responses preserve response order and return their `colIndex` values.

```ts
const specFields: DistributionFieldInfo[] = [
  { name: "LSL", sqlType: "DOUBLE", integerCompatible: false, colIndex: 0, extras: { spec: { lsl: 1 } }, field: { name: "LSL", type: "continuous" } },
  { name: "Target", sqlType: "DOUBLE", integerCompatible: false, colIndex: 1, extras: { spec: { target: 2 } }, field: { name: "Target", type: "continuous" } },
  { name: "USL", sqlType: "DOUBLE", integerCompatible: false, colIndex: 2, extras: { spec: { usl: 3 } }, field: { name: "USL", type: "continuous" } },
];
assert.equal(hasDistributionCapabilitySpec(specFields[0]!), true);
assert.equal(hasDistributionCapabilitySpec(specFields[1]!), false);
assert.equal(hasDistributionCapabilitySpec(specFields[2]!), true);
assert.deepEqual(
  findResponsesMissingCapabilitySpecs(specFields.map((entry) => entry.field), specFields).map((entry) => entry.colIndex),
  [1],
);
```

Update fixtures that construct `DistributionFieldInfo` to provide `colIndex`.

- [ ] **Step 2: Run the pure test and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/distributionConfig.test.ts`

Expected: FAIL because the two helper exports and new required metadata do not exist.

- [ ] **Step 3: Implement finite Table-spec classification**

Read `field.extras?.spec` only when it is an object. Return true only when `lsl` or `usl` has type `number` and `Number.isFinite(value)`. Resolve response metadata by `FieldRef.name`; unknown responses remain missing rather than being silently capability-ready.

- [ ] **Step 4: Run the pure test and verify GREEN**

Run: `npx tsx --tsconfig tsconfig.app.json tests/distributionConfig.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing compatibility tests**

Use a legacy non-empty map in each affected test and require:

```ts
assert.deepEqual(createDistributionRequest(legacyItem, 7).specLimits, {});
assert.equal(
  distributionRequestFingerprint(legacyItem),
  distributionRequestFingerprint({
    ...legacyItem,
    analysis: { ...legacyItem.analysis, specLimits: {} },
  }),
);
assert.deepEqual(createAnalysisExecutionRequest(legacyDocument, 7).specLimits, {});
assert.deepEqual(toDistributionEditorItem(legacyDocument).analysis.specLimits, {});
assert.deepEqual(createDistributionAnalysisPatch(legacyDocument, legacyItem, updatedAt).definition?.analysis.specLimits, {});
assert.deepEqual(createDistributionAnalysisDocument(legacyItem, updatedAt).definition.analysis.specLimits, {});
```

Change the adapter summary expectation to omit the `specificationLimits` entry entirely, and change legacy migration expectations to preserve all other analysis fields while normalizing only `specLimits`.

- [ ] **Step 6: Run compatibility tests and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/distributionReportState.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisMigration.test.ts
```

Expected: FAIL because current runtime, executor, adapter, patch, factory, and migration paths preserve legacy overrides.

- [ ] **Step 7: Normalize every frontend compatibility boundary**

Set runtime request `specLimits` to `{}` and remove it from request fingerprints. Remove the adapter's specification summary formatter and entry. In editor conversion, patches, and migration/factory conversion, clone all other values but construct analysis as:

```ts
analysis: {
  ...structuredClone(source.analysis),
  specLimits: {},
},
```

- [ ] **Step 8: Run all Task 1 tests and verify GREEN**

Run the five commands from Steps 4 and 6. Expected: all PASS.

---

### Task 2: Distribution Save Warning And Three Actions

**Files:**
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Modify: `src/components/distribution/index.ts`
- Modify: `src/components/distribution/distribution.css`
- Modify: `tests/e2e/DistributionDialog.spec.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/distributionLocale.test.ts`

**Interfaces:**
- Consumes: `findResponsesMissingCapabilitySpecs(state.responses, columns)` from Task 1.
- Produces: `DistributionManagePropertiesRequest` and `onManageProperties(request)`.
- Produces: warning actions that either retain the draft, submit once, or request source Table property management.

```ts
export interface DistributionManagePropertiesRequest {
  datasetId: string;
  colIndices: number[];
}

interface DistributionDialogProps {
  // existing props
  onManageProperties: (request: DistributionManagePropertiesRequest) => void;
}
```

- [ ] **Step 1: Replace the old specification-input assertion with failing behavior tests**

In `tests/e2e/DistributionDialog.spec.tsx`, give the complete-spec fixture `extras: { spec: { lsl: 0 } }` and the missing-spec fixtures no LSL/USL. Assert:

```ts
await expect(component.locator(".distribution-spec-fields")).toHaveCount(0);
await component.getByRole("button", { name: "Save" }).click();
await expect(component.getByRole("alertdialog", { name: "Missing specification limits" })).toBeVisible();
await expect(component.getByText("Value", { exact: true })).toBeVisible();
```

Add separate tests for Cancel preserving the draft, Continue submitting exactly once with `analysis.specLimits` equal to `{}`, Manage calling back with `{ datasetId: "dataset-1", colIndices: [0, 2] }` without submit, and complete specs saving without a warning.

- [ ] **Step 2: Run the focused component test and verify RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionDialog.spec.tsx`

Expected: FAIL because the old specification editor remains and no warning/actions or callback exist.

- [ ] **Step 3: Implement the dialog decision state**

Remove `SpecificationLimitsEditor` from the dialog and export. Keep `pendingMissingFields: DistributionFieldInfo[] | null` as local state. Save opens the warning when the helper returns fields; Continue calls a private `submitConfirmed()` that always builds:

```ts
analysis: { ...state.analysis, specLimits: {} }
```

Manage invokes `onManageProperties({ datasetId: state.sourceDatasetId, colIndices })`; Cancel clears only the warning. Use a nested `role="alertdialog"` with a heading, a plain list of missing response names, and three visible text buttons.

- [ ] **Step 4: Add locale keys and parity assertions**

Add the same keys in all four locale files:

```json
{
  "missingSpecs": {
    "title": "Missing specification limits",
    "message": "These responses have no finite LSL or USL in Table column properties:",
    "manage": "Manage Column Properties",
    "continue": "Continue Without Capability"
  }
}
```

Translate values per locale and extend `tests/distributionLocale.test.ts` to require key parity.

- [ ] **Step 5: Run dialog and locale tests and verify GREEN**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionDialog.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/distributionLocale.test.ts
```

Expected: PASS.

---

### Task 3: Property Manager Initial Selection

**Files:**
- Modify: `src/components/ManageExtrasDialog.tsx`
- Create: `tests/ManageExtrasDialogHarness.tsx`
- Create: `tests/manageExtrasDialog.spec.tsx`

**Interfaces:**
- Consumes: optional visible/source-aligned column indices and registered `ExtraKind` values.
- Produces: initial selection overrides while preserving existing menu defaults when props are absent.

```ts
interface ManageExtrasDialogProps {
  // existing props
  initialSelectedColIndices?: readonly number[];
  initialExtraKinds?: readonly ExtraKind[];
}
```

- [ ] **Step 1: Write failing component tests through a module-level harness**

Mount the real dialog with three columns. With `initialSelectedColIndices={[1]}` and `initialExtraKinds={["spec"]}`, assert only the second column checkbox and Specification kind checkbox are checked. Mount without initial props and assert all columns plus detected existing kinds retain the current defaults.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/manageExtrasDialog.spec.tsx`

Expected: FAIL because the initial-selection props are not accepted or consumed.

- [ ] **Step 3: Implement validated initial selection**

Build the initial column set from provided indices filtered to `Number.isInteger(index) && index >= 0 && index < cols.length`; when the prop is absent, select every column. Build the kind set from provided registered non-batch-excluded kinds; when absent, preserve detected-kind behavior.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx playwright test -c playwright-ct.config.ts tests/manageExtrasDialog.spec.tsx`

Expected: PASS.

---

### Task 4: Workspace Metadata Loading And One-Shot Table Handoff

**Files:**
- Create: `src/components/tablePropertyManagerRequest.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/DataTableView.tsx`
- Modify: `tests/workspaceDistribution.test.ts`
- Create: `tests/tablePropertyManagerRequest.test.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes: `dataService.getColumns(datasetId)` and `dataService.getColumnDisplayProps(datasetId)`.
- Produces: `buildDistributionFieldInfo(columns, displayProps): DistributionFieldInfo[]`.
- Produces: dataset-scoped request identity and exact-once acknowledgement.

```ts
export interface TablePropertyManagerRequest {
  requestId: string;
  datasetId: string;
  colIndices: number[];
  extraKinds: ExtraKind[];
}

export function buildDistributionFieldInfo(
  columns: Array<[string, string]>,
  displayProps: ColumnDisplayProps[],
): DistributionFieldInfo[];

interface DataTableViewProps {
  // existing props
  propertyManagerRequest?: TablePropertyManagerRequest | null;
  onPropertyManagerRequestHandled?: (requestId: string) => void;
}
```

- [x] **Step 1: Write failing metadata mapping and request-consumption tests**

Use literal columns and out-of-order display props to prove mapping is by `colIndex`, not array position. Test a pure predicate/reducer in `tablePropertyManagerRequest.ts` proving a request is consumable only by the matching dataset and is acknowledged once by request ID.

```ts
assert.deepEqual(
  buildDistributionFieldInfo(
    [["A", "DOUBLE"], ["B", "VARCHAR"]],
    [{ colIndex: 1, extras: { spec: { usl: 5 } } }],
  ).map(({ colIndex, extras }) => ({ colIndex, extras })),
  [{ colIndex: 0, extras: undefined }, { colIndex: 1, extras: { spec: { usl: 5 } } }],
);
```

Extend Workspace contracts to require both service calls in create and Distribution edit paths, the one-shot request state, source Table activation, and request acknowledgement. Keep existing assertions forbidding the legacy Distribution lifecycle.

- [x] **Step 2: Run focused contracts and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tablePropertyManagerRequest.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceDistribution.test.ts
```

Expected: FAIL because metadata mapping, request contract, and handoff wiring do not exist.

- [x] **Step 3: Implement shared metadata mapping and blocking load behavior**

For create and Distribution edit, run:

```ts
const [columns, displayProps] = await Promise.all([
  dataService.getColumns(datasetId),
  dataService.getColumnDisplayProps(datasetId),
]);
const fields = buildDistributionFieldInfo(columns, displayProps);
```

Only open the dialog after both calls succeed. Use the existing localized `distribution.loadFieldsFailed` alert on either rejection.

- [x] **Step 4: Implement the Workspace handoff**

When `DistributionDialog.onManageProperties` fires, create a request with `crypto.randomUUID()`, `extraKinds: ["spec"]`, close create/edit dialog state, call the existing document activation path for the source Table, and pass the request to the matching `DataTableView`. Clear it only when `onPropertyManagerRequestHandled` returns the current request ID.

- [x] **Step 5: Implement DataTableView exact-once consumption**

After table data and display props have both loaded, consume only a request whose `datasetId` matches the component. Track the last handled request ID in a ref, set `showManageExtras(true)`, pass Task 3's initial props, then acknowledge. Do not change the ordinary menu button path, which continues to open with no initial overrides.

- [x] **Step 6: Run focused contracts and component coverage and verify GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tablePropertyManagerRequest.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceDistribution.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx tests/manageExtrasDialog.spec.tsx
```

Expected: PASS.

#### Task 4 Fix Round 2 Evidence (2026-09-14)

- RED first: `npx tsx --tsconfig tsconfig.app.json tests/tablePropertyManagerRequest.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceDistributionMetadata.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceDistribution.test.ts && npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx` failed immediately because `tablePropertyManagerRequest.ts` did not yet export the identity-based retention helper or Workspace metadata-fence helper surface.
- GREEN focused slice: the same focused command then passed after the fix. Coverage now proves `DataTableView` does not consume a dataset B request while the loaded table data and loaded display props still identify dataset A, and consumes exactly once only after both identities move to dataset B.
- Root fix shape: `DataTableView` now clears and restamps loaded data and loaded display-props dataset identities per request epoch, rechecks the epoch after every await including `getColumnDisplayProps`, and never marks readiness from stale or failed loads. `Workspace` now fences Distribution create/edit metadata completions by requested dataset or analysis identity plus request epoch, and drops a pending property-manager request only when its dataset disappears from the available dataset list.
- Broader verification: `npx tsc -b`, `npm run test:distribution:contracts`, and `npm run test:analysis:contracts` all exited 0 after the focused slice was green.

---

### Task 5: Per-Response Rust Integration And Archive Compatibility

**Files:**
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/distributionAnalysisMigration.test.ts`
- Verify unchanged: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: two response columns whose Table display properties differ.
- Produces: `processCapability` only for the response with finite LSL or USL.
- Preserves: acceptance of non-empty legacy `analysis.specLimits` at the current archive schema boundary before frontend normalization.

- [ ] **Step 1: Add a Rust two-response integration test**

Create one in-memory two-DOUBLE-column dataset. Set display props so response A has `{ "spec": { "lsl": 0.0, "usl": 10.0 } }` and response B has Target only. Execute one request with both response column IDs and `capability.normal.individuals` enabled. Group report blocks by their response identity and assert exactly A has one available `processCapability` block whose source is `columnProperty`.

- [ ] **Step 2: Run the focused Rust test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml table_specs_are_resolved_per_response -- --exact`

Expected: PASS if the established backend behavior is correct. If it fails, treat the output as new root-cause evidence and make only the smallest backend repair needed for per-response lookup.

- [ ] **Step 3: Add frontend archive-normalization coverage**

Create a legacy project payload whose Distribution compatibility map is non-empty. Assert hydration succeeds, the resulting Analysis has `specLimits: {}`, and the input Table display props fixture remains byte-for-byte unchanged.

- [ ] **Step 4: Run archive and migration tests and verify GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisMigration.test.ts
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

Expected: PASS without changing the current Rust archive validator shape.

---

### Task 6: Full Verification, Independent Review, And Manual Acceptance

**Files:**
- Review: every file changed in Tasks 1-5
- Update: `docs/superpowers/plans/2026-09-14-distribution-table-specification-source.md` checkbox status

**Interfaces:**
- Consumes: completed TDD slices.
- Produces: verified feature worktree ready for user acceptance, without commit or PR creation.

- [ ] **Step 1: Run frontend gates**

Run:

```bash
npm run test:distribution
npm run test:analysis
npm run build
```

Expected: every command exits 0 with zero failing tests.

- [ ] **Step 2: Run Rust gates**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml distribution_service
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: every command exits 0 with zero test or lint failures.

- [ ] **Step 3: Inspect the bounded final change**

Run `git --no-pager diff --no-ext-diff --stat`, then inspect only changed source/test/docs files and run `git --no-pager diff --no-ext-diff --check`. Confirm no generated output, cache, secret, lockfile, unrelated change, or direct Table-property write from legacy overrides is present.

- [ ] **Step 4: Dispatch independent review**

Give the reviewer Issue #187, base `0765096`, the approved spec, and the actual tracked plus untracked diff. Require findings ordered by severity for behavior, lifecycle, stale request handling, archive compatibility, test honesty, and missing acceptance coverage. Repair every Critical or Important finding and rerun affected focused and full gates.

- [ ] **Step 5: Start the isolated Tauri app and verify process binding**

Run the app from the sibling worktree with an explicit worktree-bound command. Verify the Vite URL, frontend source root, Tauri executable path, and running process all point to `fix-issue-187-distribution-table-specs` before reporting the acceptance target.

- [ ] **Step 6: Request manual acceptance**

Ask the user to verify:

1. Distribution no longer shows LSL, Target, or USL inputs.
2. A response with a finite Table LSL or USL saves directly and shows Process Capability.
3. Missing and Target-only responses appear in the warning and can continue without Process Capability.
4. Manage Column Properties opens the correct source Table with only missing responses and Specification selected.
5. Editing a legacy Analysis does not restore or copy old analysis-level overrides.

Stop at this gate. Commit, push, pull request creation, merge, Issue closure, and worktree cleanup follow only their separately authorized lifecycle stages.
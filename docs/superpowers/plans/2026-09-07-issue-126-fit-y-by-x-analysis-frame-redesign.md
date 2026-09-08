# Issue 126 Fit Y by X Analysis Frame Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live legacy Fit Y by X document lifecycle with a fully registered `fitYByX` Analysis kind while preserving legacy project and Report compatibility.

**Architecture:** Add Fit Y by X vertically to every layer-local Analysis registry, migrate legacy `.spf` values at the frontend hydration boundary, and keep the existing Rust statistical engine behind an identity-bearing IPC response envelope. Workspace and Report rendering share the Analysis execution authority and pure Fit Y by X result composition, while legacy fields remain read-only compatibility inputs.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, Tauri 2, Rust, DuckDB, Playwright Component Testing, Node `tsx` contract tests.

**Spec:** `docs/superpowers/specs/2026-09-07-issue-126-fit-y-by-x-analysis-frame-redesign.md`

## Global Constraints

- Follow `docs/analysis-development-standard.md` and `.github/instructions/analysis-development.instructions.md`.
- Distribution is the reference implementation and must remain behaviorally unchanged.
- Rust is the sole statistical authority; no frontend statistical fallback is permitted.
- Persist definitions and presentation only; never persist results, report blocks, graph frames, or generated markdown.
- Fence execution by kind, document ID, config revision, dataset ID, dataset generation, dataset update version, definition fingerprint, request identity, and token.
- Mask stale state synchronously before paint.
- Register every Analysis kind exhaustively in descriptor, executor, view, editor, graph, and report records.
- Keep `contracts/analysis/kinds.v1.json`, TypeScript document types, and Rust validators in exact parity.
- Unsupported capabilities use `false` plus a `null` policy; dispatch never falls back to Distribution.
- Legacy Fit Y by X migration uses confidence level `0.95`, matching the current `FIT_Y_BY_X_CONFIDENCE_LEVEL` behavior.
- Statistical input patches increment `configRevision`; graph presentation patches do not.
- The prior Issue 126 implementation and commit `3a4ce3e` were explicitly discarded and must not be restored or used as implementation source.
- Do not commit, push, or create a pull request before manual acceptance. Task checkpoints are reviewed diffs plus passing focused tests.

---

### Task 1: Persisted Kind Contract And Deterministic Legacy Migration

**Files:**
- Modify: `contracts/analysis/kinds.v1.json`
- Modify: `src/types/analysis.ts`
- Create: `src/components/analysis/adapters/fitYByXAnalysisAdapter.ts`
- Modify: `src/components/analysis/adapters/index.ts`
- Create: `src/components/analysis/fitYByXAnalysisMigration.ts`
- Modify: `src/components/analysis/analysisWorkspaceLifecycle.ts`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `tests/analysisKindRegistry.test.ts`
- Modify: `tests/analysisDocument.test.ts`
- Create: `tests/fitYByXAnalysisMigration.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/tsconfig.analysis-contracts.json`

**Interfaces:**
- Consumes: legacy `FitYByXItem`, `EmbeddedGraphConfig`, `validateFitYByXRoles`, and the current Analysis hydration result.
- Produces: `FitYByXAnalysisDefinition`, `FitYByXAnalysisPresentation`, `FitYByXAnalysisDocument`, `createFitYByXAnalysisDocument`, `migrateLegacyFitYByX`, and a two-kind Rust validator contract.

- [ ] **Step 1: Write RED TypeScript contract and migration tests**

Add the expected manifest kind and compile-time document narrowing:

```ts
assert.deepEqual(manifestKinds, ["distribution", "fitYByX"]);

const document: FitYByXAnalysisDocument = {
  schemaVersion: 1,
  documentType: "analysis",
  id: "fit-1",
  name: "Strength by Site",
  analysisKind: "fitYByX",
  configRevision: 1,
  source: { datasetId: "dataset-1" },
  definition: {
    kind: "fitYByX",
    response: { name: "Strength", type: "continuous" },
    factor: { name: "Site", type: "nominal" },
    personality: "oneway",
    confidenceLevel: 0.95,
  },
  presentation: {
    schemaVersion: 1,
    layout: "fit-y-by-x-v1",
    graph: createDefaultFitYByXGraphConfig({ response, factor }),
  },
  createdAt,
  updatedAt: createdAt,
};
```

In `tests/fitYByXAnalysisMigration.test.ts`, assert:

```ts
const migrated = migrateLegacyFitYByX({
  analyses: [],
  analysisFolders: {},
  fitYByX: [legacy],
  fitYByXFolders: { [legacy.id]: "Analyses/Legacy" },
});
assert.equal(migrated.analyses[0]?.id, legacy.id);
assert.equal(migrated.analyses[0]?.name, legacy.name);
assert.equal(migrated.analyses[0]?.source.datasetId, legacy.sourceDatasetId);
assert.equal(migrated.analyses[0]?.createdAt, legacy.createdAt);
assert.deepEqual(migrated.analyses[0]?.definition.response, legacy.response);
assert.deepEqual(migrated.analyses[0]?.definition.factor, legacy.factor);
assert.equal(migrated.analyses[0]?.definition.personality, legacy.personality);
assert.equal(migrated.analyses[0]?.definition.confidenceLevel, 0.95);
assert.deepEqual(migrated.analyses[0]?.presentation.graph, legacy.graph);
assert.equal(migrated.analysisFolders[legacy.id], "Analyses/Legacy");
assert.throws(
  () => migrateLegacyFitYByX({ ...input, analyses: [sameIdAnalysis] }),
  /fit-1/,
);
assert.throws(() => migrateLegacyFitYByX({ ...input, fitYByX: [invalidRoles] }));
```

- [ ] **Step 2: Run RED checks**

Run:

```powershell
npx tsc -p tests/tsconfig.analysis-contracts.json
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisMigration.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
```

Expected: FAIL because `fitYByX` is not an Analysis kind and the migration adapter does not exist.

- [ ] **Step 3: Add the TypeScript contract and migration adapter**

Add these exact kind members:

```ts
export type AnalysisKind = "distribution" | "fitYByX";

export interface FitYByXAnalysisDefinition {
  kind: "fitYByX";
  response: FieldRef;
  factor: FieldRef;
  personality: FitYByXPersonality;
  confidenceLevel: number;
}

export interface FitYByXAnalysisPresentation {
  schemaVersion: 1;
  layout: "fit-y-by-x-v1";
  graph: EmbeddedGraphConfig;
}

export interface FitYByXAnalysisDocument extends AnalysisDocumentEnvelope {
  analysisKind: "fitYByX";
  definition: FitYByXAnalysisDefinition;
  presentation: FitYByXAnalysisPresentation;
}
```

If no shared envelope exists, retain the current explicit fields in both union members rather than introducing a generic persisted result type.

Implement migration with a hard collision check:

```ts
export const FIT_Y_BY_X_DEFAULT_CONFIDENCE_LEVEL = 0.95;

export function createFitYByXAnalysisDocument(
  input: {
    item: FitYByXItem;
    confidenceLevel: number;
    updatedAt: string;
  },
): FitYByXAnalysisDocument {
  const { item, confidenceLevel, updatedAt } = input;
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: item.id,
    name: item.name,
    analysisKind: "fitYByX",
    configRevision: 1,
    source: { datasetId: item.sourceDatasetId },
    definition: {
      kind: "fitYByX",
      response: structuredClone(item.response),
      factor: structuredClone(item.factor),
      personality: item.personality,
      confidenceLevel,
    },
    presentation: {
      schemaVersion: 1,
      layout: "fit-y-by-x-v1",
      graph: structuredClone(item.graph),
    },
    createdAt: item.createdAt,
    updatedAt,
  };
}
```

`migrateLegacyFitYByX` validates roles, personality consistency, confidence default, and graph shape before calling `createFitYByXAnalysisDocument({ item, confidenceLevel: FIT_Y_BY_X_DEFAULT_CONFIDENCE_LEVEL, updatedAt })`. `hydrateAnalysisProjectPayload` first migrates Distribution, then passes that result to Fit Y by X migration. Return `migratedCount` as the sum. Do not rename a colliding Fit Y by X ID.

- [ ] **Step 4: Add explicit Rust definition and presentation validators**

Extend `AnalysisValidatorContract` with:

```rust
validate_presentation: fn(&Map<String, Value>, &str) -> Result<(), AppError>,
```

Distribution uses a no-op presentation validator. Fit Y by X validation requires one response `FieldRef`, one factor `FieldRef`, personality in `oneway|bivariate`, finite `confidenceLevel` strictly inside `(0, 1)`, and `presentation.graph` accepted by `validate_embedded_graph_config`.

Implement and dispatch these exact validator boundaries:

```rust
fn validate_fit_y_by_x_analysis_definition(
  definition: &Map<String, Value>,
  context: &str,
) -> Result<(), AppError>;

fn validate_fit_y_by_x_analysis_presentation(
  presentation: &Map<String, Value>,
  context: &str,
) -> Result<(), AppError>;

(contract.validate_definition)(definition, context)?;
(contract.validate_presentation)(presentation, context)?;
```

Add a second `ANALYSIS_VALIDATOR_CONTRACTS` entry matching:

```json
{
  "analysisKind": "fitYByX",
  "documentSchemaVersion": 1,
  "definitionKind": "fitYByX",
  "presentation": { "schemaVersion": 1, "layout": "fit-y-by-x-v1" }
}
```

- [ ] **Step 5: Run GREEN contract and migration checks**

Run:

```powershell
npx tsc -p tests/tsconfig.analysis-contracts.json
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisMigration.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
cargo test --manifest-path src-tauri/Cargo.toml analysis_document_validation
```

Expected: PASS, including invalid personality, confidence, field reference, graph, and ID-collision cases.

- [ ] **Step 6: Review checkpoint**

Inspect `git diff --check` and the Task 1 diff. Confirm only contract, migration, and validator behavior changed; no Workspace runtime path changed yet.

---

### Task 2: Identity-Bearing Fit Y by X IPC And Unified Executor

**Files:**
- Modify: `src-tauri/src/models/fit_y_by_x.rs`
- Modify: `src-tauri/src/commands/fit_y_by_x_commands.rs`
- Modify: `src/services/fitYByXService.ts`
- Modify: `src/types/fitYByX.ts`
- Modify: `src/components/analysis/analysisExecutors.ts`
- Modify: `src/components/analysis/useAnalysisExecution.ts`
- Modify: `tests/analysisExecution.test.ts`
- Modify: `tests/AnalysisExecutionHarness.tsx`
- Modify: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: `FitYByXAnalysisDocument`, existing `FitYByXRequest`, Rust `FitYByXService::run`, and Analysis execution fencing.
- Produces: `FitYByXResponse { datasetId, generation, result }`, `fitYByXService.compute`, a legacy-compatible `fitYByXService.run`, and two-kind execution request/response maps.

- [ ] **Step 1: Write RED response-identity and stale-fence tests**

Add TypeScript assertions:

```ts
const fitRequest = createAnalysisExecutionRequest(fitDocument, 7);
assert.deepEqual(fitRequest, {
  datasetId: "dataset-1",
  generation: 7,
  responseColumn: "Strength",
  factorColumn: "Site",
  personality: "oneway",
  confidenceLevel: 0.95,
});

const mismatch = createAnalysisExecutionController({
  getDatasetGeneration: async () => 7,
  computeFitYByX: async () => ({
    datasetId: "other-dataset",
    generation: 7,
    result: notComputableResult,
  }),
});
await mismatch.load(fitDocument, dataset());
assert.equal(mismatch.getState().status, "error");
```

Add a Playwright case that changes only `presentation.graph` while a Fit Y by X success is visible and proves compute count stays unchanged; then change `definition.confidenceLevel` and prove stale success is masked immediately and compute count increases once.

Parameterize the existing controller fence cases for Fit Y by X so late responses are rejected after each independent change: Analysis kind/ID, `configRevision`, dataset ID, dataset generation, dataset `updatedAt`, definition fingerprint, request identity, and request token. The first observable state after any changed fence must be loading, never the previous success.

- [ ] **Step 2: Run RED execution checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx -g "Fit Y by X"
```

Expected: FAIL because execution maps and the identity-bearing response do not exist.

- [ ] **Step 3: Add the IPC response envelope without changing the statistical engine**

Add matching Rust and TypeScript models:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitYByXResponse {
    pub dataset_id: String,
    pub generation: u64,
    pub result: FitYByXResult,
}
```

The command clones `request.dataset_id` and reads `request.generation` before passing the request to `FitYByXService::run`, then wraps the returned result. Keep engine and service result tests unchanged.

Expose both frontend methods:

```ts
export const fitYByXService = {
  compute: (request: FitYByXRequest) =>
    invoke<FitYByXResponse>("fit_y_by_x", { request }),
  run: async (request: FitYByXRequest): Promise<FitYByXResult> =>
    (await fitYByXService.compute(request)).result,
};
```

The temporary `run` compatibility method keeps legacy tests working until Task 7 removes the live legacy hook.

- [ ] **Step 4: Generalize execution maps and state by kind**

Add exact maps:

```ts
export type AnalysisExecutionRequestByKind = {
  distribution: DistributionRequest;
  fitYByX: FitYByXRequest;
};

export type AnalysisExecutionResponseByKind = {
  distribution: DistributionReportResponse;
  fitYByX: FitYByXResponse;
};
```

Preserve the current Distribution dependency override as `compute`. Add `computeFitYByX` to `AnalysisExecutionDependencies` and `UseAnalysisExecutionRuntime`. The Fit Y by X executor uses `fitYByXService.compute` by default and matches both `datasetId` and `generation`.

Make `AnalysisExecutionState` a discriminated union carrying `analysisKind`; success rows pair each kind with its response type. Narrow renderer access by checking both `state.status` and `state.analysisKind`.

The Fit Y by X fingerprint includes analysis kind, config revision, source dataset ID, response, factor, personality, and confidence level. It excludes `presentation.graph`.

- [ ] **Step 5: Run GREEN execution and Rust IPC checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx -g "Fit Y by X"
cargo test --manifest-path src-tauri/Cargo.toml fit_y_by_x_commands
cargo test --manifest-path src-tauri/Cargo.toml fit_y_by_x_service
```

Expected: PASS with response mismatch rejected and presentation-only changes excluded from the statistical fingerprint.

- [ ] **Step 6: Review checkpoint**

Confirm the Rust engine math is untouched, the legacy `run` wrapper unwraps the envelope, and every asynchronous acceptance path checks the full fence.

---

### Task 3: Synchronous Fit Y by X Renderer And Shared Result Composition

**Files:**
- Create: `src/components/analysis/renderers/fitYByXAnalysisModel.ts`
- Create: `src/components/analysis/renderers/FitYByXAnalysisReport.tsx`
- Create: `src/components/analysis/renderers/FitYByXAnalysisResults.tsx`
- Modify: `src/components/analysis/analysisViewRegistry.tsx`
- Modify: `src/components/analysis/analysisViewContracts.ts`
- Modify: `src/components/analysis/analysisKindDescriptors.ts`
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `src/components/analysis/analysis.css`
- Modify: `tests/analysisKindRegistry.test.ts`
- Modify: `tests/AnalysisViewHarness.tsx`
- Modify: `tests/analysisView.spec.tsx`
- Create: `tests/fitYByXAnalysisRenderer.test.ts`

**Interfaces:**
- Consumes: Fit Y by X Analysis document, kind-narrowed `AnalysisExecutionState`, shared presentation primitives, and embedded Graph Builder runtime.
- Produces: `createFitYByXAnalysisReportModel`, `FitYByXAnalysisReport`, and synchronous `FitYByXAnalysisResults` registration.

- [ ] **Step 1: Write RED pure-model and component tests**

Move expected formatting cases from the legacy report suite into `tests/fitYByXAnalysisRenderer.test.ts`. Assert Bivariate sections `summaryOfFit`, `lackOfFit`, `analysisOfVariance`, and `parameterEstimates`; Oneway sections `groupSummary`, `analysisOfVariance`, and `effectSize`; plus not-computable, loading, error, and source-unavailable states.

Add Playwright assertions:

```ts
await expect(component.locator('[data-analysis-kind="fitYByX"]')).toBeVisible();
await expect(component.getByRole("button", { name: /edit inputs/i })).toBeEnabled();
await expect(component.locator('[data-analysis-block="graph"]')).toBeVisible();
await expect(component.locator('[data-analysis-block="report"]')).toBeVisible();
```

- [ ] **Step 2: Run RED renderer checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisRenderer.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx -g "Fit Y by X"
```

Expected: FAIL because no Fit Y by X renderer is registered.

- [ ] **Step 3: Extract a pure Analysis report model**

Implement:

```ts
export function createFitYByXAnalysisReportModel(input: {
  document: FitYByXAnalysisDocument;
  state: AnalysisExecutionState;
  datasetMissing: boolean;
  translate: Translate;
}): FitYByXAnalysisReportModel;
```

Port number, p-value, equation, ANOVA, estimate, group summary, and effect-size formatting from the existing report without copying its legacy state or HTML table structure. `FitYByXAnalysisReport` renders the model exclusively through `AnalysisFrame`, `AnalysisTable`, `AnalysisStack`, and `AnalysisText`.

- [ ] **Step 4: Register the synchronous page renderer**

`FitYByXAnalysisResults` calls `useAnalysisExecution` once, materializes its graph with `createEmbeddedGraphItem`, and renders one `AnalysisShell`. The graph uses `item.presentation.graph`; report output uses the shared pure model.

Register:

```ts
export const analysisViewRegistry = {
  distribution: DistributionAnalysisResults,
  fitYByX: FitYByXAnalysisResults,
} satisfies {
  [Kind in AnalysisKind]: ComponentType<AnalysisKindViewProps<Kind>>;
};
```

Set the descriptor title to `fitYByX.title`, `graphEditing: true`, and `reportEmbedding: true`. Add `fit-y-by-x-v1` to `analysisViewContracts`.

- [ ] **Step 5: Run GREEN renderer checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisRenderer.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx -g "Fit Y by X"
```

Expected: PASS for Oneway, Bivariate, not-computable, loading, error, graph, and missing-source rendering.

- [ ] **Step 6: Review checkpoint**

Confirm the renderer has no direct service call, no frontend statistics, no raw `<table>`, and no fallback dispatch.

---

### Task 4: Input Editor And Presentation-Only Graph Persistence

**Files:**
- Modify: `src/components/analysis/adapters/fitYByXAnalysisAdapter.ts`
- Modify: `src/components/analysis/analysisEditorRegistry.ts`
- Modify: `src/components/analysis/analysisGraphPolicies.ts`
- Modify: `src/components/analysis/renderers/FitYByXAnalysisResults.tsx`
- Modify: `src/components/analysis/analysisWorkspaceLifecycle.ts`
- Modify: `src/components/fitYByX/FitYByXRoleDialog.tsx`
- Modify: `tests/analysisDocument.test.ts`
- Modify: `tests/workspaceAnalysisLifecycle.test.ts`
- Modify: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: legacy role-dialog item shape, Analysis editor registry, graph role mapping, and Workspace Analysis patch callback.
- Produces: `FitYByXAnalysisEditorItem`, `toFitYByXEditorItem`, `createFitYByXAnalysisPatch`, `describeFitYByXAnalysis`, graph role `"main"`, and `createWorkspaceAnalysisGraphConfigPatch` support.

- [ ] **Step 1: Write RED adapter and graph-policy tests**

Assert:

```ts
const statisticalPatch = createAnalysisEditorPatch(document, submitted, updatedAt);
assert.equal(statisticalPatch.configRevision, document.configRevision + 1);
assert.equal(statisticalPatch.definition?.response.name, "Strength2");
assert.equal(statisticalPatch.definition?.factor.name, "Temperature");
assert.equal(statisticalPatch.definition?.personality, "bivariate");
assert.equal(statisticalPatch.definition?.confidenceLevel, 0.9);
assert.deepEqual(statisticalPatch.presentation, undefined);

const graphResult = createAnalysisGraphPersistencePatch(document, "main", changedGraph, updatedAt);
assert.equal(graphResult.statisticalInputsChanged, false);
assert.deepEqual(graphResult.patch.presentation?.graph, changedGraph);
assert.equal(graphResult.patch.configRevision, undefined);
assert.deepEqual(graphResult.patch.definition, undefined);
```

- [ ] **Step 2: Run RED editor and graph checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisLifecycle.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx -g "axis|Fit Y by X"
```

Expected: FAIL because editor and graph policy maps only accept Distribution.

- [ ] **Step 3: Add kind-mapped editor APIs**

Define:

```ts
export interface FitYByXAnalysisEditorItem extends FitYByXItem {
  confidenceLevel: number;
}

export type AnalysisEditorItemByKind = {
  distribution: DistributionItem;
  fitYByX: FitYByXAnalysisEditorItem;
};
```

`toFitYByXEditorItem` maps definition fields, definition confidence, and presentation graph into the dialog item shape. `createFitYByXAnalysisPatch` validates roles and confidence, derives personality from the submitted factor, retains the document source, increments `configRevision`, and does not copy the submitted name or graph into the statistical patch.

Extend `FitYByXRoleDialogProps` with `mode: "create" | "edit"` and `initialValue?: FitYByXAnalysisEditorItem`. Initialize response, factor, and confidence from `initialValue` in edit mode, disable name editing there, and add a numeric confidence input constrained to the open interval `(0, 1)`. The submit callback returns `FitYByXAnalysisEditorItem`; creation still allocates the ID and default graph exactly once.

Use generic overloads for `toAnalysisEditorItem` and `createAnalysisEditorPatch` so each document kind pairs with only its own editor item type.

- [ ] **Step 4: Add Fit Y by X graph persistence**

Extend:

```ts
export type AnalysisGraphRoleByKind = {
  distribution: "overview";
  fitYByX: "main";
};
```

The Fit Y by X policy returns:

```ts
{
  patch: {
    presentation: { ...document.presentation, graph: structuredClone(graph) },
    updatedAt,
  },
  statisticalInputsChanged: false,
}
```

Wire X/Y axis dialogs and reset zoom through `onGraphConfigChange("main", graph)`.

- [ ] **Step 5: Run GREEN editor and graph checks**

Run the Step 2 commands. Expected: PASS with no compute call after graph-only changes and one compute call after a definition patch.

- [ ] **Step 6: Review checkpoint**

Confirm graph patches never rewrite `definition`, statistical patches never accept a name edit, and invalid roles preserve the last valid document.

---

### Task 5: Move Workspace Ownership To The Shared Analysis Lifecycle

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/analysis/analysisWorkspaceLifecycle.ts`
- Modify: `src/components/fitYByX/FitYByXRoleDialog.tsx`
- Modify: `src/stores/useAnalysisStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Modify: `tests/workspaceAnalysis.test.ts`
- Modify: `tests/workspaceAnalysisLifecycle.test.ts`
- Modify: `tests/workspaceFitYByX.test.ts`
- Modify: `tests/folderStore.analysis.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: Fit Y by X role dialog, Analysis factory/adapter, shared Analysis store/folders, project hydrate/build helpers, and existing history actions.
- Produces: Analysis-backed create/edit/select/rename/delete/folder/save/open behavior with no live `activeFitYByXId` or Fit Y by X folder map.

- [ ] **Step 1: Replace legacy-positive Workspace tests with RED Analysis ownership tests**

Change `tests/workspaceFitYByX.test.ts` to assert:

```ts
assertSourceIncludes(workspaceSource, "createFitYByXAnalysisDocument");
assertSourceIncludes(workspaceSource, "analysisItems.filter(isFitYByXAnalysisDocument)");
assertSourceExcludes(workspaceSource, "useFitYByXStore");
assertSourceExcludes(workspaceSource, "activeFitYByXId");
assertSourceExcludes(workspaceSource, "fitYByXFolders");
assertSourceExcludes(workspaceSource, "deleteFitYByXByDataset");
```

Add behavioral tests proving source deletion retains the active Fit Y by X Analysis and project save emits `fitYByX: []` plus the migrated document in `analyses`.

- [ ] **Step 2: Run RED Workspace checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitYByX.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisLifecycle.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: FAIL because Workspace still owns the legacy store and active ID.

- [ ] **Step 3: Rewire creation and editing**

Keep `FitYByXRoleDialog` as a controlled input UI, but make its submit callback return a validated `FitYByXAnalysisEditorItem` rather than mutate a store. In create mode it uses confidence `0.95` initially. Workspace converts a new submission with `createFitYByXAnalysisDocument({ item: submitted, confidenceLevel: submitted.confidenceLevel, updatedAt: submitted.createdAt })`, adds it through `useAnalysisStore`, selects `activeAnalysisId`, assigns `analysisFolders`, and records the existing user-facing Fit Y by X history message.

For edit, call `toAnalysisEditorItem(activeAnalysis)`, submit through the same dialog with name editing disabled, and apply `createAnalysisEditorPatch` through `useAnalysisStore.updateItem`.

- [ ] **Step 4: Rewire project hydration and save**

Pass `result.fitYByX` and `result.fitYByXFolders` into `hydrateAnalysisProjectPayload`. Load only the returned Analysis documents/folders into live stores. Save `fitYByX: []` and `fitYByXFolders: {}` while preserving the compatibility fields in request/result types.

Mark the project dirty when `migratedCount > 0`. Remove source-dataset cascade deletion for Fit Y by X; use the existing retained-Analysis selection behavior.

- [ ] **Step 5: Remove live Workspace branches**

Remove Fit Y by X store selectors/actions, `activeFitYByXId`, independent tree grouping, context-menu union members, folder assignment calls, main-pane `FitYByXView`, and reset/load calls. Render all Fit Y by X rows through the Analysis tree and `AnalysisView`.

- [ ] **Step 6: Run GREEN Workspace checks**

Run the Step 2 commands plus:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.analysis.test.ts
```

Expected: PASS with one shared active Analysis ID and retained documents after source deletion.

- [ ] **Step 7: Review checkpoint**

Search `Workspace.tsx` for `useFitYByXStore|activeFitYByXId|fitYByXFolders|FitYByXView`. Expected: zero matches outside legacy migration payload field names.

---

### Task 6: Transparent Legacy Report Embed Compatibility

**Files:**
- Modify: `src/components/analysis/analysisReportPolicies.ts`
- Create: `src/components/report/FitYByXAnalysisReportEmbed.tsx`
- Modify: `src/components/report/ReportEmbed.tsx`
- Modify: `src/components/report/ReportView.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/reportEmbeds.test.ts`
- Modify: `tests/reportViewHarness.tsx`
- Modify: `tests/reportView.spec.tsx`
- Modify: `tests/workspaceReport.test.ts`
- Modify: `tests/analysisKindRegistry.test.ts`

**Interfaces:**
- Consumes: `kind="fitYByX"` Report dependency grammar, Analysis store, Fit Y by X report policy, `useAnalysisExecution`, and `FitYByXAnalysisReport`.
- Produces: Report resolution and embedding from `FitYByXAnalysisDocument` with unchanged markdown syntax.

- [ ] **Step 1: Write RED Report resolution and render tests**

Assert that a dependency `{ kind: "fitYByX", documentId: "fit-1" }` resolves only when `useAnalysisStore` contains a same-ID document with `analysisKind === "fitYByX"`. A same-ID Distribution document must return `missing`.

In Playwright, render the legacy markdown token and assert:

```ts
await expect(component.locator('[data-kind="fitYByX"]')).toBeVisible();
await expect(component.getByText("Strength by Site")).toBeVisible();
await expect(component.locator('[data-analysis-report-kind="fitYByX"]')).toBeVisible();
```

- [ ] **Step 2: Run RED Report checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/reportEmbeds.test.ts
npx playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx -g "Fit Y by X"
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
```

Expected: FAIL because dependency resolution still reads `useFitYByXStore` and the report policy is absent.

- [ ] **Step 3: Define and register the report policy**

Use an explicit policy shape:

```ts
export interface AnalysisReportPolicy<Kind extends AnalysisKind> {
  dependencyKind: "fitYByX";
  accepts: (document: AnalysisDocument) => document is AnalysisDocumentByKind[Kind];
}

export const analysisReportPolicies = {
  distribution: null,
  fitYByX: {
    dependencyKind: "fitYByX",
    accepts: isFitYByXAnalysisDocument,
  },
} satisfies { [Kind in AnalysisKind]: AnalysisReportPolicy<Kind> | null };
```

Do not add a generic result schema or fallback renderer.

- [ ] **Step 4: Resolve and render Analysis-backed Fit Y by X embeds**

Replace the Fit Y by X snapshot collection with `analyses: readonly AnalysisDocument[]`. Filter using the policy type guard, find the source dataset, and return a resolved source whose item is `FitYByXAnalysisDocument`.

`FitYByXAnalysisReportEmbed` calls `useAnalysisExecution(source.item, source.dataset, runtime)` and renders only the Report card header plus `FitYByXAnalysisReport`. It must not render `AnalysisShell` or call `useFitYByXReport`.

Workspace Report option lists use:

```ts
analysisItems
  .filter(isFitYByXAnalysisDocument)
  .map(({ id, name }) => ({ id, name }));
```

- [ ] **Step 5: Run GREEN Report checks**

Run the Step 2 commands plus `npx tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts`.

Expected: PASS with unchanged Report markdown and no legacy store/hook dependency.

- [ ] **Step 6: Review checkpoint**

Confirm wrong-kind IDs are unavailable, missing datasets do not execute, and the descriptor capability equals the non-null report policy.

---

### Task 7: Remove Obsolete Live Runtime And Enforce Compatibility-Only Legacy Fields

**Files:**
- Delete: `src/stores/useFitYByXStore.ts`
- Delete: `src/components/fitYByX/FitYByXView.tsx`
- Delete: `src/components/fitYByX/useFitYByXReport.ts`
- Delete: `src/components/report/FitYByXReportEmbed.tsx`
- Modify: `src/components/fitYByX/index.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/services/index.ts`
- Modify: `src/types/index.ts`
- Modify: `src/components/fitYByX/FitYByXReport.tsx`
- Modify: `src/App.css`
- Modify: `src/components/fitYByX/fitYByX.css`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Delete: `tests/fitYByXStore.test.ts`
- Delete: `tests/fitYByXReportState.test.ts`
- Delete: `tests/fitYByXReport.test.ts`
- Delete: `tests/fitYByXLayout.test.ts`
- Modify: `tests/workspaceFitYByX.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`

**Interfaces:**
- Consumes: fully working Analysis-backed Workspace and Report paths from Tasks 1-6.
- Produces: no second live Fit Y by X runtime, while old archive fields and `fitYByXService.run` remain only if a non-Analysis compatibility test still requires them.

- [ ] **Step 1: Add RED absence and archive-write tests**

Add source-contract assertions to `tests/workspaceFitYByX.test.ts` that production Workspace and Report files do not import the deleted store, view, or hook. Add an archive round-trip proving a new save has Fit Y by X only under `analyses/*.span` and no `fitYByX/*.spf` entry. Delete the four legacy ownership/report tests only after their behavior assertions are present in the Analysis execution, renderer, Workspace, and Report suites created in Tasks 2-6.

Keep legacy archive-read coverage using a fixture or constructed v4 bundle containing `.spf` data.

- [ ] **Step 2: Run RED cleanup checks**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitYByX.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
cargo test --manifest-path src-tauri/Cargo.toml fit_y_by_x
```

Expected: FAIL while obsolete live modules and write paths remain.

- [ ] **Step 3: Delete live legacy modules and move retained pure utilities**

Delete the legacy store, view, report hook, and report embed. Keep role validation, dialog state, graph factory, result TypeScript models, service transport, and locale keys because the Analysis kind consumes them.

If `FitYByXReport.tsx` still owns formatters required by `fitYByXAnalysisModel.ts`, move those formatters into the Analysis model and delete the legacy component. Do not retain a forwarding component whose only purpose is preserving dead imports.

- [ ] **Step 4: Keep archive fields read-compatible and stop new writes**

Rust request/response models may retain `fit_y_by_x` and `fit_y_by_x_folders` with serde defaults so old projects open. The frontend save payload always supplies empty values. The archive writer must not materialize an `.spf` entry when the collection is empty.

Do not delete old read validators or project migration fields in this Issue.

- [ ] **Step 5: Run GREEN cleanup and method suites**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitYByXConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXDialog.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAxisInteractions.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisMigration.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAnalysisRenderer.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitYByX.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportEmbeds.test.ts
cargo test --manifest-path src-tauri/Cargo.toml fit_y_by_x
```

Expected: PASS with all meaningful Fit Y by X statistical, dialog, graph, migration, Workspace, and Report behavior covered through the new ownership path.

- [ ] **Step 6: Review checkpoint**

Search production frontend files for `useFitYByXStore|useFitYByXReport|FitYByXView|FitYByXReportEmbed`. Expected: zero matches. Search for `fitYByX` and classify every remaining match as Analysis kind identity, compatibility input, user-facing locale, dialog/config utility, statistical model, or service transport.

---

### Task 8: Full Gate, Independent Review, And Manual Acceptance

**Files:**
- Modify only files required by verified Critical or Important review findings.

**Interfaces:**
- Consumes: complete branch implementation and Issue 126 acceptance scenarios.
- Produces: verified acceptance build and review evidence; no commit, push, or pull request before user acceptance.

- [ ] **Step 1: Run the required Analysis gate**

Run:

```powershell
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
npm run build
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Run affected full Fit Y by X and Rust suites**

Run the Fit Y by X commands from Task 7, then:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fit_y_by_x
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive
```

Expected: all tests pass. If the known unrelated streaming writer timing test fails in an unfiltered full Rust run, rerun that exact test once and report both results without changing unrelated code.

- [ ] **Step 3: Inspect final scope**

Run:

```powershell
git status --short --branch
git diff --stat origin/dev...HEAD
git diff --name-status origin/dev...HEAD
git status --ignored --short --untracked-files=all
```

Because implementation remains uncommitted before acceptance, also inspect `git diff --stat` and `git diff --name-status`. Exclude generated caches and preserve unrelated files.

- [ ] **Step 4: Request independent review**

Provide the reviewer with Issue 126, the approved spec, base SHA `38198eea3f2e929cc54b6d6b422229a9b870e2b2`, all tracked/untracked implementation files, and these review priorities:

- TS/Rust/manifest parity;
- complete stale fencing and synchronous masking;
- no live legacy lifecycle;
- deterministic collision-safe migration;
- no persisted computed output;
- Report wrong-kind/missing-source handling;
- presentation-only graph edits do not recompute.

Fix every Critical or Important finding, rerun its focused check, and rerun affected full gates.

- [ ] **Step 5: Start the acceptance build**

Run the Tauri development app from this exact worktree. Verify the launched frontend source and executable belong to `StatsPlayground-issue-126`; use an isolated Cargo target if another process locks the shared binary.

- [ ] **Step 6: Ask for manual acceptance**

Give the user the worktree path and the eight scenarios from the spec: legacy migration; Oneway and Bivariate creation; statistical edit; axis edit/reset without recompute; rapid stale switch; legacy Report embed; source deletion retention; and save/reopen without new `.spf` output.

Stop at the manual acceptance gate. After explicit acceptance, freshly rerun required verification, stage only intended files, create the conventional commit, push without force, and open a pull request to `dev` that closes Issue 126. Do not merge automatically.
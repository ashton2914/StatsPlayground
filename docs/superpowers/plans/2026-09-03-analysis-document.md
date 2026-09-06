# Analysis Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project-internal `.span` Analysis documents whose tables and graphs are rendered only from live typed Rust backend results.

**Architecture:** Analysis is a typed, report-like project document with its own store, folder assignments, archive kind, and dedicated view. A Distribution definition is embedded in the Analysis file, while the existing Distribution backend service remains the sole source of computed statistics and graph data; runtime responses are fenced and never persisted.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri v2, Rust, DuckDB, ECharts, Playwright Component Testing

**Spec:** `docs/superpowers/specs/2026-09-03-analysis-document-design.md`

## Global Constraints

- `.span` is project-internal in this release; do not add external import/export.
- Analysis files persist definitions and presentation settings only.
- Never persist or generate Markdown numeric tables, summary rows, quantile rows, graph frames, or backend result blocks.
- Every displayed statistic and graph coordinate must come from the existing typed Distribution Rust service.
- Fence results by analysis ID, config revision, dataset ID, dataset generation/data version, definition fingerprint, and latest request token.
- Preserve existing `.sprp` and `.spdist` behavior and archive compatibility.
- Preserve unrelated user changes in `src-tauri/Cargo.toml` and generated Tauri schemas.
- Use `Result<T, AppError>` in Rust production code; do not add `unwrap()` or `expect()` outside tests.

---

### Task 1: Analysis Definition, Store, And Sample Contract

**Files:**
- Create: `src/types/analysis.ts`
- Create: `src/stores/useAnalysisStore.ts`
- Modify: `src/types/index.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/components/analysis/analysisSample.ts`
- Create: `tests/analysisDocument.test.ts`
- Create: `tests/analysisStore.test.ts`
- Modify: `tests/analysisSample.test.ts`

**Interfaces:**
- Produces: `AnalysisDocument`, `DistributionAnalysisDefinition`, `AnalysisPresentation`, `createAnalysisSampleDocument`, and `useAnalysisStore`.
- Consumes: `DistributionAnalysisConfig`, `EmbeddedGraphConfig`, `FieldRef`, and `createDistributionItem` only as a graph-default factory.

- [ ] **Step 1: Write failing document and sample tests**

Assert that the saved object contains only a definition:

```ts
const analysis = createAnalysisSampleDocument({
  datasetId: "dataset-112",
  analysisId: "analysis-112",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-03T00:00:00.000Z",
});

assert.equal(analysis.documentType, "analysis");
assert.equal(analysis.analysisKind, "distribution");
assert.equal(analysis.source.datasetId, "dataset-112");
assert.deepEqual(analysis.definition.responses, [{ name: "DIM1", type: "continuous" }]);
assert.equal("markdown" in analysis, false);
assert.equal("reportBlocks" in analysis, false);
assert.equal("graphFrames" in analysis, false);
```

Update the sample test so `createAnalysisSample()` asserts only deterministic
`values` and `rows`; remove assertions and types for frontend `summary` and
`quantiles`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisSample.test.ts
```

Expected: FAIL because `AnalysisDocument` and
`createAnalysisSampleDocument` do not exist.

- [ ] **Step 3: Add the typed document model**

Define the concrete first-release model:

```ts
export type AnalysisKind = "distribution";

export interface AnalysisPresentation {
  schemaVersion: 1;
  layout: "distribution-v1";
}

export interface DistributionAnalysisDefinition {
  kind: "distribution";
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: DistributionItem["graphs"];
}

export interface AnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "distribution";
  configRevision: number;
  source: { datasetId: string };
  definition: DistributionAnalysisDefinition;
  presentation: AnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}
```

Implement `useAnalysisStore` with `items`, `addAnalysis`, `updateAnalysis`,
`removeAnalysis`, `loadAnalyses`, `reset`, and a collision-safe name helper,
matching the immutable update and read-only behavior of `useReportStore`.

- [ ] **Step 4: Remove frontend statistics from the sample**

Delete `quantile`, `AnalysisSampleQuantile`, `AnalysisSampleSummary`, and all
summary/quantile calculations. Keep Box-Muller input generation. Build the
embedded Distribution definition using current `createDistributionItem`
defaults and copy only its roles, analysis config, and graph configs into the
Analysis document.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisSample.test.ts
```

Expected: all three commands print their pass messages and exit 0.

- [ ] **Step 6: Commit the model slice**

```powershell
git add src/types/analysis.ts src/types/index.ts src/stores/useAnalysisStore.ts src/stores/index.ts src/components/analysis/analysisSample.ts tests/analysisDocument.test.ts tests/analysisStore.test.ts tests/analysisSample.test.ts
git commit -m "feat(analysis): add typed analysis documents"
```

### Task 2: `.span` Archive And Project Contracts

**Files:**
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Create: `tests/analysisProjectContracts.test.ts`
- Modify: Rust unit tests in the three touched service modules

**Interfaces:**
- Consumes: `AnalysisDocument[]` from Task 1.
- Produces: `SaveProjectRequest.analyses`, `analysisFolders`,
  `OpenProjectResult.analyses`, `DocumentKind::Analysis`, and strict
  `analyses/<name>.span` archive entries.

- [ ] **Step 1: Write failing source-contract and Rust archive tests**

The TS contract test must assert the save/open models include `analyses` and
`analysisFolders`, and the archive source includes `DocumentKind::Analysis`,
`.span`, and `analyses`.

Add a Rust archive round-trip fixture containing:

```rust
serde_json::json!({
    "schemaVersion": 1,
    "documentType": "analysis",
    "id": "analysis-1",
    "name": "DIM1 Analysis",
    "analysisKind": "distribution",
    "configRevision": 0,
    "source": { "datasetId": "dataset-1" },
    "definition": { "kind": "distribution", "responses": [], "weight": null,
        "frequency": null, "by": [], "analysis": {}, "graphs": {} },
    "presentation": { "schemaVersion": 1, "layout": "distribution-v1" },
    "createdAt": "2026-09-03T00:00:00.000Z",
    "updatedAt": "2026-09-03T00:00:00.000Z"
})
```

Also assert validation rejects top-level `markdown`, `reportBlocks`,
`graphFrames`, and `result` fields.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
Set-Location src-tauri
cargo test analysis_document
Set-Location ..
```

Expected: FAIL because project/archive Analysis fields are absent.

- [ ] **Step 3: Extend save/open and manifest models**

Add defaulted Rust fields:

```rust
#[serde(default)]
pub analyses: Vec<serde_json::Value>,
#[serde(default)]
pub analysis_folders: HashMap<String, String>,
```

Thread them through `SaveSnapshot`, `OpenProjectResult`, `ProjectBundle`, bundle
builders, readers, and streaming writer calls. Mirror camelCase fields in TS.

- [ ] **Step 4: Add strict `.span` allocation and validation**

Add `DocumentKind::Analysis`, a manifest `analyses` collection, unique active
document IDs, and path allocation with:

```rust
allocate_archive_name(&name, &id, ".span", "analyses", &mut used_analysis_paths)
```

Implement `validate_analysis_value` to require the envelope fields and reject
persisted-result keys. Use existing path/name/ID validators; preserve empty
defaults for older archives.

- [ ] **Step 5: Run focused archive tests to verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
Set-Location src-tauri
cargo test analysis_document
cargo test archive
Set-Location ..
```

Expected: Analysis tests and existing archive tests pass.

- [ ] **Step 6: Commit the archive slice without generated schema files**

```powershell
git add src-tauri/src/models/save.rs src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/services/streaming_project_writer.rs src/types/project.ts src/services/projectService.ts tests/analysisProjectContracts.test.ts
git commit -m "feat(project): persist analysis documents"
```

### Task 3: Folder And Workspace Lifecycle

**Files:**
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/utils/projectFileNaming.ts`
- Modify: `src/components/Workspace.tsx`
- Create: `tests/folderStore.analysis.test.ts`
- Modify: `tests/projectFileNaming.test.ts`
- Create: `tests/workspaceAnalysis.test.ts`

**Interfaces:**
- Consumes: `useAnalysisStore`, `AnalysisDocument`, project save/open fields.
- Produces: Analysis Directory nodes, `.span` naming, CRUD, active routing,
  save/open/reset, and source-unavailable retention.

- [ ] **Step 1: Write failing folder, naming, and Workspace tests**

Assert `.span` naming:

```ts
assert.equal(projectFileExtension("analysis"), ".span");
assert.equal(ensureProjectFileName("DIM1 Analysis", "analysis"), "DIM1 Analysis.span");
```

Assert folder state supports `analysisFolders` and `setAnalysisFolder`. In the
Workspace source contract require `activeAnalysisId`, `addAnalysis`,
`analysisFolders`, `AnalysisView`, save/open/reset wiring, and forbid sample
`addReport`, `addDistribution`, and `addGraphBuilder`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/folderStore.analysis.test.ts
npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts
```

Expected: FAIL on missing Analysis lifecycle fields.

- [ ] **Step 3: Add folder and naming support**

Extend the folder store with a dedicated assignment map while reusing its
generic move, prune, remap, hydrate, and reset helpers. Add `analysis` and
`.span` to project file naming types, known extensions, and extension mapping.

- [ ] **Step 4: Wire Analysis through Workspace**

Add Analysis store selectors and `activeAnalysisId`. Include Analysis in all
mutually exclusive active-document clearing paths, Directory rendering and
context actions, rename/delete/move, save payload, open hydration, project
reset, and folder pruning. Deleting a source dataset clears the active Analysis
view if needed but does not remove the saved Analysis document.

- [ ] **Step 5: Run focused lifecycle tests to verify GREEN**

Run the three Task 3 commands again. Expected: PASS.

- [ ] **Step 6: Commit the Workspace lifecycle**

```powershell
git add src/stores/useFolderStore.ts src/utils/projectFileNaming.ts src/components/Workspace.tsx tests/folderStore.analysis.test.ts tests/projectFileNaming.test.ts tests/workspaceAnalysis.test.ts
git commit -m "feat(workspace): integrate analysis documents"
```

### Task 4: Live Distribution Analysis Execution And View

**Files:**
- Create: `src/components/analysis/useAnalysisExecution.ts`
- Create: `src/components/analysis/AnalysisView.tsx`
- Create: `src/components/analysis/index.ts`
- Modify: `src/components/distribution/DistributionView.tsx`
- Modify: `src/components/distribution/useDistributionReport.ts`
- Modify: `src/components/Workspace.tsx`
- Create: `tests/analysisExecution.test.ts`
- Create: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: Analysis definition and current `DatasetMeta`.
- Produces: fenced runtime state using the existing Distribution Tauri service,
  plus dedicated Analysis rendering with no Markdown path.

- [ ] **Step 1: Write failing execution-fence tests**

Model the existing Distribution controller test and assert a response is
discarded when any of these changes before resolution: `analysis.id`,
`configRevision`, source dataset ID, dataset generation, definition
fingerprint, or latest request token.

The component test must mock the Distribution service response and assert:

```ts
await expect(component.getByRole("heading", { name: "Quantiles" })).toBeVisible();
await expect(component.getByText("101.044792")).toBeVisible();
await expect(component.locator(".report-editor")).toHaveCount(0);
```

Then change the mocked backend quantile and verify the rendered cell changes
without mutating the Analysis document fixture.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx
```

Expected: FAIL because executor and view do not exist.

- [ ] **Step 3: Extract reusable Distribution presentation helpers**

Move graph materialization and the presentational graph/report composition to
helpers accepting a Distribution definition plus runtime result. Preserve
`DistributionView` behavior and axis controls. Do not add formulas or convert
result values to Markdown.

- [ ] **Step 4: Implement the Analysis executor and renderer**

Adapt the embedded definition to the existing Distribution request builder.
The hook owns runtime-only state and checks all fence inputs before accepting a
response. `AnalysisView` dispatches `analysisKind: "distribution"`, renders
structured graph frames and `DistributionReport`, and handles loading, backend
error, unsupported schema, and missing source states.

- [ ] **Step 5: Run focused Analysis and Distribution regression tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx
npm run test:distribution:report
npm run test:distribution:adapter
```

Expected: all pass; Analysis renders backend values and existing Distribution
rendering is unchanged.

- [ ] **Step 6: Commit the runtime slice**

```powershell
git add src/components/analysis src/components/distribution/DistributionView.tsx src/components/distribution/useDistributionReport.ts src/components/Workspace.tsx tests/analysisExecution.test.ts tests/analysisView.spec.tsx
git commit -m "feat(analysis): render live backend results"
```

### Task 5: Replace Issue 112 Sample Assembly

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/workspaceAnalysisSample.test.ts`
- Replace: `tests/analysisSample.spec.tsx`
- Modify: four `src/i18n/locales/*.json` files only where Analysis labels require it
- Modify: `package.json`

**Interfaces:**
- Consumes: `createAnalysisSample`, `createAnalysisSampleDocument`,
  `useAnalysisStore`, and `AnalysisView`.
- Produces: transactional dataset + one Analysis sample flow and
  `npm run test:analysis`.

- [ ] **Step 1: Rewrite the sample integration tests**

Require this exact lifecycle in the handler: create rows, create backend table,
refresh metadata, create/add Analysis, activate Analysis, mark dirty, and on
failure remove Analysis then delete dataset. Forbid calls to `addReport`,
`addDistribution`, and `addGraphBuilder`.

Replace the obsolete Markdown Report component test with the real
`AnalysisView` component test or remove it if Task 4 already covers the same
behavior without losing assertions.

- [ ] **Step 2: Run sample tests to verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisSample.test.ts
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx
```

Expected: Workspace test fails until the handler creates Analysis.

- [ ] **Step 3: Implement transactional sample creation**

Create exactly one dataset and one Analysis document. Keep backend table
registration and refresh before store insertion. Track IDs for reverse-order
rollback. Remove sample-only Markdown report strings, graph/report factories,
and CSS changes. Keep localized menu/history/error labels.

- [ ] **Step 4: Add the Analysis test script**

Add a script that runs all Analysis Node tests followed by the Analysis CT:

```json
"test:analysis": "tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts && tsx --tsconfig tsconfig.app.json tests/analysisStore.test.ts && tsx --tsconfig tsconfig.app.json tests/analysisSample.test.ts && tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts && tsx --tsconfig tsconfig.app.json tests/folderStore.analysis.test.ts && tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts && tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisSample.test.ts && tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts && playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx"
```

- [ ] **Step 5: Run sample and Analysis suites to verify GREEN**

Run `npm run test:analysis`. Expected: all Node contracts and CT pass.

- [ ] **Step 6: Commit the sample flow**

```powershell
git add src/components/Workspace.tsx src/components/analysis/analysisSample.ts tests/workspaceAnalysisSample.test.ts tests/analysisSample.spec.tsx tests/analysisView.spec.tsx src/i18n/locales package.json
git commit -m "fix(analysis): create live sample analysis"
```

### Task 6: Full Verification And Runtime Acceptance

**Files:**
- Modify only files required by failures caused by this feature.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: verified frontend, archive, backend, and Tauri runtime behavior.

- [ ] **Step 1: Run frontend suites**

```powershell
npm run test:analysis
npm run test:distribution
npm run build
```

Expected: all tests pass and Vite build exits 0. Existing chunk-size warnings
may remain.

- [ ] **Step 2: Run backend verification with the shared target cache**

```powershell
$env:CARGO_TARGET_DIR='C:\Users\v-zhichuang\git\ashton2914\StatsPlayground\src-tauri\target'
Set-Location src-tauri
cargo test
cargo build
Set-Location ..
```

Expected: both commands exit 0. Do not edit or stage unrelated Cargo/schema
changes to address pre-existing diagnostics.

- [ ] **Step 3: Run archive hygiene checks**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional feature files plus preserved
unrelated user changes remain.

- [ ] **Step 4: Start and verify the Tauri app**

Free port 1420 only if its listener belongs to a stale StatsPlayground
worktree. Start Issue 112 with the main target cache:

```powershell
$env:CARGO_TARGET_DIR='C:\Users\v-zhichuang\git\ashton2914\StatsPlayground\src-tauri\target'
.\node_modules\.bin\tauri.cmd dev
```

Verify the Vite command line contains `StatsPlayground-issue-112`, the
StatsPlayground window is responsive, and `Analyze > Sample Analysis` opens an
Analysis view populated after a real backend call with no Markdown editor.

- [ ] **Step 5: Final review and commit**

Review the branch diff against the spec. If verification required scoped
repairs, commit only those feature files:

```powershell
git commit -m "test(analysis): verify live analysis workflow" <verified-files>
```

Do not stage `src-tauri/Cargo.toml` or generated schemas unless their changes
are proven to be required by this feature.
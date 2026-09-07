# Issue 107 Distribution Analysis Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy editable Distribution workflow with a complete, archive-compatible Distribution Analysis module.

**Architecture:** A pure frontend hydration migration converts legacy Distribution definitions and folder assignments into canonical Analysis documents. Workspace creates and manages only Analysis documents, while `useAnalysisExecution` and shared Analysis presentation primitives render the complete Rust-authoritative result.

**Tech Stack:** React 19, TypeScript, Zustand, Playwright Component Testing, Tauri v2, Rust, ECharts Graph Core

**Spec:** `docs/superpowers/specs/2026-09-06-issue-107-distribution-analysis-migration-design.md`

## Global Constraints

- New Distribution commands create `AnalysisDocument` values only.
- Existing `.spdist` documents migrate in memory on project open and are rewritten only after explicit save.
- Rust is the sole source of statistical values and graph frames.
- Histogram, fitted curve, and box plot are one approved fixed composite; ECDF and Normal Quantile are independent graph components.
- Axis-only presentation changes do not increment `configRevision`; statistical input changes increment it exactly once.
- Existing Analysis documents win ID and name collisions and are never overwritten.
- Do not modify or discard the uncommitted files in `StatsPlayground-issue-107`.
- Do not create commits without explicit user approval.

---

### Task 1: Deterministic Legacy Migration

**Files:**
- Create: `src/components/analysis/distributionAnalysisMigration.ts`
- Modify: `src/components/analysis/index.ts`
- Create: `tests/distributionAnalysisMigration.test.ts`

**Interfaces:**
- Consumes: `AnalysisDocument[]`, `Record<string, string>`, `DistributionItem[]`, and `Record<string, string>`.
- Produces: `migrateLegacyDistributions(input): DistributionAnalysisMigrationResult`.

```ts
export interface DistributionAnalysisMigrationInput {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  distributions: DistributionItem[];
  distributionFolders: Record<string, string>;
}

export interface DistributionAnalysisMigrationResult {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  migratedCount: number;
}
```

- [ ] Write a failing test proving one legacy definition becomes a valid `distribution-v1` Analysis while preserving every input and all four graph configs.
- [ ] Run `npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisMigration.test.ts` and confirm the missing module/export is the failure.
- [ ] Implement minimal pure conversion with `configRevision: 1`, `updatedAt: createdAt`, structured clones, and no service calls.
- [ ] Rerun the focused test and require PASS.
- [ ] Add failing cases for case-insensitive name collisions, ID collisions, and folder transfer to the resolved ID.
- [ ] Implement deterministic `-migrated-N` IDs and `.span` basename allocation with `allocateProjectBasename`.
- [ ] Rerun the focused test and require PASS.

### Task 2: Canonical Project Hydration And Save

**Files:**
- Modify: `src/components/analysis/analysisWorkspaceLifecycle.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/workspaceAnalysis.test.ts`
- Modify: `tests/workspaceDistribution.test.ts`

**Interfaces:**
- `hydrateAnalysisProjectPayload` invokes `migrateLegacyDistributions` and returns `migratedCount` with canonical `analyses` and `analysisFolders`.
- Workspace hydrates `useDistributionStore` with `[]` and marks the project dirty when `migratedCount > 0`.
- Save payloads emit canonical `analyses` and an empty legacy `distributions` collection.

- [ ] Add failing hydration contract tests for migration, existing Analysis preservation, folder transfer, and zero-migration identity behavior.
- [ ] Run `npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts` and verify the expected contract failure.
- [ ] Implement migration in the Analysis hydration boundary and rerun the focused test to PASS.
- [ ] Add failing Workspace source-contract tests proving the Distribution store is cleared, migrated projects become dirty, and save payloads cannot duplicate legacy entries.
- [ ] Update Workspace open/save orchestration minimally and rerun `tests/workspaceAnalysis.test.ts` plus `tests/workspaceDistribution.test.ts` to PASS.

### Task 3: Create Distribution As Analysis

**Files:**
- Modify: `src/components/analysis/adapters/distributionAnalysisAdapter.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useAnalysisStore.ts` only if a canonical factory belongs there
- Modify: `tests/distributionAnalysisAdapter.test.ts`
- Modify: `tests/workspaceAnalysis.test.ts`
- Modify: `tests/workspaceDistribution.test.ts`

**Interfaces:**
- Produces: `createDistributionAnalysisDocument(item, updatedAt): AnalysisDocument`.
- The existing Distribution dialog submission resolves an Analysis basename, adds through `useAnalysisStore`, assigns an Analysis folder, activates `activeAnalysisId`, and records Analysis history.

```ts
export function createDistributionAnalysisDocument(
  item: DistributionItem,
  updatedAt: string,
): AnalysisDocument;
```

- [ ] Add a failing adapter test for the canonical factory envelope and definition fidelity.
- [ ] Run `npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisAdapter.test.ts` and confirm the missing export fails.
- [ ] Implement the factory by sharing the same conversion used by migration, then rerun the adapter test to PASS.
- [ ] Add failing Workspace contracts proving new Distribution submission activates Analysis and never calls `addDistribution`.
- [ ] Replace the create handler and directory insertion with the Analysis lifecycle, then rerun the focused Workspace tests to PASS.

### Task 4: Complete Distribution Analysis Presentation

**Files:**
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `src/components/analysis/analysis.css`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/distributionPresentation.tsx` only to extract typed report content without a second page shell
- Modify: `tests/analysisView.spec.tsx`
- Modify: `tests/distributionReportWiring.test.ts`
- Modify: `tests/distributionVisualCompatibility.test.ts`

**Interfaces:**
- `AnalysisView` materializes `overview`, `ecdf`, and `normalQuantile` graph items from the persisted Analysis definition.
- The overview graph merges backend overview and box-plot aggregate frames into the approved fixed composite.
- A report-content component receives `DistributionReportResponse` and renders the complete grouped report inside shared Analysis frames.

- [ ] Add failing component assertions for exactly three graph regions: composite overview, ECDF, and Normal Quantile.
- [ ] Add failing assertions that grouped quantiles, full summary values, fit details/comparison, compatibility status, and capability content are reachable from the Analysis page.
- [ ] Run `npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx` and verify the missing Normal Quantile/full-report assertions fail.
- [ ] Add the independent Normal Quantile Graph Builder graph and preserve per-role axis-dialog persistence.
- [ ] Replace sample-only summary rendering with the complete typed Distribution report content inside `AnalysisFrame`/`AnalysisStack`; do not add a second page shell.
- [ ] Rerun the component and report wiring tests and require PASS.
- [ ] Run `npx tsx --tsconfig tsconfig.app.json tests/distributionVisualCompatibility.test.ts` and require PASS.

### Task 5: Retire The Legacy Editable Control Path

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/distribution/index.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Modify: focused folder/selection tests under `tests/`
- Retain: Rust legacy Distribution archive readers and validators

**Interfaces:**
- Workspace no longer renders `DistributionView`, tracks `activeDistributionId`, or exposes Distribution rename/move/delete actions.
- TypeScript save requests keep a compatibility `distributions` field only where the Tauri command schema still requires it, always passing `[]`.

- [ ] Add failing source-contract tests that reject legacy active-selection/render/create paths while retaining the dialog editor adapter.
- [ ] Remove legacy production routing, selection, and directory actions without deleting reusable report/editor/Graph Adapter code.
- [ ] Rerun Analysis, Distribution, folder, source-deletion, and project-save focused tests until PASS.
- [ ] Run `npx tsc -p tests/tsconfig.contracts.json` and fix only migration-related type errors.

### Task 6: End-To-End Verification

**Files:**
- Modify only defects exposed by verification and only within the approved scope.

- [ ] Run `npm run test:analysis`.
- [ ] Run `npm run test:distribution`.
- [ ] Run `npm run test:fit-model` as an adjacent Analysis lifecycle regression gate.
- [ ] Run `npm run build`.
- [ ] Run the focused Rust archive tests in `src-tauri` with `cargo test spprj_archive` and `cargo test project_service`.
- [ ] Run `cargo clippy --all-targets` and report pre-existing warnings separately from new findings.
- [ ] Inspect the final diff for persisted computed values, duplicate document ownership, accidental old-worktree changes, and unrelated formatting churn.
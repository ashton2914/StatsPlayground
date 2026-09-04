# Analysis Shell and Editor Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize every Analysis page behind one shell and make the Sample Distribution configuration editable in place.

**Architecture:** A presentation-only `AnalysisShell` receives semantic summary entries and result children. A Distribution adapter owns `.span`/dialog conversion, while Workspace owns modal state and applies one atomic revisioned patch.

**Tech Stack:** React 19, TypeScript, Zustand, Playwright Component Testing

**Spec:** `docs/superpowers/specs/2026-09-04-analysis-shell-and-editor-adapters-design.md`

## Global Constraints

- Shell code must not import Distribution types.
- Save preserves Analysis ID, name, creation time, and folder assignment.
- Save increments `configRevision` by exactly one; Cancel performs no update.
- Rust remains authoritative for all computed results.
- Missing-source and read-only states disable `Edit Inputs`.

---

### Task 1: Shared Analysis Shell

**Files:**
- Create: `src/components/analysis/presentation/AnalysisShell.tsx`
- Modify: `src/components/analysis/presentation/analysisPresentation.css`
- Modify: `src/components/analysis/presentation/index.ts`
- Create: `tests/analysisShell.spec.tsx`

**Interfaces:**
- Produces: `AnalysisSummaryEntry { key: string; label: ReactNode; value: ReactNode }`
- Produces: `AnalysisShell({ title, sourceName, summary, canEditInputs, onEditInputs, children })`

```ts
export interface AnalysisSummaryEntry {
	key: string;
	label: ReactNode;
	value: ReactNode;
}

export interface AnalysisShellProps {
	title: ReactNode;
	sourceName: ReactNode;
	summary: AnalysisSummaryEntry[];
	canEditInputs: boolean;
	onEditInputs?: () => void;
	children: ReactNode;
}
```

- [ ] Write a failing component test for title placement, Source and option rows, Edit Inputs callback, and disabled behavior.
- [ ] Run `npx playwright test -c playwright-ct.config.ts tests/analysisShell.spec.tsx` and confirm missing exports fail.
- [ ] Implement the shell with a fixed information rail and scrollable result region; use a normal command button for Edit Inputs.
- [ ] Rerun the focused test and require PASS.
- [ ] Commit only Task 1 files with `feat(analysis): add shared analysis shell`.

### Task 2: Distribution Analysis Adapter

**Files:**
- Create: `src/components/analysis/adapters/distributionAnalysisAdapter.ts`
- Create: `src/components/analysis/adapters/index.ts`
- Create: `tests/distributionAnalysisAdapter.test.ts`

**Interfaces:**
- Produces: `describeDistributionAnalysis(document, dataset): AnalysisSummaryEntry[]`
- Produces: `toDistributionEditorItem(document): DistributionItem`
- Produces: `createDistributionAnalysisPatch(document, submitted, updatedAt): AnalysisDocumentPatch`

```ts
export function describeDistributionAnalysis(
	document: AnalysisDocument,
	dataset: DatasetMeta | null,
	translate: (key: string, values?: Record<string, unknown>) => string,
): AnalysisSummaryEntry[];

export function toDistributionEditorItem(document: AnalysisDocument): DistributionItem;

export function createDistributionAnalysisPatch(
	document: AnalysisDocument,
	submitted: DistributionItem,
	updatedAt: string,
): AnalysisDocumentPatch;
```

- [ ] Write failing tests proving semantic summary values, editor initialization, graph replacement, identity preservation, and `configRevision + 1`.
- [ ] Run `tsx --tsconfig tsconfig.app.json tests/distributionAnalysisAdapter.test.ts` and confirm missing exports fail.
- [ ] Implement pure conversion functions; do not invoke services or calculate statistics.
- [ ] Rerun the adapter test and require PASS.
- [ ] Commit only Task 2 files with `feat(analysis): add distribution editor adapter`.

### Task 3: Sample and Workspace Editing Lifecycle

**Files:**
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `src/components/analysis/analysis.css`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/analysisView.spec.tsx`
- Modify: `tests/workspaceAnalysis.test.ts`

**Interfaces:**
- `AnalysisView` adds `canEditInputs?: boolean` and `onEditInputs?: () => void`.
- Workspace stores `editingAnalysisId: string | null`, opens the matching selector, and applies the adapter patch through `updateAnalysis`.

The Workspace save path is exactly:

```ts
const editing = analysisItems.find((item) => item.id === editingAnalysisId);
if (!editing) return;
updateAnalysis(editing.id, createDistributionAnalysisPatch(
	editing,
	submitted,
	new Date().toISOString(),
));
setEditingAnalysisId(null);
markDirty();
```

- [ ] Add failing AnalysisView assertions for Shell title/summary and Edit Inputs.
- [ ] Add failing Workspace source-contract assertions for editor state, `initialItem`, Cancel, and revisioned update.
- [ ] Replace AnalysisView page-specific layout with `AnalysisShell` and adapter summaries.
- [ ] Wire Workspace to load Distribution columns, render `DistributionDialog` with adapter initial state, Cancel without mutation, and Save through one `updateAnalysis` call.
- [ ] Add localized `editInputs`, summary labels, and update-history strings in all four locales.
- [ ] Run `npm run test:analysis`, the adapter and primitive tests, `npm run test:distribution`, and `npm run build`.
- [ ] Commit Task 3 files with `feat(analysis): edit sample inputs from shared shell`.
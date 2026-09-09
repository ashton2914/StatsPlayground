# Issue 137 Fit Model Analysis Migration Design

## Context

Fit Model currently owns a parallel document lifecycle: `useFitModelStore`,
`fitModelFolders`, Workspace selection and dispatch, a report request controller,
and bespoke report markup. Distribution and Fit Y by X already use the Analysis
document standard. Issue 137 migrates Fit Model into that standard and adds only
the shared presentation capabilities proven necessary by the existing Fit Model
surface.

## Scope

This change migrates Fit Model only. Fit Y by X remains a separate, existing
Analysis kind. The current Rust Fit Model engine, Tauri command, TypeScript
service, numerical behavior, save-columns mutation, prediction profiler, and all
user-visible report sections remain authoritative and functionally intact.

The change adds:

- a native `fitModel` Analysis kind;
- a shared Analysis button primitive;
- controlled checkbox selection and typed row actions for Analysis tables;
- custom Analysis graph composition for every Fit Model graph;
- one-way migration of legacy `fitModels` and `fitModelFolders` project data.

It does not add a schema-driven report DSL, Graph Builder editing for Fit Model,
new statistical methods, new report sections, or a frontend statistical fallback.

## Invariants

1. Rust remains the sole statistical authority.
2. Persisted Analysis documents contain definitions and presentation only, never
   computed Fit Model results, diagnostics, plot rows, or disclosure state.
3. Every asynchronous result is protected by the complete Analysis stale fence.
4. A Fit Model definition change increments `configRevision`; local disclosure,
   diagnostic filtering, dialog state, and presentation-only state do not.
5. Existing project IDs, names, timestamps, source datasets, folder assignments,
   model definitions, and load-problem visibility survive migration.
6. New project saves write Fit Model only through `analyses` and
   `analysisFolders`. Legacy fields remain read-compatible but are not written.
7. All Fit Model graphs use `AnalysisGraph` with `mode: "custom"`. They never
   masquerade as editable Graph Builder documents.
8. Existing Distribution and Fit Y by X behavior and persisted contracts do not
   change.

## Persisted Contract

Add `fitModel` to `AnalysisKind`, `AnalysisDocumentByKind`,
`contracts/analysis/kinds.v1.json`, descriptor registration, execution, view,
editor, graph, report, and Rust archive validation records.

`FitModelAnalysisDefinition` contains:

```ts
interface FitModelAnalysisDefinition {
  kind: "fitModel";
  response: FieldRef;
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  confidenceLevel: number;
  migrationIssue?: FitModelLoadIssue;
}
```

`FitModelAnalysisPresentation` is version 1 with layout
`"fit-model-v1"`. It does not persist graph options or report disclosure state.
The descriptor declares `graphEditing: false`. Its graph policy is `null`.
Report embedding remains `false` because the legacy Fit Model surface does not
currently provide that capability; it can be added later through the normal
Analysis registration path.

`migrationIssue` exists only to preserve malformed legacy entries without
silently deleting them. A migrated document carrying it is visible but cannot
execute until repaired. New documents never create this field.

## Execution And Host Actions

The `fitModel` executor constructs the existing `FitModelRequest` and invokes
`fitModelService.run`. It fingerprints every statistical input listed in the
definition and checks response identity through the shared Analysis execution
controller. A `migrationIssue` causes a deterministic local unavailable state
without an IPC call.

Analysis view props gain controlled host actions needed by interactive kinds:

```ts
onDefinitionChange?: (patch: AnalysisDocumentPatch) => void;
onDatasetChanged?: () => Promise<void>;
```

Workspace owns document mutation, read-only enforcement, dirty state, history,
and dataset refresh. The Fit Model renderer owns only transient UI state and
calls these host actions. Remove and Undo create a complete next definition and
increment `configRevision`. Save Columns continues through the existing typed
service and table-history transaction, then asks the host to refresh the dataset.

## Shared Presentation Primitives

Add `AnalysisButton`, a thin accessible wrapper around a native button. It
supports `tone: "default" | "primary" | "danger"`, native disabled semantics,
an optional pending label, and ordinary React children. It must not encode Fit
Model-specific action names.

Extend `AnalysisTable` without breaking its existing static API:

```ts
interface AnalysisTableSelection {
  selectedRowKeys: ReadonlySet<string>;
  onToggle: (rowKey: string, checked: boolean) => void;
  isDisabled?: (row: AnalysisTableRow) => boolean;
  getLabel: (row: AnalysisTableRow) => string;
}

interface AnalysisTableRowAction {
  key: string;
  label: string;
  onInvoke: () => void;
  disabled?: boolean;
  tone?: AnalysisButtonTone;
}
```

When `selection` is supplied, the table renders one leading checkbox column.
When `getRowActions` is supplied, it renders one trailing actions column using
`AnalysisButton`. Static tables render exactly as before. Save Columns uses the
selection form; Effect Summary uses row actions. Other Fit Model result tables
remain static shared tables.

## Result Composition And Graphs

Create a synchronous `FitModelAnalysisResults` renderer under the Analysis
renderers directory. It composes `AnalysisShell`, nested `AnalysisFrame`,
`AnalysisText`, `AnalysisTable`, `AnalysisButton`, and `AnalysisGraph`.

The renderer preserves Model Specification, Effect Summary, Summary of Fit,
ANOVA, Lack of Fit, Parameter Estimates, Actual by Predicted, Residual by
Predicted, Residual Q-Q, Row Diagnostics, Prediction Profiler, Warnings,
not-computable, stale, error-with-old-result, and source-missing states.

Actual by Predicted, Residual by Predicted, and Residual Q-Q reuse the existing
option factories and ECharts lifecycle component inside `AnalysisGraph` custom
strategies. Prediction Profiler is also mounted through a custom strategy. No
custom series or histogram bin math changes are required.

## Legacy Project Migration

At project-open time, normalize legacy `fitModels` with the existing Fit Model
validation and canonicalization rules, then adapt each normalized item to a
`FitModelAnalysisDocument`.

- Existing new-format Analysis IDs win on collision.
- Non-colliding legacy IDs are appended in original order.
- `fitModelFolders[id]` moves to `analysisFolders[id]` unless a new-format
  assignment for that ID already exists.
- Duplicate terms retain the first canonical term and emit the existing migration
  warning.
- Invalid definitions retain their normalized recoverable data plus
  `migrationIssue` and remain visible but non-executable.
- Legacy transient results, plot rows, report state, and disclosure state are
  discarded.

The Rust archive reader continues to expose legacy fields for old files. The
frontend performs the one-way adaptation before loading `useAnalysisStore`.
Save requests omit legacy Fit Model arrays and folder maps. Rust validates new
`fitModel` Analysis documents explicitly by both analysis and definition kind.

After migration tests pass, remove `useFitModelStore`, separate Fit Model
selection, `fitModelFolders`, old Workspace save/open/dispatch branches, and the
standalone report execution controller. Retain pure Fit Model configuration,
report-model, equation, prediction, graph-option, profiler, dialog, save-columns,
service, and backend modules that the new Analysis kind reuses.

## Error Handling

- Missing source dataset renders the shared source-missing state and does not run.
- A migration issue renders its preserved detail and does not run.
- A request failure with a prior result keeps the prior result and shows the
  shared stale/error notice.
- Save Columns keeps the existing distinction between mutation failure and
  post-commit refresh failure.
- Read-only projects disable definition mutations and table-changing actions.
- Unknown kind, schema, definition, or presentation identities never fall back to
  another Analysis kind.

## Test Strategy

TDD proceeds from contracts to lifecycle to presentation:

1. RED/GREEN cross-language kind manifest and Rust validator parity.
2. RED/GREEN document adapter, fingerprint, executor, response identity, and full
   stale-fence tests.
3. RED/GREEN legacy valid/invalid/collision/folder one-way migration and save
   payload tests.
4. RED/GREEN `AnalysisButton` and static/selection/action `AnalysisTable`
   component tests using real rendered behavior.
5. RED/GREEN Fit Model Analysis renderer tests for all report states and actions.
6. RED/GREEN Workspace creation, editing, selection, rename, folder, delete,
   source cascade, history, and read-only behavior after removing the old store.
7. Component visual tests at desktop and mobile widths for report scrolling,
   tables, custom graphs, Profiler, and Save Columns.
8. Existing Rust Fit Model numerical and save-columns suites prove the compute
   authority was not changed.

The final gate is:

```text
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
npm run test:fit-model
npm run test:fit-model:ui
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
git diff --check
```

On machines without the Playwright-managed Chromium binary, component tests use
an ephemeral local config targeting the installed system Chrome; that config is
not committed.

## Manual Acceptance

Open a legacy project containing Fit Model entries and confirm each appears once
under Analysis with its original folder. Create a new Fit Model, exercise every
report section, Remove/Undo an effect, filter diagnostics, save selected columns,
and inspect all custom graphs and Profiler at desktop and narrow window sizes.
Save and reopen the project, verify only the new Analysis representation remains,
and confirm Distribution and Fit Y by X still operate normally.

# Analysis Document Design

**Date:** 2026-09-03
**Status:** Approved design, pending written-spec review

## Goal

Introduce Analysis as a first-class project document that behaves like a
highly specialized Report while preserving JMP Pro-style statistical
integrity.

An Analysis document owns its source binding, analysis parameters, presentation
layout, and file identity. It never owns calculated statistics. Every numeric
table and graph is produced from the current source data by a typed backend
analysis function and rendered from that structured response.

The first Analysis kind is Distribution. The architecture must allow later
kinds, such as Fit Y by X and Process Capability, to reuse the same document,
directory, history, persistence, execution-state, and presentation framework.

## Non-Negotiable Statistical Contract

- An Analysis file persists definitions, not computed answers.
- Analysis content must not contain generated Markdown tables or hard-coded
  statistical values.
- Quantiles, summary statistics, fitted parameters, capability indices, graph
  coordinates, diagnostics, and status values come from a registered Rust
  analysis service.
- The frontend receives raw typed values and applies display formatting only.
- A result is displayed only when its analysis ID, configuration revision,
  source dataset ID, and source data version match the active Analysis.
- Missing, unavailable, not-applicable, unbounded, and failed values remain
  explicit states. The frontend must not replace them with fabricated zeroes or
  plausible-looking placeholders.
- Each backend result carries enough method/version/provenance information to
  identify how it was calculated and its JMP compatibility status where
  applicable.

These rules apply to every Analysis kind and are enforced at type, service, and
test boundaries.

## Scope

The first release includes:

- A project-internal `.span` Analysis document.
- A shared Analysis model and lifecycle built on reusable Report document
  infrastructure.
- A typed Distribution Analysis body embedded directly in the `.span` file.
- Live execution through the existing Distribution backend service.
- A dedicated, non-Markdown Analysis view using the existing Distribution
  charts and structured statistical tables.
- Directory selection, rename, move, delete, history, save, open, reset, and
  source-deletion handling.
- `Analyze > Sample Analysis` creating one dataset and one Analysis document.
- V4 archive validation for Analysis IDs, names, paths, and body schemas.

The first release does not include:

- External standalone `.span` import or export.
- Persisted backend responses or graph data frames.
- User-authored Markdown inside an Analysis.
- A generic drag-and-drop Analysis layout editor.
- Migration of existing Distribution, Fit Y by X, or Tabulate documents.
- Automatic conversion of the Issue 112 sample `.sprp` report. That sample is
  development-only and is replaced by the new Analysis document.

## Architectural Direction

### Considered Approaches

1. **Typed Report variant with an embedded analysis definition (selected).**
   Reuses document lifecycle infrastructure while giving Analysis its own body,
   extension, renderer, and backend executor. One Analysis appears as one file.
2. **Report referencing a separate Distribution document.**
   Reuses current entities but creates two project files and permits references
   to become detached. This does not satisfy the single-file Analysis boundary.
3. **Completely independent Analysis subsystem.**
   Gives strong isolation but duplicates store, folder, active-document,
   history, save/open, and archive behavior. This increases complexity without
   improving statistical correctness.

The selected approach shares generic document mechanics, not content formats.
Markdown Report and Analysis are sibling variants under one document
abstraction.

## Document Model

### Shared Envelope

The frontend introduces a discriminated document family:

```ts
interface DocumentEnvelopeBase {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface MarkdownReportDocument extends DocumentEnvelopeBase {
  documentType: "report";
  markdown: string;
}

interface AnalysisDocument extends DocumentEnvelopeBase {
  documentType: "analysis";
  analysisKind: AnalysisKind;
  configRevision: number;
  source: AnalysisSourceBinding;
  definition: AnalysisDefinition;
  presentation: AnalysisPresentation;
}
```

`ReportItem` remains backward-compatible with existing `.sprp` data. Loading
code normalizes an existing report without `documentType` to `"report"`.

### Source Binding

```ts
interface AnalysisSourceBinding {
  datasetId: string;
}
```

The saved file contains the stable dataset ID only. Dataset generation or
source data version is read at execution time and sent in the backend request;
it is not frozen into the saved Analysis.

### Definition Registry

The Analysis definition is a discriminated union. The first member is:

```ts
interface DistributionAnalysisDefinition {
  kind: "distribution";
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: DistributionGraphConfigs;
}
```

The stored fields correspond to the current `DistributionItem` configuration,
excluding its duplicate document envelope and source dataset ID. The Analysis
document is therefore self-contained as a definition and does not reference a
separate `.spdist` document.

Future definitions extend the union and registry. Each Analysis kind must
provide:

- Definition validation.
- Request construction.
- A typed backend command and response schema.
- A result-fencing fingerprint.
- A dedicated result renderer.
- Default presentation metadata.

### Presentation

`AnalysisPresentation` stores stable display choices only, such as visible
sections, section order, collapsed state, and embedded graph configuration.
It must not contain graph coordinates, statistics, table cells, formatted
numeric strings, backend result blocks, or Markdown-generated numeric tables.

The first release uses a fixed Distribution presentation. The model includes a
versioned presentation ID so layout can evolve without turning the document
into an unrestricted page builder.

## Persistence

### Project Archive

Analysis documents are serialized as JSON entries under:

```text
analyses/<resolved-name>.span
```

The V4 manifest adds an `analyses` collection of `DocumentEntryRef` values with
`DocumentKind::Analysis`. `SaveProjectRequest`, `SaveSnapshot`, open-project
results, and streaming writer snapshots carry `analyses` and
`analysisFolders` alongside existing document collections.

Archive validation enforces:

- Unique Analysis IDs and uniqueness in the active-document ID namespace.
- Manifest ID equals body ID.
- Manifest name equals body name and file basename.
- Entry path is inside `analyses/` and uses `.span`.
- `documentType` is `analysis`.
- Known `analysisKind`, schema version, and presentation version.
- Definition fields have the expected shape before reaching the frontend.

Computed responses are never written to `.span` or the project archive.

### Folder And Naming Behavior

Analysis uses a dedicated `analysisFolders` assignment map so it can appear in
an `ANALYSES` Directory section while sharing generic folder operations.
`projectFileNaming.ts` maps Analysis to `.span` and applies the same collision
and immutable-extension policy as other project documents.

## Execution Architecture

### Frontend Executor Registry

An Analysis runtime dispatches by `analysisKind`:

```ts
interface AnalysisExecutor<Definition, Result> {
  buildRequest(document: AnalysisDocument, dataset: DatasetMeta): unknown;
  execute(request: unknown): Promise<Result>;
  fingerprint(document: AnalysisDocument, dataset: DatasetMeta): string;
}
```

The registry is internal application code, not persisted data. Unknown kinds
render an unsupported-document state and never fall back to Markdown.

For Distribution, the executor adapts the embedded definition to the existing
`DistributionRequestV1` and invokes the existing typed Distribution service.
No statistical formula is moved into React.

### Result Lifecycle And Fencing

Results are runtime-only state owned by an Analysis execution hook. A request
captures:

- Analysis document ID.
- Analysis kind.
- Configuration revision.
- Source dataset ID.
- Source dataset generation/data version.
- Definition fingerprint.
- Monotonic request token.

The response updates the view only if every captured value still matches the
current document and dataset and the request token is latest. Editing the
definition or changing source data invalidates the displayed result and starts
a new request. The previous valid result may remain visible with an explicit
loading treatment, but it cannot be presented as current.

Closing or reopening a project always recomputes Analysis results. This is
intentional: the `.span` file describes the analysis, while the backend is the
authority for its current output.

### Backend Boundary

Each Analysis kind is backed by a thin Tauri command delegating to a Rust
service. Requests are validated before querying DuckDB. SQL identifiers are
resolved from dataset metadata and queries remain parameterized or generated
from closed, validated templates.

Distribution reuses its existing backend models and service. Its structured
response remains authoritative for:

- Summary statistics and quantiles.
- Histogram bins and probabilities.
- Box-plot coordinates and outliers.
- ECDF and normal-quantile coordinates.
- Distribution fits and diagnostics.
- Process capability results.
- Availability states, reason codes, warnings, and provenance.

If an Analysis kind lacks a backend implementation for a requested block, the
backend returns an explicit unavailable/failed block. The frontend does not
calculate a substitute.

## Frontend Presentation

### View Dispatch

The workspace routes the active document envelope by `documentType`:

- `report` renders the existing Markdown `ReportView`.
- `analysis` renders `AnalysisView`.

`AnalysisView` dispatches its body by `analysisKind`. The Distribution renderer
reuses `DistributionReport`, `GraphRuntime`, the Distribution graph adapter,
and the existing structured loading/error/empty states. It does not mount the
Markdown editor or pass computed output through Markdown parsing.

### Numeric Tables

Analysis tables are React components over typed backend responses. For
example, Quantiles and Summary Statistics rows are assembled from
`DistributionSummaryDataV1` values and status fields returned by Rust.

Formatting is presentational only:

- Raw numbers remain numbers across IPC.
- Locale controls decimal and label formatting.
- Column display metadata may control precision.
- Null and unavailable states use localized status presentation.
- Sorting or section toggles cannot change calculation semantics.

There is no code path from an Analysis result to a Markdown table string.

### Editing

The first release presents the generated sample Analysis in a dedicated view.
Configuration editing continues through the existing Distribution controls or
future Analysis-specific controls. Any definition change increments
`configRevision`, marks the project dirty, records history, and triggers a
fenced backend recomputation.

## Sample Analysis Flow

`Analyze > Sample Analysis` performs one transactional workflow:

1. Generate deterministic DIM1 input rows.
2. Create the backend dataset and refresh dataset metadata.
3. Build one `AnalysisDocument` with `analysisKind: "distribution"` and an
   embedded Distribution definition.
4. Add it to the Analysis document collection and activate `AnalysisView`.
5. Let the Analysis executor call the Distribution backend for all displayed
   values and graph frames.

It does not create a Graph Builder, a `.spdist` Distribution document, or a
Markdown `.sprp` report. On failure it removes the Analysis document and
backend dataset in reverse order. Rollback errors do not hide the primary
failure.

The current hard-coded Issue 112 Markdown quantile and summary tables are
removed. Tests must prevent their reintroduction.

## Errors And Degraded States

AnalysisView has explicit states:

- Source unavailable.
- Unconfigured definition.
- Loading/recomputing.
- Ready.
- Valid empty result.
- Partially unavailable result blocks.
- Backend error.
- Unsupported Analysis kind or schema version.

A source deletion leaves the `.span` document visible and reports the missing
source. It does not silently delete the Analysis. A backend failure preserves
the definition for correction or retry and never serializes the error as
Analysis content.

## Compatibility And Migration

- Existing `.sprp` reports continue to load unchanged.
- Existing `.spdist` documents continue using the Distribution subsystem.
- The new sample creates only `.span`; no automatic migration is required.
- V3 and older archives without `analyses` default to an empty collection.
- V4 archives validate Analysis entries strictly once the manifest contains
  them.
- Unknown future Analysis kinds remain preserved by the archive layer but are
  rejected by the current UI as unsupported rather than rendered incorrectly.

## Testing Strategy

### Contract Tests

- `AnalysisDocument` accepts only known versioned definitions.
- Distribution Analysis request construction preserves every saved parameter.
- Analysis persistence contains no response blocks, graph frames, quantile
  rows, summary rows, or generated Markdown.
- Backend request and response types remain camelCase-compatible across IPC.

### Backend Tests

- Existing Distribution service tests remain the numeric authority.
- Fixed input fixtures assert exact summary, quantile, histogram, box-plot, and
  fit outputs where deterministic.
- Invalid columns, parameter combinations, and stale source versions fail with
  the correct `AppError` category.
- Result blocks contain method/version/provenance and explicit state fields.

### Frontend Tests

- AnalysisView renders Quantiles and Summary Statistics from mocked structured
  backend responses.
- Changing mocked backend values changes rendered cells without changing the
  saved `.span` document.
- No Markdown editor appears for an Analysis.
- No test may satisfy an Analysis table assertion using a Markdown string.
- Stale responses are ignored after config revision, dataset generation,
  source binding, or active document changes.
- Source deletion and backend failure render explicit states.

### Persistence And Workspace Tests

- Save/open round-trip preserves the Analysis definition, name, folder, and
  presentation but not runtime results.
- Archive validation rejects incorrect `.span` paths, IDs, names, types, and
  schemas.
- Directory actions and undo/redo cover create, rename, move, definition edit,
  and delete.
- Sample Analysis creates exactly one dataset and one Analysis document and
  rolls both back on failure.

### End-To-End Acceptance

From a clean project, invoking `Analyze > Sample Analysis` opens a dedicated
DIM1 Analysis view. Its tables and graphs populate after a real Tauri backend
request. Modifying the source data and rerunning/reloading the Analysis changes
the displayed values. Saving and reopening the project recomputes the same
analysis from the reopened source instead of displaying persisted results.

## Implementation Sequence

1. Add the shared document envelope and Analysis definition registry.
2. Add frontend Analysis store/folder/active-document lifecycle by extracting
   reusable Report document mechanics rather than copying them.
3. Add Analysis save/open models, manifest entries, `.span` archive writing,
   and strict validation.
4. Add the runtime executor and stale-result fencing.
5. Add Distribution Analysis rendering over the existing backend result.
6. Replace the Issue 112 sample Markdown Report flow with dataset + Analysis.
7. Remove sample-only Report CSS and localization artifacts.
8. Run focused frontend/backend tests, archive round trips, full builds, and a
   Tauri acceptance check against the real backend.

## Success Criteria

- Analysis is visibly and persistently a separate `.span` project document.
- It reuses generic Report document infrastructure without using Markdown as
  its content or calculation format.
- The sample produces no `.sprp`, `.spdist`, or standalone graph document.
- Every displayed statistical value and graph coordinate comes from the live
  backend response.
- Source or parameter changes cannot leave a stale result presented as current.
- Existing Report and Distribution files remain backward-compatible.
- A future Analysis kind can be added through a definition, executor, backend
  contract, and renderer without adding another complete workspace lifecycle.
# Issue 107 Distribution Analysis Migration

**Date:** 2026-09-06
**Status:** Approved

## Goal

Rebuild Distribution as a conforming Analysis module so its document lifecycle,
execution, presentation, and project persistence match the framework introduced
for `.span` documents. Existing Distribution capability must remain available,
while the legacy editable `.spdist` control path is retired.

## Product Contract

- New Distribution commands create an `AnalysisDocument`, never a standalone
  `DistributionItem`.
- Existing project archives containing Distribution documents open through a
  one-way, in-memory migration to Analysis documents.
- Migration does not overwrite the source archive. It marks the project dirty;
  the next explicit save writes the migrated definitions as `.span` entries.
- A migrated document preserves its source, response, weight, frequency, By,
  specification limits, fitted distributions, confidence level, and all graph
  configurations.
- Statistical output remains Rust-authoritative and runtime-only. Migration and
  rendering must not calculate or persist statistics in React.
- Independent visualizations remain independent graph components. The approved
  histogram, fitted curve, and box plot are the sole fixed composite exception.

## Architecture

### Hydration Boundary

Migration belongs at the frontend project-hydration boundary. Rust remains
responsible for validating and faithfully reading both legacy `.spdist` and
current `.span` archive entries. After `open_project` returns, a pure migration
function converts the legacy definitions before Zustand stores are hydrated.

The migration function accepts the existing Analysis documents and folder map
alongside legacy Distribution documents and their folder map. It returns one
canonical Analysis collection and Analysis folder map. The Distribution store
receives an empty collection, so the application never mounts two editable
representations of the same definition.

This boundary keeps presentation schema and naming policy out of Rust archive
code, while ensuring every frontend consumer sees only the canonical model.

### Conversion Contract

For each legacy `DistributionItem`, conversion creates this envelope:

```ts
interface MigratedDistributionAnalysis extends AnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  analysisKind: "distribution";
  configRevision: 1;
  source: { datasetId: string };
  definition: DistributionAnalysisDefinition;
  presentation: { schemaVersion: 1; layout: "distribution-v1" };
}
```

`createdAt` and the original ID are retained when possible; `updatedAt` starts
at `createdAt`. A collision with an existing Analysis ID receives a stable
`-migrated-N` suffix. A case-insensitive name collision uses the existing
`.span` basename allocator and receives `-N`. Folder assignment follows the
resolved migrated ID. Existing Analysis documents always win collisions and
are never changed.

Malformed documents remain the Rust archive validator's responsibility. The
frontend migration must reject unsupported input rather than invent defaults
for required statistical fields.

### Workspace Lifecycle

The Distribution selector remains the type-specific editor adapter. Submitting
it creates or updates an `AnalysisDocument` through `useAnalysisStore`.
Selection, rename, move, delete, source deletion, history, dirty state, folder
assignment, and save payloads all use the Analysis lifecycle.

The save path emits migrated and new documents in `analyses`, emits no migrated
documents in `distributions`, and transfers folder assignments to
`analysisFolders`. Legacy Rust read support remains so older projects continue
to open.

### Execution And Presentation

`useAnalysisExecution` is the only mounted Distribution execution owner. It
builds the typed Distribution request, invokes the existing Tauri service, and
fences results by document ID, configuration revision, source ID, source
generation, definition fingerprint, and request token.

The production `AnalysisView` renders the full Distribution result:

1. Histogram, fitted curve, and box plot fixed composite through Graph Builder.
2. ECDF as an independent Graph Builder-hosted custom graph.
3. Normal Quantile as an independent Graph Builder graph.
4. Complete grouped quantiles, summary statistics, fitted-distribution details,
   fit comparison, compatibility status, and process capability output.

The page uses `AnalysisShell`, `AnalysisFrame`, `AnalysisGraph`, `AnalysisStack`,
`AnalysisTable`, and related shared primitives. Distribution-specific adapters
may format typed values but may not own page-level layout or duplicate the
Analysis shell.

Axis presentation edits update graph definitions and `updatedAt` without
incrementing `configRevision`. Statistical input edits increment
`configRevision` exactly once.

## Compatibility And Failure Behavior

- Missing sources render the standard Analysis unavailable state and retain the
  migrated definition.
- Unknown Analysis schema or presentation versions render unsupported states;
  they do not fall back to legacy Distribution rendering.
- Project-open migration is deterministic and side-effect free until hydration.
- Read-only state may display an in-memory migrated Analysis but never causes an
  automatic archive write.
- No legacy item is saved in both `distributions` and `analyses`.

## Verification

Automated coverage must prove conversion fidelity, ID and name collision
handling, folder transfer, dirty-state behavior, canonical save payloads, new
creation through Analysis, complete output rendering, graph independence,
execution fencing, and continued Rust validation of legacy archives.

The final gate includes focused TypeScript tests, Playwright component tests,
the full Analysis and Distribution suites, the Vite production build, and the
relevant Rust archive tests.

## Non-Goals

- Deleting Rust support for opening old `.spdist` entries.
- Persisting computed report or graph data.
- Creating a generic Analysis layout editor.
- Migrating Fit Y by X, Fit Model, or Tabulate in this issue.

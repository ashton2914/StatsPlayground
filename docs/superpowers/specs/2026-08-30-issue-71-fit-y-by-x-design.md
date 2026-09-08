# Fit Y by X Framework Design

**Date:** 2026-08-30

**Status:** Approved

**Issue:** #71

## Goal

Add the first Fit Y by X analysis workflow to StatsPlayground. A user chooses
Analysis > Fit Y by X, assigns one continuous Y, Response and one categorical X,
Factor, and creates a persistent analysis document in the project tree.
The document renders its one-way graph through the same Graph Builder
configuration and data pipeline used by an interactive graph.

This release establishes the reusable analysis-document and embedded-graph
boundaries. It does not attempt to reproduce every JMP Fit Y by X personality
or its inferential statistics.

## User Experience

The Analysis menu adds Fit Y by X next to Tabulate. Choosing it opens a modal
role-assignment dialog for the active table. The dialog contains:

- the source table name;
- a searchable field list with data type and modeling role;
- one Y, Response role accepting exactly one continuous numeric column;
- one X, Factor role accepting exactly one categorical column;
- Create and Cancel actions.

Create remains disabled until both roles are valid. Dropping or selecting an
invalid column leaves the existing role unchanged and presents a visible,
accessible validation message. A column cannot fill both roles. Closing or
cancelling the dialog creates no project state.

Creating the analysis adds a `Fit Y by X N` document to the project tree,
selects it, and displays the analysis on the right. The document header shows
the analysis name, source table, and assigned roles. The initial graph uses X
as the categorical horizontal axis and Y as the continuous vertical axis. It
shows the available one-way distribution through Graph Builder's existing 2D
elements, initially Points and Box Plot.

The analysis view is read-only with respect to graph roles and layers. Users
change the analysis definition by creating a new analysis in this release.
Graph interactions already supported by the shared renderer remain available
where applicable.

Deleting the source table also deletes dependent Fit Y by X documents. Rename,
delete, folder movement, project read-only behavior, save, close, and reopen
match existing project documents.

## Approaches Considered

### Recommended: Analysis Document With Shared Graph Runtime

Persist a Fit Y by X definition as its own analysis document. Convert that
definition into a canonical Graph Builder item, then pass the item through a
shared graph runtime extracted from `GraphBuilderView`. Interactive Graph
Builder and embedded analyses therefore share normalization, request
derivation, loading, errors, and rendering while retaining different editing
interfaces.

This keeps analysis semantics separate from presentation state and satisfies
the requirement that later Graph Builder rendering improvements flow into
analysis modules.

### Store The Analysis As A Graph Builder Document

Create an ordinary graph document with pre-populated X, Y, Points, and Box Plot
settings. This is smaller, but the project tree would expose an editable graph
instead of a Fit Y by X analysis. Analysis identity, future statistical options,
and results would have no stable ownership boundary. This approach is rejected.

### Build A Dedicated Fit Y By X Chart

Give the analysis view its own data request and ECharts option builder. This
would make the first screen quick to assemble, but it duplicates Graph Builder
behavior and prevents graph fixes from propagating. This approach is rejected.

## Analysis Document Model

The frontend adds a dedicated persisted type:

```ts
interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}
```

`response` and `factor` preserve both column identity and the display metadata
already carried by `FieldRef`. The semantic role is determined by the property,
not duplicated as mutable data.

`graph` is persisted so presentation choices have a versioned home and future
Fit Y by X releases can add analysis-controlled graph settings without changing
the document identity. In the first release it is produced by a pure factory
and is not edited directly in the analysis view.

The Zustand store follows the existing graph and tabulate stores. It owns item
creation, update, rename, deletion, source-table cascade deletion, project
loading, reset, and the default-name counter. Mutating actions call
`assertProjectMutable`.

The folder store gains a `fitYByXFolders` map. Fit Y by X documents participate
in the same folder tree operations as tables, graphs, and tabulates without
adding folder data to the document itself.

## Architecture And Embedded Graph Contract

Graph Builder gains a small public configuration boundary rather than a second
renderer. The first version is:

```ts
type EmbeddedGraphConfig = Pick<
  GraphBuilderItem,
  "mode" | "modeStates" | "filters" | "sampling"
>;

function createEmbeddedGraphItem(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  config: EmbeddedGraphConfig;
  createdAt: string;
}): GraphBuilderItem;
```

The Fit Y by X factory emits a current-format 2D configuration:

- `encoding.x` is the factor;
- `encoding.y` is the response;
- Points and Box Plot are enabled;
- `multiX` and `multiY` are empty;
- 3D and Multivariate states use their normal defaults;
- sampling is full data;
- filters are empty.

The contract deliberately uses current Graph Builder state instead of a second
analysis-specific chart schema. `normalizeGraphBuilderItem` remains the single
ingress normalizer.

`GraphBuilderView` is split along an ownership boundary:

- the interactive shell owns field lists, role drops, layer controls, settings,
  and writes to `useGraphBuilderStore`;
- a shared graph runtime receives a complete `GraphBuilderItem` and dataset,
  derives the graph-data request, handles loading and stale-request fencing, and
  renders Graph or Chart3D;
- the Fit Y by X view creates the complete item from its persisted analysis and
  mounts the same runtime without registering a hidden graph document.

The runtime must not mutate the supplied item. Any renderer-owned transient
state stays local. Analysis documents do not appear in `useGraphBuilderStore`,
so the project tree cannot show duplicate graph and analysis nodes.

The existing Graph Core transforms and Rust graph-data protocol are reused.
No new ECharts series, aggregate packet, or backend statistical command is
required for the first release.

## Data And Validation Rules

The dialog loads columns and display properties through the existing data
service. A pure role-assignment helper combines physical type and modeling role
into selectable field metadata.

The response is valid only when the column is numeric and modeled as
continuous. The factor is valid when modeled as nominal or ordinal. A numeric
column explicitly modeled as nominal or ordinal is therefore a valid factor;
physical numeric type alone does not force a continuous role.

The factory revalidates both fields before creating an item. UI checks provide
feedback, but persisted analysis state cannot depend on UI-only validation.
Missing source tables or columns encountered while reopening a project produce
the existing unavailable-document state rather than a malformed graph request.

## Workspace Integration

`Workspace` owns the modal open state and active Fit Y by X document ID, as it
currently does for graph and tabulate documents. Creation clears the active
table, graph, and tabulate selections before selecting the new analysis.
Selecting another document clears the active Fit Y by X selection.

The project tree adds a Fit Y by X document family with the same rename,
delete, drag-to-folder, context-menu, and active-row behavior as existing
documents. The right pane dispatches to `FitYByXView` before falling back to the
active table. Menu and document labels are added to both supported locales.

The first implementation should extract shared workspace helpers only where
needed to prevent another copy of document selection or folder movement logic.
It does not introduce a general document registry in this issue.

## Persistence

Fit Y by X documents are stored inline in `manifest.json`, following tabulates.
The project save request, open result, Rust manifest, and archive load/save path
gain:

```text
fitYByX: unknown[]
fitYByXFolders: Record<string, string>
```

Rust treats the analysis payload as opaque JSON. Frontend types and store
normalization own its schema. Serde defaults both fields so projects written by
older releases open with empty Fit Y by X collections. Saving a current project
always emits both fields.

No separate analysis archive member is introduced. This keeps the framework
consistent with the existing lightweight tabulate documents while leaving
large result artifacts out of the manifest.

## Error Handling

- The menu action is unavailable when no source table is active.
- Column-loading errors remain inside the dialog and allow retry or cancellation.
- Invalid role assignments never create a document.
- A missing source dataset or column renders a recoverable unavailable state.
- Graph-data failures use the shared runtime error overlay and preserve the
  analysis definition.
- Request cancellation and generation fencing prevent stale graph results from
  replacing the selected analysis.
- Read-only projects permit viewing but reject rename, delete, movement, and
  creation through the existing mutability guard.

## Testing

Development follows red-green-refactor. Each production boundary starts with a
focused failing test.

### Role And Configuration Tests

- continuous numeric Y plus nominal or ordinal X is accepted;
- columns outside the first-release continuous-Y/categorical-X scope,
  duplicate roles, and missing roles are rejected;
- a numeric column modeled as nominal is accepted as X;
- the Fit Y by X factory emits X=factor, Y=response, Points, Box Plot, full
  sampling, empty filters, and valid inactive mode defaults;
- materializing the embedded item is pure and produces a current-format
  `GraphBuilderItem` accepted idempotently by the normalizer.

### Store And Project Tests

- create, rename, delete, reset, and source-table cascade deletion work;
- read-only mutations are rejected;
- save and reopen preserve role identity, graph config, folder placement, and
  the default-name counter;
- older manifests without the new fields load empty collections;
- current saves emit the new fields without changing existing graph or tabulate
  payloads.

### Runtime And Workspace Tests

- the shared runtime derives the same request for an interactive item and the
  equivalent embedded item;
- the embedded runtime does not write to `useGraphBuilderStore`;
- stale requests cannot replace the current document;
- menu creation, active-document switching, source deletion, and unavailable
  documents follow existing workspace behavior;
- existing 2D, 3D, Multivariate, graph pipeline, and project lifecycle tests
  remain green.

## Validation

The change is complete when:

1. Focused role, factory, store, embedded-runtime, and project lifecycle tests
   pass.
2. Existing Graph Builder mode, graph-data pipeline, and save lifecycle tests
   pass.
3. The complete frontend test set used by the repository passes.
4. `npx vite build` succeeds.
5. `cargo test` and `cargo clippy -- -D warnings` succeed in `src-tauri`.
6. A Tauri development run verifies dialog validation, document creation,
   navigation, graph rendering, rename, folders, deletion, and save/reopen.

## Non-Goals

- Continuous X regression, categorical Y analyses, or automatic personality
  selection.
- ANOVA tables, means comparisons, confidence intervals, effect sizes, or other
  inferential statistics.
- Editing graph roles or layers inside the analysis view.
- A generic registry for every workspace document family.
- New Graph Core transforms, Rust aggregate packets, or data-service commands.
- Persisting computed chart data or statistical results.
# Issue 235 Graph Builder-new Overlay and Legend Design

**Date:** 2026-09-19

**Status:** Proposed for written review

**Issue:** https://github.com/ashton2914/StatsPlayground/issues/235

## Goal

Add a functional Overlay channel and interactive Legend to Graph Builder-new
without introducing the deferred native style system. One categorical field
groups points, Raw Line, and Mean; every group receives a stable color; Legend
items can hide and show groups without another DuckDB projection or rebuilding
the source cache; and the complete configuration persists in `.spprj`.

The required performance acceptance population is 2,000,000 rows. A
10,000,000-row run is a measured stretch target. A stretch miss does not block
delivery when the required population is usable and the limitation, raw
measurements, and next bottleneck are recorded.

## Scope

### Included

- One optional Overlay field selected from the active dataset.
- Typed, deterministic group identities, including an explicit missing-value
  group.
- Exact global group counts from the same full-source projection used to build
  the graph.
- Stable backend-owned group colors returned to the frontend for the Legend.
- Point, Raw Line, and Mean rendering grouped by Overlay.
- Legend hide/show state that preserves the camera and reuses the same
  `GraphKey`, LOD pyramid, CPU cache, and persistent cache.
- Group-aware representative admission so a small group is not automatically
  erased by a dominant group in the same spatial region.
- Versioned tile/cache changes and backward-compatible Graph Builder-new
  document migration.
- Focused correctness, persistence, interaction, resource, and performance
  evidence at 2M rows, plus a bounded 10M stretch run.

### Deferred

- User-editable palettes, colors, alpha, line width, point shape, ordering, or
  any general native style editor.
- Multiple Overlay fields, nested legends, facets, Group X/Y, Wrap, Color,
  Size, labels, or continuous color scales.
- Search, paging, or virtualization for a high-cardinality Legend.
- Per-group axis domains, camera auto-fit to visible groups, and separate
  scales.
- Exact Raw Line or Mean above the existing complete-source retention ceiling.
- Any change to the legacy ECharts Graph Builder.

## Product Decisions

### Cardinality

Overlay accepts any scalar dataset column whose values can be represented by
the existing metadata-validated DuckDB projection. The build admits at most
**64 distinct groups including the missing-value group**. The 65th distinct
identity aborts the cold build with the stable reason
`graph_new_overlay_too_many_groups`; it does not silently merge values into
Other, truncate the Legend, or reinterpret the field.

The 64-group limit is a deliberate functional-MVP boundary. It keeps the
Legend usable, allows at least one representative per present group inside a
4,096-mark tile, and bounds dictionary, palette, line, and Mean bookkeeping.
The cold scan discovers cardinality in the same streamed projection; no
cardinality-only DuckDB query is added.

### Missing Values

When Overlay is active, SQL `NULL` becomes one synthetic group:

- label: `(Missing)` in the backend contract; the frontend localizes the
  display text without changing identity;
- identity: a dedicated missing tag, never the literal string `(Missing)`;
- color: a fixed neutral gray;
- count: rows with finite X/Y and a missing Overlay value.

Missing X or Y remains excluded by the existing finite-pair policy. Missing
Overlay does not exclude an otherwise valid point.

### Stable Identity, Ordering, and Color

The backend canonicalizes each group as a type-tagged value within the selected
Overlay column. It returns:

```text
GraphNewOverlayGroup {
    id: "sha256:<64 lowercase hex>",
    code: u16,
    label: String,
    color: [u8; 4],
    totalRows: u64,
    missing: bool
}
```

`id` is the persisted and request-facing identity. `code` is compact
build-local storage used by points and tiles; it is never persisted in the
Graph Builder-new document. Labels are capped at 512 UTF-8 bytes. A build
rejects malformed or over-limit labels explicitly.

Legend order is missing last, then label by Unicode code-point order, then
group ID as a deterministic tie-breaker. Color is derived from the full group
ID using one fixed light-theme color function; the missing group uses its
fixed gray. Rust returns the resolved RGBA value, so the renderer and React
Legend do not maintain duplicate palette algorithms. Adding, removing, or
reordering other groups cannot recolor an existing identity.

### Visibility and Camera

Hidden groups are presentation state:

- `hiddenOverlayGroupIds` is not part of `GraphKey`;
- a Legend toggle does not scan DuckDB, rebuild LOD, write a new cache file, or
  reset the camera;
- the renderer filters cached selected points, Raw Line segments, and Mean
  series by group ID/code before GPU submission;
- automatic and reset-view domains continue to use all finite groups.

Keeping the all-group domain avoids camera jumps and prevents visibility from
fragmenting the persistent cache. Reset View therefore restores the full
all-group domain, not the enabled-group domain.

## Contracts

### Persisted TypeScript Document

`GraphBuilderNewDocument` advances to version 2:

```ts
interface GraphBuilderNewDocumentV2 {
  version: 2;
  id: string;
  name: string;
  datasetId: string;
  xColumnId: string | null;
  yColumnId: string | null;
  overlayColumnId: string | null;
  hiddenOverlayGroupIds: string[];
  showMean: boolean;
  xMode: GraphNewXMode;
  rawMode: GraphNewRawMode;
  camera: GraphBuilderNewCamera | null;
}
```

Archive validation accepts the exact legacy version-1 shape and the exact
version-2 shape. Loading version 1 normalizes it in memory to version 2 with
`overlayColumnId: null` and an empty hidden list. This migration does not mark
the project dirty and works in read-only mode. The next authorized save writes
version 2. Unknown fields, duplicate hidden IDs, malformed IDs, more than 64
hidden IDs, and hidden IDs without an Overlay field are rejected.

Selecting a different Overlay field clears hidden group IDs but preserves the
camera. Removing X, Y, or changing X interpretation keeps the existing camera
reset behavior. A missing persisted Overlay field produces the same localized,
non-destructive unavailable-field state as missing X/Y and leaves the document
unchanged.

### Render Request

TypeScript and Rust add:

```text
overlayColumnId: Option<String>
hiddenOverlayGroupIds: Vec<String>
```

Validation requires:

- Overlay ID is either absent or a trimmed, non-empty stable column ID no
  longer than 256 bytes;
- hidden IDs are unique full `sha256:` identities, at most 64 entries;
- hidden IDs are empty when no Overlay field is selected.

`GraphNewBuildRequest` receives only `overlayColumnId`. Visibility does not
enter the build request.

### Render Completion

Completion adds:

```text
overlayGroups: Vec<GraphNewOverlayGroup>
overlayActive: bool
hiddenOverlayGroups: usize
```

Group counts cover every finite X/Y source row before visibility filtering.
`selectedMarks` and `visibleRows` describe enabled groups after filtering.
`exactVisible` is true only when the enabled visible population is completely
retained and filtered exactly. The camera domain and `finiteRows` continue to
describe all groups. The frontend validates group ID uniqueness, code
uniqueness, RGBA shape, label limits, exact count sum, hidden count, and request
consistency before presenting the frame or Legend.

## GraphKey and Cache Versioning

`GraphKeyParts` and diagnostics add `overlay_column_id: Option<String>`.
Overlay field identity changes the canonical key because it changes tile
payload and group summaries. Hidden group identities do not.

The implementation advances these incompatible derived-data contracts:

- renderer contract version: 1 -> 2;
- tile format version: 1 -> 2;
- bounded pyramid magic: `GNPC0003` -> `GNPC0004`;
- bounded canonical key label:
  `graph-new-v6-compact-exact-2100000` ->
  `graph-new-v7-overlay-compact-exact-2100000`.

Old cache artifacts are ordinary misses and remain eligible for owned-cache
eviction. They are never migrated in place. The lossless research cache is not
extended for Overlay in this issue.

## Rust Data Path

### Projection and Dictionary

The cold build resolves X, Y, and optional Overlay by stable column ID before
forming SQL. Dynamic identifiers continue through the existing validated
identifier-quoting boundary. The main streamed projection returns:

```text
_row_id, encoded_x, numeric_y, x_kind, x_label/time metadata,
overlay_is_null, overlay_label
```

Overlay label conversion occurs inside DuckDB using the resolved column type
and a deterministic textual representation. Values are never interpolated
into SQL. Rust maintains a bounded dictionary from the type-tagged value to a
`u16` code, full identity, display label, color, and exact finite-row count.
The dictionary and point group code are produced while processing the same
bounded batches as X/Y. Projection query telemetry remains one for this scan.

No-Overlay builds use one internal all-rows code but return
`overlayActive: false` and no Legend groups, preserving current UI behavior.

### Source and Tile Shapes

`SourcePoint` adds `group_code: u16`. `GraphNewTile` adds a parallel
`group_codes: Vec<u16>` array with the same length as row IDs, X, Y, and
counts. Tile encode/decode, checksums, payload-length math, resident-byte
accounting, spool estimates, persistent-cache validation, and corruption tests
all include the new column.

The pyramid stores the bounded group dictionary and per-group exact source
counts in its versioned metadata. Decode rejects a point code not present in
that dictionary.

### Group-Aware LOD Admission

Existing spatial addresses and camera selection remain unchanged. Within each
output tile, representative admission becomes stratified:

1. candidates are partitioned by group code inside the existing spatial
   bucket;
2. each group present in the tile receives one deterministic admission before
   any group receives an additional admission;
3. remaining capacity is assigned proportionally by group population using a
   largest-remainder rule with group code as the tie-breaker;
4. each group's existing deterministic representative order fills its assigned
   capacity;
5. total retained marks never exceeds `max_tile_points`.

This guarantees minority-group presence at tile level when Overlay cardinality
is within the 64-group limit and tile capacity is at least 64. It does not
claim exact density or anomaly preservation in approximate LOD. All-source
tile counts and exact global group counts remain exact.

### Raw Line

Raw Line construction never connects different group codes. It applies the
existing X/row ordering and missing-gap rules independently inside each group.
The result carries group code per segment so the renderer can color and hide
segments without rebuilding line topology. With no Overlay, output remains
byte-for-byte equivalent in ordering and segment count to the current path.

### Mean

Mean changes from grouping by X to grouping by `(group_code, X)`. Each group
produces a separately breakable Mean series ordered by X. Mean metadata reports
the total number of `(group, X)` aggregates; visibility only controls which
already-computed group series are submitted. Existing complete-source
availability rules remain in force: if Mean is unavailable for the retained
population, Overlay does not make it appear available.

## Native Renderer

The scene owns:

- point group codes and the resolved group-color table;
- grouped Raw Line segments;
- grouped Mean vertices with explicit series boundaries;
- a compact enabled-group mask derived from hidden group IDs.

Point `Mark.color` is filled from the backend-resolved group color instead of
the current constant blue. Raw and Mean pipelines receive per-vertex color and
must not draw a segment across a group boundary. Hidden groups are removed
before buffer upload. GPU cache identity includes geometry source plus the
enabled-group mask; changing visibility may upload filtered presentation
buffers but must reuse the CPU/persistent pyramid and must report zero source
projection queries.

No Overlay retains current blue points and current Raw/Mean colors so existing
screenshots and behavior do not change.

## Frontend

### Field Surface

`GraphBuilderNewView` adds an Overlay select below Y. It lists all resolved
dataset columns because backend cardinality validation is authoritative.
Unavailable persisted Overlay fields remain visible as disabled retained
options. Read-only mode disables the select and Legend toggles.

### Legend

`GraphNewCanvas` renders an HTML Legend from validated completion metadata.
Each item contains a backend color swatch, localized label, exact formatted
row count, and checkbox/button semantics with an accessible name. Toggling an
item updates `hiddenOverlayGroupIds`, marks a mutable project dirty, preserves
the camera, and schedules a latest-wins native render against the existing
cache.

The existing Raw/Mean layer indicators remain separate from the Overlay
Legend. The MVP does not imitate the complete legacy style panel.

The Legend uses a bounded scroll region because group count is capped at 64.
It supports keyboard toggle and focus-visible styling. It does not add search,
reordering, or color editing.

## Error and Recovery Behavior

New stable frontend-safe reasons are:

- `graph_new_overlay_too_many_groups`;
- `graph_new_overlay_value_too_large`;
- `graph_new_overlay_group_missing`;
- `graph_new_overlay_cache_incompatible`.

Invalid request and corrupt-cache paths continue to use the existing safe error
mapping. A corrupt or incompatible derived cache is evicted and rebuilt on a
full-domain request. A camera-only request cannot rebuild and returns
`graph_new_missing_cache`, preserving the current reset-view recovery.

Cancellation, dataset generation, renderer generation, and runtime epoch
checks cover dictionary construction, tile admission, grouped Mean/Raw
construction, visibility filtering, rendering, and frame publication.
Failures preserve the last coherent frame and never mutate source data or
expose SQL, absolute paths, or raw backend errors.

## Performance and Resource Policy

Existing defaults remain:

- construction memory: 512 MiB request default, 1 GiB maximum;
- process CPU graph cache: 768 MiB;
- GPU graph cache: 256 MiB;
- persistent graph cache: 1 GiB;
- scene submission ceiling: 2,100,000 marks.

All new arrays, dictionary storage, grouped line/Mean buffers, decoded tiles,
GPU buffers, and temporary visibility-filter buffers participate in existing
admission and telemetry. Capacity accounting uses allocated capacity, not only
logical length.

### Required 2M Gate

Use a deterministic dataset with at least 2,000,000 finite X/Y rows, at least
eight groups, one minority group below 0.1%, and a missing Overlay group.
Acceptance requires:

- cold build completes without resource refusal;
- exact retained geometry remains available where the current 2.1M compact
  exact path supports it;
- every expected Legend group and exact count is correct;
- minority and missing groups appear;
- group colors remain identical across cold, warm, reopen, and camera renders;
- Raw Line contains no cross-group segment;
- Mean equals independently calculated `(group, X)` expectations;
- warm camera and Legend toggles report
  `sourceProjectionQueryCount == 0`;
- Legend toggle does not change `GraphKey`, persistent bytes, or camera;
- cancellation and stale-frame fences remain effective.

### 10M Stretch Gate

Run one bounded release matrix covering cold overview, warm reopen, camera,
hide, and show at 10,000,000 rows. Record backend build/render/readback,
submitted marks, cache bytes, process RSS, query counts, and failure reason.
WebView presentation is measured separately when a live acceptance run is
available. A single sample is reported as a single sample, never P95.

Failure to meet a non-critical stretch threshold does not trigger an unbounded
optimization loop. Preserve the report, identify the first limiting layer,
document whether the 2M gate remains satisfied, and open follow-up work if the
bottleneck is outside the functional vertical slice.

## Test Strategy

### Rust

- Request and build validation for optional Overlay and hidden identities.
- GraphKey changes for Overlay field and stability across hidden sets.
- Dictionary identity, NULL distinction, label limits, 64/65 cardinality.
- Tile v2 round trip, code validation, checksum, length, and old-version
  rejection.
- Group-aware admission with dominant, minority, missing, and full-capacity
  fixtures.
- Persistent pyramid round trip and memory/capacity accounting.
- Raw Line same-group boundaries and legacy no-Overlay parity.
- `(group, X)` Mean values, ordering, boundaries, cancellation, and cache reuse.
- Renderer point/Raw/Mean colors, visibility mask, GPU reuse, and no-Overlay
  screenshot parity.
- Service cold/warm/camera/toggle query counts and stale/cancellation fences.
- 2M required harness and bounded 10M stretch report.

### TypeScript and Component Tests

- Strict request/completion validation for group metadata and hidden IDs.
- Version-1 document normalization and version-2 round trip without dirty
  feedback.
- Overlay field selection, missing field, read-only behavior, and project dirty
  semantics.
- Legend ordering, labels, counts, swatches, keyboard behavior, and bounded
  scrolling.
- Hide/show request shape, zero-query completion, stable camera, and persisted
  visibility.
- Raw/Mean layer controls remain independent from group Legend controls.
- Existing no-Overlay Graph Builder-new acceptance remains unchanged.

### Final Gates

Use the accelerated verification policy: each slice runs the cheapest focused
RED/GREEN test and its directly affected suite. After all slices, run the full
Graph Builder-new TypeScript/component suites, frontend build, serial
Graph-new Rust tests, Cargo build/test/clippy required by the repository,
independent review, and manual native acceptance once.

## Delivery Slices

Only one slice is active at a time.

1. **Document and IPC contract:** version-2 persistence, migration, Overlay
   selection, strict request/completion types, and archive validation.
2. **Grouped source and cache format:** dictionary, `SourcePoint`, tile v2,
   pyramid metadata, GraphKey, cache invalidation, and accounting.
3. **Minority-safe grouped LOD:** stratified admission and exact group
   telemetry.
4. **Native grouped rendering:** point colors, group-safe Raw Line and Mean,
   and no-Overlay parity.
5. **Legend visibility loop:** validated Legend UI, hidden state persistence,
   enabled mask, zero-query camera/toggle reuse, accessibility, and read-only
   behavior.
6. **Performance and hardening:** 2M required qualification, bounded 10M
   stretch evidence, affected/full gates, independent review, and native
   acceptance.

Each slice starts with a failing behavioral test, ends with focused and
affected green evidence, and receives an independent commit before the next
slice begins.

## Acceptance Summary

Issue 235 is functionally complete when:

- Graph Builder-new accepts one Overlay field and renders every finite X/Y row
  under exactly one group, including missing Overlay values;
- Legend labels, exact counts, stable colors, and hide/show behavior are
  correct and accessible;
- points, Raw Line, and Mean never connect or aggregate across groups;
- a hidden-group change preserves camera and `GraphKey`, launches zero DuckDB
  projections, and reuses the completed source cache;
- old version-1 native graph documents load without dirty feedback and new
  version-2 documents round trip through `.spprj`;
- incompatible derived caches miss or recover safely;
- required 2M functional/resource acceptance passes;
- the 10M stretch matrix is run once and reported honestly, with any
  non-blocking limitation preserved rather than optimized indefinitely;
- existing no-Overlay Graph Builder-new and legacy Graph Builder behavior stay
  unchanged;
- final repository verification, review, and native acceptance complete
  without an unresolved blocking defect.

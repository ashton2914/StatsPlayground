# Issue 57: Unified 2D Graph Rendering Design

## Goal

Restore Graph Builder behavior lost during the unified data-pipeline migration:

- standalone 2D points render through ECharts and obey STYLE settings;
- standalone box plots render without requiring a histogram layer;
- fit lines render from frame-backed data;
- composed layers continue to work, including points over histograms;
- backend projection, aggregation, typed-buffer transport, and sampling
  optimizations remain intact.

Consistency has priority over a separate frontend point renderer. The same 2D
mark must have the same style and interaction behavior regardless of row count.

## Chosen Approach

Use the typed `GraphDataFrame` as the only production data source while making
ECharts the only 2D renderer. Existing frame-to-series helpers will decode
typed chunks directly into ECharts series data. The implementation must not
reconstruct full legacy `unknown[][]` rows.

The alternatives were rejected for these reasons:

- Reconstructing legacy rows would duplicate large datasets in JavaScript and
  undo the memory and transport improvements of the new pipeline.
- Keeping a Canvas fallback above a row threshold would preserve two visual and
  interaction systems, so STYLE behavior would still change with dataset size.

## Architecture

The retained data path is:

```text
GraphDataRequest
  -> Rust graph data service and DuckDB
  -> typed raw chunks plus aggregate packets
  -> GraphDataFrame
  -> graphCore typed-frame adapters
  -> ECharts option and series
  -> Graph.tsx ECharts instances
```

The Rust service, Tauri stream transport, coherent frame commit, and scatter
render budget remain unchanged unless a failing contract test proves a packet
is not emitted. Frontend changes stay within the graph builder pipeline and
`graphCore` rendering boundary.

### Point Budget Behavior

The confirmed blank-chart path is a Full request containing raw points whose
valid row count exceeds `rawPointBudget`: the backend deliberately clears all
buffered raw chunks and emits only aggregate packets. Histogram layers survive,
while points and any raw-derived overlay lose their input.

Full mode will continue to compute aggregates over the complete filtered data,
but raw-derived ECharts layers will request a deterministic sample capped at
`SCATTER_RENDER_BUDGET`. Explicit user Sample settings still win. The committed
frame reports the effective sample so the status UI does not claim that every
raw point was drawn. A point-producing request must not complete with an
`omitted` disposition merely because the valid row count exceeded the budget.

## Rendering Behavior

### Points

`buildFrameBackedScatterSeries` becomes the sole production renderer for raw
2D points. It must preserve:

- categorical, continuous, and datetime coordinates;
- grouping, hidden groups, facets, wrap, and multi-response source identity;
- jitter offsets;
- marker shape, color, size, and opacity from resolved group STYLE settings;
- row and column pick metadata on ECharts data items;
- the existing frontend render budget supplied to the backend request.

`Graph.tsx` will no longer mount `RawPointsLayer` for 2D panels. Canvas-specific
z-index, hit-testing, and brush routing will be removed from the active path.
ECharts click and brush handling will use the existing `__pick` metadata.

Points, raw lines, smoothers, and fit lines are raw-derived layers for sampling
purposes. Summary points/lines and packet-owned histogram, heatmap, and boxplot
layers remain exact aggregate consumers and do not force raw sampling.

### Box Plots

Frame-backed box plots are owned by `BoxPlotPacket`. Standalone rendering must
derive categories and series data from that packet and the bound field metadata,
without requiring histogram bins or reading legacy rows. Empty category/group
slots continue to use ECharts' supported missing-value representation.

### Fit Lines And Smoothers

Fit lines and smoothers will consume finite typed-frame X/Y points through a
shared frame decoder. They must not depend on legacy rows or on the presence of
a points or histogram element. Group and facet filtering must be applied before
fitting so each emitted line represents the same panel/group population as the
visible marks.

### Layer Composition

Histogram and box-plot aggregate packet paths remain ECharts series. Points,
fit lines, smoothers, and other raw-derived 2D layers share the same coordinate
system and series stack. Existing z-order intent is retained: aggregate fills
below points and outlines, with labels and interaction carriers above them.

## Error And Empty States

Missing or malformed typed slices must not trigger a legacy row fallback. The
affected layer should emit no series while the graph pipeline reports transport
or decoding errors through its existing error state. A valid zero-row frame
produces axes with no marks and remains a successful completed request.

If an expected aggregate packet is absent, the corresponding aggregate layer
stays empty; it must not borrow histogram data or scan placeholder rows.

## Testing

Add regression coverage using production-shaped `GraphDataFrame` fixtures:

- standalone points emit a non-empty ECharts scatter series;
- point STYLE controls marker, color, size, and opacity;
- standalone boxplot packets emit boxplot series and categories;
- standalone fitline and smoother elements emit non-empty line data;
- points remain visible when composed with histogram and boxplot layers;
- Full requests with more than `SCATTER_RENDER_BUDGET` source rows still emit a
  bounded, deterministic raw sample while aggregate packets remain full-data;
- grouped, hidden-group, faceted, datetime, and jitter behavior remains intact;
- Graph Builder and `Graph.tsx` no longer rely on `RawPointsLayer` for 2D output;
- frame-backed paths never read legacy rows.

Verification consists of focused Node regression tests, the full frontend test
set relevant to graph rendering and data transport, `npx vite build`, and manual
Tauri verification of the three issue reproductions plus a STYLE edit.

## Out Of Scope

- Replacing ECharts GL for 3D charts.
- Changing backend aggregation algorithms or sampling policy.
- Raising the existing scatter render budget.
- Redesigning Graph Builder controls or STYLE panel layout.
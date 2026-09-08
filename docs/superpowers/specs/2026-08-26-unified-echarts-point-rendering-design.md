# Unified ECharts Point Rendering Design

## Problem

The projection-first graph pipeline currently renders raw 2D points on a
panel-local Canvas while ECharts renders axes, legends, aggregate elements,
labels, and every other 2D series. This split reduced per-point object cost for
large frames, but it also created two independent implementations of graph
semantics.

The divergence is now user-visible. Grouped jitter does not follow the same
legend and series behavior as other elements, random jitter can resemble a
translation, and point interaction and layer ordering require separate hit-test
and z-index glue. Continuing to patch the Canvas implementation would preserve
the architectural cause of these inconsistencies.

Architecture consistency is therefore a primary requirement of this change,
not a secondary cleanup goal.

## Goals

- Use standard ECharts scatter series as the only production renderer for raw
  2D points at every supported point count.
- Keep the projection-first typed IPC pipeline, graph-frame cache, cancellation,
  and exact backend aggregate packets.
- Give points the same legend, style, tooltip, selection, brush, zoom, pan,
  facet, and layer semantics as other ECharts elements.
- Preserve the existing `stacked`, `uniform`, and `normal` jitter options and
  make their behavior deterministic across redraws.
- Protect the WebView main thread with an explicit measured point budget rather
  than switching to a behaviorally different renderer.
- Preserve exact full-data aggregate results when raw points exceed the
  interactive rendering budget.

## Non-Goals

- Rendering 300,000 ordinary ECharts scatter items regardless of main-thread
  cost.
- Enabling ECharts `large` mode, `scatterGL`, or another renderer above a size
  threshold.
- Automatically sampling while the graph is labeled Full Data.
- Restoring full-table JSON transfer or rebuilding the legacy
  `GraphData.rows` data path.
- Changing the 3D scatter or surface renderer.

## Architectural Invariants

1. `GraphDataFrame` is the sole production data source for frame-backed graphs.
2. `transform.ts` is the sole owner of 2D graph semantics.
3. ECharts is the sole production 2D renderer and interaction system.
4. Dataset size may change whether raw observations are admitted, but it must
   never select a different renderer or interaction model.
5. Full Data never silently drops or samples raw observations.
6. Aggregate packets remain exact over the filtered source rows, independent of
   raw-point sampling or omission.

## Chosen Approach

Use one ordinary ECharts scatter path for all admitted raw observations. A
typed-frame adapter inside graphCore converts only the projected fields required
by the active specification into standard ECharts scatter data. Large frames
must use the existing explicit Sample mode when their raw point count exceeds a
measured interactive budget.

This approach is preferred over the alternatives:

- Forcing ordinary scatter to render every Full Data row preserves semantics but
  can reintroduce long main-thread stalls and unbounded JavaScript object cost.
- Switching to ECharts `large` mode or `scatterGL` above a threshold still
  creates two behavior sets because those modes restrict per-item style,
  tooltip, and selection semantics.
- Retaining Canvas and sharing only selected helpers leaves two renderers, two
  hit-test systems, and two layer models in production.

## Data Flow

```text
GraphSpec
  -> GraphDataRequest(rawPointBudget)
  -> DuckDB filtering, projection, sampling, and exact aggregation
  -> ordered typed chunks and aggregate packets
  -> GraphDataFrame
  -> buildFrameScatterSeries
  -> standard ECharts scatter series
  -> one ECharts renderer and interaction system
```

The typed adapter must not materialize a complete table. It reads X, Y, group,
size, source, facet, validity, and row-ID vectors directly from the committed
frame. It creates only the ECharts point items required by the active panel and
active point element.

Each legend group becomes a normal ECharts scatter series in dictionary order.
Series-level style comes from the existing `resolveGroupStyle` path. Each point
item contains its ECharts value, deterministic symbol offset when jitter is
enabled, and the existing pick metadata needed to select the source table cell.

The adapter is a named graphCore boundary rather than a generic reconstruction
of `GraphData.rows`. Other element builders continue to consume exact aggregate
packets or their own typed-frame projections.

The adapter is mechanical: it receives explicit resolved group order, styles,
jitter policy, facet selection, and pick-field definitions from `transform.ts`.
It must not parse `GraphSpec`, choose defaults, or independently interpret
legend state. This keeps one semantic owner even though buffer decoding lives in
a smaller module.

## Jitter Semantics

One pure jitter module supplies offsets to the ECharts scatter builder.

- `stacked` groups by X and bins by projected Y proximity, then spreads points
  symmetrically within the X band.
- `uniform` generates bounded horizontal offsets from a stable hash of request
  seed and row ID.
- `normal` uses the same stable inputs with a clamped normal distribution.
- `jitterLimit` scales the usable fraction of the category band or equivalent
  local X spacing.
- Legacy `auto` is normalized to `stacked`.

All legend groups use the same algorithm. Group identity may affect series
style, but it must not disable or translate the jitter distribution. Rebuilding,
resizing, zooming, or toggling another legend group must not randomly move an
unchanged point.

## Point Budget And Sampling

The point budget is a performance policy, not a renderer switch. It is measured
on the target Windows WebView before a default is fixed.

The benchmark covers representative continuous, categorical, grouped, faceted,
and overlaid plots. The selected budget must retain a conservative margin while
meeting both requirements:

- cold activation to one coherent frame is at most 2 seconds;
- no avoidable WebView main-thread task exceeds 200 milliseconds.

The budget counts valid raw observations across the complete frame before panel
layout. Faceting does not grant a separate budget to each panel.

When Sample mode is active, DuckDB continues to perform deterministic stratified
sampling. The sample size input is capped at the measured point budget. Sampled
points use the same adapter and ordinary ECharts scatter series as Full Data
points.

## Full Data Over Budget

When Full Data exceeds the raw-point budget:

1. The backend computes exact requested aggregate packets over all filtered
   rows.
2. It does not stream a raw-point payload that the frontend will refuse to
   render.
3. Completion metadata explicitly reports that raw observations were omitted
   because the point budget was exceeded, including the valid observation count
   and budget.
4. Aggregate and synthetic ECharts layers remain visible.
5. Graph Builder displays a clear omission state with a command that switches
   the item to Sample mode.

An omitted raw layer is distinct from an empty dataset, a cancelled request, and
a transport error. The frontend must never infer omission from an empty chunk
array.

Full Data remains truthful: it either renders all admitted raw observations or
states that the raw layer was omitted. It never silently samples.

## Component Changes

### graphCore

- Add a focused typed-frame scatter adapter, preferably outside the already
  large `transform.ts`, while keeping `transform.ts` as its semantic owner and
  caller. The adapter accepts resolved inputs and does not interpret
  `GraphSpec`.
- Extract the existing ECharts jitter calculation into a pure tested module and
  make random modes deterministic.
- Stop emitting `RawPointPanelDescriptor` from built panels.
- Delete `RawPointsLayer.tsx` and the Canvas raw-point projection, rasterization,
  pixel-index, and hit-test implementation.
- Remove Canvas z-index insertion while retaining ECharts base and overlay
  `zlevel` policy.

### Graph Host

- `Graph.tsx` hosts one ECharts instance per panel and no point Canvas.
- Point click and brush selection use standard ECharts event/data metadata.
- Tooltip, legend filtering, resize, zoom, and pan no longer synchronize with a
  second renderer.

### Typed Contract And Backend

- Extend the request with a validated raw-point budget supplied by application
  policy, not arbitrary user input.
- Extend frame/completion metadata with a structured raw-point disposition:
  included, empty, or omitted because the budget was exceeded.
- Avoid emitting raw chunks when Full Data is known to exceed the budget while
  still producing requested exact aggregate packets.
- Preserve cancellation, generation checks, ordered chunks, and sampling
  metadata.

### Graph Builder UI

- Keep the existing explicit Full and Sample controls.
- Show the measured budget in the Sample size constraint and status text.
- On point-budget omission, show the valid observation count and a direct
  Switch to Sample command.
- Do not label an omitted or sampled point layer as fully rendered Full Data.

## Error And State Handling

- No valid points: commit a normal empty frame without a sampling prompt.
- Point budget exceeded: commit exact aggregates plus structured point-omission
  metadata.
- Cancelled or stale request: do not commit a partial replacement frame.
- Transport or aggregate failure: retain the previous coherent graph and show
  the existing pipeline error state.
- Invalid budget metadata: reject it at the typed boundary rather than treating
  it as an empty result.

## Compatibility

- Existing project files keep `jitter`, `jitterLimit`, and `auto` compatibility.
- Unused experimental `rawPointJitter*` options are removed rather than mapped
  into a second option family.
- Project format does not need a migration for the renderer change.
- Existing explicit sampling settings and seeds remain valid, subject to the
  measured maximum sample size.

## Verification

### Behavior Matrix

- Points alone for continuous, categorical, date, grouped, melted, and faceted
  data.
- Points overlaid with line, box plot, histogram, heatmap, fit line, and
  smoother elements.
- `stacked`, `uniform`, and `normal` jitter across every visible legend group.
- Legend hide/show, group color, marker size, opacity, tooltip, click, overlap,
  brush, zoom, pan, axis reversal, and transpose.
- Empty, sampled, full-under-budget, and full-over-budget states.

### Architecture Guards

- Production graph code does not import or mount a raw-point Canvas renderer.
- Frame-backed points produce standard ECharts scatter series with pick
  metadata.
- No raw-point series enables ECharts `large` mode or `scatterGL`.
- Frame-backed graph construction does not read `GraphData.rows`.
- Full-over-budget frames carry explicit omission metadata and no raw payload.

### Performance

- Benchmark candidate budgets on the target Tauri WebView.
- Record typed decode, adapter construction, ECharts `setOption`, coherent-frame
  time, longest main-thread task, zoom, brush, and cache re-entry.
- Fix the default budget only after the acceptance gates pass with a
  conservative margin.

## Removal Criteria

The Canvas path is removed in the same migration that makes frame-backed
ECharts scatter production-ready. It is not retained behind a dataset-size
condition, fallback flag, or dormant production branch. Historical benchmark
documentation may remain, but production tests must enforce the single-renderer
invariant.
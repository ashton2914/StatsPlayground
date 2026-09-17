# Issue 221 Graph Builder-new wgpu Point Plot Design

**Date:** 2026-09-17

**Status:** Approved for implementation planning

**Issue:** https://github.com/ashton2914/StatsPlayground/issues/221

## Goal

Add a separate, session-only `Graph Builder-new` entry that can build and
interact with a light-theme two-dimensional point plot from at least 10,000,000
source rows without an obvious performance bottleneck. Rust owns full-source
scanning, multi-resolution level-of-detail data, hit-test identity, and
`wgpu` offscreen rendering. The existing Graph Builder and ECharts renderer
remain unchanged and available throughout this work.

This first vertical slice proves the architecture. It does not replace the
current Graph Builder and does not attempt feature parity beyond the explicitly
listed point-plot behavior.

## Product Scope

### Included

- A new `Graph Builder-new` command in the application menu.
- A temporary workspace view bound to the current dataset.
- Session-only X and Y field selection for continuous columns.
- One light-theme 2D point layer.
- Axes, major grid lines, point marks, and a minimal loading/error state.
- Pan and zoom without interaction-triggered DuckDB queries.
- Basic point tooltip and stable source-row selection.
- A Rust `wgpu` offscreen renderer with a WebView-compatible frame transport.
- A 4K transport feasibility gate completed before the production LOD and
  interaction stack is built.
- On-demand, `GraphKey`-scoped multi-resolution LOD construction.
- Bounded persistent, CPU, and GPU caches with deterministic invalidation.
- Instrumentation and automated tests for correctness, performance, fallback,
  cancellation, and memory budgets.

### Deferred

- Dark theme.
- `.spprj` persistence and project archive migration.
- Directory-tree documents, rename, delete, copy, report embed, and workflow
  integration.
- Categorical axes, datetime axes, color grouping, facets, labels, legends,
  brush selection, reference lines, axis dialogs, export, and custom styling.
- Line, bar, histogram, normal curve, boxplot, heatmap, correlation matrix,
  smoother, fit line, confidence band, and other 2D layers.
- Distribution, Fit Y by X, Fit Model, Hypothesis Test, and other Analysis
  integration.
- 3D rendering.
- Removal or modification of the existing Graph Builder production path.
- Native child/sibling GPU surfaces. Plan C requires a separate measured spike
  after Plan B proves value.
- Continuous delivery of a newly read-back 4K bitmap at display refresh rate.
  The MVP reprojects the last coherent frame locally during interaction and
  publishes a fresh Rust frame only when it can replace that image coherently.

## Existing Evidence

The current graph surface is large and active:

- `src/graphCore` contains 18 source files and 12,660 physical lines.
- `src/graphCore/transform.ts` contains 7,930 lines.
- `src/graphCore/Graph.tsx` contains 1,107 lines.
- The existing Rust graph-data and TypeScript transport path contains another
  7,011 lines across its principal files.
- The measured ECharts scatter budget is 8,000 points.
- A measured 100,000-point ordinary ECharts scatter reached a 1,375.5 ms
  coherent frame and a 3,607 ms longest task on the recorded Windows machine.
- The backend 300,000-row graph projection benchmark is fast, but desktop
  `decodeMs` and `drawMs` remain unmeasured in the CLI harness.

These facts support a separate vertical slice rather than a rewrite of the
existing runtime.

## Performance Meaning

"Supports 10,000,000 rows" means the backend scans all qualifying source rows
and the visual result represents the complete population through a bounded,
pixel-aware LOD. It does not mean that every frame submits 10,000,000
independent overlapping marks.

Population counts use all qualifying rows; representative marks do not preserve
every observation or guarantee anomaly visibility. A small viewport alone does
not prove complete retained data.

### Approved Step 8 Performance-First Default

The user's 2026-09-17 performance-first decision supersedes the lossless-index
prerequisite for the current default. `TilePyramidBuilder::new` and the production
service build bounded LOD only. Fine tiles retain at most
min(max_tile_points, 4096) points. Every source row is scanned to obtain exact
global finite/excluded counts and tile populations; source tables stay immutable.
The existing temporary construction spools remain bounded-memory scan machinery,
not a retained raw authority. No raw index writer, pages, gap records, query
scratch reservation, or raw query runs on the default path.

Camera selection uses retained tiles only, within the pixel-aware mark budget.
`exactVisible` is true only when all intersecting tile populations were retained
without downsampling and then filtered to the viewport. Otherwise it stays false,
even if zero representatives remain visible. `visibleRows` is an exact count or
null: known for a complete retained view or a camera enclosing the full domain,
unknown for an incomplete partial viewport. Tile-population sums must never be
presented as exact viewport counts. Above-budget LOD and anomaly visibility remain
approximate; this does not establish arbitrary statistical completeness.

Default persistence stores only LOD with budgets, lengths, counts, coordinates,
checksums, and existing owned-path checks. `GNPC0003` and
`graph-new-v4-bounded-lod` separate it from incompatible historical index caches.
The 1 GiB disk, 768 MiB CPU and 256 MiB GPU budgets, cancellation/epoch fences,
capacity accounting and cache-only camera misses remain in force. Bounded caches
do not reserve the research raw query's 64 MiB scratch.

Full projected raw retrieval remains a deferred goal. Explicit test-only
`lossless(...)` construction retains the raw research implementation, its 128-mark
fine summaries and exact recovery/checksum/ordinal tests under a separate key and
`GNPL0003` schema. It is not a public request option or UI toggle. Its scan order
does not establish time ordering or preserve original column types/NULL provenance.
No hover, click, time-series UI or Graph Builder parity expansion is authorized.

## Performance Budgets

The baseline device is a laptop from the last five years with an integrated
GPU, 16 GB system memory, and NVMe storage. Acceptance uses release builds.

For a representative 10,000,000-row dataset with two numeric value columns and
a stable row ID:

- First coherent, interactive overview: at most 3,000 ms.
- Warm reopen of the same completed `GraphKey`: at most 300 ms.
- Interaction-triggered DuckDB query count during pan/zoom: exactly zero.
- Pan/zoom frame-rate P95: at least 55 FPS.
- Pan/zoom frame-time P95: at most 18 ms.
- The pan/zoom FPS and frame-time targets measure pointer handling and WebView
  composition of the most recent coherent frame. They do not claim that Rust
  reads back and transfers a new 4K bitmap at 55 or 60 FPS.
- Highest currently available LOD displayed after interaction settles: at most
  200 ms.
- For a 3840 x 2160 output frame, GPU readback through WebView presentation is
  at most 100 ms P95, leaving the other half of the settled-LOD budget for
  selection, rendering, and scheduling.
- Avoidable WebView main-thread task: at most 50 ms.
- GPU cache budget per graph: at most 256 MiB by default.
- Total process graph-cache budget: at most 1 GiB by default.
- Cache pressure degrades through bounded LRU eviction; it must not crash,
  corrupt project data, or silently switch statistical semantics.

The overview target and complete-pyramid target are separate. The overview must
be interactive within 3 seconds. Finer LOD construction may continue in the
background, with a target of completing the representative pyramid within 10
seconds. Background construction is one already-running build operation, not a
query launched by each gesture.

At 3840 x 2160, one uncompressed RGBA8 frame is 33,177,600 bytes, about
31.6 MiB. A 60 FPS raw stream would move about 1.99 GB/s before serialization,
copies, decoding, or presentation. That transport pattern is explicitly
outside the design. Passing RGBA bytes as JSON numbers, serializing them into a
normal event payload, or Base64-encoding them is a design failure rather than
an optimization opportunity.

## Architecture

```text
Current dataset + temporary Graph Builder-new state
                       |
                       v
              GraphNewRequest / GraphKey
                       |
                       v
             Rust graph_new service
        validate -> project -> stream full scan
                       |
                       v
        TilePyramidBuilder (bounded)
                       |
             +---------+----------+
             |                    |
             v                    v
       bounded tile cache    wgpu renderer
                                  |
                                  v
                       offscreen RGBA frame
                                  |
                                  v
                 approved binary frame transport
                                  |
                                  v
              GraphBuilderNewView / input bridge
```

### Isolation From Existing Graph Builder

`Graph Builder-new` is a separate workspace surface, store, request contract,
service, and renderer host. It may reuse stable dataset metadata and validated
filter primitives, but it must not route the existing Graph Builder through
new code or alter existing graph documents.

The initial entry opens from the menu against the current dataset. Closing the
view discards its UI configuration. Project save/open ignores this temporary
state. This prevents an experimental schema from becoming an archive contract.

### Transport Feasibility Gate

Before DuckDB scanning, the tile pyramid, text rendering, or production
interaction is implemented, a synthetic `wgpu` point scene must exercise the
exact production-shaped path from offscreen texture through WebView
presentation at 1920 x 1080 and 3840 x 2160. This is Slice 0 and a hard Plan B
gate, not an optional benchmark added after the renderer is complete.

The spike compares only binary-safe candidates that avoid text serialization:

- a Tauri raw-byte response consumed as an `ArrayBuffer`, then decoded or
  uploaded without conversion to a JavaScript number array; and
- an application-owned custom protocol serving immutable, generation-keyed
  encoded frames to browser-native image decode.

The smallest cross-platform candidate that passes is promoted into the MVP.
Base64, data URLs, JSON byte arrays, per-frame temporary paths exposed to the
frontend, and an unbounded event stream are prohibited.

The transport uses latest-wins backpressure. At most one frame is being read
back or transferred and one complete frame is pending presentation per view. A
newer camera generation invalidates pending older work; frames never queue
behind pointer events. Buffers are pooled and their peak count and bytes are
measured. The previous coherent image remains visible until its complete
replacement is decoded and ready.

The 4K gate passes only when a release build demonstrates all of these on the
baseline machine class:

- readback + optional encode + transfer + decode + present is at most 100 ms
  P95 over a sustained scripted run;
- WebView pointer handling and compositor reprojection remain at least 55 FPS
  P95 with frame time at most 18 ms P95 while replacement frames arrive;
- no avoidable WebView main-thread task exceeds 50 ms;
- transport has no Base64 or JSON pixel representation, no queue growth, and
  no more than the bounded current/pending/presentation buffer set; and
- cancellation, resize, and stale generations cannot present a torn or old
  frame.

Failure stops Plan B before the expensive data and LOD work begins. The review
then chooses explicitly between reducing the product requirement, moving GPU
rendering into the WebView, or authorizing a separate Plan C native-composition
spike. It must not continue under the assumption that later tuning will remove
the transport boundary.

Decision update (2026-09-17): the release probe retained coherent 4K output,
bounded queue depth, and zero stale/torn frames, but measured 50.00 FPS and
20 ms compositor frame-time P95 against the strict 55 FPS / 18 ms targets. The
user explicitly accepted this shortfall for the current milestone and
authorized Task 4 while deferring transport optimization. The strict gate
remains failed; this exception is not evidence that later tuning will remove
the transport boundary.

### Renderer-Neutral Scene Contract

The MVP scene contract contains only the primitives needed by the point plot:

- viewport dimensions and device-pixel ratio;
- numeric X and Y domains;
- major ticks and labels;
- plot rectangle and clipping rectangle;
- point tile references and point style;
- row-identity metadata for hit testing;
- light-theme colors;
- build generation and frame identity.

The contract must not expose ECharts options, ZRender objects, DOM nodes,
platform window handles, or `wgpu` resource handles. Rust validates all scene
and tile inputs before allocation or rendering.

### GraphKey

A canonical `GraphKey` includes:

- dataset ID and dataset generation;
- X and Y stable column IDs;
- normalized filter identity, if filtering enters the MVP;
- renderer contract version;
- tile format version;
- numeric-domain policy.

Column display names are not identity. Any generation or format mismatch is a
cache miss. Graph keys are hashed for storage, but diagnostics retain only
path-safe, non-sensitive fields and never expose absolute cache paths.

The MVP must not prebuild every possible column pair. A pyramid is built only
for an actual `GraphKey`, then reused on warm open.

## Rust Data Path

### Request Validation

A thin Tauri command delegates to `graph_new_service`. The service validates:

- the dataset exists and generation matches;
- X and Y resolve by stable column ID;
- both columns are supported numeric types;
- dimensions and device-pixel ratio are finite and bounded;
- cache and tile budgets are within application-owned limits;
- no untrusted identifier enters SQL without metadata validation and quoting.

Errors return `Result<T, AppError>` using existing application variants. No
non-test code uses `unwrap()` or `expect()`.

### Single Full Scan

DuckDB projects only `_row_id`, X, and Y. The scan is streaming and bounded; it
must not materialize ten million Rust row objects or send raw rows through JSON.
Invalid or non-finite X/Y observations are excluded with explicit counters.
Cancellation and dataset-generation checks occur between bounded batches.

The scan produces:

- global finite X/Y bounds;
- a coarse overview tile set;
- progressively finer spatial tiles;
- per-tile counts and deterministic representative points;
- an exact row-identity payload for retained points;
- timing, processed-row, excluded-row, and memory telemetry.

### LOD Pyramid

The pyramid uses a fixed quadtree-like spatial address per `GraphKey`. Each
level increases screen-space resolution. A tile has a versioned binary header
and structure-of-arrays payload rather than row-oriented JSON.

Representative selection is deterministic for the same data generation and
key. Dense cells retain density/count information so the overview represents
the full source population even when one representative mark is drawn. Fine
levels retain exact points needed for deep zoom and hit testing within their
bounded tile region.

LOD selection depends on viewport size, camera domain, device-pixel ratio, and
a bounded overdraw factor. It does not depend on total source-row count after
the pyramid exists.

### Cache Layers

1. **Persistent tile cache:** versioned files under an application-owned cache
   directory, keyed by `GraphKey`; never stored in `.spprj` for this MVP.
2. **CPU tile cache:** decoded, bounded tiles required by the current and
   adjacent LOD.
3. **GPU tile cache:** uploaded point buffers and render resources bounded to
   256 MiB per graph by default.

The process-wide cache coordinator enforces the 1 GiB default using LRU
metadata. Cache eviction is safe because every artifact is derived. A corrupt
or incompatible tile is deleted and rebuilt without affecting project data.

## wgpu Offscreen Renderer

The renderer creates an adapter/device/queue compatible with the active
platform backend, but does not create a native window surface. It renders to an
offscreen texture sized to the plot viewport and device-pixel ratio.

The point pipeline uses instanced or vertex-buffer point primitives, plot-rect
clipping, and a uniform camera transform. Pan/zoom updates camera uniforms and
selects cached tiles; it does not rebuild point objects or query DuckDB.

Axis and label work remains deliberately small in the MVP. Rust computes stable
numeric ticks and the renderer draws a single light-theme axis/grid style. Text
uses one explicitly selected cross-platform text rasterization strategy with a
bounded glyph atlas. Exact visual parity with ECharts is not required; legible,
stable output and deterministic screenshots are required.

The frame transport is the binary-safe mechanism approved by the Transport
Feasibility Gate. Shared native texture handles are out of scope. The
implementation records render, readback, encode, transfer, decode, and present
times separately and preserves the spike's bounded buffer and latest-wins
rules.

## Interaction Model

The frontend owns DOM sizing and pointer capture. It forwards normalized input
with viewport identity and camera generation to the Rust runtime.

- Wheel/pointer pan and zoom update the camera immediately.
- During an active gesture, the WebView compositor applies an affine
  reprojection to the last coherent bitmap at display refresh rate. Overscan
  limits exposed edges. Axis labels may be transiently stale or softened, but
  the state is visibly provisional and never used for hit-test identity.
- Existing CPU/GPU tiles are selected without a DuckDB query.
- A settled interaction requests one fresh frame at the highest already-built
  matching LOD. That frame replaces the reprojected bitmap atomically within
  the settled-LOD budget.
- Background pyramid progress can make a finer LOD available and replace the
  frame coherently.
- Hover uses a bounded spatial index for the displayed tile set.
- Click returns stable `{ rowId, xColumnId, yColumnId }` identity.
- The table-selection bridge may be called only after row identity is verified
  against the active dataset generation.

A frame is committed only when request ID, dataset generation, camera
generation, and renderer generation all match the active view. Stale, duplicate,
out-of-order, or partial results never replace the previous coherent frame.

## Failure And Fallback

The existing Graph Builder is the product fallback. Because the new view is a
separate entry, failure in `Graph Builder-new` never mutates or reroutes an
existing graph document.

The new view preserves its last coherent frame and shows a stable diagnostic
when any of these occur:

- unsupported or unavailable GPU adapter;
- device loss;
- shader or pipeline creation failure;
- texture, buffer, or glyph-atlas allocation failure;
- invalid/corrupt tile;
- dataset-generation mismatch;
- cancellation;
- frame transport failure;
- cache-budget exhaustion;
- overview or renderer timeout.

Where possible, the view offers an explicit action to open the current dataset
in the existing Graph Builder. It does not silently claim that ECharts is the
same temporary graph, because the MVP state is not persisted and feature sets
differ.

Diagnostics use stable reason codes and path-safe messages. Raw backend errors,
absolute cache paths, GPU driver details that may expose machine information,
and SQL text stay out of the frontend contract.

## Test Strategy

Test code may cover future matrix dimensions early, but routine iteration runs
only the smallest focused and affected checks for the current point-plot slice.
A passing layer is rerun only when code, contracts, dependencies, environment,
or requirements invalidate it.

### Focused Tests During Development

- Rust `GraphKey` canonicalization and generation invalidation.
- Tile format round trip and corruption rejection.
- Deterministic representative selection and all-source count preservation.
- LOD selection and cache-budget eviction.
- Numeric tick generation.
- wgpu point geometry, clipping, camera transforms, and hit testing.
- 4K binary frame transport, backpressure, buffer reuse, stale cancellation,
  decode, and atomic presentation.
- command/service validation, cancellation, and stale-result fencing.
- TypeScript transport decoding and coherent-frame reducer.
- `Graph Builder-new` menu entry, temporary lifecycle, field binding, and error
  behavior.
- Light-theme point-plot Playwright component screenshots and interactions.

### Affected Checks At Milestone Boundaries

- New Rust graph module tests.
- Existing graph-data service tests when shared primitives change.
- New TypeScript contract and component suites.
- Workspace tests covering the separate entry and proving existing Graph
  Builder behavior remains unchanged.
- Frontend build and Rust build/clippy for touched targets.

### Final Pre-merge Gate

Run the repository-required full frontend and Rust verification once after the
MVP slices are complete, followed by independent review and manual desktop
acceptance. Full-suite failures are not waived; the accelerated workflow avoids
redundant full runs during iteration by reducing WIP to one vertical slice.

### Performance Harness

Extend the release benchmark with deterministic 100,000, 1,000,000, and
10,000,000-row graph-new workloads. Machine-readable output records:

- setup and full-scan time;
- overview-ready and pyramid-complete time;
- processed and excluded rows;
- tile counts and bytes per LOD;
- CPU/GPU cache bytes and eviction count;
- render, readback, encode, transfer, decode, and present time;
- frame-time distribution during scripted pan/zoom;
- interaction-triggered query count;
- hover/click hit-test latency and row-identity result;
- cancellation and stale-frame outcome.

The harness reports interaction compositor frames separately from newly
published Rust frames. It must never combine the two into one FPS number. It
also reports payload bytes before and after encoding, copy count where the
platform exposes it, peak transport buffers/bytes, dropped superseded frames,
and maximum queue depth.

Absolute time/FPS acceptance runs on the stated integrated-GPU machine class.
Ordinary CI validates deterministic shape, bounded memory contracts, and
regression ratios where stable; it does not pretend shared runners provide a
reliable GPU performance oracle.

## Delivery Slices

### Slice 0: 4K Frame Transport Gate

Deliver a synthetic offscreen `wgpu` point scene and the smallest
production-shaped WebView receiver. Compare binary-safe transport candidates
at 1080p and 4K, verify compositor reprojection and latest-wins backpressure,
and record every pipeline stage. Do not begin the DuckDB, LOD, text, or full UI
implementation unless the 4K gate passes. A failed gate produces an
architecture decision, not a partially built product path.

### Slice 1: Independent Product Entry

Deliver a menu-opened, session-only `Graph Builder-new` shell bound to the
current dataset. It lists numeric columns and does not alter project payloads,
directory records, or the existing Graph Builder.

### Slice 2: Contracts And Headless LOD

Deliver versioned Rust/TypeScript contracts, `GraphKey`, a cancellable full
scan, deterministic overview tiles, and a headless 10,000,000-row benchmark.
The approved Slice 0 transport contract is a prerequisite; no additional GPU
or production UI work is required to approve this slice.

### Slice 3: Offscreen Point Renderer

Deliver the light-theme point pipeline, axes/grid, text atlas, offscreen frame,
and measured WebView transport. The UI displays a coherent overview and keeps
the old Graph Builder independent.

### Slice 4: Interaction And Identity

Deliver pan/zoom without interaction-triggered queries, LOD switching, tooltip,
stable row selection, stale fencing, and last-frame preservation.

### Slice 5: Cache And Performance Gate

Deliver persistent/CPU/GPU cache budgets, corruption recovery, warm reopen,
release instrumentation, and the integrated-GPU 10,000,000-row acceptance
record.

### Slice 6: Hardening And MVP Decision

Complete focused/affected suites, one final repository-wide verification,
independent review, and manual acceptance. Decide from evidence whether to keep
`Graph Builder-new` experimental, begin additional 2D marks, or revise the
transport/renderer architecture.

Only one slice is active at a time. Each slice is independently demonstrable,
reviewed, and committed on the Issue 221 branch before the next begins.

## Migration Gates After The MVP

The MVP does not authorize replacement of the current Graph Builder. Later
capabilities migrate independently only after functional, visual, interaction,
performance, cross-platform, and rollback gates pass.

The next likely order is dark theme, project persistence/directory integration,
categorical/grouped point plots, facets, remaining 2D marks, Analysis
integration, and 3D. Plan C native-surface research begins only if measured
readback/transport cost materially limits Plan B and a separate spike proves
that native composition benefits outweigh platform risk.

## Security And Compatibility

- SQL values remain parameterized. Dynamic identifiers resolve through dataset
  metadata and use the existing identifier-quoting boundary.
- Cache paths remain under application-owned directories and never cross IPC.
- The frontend never supplies a filesystem path or GPU resource handle.
- Existing `.spprj` files and graph documents are unchanged.
- Existing Graph Builder tests remain active.
- Cancellation, project replacement, dataset deletion, and generation changes
  fence all late work.
- A renderer or cache failure cannot mutate source data.

## Acceptance Summary

The MVP is accepted only when all of the following are true:

- The current Graph Builder behaves as before.
- `Graph Builder-new` opens separately and remains session-only.
- A light-theme numeric X/Y point plot reaches a coherent interactive overview
  from 10,000,000 source rows within 3 seconds on the baseline machine class.
- Warm reopen of the same completed `GraphKey` is within 300 ms.
- Scripted pan/zoom launches zero DuckDB queries and meets the approved frame
  budgets through compositor reprojection; published-Rust-frame cadence is
  reported separately and is not represented as display FPS.
- The 4K transport gate passes without Base64/JSON pixels, queue growth, or an
  avoidable WebView main-thread task over 50 ms, and its readback-to-present
  pipeline is at most 100 ms P95.
- Settled interaction presents the highest available LOD within 200 ms.
- Tooltip and click resolve a stable source row correctly.
- GPU and process cache budgets are enforced through safe eviction.
- Cancellation, stale responses, cache corruption, device loss, and transport
  failure preserve the previous frame and produce actionable diagnostics.
- Focused and affected tests pass during development; the complete required
  repository verification, independent review, and manual acceptance pass once
  at the final pre-merge gate.

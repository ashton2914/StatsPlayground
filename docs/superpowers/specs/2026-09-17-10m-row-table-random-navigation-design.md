# 10M-Row Table Random Navigation Design

## Status

Approved in chat on 2026-09-17. This document defines the architecture and
acceptance boundary for JMP-like random navigation across managed tables with
at least 10,000,000 rows.

**Tracking:** https://github.com/ashton2914/StatsPlayground/issues/224

## Problem

`DataTableView` already limits rendered rows and keeps a bounded 5,000-row
cache, but its remaining contracts still scale poorly for very large tables:

- The browser scroll space is represented by spacer heights derived from
  `logical row count * row height`. At 10,000,000 rows and 27 px per row, the
  logical height is 270,000,000 CSS pixels, beyond the reliable scroll range of
  the target WebViews.
- Every uncached window request performs an exact `COUNT(*)` and then reads the
  requested page through `LIMIT/OFFSET`.
- A deep jump therefore pays for counting and offset traversal before any cell
  values can appear.
- Every response projects all user columns and serializes nested JSON even
  when horizontal virtualization displays only a subset.
- Read requests share one globally locked DuckDB engine. Obsolete requests are
  ignored by the frontend after completion but are not cancelled, so they can
  delay the newest viewport request.
- Rows are keyed by logical row index, so a distant jump replaces the visible
  row tree instead of reusing a stable pool of viewport slots.

The result is bounded frontend memory but not bounded random-access latency.
Optimizing React rendering alone cannot produce JMP-like navigation.

## Goal

Keep the table visibly responsive while the user drags directly to any logical
position in a 10,000,000-row managed table, then show the requested values
within a bounded settled latency.

The implementation must preserve existing table editing, selection, filtering,
sorting, column formatting, calculated-column, history, and stale-generation
semantics. It must remain domain-neutral and work on Windows WebView2 and macOS
WKWebView.

## Non-Goals

- Replacing the table with Canvas, WebGL, or `wgpu` in the first delivery.
- Rendering or retaining all rows or columns in the WebView.
- Guaranteeing instant first-use completion of an uncached 10,000,000-row
  arbitrary sort or complex filter.
- Changing graph rendering or Issue 221's dual-renderer work.
- Expanding large selections into frontend cell or row sets.

## Performance Contract

Release-build acceptance uses deterministic DuckDB-generated tables with at
least 10,000,000 rows and representative numeric, categorical, text, date, and
calculated columns.

- Scroll-drag visual feedback P95: no more than 16 ms.
- No blank table body while a target window is loading. Target row numbers and
  inert placeholder cells remain visible.
- Natural-order cold random jump P95: no more than 100 ms after drag settles.
- Cached random jump P95: no more than 50 ms.
- Filtered or sorted random jump after its query session is ready P95: no more
  than 200 ms.
- At most one active viewport query and one pending latest target per table.
- Frontend retained rows and DOM nodes remain bounded independently of total
  row count.
- A jump must not trigger an exact full-result count when a valid count already
  exists for the same query signature.
- Measurements report lock wait, count, order/session preparation, DuckDB
  execution, encoding, IPC, decode, React commit, and first painted cells as
  separate stages.

The acceptance positions are the beginning, 50%, 90%, 99%, and end of the
logical result. Tests include repeated top-to-bottom dragging and rapid
bidirectional dragging.

## Recommended Architecture

### 1. Logical Scroll Model

Replace table-height-derived scrolling with a bounded physical scroll rail.
The rail maps its thumb position to a logical row position:

```text
logicalStart = round(positionRatio * max(0, totalRows - visibleRows))
```

The mapping is owned by a pure `tableScrollModel` module. It clamps both ends,
supports zoom without changing logical position, and avoids cumulative floating
point drift by deriving every target from the current ratio and row count.

During thumb drag, the UI updates logical row numbers and a fixed viewport of
inert placeholder cells immediately. It does not create a spacer proportional
to total rows. Ordinary wheel and keyboard navigation update the same logical
position by row deltas, preserving expected spreadsheet behavior.

The first implementation may retain the native scroll container for horizontal
scrolling. Vertical navigation uses a dedicated logical rail so browser maximum
element-height behavior cannot affect row addressing.

### 2. Stable Viewport Slot Pool

Render a bounded set of row slots based on viewport height plus overscan. Slot
identity is its viewport slot, not the current logical row number. Each slot is
rebound to a logical row and row payload when the window changes.

The slot pool preserves:

- absolute logical row numbers for headers, selection, editing, and hit testing;
- stable dimensions while placeholder and loaded states alternate;
- existing horizontal column virtualization;
- no interaction on placeholder cells;
- atomic replacement of placeholders when the matching target arrives.

This removes distant-jump DOM churn while keeping semantic cell components and
the existing editor behavior.

### 3. Natural-Order Seek Windows

Natural table order uses stable `_row_id` seeking instead of deep offset
pagination. A request identifies the target logical start, requested visible
columns, row count, dataset generation, and navigation mode.

For dense natural order, the engine translates the logical target into a row ID
anchor and executes the equivalent of:

```sql
SELECT _row_id, <visible columns>
FROM <managed table>
WHERE _row_id >= ?
ORDER BY _row_id
LIMIT ?
```

The engine must not assume `_row_id == logical index + 1` after insertions and
deletions. Dataset metadata maintains or resolves stable natural-order anchors.
The implementation may use sparse anchor checkpoints, such as one anchor per
fixed row block, so locating a natural-order target remains bounded without a
10,000,000-entry frontend index.

Natural-order total count comes from generation-bound dataset metadata. It is
not recomputed for each viewport request.

### 4. Filtered And Sorted Query Sessions

Keyset pagination alone cannot jump directly to an arbitrary percentile of an
arbitrary filtered and sorted result. Those views use a backend query session.

A session is keyed by:

```text
dataset ID + dataset generation + normalized filter + deterministic sort
```

Session preparation builds a reusable ordinal mapping with deterministic
`_row_id` tie-breaking:

```text
logical ordinal -> stable _row_id
```

The session owns the exact filtered row count and serves later windows by
ordinal range. Preparation runs asynchronously, reports progress when it
exceeds the UI feedback threshold, and is cancellable. Until it is ready, the
table keeps the previous coherent window or target placeholders; it never
shows rows under the wrong sort/filter as if they were current.

Sessions are invalidated by dataset generation changes, filter/sort changes,
project replacement, or idle expiry. They are bounded by count and bytes and
evicted with LRU policy. Session creation failure leaves the existing dataset
and prior valid view unchanged.

### 5. Latest-Wins Request Scheduling

Scroll drag is coalesced at animation-frame frequency for visual updates. Data
requests are issued only after a short settle interval or pointer release.

Each table has:

- one active viewport request;
- one latest pending target that replaces any older pending target;
- a cancellation token propagated to DuckDB work where supported;
- a monotonically increasing request epoch and dataset generation fence.

Completion is applied only when dataset, generation, query signature, epoch,
and target still match. Cancellation is operational, not merely suppression of
stale results after they consume the shared connection.

Ordinary table reads move to a bounded read-connection path so stale reads do
not monopolize the global writer lock. Mutations remain serialized and advance
the generation before affected cache/session entries can be reused.

### 6. Column-Aware Window Transport

The viewport request includes visible column IDs plus horizontal overscan.
`_row_id` is always included. The backend validates every requested identifier
against dataset metadata and projects only those columns.

The first slice may retain JSON when measured end-to-end latency remains within
budget. A binary columnar transport, preferably Arrow IPC or an equivalently
typed bounded payload, becomes mandatory if encode, transfer, or decode exceeds
20% of the uncached-jump budget on the representative wide-table workload.

The transport contract is versioned so JSON and binary implementations can be
compared without changing logical scrolling or query-session behavior.

### 7. Cache Model

The frontend cache key includes dataset generation, query signature, aligned
logical window, and projected column set. It stores bounded immutable windows
and never duplicates row arrays for overlapping consumers.

The active window and immediate neighbors may be prefetched after the settled
target is shown. Prefetch is lower priority than direct navigation and is
cancelled when the target changes. Byte and row budgets are both enforced.

The backend may retain natural-order anchors and query sessions, but neither
cache may grow with navigation history without eviction.

## Data Flow

```text
pointer/wheel/keyboard
        |
        v
logical scroll model ------> placeholder row slots painted immediately
        |
        | settled target
        v
latest-wins viewport scheduler
        |
        +--> natural order: generation metadata + row-id anchor seek
        |
        +--> filter/sort: generation-bound ordinal query session
        |
        v
visible-column bounded window
        |
        v
JSON or binary IPC -> decoded cache -> stable viewport slots
```

## Mutation And Consistency Rules

- Every table mutation advances the dataset generation.
- A mutation cancels active reads for the previous generation.
- Cell edits invalidate only windows containing the affected row and projected
  column when logical order is unchanged.
- Insert, delete, filter-dependent edit, or sort-key edit invalidates affected
  natural anchors and all query sessions whose ordering or membership may
  change.
- Existing edit commits continue to use stable `_row_id`, never viewport slot
  identity or logical position.
- Selection state remains expressed in logical ranges, stable row IDs, or
  backend tokens. Slot recycling must not transfer selection or edit state to a
  newly bound logical row.

## Error And Degradation Behavior

- A failed target request keeps the scroll position and placeholders, presents
  a retryable error, and does not fall back to stale values from another target.
- Query-session cancellation is not an error and must not surface a toast.
- Memory-pressure eviction may remove prefetched and idle sessions but not the
  active displayed window.
- If binary negotiation fails, a bounded JSON fallback is allowed and reported
  in diagnostics.
- If the requested columns no longer exist at the current generation, the
  request fails as stale and the frontend refreshes metadata before retrying
  once.
- Exact count may be temporarily unknown while a filtered session prepares.
  The logical rail switches to determinate positioning only when the session
  publishes a coherent count and ordinal mapping.

## Delivery Slices

### Slice 0: Measurement Gate

- Add a deterministic 10,000,000-row table-navigation benchmark.
- Measure current spacer behavior and stage timings at all acceptance positions.
- Add pure tests for logical ratio/row mapping, zoom, clamping, and large counts.
- Establish Windows and macOS release baselines before behavior changes.

### Slice 1: Natural-Order MVP

- Add the logical vertical rail and stable viewport slots.
- Replace repeated natural-order count queries with generation metadata.
- Add natural-order anchor seek windows and visible-column projection.
- Add latest-wins settled request scheduling and real cancellation.
- Preserve editing, selection, formatting, and calculated-column behavior.

This slice must independently meet the natural-order 10,000,000-row acceptance
target before filtered/sorted work begins.

### Slice 2: Filtered And Sorted Random Access

- Add normalized query signatures and asynchronous query-session lifecycle.
- Add deterministic ordinal mappings and count-once behavior.
- Add progress, cancellation, idle expiry, byte budgets, and generation
  invalidation.
- Verify sort/filter equivalence against the existing table semantics.

### Slice 3: Transport And Concurrency Hardening

- Measure visible-column JSON transport against the budget.
- Add versioned binary columnar transport when the threshold is exceeded.
- Introduce the bounded read-connection path and verify writer isolation.
- Add neighbor prefetch, priority, memory-pressure, and cancellation stress
  coverage.

### Slice 4: Cross-Platform Acceptance

- Run deterministic release benchmarks on Windows WebView2 and macOS WKWebView.
- Exercise mouse, trackpad, scrollbar thumb, keyboard, zoom, selection, editing,
  filters, sorts, calculated columns, project switch, undo/redo, and mutation
  invalidation.
- Record P50/P95 timings, peak retained rows/bytes, active request count, and
  query-session build times.

## Testing Strategy

Testing follows the repository's TDD and focused-validation workflow.

- Pure TypeScript tests cover logical scroll mapping, slot rebinding, request
  coalescing, stale-response rejection, and cache keys.
- Playwright component tests cover nonblank placeholders, stable row dimensions,
  distant jumps, bidirectional drag, slot state isolation, editing, and
  selection after recycling.
- Rust tests cover natural anchors with insert/delete gaps, count metadata,
  deterministic tie-breaking, query-session windows, cancellation, generation
  invalidation, column validation, and memory/session eviction.
- Integration tests send exact frontend request shapes through the registered
  Tauri command path.
- Release performance tests generate data inside DuckDB so CSV parsing and IPC
  fixture construction do not contaminate navigation measurements.
- Existing table viewport, cache, filter, edit, history, calculated-column,
  project, and archive suites remain regression gates.

## Rollout And Observability

The feature is introduced behind an internal table-navigation capability flag
until Slice 4 passes. Diagnostics expose stage timings and active/cancelled
request counts in development builds without logging cell values or absolute
paths.

The old physical-height path remains available only during measured comparison
and is removed after cross-platform acceptance. The production UI does not
offer two user-selectable table modes.

## Decision Summary

StatsPlayground will keep its semantic DOM table and existing product behavior,
but replace physical-height scrolling and offset pagination with a bounded
logical viewport and generation-safe random-access backend. Natural order uses
row-ID anchor seeking. Arbitrary filtered/sorted order uses reusable ordinal
query sessions. Transport and Canvas/GPU work are driven by measured residual
bottlenecks rather than included speculatively.
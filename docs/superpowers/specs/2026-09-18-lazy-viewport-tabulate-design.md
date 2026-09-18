# Lazy Viewport Tabulate Design

**Date:** 2026-09-18
**Status:** Approved for planning

## Problem

Tabulate currently rejects any result above 10,000 interior cells, computes the
complete row-by-column matrix in Rust, sends the complete flattened matrix over
Tauri IPC, stores it in Zustand, and mounts every returned cell in the DOM. This
architecture does not match StatsPlayground's direction as a tool for datasets
with tens of millions of source rows.

The replacement must remove the fixed logical-result cap without silently
truncating, sampling, or approximating statistics. Work and memory must scale
primarily with the visible viewport and bounded caches rather than with the full
Cartesian result matrix.

## Goals

- Support exact Tabulate navigation over source datasets with at least
  10,000,000 rows.
- Remove the fixed 10,000-total-cell contract.
- Allow logically unbounded result grids, subject to explicit time, memory,
  concurrency, and response-size protections rather than a total-cell limit.
- Compute only the aggregate cells needed by the visible two-dimensional
  viewport, plus bounded adjacent prefetch tiles.
- Preserve all existing statistic, missing-value, member-ordering, percentage,
  total, formatting, project, report, workflow, and MCP semantics.
- Keep interaction responsive through request cancellation, latest-request-wins
  fences, bounded tile caching, and logical scrolling.
- Export the complete exact result directly in the backend without routing the
  complete matrix through JavaScript.

## Non-Goals

- Approximate statistics, sampling, top-N fallback, or silent result truncation.
- Persisting runtime sessions or aggregate tiles in `.spprj` archives.
- Reusing `DataTableView` as the Tabulate UI. Tabulate may reuse its logical
  scrolling, request epoch, scheduler, and cache patterns, but owns a distinct
  two-dimensional aggregate contract and renderer.
- Claiming that a 10,000,000-cell matrix always fits every machine. That tier
  may produce a controlled resource refusal, but it must never freeze the UI,
  crash the process, or present a partial result as complete.

## Selected Architecture

Use a backend Tabulate session that materializes only deterministic row-member
and column-member indexes. Aggregate values remain lazy. A viewport request
selects bounded row and column ordinal ranges, joins those member keys back to
the source table with null-safe equality, and executes exact grouped aggregates
only for the selected combinations.

The backend returns sparse ordinal-addressed aggregate rows. The frontend fills
missing combinations with the statistic's existing `null` or zero semantics
inside the requested tile. Neither layer expands the complete Cartesian matrix.

Previously visited tiles are held in a bounded frontend LRU. The scheduler
prefetches at most the immediately adjacent row and column tiles and cancels
obsolete requests. The backend does not require a complete aggregate cube or an
unbounded aggregate cache.

## Backend Contracts

### Session Preparation

Replace the monolithic `tabulate` result path used by interactive consumers
with these commands:

```text
prepare_tabulate_session(TabulateSessionRequest) -> TabulateSessionStatus
get_tabulate_session_status(sessionId) -> TabulateSessionStatus
query_tabulate_window(TabulateWindowRequest) -> TabulateWindowResult
query_tabulate_totals(TabulateTotalsRequest) -> TabulateTotalsResult
cancel_tabulate_request(requestId) -> ()
release_tabulate_session(sessionId) -> ()
materialize_tabulate_table(TabulateMaterializeRequest) -> DatasetMeta
```

`TabulateSessionRequest` contains the dataset ID, source generation, row fields,
column fields, statistics, and total flags. It contains no total-cell limit.
The canonical request fingerprint covers every statistical input and the source
generation.

Preparation creates backend-owned temporary member-index tables with stable
zero-based ordinals. Member ordering remains the current deterministic
lexicographic field order with nulls last. No-dimension roles receive one
synthetic empty member. Temporary table and index names are derived only from a
backend UUID and never from user input.

`TabulateSessionStatus` exposes `preparing | ready | cancelled | failed`, row
member count, column member count, logical cell count, measured member-index
bytes, and a stable failure code. Logical cell count uses checked 64-bit
multiplication and is informational, not an admission cap.

### Window Queries

`TabulateWindowRequest` contains:

```text
requestId, sessionId, sourceGeneration,
rowStart, rowCount, columnStart, columnCount
```

The backend accepts at most 128 row members, 64 column members, and 16,384
numeric cells (`rowCount * columnCount * statisticCount`) per response. These
are transport-window bounds, not total-result bounds. The frontend reduces the
requested row or column count when many statistics are configured.

`TabulateWindowResult` returns the exact requested start positions, bounded
member slices, statistics, sparse cells addressed by row ordinal, column
ordinal, and statistic index, source generation, and session fingerprint. A
short final window is valid only at a known result edge.

Every request validates session identity, source generation, request bounds,
and fingerprint before querying. A stale or released session returns a stable
error and cannot update the visible result.

### Exact SQL

Window SQL joins the source table to the selected row and column member slices
with `IS NOT DISTINCT FROM` for null-safe equality, groups by both selected
ordinals, and evaluates the existing backend-owned aggregate templates. User
values never become SQL fragments. Validated identifiers remain double-quoted.

Count-like missing combinations become zero; nullable numeric aggregates remain
null. Standard deviation and variance retain sample semantics. Median and
quantile remain exact DuckDB aggregates.

### Percentages And Totals

Percentages must not derive denominators from the visible tile:

- Row percentage uses the exact full-row denominator for each visible row.
- Column percentage uses the exact full-column denominator for each visible
  column.
- Total percentage uses the exact grand denominator.

`query_tabulate_totals` lazily requests bounded row-total or column-total
ordinal ranges and the grand total. Totals use separate cache keys from interior
tiles. The frontend may request totals concurrently with a visible tile but
must show a pending total rather than a partial percentage.

### Session Lifecycle And Budgets

- At most two prepared Tabulate sessions per dataset.
- At most 256 MiB of measured member-index storage across active Tabulate
  sessions.
- Sessions expire after five minutes of inactivity when no query is active.
- A released or evicted session interrupts its active query, drops its temporary
  tables/indexes, and cannot be resurrected by a late completion.
- Window and totals requests are cancellable through DuckDB interrupt handles.
- Preparation and queries report stable failures for cancellation, stale source,
  member-index budget, query timeout, invalid bounds, and unavailable session.
- Resource refusal never returns a partial result marked ready.

These initial limits deliberately match the existing prepared table-navigation
budget and TTL. Performance evidence may justify later tuning, but implementation
must not silently raise them to make a benchmark pass.

## Frontend Architecture

### State

`useTabulateStore` persists only Tabulate definitions. Runtime state moves to a
focused session controller owned by the mounted interactive or report view:

- session status and fingerprint
- source generation
- row/column counts
- logical cell count
- current row/column logical starts
- bounded tile and totals caches
- request epoch and active request IDs

The store no longer retains a complete `TabulateResult`. Runtime state is reset
on definition changes, source generation changes, project new/open/close, and
component unmount.

### Two-Dimensional Logical Viewport

`TabulateResultTable` becomes a div/grid-based virtualized renderer rather than
a semantic `<table>` containing the complete result. It renders only visible
row slots, column/statistic slots, overscan, sticky hierarchical labels, and
totals. Stable dimensions prevent loading or label changes from shifting the
layout.

Logical row and column starts are independent of browser spacer size. Wheel,
scrollbar, keyboard, and programmatic navigation update logical positions. Both
axes clamp against backend counts. Hierarchical header spans are derived from
the visible member slice plus boundary context supplied by the window response,
so groups remain correct when a span starts before the viewport.

The frontend uses a Tabulate-specific two-dimensional cache and scheduler. It
may reuse `RequestEpoch`, cancellation, latest-request-wins, and LRU patterns
from large-table navigation, but it does not modify `DataTableView` or use raw
table-window response types.

The mounted lifecycle is owned by
`useTabulateSession(definition, datasetGeneration, presentation)`. The hook
prepares, polls, queries, cancels, retries, and releases one runtime session; it
does not write that session into durable Zustand state.

### Loading And Errors

The result surface distinguishes preparation, visible-tile loading, total
loading, cancelled, stale, resource refusal, and retryable failure. Existing
cells may remain visible during adjacent navigation but are marked busy and
cannot be mistaken for the newly requested coordinates. Stale completions are
discarded before any state mutation.

User-visible resource errors identify whether high member cardinality, memory,
timeout, session expiry, or source mutation caused the refusal. They recommend
reducing role cardinality or expensive statistics without claiming the result
was partially computed.

## Export, Reports, Workflow, And MCP

### Export To Table

Export calls `materialize_tabulate_table` with a ready session, source
generation, fingerprint, and destination name. The backend executes one exact
`CREATE TABLE AS`-style materialization inside the managed table transaction,
preserving existing flattened column naming, missing labels, duplicate suffixes,
and generation fences. The frontend never builds `CreateTableFromRowsRequest`
from all result cells.

If the session is stale, export prepares an equivalent session against the
current stable generation before the commit point. A source change during
materialization aborts without leaving metadata or a partial table.

### Reports

`TabulateReportEmbed` uses the same read-only session and virtualized result
surface. It releases its session on unmount. Interactive report viewing remains
exact and windowed. Static/print output must use an explicitly bounded export;
it must not load an unbounded matrix into the DOM.

### Application Commands, Workflow, And MCP

`tabulate.run` changes from returning the complete matrix to returning a session
summary. `tabulate.exportTable` remains the complete-result automation path but
uses backend materialization. Workflow execution records the summary and source
generation, not all cells. MCP schemas mirror these bounded outputs so a tool
call cannot place millions of cells into JSON context.

The legacy monolithic `tabulate` command remains temporarily available only for
existing focused compatibility tests and bounded callers. Interactive UI,
reports, Application Commands, Workflow, and MCP must migrate before the fixed
limit and legacy result types are removed.

## Persistence And Compatibility

Project archives continue to persist only `TabulateItem` definitions and folder
placement. No session ID, member index, tile, total, error, or runtime generation
is serialized. Existing projects open without migration because the saved
definition shape is unchanged.

The implementation must preserve read-only project behavior: viewing and
navigating a Tabulate is allowed, while definition edits and export remain
subject to existing mutation guards.

## Performance And Acceptance

Qualification uses generated deterministic fixtures and records source rows,
row-member count, column-member count, statistic count, logical cells, actual
nonempty groups, response cells, payload bytes, backend wall time, cancellation
latency, member-index bytes, process RSS, frontend heap where available, and
visible interaction latency.

Required tiers:

| Source rows | Logical cells | Required outcome |
|---:|---:|---|
| 10,000,000 | 100,000 | Exact visible tiles and totals; no full matrix allocation |
| 10,000,000 | 1,000,000 | Exact visible tiles and totals; bounded IPC/DOM/cache |
| 10,000,000 | 10,000,000 | Exact navigation or controlled resource refusal; no crash, freeze, truncation, or false success |

Performance evidence is layered:

- DuckDB member-index preparation
- backend tile and totals query wall time
- Tauri IPC payload and round trip
- frontend state/update time
- live WebView visible interaction P50/P95
- whole-process RSS, clearly distinguished from session-index bytes

At least 30 settled samples are required for P95 claims. macOS WebKit and
Windows WebView2 require separate live acceptance. Synthetic or mocked component
tests do not qualify as live WebView performance evidence.

## Test Strategy

- Rust model/service tests for validation, lifecycle, quotas, expiry,
  cancellation, and stable errors.
- DuckDB tests for member order, nested dimensions, null keys, sparse windows,
  all statistics, exact percentage denominators, totals, deep/final windows,
  generation changes, and atomic materialization.
- TypeScript tests for fingerprints, request epochs, two-dimensional window
  math, cache eviction, scheduler cancellation, boundary header spans, and stale
  completion rejection.
- Playwright component tests for horizontal/vertical logical navigation,
  hierarchy continuity, totals, loading/error recovery, read-only reports, and
  bounded rendered-cell counts.
- Application Command, Workflow, MCP schema/parity, project lifecycle, and
  export regressions.
- Final frontend build and complete affected Rust suites, followed by the
  performance matrix and native acceptance.

## Rollout

1. Add the new backend session/window/totals/materialization contracts while the
   legacy command remains intact.
2. Migrate the interactive Tabulate view and prove bounded rendering.
3. Migrate export and report consumers.
4. Migrate Application Commands, Workflow, and MCP schemas.
5. Run compatibility, resource, and performance gates.
6. Remove the fixed 10,000-cell contract and legacy full-result runtime only
   after no production consumer depends on it.
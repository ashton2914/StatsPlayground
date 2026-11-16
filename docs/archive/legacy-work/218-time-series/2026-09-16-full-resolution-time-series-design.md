# Full-Resolution Time Series Design

## Status

Approved by Ashton on 2026-09-16 after the investigation recorded in
[GitHub Issue 218](https://github.com/ashton2914/StatsPlayground/issues/218#issuecomment-5691496940)
and ADO Task 1120770.

## Goal

Add a first-class Time Series element to Graph Builder that renders every
filtered observation in deterministic order without sampling, downsampling, or
aggregation.

## Product Boundary

Time Series is a specialized 2D Graph Builder element, not a new top-level
analysis and not a second graph-building product. It reuses Graph Builder's
dataset filters, role slots, group/facet semantics, axes, themes, project
persistence, graph host, and export path.

The specialized element owns the behavior that a generic Line element cannot
promise:

- temporal X validation and interpretation;
- stable observation ordering;
- full-resolution admission independent of the scatter budget;
- missing-value gap semantics;
- dense-series marker and cursor behavior;
- target-WebView performance qualification.

Enabling Time Series must not change the meaning or eligibility rules of the
generic Graph Builder X slot for other elements.

## Why Existing Points Plus Line Is Insufficient

The current graph sampling policy rewrites Full Data to a deterministic 8,000
row sample for raw Points and Line. The backend also caps the raw-point budget
at 8,000 for ordinary point rendering. Generic raw frame conversion drops rows
whose X or Y value is invalid, so a Line configured to break on missing values
cannot retain the null sentinel needed to create a visible gap.

ECharts 5.6 ordinary `series-line` defaults to `sampling: "none"`, but its own
series defaults disable progressive rendering. Removing the application cap
would restore data semantics without proving that 50k, 100k, or 300k points are
usable on the target Windows WebView.

## Time Series X Contract

### Mode-Scoped Interpretation

The Time Series element persists one explicit X interpretation:

```ts
export type TimeSeriesTextDateFormat =
  | "isoDate"
  | "isoDateTime"
  | "usDate"
  | "usDateTime"
  | "dayFirstDate"
  | "dayFirstDateTime";

export type TimeSeriesXInterpretation =
  | { kind: "nativeTemporal" }
  | { kind: "textDate"; format: TimeSeriesTextDateFormat }
  | { kind: "sequence" };
```

The accepted text formats are a closed allowlist:

| ID | Example | DuckDB pattern |
| --- | --- | --- |
| `isoDate` | `2026-07-27` | `%Y-%m-%d` |
| `isoDateTime` | `2026-07-27 14:05:09` | `%Y-%m-%d %H:%M:%S` |
| `usDate` | `7/27/2026` | `%m/%d/%Y` |
| `usDateTime` | `7/27/2026 14:05:09` | `%m/%d/%Y %H:%M:%S` |
| `dayFirstDate` | `27/7/2026` | `%d/%m/%Y` |
| `dayFirstDateTime` | `27/7/2026 14:05:09` | `%d/%m/%Y %H:%M:%S` |

No locale-dependent or heuristic string parsing is allowed. A text column such
as the screenshot's `7/27/2026` data must use `textDate/usDate`. The format ID,
not the raw SQL pattern, crosses the IPC boundary.

### Eligibility

- `nativeTemporal` accepts DuckDB `DATE`, `TIMESTAMP`, and timestamp precision
  or time-zone variants. Standalone `TIME` is rejected because it wraps every
  day and does not define chronological order across dates.
- `textDate` accepts string-like columns only after the user selects one of the
  allowlisted formats.
- `sequence` accepts numeric columns and labels the X axis as sequence or
  elapsed value. It is never selected implicitly for a numeric X column.
- A type/interpretation mismatch blocks execution with an actionable message.

### Canonical Representation

Native and parsed temporal X values are converted in DuckDB to epoch
milliseconds and transported as `Float64Array`, with
`GraphAxisEncoding = "temporal"`. The frame metadata also records:

```ts
interface GraphTemporalAxisMetadata {
  unit: "epochMilliseconds";
  kind: "date" | "timestamp" | "timestampTz";
  displayZone: "utc";
}
```

Version 1 displays temporal values in UTC. `DATE` labels use UTC calendar
formatting so a browser timezone cannot shift a date into the previous day.
Timestamp axes visibly identify UTC. Per-graph timezone selection is outside
this version.

Text parsing is performed in DuckDB from the selected allowlist entry. Raw
format strings never enter generated SQL.

### Invalid X Values

Null or unparseable X values must not disappear silently. The stream counts
them while building the pending frame. If any exist, the request fails with a
structured `invalidTimeSeriesX` result containing the count; the frontend
discards the pending chunks, retains the previous coherent graph, and shows a
message that asks the user to fix/filter the values or choose the correct text
format.

## Ordering And Series Identity

The default ordering is computed by DuckDB:

```text
ORDER BY __sp_x ASC NULLS LAST, _row_id ASC
```

Each frontend series preserves that relative order. Duplicate X values are
retained and use `_row_id` as the deterministic tie-break. `Source Row Order`
is an explicit alternate mode that orders by `_row_id ASC`.

When multiple Y fields are melted, source-column identity remains part of the
series key. Group and source dictionaries must never merge two legal series
that share the same display label.

## Full-Resolution Contract

- Time Series requires `sampling.mode = "full"`.
- It never uses deterministic random sampling, LTTB, min/max envelopes, pixel
  aggregation, or ECharts `sampling`.
- Every filtered row with valid X and valid Y appears once as a line vertex in
  its series.
- A row with valid X and missing Y is retained as a null sentinel when missing
  mode is `break`; it is skipped only when missing mode is `connect`.
- Duplicate `(X, Y)` observations remain distinct and keep their source row ID.
- The ordinary scatter budget remains unchanged for generic Points and Line.
- Time Series is mutually exclusive with raw Points, generic Line, Smoother,
  Fit Line, Bar, and Histogram layers. Reference lines and reference bands may
  coexist with it.

The UI displays `Full resolution` and the included observation count. It does
not expose the generic Sample control while Time Series is active.

## Rendering

The first candidate uses ECharts Canvas `series-line` with:

- `sampling: "none"`;
- animation disabled;
- expensive emphasis disabled;
- no per-observation object allocation solely for pick metadata;
- a parallel row-ID index used by cursor and point picking;
- `showSymbol` controlled by `markerMode: "auto" | "show" | "hide"`.

All valid observations remain vertices in every marker mode. `auto` may hide
individual marker glyphs when density is high, but it must not remove data
vertices. Cursor/tooltip lookup still resolves the exact observation and row
ID. `show` draws every valid marker and is covered by the performance report as
a separate scenario.

Missing mode `break` emits a null data item at the original X. Missing mode
`connect` omits that item and connects its nearest valid neighbors.

## Performance Decision Gate

The ECharts candidate is measured on the target Windows WebView with total
point counts 8k, 50k, 100k, and 300k, using one and four series. Fixtures also
cover duplicate timestamps and 1% missing Y values.

The 300k default-marker scenario must meet all of these thresholds on the
reference environment:

- coherent cold frame no slower than 2,000 ms;
- maximum avoidable main-thread task no longer than 200 ms;
- zoom/pan patch p95 no slower than 100 ms;
- cursor update p95 no slower than 50 ms;
- peak JavaScript heap no greater than 512 MB.

If any threshold fails, implementation stops before release acceptance. The
same Time Series data contract is retained, and a dedicated high-density
renderer is planned as a replacement adapter. Sampling is not an allowed
performance fallback.

## Error Handling

- Unsupported X type: reject before starting the stream.
- Text format mismatch or null X: discard pending data and retain the previous
  coherent graph with the invalid-X count.
- Missing Y: apply the persisted break/connect rule.
- Cancelled or stale generation: discard pending chunks.
- Transport or render failure: retain the previous coherent graph.
- Resource exhaustion: report the failure; never retry in Sample mode.

## Persistence And Compatibility

The Time Series element and X interpretation live in the existing frontend
owned graph JSON. Existing graphs retain their generic Points/Line elements and
sampling settings. The normalizer supplies defaults only for a Time Series
element whose new optional fields are absent. No existing graph is migrated to
Time Series automatically.

## Acceptance Criteria

- A Full Time Series request above 8,000 observations remains Full.
- Counts and row-ID sets at 50k, 100k, and 300k exactly match the filtered
  source data per series.
- Native date/timestamp, explicit US text date, duplicate timestamp, numeric
  sequence, source-row ordering, and invalid-format cases are covered.
- Generic Graph Builder X behavior and the 8,000-point scatter policy remain
  unchanged.
- `break` and `connect` missing-value behavior is verified end to end.
- Saved and reopened graphs preserve the Time Series configuration exactly.
- The target Windows benchmark passes before manual acceptance and pull request.

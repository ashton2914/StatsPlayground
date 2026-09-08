# Correlation Matrix Heatmap Design

**Date:** 2026-08-26

**Status:** Approved

**Issue:** #44

## Goal

Add a correlation matrix heatmap to Graph Builder for comparing 2 to 20
continuous numeric columns. The chart supports Pearson, Spearman, and Kendall
correlation, uses pairwise deletion for missing or non-finite values, and
renders the complete symmetric matrix.

This is a correlation chart, not an extension of the existing two-dimensional
density heatmap. The two chart types have different inputs, statistics, axes,
tooltips, and aggregate packet contracts.

## User Experience

The user selects and drags between 2 and 20 continuous numeric columns onto an
axis using the existing multi-column interaction, then adds the Correlation
Matrix layer. The correlation layer is a 2D, exclusive chart layout: enabling
it removes or disables ordinary coordinate layers instead of attempting to
overlay points, lines, histograms, or density cells on the matrix.

The layer settings expose one method control:

- Pearson
- Spearman
- Kendall

Pearson is the default for newly created correlation layers. Changing the
method starts a new graph-data request and keeps the previous coherent matrix
visible until the replacement packet commits.

The matrix uses the selected columns in their current multi-column display
order on both axes. It renders all $p^2$ cells, including both symmetric halves
and the diagonal. Axis labels show column display names. Long labels may wrap
or truncate with their complete names available in the tooltip, but cells must
remain square and the chart must remain scrollable or otherwise usable at the
20-column limit.

Each defined cell displays its formatted coefficient. The diverging color
scale is fixed to $[-1, 1]$, with blue for positive correlation, red for
negative correlation, and a neutral light color at zero. Text color switches
for contrast against the cell fill. The tooltip shows:

- X column name
- Y column name
- selected method
- coefficient
- pairwise valid sample count $n$

Undefined cells have no numeric label and use a neutral unavailable style. The
tooltip explains why the value is unavailable and still reports $n$.

## Statistical Semantics

All methods use pairwise deletion. For a pair of columns $(X, Y)$, only rows
where both values are non-null, numeric, and finite participate. Consequently,
different cells may have different sample counts.

### Pearson

Pearson correlation is the sample product-moment correlation:

$$
r = \frac{\sum_i (x_i - \bar{x})(y_i - \bar{y})}
         {\sqrt{\sum_i (x_i - \bar{x})^2
                \sum_i (y_i - \bar{y})^2}}.
$$

The implementation uses a numerically stable online or centered algorithm,
not the unstable difference of raw sums.

### Spearman

Spearman correlation is Pearson correlation over pair-local ranks. Ties receive
their average rank. Ranking happens after pairwise deletion, so removing a row
for one variable pair cannot affect ranks for another pair.

### Kendall

Kendall uses $\tau_b$, including tie correction:

$$
\tau_b = \frac{n_c - n_d}
               {\sqrt{(n_0 - n_1)(n_0 - n_2)}}.
$$

Here $n_c$ and $n_d$ are concordant and discordant pair counts, $n_0$ is the
total number of observation pairs, and $n_1$ and $n_2$ are tied-pair counts for
each variable. The implementation must use an $O(n \log n)$ counting algorithm
or an equivalent bounded-complexity method; an $O(n^2)$ row-pair comparison is
not acceptable.

### Undefined Values

A coefficient is undefined when fewer than two pairwise valid observations
exist or when the method's denominator is zero, including constant columns.
Undefined is represented explicitly as an absent coefficient, never as zero,
`NaN`, or infinity.

For a column correlated with itself, the diagonal is 1 only when at least two
finite observations exist and the column is non-constant. Otherwise the
diagonal is undefined under the same rules as every other pair.

Calculated finite coefficients are clamped to $[-1, 1]$ only to remove tiny
floating-point overshoots after the statistic is computed.

## Approaches Considered

### Recommended: Dedicated Aggregate Packet and Statistics Module

Add a `correlationMatrix` graph element and aggregate packet. DuckDB applies the
existing validated filters and projects only the selected numeric columns. A
backend statistics module computes the three methods and returns only matrix
cells over IPC.

This preserves the unified graph pipeline, avoids transferring full columns to
JavaScript, gives Kendall a testable pure implementation, and keeps correlation
semantics separate from density binning.

### Extend the Existing Density Heatmap Packet

This would reuse an ECharts series name but conflate density bins with variable
pairs. It would require optional fields and branching throughout the existing
heatmap contract, weaken validation, and make tooltips and axes ambiguous. This
approach is rejected.

### Compute the Matrix in the Frontend

The typed frame already carries multi-column role vectors, so the browser could
compute correlations. This is rejected because Full Data mode could move and
retain large projected columns in JavaScript, Kendall would block the UI, and
the result would bypass the backend's exact-aggregate boundary.

## Data Contract

`ElementKind` gains `correlationMatrix`. The persisted chart element options
store `correlationMethod` as the closed enum `pearson | spearman | kendall`.
Older project files remain valid because they do not contain this element.

`GraphElementRequest` carries the selected correlation method when the element
kind is `correlationMatrix`. Rust validates the enum and rejects an unsupported
value with `AppError::InvalidParam`.

The request uses the existing ordered `multiX0`, `multiX1`, ... or `multiY0`,
`multiY1`, ... bindings. Exactly one multi-axis list must supply 2 to 20 unique
continuous numeric columns. The backend validates uniqueness, cardinality,
column existence, and numeric SQL types before running the query. Dynamic
identifiers are resolved against dataset metadata and quoted by the existing
identifier helper; filter values remain parameterized.

The backend emits one aggregate packet:

```text
CorrelationMatrixPacket
  kind: "correlationMatrix"
  method: "pearson" | "spearman" | "kendall"
  columns: string[]
  cells: CorrelationMatrixCell[]

CorrelationMatrixCell
  xIndex: number
  yIndex: number
  coefficient?: number
  sampleCount: number
  unavailableReason?: "insufficientData" | "zeroVariance"
```

The packet contains exactly $p^2$ cells in deterministic row-major order. It
includes mirrored cells explicitly so the renderer stays simple. Packet
validation checks the method, 2-to-20 unique columns, exact cell count, index
bounds and uniqueness, non-negative integer sample counts, finite coefficients
inside $[-1,1]$, and consistency between absent coefficients and unavailable
reasons.

The packet participates in the existing request ID, generation, ordering,
cancellation, and coherent-frame commit rules. A malformed or stale packet is
rejected without replacing the previous complete graph.

## Backend Architecture

The graph engine detects the `correlationMatrix` request separately from the
existing density `heatmap`. It uses the current graph query compiler for
dataset generation checks and filters, then projects the validated selected
columns once in display order.

Correlation algorithms live in a focused statistics module with pure functions
that accept pairwise finite values and return a coefficient plus sample count.
This module owns stable Pearson accumulation, average-rank Spearman, and
tie-corrected Kendall $\tau_b$. The DuckDB engine owns query planning and packet
assembly but not the statistical algorithms.

The implementation may retain selected numeric columns in backend memory while
building the matrix, but it must not create $O(p^2 n)$ retained copies. Pairwise
scratch buffers are reused and released between cells. Mirrored cells reuse the
same computed result, so only $p(p+1)/2$ correlations are calculated.

Cancellation is checked while reading rows and between variable pairs. Kendall
must not use quadratic pair enumeration. The 20-column limit is enforced before
query execution.

## Frontend Architecture

Graph Builder adds Correlation Matrix to the 2D layer picker and localization
tables. The layer card presents the method selector. Entering this mode requires
an active multi-column axis and suppresses controls that do not apply to a
matrix, including ordinary X/Y axis settings, pan/select modes, reference lines,
overlay grouping, facets, and raw-point picking.

The graph-data pipeline derives the correlation method into the request and
retains the selected multi-column order. It does not melt correlation inputs
into `__sp_variable__` / `__sp_value__`; matrix requests consume the original
role vectors directly.

`transform.ts` recognizes a valid `CorrelationMatrixPacket` before the ordinary
Cartesian layer path and emits a dedicated ECharts heatmap option with category
axes, fixed visual range, cell labels, and a semantic tooltip. Because this is
a standard ECharts heatmap series, it does not use a custom `renderItem`.

Empty or undefined-only matrices still render their axis labels and unavailable
cells. Before the first valid packet arrives, the existing loading/error overlay
and previous-coherent-frame behavior apply.

## Error Handling

- Fewer than 2 or more than 20 selected columns is rejected in the UI and
  independently rejected by Rust.
- Duplicate, missing, or non-numeric columns produce `AppError::InvalidParam`.
- Unsupported methods produce `AppError::InvalidParam`.
- Query failures map to `AppError::Database`.
- Cancellation does not commit a partial matrix and is not displayed as an
  error.
- Individual undefined coefficients are valid packet data, not request errors.
- Absolute paths, SQL text, and backend implementation details do not cross the
  IPC boundary.

## Testing

### Rust Statistics Tests

- Pearson perfect positive, perfect negative, uncorrelated, constant, and
  large-offset numeric-stability cases.
- Spearman monotonic nonlinear data, reverse order, average ranks, and pairwise
  missing-value rank locality.
- Kendall $\tau_b$ positive, negative, tied-X, tied-Y, tied-both, constant, and
  hand-calculated examples.
- Every method covers insufficient data, non-finite exclusion, symmetry,
  diagonal semantics, and coefficient bounds.

### Backend Integration Tests

- Filters are applied before pairwise deletion.
- Selected column order is preserved.
- A 2-to-20-column request emits exactly $p^2$ deterministic cells.
- Invalid method, duplicate columns, non-numeric columns, and 1/21-column
  requests fail before statistical execution.
- Aggregate stream ordering, cancellation, generation fencing, and packet
  serialization remain valid.

### Frontend Tests

- Request derivation includes the element kind, method, and ordered multi-axis
  bindings without melt fields.
- Strict packet validation rejects malformed methods, cells, indices, sample
  counts, and coefficients.
- Transform output uses category axes in selected-column order, a fixed
  $[-1,1]$ visual scale, complete matrix cells, labels, and tooltip metadata.
- Undefined cells remain distinct from zero correlation.
- Project normalization preserves the selected method and defaults a missing
  method to Pearson.
- The layer picker enforces exclusive layout and the 2-to-20-column rule.

## Validation

The change is complete when:

1. Focused frontend and Rust correlation tests pass.
2. The complete TypeScript test suite passes.
3. `npx vite build` succeeds.
4. `cargo build`, `cargo clippy`, and `cargo test` succeed in `src-tauri`.
5. A Tauri development run verifies all three methods, missing values,
   constants, method switching, filters, long labels, and the 20-column limit.
6. The original two-dimensional density heatmap and existing multi-column
   charts retain their current behavior.

## Delivery

Implementation remains on `feat/issue-44-correlation-matrix`. Completed,
verified steps use Conventional Commits. The branch is not pushed unless
explicitly requested.
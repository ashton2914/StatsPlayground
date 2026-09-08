# Fit Y by X Analysis Results Design

**Date:** 2026-08-31

**Status:** Approved

**Issue:** #71

**Builds on:** `2026-08-30-issue-71-fit-y-by-x-design.md`

## Context

The first Fit Y by X release established persistent analysis documents and a
reusable embedded Graph Builder runtime. It intentionally limited X to a
categorical factor and excluded inferential statistics, so the resulting view
contains only points and a box plot.

Issue #71 also includes JMP reference images showing the broader Fit Y by X
workflow and a Bivariate Fit report. This phase closes that gap. It adds the two
primary personalities for a continuous response:

- continuous Y with categorical X: Oneway analysis;
- continuous Y with continuous X: Bivariate linear fit.

This document supersedes the earlier design's non-goals for continuous X,
ANOVA, and inferential results. The existing document, persistence, and shared
Graph Builder architecture remain in place.

## Goals

1. Select the analysis personality automatically from the modeling type of X.
2. Continue rendering all analysis graphs through the shared Graph Builder
   runtime.
3. Add authoritative full-data statistical results computed by the Rust
   backend, independent of graph rendering or sampling.
4. Present compact, JMP-inspired reports without attempting a pixel-for-pixel
   clone.
5. Preserve existing Fit Y by X project documents and folder assignments.

## User Experience

The role dialog keeps the familiar `Y, Response` and `X, Factor` labels. Y
accepts one numeric column modeled as continuous. X accepts one distinct
column modeled as continuous, nominal, or ordinal.

The dialog displays the personality that will be created:

- nominal or ordinal X: `Oneway`;
- continuous X: `Bivariate`.

Creating the analysis adds the same `Fit Y by X N` document used by the first
release. The result view is a vertically scrollable report:

1. analysis name, source table, Y, X, and personality;
2. a bounded-height embedded Graph Builder graph;
3. collapsible result sections rendered as compact statistical tables.

The graph must leave the first result-section heading visible below it at
common desktop heights. Result sections use disclosure bars rather than nested
cards. Loading and errors for the graph and statistical report are independent.

### Oneway View

The graph uses categorical X, continuous Y, Points, and Box Plot. The report
contains:

- group summary statistics;
- Analysis of Variance;
- effect size.

### Bivariate View

The graph uses continuous X, continuous Y, Points, and a degree-one `fitline`
element with its confidence band enabled. The report contains:

- fitted equation;
- Summary of Fit;
- Lack of Fit when it is identifiable;
- Analysis of Variance;
- Parameter Estimates.

## Architecture

Fit Y by X retains two separate output paths with one analysis owner:

```text
FitYByXItem
  |-- EmbeddedGraphConfig -> GraphRuntime -> graph-data protocol -> ECharts
  `-- FitYByXRequest      -> FitYByXService -> DuckDB + statistics -> report UI
```

Graph Builder remains responsible for visualization, interactions, filtering,
and display sampling. A new Fit Y by X statistics service owns inferential
calculations. Statistical results must never be derived from rendered points or
from Graph Builder's potentially sampled payload.

The backend addition follows the standard Tauri boundary:

- Rust request/result models in `src-tauri/src/models/fit_y_by_x.rs`;
- `FitYByXService` in `src-tauri/src/services/fit_y_by_x_service.rs`;
- a thin command in `src-tauri/src/commands/fit_y_by_x_commands.rs`;
- command registration in `src-tauri/src/lib.rs`;
- mirrored TypeScript types in `src/types/fitYByX.ts`;
- an `invoke<T>()` wrapper in `src/services/fitYByXService.ts`.

The service reads only the requested Y and X columns. Dataset identity and
column existence/type are validated before query execution. Values use prepared
parameters where applicable; identifiers use the repository's validated
identifier quoting path and are never concatenated from unchecked input.

## Analysis Document Contract

The document records a personality so behavior is explicit after load:

```ts
type FitYByXPersonality = "oneway" | "bivariate";

interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  personality: FitYByXPersonality;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}
```

`personality` is derived from X during creation and revalidated during project
load. Existing documents without it infer `oneway` from their categorical X.
A mismatched persisted personality is replaced by the type-derived value.

The default graph factory is personality-aware:

- Oneway: Points and Box Plot;
- Bivariate: Points and degree-one polynomial Fit Line with confidence band;
- both: X is `factor`, Y is `response`, full sampling, and empty filters.

Valid persisted presentation customizations remain preserved when their X/Y
bindings and personality are valid. Invalid graph payloads fall back to the
personality's current default graph.

## IPC Contract

The request is deliberately small and recomputable:

```ts
interface FitYByXRequest {
  datasetId: string;
  generation: number;
  responseColumn: string;
  factorColumn: string;
  personality: FitYByXPersonality;
  confidenceLevel: 0.95;
}
```

The response is a discriminated union:

```ts
type FitYByXResult = OnewayResult | BivariateResult | NotComputableResult;
```

Every successful result includes `usedRows`, `excludedRows`, and the effective
confidence level. Numeric fields are raw finite numbers or `null` when a
particular statistic is mathematically undefined. Display formatting belongs
to the frontend.

`NotComputableResult` contains the requested personality and a stable reason
code, not a localized sentence. Expected reasons include insufficient valid
rows, insufficient groups, constant X, no residual degrees of freedom, and no
within-group degrees of freedom.

## Statistical Definitions

Rows with null, non-numeric, NaN, or infinite Y/X values are excluded pairwise.
All calculations use the remaining full data. Tests are two-sided and the
default confidence level is 95%.

### Oneway

Each group returns its label, count, mean, sample standard deviation, standard
error, and t-based confidence interval for the mean.

The ANOVA table returns Between, Within, and Total rows with degrees of freedom,
sum of squares, mean square where defined, the F statistic, and its upper-tail
p-value. The effect-size section returns:

- eta squared, equal to between-group SS divided by total SS;
- omega squared, using the standard one-way fixed-effect estimator and bounded
  to zero when the sample estimate is negative.

At least two non-empty groups and positive within-group degrees of freedom are
required for the F test. Group summaries remain available when inferential
fields are undefined.

### Bivariate

The model is ordinary least squares:

$$
Y_i = \beta_0 + \beta_1 X_i + \epsilon_i.
$$

Summary of Fit returns $R^2$, adjusted $R^2$, root mean squared error, mean of
Y, and observation count. The ANOVA table returns Model, Error, and Total rows
with degrees of freedom, sum of squares, mean square, F, and p-value.

Parameter Estimates contains intercept and slope rows with estimate, standard
error, t ratio, two-sided p-value, and t-based confidence limits. At least three
valid rows, non-constant X, and positive residual degrees of freedom are
required for inference.

Lack of Fit is calculated only when X has replicated values and pure-error and
lack-of-fit degrees of freedom are both positive. It returns Lack of Fit, Pure
Error, and Total Error rows plus F and p-value. Otherwise the section reports a
stable `notIdentifiable` state rather than fabricating zeros.

Tail probabilities and confidence quantiles use a maintained Rust statistics
library rather than hand-written distribution approximations. Core sums of
squares and coefficient calculations remain explicit and independently tested.

## Frontend State And Loading

`FitYByXView` materializes the graph item and starts the statistics request from
the same persisted analysis definition. Report state is local to the view or a
focused hook; computed results are not persisted in Zustand or the project
archive.

Each request captures the analysis ID, dataset ID, dataset generation, and a
local request generation. The backend verifies the requested generation after
acquiring the database lock and before reading rows. A response is applied only
if all captured values still match. Switching documents, changing the source
data, or unmounting the view invalidates stale responses.

The report has explicit loading, success, not-computable, and error states. An
IPC failure does not remove or cover the graph. A graph-data failure does not
discard a successful statistical report.

## Error Handling

- Missing datasets or columns use the existing unavailable-document state.
- Invalid role combinations cannot create a document.
- Invalid persisted role combinations are isolated per document during load.
- Expected mathematical degeneracy returns `NotComputableResult` or nullable
  section fields, not `AppError`.
- Invalid parameters, unknown columns, and personality/type mismatches return
  `AppError::InvalidParam`.
- Database failures return `AppError::Database`; no backend code uses
  `unwrap()` or `expect()` outside tests.
- All user-facing reason text is localized from stable result/error codes.

## Testing

Implementation follows red-green-refactor at each boundary.

### Rust Numerical Tests

Deterministic fixtures verify:

- Oneway group summaries, ANOVA decomposition, F/p-value, eta squared, and
  omega squared;
- Bivariate coefficients, fit summary, ANOVA decomposition, parameter tests,
  confidence intervals, and fitted equation inputs;
- Lack of Fit with replicated X and the not-identifiable path without repeats;
- pairwise missing-value exclusion and used/excluded counts;
- constant X, too few rows, too few groups, and zero residual degrees of
  freedom;
- camelCase serialization and discriminant strings.

Reference values use a trusted independent package and fixed tolerances. Tests
also assert identities such as total SS = model SS + error SS.

### Frontend Contract Tests

Tests verify:

- role validation accepts categorical and continuous X but rejects duplicate
  roles and non-continuous Y;
- personality derivation and personality-specific default graph elements;
- old documents infer Oneway and malformed graphs fall back correctly;
- request/result TypeScript shapes mirror Rust serialization;
- stale report responses cannot replace the active analysis;
- Oneway and Bivariate sections render the expected values and
  not-computable/error states without affecting GraphRuntime;
- report headings remain reachable in a bounded, scrollable layout.

### End-to-End Validation

- Run focused frontend contract tests, `npx tsc -b`, and `npx vite build`.
- Run `cargo test` and `cargo clippy -- -D warnings` in `src-tauri`.
- In Tauri, manually create one categorical-X and one continuous-X analysis,
  compare their graphs and report sections with trusted fixture values, switch
  rapidly between documents, and verify save/reopen behavior.

## Non-Goals

- Categorical Y personalities, including logistic and contingency analyses.
- Polynomial model selection beyond the default degree-one Bivariate fit.
- Multiple regression or more than one X column.
- Residual and diagnostic plots.
- Multiple-comparison procedures and post-hoc tests.
- Interactive JMP-style analysis menus or arbitrary model options.
- Persisting computed statistical results.
- Pixel-for-pixel reproduction of JMP visual styling.
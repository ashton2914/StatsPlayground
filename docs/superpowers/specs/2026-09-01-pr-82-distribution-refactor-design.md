# PR #82 Distribution Framework Refactor Design

**Date:** 2026-09-01

**Status:** Approved

**Source PR:** #82, `feat/distribution-analysis`

**Target branch:** `feat/distribution-analysis`

## Context

PR #82 implements a Distribution analysis workflow on commit
`d6130abcf38e7ac58fed8839fd50f162e96a8bed`. Its merge base with the current
`dev` branch is `4710df828996fa0d46493edcabaa993dc158af33`, before the current
Fit Y by X analysis framework and project format v4 were added.

The PR contains valuable, fixture-backed statistical implementations for
continuous descriptive statistics, normal process capability, parametric
distribution fitting, and visual diagnostics. It also contains an older
analysis lifecycle, event stream, custom workspace, and inline project
persistence model. Those framework pieces must not be merged into current
`dev`.

This refactor preserves Distribution as a distinct analysis family while
rebuilding its application integration in parallel with the current Fit Y by
X framework.

## Goals

1. Preserve the verified Rust statistical algorithms and deterministic
   fixtures from PR #82.
2. Make Distribution a persistent top-level analysis document alongside Fit Y
   by X and Tabulate.
3. Reuse the current analysis-document lifecycle, async report state, workspace
   integration, and project format v4 conventions.
4. Keep all statistical calculations and chart-coordinate derivation in Rust.
5. Remove the old branch's event-stream, snapshot, and duplicate workspace
   framework.

## Approved Scope

### Roles

The creation dialog accepts:

- one or more continuous numeric response columns;
- zero or one numeric Weight column;
- zero or one non-negative integer-compatible Freq column;
- zero or more categorical By columns.

The dialog uses pure role-assignment state. Invalid assignments do not mutate
an existing valid role and cannot create a document.

### Continuous Descriptive Statistics

The numerical core retains:

- weighted Hyndman-Fan Type-6 quantiles at the approved probability grid;
- weighted count, missing count, mean, sample standard deviation, standard
  error, Student-t mean confidence interval, minimum, maximum, median, modes,
  range, IQR, and MAD;
- Freedman-Diaconis histograms with the approved Scott, Sturges, and constant
  data fallbacks;
- weighted Tukey box plots and outlier identification;
- weighted ECDF coordinates;
- normal quantile scores.

### Normal Process Capability

The numerical core retains:

- table-level LSL, Target, and USL defaults with analysis-level overrides;
- moving-range within sigma and overall sigma;
- stability index;
- within and overall capability indices and their approved confidence limits;
- observed and expected nonconformance percentages and PPM;
- specification-limit and Normal-density coordinates.

Analysis-level specification overrides never write back to table column
metadata.

### Continuous Distribution Fits

The numerical core retains MLE fitting for Normal, Lognormal, Exponential with
zero location, Gamma, and Weibull distributions. Fit All ranks valid candidates
using the approved AICc, AIC, and BIC rules and returns backend-generated PDF
coordinates.

## Architecture

Distribution remains a separate module. It does not become a Fit Y by X
personality and its types are not renamed to Fit Y by X types.

The framework follows the same ownership boundaries as Fit Y by X:

```text
DistributionItem
  |-- EmbeddedGraphConfig[] -> createEmbeddedGraphItem -> GraphRuntime
  `-- DistributionRequest  -> service -> DuckDB materialization -> Rust kernels
                                               `-> report + GraphDataFrame payloads
```

The persisted item owns the analysis definition. Computed results remain
transient and are recomputed from the source dataset.

### Rust Boundaries

The following PR #82 modules are calculation authority and should be migrated
with only compatibility changes required by current models and dependencies:

- `distribution_kernel.rs`: descriptive statistics, histogram, box plot, ECDF,
  and normal quantile calculations;
- `distribution_fit.rs`: parametric MLE and model ranking;
- `normal_capability.rs`: specification resolution and capability calculations.

Their public behavior is frozen by unit tests and JSON fixtures before any
application integration is changed.

DuckDB materialization is adapted to the current engine conventions. It owns
stable column resolution, validated identifier quoting, pairwise role
filtering, weight/frequency validation, By grouping, and excluded-row
accounting. It does not contain statistical formulas.

`DistributionService` is the orchestration boundary. It validates the request,
checks dataset generation after acquiring the database lock, materializes the
required columns, invokes the pure kernels, and assembles the response. The
Tauri command remains a thin delegate returning `Result<T, AppError>`.

### Request Execution

V1 uses one asynchronous Tauri request per report generation. It does not
migrate PR #82's progress events, run IDs, cancel-token registry, snapshot IDs,
or four-key lifecycle state.

The frontend report controller captures the Distribution item ID, source
dataset ID, dataset generation, configuration fingerprint, and a local request
token. A response is applied only while all captured values still match.
Unmounting, switching documents, editing the configuration, or changing source
data invalidates an in-flight result.

Expected mathematical degeneracy is represented by stable result status and
reason codes. Invalid parameters use `AppError::InvalidParam`; database errors
use `AppError::Database`; statistical execution errors use `AppError::Stats`.

### Frontend Boundaries

`DistributionItem` is an independent persisted type containing stable ID,
name, source dataset ID, role bindings, analysis configuration, presentation
configuration, and creation time.

`useDistributionStore` owns normalized documents, naming counters, create,
update, rename, delete, source-table cascade deletion, reset, and project load.
Mutations use the existing project mutability guard. Transient results and
request state are not stored in the project store.

The role dialog emits a complete validated definition to `Workspace`; it does
not write directly to the store. A focused `useDistributionReport` controller
owns idle, loading, success, not-computable, and error states and implements
stale-response fencing.

### Charts

Every Distribution chart renders through the same embedded Graph Builder path
as Fit Y by X:

```text
EmbeddedGraphConfig
  -> createEmbeddedGraphItem
  -> GraphRuntime
  -> graphCore transform
  -> ECharts
```

`GraphRuntimeProps` gains an optional external data-state contract containing a
precomputed `GraphDataFrame`, loading state, and error state. When supplied,
the runtime does not issue its normal graph-data request. It still derives the
`GraphSpec` from the embedded `GraphBuilderItem` and continues to own viewport
sizing, themes, axis settings, drag range changes, context menus, and rendering.
The graph-data hook remains unconditionally mounted with execution disabled so
React hook ordering does not depend on the data source.

The Distribution service returns report blocks and one or more precomputed
graph frames atomically. Existing histogram and box-plot aggregate packets are
reused. The generic graph-data contract gains element-keyed precomputed point
and curve packets. A curve packet records coordinates and whether the line is
ordinary or stepped; it does not contain distribution names or fitting
parameters. These packets support fitted PDFs, ECDF steps, Q-Q points, and
reference lines without adding frontend statistical calculations.

Specification limits use the existing reference-line behavior. React and
graphCore must not re-bin, refit, calculate quantiles, derive capability
indices, or otherwise change backend coordinates.

Distribution stores Weight, Freq, and By roles only in its own persisted
definition. They are inputs to the Distribution request and are not added to
Graph Builder's interactive encoding slots.

The view materializes separate embedded graph items for the overview
histogram/density, box plot, ECDF, and normal quantile plot. Histogram and box
plot runtimes share a controlled continuous-axis range so zooming or editing
one keeps them aligned. Multiple runtimes avoid adding a Distribution-specific
multi-grid layout to the generic `GraphSpec`.

The PR #82 `DistributionChart` standalone renderer is removed. Its
`distributionAdapter` may retain pure conversion helpers for constructing
generic aggregate packets, but it must not build or render a complete ECharts
option outside graphCore.

The Distribution view uses the Fit Y by X layout conventions: one outer
scroller, bounded graph height, independent graph and report loading/error
states, and disclosure sections with compact statistical tables. It does not
reuse PR #82's card-heavy standalone workspace.

## Project And Workspace Integration

Distribution participates in the current document lifecycle:

- Analysis menu creation from an active source table;
- mutually exclusive active document selection;
- project tree rendering, rename, delete, and drag-to-folder;
- read-only mutation protection;
- source-table cascade deletion;
- history entries for create, rename, update, and delete;
- current filename collision handling and immutable extension display;
- save, close, reopen, and migration behavior.

Project format v4 stores Distribution documents as manifest references and
separate archive members, not inline manifest payloads. The implementation
registers an immutable `.spdist` document extension and a dedicated archive
directory. Manifest entries are authoritative.

V4 validation enforces:

- unique stable Distribution IDs;
- exact ID parity between manifest entry and document body;
- case-sensitive name parity between manifest name, member basename, and body
  name;
- failure on missing referenced members;
- deterministic exclusion of unreferenced members.

Legacy Distribution payloads from PR #82 are not a released project format and
do not require production migration support. Existing non-Distribution project
formats retain their current compatibility behavior.

## Preserved And Replaced Code

### Preserve

- pure descriptive, fit, and capability kernels;
- approved statistical method definitions and parameter conventions;
- deterministic seeds and golden fixtures;
- backend-precomputed chart coordinates;
- localized JMP-aligned report terminology where it remains in approved scope.

### Replace

- inline manifest persistence;
- snapshot and schema-fingerprint persistence used for computed results;
- progress event and cancellation control plane;
- feature-local run-state Zustand machinery;
- custom directory item and standalone workspace ownership;
- duplicate filter AST when the current table-filter contract is sufficient;
- frontend statistical or chart-coordinate calculations;
- legacy naming, folder, and history plumbing.

## Testing

Implementation follows red-green-refactor at each boundary.

### Numerical Characterization

Before moving a kernel, focused Rust tests run the PR fixtures against the PR
implementation. The same fixtures then run against the migrated modules. Tests
cover weighted and unweighted descriptive output, edge-case histogram rules,
capability calculations, all supported fits, fit ranking, invalid weights and
frequencies, missing values, and deterministic coordinates.

### Backend Contract

Tests verify request/result camelCase serialization, stable status codes,
generation rejection, role validation, full-data materialization, By ordering,
and command registration. Formula identities and fixture tolerances remain
separate from IPC orchestration tests.

### Frontend Contract

Tests verify role assignment, config creation and normalization, store
lifecycle, stale response rejection, report sections, backend-coordinate-only
graph frames, and independent graph/report failures. Runtime tests verify that
an external frame disables graph-data fetching while preserving graphCore
rendering and axis callbacks. Transform tests verify histogram, box-plot,
precomputed point, ordinary curve, and stepped curve packets.

### Project And Workspace

Tests verify v4 separate-member round trips, strict manifest/body/member parity,
duplicate ID rejection, immutable `.spdist` naming, folder assignment, history,
read-only guards, active selection, source cascade deletion, and save/reopen.

### Completion Validation

The change is complete when focused Distribution tests pass, existing Fit Y by
X and project lifecycle tests remain green, `npx vite build` succeeds, and
`cargo test` plus `cargo clippy -- -D warnings` succeed in `src-tauri`.

## Non-Goals

- Discrete distributions.
- Non-Normal process capability.
- Letter-Value Quantile Plot or Stem-and-Leaf output.
- Hypothesis tests, tolerance intervals, prediction intervals, or
  goodness-of-fit tests outside the approved fit-ranking measures.
- Frontend statistical calculations or chart-coordinate derivation.
- User-authored SQL or JSL.
- Persisted computed results.
- Distribution as a Fit Y by X personality.
- Reintroducing PR #82's progress/cancellation system in V1.
- A standalone Distribution ECharts renderer outside GraphRuntime.
- Adding Weight or Freq to Graph Builder's interactive role palette.
- A generic multi-grid GraphSpec extension.
- A generic analysis SDK or registry refactor before Distribution is working.
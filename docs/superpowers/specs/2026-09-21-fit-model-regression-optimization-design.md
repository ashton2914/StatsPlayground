# Fit Model Regression Optimization Design

## Goal

Refine the existing Fit Model regression report on
`feat/fit-model-regression-interactions` so its parameterization, effect tests,
chart layout, effect construction, and prediction-profiler interaction match
the supplied JMP references while preserving StatsPlayground's Analysis
architecture and Rust statistical authority.

## Scope

This change covers:

- moving Leverage Plot above Actual by Predicted and matching their frame size;
- adding automatic chart-axis breathing room and unclipped labels;
- changing the Effect Summary significance marker to a red
  `LogWorth = 1.3` line;
- adding one interaction term composed from two or more predictors;
- reporting JMP-style mean-centered parameter estimates;
- calculating effect tests for the centered parameterization;
- simplifying the Parameter Estimates columns;
- adding linked in-chart click and drag interaction to Prediction Profiler;
- focused statistical, contract, component, and visual verification.

The OLS fit, fitted values, residuals, model-wide ANOVA, saved diagnostic
columns, and persisted analysis definition remain compatible.

## Statistical Design

### Fitted Basis and Reporting Basis

Rust keeps the current full-rank OLS design matrix and fitted coefficient basis
as the computational basis for prediction, diagnostics, leverage plots, saved
columns, and model-wide fit statistics.

For reporting, Rust constructs a linear transformation from the fitted basis to
a JMP-style basis in which every continuous predictor participating in an
interaction is centered at its complete-case sample mean. The transformation
must support two-way and higher-order interaction products. It transforms both:

- the coefficient vector; and
- the coefficient covariance matrix.

This is a reparameterization of the same column space. It must not change fitted
values, residuals, SSE, model degrees of freedom, prediction intervals, or
diagnostic values.

Term labels expose the reporting basis, for example:
`(GR80P-0.37388)*(BK11P-0.39633)`.

The reporting transformation is always applied when interaction terms exist,
independent of the persisted `centeringMethod`. The persisted setting continues
to describe the model construction basis and remains backward compatible.

### Parameter Estimates

Parameter Estimates reports the transformed coefficient and covariance values.
The visible columns are:

- Term;
- Estimate;
- Std Error;
- t Ratio;
- Feature VIF.

The p-Value, Lower 95%, and Upper 95% columns are removed from the report.
Existing result fields may remain in the transport contract when required for
backward compatibility, but the report does not render them.

### Effect Tests

Effect Tests uses general linear hypotheses in the JMP reporting basis rather
than reduced-model deletion of an uncentered raw design column. For each effect,
Rust computes the hypothesis sum of squares from the transformed coefficient,
its covariance geometry, and the full-model error mean square.

For one-degree-of-freedom continuous effects, the result is equivalent to the
squared centered t test. The implementation remains grouped by effect identity
so multi-parameter effects retain a valid contract.

Interaction tests remain invariant under the transformation. Main-effect tests
change to represent the effect at the means of the interacting predictors,
which explains and corrects the current mismatch with JMP.

Rank-deficient or otherwise non-estimable hypotheses return nullable statistics
with the existing explicit inference reason. They are never reported as zero.

## Report and Chart Design

The relevant report order becomes:

1. Model Specification
2. Leverage Plot
3. Actual by Predicted
4. Effect Summary
5. Lack of Fit
6. Residual by Predicted
7. Summary of Fit
8. Analysis of Variance
9. Parameter Estimates
10. Effect Tests
11. Row Diagnostics
12. Prediction Profiler
13. Warnings

Leverage Plot and Actual by Predicted use the same responsive frame width and
chart height.

### Automatic Numeric Axes

Actual by Predicted and Residual by Predicted no longer bind the prediction axis
directly to the observed minimum and maximum. A shared numeric-axis helper:

1. validates finite values;
2. handles constant ranges;
3. adds approximately ten percent display padding;
4. chooses a stable nice step;
5. expands the limits to enclosing nice ticks.

Actual by Predicted applies the same policy independently to its actual-value
axis. Residual by Predicted includes zero and uses symmetric, nice Y limits so
the chart is visually balanced. Axis-label formatters remove floating-point
artifacts such as long endpoint decimals.

Chart grids reserve explicit left, right, and bottom space, use `containLabel`,
and set axis-name gaps so titles and tick labels remain visible at desktop and
narrow widths.

### Effect Summary

The significance reference is fixed at `-log10(0.05) = 1.30103`. It renders as
a red solid vertical line labeled `LogWorth = 1.3`. The chart uses the same
unclipped grid and axis-label policy as the diagnostic plots.

## Add Effect Interaction

Effect Summary's Add Effect flow allows selection of two or more distinct
predictors, up to all predictors currently in the model. Confirming creates one
interaction term such as `X1*X2*X3`.

The flow:

- requires at least two predictors;
- canonicalizes predictor order for stable identity and duplicate detection;
- guarantees each selected predictor has a main effect;
- does not automatically add lower-order interaction combinations;
- rejects duplicate terms explicitly;
- enforces the existing 256-term budget before applying the definition;
- applies the change through the existing revisioned Analysis editor path.

## Prediction Profiler

Each profiler card contains:

- the linked response curve and confidence band;
- a red vertical current-value reference;
- a current prediction marker;
- a numeric value input below the chart.

The existing top slider is removed. Users can update a predictor by:

- entering a finite number in the value field;
- clicking in the chart; or
- dragging the vertical reference line.

The chart converts pixel coordinates through the ECharts coordinate system,
clamps the value to the predictor's training range, and updates one shared
predictor-value state. Every accepted update recomputes:

- all profiler scan curves;
- all confidence bands;
- all current-value references and markers;
- all numeric fields;
- the predicted response;
- the mean confidence interval; and
- the prediction interval.

Pointer interaction is registered and disposed with the chart lifecycle.
Invalid numeric input does not mutate shared values and remains visibly
correctable rather than being silently converted to another value.

## Components and Data Flow

1. The existing Analysis executor sends the revisioned Fit Model request.
2. Rust fits the current model basis and computes diagnostics.
3. Rust transforms coefficients and covariance into the reporting basis.
4. Rust calculates centered general-linear-hypothesis effect tests.
5. The existing stale-result fencing accepts or rejects the response.
6. The report renders the revised section order, tables, and chart options.
7. Add Effect applies a validated definition revision and triggers a refit.
8. Profiler interactions update local presentation state against the immutable
   fitted snapshot.

No frontend statistical fallback is introduced.

## Error Handling

- Non-finite transformation inputs return the repository-standard statistical
  error rather than a partial success response.
- Singular reporting hypotheses use explicit non-estimable result reasons.
- Add Effect validation reports insufficient selection, duplicates, hierarchy
  failures, and term-budget failures through the existing Analysis UI.
- Profiler pointer conversion ignores events outside the plotting coordinate
  system and rejects non-finite values.
- Chart extent calculation throws on non-finite source values instead of
  returning success-shaped defaults.

## Verification

### Rust

- Add a trusted fixture matching the supplied JMP example and assert centered
  intercept, main effects, interaction coefficients, standard errors, t ratios,
  effect sums of squares, F ratios, and p-values within documented tolerances.
- Cover two-way and three-way interaction transformations.
- Verify fitted values, SSE, residuals, and predictions are invariant.
- Cover rank-deficient and non-estimable hypotheses.

### Frontend

- Test padded nice domains, constant ranges, residual symmetry, and formatted
  endpoint labels.
- Test the red `LogWorth = 1.3` reference.
- Test Leverage Plot ordering and size parity with Actual by Predicted.
- Test Parameter Estimates column removal.
- Test two-or-more-factor Add Effect validation, canonicalization, duplicate
  handling, hierarchy, and term budget.
- Test profiler numeric input, chart click, and drag updates across every card
  and prediction summary.

### Gates

Run the focused Fit Model suites, required Analysis gates, Vite production
build, Rust formatting, Clippy, and Rust tests. Perform desktop and narrow-width
visual acceptance in the shared StatsPlayground browser surface, checking chart
label visibility, frame sizing, report order, and profiler interaction.

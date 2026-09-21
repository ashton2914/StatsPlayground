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
as the computational basis for prediction, saved diagnostic columns, and
model-wide fit statistics. Effect leverage coordinates are derived from the
same reporting-basis linear hypothesis used by the corresponding Effect Test.

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

The reporting transformation is applied when the interaction term set is
strongly hierarchical: every lower-order interaction implied by a higher-order
term is present. It is independent of the persisted `centeringMethod`. The
persisted setting continues to describe the model construction basis and
remains backward compatible.

With `centeringMethod = mean`, the fitted matrix already centers interaction
factors while keeping main effects raw. Reporting shifts those main effects and
the intercept only; it does not expand the already-centered interactions again.
Hierarchy detection checks each interaction's immediate predecessors rather
than allocating its power set, keeping incomplete high-order models bounded.

If a manually added higher-order interaction omits any implied lower-order
interaction, the whole model remains in its uncentered fitted basis for
Parameter Estimates and retains the existing reduced-model Effect Tests. The
report must not label that model as centered or silently change its fitted
values. This explicit fallback is necessary because a centered higher-order
product introduces lower-order columns that are absent from the fitted column
space.

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

For a strongly hierarchical model, Effect Tests uses general linear hypotheses
in the JMP reporting basis rather than reduced-model deletion of an uncentered
raw design column. For each effect, Rust computes the hypothesis sum of squares
from the transformed coefficient, its covariance geometry, and the full-model
error mean square.

For one-degree-of-freedom continuous effects, the result is equivalent to the
squared centered t test. The implementation remains grouped by effect identity
so multi-parameter effects retain a valid contract.

Interaction tests remain invariant under the transformation. Main-effect tests
change to represent the effect at the means of the interacting predictors,
which explains and corrects the current mismatch with JMP.

For a non-hierarchical higher-order model, Effect Tests retains the existing
reduced-model calculation in the uncentered fitted basis.

Rank-deficient or otherwise non-estimable hypotheses return nullable statistics
with the existing explicit inference reason. They are never reported as zero.

### JMP General-Hypothesis Leverage Plots

Effect leverage plots use the same hypothesis as the visible Effect Test. Rust
derives a reporting-basis design matrix from the coefficient transformation so
that fitted values remain unchanged while effect constraints are expressed in
the JMP reporting basis.

For each effect, Rust computes the unconstrained residual and the residual from
the model constrained by that effect hypothesis. Their difference is the
horizontal leverage contribution. The vertical coordinate is that contribution
plus the unconstrained residual, translated by the response mean. This ensures:

- distance to the sloped line equals the full-model residual;
- distance to the horizontal null line equals the constrained-model residual;
- the difference between those residual sums of squares equals the Effect Test
  hypothesis sum of squares; and
- the p-value, points, fitted line, and confidence curves describe one
  consistent hypothesis.

A continuous one-degree-of-freedom main effect uses the original predictor
units on the horizontal axis. Its translated leverage values are centered on
the predictor sample mean, and the fitted-line slope equals the centered
reporting coefficient. This matches JMP when a main effect participates in an
interaction and avoids plotting the unrelated coefficient evaluated at zero.

Nominal, ordinal, interaction, multi-column, and other complex effects use
response-unit horizontal scaling. Their fitted line has slope one, matching
JMP's general linear-hypothesis leverage construction.

Confidence curves use the model error mean square, error degrees of freedom,
effect hypothesis degrees of freedom, and configured confidence level. Their
construction preserves JMP's visual significance property: the curves cross
the horizontal null line exactly when the corresponding hypothesis exceeds the
critical F threshold.

For a non-hierarchical higher-order model, the report already falls back to its
raw fitted basis. Its leverage plot uses the same raw-basis Effect Test and
general-hypothesis construction. Rank-deficient or non-estimable hypotheses
return the existing explicit inference reason and no misleading plot.

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

All top-level report sections use the same responsive frame width while their
heights remain content-driven. Leverage Plot and Actual by Predicted also use
the same chart height.

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

Leverage Plot applies the same padded nice-extent policy independently to both
axes, using its adjusted points, fitted line, confidence band, and null line.
Explicit bounds prevent the ECharts value-axis default from forcing zero into
the window and compressing a narrow effect range.

Actual by Predicted is the Whole Model leverage plot. Rust constructs its
95-percent confidence curves from the hypothesis that all non-intercept model
effects are zero, using the full model error mean square, error degrees of
freedom, model hypothesis degrees of freedom, and configured confidence level.
The result is a smooth translucent red confidence region around the solid red
`y=x` line. It is not produced by connecting row-specific multivariate
prediction intervals, because those intervals can differ for rows with the
same fitted value and do not define a single confidence curve over the
predicted axis.

The fitted-result contract contains dedicated ordered Whole Model confidence
band points. The frontend only maps these Rust coordinates and never
recomputes statistical inference.

Chart grids reserve explicit left, right, and bottom space, use `containLabel`,
and set axis-name gaps so titles and tick labels remain visible at desktop and
narrow widths.

### Effect Summary

The significance reference is fixed at `-log10(0.05) = 1.30103`. It renders as
a red solid vertical line labeled `LogWorth = 1.3`. Its label is anchored at
the top inside edge of the line so it cannot overlap the X-axis tick labels.
The chart uses the same unclipped grid and axis-label policy as the diagnostic
plots.

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

Creating a higher-order term without all lower-order interactions therefore
opts that model into the explicit uncentered reporting fallback described
above.

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
  constraints, and term-budget failures through the existing Analysis UI.
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
- Cover the uncentered reporting fallback for a non-hierarchical three-way
  interaction.
- Verify fitted values, SSE, residuals, and predictions are invariant.
- Cover rank-deficient and non-estimable hypotheses.
- Verify general-hypothesis leverage geometry by asserting that distances to
  the sloped and horizontal lines reproduce unconstrained and constrained
  residuals and that their sum-of-squares difference equals the Effect Test.
- Cover a centered interaction fixture where the reporting-basis main-effect
  slope changes sign from the raw fitted-basis coefficient.
- Verify continuous main effects retain original predictor units while
  interaction and complex effects use response-unit scaling with slope one.
- Verify leverage confidence curves cross the null line if and only if the
  effect F statistic exceeds its configured critical threshold.
- Verify Whole Model Actual by Predicted confidence points are ordered, smooth,
  use the whole-model hypothesis, and do not depend on row-specific diagnostic
  interval widths.

### Frontend

- Test padded nice domains, constant ranges, residual symmetry, and formatted
  endpoint labels.
- Test that Actual by Predicted renders only the dedicated Whole Model
  confidence band returned by Rust.
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

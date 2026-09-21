# Fit Model Regression Interactions Design

## Goal

Enhance the Fit Model regression report so its statistical content, ordering,
effect management, leverage diagnostics, and prediction-profiler interactions
match the requested JMP-inspired workflow while retaining StatsPlayground's
existing Analysis presentation and Graph Builder visual language.

## Scope

This change covers:

- report section ordering and sizing;
- a graphical Effect Summary with add/remove interactions;
- Type III effect tests;
- JMP-style effect leverage plots;
- a compact, linked Prediction Profiler;
- focused contract, statistical, component, and visual tests.

It does not add categorical predictors. Fit Model continues to accept continuous
response and predictor fields, with main, interaction, and quadratic terms.

## Branch and Baseline

Implementation is performed on
`feat/fit-model-regression-interactions`, created from the latest
`origin/dev`.

## Statistical Authority and Result Contract

Rust remains the sole statistical authority. The frontend may format, sort,
select, and render returned values, but it must not recompute effect tests,
leverage coordinates, confidence bands, or inferential statistics.

### Type III Effect Tests

The fitted result gains an `effectTests` collection. Each row identifies one
resolved model effect and includes:

- term ID and display label;
- number of parameters;
- effect degrees of freedom;
- partial sum of squares;
- F ratio;
- p-value;
- an optional explicit non-estimable reason.

For each effect, Rust compares the full model with the constrained model that
removes the design-matrix column group belonging to that effect while retaining
all other effects. The partial sum of squares is the reduced-model SSE minus
the full-model SSE. The numerator degrees of freedom is the corresponding rank
difference. The F statistic divides the effect mean square by the full model's
error mean square.

Although current continuous terms contribute one design-matrix column each, the
calculation and contract group columns by effect identity so the implementation
does not encode a one-parameter assumption.

Non-estimable statistics return nullable values plus an explicit reason. They
must never be represented as zero or silently omitted.

### Effect Leverage Plots

The fitted result gains leverage-plot data for every resolved effect. Rust uses
JMP-style partial-regression geometry: the selected effect is evaluated after
adjusting the response and selected effect contribution for all other model
terms. Each effect payload contains:

- term ID, label, and effect-test p-value;
- deterministic sampled plot rows with stable source row identity;
- the adjusted response and selected-effect leverage coordinate;
- fitted reference geometry;
- confidence-band geometry when estimable;
- the null-effect reference geometry;
- sampling metadata;
- an optional explicit non-estimable reason.

The renderer displays one effect at a time, so charts are not all mounted
simultaneously. The response contains sampled leverage rows for every effect to
make switching instantaneous. Sampling uses the existing deterministic
scatter render budget per effect and reports source counts so payload growth is
bounded and visible.

The implementation must validate the exact leverage formulas against a
hand-computable fixture and a trusted JMP-style reference dataset before the
chart is accepted.

### Compatibility

Existing result fields remain stable. Residual Q-Q result data stays in the
backend contract for archive and API compatibility, but the report no longer
renders a Residual Q-Q section.

Rust models use `#[serde(rename_all = "camelCase")]`. TypeScript result types
mirror the new fields exactly.

## Report Structure

The fitted report uses the following order:

1. Model Specification
2. Actual by Predicted
3. Effect Summary
4. Lack of Fit
5. Residual by Predicted
6. Summary of Fit
7. Analysis of Variance
8. Parameter Estimates
9. Effect Tests
10. Leverage Plot
11. Row Diagnostics
12. Prediction Profiler
13. Warnings

Residual Q-Q is not rendered, including its unavailable-state placeholder.

### Actual and Residual Plots

Actual by Predicted moves immediately above Effect Summary.

Lack of Fit moves immediately below Effect Summary, followed by Residual by
Predicted. The residual plot receives a wider desktop frame than the current
680-pixel limit while remaining fluid and page-overflow-safe at narrow widths.
The graph continues to use the existing Fit Model Graph Builder adapter.

### Effect Summary

Effect Summary directly composes shared Analysis presentation primitives and a
Graph Builder chart. It contains:

- the existing effect table;
- a horizontal LogWorth bar chart aligned to the same sorted effects;
- p-values and LogWorth values;
- a per-row Remove action;
- an Add action;
- the existing Undo behavior.

Add opens the existing Fit Model editor with the current definition. Saving the
editor applies a revisioned definition update and triggers the normal refit.
Remove continues to enforce model hierarchy: a main effect cannot be removed
while a retained interaction or power term depends on it, and the final main
effect cannot be removed.

Chart selection and table ordering use the same stable term IDs. No duplicate
model-editing state is introduced inside the report.

### Summary and Inferential Tables

Summary of Fit adds:

- Mean of Response;
- Observations.

Analysis of Variance and Parameter Estimates continue to use the values already
returned by Rust but move to the approved report positions.

Effect Tests is a new wide Analysis table with Source, Nparm, DF, Sum of
Squares, F Ratio, and Prob > F.

### Leverage Plot Interaction

Leverage Plot contains one Graph Builder-style chart and an effect selector.
The selector:

- lists all estimable and non-estimable effects by label;
- defaults to the effect with the smallest estimable p-value;
- preserves selection while the same result identity remains active;
- falls back deterministically when a refit removes the selected effect.

Changing the selector redraws the existing chart instance from the already
returned effect payload. The chart uses StatsPlayground colors, typography,
tooltips, axes, and responsive behavior rather than copying JMP's visual skin.
It shows points, fitted line, confidence band when estimable, null-effect
reference, and the selected effect's p-value.

## Prediction Profiler

The profiler uses the approved compact single-row layout:

- predictor cards occupy one horizontal track;
- each card has bounded minimum and maximum dimensions;
- additional cards scroll horizontally rather than shrinking below the useful
  plotting width;
- narrow screens focus one card at a time without causing page-level overflow;
- the shared prediction result strip remains below the track.

All profiler charts are linked through one current-value state. Changing a
number field or slider updates:

- every predictor scan curve;
- every confidence band;
- every current-value marker;
- every paired numeric input and slider;
- the predicted response and both interval summaries.

The frontend derives one shared Y-axis domain from all current profiler scan
data and confidence bounds. That domain is recomputed after linked values
change, with finite-value guards and graph-standard padding. Each chart retains
its own predictor X domain and slider range from the training range.

This shared display-domain calculation is presentation logic, not statistical
inference. Point predictions, scan values, and intervals continue to come from
the fitted Rust snapshot and the existing typed prediction helpers.

## Data Flow and State

1. The Analysis executor sends the existing revisioned Fit Model request.
2. Rust validates inputs and fits the full model.
3. Rust computes summary, ANOVA, parameter estimates, diagnostics, Type III
   effect tests, and bounded leverage-plot payloads.
4. The existing result identity and stale-result fences accept or reject the
   response.
5. The report renders the ordered blocks.
6. Effect Add/Remove changes the persisted Analysis definition through the
   existing editor/definition-change path, increments revision, and refits.
7. Leverage selection and profiler control values remain transient view state;
   they do not change or persist the Analysis definition.

## Error Handling

- Numerical or invalid-input failures continue through repository-standard
  `AppError` mapping.
- Per-effect inferential failures are represented by nullable values and an
  explicit reason when the overall fit remains valid.
- A non-estimable leverage effect keeps the selector and panel visible and
  shows the localized reason instead of an empty chart.
- Rendering ignores non-finite chart coordinates and surfaces the corresponding
  non-estimable state; it must not coerce them to zero.
- Add/Remove failures use the existing report status and hierarchy messages.
- Stale results remain synchronously masked by the Analysis execution fences.

## Testing and Acceptance

### Rust

- hand-computable main-effect and interaction fixtures for Type III partial
  sums of squares, rank differences, F ratios, and p-values;
- ordering-invariance checks for Type III tests;
- explicit non-estimable cases;
- leverage-coordinate, fitted-line, confidence-band, and null-reference
  fixture checks;
- deterministic sampling and source-count checks;
- camelCase serialization contract coverage.

### TypeScript

- exact Rust/TypeScript result-shape fixtures;
- Effect Summary ordering and LogWorth chart model tests;
- definition transitions for Add, Remove, hierarchy blocking, and Undo;
- leverage selection and fallback tests;
- shared profiler Y-domain and linked update tests;
- locale parity for all new labels and reasons.

### Component and Visual Acceptance

- exact report block order;
- no Residual Q-Q graph or placeholder;
- Actual by Predicted above Effect Summary;
- Effect Summary bars, Add, Remove, and Undo;
- Lack of Fit and widened Residual by Predicted placement;
- Mean of Response and Observations in Summary of Fit;
- ANOVA, Parameter Estimates, and Effect Tests content;
- single leverage chart with effect switching;
- compact horizontal Profiler cards, linked updates, shared Y domain, and
  narrow-width page-overflow safety;
- desktop and narrow-width chart visibility and geometry.

### Verification Commands

Run the smallest focused suites first, then the required gates:

- Fit Model TypeScript and Playwright component suites;
- targeted Rust Fit Model tests;
- `npm run test:analysis:typecheck`;
- `npm run test:analysis:contracts`;
- `npm run test:analysis:kinds`;
- `npm run test:analysis:ui`;
- `npm run test:analysis`;
- `cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts`;
- `npm run build`;
- `cargo test` in `src-tauri`;
- `cargo clippy` in `src-tauri`.

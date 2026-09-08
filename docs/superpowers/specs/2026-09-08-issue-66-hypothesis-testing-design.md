# Issue 66 Hypothesis Testing Analysis Design

**Date:** 2026-09-08
**Status:** Approved design, pending written-spec review
**Issue:** https://github.com/ashton2914/StatsPlayground/issues/66

## Context

StatsPlayground currently exposes separate Distribution, Fit Y by X, and Fit
Model Analysis kinds, but it does not provide a unified workflow for choosing
and running a comparison test. Issue 66 adds a native Hypothesis Testing
Analysis for a continuous response.

The reference image contains ten tests across four study structures, not nine:

1. Two independent groups: Student two-sample t, Welch t, and Wilcoxon
   rank-sum/Mann-Whitney U.
2. Three or more independent groups: one-way ANOVA, Welch ANOVA, and
   Kruskal-Wallis.
3. Two paired conditions: paired t and Wilcoxon signed-rank.
4. Three or more paired conditions or complete blocks: randomized-block
   one-factor repeated-measures ANOVA and Friedman.

JMP 19 provides these capabilities across Oneway, Unequal Variances,
Nonparametric, and Matched Pairs platforms. StatsPlayground will provide one
study-question workflow that joins study-design validation, transparent method
selection, effect estimation, sensitivity analysis, post-hoc comparisons, and
auditable reporting.

## Goals

- Implement all ten methods in the reference image as Rust-authoritative
  statistical methods.
- Accept both long and wide data layouts.
- Support automatic recommendation, guided selection, and fully manual
  selection.
- Prevent manual selection from bypassing mathematical or structural
  compatibility requirements.
- Explain each automatic recommendation using inspectable evidence rather than
  a black-box score or one normality-test p-value.
- Run a matched sensitivity method when the available evidence does not support
  one unambiguous method.
- Automatically run the correct post-hoc family after a significant multi-group
  omnibus test.
- Present estimates, confidence intervals, effect sizes, diagnostics, raw-data
  graphics, and robustness before emphasizing p-values.
- Persist enough method and selector provenance to reproduce why an analysis
  ran as it did.
- Integrate with the native Analysis document lifecycle, presentation
  primitives, archive validation, report embedding, and stale-result fencing.

## Non-Goals

The first release does not include:

- one-sample tests;
- equivalence, non-inferiority, or superiority margins;
- tests for proportions, counts, survival outcomes, or categorical responses;
- factorial ANOVA, ANCOVA, covariate adjustment, or mixed-effects models;
- Greenhouse-Geisser or Huynh-Feldt repeated-measures corrections;
- model-based handling of incomplete repeated measurements;
- permutation, bootstrap, Bayesian, power, or sample-size procedures;
- Nemenyi as an alternative Friedman post-hoc family;
- runtime statistical plugins or frontend statistical fallbacks.

The scope is one continuous response compared across one condition factor.

## Architectural Decision

Add an independent `hypothesisTest` Analysis kind. Internally, separate study
normalization, method compatibility, diagnostic evidence, recommendation, and
method execution.

### Alternatives Considered

1. **Extend Fit Y by X.** This would reuse the independent-group role surface,
   but pairing, complete blocks, and multiple wide response columns are not
   natural Y-by-X semantics. It would also make Fit Y by X own method
   recommendation and study-design inference. Rejected.
2. **Build one monolithic hypothesis-test engine.** This would establish a
   unified entry point quickly, but normalization, diagnostics, selection, ten
   methods, and five post-hoc families would become one branch tree that is
   difficult to validate and extend. Rejected.
3. **Add a registry-based Hypothesis Testing Analysis kind.** A study-design
   resolver produces typed input, a method registry declares compatibility and
   output contracts, a selector produces an execution plan, and independent
   executors calculate the results. Selected.

The selector never computes a statistic. A method executor never reinterprets
the study design. This boundary allows recommendation policy to evolve without
changing statistical formulas, and methods to gain better numerical
implementations without changing selection semantics.

## Invariants

1. Rust is the sole authority for diagnostics, selection, statistical results,
   effect sizes, intervals, and post-hoc comparisons.
2. Persisted Analysis documents contain definitions and presentation only,
   never calculated results or generated report tables.
3. Pairing or blocking is established by the data layout and an explicit user
   declaration. It is never inferred from similar distributions or row counts.
4. Wide data uses one row per observational unit. In a paired design, values in
   one row are paired. In an independent design, values in different wide
   columns are treated as independent samples and row alignment has no
   statistical meaning.
5. Long paired data requires a Subject/Pair/Block ID.
6. Manual selection can override a recommendation only after the same
   compatibility gate used by automatic selection succeeds.
7. Shapiro-Wilk is diagnostic evidence only. Its p-value cannot independently
   select a parametric or rank method.
8. Every result identifies its estimand. A rank test is not described as a
   median test unless the required common-shape or symmetry interpretation is
   supported.
9. A non-significant result is described as insufficient evidence of a
   difference, never as acceptance of the null or proof of equivalence.
10. Every asynchronous result is protected by the complete Analysis stale
    fence, including method choice, level ordering, alternative, and selector
    version.
11. Unsupported, unavailable, degraded, and not-computable outputs are explicit
    typed states. Non-finite numbers never cross IPC.
12. Every kind renderer directly composes the shared Analysis presentation
    primitives. It cannot wrap a legacy report surface.

## Product Workflow

### Create And Configure

`Analyze > Hypothesis Test` opens a role dialog for the active dataset.

The dialog contains:

- a `Long` / `Wide` segmented data-layout control;
- role slots appropriate to the selected layout;
- an `Independent` / `Paired or blocked` study-design control;
- an `Automatic` / `Guided` / `Manual` method-mode control;
- alpha, confidence level, alternative, level order, reference level, and
  post-hoc controls;
- a live compatibility summary.

Long layout accepts:

- exactly one numeric continuous Response column;
- exactly one nominal or ordinal Condition column;
- exactly one optional Subject/Pair/Block ID column.

The ID becomes required when the user selects a paired or blocked design.
Within one subject, each condition can contribute at most one valid response.
Duplicate subject-condition cells are an error; they are not averaged
implicitly.

Wide layout accepts two or more numeric continuous Measurement columns and one
optional Subject ID column. In a paired design, the stable dataset row identity
is the subject identity when no explicit Subject ID is supplied. An explicit ID
must be non-missing and unique among retained rows.

The dialog may suggest a layout based on selected roles, but the user confirms
the study design. Cancelling creates no project state.

### Selection Modes

**Automatic** runs the recommended compatible method and any required
sensitivity method.

**Guided** runs diagnostics and shows the recommended and other compatible
methods before the user confirms one. Before confirmation, the recommendation
may be previewed but is not recorded as a user selection.

**Manual** requires the user to choose a method before execution. Incompatible
methods remain visible but disabled with concrete reasons. A compatible manual
choice records both the recommendation and the selected method so exported
reports preserve the override.

Changing mode or method is a statistical definition change. It increments
`configRevision`, invalidates the current result synchronously, and runs through
the standard Analysis history and read-only guards.

### Result Reading Order

The result view presents:

1. a conclusion statement and robustness status;
2. the primary estimate, interval, effect size, statistic, degrees of freedom,
   and p-value;
3. a study-appropriate raw-data and estimate graph;
4. the evidence supporting and opposing the method choice;
5. sensitivity results when required;
6. post-hoc results for eligible multi-group analyses;
7. exclusions, method details, and the audit trail.

The p-value is never the only visually prominent result.

## Study Normalization And Missing Data

The service queries validated identifiers through the existing dataset metadata
boundary and converts either layout to one of four typed engine inputs.

### Independent Two-Group Input

Requires exactly two non-empty groups. Long rows with a missing response or
condition are excluded. Wide independent data excludes missing values within
each measurement column independently. Unequal group sizes are valid.

### Independent Multi-Group Input

Requires three or more non-empty groups. Missing values follow the same rule as
independent two-group input. A group with an insufficient sample for a requested
method makes that method incompatible; it is not silently removed.

### Paired Two-Condition Input

Requires exactly two conditions. Only observational units with both finite
measurements form a pair. Incomplete pairs are excluded as whole pairs and
listed in the exclusion summary. Pair order follows the persisted condition
order.

### Paired Multi-Condition Or Complete-Block Input

Requires three or more conditions, one value per subject-condition cell, and a
complete set of conditions for every retained subject. Subjects with any
missing condition are excluded as whole blocks and listed. The first release
does not impute values, use pairwise deletion, or reinterpret incomplete blocks
as independent observations.

The parametric executor fits the additive model `response ~ condition + block`.
For repeated measurements, the block is the subject. The method is reported as
randomized-block ANOVA / one-factor repeated-measures ANOVA. The report states
that the additive covariance/sphericity requirement is not fully testable from
one observation per subject-condition cell and that no epsilon correction is
included in this release.

## Method Registry

Stable method IDs are persisted and used across Rust, TypeScript, archives,
tests, and reports.

| Method ID | Display method | Compatible structure | Primary estimand |
| --- | --- | --- | --- |
| `studentTwoSampleT` | Student two-sample t | Independent, 2 groups | Difference in means |
| `welchTwoSampleT` | Welch two-sample t | Independent, 2 groups | Difference in means |
| `mannWhitneyU` | Wilcoxon rank-sum / Mann-Whitney U | Independent, 2 groups | Relative stochastic location; location shift when common shape is plausible |
| `oneWayAnova` | One-way ANOVA | Independent, 3+ groups | Equality of means |
| `welchAnova` | Welch ANOVA | Independent, 3+ groups | Equality of means under unequal variances |
| `kruskalWallis` | Kruskal-Wallis | Independent, 3+ groups | Equality of rank distributions; location when common shape is plausible |
| `pairedT` | Paired t | Paired, 2 conditions | Mean paired difference |
| `wilcoxonSignedRank` | Wilcoxon signed-rank | Paired, 2 conditions | Pseudomedian paired difference under symmetry |
| `randomizedBlockAnova` | Randomized-block / repeated-measures ANOVA | Complete block, 3+ conditions | Equality of condition means after block adjustment |
| `friedman` | Friedman | Complete block, 3+ conditions | Equality of within-block rank distributions |

Each registry entry declares:

- supported study structures and group-count bounds;
- minimum sample or complete-block requirements;
- degenerate-data and finite-number checks;
- alternative-hypothesis support;
- estimand and interpretation requirements;
- exact/asymptotic policy;
- statistic, interval, and effect-size family;
- compatible sensitivity and post-hoc method;
- stable method and formula version identifiers.

The registry is compiled application code, not a runtime plugin system and not
persisted inside a project.

## Compatibility Gate

Compatibility is deterministic and precedes diagnostics or recommendation.
Each rejection returns a stable reason code and localized parameters.

The gate checks:

- valid data layout and role types;
- declared independent or paired/blocked structure;
- effective condition count;
- unique and complete pair/block identity where required;
- method group-count bounds;
- method-specific minimum observations and degrees of freedom;
- finite input and non-degenerate variance or rank structure;
- valid alpha and confidence level;
- level ordering and reference-level membership;
- alternative support.

Multi-group omnibus methods are two-sided. A saved `less` or `greater`
alternative is incompatible once the effective data contains three or more
conditions. Post-hoc procedures in this release are also two-sided.

Examples of reason codes include:

- `PAIR_ID_REQUIRED`
- `DUPLICATE_SUBJECT_CONDITION`
- `INCOMPLETE_BLOCKS_EXCLUDED`
- `INSUFFICIENT_GROUP_COUNT`
- `INSUFFICIENT_OBSERVATIONS`
- `ZERO_WITHIN_GROUP_VARIANCE`
- `ALL_RANKS_TIED`
- `ONE_SIDED_OMNIBUS_UNSUPPORTED`
- `METHOD_STUDY_DESIGN_MISMATCH`

Warnings such as excluded incomplete pairs are separate from hard method
incompatibility. If exclusions leave a valid analysis, execution continues and
the report gives the before/after counts.

## Diagnostic Evidence

Diagnostics operate on the data relevant to the candidate method:

- independent designs use group residuals around group centers;
- paired t and signed-rank use paired differences;
- randomized-block ANOVA uses residuals from the additive condition-plus-block
  model;
- Friedman uses within-block ranks and tie counts.

The evidence payload includes:

- per-group, pair, and complete-block sample counts;
- minimum/maximum sample ratio and group-size balance;
- means, medians, standard deviations, robust spread, skewness, and tail weight;
- Q-Q plot coordinates and a summarized deviation grade;
- robust extreme-observation count and influence grade;
- Brown-Forsythe statistic and p-value for independent groups;
- largest-to-smallest finite variance ratio;
- ties and zero-difference counts;
- whether diagnostic power is limited by small sample size.

Shapiro-Wilk can be reported when its numerical contract is supported, but it
is never a routing gate. Bartlett is not used for automatic routing because its
variance conclusion is itself sensitive to non-normality.

Evidence is graded `supports`, `opposes`, or `insufficient` for each assumption.
The overall selector certainty is `high`, `medium`, or `low`; it is a policy
classification, not a probability.

## Selector Version 1

The selector is a deterministic, table-driven policy with all thresholds in one
versioned Rust policy definition. It uses the following order:

1. Resolve study structure and compatible candidates.
2. Grade severe shape/influence concerns.
3. For independent groups, grade heteroscedasticity and imbalance.
4. Select the primary method.
5. Decide whether a sensitivity method is required.
6. Emit reason codes, evidence links, and certainty.

Version 1 defines severe small-sample shape evidence as at least one of:

- absolute adjusted skewness greater than 2;
- adjusted excess kurtosis greater than 7;
- a robust standardized deviation greater than 5 when robust scale is
  estimable.

Shape evidence is treated as limited rather than reassuring when the relevant
sample has fewer than eight observations. For samples of at least 30 per
independent group or 30 complete pairs/blocks, skewness alone does not force a
rank method; severe influence, tail behavior, and sensitivity evidence remain
active.

Independent-group heteroscedasticity is material when Brown-Forsythe has
`p < 0.10`, or when the finite variance ratio exceeds 2 and the largest-to-
smallest sample-size ratio exceeds 2. A variance diagnostic with fewer than
five observations in a group is marked insufficient and cannot support
Student/ANOVA with high certainty.

The method rules are:

- Independent two-group: choose Mann-Whitney when severe shape/influence
  evidence is present and the minimum group size is below 30; otherwise choose
  Welch t when heteroscedasticity is material; otherwise choose Student t.
- Independent multi-group: choose Kruskal-Wallis under the corresponding severe
  small-sample shape/influence condition; otherwise choose Welch ANOVA when
  heteroscedasticity is material; otherwise choose one-way ANOVA.
- Paired two-condition: choose signed-rank when paired differences show severe
  shape/influence evidence and fewer than 30 complete pairs exist; otherwise
  choose paired t.
- Paired multi-condition: choose Friedman when additive-model residuals show
  severe shape/influence evidence and fewer than 30 complete blocks exist;
  otherwise choose randomized-block ANOVA.

Signed-rank needs a plausibly symmetric paired-difference distribution for a
simple location interpretation. When paired differences are strongly
asymmetric, neither paired t nor signed-rank receives high certainty at small
sample size. Version 1 selects signed-rank for robustness, runs paired t as a
sensitivity method, lowers certainty to `low`, and reports the estimand caveat.

Randomized-block ANOVA cannot establish sphericity from this first-release
input. When it is primary, Friedman is always included as sensitivity evidence
unless there are at least 30 complete blocks and no material covariance,
shape, tie, or influence warning. The report never claims that sphericity was
proven.

Q-Q coordinates remain visible diagnostic evidence but do not add an
independent routing threshold in selector version 1. The adjusted-moment and
robust-scale formulas are part of selector version 1's tested numerical
contract. They cannot change under the same selector version.

## Sensitivity Analysis

Sensitivity analysis is required when:

- selector certainty is `medium` or `low`;
- shape, variance, or influence evidence conflicts;
- a paired nonparametric estimand has an interpretation caveat;
- the randomized-block covariance assumption is not adequately supported;
- the user manually selects a compatible method different from the
  recommendation.

The paired method families are:

- Student or Welch t with Mann-Whitney;
- one-way or Welch ANOVA with Kruskal-Wallis;
- paired t with signed-rank;
- randomized-block ANOVA with Friedman.

A sensitivity table shows method, estimand, estimate where comparable,
statistic, p-value, direction, and conclusion. It distinguishes:

- `stable`: direction and alpha-level conclusion agree;
- `statisticallySensitive`: p-values cross alpha but direction does not change;
- `substantivelyConflicting`: direction or practical-effect interpretation
  changes;
- `notDirectlyComparable`: methods target materially different estimands.

Conflict status is visible in the conclusion area and in exported reports. It
cannot be hidden by collapsing the sensitivity section.

The system does not use sensitivity results to choose the result with the most
favorable p-value.

## Exact And Asymptotic Rank Methods

Mann-Whitney and signed-rank use an exact distribution when the input contains
no ties, signed-rank contains no zero differences, and the deterministic state-
space and memory budget is not exceeded.

Version 1 permits at most 2,000,000 assignment states and 64 MiB of temporary
exact-distribution workspace per calculation. For Mann-Whitney, the assignment
estimate is `choose(n1 + n2, n1)`; for signed-rank it is `2^n` after zero
differences are removed. An implementation can use dynamic programming rather
than enumerate every assignment, but it cannot exceed either public budget.

Otherwise they use a tie-corrected asymptotic distribution. The method audit
records:

- exact or asymptotic path;
- state-space estimate and budget outcome;
- tie correction;
- zero-difference handling;
- continuity correction;
- formula version.

Signed-rank version 1 removes zero differences before ranking and reports the
removed count. Mann-Whitney and signed-rank use a continuity correction by
default on the asymptotic path. Kruskal-Wallis, Friedman, and Dunn use tie
corrections.

The first release does not label a Monte Carlo approximation as exact. If an
exact calculation exceeds its budget, it degrades transparently to the declared
asymptotic path and emits a warning.

## Estimates, Intervals, And Effect Sizes

Every method returns its raw statistic, p-value, degrees of freedom where
defined, method/formula version, and an estimate block. The estimate block uses
typed availability states when an interval is undefined or unsupported.

| Method family | Estimate and interval | Effect size |
| --- | --- | --- |
| Student t | Mean difference and confidence interval | Pooled-SD Hedges' g |
| Welch t | Mean difference and Welch confidence interval | Hedges' g-av using the root mean square of group SDs |
| Mann-Whitney | Hodges-Lehmann location shift and compatible interval when defined | Rank-biserial correlation |
| Paired t | Mean paired difference and confidence interval | Standardized paired difference d-z |
| Signed-rank | Hodges-Lehmann paired pseudomedian and compatible interval when defined | Matched-pairs rank-biserial correlation |
| One-way ANOVA | Group means and model intervals | Omega squared |
| Welch ANOVA | Group means and heteroscedastic intervals | Welch-F partial omega-squared approximation |
| Kruskal-Wallis | Group rank/location summaries | Epsilon squared |
| Randomized-block ANOVA | Block-adjusted condition means and intervals | Generalized eta squared |
| Friedman | Condition mean ranks | Kendall's W |

For Welch ANOVA, version 1 reports the F-based partial omega-squared
approximation

`omega_p_squared = ((F - 1) * df1) / (F * df1 + df2 + 1)`,

using the Welch F statistic and its Welch-Satterthwaite degrees of freedom. A
negative finite estimate remains visible rather than being silently clipped to
zero. The response names this approximation and its formula version; a generic
unweighted eta squared cannot be substituted. Student Hedges' g, Welch g-av,
paired d-z, and every omnibus effect size likewise have separate method IDs and
reference fixtures so a shared display label cannot conceal different
denominators.

Confidence intervals are simultaneous only when the underlying procedure
provides simultaneous coverage. An ordinary estimate interval is labeled as
such and is not presented as multiplicity-adjusted.

## Post-Hoc Comparisons

With `postHoc: "automatic"`, post-hoc comparisons run only when a compatible
multi-group omnibus test has `p <= alpha`.

| Omnibus method | Post-hoc family | Multiplicity control |
| --- | --- | --- |
| One-way ANOVA | Tukey HSD/Tukey-Kramer | Family-wise simultaneous procedure |
| Welch ANOVA | Games-Howell | Heteroscedastic family-wise procedure |
| Kruskal-Wallis | Dunn joint-rank comparisons | Holm adjusted p-values |
| Randomized-block ANOVA | Paired t comparisons | Holm adjusted p-values |
| Friedman | Paired Wilcoxon signed-rank comparisons | Holm adjusted p-values |

Post-hoc output includes pair identity, direction, estimate or rank difference,
standard error where defined, raw p-value, adjusted p-value, interval status,
effect size, and compact-letter grouping.

Tukey and Games-Howell return their corresponding simultaneous intervals. Dunn,
paired t-Holm, and paired Wilcoxon-Holm separately label adjusted p-values and
estimate intervals; they cannot imply simultaneous interval coverage when it
has not been calculated.

Nemenyi remains a future optional Friedman family. Version 1 uses paired
Wilcoxon-Holm to keep pairwise estimates, effect sizes, zero handling, and
auditing aligned with the paired two-condition executor.

## Persisted Analysis Contract

Add `hypothesisTest` to the exhaustive Analysis kind manifest, document union,
descriptor, executor, view, editor, graph, report, and Rust archive-validator
registries.

The TypeScript definition is structurally equivalent to:

```ts
type HypothesisTestMethodId =
  | "studentTwoSampleT"
  | "welchTwoSampleT"
  | "mannWhitneyU"
  | "oneWayAnova"
  | "welchAnova"
  | "kruskalWallis"
  | "pairedT"
  | "wilcoxonSignedRank"
  | "randomizedBlockAnova"
  | "friedman";

type HypothesisTestRoles =
  | {
      layout: "long";
      response: FieldRef;
      condition: FieldRef;
      subject: FieldRef | null;
    }
  | {
      layout: "wide";
      measurements: FieldRef[];
      subject: FieldRef | null;
    };

interface HypothesisTestManualSelection {
  methodId: HypothesisTestMethodId;
  reason: string | null;
}

interface HypothesisTestAnalysisDefinition {
  kind: "hypothesisTest";
  roles: HypothesisTestRoles;
  studyDesign: "independent" | "pairedOrBlocked";
  selectionMode: "automatic" | "guided" | "manual";
  manualSelection: HypothesisTestManualSelection | null;
  alternative: "twoSided" | "less" | "greater";
  alpha: number;
  confidenceLevel: number;
  levelOrder: string[];
  referenceLevel: string | null;
  postHoc: "automatic" | "off";
  selectorVersion: "1";
}
```

Automatic mode requires `manualSelection: null`. Manual mode requires a
selection. Guided mode permits `null` while previewing the recommendation and
persists a selection after confirmation. A manual-selection reason is optional
user context and does not affect calculation or fingerprinting beyond the
selected method ID.

`selectorVersion` is persisted. Opening an older supported selector version
reproduces its rules. Upgrading an analysis to a newer selector is an explicit
definition edit with a visible change summary. An unsupported selector version
renders an unavailable state; it is not silently mapped to the current policy.

`HypothesisTestAnalysisPresentation` version 1 uses layout
`hypothesis-test-v1`. It stores disclosure state, active result tab, graph
display settings, and table sorting only. It cannot store computed rows,
diagnostics, recommendation output, exclusions, or formatted statistics.

The descriptor declares report embedding and custom Analysis graphs. Graph
editing remains unsupported and its graph-editing policy is `null`.

## Request, Response, And Execution

The frontend executor constructs a typed `HypothesisTestRequest` from the
document and current dataset metadata. The request includes document identity,
dataset identity/version, definition, and fingerprint.

The Rust service validates roles and identifiers, queries DuckDB, normalizes the
data, and invokes the pure engine. The Tauri command delegates to the service;
it contains no statistical logic.

`HypothesisTestResponse` contains:

- response identity and fingerprint;
- normalized data summary;
- exclusions and retained counts;
- compatibility records for all ten methods;
- diagnostic evidence;
- recommendation and actual execution decision;
- primary method result;
- zero or more sensitivity results;
- optional post-hoc result;
- warnings and method audit.

Every variant uses an explicit discriminator. Rust models use camelCase serde
output and TypeScript mirrors the contract. The executor validates response
kind, analysis ID, dataset ID/version, config revision, fingerprint, and key
discriminators before submitting a result to runtime state.

The complete stale fingerprint includes:

- Analysis ID and kind;
- source dataset ID and current data version;
- all role field identities and ordering;
- study design and selection mode;
- selected method ID;
- alternative, alpha, and confidence level;
- level order and reference level;
- post-hoc mode;
- selector version.

The free-text manual-selection reason does not change statistical output and is
excluded from the statistical fingerprint, while remaining persisted for the
audit trail.

## Rust Module Boundaries

The engine is organized by responsibility:

```text
src-tauri/src/engine/hypothesis_test/
  mod.rs
  normalize.rs
  compatibility.rs
  diagnostics.rs
  selector.rs
  effect_size.rs
  result.rs
  methods/
  post_hoc/
```

- `normalize` creates one of the four typed study inputs and exclusion records.
- `compatibility` applies hard method constraints and reason codes.
- `diagnostics` calculates evidence without choosing a method.
- `selector` turns compatibility and evidence into a versioned execution plan.
- `methods` owns ten independent primary executors.
- `post_hoc` owns the five comparison families.
- `effect_size` owns shared, versioned estimate and interval helpers.
- `result` assembles the IPC response without recalculating method values.

Existing ANOVA or distribution helpers may be reused only when their formula
and edge-case contracts match and reference tests cover the reused path. The
new Analysis does not reuse the Fit Y by X IPC or UI semantics.

## Result Presentation

`HypothesisTestAnalysisResults` directly composes `AnalysisFrame`,
`AnalysisStack`, `AnalysisText`, `AnalysisTable`, `AnalysisButton`, and
`AnalysisGraph`.

### Conclusion And Core Estimate

The first frame states the comparison, selected method, recommendation status,
selector certainty, alpha-level conclusion, and sensitivity status. It uses
phrases such as:

- evidence of a difference;
- insufficient evidence of a difference;
- statistical conclusion depends on method choice;
- methods target different estimands and are not directly interchangeable.

The estimate table shows raw values with locale-aware display formatting. It
does not convert missing or unavailable values to zero.

### Graphs

- Independent designs show raw observations, a compact distribution summary,
  and interval estimates on a shared group order.
- Paired two-condition designs show subject lines and a paired-difference plot.
- Complete-block designs show subject profiles and condition estimates without
  allowing dense profiles to obscure the aggregate estimate.
- Diagnostic disclosure includes Q-Q and residual/difference views.
- Excluded observations can be inspected but never appear as if they
  contributed to the current statistic.

All charts use `AnalysisGraph` custom strategies and the common Analysis
presentation tokens. They are not hidden Graph Builder documents.

### Method Evidence

Each evidence row shows its observed value, policy interpretation, and
`supports`/`opposes`/`insufficient` grade. Human-readable text is paired with
stable reason codes such as `UNEQUAL_VARIANCE_WITH_IMBALANCE`.

The UI distinguishes "no violation detected" from "assumption established."
Small samples explicitly report limited diagnostic power.

### Post-Hoc Presentation

The default view combines an estimate plot and compact-letter display. A full
pairwise table is available without nesting a card inside another card. Group
order, colors, and labels remain consistent with the primary graph.

### Audit

The audit disclosure contains:

- requested, recommended, and executed methods;
- user override and optional reason;
- formula, method, and selector versions;
- exact/asymptotic path and corrections;
- ties, zeros, exclusions, and retained counts;
- confidence and alpha levels;
- source data version and execution timestamp;
- warnings and degraded calculations.

Copy and report embedding include the conclusion, estimand, estimate, interval,
effect size, method, robustness status, and audit summary. They do not export a
context-free p-value table.

## Errors And Degraded States

Rust returns `Result<T, AppError>` and maps failures to the existing variants:

- `InvalidParam` for invalid roles, alpha, confidence level, level order,
  design, or incompatible manual method;
- `Stats` for insufficient degrees of freedom, singular designs, all ties, zero
  variance, or numerical algorithm failure;
- `Database` and `FileIO` at their existing service boundaries.

The UI presents actionable, path-safe messages such as "3 subjects are missing
condition C; complete-block analysis retained 17 subjects." It never presents
raw SQL, absolute paths, or an implementation exception.

Warnings are not errors. Exact-to-asymptotic degradation, limited diagnostic
power, excluded incomplete pairs, and an estimand caveat preserve a valid result
with visible warnings. Failure to form a legal study input or compute the
selected method produces an error state and cannot be hidden by silently
running another method.

## Persistence And Archive Validation

Hypothesis Test uses the existing `.span` Analysis document storage. Computed
responses are never written to the archive.

The Rust archive validator mirrors the TypeScript contract and rejects:

- unknown method, selector, presentation, or definition identities;
- a role shape that disagrees with its layout discriminator;
- duplicate or insufficient wide measurement references;
- invalid alpha or confidence levels;
- automatic mode with a manual selection;
- manual mode without a manual selection;
- a mismatched analysis and definition kind.

Archive validation checks document shape, not data-dependent group counts or
statistical computability. Those checks occur against the current dataset at
execution.

Save/open round trips preserve definition, presentation, folder assignment, and
manual audit context. Reopening recomputes the result from current source data.

## Localization And Accessibility

Every label, conclusion phrase, reason code presentation, warning, method name,
and audit term ships in English and Chinese in the same change.

Segmented controls, role slots, method lists, tables, graph alternatives, and
disclosures remain keyboard accessible. Disabled methods expose their reason to
assistive technology. Color never carries support/opposition, significance, or
robustness alone.

Tables and controls must fit narrow windows without overlapping or resizing
fixed controls. Long method names wrap without truncating the statistical
identity.

## Numerical Verification

Every primary method covers standard, unbalanced, tied, zero-difference,
degenerate, minimum-sample, missing-value, and large-scale numeric fixtures as
applicable.

Checked-in reference fixtures record:

- reference application or package;
- exact version;
- function and arguments;
- alternative, ties, zeros, and correction settings;
- expected statistic, degrees of freedom, p-value, estimate, interval, effect
  size, and adjusted p-values;
- field-specific absolute and relative tolerances.

Reference values may be generated offline with fixed versions of R packages,
SciPy, or JMP, but production and test execution do not depend on those tools.
A single broad tolerance for an entire response is not acceptable.

The following cross-method invariants are required:

- row order and legal label renaming do not alter results;
- translation and positive rescaling obey each method's expected invariants;
- equivalent long and wide inputs produce the same normalized statistical
  input and results;
- for two groups, Student t squared equals classic one-way ANOVA F;
- for two groups, Welch t squared equals Welch ANOVA F;
- swapping two group labels reverses directional estimates but preserves a
  two-sided p-value;
- exact small-sample rank results match enumerated distributions;
- ties, zeros, and continuity correction independently exercise the asymptotic
  path;
- Holm adjusted p-values are monotonic in ordered raw p-values and never below
  their corresponding raw p-values.

## Test Strategy

Implementation follows red-green-refactor from contracts through behavior.

### Contract And Registry Tests

- The cross-language kind manifest, TypeScript document registry, Rust handler,
  and archive validator contain `hypothesisTest` exactly once.
- Every one of the ten method IDs appears in registry parity tests.
- Unsupported capabilities use `false` and a `null` policy.
- Definition and presentation persistence contain no result fields.
- Request and response unions remain camelCase-compatible across IPC.

### Normalization And Compatibility Tests

- Long and wide forms normalize equivalently for all four study structures.
- Independent wide missingness is per column; paired missingness removes a
  whole pair/block.
- Duplicate subject-condition cells fail without implicit aggregation.
- Stable row identity supports a paired wide analysis without an explicit ID.
- Every compatibility reason code has a table-driven positive and negative
  case.
- Manual mode cannot execute a structurally incompatible method.

### Selector Tests

- Each of the ten methods has at least one dataset for which selector version 1
  recommends it where applicable.
- Heteroscedastic balanced and unbalanced cases route according to the declared
  Brown-Forsythe/ratio policy.
- Severe small-sample shape evidence routes to the matching rank family.
- Large-sample skew alone does not mechanically force a rank method.
- Limited diagnostic power lowers certainty rather than proving assumptions.
- Strongly asymmetric paired differences produce the signed-rank caveat and
  paired-t sensitivity result.
- The same diagnostics and selector version always produce the same plan and
  reason codes.

### Numerical Method Tests

- All ten main methods match their independent reference fixtures.
- All five post-hoc families match raw and adjusted reference outputs.
- Exact and asymptotic rank paths cover ties, zeros, and budget degradation.
- Effect sizes and intervals have independent fixtures, including unavailable
  boundaries.
- Degenerate inputs return typed errors or unavailable fields, never non-finite
  JSON values.

### Analysis Lifecycle Tests

- Creation, editing, rename, folder movement, duplicate, delete, history,
  read-only mode, and source-unavailable behavior match other Analysis kinds.
- Every statistical definition edit increments `configRevision`.
- Presentation-only changes do not increment it.
- A stale response is rejected after any fingerprinted field or source data
  version changes.
- Save/open preserves definitions but recomputes results.
- Report embedding is isolated from the live Analysis view and uses the same
  typed result model.

### Presentation And Acceptance Tests

- The renderer directly uses shared Analysis primitives and contains no legacy
  report wrapper, raw result table, or raw action markup.
- Automatic, guided, and manual transitions expose the correct controls and
  audit state.
- Incompatible methods are disabled with visible and accessible reasons.
- A conflicting sensitivity result remains visible in the conclusion and
  embedded report.
- Graphs, tables, disclosures, loading, stale, warning, empty, and error states
  pass component tests at desktop and narrow widths.
- English and Chinese labels fit without incoherent overlap.

## Validation Gate

Completion requires:

1. Hypothesis Test contract, selector, normalization, numerical, post-hoc,
   Analysis lifecycle, and component suites pass.
2. Existing Analysis contract, kind, execution, presentation, archive, report,
   Distribution, Fit Y by X, and Fit Model suites remain green.
3. `npm run build` succeeds.
4. `cargo build`, `cargo clippy -- -D warnings`, and `cargo test` succeed under
   `src-tauri`.
5. `git diff --check` succeeds.
6. Manual Tauri acceptance covers all four study structures, both layouts, all
   three selection modes, a sensitivity conflict, exact/asymptotic degradation,
   post-hoc output, report embedding, and save/reopen.
7. Desktop and narrow-window screenshots confirm that controls, tables, text,
   and graphs do not overlap and that every graph renders nonblank data.

## Manual Acceptance Scenarios

1. Create equivalent long and wide independent two-group analyses and confirm
   the same selected method and result.
2. Exercise Student, Welch, and Mann-Whitney recommendations with datasets built
   for their declared evidence paths; inspect and override each recommendation.
3. Repeat for one-way ANOVA, Welch ANOVA, and Kruskal-Wallis, confirming the
   matching automatic post-hoc family.
4. Run paired t and signed-rank from wide and long paired inputs, then remove one
   condition value and confirm whole-pair exclusion.
5. Run randomized-block ANOVA and Friedman on complete blocks, then introduce
   an incomplete block and confirm transparent whole-block exclusion.
6. Open a method-sensitive dataset and confirm the conclusion area, sensitivity
   table, and embedded report all expose the conflict.
7. Trigger all-ties, duplicate subject-condition, zero-variance, insufficient
   sample, and exact-budget states and confirm their typed messages.
8. Save, close, and reopen the project; confirm the definition and audit context
   persist while results are recomputed and stale responses cannot appear.

## Completion Definition

The feature is complete only when all ten methods have independent numerical
reference coverage, automatic selection is deterministic and explainable, long
and wide forms agree, manual mode cannot create an invalid analysis,
sensitivity conflicts remain visible, post-hoc families match the selected
omnibus methods, and archive/report round trips preserve a reproducible
definition without persisting computed answers.
# Issue 66 Hypothesis Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native Hypothesis Testing Analysis that runs all ten approved continuous-response comparison methods, recommends a compatible method transparently, supports manual override, and reports sensitivity and post-hoc results.

**Architecture:** Add `hypothesisTest` as a fourth exhaustive Analysis kind. Rust owns long/wide normalization, compatibility, diagnostics, selector version 1, all statistical calculations, and response assembly; React owns typed configuration, stale-fenced execution, shared-primitive presentation, and report embedding. The Rust engine separates normalization, compatibility, diagnostics, selection, primary methods, effect sizes, and post-hoc procedures so each numerical family has an independent reference-test boundary.

**Tech Stack:** Rust 2021, Tauri v2, DuckDB 1.10505.0, statrs 0.19.1, nalgebra 0.35.0, React 19, TypeScript 5.7, Zustand 5, ECharts 5.6, Playwright Component Testing 1.55.

**Spec:** `docs/superpowers/specs/2026-09-08-issue-66-hypothesis-testing-design.md`

## Global Constraints

- Work in an isolated Issue 66 worktree created from a user-confirmed current `origin/dev`; do not implement in the current checkout.
- Retrieve Issue 66 again at execution start and confirm the target branch before creating the worktree.
- Follow `docs/analysis-development-standard.md` and `.github/instructions/analysis-development.instructions.md` for every Analysis path.
- Rust is the sole statistical authority; TypeScript must not calculate diagnostics, p-values, intervals, effect sizes, selection, or post-hoc results.
- Persist definition and presentation only. Never persist computed responses, graph rows, diagnostics, or formatted result tables.
- Use the stable kind `hypothesisTest`, presentation layout `hypothesis-test-v1`, selector version `1`, and exactly the ten method IDs defined below.
- Support long and wide layouts, independent and paired/blocked study designs, and automatic, guided, and manual selection modes.
- Manual selection may override recommendation but may not bypass compatibility.
- Shapiro-Wilk, if added as a displayed diagnostic, must never independently route method selection.
- Version 1 exact budgets are 2,000,000 assignment states and 64 MiB temporary workspace per calculation; deterministic over-budget behavior is asymptotic degradation with an audit warning.
- Version 1 signed-rank removes zero differences before ranking; asymptotic Mann-Whitney and signed-rank use tie correction and continuity correction.
- Post-hoc mapping is fixed: ANOVA to Tukey-Kramer, Welch ANOVA to Games-Howell, Kruskal-Wallis to Dunn-Holm, randomized-block ANOVA to paired t-Holm, and Friedman to paired Wilcoxon-Holm.
- All four locale files (`en`, `zh-CN`, `zh-TW`, `vi`) must contain every new user-visible string in the same change.
- Render result hierarchy directly with shared Analysis primitives; no legacy report wrapper, raw result `<table>`, or raw action `<button>`.
- Return `Result<T, AppError>` from non-test Rust boundaries; do not use `unwrap()` or `expect()` outside tests.
- Validate identifiers through dataset metadata before building closed-template SQL. Never concatenate unvalidated user input into SQL.
- Use field-specific numerical tolerances and checked-in provenance for reference fixtures; do not use one broad JSON tolerance.
- After the first edit in every task, run that task's focused RED/GREEN command before widening scope.
- Do not push, open a PR, merge, or clean the worktree until the corresponding GitHub lifecycle gate is explicitly authorized.

## Stable Contracts

The following names are fixed across tasks.

```ts
export type HypothesisTestMethodId =
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

export type HypothesisTestStudyDesign = "independent" | "pairedOrBlocked";
export type HypothesisTestSelectionMode = "automatic" | "guided" | "manual";
export type HypothesisTestAlternative = "twoSided" | "less" | "greater";
export type HypothesisTestSelectorVersion = "1";
```

Rust uses the corresponding serde enums `HypothesisTestMethodId`,
`HypothesisTestStudyDesign`, `HypothesisTestSelectionMode`,
`HypothesisTestAlternative`, and `HypothesisTestSelectorVersion` with
`#[serde(rename_all = "camelCase")]`.

The pure engine entry point is:

```rust
pub fn run_hypothesis_test(
    input: NormalizedStudy,
    definition: &HypothesisTestDefinition,
) -> Result<HypothesisTestComputation, AppError>;
```

The service entry point is:

```rust
pub fn run(
    &self,
    request: HypothesisTestRequest,
) -> Result<HypothesisTestResponse, AppError>;
```

The TypeScript transport is:

```ts
export const hypothesisTestService = {
  run: (request: HypothesisTestRequest) =>
    invoke<HypothesisTestResponse>("hypothesis_test", { request }),
};
```

## File Structure

### New Rust Files

- `src-tauri/src/models/hypothesis_test.rs`: serde request, definition, diagnostics, selection, result, post-hoc, audit, warning, and response contracts.
- `src-tauri/src/engine/hypothesis_test/mod.rs`: pure orchestration and public exports.
- `src-tauri/src/engine/hypothesis_test/normalize.rs`: long/wide rows to four typed study inputs and exclusion records.
- `src-tauri/src/engine/hypothesis_test/compatibility.rs`: deterministic hard eligibility and reason codes.
- `src-tauri/src/engine/hypothesis_test/diagnostics.rs`: shape, influence, variance, ties, zeros, Q-Q, and evidence grades.
- `src-tauri/src/engine/hypothesis_test/selector.rs`: selector version 1 execution-plan rules.
- `src-tauri/src/engine/hypothesis_test/effect_size.rs`: versioned effect sizes and shared interval helpers.
- `src-tauri/src/engine/hypothesis_test/result.rs`: response assembly and non-finite-value rejection.
- `src-tauri/src/engine/hypothesis_test/methods/{mod,parametric,rank,exact}.rs`: ten primary method executors and bounded exact distributions.
- `src-tauri/src/engine/hypothesis_test/post_hoc/{mod,parametric,rank}.rs`: five post-hoc families and Holm adjustment.
- `src-tauri/src/services/hypothesis_test_service.rs`: generation validation, DuckDB read, normalization, and engine delegation.
- `src-tauri/src/commands/hypothesis_test_commands.rs`: thin Tauri command.
- `src-tauri/testdata/hypothesis_test/reference.json`: checked-in independent reference values and provenance.

### New Frontend Files

- `src/types/hypothesisTest.ts`: TypeScript mirror of Rust IPC models.
- `src/services/hypothesisTestService.ts`: typed Tauri invoke wrapper.
- `src/components/hypothesisTest/{hypothesisTestConfig,HypothesisTestDialog,index}.ts(x)`: pure configuration and create/edit UI.
- `src/components/hypothesisTest/hypothesisTest.css`: kind-specific stable dimensions only.
- `src/components/analysis/adapters/hypothesisTestAnalysisAdapter.ts`: document creation, summary, editor adaptation, and revisioned patching.
- `src/components/analysis/renderers/HypothesisTestAnalysisResults.tsx`: shared-primitive result hierarchy.
- `src/components/analysis/renderers/HypothesisTestAnalysisReport.tsx`: reusable live/embed report body.
- `src/components/analysis/renderers/hypothesisTestAnalysisModel.ts`: pure typed display-model assembly.
- `src/components/analysis/renderers/hypothesisTestGraphOptions.ts`: ECharts options over backend coordinates.
- `src/components/report/HypothesisTestAnalysisReportEmbed.tsx`: typed report embed.

### New Tests

- `tests/hypothesisTestContracts.test.ts`
- `tests/hypothesisTestConfig.test.ts`
- `tests/hypothesisTestAnalysisAdapter.test.ts`
- `tests/hypothesisTestArchive.test.ts`
- `tests/hypothesisTestReport.test.ts`
- `tests/hypothesisTestReportWiring.test.ts`
- `tests/workspaceHypothesisTest.test.ts`
- `tests/HypothesisTestHarness.tsx`
- `tests/hypothesisTest.spec.tsx`

---

### Task 1: Register The Persisted Kind And Cross-Language Contracts

**Files:**
- Modify: `contracts/analysis/kinds.v1.json`
- Modify: `src/types/analysis.ts`
- Create: `src/types/hypothesisTest.ts`
- Create: `src-tauri/src/models/hypothesis_test.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src/components/analysis/analysisKindDescriptors.ts`
- Modify: `src/components/analysis/analysisViewContracts.ts`
- Modify: `src/components/analysis/analysisGraphPolicies.ts`
- Modify: `src/components/analysis/analysisReportPolicies.ts`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `tests/analysisKindRegistry.test.ts`
- Modify: `tests/analysisDocument.test.ts`
- Create: `tests/hypothesisTestContracts.test.ts`
- Create: `tests/hypothesisTestArchive.test.ts`
- Modify: `tests/tsconfig.analysis-typecheck.json`

**Interfaces:**
- Consumes: existing Analysis manifest and discriminated document conventions.
- Produces: `HypothesisTestAnalysisDocument`, `HypothesisTestRequest`, `HypothesisTestResponse`, stable method IDs, and exhaustive kind registration used by every later task.

- [ ] **Step 1: Add RED registry and persisted-document tests**

Extend expected kinds and assert truthful capabilities:

```ts
assert.deepEqual(manifestKinds, ["distribution", "fitModel", "fitYByX", "hypothesisTest"]);
assert.deepEqual(analysisKindDescriptors.hypothesisTest.capabilities, {
  graphEditing: false,
  reportEmbedding: true,
});
assert.equal(analysisGraphPolicies.hypothesisTest, null);
assert.notEqual(analysisReportPolicies.hypothesisTest, null);
assert.equal(analysisViewContracts.hypothesisTest.presentationLayout, "hypothesis-test-v1");
```

Construct valid long and wide documents. Assert automatic mode has
`manualSelection: null`, manual mode has a method, and persisted JSON contains
none of `primaryResult`, `diagnostics`, `postHocResult`, or
`sensitivityResults`.

- [ ] **Step 2: Run RED contract tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestContracts.test.ts
```

Expected: FAIL because the kind and types do not exist.

- [ ] **Step 3: Add TypeScript document and IPC unions**

Define persisted roles exactly as:

```ts
export type HypothesisTestRoles =
  | { layout: "long"; response: FieldRef; condition: FieldRef; subject: FieldRef | null }
  | { layout: "wide"; measurements: FieldRef[]; subject: FieldRef | null };

export interface HypothesisTestAnalysisDefinition {
  kind: "hypothesisTest";
  roles: HypothesisTestRoles;
  studyDesign: HypothesisTestStudyDesign;
  selectionMode: HypothesisTestSelectionMode;
  manualSelection: { methodId: HypothesisTestMethodId; reason: string | null } | null;
  alternative: HypothesisTestAlternative;
  alpha: number;
  confidenceLevel: number;
  levelOrder: string[];
  referenceLevel: string | null;
  postHoc: "automatic" | "off";
  selectorVersion: "1";
}
```

Add presentation schema 1/layout `hypothesis-test-v1` with disclosure, active
tab, and graph display state only. Add the document to all Analysis unions.
Define IPC variants with explicit discriminators and raw numeric fields. Use:

```ts
export type HypothesisTestValue =
  | { state: "available"; value: number }
  | { state: "unavailable"; reason: string };
```

for calculations that can be undefined.

- [ ] **Step 4: Add mirrored Rust serde models and serialization tests**

Use internally tagged enums. Deserialize a complete camelCase request and
serialize a response, asserting:

```rust
assert_eq!(value["analysisKind"], "hypothesisTest");
assert_eq!(value["selectionDecision"]["recommendedMethod"], "welchTwoSampleT");
assert_eq!(value["primaryResult"]["methodId"], "welchTwoSampleT");
assert_eq!(value["methodAudit"]["selectorVersion"], "1");
```

- [ ] **Step 5: Register the kind and strict archive validator**

Add the manifest entry, descriptor, view contract, `null` graph policy, and a
typed report policy with dependency kind `hypothesisTest`. Add explicit Rust
definition/presentation validators selected by both analysis and definition
kind. Validate role discriminators, unique wide measurement refs,
alpha/confidence open intervals, mode/manual invariants, ten method IDs,
selector `"1"`, and presentation values. Leave data-dependent group counts to
execution.

- [ ] **Step 6: Run GREEN contracts and archive parity**

```bash
npm run test:analysis:typecheck
npx tsx --tsconfig tsconfig.app.json tests/analysisKindRegistry.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisDocument.test.ts
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestContracts.test.ts
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

- [ ] **Step 7: Commit Task 1**

```bash
git add contracts/analysis/kinds.v1.json src/types src-tauri/src/models src/components/analysis src-tauri/src/services/spprj_archive.rs tests
git commit -m "feat(analysis): register hypothesis test contracts"
```

### Task 2: Normalize Long And Wide Data Through DuckDB

**Files:**
- Create: `src-tauri/src/engine/hypothesis_test/{mod,normalize}.rs`
- Modify: `src-tauri/src/engine/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Create: `src-tauri/src/services/hypothesis_test_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Interfaces:**
- Consumes: `HypothesisTestRequest` and role union from Task 1.
- Produces: `HypothesisTestRows`, `NormalizedStudy::{IndependentTwo, IndependentMulti, PairedTwo, CompleteBlock}`, and exclusion records.

- [ ] **Step 1: Write RED normalization and service tests**

Cover equivalent long/wide independent data, equivalent long/wide paired data,
per-column independent deletion, whole-pair deletion, whole-block deletion,
duplicate long subject-condition rejection, non-unique explicit wide subject
rejection, and stale generation rejection.

```rust
assert_eq!(long_study, wide_study);
assert_eq!(normalized.retained_observations(), 6);
assert_eq!(exclusions[0].reason, ExclusionReason::IncompletePair);
```

- [ ] **Step 2: Run RED normalization tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_service
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::normalize
```

- [ ] **Step 3: Add closed-shape DuckDB row reading**

```rust
pub fn read_hypothesis_test_rows(
    &self,
    dataset_id: &str,
    roles: &HypothesisTestRoles,
) -> Result<HypothesisTestRows, AppError>;
```

Resolve each field through `get_user_columns`, verify numeric measurements and
categorical long condition role, reject duplicate role identities, and quote
only validated identifiers. Select `_row_id` for stable wide pairing. Return
typed raw cells and row identity; do not decide exclusions in DuckDB.

- [ ] **Step 4: Implement pure normalization**

```rust
pub enum NormalizedStudy {
    IndependentTwo(IndependentGroups),
    IndependentMulti(IndependentGroups),
    PairedTwo(PairedDifferences),
    CompleteBlock(CompleteBlocks),
}
```

Preserve persisted condition order and append unseen levels in first-observed
order. Validate one value per long subject-condition. Apply missingness exactly
as specified and return before/after counts.

- [ ] **Step 5: Implement the service boundary**

Validate alpha/confidence, check current generation while holding the DB lock,
read rows, normalize them, and temporarily return typed `notComputable` until
method dispatch exists. Do not add a command yet.

- [ ] **Step 6: Run GREEN normalization tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::normalize
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_service
cargo test --manifest-path src-tauri/Cargo.toml read_hypothesis_test_rows
```

- [ ] **Step 7: Commit Task 2**

```bash
git add src-tauri/src/engine src-tauri/src/services
git commit -m "feat(stats): normalize hypothesis test inputs"
```

### Task 3: Implement Parametric Two-Condition Methods

**Files:**
- Create: `src-tauri/src/engine/hypothesis_test/methods/{mod,parametric}.rs`
- Create: `src-tauri/src/engine/hypothesis_test/effect_size.rs`
- Create: `src-tauri/src/engine/hypothesis_test/compatibility.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/mod.rs`
- Create: `src-tauri/testdata/hypothesis_test/reference.json`

**Interfaces:**
- Consumes: independent groups or paired differences, alpha, confidence, alternative.
- Produces: Student t, Welch t, paired t, intervals, pooled Hedges' g, Welch g-av, paired d-z, and compatibility records.

- [ ] **Step 1: Add provenance-rich RED fixtures**

Cover balanced equal variance, unbalanced unequal variance, one-sided
alternatives, paired data, constant groups, minimum degrees of freedom,
translation, and positive rescaling. Each expected field has independent
absolute/relative tolerance and metadata such as:

```json
{"tool":"R","version":"4.5.1","function":"stats::t.test","arguments":{"var.equal":false,"alternative":"two.sided"}}
```

- [ ] **Step 2: Run RED tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::parametric
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::effect_size
```

- [ ] **Step 3: Implement compatibility**

```rust
pub fn evaluate_method_compatibility(
    study: &NormalizedStudy,
    method: HypothesisTestMethodId,
    alternative: HypothesisTestAlternative,
) -> MethodCompatibility;
```

Student/Welch require two independent non-empty groups and positive residual
degrees of freedom. Student requires estimable pooled variance. Paired t
requires at least two finite differences and estimable difference variance.
Known incompatibility returns reason codes, not execution errors.

- [ ] **Step 4: Implement Student, Welch, paired t, and effects**

Use stable two-pass moments. Student uses pooled variance and `n1+n2-2` df;
Welch uses Welch-Satterthwaite df; paired t uses only normalized differences.
Use statrs Student t CDF/inverse CDF. Add versioned:

```rust
pub fn hedges_g_pooled(groups: &IndependentGroups) -> Result<EffectEstimate, AppError>;
pub fn hedges_g_av(groups: &IndependentGroups) -> Result<EffectEstimate, AppError>;
pub fn paired_d_z(differences: &PairedDifferences) -> Result<EffectEstimate, AppError>;
```

Apply the small-sample J correction and retain denominator identity in audit.

- [ ] **Step 5: Run GREEN tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::parametric
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::effect_size
```

- [ ] **Step 6: Commit Task 3**

```bash
git add src-tauri/src/engine/hypothesis_test src-tauri/testdata/hypothesis_test
git commit -m "feat(stats): add two-condition parametric tests"
```

### Task 4: Implement Exact And Asymptotic Two-Condition Rank Methods

**Files:**
- Create: `src-tauri/src/engine/hypothesis_test/methods/{rank,exact}.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/methods/mod.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/{effect_size,compatibility}.rs`
- Modify: `src-tauri/testdata/hypothesis_test/reference.json`

**Interfaces:**
- Consumes: independent samples or paired differences and exact budgets.
- Produces: Mann-Whitney U, signed-rank, Hodges-Lehmann estimates, rank-biserial effects, audit path, and degradation warnings.

- [ ] **Step 1: Add RED exact/asymptotic fixtures**

Cover exact no-tie inputs, ties, signed-rank zeros, continuity correction,
all-tied incompatibility, alternatives, exact budget boundary, and deterministic
over-budget degradation.

```rust
assert_eq!(result.audit.inference_path, InferencePath::Exact);
assert_eq!(degraded.audit.inference_path, InferencePath::Asymptotic);
assert!(degraded.warnings.contains(&WarningCode::ExactBudgetExceeded));
```

- [ ] **Step 2: Run RED rank tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::exact
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::rank
```

- [ ] **Step 3: Implement ranking and exact budgets**

Use average tied ranks. Estimate states with overflow-safe capped
`choose(n1+n2,n1)` and capped `2^n`. Refuse exact mode for ties or signed-rank
zeros. Dynamic programming must stay within 2,000,000 states and 64 MiB.

- [ ] **Step 4: Implement asymptotic paths and estimates**

Apply tie-corrected variance and directional 0.5 continuity correction. Remove
signed-rank zeros and report count. Use standard normal inference. Add bounded
Hodges-Lehmann estimates/intervals and independent/matched rank-biserial effects;
return typed unavailable intervals when the bounded calculation is not valid.

- [ ] **Step 5: Run GREEN rank tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::exact
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::methods::rank
```

- [ ] **Step 6: Commit Task 4**

```bash
git add src-tauri/src/engine/hypothesis_test src-tauri/testdata/hypothesis_test/reference.json
git commit -m "feat(stats): add two-condition rank tests"
```

### Task 5: Implement Independent Multi-Group Tests And Post-Hoc

**Files:**
- Modify: `src-tauri/src/engine/hypothesis_test/methods/{parametric,rank}.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/{compatibility,effect_size,mod}.rs`
- Create: `src-tauri/src/engine/hypothesis_test/post_hoc/{mod,parametric,rank}.rs`
- Modify: `src-tauri/testdata/hypothesis_test/reference.json`

**Interfaces:**
- Consumes: three-or-more independent groups.
- Produces: one-way ANOVA, Welch ANOVA, Kruskal-Wallis, three effects, Tukey-Kramer, Games-Howell, Dunn-Holm, and compact letters.

- [ ] **Step 1: Add RED omnibus/post-hoc fixtures**

Cover balanced/unbalanced ANOVA, heteroscedastic Welch, tied Kruskal-Wallis,
singleton/zero-variance incompatibility, significant/non-significant omnibus,
all pairwise families, `Student t^2 == ANOVA F`, and `Welch t^2 == Welch F`.

- [ ] **Step 2: Run RED tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_independent_multi
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::post_hoc
```

- [ ] **Step 3: Implement omnibus methods/effects**

Use standard between/within ANOVA, inverse-variance Welch ANOVA with correction
and Satterthwaite df, and pooled-rank tie-corrected Kruskal-Wallis. Implement
omega squared, epsilon squared, and named Welch-F partial omega squared:

```rust
let omega_p_squared = ((f_ratio - 1.0) * df1)
    / (f_ratio * df1 + df2 + 1.0);
```

Preserve finite negative estimates.

- [ ] **Step 4: Implement post-hoc dispatch and Holm**

```rust
pub fn run_post_hoc(
    method: HypothesisTestMethodId,
    study: &NormalizedStudy,
    alpha: f64,
    confidence_level: f64,
) -> Result<PostHocResult, AppError>;
```

Run only for automatic post-hoc and `omnibus_p <= alpha`. Implement
Tukey-Kramer and Games-Howell simultaneous procedures, Dunn pooled joint ranks
with tie correction, stable Holm ordering, and deterministic compact letters in
condition order.

- [ ] **Step 5: Run GREEN tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_independent_multi
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::post_hoc
```

- [ ] **Step 6: Commit Task 5**

```bash
git add src-tauri/src/engine/hypothesis_test src-tauri/testdata/hypothesis_test/reference.json
git commit -m "feat(stats): add independent multi-group tests"
```

### Task 6: Implement Complete-Block Methods And Paired Post-Hoc

**Files:**
- Modify: `src-tauri/src/engine/hypothesis_test/methods/{parametric,rank}.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/{compatibility,effect_size}.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/post_hoc/{parametric,rank}.rs`
- Modify: `src-tauri/testdata/hypothesis_test/reference.json`

**Interfaces:**
- Consumes: complete condition-by-block matrices.
- Produces: randomized-block ANOVA, Friedman, generalized eta squared, Kendall's W, paired t-Holm, and paired Wilcoxon-Holm.

- [ ] **Step 1: Add RED complete-block fixtures**

Cover complete blocks, incomplete-block exclusions, condition ties,
all-within-block ties, minimum blocks, additive residuals, and significant/non-
significant post-hoc cases.

- [ ] **Step 2: Run RED tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_complete_block
```

- [ ] **Step 3: Implement randomized-block ANOVA**

Fit `response = grand + condition + block + residual`. Report condition, block,
residual, total sums of squares/df and use condition F as the primary test.
Return adjusted means and named/versioned generalized eta squared. Reject zero
residual df or non-finite residual mean square through compatibility.

- [ ] **Step 4: Implement Friedman and paired post-hoc**

Rank within block, average ties, apply Friedman tie correction, and calculate
Kendall's W. Reuse paired t/signed-rank per condition pair and apply Holm once
across the family, retaining each pair's exact/tie/zero audit.

- [ ] **Step 5: Run GREEN tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_complete_block
```

- [ ] **Step 6: Commit Task 6**

```bash
git add src-tauri/src/engine/hypothesis_test src-tauri/testdata/hypothesis_test/reference.json
git commit -m "feat(stats): add complete-block hypothesis tests"
```

### Task 7: Add Diagnostics, Selector, Sensitivity, And Result Assembly

**Files:**
- Create: `src-tauri/src/engine/hypothesis_test/{diagnostics,selector,result}.rs`
- Modify: `src-tauri/src/engine/hypothesis_test/mod.rs`
- Modify: `src-tauri/src/services/hypothesis_test_service.rs`
- Modify: `src-tauri/testdata/hypothesis_test/reference.json`

**Interfaces:**
- Consumes: normalized study, ten compatibility records, definition.
- Produces: diagnostics, `SelectionDecision`, execution plan, robustness status, post-hoc, warnings, audit, and finite final response.

- [ ] **Step 1: Add RED selector cases**

Include one dataset recommending each method, plus limited power,
variance/shape conflict, manual override, asymmetric paired differences,
randomized-block sensitivity, stable, alpha-crossing, direction-conflicting, and
incomparable-estimand results.

```rust
assert_eq!(plan.recommended_method, HypothesisTestMethodId::WelchTwoSampleT);
assert!(plan.reason_codes.contains(&SelectionReason::UnequalVarianceWithImbalance));
assert_eq!(plan.certainty, SelectorCertainty::Medium);
```

- [ ] **Step 2: Run RED tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::diagnostics
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::selector
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_result_assembly
```

- [ ] **Step 3: Implement diagnostic evidence**

Calculate two-pass moments, adjusted skewness/excess kurtosis, median-absolute-
deviation robust deviations, Q-Q coordinates, balance, finite variance ratio,
Brown-Forsythe over absolute median deviations, ties, zeros, and diagnostic-
power flags. Use group residuals, paired differences, or additive block
residuals. Grade each item `supports`, `opposes`, or `insufficient`. Q-Q and
Shapiro-Wilk do not add selector v1 routing thresholds.

- [ ] **Step 4: Implement selector version 1**

Keep thresholds in one `SelectorPolicyV1`. Apply compatibility, then severe
small-sample shape/influence, then independent heteroscedasticity. Material
heteroscedasticity is Brown-Forsythe `p < 0.10`, or variance ratio >2 together
with sample ratio >2; group sizes <5 make variance evidence insufficient.
Follow the exact four-family routing in the spec and emit reason codes plus
`high`/`medium`/`low` certainty.

- [ ] **Step 5: Assemble primary/sensitivity/post-hoc/audit**

Run selected primary, required sensitivity, and eligible post-hoc. Compare
direction, alpha conclusion, practical interpretation, and estimand to emit
`stable`, `statisticallySensitive`, `substantivelyConflicting`, or
`notDirectlyComparable`. Reject non-finite available values before
serialization. Never silently switch methods after execution failure.

- [ ] **Step 6: Run GREEN engine tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::diagnostics
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test::selector
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_result_assembly
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test
```

- [ ] **Step 7: Commit Task 7**

```bash
git add src-tauri/src/engine/hypothesis_test src-tauri/src/services/hypothesis_test_service.rs src-tauri/testdata/hypothesis_test/reference.json
git commit -m "feat(stats): add hypothesis test recommendation engine"
```

### Task 8: Wire IPC And Complete Analysis Stale Fencing

**Files:**
- Create: `src-tauri/src/commands/hypothesis_test_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/services/hypothesisTestService.ts`
- Modify: `src/components/analysis/analysisExecutors.ts`
- Modify: `src/components/analysis/useAnalysisExecution.ts`
- Modify: `tests/analysisExecution.test.ts`
- Modify: `tests/AnalysisExecutionHarness.tsx`
- Create: `tests/hypothesisTestAnalysisAdapter.test.ts`

**Interfaces:**
- Consumes: service/IPC contracts from Tasks 1-7.
- Produces: registered command, typed transport, exhaustive executor, full fingerprint, response identity match, stale masking.

- [ ] **Step 1: Add RED command/execution tests**

Assert one delegation, handler registration, `{ request }` transport, complete
statistical fingerprint, and exclusion of `manualSelection.reason`. Add stale
cases for roles/order, design, mode, method, alternative, alpha, confidence,
level/reference order, post-hoc, selector version, generation, and `updatedAt`.

- [ ] **Step 2: Run RED tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_commands
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestAnalysisAdapter.test.ts
```

- [ ] **Step 3: Add command and service wrapper**

```rust
#[tauri::command]
pub fn hypothesis_test(
    state: State<'_, AppState>,
    request: HypothesisTestRequest,
) -> Result<HypothesisTestResponse, AppError> {
    HypothesisTestService::new(&state).run(request)
}
```

Register module, mutation guard, and generate handler. Add the Stable Contracts
TypeScript invoke wrapper.

- [ ] **Step 4: Add exhaustive executor/stale branches**

Extend dependency/request/response maps with `runHypothesisTest`. Build the
request and stable fingerprint from every statistical input. Match response
kind, analysis ID, dataset ID, generation, revision, selector, and fingerprint.
Replace every existing Fit Model default fallthrough in `useAnalysisExecution`
with explicit four-kind dispatch.

- [ ] **Step 5: Run GREEN tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_commands
npx tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestAnalysisAdapter.test.ts
npm run test:analysis:typecheck
```

- [ ] **Step 6: Commit Task 8**

```bash
git add src-tauri/src/commands src-tauri/src/lib.rs src/services/hypothesisTestService.ts src/components/analysis/analysisExecutors.ts src/components/analysis/useAnalysisExecution.ts tests
git commit -m "feat(analysis): execute hypothesis tests through Tauri"
```

### Task 9: Add Configuration And Workspace Lifecycle

**Files:**
- Create: `src/components/hypothesisTest/{hypothesisTestConfig,HypothesisTestDialog,index}.ts(x)`
- Create: `src/components/hypothesisTest/hypothesisTest.css`
- Create: `src/components/analysis/adapters/hypothesisTestAnalysisAdapter.ts`
- Modify: `src/components/analysis/adapters/index.ts`
- Modify: `src/components/analysis/analysisEditorRegistry.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`
- Create: `tests/hypothesisTestConfig.test.ts`
- Create: `tests/workspaceHypothesisTest.test.ts`
- Modify: `tests/workspaceAnalysis.test.ts`
- Modify: `tests/workspaceAnalysisLifecycle.test.ts`

**Interfaces:**
- Consumes: definition, common Analysis store/lifecycle, column metadata.
- Produces: validated dialog, document factory/editor patch, menu, create/edit/history/source-retention behavior.

- [ ] **Step 1: Add RED pure config tests**

Test long roles, paired-long subject requirement, two unique wide measurements,
continuous types, unique subject, mode/manual invariants, alpha/confidence,
known one-sided multi-group rejection, and compatibility labels for ten methods.

- [ ] **Step 2: Add RED Workspace contracts**

Assert `showHypothesisTestDialog`, `createHypothesisTestAnalysisDocument`,
`addAnalysis`, `activateWorkspaceDocument("analysis", id)`, common editor
registry, source retention, and absence of a parallel store/folder map.

- [ ] **Step 3: Run RED tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceHypothesisTest.test.ts
```

- [ ] **Step 4: Implement pure validation/adaptation**

```ts
export function validateHypothesisTestDefinition(
  definition: HypothesisTestAnalysisDefinition,
): { ok: true } | { ok: false; code: HypothesisTestConfigError };

export function createHypothesisTestAnalysisDocument(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  definition: HypothesisTestAnalysisDefinition;
  createdAt: string;
}): HypothesisTestAnalysisDocument;
```

Deep-clone roles, increment revision only for statistical definition changes,
preserve source, and summarize layout, fields, design, mode, and selected state
without results.

- [ ] **Step 5: Implement dialog**

Use segmented controls for layout/design/mode, role slots, menus for method,
alternative and post-hoc, and numeric alpha/confidence controls. Show accessible
disabled reasons. Automatic clears manual selection; guided persists after
confirmation; manual requires compatible choice. Use metadata only for
structural preflight, never frontend diagnostics.

- [ ] **Step 6: Wire Workspace and locales**

Add `Analyze > Hypothesis Test`, create/activate one Analysis, mark dirty,
record history, and enter rename. Route editing through the registry and common
lifecycle. Add all roles, methods, modes, reason/warning/result/audit/history
strings to all four locales.

- [ ] **Step 7: Run GREEN lifecycle tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceHypothesisTest.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisLifecycle.test.ts
npm run test:analysis:typecheck
```

- [ ] **Step 8: Commit Task 9**

```bash
git add src/components/hypothesisTest src/components/analysis/adapters src/components/analysis/analysisEditorRegistry.ts src/components/Workspace.tsx src/i18n/locales tests
git commit -m "feat(analysis): add hypothesis test workflow"
```

### Task 10: Render Decision-First Results And Graphs

**Files:**
- Create: `src/components/analysis/renderers/{hypothesisTestAnalysisModel,hypothesisTestGraphOptions}.ts`
- Create: `src/components/analysis/renderers/{HypothesisTestAnalysisReport,HypothesisTestAnalysisResults}.tsx`
- Modify: `src/components/analysis/analysisViewRegistry.tsx`
- Modify: `src/components/analysis/analysis.css`
- Create: `tests/hypothesisTestReport.test.ts`
- Create: `tests/HypothesisTestHarness.tsx`
- Create: `tests/hypothesisTest.spec.tsx`
- Modify: `tests/AnalysisViewHarness.tsx`
- Modify: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: stale-fenced response and Analysis host edit actions.
- Produces: conclusion, estimates, graphs, evidence, sensitivity, post-hoc, exclusions, audit.

- [ ] **Step 1: Add RED model/structure/component tests**

Cover success, loading, source missing, typed error, warning/degraded exact,
stable/conflicting sensitivity, absent and five-family post-hoc, and unavailable
intervals. Require all shared Analysis primitives; reject legacy report imports,
raw result `<table>`, and raw action `<button>`.

- [ ] **Step 2: Run RED tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestReport.test.ts
npx playwright test -c playwright-ct.config.ts tests/hypothesisTest.spec.tsx
```

- [ ] **Step 3: Implement display model**

Map typed response to `AnalysisTable` rows without changing values. Localize and
format only at cells. Build conclusion from backend conclusion/robustness codes,
never by re-testing p-values in React.

- [ ] **Step 4: Implement graph options**

Use backend coordinates for independent raw/distribution/interval views, paired
subject/difference views, block profiles/estimates, and Q-Q/residual diagnostics.
Keep category order stable. Any jitter is deterministic by row identity and
presentational only. Use bounded responsive heights and `AnalysisGraph` custom
strategies.

- [ ] **Step 5: Compose live result**

Use `AnalysisShell`, then conclusion, core estimate, main graph, evidence,
sensitivity, post-hoc, exclusions, audit frames. Keep sensitivity conflict in
the first frame even if details collapse. Do not nest cards. Respect read-only.

- [ ] **Step 6: Run GREEN UI tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestReport.test.ts
npx playwright test -c playwright-ct.config.ts tests/hypothesisTest.spec.tsx
npm run test:analysis:ui
```

- [ ] **Step 7: Commit Task 10**

```bash
git add src/components/analysis tests
git commit -m "feat(analysis): present hypothesis test decisions"
```

### Task 11: Add Report Embedding And Project Round Trips

**Files:**
- Create: `src/components/report/HypothesisTestAnalysisReportEmbed.tsx`
- Modify: `src/components/report/ReportEmbed.tsx`
- Modify: `src/types/report.ts`
- Modify: `src/components/report/reportDependencyTokens.ts`
- Modify: `src/components/report/ReportDependencyDialog.tsx`
- Create: `tests/hypothesisTestReportWiring.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/reportDependencyTokens.test.ts`
- Modify: `tests/reportEmbed.test.ts`

**Interfaces:**
- Consumes: report policy, execution hook, reusable report body.
- Produces: typed dependency resolution, isolated execution, token and project round trips.

- [ ] **Step 1: Add RED dependency tests**

Assert resolution only through `analysisReportPolicies.hypothesisTest`, source
dataset requirement, distinct resolved source, same-ID wrong-kind rejection,
and dependency token round trip.

- [ ] **Step 2: Run RED report tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestReportWiring.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportDependencyTokens.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportEmbed.test.ts
```

- [ ] **Step 3: Extend dependency and embed**

Add `hypothesisTest` to dependency types, tokens, dialog, resolved maps, runtime,
labels, and exhaustive resolver. Lazy-load the embed. It calls
`useAnalysisExecution` and renders `HypothesisTestAnalysisReport`, without a
second shell or copied result logic.

- [ ] **Step 4: Add round-trip coverage**

Save/reopen long automatic and wide manual analyses plus one report dependency.
Assert definition, presentation, folder, manual reason, selector, and token
persist, while results never enter `.span` or Markdown.

- [ ] **Step 5: Run GREEN tests**

```bash
npx tsx --tsconfig tsconfig.app.json tests/hypothesisTestReportWiring.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportDependencyTokens.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportEmbed.test.ts
npx tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test_analysis
```

- [ ] **Step 6: Commit Task 11**

```bash
git add src/components/report src/types/report.ts tests src-tauri/src/services/spprj_archive.rs
git commit -m "feat(report): embed hypothesis test analyses"
```

### Task 12: Integrate Suites, Run Full Gates, And Perform Acceptance

**Files:**
- Modify: `package.json`
- Modify: `tests/tsconfig.analysis-typecheck.json`
- Modify: focused Issue 66 files only if a gate exposes an Issue 66 defect.
- Modify: `docs/analysis-development-standard.md` only for a genuinely reusable rule discovered during implementation.

**Interfaces:**
- Consumes: Tasks 1-11.
- Produces: named suites, full verification evidence, running isolated Tauri artifact, independent review, manual-acceptance handoff.

- [ ] **Step 1: Add package scripts and Analysis gate integration**

```json
"test:hypothesis-test:contracts": "tsx --tsconfig tsconfig.app.json tests/hypothesisTestContracts.test.ts && tsx --tsconfig tsconfig.app.json tests/hypothesisTestConfig.test.ts && tsx --tsconfig tsconfig.app.json tests/hypothesisTestAnalysisAdapter.test.ts && tsx --tsconfig tsconfig.app.json tests/hypothesisTestArchive.test.ts && tsx --tsconfig tsconfig.app.json tests/hypothesisTestReportWiring.test.ts && tsx --tsconfig tsconfig.app.json tests/workspaceHypothesisTest.test.ts",
"test:hypothesis-test:report": "tsx --tsconfig tsconfig.app.json tests/hypothesisTestReport.test.ts",
"test:hypothesis-test:ui": "playwright test -c playwright-ct.config.ts tests/hypothesisTest.spec.tsx",
"test:hypothesis-test": "npm run test:hypothesis-test:contracts && npm run test:hypothesis-test:report && npm run test:hypothesis-test:ui"
```

Append Hypothesis Test adapter/report tests to `test:analysis:kinds` and its
component spec to `test:analysis:ui`.

- [ ] **Step 2: Run focused suites**

```bash
npm run test:hypothesis-test
cargo test --manifest-path src-tauri/Cargo.toml hypothesis_test
```

Expected: PASS with all ten method IDs represented.

- [ ] **Step 3: Run complete gates**

```bash
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git --no-pager diff --no-ext-diff --check
```

Expected: every command exits 0. Prove unrelated failures on untouched base;
do not weaken tests or fix unrelated behavior.

- [ ] **Step 4: Inspect bounded status/diff**

```bash
git status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat
```

Inspect intended paths only. Exclude generated output, credentials, failed-test
snapshots, and unrelated changes.

- [ ] **Step 5: Start and bind isolated Tauri runtime**

```bash
npm --prefix <issue-66-worktree> run tauri -- dev
```

Use another port if 1420 is occupied; do not stop unrelated worktrees. Verify
Vite source, process cwd, executable, and port all belong to Issue 66.

- [ ] **Step 6: Perform visual/behavioral acceptance**

Exercise both layouts; all ten recommendation/manual paths; all five post-hoc
families; incomplete pair/block exclusion; sensitivity conflict; exact, tied,
zero, and over-budget paths; typed degenerate errors; report embedding; and
save/reopen. Check desktop/narrow English and Chinese layouts. Capture main
independent, paired, block, conflict, post-hoc, and narrow screenshots. Verify
nonblank charts with canvas pixels or ECharts series state, not container DOM.

- [ ] **Step 7: Commit final gate integration**

```bash
git add package.json tests/tsconfig.analysis-typecheck.json
git add <only Issue 66 source/test/docs repaired during final gates>
git commit -m "test(analysis): complete hypothesis test validation"
```

Omit unchanged paths and do not create an empty commit.

- [ ] **Step 8: Independent review and manual acceptance gate**

Review actual commits and untracked files against Issue 66, base SHA, numerical
contracts, selector policy, stale fencing, and presentation rules. Repair all
Critical/Important findings and rerun affected gates. Then provide worktree,
runtime, checklist, evidence, limitations, and screenshots to the user. Stop
for explicit manual acceptance before push or PR creation under the GitHub Issue
lifecycle.

## Final Definition Of Done

- All ten methods have independent numerical reference coverage.
- Four study structures and both layouts work and agree for equivalent data.
- Automatic selection is deterministic, versioned, and explained.
- Guided/manual selection cannot bypass compatibility.
- Sensitivity conflicts and incomparable estimands remain visible live and embedded.
- Five post-hoc mappings and multiplicity labels are correct.
- Exact/asymptotic path, ties, zeros, corrections, exclusions, and formulas are auditable.
- Descriptor, executor, view, editor, graph, report, archive, and tests are exhaustive.
- Project/report round trips persist definitions only and recompute results.
- Full frontend, Rust, Analysis, build, clippy, diff, independent review, visual, and manual gates pass before PR creation.
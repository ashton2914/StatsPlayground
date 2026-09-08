# Issue 126 Fit Y by X Analysis Frame Redesign

## Purpose

Refactor Fit Y by X into the shared Analysis architecture established by
Distribution. Fit Y by X becomes the second registered Analysis kind. The
existing Rust statistics remain authoritative, while the frontend owns typed
request construction, synchronous presentation, persisted definitions, and
stale-result rejection.

This redesign replaces the discarded Issue 126 implementation. It preserves
the approved product behavior but follows the current Analysis development
standard and keeps every kind-specific registration layer explicit.

## Product Behavior

- Opening a project containing legacy `.spf` Fit Y by X documents migrates
  them to `.span` Analysis documents.
- Migration preserves document ID, name, source dataset, creation time,
  statistical inputs, graph presentation, and folder assignment.
- A legacy Report embed with `kind="fitYByX"` resolves the migrated Analysis
  by the same document ID without rewriting Report markdown.
- Deleting a source dataset retains the Analysis document and presents a
  source-unavailable state.
- Editing a graph axis or other presentation setting does not increment the
  statistical `configRevision` or trigger recomputation.
- Editing response, factor, personality, or confidence level increments
  `configRevision` and triggers a newly fenced execution.
- New project saves persist Fit Y by X only through the Analysis document and
  Analysis folder collections. Legacy archive fields remain read-compatible
  migration inputs and are not new-write targets.

## Governing Constraints

- Follow `docs/analysis-development-standard.md` and the scoped Analysis
  development instructions.
- Treat Distribution as the reference implementation.
- Persist only user-authored definition and presentation state.
- Keep Rust as the sole statistical authority; do not add frontend fallback
  statistics.
- Register Fit Y by X exhaustively in every layer-local Analysis registry.
- Preserve the complete stale fence: kind, document ID, config revision,
  dataset ID, dataset generation, dataset update version, definition
  fingerprint, request identity, and request token.
- Mask stale success synchronously before paint.
- Represent unsupported capabilities with a truthful `false` descriptor and
  a `null` policy.
- Keep the JSON kind manifest, TypeScript document contract, and Rust archive
  validators in exact parity.
- Do not introduce a runtime plugin loader or universal result schema.

## Chosen Architecture

Use a vertical, layer-local registration for the new kind. Legacy Fit Y by X
types and persistence fields exist only at compatibility boundaries during the
migration. The live Workspace, execution, rendering, graph editing, and Report
paths use `AnalysisDocument` ownership exclusively.

The rejected alternatives are:

- Wrapping the legacy Fit Y by X view inside Analysis. This retains parallel
  execution and state ownership and does not satisfy the Analysis standard.
- Migrating the complete document in Rust. This would make the archive layer
  responsible for frontend graph presentation conversion and diverge from the
  Distribution migration boundary.

## Persisted Contract

Add `fitYByX` to `contracts/analysis/kinds.v1.json` with explicit document,
definition, presentation, and layout identities. Add a corresponding member
to the TypeScript `AnalysisDocument` discriminated union and
`AnalysisDocumentByKind` mapping.

The kind-specific definition contains:

- `kind: "fitYByX"`
- response field reference
- factor field reference
- derived personality (`oneway` or `bivariate`)
- confidence level

The kind-specific presentation contains:

- its own schema version and layout identity
- the normalized embedded graph configuration

Computed results, report rows, graph packets, and generated text are never
persisted. The Rust archive validator selects the Fit Y by X validator only
when both `analysisKind` and `definition.kind` are `fitYByX`, then validates
the nested definition and presentation shapes explicitly.

## Legacy Migration

Add a deterministic Fit Y by X migration adapter beside the Distribution
migration adapter. Project hydration performs these operations before loading
the shared Analysis store:

1. Validate every legacy Fit Y by X document needed for conversion.
2. Convert it to a Fit Y by X Analysis document with the same stable ID.
3. Normalize the legacy graph into the Fit Y by X presentation contract.
4. Merge its folder assignment into `analysisFolders`.
5. Reject duplicate IDs across legacy Fit Y by X and existing Analysis
   documents with a clear migration error. Never generate a replacement ID.
6. Return empty live legacy Fit Y by X collections after successful migration.
7. Mark the project dirty so the next save writes only the Analysis form.

Migration does not compute statistics. Invalid legacy content remains an
explicit load failure rather than being partially repaired or silently
dropped.

## Execution

Register a Fit Y by X executor in `analysisExecutors.ts`. It:

- constructs the existing typed `FitYByXRequest` from the Analysis definition
  and current dataset generation;
- fingerprints only statistical inputs and stable source identity;
- resolves the existing Fit Y by X service transport;
- calls the Rust-backed compute service;
- verifies echoed request identity available in the response contract;
- normalizes errors without leaking machine-local paths.

`useAnalysisExecution` remains the mounted execution authority. It dispatches
by Analysis kind and retains the complete fence for both Distribution and Fit
Y by X. A document, dataset, or request change returns a masked loading state
synchronously; a late response may not paint or overwrite newer state.

## Presentation And Editing

Register a synchronous Fit Y by X renderer in `analysisViewRegistry.tsx`. The
renderer composes Oneway, Bivariate, loading, error, not-computable, and
source-unavailable states from the shared Analysis presentation primitives.
It does not own an effect, call a service, or use the legacy report hook.

The result composition uses:

- `AnalysisShell` for the document envelope and input-edit action;
- `AnalysisFrame` and `AnalysisStack` for hierarchy and disclosure;
- `AnalysisTable` for summary, ANOVA, lack-of-fit, parameter estimate, group
  summary, and effect-size tables;
- `AnalysisGraph` for the normalized embedded graph;
- `AnalysisText` for equations, status, and explicit unavailable messages.

Register an editor adapter that reuses the existing role-selection interaction
but reads and writes the Fit Y by X Analysis definition. The adapter emits a
revisioned statistical patch. Workspace rename remains the only name-edit
path.

Register graph persistence independently from report embedding. Graph patches
write only `presentation.graph` and declare that they do not change
statistical inputs. Fit Y by X report embedding is supported and receives an
explicit non-null report policy.

## Workspace Ownership

Workspace creation produces one Fit Y by X Analysis document and adds it to
the shared Analysis store. Selection, folder movement, rename, delete,
history, project save/open, and source retention use the existing Analysis
lifecycle.

After the Analysis-backed path is covered, remove live dependencies on:

- `useFitYByXStore`;
- `activeFitYByXId`;
- `fitYByXFolders` as a live folder namespace;
- legacy Fit Y by X selection, rename, delete, and cascade-delete branches;
- `FitYByXView` and `useFitYByXReport` as live Workspace execution paths.

Compatibility types and archive fields may remain where required to read old
projects. Their presence must not create a second runtime lifecycle.

## Report Compatibility

Keep the existing Report markdown grammar for `kind="fitYByX"`. Dependency
resolution looks up a Fit Y by X `AnalysisDocument` by ID and verifies that its
source dataset is available. Rendering uses the Analysis report policy and
the shared execution contract rather than the legacy store or report hook.

The Report editor continues to list Fit Y by X under its existing user-facing
group, but options come from Analysis documents filtered by kind. Missing or
wrong-kind IDs produce the existing unavailable state instead of falling back
to another Analysis kind.

## Error Handling

- Contract identity mismatch: reject at archive validation or migration.
- Legacy/current ID collision: reject project hydration with the conflicting
  ID in a path-safe message.
- Missing source dataset: retain and render the document as unavailable; do
  not execute.
- Invalid role combination: prevent creation or revision through the editor
  adapter and preserve the last valid document.
- Stale or mismatched response: synchronously mask and ignore it.
- Unsupported schema, layout, graph, or report policy: fail explicitly; never
  dispatch to Distribution or a generic fallback.

## Implementation Sequence

1. Add RED contract and migration tests, then add the manifest, TypeScript
   document member, Rust validator, and migration adapter.
2. Add RED execution and stale-fence tests, then register the typed executor.
3. Add RED renderer and editor tests, then implement synchronous presentation
   and revisioned input patches.
4. Add RED graph-policy tests, then persist presentation-only graph changes.
5. Add RED Workspace lifecycle tests, then move creation and document
   ownership to the shared Analysis store.
6. Add RED Report compatibility tests, then resolve and render Fit Y by X from
   Analysis documents.
7. Add absence tests for legacy runtime ownership, remove obsolete live paths,
   and rerun the affected suites.

Each task uses the smallest focused check immediately after its first
substantive edit. A failed check is repaired within the same layer before the
scope expands.

## Verification

Required automated gate:

- `npm run test:analysis:typecheck`
- `npm run test:analysis:contracts`
- `npm run test:analysis:kinds`
- `npm run test:analysis:ui`
- `npm run test:analysis`
- focused Fit Y by X method, migration, Workspace, Report, and archive suites
- `cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts`
- affected Rust Fit Y by X and archive tests
- `npm run build`
- `git diff --check`

An independent review must inspect the complete branch diff against the
confirmed base and report Critical or Important findings before manual
acceptance.

## Manual Acceptance

1. Open a project with a legacy `.spf` Fit Y by X document and verify the same
   ID, name, inputs, graph, and folder appear as a `.span` Analysis.
2. Create Oneway and Bivariate Fit Y by X analyses and verify their Rust-backed
   results and graph composition.
3. Edit statistical inputs and verify one new execution with a bumped
   `configRevision`.
4. Change and reset axis settings and verify presentation persistence without
   statistical recomputation.
5. Rapidly switch analyses or revise inputs and verify stale results never
   paint.
6. Open a Report containing a legacy Fit Y by X embed and verify it resolves
   the migrated Analysis without markdown changes.
7. Delete the source dataset and verify the Analysis remains visible with a
   source-unavailable state.
8. Save and reopen the project and verify no new legacy Fit Y by X document is
   written.

Commit, push, pull request creation, merge, and cleanup remain separate
authorization gates under the repository development workflow.
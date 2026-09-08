# Analysis Development Standard

This document defines the required path for adding or changing an Analysis kind. Distribution and Fit Y by X are the reference implementations for shared Analysis composition.

## Architecture Rules

1. An Analysis document persists user-authored definitions and presentation configuration only. Never persist computed results, report blocks, graph frames, or generated markdown.
2. Rust is the statistical authority. Frontend code constructs typed requests, presents responses, and rejects mismatched response identities; it must not provide a statistical fallback.
3. Execution must fence every asynchronous result by Analysis kind, document ID, configuration revision, dataset ID, dataset generation, dataset update version, definition fingerprint, request identity, and request token. Stale results must be masked synchronously before paint.
4. Analysis views use the shared shell and presentation primitives under `src/components/analysis/presentation/`. A kind renderer must directly compose its result hierarchy with `AnalysisFrame`, `AnalysisStack`, `AnalysisText`, `AnalysisTable`, `AnalysisButton`, and `AnalysisGraph` as applicable. It must not wrap or delegate to a legacy report or view surface. Result tables use `AnalysisTable`, and result actions use `AnalysisButton`; native `<table>` and native action `<button>` markup are reserved for implementation inside the shared primitives or controls with semantics those primitives do not support.
5. Analysis documents use the common Zustand store, Workspace selection, project save/open, folder, rename, delete, source-retention, and history lifecycle. A kind must not introduce a parallel document lifecycle.
6. Registration is layer-local and exhaustive. Every kind must be present in the descriptor, executor, view, editor, graph, and report policy records. Dispatch must not fall back to another kind.
7. Unsupported capabilities are explicit. A missing implementation is represented by a `null` policy and a `false` descriptor capability, not placeholder syntax or a generic implementation.
8. `contracts/analysis/kinds.v1.json` is the cross-language identity contract. TypeScript registration and Rust archive validation must match its kind, definition, document schema, presentation schema, and layout exactly.
9. Analysis result typography, spacing, borders, disclosure headers, table cells, and action controls inherit from shared presentation tokens and classes. Kind CSS may size or arrange genuinely kind-specific content such as a chart canvas or profiler control, but it must not recreate the shared report shell, frame, table, button, or text system.

## Persisted Contract

Each kind defines a discriminated `AnalysisDocument` member and an `AnalysisDocumentByKind` mapping in `src/types/analysis.ts`. The outer document contract stays stable: schema and document identity, revision, source dataset, kind-specific definition, presentation identity, and timestamps.

The Rust archive validator must select an explicit validator by both `analysisKind` and `definition.kind`, validate the shared identity contract, then perform method-specific nested validation. Do not infer a universal result schema or generic statistical rules.

## Registration Checklist

1. Add the kind identity to `contracts/analysis/kinds.v1.json` and the matching TypeScript document union member.
2. Add descriptor identity, schema, valid locale keys, and truthful capability flags.
3. Register request construction, definition fingerprinting, dependencies, compute transport, response identity matching, and error normalization in `analysisExecutors.ts`.
4. Add a synchronous renderer and register it in `analysisViewRegistry.tsx`; keep `AnalysisView.tsx` limited to envelope/schema handling and dispatch.
5. Register editor conversion and revisioned input patches in `analysisEditorRegistry.ts`.
6. Register graph persistence behavior or `null`, and state whether the patch changes statistical inputs. Register report embedding behavior or `null` independently.
7. Add an explicit Rust validator contract and method-specific validator coverage.
8. Extend the registration contract test and the kind's focused method suite without duplicating feature tests.
9. Add a source or rendered-structure contract that rejects legacy report delegation and raw result table/action markup, and asserts the shared presentation primitives used by the kind.
10. Add visual acceptance at desktop and narrow widths for frame nesting, typography, table scrolling, graph sizing, and the absence of page-level overflow.

## Required Gate

- `npm run test:analysis:typecheck`
- `npm run test:analysis:contracts`
- `npm run test:analysis:kinds`
- `npm run test:analysis:ui`
- `npm run test:analysis`
- `cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts`
- `npm run build`

The method suite must exercise each registered kind through meaningful existing tests. Distribution is currently the complete method suite; adding a future kind requires adding its focused tests to `test:analysis:kinds`.

Passing automated gates is not a substitute for visual acceptance of a new or migrated Analysis kind. Compare the running desktop surface with the reference kinds before declaring the migration complete.
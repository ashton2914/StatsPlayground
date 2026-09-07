# Analysis Development Standard

This document defines the required path for adding or changing an Analysis kind. Distribution is the reference implementation and the only currently registered Analysis kind.

## Architecture Rules

1. An Analysis document persists user-authored definitions and presentation configuration only. Never persist computed results, report blocks, graph frames, or generated markdown.
2. Rust is the statistical authority. Frontend code constructs typed requests, presents responses, and rejects mismatched response identities; it must not provide a statistical fallback.
3. Execution must fence every asynchronous result by Analysis kind, document ID, configuration revision, dataset ID, dataset generation, dataset update version, definition fingerprint, request identity, and request token. Stale results must be masked synchronously before paint.
4. Analysis views use the shared shell and presentation primitives under `src/components/analysis/presentation/`. Kind renderers remain synchronous and own only kind-specific result composition.
5. Analysis documents use the common Zustand store, Workspace selection, project save/open, folder, rename, delete, source-retention, and history lifecycle. A kind must not introduce a parallel document lifecycle.
6. Registration is layer-local and exhaustive. Every kind must be present in the descriptor, executor, view, editor, graph, and report policy records. Dispatch must not fall back to another kind.
7. Unsupported capabilities are explicit. A missing implementation is represented by a `null` policy and a `false` descriptor capability, not placeholder syntax or a generic implementation.
8. `contracts/analysis/kinds.v1.json` is the cross-language identity contract. TypeScript registration and Rust archive validation must match its kind, definition, document schema, presentation schema, and layout exactly.

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

## Required Gate

- `npm run test:analysis:typecheck`
- `npm run test:analysis:contracts`
- `npm run test:analysis:kinds`
- `npm run test:analysis:ui`
- `npm run test:analysis`
- `cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts`
- `npm run build`

The method suite must exercise each registered kind through meaningful existing tests. Distribution is currently the complete method suite; adding a future kind requires adding its focused tests to `test:analysis:kinds`.
# Task 4 Report

## Status

- Complete.
- Extracted a shared read-only graph runtime into `GraphRuntime.tsx` and a pure derivation layer into `graphRuntimeModel.ts`.
- `GraphRuntime` does not import or mutate `useGraphBuilderStore`.
- `GraphBuilderView` remains the mutating shell for slots, filters, layers, axis dialogs, and store writes.

## Commit

- Requested message: `refactor(graph): extract reusable graph runtime`

## Verification

- RED confirmed first: `tests/graphRuntime.test.ts` failed because `graphRuntimeModel.ts` did not exist.
- GREEN verification:
  - `graphRuntime` contract test passed.
  - `graphDataPipeline` test passed with the new equivalent interactive vs embedded request assertion.
  - `graphBuilderMode` regression test passed.
  - `npx vite build` passed.
- Focused test harness note: `graphDataPipeline.test.ts` had to run as a bundled CommonJS file because its TypeScript AST inspection path triggers Node `dynamic require` failures under an ESM esbuild bundle in this environment.

## Self Review

- Interaction callbacks: point pick, brush select, axis double-click, axis context menu, and axis range change now flow from `GraphBuilderView` into `GraphRuntime` without store access inside the runtime.
- Request fencing: request derivation remains in `useGraphDataPipeline`; equivalent embedded and interactive items now have direct parity assertions.
- Metadata loading: column names, SQL types, value orders, and display props are loaded once inside `GraphRuntime` and surfaced back to the shell as read-only runtime state.
- 2D/3D/multivariate dispatch: the runtime computes one shared model and keeps multivariate empty-state handling and warning overlay separation intact.
- Progress and errors: pipeline status, progress, metadata loading/error state, and raw-point omission notices are owned by the runtime and reported upward for the shell toolbar.
- Source equivalence: `buildGraphRuntimeModel` and `deriveGraphRequestParts` now have explicit equivalence checks for normalized interactive vs embedded graph items.

## Concerns

- The focused pipeline verification uses a CJS bundle because of the existing TypeScript AST test harness shape; production behavior is unaffected, but the verification command is slightly different from the original ESM sketch.
- `GraphRuntime` now statically imports `dataService`, which keeps behavior correct and the build green, but Vite still reports the pre-existing mixed static/dynamic import chunking warning for that module.
# Task 6 Report

## Status

Complete.

## Scope

Shared Graph and Report application commands were added to the application runtime so UI and MCP callers can execute the same command handlers. The implementation covers command registration, runtime document revision fencing, report embed validation, graph normalization, coalesced report history flushing, and UI migration onto the shared command path.

## Files Changed

- src/applicationCommands/applicationRuntime.ts
- src/applicationCommands/graphCommands.ts
- src/applicationCommands/reportCommands.ts
- src/applicationCommands/types.ts
- src/components/Workspace.tsx
- src/components/graphBuilder/GraphBuilderView.tsx
- src/i18n/locales/en.json
- src/i18n/locales/vi.json
- src/i18n/locales/zh-CN.json
- src/i18n/locales/zh-TW.json
- src/stores/useGraphBuilderStore.ts
- src/stores/useReportStore.ts
- tests/applicationCommandGraph.test.ts
- tests/applicationCommandReport.test.ts
- tests/workspaceReport.test.ts

## RED Evidence

Graph RED started from the new focused command test. During green validation, the first Graph test run failed because the expected object shape did not include canonical normalization fields (`sampling` and `groupThemeSlots`). That failure confirmed the new handler was returning normalized graph documents. The test expectation was corrected to assert the normalized shape.

Report RED was covered by the new focused command test and by the recreated Workspace source-contract test. A later focused run of `tests/workspaceReport.test.ts` failed twice during integration:

- first on an accidental duplicate test body appended into the file
- then on a real async flush bug where `flushPendingReportHistory()` was still fire-and-forget in close/open teardown paths

Both failures were repaired locally and the same focused test was rerun to green.

## Implementation Notes

### Shared command runtime

- Registered `graph.create`, `graph.update`, `report.create`, and `report.update` in `applicationRuntime`.
- Exposed `flushPendingEffects()` from the runtime so report coalescing can be flushed before save, selection changes, and teardown.

### Graph commands

- Added `graphCommands.ts` with shared handlers for create and update.
- Create allocates a basename through the project naming policy, seeds default 2D/3D/multivariate mode state, normalizes every new graph through `normalizeGraphBuilderItem`, initializes runtime-only document revision `1`, activates selection, marks dirty, and records history.
- Update rejects stale `expectedDocumentRevision`, enforces `definition.id === graphId`, validates the source dataset, normalizes the full definition, returns `changed: false` for no-op updates, and increments runtime-only document revision on real edits.

### Report commands

- Added `reportCommands.ts` with shared handlers for create/update and a coalesced `flushPendingHistory()` helper.
- Update parses markdown with `parseReportMarkdown`, validates embeds through `extractReportDependencies`, rejects stale `expectedDocumentRevision`, returns `changed: false` for no-op edits, increments runtime-only document revision on success, and coalesces `history.editReport` until explicitly flushed.

### Store/runtime state

- Added runtime-only `documentRevisions` tracking to graph and report stores.
- Kept persisted project/archive schemas unchanged.

### UI migration

- `GraphBuilderView` now routes graph mutations through `applicationRuntime.execute({ type: "graph.update" ... })` and preserves direct `markDirty()` only for non-command dataset filter paths.
- `Workspace` now routes report edits and document creation through shared commands, flushes pending report effects before save/selection changes/close/open, and retains the existing direct `.spgh` import path for imported graph files.

### Localization

- Added the missing `history.editGraph` locale string in all supported locale files.

## Validation

Focused validations executed successfully in the isolated worktree via VS Code tasks using the worktree tsconfig:

1. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/applicationCommandGraph.test.ts`
   - Result: `application command graph lifecycle OK`
2. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/applicationCommandReport.test.ts`
   - Result: `application command report lifecycle OK`
3. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/graphBuilderMode.test.ts`
   - Result: `graphBuilderMode migration tests passed`
4. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/reportParser.test.ts`
   - Result: `report-parser contract passed`
5. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/workspaceReport.test.ts`
   - Result: `Workspace report integration contract passed`
6. `npm run build --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer`
   - Result: success (`tsc -b && vite build`)

Notes on validation environment:

- Direct terminal execution of some commands returned unusable truncated output in this session, so the reliable evidence came from the VS Code task runner.
- The production build still reports pre-existing Vite chunking warnings about mixed dynamic/static imports and large output chunks, but the build succeeds.

## Self-Review

- Graph and Report mutations now share the same command entry points for UI and MCP callers.
- Report teardown paths now await flushes before reset/save boundaries, fixing the stale pending-history race.
- Graph updates are canonicalized through `normalizeGraphBuilderItem` on every update path.
- Report embeds are validated against current project objects before state/history mutation.

## Commit

Requested commit message: `refactor(documents): share graph and report commands`

Commit SHA: recorded after commit creation.

## Concerns

- The `.spgh` import flow still uses the existing direct store add path rather than a shared command because imported graph payloads are materially different from `graph.create`; this preserves current behavior but leaves import outside the new command surface.
- Vite build warnings about chunk size and mixed dynamic/static imports remain unchanged and were not part of this task.

## Fix Round 1

### Status

Complete for the Task 6 review findings in `task-6-review.md`: 3 Important findings addressed and the Minor coverage gap strengthened.

### RED Evidence

1. Graph canonical no-op regression:
   - Added a focused `graph.update` test proving a definition that differs only by storage-canonicalized `groupThemeSlots` must be a no-op.
   - Initial RED failure: `AssertionError [ERR_ASSERTION]: true !== false` at `tests/applicationCommandGraph.test.ts:338`, showing the command reported `changed: true` for a persisted no-op.
2. Awaitable report drain boundary:
   - Added a behavioral `workspaceReport.test.ts` case that registers a queued report write with the runtime, calls the drain boundary, then proves the markdown update and coalesced edit history are both complete before the drain resolves.
   - Initial RED failure: `TypeError: runtime.registerPendingEffectsDrain is not a function` at `tests/workspaceReport.test.ts:232`, showing the awaitable boundary did not exist.
3. Graph dirty ownership leakage:
   - Strengthened focused view tests to assert field-binding and graph-update paths in `GraphBuilderView` do not call direct `markDirty()`, while dataset-filter paths still do.

### Fixes

1. Shared Graph canonicalization:
   - Exported `normalizeStoredGraphBuilderItem` from `useGraphBuilderStore.ts`.
   - Switched `graphCommands.ts` and the graph command harness to use the exact persisted-storage canonicalizer for create/update/no-op comparison.
2. Awaitable runtime drain lifecycle:
   - Extended `applicationRuntime` with `registerPendingEffectsDrain()`, async `flushPendingEffects()`, and async `shutdown()`.
   - Registered the Workspace report-update queue with the runtime drain boundary.
   - Made report selection/save/open/close boundaries await `applicationRuntime.flushPendingEffects()` before mutating selection or tearing down state.
   - Kept unmount cleanup as fallback only via `void applicationRuntime.shutdown()`.
3. Graph command ownership cleanup:
   - Removed direct `markDirty()` calls from command-backed GraphBuilderView update paths for reconciled theme slots, slot binding, and sampling changes.
   - Preserved direct dirty behavior only where dataset filters are mutated.

### Exact Validation Outputs

1. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/applicationCommandGraph.test.ts`
   - `application command graph lifecycle OK`
2. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/applicationCommandReport.test.ts`
   - `application command report lifecycle OK`
3. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/graphBuilderMode.test.ts`
   - `graphBuilderMode migration tests passed`
4. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/reportParser.test.ts`
   - `report-parser contract passed`
5. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/workspaceReport.test.ts`
   - `Workspace report integration contract passed`
6. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/axisBinding.test.ts`
   - `axis binding helper checks passed`
7. `npx tsx --tsconfig /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tsconfig.app.json /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer/tests/datasetFilterViews.test.ts`
   - `dataset Filter view ownership passed`
8. `npm run build --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/188-mcp-command-layer`
   - `> stats-playground@0.1.0 build`
   - `> tsc -b && vite build`
   - `✓ built in 3.63s`

### Self-Review

- The Graph command now decides no-op semantics with the same canonicalization that persisted storage uses.
- The report flush path now has one explicit awaited lifecycle boundary instead of relying on cleanup-side fire-and-forget behavior.
- `GraphBuilderView` now leaves Graph dirty/history/project revision ownership to `graph.update`, with dataset filters remaining the only direct dirty side path.
- The previous `workspaceReport.test.ts` source-only coverage now includes a real async drain behavior assertion.

### Concerns

- The report file cannot contain the exact SHA of the same commit that records this section without a second post-commit edit; the resulting fix commit SHA is therefore recorded from `HEAD` immediately after commit creation.
- Existing Vite warnings about mixed dynamic/static imports and chunk size remain unchanged.

### Commit

- Commit message: `fix(documents): drain report effects and unify graph no-op semantics`
- Commit SHA: recorded from `HEAD` immediately after commit creation.
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
# Issue 92 Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class `.sprp` Report documents with Markdown editing, live previews, stable-ID embeds of every DIRECTORY document type on the local `dev` baseline, and format 4 project persistence.

**Architecture:** A frontend-owned `ReportItem` stores versioned Markdown and is managed by a Zustand store. A strict pure parser splits Markdown from canonical embed directives and exposes ordered dependencies; a typed React adapter registry renders current table, graph, Fit Y by X, and Tabulate state. Existing save/open and v4 archive paths carry opaque Report JSON with explicit Rust validation. No workflow implementation is imported or modified.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, `react-markdown`, `remark-gfm`, Tauri 2, Rust 2021, serde/serde_json, ZIP format 4, direct `tsx` tests, Playwright component tests.

**Spec:** `docs/superpowers/specs/2026-09-02-issue-92-report-design.md`

## Global Constraints

- Base all work on local `dev@0e45e59` in `C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-92` on `feat/issue-92-report`.
- Support only `table | graph | fitYByX | tabulate` embeds on this baseline.
- Do not copy, import, edit, or depend on workflow code from any other worktree.
- Expose workflow compatibility only through `extractReportDependencies(markdown)` and stable `(kind, documentId)` values.
- Do not add Distribution embedding until its document lifecycle is merged into `dev`.
- Keep raw HTML disabled in Markdown.
- Persist Reports only inside `.spprj` as `data/<name>.sprp`; standalone import/export is out of scope.
- Preserve v4 atomic validation and destination replacement behavior.
- Follow strict TDD: write and run a failing behavior test before each production change.

---

### Task 1: Report Domain, Parser, Naming, And Store

**Files:**
- Create: `src/types/report.ts`
- Create: `src/utils/reportParser.ts`
- Create: `src/stores/useReportStore.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/utils/projectFileNaming.ts`
- Create: `tests/reportParser.test.ts`
- Create: `tests/reportStore.test.ts`
- Modify: `tests/projectFileNaming.test.ts`

**Interfaces:**
- Produces: `ReportEmbedKind`, `ReportDependency`, `ReportItem`, `ReportToken`.
- Produces: `parseReportMarkdown(markdown: string): ReportToken[]`.
- Produces: `extractReportDependencies(markdown: string): ReportDependency[]`.
- Produces: `formatReportEmbed(dependency: ReportDependency): string`.
- Produces: `useReportStore` with `items`, `counter`, `addItem`, `updateMarkdown`, `renameItem`, `deleteItem`, `loadFromProject`, `reset`, and `nextName`.

- [ ] **Step 1: Write failing parser tests**

Cover a canonical complete-line directive, surrounding Markdown order, duplicate dependency removal, directive-like text inside backtick and tilde fences, malformed directives remaining Markdown, and CRLF input. Use literal expected tokens and dependencies:

```ts
assert.deepEqual(parseReportMarkdown('Before\n{{sp-embed kind="graph" id="graph-1"}}\nAfter'), [
  { type: "markdown", markdown: "Before\n" },
  { type: "embed", dependency: { kind: "graph", documentId: "graph-1" } },
  { type: "markdown", markdown: "After" },
]);
assert.deepEqual(extractReportDependencies(source), [
  { kind: "graph", documentId: "graph-1" },
]);
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts`
Expected: FAIL because `src/utils/reportParser.ts` does not exist.

- [ ] **Step 3: Implement the strict parser and formatter**

Use a line scanner that tracks CommonMark fences and recognizes only this anchored grammar outside fences:

```ts
const REPORT_EMBED_RE = /^\{\{sp-embed kind="(table|graph|fitYByX|tabulate)" id="([^"{}\s\x00-\x1f\x7f]+)"\}\}$/;
```

Preserve Markdown text exactly, coalesce adjacent Markdown tokens, and deduplicate dependencies by `${kind}\0${documentId}` in first-seen order.

- [ ] **Step 4: Run the parser test and verify GREEN**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing naming and store tests**

Assert `projectFileExtension("report") === ".sprp"`, `.sprp` input normalization, an independent Report namespace, immutable extension metadata, read-only mutation rejection, timestamp update, load/reset, and default `Report N` counter restoration.

- [ ] **Step 6: Run naming/store tests and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts; npx tsx --tsconfig tsconfig.app.json tests/reportStore.test.ts`
Expected: FAIL on missing Report types/store and `.sprp` mapping.

- [ ] **Step 7: Implement types, naming, and store**

Use the approved model exactly:

```ts
export interface ReportItem {
  schemaVersion: 1;
  id: string;
  name: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}
```

`updateMarkdown(id, markdown, updatedAt)` must accept the timestamp as an argument so tests are deterministic. Every mutating action calls `assertProjectMutable(useProjectStore.getState().readOnly)`; `loadFromProject` and `reset` remain available while read-only.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts; npx tsx --tsconfig tsconfig.app.json tests/reportStore.test.ts; npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts`
Expected: PASS.

Commit: `feat(report): add report document domain`

---

### Task 2: Folder And Frontend Save/Open Contracts

**Files:**
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Create: `tests/folderStore.report.test.ts`
- Create: `tests/reportProjectContracts.test.ts`
- Create: `tests/tsconfig.report.json`

**Interfaces:**
- Consumes: `ReportItem` from Task 1.
- Produces: `reportFolders: Record<string, string>` and `setReportFolder(reportId, folder)`.
- Changes: `FolderStore.loadFromProject(...)` and `pruneAssignments(...)` gain Report inputs.
- Changes: `SaveProjectRequest` and `OpenProjectResult` gain `reports` and `reportFolders`.

- [ ] **Step 1: Write failing folder behavior tests**

Clone the real behavior style from `folderStore.fitYByX.test.ts`. Assert load normalization, set/unset, rename-folder remapping, delete-folder promotion, move-folder remapping, pruning deleted Report IDs, reset, and read-only mutation rejection.

- [ ] **Step 2: Run folder tests and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/folderStore.report.test.ts`
Expected: FAIL because `reportFolders` and `setReportFolder` do not exist.

- [ ] **Step 3: Extend `useFolderStore` through every folder transformation**

Add Report assignments to state, `loadFromProject`, `reset`, `renameFolder`, `deleteFolder`, `moveFolder`, and `pruneAssignments`. Add `validReportIds` as the final `pruneAssignments` argument to minimize existing call-site churn.

- [ ] **Step 4: Run folder tests and verify GREEN**

Run: `npx tsx --tsconfig tsconfig.app.json tests/folderStore.report.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing save/open type-contract test**

Use compile-time assignments and literal runtime checks to require:

```ts
reports: ReportItem[];
reportFolders: Record<string, string>;
```

in both frontend request/result contracts and `SaveProjectFolders`.

- [ ] **Step 6: Run contract test and verify RED**

Run: `npx tsc -p tests/tsconfig.report.json`
Expected: FAIL with missing `reports`/`reportFolders` properties.

- [ ] **Step 7: Extend frontend contracts and run focused tests**

Add Report fields without weakening existing types. Run:

`npx tsc -p tests/tsconfig.report.json; npx tsx --tsconfig tsconfig.app.json tests/reportProjectContracts.test.ts; npx tsx --tsconfig tsconfig.app.json tests/folderStore.fitYByX.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit: `feat(report): add report folder and project contracts`

---

### Task 3: Format 4 Report Archive Support

**Files:**
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes frontend JSON fields `reports` and `reportFolders`.
- Produces Rust `SaveProjectRequest.reports`, `SaveProjectRequest.report_folders`, and `OpenProjectResult` equivalents.
- Produces `DocumentKind::Report`, `ProjectManifest.report_files`, `ProjectManifest.report_folders`, and `ProjectBundle.reports`.
- Produces strict `validate_report_value(value: &Value, context: &str) -> Result<(), AppError>`.

- [ ] **Step 1: Add failing archive tests before production changes**

Inside `spprj_archive.rs`, add literal Report fixtures and tests for:

- `data/Report 1.sprp` path and `DocumentKind::Report` manifest entry;
- Report round trip with Markdown and `reportFolders` preserved;
- absent Report fields defaulting to empty on an older format 4 manifest;
- duplicate stable IDs and case-insensitive `.sprp` names;
- malformed JSON, missing file, wrong kind/extension, unsupported schema version, non-string Markdown, and manifest/body ID or name mismatch.

- [ ] **Step 2: Run the smallest archive test and verify RED**

From `src-tauri`, run: `cargo test report_round_trip_preserves_markdown_and_folder_map -- --nocapture`
Expected: FAIL to compile because Report archive fields do not exist.

- [ ] **Step 3: Implement Report manifest, bundle, read, build, write, and validation paths**

Use serde defaults for new fields. Validate the exact body contract:

```rust
fn validate_report_value(value: &Value, context: &str) -> Result<(), AppError> {
    require_u64(value, "schemaVersion", context, 1)?;
    value_required_id(value, context)?;
    value_required_name(value, context)?;
    require_string(value, "markdown", context)?;
    Ok(())
}
```

Allocate Report names only against other `.sprp` Reports. Keep Fit Y by X and Tabulate `.spf` namespaces unchanged. Write only manifest-indexed payloads and synchronize body names to manifest names.

- [ ] **Step 4: Run focused archive tests and repair only local failures**

From `src-tauri`, run: `cargo test report -- --nocapture`
Expected: all Report archive tests PASS.

- [ ] **Step 5: Add failing project-service round-trip assertions**

Extend existing create/open/save test fixtures to require `reports` and `reportFolders` to cross `SaveProjectRequest`, `build_bundle`, and `OpenProjectResult` unchanged.

- [ ] **Step 6: Run project-service test and verify RED, then implement contract plumbing**

Run the named project-service test selected from the existing module with `cargo test <exact_test_name> -- --nocapture`; verify failure on missing fields, then pass `reports` and `report_folders` through create/open/save snapshot paths.

- [ ] **Step 7: Run archive/service regression tests and commit**

Run: `cargo test spprj_archive -- --nocapture; cargo test project_service -- --nocapture`
Expected: PASS.

Commit: `feat(report): persist reports in project archives`

---

### Task 4: Streaming Writer Report Entries And Atomic Validation

**Files:**
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: `ProjectBundle.reports` and `ProjectManifest.report_files` from Task 3.
- Produces: metadata-phase `.sprp` ZIP entries indexed by stable ID.

- [ ] **Step 1: Write failing streaming-writer tests**

Extend real writer fixtures with one Report. Assert the archive contains `data/Report 1.sprp`, does not contain an ID-derived or logical-folder path, body ID/name match the manifest, and destination bytes remain unchanged when Report validation fails.

- [ ] **Step 2: Run the writer test and verify RED**

From `src-tauri`, run: `cargo test stream_writer_writes_report_entry -- --nocapture`
Expected: FAIL because `write_temp_archive` does not emit Report payloads.

- [ ] **Step 3: Implement metadata-phase Report writing**

Build `report_by_id`, resolve every `report_files` reference, synchronize body names with `indexed_payload_with_manifest_name`, validate the Report body, serialize with `serde_json::to_vec`, and write the exact manifest path. Missing indexed payloads return `AppError::FileIO` before replacement.

- [ ] **Step 4: Run focused writer and archive validation tests**

Run: `cargo test stream_writer -- --nocapture; cargo test report -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat(report): stream report archive entries`

---

### Task 5: Workspace Report Lifecycle And DIRECTORY Integration

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/App.css`
- Create: `src/components/report/ReportView.tsx`
- Create: `src/components/report/index.ts`
- Create: `tests/workspaceReport.test.ts`
- Modify: `tests/projectFileNaming.integration.test.ts`

**Interfaces:**
- Consumes: `useReportStore`, `reportFolders`, frontend save/open contracts.
- Produces: `activeReportId`, create/select/rename/delete/move/save/open/reset lifecycle.
- Produces temporary `ReportView({ item }: { item: ReportItem })` surface; Task 6 fills editing/rendering behavior.

- [ ] **Step 1: Write failing Workspace behavior-contract tests**

Require observable source contracts for the same patterns already tested by `workspaceFitYByX.test.ts`: Report menu creation, stable active routing, `.sprp` label, rename/delete context actions, drag payload and folder assignment, prune IDs, save payload, open/load, close/reset, and immutable rename suffix.

- [ ] **Step 2: Run Workspace test and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts`
Expected: FAIL because Workspace has no Report lifecycle.

- [ ] **Step 3: Add the smallest complete Report lifecycle**

Create a default Report with `schemaVersion: 1`, empty Markdown, and one timestamp for both date fields. Add report name resolution through `resolveProjectBasenameForKind`. Clear `activeReportId` when another document opens and clear other active IDs when a Report opens. Include Report in folder pruning, project save/open/reset, tree grouping, context menu, and drag/drop.

- [ ] **Step 4: Run Workspace and existing naming integration tests**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts; npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run frontend type/build check and commit**

Run: `npx vite build`
Expected: PASS.

Commit: `feat(report): integrate reports into workspace`

---

### Task 6: Markdown Editor, Preview, And Insertion

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/report/ReportView.tsx`
- Create: `src/components/report/ReportMarkdown.tsx`
- Create: `src/components/report/report.css`
- Create: `tests/reportEditor.test.ts`
- Create: `tests/reportView.spec.tsx`

**Interfaces:**
- Consumes: Task 1 parser/formatter and Task 5 Report lifecycle.
- Produces: `insertReportEmbed(markdown, selectionStart, selectionEnd, dependency)` returning `{ markdown, selectionStart, selectionEnd }`.
- Produces: responsive Markdown editor/live preview with an Editor/Preview segmented control at narrow widths.

- [ ] **Step 1: Install approved Markdown libraries**

Run: `npm install react-markdown remark-gfm`
Expected: `package.json` and lockfile contain pinned compatible dependency ranges.

- [ ] **Step 2: Write failing pure insertion tests**

Assert insertion into empty text, replacement of a selection, newline normalization around a directive, and returned caret position using literal strings.

- [ ] **Step 3: Run insertion test and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts`
Expected: FAIL because `insertReportEmbed` does not exist.

- [ ] **Step 4: Implement insertion helper and verify GREEN**

Keep the helper pure. It must generate the directive with `formatReportEmbed` and preserve unrelated text.

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing component test for editing and preview**

Mount a real Report view and assert Markdown headings/GFM tables render, raw HTML is shown as text or omitted rather than executed, typing updates the Report store, the insert menu groups current project documents, and selecting an item inserts the canonical directive at the textarea selection.

- [ ] **Step 6: Run component test and verify RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx`
Expected: FAIL because the editor/preview UI is incomplete.

- [ ] **Step 7: Implement editor, safe Markdown, responsive mode, and focus restoration**

Use `ReactMarkdown` with `remarkGfm` and no `rehypeRaw`. Keep toolbar controls icon-led with tooltips. Debounce/coalesce history recording at the Workspace boundary while store text updates remain immediate. Use stable CSS grid tracks so preview content does not resize the toolbar.

- [ ] **Step 8: Run focused tests/build and commit**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts; npx playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx; npx vite build`
Expected: PASS.

Commit: `feat(report): add markdown editor and preview`

---

### Task 7: Typed Live Embed Adapters, Localization, And Final Verification

**Files:**
- Create: `src/components/report/ReportEmbed.tsx`
- Create: `src/components/report/TableReportEmbed.tsx`
- Create: `src/components/report/GraphReportEmbed.tsx`
- Create: `src/components/report/FitYByXReportEmbed.tsx`
- Create: `src/components/report/TabulateReportEmbed.tsx`
- Modify: `src/components/report/ReportMarkdown.tsx`
- Modify: `src/components/tabulate/TabulateResultTable.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/reportEmbeds.test.ts`
- Create: `tests/reportLocale.test.ts`
- Modify: `tests/reportView.spec.tsx`

**Interfaces:**
- Consumes: ordered `ReportToken` values and existing stores/services/runtime components.
- Produces: `ReportEmbed({ dependency }: { dependency: ReportDependency })` dispatcher.
- Produces: adapter-local loading, missing-source, and error states.
- Changes: `TabulateResultTable` gains an explicit read-only presentation option that hides export and depth mutation controls without changing default behavior.

- [ ] **Step 1: Write failing adapter behavior tests**

Test real resolver behavior for each `(kind, id)`: current source resolves, missing ID returns an unavailable state, and one adapter failure leaves neighboring Markdown/embed tokens renderable. Assert a source name change is reflected without changing the directive ID.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportEmbeds.test.ts`
Expected: FAIL because adapter modules do not exist.

- [ ] **Step 3: Implement adapters one kind at a time**

- Table queries a bounded first window with `dataService.queryTableWindow`; cap rows/columns and render a stable read-only HTML table.
- Graph resolves `GraphBuilderItem` and `DatasetMeta`, then renders `GraphRuntime` with no mutation callbacks.
- Fit Y by X composes `useFitYByXReport(item, generationSignal)` and `FitYByXReport` in read-only presentation.
- Tabulate runs the existing service and renders `TabulateResultTable` with its new read-only option.

Each adapter catches its own async/render error and emits the localized embed error without throwing through `ReportMarkdown`.

- [ ] **Step 4: Run adapter tests after each adapter, then all together**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportEmbeds.test.ts`
Expected: PASS for all four kinds, missing references, rename refresh, and local error isolation.

- [ ] **Step 5: Write failing locale completeness test**

Require identical Report keys in `en`, `zh-CN`, `zh-TW`, and `vi` for menu creation, editor/preview labels, insertion, unavailable reference, embed error, empty preview, and history actions.

- [ ] **Step 6: Run locale test and verify RED, then add translations**

Run: `npx tsx --tsconfig tsconfig.app.json tests/reportLocale.test.ts`
Expected before implementation: FAIL on missing keys. Add natural translations and rerun to PASS.

- [ ] **Step 7: Run complete Report verification**

Run frontend focused tests:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.report.test.ts
npx tsc -p tests/tsconfig.report.json
npx tsx --tsconfig tsconfig.app.json tests/reportProjectContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportEmbeds.test.ts
npx tsx --tsconfig tsconfig.app.json tests/reportLocale.test.ts
npx playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx
npx vite build
```

Expected: all PASS.

- [ ] **Step 8: Run backend and full regression verification**

From `src-tauri`:

```powershell
cargo fmt -- --check
cargo clippy -- -D warnings
cargo test report -- --nocapture
cargo test streaming_project_writer -- --nocapture
cargo test
```

Expected: all PASS. If the known unrelated streaming progress timing test fails once, rerun that test once before classifying it as a regression.

- [ ] **Step 9: Run `git diff --check`, review scope, and commit**

Verify no workflow files, Distribution files, generated schema churn, or unrelated changes appear.

Commit: `feat(report): render live project embeds`

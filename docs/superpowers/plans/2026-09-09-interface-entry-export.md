# Issue 153 Interface Entry And Table Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented table export entry points with one folder-aware selection dialog, align the top menus with Issue 153, remove standalone graph export, and add the Contributors help view.

**Architecture:** A pure `tableExportModel` owns tree construction, tri-state selection, safe output names, and service-neutral export plans. `TableExportDialog` renders that model without invoking Tauri. `Workspace` owns native pickers and routes approved plans to existing export services; Help and graph command cleanup remain separate focused tasks.

**Tech Stack:** React 19, TypeScript 5.7, Zustand folder state, Tauri v2 dialog/path APIs, Playwright Component Testing, Rust, DuckDB, zip-rs.

**Spec:** `docs/superpowers/specs/2026-09-09-interface-entry-export-design.md`

## Global Constraints

- Work only in `/Users/ashton/git/ashton2914/StatsPlayground-issue-153` on `feat/issue-153-interface-entry-export`, based on `ecd7547`.
- The final pull request target is `dev`.
- Preserve all Analysis document, execution, registration, and presentation behavior while editing `Workspace.tsx`.
- The Table menu order is exactly New Table, Transform, Tabulate, SQL Query, separator, Import SPTB, Import CSV, Import SQLite, separator, Export.
- A folder checkbox recursively selects descendants and remains independently adjustable through tri-state selection.
- One SPTB or CSV table exports directly; multiple SPTB or CSV tables produce `<safe-project-name>-sptb.zip` or `<safe-project-name>-csv.zip` in the selected directory.
- One or more SQLite tables always export into one database file.
- ZIP entries preserve the full Directory folder hierarchy; SQLite table names flatten folder separators to dashes.
- Empty folders are omitted from the export tree without mutating the shared folder store.
- Standalone graph export is removed; graph import and project-internal SPGH persistence remain.
- Contributors are Ashton Huang, Chi Zhang, Junyi Zhu, Max Xu, Ryan Qiu, and Stanley Su in that order.
- Do not add a dependency. Use `@tauri-apps/api/path.join` and the existing dialog plugin.
- Do not commit, push, or create a pull request before manual acceptance; task checkpoints remain uncommitted under the GitHub Issue lifecycle.

---

### Task 1: Pure Table Export Model

**Files:**
- Create: `src/components/tableExport/tableExportModel.ts`
- Create: `tests/tableExportModel.test.ts`

**Interfaces:**
- Consumes: `DatasetMeta` fields `id` and `name`, plus `Record<string, string>` table-folder assignments.
- Produces:

```ts
export type TableExportFormat = "sqlite" | "sptb" | "csv";

export interface TableExportItem {
  id: string;
  name: string;
  folder: string;
}

export interface TableExportFolderNode {
  path: string;
  name: string;
  folders: TableExportFolderNode[];
  tables: TableExportItem[];
  descendantIds: string[];
}

export interface TableExportPlan {
  format: TableExportFormat;
  datasetIds: string[];
  mode: "single-file" | "sqlite-subset" | "zip";
  archivePaths: Record<string, string>;
  sqliteNames: Record<string, string>;
  suggestedFilename: string;
}

export function buildTableExportTree(
  datasets: readonly Pick<DatasetMeta, "id" | "name">[],
  tableFolders: Readonly<Record<string, string>>,
): TableExportFolderNode;

export function setTableSelection(
  selectedIds: ReadonlySet<string>,
  targetIds: readonly string[],
  selected: boolean,
): Set<string>;

export function selectionState(
  selectedIds: ReadonlySet<string>,
  targetIds: readonly string[],
): "checked" | "mixed" | "unchecked";

export function buildTableExportPlan(args: {
  datasets: readonly Pick<DatasetMeta, "id" | "name">[];
  tableFolders: Readonly<Record<string, string>>;
  selectedIds: ReadonlySet<string>;
  format: TableExportFormat;
  projectName: string;
}): TableExportPlan | null;
```

- Safe project basenames replace `/`, `\\`, `:`, `*`, `?`, `"`, `<`, `>`, and `|` with `-`, trim trailing dots/spaces, collapse repeated dashes, and fall back to `export`.
- Dataset ordering is the input dataset order so exports and tests remain deterministic.

- [ ] **Step 1: Write failing model tests**

Cover these cases with `node:assert/strict`:

```ts
const datasets = [
  { id: "root", name: "Root" },
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];
const folders = { a: "Batch/One", b: "Batch/Two" };

assert.deepEqual(buildTableExportTree(datasets, folders).descendantIds, ["root", "a", "b"]);
assert.equal(selectionState(new Set(["a"]), ["a", "b"]), "mixed");
assert.deepEqual([...setTableSelection(new Set(["a", "b"]), ["b"], false)], ["a"]);
```

Also assert empty folders are absent, stale selected IDs are dropped, single CSV/SPTB plans use `single-file`, multi CSV/SPTB plans use `zip`, every SQLite cardinality uses `sqlite-subset`, archive paths retain `Batch/One/A`, SQLite names use `Batch-One-A`, and project name `A:/B*` yields `A-B-csv.zip`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableExportModel.test.ts
```

Expected: FAIL because `tableExportModel.ts` does not exist.

- [ ] **Step 3: Implement the model minimally**

Build one synthetic root node with `path: ""`; create folder nodes only while assigning real tables, then recursively sort folder nodes and table rows by `name.localeCompare`. Derive each folder's `descendantIds` after children are complete. `buildTableExportPlan` intersects `selectedIds` with live datasets, returns `null` when the intersection is empty, and emits maps only for live selected IDs.

- [ ] **Step 4: Run the model test and verify GREEN**

Run the Step 2 command. Expected: all assertions pass with exit code 0.

- [ ] **Step 5: Run focused type checking**

Run:

```bash
npx tsc -p tsconfig.app.json --noEmit
```

Expected: exit code 0.

### Task 2: Table Export Dialog

**Files:**
- Create: `src/components/tableExport/TableExportDialog.tsx`
- Create: `src/components/tableExport/index.ts`
- Modify: `src/App.css`
- Create: `tests/TableExportDialogHarness.tsx`
- Create: `tests/tableExportDialog.spec.tsx`

**Interfaces:**
- Consumes Task 1 model functions and:

```ts
export interface TableExportDialogProps {
  datasets: readonly Pick<DatasetMeta, "id" | "name">[];
  tableFolders: Readonly<Record<string, string>>;
  projectName: string;
  onExport: (plan: TableExportPlan) => Promise<boolean>;
  onClose: () => void;
}
```

- `onExport` returns `true` only after a file was written. `false` means the native picker was canceled and keeps the dialog open without an error.
- A rejected `onExport` promise is converted to visible inline error text while preserving format and selection.

- [ ] **Step 1: Write the failing component tests**

Mount a module-level harness with root and nested tables. Assert:

```ts
await expect(component.getByRole("dialog", { name: "Export Tables" })).toBeVisible();
await expect(component.getByRole("button", { name: "Export" })).toBeDisabled();
await component.getByRole("checkbox", { name: "Batch" }).check();
await expect(component.getByText("2 tables selected")).toBeVisible();
await component.getByRole("checkbox", { name: "B" }).uncheck();
await expect(component.getByRole("checkbox", { name: "Batch" })).toHaveAttribute("aria-checked", "mixed");
```

Add tests for CSV/SQLite/SPTB segmented format selection, Escape/Cancel, picker cancellation retaining the dialog, and a rejected export retaining selection plus an inline `Export failed` message.

- [ ] **Step 2: Run the component spec and verify RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/tableExportDialog.spec.tsx
```

Expected: FAIL because the dialog and harness do not exist.

- [ ] **Step 3: Implement the dialog and stable responsive styling**

Use the existing `.sp-dialog-overlay`, `.sp-dialog`, `.sp-dialog-title`, and `.sp-dialog-actions` shell classes. Add focused `table-export-*` classes with a two-column body above 720px and a stacked body below 720px. Use native checkbox inputs, `aria-checked="mixed"`, and set `input.indeterminate` through a ref/effect for mixed folders. Use text buttons for the three explicit format options because they are a segmented mode control, not commands.

Folder rows use disclosure buttons with chevron icons from the existing icon library/classes. The Export button calls `buildTableExportPlan`; it sets a local busy flag, awaits `onExport`, closes only on `true`, and catches errors into local inline text.

- [ ] **Step 4: Run the component spec and verify GREEN**

Run the Step 2 command. Expected: all dialog tests pass.

- [ ] **Step 5: Re-run Task 1 and focused type checking**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableExportModel.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

Expected: both commands exit 0.

### Task 3: Workspace Export Orchestration And Menu Contract

**Files:**
- Modify: `src/components/Workspace.tsx`
- Create: `tests/workspaceIssue153.test.ts`

**Interfaces:**
- Consumes `TableExportDialog`, `TableExportPlan`, existing `ioService`, existing `projectService`, `open`, `save`, and `join` from `@tauri-apps/api/path`.
- Produces one `handleTableExport(plan: TableExportPlan): Promise<boolean>` orchestration function.

- [ ] **Step 1: Write a failing Workspace source contract**

Read `Workspace.tsx`, isolate the menu block, and assert ordered string positions for:

```ts
const tableOrder = [
  "menu.newTable",
  "menu.transform",
  "menu.tabulate",
  "menu.sqlQuery",
  "menu.importSptb",
  "menu.importCsv",
  "menu.importSqlite",
  "menu.exportTables",
];
```

Assert the menu block has no `menu.data`, Analyze has no `menu.tabulate`, Graph has no `menu.exportSpgh`, table/folder context blocks have no export handler names, and Workspace renders `TableExportDialog`. Assert orchestration source contains `open({ directory: true`, `join(`, `ioService.exportCsv`, `ioService.exportCsvZipSubset`, `ioService.exportSqliteSubset`, `projectService.exportTable`, and `projectService.exportTablesSptbZip`.

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceIssue153.test.ts
```

Expected: FAIL on the old menu order and missing dialog.

- [ ] **Step 3: Replace fragmented Workspace export state and handlers**

Add `showTableExport` state. Remove all old table/folder export handlers and their helper functions after moving path/name behavior into Task 1. Remove only the three table export items from table and folder context menus; retain rename, create-subfolder, and delete actions.

Implement routing:

```ts
const handleTableExport = async (plan: TableExportPlan): Promise<boolean> => {
  let outputPath: string | null = null;
  if (plan.mode === "zip") {
    const directory = await open({ directory: true, multiple: false });
    if (!directory || Array.isArray(directory)) return false;
    outputPath = await join(directory, plan.suggestedFilename);
  } else {
    outputPath = await save({
      title: t("tableExport.title"),
      defaultPath: plan.suggestedFilename,
      filters: exportFilters(plan),
    });
    if (!outputPath) return false;
  }
  // Dispatch by plan.format and plan.mode to the existing service methods.
  return true;
};
```

Do not catch export errors here; allow the dialog to render them inline. For one selected table, call `exportCsv` or `exportTable`. For multi-table ZIP, pass `plan.datasetIds` and `plan.archivePaths`. For SQLite, pass `plan.datasetIds` and `plan.sqliteNames` regardless of count.

- [ ] **Step 4: Apply the exact menu structure**

Move existing Tabulate and SQL Query actions into Table before the first separator. Move Import SPTB before Import CSV and Import SQLite. Remove PostgreSQL/MySQL entries from the top menu without deleting connector components or state. Add one Export item that opens the dialog. Remove the Data menu and Analyze Tabulate entry. Remove Graph SPGH export item while retaining New Graph Builder and Import SPGH.

- [ ] **Step 5: Run focused contracts and Analysis-sensitive checks**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceIssue153.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts
npm run test:analysis:typecheck
```

Expected: all commands exit 0.

### Task 4: Contributors And Four-Locale Copy

**Files:**
- Modify: `src/components/HelpDialog.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/issue153LocaleAndHelp.test.ts`

**Interfaces:**
- Extends Help mode to `"about" | "license" | "contributors"`.
- Produces an immutable contributors constant in first-name alphabetical order.
- Adds locale keys `menu.exportTables`, `menu.contributors`, `tableExport.*`, `help.contributorsTitle`, and `help.contributorsIntro` in all four locale files.

- [ ] **Step 1: Write a failing locale and Help contract**

Parse all four JSON locale files and assert every required dotted key resolves to a non-empty string. Read `HelpDialog.tsx` and assert the six names appear once and in the required order. Read `Workspace.tsx` and assert Help contains `menu.contributors` and `setHelpDialog("contributors")`.

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/issue153LocaleAndHelp.test.ts
```

Expected: FAIL because contributors and export-dialog locale keys are absent.

- [ ] **Step 3: Add translated copy and Contributors rendering**

Use native phrasing in each locale. Keep contributor names unchanged. Render Contributors as a simple unnumbered list inside the Help dialog body; do not imply rank. Add the Help menu entry after License.

- [ ] **Step 4: Replace Task 2/3 fallback copy with locale keys**

Localize dialog title, selected count singular/plural, format labels, empty state, Cancel, Export, export failure, and native picker titles. Do not place usage instructions or keyboard shortcuts visibly in the dialog.

- [ ] **Step 5: Run locale, dialog, Workspace, and build checks**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/issue153LocaleAndHelp.test.ts
npx playwright test -c playwright-ct.config.ts tests/tableExportDialog.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/workspaceIssue153.test.ts
npm run build
```

Expected: all commands exit 0.

### Task 5: Remove Standalone Graph Export Command And Prove Artifact Exports

**Files:**
- Create: `tests/graphExportRemoval.test.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src-tauri/src/commands/project_commands.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/services/io_service.rs`
- Test: existing `src-tauri/src/services/project_service.rs` unit-test module

**Interfaces:**
- Removes `projectService.exportGraph`, Tauri `export_graph`, `ProjectService::export_graph`, handler registration, and command classification.
- Retains `projectService.importGraph`, Tauri `import_graph`, `ProjectService::import_graph`, `GraphDoc`, and all SPPRJ archive graph behavior.

- [ ] **Step 1: Write a failing standalone graph-export removal contract**

Read the five frontend/Rust source files named above and assert they do not
contain the standalone export symbols, while import symbols and archive graph
types remain present:

```ts
assert.doesNotMatch(projectServiceSource, /exportGraph\s*:/);
assert.doesNotMatch(projectCommandsSource, /pub fn export_graph/);
assert.doesNotMatch(projectServiceRustSource, /pub fn export_graph/);
assert.doesNotMatch(libSource, /commands::project_commands::export_graph/);
assert.doesNotMatch(coverageSource, /project_commands::export_graph/);
assert.match(projectServiceSource, /importGraph\s*:/);
assert.match(projectCommandsSource, /pub fn import_graph/);
```

- [ ] **Step 2: Run the removal contract and verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphExportRemoval.test.ts
```

Expected: FAIL because the standalone graph-export surface still exists.

- [ ] **Step 3: Add covering Rust artifact tests before production removal**

Create small in-memory datasets through the existing `AppState`/DuckDB test helpers and temporary paths. Assert:

```rs
// SQLite subset contains exactly the selected table names.
assert_eq!(sqlite_table_names, vec!["Batch-One-A", "Batch-Two-B"]);

// CSV ZIP contains nested entries and excludes the unselected dataset.
assert_eq!(zip_names, vec!["Batch/One/A.csv", "Batch/Two/B.csv"]);

// SPTB ZIP contains nested entries that deserialize as standalone table docs.
assert_eq!(zip_names, vec!["Batch/One/A.sptb", "Batch/Two/B.sptb"]);
```

Use the repository's existing temp-file naming pattern and remove every created artifact at test end.

- [ ] **Step 4: Run focused tests to establish current artifact behavior**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml export_csv_zip_subset
cargo test --manifest-path src-tauri/Cargo.toml export_sqlite_subset
cargo test --manifest-path src-tauri/Cargo.toml export_tables_sptb_zip
```

Expected: the new characterization tests pass against existing backend behavior.

- [ ] **Step 5: Remove only the standalone graph-export surface**

Delete the wrapper, command, service method, registration, and mutation-coverage entry named above. Do not edit `spprj_archive.rs`, graph project save/open code, or graph import.

- [ ] **Step 6: Run the removal contract and verify GREEN**

Run the Step 2 command. Expected: exit code 0 while all graph-import assertions
remain present.

- [ ] **Step 7: Run command coverage and focused artifact tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mutation_guard_coverage
cargo test --manifest-path src-tauri/Cargo.toml export_csv_zip_subset
cargo test --manifest-path src-tauri/Cargo.toml export_sqlite_subset
cargo test --manifest-path src-tauri/Cargo.toml export_tables_sptb_zip
```

Expected: all commands exit 0 and no test references `export_graph`.

### Task 6: Full Verification And Manual Acceptance Runtime

This is a verification and acceptance gate, not an implementation task. It
adds no production behavior and therefore has no artificial RED/GREEN cycle;
every behavior it verifies was introduced through Tasks 1-5's explicit cycles.

**Files:**
- Modify only files required by failures caused by Tasks 1-5.
- Do not fix unrelated pre-existing failures.

**Interfaces:**
- Consumes the complete Issue 153 change.
- Produces fresh verification evidence and a running Tauri application for user acceptance.

- [ ] **Step 1: Run every focused Issue 153 test together**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableExportModel.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceIssue153.test.ts
npx tsx --tsconfig tsconfig.app.json tests/issue153LocaleAndHelp.test.ts
npx playwright test -c playwright-ct.config.ts tests/tableExportDialog.spec.tsx
```

Expected: all commands exit 0.

- [ ] **Step 2: Run repository-required frontend and Analysis gates**

Run:

```bash
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run build
```

Expected: all commands exit 0. The full Analysis kind/UI suites are required only if these focused checks or the final review identify an Analysis regression, because Issue 153 does not alter Analysis documents or renderers.

- [ ] **Step 3: Run backend gates**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

Expected: all commands exit 0.

- [ ] **Step 4: Inspect the bounded final change**

Run:

```bash
git status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat
git --no-pager diff --no-ext-diff --check
```

Expected: only Issue 153 source, test, design, and plan files are present; diff check exits 0; no generated artifacts or credentials appear.

- [ ] **Step 5: Obtain independent whole-branch review**

Give the reviewer Issue 153, the approved spec, base `ecd7547`, all uncommitted tracked/untracked changes, focused/full verification evidence, and the exact requirements. Fix all Critical and Important findings, rerun affected checks, and repeat review if behavior changes materially.

- [ ] **Step 6: Start Tauri for manual acceptance**

Run from the exact sibling worktree:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-153 run tauri -- dev
```

Verify the process source path, Vite URL, and native executable belong to the Issue 153 worktree. Ask the user to exercise every acceptance item from the spec. Stop before commit, push, or pull-request creation until the user explicitly accepts the runtime behavior.
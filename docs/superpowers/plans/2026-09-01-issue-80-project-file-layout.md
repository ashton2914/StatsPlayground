# Issue 80 Project File Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `.spprj` saves to readable, flat, display-name-based files while retaining stable UUID identity and automatic legacy migration.

**Architecture:** Rust owns the authoritative v4 archive index, portable filename validation, collision allocation, compatibility reads, and atomic writes. A small TypeScript naming module mirrors extension namespaces for immediate UI behavior; the Rust save boundary validates the invariant independently.

**Tech Stack:** Rust 2021, serde/serde_json, zip, Tauri v2, TypeScript, React 19, Zustand, esbuild Node contract tests.

**Spec:** `docs/superpowers/specs/2026-09-01-issue-80-project-file-layout-design.md`

## Global Constraints

- New saves use project format `4.0.0`.
- Active documents are flat direct children of `data/`; snapshots are flat direct children of `snapshots/`.
- Physical filenames equal display basename plus immutable extension.
- `.sptb`, `.spgh`, and `.spf` are separate case-insensitive namespaces; Fit Y by X and Tabulate share `.spf`.
- Conflicts resolve as `name-2.ext`, `name-3.ext`; logical folders do not affect uniqueness.
- Existing JSON and ZIP formats remain readable and become v4 on the next save.
- UUIDs remain stable internal identities and manifest/folder-map keys, never generated filenames.
- Invalid names and unresolved v4 references fail before destination or live-state mutation.

---

### Task 1: Format 4 Archive Model And Reader

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Produces: `DocumentKind`, `DocumentEntryRef`, and `SnapshotEntryRef` serde types.
- Produces: `allocate_archive_names<T>(...)`-equivalent internal allocation used by `build_bundle`.
- Produces: `ProjectManifest` indexes for Fit Y by X, Tabulate, and snapshots while retaining legacy inline fields as read-only fallbacks.
- Preserves: `ProjectBundle` arrays consumed by `ProjectService` and the streaming writer.

- [ ] **Step 1: Write failing archive tests**

Add tests beside existing `spprj_archive` tests that build table, graph, Fit Y by X, Tabulate, and snapshot values named `data` and assert manifest paths:

```rust
assert_eq!(bundle.manifest.tables[0].file, "data/data.sptb");
assert_eq!(bundle.manifest.graphs[0].file, "data/data.spgh");
assert_eq!(bundle.manifest.fit_y_by_x_files[0].file, "data/data.spf");
assert_eq!(bundle.manifest.tabulate_files[0].file, "data/data-2.spf");
assert_eq!(bundle.manifest.snapshot_files[0].file, "snapshots/data.json");
```

Also assert case-insensitive suffixing, Windows reserved/control-character rejection, absence of logical folder ZIP paths, v4 missing entry rejection, and successful reads of inline Fit/Tabulate plus aggregate legacy snapshots.

- [ ] **Step 2: Verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture
```

Expected: compile/test failure because v4 entry indexes and `data/` allocation do not exist.

- [ ] **Step 3: Implement the v4 model and compatibility reader**

Add tagged manifest references carrying `id`, `name`, `file`, and a Fit/Tabulate type discriminator. Build paths from validated display names with one case-folded set per extension namespace. Keep stable IDs in entry refs and document bodies. Read indexed v4 files first; only when indexes are absent, read current inline/aggregate forms. Validate relative normalized paths, expected roots/extensions, unique entry paths, body IDs, and required entries.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 command and confirm all archive tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/spprj_archive.rs
git commit -m "feat(project): add readable v4 archive entries"
```

### Task 2: Streaming Writer And Atomic Validation

**Files:**
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: v4 refs and bundle payloads from Task 1.
- Produces: temporary ZIPs containing manifest-indexed `data/*` and `snapshots/*` entries.
- Preserves: existing keyset table streaming, progress events, temporary-file validation, and atomic replacement.

- [ ] **Step 1: Write a failing production-writer test**

Add a focused sibling to existing streaming tests. Save a project containing every document type, open the ZIP, and assert its file set includes the expected readable paths and excludes `.snapshots.json`, logical folder entries, `tables/`, and `graphs/`. Add a validation-hook test proving a missing `.spf` leaves pre-existing destination bytes unchanged.

- [ ] **Step 2: Verify RED**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::streaming_project_writer::tests -- --nocapture
```

Expected: entry-set assertions fail because Fit/Tabulate remain inline and snapshots aggregate.

- [ ] **Step 3: Write indexed entries**

Change `write_temp_archive` to stop creating logical folder ZIP entries; stream tables through manifest table refs; serialize graph docs through graph refs; serialize Fit Y by X and Tabulate values through `.spf` refs; serialize each named snapshot through its snapshot ref. Pass all indexed paths into central validation before replacement. Bump `STREAM_VERSION` to `4.0.0`.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 command. If the known progress timing test alone fails, rerun it once before classifying it as a regression.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/spprj_archive.rs src-tauri/src/services/streaming_project_writer.rs
git commit -m "feat(project): stream flat named project files"
```

### Task 3: Generalized Legacy Name Migration

**Files:**
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/models/project.rs`
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Produces: `DocumentNameMigration { id: String, kind: String, old_name: String, new_name: String }`, serialized camelCase.
- Produces: `OpenProjectResult.document_name_migrations` / TS `documentNameMigrations`.
- Preserves: `datasetNameMigrations` during the transition only if existing consumers still require it; dirty state is true when either migration list is non-empty or archive version is older than 4.

- [ ] **Step 1: Write failing service and store tests**

Create legacy fixtures with case-only duplicate tables and shared Fit/Tabulate names. Assert deterministic basenames `name`, `name-2`, stable IDs/folder maps, `documentNameMigrations`, and dirty state after open. Assert a format 4 missing indexed file does not replace the current live project.

- [ ] **Step 2: Verify RED**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture
.\node_modules\.bin\esbuild.cmd tests/useProjectStore.saveLifecycle.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=tests/.issue80-project-store.mjs
node tests/.issue80-project-store.mjs
```

Expected: migration fields/normalization assertions fail.

- [ ] **Step 3: Normalize all visible document names on open**

Use extension-scoped, case-insensitive allocation before staged restoration. Rewrite each in-memory object's `name` when a collision or unsafe legacy name requires migration, retaining IDs and maps. Return the generalized migrations and an archive-migration indicator sufficient for the frontend to mark any pre-v4 project dirty. Bump `SPPRJ_VERSION` to `4.0.0`.

- [ ] **Step 4: Verify GREEN**

Run both Task 3 commands and delete the generated `tests/.issue80-project-store.mjs` artifact.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/services/project_service.rs src-tauri/src/models/project.rs src/services/projectService.ts src/types/project.ts src/stores/useProjectStore.ts tests/useProjectStore.saveLifecycle.test.ts
git commit -m "feat(project): migrate legacy document names"
```

### Task 4: Shared Frontend Filename Policy

**Files:**
- Create: `src/utils/projectFileNaming.ts`
- Create: `tests/projectFileNaming.test.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/HistoryPanel.tsx`

**Interfaces:**
- Produces: `type ProjectFileExtension = ".sptb" | ".spgh" | ".spf" | ".json"`.
- Produces: `projectFileExtension(kind): ProjectFileExtension`.
- Produces: `allocateProjectBasename(requested, extension, existing, currentName?): string` using case-insensitive `-N` suffixing.
- Produces: `validateProjectBasename(name)` using the same invalid-name categories as Rust.
- Consumes: all table names for `.sptb`, graph names for `.spgh`, and combined Fit/Tabulate names for `.spf`; snapshots use their own `.json` namespace.

- [ ] **Step 1: Write the naming contract test**

Cover cross-extension coexistence, Fit/Tabulate collision, case-insensitive collisions, `name-2` progression, current-name exclusion during rename, invalid characters/control characters, Windows reserved names, and extension stripping from pasted rename text.

- [ ] **Step 2: Verify RED**

```powershell
.\node_modules\.bin\esbuild.cmd tests/projectFileNaming.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=tests/.issue80-naming.mjs
node tests/.issue80-naming.mjs
```

Expected: bundle failure because `projectFileNaming.ts` does not exist.

- [ ] **Step 3: Implement and route naming**

Implement the pure utility. Route Workspace create and rename handlers through the appropriate namespace and use the resolved basename for history messages. Route snapshot creation/rename through the snapshot namespace. Keep Zustand stores as state primitives; centralize policy in the utility and owning UI workflows.

- [ ] **Step 4: Verify GREEN**

Run the Task 4 commands and delete `tests/.issue80-naming.mjs`.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/projectFileNaming.ts tests/projectFileNaming.test.ts src/components/Workspace.tsx src/components/HistoryPanel.tsx
git commit -m "feat(workspace): enforce project filename namespaces"
```

### Task 5: Immutable Extension UI And End-To-End Verification

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/HistoryPanel.tsx`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/workspaceFitYByX.test.ts`
- Modify: `tests/fitYByXLayout.test.ts`

**Interfaces:**
- Consumes: `projectFileExtension` and basename-only state from Task 4.
- Produces: DIRECTORY and snapshot labels with visible extensions; rename rows with a text input plus non-editable suffix.

- [ ] **Step 1: Write failing UI source/contract assertions**

Assert all four DIRECTORY item renderers append the correct extension, Fit and Tabulate both append `.spf`, snapshot labels append `.json`, and rename markup renders the extension outside the input. Assert open handling consumes generalized migration state.

- [ ] **Step 2: Verify RED**

```powershell
.\node_modules\.bin\esbuild.cmd tests/workspaceFitYByX.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=tests/.issue80-workspace.mjs
node tests/.issue80-workspace.mjs
.\node_modules\.bin\esbuild.cmd tests/fitYByXLayout.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=tests/.issue80-layout.mjs
node tests/.issue80-layout.mjs
```

Expected: UI contract assertions fail because labels omit extensions.

- [ ] **Step 3: Render immutable suffixes**

Append suffixes to normal labels and add a compact fixed suffix beside rename inputs without changing row dimensions. Add localized duplicate/invalid-name feedback only where existing alert patterns require it. Preserve source tags, drag/drop, read-only behavior, and keyboard submit/cancel.

- [ ] **Step 4: Run focused and full verification**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
.\node_modules\.bin\tsc.cmd -b
.\node_modules\.bin\vite.cmd build
```

Also run the repository's relevant bundled Node tests and remove all `.issue80-*.mjs` outputs.

- [ ] **Step 5: Commit**

```powershell
git add src/components/Workspace.tsx src/components/HistoryPanel.tsx src/App.css src/i18n/locales tests
git commit -m "feat(workspace): show immutable project extensions"
```

### Task 6: Whole-Branch Review

**Files:**
- Review: all changes since `dev`.

- [ ] **Step 1: Compare implementation to every design requirement**

Inspect the complete diff for format compatibility, name/path equality, extension-scoped uniqueness, pre-mutation validation, atomic open/save, and unchanged logical folder behavior.

- [ ] **Step 2: Run final clean verification**

Repeat the full Task 5 verification from a clean worktree and inspect `git status` for generated artifacts.

- [ ] **Step 3: Commit review fixes if needed**

Use a focused Conventional Commit describing only the reviewed correction.
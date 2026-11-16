# Issue 263 Persistent DataLinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist secret-free SQLite and PostgreSQL DataLinks in `.spprj` projects and let guarded SQL Query statements reference them without importing complete source databases.

**Architecture:** DataLinks are versioned project documents stored under `datalink/` and indexed by `manifest.json`. Rust owns session-only credentials and builds an isolated DuckDB query connection containing project-table snapshots plus only the validated DataLink relations referenced by the query; the frontend provides management, cached schema browsing, explicit Refresh, and credential prompts.

**Tech Stack:** Tauri v2, Rust, DuckDB/libduckdb-sys, sqlparser-rs, serde, ZIP `.spprj` archives, React 19, TypeScript, Zustand, Playwright Component Testing.

**Spec:** `docs/superpowers/specs/2026-10-09-issue-263-persistent-datalinks-design.md`

## Global Constraints

- The worktree is `StatsPlayground.worktrees/263-persistent-datalinks` on `feat/263-persistent-datalinks`, based on `origin/dev` commit `445046c84a7a12845f108596a5de67aaf81a030f`; PR target is `dev`.
- Support SQLite and PostgreSQL in the first release. MySQL is deferred because
  DuckDB 1.5.5 requires a live connection during `ATTACH` before relation
  binding can be proven.
- Store DataLinks inside `.spprj` as `datalink/<uuid>.json`; do not convert projects into expanded directories.
- Never serialize passwords, tokens, private keys, complete connection strings, or absolute SQLite paths.
- PostgreSQL credentials and SQLite file authorization expire when the project session closes.
- Refresh is explicit and preserves the last successful cache after failure.
- SQL syntax is `"DataLink"."schema"."table"` for PostgreSQL and `"DataLink"."table"` for SQLite.
- User SQL remains one read-only query and cannot contain `ATTACH`, `INSTALL`, `LOAD`, `COPY`, DDL, DML, or table functions.
- Runtime scanner installation or download is forbidden; release builds package exact DuckDB-version-matched scanner extensions.
- No credential or user path may be concatenated into SQL. Phase 0 must prove structured native binding before product implementation.
- Preserve `Result<T, AppError>` and structured `DataLinkError`; do not use `unwrap()` or `expect()` in non-test Rust.
- Register each new Tauri command in `src-tauri/src/lib.rs` and wrap it in `src/services/dataLinkService.ts`.
- Keep shared DataLink state in Zustand and keep dialogs presentation-focused.
- Do not commit during implementation. The GitHub Issue lifecycle requires automated verification, independent review, and user manual acceptance before the single scoped commit and PR.

## File Responsibility Map

### Backend

- `src-tauri/src/models/data_link.rs`: persisted and runtime DataLink contracts; no archive or database I/O.
- `src-tauri/src/services/data_link_archive.rs`: validate and serialize DataLink archive documents.
- `src-tauri/src/services/data_link_session.rs`: project-session credentials, SQLite grants, and non-sensitive runtime status.
- `src-tauri/src/services/data_link_service.rs`: connector discovery, test, refresh, CRUD orchestration.
- `src-tauri/src/services/data_link_query_runtime.rs`: packaged extension loading, structured relation binding, isolated connection lifecycle, and pushdown probe.
- `src-tauri/src/engine/sql_query.rs`: pure AST validation and relation resolution.
- `src-tauri/src/engine/duckdb_engine.rs`: project snapshot copy, DataLink-aware query preview, and transactional materialization.
- `src-tauri/src/services/spprj_archive.rs`: manifest/index models and archive read validation.
- `src-tauri/src/services/streaming_project_writer.rs`: write DataLink JSON entries into the atomic save archive.
- `src-tauri/src/models/save.rs`: DataLinks in the save snapshot request.
- `src-tauri/src/services/project_service.rs`: expose opened DataLinks and clear runtime state on project lifecycle changes.
- `src-tauri/src/commands/data_link_commands.rs`: thin IPC delegates.
- `src-tauri/src/lib.rs`: command registration.
- `src-tauri/duckdb-extensions.json`: exact DuckDB version, target artifacts, URLs, and SHA-256 values.
- `scripts/duckdbExtensionsCore.mjs`: pure extension-manifest validation and target-path calculation.
- `scripts/prepareDuckDbExtensions.mjs`: build-time verified download into generated Tauri resources.

### Frontend

- `src/types/dataLink.ts`: exact camelCase mirrors of persisted/runtime Rust contracts.
- `src/services/dataLinkService.ts`: typed IPC wrapper.
- `src/stores/useProjectDataLinkStore.ts`: project DataLinks, cache, runtime status, mutations, and dirty integration.
- `src/components/dataLink/DataLinkManagerDialog.tsx`: manager shell and connector editor routing.
- `src/components/dataLink/DataLinkSchemaTree.tsx`: cached catalog/schema/object display.
- `src/components/dataLink/DataLinkCredentialsDialog.tsx`: transient credential collection without Zustand persistence.
- `src/components/dataLink/dataLink.css`: manager, schema tree, and status styles.
- `src/components/SqlQueryDialog.tsx`: project/DataLink object browser, qualified identifier insertion, credential retry.
- `src/components/Workspace.tsx`: open/close lifecycle and one File-menu DataLink entry.
- `src/services/projectService.ts`, `src/types/project.ts`: DataLinks in save/open contracts.
- `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`: manager, status, Refresh, and structured error copy.

### Tests

- Rust tests remain beside their owning modules.
- `scripts/duckdbExtensionsCore.test.mjs`: target mapping, hash enforcement, and missing-artifact failures.
- `tests/dataLinkProjectContracts.test.ts`: TypeScript save/open/default compatibility.
- `tests/dataLinkStore.test.ts`: store mutation, dirty, and failed Refresh retention.
- `tests/DataLinkManagerHarness.tsx`, `tests/dataLinkManager.spec.tsx`: manager interaction.
- `tests/sqlQueryDataLink.test.ts`: source-level and helper contracts.
- `tests/SqlQueryDataLinkHarness.tsx`, `tests/sqlQueryDataLink.spec.tsx`: object browsing and credential retry.
- `tests/workspaceDataLink.test.ts`: one menu entry and replacement of snapshot-import dialogs.

---

### Task 1: Prove Packaged Scanner and Structured Binding Feasibility

**Files:**
- Create: `src-tauri/examples/datalink_scanner_probe.rs`
- Modify: `src-tauri/src/models/data_link.rs`
- Create: `src-tauri/src/services/data_link_query_runtime.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/duckdb-extensions.json`
- Create: `scripts/duckdbExtensionsCore.mjs`
- Create: `scripts/duckdbExtensionsCore.test.mjs`
- Create: `scripts/prepareDuckDbExtensions.mjs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `ScannerExtension::{Sqlite, PostgreSql}`.
- Produces: `ScannerResourceManifest::load(path: &Path) -> Result<Self, AppError>`.
- Produces: `DataLinkQueryRuntime::open(resource_dir: &Path) -> Result<Self, AppError>`.
- Produces: `DataLinkQueryRuntime::bind_relation(&self, binding: &ResolvedDataLinkBinding, secret: &SessionSecret) -> Result<(), AppError>`.
- Produces: `verifyPushdownEvidence(plan: &str) -> Result<(), AppError>`.

Task 1 defines the shared query/runtime types that later tasks populate:

```rust
pub struct ResolvedDataLinkBinding {
    pub data_link_id: String,
    pub connector: ConnectorKind,
    pub catalog: Option<String>,
    pub schema: Option<String>,
    pub object: String,
    pub relation_alias: String,
}

pub enum SessionSecret {
    UsernamePassword { username: String, password: String },
    SqliteGrant { file_path: PathBuf, fingerprint: String },
}
```

`SessionSecret` must not implement `Debug`, `Clone`, `Serialize`, or
`Deserialize`.

- [ ] **Step 1: Add failing extension-manifest tests**

```javascript
test("requires every supported target and exact sha256", () => {
  const manifest = validateExtensionManifest(fixture);
  assert.deepEqual(Object.keys(manifest.targets).sort(), [
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ]);
  assert.match(manifest.targets["aarch64-apple-darwin"].postgres.sha256, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run the manifest test and confirm RED**

Run: `node --test scripts/duckdbExtensionsCore.test.mjs`

Expected: FAIL because `duckdbExtensionsCore.mjs` does not exist.

- [ ] **Step 3: Implement the manifest parser and verified preparation script**

Use `duckdb-extensions.json` as the only network/artifact authority. The
preparation script must stream each artifact to a temporary file, verify its
declared SHA-256, atomically rename it under
`src-tauri/resources/duckdb_extensions/<target>/`, and fail without leaving a
success-shaped file when the hash differs.

```javascript
export function extensionRelativePath(target, extension) {
  assertSupportedTarget(target);
  assertExtensionName(extension);
  return `duckdb_extensions/${target}/${extension}.duckdb_extension`;
}
```

- [ ] **Step 4: Run the manifest tests and confirm GREEN**

Run: `node --test scripts/duckdbExtensionsCore.test.mjs`

Expected: PASS with zero skipped tests.

- [ ] **Step 5: Write failing Rust tests for structured binding**

The tests must reject a fake binding API that accepts a connection-string SQL
fragment and must prove that secrets are separate typed inputs:

```rust
#[test]
fn binding_contract_keeps_secrets_out_of_sql_text() {
    let binding = fixture_postgres_binding();
    let secret = SessionSecret::UsernamePassword {
        username: "reader".into(),
        password: "<fixture-password>".into(),
    };
    let plan = build_native_binding_plan(&binding, &secret).unwrap();
    assert!(!plan.debug_sql.contains("not-serialized"));
    assert_eq!(plan.relation_alias, "__datalink_0");
}
```

- [ ] **Step 6: Run the focused Rust test and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml data_link_query_runtime -- --nocapture`

Expected: compile failure because the runtime types and structured native
binding adapter do not exist.

- [ ] **Step 7: Implement the narrow runtime adapter and probe executable**

The implementation must use a structured DuckDB/libduckdb native API for
attachment or scanner configuration. Application-owned extension names are
fixed enum matches. Credential and SQLite path fields stay typed and never
become SQL fragments.

The probe must:

1. load the packaged SQLite scanner without `INSTALL`;
2. bind a selected SQLite fixture;
3. copy a one-row project table into the same isolated connection;
4. execute a join;
5. inspect `EXPLAIN` for scanner-local projection pushdown and classify
   predicate execution as scanner-local or DuckDB-side;
6. repeat binding construction for PostgreSQL without contacting a live
   server.

- [ ] **Step 8: Run the probe and enforce the stop condition**

Run:

```bash
npm run prepare:duckdb-extensions
cargo run --manifest-path src-tauri/Cargo.toml --example datalink_scanner_probe
```

Expected: PASS with explicit lines for offline load, mixed project/DataLink
join, structured secret binding, projection pushdown, and predicate execution
location. Predicate pushdown is optional when the bundled scanner leaves the
predicate in a DuckDB `FILTER`; full-object staging remains prohibited.

If any line fails, stop implementation and return the exact evidence to the
design gate. Do not proceed to Task 2 and do not implement SQL string
interpolation or temporary full-table staging.

- [ ] **Step 9: Run the focused gate**

Run:

```bash
node --test scripts/duckdbExtensionsCore.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml data_link_query_runtime -- --nocapture
git diff --check
```

Expected: all commands pass. Do not commit.

### Task 2: Add Persistent DataLink Models and Archive Round-Trip

**Files:**
- Modify: `src-tauri/src/models/data_link.rs`
- Create: `src-tauri/src/services/data_link_archive.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src/types/dataLink.ts`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Create: `tests/dataLinkProjectContracts.test.ts`

**Interfaces:**
- Produces Rust `PersistedDataLink`, `DataLinkEntryRef`, `CachedSourceCatalog`, `CachedSourceSchema`, `CachedSourceObject`, and `CachedSourceColumn`.
- Adds `ProjectManifest.data_links: Vec<DataLinkEntryRef>`.
- Adds `ProjectBundle.data_links: Vec<PersistedDataLink>`.
- Adds `SaveProjectRequest.data_links: Vec<PersistedDataLink>`.
- Adds `OpenProjectResult.data_links: Vec<PersistedDataLink>`.
- Produces `validate_persisted_data_links(entries, docs) -> Result<(), AppError>`.

The persisted connection enum is defined exactly once in this task:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "connector", rename_all = "camelCase")]
pub enum PersistedConnectionDefinition {
    Sqlite,
    PostgreSql {
        host: String,
        port: u16,
        database: String,
        authentication_type: AuthenticationType,
        tls_mode: TlsMode,
        tls_root_certificate_pem: Option<String>,
        connect_timeout_seconds: u32,
    },
    MySql {
        host: String,
        port: u16,
        database: String,
        authentication_type: AuthenticationType,
        tls_mode: TlsMode,
        tls_root_certificate_pem: Option<String>,
        connect_timeout_seconds: u32,
    },
}
```

- [ ] **Step 1: Write failing Rust serialization and validation tests**

Cover SQLite and PostgreSQL, old manifests with no `dataLinks`, index/document
identity mismatch, `../` paths, absolute paths, duplicate case-insensitive
names, unsupported versions, prohibited credential keys, prohibited SQLite
absolute paths, and bounded cache sizes.

```rust
#[test]
fn persisted_data_link_never_serializes_credentials_or_sqlite_path() {
    let value = serde_json::to_value(sqlite_document()).unwrap();
    let text = value.to_string();
    assert!(!text.contains("password"));
    assert!(!text.contains("/Users/"));
    assert_eq!(value["sourceFileName"], "source.sqlite");
}
```

- [ ] **Step 2: Run the archive model tests and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml data_link_archive -- --nocapture`

Expected: compile failure because persistent archive types do not exist.

- [ ] **Step 3: Implement exact persisted models**

Use a tagged connector definition and a schema cache that stores stable source
identity:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDataLink {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub connection: PersistedConnectionDefinition,
    pub refreshed_at: String,
    pub source_file_name: Option<String>,
    pub source_fingerprint: Option<String>,
    pub catalogs: Vec<CachedSourceCatalog>,
}
```

Set explicit limits in `data_link_archive.rs`: 128 DataLinks per project,
128 catalogs per DataLink, 1,024 schemas per catalog, 100,000 objects per
DataLink, 10,000 columns per object, and 1,024 UTF-8 bytes per user/source
identifier.

- [ ] **Step 4: Add archive index/read/write support**

Write each validated document to `datalink/<uuid>.json` from the streaming
writer. Read exactly the manifest-indexed entries, reject duplicate/unindexed
documents, and default old manifests to an empty list.

- [ ] **Step 5: Add matching TypeScript project contracts**

```typescript
export interface PersistedDataLink {
  formatVersion: number;
  id: string;
  name: string;
  connection: PersistedConnectionDefinition;
  refreshedAt: string;
  sourceFileName: string | null;
  sourceFingerprint: string | null;
  catalogs: CachedSourceCatalog[];
}
```

Add `dataLinks` to `OpenProjectResult` and `SaveProjectRequest`, defaulting to
`[]` in `projectService.openProject` and `projectService.saveProject`.

- [ ] **Step 6: Run Rust and TypeScript contract tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml data_link_archive -- --nocapture
npx tsx --tsconfig tsconfig.app.json tests/dataLinkProjectContracts.test.ts
```

Expected: PASS, including old-project compatibility and secret/path exclusion.

- [ ] **Step 7: Run archive regression coverage**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml streaming_project_writer -- --nocapture
git diff --check
```

Expected: PASS. Do not commit.

### Task 3: Add Project-Scoped Session State and DataLink CRUD IPC

**Files:**
- Create: `src-tauri/src/services/data_link_session.rs`
- Modify: `src-tauri/src/services/data_link_service.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/commands/data_link_commands.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src/services/dataLinkService.ts`
- Create: `src/stores/useProjectDataLinkStore.ts`
- Create: `tests/dataLinkStore.test.ts`

**Interfaces:**
- Produces `DataLinkRuntimeStatus::{AuthenticationRequired, Connected, ConnectionError}`.
- Produces `DataLinkSessionRegistry::{set_credentials, bind_sqlite_file, status, clear_project}`.
- Produces service methods `create_data_link`, `rename_data_link`, `delete_data_link`, `connect_data_link`, `refresh_data_link`, and `list_data_link_statuses`.
- Produces matching Tauri commands and TypeScript wrappers.
- Produces `useProjectDataLinkStore` actions `hydrate`, `create`, `rename`, `remove`, `connect`, `refresh`, and `clear`.

- [ ] **Step 1: Write failing Rust lifecycle tests**

```rust
#[test]
fn clearing_project_drops_credentials_and_sqlite_grants() {
    let registry = DataLinkSessionRegistry::default();
    registry.set_credentials("link-1", secret()).unwrap();
    registry.bind_sqlite_file("link-2", grant()).unwrap();
    registry.clear_project().unwrap();
    assert_eq!(registry.status("link-1").unwrap(), AuthenticationRequired);
    assert_eq!(registry.status("link-2").unwrap(), AuthenticationRequired);
}
```

- [ ] **Step 2: Run the lifecycle test and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml data_link_session -- --nocapture`

Expected: compile failure because `DataLinkSessionRegistry` does not exist.

- [ ] **Step 3: Implement session registry and structured errors**

Use a mutex-protected project-scoped map. Do not derive `Debug`, `Serialize`, or
`Clone` for secret-bearing values. Convert lock poisoning and connector errors
to `AppError`/`DataLinkError` without returning secret fields.

- [ ] **Step 4: Add failing CRUD/Refresh service tests**

Test unique names, first successful schema fetch before create, explicit
Refresh replacing cache atomically, failed Refresh preserving cache, rename and
delete, fingerprint mismatch, and project-close clearing.

- [ ] **Step 5: Implement thin commands and typed frontend wrapper**

Register:

```rust
commands::data_link_commands::create_data_link,
commands::data_link_commands::rename_data_link,
commands::data_link_commands::delete_data_link,
commands::data_link_commands::connect_data_link,
commands::data_link_commands::refresh_data_link,
commands::data_link_commands::list_data_link_statuses,
```

Each command delegates to `DataLinkService` and participates in the repository
mutation guard where it changes project state.

- [ ] **Step 6: Write failing Zustand tests**

Assert that create/rename/delete/successful Refresh call
`useProjectStore.getState().markDirty()`, failed Refresh retains the old cache
and does not mark a false success, and `clear()` removes all runtime state.

- [ ] **Step 7: Implement `useProjectDataLinkStore`**

The store holds `PersistedDataLink[]`, non-sensitive statuses, busy operation
IDs, and structured errors. Credential values remain local variables passed
directly to the service and never enter `set()`.

- [ ] **Step 8: Run focused backend/frontend tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml data_link_session -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml data_link_service -- --nocapture
npx tsx --tsconfig tsconfig.app.json tests/dataLinkStore.test.ts
git diff --check
```

Expected: PASS. Do not commit.

### Task 4: Replace Snapshot Import UI with the DataLink Manager

**Files:**
- Create: `src/components/dataLink/DataLinkManagerDialog.tsx`
- Create: `src/components/dataLink/DataLinkSchemaTree.tsx`
- Create: `src/components/dataLink/DataLinkCredentialsDialog.tsx`
- Modify: `src/components/dataLink/dataLink.css`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/DataLinkManagerHarness.tsx`
- Create: `tests/dataLinkManager.spec.tsx`
- Modify: `tests/workspaceDataLink.test.ts`

**Interfaces:**
- Consumes: `useProjectDataLinkStore` from Task 3.
- Produces: `DataLinkManagerDialog({ onClose }: { onClose: () => void })`.
- Produces: `DataLinkCredentialsDialog` callback with credentials submitted
  directly to the store action.
- Produces: one Workspace-level `showDataLinkManager` state and File-menu entry.

- [ ] **Step 1: Write failing manager component tests**

Test add for SQLite and PostgreSQL, Test Connection before create, status labels,
explicit Refresh, failed Refresh retaining the rendered schema, rename, delete
confirmation, and password-field clearing after submit/close.

- [ ] **Step 2: Run component tests and confirm RED**

Run: `npx playwright test -c playwright-ct.config.ts tests/dataLinkManager.spec.tsx --output test-results/issue-263-manager-red`

Expected: FAIL because the manager harness/components do not exist.

- [ ] **Step 3: Implement the manager and schema tree**

Keep connector forms local to the dialog. Render cached catalogs/schemas/objects
from persisted documents. Display `refreshedAt` and status independently so a
failed connection cannot erase the last successful cache time.

- [ ] **Step 4: Replace Workspace dialog routing**

The File menu opens one `DataLinkManagerDialog`. Remove Workspace ownership of
the existing SQLite/PostgreSQL snapshot-import dialog state only after the new
manager is wired. Hydrate the DataLink store from `openProject().dataLinks`,
include `dataLinks` in save requests, and call `clear()` on project close.

- [ ] **Step 5: Add complete locale parity**

Add the same keys in all four locale files for Add, Connect, Reconnect,
Refresh, Rename, Delete, cached schema, credentials required, stale schema, and
the structured error categories. The locale contract test must compare key
sets.

- [ ] **Step 6: Run UI and Workspace contracts**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/dataLinkManager.spec.tsx --output test-results/issue-263-manager-green
npx tsx --tsconfig tsconfig.app.json tests/workspaceDataLink.test.ts
npx tsx --tsconfig tsconfig.app.json tests/dataLinkProjectContracts.test.ts
git diff --check
```

Expected: PASS. Do not commit.

### Task 5: Extend SQL AST Validation with Typed DataLink Resolution

**Files:**
- Modify: `src-tauri/src/engine/sql_query.rs`
- Modify: `src-tauri/src/models/data_link.rs`

**Interfaces:**
- Consumes: validated `PersistedDataLink` documents from Task 2.
- Produces `AllowedRelationCatalog`.
- Produces `ResolvedReadOnlyQuery { sql: String, data_link_bindings: Vec<ResolvedDataLinkBinding> }`.
- Consumes and populates `ResolvedDataLinkBinding` from Task 1.
- Replaces `validate_read_only_query(sql, allowed_tables)` with `resolve_read_only_query(sql, &AllowedRelationCatalog)`.
- Preserves a compatibility wrapper for internal callers until Task 6 migrates them.

```rust
pub struct AllowedRelationCatalog {
    pub project_tables: HashSet<String>,
    pub data_links: Vec<PersistedDataLink>,
}

pub struct ResolvedReadOnlyQuery {
    pub sql: String,
    pub data_link_bindings: Vec<ResolvedDataLinkBinding>,
}
```

- [ ] **Step 1: Write failing qualified-relation tests**

```rust
#[test]
fn resolves_project_sqlite_and_server_relations() {
    let resolved = resolve_read_only_query(
        r#"SELECT * FROM "Customers" c
           JOIN "Local"."orders" l ON c.id = l.id
           JOIN "Production"."public"."orders" p ON c.id = p.id"#,
        &catalog(),
    ).unwrap();
    assert_eq!(resolved.data_link_bindings.len(), 2);
}
```

Also assert rejection of unknown aliases, wrong qualification depth, cached
views/objects absent from the cache, hidden scanner functions in subqueries,
user `ATTACH`/DDL/DML, and CTE shadowing behavior.

- [ ] **Step 2: Run SQL tests and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml engine::sql_query -- --nocapture`

Expected: FAIL because qualified relations are still rejected.

- [ ] **Step 3: Implement typed resolution**

Resolve each relation to either a project alias, CTE, or immutable
`ResolvedDataLinkBinding` containing DataLink ID, connector, and source object
identity. Rewrite the internal AST relation to deterministic aliases
`__datalink_0`, `__datalink_1`, while preserving user aliases and collecting
bindings in first-use order.

- [ ] **Step 4: Preserve the complete existing AST traversal**

Do not add a keyword scan. Keep current recursion through CTEs, derived queries,
joins, subqueries, wildcard replacement expressions, JSON path expressions,
window expressions, and set operations. Table functions remain rejected.

- [ ] **Step 5: Run SQL security coverage**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml engine::sql_query -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml sql_query -- --nocapture
git diff --check
```

Expected: all existing tests plus new DataLink tests pass. Do not commit.

### Task 6: Execute and Materialize DataLink-Aware SQL

**Files:**
- Modify: `src-tauri/src/services/data_link_query_runtime.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src/services/dataService.ts`
- Modify: `src/types/data.ts`

**Interfaces:**
- Consumes: `ResolvedReadOnlyQuery`, `ResolvedDataLinkBinding`,
  `DataLinkSessionRegistry`, and packaged scanner resources.
- Produces structured `SqlQueryError` with
  `credentialsRequired | schemaStale | objectNotFound | extensionUnavailable | query`.
- Changes preview and Create Table commands to return/throw the structured
  error without exposing secret fields.

- [ ] **Step 1: Write failing execution tests**

Cover SQLite preview, project/SQLite join, complete Create Table
materialization, missing credentials listing only DataLink IDs, stale schema,
missing live object, extension unavailable, and transaction rollback.

- [ ] **Step 2: Run focused execution tests and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml data_link_sql -- --nocapture`

Expected: FAIL because DuckDbEngine does not accept DataLink catalogs or
session bindings.

- [ ] **Step 3: Build the isolated connection**

Copy visible project Tables using the existing snapshot path. Load fixed
packaged extensions through `DataLinkQueryRuntime`, bind each collected
DataLink relation exactly once, and execute only the rewritten internal query.
Destroy the connection on every success/error path.

- [ ] **Step 4: Add structured credential and stale-cache errors**

The credentials-required payload contains only:

```rust
pub struct CredentialsRequiredDetail {
    pub data_link_id: String,
    pub connector: ConnectorKind,
}
```

Do not include host, username, password, connection string, or SQLite path.

- [ ] **Step 5: Preserve preview and Create Table behavior**

Preview keeps page size `1..=200`. Create Table revalidates the query, reruns it
without trusting preview rows, and commits physical table plus metadata in one
transaction. No partial Table remains after scanner, conversion, or metadata
failure.

- [ ] **Step 6: Prove scanner execution and pushdown**

For a fixture with many rows, assert the scanner node includes the requested
projection and that no complete source object is staged. When a connector
places the predicate inside the scanner node, assert predicate pushdown and
reduced transferred rows. When it leaves the predicate in a DuckDB `FILTER`,
assert that execution shape explicitly and treat it as a supported,
connector-capability-dependent path.

- [ ] **Step 7: Run execution and regression coverage**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml data_link_sql -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml create_table_from_sql_query -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml execute_sql_query -- --nocapture
git diff --check
```

Expected: PASS. Do not commit.

### Task 7: Add DataLink Schema Browsing and Credential Retry to SQL Query

**Files:**
- Modify: `src/components/SqlQueryDialog.tsx`
- Modify: `src/components/sqlQueryDialog.css`
- Modify: `src/applicationCommands/sqlCommands.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src/types/data.ts`
- Create: `tests/SqlQueryDataLinkHarness.tsx`
- Create: `tests/sqlQueryDataLink.spec.tsx`
- Create: `tests/sqlQueryDataLink.test.ts`
- Modify: `tests/applicationCommandSql.test.ts`

**Interfaces:**
- Consumes: DataLinks/statuses from `useProjectDataLinkStore`.
- Consumes: structured SQL query errors from Task 6.
- Produces fully quoted identifier insertion.
- Produces unchanged-query retry after transient credential submission.
- Preserves current application-command adapter behavior and Create Table flow.

- [ ] **Step 1: Write failing helper and component tests**

Assert exact insertion:

```typescript
expect(qualifiedDataLinkIdentifier(sqliteLink, sqliteObject))
  .toBe('"Local SQLite"."orders"');
expect(qualifiedDataLinkIdentifier(postgresLink, postgresObject))
  .toBe('"Production DB"."public"."orders"');
```

Component tests cover cached tree rendering without connection, status badges,
Manage DataLinks shortcut, credentials-required prompt, password absence from
store state, unchanged SQL retry, stale-schema Refresh guidance, and Create
Table after a successful DataLink preview.

- [ ] **Step 2: Run SQL UI tests and confirm RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/sqlQueryDataLink.test.ts
npx playwright test -c playwright-ct.config.ts tests/sqlQueryDataLink.spec.tsx --output test-results/issue-263-sql-red
```

Expected: FAIL because DataLink browsing and retry do not exist.

- [ ] **Step 3: Implement grouped object browser**

Render `Project Tables` and `DataLinks` groups. Build inserted identifiers from
cached typed identities, not concatenated display fragments. Quote every
identifier component by doubling embedded quotes.

- [ ] **Step 4: Implement credentials retry**

When the backend returns `credentialsRequired`, open
`DataLinkCredentialsDialog` for the listed IDs. Submit credentials directly to
the Rust service, discard local form values, then call `runQuery` with the exact
previous successful request SQL and page. Revalidation remains backend-owned.

- [ ] **Step 5: Preserve application-command parity**

Update adapters and tests so UI and MCP SQL commands share the same backend
errors and materialization path. MCP receives structured credentials-required
failure; it does not open UI or obtain credentials.

- [ ] **Step 6: Run focused SQL frontend coverage**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/sqlQueryDataLink.test.ts
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandSql.test.ts
npx playwright test -c playwright-ct.config.ts tests/sqlQueryDataLink.spec.tsx --output test-results/issue-263-sql-green
git diff --check
```

Expected: PASS. Do not commit.

### Task 8: Remove Superseded Snapshot UI, Update Documentation, and Run Final Gates

**Files:**
- Delete after replacement coverage passes: `src/components/dataLink/SqliteDataLinkDialog.tsx`
- Delete after replacement coverage passes: `src/components/dataLink/PostgresDataLinkDialog.tsx`
- Delete after replacement coverage passes: `tests/DataLinkHarness.tsx`
- Modify: `src/stores/useDataLinkStore.ts` or delete it if no non-snapshot consumer remains
- Modify: `src/services/dataLinkService.ts`
- Modify: `src-tauri/src/commands/data_link_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `tests/dataLink.spec.tsx`
- Modify: `tests/workspaceDataLink.test.ts`
- Modify: `docs/spec.md`
- Modify: `docs/scaffold.md`
- Modify: `README.md`

**Interfaces:**
- Consumes all completed tasks.
- Produces one supported DataLink manager/query workflow with no orphan snapshot
  UI entry points.
- Preserves reusable connector discovery and schema APIs needed by the manager.

- [ ] **Step 1: Add failing removal contracts**

Update `workspaceDataLink.test.ts` to reject imports/mounts of the old snapshot
dialogs and require the manager, project store, schema tree, and SQL Query
DataLink browser.

- [ ] **Step 2: Run the removal contract and confirm RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workspaceDataLink.test.ts`

Expected: FAIL while old snapshot UI remains.

- [ ] **Step 3: Remove only superseded surfaces**

Delete old components/harnesses and snapshot-only store actions. Keep connector
test/discovery/schema methods used by the new manager. Remove obsolete Tauri
commands only when no TypeScript, Rust, test, benchmark, or documentation
consumer remains.

- [ ] **Step 4: Update product documentation**

Document `.spprj/datalink/`, secret-free schema caching, session credentials,
qualified SQL syntax, explicit Refresh, packaged scanner resources, structured
errors, and the removal of automatic snapshot import from the DataLink entry.

- [ ] **Step 5: Run the complete focused frontend gate**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/dataLinkProjectContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/dataLinkStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceDataLink.test.ts
npx tsx --tsconfig tsconfig.app.json tests/sqlQueryDataLink.test.ts
npx tsx --tsconfig tsconfig.app.json tests/applicationCommandSql.test.ts
npx playwright test -c playwright-ct.config.ts tests/dataLinkManager.spec.tsx tests/sqlQueryDataLink.spec.tsx --output test-results/issue-263-final
```

Expected: PASS with nonzero executed test counts and zero failures.

- [ ] **Step 6: Run the complete Rust gate**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml data_link -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml sql_query -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml spprj_archive -- --nocapture
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS with nonzero executed test counts and zero failures.

- [ ] **Step 7: Run final product checks**

Run:

```bash
npm run build
node --test scripts/duckdbExtensionsCore.test.mjs
git diff --check
git status --short --untracked-files=all
```

Expected: frontend build succeeds, extension integrity tests pass, no whitespace
errors exist, and status contains only Issue 263 source/docs/tests plus generated
paths explicitly allowed by the development workflow.

- [ ] **Step 8: Run independent review**

Dispatch an independent reviewer with Issue 263, base SHA
`445046c84a7a12845f108596a5de67aaf81a030f`, the approved spec, this plan, and
the actual uncommitted diff including untracked files. Fix every Critical or
Important finding and rerun affected focused/full gates.

- [ ] **Step 9: Prepare manual acceptance**

Launch the app from the worktree with:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/263-persistent-datalinks run tauri -- dev
```

Verify the process paths and port belong to this worktree. Ask the user to
exercise all nine scenarios in the spec's Manual Acceptance section. Stop
without committing, pushing, or creating a PR.

- [ ] **Step 10: Commit and PR only after explicit manual acceptance**

After acceptance, rerun fresh final gates, inspect the bounded diff, stage only
Issue 263 files, commit with a Conventional Commit message and required
co-author trailer, push without force, and create a PR to `dev` using the
repository PR template. Preserve the worktree for review feedback and do not
merge automatically.

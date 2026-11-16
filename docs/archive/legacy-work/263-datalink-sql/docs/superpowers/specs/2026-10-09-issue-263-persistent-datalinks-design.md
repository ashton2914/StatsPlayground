# Issue 263 Persistent DataLinks Design

## Status

Approved in conversation on 2026-10-09 and narrowed on 2026-10-10 to SQLite
and PostgreSQL after the MySQL feasibility gate failed. Implementation remains
gated by the implementation plan, automated verification, and manual
acceptance.

## Problem

DataLink currently provides an ephemeral discovery, preview, and snapshot
import flow. Connection definitions and credentials are passed into each IPC
call, the frontend store resets when the dialog closes, and the project archive
contains no DataLink document or schema index. SQL Query accepts only project
table aliases and CTEs and intentionally rejects external relations.

This forces users to copy complete source objects into the project before they
can use SQL Query. Large source databases therefore create unnecessary import
time and project size.

Issue 263 changes DataLink into a persistent project document. A project stores
secret-free connection metadata and a cached source schema. SQL Query can
reference registered DataLinks directly and materialize only the selected query
result as a project Table.

## Goals

- Persist SQLite and PostgreSQL DataLinks inside the `.spprj` archive.
- Store each DataLink as a versioned `datalink/<id>.json` document indexed by
  `manifest.json`.
- Persist connection metadata and the last successful schema index without
  persisting credentials or absolute local paths.
- Require PostgreSQL credentials again in each application session.
- Require the SQLite source file to be reselected after reopening a project.
- Expose cached DataLink objects in SQL Query with qualified relation names.
- Support joins between project Tables and DataLink relations.
- Use a visible, explicit Refresh action; never contact external databases just
  because a project opened.
- Let Create Table materialize the complete successful query result through the
  existing transactional project-table path.
- Preserve the existing read-only SQL boundary and backward compatibility with
  projects that have no DataLinks.

## Non-Goals

- Persisting passwords, access tokens, private keys, complete connection
  strings, or OS-keychain references.
- Automatically refreshing schema when a project opens.
- Background synchronization, incremental replication, live Table documents,
  or automatic refresh of materialized project Tables.
- Allowing user-authored `ATTACH`, `INSTALL`, `LOAD`, `COPY`, arbitrary table
  functions, DDL, or DML.
- Providing a generic database administration client.
- Silently falling back to full snapshot import when direct querying is not
  available.

## Chosen Architecture

The backend owns a controlled DuckDB DataLink query environment.

For each SQL request, the engine creates an isolated query connection, copies
the visible project Tables using the existing snapshot behavior, loads only
application-bundled scanner extensions, and binds only the DataLinks referenced
by the validated SQL AST. The user query cannot configure the scanner, attach a
database, or supply a connection string.

The isolated connection is destroyed after preview or materialization. Server
credentials live only in a Rust session registry and are never returned to the
frontend after submission.

### Rejected Alternatives

1. **Execute SQL directly in each existing connector.** This prevents reliable
   joins with project Tables and other DataLinks and exposes source-specific SQL
   dialect differences.
2. **Stream referenced objects into temporary DuckDB tables.** This can still
   transfer entire source tables and defeats the primary large-database goal.
3. **Allow user-authored DuckDB `ATTACH`.** This breaks the current SQL security
   boundary and exposes connection strings and arbitrary external access.

## Phase 0 Feasibility Gate

Implementation must first prove all of the following against the repository's
exact bundled DuckDB version:

1. SQLite and PostgreSQL scanner extensions can be packaged as Tauri
   resources for every supported target and loaded without a runtime download.
2. The backend can configure an attachment or equivalent scanner relation
   through a structured native API. Credentials and user-controlled paths must
   not be interpolated into SQL text.
3. Project Tables and at least one scanner-backed relation can be queried in the
   same isolated connection.
4. Scanner-backed queries push requested projections into the source scanner
   and do not stage the complete source object. Predicate pushdown is
   connector-capability-dependent: use and test it when the scanner exposes
   it, but allow DuckDB-side filtering when it does not.
5. The existing AST boundary can reject all user-authored external operations
   while accepting backend-resolved DataLink relations.

The feasibility test may use local fixtures and must not change product
behavior. If the current Rust DuckDB wrapper does not expose the required
structured API, the implementation may add a narrow typed wrapper over the
bundled DuckDB C API. It must not fall back to connection-string SQL
concatenation. Failure of any gate returns the design for review before feature
implementation. Lack of predicate pushdown alone is not a gate failure when
the plan proves scanner-backed access, projection pushdown, and DuckDB-side
filtering without full-object staging.

## Archive Contract

### Layout

```text
manifest.json
datalink/<uuid>.json
data/<project documents>
...
```

`ProjectManifest` gains a default-empty DataLink index:

```json
{
  "dataLinks": [
    {
      "id": "a stable UUID",
      "name": "Production DB",
      "file": "datalink/<uuid>.json"
    }
  ]
}
```

Missing `dataLinks` means an older project with no DataLinks.

### DataLink Document

Each document contains:

- `formatVersion`
- stable `id`
- unique display `name`
- `connector`: `sqlite` or `postgresql`
- secret-free connection definition
- last successful refresh timestamp
- cached catalogs, schemas, tables, views, and columns
- column type, nullable state, and primary-key metadata
- source object identity needed for qualified SQL resolution
- cache status and the most recent refresh error category
- SQLite display filename and source fingerprint

PostgreSQL connection metadata may include host, port, database,
authentication type, TLS mode, and a public CA certificate. It never includes a
password, token, private key, or complete connection string.

SQLite documents never contain an absolute path. After reopening a project,
the user selects the source file again. The backend compares its fingerprint
with the persisted fingerprint and requires explicit confirmation before
rebinding a different file.

### Validation

Archive input is untrusted. Opening a DataLink validates:

- supported format version and connector;
- UUID identity and index/document consistency;
- relative `datalink/<uuid>.json` path without traversal;
- case-insensitive unique DataLink names;
- bounded DataLink, object, column, and string counts;
- valid source object hierarchy and duplicate identities;
- connector-appropriate connection fields;
- absence of credentials and prohibited path fields.

Invalid DataLink metadata fails project opening with an explicit archive error;
it is not silently dropped.

### Save and Dirty State

Create, rename, delete, rebind, and successful Refresh mark the project dirty.
Save writes the manifest and all DataLink documents through the existing atomic
project-save pipeline. Refresh failure updates runtime error state but does not
replace the last successful cache or create a misleading saved success state.

Deleting a DataLink does not delete Tables previously materialized from it.

## Runtime State

Rust owns a project-scoped registry keyed by DataLink ID:

- `authenticationRequired`
- `connected`
- `connectionError`

The registry stores submitted credentials and the resolved SQLite file grant
only for the active project session. Closing the project or application clears
the registry.

Credentials cross the IPC boundary only when the user connects, refreshes, or
answers a `credentialsRequired` query response. They are not stored in Zustand,
returned by a read command, logged, included in diagnostics, or serialized.

The frontend stores only non-sensitive status and cached metadata.

## SQL Contract

### User Syntax

Project Table:

```sql
SELECT * FROM "Customers"
```

PostgreSQL DataLink:

```sql
SELECT * FROM "Production DB"."public"."orders"
```

SQLite DataLink:

```sql
SELECT * FROM "Local SQLite"."orders"
```

Cross-source joins use the same qualified names.

### Resolution

The SQL validator requires exactly one top-level read-only query.

- A one-part relation must resolve to a unique visible project Table or a CTE.
- A two-part relation must resolve to a cached SQLite DataLink object.
- A three-part relation must resolve to a cached PostgreSQL schema object.
- Every DataLink ID and source object identity comes from the validated project
  model, not from user-generated connection configuration.
- Unknown aliases, missing objects, stale objects, and unsupported qualification
  depth are rejected before execution.

After validation, the backend produces an internal resolved query plan and
binds the referenced relations to the isolated connection. User SQL remains
unable to call scanner functions or issue external-control statements.

### Execution

Only DataLinks referenced by the query are connected. If credentials or SQLite
authorization are missing, execution returns structured
`credentialsRequired` details identifying the DataLink IDs, without echoing
connection strings.

After credentials are submitted, the frontend retries the unchanged query.
The engine revalidates it before execution.

Preview preserves the existing page-size and pagination contract. Create Table
reruns the validated complete query and uses the existing atomic managed-table
creation path. Failure leaves no partial physical table or metadata.

If the live source no longer matches the cached object identity, execution
returns `schemaStale` or `objectNotFound` and asks the user to Refresh. It does
not silently rewrite the query or cache.

## User Experience

### DataLink Manager

`File > DataLink...` opens a project-level manager.

The manager provides:

- saved DataLink list;
- Add DataLink for SQLite and PostgreSQL;
- connection and cache status;
- last successful Refresh time;
- Connect or Reconnect;
- explicit Refresh;
- Rename;
- Delete;
- cached schema summary.

Creating a DataLink tests the connection and obtains a complete schema index.
The DataLink is created only after the first schema fetch succeeds. It does not
import source rows.

Refresh is always user initiated. Success atomically replaces the schema cache
and marks the project dirty. Failure preserves the previous cache and shows the
latest error.

The existing multi-object snapshot-import wizard leaves the primary DataLink
flow. SQL Query plus Create Table replaces it with explicit projection,
filtering, joining, and materialization. Reusable connector discovery and
conversion code remains available to the new services; obsolete UI and command
surfaces are removed only after their replacement coverage is in place.

### SQL Query

The object browser contains:

```text
Project Tables
DataLinks
  <DataLink>
    <schema when applicable>
      <table or view>
```

Selecting an object inserts its fully quoted identifier. DataLinks display
connected, credentials-required, connection-error, and stale-cache states. SQL
Query includes a shortcut to Manage DataLinks.

## Error Contract

DataLink operations use structured categories:

- `credentialsRequired`
- `connection`
- `authentication`
- `tls`
- `permission`
- `schemaStale`
- `objectNotFound`
- `extensionUnavailable`
- `query`
- `cancelled`
- `storage`

Errors never contain passwords, tokens, complete connection strings, private
keys, or absolute local paths. Worker and cleanup errors do not replace a more
actionable source error.

## IPC and Service Boundaries

New commands remain thin and delegate to services. The expected command groups
are:

- list/get DataLink documents and runtime status;
- create, rename, delete, and rebind;
- connect or reconnect with session credentials;
- refresh schema;
- resolve credentials-required execution and retry.

Every command is registered in the Tauri handler and wrapped by a typed
TypeScript service. Rust models use camelCase serialization and have matching
TypeScript contracts. Shared frontend state lives in a Zustand project
DataLink store; dialogs remain presentation-focused.

Project archive logic owns serialization. DataLink services own connector and
runtime state. SQL resolution owns AST validation and relation binding. The UI
must not duplicate security or source-resolution rules.

## Testing

### Rust

- DataLink model serialization and secret exclusion.
- Archive round-trip for SQLite and PostgreSQL.
- Compatibility with archives that omit DataLinks.
- Index/document mismatch, traversal, duplicate name, unsupported version, and
  size-limit rejection.
- Save/open dirty-state behavior.
- Session credential lifecycle and clearing.
- SQL relation resolution for project, SQLite, PostgreSQL, and CTE
  relations.
- Cross-source joins.
- Rejection of arbitrary attach/load/install/table-function/DDL/DML input.
- Stale cache and missing-object behavior.
- Atomic Create Table failure behavior.
- SQLite scanner integration by default.
- PostgreSQL protocol fixtures or mocks by default, with explicitly gated live
  database tests.
- Projection pushdown evidence for representative queries, plus
  connector-specific predicate pushdown evidence where supported.
- Explicit coverage that a scanner may retain a predicate in a DuckDB `FILTER`
  operator without staging the complete source object.

### TypeScript and Component Tests

- Manager create, reconnect, refresh, rename, and delete.
- Refresh failure retaining the last successful cache.
- SQL object tree and qualified identifier insertion.
- Credentials-required collection and unchanged-query retry.
- DataLink status presentation.
- Create Table success and failure behavior.
- Project dirty and close-confirmation integration.

### Final Gates

- focused RED/GREEN checks for each slice;
- affected frontend suites and Vite build;
- focused Rust tests, `cargo build`, `cargo clippy`, and `cargo test`;
- scanner resource integrity checks for supported targets;
- `git diff --check`;
- independent review;
- manual desktop acceptance before commit and pull request creation.

## Manual Acceptance

Manual acceptance must cover:

1. Create, save, close, and reopen one DataLink of each connector type.
2. Confirm cached schema is visible without contacting the source on open.
3. Confirm server credentials and the SQLite file are requested on first use.
4. Refresh successfully and observe updated cache metadata.
5. Force Refresh failure and confirm the previous cache remains.
6. Query each DataLink and join at least one with a project Table.
7. Create a project Table from a filtered DataLink query.
8. Confirm forbidden external SQL remains blocked.
9. Inspect the saved archive and confirm no credentials or absolute SQLite path
   are present.

## Delivery Sequence

1. Prove the Phase 0 feasibility gate.
2. Add persistent models and archive round-trip.
3. Add backend session registry and lifecycle commands.
4. Add manager UI and project dirty integration.
5. Add DataLink-aware SQL resolution and isolated scanner execution.
6. Add SQL Query object browser and credentials retry.
7. Remove superseded snapshot-import UI surfaces.
8. Complete full verification, independent review, and manual acceptance.

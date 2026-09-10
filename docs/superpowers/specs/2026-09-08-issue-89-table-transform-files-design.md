# Issue 89 Table Transform File Design

**Status:** Approved design
**Date:** 2026-09-08
**Branch:** `feat/issue-89-table-transform-files`
**Issue:** https://github.com/ashton2914/StatsPlayground/issues/89
**Parent:** https://github.com/ashton2914/StatsPlayground/issues/50

## Purpose

StatsPlayground table operations currently execute immediately against concrete
dataset IDs. Most operations create a new table with a random ID, while Update
mutates its left input in place. The operation parameters disappear after
execution, so the result cannot be rebound to another upstream table or used as
a stable intermediate Workflow node.

Issue 89 introduces a standalone Table Transform document with the `.sptbtf`
extension. A Table Transform records how one or more input tables produce one
stable output table. Rebinding or updating an upstream table reruns the same
definition and atomically refreshes the output without changing the output
document ID or downstream lineage.

## Scope

Version 1 supports all existing Table Transform operations:

- Sort
- Subset
- Transpose
- Stack
- Split
- Summary
- Join
- Update
- Concatenate

This issue owns the reusable definition, execution contract, stable output,
project persistence, standalone import/export, explicit input rebinding, and
lineage integration for those operations.

This issue does not implement automatic graph-wide Workflow scheduling, the
visual Workflow editor, `.spwf` export, or SQL Query extraction. Those remain
owned by Issues 54, 55, and 52. A Table Transform produced here is nevertheless
a valid intermediate lineage node that those features can execute later.

## Core Decisions

### A Table Transform Is a Project Document

`TableTransformDefinition` is a separately versioned, strongly typed project
document. It is not an opaque `OperationNode.configuration` object and not a
single-operation Workflow.

Each definition contains:

- Stable document ID and display name
- `formatVersion` and `revision`
- One of nine typed operation configurations
- One or more named input slots
- A schema contract for each input slot
- One stable output Table document reference and output name

The `.sptbtf` body contains no table rows and no concrete upstream dataset IDs.
Concrete project bindings belong to project state and lineage. This keeps the
standalone file portable between projects.

### Stable Output Identity

Every definition owns one output Table document ID. Initial execution creates
that output. Later execution, including execution after input rebinding,
replaces the output table's schema, rows, and display metadata under the same
document ID.

The output is an ordinary Table document, not a Transform-specific table type.
Stack and every other operation therefore produce tables with the same filter,
graph, analysis, project-save, and standalone-export behavior as imported or
manually created tables. The `.sptb` suffix shown in the project tree identifies
the logical Table document and its standard serialization format; it does not
assert that a standalone `.sptb` file already exists on disk.

The executor computes into a temporary table first. It validates the completed
result and then swaps it into the stable output in one database transaction. If
validation or execution fails, the temporary table is discarded and the prior
output remains unchanged. Downstream documents and lineage edges therefore
continue to reference the same output ID.

Update follows this derived-output rule. It no longer mutates the left input
when executed as a Table Transform. Its output is the left table with matching
values updated from the right table.

### Input Roles

Input slots have stable role names:

| Operation | Input roles |
| --- | --- |
| Sort, Subset, Transpose, Stack, Split, Summary | `source` |
| Join, Update | `left`, `right` |
| Concatenate | ordered `sources[]` |

Project bindings map each role to a concrete Table document ID. Rebinding a role
does not alter the definition or output identity.

### Strongly Typed Configuration

Rust owns a tagged `TableTransformOperation` enum. Every variant contains only
the parameters required by its existing table operation. TypeScript mirrors the
same discriminated union in camelCase.

The first version preserves existing operation semantics and validation. It
does not add expressions, implicit type conversion, fuzzy column matching, or
operation modes that do not exist today.

## Schema Contracts

Each input slot stores a `SchemaContract` using the existing Workflow domain
types. Contracts include only columns referenced by the operation definition:

- Sort requires its sort columns.
- Subset requires selected and filter-referenced columns.
- Stack requires stack and identifier columns.
- Split requires split, value, and identifier columns.
- Summary requires statistic and group columns.
- Join requires the key selected for each input.
- Update requires each side's match column and the right-side update columns;
  matching target columns must exist on the left.
- Concatenate requires the output-compatible columns established by the
  existing concatenate operation.
- Transpose records the complete source schema because every source column
  participates in the result.

Required names match exactly. DuckDB types match after existing canonical type
normalization. Extra columns are accepted unless an operation's semantics use
the complete schema. Schema preflight runs before temporary output creation.

A mismatch is a normal blocked result containing missing columns, type
mismatches, extra columns, and the affected input role. It is not converted to
an unstructured exception.

## Execution Service

Rust provides one Table Transform service as the authority for validation and
execution. Existing operation-specific DuckDB methods remain the compute
primitives, but they must accept an executor-provided output ID and name rather
than always allocating an ID in `DataService`.

The service flow is:

1. Validate the definition version and operation configuration.
2. Resolve every project input binding.
3. Load concrete input schemas and validate all slot contracts.
4. Create a unique temporary output identity.
5. Execute the selected operation into the temporary output.
6. Validate the result table and preserve applicable display metadata.
7. Atomically replace the stable output table with the temporary result.
8. Update the definition run state and concrete lineage without changing IDs.

The service returns a structured result with the definition ID, output table
metadata, status, schema report, and a path-safe error when blocked or failed.
Unexpected database and file failures remain `AppError` variants.

Concurrent reruns of one definition are serialized through the existing
mutation permit. A rerun uses the definition revision it started with; if the
definition revision changes before commit, the result is rejected instead of
replacing the output with stale work.

## Lineage Integration

The existing bipartite `ProjectLineageGraph` remains the only relationship
authority.

- Add `TableTransform` to `ProjectDocumentKind`.
- Add `TableTransform` to `OperationKind`.
- The operation node's `documentRef` points to the `.sptbtf` definition.
- Bound input Table artifacts connect to the operation with `consumes` edges.
- The operation connects to its stable output Table artifact with one
  `produces` edge.

Rebinding replaces only the affected `consumes` edge. The operation node,
definition document, output artifact, `produces` edge, and downstream edges keep
their stable identities.

The project graph stays acyclic because Update produces a distinct derived
artifact rather than mutating an input artifact in place.

## Persistence

### Standalone `.sptbtf`

The file is pretty JSON in version 1, matching current standalone `.sptb` and
`.spgh` conventions. Read and write functions validate the extension-independent
body shape, format version, operation parameters, unique input roles, schema
contracts, and output reference.

Export writes only the portable definition. Import allocates a fresh definition
ID and output Table ID, clears concrete bindings and run state, and returns an
unbound definition for the user to bind before execution. Import never silently
binds a table by matching its name.

### Project Archive

The `.spprj` manifest gains an additive, default-empty indexed collection for
Table Transform documents. New project archives write each definition as an
independent `.sptbtf` entry using the existing collision-safe name allocation.
Bindings and lineage remain project metadata and reference stable document IDs.
Each materialized output is serialized through the normal Table writer as an
embedded `.sptb` entry. No separate table format or archive path is introduced
for Transform outputs.

Creating, rebinding, or rerunning a Transform changes project state and marks
the project dirty. Before project save, its definition, bindings, run state, and
materialized output exist in runtime/project state only. Confirming the operation
does not write a standalone `.sptbtf` or `.sptb` file. Saving the project embeds
both entries in `.spprj`; exporting the Transform or output Table is a separate,
explicit action that writes the corresponding standalone file. Closing without
saving follows the common save/discard/cancel flow, and discard may remove the
unsaved definition and output.

Existing archives load with no Table Transform definitions. Adding defaulted
collections does not by itself require an archive major-version increase.
Readers reject missing indexed entries, duplicate IDs, manifest/body mismatches,
invalid definitions, missing bound inputs, missing stable outputs, and lineage
references to unknown definitions.

## Frontend Behavior

The existing Table operation toolbar and parameter dialogs remain the creation
surface. Confirming a dialog now:

1. Creates a named Table Transform definition from the form values.
2. Captures minimal input schema contracts through the backend.
3. Creates project bindings and lineage nodes/edges.
4. Executes the definition once.
5. Opens the stable output table on success.

The project tree displays the `.sptbtf` document separately from its output
`.sptb` table. Opening the Transform displays its operation, parameters, current
bindings, schema status, stable output, last run status, and actions to rebind
or rerun. Shared state belongs in a Zustand Table Transform store; React
components remain presentation and interaction surfaces.

Standalone Import/Export actions use `.sptbtf` file filters. An imported
definition is visibly unbound and cannot run until all roles have compatible
table bindings.

## Compatibility

Existing direct IPC commands remain available while the UI migrates, so callers
outside the new document flow do not break. Their operation semantics remain
unchanged except that shared lower-level compute accepts an explicit destination
identity.

Existing `.sptb` files remain pure table documents and do not gain transform
configuration. Existing project archives and table operation results continue
to load.

## Error Handling

- Invalid `.sptbtf` bodies return `AppError::FileIO` with a path-safe format
  message for standalone reads.
- Invalid parameters and referential problems return `AppError::InvalidParam`.
- DuckDB execution and atomic replacement failures return
  `AppError::Database`.
- Schema incompatibility returns a structured blocked execution result and does
  not modify the output.
- Failed initial execution leaves the definition present and visibly failed but
  does not create a partial output table or dangling `produces` edge.
- Failed reruns preserve the previous output and downstream lineage.

No error returned to the frontend contains an absolute filesystem path.

## Test Strategy

Implementation follows red-green-refactor. Focused tests cover:

- Serialization and validation for all nine operation variants
- Exact input role rules and minimal schema contract derivation
- Standalone `.sptbtf` read/write round-trip
- Standalone import allocating fresh definition and output IDs
- Project archive indexed-entry round-trip and legacy default loading
- Manifest/body ID and name validation
- Lineage creation for one-input, two-input, and ordered multi-input operations
- Rebinding replacing only the correct `consumes` edge
- Stable output ID across successful reruns
- Atomic replacement updating content while preserving downstream references
- Schema mismatch blocking before output creation
- Initial execution failure leaving no partial output
- Rerun failure preserving prior output content
- Revision fencing rejecting stale execution results
- Update producing a derived output without mutating either input
- TypeScript/Rust DTO parity and IPC registration
- Store creation, rebinding, rerun, persistence, and error states
- Workspace creation flow and standalone Import/Export wiring

Final verification includes focused frontend contract tests, focused Rust
service/archive tests, the full applicable frontend test set, `npm run build`,
`cargo test`, `cargo clippy -- -D warnings`, and `git diff --check`.

## Acceptance Criteria

Issue 89 is complete when:

1. All nine existing Table Transform operations can be represented by a
   validated, strongly typed `.sptbtf` definition.
2. A definition can be saved in a project, exported, imported into another
   project, rebound to schema-compatible inputs, and executed.
3. Every definition owns one stable output Table ID that remains unchanged
   across reruns and input rebinding.
4. Successful reruns atomically refresh the output content while all downstream
   document references and lineage edges remain valid.
5. Schema-incompatible inputs block execution with structured diagnostics before
   any output mutation.
6. Failed reruns preserve the last successful output.
7. Update is side-effect-free in the Transform flow and produces a derived table.
8. Project lineage represents concrete input, transform, output, and downstream
   relationships without a second relationship authority.
9. Existing `.spprj` and `.sptb` files continue to load and existing direct
   operation callers remain compatible.
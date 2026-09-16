# Issue 219 Calculated Table Columns Design

## Status And Traceability

- GitHub: [Issue 219](https://github.com/ashton2914/StatsPlayground/issues/219)
- ADO: [Task 1120771](https://1es4devices.visualstudio.com/MechanicalEngineering/_workitems/edit/1120771)
- Base branch: `origin/dev`
- Product design: approved on 2026-09-16

## Goal

Add materialized, column-level calculations to Table. A user defines one formula
for an output column, sees readable column names while editing, and receives a
physical result column whose values are stored with the final table data.

Formula dependencies use stable column UUIDs. Renaming or reordering a source
column must not change formula binding. Source-data mutations synchronously and
atomically recompute the affected calculated-column dependency closure.

## Product Decisions

1. Calculated columns are first-class Table data, not cell formulas, frontend
   virtual columns, or opaque display extras.
2. Formula definitions and evaluation are owned by Rust. React edits and
   displays formulas but never computes table results.
3. V1 supports common row-level numeric and conditional expressions. It does
   not accept arbitrary SQL or executable code.
4. Recalculation is synchronous and atomic with the triggering table mutation.
5. Calculated cells are read-only. A user must choose **Convert to Values**
   before directly editing or pasting into them.
6. Normal deletion of a referenced column is blocked and identifies all direct
   and indirect dependent calculated columns.
7. Stable column UUIDs, formula definitions, and materialized values survive
   project save/reopen, standalone table export, and undo/redo.
8. Copying or importing a table creates a new identity namespace and repairs
   every internal formula reference in one transaction.

## Current System And Gap

DuckDB already assigns each live user column a globally unique
`_meta_columns.column_id`. A normal rename updates only `col_name`, so the UUID
survives. Column descriptors expose that identity to selected analysis and graph
paths.

The Table lifecycle does not yet preserve it consistently:

- `TableDoc` serializes column name, type, display properties, extras, and row
  values, but not `column_id` or a formula definition.
- Restore creates columns through the ordinary table-creation path and therefore
  generates new UUIDs.
- History records column positions, names, types, and snapshots, but not stable
  UUIDs or calculated definitions.
- `ColumnDisplayProps.extras` is indexed by `colIndex` and deliberately treated
  as opaque JSON by the backend. It is appropriate for Unit, Specification,
  Range, Notes, and Value Order, not executable formulas.
- The visible formula bar edits one cell as text. No generic Table formula
  parser, dependency graph, evaluator, mutation hook, or archive contract exists.

Issue 219 therefore starts with stable identity across the complete Table
lifecycle. A formula UI built before that foundation would silently break after
save/reopen or selected undo/redo paths.

## Architecture

### Ownership Boundaries

`_meta_columns` remains the authority for:

- dataset ID;
- stable column UUID;
- display order;
- display name;
- physical DuckDB type;
- modeling role and basic column statistics.

A new `_meta_calculated_columns` table is the authority for formula definitions.
Its output `column_id` is both primary key and foreign key into `_meta_columns`.
The physical dataset table remains the authority for materialized result values.

There is one write model. `TableDoc` is a versioned serialization of that model,
not a second live authority. `ColumnDescriptor.calculated` is a read-only IPC
projection assembled from the metadata tables and current descriptors. Neither
archive payloads nor IPC projections are written independently after a table is
restored into the live model.

`CalculatedColumnService` owns:

- parsing display formulas;
- resolving displayed column references to UUIDs;
- AST normalization and fingerprinting;
- type inference and function validation;
- dependency graph construction, cycle detection, and topological ordering;
- allowlisted DuckDB expression generation;
- set-based materialization and warning counts;
- dependent-column deletion protection;
- archive validation and UUID remapping.

A Table mutation coordinator owns the transaction around a source mutation,
calculated-column recomputation, history capture, dataset-generation increment,
and commit. Existing mutation commands delegate to this coordinator rather than
implementing formula hooks independently.

### Rejected Alternatives

Storing formulas directly in `ColumnDisplayProps.extras` is rejected because
extras are positional, frontend-shaped, and opaque to the backend. They cannot
provide stable dependency identity or authoritative execution.

Adding nullable formula fields directly to `_meta_columns` is rejected because
it mixes basic schema identity with a versioned expression document, dependency
graph, fingerprint, and runtime diagnostics.

Representing each calculated column as a Table Transform is rejected because a
single table would become a chain of table-producing nodes. That model conflicts
with the requested in-place physical result column and makes ordinary table
editing unnecessarily indirect.

## Formula Document

### Calculated Column Definition

The wire and archive model uses camelCase. The conceptual V1 shape is:

```text
CalculatedColumnDefinitionV1
  formulaId: UUID
  schemaVersion: "1"
  outputColumnId: UUID
  expression: CalculatedExpressionV1
  dependencyColumnIds: UUID[]
  inferredOutputType: "BIGINT" | "DOUBLE" | "BOOLEAN"
  fingerprint: SHA-256
```

`dependencyColumnIds` is a canonical first-occurrence traversal of the normalized
AST. It is persisted for fast validation and indexing, but it must exactly match
the IDs derived from `expression`. A mismatch is invalid archive data.

The fingerprint covers:

- formula schema version;
- canonical normalized AST;
- ordered dependency UUIDs;
- inferred output type.

It excludes output/display names, whitespace, localization, materialized values,
and project paths.

### Versioned AST

`CalculatedExpressionV1` is a tagged recursive enum with these nodes:

```text
columnRef { columnId }
numberLiteral { value }
booleanLiteral { value }
nullLiteral
unary { operator: plus | minus | not, operand }
binary { operator: add | subtract | multiply | divide, left, right }
comparison { operator: eq | ne | gt | ge | lt | le, left, right }
logical { operator: and | or, left, right }
function { function: abs | round | min | max | coalesce | if, arguments }
```

No AST node carries a column name. Names are resolved when parsing and inserted
when formatting for display.

### Display Syntax

Examples:

```text
ROUND(Length * Width, 2)
IF(Temperature > 80, MAX(Load, 0), COALESCE(BackupLoad, 0))
```

Identifiers that contain whitespace, punctuation, or reserved words display in
square brackets, for example `[Upper Limit]`. Literal `]` is escaped as `]]`.
Autocomplete inserts the correctly escaped display form.

The parser accepts names only as an authoring convenience. It resolves every
reference against the current dataset before returning a valid AST. Unknown or
ambiguous names fail validation. Persisted execution never resolves by name.

The formatter regenerates normalized display text from AST plus current column
descriptors. A source rename therefore changes presentation without rewriting
the formula document or fingerprint.

## V1 Expression Semantics

### Supported Types

V1 formula outputs are `BIGINT`, `DOUBLE`, or `BOOLEAN`.

- Unary plus/minus require numeric operands.
- `+`, `-`, and `*` return `BIGINT` only when both inputs are `BIGINT` and the
  operation succeeds without overflow; otherwise numeric promotion returns
  `DOUBLE`.
- `/` always returns `DOUBLE`.
- Comparisons require compatible operands and return `BOOLEAN` or `NULL`.
- `AND`, `OR`, and `NOT` use SQL three-valued Boolean logic.
- Strings, dates, lists, structs, blobs, and user-defined values are outside V1.

### Functions

- `ABS(value)` accepts one numeric argument and preserves its numeric type.
- `ROUND(value, digits)` accepts a numeric value and an integer literal `digits`
  in `-15..15`. It returns the input numeric type where DuckDB can preserve it;
  otherwise it returns `DOUBLE`.
- `MIN(a, b, ...)` and `MAX(a, b, ...)` accept two or more compatible numeric
  arguments and operate within one row. They are not aggregate functions.
- `COALESCE(a, b, ...)` accepts two or more type-compatible arguments and
  returns the first non-null value.
- `IF(condition, whenTrue, whenFalse)` requires a Boolean condition and
  compatible result branches. A `NULL` condition selects `whenFalse`.

Arithmetic, comparison, `ABS`, `ROUND`, `MIN`, and `MAX` are strict: a null
required operand produces null. `COALESCE` and `IF` have the explicit branching
behavior above.

### Evaluation Faults

A fault in one row must not abort materialization for every row. Division by
zero, numeric overflow, or another allowlisted numeric evaluation fault produces
`NULL` for that row and increments a typed warning count.

All V1 numeric results must be finite. DuckDB `NaN`, positive/negative infinity,
and a value outside the target `BIGINT` range are evaluation faults and normalize
to `NULL` before storage. `DOUBLE` underflow to a finite zero is not a fault.

The AST compiler emits both a value expression and fault predicates. Generated
DuckDB SQL uses safe evaluation and counts faults in the same transaction. A
legitimate null caused by source nulls, `IF`, or `COALESCE` is not counted as an
evaluation fault.

Syntax errors, unknown columns, ambiguous columns, incompatible types, invalid
function arity, self-reference, and dependency cycles are definition errors.
They are rejected before any schema or value mutation begins.

## Runtime Metadata Schema

The conceptual metadata table is:

```sql
CREATE TABLE _meta_calculated_columns (
    output_column_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    formula_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    expression_json TEXT NOT NULL,
    dependency_column_ids_json TEXT NOT NULL,
    inferred_output_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL
);
```

The service validates UUIDs and serialized AST structure before insert/update.
Every read joins back to `_meta_columns` by both dataset and output column. The
application enforces referential integrity transactionally because the in-memory
DuckDB metadata layer currently owns schema mutations directly.

Runtime `ready`, `broken`, and `unsupported` states are derived, not accepted as
trusted persisted state:

- `ready`: schema version is supported, dependencies exist, types match, and
  fingerprint validates;
- `broken`: supported definition is structurally valid but a dependency is
  missing or inconsistent due to damaged external data;
- `unsupported`: the formula schema version is unknown and retained read-only.

Normal application mutations do not create `broken`. Deletion protection and
atomic transactions prevent that state.

## Transaction Flows

### Validate Formula

`validate_calculated_column` is side-effect free:

1. verify dataset generation and resolve the optional existing output column;
2. tokenize and parse display text;
3. resolve column names to UUIDs;
4. normalize AST and infer types;
5. build the candidate dependency graph and reject self-reference/cycles;
6. return normalized display formula, dependencies, inferred type, downstream
   impact, fingerprint, and structured diagnostics.

Validation is advisory. The mutation command repeats every authoritative check
inside its transaction to prevent time-of-check/time-of-use races.

### Create Calculated Column

`upsert_calculated_column` with no output column ID:

1. acquire the application mutation permit;
2. begin a DuckDB transaction and verify `expectedGeneration`;
3. repeat parse, identity, type, and graph validation;
4. allocate a new output column UUID and collision-safe display name;
5. add the physical column at the requested visible index;
6. insert its formula definition;
7. topologically materialize the new column and affected downstream columns;
8. capture one history change set with definition, schema, and values;
9. increment dataset generation exactly once;
10. commit and return descriptor, generation, change-set ID, and warning counts.

Any failure rolls back the physical column, metadata, values, history record,
and generation change.

### Convert Existing Column

When `upsert_calculated_column` targets an ordinary column, it preserves the
column UUID, display order, and name. The transaction stores the original type
and values in history, adds the formula definition, changes the physical type if
required, and materializes the calculated result. Undo restores the exact
ordinary column.

### Edit Formula

Editing preserves the output column UUID, formula ID, display order, and name.
The transaction validates the candidate graph before replacing the old
definition. If inferred type changes, it changes the physical type and then
materializes the output and downstream closure. Undo restores the old AST,
fingerprint, type, values, and dependency behavior.

Renaming a calculated column is an ordinary name mutation. It does not change
formula identity, dependency identity, AST, or fingerprint.

### Source Mutations And Recalculation

Cell edit, batch update, clear, paste, row add/delete, source type change, and
their undo/redo paths use one coordinator flow:

```text
verify expected generation
-> capture source before image
-> apply source mutation
-> identify changed source column UUIDs
-> compute transitive calculated dependents
-> topologically order the affected closure
-> materialize one full column at a time
-> capture one unified history change set
-> increment generation once
-> commit
```

Row addition evaluates every calculated column for the new rows before commit.
Row deletion needs no value recomputation but remains one transaction with the
table and history changes. A rename or reorder does not recompute because UUID
dependencies and values are unchanged.

The user action creates one history entry regardless of how many calculated
columns are updated.

### Delete And Convert To Values

Before deleting a column, the service computes direct and transitive dependents.
If any exist, deletion fails with their UUIDs, display names, and dependency
paths. There is no cascade-delete option in V1.

Deleting a calculated column with no downstream dependents removes its physical
column and formula definition in one undoable transaction.

**Convert to Values** preserves the output UUID, name, type, order, and current
values and removes only its formula definition. Downstream calculated columns
continue to reference the same UUID and therefore remain valid.

After conversion, the column follows every ordinary-column rule. A later value
edit or paste into it recomputes its downstream dependent closure; a later type
change is allowed only when the proposed type remains compatible with every
dependent formula; and deletion remains blocked while dependents exist. Undoing
the conversion restores the removed definition and materializes its downstream
closure atomically.

The backend rejects direct cell edits, clears, paste targets, and explicit type
changes that include a calculated output column. UI disabling is convenience,
not the authority.

## History Model

History must preserve identity, not recreate equivalent-looking columns. Extend
column change-set records or add a dedicated calculated-column change-set table
with the following before/after data where applicable:

- column UUID, index, name, and type;
- ordinary or calculated status;
- raw versioned formula envelope;
- materialized before/after values;
- dataset generation transition.

The concrete persisted history envelope is:

```text
ColumnIdentitySnapshot
  columnId: UUID
  colIndex: integer
  name: string
  colType: string
  calculatedDefinition: RawVersionedDefinition | null

CalculatedHistorySnapshot
  changeSetId: UUID
  datasetId: UUID
  generationBefore: integer
  generationAfter: integer
  columnsBefore: ColumnIdentitySnapshot[]
  columnsAfter: ColumnIdentitySnapshot[]
  valuesBeforeSnapshotId: UUID | null
  valuesAfterSnapshotId: UUID | null
```

The before and after column arrays include every column whose identity, type,
definition, or physical values change, including transitively re-materialized
outputs. Existing temporary before/after relations remain the value-snapshot
mechanism; snapshot IDs link them to this identity envelope. Create and delete
use a missing entry on the corresponding side. Convert to Values stores the same
column UUID with a non-null definition before and null after. Formula edit stores
the same column and formula UUID on both sides with different raw definitions.

Undo and redo restore formula metadata and physical data within the same mutation
coordinator used by forward operations. A removed and restored calculated column
must return with the exact original UUID and formula ID.

History eviction removes any associated calculated metadata snapshots together
with the existing before/after tables. It must not remove live formula metadata.

## Archive, Restore, And Copy

### Table Document V3

The next `TableDoc` version adds stable identity and optional formula metadata to
every column:

```text
TableColumnV3
  columnId: UUID
  name: string
  colType: string
  width?: number
  format?: TableColumnFormat
  extras?: object
  calculated?:
    | { state: "ready", definition: CalculatedColumnDefinitionV1 }
    | { state: "preserved", schemaVersion: string, rawDefinition: object }
```

Rows continue to contain `_row_id` followed by physical user-column values.
Materialized calculated values are stored exactly like ordinary column values.

Normal and streaming saves must serialize equivalent V3 documents from one
generation-consistent snapshot of schema, formulas, and values.

### Reopen

Opening an original project restores table and column UUIDs exactly. Restore
validates:

- table-level and global column-ID uniqueness;
- formula/output identity agreement;
- AST and persisted dependency agreement;
- fingerprint and inferred output type;
- dependency existence and acyclicity;
- physical value compatibility with declared column type.

Supported, consistent definitions are revalidated and materialized within the
restore transaction. A mismatch between stored and recomputed values is treated
as corrupted archive data and reported rather than silently changing a normal
archive.

Unknown formula schema versions retain raw definition and materialized values in
read-only `unsupported` state. A supported definition with a missing dependency
opens read-only as `broken` with a stable diagnostic. Neither state rebinds by
column name.

### Legacy Migration

V1/V2 table documents lack column UUIDs and formula definitions. Restore assigns
fresh UUIDs in column order and treats every column as ordinary. It never infers
a formula from names, values, or `extras`.

Saving the opened project writes V3 using those assigned identities.

Migration is read-old/write-new rather than an in-place archive rewrite. The
loader dispatches V1/V2 to their existing parsers, normalizes their result into
the live identity-bearing model, and dispatches V3 to the strict identity-aware
parser. A save snapshots one live dataset generation and writes an entirely V3
table document to the temporary archive; the existing atomic archive replacement
then publishes the complete project. A failed or interrupted save leaves the
previous project archive unchanged, so a project cannot contain a partially
migrated table document from that save.

### Standalone Import And Duplication

Importing an `.sptb` or duplicating a table into a project creates a new table
identity namespace:

1. validate the source document without mutation;
2. allocate a new table ID and a new UUID for every user column;
3. build an old-to-new column-ID map;
4. rewrite output IDs and every AST `columnRef` through that map;
5. allocate new formula IDs and recompute fingerprints;
6. insert schema, definitions, and values atomically;
7. perform one validation materialization before commit.

External or missing references are invalid in V1 because formulas are strictly
same-table. Import never reuses globally unique IDs and never repairs by name.

## IPC Contracts

The Tauri command layer remains thin and delegates to the service. New commands
are registered in the standard handler list and wrapped by `dataService`:

```text
validate_calculated_column(request) -> CalculatedColumnValidation
upsert_calculated_column(request) -> CalculatedColumnMutationResult
convert_calculated_column_to_values(
  datasetId,
  columnId,
  expectedGeneration
) -> CalculatedColumnMutationResult
```

The upsert request contains dataset ID, optional output column ID, output name,
formula display text, optional insertion index, and expected generation.

Mutation results contain:

- canonical output `ColumnDescriptor`;
- normalized display formula and calculated metadata;
- new dataset generation;
- opaque history change-set ID;
- warning counts keyed by stable warning code.

`ColumnDescriptor` gains optional calculated metadata:

```text
calculated?:
  formulaId
  schemaVersion
  normalizedDisplayFormula
  dependencyColumnIds
  inferredOutputType
  status: ready | broken | unsupported
```

Raw SQL, internal table names, and absolute paths never cross IPC.

## User Experience

### Entry Points

- **Add Column -> Calculated Column** creates a new calculated output.
- A normal column's single-column properties dialog offers **Calculated
  Formula**, converting that column on Apply.
- A calculated column offers **Edit Formula**, **Convert to Values**, and
  **Delete Column**.

Calculated Formula is excluded from the existing flat multi-column property
grid and its property-table import/export workflow. Formula definitions do not
fit that positional metadata format.

### Formula Editor

The editor is a text expression field with:

- column-name and function autocomplete;
- searchable Columns and Functions insertion menus;
- bracket escaping for non-simple names;
- local lexical highlighting;
- backend validation status;
- normalized formula preview;
- inferred output type;
- dependency and downstream-impact lists;
- Apply disabled until authoritative validation succeeds.

The editor keeps `draftText`, `validatedText`, and `validatedGeneration`
separately. Any draft edit invalidates the prior validation. If the dataset
generation changes, the UI preserves `draftText`, refreshes descriptors, and
requests validation again. Apply sends the unchanged draft plus the generation
returned by that validation. A stale-generation mutation response preserves the
draft, refreshes descriptors, and returns the editor to pending validation; it
never submits automatically.

The UI may suggest an editable output name from first-occurrence dependency
names, for example `Length_Width`. Name allocation follows existing
case-insensitive collision behavior and adds the normal numeric suffix. The name
is presentation only and is not part of formula identity.

### Table Presentation

Calculated columns display a formula icon in the Columns panel and table header.
A tooltip shows the normalized formula and inferred output type. Result cells do
not enter edit mode. Paste that intersects a calculated column is rejected before
any values are written and identifies the blocked columns.

During synchronous calculation the existing pending-mutation behavior prevents
another table mutation. On success, existing dataset-generation invalidation
refreshes the bounded table window and downstream consumers.

`broken` and `unsupported` columns retain their materialized display values but
are read-only and visibly marked. Their property view presents the diagnostic
and raw schema version without offering normal Apply.

## Diagnostics And Localization

Backend responses use stable codes with structured details. Initial codes are:

- `formula_syntax_invalid`
- `formula_unknown_column`
- `formula_ambiguous_column`
- `formula_type_mismatch`
- `formula_function_arity_invalid`
- `formula_cycle`
- `formula_dependency_in_use`
- `calculated_column_read_only`
- `formula_schema_unsupported`
- `formula_archive_inconsistent`
- `stale_dataset_generation`

Details may contain formula offsets, column UUIDs, current display names,
expected/actual types, and dependency paths. They must not expose generated SQL
or internal relation names.

Frontend locale files map codes, labels, function descriptions, warning counts,
and actions in every shipped language. The UI does not branch on backend English
message text.

## Performance And Concurrency

- Evaluation is set-based DuckDB SQL, never a React or Rust per-row loop.
- The service recomputes only the transitive dependent closure of changed source
  UUIDs.
- Each affected calculated column is updated once in topological order.
- Multiple changed source columns in one paste or batch edit are deduplicated
  before graph traversal.
- Validation has no full-table scan. Materialization and warning counts share
  generated expressions where practical.
- The mutation permit and `expectedGeneration` fence prevent concurrent table
  writes from committing against stale dependencies.
- Synchronous V1 does not expose dirty values. Progress/cancellation and an
  asynchronous threshold are follow-up capabilities if measured fixtures show
  unacceptable blocking.

The implementation plan must define a performance fixture with chained formulas
on a large table and record materialization time and peak-memory behavior. It
must not silently switch to asynchronous or approximate execution.

The required baseline fixture is the repository's 300,000-row dataset with a
five-column linear dependency chain and a source mutation affecting the full
closure. After a warm-up run, five measured runs on the documented development
machine must have median mutation-plus-materialization time at or below 2.0
seconds and peak resident-memory growth at or below 2.0 times the physical input
and calculated-result bytes. The benchmark records hardware, DuckDB build, each
run, median, and peak-memory method. Missing either threshold blocks release of
the synchronous V1 behavior and requires an explicit design revision; it does
not permit exposing partial values.

## Security

- User formula text is parsed into a closed AST. It is never concatenated into
  SQL.
- Column names enter generated SQL only through the existing trusted identifier
  quoting function after UUID resolution.
- Numeric and Boolean literals are emitted from typed parsed values, not raw
  source slices.
- Function names and operators come only from exhaustive enums.
- Comments, statement separators, subqueries, relation references, pragmas,
  macros, and arbitrary DuckDB functions are not representable.
- AST depth, token count, function arity, and formula length have explicit
  bounds to prevent parser or planner abuse.

## Testing

### Formula Domain

- operator precedence, associativity, parentheses, and bracket escaping;
- every unary, binary, comparison, logical, and function node;
- scalar `MIN/MAX`, bounded `ROUND`, `COALESCE`, and null-condition `IF`;
- normalization and fingerprint stability across whitespace and source rename;
- type promotion, branch compatibility, function arity, and null propagation;
- unknown/ambiguous names, self-reference, direct cycles, and indirect cycles;
- AST depth/token/formula-length limits;
- exhaustive SQL generation with no raw formula fragment in output.

### Service And Engine

- create, convert ordinary-to-calculated, edit, rename, reorder, and delete;
- chained formulas materialized in topological order;
- cell, batch, clear, paste, row add/delete, and type-change integration;
- direct edits, clears, paste, and type changes against outputs are rejected;
- divide-by-zero, overflow, legitimate nulls, and exact warning counts;
- dependent deletion protection returns direct and transitive paths;
- Convert to Values preserves identity and downstream validity;
- every failure rolls back schema, definitions, values, history, and generation;
- one user mutation produces one history entry and one generation increment.

### History

- undo/redo calculated-column creation and deletion;
- undo/redo formula edit with output-type change;
- undo ordinary-to-calculated conversion and Convert to Values;
- undo/redo source mutations re-materializes the same dependent values;
- restored columns retain exact column and formula UUIDs;
- history eviction removes only unreachable snapshots.

### Archive And Migration

- V3 normal and streaming save equivalence;
- project save/reopen preserves IDs, definitions, values, and display metadata;
- standalone `.sptb` round trip;
- copy/import remaps all IDs and references consistently;
- V1/V2 migration creates ordinary columns with stable new IDs;
- unknown formula schema preservation;
- missing dependency, dependency-list mismatch, fingerprint mismatch, duplicate
  UUID, type mismatch, and materialized-value mismatch;
- save cannot observe partially materialized values.

### Frontend And IPC

- typed camelCase contracts and command registration;
- autocomplete and escaped column insertion;
- normalized display after source rename;
- new-column and existing-column conversion flows;
- inferred type, dependencies, downstream impact, and diagnostics;
- collision-safe suggested output names;
- calculated-cell edit and paste blocking;
- Edit Formula, Convert to Values, delete protection, undo, and redo;
- stale-generation refresh preserves unsubmitted formula text;
- `broken` and `unsupported` read-only presentation;
- all shipped locales contain the new keys.

### Required Gates

- focused Rust formula-domain, service, engine, history, and archive suites;
- existing table-mutation and project archive regression suites;
- TypeScript IPC and pure editor-contract tests;
- Playwright component tests for Table formula flows;
- frontend production build;
- `cargo fmt --check`;
- `cargo clippy`;
- `cargo test`.

## Delivery Slices

### Slice 1: Stable Column Identity Foundation

- persist column UUIDs in TableDoc V3;
- restore exact IDs for original projects;
- implement legacy migration and copy/import remapping;
- extend normal and streaming save;
- preserve IDs through schema history and undo/redo.

This slice must land before formula UI or evaluator work.

### Slice 2: Formula Domain And Atomic Materialization

- add formula models and metadata table;
- implement parser, formatter, normalization, type inference, and fingerprint;
- implement dependency graph and deletion protection;
- implement safe SQL generation, warning counts, and topological evaluation;
- integrate the mutation coordinator with every relevant source/history path;
- add validate, upsert, and Convert to Values backend commands.

### Slice 3: Table UX And Contracts

- add TypeScript models and service wrappers;
- add calculated-column entry points and formula editor;
- enforce read-only output behavior in all edit/paste paths;
- add formula status, tooltip, diagnostics, and localization;
- complete component, integration, build, and manual acceptance gates.

## Acceptance Criteria

1. A user can create or edit a calculated column using readable names and the V1
   expression language.
2. Persisted dependencies and execution use stable UUIDs; rename, reorder, or
   insertion before a dependency does not alter binding.
3. Source mutations and affected calculated columns commit atomically and update
   dataset generation once.
4. Chained formulas evaluate in dependency order; cycles and invalid definitions
   fail before mutation.
5. Deleting a dependency is blocked with useful dependent paths. Recreating the
   same display name never silently rebinds a formula.
6. Calculated cells are read-only, and Convert to Values preserves the current
   physical column and downstream UUID references.
7. Project reopen and standalone export preserve UUIDs, definitions, and values;
   copy/import remaps internal identities consistently.
8. Undo/redo restores exact identities, definitions, types, source changes, and
   materialized results.
9. Legacy tables open as ordinary columns without inferred formulas. Unknown or
   damaged definitions remain visible, read-only, and explicit.
10. Backend, archive, history, IPC, UI, localization, build, and performance
    gates pass without exposing raw SQL or accepting arbitrary code.

## Out Of Scope

- arbitrary SQL, JavaScript, Python, macros, or plugins;
- text and date formula functions;
- aggregate, grouped, window, lag/lead, or cross-row formulas;
- cross-table references;
- per-cell formulas or mixed formulas within one column;
- asynchronous/background recalculation;
- cascade deletion of dependent columns;
- formula definitions in the batch property-table import/export workflow;
- editing or rebinding unsupported/damaged formulas by column name;
- automatic conversion of existing cell text beginning with `=` into formulas.
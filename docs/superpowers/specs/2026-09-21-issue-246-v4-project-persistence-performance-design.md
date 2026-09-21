# Issue 246 v4 Project Persistence Performance Design

## Status

Approved in design review on 2026-09-21.

## Context

Issue 246 investigates slow save and open behavior for projects containing
tables with two million or more rows. The current production project format is
a v4 ZIP archive: project metadata and documents are JSON entries, while each
managed table is a row-oriented JSON `.sptb` entry.

This is different from the unimplemented file-backed DuckDB proposal in
`2026-08-18-big-data-performance-design.md`. This design uses "v4" to mean the
actual current ZIP/JSON format and does not revive that earlier format proposal.

Release measurements on macOS 27.0 with an Apple M3 Pro and a deterministic
2,000,000-row by 20-column synthetic table established:

- Save: 13,090 ms, including 10,048 ms of DuckDB query/value materialization.
- Open: 8,210 ms, including 2,552 ms of archive read/parse and 5,585 ms of table
  restoration.
- Open RSS increase: 3,378,462,720 bytes for a 139,446,462-byte archive.

The fixture repeats `BIGINT`, `DOUBLE`, and short low-cardinality `VARCHAR`
columns. It is not representative of every real project. Development builds
are also not performance evidence: the same save took 120,849 ms under the
unoptimized Rust dev profile, about 9.2 times the release result.

## Goals

For the release-profile 2,000,000-row by 20-column reference workload:

- Save median at or below 8 seconds.
- Open median at or below 5 seconds.
- Open RSS increase at or below 1.5 GiB for every final qualification sample.
- Exact restoration of all 2,000,000 rows.
- Compatibility with existing v4 projects and readers.
- Preservation of the save writer's 4 MiB target and 8 MiB hard batch limit.

The work is split into independently measured save and open stages. Results
from this design determine whether and when a separate v5 Parquet design is
needed.

## Non-Goals

- Changing the `.spprj` or `.sptb` v4 schema.
- Implementing Parquet or another v5 format.
- Changing Tauri IPC or frontend save commands.
- Optimizing standalone `.sptb` import.
- Redesigning project progress UI.
- Using debug-build timings as product performance qualification.
- Guaranteeing the synthetic thresholds for arbitrary wide or string-heavy
  projects.

## Design Decisions

### Save Cursor

Replace the current row-ID-only archive cursor with an explicit keyset cursor:

```text
ArchiveCursor {
  natural_order_key: i128,
  row_id: i64
}
```

The archive query returns the natural-order key with each row and binds the
previous cursor directly:

```sql
WHERE natural_order > ?
   OR (natural_order = ? AND row_id > ?)
ORDER BY natural_order, row_id
LIMIT ?
```

The last emitted row becomes the next cursor. The initial query has no cursor.
This removes the repeated correlated subqueries that currently resolve the
previous natural-order key from its row ID.

The fixed 4,096-row query limit becomes a higher safety ceiling. The existing
retained-byte accounting remains authoritative: a batch targets 4 MiB and must
never exceed the 8 MiB hard limit. A single oversized row remains an explicit
error.

The streaming JSON writer, ZIP compression, validation, sibling temporary
file, `sync_all`, and atomic replacement semantics remain unchanged.

### Project Archive Reader

Introduce a file-backed archive reader in `spprj_archive.rs`:

```text
ProjectArchiveReader<File>
  - reads and validates the manifest
  - materializes only small project documents
  - opens table entries in manifest order
  - streams table headers and rows into a TableRowSink
```

The ZIP archive is created over `File`, not `Cursor<Vec<u8>>`. The reader does
not retain the complete `.spprj` or an inflated `.sptb` byte buffer.

Small documents such as graphs, analyses, workflows, history metadata, and
folder metadata retain their current JSON models. Only managed table payloads
move to the streaming path.

### Streaming Table Restore

For each canonical application-written `.sptb`:

1. Parse and validate `id`, `name`, `sourceType`, `version`, and `columns`.
2. Verify manifest/body identity and table structure before accepting rows.
3. Create the table in the staged DuckDB state.
4. Parse one JSON row at a time.
5. Validate row width, row ID uniqueness, archive scalar representation, and
   target column conversion.
6. Append the converted row directly to DuckDB.
7. Finalize table metadata and verify the restored row count.

The reader never constructs the table's complete `Vec<Vec<Value>>`.

The first implementation retains the existing row-ID `HashSet` to preserve
duplicate-ID error behavior. If the final memory gate still fails, moving
uniqueness enforcement into staged DuckDB is a separately measured follow-up,
not an implicit part of this change.

### Field-Order Compatibility

StatsPlayground's writer emits table header fields before `rows`. That layout
uses the single-pass streaming fast path.

JSON object field order is not semantically significant, so a valid table may
place `rows` before required header fields. The streaming parser detects this
specific condition before consuming the row array, reopens the ZIP entry, and
uses the existing complete `TableDoc` parser.

This compatibility path is selected only by the deterministic field-order
condition. Malformed JSON, missing or duplicate fields, invalid values,
trailing data, and missing ZIP entries remain errors and never trigger a
success-shaped fallback.

Legacy single-file JSON projects retain their current reader.

## Atomicity and Error Handling

Opening continues to use a staged `AppState`. Manifest validation, table
streaming, document migration, recovered workflow output, history restoration,
dataset generations, and display metadata must all succeed before the live
database, display state, and project metadata are replaced.

Any ZIP, JSON, validation, conversion, or DuckDB error:

- Returns a repository-standard `AppError`.
- Drops staged state and partial tables.
- Leaves the currently open project unchanged.
- Does not report a completed progress event.

Saving retains the existing sibling temporary-file and atomic-replacement
contract. A cursor or batch error removes temporary artifacts and preserves
the prior project file.

## Progress

The current v4 table header does not contain row count. The format will not be
changed to add one.

During streaming restore:

- Dataset index and dataset total remain exact.
- `rowsDone` advances at a bounded batch cadence.
- `rowsTotal` is zero, selecting the frontend's existing indeterminate progress
  presentation.
- Completion emits the current final event.

This prevents per-row IPC and avoids a full pre-scan solely to calculate a
percentage.

## Verification

### Correctness Corpus

Save tests cover:

- Empty and single-row tables.
- Multiple batches with exact no-gap/no-duplicate output.
- Inserted and rebalanced natural-order keys.
- Equal natural-order keys with row-ID tie-breaking.
- Extreme `HUGEINT` order keys.
- Wide and single-oversized rows.
- Interleaved reads, bounded memory, failure cleanup, archive validation, and
  atomic replacement.

Open tests compare legacy and streaming results for:

- Current canonical v4 projects.
- v1-v4 compatibility fixtures.
- Multiple tables and nested archive paths.
- Calculated columns, display metadata, filters, history, snapshots, workflows,
  and generations.
- Nulls and every supported archive scalar representation.
- Header fields after `rows`, exercising the compatibility path.
- Missing entries, malformed and trailing JSON, duplicate row IDs, width
  mismatches, type errors, and injected append failures.
- Preservation of the live project after every rejected open.
- Bounded progress callback counts and indeterminate row totals.

### Performance Qualification

Development iterations use targeted release samples. Final evidence is
collected only after correctness, review, and source changes are frozen.

Final qualification runs five independent release samples of the 2,000,000 by
20 workload:

| Metric | Requirement |
| --- | ---: |
| Save median | <= 8,000 ms |
| Open median | <= 5,000 ms |
| Open RSS increase | <= 1.5 GiB in every sample |
| Restored rows | exactly 2,000,000 in every sample |
| Save retained batch | <= 8 MiB in every sample |

The 300,000-row and 1,000,000-row tiers are rerun to detect small-project
regressions. A smaller long-string, high-cardinality, null-containing fixture
checks correctness and bounded memory without claiming that the synthetic
latency threshold applies to all project shapes.

All reports identify profile, source revision, machine, sample count, and
whether a value is a median or a single diagnostic sample.

## Delivery Phases

1. Freeze benchmark contracts and compatibility fixtures.
2. Implement and qualify the direct natural-order save cursor.
3. Implement the file-backed archive reader and streaming table sink.
4. Run affected service tests, full compatibility tests, release build, diff
   checks, and independent review.
5. Freeze source and run the five-sample final performance matrix.
6. Update `docs/performance.md` and Issue 246 with commands, raw results,
   limitations, and target outcomes.
7. Stop for manual acceptance.

If save misses its target, investigate remaining query materialization before
changing unrelated stages. If open time passes but RSS fails, address retained
row identity or conversion state. If RSS passes but time fails, profile row
conversion and appender work. A v5 Parquet proposal begins only after measured
v4 results and explicit approval.

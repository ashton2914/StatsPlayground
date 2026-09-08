# Tabulate Export-to-Table Design

## Goal

Add an export action to a completed Tabulate result that creates a standard
StatsPlayground data table. The exported table must preserve the displayed
row dimension and flatten multidimensional column headers into stable column
names.

## Scope

- A Tabulate item accepts at most one Rows field.
- Columns continues to accept multiple ordered fields.
- Statistics continues to accept multiple ordered entries and forms the final
  level of exported data columns.
- Row totals, column totals, and grand totals are not exported.
- Export is unavailable while the project is read-only or no current result is
  ready.

## Export Shape

The first exported column is the configured Rows field when one exists. Its
values come from `TabulateResult.rowMembers`. If no Rows field is configured,
the export contains only statistic columns and one result row.

Each statistic column name joins these labels with ` - `:

1. Every value in the corresponding `columnMembers` entry, in configured
   Columns order.
2. The localized statistic label.
3. The statistic source field name.

For example, Columns values `East` and `Retail`, with Mean of `Sales`, produce
`East - Retail - Mean - Sales`. A null dimension value uses the same localized
`Missing` label as the rendered result table. When no Columns field is
configured, the name is `Mean - Sales`.

Column names must be unique. The first occurrence keeps its generated name;
later collisions receive stable suffixes such as ` (2)` and ` (3)`.

Cells preserve the row-major ordering already defined by `cellIndex`. Null
aggregate values remain null. Export ignores the result table's visible-depth
controls because those controls only collapse presentation; the full configured
dimensional result is exported.

## Architecture

A pure frontend helper converts `TabulateItem` and `TabulateResult` into a
typed table payload containing column names, column types, and rows. Keeping
this transformation pure makes ordering, missing labels, duplicate names, and
the zero-Rows case directly testable.

The frontend calls a new `dataService` method with the generated payload and a
default table name derived from the Tabulate item. A thin Tauri command delegates
to `DataService`. The service validates the name, column definitions, row widths,
and supported scalar values before asking the DuckDB engine to create and fill
the dataset as one operation. User values are passed through typed parameters;
they are never concatenated into SQL.

On success, `Workspace` refreshes dataset metadata, marks the project dirty,
records a history entry, clears graph/Tabulate selection, and selects the new
dataset. On failure, the current Tabulate result remains visible and an inline
error is shown; no partial dataset remains.

## User Interface

Add an icon-and-text Export to Table button to the Tabulate results toolbar.
It is enabled only when a result is ready, no export is in progress, and the
project is writable. While exporting, disable repeat activation and show the
existing busy treatment. The button has a tooltip and localized accessible
label.

The existing Rows drop zone rejects a second field. Keyboard and drag/drop
assignment follow the same rule so the constraint is not presentation-only.

## Validation and Errors

The frontend helper rejects malformed result dimensions before IPC. The backend
repeats structural validation because IPC input is untrusted. Empty or duplicate
column names after normalization, mismatched row widths, unsupported nested
values, and an empty table payload return `AppError::InvalidParam`.

Database failures return `AppError::Database`. Dataset creation is transactional
or explicitly cleaned up before an error is returned, so metadata and physical
tables cannot diverge.

## Testing

- Frontend helper tests cover multidimensional column ordering, multiple
  statistics, the optional Rows column, null labels and values, duplicate-name
  suffixes, and exports without Columns.
- UI/store tests cover the single-Rows assignment rule and the enabled/disabled
  export state.
- Rust service/engine tests cover successful typed table creation, malformed row
  widths, invalid values, and rollback on insertion failure.
- Verification runs the focused TypeScript test, relevant Rust tests, the full
  frontend test suite, Vite build, `cargo test`, and `cargo clippy`.
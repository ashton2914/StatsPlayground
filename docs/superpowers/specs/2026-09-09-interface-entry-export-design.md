# Issue 153 Interface Entry And Table Export Design

## Context

Issue [#153](https://github.com/ashton2914/StatsPlayground/issues/153)
consolidates table operations into the Table menu and replaces the current
location-specific export actions with one explicit table-selection workflow.
It also removes graph export from the UI and adds a contributors view under
Help.

The implementation starts from `origin/dev` at `ecd7547` and targets `dev`.

## Goals

- Reorder the Table menu to match the requested operation groups.
- Remove the Data menu and move SQL Query into Table.
- Move Tabulate from Analyze into Table.
- Replace all table and folder context-menu exports with one Table > Export
  dialog.
- Support recursive, folder-aware multi-selection of tables.
- Export one table directly and package multiple SPTB or CSV tables as ZIP.
- Export any selected SQLite tables into one database file.
- Remove the Graph menu's SPGH export action while preserving SPGH import and
  project-internal graph persistence.
- Add an alphabetized Contributors dialog under Help.

## Menu Structure

The Table menu has three groups in this exact order:

1. New Table, Transform, Tabulate, SQL Query
2. Import SPTB, Import CSV, Import SQLite
3. Export

The Data menu is removed. Analyze no longer contains Tabulate. PostgreSQL and
MySQL connector entries are not retained in the top-level Table menu as part of
this interface adjustment; their existing connector implementation remains
available for a future dedicated entry design.

The Graph menu contains New Graph Builder and Import SPGH Graph File. Export
Current Graph as SPGH is removed from the frontend and from the public Tauri
command surface. Project archives continue to use SPGH internally.

Table and folder rows in Directory no longer expose SPTB, CSV, or SQLite export
actions in their context menus.

Help contains About, License, and Contributors. Contributors opens the existing
Help dialog shell and lists these names alphabetically by first name:

- Ashton Huang
- Chi Zhang
- Junyi Zhu
- Max Xu
- Ryan Qiu
- Stanley Su

## Export Dialog

`TableExportDialog` is a focused component rather than additional stateful UI
inside `Workspace.tsx`. It receives datasets and table-folder assignments and
returns an export request containing the selected dataset IDs and format.

The left side displays a collapsible folder tree derived from the same folder
paths used by Directory. Only tables and folders containing tables appear.
Folders and tables use checkboxes with three-state folder semantics:

- Checking a folder recursively selects every descendant table.
- A fully selected folder is checked.
- A partially selected folder is indeterminate.
- A user may clear any descendant after selecting its folder.

The right side uses a segmented format control for SQLite, SPTB, and CSV. It
shows the selected-table count and disables Export until at least one table is
selected. Escape and Cancel close the dialog without side effects.

## Export Planning

Selection-to-output behavior is represented by a pure export-plan function so
format, cardinality, paths, and service routing can be tested independently of
React and native dialogs.

| Selection | Format | Output |
| --- | --- | --- |
| One table | SQLite | One `.db` / `.sqlite` file |
| Multiple tables | SQLite | One database file containing all selected tables |
| One table | SPTB | One `.sptb` file |
| Multiple tables | SPTB | `<project-name>-sptb.zip` in a selected directory |
| One table | CSV | One `.csv` file |
| Multiple tables | CSV | `<project-name>-csv.zip` in a selected directory |

For multi-table SQLite exports, folder paths are flattened into table names
with dashes so same-named tables in different folders remain distinct. For ZIP
exports, archive entries preserve the full Directory folder hierarchy. Existing
backend de-duplication remains authoritative for colliding sanitized names.

The system path picker opens only after the user confirms the dialog:

- Direct-file cases use a save-file picker.
- Multi-table SPTB and CSV cases use a directory picker, then create the
  deterministic ZIP filename inside that directory.

Canceling the system picker keeps the dialog selection intact. A failed export
keeps the dialog open and presents an inline error. A successful export closes
the dialog.

## Backend And IPC

Existing subset exporters remain the implementation authority:

- `export_sqlite_subset` writes selected tables to one SQLite file.
- `export_csv_zip_subset` writes selected CSV entries to one ZIP.
- `export_tables_sptb_zip` writes selected SPTB entries to one ZIP.
- Existing single-table CSV and SPTB exporters handle direct files.

The frontend joins the selected directory with the deterministic ZIP filename
using the platform path API or a narrow Tauri helper that validates the output
is a child of the chosen directory. No user-provided path is interpolated into
SQL.

The standalone `export_graph` command and its TypeScript wrapper are removed
only if no non-menu consumer remains. Archive graph serialization and SPGH
import stay unchanged.

## Error Handling

- Empty selection cannot submit.
- Missing datasets are ignored when resolving a stale selection; submission is
  blocked if nothing valid remains.
- Backend errors are shown in the export dialog without clearing selection.
- Read-only projects may export existing tables because export is non-mutating.
- Import and table-creation entries retain their existing read-only guards.

## Testing

1. Pure TypeScript tests cover tree construction, recursive selection,
   indeterminate folders, descendant opt-out, output-plan routing, archive
   paths, SQLite names, and deterministic ZIP filenames.
2. Playwright component tests cover visible tree interaction, format switching,
   disabled submission, Cancel, Escape, and error retention.
3. Workspace source contracts cover exact menu ordering, removal of Data and
   context exports, removal of graph export, and the Contributors entry.
4. Locale contracts require all new labels in English, Simplified Chinese,
   Traditional Chinese, and Vietnamese.
5. Rust tests inspect real single-table and selected multi-table export
   artifacts for CSV, SPTB ZIP, and SQLite.
6. Final gates are the focused tests, frontend build, `cargo test`,
   `cargo clippy`, `git diff --check`, and manual Tauri acceptance.

## Acceptance Checklist

- Table menu order and separators match the Issue 153 reference.
- Data is absent and Analyze no longer contains Tabulate.
- Export opens one table-tree selection dialog.
- Folder selection is recursive and supports clearing individual descendants.
- Single SPTB/CSV output is uncompressed.
- Multi-table SPTB/CSV output is one correctly named ZIP preserving folders.
- Selected SQLite tables are written into one database file.
- Directory context menus have no table-export actions.
- Graph has no SPGH export action and still supports SPGH import.
- Help > Contributors shows all six names in alphabetical order.
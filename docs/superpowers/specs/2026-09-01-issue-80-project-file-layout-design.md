# Issue 80 Project File Layout Design

## Problem

The current `.spprj` ZIP layout does not consistently represent the files shown
in the DIRECTORY UI. Tables and Graph Builders are separate documents, but
their archive paths may contain IDs or logical folder paths. Fit Y by X and
Tabulate documents are embedded in `manifest.json`, and all named snapshots are
combined in one hidden JSON file. Extracting a project therefore does not show
the same named files that users see in the application.

## Goals

- Store every savable DIRECTORY item as a separate, plainly named file.
- Keep physical project data flat while preserving the logical folder tree in
  manifest metadata.
- Display immutable file extensions in the DIRECTORY UI.
- Keep existing ZIP and legacy JSON projects readable and migrate them on the
  next save.

## Archive Format

New saves use project format `4.0.0` and this ZIP layout:

```text
manifest.json
data/<table-name>.sptb
data/<graph-builder-name>.spgh
data/<fit-y-by-x-name>.spf
data/<tabulate-name>.spf
snapshots/<snapshot-name>.json
.history.json
```

All active document files are direct children of `data/`; logical DIRECTORY
folders never become ZIP directories. Each snapshot is a direct child of
`snapshots/`. `.history.json` remains an internal aggregate because history
entries are not user-visible files.

The manifest indexes every active document and snapshot with its stable ID,
type, display name, and relative archive path. Stable IDs remain the identity
used by runtime state, data-source references, and folder-assignment maps, but
they never appear in generated filenames. Fit Y by X and Tabulate bodies move
out of the manifest into opaque `.spf` documents. Snapshot bodies likewise move
out of `.snapshots.json` into individual JSON documents.

## Naming

The displayed filename is the document display name plus its fixed extension:
`.sptb` for tables, `.spgh` for Graph Builders, and `.spf` for Fit Y by X and
Tabulate. Snapshot filenames use `.json`.

Names are unique across the whole project within one extension namespace,
regardless of logical folder. Different extensions may share a basename, so
`data.sptb`, `data.spgh`, and `data.spf` may coexist. Fit Y by X and Tabulate
share the `.spf` namespace and therefore cannot both use `data.spf`.

Creation, rename, and migration resolve conflicts case-insensitively by adding
`-2`, `-3`, and so on before the extension. The resolved basename becomes the
document's display name, preserving the invariant that UI name and physical
filename match. Filename validation rejects path separators, filesystem-invalid
characters, leading or trailing dots/whitespace, control characters, and
Windows reserved device names.

The DIRECTORY tree renders complete filenames. Rename controls edit only the
basename and render the extension as a separate, immutable suffix. Callers use
one shared frontend naming utility so creation and rename apply the same
extension namespace and suffix rules. The Rust writer independently validates
uniqueness and portability before mutating the destination archive.

Snapshots use the same basename-only rename interaction and conflict suffixing
inside the snapshot `.json` namespace. Default snapshot names use the
filesystem-safe `Snapshot YYYYMMDDHHmmss` format. Readers also accept indexed
`.spf` snapshot entries written by earlier v4 builds.

## Logical Folders

`folders`, `tableFolders`, `graphFolders`, `fitYByXFolders`, and
`tabulateFolders` remain manifest metadata. Moving an item changes only its
folder assignment. It does not change its path under `data/` and cannot make a
duplicate filename valid. Empty logical folders remain listed in `folders` but
do not create ZIP directory entries.

## Compatibility And Migration

The reader supports all current inputs:

- legacy single-file JSON projects;
- ZIP projects with `tables/<id>.sptb` and `graphs/<id>.spgh`;
- ZIP projects with display-name files inside logical folder paths;
- inline manifest Fit Y by X and Tabulate arrays;
- aggregate `.snapshots.json` or `snapshots.json` files;
- format 4 projects with manifest-indexed `data/` and `snapshots/` files.

Opening an older format normalizes conflicting or non-portable names in memory,
returns the name migrations to the frontend, and marks the project dirty. No
source file is modified merely by opening it. The next save always writes
format 4 and atomically replaces the project archive, completing migration.
Opening a format 4 archive with a missing indexed file fails before replacing
the live in-memory project.

## Data Flow

The frontend collects documents, folder maps, history, and snapshots through
the existing save request. The archive builder assigns validated display-name
paths and creates manifest references. The streaming writer writes the
manifest, streams tables to their `.sptb` entries, writes Graph Builder and
`.spf` documents, writes history, validates the temporary archive, and then
performs the existing atomic replacement.

On open, the archive reader resolves all indexed documents and legacy fallbacks
into the existing `OpenProjectResult` arrays. `ProjectService` restores tables
into a staged database, then swaps state only after the complete archive has
validated. The frontend loads the same stores as today and uses returned
migration metadata to set dirty state.

## Error Handling

- Reject duplicate or unsafe format 4 manifest paths during validation.
- Reject missing, malformed, or type-mismatched indexed documents with an
  `AppError::FileIO` message naming the relative entry.
- Reject a save request containing unresolved duplicate or invalid names before
  destination mutation.
- Preserve the current project and destination archive on any read, validation,
  serialization, or replacement failure.

## Verification

- A format 4 round trip contains exactly the expected plainly named `data/`
  and `snapshots/` files and restores all stores and logical folder maps.
- Table, Graph Builder, and `.spf` documents may share a basename; Fit Y by X
  and Tabulate conflicts become `name.spf` and `name-2.spf`.
- Conflicts are case-insensitive and migration updates both display names and
  filenames deterministically.
- DIRECTORY labels include fixed extensions while rename inputs cannot modify
  them.
- Legacy JSON and each supported ZIP layout open successfully and become dirty;
  their next save emits only format 4 document paths.
- Missing or duplicate indexed files fail atomically.
- Focused frontend tests, Rust archive/service tests, the frontend build, and
  the full Rust test suite pass.
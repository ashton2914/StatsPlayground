# Graph Builder-new Project Persistence

Approved in conversation on 2026-09-18. Windows manual acceptance of the
pre-persistence renderer passed per the user. Baseline: `10f45ca`, already pushed.
This explicitly supersedes the original session-only/project-format exclusion.

## Contract

Persist independent versioned native graph documents in `.spprj`, using the
existing archive and save/open pipeline, not localStorage or serialized images.
Expose `graphBuildersNew` and `graphNewFolders` in the project save/open contract;
missing fields in older projects mean empty collections. Preserve legacy graphs
and all existing project document types. Unsupported future document versions
must fail clearly rather than silently discarding content.

Each document has `version: 1`, `id`, `name`, `datasetId`, nullable `xColumnId`
and `yColumnId`, `showMean`, `xMode` (auto/numeric/time/duration/category),
`rawMode` (scatter/line/pointsLine), and nullable `camera` with finite increasing
`xMin`, `xMax`, `yMin`, `yMax`. Source identities are stable IDs, not display names.
Do not persist dataset generations, GPU resources, cache paths, pixels or requests.
Bind restored sessions to current dataset generations. Missing source fields
remain in the document and produce a visible diagnostic, not silent replacement.
Changing axes or X interpretation clears the camera; mark/Mean changes retain it.

## Desktop Lifecycle

Separate durable documents from open sessions. Multiple documents coexist.
Creating/editing/renaming/deleting marks the project dirty and observes the
existing save read-only guard. Closing a view releases transient resources but
does not delete its document. Project-tree entries can reopen, rename, delete,
and participate in existing folder organization. Project close/new/open clears
old documents and sessions; restoring documents does not itself dirty a project.
Data-table deletion follows the existing dependent-graph policy.

Save/Save As include every document, including closed views. Reopening a project
restores the project tree; opening a saved entry reconstructs the live chart from
project data. A saved zoom restores after full-domain metadata is available and
must satisfy the renderer's camera constraints. Failed saves preserve dirty state.

## Verification

First reproduce loss of two independently configured documents in focused tests.
Cover archive roundtrip, missing legacy fields, invalid/future versions, duplicate
IDs, folder mappings, camera validity and no runtime-only fields. Exercise create
two -> edit -> save -> close -> reopen -> open both, asserting fields, modes,
Mean, source binding and camera. Test close versus delete, save read-only, dirty
state, missing references and legacy graph preservation. Reuse existing tests and
component harnesses; isolate Playwright output under `.cache/issue221-persistence/`.
Run focused TS/Rust tests, TypeScript/Vite and Cargo builds, an independent review,
and launch an isolated native app without terminating existing user windows.
Do not claim Windows verification of the new persistence code from prior acceptance.

## Exclusions

No renderer replacement, cache format changes, oversized-data fidelity expansion,
hover, overscan, table-selection linkage, new chart types, or general UI redesign.
Old application versions are not promised to preserve the new document kind.
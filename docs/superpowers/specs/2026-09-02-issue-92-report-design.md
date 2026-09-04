# Issue 92 Report Design

## Problem

StatsPlayground can create tables, Graph Builders, Fit Y by X analyses, and
Tabulate analyses, but it cannot compose those project documents into an
editable report. Users need a report document that combines Markdown text with
live project content, appears in DIRECTORY like other files, and survives a
project save/open round trip.

The workflow domain is being developed independently in another worktree. This
change must not copy, import, or anticipate that implementation beyond exposing
a stable, read-only dependency extraction boundary.

## Goals

- Add Report as a first-class project document created from the Report menu.
- Edit Report content as Markdown with a live preview.
- Insert and render references to every document type available on the `dev`
  baseline: Table, Graph Builder, Fit Y by X, and Tabulate.
- Bind embeds by document kind and stable ID so renames do not break reports.
- Refresh embeds automatically when their source store changes.
- Show Report files in DIRECTORY with the immutable `.sprp` extension and the
  existing folder, rename, move, and delete behaviors.
- Persist each Report as `data/<report-name>.sprp` in format 4 `.spprj`
  archives, with the same atomic validation guarantees as other documents.
- Expose deterministic Report dependencies for later workflow integration
  without depending on workflow code.

## Non-Goals

- A block editor, WYSIWYG editor, freeform canvas, pagination, or print layout.
- Report-to-Report embedding or recursive embed resolution.
- Distribution embedding, because Distribution is not a persisted DIRECTORY
  document on the selected local `dev` baseline. Its future integration adds a
  registry adapter without changing the Report file format.
- Workflow nodes, ports, execution, lineage, validation, or serialization.
- Standalone `.sprp` import/export outside a `.spprj` project.
- Raw HTML execution inside Markdown.

## Document Model

The frontend owns this versioned shape:

```ts
export type ReportEmbedKind = "table" | "graph" | "fitYByX" | "tabulate";

export interface ReportDependency {
  kind: ReportEmbedKind;
  documentId: string;
}

export interface ReportItem {
  schemaVersion: 1;
  id: string;
  name: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}
```

A `.sprp` entry is UTF-8 JSON containing exactly this document envelope. The
Markdown remains the editable report body while the envelope gives archive
validation an explicit stable ID, display name, and schema version. Unknown
schema versions fail open with a file-specific `AppError::FileIO` instead of
silently coercing content.

Report names occupy their own case-insensitive `.sprp` namespace. They follow
the existing portable basename validation and deterministic `-2`, `-3` suffix
allocation rules.

## Embed Syntax And Parsing

An embed is a complete line with this canonical form:

```text
{{sp-embed kind="graph" id="stable-document-id"}}
```

`kind` must be one of `table`, `graph`, `fitYByX`, or `tabulate`. `id` must be a
non-empty stable ID and cannot contain quotes, braces, whitespace, or control
characters. Attribute order is fixed in generated content. The parser:

- recognizes directives only when they occupy a complete line;
- ignores directive-like text inside fenced Markdown code blocks;
- returns ordered Markdown and embed tokens for rendering;
- leaves malformed directives visible as ordinary Markdown text;
- returns dependencies in first-appearance order with duplicate `(kind, id)`
  pairs removed.

`extractReportDependencies(markdown)` is a pure frontend function and the only
workflow-facing boundary in this change. It imports no workflow modules and
persists no duplicate dependency list.

## Rendering

The Report preview renders Markdown segments through `react-markdown` with
GitHub-flavored Markdown support from `remark-gfm`. Raw HTML remains disabled.
Links use safe browser behavior and cannot execute script URLs.

Embed tokens resolve through a typed adapter registry keyed by
`ReportEmbedKind`. Each adapter reads the live Zustand store for its source and
renders a read-only representation using existing runtime/view components
where practical:

- Table: a bounded, read-only table preview.
- Graph Builder: the current graph runtime output.
- Fit Y by X: the current analysis output in read-only form.
- Tabulate: the current result table in read-only form.

The preview subscribes to the corresponding stores, so source edits or reruns
cause React to render the latest result without mutating Report Markdown.
Missing or deleted sources render a localized unavailable-reference placeholder
that includes the kind and stable ID. Adapter errors remain local to that embed
and do not blank the rest of the Report.

## Editing Experience

The Report workspace uses a stable two-column layout: Markdown editor on the
left and preview on the right. On narrow widths, an Editor/Preview segmented
control shows one pane at a time. The toolbar provides an insert control that
lists current project documents grouped by type; selecting one inserts the
canonical directive at the current selection and restores editor focus.

Markdown edits update `updatedAt`, mark the project dirty through the existing
project state path, and participate in history with coalesced edit actions
rather than one action per keystroke. Creating, renaming, moving, and deleting a
Report follows existing Workspace conventions.

## Workspace And DIRECTORY Integration

`Workspace` gains `activeReportId` and routes Report selection independently of
other active document IDs. The Report menu contains the create command. Report
items appear in the existing logical folder tree with a Report icon and the
`.sprp` suffix. Context menu actions support rename and delete; drag/drop uses a
new `reportFolders` map in `useFolderStore`.

Save/open/reset flows include `reports` and `reportFolders`. Opening a project
loads Reports only after the backend has validated the complete archive, then
restores folder assignments and active state using the same staged project
semantics as existing document types.

## Archive Format

Format 4 archives add:

```text
data/<report-name>.sprp
```

The manifest adds `reportFiles` entries with `DocumentKind::Report` and a
`reportFolders` map. The in-memory bundle and save/open contracts add `reports`.
New fields default to empty so existing format 4 and legacy projects remain
readable without migration.

Build, write, read, and validation boundaries enforce:

- unique Report stable IDs;
- unique portable `.sprp` names, case-insensitively;
- exact manifest ID and name parity with the `.sprp` body;
- exact `data/<name>.sprp` path and Report document kind;
- valid `schemaVersion: 1` and string `markdown` content;
- no missing indexed payloads and no unindexed Report output;
- destination preservation on serialization or validation failure.

## Workflow Boundary

This branch contains no workflow implementation and does not touch the workflow
worktree. The future integration may consume `extractReportDependencies()` to
create upstream edges and treat Report as a non-executing sink whose preview
reflects current source state. That future adapter must be implemented only
after the workflow branch is merged and its actual contracts are available.

## Error Handling

- Invalid Report names use the existing localized filename errors.
- Malformed embed directives stay editable and visible instead of disappearing.
- Missing embed targets show a localized inline placeholder.
- A failing embed adapter shows a localized error for that embed only.
- Invalid or mismatched `.sprp` entries fail project open before live state is
  replaced.
- Invalid Report save payloads fail before the destination archive is mutated.

## Testing

Frontend tests cover:

- canonical directive parsing, fenced-code exclusion, malformed directives,
  ordered tokenization, and dependency deduplication;
- Report store create/update/rename/delete/load/reset behavior;
- `.sprp` naming, namespace allocation, and immutable DIRECTORY labels;
- folder assignment, pruning, save/open/reset wiring, and active routing;
- source insertion at the editor selection;
- live adapter resolution, missing references, and adapter-local failures;
- responsive Editor/Preview behavior and localized strings.

Rust tests cover:

- Report archive round trips and `reportFolders` preservation;
- generated `data/<name>.sprp` entries and manifest references;
- duplicate IDs/names, missing files, wrong kinds/extensions, malformed JSON,
  unsupported schema versions, and ID/name mismatches;
- old archives with no Report fields defaulting cleanly;
- atomic destination preservation on Report validation failures.

Final verification runs focused frontend tests, component tests where needed,
`npx vite build`, focused Rust archive/service tests, and the full Rust test
suite.

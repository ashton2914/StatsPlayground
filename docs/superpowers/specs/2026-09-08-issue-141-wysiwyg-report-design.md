# Issue 141 WYSIWYG Report Design

## Context

Issue 141 replaces the Report workspace's Markdown-source and separate-preview
workflow with one directly editable final report. Users should format report
content from a compact toolbar and insert live project documents without seeing
or editing Markdown syntax.

The existing Report domain stores `ReportItem.markdown`, persists it in `.sprp`
documents, extracts dependencies from canonical `{{sp-embed ...}}` directives,
and renders live project content through `ReportEmbed`. Those contracts remain
the compatibility boundary.

## Goals

- Present one WYSIWYG report surface on desktop and narrow viewports.
- Edit the rendered text and block structure directly.
- Provide Paragraph, Heading 1, Heading 2, and Heading 3 block styles.
- Provide bold, italic, strikethrough, unordered list, ordered list, blockquote,
  code block, and link commands.
- Insert every currently supported project document kind: Table, Graph,
  Fit Y by X, Tabulate, and Distribution.
- Render project documents as selectable, deletable, read-only atomic blocks.
- Preserve Markdown as the only persisted Report representation.
- Open existing `.sprp` Reports without a migration or Rust archive change.
- Preserve Workspace dirty-state, history, save/open, rename, move, and delete
  behavior.

## Non-goals

- Editing an embedded source document from inside a Report.
- Adding image upload, external image loading, raw HTML, collaborative editing,
  comments, pagination, or print-layout controls.
- Changing `ReportItem.schemaVersion`, the `.sprp` archive schema, or the Rust
  Report validator.
- Exposing Markdown source as a second editing mode.

## Architecture

Use TipTap on top of ProseMirror as the editor engine. The editor owns transient
ProseMirror document state only; `ReportItem.markdown` remains authoritative
application and persistence state.

The Report implementation is divided into four responsibilities:

1. `reportEditorCodec.ts` converts persisted Markdown to and from TipTap JSON.
2. `ReportProjectEmbed.tsx` defines and renders the `projectEmbed` atom node.
3. `ReportToolbar.tsx` maps toolbar interactions to TipTap commands.
4. `ReportView.tsx` synchronizes the editor with the existing Report callback,
   composes the toolbar and editor, and owns the insert menu.

`ReportEmbed.tsx` remains the source resolver and fault boundary. Table, Graph,
Fit Y by X, and Tabulate keep their existing adapters. Distribution resolution
preserves whether a document comes from the current Analysis store or the legacy
Distribution store: Analysis-owned documents render through the current
`DistributionAnalysisResults` presentation, while legacy documents retain the
legacy Report renderer as a compatibility fallback.

## Markdown Codec

The codec consumes `parseReportMarkdown(markdown)` so canonical project
directives remain distinct from ordinary Markdown and fenced code. Each embed
token becomes this TipTap atom:

```ts
interface ProjectEmbedAttrs {
  kind: ReportEmbedKind;
  documentId: string;
}
```

Ordinary Markdown tokens become editable TipTap blocks. The supported syntax is:

- paragraphs and hard/soft line breaks;
- headings levels 1 through 3;
- bold, italic, strikethrough, inline code, and links;
- unordered and ordered lists;
- blockquotes and fenced code blocks;
- GFM tables already present in saved Reports.

Serialization walks the top-level editor document in order. Regular blocks are
serialized to normalized Markdown; each `projectEmbed` node is serialized with
`formatReportEmbed()` on its own line. This preserves the existing dependency
parser, archive validator, and downstream workflow contract.

Initializing or externally synchronizing the editor must not call
`onMarkdownChange`. A Report therefore keeps its original bytes until the user
performs an editing transaction. After a real edit, supported Markdown may be
normalized, but its rendered meaning and embed order must remain stable.

If the importer encounters syntax outside the supported set, it creates an
`unsupportedMarkdown` atom containing the exact source. The editor displays it
as a visible read-only source block and serialization emits the source unchanged.
Unsupported content must never disappear silently.

Raw HTML remains disabled. External Markdown images remain non-loading blocked
content that displays only their alt text, matching the current security policy.
Links are sanitized to supported browser-safe protocols and opened without
granting opener access.

## Editor Synchronization

`ReportView` creates one TipTap editor for the active `ReportItem.id`.

- User transactions serialize the editor and call the existing
  `onMarkdownChange(markdown)` callback immediately.
- Workspace continues to update `updatedAt`, mark the project dirty, and
  coalesce history through `scheduleReportHistory`.
- A new external Markdown value is applied with `emitUpdate: false` only when it
  differs from the last Markdown emitted by this editor. This prevents update
  loops and selection jumps.
- Changing the active Report resets the editor from that Report's Markdown.
- Read-only mode sets `editable: false` and disables every mutating toolbar and
  insert action while retaining final rendering.

## Project Embed Node

`projectEmbed` is a block atom with `kind` and `documentId` attributes. Its React
node view wraps the existing `ReportEmbed` component and provides:

- a stable node boundary that ProseMirror can select;
- a selected state with a clear focus border;
- deletion through Delete or Backspace when selected;
- no editable descendants and no command that mutates the source document;
- the existing missing-reference, loading, and per-embed error states.

The insert menu keeps the current grouped options supplied by Workspace. Choosing
an item inserts a `projectEmbed` at the current editor selection, restores editor
focus, and closes the menu.

## Toolbar And Layout

The Report workspace has a title bar, one sticky formatting toolbar, and one
scrolling document surface. The old textarea, Preview pane, split layout, and
narrow-screen Editor/Preview tabs are removed.

The toolbar contains:

- a block-style menu for Paragraph and Heading 1-3;
- icon buttons for bold, italic, strikethrough, unordered list, ordered list,
  blockquote, code block, and link;
- an icon-and-text Insert Project Document command opening the grouped menu.

Buttons expose accessible names and tooltips, fixed dimensions, keyboard focus,
disabled state, and active state derived from the current selection. Link creation
uses a small URL prompt or popover and supports removing the selected link.

The document surface uses the existing Report preview typography and embed card
styles. It fills the available Workspace height, scrolls vertically, and uses the
same single-column document model at all widths. An empty editable Report shows a
content placeholder; an empty read-only Report shows the existing empty state.

## Error Handling

- A Markdown import failure leaves the persisted Markdown untouched and shows a
  localized Report-level error with a retry action.
- Unsupported Markdown is preserved by an exact-source atom rather than dropped.
- A missing project source renders the existing unavailable-reference block.
- A project render exception remains isolated by `ReportEmbedBoundary`.
- A malformed embed-like line remains ordinary Markdown, preserving current
  parser semantics.
- Toolbar commands that cannot apply to the current selection are disabled or
  become no-ops; they never corrupt the editor document.

## Localization

Replace source/preview-specific copy with editor and formatting terminology in
all four locale files. Every visible toolbar command, tooltip, menu heading,
placeholder, import error, and unsupported-content label uses an i18n key. Existing
embed group and error strings are reused where their meaning is unchanged.

## Testing

Development follows red-green-refactor.

### Codec tests

- Import and export every supported text/block format.
- Preserve canonical embed kind, ID, and order through round trips.
- Keep embed-like text inside fenced code as code.
- Preserve malformed directives and unsupported Markdown exactly.
- Prove editor initialization does not rewrite untouched Markdown.

### Component tests

- Render one editable final report with no Markdown textarea or Preview pane.
- Type directly into rendered content and observe Markdown callback output.
- Apply each toolbar command and assert both rendered state and serialized
  Markdown.
- Insert each project kind at the current selection.
- Select and delete an embed without changing neighboring content.
- Preserve live embed rendering, missing sources, error isolation, and recovery.
- Disable mutations in read-only mode.
- Use the same single editor surface at a narrow viewport.
- Keep raw HTML inert and prevent external image requests.

### Integration verification

- Run focused Report unit and Playwright component suites.
- Run Report project/archive contract tests.
- Run TypeScript type checking and the production Vite build.
- Run the focused Rust `.sprp` archive tests to prove schema compatibility.
- Run `git diff --check` and inspect the bounded final diff.
- Start Tauri from the Issue worktree for manual acceptance.

## Acceptance Criteria

1. Report never displays an editable Markdown source field.
2. The visible final report is the editing surface.
3. The approved block and inline formatting commands work from the top toolbar.
4. All current project document kinds can be inserted as live, read-only blocks.
5. Embedded blocks can be selected and removed without editing their source.
6. Existing Reports open with equivalent content and require no migration.
7. Untouched Reports are not rewritten merely by opening them.
8. Read-only projects render Reports without allowing mutations.
9. Unsupported content, missing references, and embed failures remain visible and
   localized rather than losing the rest of the Report.
10. Existing archive, Workspace lifecycle, history, and dirty-state contracts pass.
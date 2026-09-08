# Issue 141 WYSIWYG Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Report Markdown-source/preview split with one directly editable final report surface and a formatting/project-insert toolbar.

**Architecture:** TipTap 3 owns transient ProseMirror state while `ReportItem.markdown` remains the sole application and archive representation. The official TipTap Markdown extension handles supported GFM syntax, custom atom nodes preserve project embeds and unsupported source, and the existing `ReportEmbed` runtime continues resolving live project documents.

**Tech Stack:** React 19, TypeScript 5.7, TipTap 3.30.6, ProseMirror, Zustand, Playwright Component Testing, Tauri v2/Rust archive contracts.

**Spec:** `docs/superpowers/specs/2026-09-08-issue-141-wysiwyg-report-design.md`

## Global Constraints

- Work only in `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report` on `feature/issue-141-wysiwyg-report`, based on `origin/dev@2e0487f`.
- Keep `ReportItem.schemaVersion`, `ReportItem.markdown`, `.sprp`, and the Rust archive schema unchanged.
- Opening or externally synchronizing a Report must not emit `onMarkdownChange`; only user transactions may rewrite Markdown.
- Preserve unsupported Markdown as exact visible source and serialize it unchanged.
- Keep raw HTML inert, block external image requests, and sanitize links.
- Project embeds remain read-only, selectable/deletable atom nodes and continue using `ReportEmbed` fault isolation.
- Keep Workspace dirty state, edit-history coalescing, save/open, rename, move, and delete behavior unchanged.
- All four locales (`en`, `zh-CN`, `zh-TW`, `vi`) must define every new visible string.
- Use TDD: observe the focused test fail for the expected missing behavior before each production edit.
- Bind every command to the sibling worktree with `npm --prefix`, `git -C`, or an explicit tool path.

---

### Task 1: TipTap Markdown Codec And Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/report/reportEditorCodec.ts`
- Create: `tests/reportEditorCodec.test.ts`
- Modify: `tests/tsconfig.report.json`

**Interfaces:**
- Consumes: `parseReportMarkdown(markdown)` and `formatReportEmbed(dependency)`.
- Produces: `createReportEditorExtensions(): Extensions`, `parseReportEditorContent(markdown: string): JSONContent`, and `serializeReportEditorContent(content: JSONContent): string`.
- Defines TipTap node names `projectEmbed` and `unsupportedMarkdown` with `kind`, `documentId`, and `source` attributes used by later tasks.

- [ ] **Step 1: Write the failing codec contract**

Create table-driven assertions covering paragraph, Heading 1-3, bold, italic,
strike, link, bullet list, ordered list, blockquote, fenced code, GFM table,
canonical project embed order, embed-like text in code fences, malformed embed
text, raw HTML, image alt text, and an unsupported task-list block. Assert:

```ts
const document = parseReportEditorContent(markdown);
assert.equal(document.type, "doc");
assert.equal(serializeReportEditorContent(document), expectedMarkdown);
assert.deepEqual(findNodes(document, "projectEmbed").map((node) => node.attrs), [
  { kind: "graph", documentId: "graph-1" },
]);
assert.deepEqual(findNodes(document, "unsupportedMarkdown").map((node) => node.attrs?.source), [
  "- [ ] preserve this task\n",
]);
```

Add the test to `tests/tsconfig.report.json` so the codec is typechecked with the
Report contract suite.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportEditorCodec.test.ts
```

Expected: FAIL because `reportEditorCodec.ts` does not exist.

- [ ] **Step 3: Install exact compatible dependencies**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report install --save-exact @tiptap/core@3.30.6 @tiptap/pm@3.30.6 @tiptap/react@3.30.6 @tiptap/starter-kit@3.30.6 @tiptap/markdown@3.30.6 @tiptap/extension-link@3.30.6 @tiptap/extension-placeholder@3.30.6 @tiptap/extension-table@3.30.6
```

- [ ] **Step 4: Implement the minimal pure codec**

Configure StarterKit headings to levels `[1, 2, 3]`, Link with
`openOnClick: false`, TableKit, and Markdown with HTML disabled. Split input with
the existing Report parser before Markdown parsing. Convert embed tokens to
`projectEmbed` blocks. Detect unsupported task-list/image/raw-HTML source before
normal parsing and represent each exact source block as `unsupportedMarkdown`.
During export, serialize ordinary contiguous blocks through TipTap Markdown and
emit `formatReportEmbed()` or exact unsupported `source` for atom blocks.

- [ ] **Step 5: Run GREEN and typecheck**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportEditorCodec.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsc -p tests/tsconfig.report.json
```

Expected: both commands exit 0.

---

### Task 2: Selectable Project Embed Atom

**Files:**
- Create: `src/components/report/ReportProjectEmbed.tsx`
- Create: `tests/reportProjectEmbed.spec.tsx`
- Modify: `tests/reportViewHarness.tsx`

**Interfaces:**
- Consumes: `projectEmbed` attrs and existing `ReportEmbed({ dependency, runtime })`.
- Produces: `ProjectEmbedExtension.configure({ runtime })`, a React node view with `data-report-project-embed`, `data-kind`, and `data-document-id` attributes.

- [ ] **Step 1: Write the failing component tests**

Mount an editor harness containing text, a graph embed, and trailing text. Assert
the embed renders `ReportEmbed`, has `contenteditable="false"`, receives
`.is-selected` after clicking its node boundary, and disappears after `Delete`
while both neighboring paragraphs remain. Repeat deletion with `Backspace`.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- playwright test -c playwright-ct.config.ts tests/reportProjectEmbed.spec.tsx
```

Expected: FAIL because `ReportProjectEmbed.tsx` does not exist.

- [ ] **Step 3: Implement the node extension and React node view**

Define a block atom with `selectable: true`, `draggable: false`, required `kind`
and `documentId` attributes, Markdown parse/render hooks for canonical directives,
and `addNodeView()` using `ReactNodeViewRenderer`. Render `NodeViewWrapper` around
`ReportEmbed`; apply selected state from node-view props. Add keyboard shortcuts
that delete only a selected `projectEmbed` node.

- [ ] **Step 4: Run GREEN**

Run the Task 2 component test and Task 1 codec test. Expected: both exit 0.

---

### Task 3: Formatting And Insert Toolbar

**Files:**
- Create: `src/components/report/ReportToolbar.tsx`
- Create: `tests/reportToolbar.spec.tsx`
- Modify: `tests/reportViewHarness.tsx`

**Interfaces:**
- Consumes: `Editor`, grouped `ReportLinkOption[]`, and `(kind, documentId) => void`.
- Produces: `ReportToolbar` with accessible block selector and buttons named `Bold`, `Italic`, `Strikethrough`, `Bulleted list`, `Numbered list`, `Blockquote`, `Code block`, `Link`, and `Insert project document`.

- [ ] **Step 1: Write the failing toolbar tests**

For each command, select text or place a cursor in a paragraph, click the named
control, and assert TipTap state plus rendered DOM. Verify Paragraph/Heading 1-3,
active `aria-pressed`, disabled read-only controls, link add/remove with a local
URL input popover, outside-click/Escape menu closure, grouped project options,
and the insert callback's exact kind/ID.

- [ ] **Step 2: Run RED**

Run the toolbar component test. Expected: FAIL because `ReportToolbar.tsx` does
not exist.

- [ ] **Step 3: Implement the toolbar**

Use `editor.chain().focus()` commands. Use a native `select` for block type,
fixed-size Font Awesome icon buttons with title/ARIA labels for familiar commands,
and an icon-plus-text project insert button. Implement an in-app link popover;
accept only `https:`, `http:`, `mailto:`, and project-relative URLs, display a
localized validation error for any other protocol, and support unlinking.

- [ ] **Step 4: Run GREEN**

Run the Task 3 component test. Expected: exit 0 with all toolbar cases passing.

---

### Task 4: Single-Surface WYSIWYG Report View

**Files:**
- Modify: `src/components/report/ReportView.tsx`
- Modify: `src/components/report/report.css`
- Modify: `tests/reportView.spec.tsx`
- Modify: `tests/reportViewHarness.tsx`
- Delete: `tests/reportEditor.test.ts`
- Modify: `src/components/report/ReportMarkdown.tsx`

**Interfaces:**
- Consumes: Tasks 1-3, existing `ReportViewProps`, and existing `onMarkdownChange(markdown)`.
- Produces: one `.sp-report-editor-surface` containing `EditorContent`; no textarea, preview pane, or narrow-mode tabs.
- Keeps `ReportMarkdown` only if another production consumer exists; otherwise exports only still-used link option types from a focused module and removes the obsolete split-preview implementation.

- [ ] **Step 1: Rewrite the existing ReportView tests to RED**

Assert one directly editable `[contenteditable]` final surface; no `textarea`,
`Markdown editor`, Preview heading, or Editor/Preview tabs; rendered headings and
tables inside the editor; typing emits canonical Markdown; untouched mount emits
zero changes; external prop sync emits zero changes and keeps selection; all five
live embed kinds render; insertion occurs at the editor selection; selected embed
deletion preserves neighbors; narrow viewport uses the same surface; read-only
mode has no editable element and no enabled mutating controls; raw HTML cannot
execute and external image URLs generate no request.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- playwright test -c playwright-ct.config.ts tests/reportView.spec.tsx
```

Expected: FAIL because the current view still renders a textarea and Preview pane.

- [ ] **Step 3: Implement the single editor surface**

Create one editor per Report ID using `useEditor`. Parse initial Markdown without
emitting; on user transaction serialize and call `onMarkdownChange` only when the
result differs from the last emitted value. On external `item.markdown` changes,
compare against that marker and call the following only for a genuine external
change:

```ts
editor.commands.setContent(content, { emitUpdate: false });
```

Preserve selection when the active Report ID is unchanged. Configure
`editable: !readOnly`, toolbar state, project insertion, atom runtime, and
placeholder.

- [ ] **Step 4: Replace split-preview CSS**

Use a title row, sticky compact toolbar, and one vertically scrolling document
surface. Move existing Report typography and embed-card rules onto `.ProseMirror`.
Add focus, selected atom, disabled, link-popover, unsupported-source, narrow-width,
and read-only styles. Keep cards at 8px radius or less and prevent toolbar controls
from resizing between active/inactive states.

- [ ] **Step 5: Run focused GREEN tests**

Run codec, embed, toolbar, and ReportView suites. Expected: all exit 0.

---

### Task 5: Localization, Workspace Contracts, And Final Verification

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/reportLocale.test.ts`
- Modify: `tests/workspaceReport.test.ts`
- Modify: `src/components/Workspace.tsx` only if the current Analysis-backed Distribution option source is missing from Report props.

**Interfaces:**
- Consumes: final toolbar/view copy and existing Workspace Report lifecycle.
- Produces: locale parity and unchanged `.sprp`/history/lifecycle behavior.

- [ ] **Step 1: Write locale and integration RED assertions**

Replace obsolete source/preview keys in `REPORT_KEYS` with exact keys for block
types, formatting tooltips, insert menu, link URL/validation/unlink, editor
placeholder, unsupported source, and import retry/error. Add Workspace source
contracts proving Report receives all current Analysis report-capable options,
including Distribution, without reading legacy stores.

- [ ] **Step 2: Run RED**

Run `reportLocale.test.ts` and `workspaceReport.test.ts`. Expected: at least one
fails because new locale keys and/or Distribution option wiring are absent.

- [ ] **Step 3: Add all four translations and repair only proven Workspace gaps**

Remove obsolete editor/preview copy only after confirming no production reference.
Add natural English, Simplified Chinese, Traditional Chinese, and Vietnamese copy.
If the RED Workspace assertion proves the Distribution options are absent, derive
them from Analysis documents accepted by the Distribution report policy and pass
them to `ReportView`; do not revive the legacy Distribution store.

- [ ] **Step 4: Run focused Report verification**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportParser.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportProjectContracts.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportStore.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/reportLocale.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsx --tsconfig tsconfig.app.json tests/workspaceReport.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- playwright test -c playwright-ct.config.ts tests/reportProjectEmbed.spec.tsx tests/reportToolbar.spec.tsx tests/reportView.spec.tsx
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report exec -- tsc -p tests/tsconfig.report.json
```

Expected: every command exits 0.

- [ ] **Step 5: Run production and archive compatibility gates**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report run build
cargo test --manifest-path /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report/src-tauri/Cargo.toml spprj_archive::tests:: -- --nocapture
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report --no-pager diff --no-ext-diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Independent review and manual acceptance runtime**

Request an independent whole-branch review against Issue 141 and the design spec;
fix every Critical or Important finding and rerun affected gates. Then start Tauri
with:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/141-report run tauri -- dev
```

Verify the Vite port and desktop process both resolve to the Issue 141 worktree,
then provide the acceptance checklist. Do not commit, push, or create a pull
request until Ashton explicitly accepts the runtime.
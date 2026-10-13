---
name: sp-mcp-guide
description: Use when operating the sp-mcp server for project inspection, tables, transformations, SQL, CSV export, graphs, analyses, Tabulate, reports, saving, snapshots, or recovering from tool and revision errors.
---

# sp MCP guide

Use the connected `sp-mcp` server and its advertised tools. The `statsplayground_*` identifiers are compatibility API names, not product branding. Do not guess abbreviated tools such as `sp_distribution`.

Read [the complete tool reference](references/tools.md) before constructing unfamiliar arguments. It covers all 22 tools, nested contracts, examples, output paths, prerequisites and errors. [Machine-readable examples](references/examples.json) are contract fixtures, not instructions to generate user data or execute all mutations.

## Safe command sequence

1. Inspect the project, list tables/documents (follow `nextCursor`), and describe the chosen source. Resolve IDs from returned data. Ask when the requested file is absent or the source is ambiguous.
2. Read the tool's actual schema. Use camelCase fields and explicit enum discriminators. Creation and update payloads differ; updates often replace a complete definition.
3. Execute dependent mutations sequentially. Preserve returned IDs, revisions, generation, warnings and status. Optional top-level `control` contains `expectedProjectRevision` and `idempotencyKey`; never put these inside a draft or manufacture confirmation flags.
4. Check MCP `isError`/structured errors, then domain statuses inside successful `data`. A successful call can contain a failed analysis or transform. Interpret only available results.
5. Read back the created/updated document. Save only when a project path already exists; MCP save cannot select a destination.

## Four different version values

- `projectRevision`: envelope/project mutation fence; update from each response. A guarded mutation uses `control.expectedProjectRevision`.
- `configRevision`: analysis configuration; mandatory `expectedConfigRevision` on analysis updates.
- `documentRevision`: graph/report content; mandatory `expectedDocumentRevision` on updates. Use creation/update responses.
- `generation`: source table version; establishes result/cache freshness, not a document revision.

On `revision_conflict`, reread the affected definition and reconcile concurrent edits before submitting a complete replacement. `document.get` exposes analysis `configRevision`, but **does not return graph/report document revisions**. Use a conflict's `details.actual` only when actually supplied; there is no general revision-read tool. If unavailable, explain the limitation rather than guess.

## Error recovery

Errors contain `requestId`, `code`, `message`, `retryable`, and optional `details`; schema errors may instead be MCP invalid-params errors. Correct invalid inputs; rediscover `not_found` IDs; respect read-only/path/confirmation restrictions. Do not blindly retry a permanent error. For timeout/cancellation or an uncertain write outcome, inspect documents first and reuse the same idempotency key with the same arguments where supported. A new logical mutation needs a new key. Honor cancellation and warnings.

The current catalog has no CSV-import, general table-edit, document-delete/rename, report-export, result-polling, or project-save-as tool. Parse supplied CSV outside MCP then create a managed table, or use UI import for large files. The tools operate on the current project; do not assume they open another project. Mutations can activate documents and mark the project dirty.

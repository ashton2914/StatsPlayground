# Default v5 builds and a table-centered project directory

Status: design approved on 2026-10-30, including directed cascade deletion and
whole-group folder drag/drop; product implementation has not started.

## Intent and confirmed requirements

Normal native development, release, and portable builds use the existing v5
persistent DuckDB project architecture without an extra feature argument.
The project directory displays typed application objects by name and icon,
without synthetic per-object filename extensions.

Tables are the center of navigation. Graph Builder, Graph Builder-new,
Analysis (all analysis kinds), and Tabulate documents appear beneath their
source table. A Transform establishes directed parent/child dependencies from
each input table to its output table. Moving, copying, and project-object export
operate on the complete linked component, including all inputs, outputs,
branches, and chained transforms. Join and Concatenate connect every input.
An unconnected table is a component of one.

Deletion follows the directed dependencies rather than whole-component
membership: a derived table may be deleted independently of its upstream
parents, but deleting a table also deletes every downstream descendant and
every Graph/Analysis/Tabulate owned by any deleted table. Individual owned
documents can be deleted without deleting their table.

The bracket reference guides visual grouping: table rows may remain peers
inside the linked block, but a derived table is semantically a child of its
input table(s), never an independent table merely sharing a folder. Each table
retains its own expandable Graph/Analysis/Tabulate children.

## Inspected implementation

- `src-tauri/Cargo.toml` defines `project-v5 = []` with no default enablement.
- `src/projectPersistence/startup.ts` selects native persistence through the
  backend feature probe. Existing migration, draft recovery, coordinator,
  incremental save, and revision/epoch contracts must remain authoritative.
- `src/components/Workspace.tsx` currently groups object kinds independently by
  folder, appends extensions, and dispatches moves per individual object.
- `src/types/projectPersistence.ts` exposes paginated summary records with
  kind, name, folder, revision, and dependencies.
- `src/projectPersistence/documentAdapters.ts` extracts single-table document
  dependencies, but its generic extraction does not establish complete
  Transform input/output topology. Do not assume `dependencies[0]` describes
  a Transform or enough information to form a group.
- Transform definitions declare output table IDs; project bindings declare
  input table IDs. The persisted lineage graph also represents operations.
- `src-tauri/src/services/project_catalog.rs` applies record patches inside
  the encompassing project transaction. Existing table retirement/history
  code is per-table and cannot by itself guarantee a group operation.

## Approach

Use the existing native catalog and Transform definitions/bindings as the
source of truth, with one backend topology resolver and transactional
operations. It computes complete connected components for move/copy/export
and directed descendant closures for delete. Frontend navigation is a
projection of that same topology.

Other approaches considered:

1. A UI-only nested tree is smaller, but raw commands and MCP could still
   split a group; it cannot satisfy the confirmed operation rules.
2. A separately editable group registry or physical directory hierarchy
   duplicates Transform ownership and can diverge after Join, replay, or
   migration. It is unnecessary for this requirement.
3. A backend-enforced projection of actual Transform links satisfies all
   entry points and preserves existing stable object IDs. This is the proposed
   approach because the indivisibility requirement rules out the first two.

No external filesystem rearrangement or replacement data engine is required.

## Group identity and metadata

Treat each Transform as a connector between all bound inputs and its declared
output. Resolve connected components over table IDs; preserve connector IDs,
input roles, operation labels, and output direction for presentation and
cascading deletion. Do not reuse an undirected component as the delete scope.
Reject cycles when establishing Transform dependencies.

Group membership is derived, never user-editable. Use stable table/document
IDs, not display names or folder strings. A deterministic representative ID
may key UI expansion, but it is not an authorization token or permanent domain
identity: merging two groups can change the representative.

Provide a bounded, metadata-only group/topology query or indexed catalog
projection so a partial catalog page is never mistaken for complete membership.
The builder chooses an additive schema/query implementation after inspecting
backend producers. It must cover unhydrated transforms and return the project
revision it represents. Do not hydrate graph/analysis bodies or scan dataset
rows merely to show the tree or resolve a group.

Backend writes maintain canonical source ownership and Transform topology in
the same transaction as affected records. Never trust frontend-supplied member
lists as authority. Detect missing IDs, invalid roles, missing bindings, and
contradictory topology; expose a recoverable diagnostic and block group-changing
operations instead of silently treating broken links as unrelated tables.

## Navigation and naming

Render a linked component as a bracketed block with a Transform icon/link
control; each table is a collapsible peer. Expanding a table shows its graph,
analysis, and tabulation documents, each with its existing type icon and name.
Clicking a table or child opens the existing editor. Connector controls open the
existing Transform editor and show operation/source/target information.

Order tables upstream to downstream, with stable ID tie-breaking for peers.
Multiple incoming links and branches retain direction without duplicating table
objects. A group of one does not need a prominent connector bracket.

Keep existing folders as optional containers for whole groups. Folder moves
must account for all contained groups. Table children inherit their table's
location and cannot be independently moved to another folder or table.
Creating a folder creates an empty container at the root or inside another
folder. It does not create or alter Transform relationships. Dragging a table,
a group handle, or one of the table's owned documents onto a folder resolves
the owning table's complete linked component and moves that whole component.
Dropping back at project root does the same. There is no independent child-file
move that bypasses table ownership. A drop onto a table or document cannot
reparent objects. Deleting a folder retains the existing non-destructive rule:
promote its contained groups to its parent, preserving complete groups.

Expansion state is UI state and must survive rename without depending on names.

Names are application-object names rather than filenames. Remove automatic
extension appending and fixed extension decorations from the directory,
rename fields, menus, tooltips, and validation paths used for internal objects.
Do not strip text from user-authored names just because it resembles an
extension. Stable kind/ID distinguishes objects; preserve existing applicable
name collision behavior within each kind and parent.

The project container retains `.spprj`. Explicit CSV, spreadsheet, legacy
archive, and other interchange files retain their real external extensions.
This does not restore standalone project-object export for a linked table.

## Operations and entry points

Resolve move/copy/project-object export on any linked table to its complete
current component. Resolve deletion to the selected table plus its transitive
downstream descendants and their owned documents. UI menus and drag affordances
communicate the actual scope before execution; delete confirmation lists that
exact directed cascade, not every table in the linked component. The backend
revalidates topology and revision under its serialized writer.

- **Move:** update the folder of every table, Transform, and owned child in
  one transaction; reject a raw partial move. Folder operations obey the same
  rule, including groups that were spread across folders by older projects.
- **Delete table:** retire the selected table, all downstream descendant
  tables, their owned Graph/Graph-new/Analysis/Tabulate documents, directory
  records, and associated table state atomically. Remove Transform definitions,
  bindings, and lineage edges that produce deleted outputs; preserve upstream
  parents and unaffected sibling branches. For a multi-input Transform, deleting
  any required input deletes its output and descendants but preserves the other
  input tables. Preserve recoverable metadata and existing undo/redo semantics;
  the complete deletion cascade must replay as one unit.
- **Delete owned document:** delete only the selected graph, analysis, or
  tabulation. Preserve its source table, siblings, and Transform relationships.
- **Copy:** create a complete group in the selected destination, assigning new
  table, connector, and child-document IDs. Remap all internal references,
  Transform bindings, and lineage to copied IDs. Preserve current data,
  definitions, display/filter settings, and document configuration; original
  undo history and transient caches are not copied. Copy failure publishes
  nothing. Large copies may use isolated staging and cancellation followed by
  one atomic publication.
- **Project-object export/import:** use a self-contained native `.spprj`
  subset containing the entire group, its Transform definitions/bindings,
  owned children, required state, and consistent data snapshot. Import
  validates and remaps identities before atomic publication, preserving the
  complete connected component. Cancellation leaves the source untouched.
- **Rename/edit:** renaming one table or editing an individual child remains
  possible; it changes content/name, not group membership. Deleting/copying an
  individual graph, analysis, or tabulation remains a document action; it does
  not detach tables or split the linked group.

Deleting a derived table legitimately removes its producing Transform and
changes component membership. This is distinct from removing or unbinding a
Transform while retaining its output as a detached table; standalone
remove/unbind routes must not expose that bypass. Transform
execution and edits may update parameters and produce new linked outputs, but
cannot silently detach existing member tables. Rebinding that would remove an
existing link is rejected in this scope; a future explicit detach feature is
outside this design.

Apply enforcement to native UI handlers, application commands, MCP, generic
record patches, table deletion/export commands, Transform remove/rebind, folder
mutations, and undo/redo. Internal workflow staging cleanup operates on private
unpublished staging IDs, not a loophole for public project tables.

Existing project-wide Reports and Workflows remain supported. Their references
do not by themselves merge otherwise unrelated Transform groups. Before table
deletion, find references from outside the directed deletion cascade and reject
the operation with
an actionable list rather than silently damaging unrelated documents. A group
export never emits dangling external references; include only owned objects
and validate the resulting package. Reports/workflow UI redesign is outside
this change.

## Existing project compatibility

Preserve the existing legacy-to-v5 migration and source-file protection. Older
v5 projects may contain complete Transform records but incomplete summary
indexes; repair their metadata from authoritative definitions/bindings through
an explicit compatible migration/transaction, never by loading table data.

If old folder assignments split a group, choose the folder of the first
upstream table using stable ordering, show the proposed destination, and offer
one atomic normalization action before permitting a move. Do not silently
rewrite unrelated folder organization on open. Children display beneath their
source table regardless of old independent child-folder assignments; persist
canonical inherited location on explicit normalization or subsequent writes.

If old project links are inconsistent, preserve the original file and show
which connector/table needs repair. Do not silently discard a link or offer
partial-group export or an incomplete descendant cascade as a fallback.

## Default-build change

Enable `project-v5` through Cargo default features and verify ordinary Tauri
development, release, and portable invocations actually select it. Retain an
explicit `--no-default-features` developer compatibility path if the current
legacy implementation requires it; release jobs must not accidentally use that
path. Update development instructions and previous opt-in wording.

Do not alter the locked DuckDB version or rewrite startup/recovery policy.
The feature probe must return true for default native builds, and startup must
reach the existing native draft/open path. Run the existing persistence suite
and inspect relevant pre-existing failures before promoting the default.

## Verification and acceptance

- Default Cargo configuration and ordinary packaging select project-v5;
  a native startup check demonstrates v5 draft creation and persistence.
- Graph, Graph-new, every Analysis kind, and Tabulate are under their correct
  source table with no generated suffix in display or rename controls.
- Independent table; one Transform; chained transforms; branched transforms;
  Join/Concatenate with multiple inputs; rename and empty/failed outputs.
- Membership works across catalog pages and unopened document bodies without
  table reads or analysis evaluation.
- Move/copy/export invoked on any member affects exactly the whole component;
  direct partial requests through raw commands/MCP are rejected.
- For A -> B -> C, deleting B removes B/C and their owned documents but
  preserves A and its owned documents; deleting A removes A/B/C.
- For A -> B and A -> D, deleting B preserves A/D; deleting A removes both
  branches. A child graph/analysis/tabulation can be deleted alone.
- For A + X -> B, deleting A removes B and its descendants but preserves X;
  deleting B preserves both A and X. Validate no dangling Transform records.
- UI, application-command, MCP, and raw native deletion entry points all apply
  the same directed cascade; they neither over-delete ancestors nor leave
  dependent descendants behind.
- Fault injection before publication leaves all members unchanged; stale
  revision/epoch requests cannot act on a newly changed component.
- Copy and import remap identities and survive close/reopen; exported native
  subset opens with complete data, links, and child configurations.
- Undo/redo of table deletion restores/retires the exact complete cascade,
  including owned documents and Transform state, while preserving unaffected
  ancestors and sibling branches. External references produce explicit blockers.
- Existing legacy migration, v5 reopen, recovery, autosave, read-only rejection,
  and catalog budgets continue to hold.
- Visual acceptance checks bracket alignment, child indentation, expand/collapse,
  drag scope, menus, and destructive confirmation in the actual desktop app.

## Scope and remaining builder decisions

This is a cross-layer project, not only a directory styling change. It includes
v5 default promotion, dependency metadata, table-centered navigation, group
operation enforcement and copying/exporting the group using existing native
project capabilities. No Git publication, release, machine installation, or
user-data cleanup is requested.

The builder chooses exact internal API names, additive metadata representation,
topology layout details, localization keys, staging strategy, and focused tests,
while preserving the contracts above. Design approval authorizes implementation
planning. Existing Node/npm tooling has been located and verified; execution
can select it through a process-scoped PATH without installing tools or changing
machine settings.

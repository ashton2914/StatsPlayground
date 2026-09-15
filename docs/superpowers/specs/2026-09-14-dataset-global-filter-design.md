# Dataset-Global Filter Design

## Context

Issue #198 reports two related failures:

1. A Table filter disappears after navigating away from the Table and returning.
2. A Graph Builder filter does not appear in or affect the source Table.

The current implementation has two independent owners. `DataTableView` keeps filters in component-local React state and clears them when the dataset view mounts. Each `GraphBuilderItem` separately persists its own `filters` array. The views share filter rule types and UI, but not state.

The approved product rule is stronger than synchronization: a dataset has exactly one Filter. Its Table and every Graph Builder sourced from that dataset always use the same rules. Graph-local filter divergence is no longer supported.

## Goals

- Make a dataset's Filter survive view unmount and remount.
- Make Table and every Graph Builder for the same dataset observe and edit one authoritative Filter.
- Persist dataset Filters in `.spprj` and restore them on project open.
- Migrate legacy graph-level filters deterministically.
- Preserve independent Filters for different datasets.
- Cover dataset deletion, column rename, project reset, read-only save state, and legacy archives.

## Non-Goals

- Persist whether a Filter panel is open or its width. Those remain per-view transient presentation state.
- Share Filters between different datasets, even when one table derives from another.
- Add Filter inheritance to Analysis documents or embedded frozen graph configurations.
- Add a conflict-resolution UI for legacy projects.
- Change filter predicate semantics, SQL serialization, categorical exclusion behavior, or graph sampling.

## Chosen Architecture

### Runtime authority

Add a dedicated Zustand store keyed by stable dataset ID:

```ts
type DatasetFilters = Record<string, FilterRuleItem[]>;
```

The store is the only runtime authority for live Table and standalone Graph Builder filtering. It owns actions to:

- replace one dataset's rules;
- delete one dataset's rules;
- migrate a renamed column within one dataset's rules;
- load the complete project mapping;
- reset all rules.

Rules returned to consumers are the canonical empty Filter `[]` when the dataset has no map entry. Omitting that empty array from persisted output is only a storage optimization; the dataset still has exactly one logical Filter authority.

`DataTableView` subscribes to the rules at its `datasetId`. It no longer initializes or clears rules during mount. Its existing query reload effect continues to serialize the subscribed rules and reset the viewport to row zero when rules change.

`GraphBuilderView` subscribes to the rules at `item.sourceDatasetId`. Its Filter panel writes to the dataset store instead of calling `updateItem(item.id, { filters })`. The graph request identity continues to include the effective filters, so every open Graph for the dataset restarts its data pipeline when the shared rules change.

Changing Filter rules is a project mutation. Both Table and Graph entry points reject changes while the project is read-only and mark the project dirty after a successful change. Panel visibility and width remain local state and do not mark the project dirty.

### Persisted authority

Add optional `datasetFilters` to `manifest.json`, keyed by dataset ID. This belongs in the project manifest because it is project presentation/query state associated with a stable table identity, similar to existing dataset-keyed folder metadata. It does not belong in `.sptb`, because changing a Filter must not rewrite table data, and it does not belong in `.spgh`, because graph-local ownership is being removed.

The frontend `SaveProjectRequest` sends `datasetFilters`. Rust validates and writes the mapping into `ProjectManifest`. `OpenProjectResult` returns the restored mapping. Missing fields deserialize to an empty map for backward compatibility.

The archive layer validates persisted rules rather than trusting arbitrary JSON. Valid rules must have a supported `kind`, a non-empty field name, a valid field type, a supported logical operator, and values matching the rule kind. Invalid dataset Filter payloads fail project open as invalid archive data rather than reaching DuckDB.

## Legacy Migration

Legacy `.spgh` documents may contain `GraphBuilderItem.filters`. Migration groups graph entries by `sourceDatasetId` and compares normalized complete filter arrays.

For each dataset:

1. Exactly one legacy Graph references the dataset: migrate that Graph's complete filter array, including `[]`.
2. Multiple legacy Graphs reference the dataset and every complete filter array is structurally identical: migrate that shared array.
3. Multiple legacy Graphs reference the dataset and any complete filter arrays differ, including `[]` versus a non-empty array: select the canonical empty Filter `[]` and record one conflict for that dataset.

A dataset referenced by only one legacy Graph with non-empty filters migrates that Filter. Rule comparison includes order, logical operators, field identity, values, exclusion mode, and persisted card height; IDs are retained and therefore also participate in exact structural equality.

The open result adds `datasetFilterMigrationConflicts: string[]`, containing only affected dataset IDs. A non-empty list sets `requiresMigration = true`, marks the project dirty, and produces a localized Workspace toast stating that conflicting legacy graph filters were cleared. The warning does not expose filesystem paths.

After migration, frontend graph items are normalized without a live `filters` property. The next save writes `datasetFilters` to the manifest and writes graph documents without legacy filters. Migration is therefore one-way and removes the dual source of truth.

## Import And Export Boundaries

A standalone `.spgh` is a graph configuration, not a dataset state package. New graph exports omit dataset-global Filter rules. Importing a new-format graph does not alter the destination dataset's Filter.

For a legacy `.spgh` import that still contains `filters`, the importer removes the legacy field. It does not overwrite an existing dataset Filter implicitly. If the destination dataset currently has no Filter and product behavior later needs an adoption prompt, that is separate work; Issue #198 does not add it.

Embedded graphs inside Analysis definitions retain their existing persisted `filters` contract because they represent frozen analysis presentation/configuration rather than a standalone Graph Builder editing the dataset-global Filter. This change must not route embedded Analysis graph filters through the live dataset store.

## Lifecycle Integration

- **Project create/close/open:** reset the dataset Filter store before initializing or loading another project; load the complete mapping after project data is restored.
- **Project save:** read the mapping directly from the store at save time to avoid stale React closures.
- **Dataset delete:** delete the matching Filter entry in the same user action.
- **Column rename:** update matching `rule.field.name` values for that dataset before subsequent Table or Graph queries; preserve the field type and all rule values.
- **Graph create/delete:** no Filter state is created or deleted because ownership is the dataset.
- **Dataset generation changes:** preserve valid Filter rules. Existing backend query errors remain authoritative if a dataset schema changes outside the supported rename path.
- **Read-only save window:** Filter editors remain visible but cannot mutate state while `readOnly` is true.

## Error Handling

- Invalid persisted `datasetFilters` cause `AppError::InvalidParam` or the archive's established invalid-data error at project-open validation.
- A legacy migration conflict is recoverable, clears only that dataset's Filter, and surfaces a toast plus dirty state.
- Filter query failures continue through the existing Table and Graph error paths; the shared store does not swallow or rewrite backend errors.
- Migration warnings report dataset display names in the UI when resolvable, but the transport carries stable IDs.

## Testing

### Store tests

- Different dataset IDs retain independent rule arrays.
- Replacing one dataset's Filter notifies all subscribers to that key.
- Deleting a dataset removes only its Filter.
- Column rename updates matching rules and leaves unrelated rules unchanged.
- Load and reset replace the complete mapping without retaining stale entries.

### Frontend integration tests

- Set a Table Filter, unmount/remount the Table, and verify the same rules and filtered request remain active.
- Edit a Filter in Table and verify two Graph Builders for the same dataset derive identical graph requests.
- Edit a Filter in either Graph and verify Table and the other Graph immediately use it.
- Verify a Graph for another dataset is unaffected.
- Verify Filter mutation is blocked during read-only save state.
- Verify project save reads `datasetFilters`, project open loads it, and project close resets it.
- Verify dataset delete and column rename call the store lifecycle actions.
- Verify standalone graph export/import does not establish a second Filter authority.

### Rust archive tests

- Current-format `datasetFilters` round-trips through save/open.
- A manifest without `datasetFilters` opens as an empty mapping.
- One legacy filtered Graph migrates its rules.
- Multiple identical non-empty legacy Graph filters migrate once.
- Empty versus non-empty or differing legacy Graph filters clear the dataset Filter and return one conflict ID.
- Legacy graph payloads are rewritten without `filters` on the next save.
- Invalid rule payloads are rejected before frontend load.

### Regression gates

Run the focused Filter, table viewport, graph data pipeline, project save lifecycle, archive, Analysis contract, TypeScript build, Rust test, and Clippy suites. The Analysis gate is required because `Workspace.tsx` and archive structures are touched, even though Analysis filtering behavior is a non-goal.

## Acceptance Criteria

1. A Filter created in Table remains present and applied after navigating away and back.
2. Table and every standalone Graph Builder for one dataset display and apply the same rules.
3. Editing from any one of those views updates all others without requiring project reload.
4. Saving and reopening the project restores the shared Filter.
5. Different datasets remain isolated.
6. A conflicting legacy project opens successfully, clears only conflicted dataset Filters, warns the user, and becomes dirty for migration save.
7. No standalone graph item remains a live or persisted Filter authority after migration.
8. Existing embedded Analysis graph behavior remains unchanged.

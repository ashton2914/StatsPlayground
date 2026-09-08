# Multivariate Graph Builder Mode Design

**Date:** 2026-08-28

**Status:** Approved

**Issue:** #69

## Goal

Add a first-class Multivariate mode alongside Graph Builder's 2D and 3D
modes. The first release moves Correlation Matrix out of the 2D layer model
and lets users build it by dropping 2 to 20 continuous columns onto a dedicated
Y (Variables) role.

Each mode owns an independent visualization configuration. Switching modes
restores that mode's fields, layers, axes, and presentation settings without
changing either of the other modes.

Regression analysis is explicitly out of scope. The design leaves a chart-type
selection boundary in Multivariate mode so regression plots can be designed
later without another mode-model migration.

## User Experience

The Graph Builder toolbar always displays one segmented mode control:

```text
2D | 3D | Multivariate
```

New graphs open in 2D mode. Selecting another mode immediately restores its
last configuration. Mode changes never copy, clear, or reinterpret another
mode's fields.

Multivariate mode initially offers one chart type, Correlation Matrix, which is
selected automatically. The chart-type control remains visible as the future
extension point for other multivariate charts.

The role panel contains one Y (Variables) drop zone. Users can:

- drop several columns at once;
- append columns with later drops;
- reorder selected columns;
- remove individual columns.

Only continuous numeric columns are accepted. Duplicate columns and a 21st
column are rejected with visible feedback. With fewer than two valid columns,
the center panel shows guidance instead of requesting a matrix. With 2 to 20
columns, the matrix updates immediately and preserves their displayed order on
both axes.

Multivariate mode exposes the existing Pearson, Spearman, and Kendall method
control and the local data filter. Correlations always use the complete
filtered dataset. The following controls are hidden because they do not apply:

- X, Z, Group, Overlay, Wrap, and facet roles;
- ordinary and 3D layer controls;
- Swap X/Y;
- pan and point-selection cursor modes;
- axis settings and reference lines;
- raw-point sampling.

## Approaches Considered

### Recommended: Explicit Mode With Nested State

Persist an explicit active mode and independent 2D, 3D, and Multivariate state
objects. Shared graph identity and data-selection concerns remain at the item
level. This establishes one canonical state location, cleanly separates
ordinary multi-column melt semantics from correlation-variable selection, and
supports future multivariate chart types.

### Flat Active State With Hidden Snapshots

Keep the current flat fields as the active configuration and copy them into
mode snapshots during every switch. This appears smaller initially but creates
two possible sources of truth, complicates autosave and history, and makes a
partially completed switch persistable. This approach is rejected.

### Separate Graph Builder Items

Represent each mode as a separate graph item. This provides isolation but no
longer behaves as three modes of one graph and clutters project navigation.
This approach is rejected.

## Persisted State Model

`GraphBuilderItem` gains an explicit mode:

```ts
type GraphBuilderMode = "2d" | "3d" | "multivariate";

interface GraphBuilderItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  mode: GraphBuilderMode;
  modeStates: {
    twoD: Graph2DState;
    threeD: Graph3DState;
    multivariate: MultivariateGraphState;
  };
  filters?: FilterRuleItem[];
  sampling?: GraphSampling;
  createdAt: string;
}
```

The mode-specific states own only settings that affect their visualization:

- `Graph2DState`: X/Y and grouping encodings, `multiX`/`multiY`, 2D elements,
  axis settings, reference lines, auto-spec flags, smoother settings, group
  styles, theme-slot identities, and hidden groups.
- `Graph3DState`: X/Y/Z and grouping encodings, 3D elements, applicable
  smoother settings, group styles, theme-slot identities, and hidden groups.
- `MultivariateGraphState`: ordered `columns`, `chartType`, and
  `correlationMethod`.

The initial defaults are:

- 2D: empty encoding with Points enabled;
- 3D: empty encoding with 3D Scatter enabled;
- Multivariate: no columns, Correlation Matrix selected, Pearson method.

Name, source dataset, filters, sampling policy, and creation time remain shared.
Sampling remains persisted because it applies when 2D or 3D is active, but it
is ignored and hidden in Multivariate mode.

The old `threeD`, flat `encoding`, `multiX`, `multiY`, `elements`, axis,
reference-line, and presentation fields become legacy read inputs only. New
application code reads and writes `mode` and `modeStates` exclusively.

## Legacy Project Migration

Project loading normalizes every graph item at the Zustand store boundary.
Normalization is pure and idempotent: normalizing an already-current item does
not alter it.

For an ordinary legacy graph:

1. Set the active mode from `threeD` (`true` means 3D; otherwise 2D).
2. Copy shared legacy X/Y and compatible grouping bindings into both Cartesian
   mode states so either mode preserves the pre-migration view.
3. Copy Z and Group Z only into the 3D state.
4. Split elements through a shared element-dimension registry. Put 2D elements
   in the 2D state and 3D elements in the 3D state.
5. Copy 2D-only axis and reference-line settings into the 2D state. Copy
   applicable presentation settings into each Cartesian state.
6. Initialize Multivariate state with its defaults.

For a legacy correlation graph:

1. Set the active mode to Multivariate regardless of `threeD`.
2. Use the non-empty `multiX` list, otherwise the non-empty `multiY` list, as
   the ordered Multivariate columns. Legacy correlation UI rules prevented both
   lists from being active; if malformed input contains both, `multiX` wins to
   match the current read precedence.
3. Preserve the correlation method, defaulting a missing or invalid value to
   Pearson.
4. Initialize 2D and 3D with their defaults because enabling the legacy
   exclusive correlation layer removed ordinary layers.

Current-format projects are saved without legacy fields. No backend project
schema migration is required because graph items are serialized as frontend
project data, but save/reload tests must prove the new nested shape survives a
round trip.

## Frontend Architecture

Mode selection becomes a three-option setter rather than a boolean 3D toggle.
All field editing, layer editing, chart rendering, and request derivation first
select the active nested state. Helpers receive the relevant state directly
instead of branching repeatedly on the complete graph item.

The existing layer-dimension knowledge currently embedded in Graph Builder UI
code moves to a reusable module so migration and layer presentation share the
same classification.

Ordinary multi-column behavior remains unchanged inside `Graph2DState`:
`multiX` and `multiY` still represent axis/merge melt operations. Correlation
selection no longer reads or writes those fields. It uses only
`MultivariateGraphState.columns`.

The renderer dispatch is explicit:

- 2D mode builds the existing `Graph` specification from `Graph2DState`.
- 3D mode builds the existing `Chart3D` specification from `Graph3DState`.
- Multivariate mode uses the existing correlation matrix ECharts transform.

No regression chart type, model options, or statistical computation is added.

## Data Flow And Backend Contract

The graph-data pipeline reads only the active mode state.

For Multivariate mode, it derives the existing exclusive correlation request:

- `chartType` becomes the existing `correlationMatrix` element request;
- `correlationMethod` becomes the existing method option;
- ordered `columns` become `multiY0`, `multiY1`, ... bindings;
- shared local filters are included;
- sampling is omitted.

Using one fixed role family makes the frontend request deterministic. The
existing Rust resolver, DuckDB query, pairwise missing-value behavior,
correlation algorithms, aggregate packet, cancellation, generation fencing,
and ECharts matrix transform remain unchanged.

Inactive mode states do not contribute fields, elements, or requests. A mode
switch therefore issues at most the request required by the newly active mode
and cannot accidentally melt Multivariate columns through the 2D pipeline.

## Error Handling

- The UI rejects non-continuous fields, duplicates, and selections over 20.
- Fewer than two columns is a valid editable state and produces no request.
- Rust independently retains its 2-to-20, uniqueness, numeric-type, method,
  and column-existence validation.
- Pipeline failures use the existing error overlay and do not clear mode state.
- Switching modes during a request relies on the existing request ID,
  generation, and cancellation fencing; a stale result cannot replace the
  active mode's chart.
- Invalid legacy correlation methods normalize to Pearson. Other malformed
  legacy fields fall back to the affected mode's default without changing
  valid sibling mode state.

## Testing

Development follows red-green-refactor. The first failing tests target the pure
normalizer before production migration code is added.

### State And Migration Tests

- New items contain all three default states and start in 2D.
- Switching modes preserves independent fields, elements, axes, ordering, and
  correlation method.
- A legacy 2D item migrates shared Cartesian bindings and splits layers.
- A legacy 3D item activates 3D while retaining a usable 2D state.
- A legacy correlation item migrates ordered columns and method.
- Malformed dual-list legacy correlation input deterministically prefers
  `multiX`.
- Normalization is idempotent.
- Save/reload preserves the nested shape and emits no legacy fields.

### Pipeline And UI Tests

- Multivariate columns derive ordered `multiY0...multiYn` roles and the selected
  correlation method without synthetic melt fields or sampling.
- Inactive mode bindings never enter a request.
- Existing 2D `multiX`/`multiY` axis and merge semantics remain unchanged.
- Y (Variables) accepts 2 to 20 unique continuous fields, supports append,
  reorder, and removal, and rejects invalid drops.
- Mode-specific controls are shown or hidden according to the active mode.
- Changing modes during an in-flight request cannot commit a stale result.

### Existing Correlation Coverage

Existing frontend packet, transform, project-lifecycle, and Rust correlation
tests remain authoritative for statistical and rendering behavior. Backend
production code should not change for this issue.

## Validation

The change is complete when:

1. Focused state migration and graph-data pipeline tests pass.
2. Existing correlation and ordinary multi-column frontend tests pass.
3. The complete TypeScript test suite passes.
4. `npx vite build` succeeds.
5. Existing focused Rust correlation tests pass.
6. A Tauri development run verifies mode switching, independent state restore,
   filtering, all three methods, invalid drops, ordering, and save/reload.
7. Existing 2D and 3D charts retain their rendering and interactions.

## Non-Goals

- Regression analysis or regression-specific plots.
- New correlation statistics or matrix rendering styles.
- Changes to pairwise missing-value semantics.
- Faceting, grouping, reference lines, sampling, or point selection in
  Multivariate mode.
- Backend correlation protocol changes.
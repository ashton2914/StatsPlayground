# Issue 64 Graph Theme Identity Design

## Problem

Graph Builder currently derives automatic colors from the order in which groups are present in a data frame. That order can change when layers are added, removed, or reordered; when sampling changes; when a group temporarily has no plottable rows; and when a 2D or 3D Graph Builder is unmounted and mounted again. The current component-local slot registry reduces changes during one mount, but loses its state during navigation.

Colors are visual identifiers. A group that receives a theme identity must retain it throughout the graph item's lifetime and after project save/load. Rendering order and temporary data availability must not redefine identity.

## Goals

- Preserve each group's automatic theme identity across layer add/remove/reorder, hidden groups, filters, sampling modes, frame rebuilds, Graph/Table navigation, and 2D/3D navigation.
- Use the same identity for every 2D and 3D display element.
- Persist identities in the Graph Builder project item and restore them on load.
- Keep user style overrides authoritative.
- Let custom Palette edits change the colors represented by a slot without changing group-to-slot assignment.
- Preserve compatibility with project files that predate this feature.

## Non-Goals

- Persist resolved RGB values for automatic themes.
- Change the Rust project archive schema or graph-data IPC protocol.
- Make Value Order redefine color identity.
- Keep removed custom Palette colors frozen in existing graphs.

## Persistent Model

Add the following optional field to `GraphBuilderItem`:

```ts
export type GroupThemeSlots = Record<string, Record<string, number>>;

interface GraphBuilderItem {
  groupThemeSlots?: GroupThemeSlots;
}
```

The outer key is the grouping field name. The inner key is the normalized group value. The number is a non-negative theme slot.

Field names namespace identities because two grouping fields may contain the same category text with unrelated meaning. Color and Overlay bindings to the same field share the same namespace. A Graph Builder item already belongs to one source dataset, so no dataset identifier is needed in the key.

Slots are append-only within a field namespace. Temporarily absent or hidden groups retain their entries. Newly discovered groups receive the lowest unused non-negative slot. Changing Value Order changes presentation order only. Removing or rebinding a grouping field does not erase prior assignments, so rebinding restores prior visual identities.

## Resolution Pipeline

Introduce pure theme identity helpers in `graphThemeIdentity.ts`:

```ts
export function reconcileGroupThemeSlots(
  current: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  activeKeys: readonly unknown[],
): GroupThemeSlots;

export function groupThemeSlot(
  slots: GroupThemeSlots | undefined,
  fieldName: string | undefined,
  groupKey: string,
  fallbackIndex: number,
): number;
```

`reconcileGroupThemeSlots` preserves every existing assignment, ignores blank/sentinel keys, and allocates only new keys. It must repair malformed legacy JSON defensively: ignore negative, fractional, duplicate, or non-finite slot values, then assign valid unique slots deterministically.

Graph Builder computes active group keys from both `encoding.color` and `encoding.overlay` using the existing aggregate/raw dictionary discovery and stable ordering. It immediately derives a reconciled map for rendering. A guarded effect writes a changed map to the Zustand item, marking the project dirty through the existing update path. Read-only projects use the derived map for the current render but do not attempt persistence.

Automatic styles are resolved from stable slot numbers rather than the active group's array index:

1. Resolve the slot from `groupThemeSlots[fieldName][groupKey]`.
2. Interpret that slot against the current custom Palette list followed by built-in colors.
3. Build a complete `GroupStyle` containing line, fill, point, and gradient marks.
4. Overlay `groupStyles[groupKey]` per mark. Explicit user styles have highest priority.
5. Pass the complete style map through `GraphSpec.styles` to both 2D and 3D renderers.

When custom Palettes are edited or removed, the same slot is interpreted against the updated Palette sequence. Colors may update by product choice, but group-to-slot identity does not change.

## Renderer Contract

Every grouped display element must resolve color by group key from `GraphSpec.styles`; no element may consume ECharts' implicit series palette or derive a group color from current series order.

This contract covers points, line, bar, histogram, boxplot and outliers, smoother, fitline and confidence bands, heatmap, scatter3d, surface, contour3d, and 3D error visuals. Renderer-local group order remains valid for series and legend ordering only.

Ungrouped charts retain their existing neutral/default styling and do not allocate group slots.

## Lifecycle And Persistence

`groupThemeSlots` lives in `GraphBuilderItem`, so the existing Zustand store, Workspace save request, and opaque GraphDoc JSON archive carry it without backend changes. Store normalization validates optional loaded data and retains valid assignments. Old projects with no map initialize deterministically from the first complete group discovery and persist on the next mutable save.

The component-local `useRef` registry is removed. It cannot be an identity source because Graph Builder views are intentionally unmounted during navigation.

Reset Style clears explicit `groupStyles` only. It does not clear `groupThemeSlots`. Deleting a graph deletes its identities with the graph item.

## Error Handling

Malformed persisted slot maps never prevent a graph from loading. Invalid entries are discarded by normalization; duplicate slots are resolved deterministically while preserving the first valid assignment. New assignments use the lowest unused slot.

If frame data has not arrived, the previous persisted map remains unchanged. The default sentinel is never persisted as a grouped identity.

## Test Strategy

Pure tests verify allocation, malformed data repair, field namespaces, missing/reappearing groups, Value Order independence, and Palette mutation semantics.

Graph Builder/store tests verify persistence across item updates and save/load, read-only behavior, and that remounting derives the same complete styles.

Renderer tests assert concrete per-group colors across:

- points, line, bar, histogram, boxplot, smoother, fitline, and heatmap;
- scatter3d, surface, and contour3d;
- layer add/remove/reorder;
- a temporarily missing middle group;
- hidden/unhidden groups;
- sampled and aggregate-only frames;
- 2D/3D navigation-equivalent rebuilds.

Production verification runs the focused Node TypeScript tests and `npx vite build`. Existing unrelated TypeScript failures are reported separately rather than repaired in this issue.

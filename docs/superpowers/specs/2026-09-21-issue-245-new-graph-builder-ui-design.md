# Issue 245 New Graph Builder UI Refactor Design

**Date:** 2026-09-21

**Status:** Phase 1 manually accepted

**Issue:** https://github.com/ashton2914/StatsPlayground/issues/245

**Base and target:** latest `origin/dev` -> `dev`

## Goal

Refactor New Graph Builder to use the current Old Graph Builder layout and
frontend interaction model without coupling the native renderer to the Old
Graph Builder's ECharts runtime or state model.

The completed surface uses the same toolbar, draggable field palette, axis
slots, Layers area, canvas arrangement, Legend, and Style-panel structure as
Old Graph Builder. Existing New Graph Builder capabilities remain functional.
Capabilities that do not yet have a New Graph Builder implementation remain
visible as disabled placeholders with an explicit unavailable explanation.

## Current State

`GraphBuilderNewView` currently implements a separate form-style interface:

- select controls for X, Y, Overlay, X interpretation, and raw-series mode;
- a two-column field-controls/canvas layout;
- Layers and Overlay legend content rendered around the native canvas rather
  than through the Old Graph Builder panel structure.

New Graph Builder already supports:

- one persisted X field and one persisted Y field;
- scalar X values and numeric Y values in the native renderer;
- point, line, and points-plus-line raw modes;
- numeric, time, duration, category, and automatic X interpretation;
- Mean visibility;
- one Overlay field, deterministic Overlay groups, and group visibility;
- camera persistence;
- stale-source, missing-source, read-only, and save-state guards.

Old Graph Builder already provides the target interaction model:

- a draggable field palette;
- X, Y, Group X, and Group Y drop slots;
- a top toolbar;
- Layer cards and Add Layer;
- a canvas-centered axis-slot layout;
- a right-side Legend and Style inspector.

The mismatch exists because the two builders implement separate UI surfaces.

## Scope

### Included

- Extract store-agnostic UI primitives from the current Old Graph Builder
  presentation.
- Make Old and New Graph Builder consume the same core presentation primitives.
- Refactor New Graph Builder to the current Old Graph Builder desktop layout.
- Replace the New Graph Builder X/Y selects with single-value drag/drop slots.
- Permit any dataset column to bind to either X or Y.
- Persist a nonnumeric Y binding while withholding the unsupported native
  render request and presenting a specific unsupported-combination state.
- Move X interpretation into X-slot settings.
- Represent Points, Line, and Time Series through Layer cards while mapping
  back to the existing New Graph Builder state.
- Move Mean into the applicable Layer settings.
- Replace the Overlay select with an Overlay drop target in the Legend panel.
- Preserve Overlay group color, label, count, scrolling, and visibility
  behavior.
- Display unavailable controls in their Old Graph Builder locations as
  disabled placeholders with explanatory tooltips.
- Preserve all current missing/stale/read-only/save/error behavior.

### Deferred

- Multiple columns in one X or Y slot.
- A new persisted document version.
- Any native-renderer or IPC contract expansion.
- Native support for nonnumeric Y.
- Start Over and Swap X & Y behavior.
- Filter behavior.
- Pan/select tool selection and linked-cell selection.
- 3D and Multivariate modes.
- Sample mode.
- Group X and Group Y behavior.
- Style editing.
- Axis settings and the complete axis-display optimization program.
- Detailed point and line styling.
- Additional graph types.
- Changes to Old Graph Builder behavior.

## Product Decisions

### Source of Visual Truth

The current Old Graph Builder implementation is the source of truth. The issue
attachment communicates the overall target structure but does not override the
current Old Graph Builder's component behavior or theme conventions.

### Placeholder Behavior

An unavailable capability is visible but disabled. Its accessible name remains
available, and its title explains that the capability is not yet implemented
in New Graph Builder.

Unavailable controls do not:

- mutate New Graph Builder state;
- mark the project dirty;
- invoke the native backend;
- display a success-shaped fallback.

The following controls are placeholders in this issue:

- Start Over;
- Swap X & Y;
- Filter;
- pan and select tools;
- 3D and Multivariate;
- Sample;
- Group X and Group Y;
- Style;
- axis settings;
- unsupported Layer types;
- detailed point and line styling.

The 2D and Full controls display the current fixed state.

### X and Y Slots

Each slot stores one stable column ID. A drop replaces the previous binding.
The slot supports an explicit clear action.

All source columns are draggable to both slots. Field identity uses
`columnId`, never display name, so duplicate names remain distinct.

The UI distinguishes three states:

1. available and renderable binding;
2. available but unsupported binding, such as nonnumeric Y;
3. persisted binding whose column no longer exists.

State 2 is persisted and does not invoke the native backend. State 3 preserves
the persisted value and existing unavailable-field diagnostic without marking
the project dirty.

### Layers

Layer UI maps onto the existing New Graph Builder state:

- Points only -> `rawMode: "scatter"`;
- Line only -> `rawMode: "line"`;
- Points and Line -> `rawMode: "pointsLine"`.

At least one raw geometry remains active. Removing the last active geometry is
disabled rather than inventing an empty backend mode.

Time Series is an existing interpretation-plus-line capability, not a new
backend layer contract. Its card exposes the supported time/duration X
interpretation behavior and maps to the existing `xMode` and `rawMode`.

Mean moves into the applicable Layer settings and continues to use
`showMean`. Changing raw geometry or Mean preserves the camera. Changing X,
Y, or X interpretation retains the existing camera-reset rules.

Unsupported graph types appear in Add Layer but remain disabled.

### Legend and Overlay

Legend owns the Overlay drop target. Dropping a field calls the existing
Overlay store operation. Clearing or replacing Overlay continues to clear
hidden group identities while preserving the camera.

The current group list remains authoritative:

- backend-provided stable colors;
- localized missing-group label;
- exact counts;
- per-group visibility checkboxes;
- a maximum of 64 groups;
- bounded vertical scrolling.

Style appears beneath Legend using the Old Graph Builder section structure,
but all Style controls are disabled placeholders.

## Architecture

### Shared Presentation Primitives

Create focused, callback-driven components under the Graph Builder component
area:

- `GraphBuilderLayout` - toolbar, left rail, center, axis-slot tracks, and
  right rail;
- `GraphBuilderToolbar` - current mode and capability controls;
- `GraphFieldPalette` - ordered draggable columns and stable drag payloads;
- `GraphDropSlot` - bound/unbound/unavailable display, drop, clear, and
  disabled behavior;
- `GraphLayersPanel` - active Layer cards and Add Layer;
- `GraphInspectorPanel` - Legend and Style section structure.

These components receive typed props and callbacks. They do not:

- import either Graph Builder store;
- call application services;
- know whether the renderer is ECharts or native;
- decide persistence or dirty-state behavior.

### Old Graph Builder Adapter

Old Graph Builder maps its existing state and callbacks into the shared
presentation primitives. Extraction must preserve its current behavior,
including drag payloads, multi-column behavior, filters, modes, layers,
sampling, axis interactions, and inspector behavior.

This issue does not simplify or redesign Old Graph Builder runtime code.

### New Graph Builder Adapter

New Graph Builder maps:

- column descriptors into field-palette items;
- `xColumnId` and `yColumnId` into axis-slot bindings;
- `rawMode`, `xMode`, and `showMean` into Layer cards;
- `overlayColumnId` and Overlay groups into Legend;
- existing store operations into shared callbacks.

`GraphNewCanvas` and the native service pipeline remain independent children
of the center canvas host.

## Data Flow

### Field Drop

1. `GraphFieldPalette` writes a versioned internal drag payload containing the
   stable column ID.
2. `GraphDropSlot` validates and decodes the payload.
3. The New adapter resolves the ID against current column descriptors.
4. X or Y replacement calls the existing `setColumns` operation.
5. Store logic applies dirty-state and camera-reset behavior.
6. The render guard checks source validity and native type support.
7. A supported X/Y pair reaches `GraphNewCanvas`; an unsupported pair reaches
   the explicit unsupported state without an IPC request.

Malformed, stale, or unknown drag payloads are rejected visibly and do not
mutate state.

### Layer Change

1. The Layer panel emits the next active supported Layer set.
2. The New adapter maps that set to one existing `GraphNewRawMode`.
3. Time Series settings map to `GraphNewXMode`.
4. Mean maps to `setMean`.
5. Existing store and renderer behavior remains authoritative.

### Overlay Change

1. The Overlay drop target emits a stable column ID.
2. The New adapter calls `setOverlay`.
3. The next native request uses the existing Overlay contract.
4. Completion metadata populates the existing Legend group model.
5. Visibility changes call `setHiddenOverlayGroups` and retain the current
   camera and backend cache behavior.

## Layout and Styling

New Graph Builder adopts the current Old Graph Builder visual hierarchy:

- compact top toolbar;
- resizable-looking three-column shell using the current panel widths and
  section headers;
- ordered field palette above Layers in the left rail;
- Group X above the canvas;
- Y to the left of the canvas;
- Group Y to the right of the canvas;
- X below the canvas;
- Legend and Style in the right rail.

This issue does not add panel resizing behavior unless extraction can preserve
the existing Old Graph Builder primitive without adding New-specific state.
Static dimensions must still use the same CSS tokens and visual proportions.

Shared styles use the application's existing theme variables. New Graph
Builder removes its separate light-only visual vocabulary where the shared
Old Graph Builder tokens provide an equivalent. Native plot contents remain
subject to the native renderer's current theme limitation.

At narrow widths, rails remain bounded and the center canvas may shrink or
scroll according to the existing workspace layout. Controls must not overlap
the axis slots or native canvas.

## Error and Read-only Behavior

- Metadata loading has an explicit loading state.
- Metadata failure remains an alert and disables mutations.
- Missing and stale datasets retain their current localized states.
- Missing persisted fields remain visible and unchanged.
- Unsupported nonnumeric Y receives a separate localized status.
- Read-only/save state disables field drag, drops, clear actions, Layer
  changes, X interpretation, Mean, Overlay changes, and group visibility.
- Native render errors continue through the existing safe error mapping and
  never expose absolute paths.
- Placeholder controls are disabled by product scope, independently of
  read-only state.

## Localization and Accessibility

All newly visible labels and unavailable explanations use the existing i18n
system in English and Simplified Chinese, with parity for other maintained
locale files according to repository convention.

Shared controls retain semantic buttons, groups, labels, disabled state,
focus-visible treatment, and deterministic accessible names. Drag/drop is the
primary binding interaction in this issue; an accessible clear action and
readable binding state remain available. Keyboard-driven field assignment is
deferred unless the extracted Old Graph Builder primitive already supports it.

## Testing

### Shared UI Contracts

- drag payloads use stable column IDs;
- duplicate display names remain distinct;
- X/Y replacement and clear callbacks are correct;
- malformed and unknown drops do not mutate;
- disabled placeholders do not fire callbacks;
- Old and New Graph Builder render the shared core primitives.

### New Graph Builder Component Tests

- every available column can bind to X or Y;
- X and Y remain single-value slots;
- a nonnumeric Y persists but produces zero additional native render calls;
- missing persisted fields remain non-destructive;
- Points, Line, and combined geometry map to the exact existing `rawMode`;
- Time Series and X interpretation use the relocated controls;
- Mean uses the relocated Layer control and preserves camera behavior;
- Overlay uses the Legend drop target;
- Overlay visibility, missing labels, counts, and 64-group scrolling remain
  correct;
- read-only/save state disables every mutation;
- stale, missing, loading, and error behavior remains explicit;
- English and Simplified Chinese labels remain correct.

### Visual and Layout Tests

- desktop layout matches the current Old Graph Builder hierarchy;
- toolbar, field palette, Layers, axis slots, canvas, Legend, and Style occupy
  the intended regions;
- narrow layouts do not overlap canvas or slots;
- light and dark application theme variables remain readable;
- focused screenshots cover the primary desktop state and unsupported-Y
  state.

### Regression Gates

- complete affected New Graph Builder component suite;
- affected Old Graph Builder component and layout suites;
- TypeScript checks and Vite production build;
- `git diff --check`;
- Rust graph-new tests only if implementation changes a cross-boundary
  contract, which this design does not require.

## Acceptance Criteria

1. New Graph Builder visibly follows the current Old Graph Builder structure.
2. A user can drag any source column into X or Y, one column per slot.
3. Supported bindings render through the unchanged native pipeline.
4. Nonnumeric Y remains visibly bound and persisted while no native request is
   sent for that unsupported combination.
5. Points, Line, Time Series, X interpretation, and Mean remain usable through
   the Layer/slot UI.
6. Overlay is assigned through Legend and current group visibility behavior
   remains intact.
7. Every deferred control listed in this design is visible, disabled, and
   clearly explained.
8. Old Graph Builder behavior is unchanged.
9. Existing project persistence, camera, stale-source, error, and read-only
   contracts continue to pass.

## Implementation Boundary

This issue establishes a reusable presentation boundary. It must not become a
general rewrite of Old Graph Builder, a native renderer expansion, or a
multi-column schema migration. If extraction reveals that a proposed shared
component cannot remain store-agnostic without moving runtime behavior, keep
that behavior in the owning adapter and share only the smaller presentational
unit.

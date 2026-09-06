# Analysis Composition Primitives

## Goal

Build Analysis documents from a small reusable presentation vocabulary. A
module supplies live Rust results and arranges primitives; it does not create
its own frame, table, or graph styling.

## Component Model

### `AnalysisFrame`

`AnalysisFrame` is the only owner of framed hierarchy. It renders a title bar,
border, rounded corners, disclosure control, and a content body. Frames may be
nested to any practical depth. Each frame owns its expanded state, defaults to
expanded, and exposes accessible disclosure semantics.

### `AnalysisTable`

`AnalysisTable` composes `AnalysisFrame` with semantic columns and rows. It
owns table scrolling, named widths, numeric alignment, and tabular numerals.
One `AnalysisTable` always contains exactly one table and one title.

### `AnalysisGraph`

`AnalysisGraph` composes `AnalysisFrame` with `GraphRuntime`. It accepts the
same graph item, dataset, backend frame state, sizing, and interaction handlers
needed by `GraphRuntime`. This preserves GraphBuilder axis configuration,
point/line/area styling, zooming, selection, and other graph behavior. A render
override remains available for focused component tests.

### `AnalysisText`

`AnalysisText` is an unframed text leaf. It participates in layout without
creating a false hierarchy level.

### `AnalysisStack`

`AnalysisStack` arranges sibling nodes vertically or horizontally with shared
spacing. It does not add a title or border.

## Composition

The Sample Distribution Analysis becomes:

1. A root `AnalysisFrame` for the response.
2. An `AnalysisGraph` containing the overview and box-plot runtimes.
3. An `AnalysisText` summary.
4. A nested `AnalysisFrame` for Summary Statistical containing three
   `AnalysisTable` leaves.
5. A nested `AnalysisFrame` for Process Capabilities containing five
   `AnalysisTable` leaves.

The existing Rust execution response remains authoritative. This change does
not persist rendered output or alter the `.span` schema.

## Styling Contract

All frame variants share one title bar, border, `6px` radius, disclosure icon,
and clipping implementation. Nesting is expressed by DOM hierarchy and stack
spacing, not page-specific descendant CSS. Tables retain the existing compact,
standard, and wide width presets. Graph content fills the frame body without
introducing another decorative border.

## Migration Boundary

Only the Sample Distribution Analysis and Process Capability presentation are
migrated initially. Existing callers keep compatibility exports for the
statistical component names while the new Analysis primitives become the
canonical implementation.

## Verification

Component tests must prove recursive frame nesting, independent disclosure,
one table per table component, named widths, numeric alignment, GraphRuntime
property forwarding, Sample block order, and stale-result fencing. The Vite
production build must also pass.
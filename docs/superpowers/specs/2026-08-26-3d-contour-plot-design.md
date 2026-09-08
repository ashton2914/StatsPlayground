# 3D Contour Plot Design

## Goal

Add a first-class `contour3d` layer to Graph Builder. The layer draws true
constant-Z contour lines over the existing 3D surface, rotates and zooms with
the ECharts GL scene, and follows the same X, Y, Z, Overlay, hidden-group, and
theme-color behavior as the existing Surface layer.

## User Experience

- The 3D layer picker offers a Contour layer alongside Scatter and Surface.
- A newly added Contour layer defaults to mean aggregation, zero smoothing,
  and 10 contour levels.
- Its options panel exposes Statistic (Mean or Median), Smoothness (0 to 1),
  and Levels (3 to 20).
- Contour can be used with or without Surface. When both are enabled, lines
  sit just above the surface to avoid depth-buffer flicker.
- The existing empty-state guidance for missing X, Y, Z, or sufficient numeric
  grid data also applies to Contour.

## Architecture

Extend `ElementKind` and Graph Builder's 3D layer registry with `contour3d`.
The UI stores layer options in the existing `ChartElement.options` map, so no
project schema migration is required and older projects remain compatible.

Refactor the duplicated surface-grid builders in `threeD.ts` to return one
internal regular-grid representation containing sorted X/Y coordinates,
smoothed aggregate Z values, vertices, shape, and finite Z range. Surface and
Contour consume that same representation, ensuring that displayed contour
lines match the displayed surface exactly for both row-backed and frame-backed
data.

Generate contours with marching squares. Levels are evenly spaced strictly
inside the finite surface range, excluding the minimum and maximum. Missing
vertices invalidate only their adjacent cells, so lines never bridge holes.
Ambiguous saddle cells use a deterministic center-value test to select segment
pairing. Segments at each level are joined by quantized endpoints into maximal
continuous polylines; each connected polyline becomes one `line3D` series.
This preserves breaks at saddles and holes without creating one ECharts series
per grid cell. Contour series are silent and excluded from the surface gradient
`visualMap` indices.

Overlay groups build separate grids and contour lines using their assigned
theme color. Hidden groups produce no contour series, matching existing 3D
layers.

## Error Handling And Limits

Contour requires X, Y, and Z bindings and at least one complete finite grid
cell with a non-zero Z range. Invalid option values are clamped: smoothness to
0..1 and levels to integer 3..20. A flat surface renders no contour lines but
does not break other enabled 3D layers. Rendered contour Z values receive a
small offset equal to one millionth of the finite Z span; the level used for
geometry extraction and labels remains unchanged.

To keep option size predictable, contour extraction accepts at most 20,000
segments and emits at most 512 connected polylines per group, in ascending
level and deterministic grid order. Additional geometry is silently omitted;
the chart remains usable and all lower levels remain complete. Surface and
scatter behavior remain unchanged.

## Verification

- Unit tests verify level interpolation on a small regular grid.
- Unit tests verify missing cells are not crossed and flat grids emit no lines.
- `build3DOption` tests verify `line3D` contour output, configured level count,
  grouped colors, hidden groups, and coexistence with Surface.
- Run `node --experimental-strip-types tests/threeD.test.ts`.
- Run the focused contour test file.
- Run `npx vite build` to validate the frontend bundle.
- Visually verify in the running app that the surface, contour lines, layer
  controls, rotation, zoom, light theme, and dark theme render without overlap
  or blank canvas regressions.
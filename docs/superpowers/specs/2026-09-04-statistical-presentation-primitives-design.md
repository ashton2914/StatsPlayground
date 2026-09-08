# Statistical Presentation Primitives Design

## Goal

Provide one stable visual and semantic contract for framed statistical tables across all current and future analyses.

## Problem

The codebase currently shares cell styling through `sp-fit-y-by-x-report-table`, but does not share a complete table-frame component. Individual reports render different combinations of captions, details, headings, borders, and page-scoped CSS overrides. This allows the same conceptual table to acquire different borders and title behavior depending on its parent page.

## Design

Create reusable components under `src/components/statistical/`:

- `StatisticalSection`: an optional collapsible outer analysis frame.
- `StatisticalTableFrame`: exactly one integrated title bar and one table.
- `StatisticalTable`: columns, rows, numeric alignment, and width presets.

Each `StatisticalTableFrame` owns its title, border, background, overflow, and width. Consumers provide only semantic table models. A shared title may group frames at the `StatisticalSection` level, but it must never visually merge two tables into one table frame.

## Data Flow

Rust remains the sole authority for computed values. Analysis adapters map backend response values into `StatisticalTableModel`; the shared components only format and render those values. No computed result is persisted in `.span` files.

## Styling Contract

- One table frame contains exactly one table.
- The title bar and table body share one outer border.
- Width uses named presets (`compact`, `standard`, `wide`) and never stretches to viewport width.
- Numeric columns are right aligned with tabular numerals.
- Consumers must not use descendant CSS selectors to restyle shared table internals.
- Right-side whitespace is valid and expected.

## Migration

Migrate Analysis Quantiles, Location, Variation, and all Process Capability tables first. Convert `ProcessCapabilityReport` into model construction plus shared primitives so Distribution and Analysis receive identical table rendering.

## Verification

Component tests assert one title per table frame, stable width presets, and identical primitives for summary and capability output. Existing backend and archive contracts remain unchanged.
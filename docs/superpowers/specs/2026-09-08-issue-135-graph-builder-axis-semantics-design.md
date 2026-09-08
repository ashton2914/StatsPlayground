# Issue 135: Graph Builder Axis Semantics

## Problem

Graph Builder currently treats one continuous column dropped on X as a direct
`encoding.x` value axis, but treats two or more continuous columns dropped on X
as `multiX` data that is melted into column-label categories and values. This
single-versus-multiple threshold gives the same user action two different
meanings and allows the histogram, normal curve, and box plot combination to
split into separate grids.

## Invariant

For interactive two-dimensional Graph Builder charts:

- Y represents measured variable values.
- X represents attributes that identify or group those values.
- Dropping one or more continuous columns on X uses the column labels as X
  attributes and the cell values as Y variables.
- One-column and multi-column X drops follow the same pipeline. They differ only
  in the number of X attribute labels.
- A distribution layer combination must not create a second plot solely because
  one continuous column was dropped on X.

A categorical or ordinal column dropped on X remains a direct X attribute. A
continuous column dropped directly on Y remains a direct Y variable.

## Canonical State

A continuous-column drop on X is stored in `modeStates.twoD.multiX`, including a
single-column list. It is not collapsed into `encoding.x`.

At runtime, any non-empty `multiX` list is melted to:

- `__sp_variable__`: nominal X attribute containing column labels.
- `__sp_value__`: continuous Y variable containing cell values.

`multiY` remains readable for saved projects and Analysis embedded graphs. This
change does not migrate Analysis graph definitions or remove the compatibility
format.

## Data Flow

1. The drop router sends every numeric X drop, whether one or many fields, to the
   same `setMultiAtSlot("x", fields)` operation.
2. State normalization preserves a one-element `multiX` list.
3. Request derivation emits `multiX0` starting at one selected column and treats
   that request as executable.
4. Runtime model derivation activates X melt starting at one selected column.
5. The renderer receives nominal X attributes plus continuous Y values, so the
   distribution and box-plot layers share one chart coordinate system.

## Compatibility And Migration

- Existing categorical X plus continuous Y charts keep their direct encodings.
- Existing multi-column X charts keep their current behavior.
- Existing `multiY` Analysis and saved-project contracts remain supported.
- A legacy interactive item with one continuous `encoding.x`, no `encoding.y`,
  and an enabled distribution layer is normalized to one-element `multiX`. This
  migration is limited to the unambiguous value-only distribution shape so a
  deliberate continuous X chart is not silently reinterpreted.
- Normalization remains idempotent after migration.

## Testing

Automated coverage will prove:

- One and multiple continuous X columns derive the same request roles and the
  same runtime X-attribute/Y-value encoding.
- One-element `multiX` survives normalization and is executable.
- Legacy single-continuous-X distribution state migrates once and remains
  idempotent.
- Categorical X plus variable Y behavior is unchanged.
- Existing multi-column X and Analysis `multiY` contracts remain unchanged.
- Histogram, normal curve, and box plot no longer enter the continuous-X-only
  split-grid branch for the interactive X-drop path.

Validation includes focused mode, request, runtime, transform, and Analysis
contracts; TypeScript/Vite production build; diagnostics; `git diff --check`;
and manual desktop acceptance reproducing Issue 135.

# Distribution Table Specification Source Design

## Goal

Make Table column properties the only authoritative source of Distribution
specification limits. Distribution creation and editing no longer accept
analysis-level LSL, Target, or USL values.

When selected response columns do not have a valid LSL or USL, Save identifies
those columns and lets the user open the source Table's column-property manager,
continue without Process Capability for those responses, or cancel.

## Product Decisions

1. A finite LSL or USL enables Process Capability. Target alone does not.
2. Specification limits are read independently for each response from
   `ColumnDisplayProps.extras.spec`.
3. Continuing without limits saves and runs the Distribution analysis. The
   affected response receives the normal Distribution report without a Process
   Capability block.
4. Existing analysis-level overrides are not copied into shared Table
   properties.
5. Legacy projects remain readable, but their persisted analysis-level
   `specLimits` values are ignored and normalized to an empty compatibility
   object when loaded.

## User Flow

### Create Or Edit Distribution

Workspace loads the source dataset's columns and display properties together.
The Distribution dialog receives column metadata including each column index and
its current extras. The dialog contains role assignment and analysis options but
no specification editor.

### Save With Complete Specifications

If every selected response has a finite LSL or USL in its Table column
properties, Save follows the existing create or update path without an
additional prompt.

### Save With Missing Specifications

If one or more selected responses lack a finite LSL and USL, Save opens a
warning dialog listing only those response names. The warning offers:

- **Manage Column Properties**: cancel the pending save, close the Distribution
  dialog, activate its source Table, and open the property manager with the
  missing response columns and the Specification kind preselected.
- **Continue Without Capability**: save the analysis immediately. Responses
  without valid limits omit Process Capability.
- **Cancel**: close the warning and return to the unchanged Distribution dialog.

After managing Table properties, the user reopens the Distribution editor. This
avoids keeping a stale, hidden pending analysis draft while shared Table state is
being changed elsewhere.

## Component Boundaries

### Distribution Field Metadata

`DistributionFieldInfo` gains the source column index and optional extras. A
small pure helper classifies a response as capability-ready when
`extras.spec.lsl` or `extras.spec.usl` is a finite number. The same helper
returns missing response names for Save validation.

The helper is a UI workflow check, not a statistical implementation. Rust
remains authoritative and validates the current Table properties again during
execution.

### Distribution Dialog

`DistributionDialog` removes `SpecificationLimitsEditor`. It owns the missing
specification warning because it owns the unsaved role assignments and Save
decision. A new callback reports a request to manage properties for a dataset
and a set of source column indices.

Continuing creates a definition whose compatibility `analysis.specLimits` value
is always empty. Editing a legacy analysis therefore cannot re-submit an old
override.

### Workspace Navigation

Workspace loads `getColumns()` and `getColumnDisplayProps()` in parallel for
both create and edit flows. It maps display properties by `colIndex` into
`DistributionFieldInfo`.

When the dialog requests property management, Workspace stores a one-shot
request, closes the Distribution dialog, and activates the source dataset. The
request is scoped by dataset ID so it cannot open on a different Table.

### DataTableView And ManageExtrasDialog

`DataTableView` accepts an optional one-shot property-manager request containing
selected column indices and the requested extra kind. After the matching
dataset is mounted and its display properties are loaded, it opens
`ManageExtrasDialog` once and acknowledges the request.

`ManageExtrasDialog` accepts optional initial selected column indices and extra
kinds. Existing menu launches keep their current all-column and detected-kind
defaults.

## Persistence And Compatibility

The current Analysis schema requires `analysis.specLimits`. Removing it in
place would reject existing archives and widen the change into a document-schema
version migration. This change therefore retains the field as a compatibility
container with these rules:

- New Distribution definitions persist `specLimits: {}`.
- Loading or adapting a legacy definition normalizes any stored values to `{}`.
- Runtime request construction always sends an empty legacy `specLimits` map,
  so no `analysisOverride` envelope is generated.
- Analysis summaries no longer present analysis-level specification values.
- Archive validation continues accepting the existing field shape so old
  projects can be opened before frontend normalization.

A later Analysis document-schema version may remove the compatibility field
after every archive producer and consumer has an explicit migration.

## Backend Behavior

The existing Distribution service already reads `extras.spec` independently for
each response and appends `processCapability` only when valid limits resolve.
No new frontend statistical fallback is introduced.

The legacy wire override path remains structurally compatible but receives an
empty map from the Analysis frontend. Removing the backend wire field is outside
this change because workflow and archive consumers still reference it.

## Error Handling

- Failure to load column display properties blocks opening the Distribution
  dialog and reports a localized load error. Treating a failed read as "no
  specifications" would be misleading.
- Unknown or stale response names remain governed by existing role validation.
- Non-number, `NaN`, and infinite extras do not satisfy the Save check. Rust
  remains responsible for reporting invalid Table specification combinations.
- A property-manager request for a dataset that is no longer available is
  discarded when normal Workspace selection cannot resolve that dataset.

## Testing

### Pure Contracts

- Detect finite one-sided and two-sided Table specifications.
- Treat missing specs, Target-only, strings, `NaN`, and infinities as missing.
- Normalize legacy analysis-level overrides to an empty compatibility object.
- Build Distribution runtime requests without overrides.

### Component Tests

- The Distribution dialog contains no specification inputs.
- Save with missing specs lists all and only missing response names.
- Cancel returns to the draft without submitting.
- Continue submits once with empty compatibility overrides.
- Manage Column Properties reports the source dataset and missing column
  indices without submitting.
- A complete set of response specifications saves without a warning.
- The property manager opens with the requested columns and Specification kind
  selected while ordinary Table-menu launches retain existing defaults.

### Integration Tests

- Workspace loads columns and display properties for Distribution create/edit.
- The manage-properties action activates the correct source Table and consumes
  the one-shot request once.
- A two-response Rust execution where only one column has valid Table
  specifications produces Process Capability only for that response.
- Existing archive fixtures with legacy overrides open and normalize without
  modifying Table properties.

### Required Gates

- Focused Distribution contract and component tests during TDD.
- `npm run test:distribution`
- `npm run test:analysis`
- Focused Rust Distribution tests and the Analysis archive contract test.
- `npm run build`
- Desktop and narrow-width visual acceptance of the warning and property-manager
  handoff.

## Out Of Scope

- Automatically copying analysis overrides into Table properties.
- Preserving legacy override behavior after project load.
- Removing the legacy wire/archive field without a document-schema migration.
- Changing Process Capability formulas or report presentation.
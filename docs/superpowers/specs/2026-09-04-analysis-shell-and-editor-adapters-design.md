# Analysis Shell and Editor Adapters

## Goal

Give every current and future Analysis document the same page structure and
configuration-editing lifecycle. Analysis kinds provide configuration-specific
content through adapters; they do not implement their own workspace shell.

## Analysis Shell

`AnalysisShell` owns the complete page layout:

- a fixed-width information rail;
- the Analysis document name in the rail's top gray title bar;
- the source name immediately below the title;
- a list of the configuration values committed by the selector;
- one `Edit Inputs` command that reopens the selector;
- a scrollable result region containing the reusable Analysis composition
  primitives.

The shell accepts semantic summary entries instead of Analysis-kind-specific
objects. It is therefore independent of Distribution, future model fitting,
and other analysis definitions. Read-only documents and documents with a
missing source disable `Edit Inputs`.

## Type Adapters

Each Analysis kind owns an adapter with two responsibilities:

1. Convert its persisted definition into semantic summary entries for the
   shell.
2. Convert between its persisted `.span` definition and the value edited by
   its selector.

The first adapter is `DistributionAnalysisAdapter`. It reuses the existing
`DistributionDialog`, initializes it from the active `AnalysisDocument`, and
maps a successful submission back to an `AnalysisDocumentPatch`. The adapter
does not calculate statistics.

Future Analysis kinds extend the adapter dispatch point rather than branching
inside `AnalysisShell` or duplicating page layout.

## Editing Lifecycle

Workspace owns the editor session because it owns project mutation and modal
coordination. Clicking `Edit Inputs` identifies the active Analysis document,
loads selector metadata, and opens the matching adapter editor.

- Cancel closes the editor without mutating the document or rerunning it.
- Save preserves document ID, name, creation time, and folder assignment.
- Save atomically replaces the definition, sets `updatedAt`, and increments
  `configRevision` by exactly one.
- The existing execution fence observes the revision and recomputes live Rust
  results.
- A source deleted while an editor is open closes the editor without applying
  a change.

## Sample Distribution Layout

The Sample becomes the first consumer. Its rail title is `DIM1 Analysis`.
Below it, the shell displays Source, Analysis, Response, Fit, specification
limits, confidence level, and row count. The right result composition remains
the Frame/Table/Graph/Text tree already implemented.

## Extension Contract

Cross-analysis features belong in `AnalysisShell` or the common editor host.
Examples include run status, export commands, timestamps, warnings, and
toolbar actions. Adding one there makes it available to every registered
Analysis kind without changing each result renderer.

## Verification

Component tests cover shell title placement, semantic summaries, disabled
editing, and edit callback behavior. Adapter tests cover round-trip mapping,
identity preservation, and revision increment. Workspace tests cover opening,
Cancel, Save, and source-missing behavior. Existing Analysis execution,
Distribution, presentation primitive, and production build checks remain
green.
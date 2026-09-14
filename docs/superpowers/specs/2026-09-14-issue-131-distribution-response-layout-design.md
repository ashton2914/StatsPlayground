# Issue 131 Distribution Response Layout Design

## Context

Issue 131 requires Distribution Analysis output to preserve one coherent visual
boundary for each response. The current Analysis renderer joins all response
names into one document title, renders one multi-response composite graph,
summarizes only the first response, and then renders report content under a
separate group-first tree. Graph, text, and report content therefore disagree
about which response they belong to.

The Rust response already contains complete per-group, per-response report
results in `groups[].yResults[]`. Graph aggregate packets also carry response
identity in `sourceColumn` and group identity in their group/category fields.
The statistical payload does not need to change.

## Goals

- Render every response as an independent report subtree.
- Without By columns, begin directly with the response nodes.
- With By columns, render each generated group as the outermost node, followed
  by the complete response-first tree inside that group.
- Render one Distribution graph per group and response combination.
- Ensure each graph contains only packets for its current group and response.
- Keep Quantiles, Location, Variation, Continuous Fit, and Process Capability
  values attached to the matching group and response.
- Preserve Rust as the statistical authority and keep existing persisted
  Analysis definitions and graph presentation settings compatible.

## Non-goals

- Changing Distribution statistics, fitting, capability calculations, or
  backend report block generation.
- Changing the Analysis document schema or `.spprj` archive contract.
- Adding new Distribution sections, diagnostics, or graph types.
- Redesigning other Analysis kinds or the legacy Distribution workspace.
- Reproducing third-party visual styling.

## Required Hierarchy

Without By columns:

```text
Response
├─ Distribution
├─ Overall
│  ├─ Quantiles
│  ├─ Location
│  └─ Variation
├─ Continuous Fit
│  ├─ Parameter Estimates
│  └─ Measures
└─ Process Capability
   ├─ Specification
   ├─ Process Summary
   ├─ Within Capability
   ├─ Overall Capability
   └─ Nonconformance
```

With By columns:

```text
By Group
└─ Response
   ├─ Distribution
   ├─ Overall
   │  ├─ Quantiles
   │  ├─ Location
   │  └─ Variation
   ├─ Continuous Fit
   │  ├─ Parameter Estimates
   │  └─ Measures
   └─ Process Capability
      ├─ Specification
      ├─ Process Summary
      ├─ Within Capability
      ├─ Overall Capability
      └─ Nonconformance
```

When By is configured, preserve the backend group order. The all-data Overall
group remains first, followed by each By value group, including Missing when
present. `Overall` at the group level means all rows; `Overall` inside a
response is the summary section containing Quantiles, Location, and Variation.

## Presentation Architecture

`DistributionAnalysisResults` remains the Analysis-kind renderer and continues
to own execution state, graph presentation updates, and the shared
`AnalysisShell`. It stops creating one response-name document frame and one
global Statistical Report frame.

Introduce a focused response-tree presentation component that consumes the
successful `DistributionReportResponse`, persisted graph definitions, dataset,
and graph renderer. It performs presentation-only grouping:

1. Determine whether By is configured from the Analysis definition.
2. Iterate `groups` in backend order when By is configured; otherwise render
   the single ungrouped result without an extra group frame.
3. Iterate each group's `yResults` in response-definition order.
4. Render one response frame containing its graph and report sections.

All visible report structures continue to use `AnalysisFrame`, `AnalysisStack`,
`AnalysisText`, `AnalysisTable`, and `AnalysisGraph`. No legacy report/view
surface or raw table markup is introduced.

## Graph Isolation

Extend the Distribution graph adapter with a pure function that returns the
composite overview frame for one response and one group. The filter operates on
typed aggregate packets:

- histogram bins: retain entries whose `sourceColumn` matches the response and
  whose group/category identity matches the current group;
- box plot entries: apply the same response and group filter;
- fitted curves: retain packets whose `sourceColumn` matches the response and
  whose group/category identity matches the current group;
- discard packets that become empty after filtering.

The per-response Graph Builder configuration receives exactly one response in
`multiX`. It retains the persisted overview/box-plot options and axis settings.
The adapter then applies the existing composite category normalization to the
filtered frame. React does not recompute bins, quartiles, fits, or capability
values.

The graph key and embedded item ID include both stable response column ID and a
stable group identity so React and ECharts do not reuse state across adjacent
subtrees. Display names are never used as the sole identity because duplicate
labels are legal.

## Report Sections

For each `DistributionYResult`:

- `Distribution` contains the isolated composite graph.
- `Overall` contains Quantiles followed by Location and Variation.
- Each Continuous Fit block is rendered under the response's `Continuous Fit`
  section. Multiple fitted distributions remain individually expandable and
  retain the existing Parameter Estimates and Measures tables.
- Process Capability is rendered once when the response has a capability block
  and retains Specification, Process Summary, Within Capability, Overall
  Capability, and Nonconformance.
- Unsupported or unavailable blocks retain their existing localized reason
  text within the matching response subtree.

The current first-response-only prose summary is removed. Its values already
exist in the response's Overall tables, and retaining it would duplicate data
while continuing to privilege one response.

## Loading And Error States

Before execution succeeds, the renderer keeps one document-level loading,
source-missing, unsupported-presentation, or execution-error state. It does not
create speculative response/group frames without results. After success, an
empty group or response produces the existing unavailable text inside the
nearest known frame rather than borrowing another response's content.

## Axis Presentation State

Axis dialog edits remain presentation-only and do not increment the Analysis
`configRevision`. All response graphs derive from the same persisted overview
and box-plot definitions, matching the current document schema. An axis update
therefore continues to apply to every response graph in the Analysis; only the
rendered data packets differ by response and group.

## Testing

Development follows red-green-refactor.

### Pure adapter tests

- Build a graph response containing at least two responses and two groups.
- Assert the filtered composite frame contains only the selected response and
  group across histogram, fitted-curve, and box-plot packets.
- Assert the source frame is not mutated.
- Assert a missing response/group returns a valid empty frame rather than data
  from another subtree.

### Component structure tests

- Mount a successful Analysis response with `301A-F01`, `301A-F02`, and
  `301A-F03` and no By column.
- Assert the top-level result frames are the three responses in definition
  order, without a comma-joined response title or global Statistical Report
  wrapper.
- Assert every response owns one Distribution graph, one Overall section, its
  Continuous Fit blocks, and its Process Capability block.
- Assert each rendered graph receives only its response's aggregate packets.
- Mount a By response with Overall, two By values, and Missing; assert those
  groups are outermost and each contains the complete response sequence.
- Assert the first-response-only prose summary is absent.

### Visual acceptance

- Capture desktop and narrow-width component screenshots with three responses.
- Verify headings, expand controls, tables, and graphs remain inside their
  owning group/response frames with no overlap or clipped text.
- Verify collapsing one response or By group does not resize or replace a
  sibling graph.

### Required regression gates

- Run the focused Distribution Analysis component suite.
- Run Distribution graph adapter and report wiring tests.
- Run the frontend production build.
- Run the repository Analysis gate because the renderer uses shared Analysis
  primitives and execution state.

## Acceptance Criteria

- The visible hierarchy exactly follows `By Group → Response → Distribution /
  Overall / Continuous Fit / Process Capability` when By is configured.
- Without By, Response is the outermost visible result node.
- No Distribution graph combines multiple responses or multiple By groups.
- No summary, fit, capability table, warning, or unavailable reason appears
  under the wrong response or group.
- Existing projects open without migration and retain graph axis presentation
  settings.
- Focused tests, the Analysis gate, and the frontend production build pass.
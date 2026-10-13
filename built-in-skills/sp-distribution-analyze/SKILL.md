---
name: sp-distribution-analyze
description: Use when a user requests distribution analysis, descriptive statistics, missing-value assessment, distribution fitting, normality diagnostics, specification coverage, or an interpreted distribution report using the sp-mcp server and their supplied or existing data.
---

# Analyze a distribution and write its report

Use `sp-mcp` with the actual compatibility tool identifiers `statsplayground_*`. Read the sp-mcp-guide reference for unfamiliar contracts. The workflow below uses **user data**. Never generate a substitute dataset to satisfy a missing-file request. Illustrative examples in the guide are contract fixtures; generated data is permitted only when the user separately explicitly requests testing.

## Establish the source and question

1. Call `statsplayground_project_inspect({"includeCapabilities":true})` and `statsplayground_table_list({"limit":50})`. Follow pagination when needed. A table listed in the project is not automatically the user's uploaded file.
2. If the requested CSV has not been supplied and no table is chosen, ask the user to attach it or select a listed table. Stop data-dependent work; do not claim that an upload was received.
3. For an available supplied CSV, parse it using external file tooling with CSV-aware quoting/encoding handling. Preserve headers, row counts, missing values and categorical labels. Check delimiter, numeric parsing and malformed rows. Create a managed table with `statsplayground_table_create` using `request.name`, `request.columns` (`name`, `sqlType`) and `request.rows` arrays. Missing values are JSON null; do not silently coerce bad text to zero. There is no CSV-import path parameter. For large files, use the app's import flow rather than flooding a tool call with rows. Re-list/describe the imported table.
4. Call `statsplayground_table_describe({"datasetId":"<observed ID>","preview":{"limit":20}})`. Choose the requested response(s), using returned names and measurement types. Ask when several plausible columns exist. Numeric identifiers are not automatically measurements. Determine grouping, weights, frequencies and subgroup roles from the user/context; leave absent roles null and `by` empty. Do not invent specifications, weights or subgroup labels.
5. Record the source ID/name/generation, responses, missing-data treatment and any units the user provided. Preview rows are for schema inspection, not a replacement for full-data analysis.

## Create and run

For a selected continuous `Length` response, adapt this shape to observed data:

```json
{
  "analysisKind": "distribution",
  "sourceDatasetId": "<observed dataset ID>",
  "draft": {
    "name": "Length distribution",
    "responses": [{"name":"Length","type":"continuous"}],
    "weight": null,
    "frequency": null,
    "by": [],
    "nestedSubgroup": null,
    "analysis": {
      "confidenceLevel": 0.95,
      "specLimits": {},
      "fitDistributions": ["normal"],
      "fitAll": false
    }
  }
}
```

Pass it to `statsplayground_analysis_create`. Roles are FieldRef objects, not strings. `columnId` is optional; do not invent it from a preview index. Choose fits to answer the question: supported candidates are normal, cauchy, lognormal, exponential, gamma and weibull. Explicit `fitAll:true` asks for all eligible candidates; eligibility/failure is reported, not guaranteed. `fitDistributions:[]` with `fitAll:false` avoids requested fits. Nominal/ordinal responses need appropriate measurement types and interpretation; continuous fit conclusions must not be applied to categorical outputs.

Preserve `data.item.id`, `configRevision` and the full definition. Creation stores configuration and is not numerical execution. Call:

```json
{"analysisId":"<returned analysis ID>"}
```

with `statsplayground_analysis_run`. Read `data.item`, `data.definition`, `data.dataset`, and `data.state`. Require `data.state.status == "success"` before interpreting `data.state.result`. Also verify its analysis/source/config identity matches the requested analysis. A non-error MCP envelope may contain `state.status:"error"` and an `error` string; do not write successful conclusions from it. Honor warnings and domain block statuses.

## Read the actual statistical result

The result is a nested report, not `data.mean` or a flat `statistics` object. Inspect `data.state.result` as returned. The distribution response contains `datasetId`, `generation`, `groups`, `reportBlocks` and `graphFrames`. Verify source generation and distinguish per-group/per-response results from overall blocks.

- `groups[]` contains typed `groupKey` values, optional `groupNames`, and `yResults[]`. A response includes `yColumn`, `yName`, optional `sourceRows`/`processedRows`, `quantiles[]` (`probability`, `value`) and `blocks[]`.
- Blocks carry `blockId`, `kind`, `titleKey`, `status`, `reasonCode` and nullable `chartData`; optional payloads include `summaryData`, `capabilityData`, `distributionFitData` and `distributionFitComparisonData`. Use payload fields, not localized title strings, to identify evidence. `available`, `unavailable` and `failed` are distinct. Unavailable/null values are not zero.
- `summaryData` includes `n`, `nMissing`, `mean`, `stdDev`, `stdError`, `meanCiLower`, `meanCiUpper`, `minimum`, `maximum`, `median`, `primaryMode`, `modeIsUnique`, `range`, `iqr`, `mad`, and optional `confidenceLevel`. Several values may be null. Report the returned counts and units; do not infer raw observation counts from weighted/frequency results without inspecting processed/source counts and actual request.
- Quantiles use probabilities (for example 0.25, 0.5, 0.75), not percentage keys. Use actual returned probabilities. Do not invent quartiles or outlier counts from the chart's appearance.
- `graphFrames` contains `overview`, `boxPlot`, `ecdf`, `normalQuantile`. Chart evidence supports shape, tails, unusual observations and visual fit assessment. Only describe evidence present in returned/chart data; a configured graph does not itself establish skewness, multimodality or an outlier count.
- A fit payload includes `distributionId`, `status`, `reasonCode`, `parameters[]`, `effectiveN`, `estimatedParameterCount`, `logLikelihood`, `aic`, `aicc`, `bic`, `goodnessOfFit[]`, `diagnostics[]`, `convergence`, `provenance`, `warnings`, and optional `fittedCurve`. Parameter entries contain `parameterId`, `estimate`, `standardError`, `lowerConfidence`, `upperConfidence`; these and fit metrics are typed values carrying `state`, nullable `value` and `reasonCode`. Goodness-of-fit entries contain `testId`, `statistic`, `pValue`, `status`, `reasonCode`. Check availability and convergence before comparing values.
- Fit comparison contains `candidateRegistryIds` and `rows[]` with `distributionId`, `status`, `reasonCode`, `aic`, `aicc`, `bic`. Compare available metrics on comparable observations; smaller information criteria indicate relative support among fitted candidates, not proof of the true distribution. State tested candidates and failures. A nonsignificant goodness-of-fit test is not proof of normality; use the actual test and diagnostic evidence.
- Capability requires actual supplied or persisted specifications. `capabilityData.specification` contains `lsl`, `target`, `usl`, `source`; `processSummary` contains `n`, `mean`, `movingRangeAverage`, `withinSigma`, `overallSigma`, `stabilityIndex`. `indices` contains `cp`, `cpk`, `cpl`, `cpu`, `cpmWithin`, `pp`, `ppk`, `ppl`, `ppu`, `cpmOverall`, all typed values. `intervals` contains typed bounds and method/provenance; `nonconformance` distinguishes observed from expectedWithin/expectedOverall tails. Check typed states (available/notApplicable/unavailable/unbounded), reason codes and warnings. Report observed versus model-based rates separately. Do not claim process stability or reliable capability from a distribution alone.

If results are missing, failed or unsupported, explain the exact unavailable conclusion and resolve the cause using reported evidence. Do not replace missing results with invented statistics. If the source/configuration changes, rerun before reporting current results.

## Write, verify and persist the report

Construct Markdown with: source and variable(s); analysis settings/grouping; available counts and descriptive results; evidence-based shape/fit interpretation; specifications/capability only when applicable; missingness, unavailable outputs and practical limitations; proportionate next action. Attribute numbers to returned result fields and distinguish observation from interpretation. Do not paste a raw tool response as the report.

Choose the report destination from the user's request. For a requested existing report, discover its ID with `statsplayground_document_list` and read it with `statsplayground_document_get`. Preserve unrelated Markdown and reconcile the new interpretation with existing content. Use a document revision actually observed from a prior create/update response, or from a conflict's `details.actual` after rereading and reconciling. If none is available, explain that this MCP catalog cannot read the current report revision and ask how to proceed; do not invent a revision or create a duplicate report as a workaround.

When the request calls for a new report, call `statsplayground_report_create({})`. It creates a blank report; no title/markdown arguments are supported. Preserve `data.item.id` and `data.documentRevision`. Then call `statsplayground_report_update` with the chosen `reportId`, the observed `expectedDocumentRevision`, and the complete `markdown`.

A live analysis embed must be an exact standalone line outside a code fence:

```text
{{sp-embed kind="distribution" id="<returned analysis ID>"}}
```

Use the actual analysis ID, not the dataset ID. Add the interpretation around the embed; later analysis changes require revising static conclusions too. Read back using `statsplayground_document_get({"kind":"report","id":"<report ID>"})` and verify `data.document.markdown`, source references and embed ID. Report creation/update does not export PDF or rename the allocated report.

If `project.hasProjectPath` is true, call `statsplayground_project_save({})` and check success. The MCP save contract accepts no `filePath`. On `project_path_required`, establish a destination through the UI or explain that the report is created in the current project but not yet saved to disk. Never claim persistence after an unsuccessful save.

## Revisions and recovery

- Update distribution configuration with `statsplayground_analysis_update`: required `analysisKind:"distribution"`, `analysisId`, `expectedConfigRevision`, and **complete** draft containing responses, weight, frequency, by, nestedSubgroup, analysis and graphs. Read the current analysis using document.get; copy `definition` without its `kind` field. Preserve its four graph configurations. Creation's optional graphs become mandatory in the update contract. Rerun and update report conclusions after changing fits, roles, grouping or specifications.
- Use the report revision returned by the last create/update call. `document.get` returns Markdown but **no report document revision**. After `revision_conflict`, read current Markdown, reconcile user edits, and use `details.actual` only if the error actually supplies it. If no current revision is available, explain the API limitation; do not guess or use projectRevision instead.
- Optional top-level `control.expectedProjectRevision` protects against changes to the whole project; it is separate from config/document revisions. Preserve current response revisions; dependent mutations run sequentially. An idempotency key identifies one logical write and must remain stable for an uncertain retry with identical arguments.
- On timeout/cancellation, inspect existing documents before recreating analysis/report objects. Correct invalid_input, rediscover not_found IDs and follow reason codes; never blindly retry permanent errors or fabricate confirmation flags. No CSV-import, report-export, general result-polling or graph/report revision-read tool exists in this catalog.

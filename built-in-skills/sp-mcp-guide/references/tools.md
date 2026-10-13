# Complete sp-mcp tool reference

All 22 advertised tools are listed here. Actual compatibility identifiers remain `statsplayground_*`. Arguments below are schema examples with illustrative IDs and data: replace them with observed IDs and user data. They are not preconditions satisfied by the examples. The server tools/list schema is authoritative when versions differ.

## Shared contracts

Every success envelope has `requestId`, `command`, `changed`, `projectRevision`, `data`, `warnings` (`code`, `message`). Do not mistake `changed=false` for failure. Domain execution status still needs checking. Every tool accepts optional top-level `control: {"expectedProjectRevision": 7, "idempotencyKey": "unique-logical-operation"}`. IDs and revisions in examples are illustrative. Unknown fields are generally rejected. Nullables are explicitly shown in complete replacement examples; optional fields may be omitted. Schema acceptance does not imply valid source bindings or statistical applicability.

The JSON fixtures in examples.json cover every catalog tool and can be deserialized by the server input validator. Use each tool section for runtime prerequisites.

## statsplayground_project_inspect

Inspect the current project. Read-only.

**Arguments:** [ProjectInspectToolInput](#projectinspecttoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Read current project first; includeCapabilities is optional.

```json
{
  "includeCapabilities": true
}
```

**Output:** data.project (nullable), dirty, readOnly, projectRevision, counts, optional capabilities. A capability map is not a substitute for tools/list. Full data contract: [ProjectInspectToolOutput](#projectinspecttooloutput).

**Errors and limits:** No project may be open; inspect does not open one.

## statsplayground_table_list

List project tables. Read-only.

**Arguments:** [TableListToolInput](#tablelisttoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** List known sources; optional cursor and limit. Follow returned nextCursor until null when searching all tables.

```json
{
  "limit": 50
}
```

**Output:** data.items: IDs, names, sourceType, rowCount, colCount, generation, timestamps and nullable sourceName; nextCursor. Full data contract: [TableListToolOutput](#tablelisttooloutput).

**Errors and limits:** Invalid cursors/limits require correction.

## statsplayground_table_describe

Describe one table. Read-only.

**Arguments:** [TableDescribeToolInput](#tabledescribetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Use a returned datasetId. Optional preview requires limit and optionally offset; preview is a sample, not statistical evidence.

```json
{
  "datasetId": "dataset-1",
  "preview": {
    "offset": 0,
    "limit": 20
  }
}
```

**Output:** data.dataset, generation, columns (colIndex, colName, colType and display properties), optional preview with totalRows and indexed cells. Full data contract: [TableDescribeToolOutput](#tabledescribetooloutput).

**Errors and limits:** not_found means rediscover the table; use returned names for FieldRef.

## statsplayground_document_list

List project documents. Read-only.

**Arguments:** [DocumentListToolInput](#documentlisttoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Optional kind filters tableTransform, graph, analysis, tabulate or report. Optional cursor and limit paginate.

```json
{
  "kind": "analysis",
  "limit": 50
}
```

**Output:** data.items: kind, id, name, optional sourceDatasetId/timestamps; nextCursor. Full data contract: [DocumentListToolOutput](#documentlisttooloutput).

**Errors and limits:** Do not treat a document ID as a dataset ID.

## statsplayground_document_get

Get a project document. Read-only.

**Arguments:** [DocumentGetToolInput](#documentgettoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required kind and id; read a document before changing its configuration.

```json
{
  "kind": "analysis",
  "id": "analysis-1"
}
```

**Output:** data.kind, id, document, discriminated by requested kind. Analysis documents expose configRevision; graph/report documentRevision is absent. Full data contract: [DocumentGetToolOutput](#documentgettooloutput).

**Errors and limits:** not_found: refresh list; the response cannot recover graph/report revisions.

## statsplayground_table_create

Create a managed table. Mutation/execution.

**Arguments:** [TableCreateToolInput](#tablecreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Create a managed table from actual supplied data: request.name, columns and rows. Each column requires name and sqlType; optional display. Optional preview requests returned rows. Row widths and values must match columns; use JSON null for missing values.

```json
{
  "request": {
    "name": "Supplied measurements",
    "columns": [
      {
        "name": "Length",
        "sqlType": "DOUBLE"
      },
      {
        "name": "Batch",
        "sqlType": "VARCHAR"
      }
    ],
    "rows": [
      [
        10.2,
        "A"
      ],
      [
        10.4,
        "B"
      ],
      [
        null,
        "A"
      ]
    ]
  }
}
```

**Output:** Same data shape as table.describe, including generated dataset ID and generation. Full data contract: [TableCreateToolOutput](#tablecreatetooloutput).

**Errors and limits:** Unsupported SQL types, incompatible values, duplicate names or row width errors: fix before retry. No CSV path/CSV text parameter.

## statsplayground_table_transform_create

Create a table transform. Mutation/execution.

**Arguments:** [TableTransformCreateToolInput](#tabletransformcreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Create a transform draft with name, outputName, operation and inputBindings. Resolve tableDocumentId IDs and exact roles; unary transforms use source; join uses left/right. Creation can execute the transform; inspect its returned execution before running again.

```json
{
  "draft": {
    "name": "Sort length",
    "outputName": "Sorted measurements",
    "operation": {
      "kind": "sort",
      "sortColumns": [
        {
          "column": "Length",
          "direction": "ascending"
        }
      ]
    },
    "inputBindings": [
      {
        "role": "source",
        "tableDocumentId": "dataset-1"
      }
    ]
  }
}
```

**Output:** data.execution plus nullable definition, binding, outputTable, targetDatasetGeneration. Inspect execution.status, schemaReports, error and runState. Full data contract: [TableTransformCreateToolOutput](#tabletransformcreatetooloutput).

**Errors and limits:** Missing bindings/schema mismatches can prevent output creation; schema reports identify columns and types.

## statsplayground_table_transform_run

Run a table transform. Mutation/execution.

**Arguments:** [TableTransformRunToolInput](#tabletransformruntoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required transformId from the returned definition. Reruns the persisted definition/bindings, not an inline operation.

```json
{
  "transformId": "transform-1"
}
```

**Output:** Same data shape as transform.create. definitionRevision/outputGeneration identify what ran. Full data contract: [TableTransformRunToolOutput](#tabletransformruntooloutput).

**Errors and limits:** Check execution status and schemaReports even in a successful envelope.

## statsplayground_sql_create_table

Create a table from read-only SQL. Mutation/execution.

**Arguments:** [SqlCreateTableToolInput](#sqlcreatetabletoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required sql and name. Use a read-only SELECT against actual project SQL table names, with quoted identifiers. Creates a new managed result table.

```json
{
  "sql": "SELECT \"Length\", \"Batch\" FROM \"Supplied measurements\" WHERE \"Length\" IS NOT NULL",
  "name": "Nonmissing measurements"
}
```

**Output:** data.datasetId, datasetName and nullable outputTable. Full data contract: [SqlCreateTableToolOutput](#sqlcreatetabletooloutput).

**Errors and limits:** SQL syntax/binding errors and non-read-only SQL are rejected. Do not interpolate untrusted SQL fragments.

## statsplayground_table_export_csv

Export a table as CSV. Mutation/execution.

**Arguments:** [TableExportCsvToolInput](#tableexportcsvtoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required datasetId, rootId, relativePath. Use a configured approved export root; relativePath must remain inside it. This is a filesystem mutation.

```json
{
  "datasetId": "dataset-1",
  "rootId": "approved-root-1",
  "relativePath": "exports/measurements.csv"
}
```

**Output:** data.targetStatus: createNew or overwriteExisting. Full data contract: [TableExportCsvToolOutput](#tableexportcsvtooloutput).

**Errors and limits:** The catalog has no root-discovery tool; obtain a root through configured settings/UI. Overwrite/path policies may block; never supply confirmation flags to bypass them.

## statsplayground_tabulate_create

Create a Tabulate document. Mutation/execution.

**Arguments:** [TabulateCreateToolInput](#tabulatecreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required sourceDatasetId. Creates a Tabulate document, not a finished result.

```json
{
  "sourceDatasetId": "dataset-1"
}
```

**Output:** data.item: id/name/sourceDatasetId, rowFields, columnFields, statistics, totals, createdAt. Full data contract: [TabulateCreateToolOutput](#tabulatecreatetooloutput).

**Errors and limits:** Describe source and choose grouping/statistic fields before running.

## statsplayground_tabulate_run

Run a Tabulate document. Mutation/execution.

**Arguments:** [TabulateRunToolInput](#tabulateruntoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required tabulateId and complete request. request.datasetId must match the intended source. Provide rowFields, columnFields, statistics, includeRowTotals and includeColumnTotals. Statistic fields are names; quantile statistic needs quantile.

```json
{
  "tabulateId": "tabulate-1",
  "request": {
    "datasetId": "dataset-1",
    "rowFields": [
      "Batch"
    ],
    "columnFields": [],
    "statistics": [
      {
        "id": "mean-length",
        "field": "Length",
        "kind": "mean"
      }
    ],
    "includeRowTotals": false,
    "includeColumnTotals": false
  }
}
```

**Output:** data.tabulateId, requestFingerprint, sourceGeneration, completedAt, session, leaseReleased, cacheValid. Session is metadata, not a returned flat pivot matrix. Full data contract: [TabulateRunToolOutput](#tabulateruntooloutput).

**Errors and limits:** Require session.state ready; inspect failureCode. Stale source generations invalidate cache/session reuse.

## statsplayground_tabulate_to_table

Create a table from Tabulate. Mutation/execution.

**Arguments:** [TabulateToTableToolInput](#tabulatetotabletoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required tabulateId, complete request, tableName; optional session identity from a successful run (sessionId, fingerprint, sourceGeneration). Creates a managed table; omitting or stale session may rerun.

```json
{
  "tabulateId": "tabulate-1",
  "request": {
    "datasetId": "dataset-1",
    "rowFields": [
      "Batch"
    ],
    "columnFields": [],
    "statistics": [
      {
        "id": "mean-length",
        "field": "Length",
        "kind": "mean"
      }
    ],
    "includeRowTotals": false,
    "includeColumnTotals": false
  },
  "tableName": "Batch summary"
}
```

**Output:** data.outputTable (nullable), reran, requestFingerprint, sourceGeneration. Describe/preview the output table to inspect values. Full data contract: [TabulateToTableToolOutput](#tabulatetotabletooloutput).

**Errors and limits:** Do not invent session IDs; check outputTable before claiming success.

## statsplayground_graph_create

Create a Graph Builder document. Mutation/execution.

**Arguments:** [GraphCreateToolInput](#graphcreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required sourceDatasetId. Creates a default graph; configure with graph.update afterward.

```json
{
  "sourceDatasetId": "dataset-1"
}
```

**Output:** data.item and documentRevision. Preserve both for a full replacement update. Full data contract: [GraphCreateToolOutput](#graphcreatetooloutput).

**Errors and limits:** Source must exist; creating a graph does not run an analysis.

## statsplayground_graph_update

Update a Graph Builder document. Mutation/execution.

**Arguments:** [GraphUpdateToolInput](#graphupdatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required graphId, expectedDocumentRevision and full definition: preserve returned id/name/sourceDatasetId/createdAt plus mode/modeStates. There is no draft, patch, xColumn or yColumn shortcut. Encode fields inside modeStates.twoD.encoding; preserve unused mode states.

```json
{
  "graphId": "graph-1",
  "expectedDocumentRevision": 1,
  "definition": {
    "id": "graph-1",
    "name": "Length graph",
    "sourceDatasetId": "dataset-1",
    "mode": "2d",
    "modeStates": {
      "twoD": {
        "encoding": {
          "x": {
            "name": "Length",
            "type": "continuous"
          }
        },
        "multiX": [],
        "multiY": [],
        "elements": [
          {
            "kind": "histogram",
            "enabled": true,
            "options": {
              "elementId": "distribution.overview.histogram"
            }
          },
          {
            "kind": "line",
            "enabled": true,
            "options": {
              "elementId": "distribution.overview.fittedCurves"
            }
          }
        ],
        "smootherLambda": 0.4
      },
      "threeD": {
        "encoding": {},
        "elements": [
          {
            "kind": "scatter3d",
            "enabled": true
          }
        ],
        "smootherLambda": 0.4
      },
      "multivariate": {
        "columns": [],
        "chartType": "correlationMatrix",
        "correlationMethod": "pearson"
      }
    },
    "createdAt": "2026-10-13T00:00:00.000Z"
  }
}
```

**Output:** data.item and documentRevision; changed=false for identical content. Full data contract: [GraphUpdateToolOutput](#graphupdatetooloutput).

**Errors and limits:** Revision conflict: reread and reconcile; use details.actual if supplied. Match graphId/definition.id/source; unknown fields are rejected.

## statsplayground_analysis_create

Create an Analysis document. Mutation/execution.

**Arguments:** [AnalysisCreateToolInput](#analysiscreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required analysisKind, sourceDatasetId and kind-specific draft. Supported kinds: distribution, fitYByX, fitModel, hypothesisTest. See variant contracts below. Creates configuration; analysis.run is a separate step.

```json
{
  "analysisKind": "distribution",
  "sourceDatasetId": "dataset-1",
  "draft": {
    "responses": [
      {
        "name": "Length",
        "type": "continuous"
      }
    ],
    "weight": null,
    "frequency": null,
    "by": [],
    "nestedSubgroup": null,
    "analysis": {
      "confidenceLevel": 0.95,
      "specLimits": {},
      "fitDistributions": [
        "normal"
      ],
      "fitAll": false
    },
    "name": "Length distribution"
  }
}
```

**Output:** data.item: id, analysisKind, configRevision, source, definition, presentation, timestamps. Full data contract: [AnalysisCreateToolOutput](#analysiscreatetooloutput).

**Errors and limits:** Describe and map fields first; invalid roles/kinds/configurations are rejected. Do not confuse this API with lower-level distribution request shapes.

## statsplayground_analysis_update

Update an Analysis document. Mutation/execution.

**Arguments:** [AnalysisUpdateToolInput](#analysisupdatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required analysisKind, analysisId, expectedConfigRevision and complete kind-specific draft. Source cannot be changed here. Distribution updates must include graphs even when creation omitted them. Copy current definition minus kind, then change selected values.

```json
{
  "analysisKind": "distribution",
  "analysisId": "analysis-1",
  "expectedConfigRevision": 1,
  "draft": {
    "responses": [
      {
        "name": "Length",
        "type": "continuous"
      }
    ],
    "weight": null,
    "frequency": null,
    "by": [],
    "nestedSubgroup": null,
    "analysis": {
      "confidenceLevel": 0.95,
      "specLimits": {},
      "fitDistributions": [
        "normal"
      ],
      "fitAll": false
    },
    "graphs": {
      "overview": {
        "mode": "2d",
        "modeStates": {
          "twoD": {
            "encoding": {
              "x": {
                "name": "Length",
                "type": "continuous"
              }
            },
            "multiX": [],
            "multiY": [],
            "elements": [
              {
                "kind": "histogram",
                "enabled": true,
                "options": {
                  "elementId": "distribution.overview.histogram"
                }
              },
              {
                "kind": "line",
                "enabled": true,
                "options": {
                  "elementId": "distribution.overview.fittedCurves"
                }
              }
            ],
            "smootherLambda": 0.4
          },
          "threeD": {
            "encoding": {},
            "elements": [
              {
                "kind": "scatter3d",
                "enabled": true
              }
            ],
            "smootherLambda": 0.4
          },
          "multivariate": {
            "columns": [],
            "chartType": "correlationMatrix",
            "correlationMethod": "pearson"
          }
        },
        "filters": [],
        "sampling": {
          "mode": "full"
        }
      },
      "boxPlot": {
        "mode": "2d",
        "modeStates": {
          "twoD": {
            "encoding": {
              "x": {
                "name": "Length",
                "type": "continuous"
              }
            },
            "multiX": [],
            "multiY": [],
            "elements": [
              {
                "kind": "boxplot",
                "enabled": true,
                "options": {
                  "elementId": "distribution.boxPlot"
                }
              }
            ],
            "smootherLambda": 0.4
          },
          "threeD": {
            "encoding": {},
            "elements": [
              {
                "kind": "scatter3d",
                "enabled": true
              }
            ],
            "smootherLambda": 0.4
          },
          "multivariate": {
            "columns": [],
            "chartType": "correlationMatrix",
            "correlationMethod": "pearson"
          }
        },
        "filters": [],
        "sampling": {
          "mode": "full"
        }
      },
      "ecdf": {
        "mode": "2d",
        "modeStates": {
          "twoD": {
            "encoding": {
              "x": {
                "name": "Length",
                "type": "continuous"
              }
            },
            "multiX": [],
            "multiY": [],
            "elements": [
              {
                "kind": "line",
                "enabled": true,
                "options": {
                  "elementId": "distribution.ecdf"
                }
              }
            ],
            "smootherLambda": 0.4
          },
          "threeD": {
            "encoding": {},
            "elements": [
              {
                "kind": "scatter3d",
                "enabled": true
              }
            ],
            "smootherLambda": 0.4
          },
          "multivariate": {
            "columns": [],
            "chartType": "correlationMatrix",
            "correlationMethod": "pearson"
          }
        },
        "filters": [],
        "sampling": {
          "mode": "full"
        }
      },
      "normalQuantile": {
        "mode": "2d",
        "modeStates": {
          "twoD": {
            "encoding": {
              "x": {
                "name": "Length",
                "type": "continuous"
              }
            },
            "multiX": [],
            "multiY": [],
            "elements": [
              {
                "kind": "points",
                "enabled": true,
                "options": {
                  "elementId": "distribution.normalQuantile.points"
                }
              },
              {
                "kind": "line",
                "enabled": true,
                "options": {
                  "elementId": "distribution.normalQuantile.reference"
                }
              },
              {
                "kind": "line",
                "enabled": true,
                "options": {
                  "elementId": "distribution.normalQuantile.lower"
                }
              },
              {
                "kind": "line",
                "enabled": true,
                "options": {
                  "elementId": "distribution.normalQuantile.upper"
                }
              }
            ],
            "smootherLambda": 0.4
          },
          "threeD": {
            "encoding": {},
            "elements": [
              {
                "kind": "scatter3d",
                "enabled": true
              }
            ],
            "smootherLambda": 0.4
          },
          "multivariate": {
            "columns": [],
            "chartType": "correlationMatrix",
            "correlationMethod": "pearson"
          }
        },
        "filters": [],
        "sampling": {
          "mode": "full"
        }
      }
    }
  }
}
```

**Output:** data.item; configRevision advances when configuration changes. Full data contract: [AnalysisUpdateToolOutput](#analysisupdatetooloutput).

**Errors and limits:** Kind must match persisted document. On conflict reread/reconcile. Rerun before updating conclusions; updates do not return new statistical results.

## statsplayground_analysis_run

Run an Analysis document. Mutation/execution.

**Arguments:** [AnalysisRunToolInput](#analysisruntoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required analysisId only. Runs its persisted definition against the source. Do not pass a datasetId, draft or response columns here.

```json
{
  "analysisId": "analysis-1"
}
```

**Output:** data.item, definition, dataset and state. Require state.status success and then read state.result; loading/error/idle are not usable conclusions. Full data contract: [AnalysisRunToolOutput](#analysisruntooloutput).

**Errors and limits:** state.error is distinct from an MCP error; a stale/cancelled run must not be reported as current success.

## statsplayground_report_create

Create a Report document. Mutation/execution.

**Arguments:** [ReportCreateToolInput](#reportcreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Empty arguments. Creates a blank report with an allocated name; takes neither title nor markdown. Follow with report.update.

```json
{}
```

**Output:** data.item and documentRevision (initially 1). Full data contract: [ReportCreateToolOutput](#reportcreatetooloutput).

**Errors and limits:** Preserve returned ID and revision; avoid duplicate creation after uncertain retries.

## statsplayground_report_update

Update a Report document. Mutation/execution.

**Arguments:** [ReportUpdateToolInput](#reportupdatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Required reportId, expectedDocumentRevision and markdown. Replaces the whole body; preserve concurrent user edits. Embeds are exact standalone lines such as {{sp-embed kind="distribution" id="analysis-1"}}. Valid embed kinds: table, graph, fitYByX, tabulate, distribution, hypothesisTest.

```json
{
  "reportId": "report-1",
  "expectedDocumentRevision": 1,
  "markdown": "# Length distribution\n\nSource: supplied measurements. Insert conclusions from successful returned results.\n\n{{sp-embed kind=\"distribution\" id=\"analysis-1\"}}\n"
}
```

**Output:** data.item and documentRevision. No PDF/DOCX export or rename parameter. Full data contract: [ReportUpdateToolOutput](#reportupdatetooloutput).

**Errors and limits:** Missing or wrong-kind embed dependencies are invalid_input. Revision conflict requires reread/reconciliation; document.get lacks revision.

## statsplayground_project_save

Save the current project. Mutation/execution.

**Arguments:** [ProjectSaveToolInput](#projectsavetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Empty arguments. Saves current project only after a destination path exists; inspect project.hasProjectPath.

```json
{}
```

**Output:** data: ProjectSummary; check errors before claiming persisted success. Full data contract: [ProjectSaveToolOutput](#projectsavetooloutput).

**Errors and limits:** project_path_required: establish destination via UI; filePath is rejected by this MCP input contract.

## statsplayground_snapshot_create

Create a project snapshot. Mutation/execution.

**Arguments:** [SnapshotCreateToolInput](#snapshotcreatetoolinput). Required/optional nested fields are in the contract appendix.

**Workflow and preconditions:** Optional name. Creates a project snapshot; consider before substantial authorized revisions.

```json
{
  "name": "Before analysis revisions"
}
```

**Output:** data.snapshotId, snapshotName, createdAt, each nullable. Full data contract: [SnapshotCreateToolOutput](#snapshotcreatetooloutput).

**Errors and limits:** Check returned values/errors before claiming snapshot exists; obey project path/read-only restrictions.

## Contract appendix

Tables below use JSON field names. Types: `Vec<T>` is an array; `BTreeMap<string, T>` an object keyed by strings; `Option<T>` accepts null and may be omitted by the current deserializer (show null explicitly when replacing role assignments); `Box<T>` has the same JSON as T. Non-Option fields are required unless documented with a default. Empty-input structs accept `{}`. `Value` is arbitrary JSON. See enum discriminators and field-specific constraints below.

### AnalysisCommandResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| item | required | `AnalysisDocument` |

### AnalysisCreateToolInput

Tagged object: discriminator `analysisKind`; camelCase variant names and fields.

```text
distribution(DistributionAnalysisCreateInput)
fitYByX(FitYByXAnalysisCreateInput)
fitModel(FitModelAnalysisCreateInput)
hypothesisTest(HypothesisTestAnalysisCreateInput)
```

### AnalysisCreateToolOutput

Alias: `ToolCommandResult<AnalysisCommandResultData>`.

### AnalysisDefinition

Untagged union; use the matching shape.

```text
distribution(DistributionAnalysisDefinition)
fitYByX(FitYByXAnalysisDefinition)
fitModel(FitModelAnalysisDefinition)
hypothesisTest(HypothesisTestAnalysisDefinition)
```

### AnalysisDocument

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| documentType | required | `string` |
| id | required | `string` |
| name | required | `string` |
| analysisKind | required | `string` |
| configRevision | required | `integer >= 0` |
| source | required | `AnalysisSource` |
| definition | required | `AnalysisDefinition` |
| presentation | required | `AnalysisPresentation` |
| createdAt | required | `string` |
| updatedAt | required | `string` |

### AnalysisExecutionState

Tagged object: discriminator `status`; camelCase variant names and fields.

```text
idle
loading { analysisKind: AnalysisKind, analysisId: string, datasetId: string, configRevision: integer, request: nullable/optional <BTreeMap<string }
success { analysisKind: AnalysisKind, analysisId: string, datasetId: string, configRevision: integer, request: BTreeMap<string, result: BTreeMap<string }
error { analysisKind: AnalysisKind, analysisId: string, datasetId: string, configRevision: integer, request: nullable/optional <BTreeMap<string, error: string }
```

### AnalysisKind

String enum; camelCase variant names (explicit rename takes precedence).

```text
distribution
fitYByX
fitModel
hypothesisTest
```

### AnalysisPresentation

Untagged union; use the matching shape.

```text
distribution(DistributionAnalysisPresentation)
fitYByX(FitYByXAnalysisPresentation)
fitModel(FitModelAnalysisPresentation)
hypothesisTest(HypothesisTestAnalysisPresentation)
```

### AnalysisRunResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| item | required | `AnalysisDocument` |
| definition | required | `AnalysisDefinition` |
| dataset | required | `DatasetMeta` |
| state | required | `AnalysisExecutionState` |

### AnalysisRunToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| analysisId | required | `string` |

### AnalysisRunToolOutput

Alias: `ToolCommandResult<AnalysisRunResultData>`.

### AnalysisSource

| JSON field | Presence | Type |
| --- | --- | --- |
| datasetId | required | `string` |

### AnalysisUpdateToolInput

Tagged object: discriminator `analysisKind`; camelCase variant names and fields.

```text
distribution(DistributionAnalysisUpdateInput)
fitYByX(FitYByXAnalysisUpdateInput)
fitModel(FitModelAnalysisUpdateInput)
hypothesisTest(HypothesisTestAnalysisUpdateInput)
```

### AnalysisUpdateToolOutput

Alias: `ToolCommandResult<AnalysisCommandResultData>`.

### AxisConfig

| JSON field | Presence | Type |
| --- | --- | --- |
| min | optional / nullable | `Option<number>` |
| max | optional / nullable | `Option<number>` |
| tickInterval | optional / nullable | `Option<number>` |
| decimals | optional / nullable | `Option<integer >= 0>` |
| inverse | optional / nullable | `Option<boolean>` |
| minorTickCount | optional / nullable | `Option<integer >= 0>` |
| showAxisLine | optional / nullable | `Option<boolean>` |
| tickPosition | optional / nullable | `Option<string>` |
| additional keys (flattened) | optional | `BTreeMap<string, JSON value>` |

### ChartElement

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `ChartElementKind` |
| enabled | required | `boolean` |
| options | optional / nullable | `Option<BTreeMap<string, JSON value>>` |
| correlationMethod | optional / nullable | `Option<CorrelationMethod>` |

### ChartElementKind

String enum; camelCase variant names (explicit rename takes precedence).

```text
points
line
bar
heatmap
correlationMatrix
histogram
normalCurve
boxplot
smoother
fitline
surface
contour3d
scatter3d
```

### ColumnDisplayPropsWithoutIndex

| JSON field | Presence | Type |
| --- | --- | --- |
| width | optional / nullable | `Option<number>` |
| format | optional / nullable | `Option<ColumnFormatInfo>` |
| extras | optional / nullable | `Option<BTreeMap<string, JSON value>>` |

### ColumnFormatInfo

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `string` |
| decimals | optional / nullable | `Option<integer >= 0>` |
| currency | optional / nullable | `Option<string>` |

### CommandWarning

| JSON field | Presence | Type |
| --- | --- | --- |
| code | required | `string` |
| message | required | `string` |

### CorrelationMethod

String enum; camelCase variant names (explicit rename takes precedence).

```text
pearson
spearman
kendall
```

### CreateManagedTableRequest

| JSON field | Presence | Type |
| --- | --- | --- |
| name | required | `string` |
| columns | required | `Vec<CreateTableColumn>` |
| rows | required | `Vec<Vec<JSON value>>` |

### CreateTableColumn

| JSON field | Presence | Type |
| --- | --- | --- |
| name | required | `string` |
| sqlType | required | `string` |
| display | optional / nullable | `Option<ColumnDisplayPropsWithoutIndex>` |

### DatasetMeta

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| name | required | `string` |
| sourcePath | optional / nullable | `Option<string>` |
| sourceType | required | `string` |
| rowCount | required | `integer >= 0` |
| colCount | required | `integer >= 0` |
| generation | required | `integer >= 0` |
| createdAt | required | `string` |
| updatedAt | required | `string` |

### DistributionAnalysisConfig

| JSON field | Presence | Type |
| --- | --- | --- |
| confidenceLevel | required | `number` |
| specLimits | required | `BTreeMap<string, SpecLimitsOverride>` |
| fitDistributions | required | `Vec<DistributionFitKind>` |
| fitAll | optional (default) | `boolean` |

### DistributionAnalysisCreateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| name | optional / nullable | `Option<string>` |
| responses | required | `Vec<FieldRef>` |
| weight | optional / nullable | `Option<FieldRef>` |
| frequency | optional / nullable | `Option<FieldRef>` |
| by | required | `Vec<FieldRef>` |
| nestedSubgroup | optional / nullable | `Option<FieldRef>` |
| analysis | optional / nullable | `Option<DistributionAnalysisConfig>` |
| graphs | optional / nullable | `Option<DistributionGraphs>` |

### DistributionAnalysisCreateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |
| draft | required | `DistributionAnalysisCreateDraft` |

### DistributionAnalysisDefinition

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `string` |
| responses | required | `Vec<FieldRef>` |
| weight | optional / nullable | `Option<FieldRef>` |
| frequency | optional / nullable | `Option<FieldRef>` |
| by | required | `Vec<FieldRef>` |
| nestedSubgroup | optional / nullable | `Option<FieldRef>` |
| analysis | required | `DistributionAnalysisConfig` |
| graphs | required | `DistributionGraphs` |

### DistributionAnalysisPresentation

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| layout | required | `string` |

### DistributionAnalysisUpdateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| responses | required | `Vec<FieldRef>` |
| weight | optional / nullable | `Option<FieldRef>` |
| frequency | optional / nullable | `Option<FieldRef>` |
| by | required | `Vec<FieldRef>` |
| nestedSubgroup | optional / nullable | `Option<FieldRef>` |
| analysis | required | `DistributionAnalysisConfig` |
| graphs | required | `DistributionGraphs` |

### DistributionAnalysisUpdateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| analysisId | required | `string` |
| expectedConfigRevision | required | `integer >= 0` |
| draft | required | `DistributionAnalysisUpdateDraft` |

### DistributionFitKind

String enum; camelCase variant names (explicit rename takes precedence).

```text
normal
cauchy
lognormal
exponential
gamma
weibull
```

### DistributionGraphs

| JSON field | Presence | Type |
| --- | --- | --- |
| overview | required | `EmbeddedGraphConfig` |
| boxPlot | required | `EmbeddedGraphConfig` |
| ecdf | required | `EmbeddedGraphConfig` |
| normalQuantile | required | `EmbeddedGraphConfig` |

### DocumentGetToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `ProjectDocumentKind` |
| id | required | `string` |

### DocumentGetToolOutput

Alias: `ToolCommandResult<ProjectDocumentGetResultData>`.

### DocumentListToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | optional / nullable | `Option<ProjectDocumentKind>` |
| cursor | optional / nullable | `Option<string>` |
| limit | optional / nullable | `Option<integer >= 0>` |

### DocumentListToolOutput

Alias: `ToolCommandResult<ProjectDocumentListResultData>`.

### EmbeddedGraphConfig

| JSON field | Presence | Type |
| --- | --- | --- |
| mode | required | `GraphBuilderMode` |
| modeStates | required | `GraphModeStates` |
| sampling | optional / nullable | `Option<GraphSampling>` |
| groupThemeSlots | optional / nullable | `Option<BTreeMap<string, BTreeMap<string, integer >= 0>>>` |
| filters | optional / nullable | `Option<Vec<GraphFilterRuleItem>>` |

### FieldMeasurementType

String enum; camelCase variant names (explicit rename takes precedence).

```text
continuous
nominal
ordinal
datetime
id
```

### FieldRef

| JSON field | Presence | Type |
| --- | --- | --- |
| columnId | optional / nullable | `Option<string>` |
| name | required | `string` |
| type | required | `FieldMeasurementType` |

### FilterLogicalOperator

String enum; camelCase variant names (explicit rename takes precedence).

```text
AND
OR
```

### FitModelAnalysisCreateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| name | optional / nullable | `Option<string>` |
| response | required | `FieldRef` |
| construct | required | `FitModelConstruct` |
| terms | required | `Vec<FitModelTerm>` |
| centeringMethod | required | `FitModelCenteringMethod` |
| confidenceLevel | optional / nullable | `Option<number>` |

### FitModelAnalysisCreateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |
| draft | required | `FitModelAnalysisCreateDraft` |

### FitModelAnalysisDefinition

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `string` |
| response | required | `FieldRef` |
| construct | required | `FitModelConstruct` |
| terms | required | `Vec<FitModelTerm>` |
| centeringMethod | required | `FitModelCenteringMethod` |
| confidenceLevel | required | `number` |
| migrationIssue | optional / nullable | `Option<FitModelLoadIssue>` |

### FitModelAnalysisPresentation

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| layout | required | `string` |

### FitModelAnalysisUpdateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| response | required | `FieldRef` |
| construct | required | `FitModelConstruct` |
| terms | required | `Vec<FitModelTerm>` |
| centeringMethod | required | `FitModelCenteringMethod` |
| confidenceLevel | optional / nullable | `Option<number>` |

### FitModelAnalysisUpdateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| analysisId | required | `string` |
| expectedConfigRevision | required | `integer >= 0` |
| draft | required | `FitModelAnalysisUpdateDraft` |

### FitModelCenteringMethod

String enum; camelCase variant names (explicit rename takes precedence).

```text
none
mean
```

### FitModelConstruct

Tagged object: discriminator `kind`; camelCase variant names and fields.

```text
manual
fullFactorial
factorialToDegree { degree: integer } }
responseSurface
```

### FitModelLoadIssue

| JSON field | Presence | Type |
| --- | --- | --- |
| code | required | `string` |
| detail | required | `string` |

### FitModelTerm

Tagged object: discriminator `kind`; camelCase variant names and fields.

```text
main { columnNames: Vec<string> }
interaction { columnNames: Vec<string> }
power { columnNames: Vec<string>, exponent: integer }
```

### FitYByXAnalysisCreateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| name | optional / nullable | `Option<string>` |
| response | required | `FieldRef` |
| factor | required | `FieldRef` |
| confidenceLevel | required | `number` |
| graph | optional / nullable | `Option<EmbeddedGraphConfig>` |

### FitYByXAnalysisCreateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |
| draft | required | `FitYByXAnalysisCreateDraft` |

### FitYByXAnalysisDefinition

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `string` |
| response | required | `FieldRef` |
| factor | required | `FieldRef` |
| personality | required | `FitYByXPersonality` |
| confidenceLevel | required | `number` |

### FitYByXAnalysisPresentation

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| layout | required | `string` |
| graph | required | `EmbeddedGraphConfig` |

### FitYByXAnalysisUpdateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| response | required | `FieldRef` |
| factor | required | `FieldRef` |
| confidenceLevel | required | `number` |
| graph | optional / nullable | `Option<EmbeddedGraphConfig>` |

### FitYByXAnalysisUpdateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| analysisId | required | `string` |
| expectedConfigRevision | required | `integer >= 0` |
| draft | required | `FitYByXAnalysisUpdateDraft` |

### FitYByXPersonality

String enum; camelCase variant names (explicit rename takes precedence).

```text
oneway
bivariate
```

### Graph2dState

| JSON field | Presence | Type |
| --- | --- | --- |
| encoding | required | `BTreeMap<string, FieldRef>` |
| transposed | optional / nullable | `Option<boolean>` |
| multiX | required | `Vec<FieldRef>` |
| multiY | required | `Vec<FieldRef>` |
| elements | required | `Vec<ChartElement>` |
| smootherLambda | required | `number` |
| groupStyles | optional / nullable | `Option<BTreeMap<string, JSON value>>` |
| hiddenGroups | optional / nullable | `Option<Vec<string>>` |
| refLinesY | optional / nullable | `Option<Vec<ReferenceLine>>` |
| refLinesX | optional / nullable | `Option<Vec<ReferenceLine>>` |
| autoSpecLinesY | optional / nullable | `Option<boolean>` |
| autoSpecLinesX | optional / nullable | `Option<boolean>` |
| autoSpecLines | optional / nullable | `Option<boolean>` |
| yAxis | optional / nullable | `Option<AxisConfig>` |
| xAxis | optional / nullable | `Option<AxisConfig>` |

### Graph3dState

| JSON field | Presence | Type |
| --- | --- | --- |
| encoding | required | `BTreeMap<string, FieldRef>` |
| elements | required | `Vec<ChartElement>` |
| smootherLambda | required | `number` |
| groupStyles | optional / nullable | `Option<BTreeMap<string, JSON value>>` |
| hiddenGroups | optional / nullable | `Option<Vec<string>>` |

### GraphBuilderItem

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| name | required | `string` |
| sourceDatasetId | required | `string` |
| mode | required | `GraphBuilderMode` |
| modeStates | required | `GraphModeStates` |
| sampling | optional / nullable | `Option<GraphSampling>` |
| groupThemeSlots | optional / nullable | `Option<BTreeMap<string, BTreeMap<string, integer >= 0>>>` |
| createdAt | required | `string` |

### GraphBuilderMode

String enum; camelCase variant names (explicit rename takes precedence).

```text
2d
3d
multivariate
```

### GraphCommandResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| item | required | `GraphBuilderItem` |
| documentRevision | required | `integer >= 0` |

### GraphCreateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |

### GraphCreateToolOutput

Alias: `ToolCommandResult<GraphCommandResultData>`.

### GraphFilterRule

Tagged object: discriminator `kind`; camelCase variant names and fields.

```text
continuous { field: FieldRef, min: nullable/optional <number>, max: nullable/optional <number> }
categorical { field: FieldRef, selected: Vec<string>, exclude: nullable/optional <boolean> }
date { field: FieldRef, start: nullable/optional <string>, end: nullable/optional <string> }
```

### GraphFilterRuleItem

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| op | required | `FilterLogicalOperator` |
| rule | required | `GraphFilterRule` |
| height | optional / nullable | `Option<number>` |

### GraphModeStates

| JSON field | Presence | Type |
| --- | --- | --- |
| twoD | required | `Graph2dState` |
| threeD | required | `Graph3dState` |
| multivariate | required | `MultivariateGraphState` |

### GraphSampling

Tagged object: discriminator `mode`; camelCase variant names and fields.

```text
full
sample { size: integer, seed: integer } }
```

### GraphUpdateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| graphId | required | `string` |
| expectedDocumentRevision | required | `integer >= 0` |
| definition | required | `GraphBuilderItem` |

### GraphUpdateToolOutput

Alias: `ToolCommandResult<GraphCommandResultData>`.

### HypothesisTestAlternative

String enum; camelCase variant names (explicit rename takes precedence).

```text
twoSided
less
greater
```

### HypothesisTestAnalysisCreateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| name | optional / nullable | `Option<string>` |
| definition | required | `HypothesisTestAnalysisDefinition` |

### HypothesisTestAnalysisCreateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |
| draft | required | `HypothesisTestAnalysisCreateDraft` |

### HypothesisTestAnalysisDefinition

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `string` |
| roles | required | `HypothesisTestRoles` |
| studyDesign | required | `HypothesisTestStudyDesign` |
| selectionMode | required | `HypothesisTestSelectionMode` |
| manualSelection | optional / nullable | `Option<HypothesisTestManualSelection>` |
| alternative | required | `HypothesisTestAlternative` |
| alpha | required | `number` |
| confidenceLevel | required | `number` |
| levelOrder | required | `Vec<string>` |
| referenceLevel | optional / nullable | `Option<string>` |
| postHoc | required | `HypothesisTestPostHoc` |
| selectorVersion | required | `string` |

### HypothesisTestAnalysisPresentation

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| layout | required | `string` |
| activeResultTab | required | `HypothesisTestResultTab` |
| collapsedSections | required | `Vec<HypothesisTestCollapsedSection>` |
| graphs | required | `HypothesisTestGraphPresentation` |
| tableSort | optional / nullable | `Option<HypothesisTestTableSort>` |

### HypothesisTestAnalysisUpdateDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| definition | required | `HypothesisTestAnalysisDefinition` |
| presentation | optional / nullable | `Option<HypothesisTestAnalysisPresentation>` |

### HypothesisTestAnalysisUpdateInput

| JSON field | Presence | Type |
| --- | --- | --- |
| analysisId | required | `string` |
| expectedConfigRevision | required | `integer >= 0` |
| draft | required | `HypothesisTestAnalysisUpdateDraft` |

### HypothesisTestCollapsedSection

String enum; camelCase variant names (explicit rename takes precedence).

```text
methodEvidence
sensitivity
postHoc
exclusions
audit
```

### HypothesisTestGraphPresentation

| JSON field | Presence | Type |
| --- | --- | --- |
| showRawData | required | `boolean` |
| showIntervals | required | `boolean` |
| showDiagnostics | required | `boolean` |

### HypothesisTestManualSelection

| JSON field | Presence | Type |
| --- | --- | --- |
| methodId | required | `HypothesisTestMethodId` |
| reason | optional / nullable | `Option<string>` |

### HypothesisTestMethodId

String enum; camelCase variant names (explicit rename takes precedence).

```text
studentTwoSampleT
welchTwoSampleT
mannWhitneyU
oneWayAnova
welchAnova
kruskalWallis
pairedT
wilcoxonSignedRank
randomizedBlockAnova
friedman
```

### HypothesisTestPostHoc

String enum; camelCase variant names (explicit rename takes precedence).

```text
automatic
off
```

### HypothesisTestResultTab

String enum; camelCase variant names (explicit rename takes precedence).

```text
results
diagnostics
audit
```

### HypothesisTestRoles

Tagged object: discriminator `layout`; camelCase variant names and fields.

```text
long { response: FieldRef, condition: FieldRef, subject: nullable/optional <FieldRef> }
wide { measurements: Vec<FieldRef>, subject: nullable/optional <FieldRef> }
```

### HypothesisTestSelectionMode

String enum; camelCase variant names (explicit rename takes precedence).

```text
automatic
guided
manual
```

### HypothesisTestStudyDesign

String enum; camelCase variant names (explicit rename takes precedence).

```text
independent
pairedOrBlocked
```

### HypothesisTestTableSort

| JSON field | Presence | Type |
| --- | --- | --- |
| key | required | `string` |
| direction | required | `SortDirection` |

### JoinType

String enum; camelCase variant names (explicit rename takes precedence).

```text
inner
left
right
full
```

### MultivariateGraphState

| JSON field | Presence | Type |
| --- | --- | --- |
| columns | required | `Vec<FieldRef>` |
| chartType | required | `string` |
| correlationMethod | required | `CorrelationMethod` |

### MutationControl

| JSON field | Presence | Type |
| --- | --- | --- |
| expectedProjectRevision | optional / nullable | `Option<integer >= 0>` |
| idempotencyKey | optional / nullable | `Option<string>` |

### ProjectCapabilities

| JSON field | Presence | Type |
| --- | --- | --- |
| table | required | `ProjectCapabilitiesTable` |
| document | required | `ProjectCapabilitiesDocument` |
| project | required | `ProjectCapabilitiesProject` |

### ProjectCapabilitiesDocument

| JSON field | Presence | Type |
| --- | --- | --- |
| list | required | `boolean` |
| get | required | `boolean` |

### ProjectCapabilitiesProject

| JSON field | Presence | Type |
| --- | --- | --- |
| inspect | required | `boolean` |

### ProjectCapabilitiesTable

| JSON field | Presence | Type |
| --- | --- | --- |
| list | required | `boolean` |
| describe | required | `boolean` |
| describePreview | required | `boolean` |

### ProjectCounts

| JSON field | Presence | Type |
| --- | --- | --- |
| tables | required | `integer >= 0` |
| tableTransforms | required | `integer >= 0` |
| graphs | required | `integer >= 0` |
| analyses | required | `integer >= 0` |
| tabulates | required | `integer >= 0` |
| reports | required | `integer >= 0` |

### ProjectDocument

String enum; camelCase variant names (explicit rename takes precedence).

```text
tableTransform(TableTransformDefinition)
graph(GraphBuilderItem)
analysis(AnalysisDocument)
tabulate(TabulateItem)
report(ReportItem)
```

### ProjectDocumentGetResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `ProjectDocumentKind` |
| id | required | `string` |
| document | required | `ProjectDocument` |

### ProjectDocumentKind

String enum; camelCase variant names (explicit rename takes precedence).

```text
tableTransform
graph
analysis
tabulate
report
```

### ProjectDocumentListResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| items | required | `Vec<ProjectDocumentSummary>` |
| nextCursor | optional / nullable | `Option<string>` |

### ProjectDocumentSummary

| JSON field | Presence | Type |
| --- | --- | --- |
| kind | required | `ProjectDocumentKind` |
| id | required | `string` |
| name | required | `string` |
| sourceDatasetId | optional / nullable | `Option<string>` |
| createdAt | optional / nullable | `Option<string>` |
| updatedAt | optional / nullable | `Option<string>` |

### ProjectInspectResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| project | optional / nullable | `Option<ProjectSummary>` |
| dirty | required | `boolean` |
| readOnly | required | `boolean` |
| projectRevision | required | `integer >= 0` |
| counts | required | `ProjectCounts` |
| capabilities | optional / nullable | `Option<ProjectCapabilities>` |

### ProjectInspectToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| includeCapabilities | optional / nullable | `Option<boolean>` |

### ProjectInspectToolOutput

Alias: `ToolCommandResult<ProjectInspectResultData>`.

### ProjectSaveToolInput

No fields (`{}`).

### ProjectSaveToolOutput

Alias: `ToolCommandResult<ProjectSummary>`.

### ProjectSummary

| JSON field | Presence | Type |
| --- | --- | --- |
| name | required | `string` |
| createdAt | required | `string` |
| fileName | optional / nullable | `Option<string>` |
| hasProjectPath | required | `boolean` |

### ReferenceLine

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| x | optional / nullable | `Option<number>` |
| y | optional / nullable | `Option<number>` |
| label | required | `string` |
| style | required | `ReferenceLineStyle` |
| color | required | `string` |
| width | required | `number` |

### ReferenceLineStyle

String enum; camelCase variant names (explicit rename takes precedence).

```text
solid
dashed
dotted
```

### ReportCommandResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| item | required | `ReportItem` |
| documentRevision | required | `integer >= 0` |

### ReportCreateToolInput

No fields (`{}`).

### ReportCreateToolOutput

Alias: `ToolCommandResult<ReportCommandResultData>`.

### ReportItem

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaVersion | required | `integer >= 0` |
| id | required | `string` |
| name | required | `string` |
| markdown | required | `string` |
| createdAt | required | `string` |
| updatedAt | required | `string` |

### ReportUpdateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| reportId | required | `string` |
| expectedDocumentRevision | required | `integer >= 0` |
| markdown | required | `string` |

### ReportUpdateToolOutput

Alias: `ToolCommandResult<ReportCommandResultData>`.

### SchemaAttributeMismatch

| JSON field | Presence | Type |
| --- | --- | --- |
| columnName | required | `string` |
| attributeName | required | `string` |
| expectedValue | required | `JSON value` |
| actualValue | optional / nullable | `Option<JSON value>` |
| affectedOperationIds | required | `Vec<string>` |

### SchemaColumnRequirement

| JSON field | Presence | Type |
| --- | --- | --- |
| name | required | `string` |
| canonicalDuckdbType | required | `string` |
| required | required | `boolean` |
| requiredByOperationIds | required | `Vec<string>` |
| requiredExtras | optional / nullable | `Option<BTreeMap<string, JSON value>>` |

### SchemaContract

| JSON field | Presence | Type |
| --- | --- | --- |
| schemaFingerprint | required | `string` |
| columns | required | `Vec<SchemaColumnRequirement>` |

### SchemaValidationIssue

| JSON field | Presence | Type |
| --- | --- | --- |
| columnName | required | `string` |
| expectedType | required | `string` |
| actualType | required | `string` |
| affectedOperationIds | required | `Vec<string>` |

### SchemaValidationReport

| JSON field | Presence | Type |
| --- | --- | --- |
| missingColumns | required | `Vec<SchemaValidationIssue>` |
| typeMismatches | required | `Vec<SchemaValidationIssue>` |
| attributeMismatches | required | `Vec<SchemaAttributeMismatch>` |
| extraColumns | required | `Vec<string>` |

### SnapshotCreateResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| snapshotId | optional / nullable | `Option<string>` |
| snapshotName | optional / nullable | `Option<string>` |
| createdAt | optional / nullable | `Option<string>` |

### SnapshotCreateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| name | optional / nullable | `Option<string>` |

### SnapshotCreateToolOutput

Alias: `ToolCommandResult<SnapshotCreateResultData>`.

### SortColumn

| JSON field | Presence | Type |
| --- | --- | --- |
| column | required | `string` |
| direction | required | `SortDirection` |

### SortDirection

String enum; camelCase variant names (explicit rename takes precedence).

```text
ascending
descending
```

### SpecLimitsOverride

| JSON field | Presence | Type |
| --- | --- | --- |
| lsl | optional / nullable | `Option<number>` |
| target | optional / nullable | `Option<number>` |
| usl | optional / nullable | `Option<number>` |

### SqlCreateTableResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| datasetId | required | `string` |
| datasetName | required | `string` |
| outputTable | optional / nullable | `Option<TableDescribeResultData>` |

### SqlCreateTableToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sql | required | `string` |
| name | required | `string` |

### SqlCreateTableToolOutput

Alias: `ToolCommandResult<SqlCreateTableResultData>`.

### SummaryStatistic

String enum; camelCase variant names (explicit rename takes precedence).

```text
n
mean
std
min
max
sum
median
```

### TableCreateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| request | required | `CreateManagedTableRequest` |
| preview | optional / nullable | `Option<TablePreviewRequest>` |

### TableCreateToolOutput

Alias: `ToolCommandResult<TableDescribeResultData>`.

### TableDescribeColumn

| JSON field | Presence | Type |
| --- | --- | --- |
| colIndex | required | `integer >= 0` |
| colName | required | `string` |
| colType | required | `string` |
| width | optional / nullable | `Option<number>` |
| format | optional / nullable | `Option<ColumnFormatInfo>` |
| extras | optional / nullable | `Option<BTreeMap<string, JSON value>>` |

### TableDescribeResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| dataset | required | `TableListItem` |
| generation | required | `integer >= 0` |
| columns | required | `Vec<TableDescribeColumn>` |
| preview | optional / nullable | `Option<TablePreviewResult>` |

### TableDescribeToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| datasetId | required | `string` |
| preview | optional / nullable | `Option<TablePreviewRequest>` |

### TableDescribeToolOutput

Alias: `ToolCommandResult<TableDescribeResultData>`.

### TableExportCsvResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| targetStatus | required | `TableExportTargetStatus` |

### TableExportCsvToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| datasetId | required | `string` |
| rootId | required | `string` |
| relativePath | required | `string` |

### TableExportCsvToolOutput

Alias: `ToolCommandResult<TableExportCsvResultData>`.

### TableExportTargetStatus

String enum; camelCase variant names (explicit rename takes precedence).

```text
createNew
overwriteExisting
```

### TableFilterComparisonOperator

String enum; camelCase variant names (explicit rename takes precedence).

```text
equal
notEqual
greaterThan
greaterThanOrEqual
lessThan
lessThanOrEqual
```

### TableFilterExpression

Tagged object: discriminator `kind`; camelCase variant names and fields.

```text
logical { operator: TableFilterLogicalOperator, left: Box<TableFilterExpression>, right: Box<TableFilterExpression> }
not { expression: Box<TableFilterExpression> }
comparison { column: string, operator: TableFilterComparisonOperator, value: TableFilterScalar }
isNull { column: string, negated: boolean }
```

### TableFilterLogicalOperator

String enum; camelCase variant names (explicit rename takes precedence).

```text
and
or
```

### TableFilterScalar

Tagged object: discriminator `type`; camelCase variant names and fields.

```text
string { value: string } }
number { value: string } }
boolean { value: boolean } }
null
```

### TableListItem

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| name | required | `string` |
| sourceType | required | `string` |
| rowCount | required | `integer >= 0` |
| colCount | required | `integer >= 0` |
| generation | required | `integer >= 0` |
| createdAt | required | `string` |
| updatedAt | required | `string` |
| sourceName | optional / nullable | `Option<string>` |

### TableListResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| items | required | `Vec<TableListItem>` |
| nextCursor | optional / nullable | `Option<string>` |

### TableListToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| cursor | optional / nullable | `Option<string>` |
| limit | optional / nullable | `Option<integer >= 0>` |

### TableListToolOutput

Alias: `ToolCommandResult<TableListResultData>`.

### TablePreviewCell

| JSON field | Presence | Type |
| --- | --- | --- |
| colIndex | required | `integer >= 0` |
| value | required | `JSON value` |

### TablePreviewRequest

| JSON field | Presence | Type |
| --- | --- | --- |
| offset | optional / nullable | `Option<integer >= 0>` |
| limit | required | `integer >= 0` |

### TablePreviewResult

| JSON field | Presence | Type |
| --- | --- | --- |
| offset | required | `integer >= 0` |
| limit | required | `integer >= 0` |
| totalRows | required | `integer >= 0` |
| rows | required | `Vec<TablePreviewRow>` |

### TablePreviewRow

| JSON field | Presence | Type |
| --- | --- | --- |
| rowIndex | required | `integer >= 0` |
| cells | required | `Vec<TablePreviewCell>` |

### TableTransformBindingState

| JSON field | Presence | Type |
| --- | --- | --- |
| definitionId | required | `string` |
| definitionRevision | required | `integer >= 0` |
| inputs | required | `Vec<TableTransformInputBinding>` |
| outputGeneration | required | `integer >= 0` |
| lastRun | optional / nullable | `Option<TableTransformRunState>` |
| schemaReports | optional / nullable | `Option<Vec<TableTransformRoleSchemaReport>>` |

### TableTransformCommandData

| JSON field | Presence | Type |
| --- | --- | --- |
| execution | required | `TableTransformExecutionResult` |
| definition | optional / nullable | `Option<TableTransformDefinition>` |
| binding | optional / nullable | `Option<TableTransformBindingState>` |
| outputTable | optional / nullable | `Option<TableDescribeResultData>` |
| targetDatasetGeneration | optional / nullable | `Option<integer >= 0>` |

### TableTransformCreateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| draft | required | `TableTransformDraft` |

### TableTransformCreateToolOutput

Alias: `ToolCommandResult<TableTransformCommandData>`.

### TableTransformDefinition

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| name | required | `string` |
| formatVersion | required | `string` |
| revision | required | `integer >= 0` |
| operation | required | `TableTransformOperation` |
| inputSlots | required | `Vec<TableTransformInputSlot>` |
| output | required | `TableTransformOutput` |

### TableTransformDraft

| JSON field | Presence | Type |
| --- | --- | --- |
| name | required | `string` |
| outputName | required | `string` |
| operation | required | `TableTransformOperation` |
| inputBindings | required | `Vec<TableTransformInputBinding>` |

### TableTransformExecutionResult

| JSON field | Presence | Type |
| --- | --- | --- |
| definitionId | required | `string` |
| status | required | `TableTransformRunStatus` |
| output | optional / nullable | `Option<DatasetMeta>` |
| schemaReports | required | `Vec<TableTransformRoleSchemaReport>` |
| error | optional / nullable | `Option<string>` |
| binding | required | `TableTransformProjectBinding` |
| runState | required | `TableTransformRunState` |

### TableTransformInputBinding

| JSON field | Presence | Type |
| --- | --- | --- |
| role | required | `string` |
| tableDocumentId | required | `string` |

### TableTransformInputSlot

| JSON field | Presence | Type |
| --- | --- | --- |
| role | required | `string` |
| schemaContract | required | `SchemaContract` |

### TableTransformOperation

Tagged object: discriminator `kind`; camelCase variant names and fields.

```text
sort { sortColumns: Vec<SortColumn> }
subset { columns: Vec<string>, filter: nullable/optional <TableFilterExpression> }
transpose
stack { stackColumns: Vec<string>, idColumns: Vec<string> }
split { splitColumn: string, valueColumn: string, idColumns: Vec<string> }
summary { statisticColumns: Vec<string>, groupColumns: Vec<string>, statistics: Vec<SummaryStatistic> }
join { joinType: JoinType, leftKey: string, rightKey: string }
update { matchColumn: string, updateColumns: Vec<string> }
concatenate { sourceCount: integer }
```

### TableTransformOutput

| JSON field | Presence | Type |
| --- | --- | --- |
| tableDocumentId | required | `string` |
| name | required | `string` |

### TableTransformProjectBinding

| JSON field | Presence | Type |
| --- | --- | --- |
| definitionId | required | `string` |
| definitionRevision | required | `integer >= 0` |
| inputs | required | `Vec<TableTransformInputBinding>` |
| outputGeneration | required | `integer >= 0` |

### TableTransformRoleSchemaReport

| JSON field | Presence | Type |
| --- | --- | --- |
| role | required | `string` |
| report | required | `SchemaValidationReport` |

### TableTransformRunState

| JSON field | Presence | Type |
| --- | --- | --- |
| definitionRevision | required | `integer >= 0` |
| status | required | `TableTransformRunStatus` |
| outputGeneration | optional / nullable | `Option<integer >= 0>` |
| error | optional / nullable | `Option<string>` |

### TableTransformRunStatus

String enum; camelCase variant names (explicit rename takes precedence).

```text
succeeded
failed
blocked
```

### TableTransformRunToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| transformId | required | `string` |

### TableTransformRunToolOutput

Alias: `ToolCommandResult<TableTransformCommandData>`.

### TabulateCreateResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| item | required | `TabulateItem` |

### TabulateCreateToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| sourceDatasetId | required | `string` |

### TabulateCreateToolOutput

Alias: `ToolCommandResult<TabulateCreateResultData>`.

### TabulateItem

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| name | required | `string` |
| sourceDatasetId | required | `string` |
| rowFields | required | `Vec<string>` |
| columnFields | required | `Vec<string>` |
| statistics | required | `Vec<TabulateStatistic>` |
| includeRowTotals | required | `boolean` |
| includeColumnTotals | required | `boolean` |
| createdAt | required | `string` |

### TabulateRequest

| JSON field | Presence | Type |
| --- | --- | --- |
| datasetId | required | `string` |
| rowFields | required | `Vec<string>` |
| columnFields | required | `Vec<string>` |
| statistics | required | `Vec<TabulateStatistic>` |
| includeRowTotals | required | `boolean` |
| includeColumnTotals | required | `boolean` |

### TabulateRunResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| tabulateId | required | `string` |
| requestFingerprint | required | `string` |
| sourceGeneration | required | `integer >= 0` |
| completedAt | required | `string` |
| session | required | `TabulateSessionSummary` |
| leaseReleased | required | `boolean` |
| cacheValid | required | `boolean` |

### TabulateRunToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| tabulateId | required | `string` |
| request | required | `TabulateRequest` |

### TabulateRunToolOutput

Alias: `ToolCommandResult<TabulateRunResultData>`.

### TabulateSessionIdentity

| JSON field | Presence | Type |
| --- | --- | --- |
| sessionId | required | `string` |
| fingerprint | required | `string` |
| sourceGeneration | required | `integer >= 0` |

### TabulateSessionState

String enum; camelCase variant names (explicit rename takes precedence).

```text
preparing
ready
cancelled
failed
```

### TabulateSessionSummary

| JSON field | Presence | Type |
| --- | --- | --- |
| sessionId | required | `string` |
| fingerprint | required | `string` |
| sourceGeneration | required | `integer >= 0` |
| state | required | `TabulateSessionState` |
| rowMemberCount | required | `integer >= 0` |
| columnMemberCount | required | `integer >= 0` |
| logicalCellCount | required | `integer >= 0` |
| measuredMemberIndexBytes | required | `integer >= 0` |
| failureCode | optional / nullable | `Option<string>` |

### TabulateStatistic

| JSON field | Presence | Type |
| --- | --- | --- |
| id | required | `string` |
| field | required | `string` |
| kind | required | `TabulateStatisticKind` |
| quantile | optional / nullable | `Option<number>` |

### TabulateStatisticKind

String enum; camelCase variant names (explicit rename takes precedence).

```text
count
missingCount
uniqueCount
sum
mean
standardDeviation
variance
minimum
maximum
median
range
quantile
rowPercentage
columnPercentage
totalPercentage
```

### TabulateToTableResultData

| JSON field | Presence | Type |
| --- | --- | --- |
| outputTable | optional / nullable | `Option<TableDescribeResultData>` |
| reran | required | `boolean` |
| requestFingerprint | required | `string` |
| sourceGeneration | required | `integer >= 0` |

### TabulateToTableToolInput

| JSON field | Presence | Type |
| --- | --- | --- |
| tabulateId | required | `string` |
| request | required | `TabulateRequest` |
| tableName | required | `string` |
| session | optional / nullable | `Option<TabulateSessionIdentity>` |

### TabulateToTableToolOutput

Alias: `ToolCommandResult<TabulateToTableResultData>`.

### ToolCommandResult

| JSON field | Presence | Type |
| --- | --- | --- |
| requestId | required | `string` |
| command | required | `string` |
| changed | required | `boolean` |
| projectRevision | required | `integer >= 0` |
| data | required | `T` |
| warnings | required | `Vec<CommandWarning>` |

## Variant recipes and constraints

Distribution create: responses (FieldRef[]), weight/frequency/nestedSubgroup (nullable FieldRef), by (FieldRef[]); optional name, analysis and graphs. Analysis contains confidenceLevel, specLimits keyed by response name, fitDistributions and default-false fitAll. Fit names are normal, cauchy, lognormal, exponential, gamma, weibull. Set fitAll explicitly to avoid dependence on defaults. Spec override values use lsl/target/usl nullable numbers; do not derive specs from observed extrema. Full graphs has overview, boxPlot, ecdf and normalQuantile EmbeddedGraphConfig. Distribution update requires analysis and graphs; no name field.

FitYByX create/update: response, factor, confidenceLevel; optional graph; optional name only at creation. Factor measurement type determines oneway/bivariate personality. FitModel create/update: response, construct, terms, centeringMethod; optional confidenceLevel and creation-only name. Construct is tagged kind manual/fullFactorial/factorialToDegree (degree)/responseSurface. Terms are kind main/interaction/power with columnNames; power also exponent. centeringMethod is none/mean. HypothesisTest create takes definition and optional name; update takes definition and optional presentation. Definition requires kind, roles, studyDesign, selectionMode, nullable manualSelection, alternative, alpha, confidenceLevel, levelOrder, nullable referenceLevel, postHoc and selectorVersion. Preserve known selectorVersion from existing documents; do not invent supported versions.

FieldRef measurement types are continuous, nominal, ordinal, datetime, id; columnId is optional. A DuckDB SQL type is different from a measurement type. Numeric identifier columns should not automatically be treated as continuous responses.

Graph definition always contains all three modeStates: twoD, threeD, multivariate. ChartElement requires kind and enabled; options/correlationMethod are optional. sampling is {"mode":"full"} or {"mode":"sample","size":1000,"seed":42}; mode is 2d, 3d or multivariate. Axis extras are flattened keys rather than a nested extras field. GraphFilterRuleItem.op is uppercase AND/OR. Filters are part of EmbeddedGraphConfig, not arbitrary top-level GraphBuilderItem fields. Preserve the returned graph definition when editing one encoding.

Transform operation is tagged kind: sort (sortColumns), subset (columns, optional filter), transpose, stack (stackColumns/idColumns), split (splitColumn/valueColumn/idColumns), summary (statisticColumns/groupColumns/statistics), join (joinType/leftKey/rightKey), update (matchColumn/updateColumns), concatenate (sourceCount). Sort direction ascending/descending. Summary statistics n/mean/std/min/max/sum/median. Join type inner/left/right/full. Filter numbers are typed scalars {"type":"number","value":"10.2"}: value is a string, not a JSON number. Validate bindings against the operation; do not assume every operation uses source role.

Tabulate kinds: count, missingCount, uniqueCount, sum, mean, standardDeviation, variance, minimum, maximum, median, range, quantile, rowPercentage, columnPercentage, totalPercentage. Each statistic needs id, field, kind; quantile uses a probability in quantile. Requests are complete, not patches. A ready session is metadata; exportTable then table.describe provides accessible result rows.

Confidence levels/probabilities need valid ranges, SQL column types must be supported, and finite numeric values must be valid JSON. Verify runtime/domain validation and reason codes; permissive numeric schemas do not guarantee applicability. Table exports need a configured root and can require UI confirmation for overwrites; this catalog rejects all trusted-confirmation flags in tool arguments.

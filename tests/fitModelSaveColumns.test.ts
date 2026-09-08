import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_FIT_MODEL_SAVED_METRICS,
  FIT_MODEL_SAVED_METRICS,
  getFitModelSavedMetricAvailability,
  getFitModelSavedMetricUnavailableReason,
} from "../src/components/fitModel/FitModelSaveColumnsDialog.tsx";
import { runFitModelSaveColumnsLifecycle } from "../src/components/fitModel/fitModelSaveColumnsLifecycle.ts";
import type { FitModelFittedResult } from "../src/types/fitModel.ts";

const ROOT = process.cwd();
const readSource = (relativePath: string) =>
  readFileSync(path.resolve(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");

assert.deepEqual(FIT_MODEL_SAVED_METRICS, [
  "predicted",
  "residual",
  "studentizedResidual",
  "leverage",
  "cooksDistance",
  "meanConfidenceLower",
  "meanConfidenceUpper",
  "predictionLower",
  "predictionUpper",
]);
assert.deepEqual(DEFAULT_FIT_MODEL_SAVED_METRICS, FIT_MODEL_SAVED_METRICS.slice(0, 5));

const fitted = {
  kind: "fitted",
  usedRows: 1,
  availableSavedMetrics: [
    "predicted",
    "residual",
    "studentizedResidual",
    "leverage",
  ],
  diagnostics: {
    rows: [{
      fitted: 10,
      residual: 1,
      studentizedResidual: null,
      leverage: 0.25,
      cooksDistance: null,
      meanConfidenceLower: null,
      meanConfidenceUpper: null,
      predictionLower: null,
      predictionUpper: null,
    }],
  },
} as FitModelFittedResult;
const availability = getFitModelSavedMetricAvailability(fitted);
assert.equal(availability.predicted, true);
assert.equal(availability.residual, true);
assert.equal(availability.leverage, true);
assert.equal(availability.studentizedResidual, true);
assert.equal(availability.cooksDistance, false);
assert.equal(availability.meanConfidenceLower, false);
assert.equal(availability.predictionUpper, false);
fitted.diagnostics.qqReason = "insufficientDiagnosticRows";
assert.equal(
  getFitModelSavedMetricUnavailableReason(fitted, "cooksDistance"),
  "insufficientDiagnosticRows",
);
assert.equal(getFitModelSavedMetricUnavailableReason(fitted, "leverage"), null);

const lifecycleEvents: string[] = [];
const committedOutcome = await runFitModelSaveColumnsLifecycle({
  save: async () => {
    lifecycleEvents.push("saved");
    return { changeSetId: "change-1" };
  },
  onCommitted: () => lifecycleEvents.push("closed"),
  afterCommit: async () => {
    lifecycleEvents.push("refresh");
    throw new Error("refresh failed");
  },
});
assert.deepEqual(lifecycleEvents, ["saved", "closed", "refresh"]);
assert.equal(committedOutcome.status, "committed");
assert.match(String(committedOutcome.postCommitError), /refresh failed/);

let committedAfterFailure = false;
const failedOutcome = await runFitModelSaveColumnsLifecycle({
  save: async () => { throw new Error("stale generation"); },
  onCommitted: () => { committedAfterFailure = true; },
  afterCommit: async () => undefined,
});
assert.equal(failedOutcome.status, "saveFailed");
assert.equal(committedAfterFailure, false);

const serviceSource = readSource("src/services/fitModelService.ts");
assert.match(serviceSource, /invoke<SaveFitModelColumnsResult>\("save_fit_model_columns", \{ request \}\)/);

const viewSource = readSource("src/components/fitModel/FitModelView.tsx");
assert.match(viewSource, /tryBeginTableMutation\(\)/);
assert.match(viewSource, /fitModelService\.saveColumns\(/);
assert.match(viewSource, /recordTable\([\s\S]*kind: "changeSet"[\s\S]*changeSetId: result\.changeSetId/);
assert.match(viewSource, /await onDatasetChanged\(\)/);
assert.match(viewSource, /outcome\.postCommitError[\s\S]*setSaveNotice\(/);

const workspaceSource = readSource("src/components/Workspace.tsx");
assert.match(workspaceSource, /<FitModelView[\s\S]*readOnly=\{readOnly\}/);
assert.match(workspaceSource, /onDatasetChanged=\{async \(\) => \{[\s\S]*markDirty\(\);[\s\S]*await refreshDatasets\(\);/);

console.log("fitModelSaveColumns tests passed");

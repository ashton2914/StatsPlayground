import assert from "node:assert/strict";

import { createFitModelItem } from "../src/components/fitModel/fitModelConfig.ts";
import { createFitModelRequest } from "../src/components/fitModel/useFitModelReport.ts";
import { useFitModelStore } from "../src/stores/useFitModelStore.ts";
import { useFolderStore } from "../src/stores/useFolderStore.ts";

const fitModel = createFitModelItem({
  id: "fit-model-1",
  name: "Fit Model 1",
  sourceDatasetId: "table-1",
  response: { name: "height", type: "continuous" },
  terms: [
    { kind: "main", columnNames: ["age"] },
    { kind: "main", columnNames: ["dose"] },
    { kind: "interaction", columnNames: ["dose", "age"] },
  ],
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
  fields: [
    { name: "height", type: "continuous" },
    { name: "age", type: "continuous" },
    { name: "dose", type: "continuous" },
  ],
});

const fitModelWithTransient = {
  ...fitModel,
  result: { kind: "fitted" },
  plotRows: [{ rowIndex: 1 }],
  reportState: { anova: true },
};

const openResult = {
  project: { name: "Project", filePath: "project.spprj", createdAt: "now" },
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  fitModels: [fitModelWithTransient],
  tabulates: [],
  distributions: [],
  derivedFormulas: [],
  distributionIssues: [],
  folders: ["Analyses", "Analyses/Fit Models"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  fitModelFolders: { "fit-model-1": "Analyses/Fit Models" },
  tabulateFolders: {},
  distributionFolders: {},
  datasetNameMigrations: [],
};

const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        invokeCalls.push({ command, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
        if (command === "open_project") return openResult;
        return openResult.project;
      },
    },
  },
});

const { projectService } = await import("../src/services/projectService.ts");

await projectService.saveProject({
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  fitModels: [fitModelWithTransient],
  tabulates: [],
  distributions: [],
  derivedFormulas: [],
  distributionIssues: [],
  folders: ["Analyses", "Analyses/Fit Models"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  fitModelFolders: { "fit-model-1": "Analyses/Fit Models" },
  tabulateFolders: {},
  distributionFolders: {},
});

const reopened = await projectService.openProject("project.spprj");
assert.deepEqual(invokeCalls[0], {
  command: "save_project",
  args: {
    request: {
      history: [],
      snapshots: [],
      graphBuilders: [],
      fitYByX: [],
      fitModels: [fitModelWithTransient],
      tabulates: [],
      distributions: [],
      derivedFormulas: [],
      distributionIssues: [],
      folders: ["Analyses", "Analyses/Fit Models"],
      tableFolders: {},
      graphFolders: {},
      fitYByXFolders: {},
      fitModelFolders: { "fit-model-1": "Analyses/Fit Models" },
      tabulateFolders: {},
      distributionFolders: {},
    },
    onProgress: "__CHANNEL__:1",
  },
});

assert.deepEqual(reopened.fitModels, [fitModelWithTransient]);
assert.deepEqual(reopened.fitModelFolders, { "fit-model-1": "Analyses/Fit Models" });

useFitModelStore.getState().loadFromProject(reopened.fitModels ?? []);
const normalized = useFitModelStore.getState().items[0] as Record<string, unknown>;
assert.equal(normalized.id, "fit-model-1");
assert.deepEqual(normalized.construct, { kind: "manual" });
assert.equal(Object.hasOwn(normalized, "result"), false);
assert.equal(Object.hasOwn(normalized, "plotRows"), false);
assert.equal(Object.hasOwn(normalized, "reportState"), false);

const generatedRequest = createFitModelRequest(useFitModelStore.getState().items[0]!, 3);
assert.deepEqual(generatedRequest, {
  datasetId: "table-1",
  generation: 3,
  responseColumn: "height",
  terms: [
    { kind: "main", columnNames: ["age"] },
    { kind: "main", columnNames: ["dose"] },
    { kind: "interaction", columnNames: ["age", "dose"] },
  ],
  centeringMethod: "mean",
  confidenceLevel: 0.95,
});

useFolderStore.getState().loadFromProject({
  folders: [],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  fitModelFolders: { "fit-model-1": "/Analyses//Fit Models/" },
  tabulateFolders: {},
  distributionFolders: {},
});
assert.deepEqual(useFolderStore.getState().fitModelFolders, {
  "fit-model-1": "Analyses/Fit Models",
});

useFitModelStore.getState().reset();
useFolderStore.getState().reset();
console.log("fit model archive contracts OK");

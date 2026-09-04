import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import type { DistributionItem } from "../src/types/distribution.ts";

const projectTypesSource = readFileSync(
  new URL("../src/types/project.ts", import.meta.url),
  "utf8",
);
const projectServiceSource = readFileSync(
  new URL("../src/services/projectService.ts", import.meta.url),
  "utf8",
);
assert.match(projectTypesSource, /distributions:\s*DistributionItem\[\]/);
assert.match(projectTypesSource, /distributionFolders:\s*Record<string, string>/);
assert.match(projectServiceSource, /distributions:\s*DistributionItem\[\]/);
assert.match(projectServiceSource, /distributionFolders:\s*Record<string, string>/);

const response = { name: "Revenue", type: "continuous" as const };
const distribution = createDistributionItem({
  id: "dist-001",
  name: "Distribution 1",
  sourceDatasetId: "ds-42",
  responses: [response],
  weight: null,
  frequency: null,
  by: [],
  columns: [{
    name: response.name,
    sqlType: "DOUBLE",
    integerCompatible: false,
    field: response,
  }],
  analysis: {
    confidenceLevel: 0.95,
    specLimits: { Revenue: { lsl: 10, target: 15, usl: 20 } },
    fitDistributions: ["normal", "weibull"],
  },
  createdAt: "2026-09-02T00:00:00.000Z",
});
const openResult = {
  project: { name: "Project", filePath: "project.spprj", createdAt: "now" },
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [distribution],
  folders: ["Analyses", "Analyses/Revenue"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  tabulateFolders: {},
  distributionFolders: { "dist-001": "Analyses/Revenue" },
  datasetNameMigrations: [],
  documentNameMigrations: [],
  requiresMigration: false,
};
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        invokeCalls.push({ command, args });
        if (command === "open_project") return openResult;
        return openResult.project;
      },
    },
  },
});

const { projectService } = await import("../src/services/projectService.ts");
const folders = {
  folders: ["Analyses", "Analyses/Revenue"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  distributionFolders: { "dist-001": "Analyses/Revenue" },
};
await projectService.saveProject({
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [distribution],
  folders: folders.folders,
  tableFolders: folders.tableFolders,
  graphFolders: folders.graphFolders,
  fitYByXFolders: {},
  tabulateFolders: folders.tabulateFolders,
  distributionFolders: folders.distributionFolders,
});
const reopened = await projectService.openProject("project.spprj");

assert.equal(invokeCalls[0]?.command, "save_project");
assert.deepEqual(invokeCalls[0]?.args.request, {
      history: [],
      snapshots: [],
      graphBuilders: [],
      fitYByX: [],
      tabulates: [],
      distributions: [distribution],
      folders: ["Analyses", "Analyses/Revenue"],
      tableFolders: {},
      graphFolders: {},
      fitYByXFolders: {},
      tabulateFolders: {},
      distributionFolders: { "dist-001": "Analyses/Revenue" },
});
assert.deepEqual(reopened.distributions, [distribution]);
assert.deepEqual(reopened.distributionFolders, {
  "dist-001": "Analyses/Revenue",
});

const { useDistributionStore } = await import("../src/stores/useDistributionStore.ts");
const { useFolderStore } = await import("../src/stores/useFolderStore.ts");
useDistributionStore.getState().loadFromProject(reopened.distributions as DistributionItem[]);
useFolderStore.getState().loadFromProject(reopened);
assert.deepEqual(useDistributionStore.getState().items, [distribution]);
assert.deepEqual(useFolderStore.getState().distributionFolders, {
  "dist-001": "Analyses/Revenue",
});

useDistributionStore.getState().reset();
useFolderStore.getState().reset();
assert.deepEqual(useDistributionStore.getState().items, []);
assert.deepEqual(useFolderStore.getState().distributionFolders, {});

console.log("distribution archive contracts OK");
import assert from "node:assert/strict";

import { useProjectStore } from "../src/stores/useProjectStore.ts";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

Object.assign(globalThis, { localStorage: createStorage() });

const { useFolderStore } = await import("../src/stores/index.ts");

function resetStore() {
  useProjectStore.setState({ readOnly: false });
  useFolderStore.getState().reset();
}

resetStore();

(useFolderStore.getState() as unknown as {
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders: Record<string, string>;
    fitModelFolders: Record<string, string>;
    distributionFolders: Record<string, string>;
  }) => void;
}).loadFromProject({
  folders: ["analysis"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  fitModelFolders: {
    "fit-model-1": "//analysis//fit-model//",
  },
  distributionFolders: {},
});

assert.deepEqual(useFolderStore.getState().folders, ["analysis", "analysis/fit-model"]);
assert.deepEqual(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders,
  { "fit-model-1": "analysis/fit-model" },
);

const movedPath = useFolderStore.getState().moveFolder("analysis/fit-model", "archive");
assert.equal(movedPath, "archive/fit-model");
assert.equal(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders["fit-model-1"],
  "archive/fit-model",
);

const renamedPath = useFolderStore.getState().renameFolder("archive/fit-model", "models");
assert.equal(renamedPath, "archive/models");
assert.equal(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders["fit-model-1"],
  "archive/models",
);

(useFolderStore.getState() as unknown as {
  setFitModelFolder: (id: string, folder: string | null) => void;
}).setFitModelFolder("fit-model-2", "drafts/review");
assert.equal(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders["fit-model-2"],
  "drafts/review",
);

(useFolderStore.getState() as unknown as {
  setFitModelFolder: (id: string, folder: string | null) => void;
}).setFitModelFolder("fit-model-2", null);
assert.equal(
  Object.hasOwn((useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders, "fit-model-2"),
  false,
);

useFolderStore.getState().deleteFolder("archive");
assert.equal(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders["fit-model-1"],
  "models",
);

(useFolderStore.getState() as unknown as {
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validDistributionIds: Set<string>,
    validReportIds: Set<string>,
    validFitModelIds: Set<string>,
  ) => void;
}).pruneAssignments(new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set(["fit-model-1"]));

assert.deepEqual(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders,
  { "fit-model-1": "models" },
);

resetStore();

(useFolderStore.getState() as unknown as {
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders: Record<string, string>;
    fitModelFolders: Record<string, string>;
    distributionFolders: Record<string, string>;
  }) => void;
}).loadFromProject({
  folders: ["analysis"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  fitModelFolders: {},
  distributionFolders: {
    "dist-keep": "analysis/distributions",
    "dist-stale": "analysis/old",
  },
});

(useFolderStore.getState() as unknown as {
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validDistributionIds: Set<string>,
  ) => void;
}).pruneAssignments(new Set(), new Set(), new Set(), new Set(), new Set(["dist-keep"]));

assert.deepEqual(
  (useFolderStore.getState() as unknown as { distributionFolders: Record<string, string> }).distributionFolders,
  { "dist-keep": "analysis/distributions" },
);

useFolderStore.getState().reset();
assert.deepEqual(
  (useFolderStore.getState() as unknown as { fitModelFolders: Record<string, string> }).fitModelFolders,
  {},
);

console.log("folder store fitModel assignments passed");

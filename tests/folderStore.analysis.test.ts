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

type AnalysisFolderStore = {
  folders: string[];
  analysisFolders: Record<string, string>;
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders: Record<string, string>;
    reportFolders: Record<string, string>;
    distributionFolders: Record<string, string>;
    analysisFolders: Record<string, string>;
  }) => void;
  setAnalysisFolder: (analysisId: string, folder: string | null) => void;
  renameFolder: (oldPath: string, newBaseName: string) => string | null;
  deleteFolder: (path: string) => void;
  moveFolder: (path: string, newParent: string | null) => string | null;
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validDistributionIds: Set<string>,
    validReportIds: Set<string>,
    validAnalysisIds: Set<string>,
  ) => void;
  reset: () => void;
};

const folderStore = () => useFolderStore.getState() as unknown as AnalysisFolderStore;

assert.equal(typeof folderStore().setAnalysisFolder, "function");

folderStore().loadFromProject({
  folders: ["analyses"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  reportFolders: {},
  distributionFolders: {},
  analysisFolders: {
    "analysis-1": "//analyses//distribution//",
  },
});

assert.deepEqual(folderStore().folders, ["analyses", "analyses/distribution"]);
assert.deepEqual(folderStore().analysisFolders, { "analysis-1": "analyses/distribution" });

folderStore().setAnalysisFolder("analysis-2", "drafts/review");
assert.deepEqual(folderStore().analysisFolders["analysis-2"], "drafts/review");

folderStore().setAnalysisFolder("analysis-2", null);
assert.equal(Object.hasOwn(folderStore().analysisFolders, "analysis-2"), false);

folderStore().setAnalysisFolder("analysis-3", "analyses/distribution/archive");
assert.deepEqual(folderStore().analysisFolders["analysis-3"], "analyses/distribution/archive");

assert.equal(folderStore().renameFolder("analyses/distribution", "saved"), "analyses/saved");
assert.deepEqual(folderStore().analysisFolders["analysis-1"], "analyses/saved");
assert.deepEqual(folderStore().analysisFolders["analysis-3"], "analyses/saved/archive");

folderStore().deleteFolder("analyses");
assert.deepEqual(folderStore().analysisFolders["analysis-1"], "saved");
assert.deepEqual(folderStore().analysisFolders["analysis-3"], "saved/archive");

assert.equal(folderStore().moveFolder("saved", "archive"), "archive/saved");
assert.deepEqual(folderStore().analysisFolders["analysis-1"], "archive/saved");
assert.deepEqual(folderStore().analysisFolders["analysis-3"], "archive/saved/archive");

folderStore().setAnalysisFolder("analysis-4", "archive/saved/temp");
folderStore().pruneAssignments(new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set(["analysis-1", "analysis-4"]));
assert.deepEqual(folderStore().analysisFolders, {
  "analysis-1": "archive/saved",
  "analysis-4": "archive/saved/temp",
});

folderStore().reset();
assert.deepEqual(folderStore().folders, []);
assert.deepEqual(folderStore().analysisFolders, {});

useProjectStore.setState({ readOnly: true });
assert.throws(() => folderStore().setAnalysisFolder("blocked", "root"), /read-only/i);
assert.throws(() => folderStore().renameFolder("archive", "renamed"), /read-only/i);
assert.throws(() => folderStore().deleteFolder("archive"), /read-only/i);
assert.throws(() => folderStore().moveFolder("archive", null), /read-only/i);

console.log("folder store analysis assignments passed");
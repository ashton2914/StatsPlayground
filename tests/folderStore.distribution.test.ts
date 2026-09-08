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

useFolderStore.getState().loadFromProject({
  folders: ["analysis"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  distributionFolders: {
    "distribution-1": "//analysis//distribution//",
  },
});

assert.deepEqual(useFolderStore.getState().folders, ["analysis", "analysis/distribution"]);
assert.deepEqual(useFolderStore.getState().distributionFolders, {
  "distribution-1": "analysis/distribution",
});

const movedPath = useFolderStore.getState().moveFolder("analysis/distribution", "archive");
assert.equal(movedPath, "archive/distribution");
assert.equal(useFolderStore.getState().distributionFolders["distribution-1"], "archive/distribution");

const renamedPath = useFolderStore.getState().renameFolder("archive/distribution", "models");
assert.equal(renamedPath, "archive/models");
assert.equal(useFolderStore.getState().distributionFolders["distribution-1"], "archive/models");

useFolderStore.getState().setDistributionFolder("distribution-2", "drafts/review");
assert.equal(useFolderStore.getState().distributionFolders["distribution-2"], "drafts/review");

useFolderStore.getState().deleteFolder("archive");
assert.equal(useFolderStore.getState().distributionFolders["distribution-1"], "models");

useFolderStore.getState().pruneAssignments(
  new Set(),
  new Set(),
  new Set(),
  new Set(),
  new Set(["distribution-1"]),
);
assert.deepEqual(useFolderStore.getState().distributionFolders, { "distribution-1": "models" });

useFolderStore.getState().reset();
assert.deepEqual(useFolderStore.getState().distributionFolders, {});

useProjectStore.setState({ readOnly: true });
assert.throws(
  () => useFolderStore.getState().setDistributionFolder("distribution-3", "locked"),
  /read-only/i,
);
assert.deepEqual(useFolderStore.getState().distributionFolders, {});

useProjectStore.setState({ readOnly: false });
console.log("folder store Distribution assignments passed");
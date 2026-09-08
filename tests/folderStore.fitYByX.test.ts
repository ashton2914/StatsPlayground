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
  }) => void;
}).loadFromProject({
  folders: ["analysis"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {
    "fit-1": "//analysis//fit//",
  },
});

assert.deepEqual(useFolderStore.getState().folders, ["analysis", "analysis/fit"]);
assert.deepEqual(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders,
  { "fit-1": "analysis/fit" },
);

const movedPath = useFolderStore.getState().moveFolder("analysis/fit", "archive");
assert.equal(movedPath, "archive/fit");
assert.equal(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders["fit-1"],
  "archive/fit",
);

const renamedPath = useFolderStore.getState().renameFolder("archive/fit", "models");
assert.equal(renamedPath, "archive/models");
assert.equal(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders["fit-1"],
  "archive/models",
);

(useFolderStore.getState() as unknown as {
  setFitYByXFolder: (id: string, folder: string | null) => void;
}).setFitYByXFolder("fit-2", "drafts/review");
assert.equal(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders["fit-2"],
  "drafts/review",
);

useFolderStore.getState().deleteFolder("archive");
assert.equal(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders["fit-1"],
  "models",
);

(useFolderStore.getState() as unknown as {
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
  ) => void;
}).pruneAssignments(new Set(), new Set(), new Set(), new Set(["fit-1"]));

assert.deepEqual(
  (useFolderStore.getState() as unknown as { fitYByXFolders: Record<string, string> }).fitYByXFolders,
  { "fit-1": "models" },
);

console.log("folder store fitYByX assignments passed");
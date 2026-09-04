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

type ReportFolderStore = {
  folders: string[];
  reportFolders: Record<string, string>;
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders: Record<string, string>;
    reportFolders: Record<string, string>;
  }) => void;
  setReportFolder: (reportId: string, folder: string | null) => void;
  renameFolder: (oldPath: string, newBaseName: string) => string | null;
  deleteFolder: (path: string) => void;
  moveFolder: (path: string, newParent: string | null) => string | null;
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validReportIds: Set<string>,
  ) => void;
  reset: () => void;
};

const folderStore = () => useFolderStore.getState() as unknown as ReportFolderStore;

assert.equal(typeof folderStore().setReportFolder, "function");

folderStore().loadFromProject({
  folders: ["analysis"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  reportFolders: {
    "report-1": "//analysis//reports//",
  },
});

assert.deepEqual(folderStore().folders, ["analysis", "analysis/reports"]);
assert.deepEqual(folderStore().reportFolders, { "report-1": "analysis/reports" });

folderStore().setReportFolder("report-2", "drafts/review");
assert.deepEqual(folderStore().reportFolders["report-2"], "drafts/review");

folderStore().setReportFolder("report-2", null);
assert.equal(Object.hasOwn(folderStore().reportFolders, "report-2"), false);

folderStore().setReportFolder("report-3", "analysis/reports/archive");
assert.deepEqual(folderStore().reportFolders["report-3"], "analysis/reports/archive");

assert.equal(folderStore().renameFolder("analysis/reports", "findings"), "analysis/findings");
assert.deepEqual(folderStore().reportFolders["report-1"], "analysis/findings");
assert.deepEqual(folderStore().reportFolders["report-3"], "analysis/findings/archive");

folderStore().deleteFolder("analysis");
assert.deepEqual(folderStore().reportFolders["report-1"], "findings");
assert.deepEqual(folderStore().reportFolders["report-3"], "findings/archive");

assert.equal(folderStore().moveFolder("findings", "archive"), "archive/findings");
assert.deepEqual(folderStore().reportFolders["report-1"], "archive/findings");
assert.deepEqual(folderStore().reportFolders["report-3"], "archive/findings/archive");

folderStore().setReportFolder("report-4", "archive/findings/temp");
folderStore().pruneAssignments(new Set(), new Set(), new Set(), new Set(), new Set(), new Set(["report-1", "report-4"]));
assert.deepEqual(folderStore().reportFolders, {
  "report-1": "archive/findings",
  "report-4": "archive/findings/temp",
});

folderStore().reset();
assert.deepEqual(folderStore().folders, []);
assert.deepEqual(folderStore().reportFolders, {});

useProjectStore.setState({ readOnly: true });
assert.throws(() => folderStore().setReportFolder("blocked", "root"), /read-only/i);
assert.throws(() => folderStore().renameFolder("archive", "renamed"), /read-only/i);
assert.throws(() => folderStore().deleteFolder("archive"), /read-only/i);
assert.throws(() => folderStore().moveFolder("archive", null), /read-only/i);

console.log("folder store report assignments passed");
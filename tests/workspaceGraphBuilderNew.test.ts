import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useFolderStore } from "../src/stores/useFolderStore.ts";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useHistoryStore } from "../src/stores/useHistoryStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";

const originalRandomUuid = crypto.randomUUID;
const sessionId = "00000000-0000-4000-8000-000000000221";
const replacementSessionId = "00000000-0000-4000-8000-000000000222";
let nextSessionId: ReturnType<typeof crypto.randomUUID> | undefined = sessionId;

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

crypto.randomUUID = () => {
  const id = nextSessionId ?? originalRandomUuid.call(crypto);
  nextSessionId = undefined;
  return id;
};

try {
  useGraphBuilderNewStore.setState({ sessions: [] });

  useProjectStore.setState({ dirty: false, readOnly: false });
  const first = useGraphBuilderNewStore.getState().open("dataset-1", 17);
  const firstTransport = useGraphBuilderNewStore.getState().sessions[0].transportId;
  assert.notEqual(firstTransport, first, "transport identity is separate from durable identity");
  useGraphBuilderNewStore.getState().setColumns(first, "column-x", "column-y");
  useGraphBuilderNewStore.getState().setModes(first, "duration", "pointsLine");
  nextSessionId = replacementSessionId;
  const second = useGraphBuilderNewStore.getState().open("dataset-2", 4);
  assert.equal(useGraphBuilderNewStore.getState().sessions.length, 2, "opening a second graph preserves the first");
  assert.equal(useGraphBuilderNewStore.getState().items.length, 2);
  assert.equal(useProjectStore.getState().dirty, true);
  const camera = { xMin: 1.000000000000001, xMax: 51.00000000000001, yMin: -25, yMax: 25 };
  useGraphBuilderNewStore.getState().setCamera(first, camera);
  camera.xMin = 2;
  assert.equal(useGraphBuilderNewStore.getState().items[0].camera?.xMin, 1.000000000000001, "camera is copied without precision loss");
  useGraphBuilderNewStore.getState().setMean(first, false);
  useGraphBuilderNewStore.getState().setModes(first, "duration", "line");
  useGraphBuilderNewStore.getState().renameItem(first, "Durations");
  const persistedCamera = useGraphBuilderNewStore.getState().items[0].camera;
  assert.equal(persistedCamera?.xMin, 1.000000000000001, "Mean and raw mode preserve camera");
  useProjectStore.setState({ dirty: false });
  useGraphBuilderNewStore.getState().close(first);
  assert.equal(useProjectStore.getState().dirty, false, "close is runtime-only");
  assert.equal(useGraphBuilderNewStore.getState().items.length, 2, "close retains the durable definition");
  const saved = JSON.parse(JSON.stringify(useGraphBuilderNewStore.getState().items));
  assert.equal("datasetGeneration" in saved[0], false);
  assert.deepEqual(Object.keys(saved[0]).sort(), ["version", "id", "name", "datasetId", "xColumnId", "yColumnId", "showMean", "xMode", "rawMode", "camera"].sort());
  useGraphBuilderNewStore.getState().reset();
  useProjectStore.setState({ dirty: false });
  useGraphBuilderNewStore.getState().loadFromProject(saved);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, []);
  assert.equal(useProjectStore.getState().dirty, false);
  assert.equal(useGraphBuilderNewStore.getState().reopen(first, 29), first);
  assert.equal(useGraphBuilderNewStore.getState().reopen(second, 31), second);
  const reopenedTransport = useGraphBuilderNewStore.getState().sessions[0].transportId;
  assert.notEqual(reopenedTransport, firstTransport, "hydration and reopen allocate fresh transport identity");
  assert.notEqual(reopenedTransport, useGraphBuilderNewStore.getState().sessions[1].transportId);
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].datasetGeneration, 29);
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].xColumnId, "column-x");
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].rawMode, "line");
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions[0].camera, persistedCamera);
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].name, "Durations");
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].showMean, false);
  assert.equal(useProjectStore.getState().dirty, false, "reopen does not dirty a project");
  assert.equal(useGraphBuilderNewStore.getState().reopen("missing", 3), null);
  useGraphBuilderNewStore.getState().reopen(first, 29);
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].transportId, reopenedTransport, "matching live reopen retains transport identity");
  assert.equal(useGraphBuilderNewStore.getState().sessions.length, 2, "reopen is idempotent");
  assert.deepEqual(useGraphBuilderNewStore.getState().items, saved);
  const beforeNoOps = useGraphBuilderNewStore.getState();
  for (const name of ["a".repeat(256), "界".repeat(86), "CON.txt", "bad/name", "bad\u0085name", " padded", "tail."]) {
    assert.throws(() => useGraphBuilderNewStore.getState().renameItem(first, name), /project_name_/);
    assert.strictEqual(useGraphBuilderNewStore.getState(), beforeNoOps, "invalid direct rename preserves sessions and definitions");
    assert.equal(useProjectStore.getState().dirty, false);
  }
  useGraphBuilderNewStore.getState().setColumns(first, "column-x", "column-y");
  useGraphBuilderNewStore.getState().setMean(first, false);
  useGraphBuilderNewStore.getState().setModes(first, "duration", "line");
  useGraphBuilderNewStore.getState().setCamera(first, { ...persistedCamera! });
  useGraphBuilderNewStore.getState().renameItem(first, "Durations");
  useGraphBuilderNewStore.getState().deleteItem("missing");
  useGraphBuilderNewStore.getState().deleteByDataset("missing");
  useGraphBuilderNewStore.getState().setCamera("missing", null);
  assert.strictEqual(useGraphBuilderNewStore.getState(), beforeNoOps, "no-op calls do not notify or dirty");
  assert.equal(useProjectStore.getState().dirty, false);
  useProjectStore.setState({ readOnly: true });
  for (const mutate of [
    () => useGraphBuilderNewStore.getState().open("dataset-3", 1),
    () => useGraphBuilderNewStore.getState().setColumns(first, "other", "column-y"),
    () => useGraphBuilderNewStore.getState().setMean(first, true),
    () => useGraphBuilderNewStore.getState().setModes(first, "numeric", "line"),
    () => useGraphBuilderNewStore.getState().setCamera(first, null),
    () => useGraphBuilderNewStore.getState().renameItem(first, "Changed"),
    () => useGraphBuilderNewStore.getState().deleteItem(first),
    () => useGraphBuilderNewStore.getState().deleteByDataset("dataset-1"),
  ]) assert.throws(mutate, /read-only/);
  assert.deepEqual(useGraphBuilderNewStore.getState().items, saved);
  useGraphBuilderNewStore.getState().setCamera(first, { ...persistedCamera! });
  useGraphBuilderNewStore.getState().close(first);
  useGraphBuilderNewStore.getState().reopen(first, 32);
  assert.equal(useProjectStore.getState().dirty, false);
  useProjectStore.setState({ readOnly: false });
  const closedReopenedTransport = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === first)!.transportId;
  assert.notEqual(closedReopenedTransport, reopenedTransport);
  assert.equal(useGraphBuilderNewStore.getState().reopen(first, 33), first);
  const replacedTransport = useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === first)!.transportId;
  assert.notEqual(replacedTransport, closedReopenedTransport, "generation replacement allocates a fresh transport");
  useGraphBuilderNewStore.getState().close(first);
  assert.equal(useGraphBuilderNewStore.getState().reopen(first, 33), first);
  assert.notEqual(useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === first)!.transportId, replacedTransport, "same-generation close/reopen never reuses a transport");
  assert.deepEqual(useGraphBuilderNewStore.getState().items, saved);
  useGraphBuilderNewStore.getState().setModes(first, "numeric", "line");
  assert.equal(useGraphBuilderNewStore.getState().items[0].camera, null);
  useGraphBuilderNewStore.getState().setCamera(first, persistedCamera);
  useGraphBuilderNewStore.getState().setColumns(first, "missing-column", "column-y");
  assert.equal(useGraphBuilderNewStore.getState().items[0].camera, null);
  assert.equal(useGraphBuilderNewStore.getState().sessions.find(({ id }) => id === first)?.xColumnId, "missing-column");
  const beforeInvalid = useGraphBuilderNewStore.getState();
  assert.throws(() => useGraphBuilderNewStore.getState().setCamera(first, { xMin: NaN, xMax: 1, yMin: 0, yMax: 1 }), /invalid_camera/);
  assert.throws(() => useGraphBuilderNewStore.getState().loadFromProject([{ ...saved[0], version: 2 }]), /unsupported_document_version/);
  assert.throws(() => useGraphBuilderNewStore.getState().loadFromProject([saved[0], saved[0]]), /duplicate_document_id/);
  assert.strictEqual(useGraphBuilderNewStore.getState(), beforeInvalid, "invalid loads are atomic");
  useGraphBuilderNewStore.getState().loadFromProject(saved);
  saved[0].camera.xMin = 99;
  assert.equal(useGraphBuilderNewStore.getState().items[0].camera?.xMin, 1.000000000000001, "hydration owns a copy");
  useGraphBuilderNewStore.getState().reopen(first, 32);
  useGraphBuilderNewStore.getState().reopen(second, 31);
  useGraphBuilderNewStore.getState().deleteItem(first);
  assert.deepEqual(useGraphBuilderNewStore.getState().items.map((item) => item.id), [second]);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions.map((item) => item.id), [second]);
  useGraphBuilderNewStore.getState().deleteByDataset("dataset-2");
  assert.deepEqual(useGraphBuilderNewStore.getState().items, []);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, []);
  useGraphBuilderNewStore.getState().reset();
  nextSessionId = sessionId;

  const graphBuildersBefore = useGraphBuilderStore.getState().items;
  useProjectStore.setState({ dirty: false });
  const historyBefore = useHistoryStore.getState().history;
  const foldersBefore = useFolderStore.getState();

  const openedId = useGraphBuilderNewStore.getState().open("dataset-1", 17);

  assert.equal(openedId, sessionId);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, [{
    version: 1,
    id: sessionId,
    transportId: useGraphBuilderNewStore.getState().sessions[0].transportId,
    runtimeEpoch: useGraphBuilderNewStore.getState().sessions[0].runtimeEpoch,
    name: "Graph Builder-new 1",
    camera: null,
    datasetId: "dataset-1",
    datasetGeneration: 17,
    xColumnId: null,
    yColumnId: null,
    showMean: true,
    xMode: "auto",
    rawMode: "scatter",
  }]);

  useGraphBuilderNewStore.getState().setMean(sessionId, false);
  useGraphBuilderNewStore.getState().setColumns(sessionId, "column-x", "column-y");
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions[0], {
    version: 1,
    id: sessionId,
    transportId: useGraphBuilderNewStore.getState().sessions[0].transportId,
    runtimeEpoch: useGraphBuilderNewStore.getState().sessions[0].runtimeEpoch,
    name: "Graph Builder-new 1",
    camera: null,
    datasetId: "dataset-1",
    datasetGeneration: 17,
    xColumnId: "column-x",
    yColumnId: "column-y",
    showMean: false,
    xMode: "auto",
    rawMode: "scatter",
  });

  useGraphBuilderNewStore.getState().setModes(sessionId, "duration", "pointsLine");
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].xMode, "duration");
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].rawMode, "pointsLine");
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].showMean, false);

  useGraphBuilderNewStore.getState().setMean("missing-session", true);
  assert.equal(useGraphBuilderNewStore.getState().sessions[0].showMean, false);
  useGraphBuilderNewStore.getState().setColumns("missing-session", "other-x", "other-y");
  assert.equal(useGraphBuilderNewStore.getState().sessions.length, 1);

  nextSessionId = replacementSessionId;
  const replacementId = useGraphBuilderNewStore.getState().open("dataset-2", 4);
  assert.equal(replacementId, replacementSessionId);
  assert.equal(useGraphBuilderNewStore.getState().sessions.length, 2);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions[1], {
    version: 1,
    id: replacementSessionId,
    transportId: useGraphBuilderNewStore.getState().sessions[1].transportId,
    runtimeEpoch: useGraphBuilderNewStore.getState().sessions[1].runtimeEpoch,
    name: "Graph Builder-new 2",
    camera: null,
    datasetId: "dataset-2",
    datasetGeneration: 4,
    xColumnId: null,
    yColumnId: null,
    showMean: true,
    xMode: "auto",
    rawMode: "scatter",
  });

  assert.strictEqual(useGraphBuilderStore.getState().items, graphBuildersBefore);
  assert.equal(useProjectStore.getState().dirty, true);
  assert.strictEqual(useHistoryStore.getState().history, historyBefore);
  assert.strictEqual(useFolderStore.getState().folders, foldersBefore.folders);

  useGraphBuilderNewStore.getState().close(replacementSessionId);
  useGraphBuilderNewStore.getState().close(sessionId);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, []);
} finally {
  crypto.randomUUID = originalRandomUuid;
  useGraphBuilderNewStore.getState().reset();
  useProjectStore.setState({ dirty: false, readOnly: false });
}

const literalNameId = useGraphBuilderNewStore.getState().open("dataset-1", 1);
useGraphBuilderNewStore.getState().renameItem(literalNameId, "Literal.spgn");
assert.equal(useGraphBuilderNewStore.getState().items[0].name, "Literal.spgn", "direct store API accepts a basename, not a filename input");
useProjectStore.setState({ dirty: false });
const unchangedLiteral = useGraphBuilderNewStore.getState();
useGraphBuilderNewStore.getState().renameItem(literalNameId, "Literal.spgn");
assert.strictEqual(useGraphBuilderNewStore.getState(), unchangedLiteral);
assert.equal(useProjectStore.getState().dirty, false);
useGraphBuilderNewStore.getState().renameItem(literalNameId, "a".repeat(255));
const collidingId = useGraphBuilderNewStore.getState().open("dataset-1", 1);
useProjectStore.setState({ dirty: false });
const beforeLongCollision = useGraphBuilderNewStore.getState();
assert.throws(() => useGraphBuilderNewStore.getState().renameItem(collidingId, "a".repeat(255)), /project_name_tooLong/);
assert.strictEqual(useGraphBuilderNewStore.getState(), beforeLongCollision);
assert.equal(useProjectStore.getState().dirty, false);
useGraphBuilderNewStore.getState().reset();

useFolderStore.getState().loadFromProject({
  folders: [], tableFolders: {}, graphFolders: { legacy: "Charts" },
  graphNewFolders: { native: "Charts/Native" }, tabulateFolders: {}, fitYByXFolders: {},
});
assert.deepEqual(useFolderStore.getState().graphNewFolders, { native: "Charts/Native" });
useFolderStore.getState().renameFolder("Charts", "Results");
assert.deepEqual(useFolderStore.getState().graphNewFolders, { native: "Results/Native" });
useFolderStore.getState().moveFolder("Results/Native", null);
assert.deepEqual(useFolderStore.getState().graphNewFolders, { native: "Native" });
useFolderStore.getState().deleteFolder("Native");
assert.deepEqual(useFolderStore.getState().graphNewFolders, {});
useFolderStore.getState().setGraphNewFolder("native", "Results");
useFolderStore.getState().pruneAssignments(new Set(), new Set(["legacy"]), new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set());
assert.deepEqual(useFolderStore.getState().graphNewFolders, {});
assert.deepEqual(useFolderStore.getState().graphFolders, { legacy: "Results" });
useFolderStore.getState().reset();

useFolderStore.getState().loadFromProject({
  folders: ["CON", "Charts/Good"], tableFolders: { old: "CON" }, graphFolders: {}, tabulateFolders: {}, fitYByXFolders: {},
  graphNewFolders: { native: "Charts/Good" },
});
const beforeRejectedFolders = useFolderStore.getState();
for (const mutate of [
  () => useFolderStore.getState().createFolder(null, "CON"),
  () => useFolderStore.getState().createFolder("CON", "New"),
  () => useFolderStore.getState().renameFolder("Charts", "LPT1.txt"),
  () => useFolderStore.getState().moveFolder("Charts", "CON"),
  ...["CON", "Charts/AUX.txt", "Charts//Good", "/Charts", "Charts/", "Charts/..", "Charts/bad.", "Charts/bad\\name", "Charts/\u0085bad", "界".repeat(1366)].map((folder) => () => useFolderStore.getState().setGraphNewFolder("native", folder)),
]) {
  assert.throws(mutate, /project_name_/);
  assert.strictEqual(useFolderStore.getState(), beforeRejectedFolders, "invalid folder mutations must be atomic");
}
assert.deepEqual(useFolderStore.getState().tableFolders, { old: "CON" }, "legacy folders stay intact on load");
const longFolder = "a".repeat(4096);
useFolderStore.getState().setGraphNewFolder("native", longFolder);
assert.equal(useFolderStore.getState().graphNewFolders.native, longFolder, "backend has no 255-byte folder component cap");
useFolderStore.getState().setGraphNewFolder("native", "Charts/Good");
useFolderStore.getState().createFolder(null, "b".repeat(4088));
const beforeLongMove = useFolderStore.getState();
assert.throws(() => useFolderStore.getState().moveFolder("Charts", "b".repeat(4088)), /project_name_pathTooLong/);
assert.strictEqual(useFolderStore.getState(), beforeLongMove, "validate descendant paths before moving any folder");
useFolderStore.getState().renameFolder("CON", "Recovered");
assert.deepEqual(useFolderStore.getState().tableFolders, { old: "Recovered" });
useFolderStore.getState().reset();

const workspaceSource = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
const saveHandler = sourceBetween(workspaceSource, "const handleSave =", "handleSaveRef.current = handleSave;");
assert.match(saveHandler, /useGraphBuilderNewStore\.getState\(\)\.items/);
assert.equal((saveHandler.match(/graphBuildersNew:/g) ?? []).length, 2, "Save and Save As include all durable documents");
assert.equal((saveHandler.match(/graphNewFolders:/g) ?? []).length, 2);
const closeProjectHandler = sourceBetween(workspaceSource, "const handleCloseProject =", "const handleOpenAnother =");
assert.match(closeProjectHandler, /resetGraphBuildersNew\(\)/);
const openProjectHandler = sourceBetween(workspaceSource, "const handleOpenAnother =", "const singleExportBaseName =");
assert.match(openProjectHandler, /loadGraphBuildersNewFromProject\(result.graphBuildersNew \?\? \[\]\)/);
assert.ok(openProjectHandler.indexOf("await refreshDatasets()") < openProjectHandler.indexOf("loadGraphBuildersNewFromProject(result"));
assert.match(workspaceSource, /reopenGraphBuilderNew\(id, dataset\?\.generation \?\? 0\)/);
assert.match(workspaceSource, /graphNewChildren/);
const currentGraphHandler = sourceBetween(
  workspaceSource,
  "const handleCreateGraphBuilder = () => {",
  "const handleCreateGraphBuilderNew = () => {",
);
const graphBuilderNewHandler = sourceBetween(
  workspaceSource,
  "const handleCreateGraphBuilderNew = () => {",
  "const handleCreateTabulate = () => {",
);
assert.match(workspaceSource, />\s*Graph Builder-new\s*</);
assert.match(graphBuilderNewHandler, /openGraphBuilderNew\(dataset\.id, dataset\.generation\)/);
assert.doesNotMatch(graphBuilderNewHandler, /recordAction|addGraphBuilder\(/);
assert.doesNotMatch(currentGraphHandler, /GraphBuilderNew|graphBuilderNew/);

const appSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const setupSource = sourceBetween(appSource, ".setup(|app| {", ".invoke_handler(");
assert.ok(!setupSource.includes("app_cache_dir()?"), "optional cache path errors must not abort setup");
assert.ok(!setupSource.includes("set_graph_cache_directory(&directory)?"), "optional cache init errors must not abort setup");
assert.ok(setupSource.includes("initialize_graph_new_cache"));
assert.ok(setupSource.includes('"graph_new_cache_disabled"') && setupSource.includes('"memory_only"'));
assert.ok(setupSource.includes("Ok(())"));

console.log("workspaceGraphBuilderNew tests passed");
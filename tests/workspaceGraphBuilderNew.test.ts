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
let nextSessionId = sessionId;

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

crypto.randomUUID = () => nextSessionId;

try {
  useGraphBuilderNewStore.setState({ sessions: [] });

  const graphBuildersBefore = useGraphBuilderStore.getState().items;
  const dirtyBefore = useProjectStore.getState().dirty;
  const historyBefore = useHistoryStore.getState().history;
  const foldersBefore = useFolderStore.getState();

  const openedId = useGraphBuilderNewStore.getState().open("dataset-1", 17);

  assert.equal(openedId, sessionId);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, [{
    id: sessionId,
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
    id: sessionId,
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
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, [{
    id: replacementSessionId,
    datasetId: "dataset-2",
    datasetGeneration: 4,
    xColumnId: null,
    yColumnId: null,
    showMean: true,
    xMode: "auto",
    rawMode: "scatter",
  }]);

  assert.strictEqual(useGraphBuilderStore.getState().items, graphBuildersBefore);
  assert.equal(useProjectStore.getState().dirty, dirtyBefore);
  assert.strictEqual(useHistoryStore.getState().history, historyBefore);
  assert.strictEqual(useFolderStore.getState().folders, foldersBefore.folders);

  useGraphBuilderNewStore.getState().close(replacementSessionId);
  assert.deepEqual(useGraphBuilderNewStore.getState().sessions, []);
} finally {
  crypto.randomUUID = originalRandomUuid;
  useGraphBuilderNewStore.setState({ sessions: [] });
}

const workspaceSource = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
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
const saveHandler = sourceBetween(
  workspaceSource,
  "const handleSave = async () => {",
  "handleSaveRef.current = handleSave;",
);

assert.match(workspaceSource, />\s*Graph Builder-new\s*</);
assert.match(graphBuilderNewHandler, /openGraphBuilderNew\(dataset\.id, dataset\.generation\)/);
assert.doesNotMatch(graphBuilderNewHandler, /markDirty|recordAction|addGraphBuilder|Folder|projectService|clearWorkspaceDocumentSelection/);
assert.doesNotMatch(saveHandler, /GraphBuilderNew|graphBuilderNew/);
assert.doesNotMatch(currentGraphHandler, /GraphBuilderNew|graphBuilderNew/);

const appSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const setupSource = sourceBetween(appSource, ".setup(|app| {", ".invoke_handler(");
assert.ok(!setupSource.includes("app_cache_dir()?"), "optional cache path errors must not abort setup");
assert.ok(!setupSource.includes("set_graph_cache_directory(&directory)?"), "optional cache init errors must not abort setup");
assert.ok(setupSource.includes("initialize_graph_new_cache"));
assert.ok(setupSource.includes('"graph_new_cache_disabled"') && setupSource.includes('"memory_only"'));
assert.ok(setupSource.includes("Ok(())"));

console.log("workspaceGraphBuilderNew tests passed");
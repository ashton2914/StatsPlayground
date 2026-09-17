import assert from "node:assert/strict";
import { graphNewService } from "../src/services/graphNewService.ts";

async function main() {
  const calls: { command: string; args: any }[] = [];
  let callback: (message: any) => void = () => {};
  let rejectRender: (error: unknown) => void = () => {};
  let resolveRender: (value: unknown) => void = () => {};
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {
    transformCallback: (handler: typeof callback) => { callback = handler; return 1; },
    unregisterCallback: () => {},
    invoke: (command: string, args: any) => {
      calls.push({ command, args });
      if (command === "render_graph_new") return new Promise((resolve, reject) => { rejectRender = reject; resolveRender = resolve; });
      return Promise.resolve();
    },
  } } });
  assert.equal(typeof graphNewService.render, "function", "Task6 must expose render");
  const request = {
    requestId: "render-1", sessionId: "session-1", datasetId: "dataset-1",
    datasetGeneration: 1, xColumnId: "x", yColumnId: "y",
    width: 96, height: 64, devicePixelRatio: 1, rendererGeneration: 1, cameraGeneration: 1,
  };
  const frames: any[] = [];
  const errors: string[] = [];
  const controller = graphNewService.render(request, {
    activeIdentity: () => request, onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error),
  });
  const header = { ...request, frameId: 1, width: 96, height: 64, format: "rgba8",
    byteLength: 96 * 64 * 4, readbackCompletedAtUnixMicros: 1 };
  callback({ message: { messageType: "header", header }, index: 0 });
  callback({ message: new ArrayBuffer(header.byteLength), index: 1 });
  assert.equal(frames.length, 1);
  assert.equal(controller.canPresent(header), true);
  await controller.cancel();
  assert.equal(controller.canPresent(header), false);
  callback({ message: { messageType: "header", header: { ...header, frameId: 2 } }, index: 2 });
  callback({ message: new ArrayBuffer(header.byteLength), index: 3 });
  assert.equal(frames.length, 1, "cancelled render must not deliver late frames");
  assert.equal(calls[0].command, "render_graph_new");
  assert.deepEqual(calls[0].args.request, request);
  assert.deepEqual(calls[1], { command: "cancel_graph_new", args: { sessionId: request.sessionId, requestId: request.requestId, rendererGeneration: request.rendererGeneration } });
  rejectRender("database /private/user/secret.db failed");
  await assert.rejects(controller.completion, /graph_new_render_failed/);
  assert.deepEqual(errors, [], "cancelled requests do not surface late errors");
  await graphNewService.close(request.sessionId);
  assert.equal(calls.at(-1)?.command, "close_graph_new");
  const failed = graphNewService.render({ ...request, requestId: "render-2" }, {
    activeIdentity: () => ({ ...request, requestId: "render-2" }), onFrame: () => {}, onError: (error) => errors.push(error),
  });
  rejectRender("database /private/user/secret.db failed");
  await assert.rejects(failed.completion, /graph_new_render_failed/);
  assert.deepEqual(errors, ["graph_new_render_failed"]);
  for (const invalid of [{ width: 95 }, { height: 63 }, { devicePixelRatio: 9 },
    { datasetGeneration: -1 }, { cameraGeneration: 1.5 }, { rendererGeneration: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => graphNewService.render({ ...request, ...invalid }, {
      activeIdentity: () => request, onFrame: () => {}, onError: () => {},
    }), /graph_new_invalid_request/);
  }
  const invalidCompletion = graphNewService.render(request, {
    activeIdentity: () => request, onFrame: () => {}, onError: () => {},
  });
  resolveRender({ requestId: request.requestId, processedRows: 4, finiteRows: -3,
    excludedNonFiniteRows: 1, selectedMarks: 3, buildMs: 0, renderMs: 0, readbackMs: 0, width: 96, height: 64 });
  await assert.rejects(invalidCompletion.completion, /graph_new_render_failed/);
  const malformed = graphNewService.render(request, {
    activeIdentity: () => request, onFrame: () => assert.fail("bad metadata must not present"), onError: () => {},
  });
  callback({ index: 0, message: { messageType: "header", header: { ...header, rendererGeneration: -1 } } });
  callback({ index: 1, message: new ArrayBuffer(header.byteLength) });
  resolveRender({ requestId: request.requestId, processedRows: 4, finiteRows: 3,
    excludedNonFiniteRows: 1, selectedMarks: 3, buildMs: 0, renderMs: 0, readbackMs: 0, width: 96, height: 64 });
  await assert.rejects(malformed.completion, /graph_new_render_failed/);
  const cameraDomain = { xMin: 0.25, xMax: 0.75, yMin: 0.25, yMax: 0.75 };
  const cameraRequest = { ...request, cameraDomain };
  const cameraCompletion = { requestId: request.requestId, processedRows: 4, finiteRows: 3,
    exactVisible: true, visibleRows: 2, rawIndexEntriesInspected: 1, rawBlocksInspected: 1, rawPointsInspected: 3,
    excludedNonFiniteRows: 1, selectedMarks: 2, buildMs: 0, renderMs: 1, readbackMs: 1, width: 96, height: 64,
    cameraDomain, plotRect: { x: 64, y: 16, width: 16, height: 16 }, sourceProjectionQueryCount: 0, renderGenerationCheckCount: 4 };
  const handlers = { activeIdentity: () => cameraRequest, onFrame: () => {}, onError: () => {} };
  const camera = graphNewService.render(cameraRequest, handlers);
  resolveRender(cameraCompletion);
  assert.deepEqual(await camera.completion, cameraCompletion);
  const approximateCompletion = { ...cameraCompletion, exactVisible: false, visibleRows: null,
    rawIndexEntriesInspected: 0, rawBlocksInspected: 0, rawPointsInspected: 0 };
  const approximate = graphNewService.render(cameraRequest, handlers);
  resolveRender(approximateCompletion);
  assert.deepEqual(await approximate.completion, approximateCompletion);
  await camera.cancel(true);
  assert.equal(calls.at(-1)?.args.preserveCache, true);
  for (const invalid of [{ ...cameraCompletion, sourceProjectionQueryCount: 1 },
    { ...cameraCompletion, visibleRows: null },
    { ...cameraCompletion, visibleRows: undefined, exactVisible: false },
    { ...cameraCompletion, visibleRows: 3 },
    { ...cameraCompletion, exactVisible: undefined },
    { ...cameraCompletion, rawPointsInspected: -1 },
    { ...cameraCompletion, visibleRows: 4, exactVisible: false },
    { ...cameraCompletion, plotRect: { x: 0, y: 0, width: 1000, height: 1 } },
    { ...cameraCompletion, cameraDomain: { ...cameraDomain, xMax: 1 } }]) {
    const controller = graphNewService.render(cameraRequest, handlers);
    resolveRender(invalid);
    await assert.rejects(controller.completion, /graph_new_render_failed/);
  }
  const missing = graphNewService.render(cameraRequest, handlers);
  rejectRender("Stats error: graph_new_missing_cache");
  await assert.rejects(missing.completion, /graph_new_missing_cache/);
  assert.throws(() => graphNewService.render({ ...cameraRequest, cameraDomain: { ...cameraDomain, xMax: NaN } }, handlers), /graph_new_invalid_request/);
  console.log("graphNewService contract passed");
}
void main();
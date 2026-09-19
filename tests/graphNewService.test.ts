import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { graphNewService } from "../src/services/graphNewService.ts";
import { formatGraphNewTick } from "../src/components/graphBuilderNew/GraphNewCanvas.tsx";

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
    cameraDomain, plotRect: { x: 64, y: 16, width: 16, height: 16 }, sourceProjectionQueryCount: 0, renderGenerationCheckCount: 4,
    overlayActive: false, overlayGroups: [], hiddenOverlayGroups: 0 };
  const handlers = { activeIdentity: () => cameraRequest, onFrame: () => {}, onError: () => {} };
  for (const invalid of [{ xMode: "guessLocale" }, { rawMode: "mean" }, { rawMode: false }]) {
    assert.throws(() => graphNewService.render({ ...cameraRequest, ...invalid } as any, handlers), /graph_new_invalid_request/);
  }
  const typedRequest = { ...cameraRequest, xMode: "duration", rawMode: "pointsLine" } as const;
  const typedCompletion = { ...cameraCompletion, selectedMarks: 3, rawMode: "pointsLine", rawLineAvailable: true, rawLineSegments: 2,
    xAxis: { kind: "duration", utc: false, ticks: [{ value: 0.5, position: 0.5, label: null }] } };
  for (const invalid of [
    { ...typedCompletion, rawLineSegments: 3 }, { ...typedCompletion, rawLineAvailable: false },
    { ...typedCompletion, xAxis: { ...typedCompletion.xAxis, ticks: [{ value: 0.5, position: 2, label: null }] } },
    { ...typedCompletion, xAxis: { ...typedCompletion.xAxis, kind: "category" } },
  ]) {
    const typed = graphNewService.render(typedRequest, handlers);
    resolveRender(invalid);
    await assert.rejects(typed.completion, /graph_new_render_failed/);
  }
  const typed = graphNewService.render(typedRequest, handlers);
  resolveRender(typedCompletion);
  assert.deepEqual(await typed.completion, typedCompletion);
  const overlayId = `sha256:${"1".repeat(64)}`;
  const overlayGroup = {
    id: overlayId,
    code: 1,
    label: "A",
    color: [31, 111, 235, 255],
    totalRows: 3,
    missing: false,
  };
  const overlayRequest = {
    ...cameraRequest,
    overlayColumnId: "group-column",
    hiddenOverlayGroupIds: [overlayId],
  };
  const overlayCompletion = {
    ...cameraCompletion,
    overlayActive: true,
    overlayGroups: [overlayGroup],
    hiddenOverlayGroups: 1,
  };
  const overlay = graphNewService.render(overlayRequest, {
    activeIdentity: () => overlayRequest,
    onFrame: () => {},
    onError: () => {},
  });
  resolveRender(overlayCompletion);
  assert.deepEqual(await overlay.completion, overlayCompletion);
  assert.deepEqual(calls.findLast((call) => call.command === "render_graph_new")?.args.request.hiddenOverlayGroupIds, [overlayId]);
  for (const invalid of [
    { hiddenOverlayGroupIds: [overlayId, overlayId] },
    { hiddenOverlayGroupIds: ["sha256:not-a-hash"] },
    { hiddenOverlayGroupIds: Array.from({ length: 65 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`) },
    { overlayColumnId: undefined, hiddenOverlayGroupIds: [overlayId] },
  ]) {
    assert.throws(() => graphNewService.render({ ...overlayRequest, ...invalid } as any, handlers), /graph_new_invalid_request/);
  }
  for (const invalid of [
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup, id: overlayId }, { ...overlayGroup, code: 2 }] },
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup }, { ...overlayGroup, id: `sha256:${"2".repeat(64)}`, code: 1 }] },
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup, id: "sha256:not-a-hash" }] },
    { ...overlayCompletion, hiddenOverlayGroups: 65 },
    { ...cameraCompletion, overlayActive: false, overlayGroups: [overlayGroup], hiddenOverlayGroups: 1 },
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup, color: [256, 0, 0, 255] }] },
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup, label: "界".repeat(171) }] },
    { ...overlayCompletion, overlayGroups: [{ ...overlayGroup, totalRows: 4 }] },
  ]) {
    const pending = graphNewService.render(overlayRequest, {
      activeIdentity: () => overlayRequest,
      onFrame: () => {},
      onError: () => {},
    });
    resolveRender(invalid);
    await assert.rejects(pending.completion, /graph_new_render_failed/);
  }
  const extremeCompletion = { ...cameraCompletion, cameraDomain: { xMin: -1e308, xMax: 1e308, yMin: 0, yMax: 1 },
    xAxis: { kind: "numeric", utc: false, ticks: [-1e308, -5e307, 0, 5e307, 1e308].map((value, index) => ({ value, position: index / 4, label: null })) } };
  const extreme = graphNewService.render({ ...request, xMode: "numeric" }, handlers);
  resolveRender(extremeCompletion);
  assert.deepEqual(await extreme.completion, extremeCompletion);
  for (const invalid of [
    { ...extremeCompletion, xAxis: { ...extremeCompletion.xAxis, ticks: [{ value: 0, position: 0.75, label: null }] } },
    { ...extremeCompletion, cameraDomain: { xMin: 7, xMax: 7, yMin: 0, yMax: 1 },
      xAxis: { ...extremeCompletion.xAxis, ticks: [{ value: 7, position: 0, label: null }] } },
    { ...extremeCompletion, xAxis: { ...extremeCompletion.xAxis, ticks: [{ value: NaN, position: 0.5, label: null }] } },
  ]) {
    const pending = graphNewService.render({ ...request, xMode: "numeric" }, handlers);
    resolveRender(invalid);
    await assert.rejects(pending.completion, /graph_new_render_failed/);
  }
  if (process.env.GRAPH_NEW_REVIEW_EVIDENCE) {
    const recorded = JSON.parse(readFileSync(join(process.env.GRAPH_NEW_REVIEW_EVIDENCE, "extreme.json"), "utf8"));
    const replay = graphNewService.render(recorded.request, { activeIdentity: () => recorded.request, onFrame: () => {}, onError: () => {} });
    resolveRender(recorded.completion);
    assert.deepEqual(await replay.completion, recorded.completion);
  }
  const nanoAxis = { kind: "time", utc: true, origin: { epochNanos: "1789689600000000001", unitNanos: 1 },
    ticks: [{ value: 0, position: 0, label: null }, { value: 1, position: 1, label: null }] } as const;
  assert.deepEqual(nanoAxis.ticks.map(tick => formatGraphNewTick(nanoAxis as any, tick)),
    ["2026-09-18 00:00:00.000000001 UTC", "2026-09-18 00:00:00.000000002 UTC"]);
  const microAxis = { kind: "duration", utc: false, ticks: [
    { value: 90000.000001, position: 0, label: null }, { value: 90000.000002, position: 1, label: null },
  ] } as const;
  assert.deepEqual(microAxis.ticks.map(tick => formatGraphNewTick(microAxis as any, tick)), ["25:00:00.000001", "25:00:00.000002"]);
  for (const origin of [{ epochNanos: "rounded", unitNanos: 1 }, { epochNanos: "1789689600000000001", unitNanos: 2 },
    { epochNanos: "9".repeat(100), unitNanos: 1 }]) {
    const pending = graphNewService.render({ ...cameraRequest, xMode: "time" }, handlers);
    resolveRender({ ...cameraCompletion, xAxis: { kind: "time", utc: true, origin, ticks: [] } });
    await assert.rejects(pending.completion, /graph_new_render_failed/);
  }
  if (process.env.GRAPH_NEW_REVIEW_EVIDENCE) {
    for (const name of ["native", "text", "offset"]) {
      const recorded = JSON.parse(readFileSync(join(process.env.GRAPH_NEW_REVIEW_EVIDENCE, `nano-${name}.json`), "utf8"));
      const replay = graphNewService.render(recorded.request, { activeIdentity: () => recorded.request, onFrame: () => {}, onError: () => {} });
      resolveRender(recorded.completion);
      assert.deepEqual(await replay.completion, recorded.completion);
      assert.equal(recorded.completion.meanGroups, 2);
      const labels = recorded.completion.xAxis.ticks.map((tick: any) => formatGraphNewTick(recorded.completion.xAxis, tick));
      assert.equal(new Set(labels).size, labels.length);
    }
  }
  const meanRequest = { ...cameraRequest, showMean: true };
  const meanCompletion = { ...cameraCompletion, selectedMarks: 3, meanAvailable: true, meanGroups: 2, meanVisible: true };
  for (const invalid of [
    cameraCompletion, { ...meanCompletion, meanGroups: 4 }, { ...meanCompletion, meanGroups: 1.5 },
    { ...meanCompletion, meanGroups: null }, { ...meanCompletion, meanAvailable: false },
    { ...meanCompletion, meanVisible: false }, { ...meanCompletion, exactVisible: false },
    { ...meanCompletion, meanGroups: 0 },
  ]) {
    const mean = graphNewService.render(meanRequest, handlers);
    resolveRender(invalid);
    await assert.rejects(mean.completion, /graph_new_render_failed/, "reject untrustworthy mean metadata");
  }
  for (const completion of [meanCompletion,
    { ...meanCompletion, meanGroups: 1, meanVisible: false },
    { ...meanCompletion, meanAvailable: false, meanGroups: null, meanVisible: false, exactVisible: false, selectedMarks: 2 },
  ]) {
    const mean = graphNewService.render(meanRequest, handlers);
    resolveRender(completion);
    assert.deepEqual(await mean.completion, completion);
    assert.equal(calls.findLast((call) => call.command === "render_graph_new")?.args.request.showMean, true);
  }
  assert.throws(() => graphNewService.render({ ...cameraRequest, showMean: "yes" } as any, handlers), /graph_new_invalid_request/);
  const camera = graphNewService.render(cameraRequest, handlers);
  resolveRender(cameraCompletion);
  assert.deepEqual(await camera.completion, cameraCompletion);
  for (const invalid of [
    (({ overlayActive, ...rest }) => rest)(cameraCompletion),
    (({ overlayGroups, ...rest }) => rest)(cameraCompletion),
    (({ hiddenOverlayGroups, ...rest }) => rest)(cameraCompletion),
    { ...cameraCompletion, overlayActive: true, overlayGroups: [], hiddenOverlayGroups: 0 },
  ]) {
    const pending = graphNewService.render(cameraRequest, handlers);
    resolveRender(invalid);
    await assert.rejects(pending.completion, /graph_new_render_failed/, "reject partial no-overlay metadata");
  }
  const approximateCompletion = { ...cameraCompletion, exactVisible: false, visibleRows: null,
    rawIndexEntriesInspected: 0, rawBlocksInspected: 0, rawPointsInspected: 0 };
  const approximate = graphNewService.render(cameraRequest, handlers);
  resolveRender(approximateCompletion);
  assert.deepEqual(await approximate.completion, approximateCompletion);
  for (const visibleRows of [2_032_293, 7]) {
    const exactCompletion = { ...cameraCompletion, processedRows: 2_032_300,
      finiteRows: 2_032_293, excludedNonFiniteRows: 7, selectedMarks: 2_032_293, visibleRows };
    const delivered: any[] = [];
    const failures: string[] = [];
    let active = cameraRequest;
    const exact = graphNewService.render(cameraRequest, {
      activeIdentity: () => active, onFrame: (frame) => delivered.push(frame), onError: (error) => failures.push(error),
    });
    callback({ index: 0, message: JSON.stringify({ messageType: "header", header }) });
    callback({ index: 1, message: new Uint8Array(header.byteLength) });
    resolveRender(exactCompletion);
    assert.deepEqual(await exact.completion, exactCompletion, "submitted geometry is independent of viewport visibility");
    assert.equal(delivered.length, 1);
    assert.equal(exact.canPresent(header), true);
    active = { ...cameraRequest, cameraGeneration: cameraRequest.cameraGeneration + 1 };
    assert.equal(exact.canPresent(header), false);
    callback({ index: 2, message: { messageType: "header", header: { ...header, frameId: 2 } } });
    callback({ index: 3, message: new ArrayBuffer(header.byteLength) });
    assert.equal(delivered.length, 1, "stale native frames stay fenced with whole geometry");
    assert.deepEqual(failures, []);
  }
  await camera.cancel(true);
  assert.equal(calls.at(-1)?.args.preserveCache, true);
  for (const counts of [
    { processedRows: 2_100_000, finiteRows: 2_100_000, selectedMarks: 2_100_000, visibleRows: 0 },
    { processedRows: 4_000_000, finiteRows: 4_000_000, selectedMarks: 2, visibleRows: 2 },
  ]) {
    const completion = { ...cameraCompletion, ...counts, excludedNonFiniteRows: 0 };
    const accepted = graphNewService.render(cameraRequest, handlers);
    resolveRender(completion);
    assert.deepEqual(await accepted.completion, completion);
  }
  for (const invalid of [{ ...cameraCompletion, sourceProjectionQueryCount: 1 },
    { ...cameraCompletion, visibleRows: null },
    { ...cameraCompletion, visibleRows: undefined, exactVisible: false },
    { ...cameraCompletion, visibleRows: 3 },
    { ...cameraCompletion, exactVisible: undefined },
    { ...cameraCompletion, rawPointsInspected: -1 },
    { ...cameraCompletion, visibleRows: 4, exactVisible: false },
    ...[
      { selectedMarks: 2_100_001, finiteRows: 2_100_001, processedRows: 2_100_002 },
      { selectedMarks: 2_032_293.5 }, { selectedMarks: NaN }, { selectedMarks: Infinity },
      { selectedMarks: -1 }, { selectedMarks: 4 },
      { visibleRows: 1.5 }, { visibleRows: Infinity }, { visibleRows: NaN }, { visibleRows: -1 },
      { finiteRows: 2.5 }, { processedRows: Number.MAX_SAFE_INTEGER + 1 },
      { processedRows: 5 }, { excludedNonFiniteRows: -1 },
      { rawBlocksInspected: 2 }, { rawPointsInspected: 4 },
      { selectedMarks: 3, visibleRows: 2, exactVisible: false },
    ].map((counts) => ({ ...cameraCompletion, ...counts })),
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
  const nativeReportPath = process.argv[2];
  if (nativeReportPath) {
    const recordedCompletionReplay = nativeReportPath === "--recorded-native";
    const coldCompletion = {
      buildMs: 536.167333, cacheCorruptions: 0, cacheCpuHits: 0, cacheDiskHits: 0,
      cacheDiskWriteFailures: 0, cacheEvictions: 0, cacheMisses: 1,
      cameraDomain: { xMax: 729286, xMin: 1, yMax: 10, yMin: 2.682 },
      cpuCacheBytes: 56910620, cpuCacheHit: false, cpuCacheReservedBytes: 227627328,
      exactVisible: true, excludedNonFiniteRows: 0, finiteRows: 2032293,
      gpuCache: { allocatedBytes: 88666928, geometryCapacityBytes: 81293800, geometryHits: 0, geometryUploads: 1 },
      height: 720, persistentCacheBytes: 56904504, persistentCacheHit: false,
      plotRect: { height: 672, width: 1200, x: 64, y: 16 }, processCpuReservedBytes: 227627328,
      processedRows: 2032293, rawBlocksInspected: 0, rawIndexEntriesInspected: 0,
      rawPointsInspected: 0, readbackMs: 65.548, renderGenerationCheckCount: 4,
      renderMs: 243.99525, requestId: "csv-cold", selectedMarks: 2032293,
      sourceProjectionQueryCount: 1, visibleRows: 2032293, width: 1280,
    };
    const recordedNative = {
      origin: "issue221-real-csv-review4917/report.json cold/camera completion objects captured before Playwright output cleanup; original pixels unavailable",
      runs: [
        { label: "cold", completion: coldCompletion },
        { label: "camera", completion: { ...coldCompletion,
          buildMs: 0, cacheCpuHits: 2, cpuCacheHit: true,
          cameraDomain: { xMax: 546964.75, xMin: 182322.25, yMax: 8.1705, yMin: 4.5115 },
          gpuCache: { allocatedBytes: 88667328, geometryCapacityBytes: 81294200, geometryHits: 2, geometryUploads: 1 },
          readbackMs: 6.984083, renderMs: 227.279875, sourceProjectionQueryCount: 0, visibleRows: 7,
        } },
      ],
    };
    const nativeReportBytes = recordedCompletionReplay
      ? Buffer.from(JSON.stringify(recordedNative)) : readFileSync(nativeReportPath);
    const nativeReport = JSON.parse(nativeReportBytes.toString("utf8"));
    const replayed = [];
    for (const label of nativeReport.xMode ? nativeReport.runs.map((run: any) => run.label) : ["cold", "camera"]) {
      const nativeRun = nativeReport.runs.find((run: any) => run.label === label);
      assert.ok(nativeRun, `native ${label} completion exists`);
      const completion = nativeRun.completion;
      assert.equal(completion.selectedMarks, 2_032_293);
      assert.equal(completion.finiteRows, 2_032_293);
      if (!nativeReport.xMode || label !== "camera") assert.equal(completion.visibleRows, label === "camera" ? 7 : 2_032_293);
      else assert.ok(Number.isSafeInteger(completion.visibleRows) && completion.visibleRows >= 0 && completion.visibleRows <= completion.finiteRows);
      const nativeRequest = { ...request, requestId: completion.requestId,
        showMean: completion.meanGroups != null,
        xMode: nativeReport.xMode ?? "auto", rawMode: completion.rawMode ?? "scatter",
        width: completion.width, height: completion.height,
        cameraDomain: label === "camera" ? completion.cameraDomain : null };
      let active = nativeRequest;
      const delivered: any[] = [];
      const failures: string[] = [];
      const presented: any[] = [];
      const realController = graphNewService.render(nativeRequest, {
        activeIdentity: () => active, onFrame: (frame) => delivered.push(frame),
        onError: (error) => failures.push(error), onPresented: (metrics) => presented.push(metrics),
      });
      const pixels = recordedCompletionReplay ? Uint8Array.of(0, 96, 255, 255)
        : readFileSync(join(dirname(nativeReportPath), `${label}.rgba`));
      const payload = new Uint8Array(pixels).buffer;
      const nativeHeader = { ...header, ...nativeRequest, byteLength: payload.byteLength,
        ...(recordedCompletionReplay ? { width: 1, height: 1 } : {}) };
      assert.equal(payload.byteLength, nativeHeader.width * nativeHeader.height * 4);
      callback({ index: 0, message: JSON.stringify({ messageType: "header", header: nativeHeader }) });
      callback({ index: 1, message: payload });
      resolveRender(completion);
      const validated = await realController.completion;
      assert.deepEqual(validated, completion, "native completion must not be trimmed or rewritten");
      assert.equal(delivered.length, 1);
      assert.equal(realController.canPresent(nativeHeader), true);
      const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256(new Uint8Array(delivered[0].payload)), sha256(pixels));
      realController.markPresented(nativeHeader, performance.now());
      assert.equal(presented.length, 1);
      active = { ...nativeRequest, cameraGeneration: nativeRequest.cameraGeneration + 1 };
      assert.equal(realController.canPresent(nativeHeader), false);
      callback({ index: 2, message: { messageType: "header", header: { ...nativeHeader, frameId: 2 } } });
      callback({ index: 3, message: payload });
      assert.equal(delivered.length, 1);
      assert.deepEqual(failures, []);
      replayed.push({ label, request: nativeRequest, header: nativeHeader, completion: validated,
        payloadBytes: payload.byteLength, payloadSha256: sha256(pixels),
        deliveredFrames: delivered.length, presentationCallbacks: presented.length, staleFenced: true });
    }
    const artifact = { productionService: "src/services/graphNewService.ts",
      nativeReport: recordedCompletionReplay ? recordedNative.origin : nativeReportPath,
      nativeReportSha256: createHash("sha256").update(nativeReportBytes).digest("hex"),
      boundary: recordedCompletionReplay
        ? "Captured native completions unchanged through production graphNewService; synthetic valid one-pixel RGBA/header through real Channel and receiver; mocked invoke; no live Canvas/WebView, original pixel verification or new render timing"
        : "Saved native completions and RGBA through real Tauri Channel, header parser, receiver and completion validator; reconstructed channel envelopes; mocked invoke; no live WebView or new render timing",
      replayed };
    assert.ok(process.argv[3], "native replay requires a saved result path");
    writeFileSync(process.argv[3], JSON.stringify(artifact, null, 2) + "\n");
    console.log(`native production-service replay passed: ${replayed.length} frames, 2032293 submitted, unchanged completions; ${recordedCompletionReplay ? "synthetic one-pixel transport" : "unchanged native RGBA"}`);
  }
  console.log("graphNewService contract passed");
}
void main();
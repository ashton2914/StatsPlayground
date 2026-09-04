import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { SCATTER_RENDER_BUDGET } from "../src/graphCore/scatterBudget.ts";
import { decodeGraphPayload, isGraphAggregatePacket } from "../src/types/graphData.ts";
import {
  canExecuteGraphRequest,
  createInitialGraphStreamState,
  createStreamStartCancellationCoordinator,
  deriveElements,
  deriveFields,
  deriveGraphRequestIdentity,
  deriveGraphRequestParts,
  reduceGraphStream,
  type GraphLoadProgress,
  type GraphStreamState,
} from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import {
  updateMultivariateColumns,
} from "../src/components/graphBuilder/updateMultivariateColumns.ts";
import {
  deriveMultivariateSlotBinding,
  resolveCanvasDropSlot,
} from "../src/components/graphBuilder/multivariateInteractions.ts";
import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
import { createEmbeddedGraphItem, normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode.ts";
import { createGraphStreamTransport } from "../src/services/graphDataTransport.ts";
import type {
  GraphChunkHeader,
  GraphDataCompletion,
  GraphDataRequest,
  GraphDataFrame,
  GraphElementRequest,
} from "../src/types/graphData.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const TEST_FILE_DIR = resolve(process.cwd(), "tests");

type JsonObject = Record<string, unknown>;

function readJson(relativePath: string): JsonObject {
  return JSON.parse(readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8")) as JsonObject;
}

function getPathValue(root: JsonObject, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);
}

function parseTs(fileName: string, source: string): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function walk(node: ts.Node, visit: (current: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function referencesIdentifier(sourceFile: ts.SourceFile, symbolName: string): boolean {
  let found = false;
  walk(sourceFile, (node) => {
    if (ts.isIdentifier(node) && node.text === symbolName) {
      found = true;
    }
  });
  return found;
}

function hasCallWithPropertyName(sourceFile: ts.SourceFile, propertyName: string): boolean {
  let found = false;
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === propertyName) {
      found = true;
    }
  });
  return found;
}

function listGraphBuilderProductionFiles(): string[] {
  const root = resolve(TEST_FILE_DIR, "../src/components/graphBuilder");
  const collected: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx)$/i.test(entry.name)) {
        collected.push(absolute);
      }
    }
  }

  return collected;
}

export function makeGraphRows(count: number): Array<[number, string, number]> {
  return Array.from({ length: count }, (_, index) => [
    index + 1,
    ["Central", "East", "North", "South", "West"][index % 5],
    (index * 37) % 7200,
  ]);
}

assert.equal(makeGraphRows(10).length, 10);

{
  const graphSource = readFileSync(resolve(TEST_FILE_DIR, "../src/graphCore/Graph.tsx"), "utf8");
  assert.equal(graphSource.includes("toScatterPick("), false, "Graph.tsx must not call undefined toScatterPick");
}

{
  const graphBuilderViewPath = resolve(TEST_FILE_DIR, "../src/components/graphBuilder/GraphBuilderView.tsx");
  const graphBuilderViewSource = readFileSync(graphBuilderViewPath, "utf8");
  const graphBuilderViewAst = parseTs("GraphBuilderView.tsx", graphBuilderViewSource);
  const graphBuilderFiles = listGraphBuilderProductionFiles();

  assert.equal(
    graphBuilderViewSource.includes("dataService.queryTable("),
    false,
    "GraphBuilderView production graph path must not query full table via dataService.queryTable",
  );
  assert.equal(
    graphBuilderViewSource.includes("applyFilters(data"),
    false,
    "GraphBuilderView production graph path must not use frontend applyFilters(data, ...)",
  );
  assert.equal(
    graphBuilderViewSource.includes("newRows.push([...row"),
    false,
    "GraphBuilderView production graph path must not do frontend melt expansion with newRows.push([...row, ...])",
  );
  assert.equal(
    referencesIdentifier(graphBuilderViewAst, "loadGraphTableData"),
    false,
    "GraphBuilderView must not reference the removed loadGraphTableData symbol",
  );
  assert.equal(
    referencesIdentifier(graphBuilderViewAst, "graphTableDataCache"),
    false,
    "GraphBuilderView must not reference the removed graphTableDataCache symbol",
  );
  assert.equal(
    hasCallWithPropertyName(graphBuilderViewAst, "queryTableWindow"),
    false,
    "GraphBuilder pipeline view must not call dataService.queryTableWindow",
  );
  assert.match(
    graphBuilderViewSource,
    /GRAPH_LAYER_DEFS_WITH_CORRELATION[\s\S]*correlationMatrix/,
    "GraphBuilderView must keep correlationMatrix available in layer definitions",
  );
  assert.match(graphBuilderViewSource, /item\.mode === "multivariate"/);
  assert.match(graphBuilderViewSource, /setMode\("2d"\)/);
  assert.match(graphBuilderViewSource, /setMode\("3d"\)/);
  assert.match(graphBuilderViewSource, /setMode\("multivariate"\)/);
  assert.match(graphBuilderViewSource, /modeStates\.multivariate\.columns/);
  assert.match(graphBuilderViewSource, /resolveCanvasDropSlot\(/);
  assert.match(graphBuilderViewSource, /deriveMultivariateSlotBinding\(/);
  assert.match(
    graphBuilderViewSource,
    /<GraphRuntime[\s\S]*onStateChange=\{setRuntimeState\}[\s\S]*\/?>[\s\S]*\{correlationNoticeText && \(/,
    "GraphBuilderView must render the multivariate rejection status outside the extracted GraphRuntime block",
  );
  assert.doesNotMatch(graphBuilderViewSource, /isCorrelationMatrixItem\(item\)/);
  assert.equal(
    graphBuilderViewSource.includes("CorrelationMatrixOptions"),
    true,
    "LayerCard must render CorrelationMatrixOptions",
  );

  for (const graphBuilderFile of graphBuilderFiles) {
    const relativeFile = graphBuilderFile.replace(resolve(TEST_FILE_DIR, "../"), "").replace(/\\/g, "/");
    const source = readFileSync(graphBuilderFile, "utf8");
    assert.equal(
      source.includes("queryTableWindow"),
      false,
      `Graph Builder production file must not reference queryTableWindow: ${relativeFile}`,
    );
  }
}

{
  const continuous = (name: string) => ({ name, type: "continuous" as const });

  assert.equal(
    resolveCanvasDropSlot({ isMultivariateMode: true, xBound: false, yBound: false }),
    "y",
  );
  assert.equal(
    resolveCanvasDropSlot({ isMultivariateMode: true, xBound: true, yBound: true }),
    "y",
  );
  assert.equal(
    resolveCanvasDropSlot({ isMultivariateMode: false, xBound: false, yBound: false }),
    "x",
  );
  assert.equal(
    resolveCanvasDropSlot({ isMultivariateMode: false, xBound: true, yBound: false }),
    "y",
  );

  const empty = deriveMultivariateSlotBinding([]);
  assert.equal(empty.field, undefined);
  assert.equal(empty.showManager, false);
  assert.equal(empty.columns.length, 0);

  const single = deriveMultivariateSlotBinding([continuous("a")]);
  assert.equal(single.field?.name, "a");
  assert.equal(single.showManager, true);
  assert.deepEqual(single.columns.map((field) => field.name), ["a"]);

  const multi = deriveMultivariateSlotBinding([
    continuous("a"),
    continuous("b"),
  ]);
  assert.equal(multi.field, undefined);
  assert.equal(multi.showManager, true);
  assert.deepEqual(multi.columns.map((field) => field.name), ["a", "b"]);
}

{
  const continuous = (name: string) => ({ name, type: "continuous" as const });
  const nominal = (name: string) => ({ name, type: "nominal" as const });

  const appendResult = updateMultivariateColumns(
    [continuous("a"), continuous("b")],
    { type: "append", fields: [continuous("c"), continuous("d")] },
  );
  assert.equal(appendResult.error, undefined);
  assert.deepEqual(
    appendResult.columns.map((field) => field.name),
    ["a", "b", "c", "d"],
  );

  const reorderResult = updateMultivariateColumns(
    [continuous("a"), continuous("b"), continuous("c")],
    { type: "reorder", from: 2, to: 0 },
  );
  assert.equal(reorderResult.error, undefined);
  assert.deepEqual(
    reorderResult.columns.map((field) => field.name),
    ["c", "a", "b"],
  );

  const removeResult = updateMultivariateColumns(
    [continuous("a"), continuous("b"), continuous("c")],
    { type: "remove", index: 1 },
  );
  assert.equal(removeResult.error, undefined);
  assert.deepEqual(
    removeResult.columns.map((field) => field.name),
    ["a", "c"],
  );

  const duplicateResult = updateMultivariateColumns(
    [continuous("a"), continuous("b")],
    { type: "append", fields: [continuous("b")] },
  );
  assert.equal(duplicateResult.error, "duplicateField");
  assert.deepEqual(
    duplicateResult.columns.map((field) => field.name),
    ["a", "b"],
  );

  const categoricalResult = updateMultivariateColumns(
    [continuous("a"), continuous("b")],
    { type: "append", fields: [nominal("cat")] },
  );
  assert.equal(categoricalResult.error, "invalidFieldType");
  assert.deepEqual(
    categoricalResult.columns.map((field) => field.name),
    ["a", "b"],
  );

  const maxColumns = Array.from({ length: 20 }, (_, index) => continuous(`v${index + 1}`));
  const overflowResult = updateMultivariateColumns(maxColumns, {
    type: "append",
    fields: [continuous("v21")],
  });
  assert.equal(overflowResult.error, "maxColumns");
  assert.equal(overflowResult.columns.length, 20);
}

{
  const fit = createFitYByXItem({
    id: "fit-bivariate-request",
    name: "Fit Y by X 1",
    sourceDatasetId: "dataset-fit",
    response: { name: "height", type: "continuous" },
    factor: { name: "age", type: "continuous" },
    createdAt: new Date(0).toISOString(),
  });
  const graphItem = createEmbeddedGraphItem({
    id: `fit-y-by-x-graph:${fit.id}`,
    name: fit.name,
    sourceDatasetId: fit.sourceDatasetId,
    config: fit.graph,
    createdAt: fit.createdAt,
  });

  const { fields, filters, elements, sampling } = deriveGraphRequestParts(graphItem);

  assert.deepEqual(graphItem.modeStates.twoD.encoding.x, { name: "age", type: "continuous" });
  assert.deepEqual(graphItem.modeStates.twoD.encoding.y, { name: "height", type: "continuous" });
  assert.deepEqual(fields, [
    { role: "x", column: "age" },
    { role: "y", column: "height" },
  ]);
  assert.deepEqual(filters, []);
  assert.deepEqual(elements, [
    { kind: "points", summaryStat: "none" },
    { kind: "fitline", summaryStat: "none" },
  ]);
  assert.deepEqual(sampling, { mode: "full" });
  assert.equal(canExecuteGraphRequest(graphItem, fields, elements), true);
}

{
  const en = readJson("../src/i18n/locales/en.json");
  const vi = readJson("../src/i18n/locales/vi.json");
  const zhCn = readJson("../src/i18n/locales/zh-CN.json");
  const zhTw = readJson("../src/i18n/locales/zh-TW.json");
  const requiredLocalePaths = [
    "graph.rowStatus.pending",
    "graph.rowStatus.pendingRows",
    "graph.pipeline.progress",
    "graph.type.correlationMatrix",
    "graph.opt.correlationMethod",
    "graph.opt.correlation.pearson",
    "graph.opt.correlation.spearman",
    "graph.opt.correlation.kendall",
    "graph.correlation.requiresColumns",
    "graph.correlation.tooManyColumns",
    "graph.correlation.pair",
    "graph.correlation.coefficient",
    "graph.correlation.unavailableLabel",
    "graph.correlation.sampleCount",
    "graph.correlation.unavailableReason.insufficientData",
    "graph.correlation.unavailableReason.zeroVariance",
    "graph.correlation.unavailableReason.unknown",
    "graph.correlation.dropReason.duplicateField",
    "graph.correlation.dropReason.invalidFieldType",
  ];

  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(en, keyPath), "string", `en locale must define ${keyPath}`);
    assert.equal(typeof getPathValue(vi, keyPath), "string", `vi locale must define ${keyPath}`);
    assert.equal(typeof getPathValue(zhCn, keyPath), "string", `zh-CN locale must define ${keyPath}`);
    assert.equal(typeof getPathValue(zhTw, keyPath), "string", `zh-TW locale must define ${keyPath}`);
  }
}

{
  const projectStorePath = resolve(TEST_FILE_DIR, "../src/stores/useProjectStore.ts");
  const projectStoreSource = readFileSync(projectStorePath, "utf8");
  const projectStoreAst = parseTs("useProjectStore.ts", projectStoreSource);
  const workspacePath = resolve(TEST_FILE_DIR, "../src/components/Workspace.tsx");
  const workspaceSource = readFileSync(workspacePath, "utf8");
  const workspaceAst = parseTs("Workspace.tsx", workspaceSource);
  const dataTableViewSource = readFileSync(
    resolve(TEST_FILE_DIR, "../src/components/DataTableView.tsx"),
    "utf8",
  );
  const dataTableViewAst = parseTs("DataTableView.tsx", dataTableViewSource);
  const dataServiceSource = readFileSync(resolve(TEST_FILE_DIR, "../src/services/dataService.ts"), "utf8");

  const deletedPaths = [
    "../src/components/graphBuilder/loadGraphTableData.ts",
    "../src/utils/graphTableDataCache.ts",
    "../tests/loadGraphTableData.test.ts",
    "../tests/graphTableDataCache.test.ts",
  ];
  for (const relativePath of deletedPaths) {
    assert.equal(
      existsSync(resolve(TEST_FILE_DIR, relativePath)),
      false,
      `Task 4 cutover: ${relativePath} must be deleted`,
    );
  }

  assert.equal(
    referencesIdentifier(projectStoreAst, "graphTableDataCache"),
    false,
    "Task 4 migration: project lifecycle must not use obsolete graph table cache",
  );
  assert.equal(
    referencesIdentifier(workspaceAst, "graphTableDataCache"),
    false,
    "Task 4 migration: dataset deletion lifecycle must not use obsolete graph table cache",
  );
  assert.equal(
    referencesIdentifier(projectStoreAst, "loadGraphTableData"),
    false,
    "Project lifecycle store must not reference removed loadGraphTableData helper",
  );
  assert.equal(
    referencesIdentifier(workspaceAst, "loadGraphTableData"),
    false,
    "Workspace lifecycle view must not reference removed loadGraphTableData helper",
  );
  assert.equal(
    hasCallWithPropertyName(dataTableViewAst, "queryTableWindow"),
    true,
    "Table viewport/table view path must continue owning queryTableWindow access",
  );
  assert.equal(
    dataServiceSource.includes("queryTableWindow"),
    true,
    "dataService must continue owning queryTableWindow API",
  );
}

const payload = new ArrayBuffer(80);
new Float64Array(payload, 0, 2).set([1.5, 2.5]);
new Float64Array(payload, 16, 2).set([10.25, 20.5]);
new BigInt64Array(payload, 32, 2).set([101n, 102n]);
new Uint32Array(payload, 48, 2).set([0, 1]);
new Uint8Array(payload, 56, 1).set([0b00000001]);
new Uint8Array(payload, 64, 1).set([0b00000011]);

const decoded = decodeGraphPayload(
  {
    requestId: "req-1",
    generation: 7,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 2,
    sourceRows: 2,
    processedRows: 2,
    dictionaries: {
      x: ["Central", "East"],
    },
    validityRanges: {
      x: { type: "u8", offset: 56, byteLength: 1 },
      y: { type: "u8", offset: 64, byteLength: 1 },
    },
    xValues: { type: "u32", offset: 48, byteLength: 8 },
    yValues: { type: "f64", offset: 16, byteLength: 16 },
    rowIds: { type: "i64", offset: 32, byteLength: 16 },
    groupCodes: undefined,
    sizeValues: { type: "f64", offset: 0, byteLength: 16 },
    xEncoding: "categorical",
    finalChunk: true,
  },
  payload,
);

assert.deepEqual(Array.from(decoded.xValues), [0, 1]);
assert.deepEqual(Array.from(decoded.yValues), [10.25, 20.5]);
assert.deepEqual(Array.from(decoded.rowIds), [101n, 102n]);
assert.deepEqual(Array.from(decoded.sizeValues ?? []), [1.5, 2.5]);
assert.deepEqual(decoded.dictionaries.x, ["Central", "East"]);
assert.deepEqual(Array.from(decoded.validity.x), [0b00000001]);
assert.deepEqual(Array.from(decoded.validity.y), [0b00000011]);

const dynamicPayload = new ArrayBuffer(184);
new Uint32Array(dynamicPayload, 0, 2).set([0, 1]);
new Float64Array(dynamicPayload, 8, 2).set([10, 20]);
new BigInt64Array(dynamicPayload, 24, 2).set([901n, 902n]);
new Float64Array(dynamicPayload, 40, 2).set([100, 200]);
new Uint32Array(dynamicPayload, 56, 2).set([1, 0]);
new Uint32Array(dynamicPayload, 64, 2).set([0, 1]);
new Uint32Array(dynamicPayload, 72, 2).set([1, 0]);
new Uint32Array(dynamicPayload, 80, 2).set([0, 1]);
new Uint32Array(dynamicPayload, 88, 2).set([1, 1]);
new Uint32Array(dynamicPayload, 96, 2).set([1, 0]);
new Uint8Array(dynamicPayload, 104, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 112, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 120, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 128, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 136, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 144, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 152, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 160, 1).set([0b00000011]);
new Uint8Array(dynamicPayload, 168, 1).set([0b00000011]);

const dynamicDecoded = decodeGraphPayload(
  {
    requestId: "req-dynamic",
    generation: 8,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 2,
    sourceRows: 2,
    processedRows: 2,
    dictionaries: {
      x: ["A", "B"],
      source: ["m1", "m2"],
      group: ["G0", "G1"],
      facetX: ["L", "R"],
      facetY: ["Top", "Bottom"],
      facetZ: ["Front", "Back"],
      wrap: ["W1", "W2"],
    },
    validityRanges: {
      x: { type: "u8", offset: 104, byteLength: 1 },
      y: { type: "u8", offset: 112, byteLength: 1 },
      z: { type: "u8", offset: 120, byteLength: 1 },
      source: { type: "u8", offset: 128, byteLength: 1 },
      group: { type: "u8", offset: 136, byteLength: 1 },
      facetX: { type: "u8", offset: 144, byteLength: 1 },
      facetY: { type: "u8", offset: 152, byteLength: 1 },
      facetZ: { type: "u8", offset: 160, byteLength: 1 },
      wrap: { type: "u8", offset: 168, byteLength: 1 },
    },
    xValues: { type: "u32", offset: 0, byteLength: 8 },
    yValues: { type: "f64", offset: 8, byteLength: 16 },
    rowIds: { type: "i64", offset: 24, byteLength: 16 },
    zValues: { type: "f64", offset: 40, byteLength: 16 },
    roleVectors: {
      source: { type: "u32", offset: 56, byteLength: 8 },
      group: { type: "u32", offset: 64, byteLength: 8 },
      groupX: { type: "u32", offset: 72, byteLength: 8 },
      groupY: { type: "u32", offset: 80, byteLength: 8 },
      groupZ: { type: "u32", offset: 96, byteLength: 8 },
      wrap: { type: "u32", offset: 88, byteLength: 8 },
    },
    xEncoding: "categorical",
    finalChunk: true,
  } as GraphChunkHeader,
  dynamicPayload,
);

assert.deepEqual(Array.from(dynamicDecoded.sourceCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.groupCodes ?? []), [0, 1]);
assert.deepEqual(Array.from(dynamicDecoded.facetXCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.facetYCodes ?? []), [0, 1]);
assert.deepEqual(Array.from(dynamicDecoded.facetZCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.wrapCodes ?? []), [1, 1]);

{
  const request: GraphDataRequest = {
    requestId: "req-line-only",
    datasetId: "dataset-line-only",
    generation: 3,
    fields: [
      { role: "x", column: "x" },
      { role: "y", column: "y" },
    ],
    filters: [],
    elements: [{ kind: "line", summaryStat: "none" }],
    sampling: { mode: "full" },
    rawPointBudget: 8_000,
    viewport: { width: 1024, height: 768 },
  };

  const payload = new ArrayBuffer(88);
  new Float64Array(payload, 0, 3).set([11, 22, 33]);
  new Float64Array(payload, 24, 3).set([1.5, 2.5, 3.5]);
  new BigInt64Array(payload, 48, 3).set([401n, 402n, 403n]);
  new Uint8Array(payload, 72, 1).set([0b00000110]);
  new Uint8Array(payload, 80, 1).set([0b00000110]);

  const header: GraphChunkHeader = {
    requestId: request.requestId,
    generation: request.generation,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 3,
    sourceRows: 3,
    processedRows: 3,
    dictionaries: {},
    validityRanges: {
      x: { type: "u8", offset: 72, byteLength: 1 },
      y: { type: "u8", offset: 80, byteLength: 1 },
    },
    xValues: { type: "f64", offset: 0, byteLength: 24 },
    yValues: { type: "f64", offset: 24, byteLength: 24 },
    rowIds: { type: "i64", offset: 48, byteLength: 24 },
    xEncoding: "numeric",
    finalChunk: true,
  };

  const state0 = createInitialGraphStreamState();
  const state1 = reduceGraphStream(state0, { type: "start", request });
  const state2 = reduceGraphStream(state1, { type: "header", header });
  const state3 = reduceGraphStream(state2, { type: "payload", payload });
  const state4 = reduceGraphStream(state3, {
    type: "complete",
    completion: {
      requestId: request.requestId,
      datasetId: request.datasetId,
      generation: request.generation,
      sourceRows: 3,
      processedRows: 3,
      chunksSent: 1,
      cancelled: false,
      rawPointDisposition: { status: "included", validRows: 3, budget: 8_000 },
    },
  });

  assert.equal(state4.status, "ready");
  assert.equal(state4.error, null);
  assert.ok(state4.committed);
  assert.equal(state4.committed.rawChunks.length, 1);
  assert.deepEqual(Array.from(state4.committed.rawChunks[0].rowIds), [401n, 402n, 403n]);
  assert.deepEqual(state4.committed.extents.x, { min: 22, max: 33 });
  assert.deepEqual(state4.committed.extents.y, { min: 2.5, max: 3.5 });
}
assert.deepEqual(Array.from(dynamicDecoded.rowIds), [901n, 902n]);

assert.equal(isGraphAggregatePacket({ kind: "histogram" }), false);
assert.equal(isGraphAggregatePacket({ kind: "histogram", payload: {} }), false);
assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 2,
  bins: [],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [
    {
      group: "G1",
      category: "A",
      sourceColumn: "m1",
      facetX: "L",
      facetY: "Top",
      facetZ: undefined,
      wrap: "W1",
      binStart: 0,
      binEnd: 1,
      count: 1,
    },
  ],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [
    {
      group: "G1",
      category: "A",
      sourceColumn: "m1",
      facetX: "L",
      binStart: 0,
      binEnd: 1,
      count: 1,
    },
  ],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "boxPlot",
  yColumn: "cost",
  entries: [
    {
      count: 4,
      min: 1,
      q1: 2,
      median: 3,
      q3: 4,
      max: 5,
      whiskerLow: 1,
      whiskerHigh: 5,
      outliers: [],
    },
  ],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "boxPlot",
  yColumn: "cost",
  entries: [
    {
      group: "DV",
      category: "203-A6",
      sourceColumn: "203-A6",
      count: 4,
      min: 4.3,
      q1: 4.35,
      median: 4.4,
      q3: 4.45,
      max: 4.5,
      whiskerLow: 4.3,
      whiskerHigh: 4.5,
      outliers: [],
    },
  ],
}), true);

const validCorrelationPacket = {
  kind: "correlationMatrix" as const,
  method: "pearson",
  columns: ["a", "b"],
  cells: [
    { xIndex: 0, yIndex: 0, coefficient: 1, sampleCount: 10 },
    { xIndex: 1, yIndex: 0, coefficient: 0.5, sampleCount: 9 },
    { xIndex: 0, yIndex: 1, coefficient: 0.5, sampleCount: 9 },
    { xIndex: 1, yIndex: 1, coefficient: 1, sampleCount: 10 },
  ],
};

assert.equal(isGraphAggregatePacket(validCorrelationPacket), true);
assert.equal(isGraphAggregatePacket({ ...validCorrelationPacket, method: "distance" }), false);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: validCorrelationPacket.cells.slice(0, 3),
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    columns: ["a", "a"],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      validCorrelationPacket.cells[1],
      validCorrelationPacket.cells[2],
      { ...validCorrelationPacket.cells[3], xIndex: 0, yIndex: 0 },
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      validCorrelationPacket.cells[1],
      validCorrelationPacket.cells[2],
      { ...validCorrelationPacket.cells[3], xIndex: 2 },
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      validCorrelationPacket.cells[1],
      { ...validCorrelationPacket.cells[2], coefficient: 1.01 },
      validCorrelationPacket.cells[3],
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      { ...validCorrelationPacket.cells[1], sampleCount: -1 },
      validCorrelationPacket.cells[2],
      validCorrelationPacket.cells[3],
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      { ...validCorrelationPacket.cells[1], sampleCount: 2.5 },
      validCorrelationPacket.cells[2],
      validCorrelationPacket.cells[3],
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      { ...validCorrelationPacket.cells[1], coefficient: undefined },
      validCorrelationPacket.cells[2],
      validCorrelationPacket.cells[3],
    ],
  }),
  false,
);
assert.equal(
  isGraphAggregatePacket({
    ...validCorrelationPacket,
    cells: [
      validCorrelationPacket.cells[0],
      { ...validCorrelationPacket.cells[1], unavailableReason: "zeroVariance" },
      validCorrelationPacket.cells[2],
      validCorrelationPacket.cells[3],
    ],
  }),
  false,
);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-required-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        sourceRows: 2,
        processedRows: 2,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 56, byteLength: 1 },
        },
        xValues: { type: "u32", offset: 48, byteLength: 8 },
        yValues: { type: "f64", offset: 16, byteLength: 8 },
        rowIds: { type: "i64", offset: 32, byteLength: 16 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      payload,
    ),
  /rowCount/i,
);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-optional-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        sourceRows: 2,
        processedRows: 2,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 56, byteLength: 1 },
        },
        xValues: { type: "u32", offset: 48, byteLength: 8 },
        yValues: { type: "f64", offset: 16, byteLength: 16 },
        rowIds: { type: "i64", offset: 32, byteLength: 16 },
        groupCodes: { type: "u32", offset: 72, byteLength: 4 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      payload,
    ),
  /rowCount/i,
);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-validity-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 9,
        sourceRows: 9,
        processedRows: 9,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 184, byteLength: 1 },
        },
        xValues: { type: "u32", offset: 0, byteLength: 36 },
        yValues: { type: "f64", offset: 40, byteLength: 72 },
        rowIds: { type: "i64", offset: 112, byteLength: 72 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      new ArrayBuffer(256),
    ),
  /validity/i,
);

  assert.throws(
    () =>
      decodeGraphPayload(
        {
          requestId: "req-validity-oversized",
          generation: 7,
          chunkIndex: 0,
          rowOffset: 0,
          rowCount: 2,
          sourceRows: 2,
          processedRows: 2,
          dictionaries: {},
          validityRanges: {
            x: { type: "u8", offset: 56, byteLength: 2 },
          },
          xValues: { type: "u32", offset: 48, byteLength: 8 },
          yValues: { type: "f64", offset: 16, byteLength: 16 },
          rowIds: { type: "i64", offset: 32, byteLength: 16 },
          xEncoding: "categorical",
          finalChunk: false,
        },
        payload,
      ),
    /validity/i,
  );

function makeRequest(requestId: string, generation: number): GraphDataRequest {
  return {
    requestId,
    datasetId: "dataset-1",
    generation,
    fields: [
      { role: "x", column: "region" },
      { role: "y", column: "cost" },
    ],
    filters: [],
    elements: [{ kind: "points", summaryStat: "none" }],
    sampling: { mode: "full" },
    rawPointBudget: 8_000,
    viewport: { width: 1280, height: 720 },
  };
}

function makeHeader(
  requestId: string,
  generation: number,
  chunkIndex: number,
  finalChunk: boolean,
): GraphChunkHeader {
  return {
    requestId,
    generation,
    chunkIndex,
    rowOffset: chunkIndex * 2,
    rowCount: 2,
    sourceRows: 4,
    processedRows: (chunkIndex + 1) * 2,
    dictionaries: { x: ["Central", "East"] },
    validityRanges: {
      x: { type: "u8", offset: 56, byteLength: 1 },
      y: { type: "u8", offset: 64, byteLength: 1 },
    },
    xValues: { type: "u32", offset: 48, byteLength: 8 },
    yValues: { type: "f64", offset: 16, byteLength: 16 },
    rowIds: { type: "i64", offset: 32, byteLength: 16 },
    sizeValues: { type: "f64", offset: 0, byteLength: 16 },
    xEncoding: "categorical",
    finalChunk,
  };
}

function makePayload(seed: number): ArrayBuffer {
  const out = new ArrayBuffer(80);
  new Float64Array(out, 0, 2).set([1.5 + seed, 2.5 + seed]);
  new Float64Array(out, 16, 2).set([10.25 + seed, 20.5 + seed]);
  new BigInt64Array(out, 32, 2).set([BigInt(101 + seed), BigInt(102 + seed)]);
  new Uint32Array(out, 48, 2).set([0, 1]);
  new Uint8Array(out, 56, 1).set([0b00000011]);
  new Uint8Array(out, 64, 1).set([0b00000011]);
  return out;
}

function makeCompletion(requestId: string, generation: number, cancelled = false): GraphDataCompletion {
  return {
    requestId,
    datasetId: "dataset-1",
    generation,
    sourceRows: 4,
    processedRows: 4,
    chunksSent: 2,
    cancelled,
    rawPointDisposition: { status: "included", validRows: 4, budget: 8_000 },
  };
}

function makeCommittedFrame(): GraphDataFrame {
  return {
    requestId: "old-request",
    datasetId: "dataset-1",
    generation: 1,
    sourceRows: 2,
    processedRows: 2,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates: [],
    rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
  };
}

const histogramPacket = {
  kind: "histogram" as const,
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 2,
  bins: [],
};

function run(state: GraphStreamState, ...messages: Parameters<typeof reduceGraphStream>[1][]): GraphStreamState {
  let next = state;
  for (const message of messages) {
    next = reduceGraphStream(next, message);
  }
  return next;
}

function defaultModeStates(): GraphBuilderItem["modeStates"] {
  return {
    twoD: {
      encoding: {},
      multiX: [],
      multiY: [],
      elements: [{ kind: "points", enabled: true }],
      smootherLambda: 0.4,
    },
    threeD: {
      encoding: {},
      elements: [{ kind: "scatter3d", enabled: true }],
      smootherLambda: 0.4,
    },
    multivariate: {
      columns: [],
      chartType: "correlationMatrix",
      correlationMethod: "pearson",
    },
  };
}

function continuous(name: string): { name: string; type: "continuous" } {
  return { name, type: "continuous" };
}

function makeGraphBuilderItem(overrides: Record<string, unknown> = {}): GraphBuilderItem {
  return normalizeGraphBuilderItem({
    id: "graph-1",
    name: "Graph 1",
    sourceDatasetId: "dataset-1",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  });
}

function makeCanonicalGraphBuilderItem(input: {
  mode: GraphBuilderItem["mode"];
  modeStates: GraphBuilderItem["modeStates"];
  filters?: GraphBuilderItem["filters"];
  sampling?: GraphBuilderItem["sampling"];
}): GraphBuilderItem {
  return {
    id: "graph-1",
    name: "Graph 1",
    sourceDatasetId: "dataset-1",
    createdAt: new Date(0).toISOString(),
    mode: input.mode,
    modeStates: input.modeStates,
    filters: input.filters,
    sampling: input.sampling,
  };
}

function makeLegacyGraphBuilderItem(overrides: Record<string, unknown> = {}): GraphBuilderItem {
  const raw = overrides as {
    mode?: GraphBuilderItem["mode"];
    modeStates?: Partial<GraphBuilderItem["modeStates"]>;
    encoding?: Record<string, { name: string; type: "continuous" | "nominal" | "ordinal" | "date" }>;
    elements?: Array<{ kind: string; enabled?: boolean; options?: Record<string, unknown> }>;
    multiX?: Array<{ name: string; type: "continuous" | "nominal" | "ordinal" | "date" }>;
    multiY?: Array<{ name: string; type: "continuous" | "nominal" | "ordinal" | "date" }>;
    threeD?: boolean;
    filters?: GraphBuilderItem["filters"];
    sampling?: GraphBuilderItem["sampling"];
    hiddenGroups?: string[];
    groupStyles?: GraphBuilderItem["modeStates"]["twoD"]["groupStyles"];
    smootherLambda?: number;
  };

  return makeGraphBuilderItem(raw);
}

{
  const base = makeLegacyGraphBuilderItem({
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
      overlay: { name: "build", type: "nominal" },
    },
    elements: [{ kind: "boxplot", enabled: true }],
    hiddenGroups: [],
  });
  const visualOnlyChange = makeLegacyGraphBuilderItem({
    encoding: {
      x: { name: "category", type: "nominal" },
      y: { name: "measurement", type: "continuous" },
      overlay: { name: "build", type: "nominal" },
    },
    elements: [{ kind: "boxplot", enabled: true }],
    hiddenGroups: ["EV2"],
    groupStyles: {
      "TC1.6": { fill: { color: "#ff0000" } },
    },
  });
  const dataChange: GraphBuilderItem = {
    ...base,
    filters: [{
      op: "AND",
      rule: { kind: "categorical", field: "build", selected: ["EV2"] },
    }],
  };

  assert.equal(
    deriveGraphRequestIdentity(visualOnlyChange),
    deriveGraphRequestIdentity(base),
    "legend visibility and color edits must not restart the graph data stream",
  );
  assert.notEqual(
    deriveGraphRequestIdentity(dataChange),
    deriveGraphRequestIdentity(base),
    "filter edits must still restart the graph data stream",
  );
}

{
  const normalCurveItem = makeCanonicalGraphBuilderItem({
    mode: "2d",
    modeStates: {
      ...defaultModeStates(),
      twoD: {
        ...defaultModeStates().twoD,
        encoding: { y: continuous("measurement") },
        elements: [{ kind: "normalCurve", enabled: true }],
      },
    },
    sampling: { mode: "full" },
  });
  const parts = deriveGraphRequestParts(normalCurveItem);

  assert.deepEqual(parts.fields, [{ role: "y", column: "measurement" }]);
  assert.deepEqual(parts.elements, [{ kind: "normalCurve", summaryStat: "none" }]);
  assert.deepEqual(parts.sampling, { mode: "full" });
  assert.equal(canExecuteGraphRequest(normalCurveItem, parts.fields, parts.elements), true);
}

{
  const xOnlyNormalCurve = makeCanonicalGraphBuilderItem({
    mode: "2d",
    modeStates: {
      ...defaultModeStates(),
      twoD: {
        ...defaultModeStates().twoD,
        encoding: { x: continuous("measurement") },
        elements: [{ kind: "normalCurve", enabled: true }],
      },
    },
  });
  const parts = deriveGraphRequestParts(xOnlyNormalCurve);

  assert.deepEqual(parts.fields, [{ role: "y", column: "measurement" }]);
  assert.equal(canExecuteGraphRequest(xOnlyNormalCurve, parts.fields, parts.elements), true);
}

function makeEquivalentEmbeddedGraphItem(item: GraphBuilderItem): GraphBuilderItem {
  return createEmbeddedGraphItem({
    id: `${item.id}-embedded`,
    name: `${item.name} embedded`,
    sourceDatasetId: item.sourceDatasetId,
    createdAt: item.createdAt,
    config: {
      mode: item.mode,
      modeStates: item.modeStates,
      filters: item.filters,
      sampling: item.sampling,
    },
  });
}

function roleColumns(fields: ReturnType<typeof deriveFields>, role: string): string[] {
  return fields.filter((field) => field.role === role).map((field) => field.column);
}

function makeProgressedChunk(
  requestId: string,
  generation: number,
  chunkIndex: number,
  sourceRows: number,
  processedRows: number,
): Parameters<typeof reduceGraphStream>[1] {
  return {
    type: "chunk",
    chunk: {
      requestId,
      generation,
      chunkIndex,
      rowOffset: chunkIndex,
      rowCount: 1,
      sourceRows,
      processedRows,
      dictionaries: {},
      xEncoding: "numeric",
      finalChunk: false,
      xValues: new Float64Array([Number(chunkIndex)]),
      yValues: new Float64Array([Number(chunkIndex)]),
      rowIds: new BigInt64Array([BigInt(chunkIndex + 1)]),
      validity: {
        x: new Uint8Array([0b00000001]),
        y: new Uint8Array([0b00000001]),
      },
    },
  };
}

{
  const defaults = defaultModeStates();
  const interactive = makeCanonicalGraphBuilderItem({
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {
          x: { name: "site", type: "nominal" },
          y: { name: "height", type: "continuous" },
          overlay: { name: "batch", type: "ordinal" },
        },
        multiX: [],
        multiY: [],
        elements: [
          { kind: "points", enabled: true },
          { kind: "boxplot", enabled: true },
        ],
        smootherLambda: 0.4,
      },
      threeD: defaults.threeD,
      multivariate: defaults.multivariate,
    },
    filters: [
      { op: "AND", rule: { kind: "categorical", field: "site", selected: ["North", "South"] } },
    ],
    sampling: { mode: "full" },
  });
  const embedded = makeEquivalentEmbeddedGraphItem(interactive);

  assert.deepEqual(
    deriveGraphRequestParts(interactive),
    deriveGraphRequestParts(embedded),
    "equivalent interactive and embedded graph items must derive identical request parts",
  );
}

{
  const fitYByXItem = createFitYByXItem({
    id: "fit-1",
    name: "Fit Y by X 1",
    sourceDatasetId: "dataset-1",
    response: { name: "height", type: "continuous" },
    factor: { name: "site", type: "nominal" },
    createdAt: new Date(0).toISOString(),
  });
  const interactive = normalizeGraphBuilderItem({
    ...fitYByXItem.graph,
    id: "fit-y-by-x-graph:interactive",
    name: "Fit Y by X Interactive",
    sourceDatasetId: fitYByXItem.sourceDatasetId,
    createdAt: fitYByXItem.createdAt,
  });
  const embedded = createEmbeddedGraphItem({
    id: "fit-y-by-x-graph:fit-1",
    name: fitYByXItem.name,
    sourceDatasetId: fitYByXItem.sourceDatasetId,
    createdAt: fitYByXItem.createdAt,
    config: fitYByXItem.graph,
  });

  assert.deepEqual(
    deriveGraphRequestParts(interactive),
    deriveGraphRequestParts(embedded),
    "interactive Fit Y by X and embedded Fit Y by X items must derive identical request parts",
  );
}

{
  const reducerCancels: string[] = [];
  const coordinator = createStreamStartCancellationCoordinator((requestId, generation) => {
    reducerCancels.push(`${requestId}:${generation}`);
  });
  const handle = coordinator.activate("req-cancel-before-bind", 41);
  let transportCancelCalls = 0;

  handle.cancel();
  handle.cancel();
  handle.bindCancel(async () => {
    transportCancelCalls += 1;
  });

  assert.deepEqual(reducerCancels, ["req-cancel-before-bind:41"]);
  assert.equal(transportCancelCalls, 1);
}

{
  const reducerCancels: string[] = [];
  const coordinator = createStreamStartCancellationCoordinator((requestId, generation) => {
    reducerCancels.push(`${requestId}:${generation}`);
  });
  const oldHandle = coordinator.activate("req-old", 51);
  let oldTransportCancels = 0;
  oldHandle.bindCancel(async () => {
    oldTransportCancels += 1;
  });

  let oldCallbacks = 0;
  let newCallbacks = 0;
  const oldCallback = oldHandle.wrap(() => {
    oldCallbacks += 1;
  });

  const newHandle = coordinator.activate("req-new", 52);
  newHandle.bindCancel(async () => {});
  const newCallback = newHandle.wrap(() => {
    newCallbacks += 1;
  });

  oldCallback();
  newCallback();

  assert.deepEqual(reducerCancels, ["req-old:51"]);
  assert.equal(oldTransportCancels, 1);
  assert.equal(oldCallbacks, 0);
  assert.equal(newCallbacks, 1);
}

{
  const reducerCancels: string[] = [];
  const coordinator = createStreamStartCancellationCoordinator((requestId, generation) => {
    reducerCancels.push(`${requestId}:${generation}`);
  });
  const handle = coordinator.activate("req-normal", 61);
  let transportCancelCalls = 0;
  let callbackCalls = 0;
  handle.bindCancel(async () => {
    transportCancelCalls += 1;
  });

  const callback = handle.wrap(() => {
    callbackCalls += 1;
  });
  callback();

  assert.deepEqual(reducerCancels, []);
  assert.equal(transportCancelCalls, 0);
  assert.equal(callbackCalls, 1);
}

{
  const reducerCancels: string[] = [];
  const coordinator = createStreamStartCancellationCoordinator((requestId, generation) => {
    reducerCancels.push(`${requestId}:${generation}`);
  });
  const oldHandle = coordinator.activate("req-fail-cancel", 71);
  oldHandle.bindCancel(async () => {
    throw new Error("cancel failed");
  });

  let staleCommits = 0;
  let freshCommits = 0;
  const staleCommit = oldHandle.wrap(() => {
    staleCommits += 1;
  });

  const freshHandle = coordinator.activate("req-fresh", 72);
  const freshCommit = freshHandle.wrap(() => {
    freshCommits += 1;
  });

  staleCommit();
  freshCommit();

  assert.deepEqual(reducerCancels, ["req-fail-cancel:71"]);
  assert.equal(staleCommits, 0);
  assert.equal(freshCommits, 1);
}

{
  const contract: GraphLoadProgress = {
    processedRows: 0,
    sourceRows: 0,
    percent: null,
  };
  assert.deepEqual(Object.keys(contract).sort(), ["percent", "processedRows", "sourceRows"]);
}

{
  const request = makeRequest("req-progress-monotonic", 31);
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request },
    makeProgressedChunk("req-progress-monotonic", 31, 0, 10, 8),
    makeProgressedChunk("req-progress-monotonic", 31, 1, 8, 6),
  );

  assert.deepEqual(state.progress, {
    processedRows: 8,
    sourceRows: 10,
    percent: 80,
  });
}

{
  const request = makeRequest("req-stale-complete", 32);
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request },
    {
      type: "complete",
      completion: {
        ...makeCompletion("other-request", 32),
      },
    },
  );

  assert.equal(state.pending?.request.requestId, "req-stale-complete");
  assert.equal(state.committed?.requestId, "old-request");
}

{
  const start = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-explicit-cancel", 33) },
    { type: "header", header: makeHeader("req-explicit-cancel", 33, 0, false) },
  );
  const cancelled = reduceGraphStream(start, {
    type: "cancel",
    requestId: "req-explicit-cancel",
    generation: 33,
  });

  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.pendingHeader, null);
  assert.equal(cancelled.committed?.requestId, "old-request");
  assert.equal(cancelled.status, "ready");
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-zero", 34) },
    {
      type: "complete",
      completion: {
        requestId: "req-zero",
        datasetId: "dataset-1",
        generation: 34,
        sourceRows: 0,
        processedRows: 0,
        chunksSent: 0,
        cancelled: false,
        rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
      },
    },
  );

  assert.equal(state.status, "ready");
  assert.equal(state.error, null);
  assert.equal(state.committed?.requestId, "req-zero");
  assert.deepEqual(state.progress, {
    processedRows: 0,
    sourceRows: 0,
    percent: 100,
  });
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-points-omitted", 35) },
    { type: "aggregate", packet: histogramPacket },
    {
      type: "complete",
      completion: {
        requestId: "req-points-omitted",
        datasetId: "dataset-1",
        generation: 35,
        sourceRows: 8_001,
        processedRows: 8_001,
        chunksSent: 0,
        cancelled: false,
        rawPointDisposition: {
          status: "omitted",
          reason: "pointBudgetExceeded",
          validRows: 8_001,
          budget: 8_000,
        },
      },
    },
  );

  assert.equal(state.status, "ready");
  assert.equal(state.error, null);
  assert.equal(state.committed?.rawChunks.length, 0);
  assert.equal(state.committed?.aggregates.length, 1);
  assert.deepEqual(state.committed?.rawPointDisposition, {
    status: "omitted",
    reason: "pointBudgetExceeded",
    validRows: 8_001,
    budget: 8_000,
  });
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-included-without-chunks", 36) },
    {
      type: "complete",
      completion: {
        requestId: "req-included-without-chunks",
        datasetId: "dataset-1",
        generation: 36,
        sourceRows: 1,
        processedRows: 1,
        chunksSent: 0,
        cancelled: false,
        rawPointDisposition: {
          status: "included",
          validRows: 1,
          budget: 8_000,
        },
      },
    },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /inconsistent chunksSent/i);
}

{
  const initial = createInitialGraphStreamState(makeCommittedFrame());
  const request = makeRequest("req-atomic", 7);
  const afterChunks = run(
    initial,
    { type: "start", request },
    { type: "aggregate", packet: histogramPacket },
    { type: "header", header: makeHeader("req-atomic", 7, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-atomic", 7, 1, true) },
    { type: "payload", payload: makePayload(10) },
  );

  assert.equal(afterChunks.committed?.requestId, "old-request");
  assert.equal(afterChunks.pending?.chunks.length, 2);

  const committed = reduceGraphStream(afterChunks, {
    type: "complete",
    completion: makeCompletion("req-atomic", 7),
  });

  assert.equal(committed.pending, null);
  assert.equal(committed.committed?.requestId, "req-atomic");
  assert.equal(committed.committed?.rawChunks.length, 2);
  assert.equal(committed.committed?.aggregates.length, 1);
  assert.equal(committed.error, null);
}

{
  const request = makeRequest("req-terminal-before-payload", 13);
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request },
    { type: "header", header: makeHeader("req-terminal-before-payload", 13, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-terminal-before-payload", 13, 1, true) },
    { type: "complete", completion: makeCompletion("req-terminal-before-payload", 13) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /pending header/i);
}

{
  const request = makeRequest("req-stale", 3);
  const state = run(
    createInitialGraphStreamState(),
    { type: "start", request },
    { type: "header", header: makeHeader("req-stale", 2, 0, false) },
    { type: "header", header: makeHeader("other-request", 3, 0, false) },
  );

  assert.equal(state.pending?.chunks.length, 0);
  assert.equal(state.pendingHeader, null);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-dup", 9) },
    { type: "header", header: makeHeader("req-dup", 9, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-dup", 9, 0, true) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /out of order/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-out-of-order", 17) },
    { type: "header", header: makeHeader("req-out-of-order", 17, 1, false) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /out of order/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-order", 4) },
    { type: "payload", payload: makePayload(0) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /payload/i);
}

{
  const start = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-cancel", 10) },
    { type: "header", header: makeHeader("req-cancel", 10, 0, false) },
  );
  const cancelled = reduceGraphStream(start, {
    type: "complete",
    completion: makeCompletion("req-cancel", 10, true),
  });

  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.committed?.requestId, "old-request");
}

{
  const mismatch = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-terminal-mismatch", 12) },
    { type: "header", header: makeHeader("req-terminal-mismatch", 12, 0, true) },
    { type: "payload", payload: makePayload(0) },
    {
      type: "complete",
      completion: {
        ...makeCompletion("req-terminal-mismatch", 12),
        chunksSent: 2,
      },
    },
  );

  assert.equal(mismatch.pending, null);
  assert.equal(mismatch.committed?.requestId, "old-request");
  assert.match(mismatch.error ?? "", /inconsistent/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-error", 11) },
    { type: "error", requestId: "req-stale", generation: 10, error: "stale" },
  );

  assert.equal(state.pending?.request.requestId, "req-error");

  const errored = reduceGraphStream(state, {
    type: "error",
    requestId: "req-error",
    generation: 11,
    error: "boom",
  });
  assert.equal(errored.pending, null);
  assert.equal(errored.committed?.requestId, "old-request");
  assert.equal(errored.error, "boom");
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  let completionCalls = 0;
  const request = makeRequest("req-transport-order", 22);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: () => {
      events.push("payload");
    },
    onComplete: () => {
      events.push("complete");
      completionCalls += 1;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-transport-order", 22, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-transport-order", 22),
    chunksSent: 1,
  });

  assert.equal(transportError, null);
  assert.deepEqual(events, ["header", "payload", "complete"]);
  assert.equal(completionCalls, 1);
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  let payloadByteLength = 0;
  let receivedBytes: number[] = [];
  const request = makeRequest("req-transport-byte-array", 29);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: (payload) => {
      events.push("payload");
      payloadByteLength = payload.byteLength;
      receivedBytes = Array.from(new Uint8Array(payload));
    },
    onAggregate: () => {},
    onComplete: () => {
      events.push("complete");
    },
    onError: (message) => {
      transportError = message;
    },
  });

  const payload = makePayload(0);
  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader(request.requestId, request.generation, 0, true),
  });
  transport.onChannelMessage(Array.from(new Uint8Array(payload)));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion(request.requestId, request.generation),
    chunksSent: 1,
  });

  assert.equal(transportError, null);
  assert.equal(payloadByteLength, payload.byteLength);
  assert.deepEqual(receivedBytes, Array.from(new Uint8Array(payload)));
  assert.deepEqual(events, ["header", "payload", "complete"]);
}

{
  let transportError: string | null = null;
  const request = makeRequest("req-transport-sparse-byte-array", 30);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onAggregate: () => {},
    onComplete: () => {},
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader(request.requestId, request.generation, 0, true),
  });
  transport.onChannelMessage([1, , 3]);

  assert.match(transportError ?? "", /unknown chunk/i);
}

{
  let aggregate: GraphAggregatePacket | null = null;
  let transportError: string | null = null;
  const request = makeRequest("req-correlation-null-options", 23);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onAggregate: (packet) => {
      aggregate = packet;
    },
    onComplete: () => {},
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader(request.requestId, request.generation, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage(JSON.stringify({
    messageType: "aggregate",
    kind: "correlationMatrix",
    method: "pearson",
    columns: ["a", "b"],
    cells: [
      { xIndex: 0, yIndex: 0, coefficient: 1, sampleCount: 10, unavailableReason: null },
      { xIndex: 1, yIndex: 0, coefficient: null, sampleCount: 10, unavailableReason: "zeroVariance" },
      { xIndex: 0, yIndex: 1, coefficient: null, sampleCount: 10, unavailableReason: "zeroVariance" },
      { xIndex: 1, yIndex: 1, coefficient: 1, sampleCount: 10, unavailableReason: null },
    ],
  }));

  assert.equal(transportError, null);
  assert.equal(aggregate?.kind, "correlationMatrix");
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  const request: GraphDataRequest = {
    ...makeRequest("req-correlation-aggregate-only", 27),
    elements: [{ kind: "correlationMatrix", summaryStat: "none", correlationMethod: "pearson" }],
  };
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: () => {
      events.push("payload");
    },
    onAggregate: (packet) => {
      events.push(`aggregate:${packet.kind}`);
    },
    onComplete: () => {
      events.push("complete");
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "aggregate",
    ...validCorrelationPacket,
  });
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion(request.requestId, request.generation),
    chunksSent: 0,
  });

  assert.equal(transportError, null);
  assert.deepEqual(events, ["aggregate:correlationMatrix", "complete"]);
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  const request: GraphDataRequest = {
    ...makeRequest("req-correlation-aggregate-only-wrong-kind", 28),
    elements: [{ kind: "correlationMatrix", summaryStat: "none", correlationMethod: "pearson" }],
  };
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: () => {
      events.push("payload");
    },
    onAggregate: () => {
      events.push("aggregate");
    },
    onComplete: () => {
      events.push("complete");
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "aggregate",
    kind: "summary",
    yColumn: "cost",
    summaries: [],
  });

  assert.deepEqual(events, []);
  assert.match(transportError ?? "", /aggregate/i);
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  const request = makeRequest("req-omitted-aggregate", 27);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => events.push("header"),
    onPayload: () => events.push("payload"),
    onAggregate: () => events.push("aggregate"),
    onComplete: () => events.push("complete"),
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({ messageType: "aggregate", ...histogramPacket });
  transport.onChannelMessage({
    messageType: "complete",
    requestId: request.requestId,
    datasetId: request.datasetId,
    generation: request.generation,
    sourceRows: 8_001,
    processedRows: 8_001,
    chunksSent: 0,
    cancelled: false,
    rawPointDisposition: {
      status: "omitted",
      reason: "pointBudgetExceeded",
      validRows: 8_001,
      budget: 8_000,
    },
  });

  assert.equal(transportError, null);
  assert.deepEqual(events, ["aggregate", "complete"]);
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  const request = makeRequest("req-aggregate-before-raw", 25);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: () => {
      events.push("payload");
    },
    onAggregate: () => {
      events.push("aggregate");
    },
    onComplete: () => {
      events.push("complete");
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "aggregate",
    kind: "summary",
    yColumn: "cost",
    summaries: [],
  });
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion(request.requestId, request.generation),
    chunksSent: 0,
  });

  assert.deepEqual(events, []);
  assert.match(transportError ?? "", /aggregate/i);
}

{
  let aggregate: GraphAggregatePacket | null = null;
  let transportError: string | null = null;
  const request = makeRequest("req-aggregate-null-options", 27);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onAggregate: (packet) => {
      aggregate = packet;
    },
    onComplete: () => {},
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-aggregate-null-options", 27, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage(JSON.stringify({
    messageType: "aggregate",
    kind: "histogram",
    xColumn: null,
    yColumn: "cost",
    groupColumn: null,
    sourceColumn: null,
    binCount: 1,
    minValue: 0,
    maxValue: 1,
    missingCount: 0,
    binWidth: 1,
    totalCount: 1,
    bins: [{
      group: null,
      category: null,
      sourceColumn: null,
      facetX: null,
      facetY: null,
      facetZ: null,
      wrap: null,
      binStart: 0,
      binEnd: 1,
      count: 1,
    }],
  }));

  assert.equal(transportError, null);
  assert.equal(aggregate?.kind, "histogram");
}

{
  const request = makeRequest("req-cross-byte-extents", 26);
  const payload = new ArrayBuffer(216);
  new Uint32Array(payload, 0, 10).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  new Float64Array(payload, 40, 10).set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  new BigInt64Array(payload, 120, 10).set([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  new Uint8Array(payload, 200, 2).set([0b00000001, 0b00000001]);
  new Uint8Array(payload, 208, 2).set([0b00000001, 0b00000010]);

  const header: GraphChunkHeader = {
    requestId: "req-cross-byte-extents",
    generation: 26,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 10,
    sourceRows: 10,
    processedRows: 10,
    dictionaries: {},
    validityRanges: {
      x: { type: "u8", offset: 200, byteLength: 2 },
      y: { type: "u8", offset: 208, byteLength: 2 },
    },
    xValues: { type: "u32", offset: 0, byteLength: 40 },
    yValues: { type: "f64", offset: 40, byteLength: 80 },
    rowIds: { type: "i64", offset: 120, byteLength: 80 },
    xEncoding: "categorical",
    finalChunk: true,
  };

  const state = run(
    createInitialGraphStreamState(null),
    { type: "start", request },
    { type: "header", header },
    { type: "payload", payload },
    { type: "complete", completion: {
      requestId: "req-cross-byte-extents",
      datasetId: "dataset-1",
      generation: 26,
      sourceRows: 10,
      processedRows: 10,
      chunksSent: 1,
      cancelled: false,
      rawPointDisposition: { status: "included", validRows: 2, budget: 8_000 },
    } },
  );

  assert.equal(state.status, "ready");
  assert.equal(state.error, null);
  assert.deepEqual(state.committed?.extents.x, { min: 0, max: 8 });
  assert.deepEqual(state.committed?.extents.y, { min: 10, max: 19 });
}

{
  let completed = false;
  let transportError: string | null = null;
  const request = makeRequest("req-invoke-before-terminal", 23);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onComplete: () => {
      completed = true;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onInvokeResolved({
    ...makeCompletion("req-invoke-before-terminal", 23),
    chunksSent: 1,
  });
  assert.equal(completed, false);

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-invoke-before-terminal", 23, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-invoke-before-terminal", 23),
    chunksSent: 1,
  });

  assert.equal(transportError, null);
  assert.equal(completed, true);
}

{
  let completed = false;
  let transportError: string | null = null;
  const request = makeRequest("req-terminal-incomplete", 24);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onComplete: () => {
      completed = true;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-terminal-incomplete", 24, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-terminal-incomplete", 24),
    chunksSent: 2,
  });

  assert.equal(completed, false);
  assert.match(transportError ?? "", /inconsistent chunksSent/i);
}

{
  const noColumns = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
  });
  const oneColumn = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      multivariate: {
        columns: [continuous("only_one")],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
  });
  const twoColumns = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      multivariate: {
        columns: [continuous("c0"), continuous("c1")],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
  });

  assert.equal(canExecuteGraphRequest(noColumns, deriveGraphRequestParts(noColumns).fields, deriveGraphRequestParts(noColumns).elements), false);
  assert.equal(canExecuteGraphRequest(oneColumn, deriveGraphRequestParts(oneColumn).fields, deriveGraphRequestParts(oneColumn).elements), false);
  assert.equal(canExecuteGraphRequest(twoColumns, deriveGraphRequestParts(twoColumns).fields, deriveGraphRequestParts(twoColumns).elements), true);
}

{
  const correlationItem = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      twoD: {
        ...defaultModeStates().twoD,
        encoding: {
          x: continuous("inactive_x"),
          y: continuous("inactive_y"),
        },
      },
      multivariate: {
        columns: [continuous("a"), continuous("b"), continuous("c")],
        chartType: "correlationMatrix",
        correlationMethod: "spearman",
      },
    },
    filters: [
      {
        id: "corr-filter",
        op: "AND",
        rule: {
          kind: "categorical",
          field: { name: "segment", type: "nominal" },
          selected: ["A"],
          exclude: false,
        },
      },
    ],
  });

  assert.deepEqual(roleColumns(deriveFields(correlationItem), "multiY0"), ["a"]);
  assert.deepEqual(roleColumns(deriveFields(correlationItem), "multiY2"), ["c"]);
  assert.deepEqual(roleColumns(deriveFields(correlationItem), "x"), []);
  assert.deepEqual(roleColumns(deriveFields(correlationItem), "filter"), ["segment"]);
  const correlationElementsExpected: GraphElementRequest[] = [
    { kind: "correlationMatrix", summaryStat: "none", correlationMethod: "spearman" },
  ];
  assert.deepEqual(deriveElements(correlationItem), correlationElementsExpected);
  assert.deepEqual(
    deriveFields(correlationItem).filter((field) => field.column === "__sp_variable__" || field.column === "__sp_value__"),
    [],
  );

  const invalidMethodItem = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      multivariate: {
        columns: [continuous("k0"), continuous("k1")],
        chartType: "correlationMatrix",
        correlationMethod: "distance" as "pearson",
      },
    },
  });

  const invalidCorrelationElementsExpected: GraphElementRequest[] = [
    { kind: "correlationMatrix", summaryStat: "none", correlationMethod: "pearson" },
  ];
  assert.deepEqual(deriveElements(invalidMethodItem), invalidCorrelationElementsExpected);

  const mixedCorrelationItem = makeCanonicalGraphBuilderItem({
    mode: "2d",
    modeStates: {
      ...defaultModeStates(),
      twoD: {
        ...defaultModeStates().twoD,
        encoding: {
          x: continuous("x_active"),
          y: continuous("y_active"),
        },
      },
      multivariate: {
        columns: [continuous("my0"), continuous("my1"), continuous("my2")],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [
      {
        id: "corr-filter",
        op: "AND",
        rule: {
          kind: "categorical",
          field: { name: "segment", type: "nominal" },
          selected: ["A"],
          exclude: false,
        },
      },
    ],
  });

  assert.deepEqual(deriveFields(mixedCorrelationItem), [
    { role: "x", column: "x_active" },
    { role: "y", column: "y_active" },
    { role: "filter", column: "segment" },
  ]);

  const sampledMultivariateItem = makeCanonicalGraphBuilderItem({
    mode: "multivariate",
    modeStates: {
      ...defaultModeStates(),
      multivariate: {
        columns: [continuous("s0"), continuous("s1")],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    sampling: { mode: "sample", size: 100, seed: 7 },
  });
  assert.deepEqual(deriveGraphRequestParts(sampledMultivariateItem).sampling, { mode: "full" });

  const rawItem = makeLegacyGraphBuilderItem({
    elements: [
      { kind: "points", enabled: true, options: { summaryStat: "none" } },
      { kind: "fitline", enabled: true, options: { degree: 1 } },
    ],
    sampling: { mode: "full" },
  });
  const rawParts = deriveGraphRequestParts(rawItem);

  assert.deepEqual(rawParts.sampling, {
    mode: "sample",
    size: SCATTER_RENDER_BUDGET,
    seed: 0,
  });
  assert.deepEqual(rawParts.elements.map((element) => element.kind), ["points", "fitline"]);

  const boxItem = makeLegacyGraphBuilderItem({
    elements: [{ kind: "boxplot", enabled: true }],
    sampling: { mode: "full" },
  });

  assert.deepEqual(deriveGraphRequestParts(boxItem).sampling, { mode: "full" });
}

{
  const colorGrouped = makeLegacyGraphBuilderItem({
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "segment", type: "nominal" },
    },
    hiddenGroups: ["A"],
  });
  const fields = deriveFields(colorGrouped);
  assert.deepEqual(roleColumns(fields, "group"), ["segment"]);
  assert.deepEqual(roleColumns(fields, "x"), ["x"]);
  assert.deepEqual(roleColumns(fields, "y"), ["y"]);

  const overlayFallback = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        overlay: { name: "ov", type: "nominal" },
        color: { name: "segment", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(overlayFallback, "group"), ["ov"]);

  const groupXFallback = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        groupX: { name: "gx", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(groupXFallback, "group"), ["gx"]);
  assert.deepEqual(roleColumns(groupXFallback, "groupX"), ["gx"]);

  const groupYFallback = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        groupY: { name: "gy", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(groupYFallback, "group"), ["gy"]);
  assert.deepEqual(roleColumns(groupYFallback, "groupY"), ["gy"]);

  const groupZFallback = deriveFields(
    makeLegacyGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z", type: "continuous" },
        groupZ: { name: "gz", type: "nominal" },
      },
      hiddenGroups: ["A"],
      elements: [{ kind: "scatter3d", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(groupZFallback, "group"), ["gz"]);
  assert.deepEqual(roleColumns(groupZFallback, "groupZ"), ["gz"]);
}

{
  const activeMultiX = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x_stale", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      multiX: [
        { name: "mx0", type: "continuous" },
        { name: "mx1", type: "continuous" },
        { name: "mx2", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiX, "x"), ["x_stale"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX0"), ["mx0"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX1"), ["mx1"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX2"), ["mx2"]);

  const multiXAxisItem = makeLegacyGraphBuilderItem({
    encoding: {},
    multiX: [
      { name: "203-A6", type: "continuous" },
      { name: "203-A7", type: "continuous" },
      { name: "203-A8", type: "continuous" },
      { name: "203-A9", type: "continuous" },
    ],
    elements: [
      { kind: "points", enabled: true },
      { kind: "boxplot", enabled: true },
    ],
  });
  const multiXAxisParts = deriveGraphRequestParts(multiXAxisItem);
  assert.equal(
    canExecuteGraphRequest(multiXAxisItem, multiXAxisParts.fields, multiXAxisParts.elements),
    true,
    "multi-X axis mode must issue a graph data request",
  );

  const activeMultiY = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y_stale", type: "continuous" },
      },
      multiY: [
        { name: "my0", type: "continuous" },
        { name: "my1", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiY, "y"), ["y_stale"]);
  assert.deepEqual(roleColumns(activeMultiY, "multiY0"), ["my0"]);
  assert.deepEqual(roleColumns(activeMultiY, "multiY1"), ["my1"]);
  const multiYOnlyItem = makeLegacyGraphBuilderItem({
    encoding: {},
    multiY: [
      { name: "my0", type: "continuous" },
      { name: "my1", type: "continuous" },
    ],
  });
  const multiYOnlyParts = deriveGraphRequestParts(multiYOnlyItem);
  assert.equal(
    canExecuteGraphRequest(multiYOnlyItem, multiYOnlyParts.fields, multiYOnlyParts.elements),
    true,
  );

  const activeMultiBoth = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x_stale", type: "continuous" },
        y: { name: "y_stale", type: "continuous" },
      },
      multiX: [
        { name: "mx0", type: "continuous" },
        { name: "mx1", type: "continuous" },
      ],
      multiY: [
        { name: "my0", type: "continuous" },
        { name: "my1", type: "continuous" },
        { name: "my2", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiBoth, "multiX0"), ["mx0"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiX1"), ["mx1"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY0"), ["my0"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY1"), ["my1"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY2"), ["my2"]);

  const staleInactiveMulti = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      multiX: [{ name: "only_one", type: "continuous" }],
      multiY: [{ name: "also_one", type: "continuous" }],
    }),
  );

  assert.deepEqual(roleColumns(staleInactiveMulti, "multiX0"), []);
  assert.deepEqual(roleColumns(staleInactiveMulti, "multiY0"), []);
}

{
  const hiddenWrapFacet = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        wrap: { name: "facet_col", type: "nominal" },
      },
      hiddenGroups: ["facet-a"],
    }),
  );
  assert.deepEqual(roleColumns(hiddenWrapFacet, "group"), ["facet_col"]);
  assert.deepEqual(roleColumns(hiddenWrapFacet, "wrap"), ["facet_col"]);
}

{
  const staleUnused = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        size: { name: "size_unused", type: "continuous" },
        color: { name: "color_unused", type: "nominal" },
        wrap: { name: "wrap_unused", type: "nominal" },
      },
      elements: [{ kind: "line", enabled: true }],
      filters: [
        {
          id: "f1",
          op: "AND",
          rule: {
            kind: "categorical",
            field: { name: "category_filter", type: "nominal" },
            selected: ["A"],
            exclude: false,
          },
        },
      ],
    }),
  );

  assert.deepEqual(roleColumns(staleUnused, "size"), []);
  assert.deepEqual(roleColumns(staleUnused, "group"), ["color_unused"]);
  assert.deepEqual(roleColumns(staleUnused, "filter"), ["category_filter"]);

  const pointsWithSize = deriveFields(
    makeLegacyGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        size: { name: "point_size", type: "continuous" },
      },
      elements: [{ kind: "points", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(pointsWithSize, "size"), ["point_size"]);

  const no3DElement = deriveFields(
    makeLegacyGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z_unused", type: "continuous" },
      },
      elements: [{ kind: "line", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(no3DElement, "z"), []);

  const with3DElement = deriveFields(
    makeLegacyGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z", type: "continuous" },
      },
      elements: [{ kind: "scatter3d", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(with3DElement, "z"), ["z"]);
}

console.log("graph-data fixture + decoder passed");

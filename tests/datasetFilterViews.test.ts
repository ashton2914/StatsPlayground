import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deriveGraphRequestParts } from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import { createDatasetFilterStore, useDatasetFilterStore } from "../src/stores/useDatasetFilterStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import type { FilterRuleItem } from "../src/types/filter.ts";
import type { GraphBuilderItem, GraphRuntimeItem } from "../src/types/graphBuilder.ts";
import { serializeTableWindowFilters } from "../src/utils/tableViewport.ts";

function categoricalFilter(id: string, value: string): FilterRuleItem {
  return {
    id,
    op: "AND",
    rule: {
      kind: "categorical",
      field: { name: "build", type: "nominal" },
      selected: [value],
      exclude: false,
    },
  };
}

function graph(id: string, sourceDatasetId: string): GraphBuilderItem {
  return {
    id,
    name: id,
    sourceDatasetId,
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {
          x: { name: "build", type: "nominal" },
          y: { name: "measurement", type: "continuous" },
        },
        multiX: [],
        multiY: [],
        elements: [{ kind: "points", enabled: true }],
        smootherLambda: 0.4,
      },
      threeD: { encoding: {}, elements: [], smootherLambda: 0.4 },
      multivariate: { columns: [], chartType: "correlationMatrix", correlationMethod: "pearson" },
    },
    createdAt: new Date(0).toISOString(),
  };
}

function runtime(item: GraphBuilderItem, filters: FilterRuleItem[]): GraphRuntimeItem {
  return { ...item, filters };
}

const store = createDatasetFilterStore();
store.getState().replaceFilters("table-a", [categoricalFilter("filter-a", "DV")]);
store.getState().replaceFilters("table-b", [categoricalFilter("filter-b", "EV")]);

const firstConsumer = store.getState().byDataset["table-a"] ?? [];
const remountedConsumer = store.getState().byDataset["table-a"] ?? [];
assert.strictEqual(remountedConsumer, firstConsumer);

const graphOne = graph("graph-1", "table-a");
const graphTwo = graph("graph-2", "table-a");
const otherGraph = graph("graph-3", "table-b");
const initialOne = deriveGraphRequestParts(runtime(graphOne, firstConsumer));
const initialTwo = deriveGraphRequestParts(runtime(graphTwo, firstConsumer));
const initialOther = deriveGraphRequestParts(runtime(otherGraph, store.getState().byDataset["table-b"]));

assert.deepEqual(initialOne.filters, initialTwo.filters);
assert.deepEqual(serializeTableWindowFilters(firstConsumer), initialOne.filters);

store.getState().replaceFilters("table-a", [categoricalFilter("filter-a", "PQ")]);
const replaced = store.getState().byDataset["table-a"];
const replacedOne = deriveGraphRequestParts(runtime(graphOne, replaced));
const replacedTwo = deriveGraphRequestParts(runtime(graphTwo, replaced));
assert.deepEqual(serializeTableWindowFilters(replaced), replacedOne.filters);
assert.deepEqual(replacedOne.filters, replacedTwo.filters);
assert.notDeepEqual(replacedOne.filters, initialOne.filters);
assert.deepEqual(
  deriveGraphRequestParts(runtime(otherGraph, store.getState().byDataset["table-b"])).filters,
  initialOther.filters,
);

useDatasetFilterStore.getState().reset();
useGraphBuilderStore.getState().reset();
try {
  const datasetFilter = categoricalFilter("dataset-filter", "DV");
  useDatasetFilterStore.getState().replaceFilters("table-a", [datasetFilter]);
  const legacyImportedGraph = {
    ...graph("legacy-import", "table-a"),
    filters: [categoricalFilter("legacy-filter", "EV")],
  } as GraphBuilderItem;

  useGraphBuilderStore.getState().addItem(legacyImportedGraph);

  const imported = useGraphBuilderStore.getState().items[0];
  assert.equal(Object.hasOwn(imported, "filters"), false);
  assert.deepEqual(useDatasetFilterStore.getState().byDataset["table-a"], [datasetFilter]);

  useGraphBuilderStore.getState().deleteItem(imported.id);
  assert.deepEqual(useDatasetFilterStore.getState().byDataset["table-a"], [datasetFilter]);

  useGraphBuilderStore.getState().addItem(graph("new-graph", "table-a"));
  const newGraph = useGraphBuilderStore.getState().items[0];
  assert.deepEqual(
    deriveGraphRequestParts(runtime(
      newGraph,
      useDatasetFilterStore.getState().byDataset["table-a"],
    )).filters,
    serializeTableWindowFilters([datasetFilter]),
  );
} finally {
  useGraphBuilderStore.getState().reset();
  useDatasetFilterStore.getState().reset();
}

const tableSource = readFileSync(new URL("../src/components/DataTableView.tsx", import.meta.url), "utf8");
const graphSource = readFileSync(new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url), "utf8");

assert.doesNotMatch(tableSource, /useState<FilterRuleItem\[\]>/);
assert.doesNotMatch(tableSource, /setTableFilters\(/);
assert.match(tableSource, /useDatasetFilterStore/);
assert.match(tableSource, /replaceDatasetFilters\(datasetId, next\)/);
assert.doesNotMatch(graphSource, /updateItem\(item\.id,\s*\{\s*filters:/);
assert.match(graphSource, /useDatasetFilterStore/);
assert.match(graphSource, /item=\{runtimeItem\}/);
assert.match(graphSource, /if \(replaceDatasetFilters\(dataset\.id, next\)\) markDirty\(\)/);
assert.match(graphSource, /if \(!readOnly && nextItem\.filters\) \{\s*if \(replaceDatasetFilters\(dataset\.id, nextItem\.filters\)\) markDirty\(\);\s*\}/s);
assert.doesNotMatch(graphSource, /groupThemeSlots: resolvedThemeSlots \}\);\s*markDirty\(\)/);
assert.doesNotMatch(graphSource, /sampling:[\s\S]{0,120}markDirty\(\)/);

console.log("dataset Filter view ownership passed");
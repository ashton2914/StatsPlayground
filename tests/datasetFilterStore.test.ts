import assert from "node:assert";
import { type StoreApi } from "zustand/vanilla";

import { useProjectStore } from "../src/stores/useProjectStore";
import type { FilterRuleItem } from "../src/types/filter";

import {
  createDatasetFilterStore,
  type DatasetFilterMap,
  type DatasetFilterState,
  useDatasetFilterStore,
} from "../src/stores/useDatasetFilterStore";

function continuousRule(id: string, fieldName: string, columnId: string, min: number, max: number): FilterRuleItem {
  return {
    id,
    op: "AND",
    rule: {
      kind: "continuous",
      field: { name: fieldName, columnId, type: "continuous" },
      min,
      max,
    },
  };
}

function categoricalRule(
  id: string,
  fieldName: string,
  columnId: string,
  values: string[],
): FilterRuleItem {
  return {
    id,
    op: "OR",
    rule: {
      kind: "categorical",
      field: { name: fieldName, columnId, type: "nominal" },
      selected: [...values],
      exclude: true,
    },
    height: 24,
  };
}

function run(): void {
  assert.equal(typeof useDatasetFilterStore, "function");

  const store: StoreApi<DatasetFilterState> = createDatasetFilterStore();
  assert.equal(typeof store.getState().replaceFilters, "function");
  assert.equal(typeof store.getState().renameColumn, "function");
  assert.equal(typeof store.getState().removeDataset, "function");

  const initialShape: DatasetFilterMap = store.getState().byDataset;
  assert.deepEqual(initialShape, {});

  // Independent datasets + immutable cloning
  const aRules = [continuousRule("flt-a", "Length", "length-col", 1, 5)];
  const bRules = [categoricalRule("flt-b", "Build", "build-col", ["DV"])];

  const replacedA = store.getState().replaceFilters("table-a", aRules);
  const replacedB = store.getState().replaceFilters("table-b", bRules);
  assert.equal(replacedA, true);
  assert.equal(replacedB, true);

  assert.deepEqual(store.getState().byDataset["table-a"], aRules);
  assert.deepEqual(store.getState().byDataset["table-b"], bRules);

  // No-op replacement returns false
  assert.equal(store.getState().replaceFilters("table-a", store.getState().byDataset["table-a"]), false);

  // Immutable input cloning: mutating original array after replace should not affect store
  const mutable = [continuousRule("flt-x", "X", "x-col", 0, 1)];
  store.getState().replaceFilters("table-x", mutable);
  mutable[0].rule.field.name = "Changed";
  assert.equal(store.getState().byDataset["table-x"][0].rule.field.name, "X");

  // renameColumn updates nested field path and preserves the rest of the rule payload
  const renamed = store.getState().renameColumn("table-a", "Length", "Len");
  assert.equal(renamed, true);
  assert.equal(store.getState().byDataset["table-a"][0].rule.field.name, "Len");
  assert.deepEqual(store.getState().byDataset["table-a"][0].rule.field.columnId, "length-col");
  assert.deepEqual(store.getState().byDataset["table-a"][0].rule.field.type, "continuous");
  assert.deepEqual(store.getState().byDataset["table-a"][0].op, "AND");
  assert.deepEqual(store.getState().byDataset["table-a"][0].id, "flt-a");

  const renamedCategorical = store.getState().renameColumn("table-b", "Build", "Build Name");
  assert.equal(renamedCategorical, true);
  assert.deepEqual(store.getState().byDataset["table-b"][0].rule.field.columnId, "build-col");
  const renamedRule = store.getState().byDataset["table-b"][0].rule;
  assert.equal(renamedRule.kind, "categorical");
  if (renamedRule.kind !== "categorical") throw new Error("Expected categorical rule");
  assert.deepEqual(renamedRule.selected, ["DV"]);
  assert.equal(renamedRule.exclude, true);
  assert.deepEqual(store.getState().byDataset["table-b"][0].height, 24);
  assert.deepEqual(store.getState().byDataset["table-b"][0].op, "OR");

  // replaceFilters with an empty list should delete the dataset entry entirely
  assert.equal(store.getState().replaceFilters("table-b", []), true);
  assert.equal(Object.prototype.hasOwnProperty.call(store.getState().byDataset, "table-b"), false);
  assert.equal(store.getState().replaceFilters("table-b", []), false);

  // removeDataset
  const removed = store.getState().removeDataset("table-x");
  assert.equal(removed, true);
  assert.equal(Object.keys(store.getState().byDataset).includes("table-x"), false);

  // loadFromProject and reset must still replace/clear stale mappings while read-only
  const prevReadOnly = useProjectStore.getState().readOnly;
  try {
    store.getState().replaceFilters("stale-table", [continuousRule("flt-stale", "Stale", "stale-col", 0, 1)]);
    useProjectStore.setState({ readOnly: true });
    store.getState().loadFromProject({
      "table-c": [categoricalRule("flt-c", "Stage", "stage-col", ["EV"])],
    });
    assert.deepEqual(store.getState().toProjectPayload(), {
      "table-c": [categoricalRule("flt-c", "Stage", "stage-col", ["EV"])],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(store.getState().byDataset, "stale-table"), false);

    store.getState().reset();
    assert.deepEqual(store.getState().toProjectPayload(), {});

    assert.equal(store.getState().replaceFilters("missing-table", []), false);
    assert.equal(store.getState().renameColumn("missing-table", "Length", "Length 2"), false);
    assert.equal(store.getState().removeDataset("missing-table"), false);

    const readOnlyRules = [continuousRule("flt-a", "Length", "length-col", 1, 5)];
    store.getState().loadFromProject({ "table-a": readOnlyRules });
    assert.equal(store.getState().replaceFilters("table-a", readOnlyRules), false);
    assert.equal(store.getState().renameColumn("table-a", "Missing", "Other"), false);

    assert.throws(() => {
      store.getState().replaceFilters("table-a", [continuousRule("flt-a2", "Length", "length-col", 0, 2)]);
    }, /Project is read-only/);
    assert.throws(() => {
      store.getState().renameColumn("table-a", "Length", "Length 2");
    }, /Project is read-only/);
    assert.throws(() => {
      store.getState().removeDataset("table-a");
    }, /Project is read-only/);
  } finally {
    useProjectStore.setState({ readOnly: prevReadOnly });
  }

  // All done
  // print minimal summary for automation
  // eslint-disable-next-line no-console
  console.log("datasetFilterStore: OK");
}

run();

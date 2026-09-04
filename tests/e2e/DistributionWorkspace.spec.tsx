import { expect, test } from "@playwright/experimental-ct-react";

import { createDistributionItem } from "../../src/components/distribution/distributionConfig";
import * as distributionViewModule from "../../src/components/distribution/DistributionView";

const currentColumns = [
  { name: "value", sqlType: "DOUBLE", integerCompatible: false, field: { name: "value", type: "continuous" as const } },
];
const currentItem = createDistributionItem({
  id: "distribution-1", name: "Distribution 1", sourceDatasetId: "dataset-1",
  responses: [currentColumns[0].field], weight: null, frequency: null, by: [],
  columns: currentColumns, createdAt: "2026-01-01T00:00:00.000Z",
});

test("keeps the source relationship on the persisted definition", () => {
  expect(currentItem.sourceDatasetId).toBe("dataset-1");
  expect(currentItem.responses).toEqual([{ name: "value", type: "continuous" }]);
  expect(currentItem).not.toHaveProperty("runState");
  expect(currentItem).not.toHaveProperty("snapshotId");
});

test("materializes four stable embedded GraphRuntime documents", () => {
  const graphs = distributionViewModule.materializeDistributionGraphItems(currentItem);

  expect(Object.keys(graphs)).toEqual(["overview", "boxPlot", "ecdf", "normalQuantile"]);
  expect(graphs.overview.id).toBe("distribution-graph:distribution-1:overview");
  expect(graphs.boxPlot.sourceDatasetId).toBe("dataset-1");
  expect(graphs.ecdf.modeStates.twoD.encoding.x?.name).toBe("value");
});

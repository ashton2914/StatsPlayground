import { expect, test } from "@playwright/experimental-ct-react";

import { createDistributionItem } from "../../src/components/distribution/distributionConfig";
import { useDistributionStore } from "../../src/stores/useDistributionStore";
import { useFolderStore } from "../../src/stores/useFolderStore";
import { useProjectStore } from "../../src/stores/useProjectStore";

const field = { name: "value", type: "continuous" as const };
const currentItem = createDistributionItem({
  id: "distribution-stable-1", name: "Distribution 1", sourceDatasetId: "dataset-1",
  responses: [field], weight: null, frequency: null, by: [],
  columns: [{ name: "value", sqlType: "DOUBLE", integerCompatible: false, field }],
  createdAt: "2026-01-01T00:00:00.000Z",
});

test.beforeEach(() => {
  useProjectStore.setState({ readOnly: false });
  useDistributionStore.setState({ items: [], counter: 0 });
  useFolderStore.getState().reset();
});

test("keeps directory actions keyed by the stable Distribution ID", () => {
  useDistributionStore.getState().addItem(currentItem);
  useDistributionStore.getState().renameItem(currentItem.id, "Revenue");

  expect(useDistributionStore.getState().items).toHaveLength(1);
  expect(useDistributionStore.getState().items[0].id).toBe("distribution-stable-1");
  expect(useDistributionStore.getState().items[0].name).toBe("Revenue");
});

test("moves a Distribution definition through the shared folder tree", () => {
  useDistributionStore.getState().addItem(currentItem);
  const folder = useFolderStore.getState().createFolder(null, "Analysis");
  useFolderStore.getState().setDistributionFolder(currentItem.id, folder);

  expect(useFolderStore.getState().distributionFolders).toEqual({
    "distribution-stable-1": "Analysis",
  });

  useFolderStore.getState().deleteFolder("Analysis");
  expect(useFolderStore.getState().distributionFolders).toEqual({});
  expect(useDistributionStore.getState().items[0].id).toBe(currentItem.id);
});

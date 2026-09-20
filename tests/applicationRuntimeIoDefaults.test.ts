import assert from "node:assert/strict";

import { createApplicationRuntime } from "@/applicationCommands/applicationRuntime";
import { ioService } from "@/services/ioService";

const originalInspectAuthorizedCsvTarget = ioService.inspectAuthorizedCsvTarget;
const originalExportCsvAuthorized = ioService.exportCsvAuthorized;
const inspections: Array<{ datasetId: string; rootId: string; relativePath: string }> = [];
const exports: Array<{
  datasetId: string;
  rootId: string;
  relativePath: string;
  overwriteConfirmed: boolean;
}> = [];

ioService.inspectAuthorizedCsvTarget = async (datasetId, rootId, relativePath) => {
  inspections.push({ datasetId, rootId, relativePath });
  return { targetExists: false };
};
ioService.exportCsvAuthorized = async (datasetId, rootId, relativePath, overwriteConfirmed) => {
  exports.push({ datasetId, rootId, relativePath, overwriteConfirmed });
};

const runtime = createApplicationRuntime();

try {
  const result = await runtime.execute(
    {
      type: "table.exportCsv",
      input: {
        datasetId: "table-1",
        rootId: "root-1",
        relativePath: "exports/table-1.csv",
      },
    },
    { kind: "ui" },
  );

  assert.equal(result.data.targetStatus, "createNew");
  assert.deepEqual(inspections, [
    { datasetId: "table-1", rootId: "root-1", relativePath: "exports/table-1.csv" },
    { datasetId: "table-1", rootId: "root-1", relativePath: "exports/table-1.csv" },
  ]);
  assert.deepEqual(exports, [
    {
      datasetId: "table-1",
      rootId: "root-1",
      relativePath: "exports/table-1.csv",
      overwriteConfirmed: false,
    },
  ]);
} finally {
  await runtime.shutdown();
  ioService.inspectAuthorizedCsvTarget = originalInspectAuthorizedCsvTarget;
  ioService.exportCsvAuthorized = originalExportCsvAuthorized;
}

console.log("application runtime IO default dependency test passed");

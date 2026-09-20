import assert from "node:assert/strict";

import { test } from "vitest";

import type {
  ColumnDescriptor,
  ColumnMutationResult,
  RowMutationResult,
} from "../src/types/data.ts";

const rowResult: RowMutationResult = {
  rowIds: [41, 42],
  generation: 8,
  rowCount: 102,
  changeSetId: "rows-change",
};
const columnResult: ColumnMutationResult = {
  columnIds: ["column-new"],
  generation: 9,
  columnCount: 4,
  changeSetId: "columns-change",
};
const invokeCalls: Array<{ command: string; args: unknown }> = [];

Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        return command.includes("columns") ? columnResult : rowResult;
      },
    },
  },
});

const addedColumn: ColumnDescriptor = {
  columnId: "column-new",
  name: "new value",
  sqlType: "DOUBLE",
};
const deletedColumn: ColumnDescriptor = {
  columnId: "column-old",
  name: "old value",
  sqlType: "VARCHAR",
};

test("uses exact compact mutation payloads and returns typed results", async () => {
  const { dataService } = await import("../src/services/dataService.ts");

  assert.deepEqual(await dataService.addRows("dataset-1", 2, 41, 7), rowResult);
  assert.deepEqual(
    await dataService.deleteRowsWithChangeSet("dataset-1", [11, 12], 8),
    rowResult,
  );
  assert.deepEqual(
    await dataService.addColumnsWithChangeSet("dataset-1", [addedColumn], 2, 8),
    columnResult,
  );
  assert.deepEqual(
    await dataService.deleteColumnsWithChangeSet("dataset-1", [deletedColumn], 9),
    columnResult,
  );

  assert.deepEqual(invokeCalls, [
    {
      command: "add_rows",
      args: {
        datasetId: "dataset-1",
        count: 2,
        beforeRowId: 41,
        expectedGeneration: 7,
      },
    },
    {
      command: "delete_rows_with_change_set",
      args: {
        datasetId: "dataset-1",
        rowIds: [11, 12],
        expectedGeneration: 8,
      },
    },
    {
      command: "add_columns_with_change_set",
      args: {
        datasetId: "dataset-1",
        columns: [addedColumn],
        atIndex: 2,
        expectedGeneration: 8,
      },
    },
    {
      command: "delete_columns_with_change_set",
      args: {
        datasetId: "dataset-1",
        columns: [deletedColumn],
        expectedGeneration: 9,
      },
    },
  ]);
});

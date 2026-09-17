import assert from "node:assert/strict";

import {
  canManageMcpCommandRequest,
  listMcpCommandRequestsFromRuntimeSnapshot,
} from "../src/services/mcpManagementService.ts";
import type { RuntimeRequestSnapshot } from "../src/applicationCommands/runtime.ts";

const snapshot: RuntimeRequestSnapshot[] = [
  {
    requestId: "ui-1",
    command: "table.exportCsv",
    status: "awaiting-confirmation",
    actor: { kind: "ui" },
    stage: "confirmation",
    message: "UI request",
    percent: null,
  },
  {
    requestId: "mcp-1",
    command: "snapshot.create",
    status: "running",
    actor: { kind: "mcp", clientId: "desktop" },
    stage: "running",
    message: "Exporting rows",
    percent: 55,
  },
];

assert.deepEqual(listMcpCommandRequestsFromRuntimeSnapshot(snapshot), [
  {
    requestId: "mcp-1",
    command: "snapshot.create",
    status: "running",
    stage: "running",
    message: "Exporting rows",
    percent: 55,
  },
]);
assert.equal(canManageMcpCommandRequest(snapshot, "ui-1"), false);
assert.equal(canManageMcpCommandRequest(snapshot, "mcp-1"), true);
assert.equal(canManageMcpCommandRequest(snapshot, "missing"), false);

console.log("mcp management service tests passed");
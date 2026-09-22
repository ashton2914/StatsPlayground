import assert from "node:assert/strict";

import {
  canManageMcpCommandRequest,
  listMcpCommandRequestsFromRuntimeSnapshot,
  mcpManagementService,
} from "../src/services/mcpManagementService.ts";
import type { RuntimeRequestSnapshot } from "../src/applicationCommands/runtime.ts";
import type { McpSettingsState } from "../src/types/mcp.ts";

const savedSettings: McpSettingsState = {
  settings: {
    port: 48123,
    token: "a".repeat(32),
  },
};
const invokeCalls: Array<{ command: string; args: unknown }> = [];

Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        invokeCalls.push({ command, args });
        if (command === "generate_mcp_token") {
          return "b".repeat(32);
        }
        return savedSettings;
      },
    },
  },
});

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

assert.deepEqual(await mcpManagementService.getSettings(), savedSettings);
assert.deepEqual(
  await mcpManagementService.saveSettings({
    port: 48123,
    token: "a".repeat(32),
  }),
  savedSettings,
);
assert.equal(await mcpManagementService.generateToken(), "b".repeat(32));
assert.deepEqual(invokeCalls, [
  { command: "get_mcp_settings", args: {} },
  {
    command: "save_mcp_settings",
    args: {
      settings: {
        port: 48123,
        token: "a".repeat(32),
      },
    },
  },
  { command: "generate_mcp_token", args: {} },
]);

console.log("mcp management service tests passed");
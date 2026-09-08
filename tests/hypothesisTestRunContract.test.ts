import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  HypothesisTestRequest,
  HypothesisTestResponse,
} from "../src/types/hypothesisTest.ts";

const request = {
  analysisKind: "hypothesisTest",
  analysisId: "analysis-1",
  datasetId: "dataset-1",
  generation: 7,
  configRevision: 3,
  definition: {},
  requestFingerprint: "fingerprint-1",
} as HypothesisTestRequest;
const response = {
  analysisKind: request.analysisKind,
  analysisId: request.analysisId,
  datasetId: request.datasetId,
  generation: request.generation,
  configRevision: request.configRevision,
  requestFingerprint: request.requestFingerprint,
} as HypothesisTestResponse;

const invokeCalls: Array<{ command: string; args: unknown }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        if (command === "run_hypothesis_test") return response;
        throw new Error(`unexpected command: ${command}`);
      },
    },
  },
});

const { hypothesisTestService } = await import("../src/services/hypothesisTestService.ts");
assert.deepEqual(await hypothesisTestService.run(request), response);
assert.deepEqual(invokeCalls, [
  { command: "run_hypothesis_test", args: { request } },
]);

const commandSource = readFileSync(
  resolve(process.cwd(), "src-tauri/src/commands/hypothesis_test_commands.rs"),
  "utf8",
);
assert.match(commandSource, /pub fn run_hypothesis_test\(/);
assert.match(commandSource, /HypothesisTestService::new\(&state\)\.run\(request\)/);

const libSource = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
assert.match(
  libSource,
  /commands::hypothesis_test_commands::run_hypothesis_test,/,
);
import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkCargoTargetDir,
  buildTauriDevArgs,
  parseTransportBenchmarkArgs,
} from "./measureTableNavigationTransportCore.mjs";

test("isolates the benchmark Cargo target from other worktrees", () => {
  assert.equal(
    benchmarkCargoTargetDir("/repo"),
    "/repo/src-tauri/target/table-navigation-transport",
  );
});

test("uses an isolated dev port for both Tauri and Vite", () => {
  const options = parseTransportBenchmarkArgs([
    "--artifact", "artifacts/transport.json",
    "--dev-port", "1421",
  ]);

  assert.equal(options.devPort, 1421);
  assert.deepEqual(buildTauriDevArgs(options), [
    "run",
    "tauri",
    "--",
    "dev",
    "--release",
    "--features",
    "perf-harness",
    "--config",
    JSON.stringify({
      build: {
        devUrl: "http://127.0.0.1:1421",
        beforeDevCommand: "npm run dev -- --host 127.0.0.1 --port 1421 --strictPort",
      },
    }),
  ]);
});

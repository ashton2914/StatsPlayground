import path from "node:path";

export function benchmarkCargoTargetDir(repoRoot) {
  return path.join(repoRoot, "src-tauri", "target", "table-navigation-transport");
}

export function parseTransportBenchmarkArgs(argv) {
  const options = {
    rows: 10_000_000,
    columns: 20,
    positionPercent: 99,
    warmup: 5,
    iterations: 20,
    visibleRows: 40,
    devPort: 1420,
    artifact: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    switch (flag) {
      case "--rows":
        options.rows = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--columns":
        options.columns = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--position-percent":
        options.positionPercent = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--warmup":
        options.warmup = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--iterations":
        options.iterations = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--visible-rows":
        options.visibleRows = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--dev-port":
        options.devPort = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--artifact":
        options.artifact = next;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!Number.isInteger(options.rows) || options.rows < 1) {
    throw new Error("--rows must be a positive integer");
  }
  if (!Number.isInteger(options.columns) || options.columns < 1) {
    throw new Error("--columns must be a positive integer");
  }
  if (!Number.isInteger(options.positionPercent) || options.positionPercent < 0 || options.positionPercent > 100) {
    throw new Error("--position-percent must be between 0 and 100");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isInteger(options.visibleRows) || options.visibleRows < 1) {
    throw new Error("--visible-rows must be a positive integer");
  }
  if (!Number.isInteger(options.devPort) || options.devPort < 1 || options.devPort > 65_535) {
    throw new Error("--dev-port must be an integer between 1 and 65535");
  }
  if (!options.artifact) {
    throw new Error("--artifact is required");
  }
  return options;
}

export function buildTauriDevArgs(options) {
  return [
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
        devUrl: `http://127.0.0.1:${options.devPort}`,
        beforeDevCommand: `npm run dev -- --host 127.0.0.1 --port ${options.devPort} --strictPort`,
      },
    }),
  ];
}

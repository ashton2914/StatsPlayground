import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  benchmarkCargoTargetDir,
  buildTauriDevArgs,
  parseTransportBenchmarkArgs,
} from "./measureTableNavigationTransportCore.mjs";

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarize(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
  };
}

function buildArtifact(options, rawRuns, appEnvironment, payloadSnapshotPath) {
  const measuredRuns = rawRuns.filter((run) => !run.warmup);
  const measuredQuery = measuredRuns.map((run) => run.queryMs);
  const measuredDiagnosticJsonEncode = measuredRuns
    .map((run) => run.diagnosticJsonEncodeMs)
    .filter((value) => typeof value === "number");
  const measuredInvokeWall = measuredRuns.map((run) => run.invokeWallMs);
  const measuredPostBackendDelivery = measuredRuns
    .map((run) => run.postBackendDeliveryMs)
    .filter((value) => typeof value === "number");
  const measuredPostReceiveJsonReparse = measuredRuns.map((run) => run.postReceiveJsonReparseMs);
  const measuredPaint = measuredRuns.map((run) => run.paintMs);
  const measuredDiagnosticJsonBytes = measuredRuns
    .map((run) => run.diagnosticJsonBytes)
    .filter((value) => typeof value === "number");
  return {
    command: {
      npmScript: "npm run tauri -- dev --release",
      env: {
        VITE_TABLE_NAVIGATION_TRANSPORT_BENCHMARK: "1",
        VITE_TABLE_NAVIGATION_TRANSPORT_ROWS: String(options.rows),
        VITE_TABLE_NAVIGATION_TRANSPORT_COLUMNS: String(options.columns),
        VITE_TABLE_NAVIGATION_TRANSPORT_POSITION_PERCENT: String(options.positionPercent),
        VITE_TABLE_NAVIGATION_TRANSPORT_WARMUP: String(options.warmup),
        VITE_TABLE_NAVIGATION_TRANSPORT_ITERATIONS: String(options.iterations),
        VITE_TABLE_NAVIGATION_TRANSPORT_VISIBLE_ROWS: String(options.visibleRows),
      },
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      app: appEnvironment,
    },
    workload: {
      rows: options.rows,
      columns: options.columns,
      positionPercent: options.positionPercent,
      visibleRows: options.visibleRows,
      warmupRuns: options.warmup,
      measuredRuns: options.iterations,
    },
    progress: {
      completedRuns: rawRuns.length,
      totalRuns: options.warmup + options.iterations,
      measuredRunsCompleted: measuredRuns.length,
      done: rawRuns.length === options.warmup + options.iterations,
    },
    methodology: {
      queryMs: "actual query_table_navigation_window result.timings.totalMs for each invoke",
      diagnosticJsonEncodeMs: "diagnostics-gated command-side serde_json::to_vec(result); proxy for backend JSON encoding, not raw Tauri serializer timing",
      invokeWallMs: "frontend performance.now from invoke start to Promise resolution for each run",
      postBackendDeliveryMs: "frontend resolved wall-clock epoch minus backend diagnosticResponseReadyAtEpochMs for each run",
      postReceiveJsonReparseMs: "benchmark-only JSON.stringify/JSON.parse after invoke resolution for each run; post-receive proxy, not native bridge decode timing",
      paintMs: "TableViewportRows paint inside the Tauri WebView until the expected cell is verified plus two requestAnimationFrame ticks",
      diagnosticJsonBytes: "diagnostics-gated JSON byte length of the returned response shape for each run",
      payloadSnapshotPath,
    },
    summary: {
      queryMs: summarize(measuredQuery),
      diagnosticJsonEncodeMs: summarize(measuredDiagnosticJsonEncode),
      invokeWallMs: summarize(measuredInvokeWall),
      postBackendDeliveryMs: summarize(measuredPostBackendDelivery),
      postReceiveJsonReparseMs: summarize(measuredPostReceiveJsonReparse),
      paintMs: summarize(measuredPaint),
      diagnosticJsonBytes: summarize(measuredDiagnosticJsonBytes),
      shareOf100Ms: {
        queryP95: (percentile(measuredQuery, 0.95) ?? 0) / 100,
        diagnosticJsonEncodeP95: (percentile(measuredDiagnosticJsonEncode, 0.95) ?? 0) / 100,
        invokeWallP95: (percentile(measuredInvokeWall, 0.95) ?? 0) / 100,
        postBackendDeliveryP95: (percentile(measuredPostBackendDelivery, 0.95) ?? 0) / 100,
        postReceiveJsonReparseP95: (percentile(measuredPostReceiveJsonReparse, 0.95) ?? 0) / 100,
        paintP95: (percentile(measuredPaint, 0.95) ?? 0) / 100,
      },
    },
    rawRuns,
  };
}

function writeArtifact(artifactPath, artifact) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function writeErrorArtifact(artifactPath, error, rawRuns) {
  writeArtifact(`${artifactPath}.error.json`, {
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    },
    rawRuns,
  });
}

function toPosixRelativePath(repoRoot, targetPath) {
  return path.relative(repoRoot, targetPath).split(path.sep).join("/");
}

function ensurePayloadSnapshotPath(artifactPath) {
  return artifactPath.endsWith(".json")
    ? artifactPath.replace(/\.json$/u, ".payload.json")
    : `${artifactPath}.payload.json`;
}

function collectChildLogs(child) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
    process.stderr.write(chunk);
  });
  return () => output;
}

async function terminateChild(child) {
  if (!child || child.exitCode != null) {
    return;
  }
  if (process.platform === "win32") {
    child.kill("SIGTERM");
  } else {
    process.kill(-child.pid, "SIGTERM");
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const options = parseTransportBenchmarkArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const artifactPath = path.resolve(repoRoot, options.artifact);
  const payloadSnapshotPath = ensurePayloadSnapshotPath(artifactPath);
  const rawRuns = [];
  let appEnvironment = null;
  let child = null;
  let settled = false;

  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/result") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (payload.error) {
          throw new Error(payload.error);
        }
        appEnvironment = {
          runtime: process.platform === "darwin" ? "tauri-wkwebview" : "tauri-webview",
          userAgent: payload.userAgent,
        };
        if (payload.payloadSnapshot != null) {
          writeArtifact(payloadSnapshotPath, payload.payloadSnapshot);
        }
        rawRuns.push(...payload.rawRuns);
        const artifact = buildArtifact(
          options,
          rawRuns,
          appEnvironment,
          toPosixRelativePath(repoRoot, payloadSnapshotPath),
        );
        writeArtifact(artifactPath, artifact);
        fs.rmSync(`${artifactPath}.error.json`, { force: true });
        settled = true;
        response.writeHead(204).end();
        process.stdout.write(`${JSON.stringify(artifact.summary)}\n`);
        server.close();
        await terminateChild(child);
      } catch (error) {
        settled = true;
        writeErrorArtifact(artifactPath, error, rawRuns);
        response.writeHead(500).end();
        server.close();
        await terminateChild(child);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind table transport benchmark receiver");
  }
  const callbackUrl = `http://127.0.0.1:${address.port}/result`;
  const cargoTargetDir = benchmarkCargoTargetDir(repoRoot);
  child = spawn("npm", buildTauriDevArgs(options), {
    cwd: repoRoot,
    env: {
      ...process.env,
      VITE_TABLE_NAVIGATION_TRANSPORT_BENCHMARK: "1",
      VITE_TABLE_NAVIGATION_TRANSPORT_BENCHMARK_CALLBACK: callbackUrl,
      VITE_TABLE_NAVIGATION_TRANSPORT_ROWS: String(options.rows),
      VITE_TABLE_NAVIGATION_TRANSPORT_COLUMNS: String(options.columns),
      VITE_TABLE_NAVIGATION_TRANSPORT_POSITION_PERCENT: String(options.positionPercent),
      VITE_TABLE_NAVIGATION_TRANSPORT_WARMUP: String(options.warmup),
      VITE_TABLE_NAVIGATION_TRANSPORT_ITERATIONS: String(options.iterations),
      VITE_TABLE_NAVIGATION_TRANSPORT_VISIBLE_ROWS: String(options.visibleRows),
      CARGO_TARGET_DIR: cargoTargetDir,
      CARGO_BUILD_TARGET_DIR: cargoTargetDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  const readLogs = collectChildLogs(child);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      if (!settled) {
        const error = new Error(`Table transport benchmark timed out: ${readLogs()}`);
        writeErrorArtifact(artifactPath, error, rawRuns);
        await terminateChild(child);
        server.close();
        reject(error);
      }
    }, 20 * 60 * 1_000);

    child.once("error", async (error) => {
      clearTimeout(timeout);
      writeErrorArtifact(artifactPath, error, rawRuns);
      server.close();
      await terminateChild(child);
      reject(error);
    });

    child.once("exit", async (code) => {
      clearTimeout(timeout);
      if (!settled) {
        const error = new Error(`Tauri transport benchmark exited before reporting results (code ${code ?? "unknown"}): ${readLogs()}`);
        writeErrorArtifact(artifactPath, error, rawRuns);
        server.close();
        await terminateChild(child);
        reject(error);
        return;
      }
      resolve();
    });

    server.once("close", () => {
      clearTimeout(timeout);
      if (settled) {
        resolve();
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
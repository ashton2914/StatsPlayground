import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(root, "test-results/graph-new-transport/report.json");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const appExecutable = resolve(
  root,
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "stats-playground.exe" : "stats-playground",
);
let ownedProcess;
let settled = false;

function requireFinite(record, field) {
  if (!Number.isFinite(record?.[field])) {
    throw new Error(`Graph-new report field ${field} must be finite`);
  }
}

function validateResolution(report, width, height) {
  const resolution = report.resolutions.find(
    (candidate) => candidate?.width === width && candidate?.height === height,
  );
  if (!resolution) throw new Error(`Graph-new report is missing ${width} x ${height}`);
  for (const field of [
    "framesRequested",
    "framesSent",
    "framesPresented",
    "rustFrameHz",
    "compositorFpsP95",
    "compositorFrameTimeP95Ms",
    "longestAvoidableMainThreadTaskMs",
    "payloadBytes",
    "peakTransportBytes",
    "peakResidentFrameBuffers",
    "peakResidentFrameBytes",
    "maximumQueueDepth",
    "droppedSupersededFrames",
    "tornOrStaleFrames",
  ]) {
    requireFinite(resolution, field);
  }
  if (resolution.framesRequested !== 30
    || resolution.framesSent !== 30
    || resolution.framesPresented !== 30
    || !Array.isArray(resolution.samples)
    || resolution.samples.length !== 30) {
    throw new Error(`Graph-new ${width} x ${height} report is not a complete 30-frame run`);
  }
  requireFinite(resolution.stages?.readbackToPresentMs, "p95");
  if (typeof resolution.usedTextPixelEncoding !== "boolean"
    || !Number.isInteger(resolution.maximumQueueDepth)
    || resolution.maximumQueueDepth < 0
    || !Number.isInteger(resolution.tornOrStaleFrames)
    || resolution.tornOrStaleFrames < 0) {
    throw new Error(`Graph-new ${width} x ${height} report has invalid gate fields`);
  }
  return resolution;
}

function recomputeGate(fourK) {
  const failedBudgets = [];
  const failWhen = (field, condition) => {
    if (condition) failedBudgets.push(field);
  };
  failWhen("width", fourK.width !== 3840);
  failWhen("height", fourK.height !== 2160);
  failWhen("readbackToPresentP95Ms", fourK.stages.readbackToPresentMs.p95 > 100);
  failWhen("compositorFpsP95", fourK.compositorFpsP95 < 55);
  failWhen("compositorFrameTimeP95Ms", fourK.compositorFrameTimeP95Ms > 18);
  failWhen(
    "longestAvoidableMainThreadTaskMs",
    fourK.longestAvoidableMainThreadTaskMs > 50,
  );
  failWhen("maximumQueueDepth", fourK.maximumQueueDepth > 1);
  failWhen("usedTextPixelEncoding", fourK.usedTextPixelEncoding);
  failWhen("tornOrStaleFrames", fourK.tornOrStaleFrames !== 0);
  return { pass: failedBudgets.length === 0, failedBudgets };
}

function validateReport(payload) {
  if (payload.version !== 1
    || payload.transport !== "tauri-channel-raw-rgba8-pull"
    || !Array.isArray(payload.resolutions)
    || payload.resolutions.length !== 2) {
    throw new Error("WebView benchmark returned an invalid report envelope");
  }
  validateResolution(payload, 1920, 1080);
  const fourK = validateResolution(payload, 3840, 2160);
  const gate = recomputeGate(fourK);
  if (payload.gate?.pass !== gate.pass
    || JSON.stringify(payload.gate?.failedBudgets) !== JSON.stringify(gate.failedBudgets)) {
    throw new Error("WebView benchmark gate verdict does not match runner policy");
  }
  return { ...payload, gate };
}

async function terminateOwnedProcess() {
  const processToStop = ownedProcess;
  if (!processToStop || processToStop.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveKill) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(processToStop.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("exit", resolveKill);
      killer.once("error", resolveKill);
    });
    return;
  }
  try {
    process.kill(-processToStop.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function runReleaseBuild(callbackUrl) {
  return new Promise((resolveBuild, rejectBuild) => {
    const build = spawn(
      npmExecutable,
      ["run", "tauri", "--", "build", "--no-bundle"],
      {
        cwd: root,
        env: {
          ...process.env,
          VITE_GRAPH_NEW_TRANSPORT_BENCHMARK: "1",
          VITE_GRAPH_NEW_TRANSPORT_BENCHMARK_CALLBACK: callbackUrl,
        },
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    ownedProcess = build;
    build.once("error", rejectBuild);
    build.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Tauri release build failed with code ${code ?? "unknown"}`));
    });
  });
}

function startReleaseApp() {
  ownedProcess = spawn(appExecutable, [], {
    cwd: root,
    stdio: "inherit",
    windowsHide: false,
    detached: process.platform !== "win32",
  });
  return ownedProcess;
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Unable to bind graph-new benchmark receiver"));
        return;
      }
      resolveListen(`http://127.0.0.1:${address.port}/result`);
    });
  });
}

let resolveReport;
let rejectReport;
const reportReceived = new Promise((resolveValue, rejectValue) => {
  resolveReport = resolveValue;
  rejectReport = rejectValue;
});

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
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      request.destroy(new Error("Graph-new benchmark report exceeded 2 MiB"));
      return;
    }
    chunks.push(chunk);
  });
  request.on("error", rejectReport);
  request.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload.error) throw new Error(`WebView benchmark failed:\n${payload.error}`);
      response.writeHead(204).end();
      resolveReport(validateReport(payload));
    } catch (error) {
      response.writeHead(500).end();
      rejectReport(error);
    }
  });
});

async function main() {
  const callbackUrl = await listen(server);
  console.log(`Graph-new transport receiver listening at ${callbackUrl}`);
  await runReleaseBuild(callbackUrl);
  const app = startReleaseApp();
  const appExited = new Promise((_, rejectExit) => {
    app.once("error", rejectExit);
    app.once("exit", (code) => {
      if (!settled) {
        rejectExit(new Error(
          `Tauri release app exited before reporting results (code ${code ?? "unknown"})`,
        ));
      }
    });
  });
  const timedOut = new Promise((_, rejectTimeout) => {
    setTimeout(
      () => rejectTimeout(new Error("Graph-new transport gate timed out after 15 minutes")),
      15 * 60 * 1_000,
    ).unref();
  });
  const report = await Promise.race([reportReceived, appExited, timedOut]);
  settled = true;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Graph-new transport report written to ${reportPath}`);
  console.log(`GRAPH_NEW_TRANSPORT_GATE=${report.gate?.pass ? "PASS" : "FAIL"}`);
  if (!report.gate?.pass) process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await terminateOwnedProcess();
    server.close();
    process.exit(1);
  });
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  settled = true;
  server.close();
  await terminateOwnedProcess();
}
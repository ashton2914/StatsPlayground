import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpus, platform, release, arch } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(root, "docs/performance/echarts-scatter-budget-2026-08-26.md");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const BUDGET_CANDIDATES = [5_000, 8_000, 10_000, 20_000, 50_000, 100_000];
let child;
let settled = false;
let timeoutHandle;

function windowsAppPids() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ids = @(Get-CimInstance Win32_Process -Filter \"Name = 'stats-playground.exe'\" | ForEach-Object ProcessId); ConvertTo-Json -Compress -InputObject $ids",
    ], { encoding: "utf8", windowsHide: true }).trim();
    const parsed = output ? JSON.parse(output) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
  } catch (error) {
    console.warn(`Unable to inventory existing StatsPlayground processes: ${String(error)}`);
    return [];
  }
}

const existingWindowsAppPids = new Set(windowsAppPids());

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function aggregate(results) {
  return BUDGET_CANDIDATES.map((points) => {
    const rows = results.filter((row) => row.points === points);
    if (rows.length !== 9) throw new Error(`Expected 9 measurements for ${points} points, received ${rows.length}`);
    return {
      points,
      coherentFrameMs: median(rows.map((row) => row.coherentFrameMs)),
      longestTaskMs: Math.max(...rows.map((row) => row.longestTaskMs)),
      setOptionMs: median(rows.map((row) => row.setOptionMs)),
      zoomPatchMs: median(rows.map((row) => row.zoomPatchMs)),
      brushMs: median(rows.map((row) => row.brushMs)),
    };
  });
}

function chooseScatterBudget(rows) {
  const moduleUrl = pathToFileURL(resolve(root, "src/graphCore/scatterBudget.ts")).href;
  const source = `import { chooseScatterBudget } from ${JSON.stringify(moduleUrl)}; console.log(chooseScatterBudget(JSON.parse(process.argv[1])));`;
  return Number(execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    source,
    JSON.stringify(rows),
  ], { cwd: root, encoding: "utf8" }).trim());
}

function format(value) {
  return Number(value).toFixed(1);
}

function webViewVersion(userAgent) {
  return /Edg\/([\d.]+)/.exec(userAgent)?.[1] ?? "unreported";
}

function gitBuildId() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

async function writeReport(payload) {
  const rows = aggregate(payload.results);
  const budget = chooseScatterBudget(rows);
  const passingRows = rows.filter((row) => row.coherentFrameMs <= 2_000 && row.longestTaskMs <= 200);
  const largestPassing = Math.max(...passingRows.map((row) => row.points));
  const safetyCap = Math.floor((largestPassing * 0.8) / 1_000) * 1_000;
  const cpu = cpus()[0]?.model ?? "unreported";
  const markdown = `# ECharts Scatter Budget - 2026-08-26

This benchmark ran ordinary ECharts canvas scatter series inside the Tauri WebView. Each candidate was measured three times in ungrouped, two-group, and four-facet layouts. The policy uses the median coherent-frame time and maximum longest-task time across all nine runs per candidate.

## Environment

| Item | Value |
| --- | --- |
| OS | ${platform()} ${release()} (${arch()}) |
| CPU | ${cpu} (${cpus().length} logical processors) |
| WebView2 | ${webViewVersion(payload.userAgent)} |
| User agent | ${payload.userAgent.replaceAll("|", "\\|")} |
| App version | ${packageJson.version} |
| App build | ${gitBuildId()} |
| ECharts | ${packageJson.dependencies.echarts} |

## Measurements

| Points | Median setOption (ms) | Median coherent frame (ms) | Maximum longest task (ms) | Median zoom patch (ms) | Median brush (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
${rows.map((row) => `| ${row.points.toLocaleString("en-US")} | ${format(row.setOptionMs)} | ${format(row.coherentFrameMs)} | ${format(row.longestTaskMs)} | ${format(row.zoomPatchMs)} | ${format(row.brushMs)} |`).join("\n")}

## Selected Budget

The largest measured candidate meeting coherent frame <= 2,000 ms and longest task <= 200 ms was ${largestPassing.toLocaleString("en-US")} points. Its 20% safety reduction, rounded down to the nearest 1,000, produced the ${safetyCap.toLocaleString("en-US")}-point cap. The final budget is the largest measured passing candidate at or below that cap: ${budget.toLocaleString("en-US")} points. No unmeasured value is selected.

\`SCATTER_RENDER_BUDGET = ${budget}\`
`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdown, "utf8");
  console.log(`Scatter benchmark report written to ${reportPath}`);
  console.log(`SCATTER_RENDER_BUDGET=${budget}`);
}

async function terminateChild() {
  if (process.platform === "win32") {
    async function taskkill(pid) {
      await new Promise((resolveKill) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("exit", resolveKill);
        killer.once("error", resolveKill);
      });
    }

    if (child && child.exitCode === null) await taskkill(child.pid);
    for (const pid of windowsAppPids()) {
      if (!existingWindowsAppPids.has(pid)) await taskkill(pid);
    }
  } else if (child && child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM");
  }
}

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
      clearTimeout(timeoutHandle);
      if (payload.error) {
        console.error(`WebView benchmark failed:\n${payload.error}`);
        process.exitCode = 1;
        settled = true;
        response.writeHead(204).end();
        server.close();
        await terminateChild();
        return;
      }
      await writeReport(payload);
      settled = true;
      response.writeHead(204).end();
      server.close();
      await terminateChild();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      settled = true;
      clearTimeout(timeoutHandle);
      response.writeHead(500).end();
      server.close();
      await terminateChild();
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind scatter benchmark receiver");
  const callbackUrl = `http://127.0.0.1:${address.port}/result`;
  console.log(`Scatter benchmark receiver listening at ${callbackUrl}`);
  child = spawn(npmExecutable, ["run", "tauri", "dev"], {
    cwd: root,
    env: {
      ...process.env,
      VITE_SCATTER_BENCHMARK: "1",
      VITE_SCATTER_BENCHMARK_CALLBACK: callbackUrl,
    },
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  child.once("error", (error) => {
    console.error(`Unable to start Tauri benchmark: ${error.message}`);
    process.exitCode = 1;
    settled = true;
    clearTimeout(timeoutHandle);
    server.close();
    void terminateChild();
  });
  child.once("exit", (code) => {
    if (!settled) {
      console.error(`Tauri benchmark exited before reporting results (code ${code ?? "unknown"})`);
      process.exitCode = 1;
      settled = true;
      clearTimeout(timeoutHandle);
      server.close();
      void terminateChild();
    }
  });
  timeoutHandle = setTimeout(async () => {
    if (settled) return;
    console.error("Scatter benchmark timed out after 15 minutes");
    process.exitCode = 1;
    settled = true;
    server.close();
    await terminateChild();
  }, 15 * 60 * 1_000);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await terminateChild();
    server.close();
    process.exit(1);
  });
}
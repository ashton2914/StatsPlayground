import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTimeSeriesScenarioMatrix, publishBenchmarkArtifacts } from "./timeSeriesBenchmarkCore.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeAttestation = Object.freeze({
  supported: false,
  reason: "No native-only owned-process WebView2 runtime/version/build attestation channel is implemented. Renderer launch and qualification are disabled.",
});

export async function runTimeSeriesBenchmark({ args = [], outputRoot = resolve(root, "docs/performance"), filesystem } = {}) {
  const flags = new Set(args);
  if (flags.has("--schema")) {
    return {
      exitCode: 0,
      schema: { scenarios: buildTimeSeriesScenarioMatrix(), nativeAttestation },
    };
  }

  const outputRelative = relative(root, resolve(outputRoot));
  if (outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
    throw new Error("Artifacts must remain inside this worktree");
  }

  const reportDate = new Date().toISOString().slice(0, 10);
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const dryRun = flags.has("--dry-run");
  const payload = {
    reportDate,
    dryRun,
    targetQualified: false,
    nativeAttestation,
    error: nativeAttestation.reason,
    environment: {
      userAgent: dryRun ? "dry-run" : "not launched: secure native attestation unsupported",
      appVersion: "unverified",
      appBuild: "unverified",
      echartsVersion: packageJson.dependencies.echarts,
      targetQualification: "PENDING TARGET WINDOWS WEBVIEW",
    },
    backendMetrics: [],
    results: [],
  };
  const publication = await publishBenchmarkArtifacts(payload, {
    directory: resolve(outputRoot, `time-series-renderer-${reportDate}-${randomUUID()}`),
    filesystem,
  });
  return {
    ...publication,
    qualificationExitCode: publication.evaluation.exitCode,
    exitCode: dryRun && publication.published ? 0 : 1,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let exitCode = 1;
  try {
    const result = await runTimeSeriesBenchmark({ args: process.argv.slice(2) });
    if (result.schema) {
      console.log(JSON.stringify(result.schema, null, 2));
    } else {
      if (result.published) console.log(`Time Series artifact bundle: ${result.directory}`);
      console.log(`Renderer decision: ${result.evaluation.rendererDecision}`);
      console.log(`Qualification exit code: ${result.qualificationExitCode}; utility exit code: ${result.exitCode}`);
      if (!result.published) console.error(result.evaluation.failures.join("\n"));
    }
    exitCode = result.exitCode;
  } catch (error) {
    console.error(String(error));
  }
  process.exitCode = exitCode;
}
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortableBuildPlan, formatByteSize, runCommand, validatePortableArtifacts, validatePortableVersion } from "./portableBuildCore.mjs";

function getRepositoryRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..");
}

async function readProjectVersion(repositoryRoot) {
  const packageJsonPath = path.join(repositoryRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  return validatePortableVersion(packageJson.version);
}

async function ensureNativeArtifactExists(nativeArtifact) {
  try {
    await fs.access(nativeArtifact);
  } catch {
    throw new Error(`Expected native artifact to exist: ${nativeArtifact}`);
  }
}

async function removeAndRecreateDirectory(directoryPath) {
  await fs.rm(directoryPath, { recursive: true, force: true });
  await fs.mkdir(directoryPath, { recursive: true });
}

async function buildPortable() {
  const repositoryRoot = getRepositoryRoot();
  const version = await readProjectVersion(repositoryRoot);
  const plan = createPortableBuildPlan({
    platform: process.platform,
    arch: process.arch,
    version,
    projectRoot: repositoryRoot,
  });

  const outputDir = path.join(repositoryRoot, "release", "portable");
  const outputPath = path.join(outputDir, plan.portableName);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  await removeAndRecreateDirectory(outputDir);
  runCommand(npmCommand, ["run", "tauri", "--", ...plan.tauriArgs.slice(1)], { cwd: repositoryRoot });
  await ensureNativeArtifactExists(plan.nativeArtifact);

  if (plan.kind === "windows-executable") {
    await fs.copyFile(plan.nativeArtifact, outputPath);
  } else {
    runCommand("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", plan.nativeArtifact, outputPath], {
      cwd: repositoryRoot,
    });
  }

  const portableArtifacts = await fs.readdir(outputDir);
  validatePortableArtifacts(portableArtifacts, plan.portableName);

  const stat = await fs.stat(outputPath);
  console.log(`${path.relative(repositoryRoot, outputPath)} ${formatByteSize(stat.size)}`);
}

try {
  await buildPortable();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Portable build failed: ${message}`);
  process.exitCode = 1;
}
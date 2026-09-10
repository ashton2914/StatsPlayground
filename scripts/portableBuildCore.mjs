import path from "node:path";
import { spawnSync } from "node:child_process";

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function formatProcessStartError(error) {
  const details = [];

  for (const key of ["code", "syscall", "path"]) {
    const value = error?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      details.push(`${key}=${value}`);
    }
  }

  return details.length === 0 ? error.message : `${error.message} (${details.join(", ")})`;
}

const SAFE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function validatePortableVersion(version) {
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json version is required");
  }

  if (version !== version.trim()) {
    throw new Error(`package.json version must not have leading or trailing whitespace: ${JSON.stringify(version)}`);
  }

  if (/\s/.test(version)) {
    throw new Error(`package.json version must not contain whitespace: ${JSON.stringify(version)}`);
  }

  if (/[\\/]/.test(version)) {
    throw new Error(`package.json version must not contain path separators: ${JSON.stringify(version)}`);
  }

  if (!SAFE_SEMVER_PATTERN.test(version)) {
    throw new Error(`package.json version must be a safe semantic version such as 0.1.0 or 1.2.3-alpha.1+build.5: ${version}`);
  }

  return version;
}

export function runCommand(command, args = [], { cwd, platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const isWindowsCommandScript = platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const result = spawnSyncImpl(command, args, { cwd, stdio: "inherit", shell: isWindowsCommandScript });

  if (result.error) {
    throw new Error(`Could not start command: ${command}: ${formatProcessStartError(result.error)}`);
  }

  if (result.signal) {
    throw new Error(`Command terminated by signal ${result.signal}: ${formatCommand(command, args)}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${formatCommand(command, args)}`);
  }
}

export function createPortableBuildPlan({ platform, arch, version, projectRoot }) {
  if (!version) throw new Error("version is required");
  if (!projectRoot) throw new Error("projectRoot is required");

  const archLabel = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;

  if (platform === "win32") {
    return {
      tauriArgs: ["tauri", "build", "--no-bundle"],
      nativeArtifact: `${projectRoot}/src-tauri/target/release/stats-playground.exe`,
      portableName: `StatsPlayground-${version}-windows-${archLabel}.zip`,
      innerName: "StatsPlayground.exe",
      kind: "windows-executable-zip",
    };
  }

  if (platform === "darwin") {
    return {
      tauriArgs: ["tauri", "build", "--bundles", "app"],
      nativeArtifact: `${projectRoot}/src-tauri/target/release/bundle/macos/StatsPlayground.app`,
      portableName: `StatsPlayground-${version}-macos-${archLabel}.zip`,
      innerName: "StatsPlayground.app",
      kind: "macos-app-zip",
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export function validatePortableArtifacts(entries, expectedName) {
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error("Expected exactly one portable artifact");
  }

  const actual = path.basename(entries[0]);
  if (actual !== expectedName) {
    throw new Error(`Expected portable artifact ${expectedName}, got ${actual}`);
  }
}

export function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export default {
  createPortableBuildPlan,
  validatePortableArtifacts,
  formatByteSize,
  runCommand,
  validatePortableVersion,
};

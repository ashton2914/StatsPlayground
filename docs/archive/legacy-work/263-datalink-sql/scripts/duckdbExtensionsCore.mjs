import assert from "node:assert/strict";

export const SUPPORTED_TARGETS = Object.freeze([
  "aarch64-apple-darwin",
  "aarch64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]);

export const EXTENSION_NAMES = Object.freeze(["sqlite", "postgres"]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRUSTED_ORIGIN = "https://extensions.duckdb.org";
const TARGET_PLATFORMS = Object.freeze({
  "aarch64-apple-darwin": "osx_arm64",
  "aarch64-pc-windows-msvc": "windows_arm64",
  "x86_64-apple-darwin": "osx_amd64",
  "x86_64-pc-windows-msvc": "windows_amd64",
  "x86_64-unknown-linux-gnu": "linux_amd64",
});
const SCANNER_ARTIFACTS = Object.freeze({
  sqlite: "sqlite_scanner",
  postgres: "postgres_scanner",
});

export function assertSupportedTarget(target) {
  assert(
    SUPPORTED_TARGETS.includes(target),
    `unsupported target: ${String(target)}`,
  );
}

export function assertExtensionName(extension) {
  assert(
    EXTENSION_NAMES.includes(extension),
    `unsupported extension: ${String(extension)}`,
  );
}

export function artifactUrl(version, target, extension) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "invalid DuckDB version");
  assertSupportedTarget(target);
  assertExtensionName(extension);
  return `${TRUSTED_ORIGIN}/v${version}/${TARGET_PLATFORMS[target]}/${SCANNER_ARTIFACTS[extension]}.duckdb_extension.gz`;
}

function assertExactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} must contain exactly the supported ${label}`,
  );
}

export function validateExtensionManifest(value) {
  assertExactKeys(value, ["duckdbVersion", "targets"], "manifest fields");
  assert.match(value.duckdbVersion, /^\d+\.\d+\.\d+$/, "invalid DuckDB version");
  assertExactKeys(value.targets, SUPPORTED_TARGETS, "targets");

  for (const target of SUPPORTED_TARGETS) {
    const extensions = value.targets[target];
    assertExactKeys(extensions, EXTENSION_NAMES, "scanner extensions");
    for (const extension of EXTENSION_NAMES) {
      const artifact = extensions[extension];
      assertExactKeys(artifact, ["url", "sha256"], "artifact fields");
      assert.equal(
        artifact.url,
        artifactUrl(value.duckdbVersion, target, extension),
        "artifact must use the exact trusted DuckDB artifact URL",
      );
      assert.match(artifact.sha256, SHA256_PATTERN, "artifact SHA-256 must be exact lowercase hex");
    }
  }

  return value;
}

export function extensionRelativePath(target, extension) {
  assertSupportedTarget(target);
  assertExtensionName(extension);
  return `duckdb_extensions/${target}/${extension}.duckdb_extension`;
}

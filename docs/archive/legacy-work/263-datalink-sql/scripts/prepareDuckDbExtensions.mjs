import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import path from "node:path";

import {
  EXTENSION_NAMES,
  assertSupportedTarget,
  extensionRelativePath,
  validateExtensionManifest,
} from "./duckdbExtensionsCore.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "src-tauri", "duckdb-extensions.json");
const RESOURCE_ROOT = path.join(PROJECT_ROOT, "src-tauri", "resources");

function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const target = targets[key];
  if (!target) {
    throw new Error(`unsupported host for DuckDB extensions: ${key}`);
  }
  return target;
}

function selectedTarget() {
  const targetIndex = process.argv.indexOf("--target");
  const target =
    targetIndex >= 0
      ? process.argv[targetIndex + 1]
      : process.env.TAURI_ENV_TARGET_TRIPLE ||
        process.env.CARGO_BUILD_TARGET ||
        hostTarget();
  assertSupportedTarget(target);
  return target;
}

function duckdbPlatform(target) {
  return {
    "aarch64-apple-darwin": "osx_arm64",
    "aarch64-pc-windows-msvc": "windows_arm64",
    "x86_64-apple-darwin": "osx_amd64",
    "x86_64-pc-windows-msvc": "windows_amd64",
    "x86_64-unknown-linux-gnu": "linux_amd64",
  }[target];
}

function scannerFileName(extension) {
  return `${extension === "postgres" ? "postgres_scanner" : "sqlite_scanner"}.duckdb_extension`;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function downloadVerified(
  url,
  expectedSha256,
  destination,
  { fetchImpl = fetch, publishImpl = rename } = {},
) {
  try {
    if ((await sha256File(destination)) === expectedSha256) {
      return;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${randomUUID()}`;
  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    const response = await fetchImpl(url, { redirect: "error" });
    if (response.redirected || response.url !== url) {
      throw new Error(`artifact redirect is forbidden: ${url}`);
    }
    if (!response.ok || !response.body) {
      throw new Error(`download failed with HTTP ${response.status}: ${url}`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      url.endsWith(".gz") ? createGunzip() : new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk);
        },
      }),
      hashingStream,
      createWriteStream(temporary, { flags: "wx" }),
    );
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `SHA-256 mismatch for ${url}: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    await publishImpl(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const manifest = validateExtensionManifest(
    JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
  );
  const target = selectedTarget();

  for (const extension of EXTENSION_NAMES) {
    const artifact = manifest.targets[target][extension];
    const destination = path.join(
      RESOURCE_ROOT,
      extensionRelativePath(target, extension),
    );
    await downloadVerified(artifact.url, artifact.sha256, destination);
    const loadPath = path.join(
      RESOURCE_ROOT,
      "duckdb_extensions",
      target,
      `v${manifest.duckdbVersion}`,
      duckdbPlatform(target),
      scannerFileName(extension),
    );
    await mkdir(path.dirname(loadPath), { recursive: true });
    await rm(loadPath, { force: true });
    await link(destination, loadPath);
    console.log(`prepared ${target}/${extension}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}

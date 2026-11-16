import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  EXTENSION_NAMES,
  SUPPORTED_TARGETS,
  artifactUrl,
  extensionRelativePath,
  validateExtensionManifest,
} from "./duckdbExtensionsCore.mjs";
import { downloadVerified } from "./prepareDuckDbExtensions.mjs";

const SHA256 = "0123456789abcdef".repeat(4);

function fixtureManifest() {
  return {
    duckdbVersion: "1.5.5",
    targets: Object.fromEntries(
      SUPPORTED_TARGETS.map((target) => [
        target,
        Object.fromEntries(
          EXTENSION_NAMES.map((extension) => [
            extension,
            {
              url: artifactUrl("1.5.5", target, extension),
              sha256: SHA256,
            },
          ]),
        ),
      ]),
    ),
  };
}

test("requires every supported target and exact sha256", () => {
  assert.deepEqual(EXTENSION_NAMES, ["sqlite", "postgres"]);
  const manifest = validateExtensionManifest(fixtureManifest());
  assert.deepEqual(Object.keys(manifest.targets).sort(), [
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ]);
  assert.match(
    manifest.targets["aarch64-apple-darwin"].postgres.sha256,
    /^[a-f0-9]{64}$/,
  );
});

test("rejects foreign host and wrong version, platform, or scanner URL", () => {
  const cases = [
    "https://evil.example/v1.5.5/osx_arm64/sqlite_scanner.duckdb_extension.gz",
    "https://extensions.duckdb.org/v1.5.4/osx_arm64/sqlite_scanner.duckdb_extension.gz",
    "https://extensions.duckdb.org/v1.5.5/osx_amd64/sqlite_scanner.duckdb_extension.gz",
    "https://extensions.duckdb.org/v1.5.5/osx_arm64/mysql_scanner.duckdb_extension.gz",
    "https://extensions.duckdb.org/v1.5.5/osx_arm64/sqlite_scanner.duckdb_extension",
  ];

  for (const url of cases) {
    const manifest = fixtureManifest();
    manifest.targets["aarch64-apple-darwin"].sqlite.url = url;
    assert.throws(
      () => validateExtensionManifest(manifest),
      /trusted DuckDB artifact URL/,
      url,
    );
  }

  assert.throws(
    () => artifactUrl("1.5.5", "aarch64-apple-darwin", "mysql"),
    /unsupported extension/,
  );
});

test("download rejects redirects outside the trusted DuckDB origin", async () => {
  const destination = path.resolve(
    "scripts/.duckdb-extension-test/redirect.duckdb_extension",
  );
  await rm(path.dirname(destination), { recursive: true, force: true });

  try {
    await assert.rejects(
      downloadVerified(
        artifactUrl("1.5.5", "aarch64-apple-darwin", "sqlite"),
        SHA256,
        destination,
        {
          fetchImpl: async () => ({
            ok: true,
            redirected: true,
            url: "https://evil.example/payload.gz",
            body: ReadableStream.from([Buffer.from("payload")]),
          }),
        },
      ),
      /redirect/,
    );
  } finally {
    await rm(path.dirname(destination), { recursive: true, force: true });
  }
});

test("repository manifest pins the bundled DuckDB version for every artifact", async () => {
  const value = JSON.parse(
    await readFile("src-tauri/duckdb-extensions.json", "utf8"),
  );
  const manifest = validateExtensionManifest(value);
  assert.equal(manifest.duckdbVersion, "1.5.5");
  for (const target of SUPPORTED_TARGETS) {
    for (const extension of EXTENSION_NAMES) {
      assert.match(
        manifest.targets[target][extension].url,
        /\/v1\.5\.5\//,
      );
    }
  }
});

test("Tauri packages only SQLite and PostgreSQL scanner resources", async () => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  assert.deepEqual(config.bundle.resources, [
    "resources/duckdb_extensions/**/sqlite*.duckdb_extension",
    "resources/duckdb_extensions/**/postgres*.duckdb_extension",
  ]);
});

test("rejects a missing target, extension, or malformed digest", () => {
  const missingTarget = fixtureManifest();
  delete missingTarget.targets["aarch64-pc-windows-msvc"];
  assert.throws(() => validateExtensionManifest(missingTarget), /supported targets/);

  const missingExtension = fixtureManifest();
  delete missingExtension.targets["x86_64-apple-darwin"].postgres;
  assert.throws(
    () => validateExtensionManifest(missingExtension),
    /scanner extensions/,
  );

  const malformedDigest = fixtureManifest();
  malformedDigest.targets["x86_64-pc-windows-msvc"].sqlite.sha256 = "abc";
  assert.throws(() => validateExtensionManifest(malformedDigest), /SHA-256/);
});

test("maps only fixed target and extension names into resource paths", () => {
  assert.equal(
    extensionRelativePath("aarch64-apple-darwin", "postgres"),
    "duckdb_extensions/aarch64-apple-darwin/postgres.duckdb_extension",
  );
  assert.throws(
    () => extensionRelativePath("../../escape", "postgres"),
    /unsupported target/,
  );
  assert.throws(
    () => extensionRelativePath("aarch64-apple-darwin", "../escape"),
    /unsupported extension/,
  );
});

test("hash mismatch leaves no success-shaped extension artifact", async () => {
  const scratch = path.resolve("scripts/.duckdb-extension-test");
  const destination = path.join(scratch, "sqlite.duckdb_extension");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  try {
    await assert.rejects(
      downloadVerified(
        "data:application/octet-stream,bad-artifact",
        "0".repeat(64),
        destination,
      ),
      /SHA-256 mismatch/,
    );
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    assert.deepEqual(await readdir(scratch), []);

    const bytes = Buffer.from("verified-artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await downloadVerified(
      `data:application/octet-stream;base64,${bytes.toString("base64")}`,
      digest,
      destination,
    );
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("replacement publication failure preserves prior verified artifact", async () => {
  const scratch = path.resolve("scripts/.duckdb-extension-test");
  const destination = path.join(scratch, "sqlite.duckdb_extension");
  const prior = Buffer.from("prior-verified-artifact");
  const replacement = Buffer.from("replacement-artifact");
  const replacementDigest = createHash("sha256")
    .update(replacement)
    .digest("hex");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(destination, prior);

  try {
    await assert.rejects(
      downloadVerified(
        `data:application/octet-stream;base64,${replacement.toString("base64")}`,
        replacementDigest,
        destination,
        {
          publishImpl: async () => {
            throw new Error("simulated publication failure");
          },
        },
      ),
      /simulated publication failure/,
    );
    assert.deepEqual(await readFile(destination), prior);
    assert.deepEqual(await readdir(scratch), ["sqlite.duckdb_extension"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

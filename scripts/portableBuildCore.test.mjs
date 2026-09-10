import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createPortableBuildPlan, validatePortableArtifacts, formatByteSize, runCommand, validatePortableVersion } from "./portableBuildCore.mjs";

const buildPortableSource = fs.readFileSync(new URL("./buildPortable.mjs", import.meta.url), "utf8");

test("accepts artifact-safe semantic versions", () => {
  const validVersions = [
    "0.1.0",
    "1.2.3",
    "1.2.3-alpha.1",
    "1.2.3+build.5",
    "1.2.3-alpha.1+build.5",
  ];

  for (const version of validVersions) {
    assert.equal(validatePortableVersion(version), version);
  }
});

test("rejects malformed or unsafe package versions", () => {
  const invalidVersions = ["", " ", "1.2", "1.2.3/evil", "1.2.3 evil", "../1.2.3", "1.2.3\n"];

  for (const version of invalidVersions) {
    assert.throws(
      () => validatePortableVersion(version),
      /version/i,
    );
  }
});

test("plans a Windows ZIP with a stable executable name", () => {
  const plan = createPortableBuildPlan({
    platform: "win32",
    arch: "x64",
    version: "0.1.0",
    projectRoot: "/repo",
  });

  assert.deepEqual(plan.tauriArgs, ["tauri", "build", "--no-bundle"]);
  assert.equal(plan.nativeArtifact, "/repo/src-tauri/target/release/stats-playground.exe");
  assert.equal(plan.portableName, "StatsPlayground-0.1.0-windows-x64.zip");
  assert.equal(plan.innerName, "StatsPlayground.exe");
  assert.equal(plan.kind, "windows-executable-zip");
});

test("binds Windows compression paths through a PowerShell file", () => {
  const compressionScriptUrl = new URL("./compressPortable.ps1", import.meta.url);

  assert.match(buildPortableSource, /"-File"/);
  assert.match(buildPortableSource, /compressPortable\.ps1/);
  assert.doesNotMatch(buildPortableSource, /\$args/);
  assert.equal(fs.existsSync(compressionScriptUrl), true);

  const compressionScriptSource = fs.readFileSync(compressionScriptUrl, "utf8");
  assert.match(compressionScriptSource, /param\s*\(/);
  assert.match(compressionScriptSource, /Compress-Archive -LiteralPath \$SourcePath -DestinationPath \$DestinationPath -Force/);
});

test("plans a zipped native macOS application", () => {
  const plan = createPortableBuildPlan({
    platform: "darwin",
    arch: "arm64",
    version: "0.1.0",
    projectRoot: "/repo",
  });

  assert.deepEqual(plan.tauriArgs, ["tauri", "build", "--bundles", "app"]);
  assert.equal(plan.nativeArtifact, "/repo/src-tauri/target/release/bundle/macos/StatsPlayground.app");
  assert.equal(plan.portableName, "StatsPlayground-0.1.0-macos-arm64.zip");
  assert.equal(plan.innerName, "StatsPlayground.app");
  assert.equal(plan.kind, "macos-app-zip");
});

test("packages macOS without an extra metadata directory", () => {
  assert.doesNotMatch(buildPortableSource, /--sequesterRsrc/);
  assert.match(buildPortableSource, /"--norsrc"/);
});

test("rejects unsupported hosts", () => {
  assert.throws(
    () => createPortableBuildPlan({ platform: "linux", arch: "x64", version: "0.1.0", projectRoot: "/repo" }),
    /Unsupported platform: linux/,
  );
});

test("accepts exactly the expected portable artifact", () => {
  assert.doesNotThrow(() => validatePortableArtifacts(["StatsPlayground-0.1.0-macos-arm64.zip"], "StatsPlayground-0.1.0-macos-arm64.zip"));
});

test("rejects stale or missing portable artifacts", () => {
  assert.throws(() => validatePortableArtifacts([], "expected.zip"), /Expected exactly one portable artifact/);
  assert.throws(() => validatePortableArtifacts(["old.zip", "expected.zip"], "expected.zip"), /Expected exactly one portable artifact/);
  assert.throws(() => validatePortableArtifacts(["other.zip"], "expected.zip"), /Expected portable artifact expected.zip/);
});

test("formats artifact sizes for command output", () => {
  assert.equal(formatByteSize(1536), "1.50 KiB");
});

test("reports a failed build command", () => {
  assert.throws(
    () => runCommand("npm", ["run", "tauri"], {
      cwd: "/repo",
      spawnSyncImpl: () => ({ status: 7, error: undefined }),
    }),
    /Command failed with exit code 7: npm run tauri/,
  );
});

test("starts Windows command scripts through the shell", () => {
  let spawnOptions;

  runCommand("npm.cmd", ["run", "tauri"], {
    cwd: "C:\\repo",
    platform: "win32",
    spawnSyncImpl: (_command, _args, options) => {
      spawnOptions = options;
      return { status: 0, error: undefined };
    },
  });

  assert.equal(spawnOptions.shell, true);
});

test("keeps direct executables out of the shell", () => {
  for (const [command, platform] of [["powershell.exe", "win32"], ["npm.cmd", "darwin"]]) {
    let spawnOptions;

    runCommand(command, [], {
      cwd: "/repo",
      platform,
      spawnSyncImpl: (_command, _args, options) => {
        spawnOptions = options;
        return { status: 0, error: undefined };
      },
    });

    assert.equal(spawnOptions.shell, false);
  }
});

test("reports a command that could not start", () => {
  assert.throws(
    () => runCommand("ditto", [], {
      cwd: "/repo",
      spawnSyncImpl: () => ({
        status: null,
        error: Object.assign(new Error("spawn ditto ENOENT"), {
          code: "ENOENT",
          syscall: "spawn ditto",
          path: "ditto",
        }),
      }),
    }),
    /Could not start command: ditto.*code=ENOENT.*syscall=spawn ditto.*path=ditto/,
  );
});

test("reports a command terminated by signal distinctly from exit code null", () => {
  assert.throws(
    () => runCommand("tauri", [], {
      cwd: "/repo",
      spawnSyncImpl: () => ({ status: null, signal: "SIGKILL", error: undefined }),
    }),
    /Command terminated by signal SIGKILL: tauri/,
  );
});

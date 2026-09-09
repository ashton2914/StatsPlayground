# Portable Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one local command that creates one portable host-platform artifact: a Windows executable or a macOS ZIP containing the native app bundle.

**Architecture:** A small pure ES module owns platform detection, artifact naming, command planning, and final-output validation. A separate CLI module performs filesystem and child-process effects, which keeps both Windows and macOS contracts testable from either host while allowing a real macOS packaging acceptance run.

**Tech Stack:** Node.js ES modules and built-in test runner, npm scripts, Tauri v2 CLI, Rust/Cargo, macOS `ditto`.

**Spec:** `docs/superpowers/specs/2026-09-09-portable-build-design.md`

## Global Constraints

- Build only for the current host; cross-compilation and release publishing are out of scope.
- Windows produces one `.exe` and may depend on the system WebView2 runtime.
- macOS produces one `.zip` containing `StatsPlayground.app`; signing and notarization are out of scope.
- Final artifacts live in `release/portable/` and include product version, platform, and architecture in the filename.
- Any unsupported platform, failed command, missing native output, or unexpected final artifact count exits non-zero.
- Do not add third-party JavaScript dependencies.
- Keep commits deferred until the GitHub Issue lifecycle's manual-acceptance gate.

---

### Task 1: Portable Build Contract

**Files:**
- Create: `scripts/portableBuildCore.test.mjs`
- Create: `scripts/portableBuildCore.mjs`

**Interfaces:**
- Consumes: Node `path` utilities and `{ platform, arch, version, projectRoot }` input.
- Produces: `createPortableBuildPlan(options)`, `validatePortableArtifacts(entries, expectedName)`, and `formatByteSize(bytes)`.

- [ ] **Step 1: Write failing platform-plan tests**

Create tests that assert these exact contracts:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createPortableBuildPlan } from "./portableBuildCore.mjs";

test("plans a single portable Windows executable", () => {
  const plan = createPortableBuildPlan({
    platform: "win32",
    arch: "x64",
    version: "0.1.0",
    projectRoot: "/repo",
  });

  assert.deepEqual(plan.tauriArgs, ["tauri", "build", "--no-bundle"]);
  assert.equal(plan.nativeArtifact, "/repo/src-tauri/target/release/stats-playground.exe");
  assert.equal(plan.portableName, "StatsPlayground-0.1.0-windows-x64.exe");
  assert.equal(plan.kind, "windows-executable");
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
  assert.equal(plan.kind, "macos-app-zip");
});

test("rejects unsupported hosts", () => {
  assert.throws(
    () => createPortableBuildPlan({ platform: "linux", arch: "x64", version: "0.1.0", projectRoot: "/repo" }),
    /Unsupported platform: linux/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/portableBuildCore.test.mjs`

Expected: FAIL because `scripts/portableBuildCore.mjs` does not exist.

- [ ] **Step 3: Implement the minimal platform plan**

Implement `createPortableBuildPlan` with `node:path`, explicit `win32` and
`darwin` branches, architecture labels `x64`, `arm64`, and the raw Node label
for any other architecture. Reject an empty version or project root with an
actionable error.

- [ ] **Step 4: Add failing artifact-validation tests**

```js
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
```

- [ ] **Step 5: Run the focused test and verify RED**

Run: `node --test scripts/portableBuildCore.test.mjs`

Expected: FAIL because `validatePortableArtifacts` and `formatByteSize` are not exported.

- [ ] **Step 6: Implement artifact validation and size formatting**

Require one entry whose basename exactly equals `expectedName`. Format bytes
below 1024 as `B`, below 1 MiB as `KiB`, and larger values as `MiB`, using two
decimal places for scaled values.

- [ ] **Step 7: Run the focused test and verify GREEN**

Run: `node --test scripts/portableBuildCore.test.mjs`

Expected: all tests PASS with exit code 0.

### Task 2: Portable Build CLI

**Files:**
- Create: `scripts/buildPortable.mjs`
- Modify: `scripts/portableBuildCore.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1's `createPortableBuildPlan`, `validatePortableArtifacts`, and `formatByteSize`; root `package.json`; Tauri native output.
- Produces: `npm run build:portable` and generated `release/portable/<portableName>`.

- [ ] **Step 1: Add failing command-runner tests**

Extend the core module contract with `runCommand(command, args, options)` and
test it through an injected `spawnSyncImpl`:

```js
test("reports a failed build command", () => {
  assert.throws(
    () => runCommand("npm", ["run", "tauri"], {
      cwd: "/repo",
      spawnSyncImpl: () => ({ status: 7, error: undefined }),
    }),
    /Command failed with exit code 7: npm run tauri/,
  );
});

test("reports a command that could not start", () => {
  assert.throws(
    () => runCommand("ditto", [], {
      cwd: "/repo",
      spawnSyncImpl: () => ({ status: null, error: new Error("ENOENT") }),
    }),
    /Could not start command: ditto/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/portableBuildCore.test.mjs`

Expected: FAIL because `runCommand` is not exported.

- [ ] **Step 3: Implement the command runner**

Use `spawnSync` by default with `{ cwd, stdio: "inherit", shell: false }`.
Throw separately for process-start errors and non-zero exit status so CI and
local users see the command that failed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test scripts/portableBuildCore.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Implement the CLI filesystem flow**

The CLI must:

1. Resolve the repository root from `import.meta.url`.
2. Parse and validate the root `package.json` version.
3. compute the host plan from `process.platform` and `process.arch`.
4. Remove and recreate `release/portable/`.
5. Run `npm run <each plan.tauriArgs item>` using the platform's npm command
   (`npm.cmd` on Windows, `npm` elsewhere).
6. Fail if `plan.nativeArtifact` does not exist.
7. Copy the Windows executable, or run
   `ditto -c -k --sequesterRsrc --keepParent <app> <zip>` on macOS.
8. Read the output directory, call `validatePortableArtifacts`, and print the
   repository-relative artifact path plus `formatByteSize(stat.size)`.
9. Catch errors only at the top level, print `Portable build failed: <message>`
   to stderr, and set `process.exitCode = 1`.

- [ ] **Step 6: Wire npm scripts and ignore generated output**

Add:

```json
"build:portable": "node scripts/buildPortable.mjs",
"test:portable-build": "node --test scripts/portableBuildCore.test.mjs"
```

Add `/release/portable/` to `.gitignore` without changing unrelated entries.

- [ ] **Step 7: Run focused contract tests**

Run: `npm run test:portable-build`

Expected: all tests PASS.

- [ ] **Step 8: Run a real macOS portable build**

Run: `npm run build:portable`

Expected: exit code 0 and exactly one
`release/portable/StatsPlayground-0.1.0-macos-<arch>.zip`.

- [ ] **Step 9: Inspect the ZIP contract**

Run: `unzip -Z1 release/portable/*.zip | head -n 20`

Expected: entries begin with `StatsPlayground.app/`, including
`StatsPlayground.app/Contents/MacOS/stats-playground`.

### Task 3: Documentation and Final Verification

**Files:**
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: the tested `npm run build:portable` command and exact output contract.
- Produces: developer-facing portable build instructions and explicit platform limitations.

- [ ] **Step 1: Add portable build documentation**

Add a `Portable build` section covering:

```text
npm install
npm run build:portable
release/portable/
```

State that builds are host-native, Windows produces one portable executable and
requires system WebView2, macOS produces one ZIP containing an unsigned `.app`,
and signing/notarization plus cross-compilation are not included.

- [ ] **Step 2: Run the focused portable tests**

Run: `npm run test:portable-build`

Expected: all tests PASS.

- [ ] **Step 3: Run frontend production build**

Run: `npm run build`

Expected: TypeScript and Vite complete with exit code 0.

- [ ] **Step 4: Run Rust verification**

Run from `src-tauri/`: `cargo build && cargo clippy -- -D warnings && cargo test`

Expected: all three commands exit 0 and all Rust tests pass.

- [ ] **Step 5: Validate patch hygiene**

Run: `git diff --check`

Expected: exit code 0 with no output.

- [ ] **Step 6: Inspect final scope**

Review bounded status and diff statistics. Expected source changes are limited
to the two design/plan documents, two portable-build scripts, one script test,
`package.json`, `.gitignore`, and `docs/development.md`; generated
`release/portable/` and dependency/build caches remain ignored.

- [ ] **Step 7: Request independent review and manual acceptance**

Dispatch an independent reviewer against Issue 152 and the actual uncommitted
diff. Resolve every Critical or Important finding, rerun affected checks, then
provide the worktree path and generated macOS artifact for user acceptance.
Do not commit, push, or create a pull request before explicit acceptance.
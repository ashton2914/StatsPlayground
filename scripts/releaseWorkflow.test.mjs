import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeReleaseTag, synchronizeReleaseVersions } from "./releaseVersionCore.mjs";

test("normalizes a v-prefixed prerelease tag", () => {
  assert.equal(normalizeReleaseTag("v0.0.0-alpha.1"), "0.0.0-alpha.1");
});

test("rejects release refs that are not v-prefixed semantic versions", () => {
  assert.throws(() => normalizeReleaseTag("0.0.0-alpha.1"), /must start with v/);
  assert.throws(() => normalizeReleaseTag("vnot-a-version"), /semantic version/);
});

test("synchronizes every release manifest from the tag version", () => {
  const synchronized = synchronizeReleaseVersions({
    version: "0.0.0-alpha.1",
    packageJson: '{\n  "name": "stats-playground",\n  "version": "0.1.0"\n}\n',
    packageLockJson: '{\n  "name": "stats-playground",\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "version": "0.1.0"\n    }\n  }\n}\n',
    tauriConfigJson: '{\n  "productName": "StatsPlayground",\n  "version": "0.1.0"\n}\n',
    cargoToml: '[package]\nname = "stats-playground"\nversion = "0.1.0"\n',
    cargoLock: '[[package]]\nname = "stats-playground"\nversion = "0.1.0"\n',
  });

  assert.equal(JSON.parse(synchronized.packageJson).version, "0.0.0-alpha.1");
  assert.equal(JSON.parse(synchronized.packageLockJson).version, "0.0.0-alpha.1");
  assert.equal(JSON.parse(synchronized.packageLockJson).packages[""].version, "0.0.0-alpha.1");
  assert.equal(JSON.parse(synchronized.tauriConfigJson).version, "0.0.0-alpha.1");
  assert.match(synchronized.cargoToml, /version = "0\.0\.0-alpha\.1"/);
  assert.match(synchronized.cargoLock, /version = "0\.0\.0-alpha\.1"/);
});

test("synchronizes a Cargo.lock checked out with CRLF line endings", () => {
  const synchronized = synchronizeReleaseVersions({
    version: "0.0.0-alpha.1",
    packageJson: '{\n  "name": "stats-playground",\n  "version": "0.1.0"\n}\n',
    packageLockJson: '{\n  "name": "stats-playground",\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "version": "0.1.0"\n    }\n  }\n}\n',
    tauriConfigJson: '{\n  "productName": "StatsPlayground",\n  "version": "0.1.0"\n}\n',
    cargoToml: '[package]\nname = "stats-playground"\nversion = "0.1.0"\n',
    cargoLock: '[[package]]\r\nname = "stats-playground"\r\nversion = "0.1.0"\r\n',
  });

  assert.equal(
    synchronized.cargoLock,
    '[[package]]\r\nname = "stats-playground"\r\nversion = "0.0.0-alpha.1"\r\n',
  );
});

test("defines parallel portable builds and a dependent GitHub Release job", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/);
  assert.match(workflow, /node automation\/scripts\/syncReleaseVersion\.mjs/);
  assert.match(workflow, /npm run build:portable/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
  assert.match(workflow, /contents: write/);
});

test("keeps release automation available when publishing a tag that predates the workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /path: automation/);
  assert.match(workflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}\s*\n\s*path: source/);
  assert.match(workflow, /RELEASE_SOURCE_ROOT: source/);
  assert.match(workflow, /node automation\/scripts\/syncReleaseVersion\.mjs/);
  assert.match(workflow, /working-directory: source/);
  assert.match(workflow, /path: source\/release\/portable\/\*/);
});

test("does not interpolate a manual tag input into shell source", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /RELEASE_SOURCE_ROOT: source/);
  assert.match(workflow, /^\s*run: node automation\/scripts\/syncReleaseVersion\.mjs\s*$/m);
  assert.doesNotMatch(workflow, /^\s*run:.*\$\{\{.*RELEASE_TAG.*$/m);
});
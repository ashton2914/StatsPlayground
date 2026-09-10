import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { resolveAppVersion } from "./appVersionCore.mjs";

test("uses the exact tag attached to HEAD", () => {
  const commands = [];
  const version = resolveAppVersion((args) => {
    commands.push(args);
    return "v1.4.0\n";
  });

  assert.equal(version, "v1.4.0");
  assert.deepEqual(commands, [["describe", "--tags", "--exact-match", "HEAD"]]);
});

test("uses the current commit hash when HEAD has no exact tag", () => {
  const version = resolveAppVersion((args) => {
    if (args[0] === "describe") throw new Error("no exact tag");
    return "a1b2c3d\n";
  });

  assert.equal(version, "a1b2c3d");
});

test("fails when neither an exact tag nor a commit hash can be resolved", () => {
  assert.throws(
    () => resolveAppVersion(() => {
      throw new Error("git unavailable");
    }),
    /Unable to resolve application version/,
  );
});

test("resolves Git metadata independently of the caller's working directory", () => {
  const originalDirectory = process.cwd();
  const expected = resolveAppVersion();

  try {
    process.chdir(tmpdir());
    assert.equal(resolveAppVersion(), expected);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("renders the resolved version verbatim on both public surfaces", () => {
  const welcome = readFileSync(new URL("../src/components/WelcomePage.tsx", import.meta.url), "utf8");
  const help = readFileSync(new URL("../src/components/HelpDialog.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");

  assert.match(welcome, /className="version-tag">\{APP_VERSION\}</);
  assert.match(workspace, /<UpdateDialogs[\s\S]*?currentVersion=\{APP_VERSION\}/);
  assert.match(help, /defaultValue: "Version" \}\)} \{version\}/);
  assert.doesNotMatch(`${welcome}\n${help}\n${workspace}`, /v\{(?:APP_VERSION|version)\}/);
});

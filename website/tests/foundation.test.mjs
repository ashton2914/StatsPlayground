import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("builds the website as an isolated Astro package", async () => {
  const packageJson = JSON.parse(await read("../package.json"));
  assert.equal(packageJson.name, "@statsplayground/website");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.scripts.build, "astro build");
  assert.equal(packageJson.scripts.check, "astro check");
  assert.ok(packageJson.dependencies.astro);
  assert.equal(packageJson.dependencies["@lucide/astro"], undefined);
  assert.equal(packageJson.dependencies["lucide-astro"], undefined);
});

test("keeps the public package lock independent of private registries", async () => {
  const packageLock = await read("../package-lock.json");
  assert.doesNotMatch(packageLock, /packagefeedproxy\.microsoft\.io/);
  assert.doesNotMatch(packageLock, /pkgs\.visualstudio\.com/);
});

test("publishes the root custom domain without a repository base path", async () => {
  const config = await read("../astro.config.mjs");
  assert.match(config, /site:\s*["']https:\/\/statsplayground\.org["']/);
  assert.doesNotMatch(config, /\bbase\s*:/);
  assert.equal((await read("../public/CNAME")).trim(), "statsplayground.org");
});

test("deploys the website package through GitHub Pages", async () => {
  const workflow = await read("../../.github/workflows/website.yml");
  assert.match(workflow, /branches:\s*\[dev\]/);
  assert.match(workflow, /path:\s*website/);
  assert.match(workflow, /PLACEHOLDER_MEDIA\.md/);
  assert.match(workflow, /exit 1/);
  assert.match(workflow, /withastro\/action@v6/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
});

test("documents the official site and website development commands", async () => {
  const readme = await read("../../README.md");
  const development = await read("../../docs/development.md");
  assert.match(readme, /https:\/\/statsplayground\.org/);
  assert.match(development, /npm --prefix website run dev/);
  assert.match(development, /npm --prefix website run build/);
  assert.match(development, /npm --prefix website run test/);
  assert.match(development, /GitHub Pages/);
  assert.match(development, /statsplayground\.org/);
});
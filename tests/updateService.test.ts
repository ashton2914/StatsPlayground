import assert from "node:assert/strict";

import { checkForUpdate, resolvePlatformAssetSuffix } from "../src/services/updateService.ts";

const payload = [
  {
    tag_name: "v0.3.0-preview.1",
    draft: false,
    prerelease: true,
    html_url: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.3.0-preview.1",
    published_at: "2026-09-10T00:00:00Z",
    assets: [
      {
        name: "StatsPlayground-0.3.0-preview.1-windows-x64.zip",
        browser_download_url: "https://github.com/ashton2914/StatsPlayground/releases/download/v0.3.0-preview.1/StatsPlayground-0.3.0-preview.1-windows-x64.zip",
      },
    ],
  },
];

const result = await checkForUpdate({
  currentVersion: "0.2.0",
  includePrerelease: true,
  platformAssetSuffix: "windows-x64.zip",
  fetcher: async () => new Response(JSON.stringify(payload), { status: 200 }),
});

assert.equal(result?.version, "0.3.0-preview.1");
assert.equal(result?.downloadUrl, "https://github.com/ashton2914/StatsPlayground/releases/download/v0.3.0-preview.1/StatsPlayground-0.3.0-preview.1-windows-x64.zip");

assert.equal(resolvePlatformAssetSuffix("macos", "aarch64"), "macos-arm64.zip");
assert.equal(resolvePlatformAssetSuffix("macos", "x86_64"), null);
assert.equal(resolvePlatformAssetSuffix("windows", "x86_64"), "windows-x64.zip");
assert.equal(resolvePlatformAssetSuffix("linux", "x86_64"), null);

await assert.rejects(
  checkForUpdate({
    currentVersion: "0.2.0",
    includePrerelease: true,
    platformAssetSuffix: "windows-x64.zip",
    fetcher: async () => new Response("rate limited", { status: 403 }),
  }),
  /status 403/,
);

await assert.rejects(
  checkForUpdate({
    currentVersion: "0.2.0",
    includePrerelease: true,
    platformAssetSuffix: "windows-x64.zip",
    fetcher: async () => new Response(JSON.stringify({ message: "unexpected" }), { status: 200 }),
  }),
  /response is invalid/,
);

for (const invalidPayload of [
  [{ ...payload[0], html_url: undefined }],
  [{ ...payload[0], assets: [{ name: "StatsPlayground-0.3.0-preview.1-windows-x64.zip" }] }],
  [{ ...payload[0], html_url: "https://example.test/releases/tag/v0.3.0-preview.1" }],
  [{ ...payload[0], assets: [{ ...payload[0].assets[0], browser_download_url: "https://example.test/update.zip" }] }],
]) {
  await assert.rejects(
    checkForUpdate({
      currentVersion: "0.2.0",
      includePrerelease: true,
      platformAssetSuffix: "windows-x64.zip",
      fetcher: async () => new Response(JSON.stringify(invalidPayload), { status: 200 }),
    }),
    /response is invalid/,
  );
}

console.log("update service tests passed");
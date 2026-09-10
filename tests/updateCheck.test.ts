import assert from "node:assert/strict";

import { selectReleaseUpdate } from "../src/services/updateCheckCore.ts";

const releases = [
  {
    tag_name: "v0.1.1",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.1",
    published_at: "2026-09-09T00:00:00Z",
    assets: [
      {
        name: "StatsPlayground-0.1.1-macos-arm64.zip",
        browser_download_url: "https://example.test/0.1.1-macos-arm64.zip",
      },
    ],
  },
  {
    tag_name: "v0.2.0-beta.1",
    draft: false,
    prerelease: true,
    html_url: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0-beta.1",
    published_at: "2026-09-10T00:00:00Z",
    assets: [
      {
        name: "StatsPlayground-0.2.0-beta.1-macos-arm64.zip",
        browser_download_url: "https://example.test/0.2.0-beta.1-macos-arm64.zip",
      },
    ],
  },
];

assert.deepEqual(
  selectReleaseUpdate({
    currentVersion: "0.1.0",
    includePrerelease: true,
    platformAssetSuffix: "macos-arm64.zip",
    releases,
  }),
  {
    version: "0.2.0-beta.1",
    releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0-beta.1",
    downloadUrl: "https://example.test/0.2.0-beta.1-macos-arm64.zip",
    directDownload: true,
  },
  "preview mode must select the newest eligible prerelease and its exact platform asset",
);

assert.deepEqual(
  selectReleaseUpdate({
    currentVersion: "0.1.0",
    includePrerelease: false,
    platformAssetSuffix: null,
    releases,
  }),
  {
    version: "0.1.1",
    releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.1",
    downloadUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.1",
    directDownload: false,
  },
  "an unsupported platform must fall back to the selected release page",
);

const releaseWithMisnamedAsset = [{
  ...releases[0],
  tag_name: "v0.1.2",
  html_url: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.2",
  assets: [{
    name: "unofficial-0.1.2-macos-arm64.zip",
    browser_download_url: "https://example.test/unofficial-0.1.2-macos-arm64.zip",
  }],
}];
assert.deepEqual(
  selectReleaseUpdate({
    currentVersion: "0.1.0",
    includePrerelease: false,
    platformAssetSuffix: "macos-arm64.zip",
    releases: releaseWithMisnamedAsset,
  }),
  {
    version: "0.1.2",
    releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.2",
    downloadUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.1.2",
    directDownload: false,
  },
  "only the official exact package name may be opened as a direct download",
);

assert.equal(
  selectReleaseUpdate({
    currentVersion: "0.2.0-beta.1",
    includePrerelease: true,
    platformAssetSuffix: "macos-arm64.zip",
    releases: [
      { ...releases[1], draft: true, tag_name: "v9.0.0" },
      { ...releases[1], tag_name: "not-a-version" },
      { ...releases[1], tag_name: "v0.2.0-beta.1" },
      { ...releases[0], tag_name: "v0.1.0" },
    ],
  }),
  null,
  "draft, invalid, equal, and older releases must not produce an update",
);

console.log("update check core tests passed");
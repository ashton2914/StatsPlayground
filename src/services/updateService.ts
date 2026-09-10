import { selectReleaseUpdate, type GitHubRelease, type GitHubReleaseAsset, type ReleaseUpdate } from "./updateCheckCore";
import { isTrustedReleaseAssetUrl, isTrustedReleasePageUrl } from "./updateUrlCore";

const RELEASES_URL = "https://api.github.com/repos/ashton2914/StatsPlayground/releases?per_page=100";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CheckForUpdateOptions {
  currentVersion: string;
  includePrerelease: boolean;
  platformAssetSuffix: string | null;
  fetcher?: Fetcher;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAsset(value: unknown): GitHubReleaseAsset | null {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || typeof value.browser_download_url !== "string"
    || !isTrustedReleaseAssetUrl(value.browser_download_url)
  ) {
    return null;
  }
  return { name: value.name, browser_download_url: value.browser_download_url };
}

function parseRelease(value: unknown): GitHubRelease | null {
  if (
    !isRecord(value)
    || typeof value.tag_name !== "string"
    || typeof value.draft !== "boolean"
    || typeof value.prerelease !== "boolean"
    || typeof value.html_url !== "string"
    || !isTrustedReleasePageUrl(value.html_url)
    || typeof value.published_at !== "string"
    || !Array.isArray(value.assets)
  ) {
    return null;
  }

  const assets = value.assets.map(parseAsset);
  if (assets.some((asset) => asset === null)) {
    return null;
  }

  return {
    tag_name: value.tag_name,
    draft: value.draft,
    prerelease: value.prerelease,
    html_url: value.html_url,
    published_at: value.published_at,
    assets: assets as GitHubReleaseAsset[],
  };
}

export function resolvePlatformAssetSuffix(platform: string, architecture: string): string | null {
  if (platform === "macos" && architecture === "aarch64") {
    return "macos-arm64.zip";
  }
  if (platform === "windows" && architecture === "x86_64") {
    return "windows-x64.zip";
  }
  return null;
}

export async function checkForUpdate({
  currentVersion,
  includePrerelease,
  platformAssetSuffix,
  fetcher = fetch,
}: CheckForUpdateOptions): Promise<ReleaseUpdate | null> {
  const response = await fetcher(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("GitHub Releases response is invalid");
  }

  const releases: GitHubRelease[] = [];
  for (const value of payload) {
    const release = parseRelease(value);
    if (!release) {
      throw new Error("GitHub Releases response is invalid");
    }
    releases.push(release);
  }
  return selectReleaseUpdate({
    currentVersion,
    includePrerelease,
    platformAssetSuffix,
    releases,
  });
}
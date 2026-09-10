import semver from "semver";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

export interface ReleaseUpdate {
  version: string;
  releaseUrl: string;
  downloadUrl: string;
  directDownload: boolean;
}

interface SelectReleaseUpdateOptions {
  currentVersion: string;
  includePrerelease: boolean;
  platformAssetSuffix: string | null;
  releases: GitHubRelease[];
}

export function selectReleaseUpdate({
  currentVersion,
  includePrerelease,
  platformAssetSuffix,
  releases,
}: SelectReleaseUpdateOptions): ReleaseUpdate | null {
  const normalizedCurrent = semver.valid(currentVersion);
  if (!normalizedCurrent) {
    return null;
  }

  const eligible = releases
    .map((release) => ({ release, version: semver.valid(release.tag_name) }))
    .filter((candidate): candidate is { release: GitHubRelease; version: string } => (
      !candidate.release.draft
      && candidate.version !== null
      && (includePrerelease || (!candidate.release.prerelease && semver.prerelease(candidate.version) === null))
    ))
    .sort((left, right) => semver.rcompare(left.version, right.version));

  const candidate = eligible.find(({ version }) => semver.gt(version, normalizedCurrent));
  if (!candidate) {
    return null;
  }

  const expectedAssetName = platformAssetSuffix
    ? `StatsPlayground-${candidate.version}-${platformAssetSuffix}`
    : null;
  const asset = expectedAssetName
    ? candidate.release.assets.find(({ name }) => name === expectedAssetName)
    : undefined;
  return {
    version: candidate.version,
    releaseUrl: candidate.release.html_url,
    downloadUrl: asset?.browser_download_url ?? candidate.release.html_url,
    directDownload: Boolean(asset),
  };
}
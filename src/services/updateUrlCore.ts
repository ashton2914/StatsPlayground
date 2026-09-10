const RELEASE_TAG_PATH_PATTERN = /^\/ashton2914\/StatsPlayground\/releases\/tag\/[^/]+$/;
const RELEASE_DOWNLOAD_PATH_PATTERN = /^\/ashton2914\/StatsPlayground\/releases\/download\/[^/]+\/[^/]+$/;

function hasTrustedGitHubOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://github.com"
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isTrustedReleasePageUrl(value: string): boolean {
  const url = hasTrustedGitHubOrigin(value);
  return Boolean(url && RELEASE_TAG_PATH_PATTERN.test(url.pathname));
}

export function isTrustedReleaseAssetUrl(value: string): boolean {
  const url = hasTrustedGitHubOrigin(value);
  return Boolean(url && RELEASE_DOWNLOAD_PATH_PATTERN.test(url.pathname));
}

export function isTrustedUpdateUrl(value: string): boolean {
  return isTrustedReleasePageUrl(value) || isTrustedReleaseAssetUrl(value);
}

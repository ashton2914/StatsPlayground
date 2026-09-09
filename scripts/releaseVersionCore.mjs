import { validatePortableVersion } from "./portableBuildCore.mjs";

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceVersion(content, pattern, version, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${label} version`);
  }

  return content.replace(pattern, `$1${version}$2`);
}

export function normalizeReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error("Release tag must start with v");
  }

  return validatePortableVersion(tag.slice(1));
}

export function synchronizeReleaseVersions({
  version,
  packageJson,
  packageLockJson,
  tauriConfigJson,
  cargoToml,
  cargoLock,
}) {
  const validatedVersion = validatePortableVersion(version);
  const packageManifest = JSON.parse(packageJson);
  const packageLock = JSON.parse(packageLockJson);
  const tauriConfig = JSON.parse(tauriConfigJson);

  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json is missing the root package");
  }

  packageManifest.version = validatedVersion;
  packageLock.version = validatedVersion;
  packageLock.packages[""].version = validatedVersion;
  tauriConfig.version = validatedVersion;

  return {
    packageJson: serializeJson(packageManifest),
    packageLockJson: serializeJson(packageLock),
    tauriConfigJson: serializeJson(tauriConfig),
    cargoToml: replaceVersion(
      cargoToml,
      /(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
      validatedVersion,
      "Cargo.toml package",
    ),
    cargoLock: replaceVersion(
      cargoLock,
      /(\[\[package\]\]\r?\nname = "stats-playground"\r?\nversion = ")[^"]+(")/,
      validatedVersion,
      "Cargo.lock stats-playground package",
    ),
  };
}

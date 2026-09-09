import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeReleaseTag, synchronizeReleaseVersions } from "./releaseVersionCore.mjs";

const defaultRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(process.env.RELEASE_SOURCE_ROOT ?? process.argv[3] ?? defaultRepositoryRoot);
const files = {
  packageJson: path.join(repositoryRoot, "package.json"),
  packageLockJson: path.join(repositoryRoot, "package-lock.json"),
  tauriConfigJson: path.join(repositoryRoot, "src-tauri", "tauri.conf.json"),
  cargoToml: path.join(repositoryRoot, "src-tauri", "Cargo.toml"),
  cargoLock: path.join(repositoryRoot, "src-tauri", "Cargo.lock"),
};

async function synchronizeFromTag(tag) {
  const version = normalizeReleaseTag(tag);
  const entries = Object.entries(files);
  const contents = await Promise.all(entries.map(([, file]) => fs.readFile(file, "utf8")));
  const synchronized = synchronizeReleaseVersions({
    version,
    ...Object.fromEntries(entries.map(([key], index) => [key, contents[index]])),
  });

  await Promise.all(entries.map(([key, file]) => fs.writeFile(file, synchronized[key], "utf8")));
  console.log(`Synchronized release manifests to ${version}`);
}

const tag = process.env.RELEASE_TAG ?? process.argv[2];

try {
  await synchronizeFromTag(tag);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release version synchronization failed: ${message}`);
  process.exitCode = 1;
}

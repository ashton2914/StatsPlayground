import { execFileSync } from "node:child_process";

const REPOSITORY_ROOT = new URL("..", import.meta.url);

function runGit(args) {
  return execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function resolveAppVersion(executeGit = runGit) {
  try {
    const tag = executeGit(["describe", "--tags", "--exact-match", "HEAD"]).trim();
    if (tag) return tag;
  } catch {
    // HEAD is not tagged; fall back to its commit identity.
  }

  try {
    const commit = executeGit(["rev-parse", "--short", "HEAD"]).trim();
    if (commit) return commit;
  } catch {
    // Source archives may not include Git metadata.
  }

  throw new Error("Unable to resolve application version from an exact Git tag or commit hash.");
}
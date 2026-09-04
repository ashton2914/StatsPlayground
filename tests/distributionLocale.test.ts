import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const localePaths = ["en", "zh-CN", "zh-TW", "vi"] as const;

function collectLeafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function getPathValue(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, root);
}

const allMessages = Object.fromEntries(localePaths.map((locale) => [
  locale,
  JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>,
]));
const englishDistribution = allMessages.en.distribution as Record<string, unknown>;
const requiredDistributionPaths = collectLeafPaths(englishDistribution);
const requiredWorkspacePaths = ["workspace.distributionMissing", "workspace.distributionSourceMissing"];
const requiredHistoryPaths = ["history.newDistribution", "history.renameDistribution", "history.deleteDistribution"];

for (const locale of localePaths) {
  const messages = allMessages[locale];
  const distribution = messages.distribution as Record<string, unknown> | undefined;

  assert.ok(distribution, `${locale} must define the distribution namespace`);
  for (const path of requiredDistributionPaths) {
    assert.equal(typeof getPathValue(distribution, path), "string", `${locale} distribution.${path}`);
  }
  for (const path of [...requiredWorkspacePaths, ...requiredHistoryPaths, "menu.distribution"]) {
    assert.equal(typeof getPathValue(messages, path), "string", `${locale} ${path}`);
  }
}

console.log("Distribution locale parity contract passed");
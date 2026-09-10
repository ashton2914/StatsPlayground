import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const locales = ["en", "zh-CN", "zh-TW", "vi"] as const;
const preferenceKeys = [
  "automaticUpdates",
  "automaticUpdatesHint",
  "previewUpdates",
  "previewUpdatesHint",
] as const;
const updateKeys = [
  "check",
  "checking",
  "upToDate",
  "checkFailed",
  "availableTitle",
  "availableMessage",
  "currentVersion",
  "newVersion",
  "assetUnavailable",
  "ignore",
  "download",
  "openFailed",
] as const;

for (const locale of locales) {
  const messages = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  ) as { prefs: Record<string, string>; update: Record<string, string> };

  for (const key of preferenceKeys) {
    assert.ok(messages.prefs[key]?.trim(), `${locale} must define prefs.${key}`);
  }
  for (const key of updateKeys) {
    assert.ok(messages.update[key]?.trim(), `${locale} must define update.${key}`);
  }
}

console.log("update locale tests passed");
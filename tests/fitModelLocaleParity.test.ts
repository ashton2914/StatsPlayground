import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const LOCALES = ["en", "zh-CN", "zh-TW", "vi"] as const;

function collectLeafValues(
  value: unknown,
  prefix = "fitModel",
  leaves = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    leaves.set(prefix, value);
    return leaves;
  }

  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${prefix} must be an object or string`);
  for (const [key, child] of Object.entries(value)) {
    collectLeafValues(child, `${prefix}.${key}`, leaves);
  }
  return leaves;
}

const localeLeaves = LOCALES.map((locale) => {
  const filePath = path.resolve(process.cwd(), `src/i18n/locales/${locale}.json`);
  const document = JSON.parse(readFileSync(filePath, "utf8")) as { fitModel?: unknown };
  assert.ok(document.fitModel, `${locale} must define the fitModel namespace`);
  return [locale, collectLeafValues(document.fitModel)] as const;
});

const [referenceLocale, referenceLeaves] = localeLeaves[0];
const referenceKeys = [...referenceLeaves.keys()].sort();
for (const [locale, leaves] of localeLeaves) {
  assert.deepEqual([...leaves.keys()].sort(), referenceKeys, `${locale} fitModel keys must match ${referenceLocale}`);
  for (const [key, value] of leaves) {
    assert.ok(value.trim().length > 0, `${locale}:${key} must be a non-empty string`);
  }
}

console.log(`fitModel locale parity passed (${referenceKeys.length} keys across ${LOCALES.length} locales)`);
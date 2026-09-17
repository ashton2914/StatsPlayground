import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type LocaleTree = Record<string, LocaleTree | string>;

const LOCALES = ["en", "zh-CN", "zh-TW", "vi"] as const;
const LOCALES_DIR = path.resolve(process.cwd(), "src/i18n/locales");
const REQUIRED_KEYS = [
  "history.createCalculatedColumn",
  "history.editCalculatedColumn",
  "history.convertCalculatedColumnToValues",
] as const;

function readLocale(locale: (typeof LOCALES)[number]): LocaleTree {
  return JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), "utf8")) as LocaleTree;
}

function getValue(root: LocaleTree, key: string): string | undefined {
  const value = key.split(".").reduce<LocaleTree | string | undefined>((current, segment) => {
    if (!current || typeof current === "string") return undefined;
    return current[segment];
  }, root);
  return typeof value === "string" ? value : undefined;
}

function getBranch(root: LocaleTree, key: string): LocaleTree {
  const value = key.split(".").reduce<LocaleTree | string | undefined>((current, segment) => {
    if (!current || typeof current === "string") return undefined;
    return current[segment];
  }, root);
  assert.equal(typeof value, "object", `${key} must be an object tree`);
  return value as LocaleTree;
}

function compareKeys(base: LocaleTree, candidate: LocaleTree, pathPrefix: string): void {
  const baseKeys = Object.keys(base).sort();
  const candidateKeys = Object.keys(candidate).sort();
  assert.deepEqual(candidateKeys, baseKeys, `${pathPrefix} key mismatch`);
  for (const key of baseKeys) {
    const nextPath = `${pathPrefix}.${key}`;
    const baseValue = base[key];
    const candidateValue = candidate[key];
    assert.equal(typeof candidateValue, typeof baseValue, `${nextPath} type mismatch`);
    if (typeof baseValue === "string") {
      assert.equal(typeof candidateValue, "string", `${nextPath} must be a string`);
      continue;
    }
    compareKeys(baseValue as LocaleTree, candidateValue as LocaleTree, nextPath);
  }
}

const englishMessages = readLocale("en");
const englishCalculatedColumn = getBranch(englishMessages, "dataTable.calculatedColumn");

for (const locale of LOCALES) {
  const messages = readLocale(locale);
  for (const key of REQUIRED_KEYS) {
    assert.equal(typeof getValue(messages, key), "string", `${locale} must define ${key}`);
  }
  compareKeys(englishCalculatedColumn, getBranch(messages, "dataTable.calculatedColumn"), `${locale}.dataTable.calculatedColumn`);
}

console.log("calculated column locale contract passed");
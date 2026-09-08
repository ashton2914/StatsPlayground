import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type LocaleTree = Record<string, LocaleTree | string>;

const LOCALES_DIR = path.resolve(process.cwd(), "src/i18n/locales");
const LOCALES = ["en", "zh-CN", "zh-TW", "vi"] as const;
const REPORT_KEYS = [
  "report.titleHint",
  "report.modeLabel",
  "report.editor",
  "report.preview",
  "report.insert",
  "report.insertTooltip",
  "report.markdownEditorLabel",
  "report.editorPlaceholder",
  "report.previewEmpty",
  "report.embedPlaceholder",
  "report.embedUnavailable",
  "report.embedError",
  "report.group.table",
  "report.group.graph",
  "report.group.fitYByX",
  "report.group.tabulate",
  "history.newReport",
  "history.editReport",
  "history.renameReport",
  "history.deleteReport",
  "menu.report",
  "menu.newReport",
] as const;

function readLocale(locale: (typeof LOCALES)[number]): LocaleTree {
  return JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), "utf8")) as LocaleTree;
}

function getValue(root: LocaleTree, key: string): string | undefined {
  const value = key.split(".").reduce<LocaleTree | string | undefined>((current, segment) => {
    if (!current || typeof current === "string") {
      return undefined;
    }
    return current[segment];
  }, root);

  return typeof value === "string" ? value : undefined;
}

for (const locale of LOCALES) {
  const messages = readLocale(locale);
  for (const key of REPORT_KEYS) {
    assert.equal(typeof getValue(messages, key), "string", `${locale} must define ${key}`);
  }
}

console.log("report locale contract passed");
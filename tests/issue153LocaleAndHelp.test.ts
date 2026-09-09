import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type LocaleTree = Record<string, LocaleTree | string>;

const LOCALES_DIR = path.resolve(process.cwd(), "src/i18n/locales");
const WORKSPACE_PATH = path.resolve(process.cwd(), "src/components/Workspace.tsx");
const HELP_DIALOG_PATH = path.resolve(process.cwd(), "src/components/HelpDialog.tsx");

const LOCALES = ["en", "zh-CN", "zh-TW", "vi"] as const;
const CONTRIBUTOR_NAMES = [
  "Ashton Huang",
  "Chi Zhang",
  "Junyi Zhu",
  "Max Xu",
  "Ryan Qiu",
  "Stanley Su",
] as const;
const REQUIRED_LOCALE_KEYS = [
  "menu.exportTables",
  "menu.contributors",
  "tableExport.title",
  "tableExport.intro",
  "tableExport.tablesTitle",
  "tableExport.empty",
  "tableExport.formatTitle",
  "tableExport.formatAriaLabel",
  "tableExport.format.csv",
  "tableExport.format.sqlite",
  "tableExport.format.sptb",
  "tableExport.selectedCount.one",
  "tableExport.selectedCount.other",
  "tableExport.summarySelected",
  "tableExport.summaryProject",
  "tableExport.cancel",
  "tableExport.export",
  "tableExport.exporting",
  "tableExport.error",
  "tableExport.pickerTitle.csv",
  "tableExport.pickerTitle.sqlite",
  "tableExport.pickerTitle.sptb",
  "help.contributorsTitle",
  "help.contributorsIntro",
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

function expectContributorNames(source: string): void {
  let previousIndex = -1;
  for (const name of CONTRIBUTOR_NAMES) {
    const firstIndex = source.indexOf(name);
    assert.notEqual(firstIndex, -1, `expected contributor ${name}`);
    assert.equal(source.indexOf(name, firstIndex + 1), -1, `expected contributor ${name} exactly once`);
    assert.ok(firstIndex > previousIndex, `expected contributor ${name} after the previous contributor`);
    previousIndex = firstIndex;
  }
}

function expectInOrder(block: string, tokens: readonly string[]): void {
  let previousIndex = -1;
  for (const token of tokens) {
    const index = block.indexOf(token);
    assert.notEqual(index, -1, `expected to find ${token}`);
    assert.ok(index > previousIndex, `expected ${token} after previous token`);
    previousIndex = index;
  }
}

function menuBlock(source: string, labelToken: string): string {
  const start = source.indexOf(`<MenuDropdown label={t("${labelToken}")}>`);
  assert.notEqual(start, -1, `missing ${labelToken} menu block`);
  const next = source.indexOf("</MenuDropdown>", start);
  assert.notEqual(next, -1, `missing closing MenuDropdown for ${labelToken}`);
  return source.slice(start, next);
}

for (const locale of LOCALES) {
  const messages = readLocale(locale);
  for (const key of REQUIRED_LOCALE_KEYS) {
    const value = getValue(messages, key);
    assert.equal(typeof value, "string", `${locale} must define ${key}`);
    assert.ok(value && value.trim().length > 0, `${locale} must define a non-empty ${key}`);
  }
  assert.equal(
    getValue(messages, "fitYByX.report.term.contributorsTitle"),
    undefined,
    `${locale} must not nest contributors inside fitYByX.report.term`,
  );
  assert.equal(
    getValue(messages, "fitYByX.report.lackOfFit.tableExport.title"),
    undefined,
    `${locale} must not nest tableExport inside fitYByX.report.lackOfFit`,
  );
}

const workspaceSource = readFileSync(WORKSPACE_PATH, "utf8");
assert.match(workspaceSource, /useState<"about" \| "license" \| "contributors" \| null>\(null\)/, "Workspace should track contributors help mode");
assert.match(workspaceSource, /t\("menu\.contributors"\)/, "Workspace Help menu should render contributors entry");
assert.match(workspaceSource, /setHelpDialog\("contributors"\)/, "Workspace Help menu should open contributors dialog");
expectInOrder(menuBlock(workspaceSource, "menu.help"), [
  't("menu.about")',
  't("menu.license")',
  't("menu.contributors")',
]);

const helpDialogSource = readFileSync(HELP_DIALOG_PATH, "utf8");
assert.match(helpDialogSource, /mode: "about" \| "license" \| "contributors"/, "HelpDialog should accept contributors mode");
assert.match(helpDialogSource, /const CONTRIBUTORS(?:\s*:\s*Contributor\[\])?\s*=\s*\[/, "HelpDialog should declare a contributors constant");
const contributorsStart = helpDialogSource.indexOf("const CONTRIBUTORS");
const contributorsEnd = helpDialogSource.indexOf("\n];", contributorsStart);
assert.notEqual(contributorsEnd, -1, "HelpDialog should terminate the contributors constant");
expectContributorNames(helpDialogSource.slice(contributorsStart, contributorsEnd));

console.log("issue 153 locale and help contract passed");
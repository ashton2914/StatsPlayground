import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type LocaleTree = Record<string, LocaleTree | string>;

const root = process.cwd();
const workspaceSource = readFileSync(path.join(root, "src/components/Workspace.tsx"), "utf8");
const dialogSource = readFileSync(path.join(root, "src/components/dataLink/PostgresDataLinkDialog.tsx"), "utf8");

function menuBlock(labelToken: string): string {
  const start = workspaceSource.indexOf(`<MenuDropdown label={t("${labelToken}")}>`);
  assert.notEqual(start, -1, `missing ${labelToken} menu block`);
  const end = workspaceSource.indexOf("</MenuDropdown>", start);
  assert.notEqual(end, -1, `missing closing MenuDropdown for ${labelToken}`);
  return workspaceSource.slice(start, end);
}

function localeValue(locale: string, key: string): string | undefined {
  const tree = JSON.parse(readFileSync(path.join(root, `src/i18n/locales/${locale}.json`), "utf8")) as LocaleTree;
  const value = key.split(".").reduce<LocaleTree | string | undefined>((current, segment) => {
    if (!current || typeof current === "string") return undefined;
    return current[segment];
  }, tree);
  return typeof value === "string" ? value : undefined;
}

const fileMenu = menuBlock("menu.file");
const tableMenu = menuBlock("menu.table");

assert.equal(fileMenu.match(/t\("menu\.dataLink"/g)?.length, 1, "File must expose one DataLink entry");
assert.equal(tableMenu.includes("menu.dataLink"), false, "Table must not expose the server DataLink entry");
assert.equal(workspaceSource.includes("connectPostgres"), false, "separate PostgreSQL menu entry must stay removed");
assert.equal(workspaceSource.includes("connectMysql"), false, "separate MySQL menu entry must stay removed");

const requiredLocaleKeys = [
  "menu.dataLink",
  "dataLink.connector",
  ...[
    "selectAll", "selectObject", "queue", "targetFor", "nameConflict", "pending",
    "importing", "completed", "failed", "progress", "selected", "stopping", "stop",
    "close", "importSelected",
  ].map((key) => `serverBatch.${key}`),
  ...[
    "sessionOnly", "connection", "connected", "notTested", "host", "port", "database",
    "username", "password", "timeout", "tlsMode", "tlsDisabled", "tlsRequired",
    "tlsVerifyCa", "tlsVerifyFull", "rootCertificate", "credentialsNote", "test", "testing",
    "discover", "discovering", "connectPrompt", "discoverPrompt", "readOnly", "snapshotNote",
    "importing",
  ].map((key) => `postgresDataLink.${key}`),
  "history.importPostgres",
  "history.importMysql",
];

for (const locale of ["en", "zh-CN", "zh-TW", "vi"]) {
  for (const key of requiredLocaleKeys) {
    const label = localeValue(locale, key);
    assert.ok(label?.trim(), `${locale} must define ${key}`);
  }
}

assert.match(dialogSource, /createServerConnectionDefinition/, "dialog must use shared connector defaults");
assert.match(dialogSource, /setConnector/, "dialog must expose connector switching");
assert.match(dialogSource, /postgresql/, "dialog must offer PostgreSQL");
assert.match(dialogSource, /mysql/, "dialog must offer MySQL");

console.log("workspace DataLink contract passed");
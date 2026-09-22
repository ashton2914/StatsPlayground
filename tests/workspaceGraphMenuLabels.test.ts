import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expectedLabels = {
  en: {
    newGraph: "Graph Builder",
    massiveDataGraph: "Graph Builder for massive data",
  },
  "zh-CN": {
    newGraph: "图形构建器",
    massiveDataGraph: "面向海量数据的图形构建器",
  },
  "zh-TW": {
    newGraph: "圖形建構器",
    massiveDataGraph: "面向海量資料的圖形建構器",
  },
  vi: {
    newGraph: "Trình tạo biểu đồ",
    massiveDataGraph: "Trình tạo biểu đồ cho dữ liệu lớn",
  },
} as const;

for (const [locale, expected] of Object.entries(expectedLabels)) {
  const messages = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  ) as { menu?: Record<string, string> };

  assert.equal(messages.menu?.newGraph, expected.newGraph, `${locale} must name the standard entry`);
  assert.equal(
    messages.menu?.massiveDataGraph,
    expected.massiveDataGraph,
    `${locale} must name the massive-data entry`,
  );
}

const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);

assert.match(workspaceSource, /\{t\("menu\.newGraph"\)\}/);
assert.match(workspaceSource, /\{t\("menu\.massiveDataGraph"\)\}/);
assert.doesNotMatch(workspaceSource, />\s*Graph Builder-new\s*</);

console.log("workspace graph menu labels OK");

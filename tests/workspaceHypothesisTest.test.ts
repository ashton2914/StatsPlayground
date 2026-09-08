import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/components/Workspace.tsx"), "utf8");
for (const required of [
  "showHypothesisTestDialog",
  "<HypothesisTestDialog",
  "createHypothesisTestAnalysisDocument",
  "addAnalysis(created)",
  'activateWorkspaceDocument("analysis", created.id)',
  "createAnalysisEditorPatch",
  'editingAnalysis.analysisKind === "hypothesisTest"',
]) {
  assert.equal(source.includes(required), true, `Workspace must include ${required}`);
}
assert.equal(source.includes("useHypothesisTestStore"), false);
assert.equal(source.includes("hypothesisTestFolders"), false);

for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
  const messages = JSON.parse(readFileSync(resolve(process.cwd(), `src/i18n/locales/${locale}.json`), "utf8"));
  assert.equal(typeof messages.menu.hypothesisTest, "string");
  assert.equal(typeof messages.hypothesisTest.title, "string");
  assert.equal(typeof messages.hypothesisTest.studyDesign.pairedOrBlocked, "string");
}
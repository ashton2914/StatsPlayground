import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function extractFunctionBody(code: string, signature: string): string {
  const start = code.indexOf(signature);
  assert.notEqual(start, -1, `Missing function signature: ${signature}`);
  const braceStart = code.indexOf("{", start);
  assert.notEqual(braceStart, -1, `Missing function body start: ${signature}`);
  let depth = 1;
  for (let i = braceStart + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return code.slice(braceStart + 1, i);
  }
  throw new Error(`Unbalanced braces while parsing: ${signature}`);
}

const renameSubmitBody = extractFunctionBody(source, "const handleRenameSubmit = async (id: string) =>");

assert.match(
  renameSubmitBody,
  /const basename = resolved\.basename;[\s\S]*?try \{\s*await dataService\.renameDataset\(id, basename\);\s*await refreshDatasets\(\);[\s\S]*?\} catch \(error\) \{/,
  "Dataset rename must catch backend failures around blur/Enter submit path",
);

assert.match(
  renameSubmitBody,
  /alert\(t\("alert\.renameTableFailed", \{[\s\S]*?defaultValue: "Rename table failed: ",/,
  "Dataset rename failure must use the existing alert pattern",
);

assert.match(
  source,
  /onBlur=\{\(\) => void handleRenameSubmit\(ds\.id\)\}/,
  "Dataset rename onBlur should submit async rename without leaving unhandled Promise",
);

assert.match(
  source,
  /if \(e\.key === "Enter"\) void handleRenameSubmit\(ds\.id\);/,
  "Dataset rename Enter key should submit async rename without leaving unhandled Promise",
);

console.log("workspace rename failure contract passed");

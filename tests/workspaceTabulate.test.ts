import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);

assert.match(
  workspaceSource,
  /<TabulateView[\s\S]*existingDatasetNames=\{datasets\.map\(\(dataset\) => dataset\.name\)\}/,
);

console.log("workspace tabulate wiring OK");
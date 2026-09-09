import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const projectServiceSource = read("../src/services/projectService.ts");
const projectCommandSource = read("../src-tauri/src/commands/project_commands.rs");
const projectServiceRustSource = read("../src-tauri/src/services/project_service.rs");
const libSource = read("../src-tauri/src/lib.rs");
const guardCoverageSource = read("../src-tauri/src/commands/mutation_guard_coverage.rs");

assert.equal(
  projectServiceSource.includes("exportGraph:"),
  false,
  "projectService must not expose a standalone exportGraph wrapper.",
);
assert.equal(
  projectServiceSource.includes('invoke<void>("export_graph"'),
  false,
  "projectService must not invoke the standalone export_graph command.",
);
assert.equal(
  projectServiceSource.includes("importGraph:"),
  true,
  "projectService must keep the standalone importGraph wrapper.",
);
assert.equal(
  projectServiceSource.includes('invoke<unknown>("import_graph"'),
  true,
  "projectService must still invoke import_graph.",
);

assert.equal(
  projectCommandSource.includes("pub fn export_graph("),
  false,
  "project_commands must not expose export_graph.",
);
assert.equal(
  projectCommandSource.includes("pub fn import_graph("),
  true,
  "project_commands must keep import_graph.",
);

assert.equal(
  projectServiceRustSource.includes("pub fn export_graph(&self"),
  false,
  "ProjectService must not keep the standalone export_graph service.",
);
assert.equal(
  projectServiceRustSource.includes("pub fn import_graph(&self"),
  true,
  "ProjectService must keep standalone graph import.",
);

assert.equal(
  libSource.includes("commands::project_commands::export_graph"),
  false,
  "Tauri command registration must not include export_graph.",
);
assert.equal(
  libSource.includes("commands::project_commands::import_graph"),
  true,
  "Tauri command registration must keep import_graph.",
);

assert.equal(
  guardCoverageSource.includes("commands::project_commands::export_graph"),
  false,
  "Mutation guard coverage must not classify export_graph.",
);
assert.equal(
  guardCoverageSource.includes("commands::project_commands::import_graph"),
  true,
  "Mutation guard coverage must still classify import_graph.",
);

console.log("graph export removal contract passed");
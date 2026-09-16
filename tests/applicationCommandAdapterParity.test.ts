import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorkspaceCommandHandlers } from "@/components/workspaceCommandHandlers";

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function translate(key: string, options?: { defaultValue?: string }): string {
  return options?.defaultValue ?? key;
}

const toolsSource = readSource("../src-tauri/src/mcp/tools.rs");
const runtimeSource = readSource("../src/applicationCommands/applicationRuntime.ts");

const phase1Mutations = [
  ["statsplayground.table.create", "table.create"],
  ["statsplayground.table.transform.create", "tableTransform.create"],
  ["statsplayground.table.transform.run", "tableTransform.run"],
  ["statsplayground.sql.create_table", "sql.createTable"],
  ["statsplayground.tabulate.create", "tabulate.create"],
  ["statsplayground.tabulate.run", "tabulate.run"],
  ["statsplayground.tabulate.to_table", "tabulate.exportTable"],
  ["statsplayground.graph.create", "graph.create"],
  ["statsplayground.graph.update", "graph.update"],
  ["statsplayground.analysis.create", "analysis.create"],
  ["statsplayground.analysis.update", "analysis.update"],
  ["statsplayground.analysis.run", "analysis.run"],
  ["statsplayground.report.create", "report.create"],
  ["statsplayground.report.update", "report.update"],
  ["statsplayground.table.export_csv", "table.exportCsv"],
  ["statsplayground.project.save", "project.save"],
  ["statsplayground.snapshot.create", "snapshot.create"],
] as const;

for (const [toolName, commandName] of phase1Mutations) {
  assert.match(
    toolsSource,
    new RegExp(`entry::<[^>]+>\\(\\s*\"${toolName}\\",\\s*\"${commandName}\\",`, "m"),
    `MCP tool ${toolName} must project to ${commandName}`,
  );
  assert.match(
    runtimeSource,
    new RegExp(`runtime\\.register\\(\\s*\"${commandName}\\"`, "m"),
    `Application runtime must register ${commandName}`,
  );
}

{
  const executed: Array<unknown> = [];

  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/project.spprj",
    getProjectRevision: () => 9,
    isSaving: () => false,
    isReadOnly: () => false,
    executeCommand: async (command) => {
      executed.push(command);
      return {
        requestId: "cmd-save-existing-path",
        command: "project.save",
        changed: true,
        projectRevision: 10,
        data: {
          name: "Task12",
          createdAt: "2026-09-16T00:00:00.000Z",
          fileName: "project.spprj",
          hasProjectPath: true,
        },
        warnings: [],
      };
    },
  });

  await handlers.saveProject();

  assert.deepEqual(executed, [{
    type: "project.save",
    input: {},
    control: { expectedProjectRevision: 9 },
  }], "UI save with an existing project path must project to the same project.save command shape as MCP");
}

console.log("application command adapter parity passed");

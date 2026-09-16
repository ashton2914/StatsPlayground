import assert from "node:assert/strict";

import { createWorkspaceCommandHandlers } from "@/components/workspaceCommandHandlers";
import { createApplicationCommandBridge } from "@/services/applicationCommandBridge";
import type { ApplicationCommand, ApplicationCommandRegistry } from "@/applicationCommands/types";

type Command = ApplicationCommand<ApplicationCommandRegistry>;

function translate(key: string, options?: { defaultValue?: string }): string {
  return options?.defaultValue ?? key;
}

async function projectThroughMcpBridge(command: Command): Promise<Command> {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const captured: Command[] = [];

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: (receivedCommand) => {
        captured.push(receivedCommand as Command);
        const result = Promise.resolve({
          requestId: "cmd-bridge",
          command: (receivedCommand as Command).type,
          changed: true,
          projectRevision: 1,
          data: {},
          warnings: [],
        }) as Promise<unknown> & { requestId?: string };
        Object.defineProperty(result, "requestId", {
          value: "cmd-bridge",
          enumerable: true,
        });
        return result as never;
      },
    },
    listen: async (eventName, listener) => {
      listeners.set(eventName, listener as (event: { payload: unknown }) => void);
      return () => {
        listeners.delete(eventName);
      };
    },
    invoke: async (name) => {
      if (name === "register_application_command_dispatcher") {
        listeners.get("application-command-request")?.({
          payload: {
            requestId: "mcp-request-1",
            command,
          },
        });
      }
      return undefined as never;
    },
  });

  const disposer = await bridge.start();
  await Promise.resolve();
  await disposer.dispose();

  assert.equal(captured.length, 1, "MCP bridge must dispatch exactly one command to the runtime");
  return captured[0]!;
}

async function projectSaveFromUi(input: {
  existingPath: string | null;
  selectedPath?: string | null;
  revision: number;
}): Promise<Command> {
  const captured: Command[] = [];
  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => input.existingPath,
    getProjectRevision: () => input.revision,
    isSaving: () => false,
    isReadOnly: () => false,
    requestSaveProjectPath: async () => input.selectedPath ?? null,
    executeCommand: async (command) => {
      captured.push(command as Command);
      return {
        requestId: "cmd-save-ui",
        command: "project.save",
        changed: true,
        projectRevision: input.revision + 1,
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
  assert.equal(captured.length, 1, "UI save intent must execute exactly one shared command");
  return captured[0]!;
}

async function projectSnapshotFromUi(): Promise<Command> {
  const captured: Command[] = [];
  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/project.spprj",
    getProjectRevision: () => 1,
    isSaving: () => false,
    isReadOnly: () => false,
    listen: async () => () => undefined,
    executeCommand: async (command) => {
      captured.push(command as Command);
      return {
        requestId: "cmd-snapshot-ui",
        command: "snapshot.create",
        changed: true,
        projectRevision: 2,
        data: { snapshotId: "snapshot-1", snapshotName: null, createdAt: null },
        warnings: [],
      };
    },
  });
  await handlers.createSnapshot();
  assert.equal(captured.length, 1);
  return captured[0]!;
}

async function projectExportCsvFromUi(): Promise<Command> {
  const captured: Command[] = [];
  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/project.spprj",
    getProjectRevision: () => 1,
    isSaving: () => false,
    isReadOnly: () => false,
    authorizeCsvExportRoot: async () => ({ rootId: "root-1", displayName: "root-1" }),
    revokeCsvExportRoot: async () => undefined,
    waitForCommandConfirmation: async () => null,
    executeCommand: async (command) => {
      captured.push(command as Command);
      const result = Promise.resolve({
        requestId: "cmd-export-ui",
        command: "table.exportCsv",
        changed: false,
        projectRevision: 1,
        data: { targetStatus: "createNew" as const },
        warnings: [],
      }) as Promise<unknown> & { requestId?: string };
      Object.defineProperty(result, "requestId", {
        value: "cmd-export-ui",
        enumerable: true,
      });
      return result as never;
    },
  });

  await handlers.exportCsv({
    format: "csv",
    mode: "single-file",
    datasetIds: ["table-main"],
    archivePaths: {},
    sqliteNames: {},
  }, "/Users/ashton/private/exports/out.csv");

  assert.equal(captured.length, 1);
  return captured[0]!;
}

const sharedMutationCommands: Command[] = [
  { type: "table.create", input: { request: { name: "Main", columns: [{ name: "width", sqlType: "DOUBLE" }], rows: [[10.01]] } } },
  { type: "tableTransform.create", input: { draft: { name: "Sort", operation: { kind: "sort", sortColumns: [{ column: "width", direction: "ascending" }] } } } as never },
  { type: "tableTransform.run", input: { transformId: "transform-1" } },
  { type: "sql.createTable", input: { sql: "select 1 as width", name: "sql-table" } },
  { type: "tabulate.create", input: { sourceDatasetId: "table-main" } },
  {
    type: "tabulate.run",
    input: {
      tabulateId: "tabulate-1",
      request: {
        datasetId: "table-main",
        rowFields: ["build"],
        columnFields: [],
        statistics: [{ id: "mean-width", field: "width", kind: "mean" }],
        includeRowTotals: true,
        includeColumnTotals: false,
        maxResultCells: 10000,
      },
    },
  },
  {
    type: "tabulate.exportTable",
    input: {
      tabulateId: "tabulate-1",
      tableName: "tabulate-output",
      request: {
        datasetId: "table-main",
        rowFields: ["build"],
        columnFields: [],
        statistics: [{ id: "mean-width", field: "width", kind: "mean" }],
        includeRowTotals: true,
        includeColumnTotals: false,
        maxResultCells: 10000,
      },
    },
  },
  { type: "graph.create", input: { sourceDatasetId: "table-main" } },
  {
    type: "graph.update",
    input: {
      graphId: "graph-1",
      expectedDocumentRevision: 2,
      definition: {
        id: "graph-1",
        name: "Graph 1",
        sourceDatasetId: "table-main",
        mode: "simple",
        modeStates: {},
        createdAt: "2026-09-16T00:00:00.000Z",
      },
    } as never,
  },
  {
    type: "analysis.create",
    input: {
      analysisKind: "hypothesisTest",
      sourceDatasetId: "table-main",
      draft: {
        name: "Hypothesis",
        definition: {
          kind: "hypothesisTest",
          roles: {
            layout: "long",
            response: { name: "width", type: "continuous" },
            condition: { name: "build", type: "nominal" },
            subject: null,
          },
          studyDesign: "independent",
          selectionMode: "automatic",
          manualSelection: null,
          alternative: "twoSided",
          alpha: 0.05,
          confidenceLevel: 0.95,
          levelOrder: ["EV", "DV"],
          referenceLevel: "EV",
          postHoc: "automatic",
          selectorVersion: "1",
        },
      },
    },
  },
  {
    type: "analysis.update",
    input: {
      analysisId: "analysis-1",
      analysisKind: "hypothesisTest",
      expectedConfigRevision: 3,
      draft: {
        definition: {
          kind: "hypothesisTest",
          roles: {
            layout: "long",
            response: { name: "width", type: "continuous" },
            condition: { name: "build", type: "nominal" },
            subject: null,
          },
          studyDesign: "independent",
          selectionMode: "automatic",
          manualSelection: null,
          alternative: "twoSided",
          alpha: 0.05,
          confidenceLevel: 0.95,
          levelOrder: ["EV", "DV"],
          referenceLevel: "EV",
          postHoc: "automatic",
          selectorVersion: "1",
        },
      },
    },
  },
  { type: "analysis.run", input: { analysisId: "analysis-1" } },
  { type: "report.create", input: {} },
  { type: "report.update", input: { reportId: "report-1", expectedDocumentRevision: 2, markdown: "# Updated" } },
];

for (const uiCommand of sharedMutationCommands) {
  const projectedByMcp = await projectThroughMcpBridge(uiCommand);
  assert.deepEqual(
    projectedByMcp,
    uiCommand,
    `MCP bridge projection for ${uiCommand.type} must preserve the exact canonical ApplicationCommand payload`,
  );
}

const saveExistingUi = await projectSaveFromUi({
  existingPath: "/Users/ashton/private/project.spprj",
  selectedPath: null,
  revision: 9,
});
assert.deepEqual(saveExistingUi, {
  type: "project.save",
  input: {},
  control: { expectedProjectRevision: 9 },
});
assert.deepEqual(
  await projectThroughMcpBridge(saveExistingUi),
  saveExistingUi,
  "MCP and UI must emit the same project.save command for existing-path save",
);

const saveAsUi = await projectSaveFromUi({
  existingPath: null,
  selectedPath: "/Users/ashton/private/selected.spprj",
  revision: 4,
});
assert.deepEqual(saveAsUi, {
  type: "project.save",
  input: { filePath: "/Users/ashton/private/selected.spprj" },
  control: { expectedProjectRevision: 4 },
});
assert.deepEqual(
  await projectThroughMcpBridge(saveAsUi),
  saveAsUi,
  "MCP and UI must emit the same project.save command for Save As",
);

const snapshotUi = await projectSnapshotFromUi();
assert.deepEqual(snapshotUi, { type: "snapshot.create", input: {} });
assert.deepEqual(
  await projectThroughMcpBridge(snapshotUi),
  snapshotUi,
  "MCP and UI must emit the same snapshot.create command",
);

const csvUi = await projectExportCsvFromUi();
assert.deepEqual(csvUi, {
  type: "table.exportCsv",
  input: {
    datasetId: "table-main",
    rootId: "root-1",
    relativePath: "out.csv",
  },
});
assert.deepEqual(
  await projectThroughMcpBridge(csvUi),
  csvUi,
  "MCP and UI must emit the same table.exportCsv command",
);

console.log("application command adapter parity passed");

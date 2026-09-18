import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApplicationCommand } from "@/applicationCommands/types";
import { createWorkspaceCommandHandlers } from "@/components/workspaceCommandHandlers";
import { createApplicationCommandBridge } from "@/services/applicationCommandBridge";
import type { ApplicationCommandRegistry } from "@/applicationCommands/types";

type Command = ApplicationCommand<ApplicationCommandRegistry>;

interface ProjectionCase {
  id: string;
  toolName: string;
  rawArguments: Record<string, unknown>;
  expectedEnvelope: {
    type: string;
    input: Record<string, unknown>;
    control?: Record<string, unknown>;
  };
}

interface ArtifactParityFixture {
  projectionCases: ProjectionCase[];
}

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));

function loadFixture(): ArtifactParityFixture {
  const content = readFileSync(
    resolve(TEST_FILE_DIR, "../contracts/mcp/artifact-parity.v1.json"),
    "utf8",
  );
  return JSON.parse(content) as ArtifactParityFixture;
}

function findProjectionCase(fixture: ArtifactParityFixture, id: string): ProjectionCase {
  const found = fixture.projectionCases.find((entry) => entry.id === id);
  assert.ok(found, `Missing fixture projection case: ${id}`);
  return found;
}

function translate(key: string, options?: { defaultValue?: string }): string {
  return options?.defaultValue ?? key;
}

async function captureUiSaveCommand(expectedRevision: number): Promise<Command> {
  const captured: Command[] = [];
  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/project.spprj",
    getProjectRevision: () => expectedRevision,
    isSaving: () => false,
    isReadOnly: () => false,
    requestSaveProjectPath: async () => null,
    executeCommand: async (command) => {
      captured.push(command);
      return {
        requestId: "cmd-save-ui",
        command: "project.save",
        changed: true,
        projectRevision: expectedRevision + 1,
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
  assert.equal(captured.length, 1, "UI save must execute one command");
  return captured[0]!;
}

async function captureUiSnapshotCommand(): Promise<Command> {
  const captured: Command[] = [];
  const handlers = createWorkspaceCommandHandlers({
    t: translate,
    getProjectFilePath: () => "/Users/ashton/private/project.spprj",
    getProjectRevision: () => 1,
    isSaving: () => false,
    isReadOnly: () => false,
    listen: async () => () => undefined,
    executeCommand: async (command) => {
      captured.push(command);
      return {
        requestId: "cmd-snapshot-ui",
        command: "snapshot.create",
        changed: true,
        projectRevision: 2,
        data: {
          snapshotId: "snapshot-1",
          snapshotName: null,
          createdAt: null,
        },
        warnings: [],
      };
    },
  });

  await handlers.createSnapshot();
  assert.equal(captured.length, 1, "UI snapshot must execute one command");
  return captured[0]!;
}

async function captureUiCsvCommand(): Promise<Command> {
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
      captured.push(command);
      return {
        requestId: "cmd-export-ui",
        command: "table.exportCsv",
        changed: false,
        projectRevision: 1,
        data: { targetStatus: "createNew" as const },
        warnings: [],
      };
    },
  });

  await handlers.exportCsv({
    format: "csv",
    mode: "single-file",
    datasetIds: ["table-main"],
    archivePaths: {},
    sqliteNames: {},
  }, "/Users/ashton/private/exports/main.csv");

  assert.equal(captured.length, 1, "UI CSV export must execute one command");
  return captured[0]!;
}

async function projectThroughMcpBridge(command: Command): Promise<Command> {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const captured: Command[] = [];

  const bridge = createApplicationCommandBridge({
    runtime: {
      execute: (receivedCommand) => {
        captured.push(receivedCommand);
        return Promise.resolve({
          requestId: "cmd-bridge",
          command: receivedCommand.type,
          changed: true,
          projectRevision: 1,
          data: {},
          warnings: [],
        });
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
      return undefined;
    },
  });

  const disposer = await bridge.start();
  await Promise.resolve();
  await disposer.dispose();

  assert.equal(captured.length, 1, "Bridge must dispatch one command");
  return captured[0]!;
}

const fixture = loadFixture();
for (const name of ["tabulate.run", "tabulate.exportTable"]) {
  const entry = findProjectionCase(fixture, name);
  assert.equal("maxResultCells" in (entry.expectedEnvelope.input.request as object), false);
  const command = entry.expectedEnvelope as Command;
  assert.deepEqual(await projectThroughMcpBridge(command), command);
}
const saveCase = findProjectionCase(fixture, "project.save");
const snapshotCase = findProjectionCase(fixture, "snapshot.create");
const csvCase = findProjectionCase(fixture, "table.exportCsv");

const uiSave = await captureUiSaveCommand(29);
assert.deepEqual(uiSave, {
  type: saveCase.expectedEnvelope.type,
  input: saveCase.expectedEnvelope.input,
  control: saveCase.expectedEnvelope.control,
});

const uiSnapshot = await captureUiSnapshotCommand();
assert.deepEqual(uiSnapshot, {
  type: snapshotCase.expectedEnvelope.type,
  input: {},
});

const uiCsv = await captureUiCsvCommand();
assert.deepEqual(uiCsv, {
  type: csvCase.expectedEnvelope.type,
  input: {
    datasetId: "table-main",
    rootId: "root-1",
    relativePath: "main.csv",
  },
});

const passThroughSave = await projectThroughMcpBridge(uiSave);
assert.deepEqual(passThroughSave, uiSave, "Bridge transport pass-through should preserve canonical save command");

console.log("application command adapter parity passed");

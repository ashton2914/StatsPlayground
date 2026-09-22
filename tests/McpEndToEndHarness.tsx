import { useMemo, useState } from "react";

import { createDefaultCommandPolicy } from "@/applicationCommands/policy";
import {
  CommandExecutionError,
  createApplicationCommandRuntime,
  type ApplicationCommandRuntime,
} from "@/applicationCommands/runtime";
import type {
  ApplicationCommand,
  ApplicationCommandRegistry,
  CommandActor,
} from "@/applicationCommands/types";
import { createApplicationCommandBridge } from "@/services/applicationCommandBridge";
import {
  listMcpCommandRequestsFromRuntimeSnapshot,
  type McpManagementServiceLike,
} from "@/services/mcpManagementService";
import { AiActivityView } from "../src/components/ai/AiActivityView";
import { createMcpStore } from "../src/stores/useMcpStore";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
  McpSettings,
} from "../src/types/mcp";
import artifactParityFixture from "../contracts/mcp/artifact-parity.v1.json";

type CommandType = Extract<keyof ApplicationCommandRegistry, string>;
type Command = ApplicationCommand<ApplicationCommandRegistry, CommandType>;
type Listener = (event: { payload: unknown }) => void;

type ScenarioProjectionCase = {
  id: string;
  expectedEnvelope: {
    type: CommandType;
    input: Record<string, unknown>;
    control?: Record<string, unknown>;
  };
};

type ScenarioFixture = {
  projectionCases: ScenarioProjectionCase[];
};

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loadScenarioFixture(): ScenarioFixture {
  return artifactParityFixture as ScenarioFixture;
}

function normalizeCommand(
  envelope: ScenarioProjectionCase["expectedEnvelope"],
): Command {
  return {
    type: envelope.type,
    input: envelope.input as never,
    control: undefined,
  };
}

function buildAnalysisKindCommands(datasetId: string): Command[] {
  const now = "2026-09-16T00:00:00.000Z";
  const baseCreate = {
    type: "analysis.create" as const,
    input: {
      analysisKind: "distribution",
      sourceDatasetId: datasetId,
      draft: {
        name: "Distribution 1",
        analysis: { responses: [{ name: "width", type: "continuous" }] },
        graphs: {},
      },
    },
  };

  return [
    baseCreate as unknown as Command,
    {
      type: "analysis.create",
      input: {
        analysisKind: "fitYByX",
        sourceDatasetId: datasetId,
        draft: {
          name: "Fit Y by X 1",
          response: { name: "width", type: "continuous" },
          factor: { name: "build", type: "nominal" },
          confidenceLevel: 0.95,
        },
      },
    } as unknown as Command,
    {
      type: "analysis.create",
      input: {
        analysisKind: "fitModel",
        sourceDatasetId: datasetId,
        draft: {
          name: "Fit Model 1",
          response: { name: "width", type: "continuous" },
          construct: "standard",
          terms: [{ kind: "main", columnNames: ["width"] }],
          centeringMethod: "none",
          confidenceLevel: 0.95,
        },
      },
    } as unknown as Command,
    {
      type: "analysis.create",
      input: {
        analysisKind: "hypothesisTest",
        sourceDatasetId: datasetId,
        draft: {
          name: "Hypothesis Test 1",
          definition: {
            method: "ttest_independent",
            roles: {
              layout: "long",
              response: { name: "width", type: "continuous" },
              condition: { name: "build", type: "nominal" },
              subject: null,
            },
            options: {},
          },
        },
      },
    } as unknown as Command,
    {
      type: "analysis.run",
      input: { analysisId: "analysis-distribution" },
    } as unknown as Command,
    {
      type: "analysis.run",
      input: { analysisId: "analysis-fitybyx" },
    } as unknown as Command,
    {
      type: "analysis.run",
      input: { analysisId: "analysis-fitmodel" },
    } as unknown as Command,
    {
      type: "analysis.run",
      input: { analysisId: "analysis-hypothesistest" },
    } as unknown as Command,
    {
      type: "analysis.update",
      input: {
        analysisId: "analysis-distribution",
        analysisKind: "distribution",
        expectedConfigRevision: 1,
        draft: {
          responses: [{ name: "width", type: "continuous" }],
          groupedBy: null,
          confidenceLevel: 0.95,
          showNormalCurve: true,
          showHistogram: true,
          bins: { mode: "auto" },
          outlierRule: "iqr",
          graphs: {},
        },
      },
    } as unknown as Command,
    {
      type: "analysis.update",
      input: {
        analysisId: "analysis-fitybyx",
        analysisKind: "fitYByX",
        expectedConfigRevision: 1,
        draft: {
          response: { name: "width", type: "continuous" },
          factor: { name: "build", type: "nominal" },
          confidenceLevel: 0.95,
        },
      },
    } as unknown as Command,
    {
      type: "analysis.update",
      input: {
        analysisId: "analysis-fitmodel",
        analysisKind: "fitModel",
        expectedConfigRevision: 1,
        draft: {
          response: { name: "width", type: "continuous" },
          construct: "standard",
          terms: [{ kind: "main", columnNames: ["width"] }],
          centeringMethod: "none",
          confidenceLevel: 0.95,
        },
      },
    } as unknown as Command,
    {
      type: "analysis.update",
      input: {
        analysisId: "analysis-hypothesistest",
        analysisKind: "hypothesisTest",
        expectedConfigRevision: 1,
        draft: {
          definition: {
            method: "ttest_independent",
            roles: {
              layout: "long",
              response: { name: "width", type: "continuous" },
              condition: { name: "build", type: "nominal" },
              subject: null,
            },
            options: {},
          },
          presentation: {
            updatedAt: now,
            sections: [],
          },
        },
      },
    } as unknown as Command,
  ];
}

function createRuntime(): ApplicationCommandRuntime<ApplicationCommandRegistry> {
  const runtime = createApplicationCommandRuntime<ApplicationCommandRegistry>({
    initialRevision: 21,
    policy: createDefaultCommandPolicy({
      inspectCsvExportTarget: ({ relativePath }) => (
        relativePath.toLowerCase().includes("existing") ? "overwriteExisting" : "createNew"
      ),
    }),
  });

  const readResult = {
    changed: false,
    warnings: [],
  };
  const mutationResult = {
    changed: true,
    warnings: [],
  };

  runtime.register("project.inspect", async () => ({
    ...readResult,
    data: {
      project: {
        name: "Task13",
        createdAt: "2026-09-16T00:00:00.000Z",
        fileName: "task13.spprj",
        hasProjectPath: true,
      },
      dirty: true,
      readOnly: false,
      projectRevision: 21,
      counts: {
        tables: 1,
        tableTransforms: 1,
        graphs: 1,
        analyses: 4,
        tabulates: 1,
        reports: 1,
      },
    },
  }));

  runtime.register("table.create", async () => ({
    ...mutationResult,
    data: {
      dataset: {
        id: "table-main",
        name: "Main Table",
        sourceType: "manual",
        rowCount: 2,
        colCount: 2,
        generation: 1,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
        sourceName: null,
      },
      generation: 1,
      columns: [
        { colIndex: 0, colName: "width", colType: "DOUBLE" },
        { colIndex: 1, colName: "build", colType: "VARCHAR" },
      ],
    },
  }));

  runtime.register("tableTransform.create", async () => ({
    ...mutationResult,
    data: {
      execution: {
        definitionId: "transform-1",
        runState: { outputGeneration: 1 },
        output: { id: "table-transform-output-1", name: "Sorted width" },
      },
      definition: { id: "transform-1", name: "Sort width" },
      binding: { definitionId: "transform-1" },
      outputTable: null,
      targetDatasetGeneration: 1,
    },
  }));

  runtime.register("tableTransform.run", async () => ({
    ...mutationResult,
    data: {
      execution: {
        definitionId: "transform-1",
        runState: { outputGeneration: 2 },
        output: { id: "table-transform-output-1", name: "Sorted width" },
      },
      definition: { id: "transform-1", name: "Sort width" },
      binding: { definitionId: "transform-1" },
      outputTable: null,
      targetDatasetGeneration: 2,
    },
  }));

  runtime.register("sql.createTable", async () => ({
    ...mutationResult,
    data: {
      datasetId: "table-sql-1",
      datasetName: "SQL Result",
      outputTable: null,
    },
  }));

  runtime.register("tabulate.create", async () => ({
    ...mutationResult,
    data: {
      item: {
        id: "tabulate-1",
        name: "Width by Build",
        sourceDatasetId: "table-main",
        rowFields: [],
        columnFields: [],
        statistics: [],
        includeRowTotals: true,
        includeColumnTotals: true,
        createdAt: "2026-09-16T00:00:00.000Z",
      },
    },
  }));

  runtime.register("tabulate.run", async () => ({
    ...readResult,
    data: {
      tabulateId: "tabulate-1",
      requestFingerprint: "fingerprint-1",
      sourceGeneration: 1,
      completedAt: "2026-09-16T00:00:00.000Z",
      result: {
        rowMembers: [],
        columnMembers: [],
        statistics: [],
        cells: [],
      },
      cacheValid: true,
    },
  }), { mode: "read" });

  runtime.register("tabulate.exportTable", async () => ({
    ...mutationResult,
    data: {
      outputTable: null,
      reran: false,
      requestFingerprint: "fingerprint-1",
      sourceGeneration: 1,
    },
  }));

  runtime.register("graph.create", async () => ({
    ...mutationResult,
    data: {
      item: {
        id: "graph-1",
        name: "Width Graph",
        sourceDatasetId: "table-main",
        mode: "2d",
        modeStates: { twoD: {}, threeD: {}, multivariate: {} },
        createdAt: "2026-09-16T00:00:00.000Z",
      },
      documentRevision: 1,
    },
  }));

  runtime.register("graph.update", async () => ({
    ...mutationResult,
    data: {
      item: {
        id: "graph-1",
        name: "Width Graph",
        sourceDatasetId: "table-main",
        mode: "2d",
        modeStates: { twoD: {}, threeD: {}, multivariate: {} },
        createdAt: "2026-09-16T00:00:00.000Z",
      },
      documentRevision: 2,
    },
  }));

  runtime.register("analysis.create", async (input) => {
    const kind = (input as { analysisKind: string }).analysisKind;
    return {
      ...mutationResult,
      data: {
        item: {
          id: `analysis-${String(kind).toLowerCase()}`,
          analysisKind: kind,
          name: `${kind} 1`,
          source: { datasetId: "table-main" },
          definition: {},
          presentation: {},
          configRevision: 1,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        },
      },
    };
  });

  runtime.register("analysis.update", async (input) => ({
    ...mutationResult,
    data: {
      item: {
        id: (input as { analysisId: string }).analysisId,
        analysisKind: (input as { analysisKind: string }).analysisKind,
        name: "Updated Analysis",
        source: { datasetId: "table-main" },
        definition: {},
        presentation: {},
        configRevision: 2,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
    },
  }));

  runtime.register("analysis.run", async (input) => ({
    ...readResult,
    data: {
      item: {
        id: (input as { analysisId: string }).analysisId,
        analysisKind: "distribution",
        name: "Analysis",
        source: { datasetId: "table-main" },
        definition: {},
        presentation: {},
        configRevision: 2,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      definition: {},
      dataset: {
        id: "table-main",
        name: "Main Table",
        sourceType: "manual",
        sourcePath: null,
        rowCount: 2,
        colCount: 2,
        generation: 1,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      state: {},
    },
  }), { mode: "read" });

  runtime.register("report.create", async () => ({
    ...mutationResult,
    data: {
      item: {
        schemaVersion: 1,
        id: "report-1",
        name: "Task 13 Report",
        markdown: "# Report",
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      documentRevision: 1,
    },
  }));

  runtime.register("report.update", async () => ({
    ...mutationResult,
    data: {
      item: {
        schemaVersion: 1,
        id: "report-1",
        name: "Task 13 Report",
        markdown: "# Updated",
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      documentRevision: 2,
    },
  }));

  runtime.register("project.save", async () => ({
    ...mutationResult,
    data: {
      name: "Task13",
      createdAt: "2026-09-16T00:00:00.000Z",
      fileName: "task13.spprj",
      hasProjectPath: true,
    },
  }));

  runtime.register("snapshot.create", async () => ({
    ...mutationResult,
    data: {
      snapshotId: "snapshot-1",
      snapshotName: "Snapshot 1",
      createdAt: "2026-09-16T00:00:00.000Z",
    },
  }));

  runtime.register("table.exportCsv", async (_input, context) => {
    if (!context.trusted.policy.confirmationGranted) {
      throw new CommandExecutionError("confirmation_required", "CSV export target requires confirmation", true);
    }
    return {
      ...readResult,
      data: {
        targetStatus: "overwriteExisting",
      },
    };
  }, { mode: "read", risk: "high" });

  runtime.register("table.list", async () => ({ ...readResult, data: { items: [], nextCursor: null } }), { mode: "read" });
  runtime.register("table.describe", async () => ({ ...readResult, data: { dataset: { id: "table-main", name: "Main Table", sourceType: "manual", rowCount: 2, colCount: 2, generation: 1, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z", sourceName: null }, generation: 1, columns: [] } }), { mode: "read" });
  runtime.register("document.list", async () => ({ ...readResult, data: { items: [], nextCursor: null } }), { mode: "read" });
  runtime.register("document.get", async () => ({ ...readResult, data: { kind: "report", id: "report-1", document: {} } }), { mode: "read" });

  return runtime;
}

function createHarnessService(): McpManagementServiceLike & {
  runHappyPathScenario: () => Promise<void>;
  runDeniedOverwriteScenario: () => Promise<void>;
  getCorrelations: () => Array<{ requestId: string; command: string; status: string }>;
  getSequence: () => string[];
} {
  const fixture = loadScenarioFixture();
  const projectionMap = new Map(fixture.projectionCases.map((entry) => [entry.id, entry]));

  let runtime = createRuntime();
  const listeners = new Map<string, Listener>();
  const completionUpdates: Array<{ requestId: string; command: string; status: string }> = [];
  const sequence: string[] = [];

  let status: McpServerStatus = {
    state: "stopped",
    endpoint: null,
    token: null,
    activeConnections: 0,
    queuedRequests: 0,
    runningRequests: 0,
  };
  let settings: McpSettings | null = null;

  let bridgeDispose: { dispose: () => Promise<void> } | null = null;
  const auditEntries: McpAuditEntry[] = [];
  let grants: McpAuthorizedRootGrant[] = [];
  const requestCommand = new Map<string, string>();

  const runtimeAdapter = {
    execute: (...args: Parameters<ApplicationCommandRuntime<ApplicationCommandRegistry>["execute"]>) => runtime.execute(...args),
  };

  const bridge = createApplicationCommandBridge({
    runtime: runtimeAdapter,
    listen: async (eventName, listener) => {
      listeners.set(eventName, listener as Listener);
      return () => {
        listeners.delete(eventName);
      };
    },
    invoke: async (name, args) => {
      if (name === "complete_application_command") {
        const update = (args as { update?: { kind?: string; requestId?: string; response?: { kind?: string; code?: string } } }).update;
        if (!update?.requestId) return false;
        if (update.kind === "complete") {
          const command = requestCommand.get(update.requestId) ?? "unknown";
          const statusValue = update.response?.kind === "success" ? "succeeded" : (update.response?.code ?? "failed");
          completionUpdates.push({ requestId: update.requestId, command, status: statusValue });
          auditEntries.unshift({
            requestId: update.requestId,
            timestamp: new Date().toISOString(),
            tool: command,
            status: statusValue === "succeeded" ? "succeeded" : "failed",
            durationMs: 1,
            errorCode: statusValue === "succeeded" ? null : statusValue,
          });
          if (auditEntries.length > 50) auditEntries.pop();
        }
      }
      return true;
    },
  });

  const dispatchCommand = async (command: Command, requestId: string): Promise<void> => {
    requestCommand.set(requestId, command.type);
    sequence.push(command.type);
    const listener = listeners.get("application-command-request");
    if (!listener) {
      throw new Error("application command bridge is not registered");
    }
    listener({ payload: { requestId, command } });

      for (let retries = 0; retries < 200; retries += 1) {
      const found = completionUpdates.find((entry) => entry.requestId === requestId);
      if (found) {
        if (found.status !== "succeeded") {
          throw new Error(`${found.command}:${found.status}`);
        }
        return;
      }
        await waitMs(5);
    }
    throw new Error(`timed out waiting for completion ${requestId}`);
  };

  const service: McpManagementServiceLike & {
    runHappyPathScenario: () => Promise<void>;
    runDeniedOverwriteScenario: () => Promise<void>;
    getCorrelations: () => Array<{ requestId: string; command: string; status: string }>;
    getSequence: () => string[];
  } = {
    async startServer() {
      if (status.state === "running") {
        return status;
      }
      runtime = createRuntime();
      completionUpdates.length = 0;
      sequence.length = 0;
      requestCommand.clear();
      bridgeDispose = await bridge.start();
      const port = 47000 + Math.floor(Math.random() * 1000);
      const token = `token-${Math.random().toString(36).slice(2, 10)}`;
      status = {
        state: "running",
        endpoint: `http://127.0.0.1:${port}/mcp`,
        token,
        activeConnections: 1,
        queuedRequests: 0,
        runningRequests: 0,
      };
      return status;
    },
    async stopServer() {
      if (bridgeDispose) {
        await bridgeDispose.dispose();
      }
      bridgeDispose = null;
      status = {
        state: "stopped",
        endpoint: null,
        token: null,
        activeConnections: 0,
        queuedRequests: 0,
        runningRequests: 0,
      };
      grants = [];
      requestCommand.clear();
    },
    async getServerStatus() {
      return status;
    },
    async getSettings() {
      return { settings };
    },
    async saveSettings(nextSettings) {
      settings = nextSettings;
      return { settings };
    },
    async generateToken() {
      return "generated-e2e-token-0123456789abc";
    },
    async listAuditEntries() {
      return [...auditEntries];
    },
    async authorizeOutputRoot(rootPath: string) {
      const rootId = `root-${grants.length + 1}`;
      const grant = { rootId, displayName: rootPath };
      grants = [...grants, grant];
      return grant;
    },
    async revokeOutputRoot(rootId: string) {
      grants = grants.filter((entry) => entry.rootId !== rootId);
    },
    listCommandRequests(): McpCommandRequestSummary[] {
      return listMcpCommandRequestsFromRuntimeSnapshot(runtime.snapshot());
    },
    confirmCommandRequest(requestId: string, allow: boolean) {
      const command = runtime.snapshot().find((entry) => entry.requestId === requestId)?.command ?? "unknown";
      const confirmed = runtime.confirm(requestId, allow);
      if (confirmed && !allow) {
        completionUpdates.push({ requestId, command, status: "user_denied" });
      }
      return confirmed;
    },
    cancelCommandRequest(requestId: string) {
      return runtime.cancel(requestId);
    },
    async runHappyPathScenario() {
      if (status.state !== "running") {
        throw new Error("server must be running before scenario");
      }
      const inspect: Command = {
        type: "project.inspect",
        input: { includeCapabilities: true },
      };
      await dispatchCommand(inspect, "mcp-e2e-001");

      const baseline = [
        "table.create",
        "tableTransform.create",
        "tableTransform.run",
        "tabulate.create",
        "tabulate.run",
        "tabulate.exportTable",
        "graph.create",
        "graph.update",
        "analysis.create",
        "analysis.update",
        "analysis.run",
        "report.create",
        "report.update",
      ] as const;

      let requestCounter = 2;
      for (const key of baseline) {
        const fixtureCase = projectionMap.get(key);
        if (!fixtureCase) {
          throw new Error(`missing fixture ${key}`);
        }
        await dispatchCommand(normalizeCommand(fixtureCase.expectedEnvelope), `mcp-e2e-${String(requestCounter).padStart(3, "0")}`);
        requestCounter += 1;
      }

      for (const analysisCommand of buildAnalysisKindCommands("table-main")) {
        await dispatchCommand(analysisCommand, `mcp-e2e-${String(requestCounter).padStart(3, "0")}`);
        requestCounter += 1;
      }

      const saveCommand: Command = {
        type: "project.save",
        input: {},
      };
      await dispatchCommand(saveCommand, `mcp-e2e-${String(requestCounter).padStart(3, "0")}`);
      requestCounter += 1;

      const exportCase = projectionMap.get("table.exportCsv");
      if (!exportCase) throw new Error("missing fixture table.exportCsv");
      const exportCommand = normalizeCommand(exportCase.expectedEnvelope);
      exportCommand.input = {
        ...exportCommand.input,
        relativePath: "existing.csv",
      } as never;

      const exportRequestId = `mcp-e2e-${String(requestCounter).padStart(3, "0")}`;
      requestCommand.set(exportRequestId, exportCommand.type);
      sequence.push(exportCommand.type);
      const requestListener = listeners.get("application-command-request");
      if (!requestListener) {
        throw new Error("application command bridge is not registered");
      }
      requestListener({ payload: { requestId: exportRequestId, command: exportCommand } });

      for (let retries = 0; retries < 200; retries += 1) {
        const awaiting = runtime.snapshot().find((entry) => entry.requestId === exportRequestId && entry.status === "awaiting-confirmation");
        if (awaiting) break;
        await waitMs(5);
      }

      for (let retries = 0; retries < 400; retries += 1) {
        const completed = completionUpdates.find((entry) => entry.requestId === exportRequestId);
        if (completed) {
          if (completed.status !== "succeeded") {
            throw new Error(`export completion ${completed.status}`);
          }
          break;
        }
        await waitMs(10);
      }

      requestCounter += 1;
      const snapshotCase = projectionMap.get("snapshot.create");
      if (!snapshotCase) throw new Error("missing fixture snapshot.create");
      await dispatchCommand(normalizeCommand(snapshotCase.expectedEnvelope), `mcp-e2e-${String(requestCounter).padStart(3, "0")}`);
    },
    async runDeniedOverwriteScenario() {
      if (status.state !== "running") {
        throw new Error("server must be running before scenario");
      }
      const existingPending = runtime.snapshot().find(
        (entry) => entry.command === "table.exportCsv" && entry.status === "awaiting-confirmation",
      );
      if (existingPending) {
        return;
      }

      const exportCase = projectionMap.get("table.exportCsv");
      if (!exportCase) throw new Error("missing fixture table.exportCsv");
      const exportCommand = normalizeCommand(exportCase.expectedEnvelope);
      exportCommand.input = {
        ...exportCommand.input,
        relativePath: "existing.csv",
      } as never;
      const requestId = "mcp-deny-001";
      requestCommand.set(requestId, exportCommand.type);
      sequence.push(exportCommand.type);
      const listener = listeners.get("application-command-request");
      if (!listener) throw new Error("application command bridge is not registered");
      listener({ payload: { requestId, command: exportCommand } });

      for (let retries = 0; retries < 200; retries += 1) {
        const awaiting = runtime.snapshot().find((entry) => entry.requestId === requestId && entry.status === "awaiting-confirmation");
        if (awaiting) return;
        await waitMs(5);
      }
      return;
    },
    getCorrelations: () => [...completionUpdates],
    getSequence: () => [...sequence],
  };

  return service;
}

export function McpEndToEndHarness() {
  const [subview, setSubview] = useState<"server" | "skills">("server");
  const [statusText, setStatusText] = useState("idle");
  const [errorText, setErrorText] = useState("");
  const [copyLog, setCopyLog] = useState<string[]>([]);
  const [denyInFlight, setDenyInFlight] = useState(false);

  const service = useMemo(() => createHarnessService(), []);
  const store = useMemo(() => createMcpStore({ service }), [service]);

  const correlations = service.getCorrelations();
  const sequence = service.getSequence();

  return (
    <main>
      <div role="menubar" aria-label="AI menu">
        <button type="button" onClick={() => setSubview("server")}>MCP Server...</button>
        <button type="button" onClick={() => setSubview("skills")}>Skills...</button>
      </div>
      <div>
        <button
          type="button"
          onClick={async () => {
            try {
              setErrorText("");
              await store.getState().startServer();
              setStatusText("running");
            } catch (error) {
              setErrorText(String(error));
            }
          }}
        >
          Start MCP
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              setErrorText("");
              setStatusText("running-scenario");
              await service.runHappyPathScenario();
              setStatusText("scenario-complete");
            } catch (error) {
              setErrorText(String(error));
              setStatusText("scenario-failed");
            }
          }}
        >
          Run MCP Scenario
        </button>
        <button
          type="button"
          disabled={denyInFlight}
          onClick={async () => {
            if (denyInFlight) return;
            setDenyInFlight(true);
            try {
              setErrorText("");
              setStatusText("running-deny");
              await service.runDeniedOverwriteScenario();
              setStatusText("deny-complete");
            } catch (error) {
              setErrorText(String(error));
              setStatusText("deny-failed");
            } finally {
              setDenyInFlight(false);
            }
          }}
        >
          Run Deny Scenario
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              setErrorText("");
              await store.getState().stopServer();
              setStatusText("stopped");
            } catch (error) {
              setErrorText(String(error));
            }
          }}
        >
          Stop MCP
        </button>
      </div>

      <AiActivityView
        store={store}
        subview={subview}
        onSelectSubview={setSubview}
        copyText={async (value) => {
          setCopyLog((current) => [...current, value]);
        }}
      />

      <output data-testid="mcp-e2e-status">{statusText}</output>
      <output data-testid="mcp-e2e-error">{errorText}</output>
      <output data-testid="mcp-e2e-sequence">{sequence.join(",")}</output>
      <output data-testid="mcp-e2e-correlations">{JSON.stringify(correlations)}</output>
      <output data-testid="mcp-e2e-copy-log">{copyLog.join("\n")}</output>
    </main>
  );
}

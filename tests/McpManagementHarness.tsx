import { useState } from "react";

import { AiActivityView } from "../src/components/ai/AiActivityView";
import { createMcpStore, type McpManagementServiceLike } from "../src/stores/useMcpStore";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
  McpSettings,
} from "../src/types/mcp";

type HarnessScenario = "stopped" | "starting" | "running" | "stopping";

const SAVED_TOKEN = "saved-token-abcdefghijklmnopqrstuvwxyz";
const GENERATED_TOKEN = "generated-token-abcdefghijklmnopqrstuvwxyz";

function makeStatus(scenario: HarnessScenario): McpServerStatus {
  if (scenario === "running") {
    return {
      state: "running",
      endpoint: "http://127.0.0.1:48123/mcp",
      token: "secret-token-123",
      activeConnections: 2,
      queuedRequests: 1,
      runningRequests: 1,
    };
  }
  return {
    state: scenario,
    endpoint: null,
    token: null,
    activeConnections: 0,
    queuedRequests: 0,
    runningRequests: 0,
  };
}

function makeAuditEntries(): McpAuditEntry[] {
  return Array.from({ length: 12 }, (_, index) => ({
    requestId: `mcp-${index + 1}`,
    timestamp: `2026-09-16T00:00:${String(index).padStart(2, "0")}.000Z`,
    tool: `statsplayground.tool.${index + 1}`,
    status: index % 2 === 0 ? "succeeded" : "failed",
    durationMs: 25 + index,
    errorCode: index % 2 === 0 ? null : "execution_failed",
  }));
}

function makeRequests(): McpCommandRequestSummary[] {
  return [
    {
      requestId: "cmd-queued",
      command: "table.exportCsv",
      status: "queued",
      stage: "queue",
      message: "Queued for export",
      percent: 0,
    },
    {
      requestId: "cmd-running",
      command: "snapshot.create",
      status: "running",
      stage: "running",
      message: "Exporting rows",
      percent: 64,
    },
    {
      requestId: "cmd-confirm",
      command: "table.exportCsv",
      status: "awaiting-confirmation",
      stage: "confirmation",
      message: "Confirm overwrite",
      percent: null,
    },
    {
      requestId: "cmd-commit",
      command: "snapshot.create",
      status: "committing",
      stage: "commit",
      message: "Committing snapshot",
      percent: null,
    },
  ];
}

function createHarnessService(
  scenario: HarnessScenario,
  captureSave: (settings: McpSettings) => void,
): McpManagementServiceLike {
  let status = makeStatus(scenario);
  let auditEntries = makeAuditEntries();
  let requests = makeRequests();
  let grants: McpAuthorizedRootGrant[] = [{ rootId: "root-1", displayName: "/Users/ashton/Exports" }];
  let settings: McpSettings = { port: 48123, token: SAVED_TOKEN };

  return {
    startServer: async () => {
      status = makeStatus("running");
      return status;
    },
    stopServer: async () => {
      status = makeStatus("stopped");
      auditEntries = [];
      requests = [];
    },
    getServerStatus: async () => status,
    getSettings: async () => ({ settings }),
    saveSettings: async (nextSettings: McpSettings) => {
      settings = nextSettings;
      captureSave(nextSettings);
      return { settings };
    },
    generateToken: async () => GENERATED_TOKEN,
    listAuditEntries: async () => auditEntries,
    authorizeOutputRoot: async (rootPath: string) => {
      const grant = { rootId: `root-${grants.length + 1}`, displayName: rootPath };
      grants = [...grants, grant];
      return grant;
    },
    revokeOutputRoot: async (rootId: string) => {
      grants = grants.filter((grant) => grant.rootId !== rootId);
    },
    listCommandRequests: () => requests,
    confirmCommandRequest: (requestId: string, allow: boolean) => {
      if (!requests.some((request) => request.requestId === requestId)) {
        return false;
      }
      if (allow || !allow) {
        requests = requests.filter((request) => request.requestId !== requestId);
      }
      return true;
    },
    cancelCommandRequest: (requestId: string) => {
      const found = requests.some((request) => request.requestId === requestId);
      requests = requests.filter((request) => request.requestId !== requestId);
      return found;
    },
  };
}

export function McpManagementHarness({
  scenario = "running",
  initialSubview = "server",
  constrainedHeight,
}: {
  scenario?: HarnessScenario;
  initialSubview?: "server" | "skills";
  constrainedHeight?: number;
}) {
  const [subview, setSubview] = useState<"server" | "skills">(initialSubview);
  const [copied, setCopied] = useState<string[]>([]);
  const [lastSave, setLastSave] = useState<McpSettings | null>(null);
  const [store] = useState(() => {
    const created = createMcpStore({ service: createHarnessService(scenario, setLastSave) });
    created.setState({
      status: makeStatus(scenario),
      settings: { port: 48123, token: SAVED_TOKEN },
      settingsPort: "48123",
      settingsToken: SAVED_TOKEN,
      auditEntries: makeAuditEntries(),
      commandRequests: [
        ...makeRequests(),
        {
          requestId: "ui-only-confirm",
          command: "table.exportCsv",
          status: "awaiting-confirmation",
          stage: "confirmation",
          message: "UI request should be hidden",
          percent: null,
        },
      ],
      pendingConfirmations: [
        {
          requestId: "ui-only-confirm",
          command: "table.exportCsv",
          status: "awaiting-confirmation",
          stage: "confirmation",
          message: "UI request should be hidden",
          percent: null,
        },
        ...makeRequests().filter((request) => request.status === "awaiting-confirmation"),
      ],
      authorizedRoots: [{ rootId: "root-1", displayName: "/Users/ashton/Exports" }],
    });
    return created;
  });

  return (
    <main
      className="mcp-harness-shell"
      style={constrainedHeight === undefined ? undefined : {
        display: "flex",
        flexDirection: "column",
        height: constrainedHeight,
      }}
    >
      <div className="mcp-harness-menu" role="menubar" aria-label="AI menu">
        <button type="button" onClick={() => setSubview("server")}>MCP Server...</button>
        <button type="button" onClick={() => setSubview("skills")}>Skills...</button>
      </div>
      <div
        className="mcp-harness-body"
        style={constrainedHeight === undefined ? undefined : {
          display: "flex",
          flex: "1 1 auto",
          minHeight: 0,
        }}
      >
        <aside className="mcp-harness-activity" aria-label="AI activity">
          <button
            type="button"
            aria-label="AI"
            title="AI"
            onClick={() => setSubview("server")}
          >
            AI
          </button>
          <button type="button" onClick={() => setSubview("server")}>MCP Server</button>
          <button type="button" onClick={() => setSubview("skills")}>Skills</button>
        </aside>
        <AiActivityView
          store={store}
          subview={subview}
          onSelectSubview={setSubview}
          copyText={async (value) => {
            setCopied((current) => [...current, value]);
          }}
        />
      </div>
      <output data-testid="copy-log">{copied.join("\n---\n")}</output>
      <output
        data-testid="save-log"
        data-last-save={lastSave === null ? "" : JSON.stringify(lastSave)}
      />
    </main>
  );
}
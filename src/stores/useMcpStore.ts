import { create } from "zustand";

import { mcpManagementService } from "@/services/mcpManagementService";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
  McpSettings,
  McpSettingsState,
} from "@/types/mcp";

export type McpManagementServiceLike = Pick<
  typeof mcpManagementService,
  | "startServer"
  | "stopServer"
  | "getServerStatus"
  | "getSettings"
  | "saveSettings"
  | "generateToken"
  | "listAuditEntries"
  | "authorizeOutputRoot"
  | "revokeOutputRoot"
  | "listCommandRequests"
  | "confirmCommandRequest"
  | "cancelCommandRequest"
>;

type IntervalHandle = ReturnType<typeof setInterval>;

interface McpStoreDependencies {
  service: McpManagementServiceLike;
  setInterval: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
  refreshIntervalMs: number;
}

export interface McpStore {
  viewVisible: boolean;
  status: McpServerStatus;
  auditEntries: McpAuditEntry[];
  authorizedRoots: McpAuthorizedRootGrant[];
  commandRequests: McpCommandRequestSummary[];
  pendingConfirmations: McpCommandRequestSummary[];
  settings: McpSettings | null;
  settingsPort: string;
  settingsToken: string;
  settingsTokenVisible: boolean;
  settingsBusy: boolean;
  settingsDirty: boolean;
  refreshing: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  setViewVisible: (visible: boolean) => void;
  setSettingsPort: (port: string) => void;
  setSettingsToken: (token: string) => void;
  toggleSettingsTokenVisible: () => void;
  generateSettingsToken: () => Promise<void>;
  saveSettings: () => Promise<void>;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  authorizeRoot: (rootPath: string) => Promise<void>;
  revokeRoot: (rootId: string) => Promise<void>;
  allowRequest: (requestId: string) => Promise<boolean>;
  denyRequest: (requestId: string) => Promise<boolean>;
}

const STOPPED_STATUS: McpServerStatus = {
  state: "stopped",
  endpoint: null,
  token: null,
  activeConnections: 0,
  queuedRequests: 0,
  runningRequests: 0,
};

function pendingConfirmations(requests: McpCommandRequestSummary[]) {
  return requests.filter((request) => request.status === "awaiting-confirmation");
}

function removeRequest(
  requests: McpCommandRequestSummary[],
  requestId: string,
) {
  return requests.filter((request) => request.requestId !== requestId);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingsEditorFields(state: McpSettingsState) {
  return {
    settingsPort: state.settings === null ? "" : String(state.settings.port),
    settingsToken: state.settings?.token ?? "",
  };
}

function savedSettingsState(state: McpSettingsState) {
  return {
    settings: state.settings,
    ...settingsEditorFields(state),
    settingsDirty: false,
  };
}

function validateSettings(portInput: string, token: string): McpSettings {
  if (!/^\d+$/.test(portInput)) {
    throw new Error("MCP port must contain only decimal digits");
  }
  const port = Number(portInput);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP port must be between 1 and 65535");
  }
  if (token.length < 32 || token.length > 256) {
    throw new Error("MCP token must be between 32 and 256 bytes");
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("MCP token must contain only visible ASCII characters");
  }
  return { port, token };
}

function requireStopped(status: McpServerStatus) {
  if (status.state !== "stopped") {
    throw new Error("MCP settings can only be changed while the server is stopped");
  }
}

function createStoppedTransientState() {
  return {
    status: STOPPED_STATUS,
    auditEntries: [] as McpAuditEntry[],
    authorizedRoots: [] as McpAuthorizedRootGrant[],
    commandRequests: [] as McpCommandRequestSummary[],
    pendingConfirmations: [] as McpCommandRequestSummary[],
  };
}

export function createMcpStore(input: Partial<McpStoreDependencies> = {}) {
  const service = input.service ?? mcpManagementService;
  const setIntervalImpl = input.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalImpl = input.clearInterval ?? ((handle) => clearInterval(handle));
  const refreshIntervalMs = input.refreshIntervalMs ?? 2000;
  let pollHandle: IntervalHandle | null = null;

  const startPolling = (refresh: () => Promise<void>) => {
    if (pollHandle !== null) {
      clearIntervalImpl(pollHandle);
    }
    pollHandle = setIntervalImpl(() => {
      void refresh().catch(() => undefined);
    }, refreshIntervalMs);
  };

  const stopPolling = () => {
    if (pollHandle !== null) {
      clearIntervalImpl(pollHandle);
      pollHandle = null;
    }
  };

  return create<McpStore>((set, get) => ({
    viewVisible: false,
    status: STOPPED_STATUS,
    auditEntries: [],
    authorizedRoots: [],
    commandRequests: [],
    pendingConfirmations: [],
    settings: null,
    settingsPort: "",
    settingsToken: "",
    settingsTokenVisible: false,
    settingsBusy: false,
    settingsDirty: false,
    refreshing: false,
    lastError: null,

    refresh: async () => {
      const preserveSettingsEditor = get().settingsDirty || get().settingsBusy;
      set({ refreshing: true });
      try {
        const [status, auditEntries, commandRequests, settingsState] = await Promise.all([
          service.getServerStatus(),
          service.listAuditEntries(),
          Promise.resolve(service.listCommandRequests()),
          service.getSettings(),
        ]);
        if (status.state === "stopped") {
          set((state) => ({
            ...createStoppedTransientState(),
            settings: settingsState.settings,
            ...(
              preserveSettingsEditor || state.settingsDirty || state.settingsBusy
                ? {}
                : settingsEditorFields(settingsState)
            ),
            refreshing: false,
            lastError: null,
          }));
          return;
        }
        set((state) => ({
          status,
          auditEntries,
          commandRequests,
          pendingConfirmations: pendingConfirmations(commandRequests),
          settings: settingsState.settings,
          ...(
            preserveSettingsEditor || state.settingsDirty || state.settingsBusy
              ? {}
              : settingsEditorFields(settingsState)
          ),
          refreshing: false,
          lastError: null,
        }));
      } catch (error) {
        set({ refreshing: false, lastError: messageFromError(error) });
        throw error;
      }
    },

    setViewVisible: (visible) => {
      set({ viewVisible: visible });
      if (!visible) {
        stopPolling();
        return;
      }
      void get().refresh().catch(() => undefined);
      startPolling(get().refresh);
    },

    setSettingsPort: (settingsPort) => {
      set({ settingsPort, settingsDirty: true });
    },

    setSettingsToken: (settingsToken) => {
      set({ settingsToken, settingsDirty: true });
    },

    toggleSettingsTokenVisible: () => {
      set((state) => ({ settingsTokenVisible: !state.settingsTokenVisible }));
    },

    generateSettingsToken: async () => {
      try {
        requireStopped(get().status);
        set({ settingsBusy: true, lastError: null });
        const settingsToken = await service.generateToken();
        set({
          settingsToken,
          settingsBusy: false,
          settingsDirty: true,
          lastError: null,
        });
      } catch (error) {
        set({ settingsBusy: false, lastError: messageFromError(error) });
        throw error;
      }
    },

    saveSettings: async () => {
      try {
        requireStopped(get().status);
        const settings = validateSettings(
          get().settingsPort,
          get().settingsToken,
        );
        set({ settingsBusy: true, lastError: null });
        const saved = await service.saveSettings(settings);
        set({
          ...savedSettingsState(saved),
          settingsBusy: false,
          lastError: null,
        });
      } catch (error) {
        set({ settingsBusy: false, lastError: messageFromError(error) });
        throw error;
      }
    },

    startServer: async () => {
      set({
        status: { ...STOPPED_STATUS, state: "starting" },
        lastError: null,
      });
      try {
        const status = await service.startServer();
        const auditEntries = await service.listAuditEntries();
        const commandRequests = service.listCommandRequests();
        set({
          status,
          auditEntries,
          commandRequests,
          pendingConfirmations: pendingConfirmations(commandRequests),
          lastError: null,
        });
      } catch (error) {
        set({ status: STOPPED_STATUS, lastError: messageFromError(error) });
        throw error;
      }
    },

    stopServer: async () => {
      set((state) => ({
        status: {
          ...state.status,
          state: "stopping",
        },
        lastError: null,
      }));
      try {
        await service.stopServer();
        set(() => ({
          ...createStoppedTransientState(),
          lastError: null,
        }));
      } catch (error) {
        set({ lastError: messageFromError(error) });
        throw error;
      }
    },

    authorizeRoot: async (rootPath) => {
      const grant = await service.authorizeOutputRoot(rootPath);
      set((state) => ({
        authorizedRoots: [...state.authorizedRoots, grant],
        lastError: null,
      }));
    },

    revokeRoot: async (rootId) => {
      await service.revokeOutputRoot(rootId);
      set((state) => ({
        authorizedRoots: state.authorizedRoots.filter((grant) => grant.rootId !== rootId),
        lastError: null,
      }));
    },

    allowRequest: async (requestId) => {
      const confirmed = service.confirmCommandRequest(requestId, true);
      if (confirmed) {
        set((state) => {
          const nextRequests = removeRequest(state.commandRequests, requestId);
          return {
            commandRequests: nextRequests,
            pendingConfirmations: pendingConfirmations(nextRequests),
          };
        });
      }
      return confirmed;
    },

    denyRequest: async (requestId) => {
      const confirmed = service.confirmCommandRequest(requestId, false);
      if (confirmed) {
        set((state) => {
          const nextRequests = removeRequest(state.commandRequests, requestId);
          return {
            commandRequests: nextRequests,
            pendingConfirmations: pendingConfirmations(nextRequests),
          };
        });
      }
      return confirmed;
    },
  }));
}

export const useMcpStore = createMcpStore();
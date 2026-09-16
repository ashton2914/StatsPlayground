import { create } from "zustand";

import { mcpManagementService } from "@/services/mcpManagementService";
import type {
  McpAuditEntry,
  McpAuthorizedRootGrant,
  McpCommandRequestSummary,
  McpServerStatus,
} from "@/types/mcp";

export type McpManagementServiceLike = Pick<
  typeof mcpManagementService,
  | "startServer"
  | "stopServer"
  | "getServerStatus"
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
  refreshing: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  setViewVisible: (visible: boolean) => void;
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

function createStoppedTransientState(status: McpServerStatus = STOPPED_STATUS) {
  return {
    status,
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
    refreshing: false,
    lastError: null,

    refresh: async () => {
      set({ refreshing: true });
      try {
        const [status, auditEntries, commandRequests] = await Promise.all([
          service.getServerStatus(),
          service.listAuditEntries(),
          Promise.resolve(service.listCommandRequests()),
        ]);
        if (status.state === "stopped") {
          set({
            ...createStoppedTransientState(status),
            refreshing: false,
            lastError: null,
          });
          return;
        }
        set({
          status,
          auditEntries,
          commandRequests,
          pendingConfirmations: pendingConfirmations(commandRequests),
          refreshing: false,
          lastError: null,
        });
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
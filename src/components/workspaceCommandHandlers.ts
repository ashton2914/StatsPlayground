import type { ApplicationCommandRuntime } from "@/applicationCommands/runtime";
import type { ApplicationCommandRegistry } from "@/applicationCommands/types";
import type { TableExportPlan } from "@/components/tableExport";

type Translate = (key: string, options?: { defaultValue?: string; [key: string]: unknown }) => string;

type CommandRequest = {
  requestId: string;
  command: string;
  status: string;
};

interface SnapshotProgressEvent {
  payload: {
    datasetIndex: number;
    datasetTotal: number;
    datasetName: string;
  };
}

export interface WorkspaceCommandHandlerDependencies {
  t: Translate;
  getProjectFilePath: () => string | null | undefined;
  getProjectRevision: () => number;
  isSaving: () => boolean;
  isReadOnly: () => boolean;
  executeCommand: ApplicationCommandRuntime<ApplicationCommandRegistry>["execute"];
  requestSaveProjectPath?: () => Promise<string | null>;
  showToast?: (message: string, durationMs: number) => void;
  setBusyMessage?: (message: string | null) => void;
  listen?: (
    eventName: string,
    handler: (event: SnapshotProgressEvent) => void,
  ) => Promise<() => void>;
  authorizeCsvExportRoot?: (rootPath: string) => Promise<{ rootId: string; displayName: string }>;
  revokeCsvExportRoot?: (rootId: string) => Promise<void>;
  listCommandRequests?: () => CommandRequest[];
  confirmCommandRequest?: (requestId: string, allow: boolean) => boolean;
  confirmOverwrite?: () => boolean;
  waitForAnimationFrame?: () => Promise<void>;
  waitForCommandConfirmation?: (requestId: string, commandPromise: Promise<unknown>) => Promise<string | null>;
}

function splitOutputPath(outputPath: string): { rootPath: string; relativePath: string } {
  const separatorIndex = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
  return {
    rootPath: separatorIndex >= 0 ? outputPath.slice(0, separatorIndex) : ".",
    relativePath: separatorIndex >= 0 ? outputPath.slice(separatorIndex + 1) : outputPath,
  };
}

export async function waitForWorkspaceCommandConfirmation(
  requestId: string,
  commandPromise: Promise<unknown>,
  input: {
    listCommandRequests: () => CommandRequest[];
    waitForAnimationFrame: () => Promise<void>;
  },
): Promise<string | null> {
  let settled = false;
  commandPromise.finally(() => {
    settled = true;
  }).catch(() => undefined);

  while (!settled) {
    const pendingRequest = input.listCommandRequests()
      .find((request) => request.requestId === requestId && request.status === "awaiting-confirmation");
    if (pendingRequest) {
      return pendingRequest.requestId;
    }
    await input.waitForAnimationFrame();
  }

  return null;
}

export function createWorkspaceCommandHandlers(input: WorkspaceCommandHandlerDependencies) {
  const showToast = input.showToast ?? (() => undefined);
  const setBusyMessage = input.setBusyMessage ?? (() => undefined);
  const listen = input.listen ?? (async () => () => undefined);
  const authorizeCsvExportRoot = input.authorizeCsvExportRoot ?? (async () => {
    throw new Error("authorizeCsvExportRoot dependency is required");
  });
  const revokeCsvExportRoot = input.revokeCsvExportRoot ?? (async () => undefined);
  const listCommandRequests = input.listCommandRequests ?? (() => []);
  const confirmCommandRequest = input.confirmCommandRequest ?? (() => false);
  const confirmOverwrite = input.confirmOverwrite ?? (() => false);
  const waitForAnimationFrame = input.waitForAnimationFrame ?? (() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  }));
  const waitForCommandConfirmation = input.waitForCommandConfirmation
    ?? ((requestId: string, commandPromise: Promise<unknown>) => waitForWorkspaceCommandConfirmation(requestId, commandPromise, {
      listCommandRequests,
      waitForAnimationFrame,
    }));

  return {
    async saveProject(): Promise<void> {
      if (input.isSaving()) return;

      let filePath = input.getProjectFilePath() ?? undefined;
      if (!filePath) {
        filePath = await input.requestSaveProjectPath?.() ?? undefined;
        if (!filePath) {
          return;
        }
      }

      await input.executeCommand(
        {
          type: "project.save",
          input: { filePath },
          control: { expectedProjectRevision: input.getProjectRevision() },
        },
        { kind: "ui" },
      );
      showToast(input.t("common.saved", { defaultValue: "Saved" }), 1500);
    },

    async createSnapshot(): Promise<void> {
      if (input.isReadOnly()) return;

      setBusyMessage(input.t("workspace.creatingSnapshot", { defaultValue: "Creating snapshot" }));
      const unlisten = await listen("snapshot-progress", (event) => {
        const { datasetIndex, datasetTotal, datasetName } = event.payload;
        if (datasetTotal > 0 && datasetIndex < datasetTotal) {
          setBusyMessage(`${input.t("workspace.creatingSnapshot", { defaultValue: "Creating snapshot" })} ${input.t("workspace.importProgressTable", { i: datasetIndex + 1, total: datasetTotal, name: datasetName })}`);
        }
      });

      try {
        await input.executeCommand(
          {
            type: "snapshot.create",
            input: {},
          },
          { kind: "ui" },
        );
      } finally {
        unlisten();
        setBusyMessage(null);
      }
    },

    async exportCsv(plan: TableExportPlan, outputPath: string): Promise<boolean> {
      if (plan.format !== "csv" || plan.mode !== "single-file") {
        throw new Error("exportCsv only supports single-file CSV plans");
      }
      if (!outputPath) {
        return false;
      }

      const { rootPath, relativePath } = splitOutputPath(outputPath);
      const authorization = await authorizeCsvExportRoot(rootPath);

      try {
        const exportCommand = input.executeCommand(
          {
            type: "table.exportCsv",
            input: {
              datasetId: plan.datasetIds[0]!,
              rootId: authorization.rootId,
              relativePath,
            },
          },
          { kind: "ui" },
        );
        const requestId = await waitForCommandConfirmation(exportCommand.requestId, exportCommand);
        if (requestId) {
          confirmCommandRequest(requestId, confirmOverwrite());
        }
        await exportCommand;
        return true;
      } finally {
        await revokeCsvExportRoot(authorization.rootId);
      }
    },
  };
}
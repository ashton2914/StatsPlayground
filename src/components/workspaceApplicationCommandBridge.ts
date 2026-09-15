import { startApplicationCommandBridge, type ApplicationCommandBridgeDisposer } from "@/services/applicationCommandBridge";

export interface WorkspaceApplicationCommandBridgeMount {
  ready: Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkspaceApplicationCommandBridgeStartupError {
  code: "application_command_bridge_start_failed";
  message: string;
  cause: string;
}

export function mountApplicationCommandBridge(input: {
  start?: () => Promise<ApplicationCommandBridgeDisposer>;
  onStartupError?: (error: WorkspaceApplicationCommandBridgeStartupError) => void;
} = {}): WorkspaceApplicationCommandBridgeMount {
  const start = input.start ?? startApplicationCommandBridge;
  const onStartupError = input.onStartupError ?? ((error) => console.error(error));
  let mounted = true;
  let disposed = false;
  let disposer: ApplicationCommandBridgeDisposer | null = null;

  const ready = start().then((bridge) => {
    if (!mounted) {
      void bridge.dispose();
      return;
    }
    disposer = bridge;
  }).catch((error: unknown) => {
    if (!mounted) return;
    onStartupError({
      code: "application_command_bridge_start_failed",
      message: "Application command bridge failed to start",
      cause: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    ready,
    async dispose() {
      if (disposed) return;
      disposed = true;
      mounted = false;
      await disposer?.dispose();
      disposer = null;
    },
  };
}
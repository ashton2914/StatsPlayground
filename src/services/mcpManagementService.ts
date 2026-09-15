import { applicationRuntime } from "@/applicationCommands/applicationRuntime";

export const mcpManagementService = {
  listCommandRequests: () => applicationRuntime.snapshot(),
  confirmCommandRequest: (requestId: string, allow: boolean) =>
    applicationRuntime.confirm(requestId, allow),
  cancelCommandRequest: (requestId: string) =>
    applicationRuntime.cancel(requestId),
};

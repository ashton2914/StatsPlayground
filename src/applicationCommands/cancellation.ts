import { CommandExecutionError } from "@/applicationCommands/runtime";

export function throwIfCommandCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CommandExecutionError("cancelled", "Command cancelled");
  }
}
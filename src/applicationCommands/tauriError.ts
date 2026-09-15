import { CommandExecutionError } from "@/applicationCommands/runtime";
import type { CommandErrorCode } from "@/applicationCommands/types";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function stripPrefix(message: string, prefix: string): string {
  if (!message.startsWith(prefix)) return message;
  return message.slice(prefix.length).trim() || message;
}

export function mapTauriAppError(error: unknown): CommandExecutionError {
  if (error instanceof CommandExecutionError) return error;

  const message = toErrorMessage(error);
  const mappings: Array<{ prefix: string; code: CommandErrorCode }> = [
    { prefix: "Invalid parameter:", code: "invalid_input" },
    { prefix: "Read-only:", code: "read_only" },
    { prefix: "Cancelled:", code: "cancelled" },
    { prefix: "Database error:", code: "execution_failed" },
    { prefix: "File I/O error:", code: "execution_failed" },
    { prefix: "Stats error:", code: "execution_failed" },
    { prefix: "Busy:", code: "execution_failed" },
  ];

  for (const mapping of mappings) {
    if (message.startsWith(mapping.prefix)) {
      return new CommandExecutionError(mapping.code, stripPrefix(message, mapping.prefix));
    }
  }

  return new CommandExecutionError("execution_failed", message);
}

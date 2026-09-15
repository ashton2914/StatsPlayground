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

const SAFE_EXECUTION_FAILURE = "Command service failed";
const SAFE_CANCELLED = "Command cancelled";
const SAFE_READ_ONLY = "Project is read-only";
const SAFE_INVALID_INPUT = "Invalid parameter";

function containsPathLikeContent(value: string): boolean {
  return /(?:^|[\s"'`])(\/[^\s"'`]+|[a-zA-Z]:\\[^\s"'`]+|\\\\[^\s"'`]+\\[^\s"'`]+)/.test(value);
}

function safeInvalidInputMessage(detail: string): string {
  if (!detail || containsPathLikeContent(detail)) {
    return SAFE_INVALID_INPUT;
  }
  return detail;
}

export function mapTauriAppError(error: unknown): CommandExecutionError {
  if (error instanceof CommandExecutionError) return error;

  const message = toErrorMessage(error);
  if (message.startsWith("Invalid parameter:")) {
    return new CommandExecutionError("invalid_input", safeInvalidInputMessage(stripPrefix(message, "Invalid parameter:")));
  }
  if (message.startsWith("Read-only:")) {
    return new CommandExecutionError("read_only", SAFE_READ_ONLY);
  }
  if (message.startsWith("Cancelled:")) {
    return new CommandExecutionError("cancelled", SAFE_CANCELLED);
  }

  const executionPrefixes: string[] = [
    "Database error:",
    "File I/O error:",
    "Stats error:",
    "Busy:",
  ];
  for (const prefix of executionPrefixes) {
    if (message.startsWith(prefix)) {
      return new CommandExecutionError("execution_failed", SAFE_EXECUTION_FAILURE);
    }
  }

  const _unknownCode: CommandErrorCode = "execution_failed";
  return new CommandExecutionError(_unknownCode, SAFE_EXECUTION_FAILURE);
}

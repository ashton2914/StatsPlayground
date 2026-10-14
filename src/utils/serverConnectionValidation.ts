import type { ConnectionCredentials, ConnectionDefinition } from "../types/dataLink";

export type ServerConnectionField = "host" | "port" | "database" | "username" | "password" | "connectTimeoutSeconds";
type ValidationCode = "required" | "portRange" | "timeoutRange";

export function validateServerConnection(
  definition: ConnectionDefinition,
  credentials: ConnectionCredentials,
): Partial<Record<ServerConnectionField, ValidationCode>> {
  const errors: Partial<Record<ServerConnectionField, ValidationCode>> = {};
  if (!definition.host.trim()) errors.host = "required";
  if (!definition.database.trim()) errors.database = "required";
  if (!credentials.username.trim()) errors.username = "required";
  if (!credentials.password) errors.password = "required";
  if (!Number.isInteger(definition.port) || definition.port < 1 || definition.port > 65535) errors.port = "portRange";
  if (!Number.isInteger(definition.connectTimeoutSeconds) || definition.connectTimeoutSeconds < 1 || definition.connectTimeoutSeconds > 300) {
    errors.connectTimeoutSeconds = "timeoutRange";
  }
  return errors;
}

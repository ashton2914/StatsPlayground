import type { ConnectionDefinition } from "../types/dataLink";

export function createServerConnectionDefinition(
  connector: "postgresql" | "mysql",
  localTest: boolean,
): ConnectionDefinition {
  return {
    connector,
    host: "localhost",
    port: connector === "mysql" ? 53307 : 16434,
    database: "statsplayground_test",
    authenticationType: "usernamePassword",
    tlsMode: localTest ? "required" : "verifyFull",
    connectTimeoutSeconds: 10,
  };
}

export function updateServerConnectionDefinition<K extends keyof ConnectionDefinition>(
  current: ConnectionDefinition,
  key: K,
  value: ConnectionDefinition[K],
): ConnectionDefinition {
  const next = { ...current, [key]: value };
  if (["host", "port", "database", "connector"].includes(key) && current[key] !== value) {
    next.tlsMode = "verifyFull";
    next.tlsRootCertificatePem = undefined;
  }
  return next;
}

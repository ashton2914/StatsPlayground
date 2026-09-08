import assert from "node:assert/strict";
import { createServerConnectionDefinition, updateServerConnectionDefinition } from "../src/utils/serverConnectionDefaults.ts";

for (const connector of ["mysql", "postgresql"] as const) {
  const definition = createServerConnectionDefinition(connector, true);
  assert.equal(definition.host, "localhost");
  assert.equal(definition.port, connector === "mysql" ? 53307 : 16434);
  assert.equal(definition.tlsMode, "required");
  assert.equal(definition.tlsRootCertificatePem, undefined);
  assert.equal(createServerConnectionDefinition(connector, false).tlsMode, "verifyFull");
  assert.equal(updateServerConnectionDefinition(definition, "connectTimeoutSeconds", 20).tlsMode, "required");
  assert.equal(updateServerConnectionDefinition(definition, "host", "localhost").tlsMode, "required");
  for (const changed of [
    updateServerConnectionDefinition(definition, "host", "db.example.com"),
    updateServerConnectionDefinition(definition, "port", 5432),
    updateServerConnectionDefinition(definition, "database", "business"),
  ]) assert.equal(changed.tlsMode, "verifyFull");
  const remote = updateServerConnectionDefinition({ ...definition, tlsRootCertificatePem: "test CA" }, "host", "db.example.com");
  assert.equal(remote.tlsRootCertificatePem, undefined);
  assert.equal(updateServerConnectionDefinition(remote, "host", "localhost").tlsMode, "verifyFull");
  assert.equal(updateServerConnectionDefinition(definition, "tlsMode", "verifyCa").tlsMode, "verifyCa");
}
console.log("server connection defaults regression passed");

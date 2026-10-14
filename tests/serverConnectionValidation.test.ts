import assert from "node:assert/strict";
import { createServerConnectionDefinition } from "../src/utils/serverConnectionDefaults.ts";
import { validateServerConnection } from "../src/utils/serverConnectionValidation.ts";

for (const connector of ["postgresql", "mysql"] as const) {
  const definition = createServerConnectionDefinition(connector, false);
  const credentials = { username: "reader", password: "test-only" };
  assert.deepEqual(validateServerConnection(definition, credentials), {});
  for (const value of ["", " \t\n"]) {
    assert.deepEqual(validateServerConnection({ ...definition, host: value }, credentials), { host: "required" });
    assert.deepEqual(validateServerConnection({ ...definition, database: value }, credentials), { database: "required" });
    assert.deepEqual(validateServerConnection(definition, { ...credentials, username: value }), { username: "required" });
  }
  assert.deepEqual(validateServerConnection(definition, { ...credentials, password: "" }), { password: "required" });
  assert.deepEqual(validateServerConnection(definition, { ...credentials, password: " " }), {}, "password whitespace is significant");
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity]) {
    assert.deepEqual(validateServerConnection({ ...definition, port }, credentials), { port: "portRange" });
  }
  for (const port of [1, 65535]) {
    assert.deepEqual(validateServerConnection({ ...definition, port }, credentials), {});
  }
  for (const connectTimeoutSeconds of [0, -1, 301, 1.5, NaN, Infinity]) {
    assert.deepEqual(validateServerConnection({ ...definition, connectTimeoutSeconds }, credentials), { connectTimeoutSeconds: "timeoutRange" });
  }
  for (const connectTimeoutSeconds of [1, 300]) {
    assert.deepEqual(validateServerConnection({ ...definition, connectTimeoutSeconds }, credentials), {});
  }
  assert.deepEqual(validateServerConnection({ ...definition, host: "", database: "", port: 0, connectTimeoutSeconds: 0 }, { username: "", password: "" }), {
    host: "required", database: "required", username: "required", password: "required", port: "portRange", connectTimeoutSeconds: "timeoutRange",
  });
}
console.log("server connection validation regressions passed");

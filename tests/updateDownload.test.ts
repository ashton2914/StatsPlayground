import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateUpdateUrl } from "../src/services/updateDownload.ts";

const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
const openerPermission = capability.permissions.find(
  (permission: unknown) => typeof permission === "object" && permission !== null
    && "identifier" in permission && permission.identifier === "opener:allow-open-url",
);

assert.deepEqual(openerPermission?.allow, [
  { url: "https://github.com/ashton2914/StatsPlayground/releases/tag/*" },
  { url: "https://github.com/ashton2914/StatsPlayground/releases/download/*/*" },
]);

assert.equal(
  validateUpdateUrl("https://github.com/ashton2914/StatsPlayground/releases/download/v0.2.0/StatsPlayground-0.2.0-windows-x64.zip"),
  "https://github.com/ashton2914/StatsPlayground/releases/download/v0.2.0/StatsPlayground-0.2.0-windows-x64.zip",
);
assert.equal(
  validateUpdateUrl("https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0"),
  "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
);

for (const unsafeUrl of [
  "http://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
  "https://example.test/download.zip",
  "https://github.com/ashton2914/OtherProject/releases/tag/v0.2.0",
  "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0/extra",
  "https://github.com/ashton2914/StatsPlayground/releases/download/v0.2.0",
  "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0?source=test",
  "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0#details",
  "https://user:pass@github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
  "https://github.com:444/ashton2914/StatsPlayground/releases/tag/v0.2.0",
]) {
  assert.throws(() => validateUpdateUrl(unsafeUrl), /Untrusted update URL/);
}

console.log("update download URL tests passed");
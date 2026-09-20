import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/stores/useHistoryStore.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

assert.equal(
  source.includes("dropTableChangeSet(changeSetId).catch(() => undefined)"),
  false,
  "discarded change-set cleanup failures must not be silently swallowed",
);
assert.match(
  source,
  /dropTableChangeSet\(changeSetId\)\.catch\(\(error\)\s*=>\s*\{[\s\S]*?historyError:\s*String\(error\)/,
  "discarded change-set cleanup failures must update historyError without blocking mutation",
);

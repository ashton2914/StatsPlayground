import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const seeds = JSON.parse(readFileSync(
  new URL("./fixtures/distribution/seeds.json", import.meta.url),
  "utf8",
)) as Array<{
  seedId: string;
  seed: number;
  caseId: string;
  inputHash: string;
  expectedHash: string;
  status: string;
}>;

const runSyntheticCase = (seed: number, caseId: string) =>
  createHash("sha256").update(JSON.stringify({ seed, caseId })).digest("hex");

for (const entry of seeds) {
  assert.match(entry.seedId, /^seed\./);
  assert.match(entry.inputHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(runSyntheticCase(entry.seed, entry.caseId), runSyntheticCase(entry.seed, entry.caseId));
  assert.equal(`sha256:${runSyntheticCase(entry.seed, entry.caseId)}`, entry.expectedHash);
  assert.equal(entry.status, "synthetic");
}
assert.ok(seeds.length > 0);
console.log("distribution golden fixtures OK");
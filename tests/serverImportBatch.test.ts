import assert from "node:assert/strict";
import { createServerImportItems, hasServerImportNameConflict, runServerImportBatch } from "../src/utils/serverImportBatch.ts";

const objects = ["customers", "measurements", "empty_table"].map((name) => ({ catalog: null, schema: "public", name, objectType: "table" as const }));
const items = createServerImportItems(objects, ["CUSTOMERS"]);
assert.equal(items[0].targetName, "customers_2");
items.forEach((item) => { item.selected = true; });
assert.equal(hasServerImportNameConflict(items, ["customers"]), false);
assert.equal(hasServerImportNameConflict(items, [" measurements "]), true);
assert.equal(hasServerImportNameConflict([{ ...items[0], targetName: " " }], []), true);
assert.equal(hasServerImportNameConflict([{ ...items[0], targetName: "same" }, { ...items[1], targetName: " SAME " }], []), true);
const imported: string[] = [];
const refreshed: string[] = [];
await runServerImportBatch(items, async (item) => {
  imported.push(item.targetName);
  if (item.object.name === "measurements") throw new Error("denied");
  return item.object.name === "empty_table" ? 0 : 3;
}, async (name) => { refreshed.push(name); throw new Error("refresh failed"); }, (key, patch) => {
  Object.assign(items.find((item) => item.key === key)!, patch);
}, () => false, String);
assert.deepEqual(imported, ["customers_2", "measurements", "empty_table"]);
assert.deepEqual(refreshed, ["customers_2", "empty_table"]);
assert.deepEqual(items.map((item) => item.status), ["completed", "failed", "completed"]);
assert.equal(items[2].rows, 0);
assert.match(items[0].message!, /refresh failed/);
imported.length = 0;
await runServerImportBatch(items, async (item) => { imported.push(item.targetName); return 100000; }, async () => {}, (key, patch) => {
  Object.assign(items.find((item) => item.key === key)!, patch);
}, () => false, String);
assert.deepEqual(imported, ["measurements"]);
let stopped = false;
const queue = createServerImportItems(objects, []).map((item) => ({ ...item, selected: true }));
imported.length = 0;
await runServerImportBatch(queue, async (item) => { imported.push(item.targetName); stopped = true; return 3; }, async () => {}, () => {}, () => stopped, String);
assert.deepEqual(imported, ["customers"]);
console.log("server import batch regression passed");

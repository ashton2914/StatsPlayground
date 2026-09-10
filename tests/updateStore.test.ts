import assert from "node:assert/strict";

import { createUpdateStore } from "../src/stores/updateStoreCore.ts";

const manualStore = createUpdateStore(async () => null);
await manualStore.getState().check("manual");
assert.equal(manualStore.getState().status, "upToDate", "manual checks must expose an up-to-date result");

const automaticStore = createUpdateStore(async () => {
  throw new Error("offline");
});
await automaticStore.getState().check("automatic");
assert.equal(automaticStore.getState().status, "idle", "automatic failures must remain silent");

const failedManualStore = createUpdateStore(async () => {
  throw new Error("offline");
});
await failedManualStore.getState().check("manual");
assert.equal(failedManualStore.getState().status, "error", "manual failures must expose a non-fatal error");
assert.equal(failedManualStore.getState().update, null);

const update = {
  version: "0.2.0",
  releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
  downloadUrl: "https://example.test/StatsPlayground-0.2.0-windows-x64.zip",
  directDownload: true,
};
const availableStore = createUpdateStore(async () => update);
await availableStore.getState().check("automatic");
assert.equal(availableStore.getState().status, "updateAvailable");
assert.deepEqual(availableStore.getState().update, update);

availableStore.getState().dismiss();
assert.equal(availableStore.getState().status, "idle", "ignore must dismiss only the current prompt");
assert.equal(availableStore.getState().update, null);

console.log("update store tests passed");
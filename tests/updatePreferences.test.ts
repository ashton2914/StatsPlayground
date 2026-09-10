import assert from "node:assert/strict";

import { resolveStoredUpdatePreference } from "../src/stores/updatePreferences.ts";

assert.equal(resolveStoredUpdatePreference(null), true, "a missing update preference must default to enabled");
assert.equal(resolveStoredUpdatePreference("true"), true, "an enabled update preference must stay enabled");
assert.equal(resolveStoredUpdatePreference("false"), false, "a disabled update preference must stay disabled");
assert.equal(resolveStoredUpdatePreference("invalid"), true, "an invalid update preference must use the enabled default");

console.log("update preference tests passed");
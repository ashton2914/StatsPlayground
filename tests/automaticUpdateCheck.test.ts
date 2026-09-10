import assert from "node:assert/strict";

import { runAutomaticUpdateCheck } from "../src/services/automaticUpdateCheck.ts";

const started = { current: false };
let checks = 0;
const check = () => {
  checks += 1;
};

runAutomaticUpdateCheck(false, started, check);
runAutomaticUpdateCheck(true, started, check);
runAutomaticUpdateCheck(true, started, check);

assert.equal(checks, 1, "automatic checking must run at most once during an application startup");
assert.equal(started.current, true);

console.log("automatic update check tests passed");
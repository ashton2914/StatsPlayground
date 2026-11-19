import assert from "node:assert/strict";
import {createProjectStartup} from "../src/projectPersistence/startup.ts";
let native=true,exists=false,fail=false;const calls:string[]=[];
const startup=()=>createProjectStartup({hasProject:()=>exists,enabled:async()=>native,createDraft:async()=>{calls.push("draft");if(fail) throw new Error("disk");exists=true;},legacyInit:async()=>{calls.push("legacy");exists=true;}});
let owner=startup();const first=owner.start();assert.equal(owner.start(),first,"concurrent startup must not create two drafts");assert.deepEqual(await first,{kind:"ready"});assert.deepEqual(calls,["draft"]);
exists=false;calls.length=0;assert.deepEqual(await startup().start(),{kind:"ready"});assert.deepEqual(calls,["draft"]);assert.equal(exists,true);
native=false;exists=false;calls.length=0;assert.deepEqual(await startup().start(),{kind:"ready"});assert.deepEqual(calls,["legacy"]);
native=true;exists=false;fail=true;owner=startup();await assert.rejects(owner.start(),/disk/);fail=false;assert.deepEqual(await owner.start(),{kind:"ready"});


exists=false;native=true;const reusable=startup();await reusable.start();
exists=false;
calls.length=0;assert.deepEqual(await reusable.start(),{kind:"ready"},"after a fatal session failure retry must create a fresh project instead of returning a cached startup result");assert.deepEqual(calls,["draft"]);
calls.length=0;await reusable.start();assert.deepEqual(calls,[],"an existing active project must not be replaced");
console.log("project startup: fresh native drafts, retained drafts ignored, legacy fallback, retry and single-flight passed");

import assert from "node:assert/strict";
import {createProjectStartup} from "../src/projectPersistence/startup.ts";
let native=true,exists=false,fail=false;const calls:string[]=[];let drafts:Array<{projectId:string;displayName:string;recoveryId:string}>=[];
const startup=()=>createProjectStartup({hasProject:()=>exists,enabled:async()=>native,listDrafts:async()=>{calls.push("list");return drafts;},createDraft:async()=>{calls.push("draft");if(fail) throw new Error("disk");exists=true;},legacyInit:async()=>{calls.push("legacy");exists=true;}});
let owner=startup();const first=owner.start();assert.equal(owner.start(),first,"concurrent startup must not create two drafts");assert.deepEqual(await first,{kind:"ready"});assert.deepEqual(calls,["list","draft"]);
exists=false;calls.length=0;drafts=[{projectId:"p",displayName:"Untitled",recoveryId:"opaque"}];assert.deepEqual(await startup().start(),{kind:"recovery",drafts});assert.deepEqual(calls,["list"]);assert.equal(exists,false);
native=false;calls.length=0;assert.deepEqual(await startup().start(),{kind:"ready"});assert.deepEqual(calls,["legacy"]);
native=true;exists=false;drafts=[];fail=true;owner=startup();await assert.rejects(owner.start(),/disk/);fail=false;assert.deepEqual(await owner.start(),{kind:"ready"});


exists=false;native=true;drafts=[];const reusable=startup();await reusable.start();
exists=false;drafts=[{projectId:"retained",displayName:"Recoverable",recoveryId:"retained-id"}];
assert.deepEqual(await reusable.start(),{kind:"recovery",drafts},"after a fatal session failure retry must rescan recovery state instead of returning a cached startup result");
console.log("project startup: native drafts, recovery choice, legacy fallback, retry and single-flight passed");

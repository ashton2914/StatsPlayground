import assert from "node:assert/strict";
import {openNativeProjectWithMigration} from "../src/projectPersistence/openWithMigration.ts";
const calls:string[]=[];
let native=false;let accepted=true;let target:string|null="copy.spprj";let collision=false;let current=true;
const deps={
 open:async(path:string)=>{calls.push(`open:${path}`);if(!native)throw new Error("Invalid parameter: project_requires_migration");},
 preflight:async(source:string,destination?:string)=>{calls.push(`preflight:${destination??"default"}`);return {formatVersion:"4.0.0",destination:destination??"old-v5.spprj",destinationExists:!!destination&&collision,requiredWriter:1};},
 confirm:async()=>{calls.push("confirm");return accepted;},
 chooseDestination:async(path:string)=>{calls.push(`choose:${path}`);return target;},
 migrate:async(source:string,destination:string,id:string)=>{calls.push(`migrate:${source}:${destination}`);assert.match(id,/^[0-9a-f-]{36}$/);},
 isCurrent:()=>current,
};
native=true;assert.equal(await openNativeProjectWithMigration("native.spprj",deps),true);assert.deepEqual(calls,["open:native.spprj"]);
native=false;calls.length=0;accepted=false;
assert.equal(await openNativeProjectWithMigration("old.spprj",deps),false);assert.deepEqual(calls,["open:old.spprj","preflight:default","confirm"]);
calls.length=0;accepted=true;target=null;
assert.equal(await openNativeProjectWithMigration("old.spprj",deps),false);assert.ok(!calls.some(x=>x.startsWith("migrate:")));
calls.length=0;target="copy.spprj";collision=true;
await assert.rejects(openNativeProjectWithMigration("old.spprj",deps),/project_migration_destination_exists/);assert.ok(!calls.some(x=>x.startsWith("migrate:")));
calls.length=0;collision=false;
assert.equal(await openNativeProjectWithMigration("old.spprj",deps),true);
assert.deepEqual(calls,["open:old.spprj","preflight:default","confirm","choose:old-v5.spprj","preflight:copy.spprj","migrate:old.spprj:copy.spprj"]);
calls.length=0;
await assert.rejects(openNativeProjectWithMigration("broken.spprj",{...deps,open:async()=>{throw new Error("bad database header");}}),/bad database header/);assert.deepEqual(calls,[]);
await assert.rejects(openNativeProjectWithMigration("old.spprj",{...deps,confirm:async()=>{current=false;return true;}}),/project_migration_session_changed/);
assert.ok(!calls.some(x=>x.startsWith("migrate:")));
console.log("explicit migration open: native bypass, confirm and chooser cancellation, collision protection, actual errors and dialog ownership fences passed");

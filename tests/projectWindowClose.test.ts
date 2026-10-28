import assert from "node:assert/strict";
import {createNativeWindowCloseHandler,drainStableEffectQueue} from "../src/projectPersistence/windowClose.ts";
let owner:object|null=null;const calls:string[]=[];let fail=false;let resume:(()=>void)|undefined;let hold=false;
const close=createNativeWindowCloseHandler({getOwner:()=>owner,flushEffects:async()=>{calls.push("flush");if(hold) await new Promise<void>(resolve=>{resume=resolve;});if(fail) throw new Error("write failed");},closeProject:async captured=>{assert.equal(captured,owner);calls.push("close");owner=null;},destroy:async()=>{calls.push("destroy");},reportError:error=>{calls.push(String(error));}});
let prevented=0;const event={preventDefault:()=>{prevented++;}};
await close(event);assert.equal(prevented,0);assert.deepEqual(calls,[]);
owner={id:"new-owner"};hold=true;const first=close(event);await close(event);assert.equal(prevented,2);assert.deepEqual(calls,["flush"]);resume!();await first;assert.deepEqual(calls,["flush","close","destroy"]);
owner={id:"retry"};hold=false;fail=true;calls.length=0;await close(event);assert.equal(calls.includes("destroy"),false);assert.ok(owner);fail=false;await close(event);assert.deepEqual(calls.slice(-3),["flush","close","destroy"]);
owner={id:"previous"};hold=true;calls.length=0;const switching=close(event);owner={id:"replacement"};resume!();await switching;assert.equal(calls.includes("close"),false);assert.equal(calls.includes("destroy"),false);assert.ok(calls.some(value=>value.includes("project_changed_during_close")));
console.log("native window close: dynamic owner, immediate prevention, stable drain, duplicate coalescing, failure retry and session switch fences passed");

let finishFirst!:()=>void;let finishSecond!:()=>void;let drained=false;
let pending=new Promise<void>(resolve=>{finishFirst=resolve;});
const draining=drainStableEffectQueue(()=>pending).then(()=>{drained=true;});
pending=new Promise<void>(resolve=>{finishSecond=resolve;});finishFirst();
await Promise.resolve();await Promise.resolve();assert.equal(drained,false,"a drain must include accepted effects appended while it awaited an earlier queue");
finishSecond();await draining;assert.equal(drained,true);

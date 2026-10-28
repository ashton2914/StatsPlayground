import assert from "node:assert/strict";
import {createNativeProjectLifecycle} from "../src/projectPersistence/nativeLifecycle.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectOpenSummary} from "../src/types/projectPersistence.ts";
const calls:string[]=[];let epoch=0;let failSnapshot=false;let listeners=0;
const summary=():ProjectOpenSummary=>({project:{name:"Native",filePath:"native.spprj",createdAt:"now"},header:{projectId:"native-id",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:0,createdAt:"now",engineVersion:"test",storageVersion:"1"},epoch:++epoch,writable:true,directory:{items:[],nextCursor:null,committedRevision:0},settingsRevision:0});
const lifecycle=createNativeProjectLifecycle({
 invoke:async<T>(command:string,args?:Record<string,unknown>):Promise<T>=>{
  calls.push(command);
  if(command==="open_project_v5") {assert.deepEqual(args,{filePath:"native.spprj",readOnly:false});return summary() as T;}
  if(command==="create_project_draft_v5") return {...summary(),project:{name:"Untitled",filePath:"",createdAt:"now"}} as T;
  if(command==="snapshot_project_v5") {assert.equal(args?.firstNaming,true);return {active:summary(),error:failSnapshot?"reopen recovered source":null,destinationPublished:failSnapshot} as T;}
  if(command==="close_project_v5") {assert.equal(args?.epoch,epoch);return undefined as T;}
  throw new Error(command);
 },
 listen:async(event,receive)=>{assert.equal(event,"project-committed");assert.equal(typeof receive,"function");listeners++;return ()=>{listeners--;};},
});
try {
 await lifecycle.switchProject("native.spprj");assert.equal(listeners,1);
 await lifecycle.closeProject();assert.equal(listeners,0);
 await lifecycle.createDraft();failSnapshot=true;const oldEpoch=epoch;
 await assert.rejects(lifecycle.saveAs("named.spprj"),/reopen recovered source/);
 assert.equal(useProjectStore.getState().persistence!.snapshot().epoch,oldEpoch+1);
 assert.equal(listeners,1);
 assert.deepEqual(calls,["open_project_v5","close_project_v5","create_project_draft_v5","snapshot_project_v5"]);
} finally {await lifecycle.closeProject();}
console.log("native lifecycle transport and structured recovery passed");

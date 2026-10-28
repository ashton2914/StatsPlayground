import assert from "node:assert/strict";
import {formatProjectLifecycleError} from "../src/projectPersistence/lifecycle.ts";
import {createNativeProjectLifecycle} from "../src/projectPersistence/nativeLifecycle.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import type {ProjectOpenSummary,ProjectCommit} from "../src/types/projectPersistence.ts";

let epoch=0;
let rejectMigration=true;
let publishedFailure=false;
const migrationId="00000000-0000-4000-8000-000000000282";
let rejectFlush=true;
let listeners=0;
const calls:string[]=[];
const summary=(id:string):ProjectOpenSummary=>({project:{name:id,filePath:`${id}.spprj`,createdAt:"today"},epoch:++epoch,writable:true,header:{projectId:id,formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:0,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[],nextCursor:null,committedRevision:0},settingsRevision:0});
const lifecycle=createNativeProjectLifecycle({
 invoke:async<T>(command:string,args?:Record<string,unknown>):Promise<T>=>{
  calls.push(command);
  if(command==="open_project_v5") return summary("live") as T;
  if(command==="close_project_v5") return undefined as T;
  if(command==="commit_project_records") {
   if(rejectFlush) throw new Error("flush failed");
   const context=args!.context as any;
   return {operationId:context.operationId,epoch:context.expectedEpoch,committedRevision:1,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[]} as ProjectCommit<T> as T;
  }
  if(command==="migrate_project_v5") {
   assert.deepEqual(args,{sourcePath:"legacy.spprj",destinationPath:"legacy-v5.spprj",migrationId});
   assert.equal(useProjectStore.getState().readOnly,true,"migration suspends edits until publication");
   if(rejectMigration) return {active:null,error:"malformed archive",destinationPublished:false} as T;
   if(publishedFailure) return {active:null,error:"could not open converted copy",destinationPublished:true} as T;
   return {active:summary("migrated"),error:null,destinationPublished:true} as T;
  }
  throw new Error(command);
 },
 listen:async()=>{listeners++;return()=>{listeners--;};},
});
try {
 await lifecycle.switchProject("live.spprj");
 const owner=useProjectStore.getState().persistence!;
 useReportStore.getState().addItem({id:"report",name:"Draft",schemaVersion:1,markdown:"keep me",createdAt:"today",updatedAt:"today"});
 await assert.rejects(lifecycle.migrateProject("legacy.spprj","legacy-v5.spprj",migrationId),/flush failed/);
 assert.equal(calls.includes("migrate_project_v5"),false);
 assert.equal(useProjectStore.getState().persistence,owner);
 assert.equal(useReportStore.getState().items[0].markdown,"keep me");
 rejectFlush=false;
 await assert.rejects(lifecycle.migrateProject("legacy.spprj","legacy-v5.spprj",migrationId),/malformed archive/);
 assert.equal(useProjectStore.getState().persistence,owner);
 assert.equal(useProjectStore.getState().readOnly,false);
 assert.equal(useReportStore.getState().items.length,1);
 assert.equal(listeners,1);
 rejectMigration=false;publishedFailure=true;
 await assert.rejects(lifecycle.migrateProject("legacy.spprj","legacy-v5.spprj",migrationId),(error:any)=>error.destinationPublished===true&&formatProjectLifecycleError(error).includes("could not open converted copy")&&formatProjectLifecycleError(error)!==error.message);
 assert.equal(useProjectStore.getState().persistence,owner,"a published copy that fails to open must not reset the retained source session");
 assert.equal(useReportStore.getState().items[0].markdown,"keep me");assert.equal(listeners,1);
 publishedFailure=false;
 await lifecycle.migrateProject("legacy.spprj","legacy-v5.spprj",migrationId);
 assert.equal(useProjectStore.getState().project!.name,"migrated");
 assert.notEqual(useProjectStore.getState().persistence,owner);
 assert.equal(useReportStore.getState().items.length,0);
 assert.equal(listeners,1);
 console.log("migration lifecycle: captured durability barrier, failed source preserves live owner and successful publication replaces metadata session");
} finally {rejectFlush=false;await lifecycle.closeProject();assert.equal(listeners,0);}

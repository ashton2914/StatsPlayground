import assert from "node:assert/strict";
import {createApplicationRuntime} from "../src/applicationCommands/applicationRuntime.ts";
import {analysisCommandFixtures} from "../src/applicationCommands/analysisCommands.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import {useAnalysisStore} from "../src/stores/useAnalysisStore.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
const sent:any[]=[];
function session(id:string,epoch:number,items:any[]) {
 const queue=createProjectPersistenceCoordinator({projectId:id,epoch,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,transport:async(operation:any,context:any)=>{sent.push({project:id,operation,context}); const documents=operation.payload.documents??[]; return {epoch,operationId:context.operationId,committedRevision:context.expectedRevision+1,value:null,changedDatasetGenerations:[],changedDocumentRevisions:documents.map((write:any)=>({id:write.document.summary.id,revision:write.document.summary.revision})),changedDirectoryEntries:documents.map((write:any)=>write.document.summary)};}});
 useProjectStore.getState().installPersistence(queue);useProjectStore.setState({readOnly:false});
 const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapter.activate();
 useProjectCatalogStore.getState().installOpenSummary({epoch,header:{projectId:id,committedRevision:1} as any,directory:{items,nextCursor:null,committedRevision:1},project:{name:id,filePath:id+".spprj",createdAt:"today"},writable:true,settingsRevision:1});
 return {queue,release};
}
const table={id:"dataset-1",name:"A data",sourcePath:null,sourceType:"manual",rowCount:1,colCount:1,generation:0,createdAt:"today",updatedAt:"today"};
useDataStore.setState({datasets:[table] as any});
const a=session("A",10,[{id:table.id,name:table.name,kind:"table",folder:"",revision:1,dependencies:[]}]);
let releaseColumns!:(columns:any)=>void;let began!:(value?:any)=>void;
const started=new Promise(resolve=>{began=resolve;});const columns=new Promise<any>(resolve=>{releaseColumns=resolve;});
const runtime=createApplicationRuntime({analysis:{getColumns:async()=>{began();return columns;},getColumnDisplayProps:async()=>[],activateAnalysis:()=>{},recordAction:()=>{}}});
const deadline=setTimeout(()=>{console.error("analysis owner test deadline",useProjectStore.getState().persistence?.snapshot(),sent.length);process.exit(2);},10000);
const command=runtime.execute({type:"analysis.create",input:analysisCommandFixtures.distribution.create},{kind:"ui"});
await started; await a.queue.close();a.release();useProjectStore.getState().installPersistence(null);useAnalysisStore.getState().reset();useDataStore.setState({datasets:[]});
const b=session("B",11,[]);
releaseColumns([["DIM1","DOUBLE"]]);
await assert.rejects(command,(error:any)=>error.code==="cancelled");
assert.equal(sent.length,0,"an old analysis command must never write into the newly active project");
assert.equal(useAnalysisStore.getState().items.length,0,"stale analysis must not change new project local state");
assert.equal(b.queue.snapshot().acknowledgedSequence,0);
console.log("analysis creation rejects owner change before local or durable mutation");
clearTimeout(deadline);await runtime.shutdown();await b.queue.close();b.release();


for(const type of ["sql.createTable","tableTransform.create"] as const) for(const destination of ["copy","closed"] as const){
 const makeOwner=(id:string,epoch:number)=>createProjectPersistenceCoordinator({projectId:id,epoch,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("stale preflight must not submit");}});
 const ownerA=makeOwner("original",20);useProjectStore.getState().installPersistence(ownerA);
 let finish!:()=>void,began!:()=>void;let publications=0;
 const started=new Promise<void>(resolve=>{began=resolve;});const pending=new Promise<void>(resolve=>{finish=resolve;});
 const preflight=async()=>{began();await pending;};const publish=async()=>{publications++;throw new Error("must not publish");};
 const runtime=createApplicationRuntime({sql:{preflightCreateTableFromSqlQuery:preflight,createTableFromSqlQuery:publish},tableTransform:{preflightCreateAndRun:preflight,createAndRun:publish}});
 const input=type==="sql.createTable"?{sql:"SELECT 1 AS value",name:"Old SQL"}:{draft:{name:"Old transform",outputName:"Old output",operation:{kind:"sort",sortColumns:[{column:"value",direction:"ascending"}]},inputBindings:[{role:"source",tableDocumentId:"shared"}]}};
 const first=runtime.execute({type,input} as any,{kind:"ui"});const second=runtime.execute({type,input} as any,{kind:"ui"});
 // Attach rejection observers before releasing the old command.
 const rejected=Promise.all([first,second].map(command=>assert.rejects(command,(error:any)=>error.code==="cancelled")));
 await started;const successor=destination==="copy"?makeOwner("copy",21):null;useProjectStore.getState().installPersistence(successor);finish();await rejected;
 assert.equal(publications,0,`${type} preflight cannot publish into ${destination}`);
 assert.equal(successor?.snapshot().pendingSequence??0,0);
 await runtime.shutdown();await ownerA.close();await successor?.close();useProjectStore.getState().installPersistence(null);
}
console.log("SQL and transform preflights and queued requests reject superseded owners");


{
 const makeOwner=(id:string,epoch:number)=>createProjectPersistenceCoordinator({projectId:id,epoch,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("unexpected native submit");}});
 const original=makeOwner("postcommit-A",30);useProjectStore.getState().installPersistence(original);
 let finish!:()=>void,began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});const pending=new Promise<void>(resolve=>{finish=resolve;});const effects:string[]=[];
 const runtime=createApplicationRuntime({sql:{preflightCreateTableFromSqlQuery:async()=>{},createTableFromSqlQuery:async()=>table as any,refreshDatasets:async()=>{began();await pending;},markDirty:()=>{effects.push("dirty");},activateDataset:()=>{effects.push("selection");},recordAction:()=>{effects.push("history");}}});
 const command=runtime.execute({type:"sql.createTable",input:{sql:"SELECT 1",name:"Committed in A"}},{kind:"ui"});
 const rejected=assert.rejects(command,(error:any)=>error.code==="cancelled");
 await started;const successor=makeOwner("postcommit-B",31);useProjectStore.getState().installPersistence(successor);finish();await rejected;
 assert.deepEqual(effects,[],"old post-commit completion must not change successor UI/history");
 await runtime.shutdown();await original.close();await successor.close();useProjectStore.getState().installPersistence(null);
}
console.log("post-commit refresh completion cannot publish effects into a successor");

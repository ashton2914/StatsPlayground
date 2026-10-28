import assert from "node:assert/strict";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects,deleteProjectDirectoryDocument,hydrateProjectDocument} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
let releaseCommit!:()=>void;
const held=new Promise<void>(resolve=>{releaseCommit=resolve;});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"delete",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,
  transport:async<T>(_operation,context)=>{await held;return {operationId:context.operationId,epoch:7,committedRevision:2,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[],deletedDirectoryIds:["report"]};}});
useProjectStore.getState().installPersistence(queue);useReportStore.getState().reset();
const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapters.activate();
let deleting:Promise<void>|undefined;
try {
  hydrateProjectDocument({summary:{id:"report",name:"Report",kind:"report",folder:"",revision:1,dependencies:[]},schemaVersion:1,body:{id:"report",name:"Report",schemaVersion:1,markdown:"original",createdAt:"today",updatedAt:"today"}});
  deleting=deleteProjectDirectoryDocument("report",7);
  assert.equal(queue.snapshot().pendingSequence,1);
  assert.throws(()=>useReportStore.getState().updateMarkdown("report","late editor update","today"),/document_deleted/);
  assert.equal(queue.snapshot().pendingSequence,1,"a late update must not queue a recreate after deletion");
  releaseCommit();await deleting;
  assert.equal(useReportStore.getState().items.length,0);
  await queue.close();
  console.log("directory deletion: a late update cannot recreate the deleted document");
} finally {releaseCommit();await deleting?.catch(()=>undefined);release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}

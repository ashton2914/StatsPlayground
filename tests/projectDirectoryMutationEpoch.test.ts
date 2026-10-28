import assert from "node:assert/strict";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects,renameProjectDirectoryDocument,deleteProjectDirectoryDocument} from "../src/projectPersistence/documentAdapters.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectRecordPatch} from "../src/types/projectPersistence.ts";
let writes=0;
const queue=createProjectPersistenceCoordinator({projectId:"new-project",epoch:8,committedRevision:1,now:()=>0,newOperationId:()=>"write",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,
  transport:async<T>(operation,context)=>{writes++;const patch=operation.payload as ProjectRecordPatch;return {operationId:context.operationId,epoch:8,committedRevision:2,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"same-id",revision:2}],changedDirectoryEntries:[{id:"same-id",kind:"report",name:patch.directoryMoves?.[0]?.name??"New report",folder:"",revision:2,dependencies:[]}]};}});
useProjectStore.getState().installPersistence(queue);
useReportStore.getState().loadFromProject([{id:"same-id",name:"New report",schemaVersion:1,markdown:"current project",createdAt:"today",updatedAt:"today"}]);
const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[{id:"same-id",kind:"report",name:"New report",folder:"",revision:1,dependencies:[]}]});const release=adapters.activate();
try {
  await assert.rejects(renameProjectDirectoryDocument("same-id","Old project's delayed rename",7),/session_stale/);
  await assert.rejects(deleteProjectDirectoryDocument("same-id",7),/session_stale/);
  assert.equal(writes,0);
  assert.equal(useReportStore.getState().items[0].name,"New report");
  await queue.close();
  console.log("directory mutations: an old project action cannot target the current same-id document");
} finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}

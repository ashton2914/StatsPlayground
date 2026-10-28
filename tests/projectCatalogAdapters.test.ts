import assert from "node:assert/strict";
import {createProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects,hydrateProjectDocument,registerProjectDocumentSummaries} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useFolderStore} from "../src/stores/useFolderStore.ts";
import type {ProjectDocumentBody,ProjectOpenSummary,ProjectRecordPatch} from "../src/types/projectPersistence.ts";
const document:ProjectDocumentBody={summary:{id:"report",name:"Report",kind:"report",folder:"Reports",revision:1,dependencies:[]},schemaVersion:1,body:{id:"report",name:"Report",schemaVersion:1,markdown:"lazy report",createdAt:"today",updatedAt:"today"}};
const opened:ProjectOpenSummary={project:{name:"Project",filePath:"project.spprj",createdAt:"today"},epoch:7,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:1,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[document.summary],nextCursor:null,committedRevision:1},settingsRevision:1};
useReportStore.getState().reset();useFolderStore.getState().reset();
const sent:ProjectRecordPatch[]=[];
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"move",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,
  transport:async<T>(operation,context)=>{const patch=operation.payload as ProjectRecordPatch;sent.push(patch);return {operationId:context.operationId,epoch:7,committedRevision:2,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"report",revision:2}],changedDirectoryEntries:[{...document.summary,folder:"Moved",revision:2}]};}});
useProjectStore.getState().installPersistence(queue);
const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapters.activate();
let reads=0;
const catalog=createProjectCatalogStore({service:{getProjectDocument:async()=>{reads++;return document;},listProjectCatalog:async()=>{throw new Error("unexpected paging");}},onDocumentReady:(epoch,body)=>hydrateProjectDocument(body,epoch),onSummariesChanged:(epoch,items,revision)=>registerProjectDocumentSummaries(items,epoch,revision)});
try {
  catalog.getState().installOpenSummary(opened);
  assert.equal(reads,0);assert.equal(useReportStore.getState().items.length,0);
  assert.equal(adapters.getSummary("report")?.revision,1,"metadata registration must make unloaded records addressable");
  useFolderStore.getState().setReportFolder("report","Moved");
  await queue.flushThrough(queue.captureBarrier());
  assert.equal(sent[0].directoryMoves![0].id,"report","folder actions must persist without loading document bodies");
  assert.equal(reads,0);
  // Install the acknowledged metadata before selecting the body in its new folder.
  const moved={...document,summary:{...document.summary,folder:"Moved",revision:2}};
  const reader=createProjectCatalogStore({service:{getProjectDocument:async()=>moved,listProjectCatalog:async()=>{throw new Error("unexpected paging");}},onDocumentReady:(epoch,body)=>hydrateProjectDocument(body,epoch)});
  reader.getState().installOpenSummary({...opened,header:{...opened.header,committedRevision:2},directory:{items:[moved.summary],nextCursor:null,committedRevision:2}});
  await reader.getState().ensureDocument("report");
  assert.equal(useReportStore.getState().items[0].markdown,"lazy report");
  assert.equal(useReportStore.getState().getDocumentRevision("report"),2);
  await queue.close();
  console.log("catalog adapters: unloaded folder mutation and selected-body hydration passed");
} finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();useFolderStore.getState().reset();}

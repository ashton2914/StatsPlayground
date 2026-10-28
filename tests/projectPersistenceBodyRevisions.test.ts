import {useDatasetFilterStore} from "../src/stores/useDatasetFilterStore.ts";
import assert from "node:assert/strict";
import {createProjectPersistenceCoordinator,type ProjectOperation} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects,hydrateProjectDocument} from "../src/projectPersistence/documentAdapters.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import type {ProjectCommit,ProjectDocumentBody,ProjectRecordPatch} from "../src/types/projectPersistence.ts";
function document(revision:number,markdown:string):ProjectDocumentBody {return {summary:{id:"report",kind:"report",name:"Report",folder:"",revision,dependencies:[]},schemaVersion:1,body:{id:"report",name:"Report",schemaVersion:1,markdown}};}
function commit(revision:number,bodyRevision:number,operationId="foreign"):ProjectCommit<null> {return {operationId,epoch:7,committedRevision:revision,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"report",revision:bodyRevision}],changedDirectoryEntries:[document(bodyRevision,"").summary]};}
{
  useReportStore.getState().reset();let receive!:(value:ProjectCommit<unknown>)=>void;let sent:ProjectOperation|undefined;
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"own",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,subscribeCommits:callback=>{receive=callback;return ()=>{};},transport:async operation=>{sent=operation;throw new Error("project_document_revision_stale");}});
  useProjectStore.getState().installPersistence(queue);
  const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[document(1,"").summary]});const release=adapters.activate();
  try {
    hydrateProjectDocument(document(1,"loaded body"));
    receive(commit(2,2));
    assert.equal(adapters.getSummary("report")?.revision,2);
    assert.equal(useReportStore.getState().getDocumentRevision("report"),1,"a newer catalog revision cannot relabel an older loaded body");
    useReportStore.getState().updateMarkdown("report","edited from old body","2026-01-03");
    await assert.rejects(queue.flushThrough(queue.captureBarrier()),/revision_stale/);
    assert.equal((sent!.payload as ProjectRecordPatch).documents![0].expectedRevision,1,"stale full bodies must retain their actual base revision");
  } finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}
}
{
  let receive!:(value:ProjectCommit<unknown>)=>void;let finish!:(value:ProjectCommit<unknown>)=>void;
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"own",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,subscribeCommits:callback=>{receive=callback;return ()=>{};},transport:<T>()=>new Promise<ProjectCommit<T>>(resolve=>{finish=value=>resolve(value as ProjectCommit<T>);})});
  useProjectStore.getState().installPersistence(queue);
  const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[document(1,"").summary]});const release=adapters.activate();
  try {
    hydrateProjectDocument(document(1,"original"));useReportStore.getState().updateMarkdown("report","saved local body","2026-01-03");
    const flushed=queue.flushThrough(queue.captureBarrier());
    receive(commit(3,3));
    finish(commit(2,2,"own"));await flushed;
    assert.equal(adapters.getSummary("report")?.revision,3,"a delayed own receipt must not regress a newer catalog entry");
    assert.equal(useReportStore.getState().items[0].markdown,"saved local body");
    assert.equal(useReportStore.getState().getDocumentRevision("report"),2,"the saved local body retains its own acknowledged base");
    hydrateProjectDocument(document(3,"current remote body"));
    assert.equal(useReportStore.getState().items[0].markdown,"current remote body");
    assert.equal(useReportStore.getState().getDocumentRevision("report"),3);
    await queue.close();
  } finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}
}
{
  useDatasetFilterStore.getState().reset();let receive!:(value:ProjectCommit<unknown>)=>void;let sent:ProjectOperation|undefined;
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"own-setting",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,subscribeCommits:callback=>{receive=callback;return ()=>{};},transport:async operation=>{sent=operation;throw new Error("project_setting_revision_stale");}});
  useProjectStore.getState().installPersistence(queue);
  const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[],settings:[{key:"filter:source",revision:1}]});const release=adapters.activate();
  try {
    receive({...commit(2,2),changedDocumentRevisions:[],changedDirectoryEntries:[],changedSettingRevisions:[{key:"filter:source",revision:2}]});
    useDatasetFilterStore.getState().replaceFilters("source",[{id:"filter",op:"AND",rule:{kind:"continuous",field:{name:"value",type:"continuous"},min:0,max:5}}]);
    await assert.rejects(queue.flushThrough(queue.captureBarrier()),/setting_revision_stale/);
    assert.equal((sent!.payload as ProjectRecordPatch).settings![0].expectedRevision,1,"foreign setting metadata must not relabel the locally loaded filter values");
  } finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useDatasetFilterStore.getState().reset();}
}
{
  let receive!:(value:ProjectCommit<unknown>)=>void;let finish!:(value:ProjectCommit<unknown>)=>void;
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>"own",setTimer:()=>1,clearTimer:()=>{},onCommit:applyCommittedProjectEffects,subscribeCommits:callback=>{receive=callback;return ()=>{};},transport:<T>()=>new Promise<ProjectCommit<T>>(resolve=>{finish=value=>resolve(value as ProjectCommit<T>);})});
  useProjectStore.getState().installPersistence(queue);
  const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[document(1,"").summary]});const release=adapters.activate();
  try {
    hydrateProjectDocument(document(1,"original"));useReportStore.getState().updateMarkdown("report","earlier saved edit","today");
    const flushed=queue.flushThrough(queue.captureBarrier());
    receive({...commit(3,3),changedDocumentRevisions:[],changedDirectoryEntries:[],deletedDirectoryIds:["report"]});
    finish(commit(2,2,"own"));await flushed;
    assert.equal(adapters.getSummary("report"),undefined,"an older own receipt must not resurrect a later deletion");
    assert.throws(()=>useReportStore.getState().updateMarkdown("report","late old editor","today"),/document_deleted|not loaded/);
    assert.equal(queue.snapshot().pendingSequence,1);
    await queue.close();
  } finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}
}
console.log("document persistence: loaded-body revisions and delayed own receipts preserve newer catalog state");

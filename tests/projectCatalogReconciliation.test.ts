import assert from "node:assert/strict";
import {createProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,getProjectDirectorySummaries,registerProjectDocumentSummaries} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import type {ProjectDocumentSummary} from "../src/types/projectPersistence.ts";
const old:ProjectDocumentSummary={id:"old",kind:"report",name:"Removed report",folder:"",revision:1,dependencies:[]};
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:2,now:()=>0,newOperationId:()=>"draft",setTimer:()=>0,clearTimer:()=>{},transport:async<T>(_operation,context)=>({operationId:context.operationId,epoch:7,committedRevision:3,value:null as T,changedDatasetGenerations:[],changedDocumentRevisions:[]})});
useReportStore.getState().reset();useProjectStore.getState().installPersistence(queue);
const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[old]});const release=adapters.activate();
const catalog=createProjectCatalogStore({service:{getProjectDocument:()=>{throw new Error("no body reads");},listProjectCatalog:()=>{throw new Error("no paging");}},onSummariesChanged:(epoch,items,revision,complete)=>registerProjectDocumentSummaries(items,epoch,revision,complete)});
try {
 useReportStore.getState().addItem({id:"draft",name:"Pending draft",schemaVersion:1,markdown:"unsaved local body",createdAt:"today",updatedAt:"today"});
 catalog.getState().installOpenSummary({project:{name:"Project",filePath:"project.spprj",createdAt:"today"},epoch:7,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:2,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[],nextCursor:null,committedRevision:2},settingsRevision:0});
 assert.deepEqual(getProjectDirectorySummaries(7)?.map(item=>item.id),["draft"],"a complete authoritative inventory removes stale durable entries while retaining pending drafts");
 assert.equal(useReportStore.getState().items[0].markdown,"unsaved local body");
 adapters.applyCommit({operationId:"late-old",epoch:7,committedRevision:1,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[{id:"old",revision:1}],changedDirectoryEntries:[old]},{own:false});
 assert.deepEqual(getProjectDirectorySummaries(7)?.map(item=>item.id),["draft"],"an older receipt cannot resurrect an entry absent from the newer complete inventory");
 await queue.close();console.log("catalog reconciliation: complete inventories prune stale metadata and preserve pending drafts and receipt fences");
} finally {release();useProjectStore.setState({persistence:null,persistenceSnapshot:null});useReportStore.getState().reset();}

import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
import assert from "node:assert/strict";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useGraphBuilderStore} from "../src/stores/useGraphBuilderStore.ts";
import {useDatasetFilterStore} from "../src/stores/useDatasetFilterStore.ts";
import {useFolderStore} from "../src/stores/useFolderStore.ts";
const dataset={id:"table",name:"Table",sourcePath:null,sourceType:"manual" as const,rowCount:1000000,colCount:1,generation:1,createdAt:"today",updatedAt:"today"};
useDataStore.setState({datasets:[dataset,{...dataset,id:"keep"}],activeDatasetId:"table"});
useGraphBuilderStore.setState({items:[{id:"graph",name:"Graph",sourceDatasetId:"table"}] as any});
useDatasetFilterStore.setState({byDataset:{table:[],keep:[]}});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:5,committedRevision:1,now:()=>0,newOperationId:()=>"unused",setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("receipt projection must not write");}});
useHistoryStore.setState({history:[{id:"deleted-history",timestamp:"today",description:"table",action:{kind:"changeSet",datasetId:"table",changeSetId:"deleted-history"}},{id:"retained-history",timestamp:"today",description:"keep",action:{kind:"changeSet",datasetId:"keep",changeSetId:"retained-history"}}],currentIdx:1});
useProjectStore.getState().installPersistence(queue);
const summaries=[{id:"table",kind:"table" as const,name:"Table",folder:"",revision:1,dependencies:[]},{id:"graph",kind:"graph" as const,name:"Graph",folder:"",revision:1,dependencies:["table"]}];
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries});const release=adapter.activate();
try {
 adapter.applyCommit({operationId:"delete",epoch:5,committedRevision:2,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[],deletedDirectoryIds:["table","graph"]});
 assert.deepEqual(useDataStore.getState().datasets.map(item=>item.id),["keep"]);assert.equal(useDataStore.getState().activeDatasetId,null);
 assert.equal(useGraphBuilderStore.getState().items.length,0);assert.equal(useDatasetFilterStore.getState().byDataset.table,undefined);assert.ok("keep" in useDatasetFilterStore.getState().byDataset);
 assert.deepEqual(useHistoryStore.getState().history.map(item=>item.id),["retained-history"]);assert.equal(useHistoryStore.getState().currentIdx,0);
 assert.equal(adapter.getSummary("table"),undefined);assert.equal(adapter.getSummary("graph"),undefined);assert.equal(queue.captureBarrier(),0);
 console.log("dataset deletion receipt: atomic loaded projection, retained unrelated data and no echo writes passed");
} finally {release();useHistoryStore.getState().reset();await queue.close();useProjectStore.getState().installPersistence(null);useDataStore.setState({datasets:[]});useGraphBuilderStore.getState().reset();useDatasetFilterStore.getState().reset();useFolderStore.getState().reset();}

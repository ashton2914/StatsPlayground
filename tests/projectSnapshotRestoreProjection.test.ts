import assert from "node:assert/strict";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters,applyCommittedProjectEffects} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
import type {ProjectCommit} from "../src/types/projectPersistence.ts";
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:0,now:()=>0,newOperationId:()=>"unused",setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("snapshot receipt projection cannot write");}});
useProjectStore.getState().installPersistence(queue);
const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapters.activate();
const receipt=(revision:number,value:unknown=null):ProjectCommit<unknown>=>({operationId:`op-${revision}`,epoch:7,committedRevision:revision,value,changedDatasetGenerations:[],changedDocumentRevisions:[],changedHistoryEntries:[]});
try {
 useHistoryStore.setState({history:[{id:"old",timestamp:"today",description:"old",action:{kind:"changeSet",datasetId:"table",changeSetId:"old"}}],currentIdx:0});
 const restored=receipt(5,{kind:"dataSnapshotRestored",snapshotId:"snapshot",tableHistoryReset:true});
 applyCommittedProjectEffects(restored);
 assert.equal(useHistoryStore.getState().history.length,0,"restored data invalidates all previous executable table history before acknowledgement");
 assert.equal(useHistoryStore.getState().currentIdx,-1);
 const history=(id:string)=>[{id,datasetId:"table",operation:"update_cells",applied:true,generation:2}];
 applyCommittedProjectEffects({...receipt(4),changedHistoryEntries:history("old-late")});assert.equal(useHistoryStore.getState().history.length,0);
 applyCommittedProjectEffects({...receipt(6),changedHistoryEntries:history("new")});assert.equal(useHistoryStore.getState().history[0].id,"new");
 applyCommittedProjectEffects(restored);assert.equal(useHistoryStore.getState().history[0].id,"new","a duplicate restore receipt must not clear newer history");
 console.log("snapshot restore projection: history invalidation and late/duplicate receipt fences passed");
}finally{release();useHistoryStore.getState().reset();useProjectStore.getState().installPersistence(null);await queue.close();}

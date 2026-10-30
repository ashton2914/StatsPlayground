import assert from 'node:assert/strict';
import {createProjectDocumentAdapters} from '../src/projectPersistence/documentAdapters.ts';
import {createProjectPersistenceCoordinator} from '../src/projectPersistence/coordinator.ts';
import {useProjectStore} from '../src/stores/useProjectStore.ts';
import {useDataStore} from '../src/stores/useDataStore.ts';
import {useWorkspaceSelectionStore} from '../src/stores/useWorkspaceSelectionStore.ts';
import {useTableTransformStore} from '../src/stores/useTableTransformStore.ts';
import {useHistoryStore} from '../src/stores/useHistoryStore.ts';
const queue=createProjectPersistenceCoordinator({projectId:'p',epoch:1,committedRevision:1,now:()=>0,newOperationId:()=> 'unused',setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw Error('receipts do not echo writes');}});
const table=(id:string)=>({id,name:id,sourceType:'manual' as const,sourcePath:null,generation:1,rowCount:1,colCount:1,createdAt:'today',updatedAt:'today'});
useProjectStore.getState().installPersistence(queue);useDataStore.setState({datasets:['A','B','X'].map(table),activeDatasetId:'B'});
useWorkspaceSelectionStore.getState().activate('dataset','B');
useHistoryStore.setState({history:[{id:'b-edit',description:'B edit',timestamp:'today',action:{kind:'changeSet',datasetId:'B',changeSetId:'b-edit'}}],currentIdx:0});
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:['A','B','X'].map(id=>({id,kind:'table',name:id,folder:'',revision:1,dependencies:[]}))});const dispose=adapter.activate();
useTableTransformStore.setState({definitions:[{id:'ab',name:'Transform'}] as any,bindings:[{definitionId:'ab'}] as any,pendingById:{ab:1}});
adapter.registerSummary({id:'ab',kind:'transform',name:'Transform',folder:'',revision:1,dependencies:['A']});
try{
  adapter.applyCommit({operationId:'cascade',epoch:1,committedRevision:2,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[],deletedDirectoryIds:['A','B','ab'],changedHistoryEntries:[{id:'root-delete',datasetId:'A',operation:'delete_table',applied:true,generation:1}]});
  assert.deepEqual(useDataStore.getState().datasets.map(t=>t.id),['X']);
  assert.equal(useWorkspaceSelectionStore.getState().selection.activeDatasetId,null,'cascade receipts must close a selected descendant');
  assert.ok(useHistoryStore.getState().history.some(h=>h.id==='b-edit'),'descendant history must remain available for cascade undo');
  useWorkspaceSelectionStore.getState().activate('dataset','X');
  adapter.applyCommit({operationId:'older',epoch:1,committedRevision:1,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[],deletedDirectoryIds:['B']});
  assert.equal(useWorkspaceSelectionStore.getState().selection.activeDatasetId,'X');
  assert.deepEqual(useTableTransformStore.getState().definitions,[]);assert.deepEqual(useTableTransformStore.getState().bindings,[]);
  assert.equal(queue.captureBarrier(),0);
  console.log('cascade receipt projection: exact descendant selection closure, retained history and no echo writes passed');
}finally{dispose();useHistoryStore.getState().reset();await queue.close();useProjectStore.getState().installPersistence(null);useWorkspaceSelectionStore.getState().clear();useDataStore.setState({datasets:[]});useTableTransformStore.getState().reset();}

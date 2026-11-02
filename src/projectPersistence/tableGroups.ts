import {useProjectStore} from '../stores/useProjectStore';
import {projectService} from '../services/projectService';
import type {ProjectActionScope, ProjectTopology} from '../types/projectPersistence';

function owner() {
  const persistence=useProjectStore.getState().persistence;
  if(!persistence) throw new Error('project_session_required');
  return persistence;
}
function assertCurrent(persistence:ReturnType<typeof owner>,epoch:number) {
  if(useProjectStore.getState().persistence!==persistence||persistence.snapshot().epoch!==epoch) throw new Error('project_topology_session_stale');
}
export async function readProjectTopology():Promise<ProjectTopology> {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  await persistence.flushThrough(persistence.captureBarrier());assertCurrent(persistence,epoch);
  const topology=await projectService.getProjectTopology(epoch);assertCurrent(persistence,epoch);
  if(topology.epoch!==epoch) throw new Error('project_topology_session_stale');
  return topology;
}
export async function previewTableAction(tableId:string,scope:ProjectActionScope) {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  await persistence.flushThrough(persistence.captureBarrier());assertCurrent(persistence,epoch);
  const preview=await projectService.previewProjectTableAction(epoch,tableId,scope);assertCurrent(persistence,epoch);
  if(preview.epoch!==epoch) throw new Error('project_topology_session_stale');
  return preview;
}
export async function moveTableGroup(targetTableId:string,destinationFolder:string,expectedTopologyRevision:number):Promise<void> {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  await persistence.submit({command:'move_project_table_group',payload:{request:{targetTableId,destinationFolder,expectedTopologyRevision}}});
  assertCurrent(persistence,epoch);
}

export async function copyTableGroup(targetTableId:string,destinationFolder:string,expectedTopologyRevision:number) {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  const commit=await persistence.submit<import('../types/projectPersistence').ProjectGroupCopyResult>({command:'copy_project_table_group',payload:{request:{targetTableId,destinationFolder,expectedTopologyRevision}}});
  assertCurrent(persistence,epoch);return commit.value;
}

export async function exportTableGroup(targetTableId:string,filePath:string,expectedTopologyRevision:number) {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  await persistence.flushThrough(persistence.captureBarrier());assertCurrent(persistence,epoch);
  const result=await projectService.exportProjectTableGroup(epoch,{targetTableId,filePath,expectedTopologyRevision});
  assertCurrent(persistence,epoch);return result;
}
export async function importTableGroup(filePath:string,destinationFolder:string) {
  const persistence=owner();const epoch=persistence.snapshot().epoch;
  const commit=await persistence.submit<import('../types/projectPersistence').ProjectGroupCopyResult>({command:'import_project_table_group',payload:{request:{filePath,destinationFolder}}});
  assertCurrent(persistence,epoch);return commit.value;
}

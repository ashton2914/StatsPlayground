import { invoke } from "@tauri-apps/api/core";
import {useProjectStore} from "@/stores/useProjectStore";
import type {ProjectDataSnapshotDescriptor,ProjectDataSnapshotRestored} from "@/types/projectPersistence";
import type { ProjectDataSnapshot } from "@/types/history";

export const historyService = {
  createNativeSnapshot:async(name:string,owner=useProjectStore.getState().persistence)=>{
    if(!owner||useProjectStore.getState().persistence!==owner)throw new Error("project_session_required");
    const commit=await owner.submit<ProjectDataSnapshotDescriptor>({command:"capture_project_data_snapshot",payload:{id:crypto.randomUUID(),name,createdAt:new Date().toISOString()}});
    if(useProjectStore.getState().persistence!==owner)throw new Error("project_epoch_stale");return commit.value;
  },
  restoreNativeSnapshot:async(id:string,expectedRevision:number,owner=useProjectStore.getState().persistence)=>{
    if(!owner||useProjectStore.getState().persistence!==owner)throw new Error("project_session_required");
    const commit=await owner.submit<ProjectDataSnapshotRestored>({command:"restore_project_data_snapshot",payload:{id,expectedRevision},documentRevisions:[{id,revision:expectedRevision}]});
    if(useProjectStore.getState().persistence!==owner)throw new Error("project_epoch_stale");return commit.value;
  },
  deleteNativeSnapshot:async(id:string,expectedRevision:number,owner=useProjectStore.getState().persistence)=>{
    if(!owner||useProjectStore.getState().persistence!==owner)throw new Error("project_session_required");
    await owner.submit({command:"delete_project_data_snapshot",payload:{id,expectedRevision},documentRevisions:[{id,revision:expectedRevision}]});
    if(useProjectStore.getState().persistence!==owner)throw new Error("project_epoch_stale");
  },
  renameNativeSnapshot:async(id:string,expectedRevision:number,name:string,owner=useProjectStore.getState().persistence)=>{
    if(!owner||useProjectStore.getState().persistence!==owner)throw new Error("project_session_required");
    await owner.submit({command:"commit_project_records",payload:{directoryMoves:[{id,expectedRevision,name,folder:""}]},documentRevisions:[{id,revision:expectedRevision}]});
    if(useProjectStore.getState().persistence!==owner)throw new Error("project_epoch_stale");
  },
  captureProjectSnapshot: () =>
    invoke<ProjectDataSnapshot>("capture_project_snapshot"),

  restoreProjectSnapshot: (snapshot: ProjectDataSnapshot) =>
    invoke<void>("restore_project_snapshot", { snapshot }),
};

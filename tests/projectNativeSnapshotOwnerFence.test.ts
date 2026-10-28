import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {useProjectDataSnapshotStore} from "../src/stores/useProjectDataSnapshotStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useHistoryStore} from "../src/stores/useHistoryStore.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let finish!:(value:unknown)=>void;let writes=0;
mockIPC(command=>{assert.equal(command,"list_project_data_snapshots");return new Promise(resolve=>{finish=resolve;});});
const queue=(epoch:number)=>createProjectPersistenceCoordinator({projectId:`project-${epoch}`,epoch,committedRevision:0,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{writes++;throw new Error("old action cannot write to new project");}});
const first=queue(7);const second=queue(8);useProjectDataSnapshotStore.getState().reset();useProjectStore.getState().installPersistence(first);
try {
 const create=useHistoryStore.getState().createSnapshot("Old project checkpoint");
 useProjectStore.getState().installPersistence(second);useProjectDataSnapshotStore.getState().install(8,0);
 finish({items:[],nextCursor:null,committedRevision:0});
 await assert.rejects(create,/project_epoch_stale/);assert.equal(writes,0);assert.equal(useProjectDataSnapshotStore.getState().epoch,8);
 console.log("native snapshot action: project switches fence metadata reads before any mutation passed");
}finally{useProjectStore.getState().installPersistence(null);useProjectDataSnapshotStore.getState().reset();clearMocks();delete(globalThis as any).window;await first.close();await second.close();}

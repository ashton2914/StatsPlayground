import {invoke} from "@tauri-apps/api/core";
import {useProjectStore} from "../stores/useProjectStore";

/** External exports include every edit accepted before the request began. */
export async function invokeProjectExport(command:string,args:Record<string,unknown>):Promise<void> {
 const owner=useProjectStore.getState().persistence;
 if(owner)await owner.flushThrough(owner.captureBarrier());
 if(useProjectStore.getState().persistence!==owner)throw new Error("project_session_stale");
 await invoke<void>(command,owner?{...args,epoch:owner.snapshot().epoch}:args);
}

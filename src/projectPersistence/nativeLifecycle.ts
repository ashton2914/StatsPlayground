import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {createProjectLifecycleV5,ProjectLifecycleRecoveryError,ProjectMigrationError,type ProjectSessionSummary} from "./lifecycle";
import type {ProjectOperation} from "./coordinator";
import type {ProjectCommit,ProjectWriteContext,ProjectOperationResolution} from "../types/projectPersistence";
interface NativeLifecycleTransport {
 invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>;
 listen(event:string,receive:(event:{payload:ProjectCommit<unknown>})=>void):Promise<()=>void>;
}
interface SnapshotOutcome {
 active:ProjectSessionSummary|null;
 error:string|null;
 destinationPublished:boolean;
}
export function createNativeProjectLifecycle(transport:NativeLifecycleTransport) {
 return createProjectLifecycleV5({
  open:(filePath,readOnly)=>transport.invoke<ProjectSessionSummary>("open_project_v5",{filePath,readOnly}),
  close:epoch=>transport.invoke<void>("close_project_v5",{epoch}),
  createDraft:()=>transport.invoke<ProjectSessionSummary>("create_project_draft_v5"),
  recoverDraft:recoveryId=>transport.invoke<ProjectSessionSummary>("recover_project_draft_v5",{recoveryId}),
  migrate:async(sourcePath,destinationPath,migrationId)=>{
   const outcome=await transport.invoke<SnapshotOutcome>("migrate_project_v5",{sourcePath,destinationPath,migrationId});
   if(outcome.error) throw new ProjectMigrationError(outcome.error,outcome.destinationPublished);
   if(!outcome.active) throw new ProjectMigrationError("project_migration_session_unavailable",outcome.destinationPublished);
   return outcome.active;
  },
  snapshot:async(epoch,filePath,firstNaming)=>{
   const outcome=await transport.invoke<SnapshotOutcome>("snapshot_project_v5",{epoch,filePath,firstNaming});
   if(outcome.error) throw new ProjectLifecycleRecoveryError(outcome.error,outcome.active,outcome.destinationPublished);
   if(!outcome.active) throw new ProjectLifecycleRecoveryError("project_snapshot_session_unavailable",null,outcome.destinationPublished);
   return outcome.active;
  },
  resolveOperation:context=>transport.invoke<ProjectOperationResolution>("resolve_project_operation",{context}),
  checkpoint:(epoch,expectedRevision)=>transport.invoke<void>("checkpoint_project_v5",{epoch,expectedRevision}),
  listenCommits:receive=>transport.listen("project-committed",event=>receive(event.payload)),
  commit:<T>(operation:ProjectOperation<T>,context:ProjectWriteContext)=>{
   if(!operation.payload||typeof operation.payload!=="object"||Array.isArray(operation.payload)) return Promise.reject(new Error("Invalid project operation payload"));
   const args=operation.command==="commit_project_records"?{patch:operation.payload,context}:{...operation.payload,context};
   return transport.invoke<ProjectCommit<T>>(operation.command,args);
  },
 });
}
export const nativeProjectLifecycle=createNativeProjectLifecycle({invoke,listen});

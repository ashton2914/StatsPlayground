import i18n from "../i18n";
import {createProjectPersistenceCoordinator,type ProjectPersistenceCoordinator,type ProjectOperation} from "./coordinator";
import {createProjectDocumentAdapters,applyCommittedProjectEffects} from "./documentAdapters";
import {projectViewportBudget} from "./viewportBudget";
import {useProjectStore} from "../stores/useProjectStore";
import {useProjectCatalogStore} from "../stores/useProjectCatalogStore";
import {useProjectHistoryStore} from "../stores/useProjectHistoryStore";
import {useProjectDataSnapshotStore} from "../stores/useProjectDataSnapshotStore";
import {useDataStore} from "../stores/useDataStore";
import {useReportStore} from "../stores/useReportStore";
import {useAnalysisStore} from "../stores/useAnalysisStore";
import {useGraphBuilderStore} from "../stores/useGraphBuilderStore";
import {useGraphBuilderNewStore} from "../stores/useGraphBuilderNewStore";
import {useTabulateStore} from "../stores/useTabulateStore";
import {useTableTransformStore} from "../stores/useTableTransformStore";
import {useWorkflowStore} from "../stores/useWorkflowStore";
import {useFolderStore} from "../stores/useFolderStore";
import {useDatasetFilterStore} from "../stores/useDatasetFilterStore";
import {useHistoryStore} from "../stores/useHistoryStore";
import {useWorkspaceSelectionStore} from "../stores/useWorkspaceSelectionStore";
import {useTableViewportStore} from "../stores/useTableViewportStore";
import {useTableNavigationSortStore} from "../stores/useTableNavigationSortStore";
import type {ProjectCommit,ProjectOpenSummary,ProjectWriteContext,ProjectOperationResolution} from "../types/projectPersistence";
import type {DatasetMeta} from "../types/data";

export interface ProjectSessionSummary extends ProjectOpenSummary {datasets?:DatasetMeta[]}
export class ProjectLifecycleRecoveryError extends Error {
 constructor(message:string,public readonly active:ProjectSessionSummary|null,public readonly destinationPublished=false) {super(message);this.name="ProjectLifecycleRecoveryError";}
}
export class ProjectMigrationError extends Error {
 readonly cancelled:boolean;
 constructor(message:string,public readonly destinationPublished=false) {super(message);this.name="ProjectMigrationError";this.cancelled=message.startsWith("Cancelled:");}
}

export function formatProjectLifecycleError(error:unknown):string {
 const message=error instanceof Error?error.message:String(error);
 return (error instanceof ProjectLifecycleRecoveryError||error instanceof ProjectMigrationError)&&error.destinationPublished
  ? `${i18n.t("workspace.destinationPublished",{defaultValue:"The copy was written to the destination."})} ${message}`:message;
}

interface LifecycleDependencies {
 open(path:string,readOnly:boolean):Promise<ProjectSessionSummary>;
 close(epoch:number):Promise<void>;
 createDraft():Promise<ProjectSessionSummary>;
 recoverDraft?(recoveryId:string):Promise<ProjectSessionSummary>;
 migrate?(sourcePath:string,destinationPath:string,migrationId:string):Promise<ProjectSessionSummary>;
 snapshot(epoch:number,path:string,firstNaming:boolean):Promise<ProjectSessionSummary>;
 listenCommits(receive:(commit:ProjectCommit<unknown>)=>void):Promise<()=>void>;
 checkpoint?(epoch:number,revision:number):Promise<void>;
 resolveOperation?(context:ProjectWriteContext):Promise<ProjectOperationResolution>;
 commit<T>(operation:ProjectOperation<T>,context:ProjectWriteContext):Promise<ProjectCommit<T>>;
}

function resetProjectDomains() {
 useReportStore.getState().reset();useAnalysisStore.getState().reset();useGraphBuilderStore.getState().reset();
 useGraphBuilderNewStore.getState().reset();useTabulateStore.getState().reset();useTableTransformStore.getState().reset();
 useWorkflowStore.getState().reset();useFolderStore.getState().reset();useDatasetFilterStore.getState().reset();
 useHistoryStore.getState().reset();useWorkspaceSelectionStore.getState().clear();useTableViewportStore.getState().reset();
 useTableNavigationSortStore.getState().reset();useProjectHistoryStore.getState().reset();useProjectDataSnapshotStore.getState().reset();projectViewportBudget.reset();
 useDataStore.setState({datasets:[],activeDatasetId:null,statusInfo:null});
}

/** The backend stages file changes; this owner drains and replaces frontend sessions. */
export function createProjectLifecycleV5(deps:LifecycleDependencies) {
 let busy=false;
 let owned:ProjectPersistenceCoordinator|null=null;
 let releaseAdapters:(()=>void)|null=null;
 const current=()=>{
  const active=useProjectStore.getState().persistence;
  if(active&&active!==owned) throw new Error("project_session_not_owned");
  return active;
 };
 const transition=async<T>(apply:(owner:ProjectPersistenceCoordinator|null)=>Promise<T>):Promise<T>=>{
  if(busy) throw new Error("project_transition_in_progress");
  const owner=current();const previous=useProjectStore.getState();const resumeWrites=owner?.suspendWrites();busy=true;
  useProjectStore.setState({readOnly:true,loading:true});
  try {
   if(owner) await owner.flushThrough(owner.captureBarrier());
   return await apply(owner);
  } finally {
   busy=false;resumeWrites?.();
   if(useProjectStore.getState().persistence===owner) useProjectStore.setState({readOnly:previous.readOnly});
   useProjectStore.setState({loading:false});
  }
 };
 const replace=async(owner:ProjectPersistenceCoordinator|null,open:()=>Promise<ProjectSessionSummary>)=>{
  const delivery:{receive:((commit:ProjectCommit<unknown>)=>void)|null;ready:boolean}={receive:null,ready:false};
  const early:ProjectCommit<unknown>[]=[];
  let unlisten:(()=>void)|null=await deps.listenCommits(commit=>{if(delivery.ready&&delivery.receive) delivery.receive(commit);else early.push(commit);});
  try {
   let summary:ProjectSessionSummary;
   let recoveredFailure:ProjectLifecycleRecoveryError|undefined;
   try {summary=await open();}
   catch(error) {
    if(!(error instanceof ProjectLifecycleRecoveryError)) throw error;
    if(!error.active) {
     if(owner) await owner.close();releaseAdapters?.();releaseAdapters=null;owned=null;
     resetProjectDomains();useProjectCatalogStore.getState().reset((owner?.snapshot().epoch??0)+1);
     useProjectStore.getState().installPersistence(null);useProjectStore.setState({project:null,dirty:false,saving:false,saveError:formatProjectLifecycleError(error)});
     throw error;
    }
    summary=error.active;recoveredFailure=error;
   }
   const stop=unlisten;
   const coordinator=createProjectPersistenceCoordinator({
    projectId:summary.header.projectId,epoch:summary.epoch,committedRevision:summary.header.committedRevision,writable:summary.writable,
    now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:(run,delay)=>setTimeout(run,delay),clearTimer:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
    transport:deps.commit,checkpoint:deps.checkpoint,resolveOperation:deps.resolveOperation,onCheckpointError:error=>console.warn("Project idle checkpoint deferred",error),
    subscribeCommits:receive=>{delivery.receive=receive;return ()=>{delivery.ready=false;delivery.receive=null;stop();};},
    onChange:snapshot=>useProjectStore.getState().syncPersistence(snapshot),
    onCommit:(commit,source)=>{applyCommittedProjectEffects(commit,source);useProjectCatalogStore.getState().applyCommit(commit);},
   });
   if(owner) await owner.close();
   releaseAdapters?.();releaseAdapters=null;
   resetProjectDomains();
   owned=coordinator;
   useProjectStore.setState({project:summary.project,dirty:false,saveError:null,saveProgress:null,saving:false,projectRevision:summary.header.committedRevision});
   useProjectStore.getState().installPersistence(coordinator,!summary.writable);
   const adapters=createProjectDocumentAdapters({coordinator,summaries:[]});
   releaseAdapters=adapters.activate();
   useProjectCatalogStore.getState().installOpenSummary(summary);
   useDataStore.setState({datasets:summary.datasets??[]});
   delivery.ready=true;
   for(const commit of early) delivery.receive?.(commit);
   early.length=0;
   unlisten=null;
   if(recoveredFailure) throw recoveredFailure;
   return summary;
  } finally {unlisten?.();}
 };
 return {
  switchProject(path:string,readOnly=false) {return transition(owner=>replace(owner,()=>deps.open(path,readOnly)));},
  migrateProject(sourcePath:string,destinationPath:string,migrationId:string=crypto.randomUUID()) {return transition(owner=>replace(owner,()=>{if(!deps.migrate) throw new Error("project_migration_unavailable");return deps.migrate(sourcePath,destinationPath,migrationId);}));},
  createDraft() {return transition(owner=>replace(owner,()=>deps.createDraft()));},
  recoverDraft(recoveryId:string) {return transition(owner=>replace(owner,()=>{if(!deps.recoverDraft) throw new Error("project_recovery_unavailable");return deps.recoverDraft(recoveryId);}));},
  saveAs(path:string) {
   return transition(async owner=>{
    if(!owner) throw new Error("project_session_required");
    const firstNaming=!useProjectStore.getState().project?.filePath;
    useProjectStore.setState({saving:true});
    try {return await replace(owner,()=>deps.snapshot(owner.snapshot().epoch,path,firstNaming));}
    finally {useProjectStore.setState({saving:false});}
   });
  },
  closeProject() {
   return transition(async owner=>{
    if(!owner) return;
    await deps.close(owner.snapshot().epoch);
    await owner.close();releaseAdapters?.();releaseAdapters=null;owned=null;
    resetProjectDomains();useProjectCatalogStore.getState().reset(owner.snapshot().epoch+1);
    useProjectStore.getState().installPersistence(null);
    useProjectStore.setState({project:null,dirty:false,saving:false,saveError:null,saveProgress:null,projectRevision:0});
   });
  },
 };
}

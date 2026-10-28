import {create} from "zustand";
import {invoke} from "@tauri-apps/api/core";
import type {ProjectDataSnapshotDescriptor,ProjectDataSnapshotPage} from "../types/projectPersistence";
interface Reader {list(epoch:number,after:string|null,limit:number):Promise<ProjectDataSnapshotPage>}
interface SnapshotState {
 epoch:number|null; committedRevision:number; items:ProjectDataSnapshotDescriptor[];
 nextCursor:string|null; loaded:boolean; loading:boolean; error:string|null;
 install(epoch:number,revision:number):void; reset():void; loadNextPage():Promise<void>;
}
/** Native snapshot descriptors are separate from legacy snapshots containing JS row arrays. */
export function createProjectDataSnapshotStore(reader:Reader={list:(epoch,after,limit)=>invoke("list_project_data_snapshots",{epoch,after,limit})}) {
 let session=0;let inFlight:Promise<void>|null=null;
 return create<SnapshotState>((set,get)=>({epoch:null,committedRevision:0,items:[],nextCursor:null,loaded:false,loading:false,error:null,
  install(epoch,revision) {
   if(get().epoch===epoch&&revision<=get().committedRevision)return;
   session++;inFlight=null;set({epoch,committedRevision:revision,items:[],nextCursor:null,loaded:false,loading:false,error:null});
  },
  reset(){session++;inFlight=null;set({epoch:null,committedRevision:0,items:[],nextCursor:null,loaded:false,loading:false,error:null});},
  loadNextPage(){
   if(inFlight)return inFlight;
   const initial=get();if(initial.epoch===null||(initial.loaded&&!initial.nextCursor))return Promise.resolve();
   const owner=session;let complete!:()=>void;const pending=new Promise<void>(resolve=>{complete=resolve;});inFlight=pending;set({loading:true,error:null});
   void(async()=>{
    let after=initial.nextCursor;
    for(let attempt=0;attempt<2;attempt++)try {
     const page=await reader.list(initial.epoch!,after,200);if(owner!==session)return;
     if(page.committedRevision<get().committedRevision||(after!==null&&page.committedRevision!==initial.committedRevision))throw new Error("project_snapshot_cursor_stale");
     const items=new Map((after===null?[]:get().items).map(item=>[item.id,item]));
     for(const item of page.items)items.set(item.id,structuredClone(item));
     set({items:[...items.values()],nextCursor:page.nextCursor,committedRevision:page.committedRevision,loaded:true});return;
    } catch(error) {
     if(owner!==session)return;const message=String(error);
     if(attempt===0&&after!==null&&message.includes("project_snapshot_cursor_stale")){after=null;set({items:[],nextCursor:null,loaded:false});continue;}
     set({error:message});return;
    }
   })().finally(()=>{if(owner===session)set({loading:false});if(inFlight===pending)inFlight=null;complete();});return pending;
  },
 }));
}
export const useProjectDataSnapshotStore=createProjectDataSnapshotStore();

import {create} from "zustand";
import {projectService} from "../services/projectService";
import type {HistoryPageRequest,ProjectHistoryPage,ProjectHistorySummary} from "../types/projectPersistence";

interface HistoryReader {
  listProjectHistory(epoch:number,request:HistoryPageRequest):Promise<ProjectHistoryPage>;
}
interface ProjectHistoryState {
  epoch:number|null;
  committedRevision:number;
  items:ProjectHistorySummary[];
  nextCursor:string|null;
  loaded:boolean;
  loading:boolean;
  error:string|null;
  install(epoch:number,committedRevision:number):void;
  loadNextPage():Promise<void>;
  reset():void;
}

/** History payloads remain on disk; the panel requests bounded summaries only. */
export function createProjectHistoryStore(reader:HistoryReader=projectService) {
  let session=0;
  let inFlight:Promise<void>|null=null;
  return create<ProjectHistoryState>((set,get)=>({
    epoch:null,committedRevision:0,items:[],nextCursor:null,loaded:false,loading:false,error:null,
    install(epoch,committedRevision) {
      if(get().epoch===epoch&&committedRevision<=get().committedRevision) return;
      session++;inFlight=null;
      set({epoch,committedRevision,items:[],nextCursor:null,loaded:false,loading:false,error:null});
    },
    reset() {
      session++;inFlight=null;
      set({epoch:null,committedRevision:0,items:[],nextCursor:null,loaded:false,loading:false,error:null});
    },
    loadNextPage() {
      if(inFlight) return inFlight;
      const initial=get();
      if(initial.epoch===null||(initial.loaded&&!initial.nextCursor)) return Promise.resolve();
      const owner=session;const epoch=initial.epoch;
      let complete!:()=>void;
      const promise=new Promise<void>(resolve=>{complete=resolve;});
      inFlight=promise;set({loading:true,error:null});
      void(async()=>{
        let after=initial.nextCursor;
        for(let attempt=0;attempt<2;attempt++) {
          try {
            const page=await reader.listProjectHistory(epoch,{datasetId:null,after,limit:200});
            if(session!==owner) return;
            if(page.committedRevision<get().committedRevision||(after!==null&&page.committedRevision!==initial.committedRevision)) throw new Error("project_history_cursor_stale");
            const entries=new Map((after===null?[]:get().items).map(item=>[item.id,item]));
            for(const item of page.items) entries.set(item.id,structuredClone(item));
            set({items:[...entries.values()],nextCursor:page.nextCursor,loaded:true,committedRevision:page.committedRevision});
            return;
          } catch(error) {
            if(session!==owner) return;
            const message=error instanceof Error?error.message:String(error);
            if(attempt===0&&after!==null&&message.includes("project_history_cursor_stale")) {
              after=null;set({items:[],nextCursor:null,loaded:false});continue;
            }
            set({error:message});return;
          }
        }
      })().finally(()=>{
        if(session===owner) set({loading:false});
        if(inFlight===promise) inFlight=null;
        complete();
      });
      return promise;
    },
  }));
}
export const useProjectHistoryStore=createProjectHistoryStore();

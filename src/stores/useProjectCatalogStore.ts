import {hydrateProjectDocument,registerProjectDocumentSummaries,hydrateProjectSetting} from "../projectPersistence/documentAdapters";
import {create} from "zustand";
import {projectService} from "../services/projectService";
import type {CatalogPage, CatalogPageRequest, ProjectCommit, ProjectDocumentBody, ProjectDocumentSummary, ProjectOpenSummary, ProjectSettingRecord} from "../types/projectPersistence";

export interface CatalogBodyState {
  status: "unloaded" | "loading" | "ready" | "error";
  revision: number;
  document?: ProjectDocumentBody;
  error?: string;
}
export interface CatalogSettingState {
  status: "unloaded" | "loading" | "ready" | "error";
  revision: number|null;
  record?: ProjectSettingRecord|null;
  error?: string;
}
interface CatalogDependencies {
  service: {
    listProjectCatalog(epoch:number, request:CatalogPageRequest):Promise<CatalogPage>;
    getProjectDocument(epoch:number, id:string, revision:number):Promise<ProjectDocumentBody>;
    getProjectSetting?(epoch:number,key:string):Promise<ProjectSettingRecord|null>;
  };
  onDocumentReady?: (epoch:number, document:ProjectDocumentBody)=>void|boolean;
  onSummariesChanged?: (epoch:number,summaries:readonly ProjectDocumentSummary[],committedRevision?:number,complete?:boolean)=>void;
  onSettingReady?: (epoch:number,key:string,record:ProjectSettingRecord|null)=>void|boolean;
}
export interface ProjectCatalogState {
  epoch:number|null;
  projectId:string|null;
  committedRevision:number;
  summaries:Record<string,ProjectDocumentSummary>;
  bodies:Record<string,CatalogBodyState>;
  settings:Record<string,CatalogSettingState>;
  nextCursor:string|null;
  loadingPage:boolean;
  pageError:string|null;
  installOpenSummary(summary:ProjectOpenSummary):void;
  loadNextPage():Promise<void>;
  ensureDocument(id:string):Promise<ProjectDocumentBody>;
  ensureSetting(key:string):Promise<ProjectSettingRecord|null>;
  invalidateDocument(id:string,revision:number):void;
  applyCommit(commit:ProjectCommit<unknown>):void;
  reset(epoch:number):void;
}
const unloaded=(revision:number):CatalogBodyState=>({status:"unloaded",revision});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
function completion<T>() {
  let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}


/** Catalog membership is independent of the bodies retained by domain stores. */
export function createProjectCatalogStore(deps:CatalogDependencies={service:projectService}) {
  let session=0;
  let catalogVersion=0;
  let pageRevision=0;
  let pageDirty=false;
  let pagePromise:Promise<void>|null=null;
  const requests=new Map<string,Promise<ProjectDocumentBody>>();
  const bodyVersions=new Map<string,number>();
  const settingRequests=new Map<string,Promise<ProjectSettingRecord|null>>();
  const settingVersions=new Map<string,number>();
  const knownSettings=new Map<string,number>();
  const overlays=new Map<string,{revision:number;summary:ProjectDocumentSummary|null}>();

  return create<ProjectCatalogState>((set,get)=>({
    epoch:null,projectId:null,committedRevision:0,summaries:{},bodies:{},settings:{},nextCursor:null,loadingPage:false,pageError:null,
    installOpenSummary(opened) {
      if(opened.header.committedRevision!==opened.directory.committedRevision) throw new Error("project_catalog_revision_mismatch");
      session++;catalogVersion++;pageRevision=opened.directory.committedRevision;pageDirty=false;pagePromise=null;
      requests.clear();bodyVersions.clear();overlays.clear();settingRequests.clear();settingVersions.clear();knownSettings.clear();
      const summaries=Object.fromEntries(opened.directory.items.map(item=>[item.id,structuredClone(item)]));
      set({epoch:opened.epoch,projectId:opened.header.projectId,committedRevision:pageRevision,summaries,settings:{},
        bodies:Object.fromEntries(opened.directory.items.map(item=>[item.id,unloaded(item.revision)])),
        nextCursor:opened.directory.nextCursor,loadingPage:false,pageError:null});
      deps.onSummariesChanged?.(opened.epoch,opened.directory.items,pageRevision,opened.directory.nextCursor===null);
    },
    reset(epoch) {
      session++;catalogVersion++;pageRevision=0;pageDirty=false;pagePromise=null;
      requests.clear();bodyVersions.clear();overlays.clear();settingRequests.clear();settingVersions.clear();knownSettings.clear();
      set({epoch,projectId:null,committedRevision:0,summaries:{},bodies:{},settings:{},nextCursor:null,loadingPage:false,pageError:null});
    },
    ensureDocument(id) {
      const state=get();const summary=state.summaries[id];
      if(!state.projectId||state.epoch===null) return Promise.reject(new Error("project_session_required"));
      if(!summary) return Promise.reject(new Error("project_document_deleted"));
      if(["table","folder","snapshot"].includes(summary.kind)) return Promise.reject(new Error("project_record_requires_typed_loader"));
      const cached=state.bodies[id];
      if(cached?.status==="ready"&&cached.revision===summary.revision&&cached.document) return Promise.resolve(cached.document);
      const existing=requests.get(id);if(existing) return existing;
      const owner=session;const epoch=state.epoch;const revision=summary.revision;const version=bodyVersions.get(id)??0;
      const current=()=>owner===session&&version===(bodyVersions.get(id)??0)&&get().summaries[id]?.revision===revision;
      set(state=>({bodies:{...state.bodies,[id]:{status:"loading",revision}}}));
      const result=completion<ProjectDocumentBody>();const promise=result.promise;
      requests.set(id,promise);
      void(async()=>{
        try {
          const document=await deps.service.getProjectDocument(epoch,id,revision);
          if(!current()) throw new Error("project_document_response_stale");
          if(document.summary.id!==id||document.summary.revision!==revision||document.summary.kind!==summary.kind) throw new Error("project_document_revision_mismatch");
          const body=structuredClone(document);
          if(deps.onDocumentReady?.(epoch,body)===false) throw new Error("project_document_local_changes_pending");
          if(!current()) throw new Error("project_document_response_stale");
          set(state=>({bodies:{...state.bodies,[id]:{status:"ready",revision,document:body}}}));
          return body;
        } catch(error) {
          if(current()) set(state=>({bodies:{...state.bodies,[id]:{status:"error",revision,error:message(error)}}}));
          throw error;
        } finally {if(requests.get(id)===promise) requests.delete(id);}
      })().then(result.resolve,result.reject);
      return promise;
    },
    ensureSetting(key) {
      const state=get();
      if(!state.projectId||state.epoch===null) return Promise.reject(new Error("project_session_required"));
      if(!deps.service.getProjectSetting) return Promise.reject(new Error("project_setting_reader_unavailable"));
      const cached=state.settings[key];
      if(cached?.status==="ready") return Promise.resolve(cached.record??null);
      const existing=settingRequests.get(key);if(existing) return existing;
      const owner=session;const epoch=state.epoch;const version=settingVersions.get(key)??0;
      const current=()=>owner===session&&version===(settingVersions.get(key)??0);
      const result=completion<ProjectSettingRecord|null>();const promise=result.promise;
      settingRequests.set(key,promise);
      set(state=>({settings:{...state.settings,[key]:{status:"loading",revision:knownSettings.get(key)??null}}}));
      void(async()=>{
        try {
          const record=await deps.service.getProjectSetting!(epoch,key);
          if(!current()) throw new Error("project_setting_response_stale");
          if(record&&record.key!==key) throw new Error("project_setting_key_mismatch");
          if((record?.revision??0)<(knownSettings.get(key)??0)) throw new Error("project_setting_response_stale");
          const value=structuredClone(record);
          if(deps.onSettingReady?.(epoch,key,value)===false) throw new Error("project_setting_local_changes_pending");
          if(!current()) throw new Error("project_setting_response_stale");
          if(record) knownSettings.set(key,record.revision);
          set(state=>({settings:{...state.settings,[key]:{status:"ready",revision:record?.revision??null,record:value}}}));
          return value;
        } catch(error) {
          if(current()) set(state=>({settings:{...state.settings,[key]:{status:"error",revision:knownSettings.get(key)??null,error:message(error)}}}));
          throw error;
        } finally {if(settingRequests.get(key)===promise) settingRequests.delete(key);}
      })().then(result.resolve,result.reject);
      return promise;
    },
    invalidateDocument(id,revision) {
      const summary=get().summaries[id];if(!summary||revision<summary.revision) return;
      bodyVersions.set(id,(bodyVersions.get(id)??0)+1);requests.delete(id);
      set(state=>({summaries:{...state.summaries,[id]:{...summary,revision}},bodies:{...state.bodies,[id]:unloaded(revision)}}));
      if(get().epoch!==null) deps.onSummariesChanged?.(get().epoch!,[get().summaries[id]]);
    },
    applyCommit(commit) {
      if(commit.epoch!==get().epoch||!get().projectId) return;
      const summaries={...get().summaries};const bodies={...get().bodies};
      const settings={...get().settings};
      for(const setting of commit.changedSettingRevisions??[]) {
        if(setting.revision<=(knownSettings.get(setting.key)??0)) continue;
        knownSettings.set(setting.key,setting.revision);settingVersions.set(setting.key,(settingVersions.get(setting.key)??0)+1);settingRequests.delete(setting.key);
        settings[setting.key]={status:"unloaded",revision:setting.revision};
      }
      let changed=false;
      const invalidate=(id:string)=>{bodyVersions.set(id,(bodyVersions.get(id)??0)+1);requests.delete(id);};
      for(const id of commit.deletedDirectoryIds??[]) {
        if((overlays.get(id)?.revision??0)>commit.committedRevision) continue;
        overlays.set(id,{revision:commit.committedRevision,summary:null});delete summaries[id];delete bodies[id];invalidate(id);changed=true;
      }
      for(const item of commit.changedDirectoryEntries??[]) {
        if((overlays.get(item.id)?.revision??0)>commit.committedRevision||(summaries[item.id]?.revision??0)>item.revision) continue;
        const previous=summaries[item.id];const summary=structuredClone(item);
        summaries[item.id]=summary;overlays.set(item.id,{revision:commit.committedRevision,summary});
        if(!previous||previous.revision!==item.revision) {invalidate(item.id);bodies[item.id]=unloaded(item.revision);}
        changed=true;
      }
      for(const item of commit.changedDocumentRevisions) {
        const previous=summaries[item.id];
        if(previous&&item.revision>previous.revision) {summaries[item.id]={...previous,revision:item.revision};invalidate(item.id);bodies[item.id]=unloaded(item.revision);changed=true;}
      }
      if(changed&&(get().nextCursor!==null||get().loadingPage)) {pageDirty=true;catalogVersion++;}
      set({summaries,bodies,settings,committedRevision:Math.max(get().committedRevision,commit.committedRevision)});
      deps.onSummariesChanged?.(commit.epoch,commit.changedDirectoryEntries??[],commit.committedRevision);
    },
    loadNextPage() {
      if(pagePromise) return pagePromise;
      const state=get();if(!state.projectId||state.epoch===null) return Promise.reject(new Error("project_session_required"));
      if(!pageDirty&&state.nextCursor===null) return Promise.resolve();
      const owner=session;const epoch=state.epoch;
      set({loadingPage:true,pageError:null});
      const result=completion<void>();const promise=result.promise;
      pagePromise=promise;
      void(async()=>{
        try {
          for(let attempt=0;attempt<2;attempt++) {
            const version=catalogVersion;const after=pageDirty?null:get().nextCursor;
            let page:CatalogPage;
            try {page=await deps.service.listProjectCatalog(epoch,{after,limit:200});}
            catch(error) {
              if(owner!==session) throw new Error("project_catalog_session_stale");
              if(after!==null&&message(error).includes("project_catalog_cursor_stale")&&attempt===0) {pageDirty=true;continue;}
              throw error;
            }
            if(owner!==session) throw new Error("project_catalog_session_stale");
            if(version!==catalogVersion||(after!==null&&page.committedRevision!==pageRevision)||page.committedRevision<get().committedRevision) {pageDirty=true;continue;}
            const summaries=after===null?{}:{...get().summaries};
            for(const item of page.items) summaries[item.id]=structuredClone(item);
            for(const [id,overlay] of overlays) {
              if(overlay.summary===null) delete summaries[id];
              else if(!summaries[id]||summaries[id].revision<overlay.summary.revision) summaries[id]=structuredClone(overlay.summary);
            }
            const bodies:Record<string,CatalogBodyState>={};
            for(const item of Object.values(summaries)) {
              const body=get().bodies[item.id];bodies[item.id]=body?.revision===item.revision?body:unloaded(item.revision);
            }
            pageRevision=page.committedRevision;pageDirty=false;
            set({summaries,bodies,nextCursor:page.nextCursor,committedRevision:pageRevision});
            deps.onSummariesChanged?.(epoch,page.nextCursor===null?Object.values(summaries):page.items,pageRevision,page.nextCursor===null);return;
          }
          throw new Error("project_catalog_changed_during_load");
        } catch(error) {if(owner===session) set({pageError:message(error)});throw error;}
        finally {if(owner===session) set({loadingPage:false});if(pagePromise===promise) pagePromise=null;}
      })().then(result.resolve,result.reject);
      return promise;
    },
  }));
}
export const useProjectCatalogStore=createProjectCatalogStore({service:projectService,
  onDocumentReady:(epoch,document)=>hydrateProjectDocument(document,epoch),
  onSettingReady:(epoch,key,record)=>hydrateProjectSetting(key,record,epoch),
  onSummariesChanged:(epoch,summaries,revision,complete)=>registerProjectDocumentSummaries(summaries,epoch,revision,complete),
});

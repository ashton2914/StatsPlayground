import {getProjectDirectorySummaries} from "../src/projectPersistence/documentAdapters";
import {useWorkflowStore} from "../src/stores/useWorkflowStore";
import {useReportStore} from "../src/stores/useReportStore";
import {useEffect,useState} from "react";
import {mockIPC,clearMocks,mockWindows} from "@tauri-apps/api/mocks";
import App from "../src/App";
import {ProjectV5UiBenchmark} from "../src/benchmarks/ProjectV5UiBenchmark";
import i18n from "../src/i18n";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useUpdatePreferencesStore} from "../src/stores/useUpdatePreferencesStore";
import {nativeProjectLifecycle} from "../src/projectPersistence/nativeLifecycle";
import type {ProjectOpenSummary} from "../src/types/projectPersistence";
export function NativeProjectAppHarness({workflowFixture=false,probeFixture=false,probeFocusDelay=false,probeAdmissionFailure=false}:{workflowFixture?:boolean;probeFixture?:boolean;probeFocusDelay?:boolean;probeAdmissionFailure?:boolean}) {
 const [ready,setReady]=useState(false);
 useEffect(()=>{
  const calls:Array<{command:string;args:any}>=[];
  let directoryNameReads=0;let focusChecks=0;let nativeFocused=false;
  let snapshotFails=false;let commitFails=false;let commitFailureMessage="save temporarily unavailable";
  let finishExtraction:(()=>void)|undefined;
  const lineage={id:"project-lineage",name:"Lineage",graphVersion:1,graphHash:"fixture",nodes:[{nodeType:"operation",id:"operation",kind:"graphGeneration",schemaVersion:"1",inputPorts:[],outputPorts:[]}],edges:[]};
  let holdCommit=false;let finishCommit:(()=>void)|undefined;
  let epoch=0;let current:ProjectOpenSummary;const summaries=new Map<number,ProjectOpenSummary>();
  const open=(name:string,path:string,id=`project-${epoch+1}`):ProjectOpenSummary=>{
   current={project:{name,filePath:path,createdAt:"today"},header:{projectId:probeFixture?"probe-fixture":id,formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:0,createdAt:"today",engineVersion:"test",storageVersion:"1"},epoch:++epoch,writable:true,directory:{items:[{id:"report",kind:"report",name:`${name} report`,folder:"",revision:1,dependencies:[]}],nextCursor:probeFixture?"later-table-page":null,committedRevision:0},settingsRevision:0,datasets:[]};
   summaries.set(epoch,current);return structuredClone(current);
  };
  useProjectStore.setState({project:null,persistence:null,persistenceSnapshot:null,dirty:false,saving:false,readOnly:false});
  useUpdatePreferencesStore.setState({automaticCheck:false});mockWindows("main");
  mockIPC(async(command,args:any)=>{
   calls.push({command,args:structuredClone(args)});
   if(command==="project_v5_enabled") return true;
   if(command==="project_ui_probe_configuration") {nativeFocused=!probeFocusDelay||++focusChecks>=3;return {fixturePath:"/virtual/probe.spprj",fixtureId:"probe-fixture",datasetId:"perf-data",rows:300000,columns:20,samples:1,cacheMode:"cold",nativeWindowFocused:nativeFocused};}
   if(command==="project_ui_probe_begin") {if(probeAdmissionFailure)throw Error("fixture admission unavailable");if(!nativeFocused)throw Error("native window activation pending");return 1;}
   if(command==="project_ui_probe_finish") return {verification:{passed:true}};
   if(command==="project_ui_probe_publish") return "/virtual/probe-catalog-cold.json";
   if(command==="list_recoverable_project_drafts") return [];
   if(command==="create_project_draft_v5") return open("Draft","");
   if(command==="open_project_v5") return open("Second",args.filePath);
   if(command==="get_project_document") {const session=summaries.get(args.epoch)!;return {summary:session.directory.items[0],schemaVersion:1,body:{id:"report",name:session.directory.items[0].name,schemaVersion:1,markdown:`# ${session.project.name} body`,createdAt:"today",updatedAt:"today"}};}
   if(command==="commit_project_records") {
    if(holdCommit) await new Promise<void>(resolve=>{finishCommit=resolve;});
    if(commitFails){commitFails=false;throw new Error(commitFailureMessage);}
    const documents=(args.patch.documents??[]).map((write:any)=>write.document.summary);
    current.header.committedRevision++;
    return {operationId:args.context.operationId,epoch:args.context.expectedEpoch,committedRevision:current.header.committedRevision,value:null,changedDatasetGenerations:[],changedDocumentRevisions:documents.map((document:any)=>({id:document.id,revision:document.revision})),changedDirectoryEntries:documents};
   }
   if(command==="update_cells") throw new Error("invalid mutation");
   if(command==="resolve_project_operation") return {status:"cancelled",operationId:args.context.operationId,epoch:args.context.expectedEpoch,committedRevision:current.header.committedRevision};
   if(command==="add_rows") return {operationId:args.context.operationId,epoch:args.context.expectedEpoch,committedRevision:++current.header.committedRevision,value:null,changedDatasetGenerations:[],changedDocumentRevisions:[]};
   if(command==="get_project_setting") return workflowFixture&&args.key==="lineage"?{key:"lineage",revision:1,value:lineage}:null;
   if(command==="extract_workflow") {
    await new Promise<void>(resolve=>{finishExtraction=resolve;});
    return {id:args.request.workflowId,name:args.request.name,formatVersion:"1",revision:1,inputSlots:[],operations:[],edges:[],outputDeclarations:[],layout:{}};
   }
   if(command==="list_datasets") return [];
   if(command==="snapshot_project_v5") return snapshotFails?{active:null,error:"published copy unavailable",destinationPublished:true}:{active:open("Named",args.filePath,current.header.projectId),error:null,destinationPublished:true};
   if(command==="close_project_v5") return;
   if(command==="plugin:dialog|open") return "/virtual/second.spprj";
   if(command==="plugin:dialog|save") return "/virtual/named.spprj";
   if(command==="get_mcp_server_status") return {running:false};
   return null;
  },{shouldMockEvents:true});
  (window as any).__nativeApp={calls:()=>calls,epoch:()=>useProjectStore.getState().persistence?.snapshot().epoch,
   failMutation:()=>{const owner=useProjectStore.getState().persistence!;void owner.submit({command:"update_cells",payload:{datasetId:"table",updates:[]}}).catch(()=>undefined);void owner.submit({command:"add_rows",payload:{datasetId:"table",count:1}}).catch(()=>undefined);},
   persistenceStatus:()=>useProjectStore.getState().persistence?.snapshot(),
   observeDirectoryReads:()=>{directoryNameReads=0;for(const item of getProjectDirectorySummaries(epoch)??[]){const name=item.name;Object.defineProperty(item,"name",{configurable:true,enumerable:true,get:()=>{directoryNameReads++;return name;}});}},directoryNameReads:()=>directoryNameReads,
   pulseSaving:()=>{const snapshot=useProjectStore.getState().persistenceSnapshot!;useProjectStore.setState({persistenceSnapshot:{...snapshot,status:"saving"},saving:true});},
   failNextCommit:(message?:string)=>{commitFails=true;commitFailureMessage=message??"save temporarily unavailable";},failSnapshot:()=>{snapshotFails=true;},holdCommit:()=>{holdCommit=true;},releaseCommit:()=>{holdCommit=false;finishCommit?.();},editReport:()=>useReportStore.getState().updateMarkdown("report","# Last accepted edit","now"),
   workflows:()=>useWorkflowStore.getState().workflows,releaseExtraction:()=>finishExtraction?.(),switchProject:()=>nativeProjectLifecycle.switchProject("/virtual/second.spprj"),
   requestClose:()=>{void import("@tauri-apps/api/event").then(({emit})=>emit("tauri://close-requested"));},
  };
  void i18n.changeLanguage("en").then(()=>setReady(true));
  return ()=>{holdCommit=false;finishCommit?.();void nativeProjectLifecycle.closeProject().finally(()=>{clearMocks();delete (window as any).__nativeApp;});};
 },[]);
 return ready?(probeFixture?<ProjectV5UiBenchmark/>:<App/>):null;
}

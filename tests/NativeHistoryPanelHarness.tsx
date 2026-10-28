import {useEffect,useRef,useState} from "react";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import i18n from "../src/i18n";
import {HistoryPanel} from "../src/components/HistoryPanel";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useHistoryStore} from "../src/stores/useHistoryStore";
import {useProjectHistoryStore} from "../src/stores/useProjectHistoryStore";
import {useDataStore} from "../src/stores/useDataStore";

export function NativeHistoryPanelHarness({failFirst=false,writable=false,failListenOnce=false,lifecycle=false,archived=false}:{failFirst?:boolean;writable?:boolean;failListenOnce?:boolean;lifecycle?:boolean;archived?:boolean}) {
  const [ready,setReady]=useState(false);const [visible,setVisible]=useState(false);
  const rename=useRef<((id:string)=>void)|null>(null);
  useEffect(()=>{
    const project=useProjectStore.getState();const history=useHistoryStore.getState();const data=useDataStore.getState();
    const requests:any[]=[];const snapshotRequests:any[]=[];const writes:any[]=[];let failures=failFirst?1:0;let listenerFailures=failListenOnce?1:0;let committedRevision=1;
    const snapshots:any[]=[{id:"native-snapshot",name:"Disk checkpoint",createdAt:"2026-10-21T00:00:00Z",revision:1,tableCount:300}];
    mockIPC(async(command,args:any)=>{
      if(command==="plugin:event|listen") {if(listenerFailures-->0)throw new Error("injected listener failure");return 1;}
      if(command==="plugin:event|unlisten")return null;
      if(command==="list_project_data_snapshots") {snapshotRequests.push(structuredClone(args));return {items:snapshots,nextCursor:null,committedRevision};}
      if(command!=="list_project_history") throw new Error(`Unexpected history IPC: ${command}`);
      requests.push(structuredClone(args));
      if(failures-->0) throw new Error("injected history read failure");
      if(archived)return {items:[{id:"imported:2",datasetId:"",operation:"archived",description:"Rename old report",timestamp:"2026-01-01T00:00:00Z",applied:true,generation:0}],nextCursor:null,committedRevision};
      const row=(id:string,applied=true)=>({id,datasetId:lifecycle?"hidden-table":"table",datasetName:lifecycle?"Retired measurements":undefined,operation:lifecycle?(id==="one"?"delete_table":"create_table"):"cell_delta",applied,generation:1});
      return args.request.after===null?{items:[row("one"),row("two",false)],nextCursor:"more",committedRevision}:{items:[row("three")],nextCursor:null,committedRevision};
    });
    const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:707,committedRevision:1,writable,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:(run,delay)=>setTimeout(run,delay),clearTimer:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),onChange:snapshot=>useProjectStore.getState().syncPersistence(snapshot),transport:async<T,>(operation:any,context:any)=>{if(operation.command!=="capture_project_data_snapshot")throw new Error("unexpected history mutation");writes.push(structuredClone(operation));const value={...operation.payload,revision:1,tableCount:300};snapshots.push(value);return {operationId:context.operationId,epoch:707,committedRevision:++committedRevision,value:value as T,changedDatasetGenerations:[],changedDocumentRevisions:[{id:value.id,revision:1}]};}});
    useProjectStore.getState().installPersistence(queue,!writable);
    useHistoryStore.setState({history:[{id:"legacy",description:"Unrelated local history",timestamp:"today"}],snapshots:[],currentIdx:0});
    useDataStore.setState({datasets:[{id:"table",name:"Measurements",sourcePath:null,sourceType:"manual",rowCount:10000000,colCount:2,generation:1,createdAt:"today",updatedAt:"today"}]});
    (window as any).__nativeHistory={requests:()=>requests,snapshotRequests:()=>snapshotRequests,writes:()=>writes};
    void i18n.changeLanguage("en").then(()=>setReady(true));
    return ()=>{clearMocks();void queue.close();useProjectStore.setState(project,true);useHistoryStore.setState(history,true);useDataStore.setState(data,true);useProjectHistoryStore.getState().install(708,0);delete (window as any).__nativeHistory;};
  },[failFirst,writable,failListenOnce,lifecycle,archived]);
  return ready?<div style={{height:600,width:420}}><button onClick={()=>setVisible(true)}>Show history</button>{visible&&<HistoryPanel setBusyMessage={()=>{}} onSnapshotMenu={()=>{}} snapRenameRef={rename}/>}</div>:null;
}

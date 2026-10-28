import {useEffect,useState} from "react";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {DataTableView} from "../src/components/DataTableView";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useDataStore} from "../src/stores/useDataStore";
import {useDatasetFilterStore} from "../src/stores/useDatasetFilterStore";
import i18n from "../src/i18n";
export function ProjectViewportEpochHarness() {
 const [ready,setReady]=useState(false);
 useEffect(()=>{
  const project=useProjectStore.getState();const data=useDataStore.getState();const filters=useDatasetFilterStore.getState();
  const makeQueue=(epoch:number)=>createProjectPersistenceCoordinator({projectId:`project-${epoch}`,epoch,committedRevision:0,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:()=>{throw new Error("viewport reads cannot write");}});
  const first=makeQueue(7);const second=makeQueue(8);let current="old";let reads=0;let completeOld:(()=>void)|undefined;
  useProjectStore.getState().installPersistence(first);useDatasetFilterStore.getState().reset();
  useDataStore.setState({datasets:[{id:"same-table",name:"Measurements",sourceType:"manual",sourcePath:null,rowCount:2,colCount:1,generation:0,createdAt:"same",updatedAt:"same"}],activeDatasetId:"same-table",statusInfo:null});
  mockIPC(async(command,args:any)=>{
   if(command==="get_dataset_generation") return 0;
   if(command==="get_column_descriptors") return [{columnId:"same-column",name:"value",sqlType:"VARCHAR"}];
   if(command==="get_column_display_props") return [];
   if(command==="cancel_table_navigation_request"||command==="release_table_query_session") return;
   if(command==="query_table_window") {
    reads++;const identity=current;
    if(identity==="old") await new Promise<void>(resolve=>{completeOld=resolve;});
    return {columns:["_row_id","value"],columnTypes:["BIGINT","VARCHAR"],rows:[[1,`${identity}-project-row-1`],[2,`${identity}-project-row-2`]],totalRows:2,start:args.request.start,generation:0};
   }
   throw new Error(`Unexpected epoch viewport IPC: ${command}`);
  });
  (window as any).__epochViewport={reads:()=>reads,switch:()=>{current="new";useProjectStore.getState().installPersistence(second);},releaseOld:()=>completeOld?.()};
  void i18n.changeLanguage("en").then(()=>setReady(true));
  return ()=>{completeOld?.();clearMocks();void first.close();void second.close();useProjectStore.setState(project,true);useDataStore.setState(data,true);useDatasetFilterStore.setState(filters,true);delete (window as any).__epochViewport;};
 },[]);
 return ready?<div style={{height:600,width:900}}><DataTableView datasetId="same-table"/></div>:null;
}

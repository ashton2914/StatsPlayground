import {useEffect,useState} from "react";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {DataTableView} from "../src/components/DataTableView";
import {projectViewportBudget} from "../src/projectPersistence/viewportBudget";
import {useDataStore} from "../src/stores/useDataStore";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useDatasetFilterStore} from "../src/stores/useDatasetFilterStore";
import i18n from "../src/i18n";
export function ProjectViewportBudgetHarness() {
 const [ready,setReady]=useState(false);
 useEffect(()=>{
  const data=useDataStore.getState();const project=useProjectStore.getState();const filters=useDatasetFilterStore.getState();
  projectViewportBudget.reset();
  useProjectStore.setState({persistence:null,persistenceSnapshot:null,readOnly:false,dirty:false,saving:false,saveError:null});
  useDatasetFilterStore.getState().reset();
  useDataStore.setState({datasets:[0,1,2].map(index=>({id:`table-${index}`,name:`Table ${index}`,sourceType:"manual",sourcePath:null,rowCount:10000,colCount:1,generation:0,createdAt:"today",updatedAt:"today"})),activeDatasetId:null,statusInfo:null});
  mockIPC((command,args:any)=>{
   if(command==="get_dataset_generation") return 0;
   if(command==="get_column_descriptors") return [{columnId:"value-column",name:"value",sqlType:"VARCHAR"}];
   if(command==="get_column_display_props") return [];
   if(command==="cancel_table_navigation_request"||command==="release_table_query_session") return;
   if(command==="query_table_window") {
    const request=args.request;
    return {columns:["_row_id","value"],columnTypes:["BIGINT","VARCHAR"],rows:Array.from({length:Math.min(request.count,10000-request.start)},(_,index)=>[request.start+index+1,`${request.datasetId}-row-${request.start+index+1}`]),totalRows:10000,start:request.start,generation:0};
   }
   throw new Error(`Unexpected viewport IPC: ${command}`);
  });
  (window as any).__viewportBudget={snapshot:()=>projectViewportBudget.snapshot()};
  void i18n.changeLanguage("en").then(()=>setReady(true));
  return ()=>{clearMocks();useDataStore.setState(data,true);useProjectStore.setState(project,true);useDatasetFilterStore.setState(filters,true);};
 },[]);
 return ready?<div>{[0,1,2].map(index=><section key={index} style={{height:400,width:900}}><DataTableView datasetId={`table-${index}`}/></section>)}</div>:null;
}

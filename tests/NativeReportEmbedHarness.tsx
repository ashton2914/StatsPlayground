import {useEffect,useState} from "react";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {ReportEmbed} from "../src/components/report/ReportEmbed";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore";
import {useDataStore} from "../src/stores/useDataStore";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters";
const runtime={table:{getDatasetGeneration:async()=>9,queryTableWindow:async(request:any)=>{
 (window as any).__nativeReportWindows.push(request);
 return {version:1,datasetId:"table",generation:9,start:0,totalRows:1000000,totalRowsExact:true,columns:["Value"],columnTypes:["DOUBLE"],rows:[[42]],timings:{totalMs:0}} as any;
}}};
export function NativeReportEmbedHarness({failMetadata=false}:{failMetadata?:boolean}) {
 const [ready,setReady]=useState(false);
 useEffect(()=>{
  let failures=failMetadata?1:0;const calls:string[]=[];
  (window as any).__nativeReportWindows=[];(window as any).__nativeReportCalls=calls;
  mockIPC(command=>{calls.push(command);if(command==="list_datasets") {if(failures-->0) throw new Error("injected metadata failure");return [{id:"table",name:"Unopened source",sourcePath:null,sourceType:"manual",rowCount:1000000,colCount:1,generation:9,createdAt:"today",updatedAt:"today"}];}throw new Error(`Unexpected ${command}`);});
  useDataStore.setState({datasets:[]});
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:303,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:async()=>{throw new Error("read-only embed must not write");}});
  useProjectStore.getState().installPersistence(queue);
  const release=createProjectDocumentAdapters({coordinator:queue,summaries:[]}).activate();
  useProjectCatalogStore.getState().installOpenSummary({project:{name:"Project",filePath:"project.spprj",createdAt:"today"},epoch:303,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:1,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[{id:"table",kind:"table",name:"Unopened source",folder:"",revision:1,dependencies:[]}],nextCursor:null,committedRevision:1},settingsRevision:0});
  setReady(true);
  return ()=>{release();void queue.close();useProjectStore.getState().installPersistence(null);useProjectCatalogStore.getState().reset(304);useDataStore.setState({datasets:[]});clearMocks();};
 },[]);
 return ready?<ReportEmbed dependency={{kind:"table",documentId:"table"}} runtime={runtime}/>:null;
}

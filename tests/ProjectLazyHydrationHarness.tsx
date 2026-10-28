import {nativeProjectLifecycle} from "../src/projectPersistence/nativeLifecycle";
import {ProjectMigrationError} from "../src/projectPersistence/lifecycle";
import {projectService} from "../src/services/projectService";
import {useEffect,useState} from "react";
import {clearMocks,mockIPC} from "@tauri-apps/api/mocks";
import {createDefaultGraph2DState,createDefaultGraph3DState,createDefaultMultivariateGraphState} from "../src/components/graphBuilder/graphBuilderMode";
import {Workspace} from "../src/components/Workspace";
import i18n from "../src/i18n";
import {useProjectStore} from "../src/stores/useProjectStore";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore";
import {useDatasetFilterStore} from "../src/stores/useDatasetFilterStore";
import {useHistoryStore} from "../src/stores/useHistoryStore";
import {useDataStore} from "../src/stores/useDataStore";
import {useReportStore} from "../src/stores/useReportStore";
import {useAnalysisStore} from "../src/stores/useAnalysisStore";
import {useGraphBuilderStore} from "../src/stores/useGraphBuilderStore";
import {useGraphBuilderNewStore} from "../src/stores/useGraphBuilderNewStore";
import {useTabulateStore} from "../src/stores/useTabulateStore";
import {useTableTransformStore} from "../src/stores/useTableTransformStore";
import {useWorkflowStore} from "../src/stores/useWorkflowStore";
import {useFolderStore} from "../src/stores/useFolderStore";
import {useWorkspaceSelectionStore} from "../src/stores/useWorkspaceSelectionStore";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator";
import {createProjectDocumentAdapters,applyCommittedProjectEffects} from "../src/projectPersistence/documentAdapters";
import type {ProjectDocumentBody,ProjectDocumentSummary,ProjectRecordPatch} from "../src/types/projectPersistence";
import type {DatasetMeta} from "../src/types/data";
const project={name:"Lazy project",filePath:"/virtual/lazy.spprj",createdAt:"2026-10-19"};
const dataset:DatasetMeta={id:"table",name:"Measurements",sourceType:"manual",sourcePath:null,rowCount:10000000,colCount:2,generation:0,createdAt:"today",updatedAt:"today"};
const summaries:ProjectDocumentSummary[]=[
  {id:"table",kind:"table",name:"Measurements",folder:"",revision:1,dependencies:[]},
  {id:"report",kind:"report",name:"Quarterly report",folder:"Reports",revision:1,dependencies:[]},
  {id:"analysis",kind:"analysis",analysisKind:"distribution",name:"Distribution",folder:"Reports",revision:1,dependencies:["table"]},
  {id:"graph",kind:"graphNew",name:"Overview",folder:"Charts",revision:1,dependencies:["table"]},
  {id:"folder:Empty",kind:"folder",name:"Empty",folder:"",revision:1,dependencies:[]},
];
const report:ProjectDocumentBody={summary:summaries[1],schemaVersion:1,body:{id:"report",name:"Quarterly report",schemaVersion:1,markdown:"# Loaded on demand\n\nOnly the selected document was read.",createdAt:"today",updatedAt:"today"}};
export function ProjectLazyHydrationHarness({failFirst=false,withTransform=false,withFilter=false,pagedCatalog=false,withWorkflow=false,withLifecycle=false,withMigration=false,confirmMigration=true}:{failFirst?:boolean;withTransform?:boolean;withFilter?:boolean;pagedCatalog?:boolean;withWorkflow?:boolean;withLifecycle?:boolean;withMigration?:boolean;confirmMigration?:boolean}) {
  const [ready,setReady]=useState(false);
  useEffect(()=>{
    const stores=[useDatasetFilterStore,useDataStore,useProjectStore,useReportStore,useAnalysisStore,useGraphBuilderStore,useGraphBuilderNewStore,useTabulateStore,useTableTransformStore,useWorkflowStore,useFolderStore,useWorkspaceSelectionStore,useHistoryStore] as const;
    const previous=stores.map(store=>store.getState());
    const previousSwitch=nativeProjectLifecycle.switchProject;
    const previousMigrate=nativeProjectLifecycle.migrateProject;
    const conversion={prompts:[] as string[],requests:[] as unknown[],cancelCalls:0};
    let rejectMigration:((error:Error)=>void)|undefined;
    if(withMigration) {
      nativeProjectLifecycle.switchProject=async()=>{throw new Error("project_requires_migration");};
      nativeProjectLifecycle.migrateProject=async(source,destination,migrationId)=>{
        conversion.requests.push({source,destination,migrationId});
        return new Promise<never>((_,reject)=>{rejectMigration=reject;});
      };
    }
    let reads=0;let metadataReads=0;let failures=failFirst?1:0;let held=!failFirst;let releaseBody:(()=>void)|undefined;
    const server=new Map(summaries.map(item=>[item.id,structuredClone(item)]));let revision=1;const mutations:ProjectRecordPatch[]=[];
    const lifecycleId="00000000-0000-4000-8000-000000000001";let lifecycleApplied=true;let lifecycleRevision=1;let tableGeneration=0;const historyCalls:any[]=[];let historyReadFailure=false;let cellValue=1;const cellMutations:any[]=[];
    if(withLifecycle) {server.delete("table");server.delete("graph");}
    const serverBodies=new Map([["report",structuredClone(report)]]);
    let savedRunCount=73;const runStateReads:any[]=[];const settingReads:string[]=[];const windowRequests:any[]=[];const pageReads:any[]=[];let pageFailures=pagedCatalog?1:0;
    const savedLineage={id:"project-lineage",name:"Lineage",graphVersion:0,graphHash:"",nodes:[{nodeType:"operation",id:"transform-op",kind:"tableTransform",schemaVersion:"1",documentRef:{kind:"tableTransform",id:"transform"},inputPorts:[],outputPorts:[]},{nodeType:"operation",id:"retained-op",kind:"tableTransform",schemaVersion:"1",documentRef:{kind:"tableTransform",id:"retained"},inputPorts:[],outputPorts:[]}],edges:[]};
    const transformSummary:ProjectDocumentSummary={id:"transform",kind:"transform",name:"Reusable sort",folder:"",revision:1,dependencies:["table"]};
    if(withTransform) {
      server.set("transform",transformSummary);
      serverBodies.set("transform",{summary:transformSummary,schemaVersion:1,body:{id:"transform",name:"Reusable sort",formatVersion:"1",revision:1,operation:{kind:"sort",sortColumns:[{column:"value",direction:"ascending"}]},inputSlots:[{role:"source",schemaContract:{schemaFingerprint:"schema",columns:[]}}],output:{tableDocumentId:"output",name:"Sorted output"}}});
    }
    if(withWorkflow) {
      const summary:ProjectDocumentSummary={id:"saved-workflow",kind:"workflow",name:"Saved workflow",folder:"",revision:1,dependencies:[]};
      server.set(summary.id,summary);
      serverBodies.set(summary.id,{summary,schemaVersion:1,body:{id:summary.id,name:summary.name,formatVersion:"1",revision:1,inputSlots:[{id:"input",name:"Source",outputPort:{id:"input:output",name:"output",payloadKind:"table"},schemaContract:{schemaFingerprint:"schema",columns:[{name:"value",canonicalDuckdbType:"DOUBLE",required:true,requiredByOperationIds:[]}]}}],operations:[],edges:[],outputDeclarations:[]}});
    }
    let holdCommit=false;let finishCommit:(()=>void)|undefined;
    mockIPC(async(command,args:any)=>{
      if(command==="plugin:dialog|open")return withMigration?"/virtual/old.spprj":"/virtual/import.spgh";
      if(command==="plugin:dialog|save")return "/virtual/old-v5.spprj";
      if(command==="plugin:dialog|message") {conversion.prompts.push(args.message);return confirmMigration?"Create converted copy":"Cancel";}
      if(command==="preflight_project_migration")return {formatVersion:"4.0.0",destination:args.destinationPath??"/virtual/old-v5.spprj",destinationExists:false,requiredWriter:1};
      if(command==="cancel_project_migration") {conversion.cancelCalls++;rejectMigration?.(new ProjectMigrationError("Cancelled: project conversion"));return true;}
      if(command==="import_graph")return {id:"graph",name:"Imported graph",sourceDatasetId:"not-present",mode:"2d",modeStates:{twoD:createDefaultGraph2DState(),threeD:createDefaultGraph3DState(),multivariate:createDefaultMultivariateGraphState()},sampling:{mode:"full"},createdAt:"2026-01-01"};
      if(command==="update_cells") {
        if(args.expectedGeneration!==tableGeneration||args.context.expectedRevision!==revision)throw new Error("project_generation_stale");
        cellMutations.push(structuredClone(args));cellValue=Number(args.updates[0].value);tableGeneration++;
        const table=server.get("table")!;
        return {operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:tableGeneration,changedDatasetGenerations:[{id:"table",generation:tableGeneration}],changedDatasetMetadata:[{...dataset,generation:tableGeneration}],changedDocumentRevisions:[{id:"table",revision:table.revision}],changedDirectoryEntries:[table],changedHistoryEntries:[{id:crypto.randomUUID(),datasetId:"table",operation:"cell_delta",applied:true,generation:tableGeneration}]};
      }
      if(command==="get_project_history_frontier") {if(historyReadFailure)throw new Error("injected history metadata failure");return {committedRevision:revision,entry:{id:lifecycleId,datasetId:"table",operation:"delete_table",applied:lifecycleApplied,generation:tableGeneration}};}
      if(command==="get_project_table_lifecycle_event")return {id:lifecycleId,datasetId:"table",operation:"delete_table",applied:lifecycleApplied,revision:lifecycleRevision,historyOrdinal:1,projectRevision:revision,datasetGeneration:lifecycleApplied?null:tableGeneration};
      if(command==="apply_project_table_lifecycle") {
        if(!withLifecycle||args.eventId!==lifecycleId||args.eventRevision!==lifecycleRevision||args.context.expectedRevision!==revision)throw new Error("project_history_stale");
        historyCalls.push(structuredClone(args));lifecycleApplied=!args.undo;lifecycleRevision++;
        const entries=args.undo?[{...summaries[0],revision:lifecycleRevision},{...summaries[3],revision:lifecycleRevision}]:[];
        if(args.undo){tableGeneration++;for(const entry of entries)server.set(entry.id,entry);}else{server.delete("table");server.delete("graph");}
        return {operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:null,changedDatasetGenerations:args.undo?[{id:"table",generation:tableGeneration}]:[],changedDatasetMetadata:args.undo?[{...dataset,generation:tableGeneration}]:[],changedDocumentRevisions:entries.map(item=>({id:item.id,revision:item.revision})),changedDirectoryEntries:entries,deletedDirectoryIds:args.undo?[]:["table","graph"],changedHistoryEntries:[{id:lifecycleId,datasetId:"table",operation:"delete_table",applied:lifecycleApplied,generation:tableGeneration}]};
      }
      if(command==="list_project_catalog") {
        pageReads.push(structuredClone(args.request));
        if(pageFailures-->0) throw new Error("injected catalog page failure");
        return {items:[{id:"later-report",kind:"report",name:"Later report",folder:"Later",revision:1,dependencies:[]}],nextCursor:null,committedRevision:1};
      }
      if(command==="get_project_workflow_run_state") {
        runStateReads.push(structuredClone(args));
        return {workflowId:"saved-workflow",workflowRevision:1,committedRevision:revision,totalCount:savedRunCount,latestRunId:"saved-run",latestOutputBindings:[]};
      }
      if(command==="get_columns") return [["value","DOUBLE"],["group","VARCHAR"]];
      if(command==="get_dataset_generation") return tableGeneration;
      if(command==="get_column_descriptors") return [{columnId:"value-column",name:"value",sqlType:"DOUBLE"},{columnId:"group-column",name:"group",sqlType:"VARCHAR"}];
      if(command==="get_column_display_props") return [];
      if(command==="prepare_table_query_session") {windowRequests.push(structuredClone(args.request));return {sessionId:"filtered",state:"ready",totalRows:2,progress:1};}
      if(command==="release_table_query_session"||command==="cancel_table_navigation_request") return;
      if(command==="query_table_window"||command==="query_table_navigation_window") {
        const request=args.request;windowRequests.push(structuredClone(request));
        return {version:1,requestId:request.requestId,datasetId:"table",generation:tableGeneration,start:request.start,totalRows:2,totalRowsExact:true,sessionId:request.sessionId,columns:["_row_id","value","group"],columnTypes:["BIGINT","DOUBLE","VARCHAR"],rows:request.start===0?[[1,cellValue,"A"],[2,2,"B"]]:[],timings:{totalMs:0}};
      }
      if(command==="list_datasets") {metadataReads++;return withLifecycle&&lifecycleApplied?[]:[{...dataset,generation:tableGeneration}];}
      if(command==="commit_project_records") {
        if(holdCommit) await new Promise<void>(resolve=>{finishCommit=resolve;});
        const patch=args.patch as ProjectRecordPatch;
        if(args.context.expectedRevision!==revision) throw new Error("project_revision_stale");
        mutations.push(structuredClone(patch));const changed:ProjectDocumentSummary[]=[];
        for(const write of patch.documents??[]) {
          if((server.get(write.document.summary.id)?.revision??null)!==write.expectedRevision) throw new Error("project_document_revision_stale");
          server.set(write.document.summary.id,structuredClone(write.document.summary));serverBodies.set(write.document.summary.id,structuredClone(write.document));changed.push(write.document.summary);
        }
        for(const move of patch.directoryMoves??[]) {
          const current=server.get(move.id);if(!current||current.revision!==move.expectedRevision) throw new Error("project_document_revision_stale");
          const next={...current,name:move.name??current.name,folder:move.folder,revision:current.revision+1};server.set(move.id,next);changed.push(next);
        }
        for(const write of patch.settings??[]) {
          const expected=write.key==="lineage"?3:write.key==="transformBinding:transform"?1:null;
          if(write.expectedRevision!==expected) throw new Error("project_setting_revision_stale");
        }
        for(const id of patch.deletedDocumentIds??[]) server.delete(id);
        return {operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:null,changedDatasetGenerations:[],changedDocumentRevisions:changed.map(item=>({id:item.id,revision:item.revision})),changedDirectoryEntries:changed,changedSettingRevisions:(patch.settings??[]).map(write=>({key:write.key,revision:(write.expectedRevision??0)+1})),deletedDirectoryIds:patch.deletedDocumentIds??[]};
      }
      if(command==="get_project_setting") {
        settingReads.push(args.key);
        if(args.key==="lineage") return {key:args.key,revision:3,value:savedLineage};
        if(withFilter&&args.key==="filter:table") return {key:args.key,revision:1,value:[{id:"saved-filter",op:"AND",rule:{kind:"continuous",field:{name:"value",columnId:"value-column",type:"continuous"},min:0,max:5}}]};
        if(args.key==="transformBinding:transform") return {key:args.key,revision:1,value:{definitionId:"transform",definitionRevision:1,inputs:[{role:"source",tableDocumentId:"table"}],outputGeneration:4,lastRun:{definitionRevision:1,status:"succeeded",outputGeneration:4},schemaReports:[]}};
        return null;
      }
      if(command==="get_project_document") {
        reads++;if(failures-->0) throw new Error("injected read failure");
        if(held) await new Promise<void>(resolve=>{releaseBody=resolve;});
        const summary=server.get(args.id);const body=serverBodies.get(args.id);if(!summary||!body) throw new Error("project_document_deleted");
        return structuredClone({...body,summary,body:{...(body.body as object),name:summary.name}});
      }
      if(command==="init_project") return project;
      throw new Error(`Unexpected lazy Workspace IPC: ${command}`);
    },{shouldMockEvents:true});
    useDatasetFilterStore.getState().reset();useReportStore.getState().reset();useAnalysisStore.getState().reset();useGraphBuilderStore.getState().reset();useGraphBuilderNewStore.getState().reset();useTabulateStore.getState().reset();useTableTransformStore.getState().reset();useWorkflowStore.getState().reset();useWorkspaceSelectionStore.getState().clear();
    useFolderStore.getState().reset();
    useFolderStore.setState({folders:["Charts","Empty","Reports"],reportFolders:{report:"Reports"},analysisFolders:{analysis:"Reports"},graphNewFolders:{graph:"Charts"}});
    useProjectStore.setState({project,dirty:false,readOnly:false,saving:false,saveError:null});
    useDataStore.setState({datasets:withLifecycle?[]:[dataset],activeDatasetId:null,statusInfo:null});
    if(withLifecycle)useHistoryStore.getState().reset();
    const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:(run,delay)=>setTimeout(run,delay),clearTimer:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
      onCommit:(commit,source)=>{applyCommittedProjectEffects(commit,source);useProjectCatalogStore.getState().applyCommit(commit);},onChange:snapshot=>useProjectStore.getState().syncPersistence(snapshot),transport:projectService.commitOperation});
    useProjectStore.getState().installPersistence(queue);
    const adapters=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapters.activate();
    useProjectCatalogStore.getState().installOpenSummary({project,epoch:7,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:1,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:[...server.values()],nextCursor:pagedCatalog?"page2":null,committedRevision:1},settingsRevision:1});
    (window as any).__projectLazy={migration:()=>conversion,snapshot:()=>({reads,reports:useReportStore.getState().items.length,analyses:useAnalysisStore.getState().items.length,pending:queue.snapshot().pendingSequence-queue.snapshot().acknowledgedSequence}),metadataReads:()=>metadataReads,runStateReads:()=>runStateReads,appendWorkflowRun:()=>{savedRunCount++;const state=useWorkflowStore.getState();useWorkflowStore.getState().loadFromProject({workflows:state.workflows,logicalFolders:state.logicalFolders,lineageGraph:state.lineageGraph,workflowRuns:[...state.workflowRuns,{id:"new-run",workflowId:"saved-workflow",workflowRevision:1,status:"failed"} as any]});},settingReads:()=>settingReads,pageReads:()=>pageReads,windowRequests:()=>windowRequests,historyCalls:()=>historyCalls,cellMutations:()=>cellMutations,failHistoryRead:(value:boolean)=>{historyReadFailure=value;},setReadOnly:(value:boolean)=>useProjectStore.setState({readOnly:value}),mutations:()=>mutations,createReport:()=>useReportStore.getState().addItem({id:"draft",name:"New draft",schemaVersion:1,markdown:"# New local document",createdAt:"today",updatedAt:"today"}),holdCommit:()=>{holdCommit=true;},releaseCommit:()=>{holdCommit=false;finishCommit?.();},release:()=>{held=false;releaseBody?.();}};
    void i18n.changeLanguage("en").then(()=>setReady(true));
    return ()=>{
      nativeProjectLifecycle.switchProject=previousSwitch;nativeProjectLifecycle.migrateProject=previousMigrate;rejectMigration?.(new ProjectMigrationError("Cancelled: harness disposed"));
      holdCommit=false;releaseBody?.();finishCommit?.();release();useProjectCatalogStore.getState().reset(8);void queue.close();
      clearMocks();stores.forEach((store,index)=>(store.setState as any)(previous[index],true));delete (window as any).__projectLazy;
    };
  },[failFirst,withTransform,withFilter,pagedCatalog,withWorkflow,withLifecycle,withMigration,confirmMigration]);
  return ready?<Workspace/>:null;
}

import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createProjectCommandHandlers} from "../src/applicationCommands/projectCommands.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
import {createProjectDocumentAdapters} from "../src/projectPersistence/documentAdapters.ts";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import type {ProjectDocumentSummary} from "../src/types/projectPersistence.ts";
const summary=(id:string,kind:ProjectDocumentSummary["kind"]):ProjectDocumentSummary=>({id,kind,name:id,folder:"",revision:1,dependencies:[],...(kind==="analysis"?{analysisKind:"distribution" as const}:{})});
const first=[summary("report","report")];
const later=[summary("second-report","report"),summary("analysis","analysis"),summary("graph","graph"),summary("transform","transform"),summary("tabulate","tabulate"),summary("table","table"),summary("folder","folder"),summary("graph-new","graphNew"),summary("workflow","workflow")];
let pages=0;let bodies=0;let tableLists=0;let windows=0;
const table={id:"table",name:"Unopened table",sourcePath:"/private/source.csv",sourceType:"csv",rowCount:1000000,colCount:1,generation:7,createdAt:"today",updatedAt:"today"};
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
mockIPC((command,args:any)=>{
  if(command==="list_project_catalog") {pages++;assert.equal(args.request.limit,200);return {items:later,nextCursor:null,committedRevision:1};}
  if(command==="get_project_document") {bodies++;assert.equal(args.id,"report");return {summary:first[0],schemaVersion:1,body:{id:"report",name:"report",schemaVersion:1,markdown:"/private/data/secret.csv",createdAt:"today",updatedAt:"today"}};}
  if(command==="list_datasets") {tableLists++;return [table];}
  if(command==="get_columns") return [["Value","DOUBLE"]];
  if(command==="get_column_display_props") return [];
  if(command==="get_dataset_generation") return 7;
  if(command==="query_table_window") {windows++;assert.equal(args.request.count,2);return {columns:["_row_id","Value"],columnTypes:["BIGINT","DOUBLE"],rows:[[1,41],[2,42]],totalRows:1000000,start:0,generation:7};}
  throw new Error(`Unexpected project query IPC: ${command}`);
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:909,committedRevision:1,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:()=>{throw new Error("queries cannot write");}});
useProjectStore.setState({project:{name:"Project",filePath:"/private/project.spprj",createdAt:"today"},dirty:false,readOnly:false,projectRevision:1});
useProjectStore.getState().installPersistence(queue);
useReportStore.getState().reset();
const adapter=createProjectDocumentAdapters({coordinator:queue,summaries:[]});const release=adapter.activate();
useProjectCatalogStore.getState().installOpenSummary({project:useProjectStore.getState().project!,epoch:909,writable:true,header:{projectId:"project",formatVersion:"5.0.0",minimumReader:1,minimumWriter:1,committedRevision:1,createdAt:"today",engineVersion:"test",storageVersion:"test"},directory:{items:first,nextCursor:"more",committedRevision:1},settingsRevision:0});
try {
  const handlers=createProjectCommandHandlers();
  const inspected=await handlers.inspectProject({includeCapabilities:true});
  assert.deepEqual(inspected.counts,{tables:1,tableTransforms:1,graphs:1,analyses:1,tabulates:1,reports:2,graphsNew:1,workflows:1});
  assert.equal(pages,1);assert.equal(bodies,0);
  const listed=await handlers.listProjectDocuments({limit:200});
  assert.equal(listed.items.length,8);assert.equal(listed.nextCursor,null);assert.equal(listed.items.find(item=>item.kind==="analysis")?.analysisKind,"distribution");assert.equal(pages,1);assert.equal(bodies,0);
  assert.deepEqual((await handlers.listProjectDocuments({kind:"report"})).items.map(item=>item.id),["report","second-report"]);
  assert.equal(useReportStore.getState().items.length,0,"listing unloaded documents must not hydrate them");
  const read=await handlers.getProjectDocument({kind:"report",id:"report"});
  assert.equal((read.document as {markdown:string}).markdown,"[redacted-path]");
  assert.equal(bodies,1);await handlers.getProjectDocument({kind:"report",id:"report"});assert.equal(bodies,1);
  await assert.rejects(handlers.getProjectDocument({kind:"analysis",id:"report"}),error=>error instanceof Error&&error.message.includes("not found"));
  useDataStore.setState({datasets:[]});
  const tables=await handlers.listProjectTables({});
  assert.equal(tables.items[0].name,"Unopened table");
  assert.equal(tables.items[0].sourceName,"source.csv");
  assert.equal("sourcePath" in tables.items[0],false);
  const described=await handlers.describeProjectTable({datasetId:"table"});
  assert.equal(described.dataset.rowCount,1000000);assert.equal(described.generation,7);
  assert.equal(windows,0,"metadata queries must never fetch rows");
  const preview=await handlers.describeProjectTable({datasetId:"table",preview:{limit:2}});
  assert.deepEqual(preview.preview?.rows.map(row=>row.cells),[[{colIndex:0,value:41}],[{colIndex:0,value:42}]],"MCP preview cells must match described visible columns, excluding hidden row IDs");
  assert.equal(tableLists,3);assert.deepEqual(useDataStore.getState().datasets,[],"querying metadata must not hydrate stores");
  const hydrated:string[]=[];
  const extended=createProjectCommandHandlers({
    hydrateNativeDocument:async id=>{hydrated.push(id);},
    listGraphsNew:()=>[{id:"graph-new",name:"New graph",datasetId:"table"}] as any,
    listWorkflows:()=>[{id:"workflow",name:"Workflow"}] as any,
  });
  assert.equal((await extended.getProjectDocument({kind:"graphNew",id:"graph-new"})).id,"graph-new");
  assert.equal((await extended.getProjectDocument({kind:"workflow",id:"workflow"})).id,"workflow");
  assert.deepEqual(hydrated,["graph-new","workflow"]);
  assert.equal(bodies,1,"unrelated bodies stay unloaded");
  const switching=createProjectCommandHandlers({getColumns:async()=>{
    useProjectStore.getState().installPersistence(null);return [["Other project","VARCHAR"]];
  }});
  await assert.rejects(switching.describeProjectTable({datasetId:"table"}), /Project changed/);
  useProjectStore.getState().installPersistence(queue);
  assert.equal(queue.captureBarrier(),0);
  console.log("project catalog commands: complete metadata counts/listing, selected-body loading and path redaction passed");
} finally {release();clearMocks();useProjectCatalogStore.getState().reset(910);await queue.close();useProjectStore.getState().installPersistence(null);useReportStore.getState().reset();delete (globalThis as any).window;}

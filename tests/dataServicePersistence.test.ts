import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { dataService } from "../src/services/dataService.ts";
import { projectService } from "../src/services/projectService.ts";
import { createProjectPersistenceCoordinator } from "../src/projectPersistence/coordinator.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import type { ProjectWriteContext } from "../src/types/projectPersistence.ts";

Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
const writes:Array<{command:string;args:Record<string,unknown>}>=[];
let revision=10;
mockIPC((command,args) => {
  if(command==="get_dataset_generation") return 5;
  if(command==="get_column_descriptors") return [{columnId:"column-value",name:"value",sqlType:"DOUBLE"}];
  if(command==="get_column_display_props") { assert.equal(args?.epoch,7); return [{colIndex:0,width:144}]; }
  writes.push({command,args:structuredClone(args ?? {})});
  const context=args?.context as ProjectWriteContext|undefined;
  if(!context) return 5;
  assert.equal(context.expectedRevision,revision);
  const generation=command==="update_cells"?6:command==="clear_cells"?7:command==="add_rows"?8:command==="delete_rows_with_change_set"?9:10;
  const creation=["import_file","create_table_from_sql_query","create_managed_table","create_table_from_rows"].includes(command);
  const id=creation?command:"table";
  const value=command==="create_managed_table"?{dataset:{id,name:"Created",rowCount:2,generation:0},generation:0,columns:[]}:creation?{id,name:"Created",rowCount:2,generation:0}:command==="clear_cells"||command==="apply_table_change_set"?null:command==="add_rows"?{rowIds:[1,2,3],generation,rowCount:3,changeSetId:"add"}:command==="delete_rows_with_change_set"?{rowIds:[2],generation,rowCount:2,changeSetId:"delete"}:generation;
  return {operationId:context.operationId,epoch:7,committedRevision:++revision,value,
    changedDatasetGenerations:[{id,generation:creation?0:generation}],changedDocumentRevisions:[]};
});
try {
  const updates=[{rowId:1,columnName:"value",value:"7"}];
  assert.equal(await dataService.updateCells("table",updates,5),5);
  const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:revision,now:()=>0,
    newOperationId:()=>crypto.randomUUID(),setTimer:()=>1,clearTimer:()=>{},transport:projectService.commitOperation});
  useProjectStore.getState().installPersistence(queue);
  assert.equal(await dataService.updateCells("table",updates,5),6,"native cell writes return the acknowledged generation");
  assert.equal((writes[1].args.context as ProjectWriteContext).expectedProjectId,"project");
  await dataService.clearCells("table",[{rowId:1,columnName:"value"}]);
  assert.equal((writes[2].args.context as ProjectWriteContext).datasetGenerations![0].generation,6);
  const added=await dataService.addRows("table",3,null,7);
  assert.equal(added.rowCount,3);
  const deleted=await dataService.deleteRowsWithChangeSet("table",[2],8);
  assert.equal(deleted.rowCount,2);
  assert.equal((writes[4].args.context as ProjectWriteContext).datasetGenerations![0].generation,8);
  await dataService.applyTableChangeSet("delete",true,"table");
  assert.equal((writes[5].args.context as ProjectWriteContext).datasetGenerations![0].generation,9);
  const imported=await dataService.importFile("external.csv");
  assert.equal(imported.id,"import_file");
  const queried=await dataService.createTableFromSqlQuery("SELECT 7 AS value","Query");
  assert.equal(queried.id,"create_table_from_sql_query");
  assert.equal((writes[7].args.context as ProjectWriteContext).expectedProjectId,"project");
  const managed=await dataService.createManagedTable({name:"Manual",columns:[{name:"value",sqlType:"DOUBLE",display:{width:144}}],rows:[[1.25],[null]]});
  assert.equal(managed.dataset.id,"create_managed_table");
  assert.equal((await dataService.getColumnDisplayProps(managed.dataset.id))[0].width,144);
  const rows=await dataService.createTableFromRows({name:"Rows",columnNames:["value"],columnTypes:["DOUBLE"],rows:[[3.5]]});
  assert.equal(rows.id,"create_table_from_rows");
  await dataService.createTable("Empty",["value"],["DOUBLE"]);
  assert.equal(writes[10].command,"create_table_from_rows","native empty-table alias must use the transactional creator");
  await dataService.setColumnDisplayProps("table",[{colIndex:0,width:177}]);
  const displayWrite=writes.at(-1)!;
  assert.equal(displayWrite.command,"set_column_display_props");
  assert.deepEqual(displayWrite.args.columnIds,["column-value"],"display indices must be bound to stable column identities");
  assert.equal((displayWrite.args.context as ProjectWriteContext).expectedEpoch,7);
  await dataService.renameDataset("table","Renamed table");
  assert.equal(writes.at(-1)!.command,"rename_dataset");
  assert.equal((writes.at(-1)!.args.context as ProjectWriteContext).expectedEpoch,7);
  assert.equal(queue.snapshot().acknowledgedSequence,12);
  await queue.close();
  console.log("data service persistence: legacy compatibility and native cell/row receipts passed");
} finally { useProjectStore.getState().installPersistence(null); clearMocks(); delete (globalThis as {window?:unknown}).window; }

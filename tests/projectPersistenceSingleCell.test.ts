import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import {projectService} from "../src/services/projectService.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {createProjectPersistenceCoordinator} from "../src/projectPersistence/coordinator.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let revision=1;let generation=3;let native=true;let generationReads=0;const writes:any[]=[];
mockIPC((command,args:any)=>{
 if(command==="get_dataset_generation") {generationReads++;return generation;}
 if(command==="update_cell") {assert.ok(!native,"native inline cell edits must use the receipt-protected batch writer");writes.push({command,args});return;}
 assert.equal(command,"update_cells");if(args.expectedGeneration!==undefined)assert.equal(args.expectedGeneration,generation);assert.deepEqual(args.context.datasetGenerations,[{id:"table",generation}]);assert.equal(args.updates.length,1);writes.push(structuredClone({command,args}));
 return {operationId:args.context.operationId,epoch:7,committedRevision:++revision,value:++generation,changedDatasetGenerations:[{id:"table",generation}],changedDocumentRevisions:[]};
});
const queue=createProjectPersistenceCoordinator({projectId:"project",epoch:7,committedRevision:1,now:()=>0,newOperationId:()=>crypto.randomUUID(),setTimer:()=>0,clearTimer:()=>{},transport:projectService.commitOperation});
try {
 useProjectStore.getState().installPersistence(queue);
 assert.equal(await dataService.updateCell("table",1,"value","7",3),undefined);
 assert.equal(generationReads,0,"an editor must bind the visible generation without refreshing it behind the user's edit");assert.deepEqual(writes[0].args.updates,[{rowId:1,columnName:"value",value:"7"}]);
 await dataService.updateCell("table",1,"value","",4);assert.deepEqual(writes[1].args.updates,[{rowId:1,columnName:"value",value:null}]);
 await dataService.updateCell("table",1,"value","8");assert.equal(generationReads,1,"callers without a visible generation retain a metadata-only compatibility lookup");
 await queue.close();native=false;useProjectStore.getState().installPersistence(null);
 await dataService.updateCell("table",1,"value","9");assert.equal(writes[3].command,"update_cell");assert.deepEqual(writes[3].args,{datasetId:"table",rowId:1,columnName:"value",value:"9"});
 console.log("single cell persistence: native one-cell receipt, visible generation CAS, empty values and legacy compatibility passed");
} finally {useProjectStore.getState().installPersistence(null);clearMocks();delete (globalThis as any).window;}

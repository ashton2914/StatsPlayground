import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {dataService} from "../src/services/dataService.ts";
import type {TableNavigationRequest} from "../src/types/data.ts";
Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
let current=true;let calls=0;let mode="valid";
mockIPC((command,args:any)=>{
 assert.equal(command,"query_table_navigation_row_ids");const request=args.request as TableNavigationRequest;calls++;
 assert.ok(request.count<=2000);assert.deepEqual(request.columnIds,["source","wide-text"]);assert.equal(request.sessionId,"sorted-session");
 if(mode==="switch")current=false;
 const rows=Array.from({length:request.count},(_,i)=>[10000-request.start-i]);
 if(mode==="duplicate")rows[1]=rows[0];
 if(mode==="wide")rows[0].push(999);
 return {version:1,requestId:request.requestId,datasetId:request.datasetId,generation:mode==="stale"?8:7,start:request.start,totalRows:10000,totalRowsExact:true,sessionId:"sorted-session",columns:["_row_id"],columnTypes:["BIGINT"],rows,timings:{totalMs:0}};
});
const request={version:1 as const,datasetId:"table",generation:7,start:2200,count:2003,columnIds:["source","wide-text"],sort:{column:"A",descending:true},filters:[],sessionId:"sorted-session",includeTransportDiagnostics:false};
try {
 const ids=await dataService.resolveTablePasteRowIds(request,()=>current);
 assert.equal(calls,2);assert.equal(ids.length,2003);assert.equal(ids[0],7800);assert.equal(ids.at(-1),5798);
 for(const next of ["stale","duplicate","wide","switch"]) {mode=next;current=true;await assert.rejects(dataService.resolveTablePasteRowIds({...request,count:3},()=>current));}
 current=false;const before=calls;await assert.rejects(dataService.resolveTablePasteRowIds(request,()=>current));assert.equal(calls,before);
 console.log("paste row identity pages: bounded projection, sorted physical IDs and owner/generation fences passed");
}finally{clearMocks();delete(globalThis as any).window;}

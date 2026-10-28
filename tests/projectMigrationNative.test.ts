import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {ioService} from "../src/services/ioService.ts";
import {projectService} from "../src/services/projectService.ts";
import {DatabaseSync} from "node:sqlite";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {once} from "node:events";
import {mkdtemp,writeFile,readFile,rm,realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {createNativeProjectLifecycle} from "../src/projectPersistence/nativeLifecycle.ts";
import {openNativeProjectWithMigration} from "../src/projectPersistence/openWithMigration.ts";
import {useProjectStore} from "../src/stores/useProjectStore.ts";
import {useDataStore} from "../src/stores/useDataStore.ts";
import {useReportStore} from "../src/stores/useReportStore.ts";
import {useProjectCatalogStore} from "../src/stores/useProjectCatalogStore.ts";
import type {ProjectMigrationPreflight} from "../src/projectPersistence/openWithMigration.ts";
import type {ProjectSessionSummary} from "../src/projectPersistence/lifecycle.ts";
const executable=process.env.STATSPG_PERSISTENCE_HARNESS;
assert.ok(executable,"provide the real native persistence harness");
const directory=await mkdtemp(join(tmpdir(),"sp-migration-native-"));
const live=join(directory,"live.spprj"),source=join(directory,"legacy.spprj"),destination=join(directory,"converted.spprj");
await writeFile(source,JSON.stringify({name:"Original measurements",version:"1.0.0",datasets:[{id:"table",name:"Measurements",sourceType:"csv",columns:[{name:"Value",colType:"DOUBLE",width:177}],rows:[[1,22],[2,33]]}]}));
const hash=()=>readFile(source).then(bytes=>createHash("sha256").update(bytes).digest("hex"));const originalHash=await hash();
const child=spawn(executable,[live],{stdio:["pipe","pipe","pipe"]});
const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();let nextId=0,stderr="";
child.stderr.on("data",data=>{stderr+=data;});
const lines=createInterface({input:child.stdout});
lines.on("line",line=>{const result=JSON.parse(line),call=pending.get(result.id);assert.ok(call);pending.delete(result.id);if(result.error)call.reject(new Error(result.error));else call.resolve(result.ok);});
child.on("error",error=>{for(const call of pending.values())call.reject(error);pending.clear();});
child.on("exit",code=>{for(const call of pending.values())call.reject(new Error(`native exit ${code}: ${stderr}`));pending.clear();});
function request<T>(command:string,args:object={}):Promise<T>{const id=++nextId;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,command,...args})+"\n");});}
let opened=false;let lifecycle:ReturnType<typeof createNativeProjectLifecycle>|undefined;
try {
 const preflight=await request<ProjectMigrationPreflight>("migrationPreflight",{sourcePath:source,destinationPath:destination});
 assert.equal(preflight.formatVersion,"1.0.0");assert.equal(preflight.destinationExists,false);
 lifecycle=createNativeProjectLifecycle({
  listen:async()=>()=>{},
  invoke:async<T>(command:string,args?:Record<string,unknown>):Promise<T>=>{
   if(command==="open_project_v5") {
    if(!opened){opened=true;return request<T>("reopen");}
    return request<T>("open",args);
   }
   if(command==="migrate_project_v5")return request<T>("migrate",args);
   if(command==="close_project_v5")return request<T>("close",args);
   if(command==="checkpoint_project_v5")return request<T>("checkpoint",args);
   if(command==="commit_project_records")return request<T>("commit",args);
   if(command==="resolve_project_operation")return request<T>("resolve",args);
   throw new Error(command);
  },
 });
 await lifecycle.switchProject(live);const owner=useProjectStore.getState().persistence!;
 await assert.rejects(lifecycle.switchProject(source),/project_requires_migration/);
 assert.equal(useProjectStore.getState().persistence,owner);
 await assert.rejects(lifecycle.migrateProject(source,source),/project_migration_source_overwrite/);
 assert.equal(useProjectStore.getState().persistence,owner);assert.equal(await hash(),originalHash);
 const result=await openNativeProjectWithMigration(source,{
  open:path=>lifecycle!.switchProject(path),preflight:(sourcePath,destinationPath)=>request("migrationPreflight",{sourcePath,destinationPath}),
  confirm:async()=>true,chooseDestination:async()=>destination,isCurrent:()=>useProjectStore.getState().persistence===owner,
  migrate:(sourcePath,destinationPath,migrationId)=>lifecycle!.migrateProject(sourcePath,destinationPath,migrationId),
 });
 assert.equal(result,true);assert.notEqual(useProjectStore.getState().persistence,owner);
 assert.equal(useProjectStore.getState().project!.filePath,destination);
 assert.equal(useDataStore.getState().datasets[0].rowCount,2);
 assert.equal(useReportStore.getState().items.length,0);
 assert.ok(useProjectCatalogStore.getState().summaries.table);
 assert.equal(Object.values(useProjectCatalogStore.getState().bodies).filter(body=>body.status==="ready").length,0,"conversion handoff installs only metadata");
 assert.deepEqual(await request("firstValue",{datasetId:"table",columnName:"Value"}),{rowId:1,value:22});
 useReportStore.getState().addItem({id:"new-report",name:"New note",schemaVersion:1,markdown:"# Incremental note",createdAt:"today",updatedAt:"today"});
 const migratedOwner=useProjectStore.getState().persistence!;await migratedOwner.flushThrough(migratedOwner.captureBarrier());
 Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});
 mockIPC((command,args:any)=>request("export",{kind:command,epoch:args.epoch,request:args}));
 const csv=join(directory,"native.csv"),sqlite=join(directory,"native.sqlite"),sptb=join(directory,"native.sptb");
 await ioService.exportCsv("table",csv);await ioService.exportSqlite(sqlite);await ioService.exportSqliteSubset(join(directory,"subset.sqlite"),["table"],{table:"Chosen"});
 await ioService.exportCsvZip(join(directory,"all.zip"));await ioService.exportCsvZipSubset(join(directory,"subset.zip"),["table"],{table:"Folder/Data"});
 await projectService.exportTable("table",sptb);await projectService.exportTablesSptbZip(["table"],join(directory,"tables.zip"),{table:"Folder/Data"});
 assert.match(await readFile(csv,"utf8"),/^Value\r?\n22(?:\.0)?\r?\n33(?:\.0)?\r?\n$/);
 const exported=JSON.parse(await readFile(sptb,"utf8"));assert.equal(exported.columns[0].width,177);assert.deepEqual(exported.rows,[[1,22],[2,33]]);
 const sql=new DatabaseSync(sqlite);try {assert.deepEqual(sql.prepare('SELECT Value FROM Measurements ORDER BY Value').all().map(row=>row.Value),[22,33]);}finally {sql.close();}
 clearMocks();delete (globalThis as any).window;
 // Reopen must follow the migrated destination rather than the harness startup path.
 const reopened=await request<ProjectSessionSummary>("reopen");
 assert.equal(await realpath(reopened.project.filePath),await realpath(destination));assert.ok(reopened.directory.items.some(item=>item.id==="new-report"));
 assert.deepEqual(await request("firstValue",{datasetId:"table",columnName:"Value"}),{rowId:1,value:22});
 assert.equal(await hash(),originalHash);console.log("native migration: explicit conversion, retained failed owner, metadata handoff, incremental note and destination reopen passed");
} finally {
 await useProjectStore.getState().persistence?.close();useProjectStore.getState().installPersistence(null);
 if(typeof window!=="undefined"){clearMocks();delete (globalThis as any).window;}child.stdin.end();await once(child,"exit");lines.close();await rm(directory,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {mockIPC,clearMocks} from '@tauri-apps/api/mocks';
import {createProjectPersistenceCoordinator} from '../src/projectPersistence/coordinator';
import {createApplicationRuntime} from '../src/applicationCommands/applicationRuntime';
import {useProjectStore} from '../src/stores/useProjectStore';
import {projectService} from '../src/services/projectService';
import {readProjectTopology} from '../src/projectPersistence/tableGroups';
import type {ProjectCommit,ProjectHeader} from '../src/types/projectPersistence';
const executable=process.env.STATSPG_PERSISTENCE_HARNESS;assert.ok(executable,'real native persistence harness required');
const dir=await mkdtemp(join(tmpdir(),'sp-group-contract-'));const child=spawn(executable,[join(dir,'live.spprj')],{stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',data=>stderr+=data);let seq=0;const calls=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();const lines=createInterface({input:child.stdout});lines.on('line',line=>{const response=JSON.parse(line);const pending=calls.get(response.id)!;calls.delete(response.id);response.error?pending.reject(new Error(response.error)):pending.resolve(response.ok);});child.on('exit',code=>{for(const call of calls.values())call.reject(new Error(`native exited ${code}: ${stderr}`));calls.clear();});
function request<T=any>(command:string,args:object={}):Promise<T>{const id=++seq;return new Promise((resolve,reject)=>{calls.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,command,...args})+'\n');});}
let owner:ReturnType<typeof createProjectPersistenceCoordinator>|null=null;
try{
 const session=await request<{header:ProjectHeader;epoch:number}>('header');let lastContext:any;let lastCommit:ProjectCommit<any>;let lose=false;let cancelAfter:number|undefined;
 owner=createProjectPersistenceCoordinator({projectId:session.header.projectId,epoch:session.epoch,committedRevision:session.header.committedRevision,now:Date.now,newOperationId:()=>crypto.randomUUID(),setTimer:(f,n)=>setTimeout(f,n),clearTimer:id=>clearTimeout(id as any),resolveOperation:context=>request('resolve',{context}),transport:async(op,context)=>{lastContext=context;lastCommit=await request('mutation',{context,operation:{command:op.command,...op.payload as object,...(cancelAfter===undefined?{}:{cancelAfterChecks:cancelAfter})}});if(lose){lose=false;throw new Error('lost reply');}return lastCommit;}});
 useProjectStore.getState().installPersistence(owner);useProjectStore.setState({readOnly:false});Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
 mockIPC((command,args:any)=>{if(command==='get_project_topology')return request('topology',args);if(command==='preview_project_table_action')return request('tableActionPreview',args);if(command==='get_dataset_generation')return request('generation',args);throw new Error(command);},{shouldMockEvents:true});
 const create=async(name:string)=>(await owner!.submit<any>({command:'create_table_from_rows',payload:{request:{name,columnNames:['value'],columnTypes:['DOUBLE'],rows:[[42]]}}})).value.id;
 const a=await create('A');const x=await create('X');const generation=await request<number>('generation',{datasetId:a});
 const derived=await owner.submit<any>({command:'create_table_transform',payload:{draft:{name:'Subset',outputName:'B',operation:{kind:'subset',columns:['value']}},inputBindings:[{role:'source',tableDocumentId:a}]},datasetGenerations:[{id:a,generation}]});const b=derived.value.definition.output.tableDocumentId;
 const runtime=createApplicationRuntime({revision:{get:()=>owner!.snapshot().committedRevision,set:()=>{},isAuthoritative:()=>true}});
 const preview=await runtime.execute({type:'project.previewTableAction',input:{tableId:b,scope:'descendants'}},{kind:'mcp'});assert.deepEqual(preview.data.tableIds,[b]);
 let topology=await readProjectTopology();await runtime.execute({type:'project.moveTableGroup',input:{targetTableId:b,destinationFolder:'New/Nested',expectedTopologyRevision:topology.committedRevision}},{kind:'mcp'});topology=await readProjectTopology();assert.equal(topology.tables.find(t=>t.id===a)!.folder,'New/Nested');assert.equal(topology.tables.find(t=>t.id===b)!.folder,'New/Nested');assert.equal(topology.tables.find(t=>t.id===x)!.folder,'');
 await assert.rejects(request('topology',{epoch:session.epoch+1}));
 const revision=topology.committedRevision;cancelAfter=2;await assert.rejects(runtime.execute({type:'project.copyTableGroup',input:{targetTableId:b,destinationFolder:'cancelled',expectedTopologyRevision:revision}},{kind:'mcp'}));cancelAfter=undefined;assert.equal((await request('topology',{epoch:session.epoch})).tables.length,3);await owner.resolveFailedOperation();
 // A rejected staged operation is recorded as rejected; retire it through the normal coordinator resolver before subsequent writes.
 topology=await readProjectTopology();lose=true;await assert.rejects(runtime.execute({type:'project.copyTableGroup',input:{targetTableId:b,destinationFolder:'copy',expectedTopologyRevision:topology.committedRevision}},{kind:'mcp'}),/handler failed/);await owner.resolveFailedOperation();assert.equal((await readProjectTopology()).tables.length,5);assert.ok(lastContext.operationId);
 await runtime.execute({type:'table.delete',input:{datasetId:b}},{kind:'mcp'});topology=await readProjectTopology();assert.ok(topology.tables.some(t=>t.id===a));assert.ok(topology.tables.some(t=>t.id===x));assert.ok(!topology.tables.some(t=>t.id===b));assert.ok(!topology.transforms.some(t=>t.outputTableId===b));
 await runtime.shutdown();console.log('real native application/MCP commands: whole-group move/copy, directed delete, foreign epoch, cancelled stage and lost reply passed');
}finally{await owner?.close().catch(()=>{});useProjectStore.setState({persistence:null});clearMocks();child.stdin.end();await once(child,'exit');lines.close();await rm(dir,{recursive:true,force:true});delete (globalThis as any).window;}

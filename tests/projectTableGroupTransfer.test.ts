import assert from 'node:assert/strict';
import {mockIPC,clearMocks} from '@tauri-apps/api/mocks';
import {exportTableGroup,importTableGroup} from '../src/projectPersistence/tableGroups.ts';
import {useProjectStore} from '../src/stores/useProjectStore.ts';
Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
const sequence:string[]=[];const result={filePath:'/out/group.spprj',tableCount:2,sourceRevision:6};
const owner={snapshot:()=>({epoch:5,committedRevision:6}),captureBarrier:()=>3,flushThrough:async(n:number)=>{assert.equal(n,3);sequence.push('flush');},submit:async(operation:any)=>{assert.equal(operation.command,'import_project_table_group');assert.deepEqual(operation.payload,{request:{filePath:'/out/group.spprj',destinationFolder:'nested'}});return {epoch:5,value:{tableIds:['new-A','new-B'],idMap:{}}};}} as any;
useProjectStore.setState({persistence:owner});
mockIPC((command,args:any)=>{assert.equal(command,'export_project_table_group');assert.deepEqual(sequence,['flush']);assert.equal(args.epoch,5);assert.equal(args.request.targetTableId,'B');assert.equal(args.request.expectedTopologyRevision,6);sequence.push('export');return result;});
try{
  assert.deepEqual(await exportTableGroup('B','/out/group.spprj',6),result);
  assert.deepEqual((await importTableGroup('/out/group.spprj','nested')).tableIds,['new-A','new-B']);
  assert.deepEqual(sequence,['flush','export']);
  console.log('group transfer transport: export write barrier and native import publication passed');
}finally{clearMocks();useProjectStore.setState({persistence:null});delete (globalThis as any).window;}

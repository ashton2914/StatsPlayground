import assert from 'node:assert/strict';
import {mockIPC,clearMocks} from '@tauri-apps/api/mocks';
import {emit} from '@tauri-apps/api/event';
import {withGroupCancellation} from '../src/projectPersistence/groupCancellation';
Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
let registered=false,cancelCalls=0,cancelled=false;
mockIPC((cmd)=>{if(cmd==='cancel_project_group_operation'){cancelCalls++;cancelled=registered;return registered;}throw new Error(cmd);},{shouldMockEvents:true});
try{const controller=new AbortController();await withGroupCancellation(controller.signal,async transferId=>{assert.ok(transferId);controller.abort();await new Promise(r=>setTimeout(r,0));assert.equal(cancelCalls,1);assert.equal(cancelled,false);registered=true;await emit('project-group-started',{transferId});await new Promise(r=>setTimeout(r,0));assert.equal(cancelCalls,2);assert.equal(cancelled,true);return 'cancelled before publication';});
 const early=new AbortController();early.abort();let ran=false;await assert.rejects(withGroupCancellation(early.signal,async()=>{ran=true;}),/cancelled/);assert.equal(ran,false);console.log('group cancellation: pre-registration intent, request identity, native retry and early-abort fencing');}finally{clearMocks();delete (globalThis as any).window;}

import assert from 'node:assert/strict';
import {measurePaintedProjectOperation} from '../src/benchmarks/projectV5UiMetrics.ts';
{
 let frames=0,now=0;const events:string[]=[];
 const value=await measurePaintedProjectOperation({begin:async()=>{events.push('begin');return 7;},operation:async()=>{events.push('operation');},ready:()=>frames>=1,isCurrent:()=>true,retention:()=>({rows:500}),clock:()=>now,frame:async()=>{frames++;now+=16;},finish:async(id,fields)=>{assert.equal(id,7);assert.equal(frames,3);assert.equal(fields.uiReadyMs,48);assert.equal(fields.verification,true);assert.deepEqual(fields.retention,{rows:500});events.push('finish');return 'measured';}});
 assert.equal(value,'measured');assert.deepEqual(events,['begin','operation','finish']);
}
{
 const finishes:any[]=[];
 await assert.rejects(()=>measurePaintedProjectOperation({begin:async()=>8,operation:async()=>{throw Error('native operation refused');},ready:()=>true,retention:()=>null,clock:()=>0,frame:async()=>{},finish:async(id,fields)=>{finishes.push({id,fields});}}),/native operation refused/);
 assert.equal(finishes.length,1);assert.equal(finishes[0].fields.uiReadyMs,null);assert.equal(finishes[0].fields.verification,false);
}
{
 let now=0;const finishes:any[]=[];
 await assert.rejects(()=>measurePaintedProjectOperation({begin:async()=>9,operation:async()=>{},ready:()=>false,retention:()=>null,timeoutMs:20,clock:()=>now,frame:async()=>{now+=16;},finish:async(_id,fields)=>{finishes.push(fields);}}),/visible state timed out/);
 assert.equal(finishes.length,1);assert.equal(finishes[0].verification,false);
}
{
 let frames=0;const finishes:any[]=[];
 await assert.rejects(()=>measurePaintedProjectOperation({begin:async()=>10,operation:async()=>{},ready:()=>true,isCurrent:()=>frames===0,retention:()=>null,clock:()=>frames*16,frame:async()=>{frames++;},finish:async(_id,fields)=>{finishes.push(fields);}}),/owner changed/);
 assert.equal(finishes.length,1);assert.equal(finishes[0].verification,false);
}
{
 const operationError=new Error('operation failed'),telemetryError=new Error('telemetry refused');let observed:any;
 try{await measurePaintedProjectOperation({begin:async()=>11,operation:async()=>{throw operationError;},ready:()=>true,retention:()=>null,clock:()=>0,frame:async()=>{},finish:async()=>{throw telemetryError;}});}catch(error){observed=error;}
 assert.equal(observed.operationError,operationError);assert.equal(observed.telemetryError,telemetryError);
}
console.log('project v5 UI metrics: exact readiness, paint frames, failure/timeout and owner fences passed');

const {projectProbeRow}=await import('../src/benchmarks/projectV5UiMetrics');
for(const rows of [300000,2000000,10000000]){
 const positions=Array.from({length:100},(_,index)=>projectProbeRow(index,rows));
 assert.equal(new Set(positions).size,100);
 assert.ok(positions.every(row=>row>=10000&&row<rows-100));
}

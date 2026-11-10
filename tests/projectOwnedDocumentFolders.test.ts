import assert from 'node:assert/strict';
import {createProjectDocumentAdapters} from '../src/projectPersistence/documentAdapters.ts';
import {useProjectStore} from '../src/stores/useProjectStore.ts';
import {useGraphBuilderNewStore} from '../src/stores/useGraphBuilderNewStore.ts';
import type {DocumentWrite} from '../src/types/projectPersistence.ts';
const writes:DocumentWrite[]=[];
const coordinator={snapshot:()=>({epoch:51,committedRevision:2,pendingSequence:writes.length}),enqueueDocument:(write:DocumentWrite)=>{writes.push(write);return writes.length;}} as any;
useProjectStore.setState({persistence:coordinator,readOnly:false});
useGraphBuilderNewStore.getState().reset();
const adapter=createProjectDocumentAdapters({coordinator,summaries:[{id:'B',kind:'table',name:'B',folder:'experiment',revision:1,dependencies:[]}]});
const dispose=adapter.activate();
try{
  useGraphBuilderNewStore.getState().open('B',0);
  assert.equal(writes.at(-1)?.document.summary.folder,'experiment','new owned documents must inherit the source table folder');
  assert.deepEqual(writes.at(-1)?.document.summary.dependencies,['B']);
  console.log('owned document persistence: new graph inherits table folder without a separate move');
}finally{dispose();useProjectStore.setState({persistence:null});useGraphBuilderNewStore.getState().reset();}

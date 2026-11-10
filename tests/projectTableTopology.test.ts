import assert from 'node:assert/strict';
import {mockIPC, clearMocks} from '@tauri-apps/api/mocks';
import {projectService} from '../src/services/projectService.ts';
Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
const topology={epoch:77,committedRevision:12,tables:[{id:'A',name:'A',folder:'',revision:1},{id:'B',name:'B',folder:'',revision:1}],transforms:[{id:'ab',revision:1,name:'Subset',operationKind:'subset',inputs:[{role:'source',tableId:'A'}],outputTableId:'B'}],ownedDocuments:[{id:'analysis-b',kind:'analysis',tableId:'B',revision:2}],diagnostics:[]};
let topologyReads=0;
mockIPC((command,args:any)=>{
  assert.equal(args.epoch,77,'topology reads must stay bound to the requested owner');
  if(command==='get_project_topology'){topologyReads++;return topology;}
  if(command==='preview_project_table_action'){
    assert.equal(args.tableId,'B');assert.equal(args.scope,'descendants');
    return {epoch:77,committedRevision:12,targetTableId:'B',scope:'descendants',tableIds:['B'],transformIds:['ab'],ownedDocumentIds:['analysis-b'],blockers:[]};
  }
  throw new Error(`Topology navigation may not hydrate bodies or read rows: ${command}`);
});
try {
  assert.deepEqual(await projectService.getProjectTopology(77),topology);
  const preview=await projectService.previewProjectTableAction(77,'B','descendants');
  assert.deepEqual(preview.tableIds,['B']);assert.deepEqual(preview.transformIds,['ab']);assert.deepEqual(preview.ownedDocumentIds,['analysis-b']);
  assert.equal(topologyReads,1);
  console.log('project table topology: revision-bound metadata query and directed preview passed');
} finally {clearMocks();delete (globalThis as any).window;}

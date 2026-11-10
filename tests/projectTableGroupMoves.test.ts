import assert from 'node:assert/strict';
import {useProjectStore} from '../src/stores/useProjectStore.ts';
import {moveTableGroup, readProjectTopology} from '../src/projectPersistence/tableGroups.ts';
import {projectService} from '../src/services/projectService.ts';
const calls:any[]=[];let release!:()=>void;
const acknowledgement=new Promise<void>(resolve=>release=resolve);
const owner={snapshot:()=>({epoch:71,committedRevision:8}),captureBarrier:()=>2,flushThrough:async (n:number)=>{assert.equal(n,2);},submit:async (operation:unknown)=>{calls.push(operation);await acknowledgement;return {epoch:71,committedRevision:9};}} as any;
useProjectStore.setState({persistence:owner});
try {
  const moving=moveTableGroup('B','new/nested',8);
  await Promise.resolve();
  assert.deepEqual(calls,[{command:'move_project_table_group',payload:{request:{targetTableId:'B',destinationFolder:'new/nested',expectedTopologyRevision:8}}}]);
  let done=false;void moving.then(()=>done=true);await Promise.resolve();assert.equal(done,false,'a group move cannot succeed optimistically');release();await moving;
  const original=projectService.getProjectTopology;
  projectService.getProjectTopology=async()=>{useProjectStore.setState({persistence:null});return {epoch:71,committedRevision:9,tables:[],transforms:[],ownedDocuments:[],diagnostics:[]};};
  await assert.rejects(readProjectTopology(),/project.*stale/i);
  projectService.getProjectTopology=original;
  console.log('project table group moves: native whole-component request, acknowledgement and owner fence passed');
}finally{useProjectStore.setState({persistence:null});}

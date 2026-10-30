import assert from 'node:assert/strict';
import {copyTableGroup} from '../src/projectPersistence/tableGroups.ts';
import {useProjectStore} from '../src/stores/useProjectStore.ts';
const operations:unknown[]=[];
const expected={tableIds:['new-A','new-B'],idMap:{A:'new-A',B:'new-B'}};
const owner={snapshot:()=>({epoch:9}),submit:async(operation:unknown)=>{operations.push(operation);return {epoch:9,value:expected};}} as any;
useProjectStore.setState({persistence:owner});
try{
  assert.deepEqual(await copyTableGroup('B','copies',12),expected);
  assert.deepEqual(operations,[{command:'copy_project_table_group',payload:{request:{targetTableId:'B',destinationFolder:'copies',expectedTopologyRevision:12}}}]);
  console.log('group copy transport: backend-authorized whole-component request and acknowledged identity map passed');
}finally{useProjectStore.setState({persistence:null});}

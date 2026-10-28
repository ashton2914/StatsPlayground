import {useEffect,useRef,useState} from 'react';
import {ProjectPersistenceStatus} from '../src/components/ProjectPersistenceStatus';
import {createProjectPersistenceCoordinator,type PersistenceSnapshot,type ProjectPersistenceCoordinator} from '../src/projectPersistence/coordinator';
import type {ProjectCommit,ProjectRecordPatch,ProjectWriteContext} from '../src/types/projectPersistence';
import i18n from '../src/i18n';
interface Request {context:ProjectWriteContext;patch:ProjectRecordPatch;resolve(value:ProjectCommit<unknown>):void;reject(error:Error):void}
export function ProjectPersistenceHarness({readOnly=false,language='en'}:{readOnly?:boolean;language?:string}){
 const owner=useRef<ProjectPersistenceCoordinator|null>(null);const requests=useRef<Request[]>([]);const edit=useRef(0);const sequence=useRef(0);
 const [snapshot,setSnapshot]=useState<PersistenceSnapshot|null>(null);const [ready,setReady]=useState(false);const [barrierDone,setBarrierDone]=useState(false);const [sent,setSent]=useState<string[]>([]);
 const makeOwner=(epoch:number)=>{
  const queue=createProjectPersistenceCoordinator({projectId:`project-${epoch}`,epoch,committedRevision:1,writable:!readOnly,now:()=>0,newOperationId:()=>`operation-${++sequence.current}`,setTimer:()=>0,clearTimer:()=>{},
   transport:<T,>(operation:{payload:unknown},context:ProjectWriteContext)=>new Promise<ProjectCommit<T>>((resolve,reject)=>{
    requests.current.push({context,patch:operation.payload as ProjectRecordPatch,resolve:resolve as (value:ProjectCommit<unknown>)=>void,reject});setSent(previous=>[...previous,context.operationId]);
   }),onChange:value=>{if(owner.current===queue)setSnapshot(value);},
  });return queue;
 };
 useEffect(()=>{owner.current=makeOwner(7);setSnapshot(owner.current.snapshot());void i18n.changeLanguage(language).then(()=>setReady(true));return()=>{owner.current=null;};},[]);
 const flush=async()=>{const queue=owner.current!;await queue.flushThrough(queue.captureBarrier());};
 const enqueue=()=>{const number=++edit.current;owner.current!.enqueueDocument({expectedRevision:number,document:{schemaVersion:1,summary:{id:'report',kind:'report',name:'Report',folder:'',revision:number+1,dependencies:[]},body:{id:'report',name:'Report',schemaVersion:1,markdown:`edit ${number}`}}});};
 const acknowledge=()=>{const request=requests.current.shift();if(!request)throw new Error('No native request');request.resolve({operationId:request.context.operationId,epoch:request.context.expectedEpoch,committedRevision:request.context.expectedRevision+1,value:null,changedDatasetGenerations:[],changedDocumentRevisions:request.patch.documents.map(write=>({id:write.document.summary.id,revision:write.document.summary.revision}))});};
 if(!ready||!snapshot)return null;
 return <div>
  <ProjectPersistenceStatus key={snapshot.epoch} snapshot={snapshot} readOnly={readOnly} onRetry={flush}/>
  <button onClick={enqueue}>Edit document</button>
  <button onClick={()=>{setBarrierDone(false);void flush().then(()=>setBarrierDone(true),()=>{});}}>Save barrier</button>
  <button onClick={acknowledge}>Acknowledge native write</button>
  <button onClick={()=>requests.current.shift()?.reject(new Error('disk full /Users/private/project.spprj'))}>Fail native write</button>
  <button onClick={()=>{owner.current=makeOwner(8);edit.current=0;setSnapshot(owner.current.snapshot());}}>Switch owner</button>
  <div data-testid="request-identities">{JSON.stringify(sent)}</div><div data-testid="barrier-complete">{String(barrierDone)}</div>
 </div>;
}

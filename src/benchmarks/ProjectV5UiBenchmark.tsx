import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import App from '../App';
import {nativeProjectLifecycle} from '../projectPersistence/nativeLifecycle';
import {useProjectStore} from '../stores/useProjectStore';
import {useProjectCatalogStore} from '../stores/useProjectCatalogStore';
import {projectViewportBudget} from '../projectPersistence/viewportBudget';
import {measurePaintedProjectOperation,projectProbeRow} from './projectV5UiMetrics';

interface Configuration {nativeWindowFocused:boolean;fixturePath:string;fixtureId:string;datasetId:string;rows:number;columns:number;samples:number;cacheMode?:'warm'|'cold'}
type Scenario='catalog'|'window'|'scroll'|'edit'|'close';
const scenarios:Scenario[]=['catalog','window','scroll','edit','close'];
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
const epoch=()=>useProjectStore.getState().persistence?.snapshot().epoch??null;
const current=(config:Configuration)=>useProjectCatalogStore.getState().projectId===config.fixtureId;
const cell=(row:number)=>document.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="0"]`);
const visible=(row:number,value:number)=>{
  const element=cell(row);const rect=element?.getBoundingClientRect();
  return !!element&&!!rect&&rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight&&element.textContent?.trim()===String(value);
};
const directory=()=>[...document.querySelectorAll<HTMLElement>('.dataset-item')].find(element=>element.querySelector('.ds-name')?.textContent?.trim()==='Data.sptb');
const catalogPainted=()=>[...document.querySelectorAll<HTMLElement>('.dataset-item')].some(element=>{
  const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight;
});
async function prepareTableDirectory(config:Configuration){
  while(!useProjectCatalogStore.getState().summaries[config.datasetId]){
    if(!current(config))throw new Error('Project changed during untimed table-directory setup');
    const before=useProjectCatalogStore.getState();
    if(before.nextCursor===null)throw new Error('Fixture table missing from complete catalog');
    await before.loadNextPage();
    const after=useProjectCatalogStore.getState();
    if(after.nextCursor===before.nextCursor&&Object.keys(after.summaries).length===Object.keys(before.summaries).length)throw new Error('Fixture catalog made no paging progress');
  }
  await waitFor(()=>current(config)&&!!directory());
}

async function waitFor(check:()=>boolean){const start=performance.now();while(!check()){if(performance.now()-start>15000)throw new Error('Benchmark setup timed out');await frame();}}
async function fill(selector:string,value:string){
  const element=document.querySelector<HTMLInputElement>(selector);if(!element)throw new Error(`Missing real App input ${selector}`);
  element.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);
  element.dispatchEvent(new Event('input',{bubbles:true}));await frame();return element;
}
function enter(element:HTMLInputElement){element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));}
function retention(){
  const usage=projectViewportBudget.snapshot();
  return {viewportRows:usage.retainedViewports===1?usage.rows:null,viewportBytes:usage.retainedViewports===1?usage.bytes:null,
    aggregateRows:usage.rows,aggregateBytes:usage.bytes,activeViewports:usage.retainedViewports,
    method:'actual projectViewportBudget cache entries; UTF-16 retained payload estimate; single-table fixture'};
}
async function run(config:Configuration,onProgress:(text:string)=>void){
  let failure:unknown;
  try {
    await waitFor(()=>current(config)&&catalogPainted());
    await nativeProjectLifecycle.closeProject();
    let index=0;
    const measure=async(scenario:Scenario,operation:()=>Promise<unknown>,ready:()=>boolean,owner:number|null)=>{
        onProgress(`${index+1}/${config.samples} ${scenario}`);
        // Foreground activation is setup, before either native or UI timing starts.
        let activation=await invoke<Configuration|null>('project_ui_probe_configuration');
        const activationStarted=performance.now();
        while(activation?.nativeWindowFocused!==true||document.visibilityState!=='visible'){
          if(performance.now()-activationStarted>15000)throw new Error('Benchmark native foreground activation timed out');
          await frame();activation=await invoke<Configuration|null>('project_ui_probe_configuration');
        }
        let focusedAtStart=false,visibilityAtStart='unknown';
        let origin:number|null=null,operationFinishedMs:number|null=null,readyObservedMs:number|null=null;
        const framesMs:Array<[number,number]>=[];
        const clock=()=>{const now=performance.now();if(origin===null){origin=now;focusedAtStart=document.hasFocus();visibilityAtStart=document.visibilityState;}return now;};
        const elapsed=()=>clock()-origin!;
        const observedRetention=()=>({...retention(),uiPhases:{operationFinishedMs,readyObservedMs,framesMs,focusedAtStart,focusedAtFinish:document.hasFocus(),visibilityAtStart,visibilityAtFinish:document.visibilityState}});
        const result=await measurePaintedProjectOperation<{verification:{passed:boolean}}>({
          clock,frame:async()=>{const start=elapsed();await frame();framesMs.push([start,elapsed()]);},
          begin:()=>invoke<number>('project_ui_probe_begin',{scenario,expectedEpoch:owner}),
          operation:async()=>{const result=await operation();operationFinishedMs=elapsed();return result;},
          ready:()=>{const result=ready();if(result&&readyObservedMs===null)readyObservedMs=elapsed();return result;},
          isCurrent:()=>scenario==='catalog'?epoch()===null||current(config):scenario==='close'?epoch()===null||(epoch()===owner&&current(config)):epoch()===owner&&current(config),
          retention:observedRetention,
          finish:(sampleId,observation)=>invoke('project_ui_probe_finish',{sampleId,...observation,retention:observation.retention??observedRetention()}),
        });
        if(!result.verification.passed)throw new Error(`Native/UI verification failed for ${scenario}`);
      };
    if(config.cacheMode==='cold'){
      await measure('catalog',()=>nativeProjectLifecycle.switchProject(config.fixturePath),()=>current(config)&&catalogPainted()&&!document.querySelector('.sp-formula-bar'),null);
      await nativeProjectLifecycle.closeProject();
      const path=await invoke<string>('project_ui_probe_publish',{scenario:'catalog'});
      onProgress(`Complete: ${path}`);return;
    }
    for(index=0;index<config.samples;index++){
      await measure('catalog',()=>nativeProjectLifecycle.switchProject(config.fixturePath),()=>current(config)&&catalogPainted()&&!document.querySelector('.sp-formula-bar'),null);
      // Catalog latency ends at first-page paint; locating a later-page table is separate setup.
      await prepareTableDirectory(config);
      const owner=epoch();if(owner===null)throw new Error('Opened fixture has no native owner');
      await measure('window',async()=>{const item=directory();if(!item)throw new Error('Fixture table missing');item.click();},()=>visible(0,0),owner);
      const row=projectProbeRow(index,config.rows);
      const reference=await fill('.sp-formula-ref-input',`A${row+1}`);
      await measure('scroll',async()=>enter(reference),()=>visible(row,row)&&document.querySelector<HTMLInputElement>('.sp-formula-ref-input')?.value===`A${row+1}`,owner);
      const value=42000000+index;const formula=await fill('.sp-formula-input',String(value));
      await measure('edit',async()=>enter(formula),()=>visible(row,value)&&document.querySelector<HTMLInputElement>('.sp-formula-ref-input')?.value===`A${row+2}`&&useProjectStore.getState().persistence?.snapshot().status==='saved',owner);
      await measure('close',()=>nativeProjectLifecycle.closeProject(),()=>epoch()===null&&!document.querySelector('.dataset-item')&&!document.querySelector('.sp-formula-bar'),owner);
    }
  }catch(error){failure=error;}
  // Preserve partial and failed samples as immutable evidence too.
  const runError=failure===undefined?undefined:failure instanceof Error?failure.message:String(failure);
  const paths=[];for(const scenario of (config.cacheMode==='cold'?['catalog']:scenarios))paths.push(await invoke<string>('project_ui_probe_publish',{scenario,runError}));
  if(failure)throw failure;
  onProgress(`Complete: ${paths.join(', ')}`);
}

/** Explicit benchmark entry point; renders the production App and real interactions. */
export function ProjectV5UiBenchmark(){
  const [ready,setReady]=useState(false);const [status,setStatus]=useState('Preparing project UI benchmark');
  useEffect(()=>{
    let disposed=false;
    void (async()=>{
      const config=await invoke<Configuration|null>('project_ui_probe_configuration');
      if(!config)throw new Error('Explicit native project UI benchmark configuration required');
      // Install an existing fixture before App mounts, avoiding any startup draft mutation.
      await nativeProjectLifecycle.switchProject(config.fixturePath);
      if(disposed)return;setReady(true);await frame();await frame();
      await run(config,text=>{if(!disposed)setStatus(text);});
    })().catch(error=>{if(!disposed)setStatus(`Failed: ${String(error)}`);});
    return ()=>{disposed=true;};
  },[]);
  return <>{ready&&<App/>}<output data-project-v5-probe-status style={{position:'fixed',bottom:0,right:0,zIndex:99999,pointerEvents:'none',fontSize:10}}>{status}</output></>;
}

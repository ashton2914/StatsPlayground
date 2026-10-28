import assert from 'node:assert/strict';
const entry=process.argv[2];
if(entry==='projectService')await import('../../src/services/projectService.ts');
else if(entry==='ioService')await import('../../src/services/ioService.ts');
else if(entry==='store')await import('../../src/stores/useProjectStore.ts');
else throw Error('unknown import-order fixture');
const {mockIPC,clearMocks}=await import('@tauri-apps/api/mocks');
const {projectService}=await import('../../src/services/projectService.ts');
const {useProjectStore}=await import('../../src/stores/useProjectStore.ts');
Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
const calls:Array<{command:string,args:any}>=[];
mockIPC((command,args)=>{calls.push({command,args});return {name:'Default service',filePath:'',createdAt:'fixture'};});
try {
 await useProjectStore.getState().initProject();
 assert.equal(useProjectStore.getState().project?.name,'Default service');
 await projectService.exportTable('table','output.sptb');
 assert.equal(calls[0].command,'init_project');assert.equal(calls[1].command,'export_table');
 assert.equal(calls[1].args.epoch,undefined);
}finally{clearMocks();delete (globalThis as any).window;}

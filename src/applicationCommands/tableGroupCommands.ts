import {open,save} from '@tauri-apps/plugin-dialog';
import {copyTableGroup,exportTableGroup,importTableGroup,moveTableGroup,previewTableAction} from '../projectPersistence/tableGroups';
import {dataService} from '../services/dataService';
import {useProjectStore} from '../stores/useProjectStore';
import {CommandExecutionError} from './runtime';
import type {ApplicationCommandRegistry,CommandExecutionContext} from './types';
import type {createApplicationCommandRuntime} from './runtime';
export function registerTableGroupCommands(runtime:ReturnType<typeof createApplicationCommandRuntime<ApplicationCommandRegistry>>){
  const check=(context:CommandExecutionContext,write=true)=>{context.assertCurrent?.();if(context.signal.aborted)throw new CommandExecutionError('cancelled','Operation cancelled');if(write&&useProjectStore.getState().readOnly)throw new CommandExecutionError('read_only','Project is read only');};
  runtime.register('project.previewTableAction',async(input,context)=>{check(context,false);const data=await previewTableAction(input.tableId,input.scope);context.assertCurrent?.();return {changed:false,data};},{mode:'read',risk:'low'});
  runtime.register('project.moveTableGroup',async(input,context)=>{check(context);context.beginCommit();await moveTableGroup(input.targetTableId,input.destinationFolder,input.expectedTopologyRevision);return {changed:true,data:null};},{mode:'mutation',risk:'low'});
  runtime.register('project.copyTableGroup',async(input,context)=>{check(context);const data=await copyTableGroup(input.targetTableId,input.destinationFolder,input.expectedTopologyRevision,{signal:context.signal});context.acknowledgeCommit?.();return {changed:true,data};},{mode:'mutation',risk:'low'});
  runtime.register('project.exportTableGroup',async(input,context)=>{check(context,false);const filePath=input.filePath??await save({defaultPath:'table-group.spprj',filters:[{name:'Project',extensions:['spprj']}]});check(context,false);if(!filePath)throw new CommandExecutionError('cancelled','No export file selected');const {tableCount,sourceRevision}=await exportTableGroup(input.targetTableId,filePath,input.expectedTopologyRevision,{signal:context.signal});context.acknowledgeCommit?.();return {changed:false,data:{tableCount,sourceRevision}};},{mode:'read',risk:'low'});
  runtime.register('project.importTableGroup',async(input,context)=>{check(context);const filePath=input.filePath??await open({multiple:false,filters:[{name:'Project',extensions:['spprj']}]});check(context);if(!filePath||Array.isArray(filePath))throw new CommandExecutionError('cancelled','No import file selected');const data=await importTableGroup(filePath,input.destinationFolder,{signal:context.signal});context.acknowledgeCommit?.();return {changed:true,data};},{mode:'mutation',risk:'low'});
  runtime.register('table.delete',async(input,context)=>{check(context);context.beginCommit();await dataService.deleteDataset(input.datasetId,input.expectedTopologyRevision);return {changed:true,data:null};},{mode:'mutation',risk:'high'});
}

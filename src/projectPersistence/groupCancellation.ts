import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {createMigrationCancellation} from './migrationCancellation';
/** Listen before dispatch so a cancellation queued before native registration is retained. */
export async function withGroupCancellation<T>(signal:AbortSignal|undefined,run:(transferId?:string)=>Promise<T>):Promise<T>{
  if(!signal)return run();
  if(signal.aborted)throw new DOMException('Operation cancelled','AbortError');
  const transferId=crypto.randomUUID();let cancellationError:unknown;
  const cancellation=createMigrationCancellation({cancel:()=>invoke<boolean>('cancel_project_group_operation',{transferId}),onChange:()=>{},onError:error=>{cancellationError=error;}});
  const unlisten=await listen<{transferId:string}>('project-group-started',event=>{if(event.payload.transferId===transferId)void cancellation.registered();});
  const abort=()=>{void cancellation.request();};signal.addEventListener('abort',abort,{once:true});
  try{if(signal.aborted)throw new DOMException('Operation cancelled','AbortError');const result=await run(transferId);if(cancellationError)console.error('group cancellation request failed',cancellationError);return result;}
  finally{signal.removeEventListener('abort',abort);cancellation.dispose();unlisten();}
}

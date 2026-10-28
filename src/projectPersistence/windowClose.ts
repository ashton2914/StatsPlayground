interface CloseDependencies<T> {
 getOwner():T|null;
 flushEffects():Promise<void>;
 closeProject(owner:T):Promise<void>;
 destroy():Promise<void>;
 reportError(error:unknown):void;
}
/** A single window listener reads the current owner so old listeners cannot bypass a save barrier. */
export function createNativeWindowCloseHandler<T>(deps:CloseDependencies<T>) {
 let closing=false;
 return async(event:{preventDefault():void})=>{
  const owner=deps.getOwner();
  if(owner===null) return;
  event.preventDefault();
  if(closing) return;closing=true;
  try {
   await deps.flushEffects();
   if(deps.getOwner()!==owner) throw new Error("project_changed_during_close");
   await deps.closeProject(owner);
   await deps.destroy();
  } catch(error) {deps.reportError(error);}
  finally {closing=false;}
 };
}
export async function drainStableEffectQueue(readPending:()=>Promise<unknown>):Promise<void> {
 for(;;) {
  const pending=readPending();
  await pending;
  if(readPending()===pending) return;
 }
}

export interface ViewportUsage {rows:number;bytes:number}
interface BudgetConfig {maxRows:number;maxBytes:number;maxRetainedViewports:number}
interface Owner {active:boolean;evict:()=>void}
interface Entry extends ViewportUsage {used:number}

/** Local cache caps multiplied by the retained viewport limit form the total cap. */
export function createViewportBudget(config:BudgetConfig) {
  for(const value of Object.values(config)) if(!Number.isSafeInteger(value)||value<1) throw new RangeError("viewport budget limits must be positive integers");
  const owners=new Map<string,Owner>();const entries=new Map<string,Entry>();let clock=0;
  const evict=(id:string)=>{
    if(!entries.delete(id)) return;
    const owner=owners.get(id);owner?.evict();
    if(!owner?.active) owners.delete(id);
  };
  const admit=(id:string)=>{
    if(!entries.has(id)) entries.set(id,{rows:0,bytes:0,used:++clock});
    while(entries.size>config.maxRetainedViewports) {
      const candidates=[...entries.keys()].filter(key=>key!==id).sort((left,right)=>Number(owners.get(left)?.active??false)-Number(owners.get(right)?.active??false)||(entries.get(left)!.used-entries.get(right)!.used));
      evict(candidates[0]);
    }
  };
  return {
    acquire(id:string,onEvict?:()=>void) {
      if(!id) throw new Error("viewport budget id is required");
      const previous=owners.get(id);
      owners.set(id,{active:true,evict:onEvict??previous?.evict??(()=>{})});
      admit(id);entries.get(id)!.used=++clock;
    },
    update(id:string,usage:ViewportUsage):boolean {
      if(!Number.isSafeInteger(usage.rows)||usage.rows<0||!Number.isSafeInteger(usage.bytes)||usage.bytes<0) throw new RangeError("viewport budget usage must be nonnegative integers");
      if(usage.rows>config.maxRows||usage.bytes>config.maxBytes) {evict(id);return false;}
      if(!owners.has(id)) throw new Error("viewport budget lease is required");
      admit(id);entries.set(id,{...usage,used:++clock});return true;
    },
    release(id:string) {const owner=owners.get(id);if(owner) owner.active=false;if(!entries.has(id)) owners.delete(id);},
    forget(id:string) {evict(id);owners.delete(id);},
    reset() {for(const id of [...entries.keys()]) evict(id);},
    snapshot() {
      return {ids:[...entries.keys()],retainedViewports:entries.size,registeredViewports:owners.size,rows:[...entries.values()].reduce((sum,item)=>sum+item.rows,0),bytes:[...entries.values()].reduce((sum,item)=>sum+item.bytes,0)};
    },
  };
}

export const projectViewportBudget=createViewportBudget({maxRows:5000,maxBytes:67108864,maxRetainedViewports:2});

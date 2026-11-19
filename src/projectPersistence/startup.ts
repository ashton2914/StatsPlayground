export type ProjectStartupResult={kind:"ready"};
interface StartupDependencies {
 hasProject():boolean;
 enabled():Promise<boolean>;
 createDraft():Promise<unknown>;
 legacyInit():Promise<unknown>;
}
export function createProjectStartup(deps:StartupDependencies) {
 let starting:Promise<ProjectStartupResult>|null=null;
 return {start():Promise<ProjectStartupResult> {
  if(starting) return starting;
  starting=(async():Promise<ProjectStartupResult>=>{
   if(deps.hasProject()) return {kind:"ready"};
   if(await deps.enabled()) {
    await deps.createDraft();
   } else await deps.legacyInit();
   return {kind:"ready"};
  })().finally(()=>{starting=null;});
  return starting;
 }};
}

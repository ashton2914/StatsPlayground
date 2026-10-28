export interface RecoverableProjectDraft {projectId:string;displayName:string;recoveryId:string}
export type ProjectStartupResult={kind:"ready"}|{kind:"recovery";drafts:RecoverableProjectDraft[]};
interface StartupDependencies {
 hasProject():boolean;
 enabled():Promise<boolean>;
 listDrafts():Promise<RecoverableProjectDraft[]>;
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
    const drafts=await deps.listDrafts();
    if(drafts.length) return {kind:"recovery",drafts};
    await deps.createDraft();
   } else await deps.legacyInit();
   return {kind:"ready"};
  })().finally(()=>{starting=null;});
  return starting;
 }};
}

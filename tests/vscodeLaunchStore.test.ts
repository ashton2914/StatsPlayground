import assert from "node:assert/strict";
import { createMcpStore } from "../src/stores/useMcpStore.ts";

const plan = {configurationPath:".mcp.json",planId:"plan-1",workspaceDisplayName:"Demo",configurationAction:"merge",confirmationRequired:true,currentEndpoint:"Different endpoint",proposedEndpoint:"http://127.0.0.1:48123/mcp",gitProtection:"localExclude",settingsAction:"reuse",warnings:["localCredential"]} as const;
const result = {configurationPath:".mcp.json",workspaceDisplayName:"Demo",configurationResult:"merge",serverState:"running",endpoint:"http://127.0.0.1:48123/mcp",launchResult:"configuredVsCodeNotFound",warnings:[]} as const;
let selected:string|null="/private/Demo"; let executions=0;
const store = createMcpStore({
  launchService:{
    selectWorkspace:async()=>selected,
    planVsCodeLaunch:async(path:string)=>{assert.equal(path,"/private/Demo");return {...plan,warnings:[...plan.warnings]};},
    executeVsCodeLaunch:async(request:{planId:string;approveConflict:boolean})=>{assert.deepEqual(request,{planId:"plan-1",approveConflict:true});executions++;return {...result,warnings:[]};},
  },
});
store.setState({refresh:async()=>{store.setState({settings:{port:48123,token:"a".repeat(32)},status:{state:"running",endpoint:result.endpoint,token:"a".repeat(32),activeConnections:0,queuedRequests:0,runningRequests:0}})}});
await store.getState().launchVSCode();
assert.equal(store.getState().launchPlan?.workspaceDisplayName,"Demo");
assert.equal(store.getState().launchPlan?.configurationPath,".mcp.json");
assert.equal(JSON.stringify(store.getState()).includes("/private/Demo"),false);
assert.equal(executions,0);
store.getState().cancelVsCodeLaunch();
assert.equal(store.getState().launchPlan,null);
await store.getState().executeVsCodeLaunch();
assert.equal(executions,0);
await store.getState().launchVSCode();
await store.getState().executeVsCodeLaunch();
assert.equal(store.getState().launchResult?.launchResult,"configuredVsCodeNotFound");
assert.equal(store.getState().status.state,"running");
assert.equal(store.getState().settings?.port,48123);
assert.equal(store.getState().launchPlan,null);
selected=null;
await store.getState().launchVSCode();
assert.equal(store.getState().launchPlan,null);
assert.equal(executions,1);
console.log("VS Code launch store tests passed");

const failedStore = createMcpStore({launchService:{
  selectWorkspace:async()=>"/private/Demo",
  planVsCodeLaunch:async()=>({...plan,warnings:[]}),
  executeVsCodeLaunch:async()=>{throw new Error("Launch plan is stale");},
}});
let refreshed=false;
failedStore.setState({refresh:async()=>{refreshed=true;}});
await failedStore.getState().launchVSCode();
await failedStore.getState().executeVsCodeLaunch();
assert.equal(failedStore.getState().launchError,"Launch plan is stale");
assert.equal(failedStore.getState().launchResult,null);
assert.equal(failedStore.getState().launchPlan,null);
assert.equal(failedStore.getState().launchBusy,false);
assert.equal(refreshed,true);

const locales=["en","zh-CN","zh-TW","vi"];
const {readFile}=await import("node:fs/promises");
for(const locale of locales){
  const strings=JSON.parse(await readFile(new URL(`../src/i18n/locales/${locale}.json`,import.meta.url),"utf8")).ai.mcpServer.vscode;
  for(const key of ["create","merge","replaceManagedEntry","unchanged"]) assert.equal(typeof strings.action[key],"string");
  for(const key of ["launched","configuredVsCodeNotFound","configuredLaunchFailed"]) assert.equal(typeof strings.result[key],"string");
}

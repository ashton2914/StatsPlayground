import {test,expect} from "@playwright/experimental-ct-react";
import {NativeProjectAppHarness} from "./NativeProjectAppHarness";
test.beforeEach(async({page})=>{await page.evaluate(()=>{(window as any).__APP_VERSION__="0.0.0-test";});});
test("native app startup and project switch use metadata summaries and clear the previous editor",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness/>);
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 expect((await page.evaluate(()=>(window as any).__nativeApp.calls())).filter((call:any)=>call.command==="get_project_document")).toHaveLength(0);
 await app.getByText("Draft report.sprp",{exact:true}).click();
 await expect(app.getByRole("heading",{name:"Draft body"})).toBeVisible();
 await app.getByText("File",{exact:true}).click();
 await app.locator(".menu-item").filter({hasText:"Open Project"}).click();
 await expect(app.getByText("Second report.sprp",{exact:true})).toBeVisible();
 await expect(app.getByRole("heading",{name:"Draft body"})).toHaveCount(0);
 await app.getByText("Second report.sprp",{exact:true}).click();
 await expect(app.getByRole("heading",{name:"Second body"})).toBeVisible();
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>["init_project","open_project","save_project"].includes(call.command))).toEqual([]);
 expect(calls.filter((call:any)=>call.command==="get_project_document").map((call:any)=>call.args.epoch)).toEqual([1,2]);
});
test("first save names the draft once and ordinary save only drains the queue",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness/>);
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 await app.getByText("File",{exact:true}).click();
 await app.locator(".menu-item").filter({hasText:/^Save(?:⌘|Ctrl)/}).first().click();
 await expect(app.getByText("Named report.sprp",{exact:true})).toBeVisible();
 await expect(app.locator(".save-toast")).toHaveCount(0);
 await page.keyboard.press("Control+s");
 await expect(app.locator(".save-toast")).toContainText("Saved");
 await expect.poll(async()=>{const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());return calls.filter((call:any)=>call.command==="snapshot_project_v5").length;}).toBe(1);
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.find((call:any)=>call.command==="snapshot_project_v5").args).toEqual({epoch:1,filePath:"/virtual/named.spprj",firstNaming:true});
 expect(calls.filter((call:any)=>call.command==="save_project")).toEqual([]);
});

test("window close prevents duplicate destruction and waits for the accepted document commit",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness/>);
 await app.getByText("Draft report.sprp",{exact:true}).click();
 await expect(app.getByRole("heading",{name:"Draft body"})).toBeVisible();
 await page.evaluate(()=>{const harness=(window as any).__nativeApp;harness.holdCommit();harness.editReport();harness.requestClose();harness.requestClose();});
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.calls().filter((call:any)=>call.command==="commit_project_records").length)).toBe(1);
 let calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>["close_project_v5","plugin:window|destroy"].includes(call.command))).toEqual([]);
 await page.evaluate(()=>(window as any).__nativeApp.releaseCommit());
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.calls().filter((call:any)=>call.command==="plugin:window|destroy").length)).toBe(1);
 calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>call.command==="close_project_v5")).toHaveLength(1);
 expect(calls.find((call:any)=>call.command==="commit_project_records").args.patch.documents[0].document.body.markdown).toBe("# Last accepted edit");
});

test("a published snapshot with no recoverable active session exposes an error and working startup retry",async({mount,page})=>{
 page.on("dialog",dialog=>void dialog.dismiss());
 const app=await mount(<NativeProjectAppHarness/>);
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).__nativeApp.failSnapshot());
 await app.getByText("File",{exact:true}).click();
 await app.locator(".menu-item").filter({hasText:/^Save(?:⌘|Ctrl)/}).first().click();
 await expect(app.getByRole("alert")).toContainText("published copy unavailable");
 await expect(app.getByRole("alert")).toContainText("The copy was written to the destination.");
 await app.getByRole("button",{name:"Retry",exact:true}).click();
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 expect((await page.evaluate(()=>(window as any).__nativeApp.calls())).filter((call:any)=>call.command==="create_project_draft_v5")).toHaveLength(2);
});

test("failed native mutation can resolve safely and continue saving queued changes",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness/>);await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).__nativeApp.failMutation());
 const recover=app.getByRole("button",{name:"Continue saving other changes"});await expect(recover).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__nativeApp.calls().filter((call:any)=>call.command==="add_rows").length)).toBe(0);
 await recover.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.persistenceStatus()?.status)).toBe("saved");
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());expect(calls.filter((call:any)=>call.command==="resolve_project_operation")).toHaveLength(1);expect(calls.filter((call:any)=>call.command==="add_rows")).toHaveLength(1);await expect(recover).toHaveCount(0);
});

test('failed close keeps the project open and retries the same document before destruction',async({mount,page})=>{
 const dialogs:string[]=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});const app=await mount(<NativeProjectAppHarness/>);
 await expect(app.getByText('Draft report.sprp',{exact:true})).toBeVisible();
 await app.getByText('Draft report.sprp',{exact:true}).click();await expect(app.getByRole('heading',{name:'Draft body'})).toBeVisible();
 await page.evaluate(()=>{const harness=(window as any).__nativeApp;harness.failNextCommit("disk full /Users/private/project.spprj");harness.editReport();harness.requestClose();});
 await expect(app.getByRole('alert')).toContainText('Changes could not be saved.');
 await expect.poll(()=>dialogs.length).toBe(1);expect(dialogs[0]).not.toContain('/Users/');expect(dialogs[0]).toContain('project is still open');
 let calls=await page.evaluate(()=>(window as any).__nativeApp.calls());expect(calls.filter((call:any)=>['close_project_v5','plugin:window|destroy'].includes(call.command))).toEqual([]);
 await app.getByRole('button',{name:'Retry saving',exact:true}).click();await expect(app.getByRole('status')).toContainText('All changes saved');
 calls=await page.evaluate(()=>(window as any).__nativeApp.calls());const writes=calls.filter((call:any)=>call.command==='commit_project_records');expect(writes).toHaveLength(2);
 const resolutions=calls.filter((call:any)=>call.command==='resolve_project_operation');expect(resolutions).toHaveLength(1);expect(resolutions[0].args.context.operationId).toBe(writes[0].args.context.operationId);
 // A proven cancellation fences the old identity before a new attempt; the
 // accepted document itself must survive unchanged through that recovery.
 expect(writes[1].args.context.operationId).not.toBe(writes[0].args.context.operationId);expect(writes[1].args.patch).toEqual(writes[0].args.patch);
 await page.evaluate(()=>(window as any).__nativeApp.requestClose());await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.calls().filter((call:any)=>call.command==='plugin:window|destroy').length)).toBe(1);
});


test("workflow extraction from the previous project cannot publish into its same-ID successor",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness workflowFixture/>);
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 await app.getByRole("button",{name:"Workflow",exact:true}).click();
 await app.locator(".workflow-node-operation").click();
 await app.getByRole("button",{name:"Save as workflow",exact:true}).click();
 await app.locator("#workflow-name-input").fill("Old project workflow");
 await app.locator(".dialog-actions").getByRole("button",{name:"Save",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.calls().filter((call:any)=>call.command==="extract_workflow").length)).toBe(1);
 await page.evaluate(()=>(window as any).__nativeApp.switchProject());
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeApp.epoch())).toBe(2);
 await page.evaluate(()=>(window as any).__nativeApp.releaseExtraction());
 // Await extraction completion in the actual view before examining state.
 await expect(app.locator("#workflow-name-input")).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__nativeApp.workflows())).toEqual([]);
 expect((await page.evaluate(()=>(window as any).__nativeApp.calls())).filter((call:any)=>call.command==="commit_project_records")).toEqual([]);
});


test("native UI probe samples a painted first catalog page without requiring a table on that page",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness probeFixture/>);
 await expect(page.locator("[data-project-v5-probe-status]")).toContainText("Complete:",{timeout:7000});
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>call.command==="project_ui_probe_begin").map((call:any)=>call.args.scenario)).toEqual(["catalog"]);
 expect(calls.filter((call:any)=>call.command==="get_project_document")).toEqual([]);
 expect(calls.filter((call:any)=>call.command==="list_project_catalog")).toEqual([]);
 const sample=calls.find((call:any)=>call.command==="project_ui_probe_finish").args;
 const phases=sample.retention.uiPhases;expect(phases).toBeDefined();
 expect(phases.operationFinishedMs).toBeGreaterThanOrEqual(0);expect(phases.readyObservedMs).toBeGreaterThanOrEqual(phases.operationFinishedMs);
 expect(phases.framesMs.length).toBeGreaterThanOrEqual(2);
 for(const [start,end] of phases.framesMs){expect(end).toBeGreaterThanOrEqual(start);expect(end).toBeLessThanOrEqual(sample.uiReadyMs);}

});


test("a saving phase with unchanged sequences does not rebuild directory entries",async({mount,page})=>{
 const app=await mount(<NativeProjectAppHarness/>);await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const h=(window as any).__nativeApp;h.observeDirectoryReads();h.pulseSaving();});
 await expect(app.locator(".project-persistence-status")).toContainText("Saving");
 expect(await page.evaluate(()=>(window as any).__nativeApp.directoryNameReads())).toBe(0);
 await expect(app.getByText("Draft report.sprp",{exact:true})).toBeVisible();
});


test("native UI probe waits for native activation before admitting a sample",async({mount,page})=>{
 await mount(<NativeProjectAppHarness probeFixture probeFocusDelay/>);
 await expect(page.locator("[data-project-v5-probe-status]")).toContainText("Complete:",{timeout:7000});
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>call.command==="project_ui_probe_begin")).toHaveLength(1);
});
test("native UI probe preserves an admission failure in published run metadata",async({mount,page})=>{
 await mount(<NativeProjectAppHarness probeFixture probeAdmissionFailure/>);
 await expect(page.locator("[data-project-v5-probe-status]")).toContainText("fixture admission unavailable");
 const calls=await page.evaluate(()=>(window as any).__nativeApp.calls());
 expect(calls.filter((call:any)=>call.command==="project_ui_probe_finish")).toEqual([]);
 const published=calls.filter((call:any)=>call.command==="project_ui_probe_publish");expect(published.length).toBeGreaterThan(0);
 expect(published.every((call:any)=>call.args.runError?.includes("fixture admission unavailable"))).toBe(true);
});

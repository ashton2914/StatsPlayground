import {expect,test} from "@playwright/experimental-ct-react";
import {ProjectLazyHydrationHarness} from "./ProjectLazyHydrationHarness";
test.beforeEach(async({page})=>{await page.evaluate(()=>{(window as any).__APP_VERSION__="0.0.0-test";});});
test("directory shows metadata and selection reads only its report body",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness/>);
  await expect(component.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
  await expect(component.getByText("Distribution.span",{exact:true})).toBeVisible();
  await expect(component.getByText("Overview.spgn",{exact:true})).toBeVisible();
  await expect(component.getByText("Empty",{exact:true})).toBeVisible();
  await expect(component.getByText("10000000×2",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:0,reports:0,analyses:0,pending:0});
  const item=component.getByText("Quarterly report.sprp",{exact:true});await item.click();await item.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().reads)).toBe(1);
  await expect(component.getByText("Loaded on demand",{exact:true})).toHaveCount(0);
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await expect(component.getByRole("heading",{name:"Loaded on demand"})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:1,reports:1,analyses:0,pending:0});
});
test("a selected body load failure can be retried",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness failFirst/>);
  await component.getByText("Quarterly report.sprp",{exact:true}).click();
  await expect(component.getByRole("alert")).toContainText("Unable to open this item");
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await component.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(component.getByRole("heading",{name:"Loaded on demand"})).toBeVisible();
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(2);
});

test("rename and delete an unloaded report without reading its body",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness/>);
  const report=component.getByText("Quarterly report.sprp",{exact:true});await expect(report).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
  await report.click({button:"right"});await expect(component.getByText("Rename",{exact:true})).toBeVisible();
  await component.getByText("Rename",{exact:true}).click();
  const input=component.locator(".ds-rename-input");await input.fill("Renamed report");await input.press("Enter");
  const renamed=component.getByText("Renamed report.sprp",{exact:true});await expect(renamed).toBeVisible();
  await renamed.click({button:"right"});await component.getByText("Delete",{exact:true}).click();
  await expect(renamed).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().pending)).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:0,reports:0,analyses:0,pending:0});
  const mutations=await page.evaluate(()=>(window as any).__projectLazy.mutations());
  expect(mutations).toHaveLength(2);expect(mutations[0].directoryMoves[0].name).toBe("Renamed report");expect(mutations[1].deletedDocumentIds).toEqual(["report"]);
});

test("deleting a selected document closes its editor before the commit finishes",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness/>);
  const report=component.getByText("Quarterly report.sprp",{exact:true});await expect(report).toBeVisible();
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await report.click();
  await expect(component.getByRole("heading",{name:"Loaded on demand"})).toBeVisible();
  await page.evaluate(()=>(window as any).__projectLazy.holdCommit());
  await report.click({button:"right"});await component.getByText("Delete",{exact:true}).click();
  await expect(component.getByRole("heading",{name:"Loaded on demand"})).toHaveCount(0);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reports).toBe(1,"the loaded body remains recoverable until deletion is acknowledged");
  await page.evaluate(()=>(window as any).__projectLazy.releaseCommit());
  await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().reports)).toBe(0);
  expect((await page.evaluate(()=>(window as any).__projectLazy.mutations())).map((patch:any)=>patch.deletedDocumentIds)).toEqual([["report"]]);
});

test("a pending new document opens from its local body without waiting for a read",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness/>);
  await expect(component.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
  const metadataBefore=await page.evaluate(()=>(window as any).__projectLazy.metadataReads());
  await page.evaluate(()=>{(window as any).__projectLazy.holdCommit();(window as any).__projectLazy.createReport();});
  await component.getByText("New draft.sprp",{exact:true}).click();
  await expect(component.getByRole("heading",{name:"New local document"})).toBeVisible();
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.metadataReads())).toBe(metadataBefore,"selecting a local report must not refresh unrelated table metadata");
  await page.evaluate(()=>(window as any).__projectLazy.releaseCommit());
  await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().pending)).toBe(0);
});


test("a selected transform reads only its definition and binding, retaining its saved run status",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withTransform/>);
  const item=component.getByText("Reusable sort.sptbtf",{exact:true});
  await expect(item).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual([]);
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await item.click();
  await expect(component.getByRole("heading",{name:"Reusable sort",exact:true})).toBeVisible();
  await expect(component.locator(".table-transform-status")).toHaveText("succeeded");
  await expect(component.getByText("Generation 4",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual(["transformBinding:transform"]);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(1);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});


test("selecting a table restores only its saved filter before querying a bounded window",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withFilter/>);
  await expect(component.getByText("10000000×2",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual([]);
  expect(await page.evaluate(()=>(window as any).__projectLazy.windowRequests())).toEqual([]);
  await component.getByText("Measurements.sptb",{exact:true}).click();
  await expect(component.getByText("Displayed rows",{exact:true}).locator("..")).toContainText("2");
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual(["filter:table"]);
  const requests=await page.evaluate(()=>(window as any).__projectLazy.windowRequests());
  expect(requests.length).toBeGreaterThan(0);
  for(const request of requests) {expect(request.filters).toHaveLength(1);if(request.count) expect(request.count).toBeLessThanOrEqual(500);}
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});


test("deleting an unloaded transform loads only settings and preserves unrelated lineage",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withTransform/>);
  const item=component.getByText("Reusable sort.sptbtf",{exact:true});await expect(item).toBeVisible();
  await item.click({button:"right"});await component.getByText("Delete",{exact:true}).click();
  await expect(item).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().pending)).toBe(0);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual(["lineage","transformBinding:transform"]);
  const patches=await page.evaluate(()=>(window as any).__projectLazy.mutations());
  expect(patches).toHaveLength(1);expect(patches[0].deletedDocumentIds).toEqual(["transform"]);
  expect(patches[0].settings.map((write:any)=>[write.key,write.expectedRevision])).toEqual([["lineage",3],["transformBinding:transform",1]]);
  expect(patches[0].settings[0].value.nodes.map((node:any)=>node.id)).toEqual(["retained-op"]);
  expect(patches[0].settings[1].value).toBeNull();
});


test("directory pages remain accessible and failed metadata reads can be retried without body reads",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness pagedCatalog/>);
  await expect(component.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.pageReads())).toEqual([]);
  await component.getByRole("button",{name:"Load more",exact:true}).click();
  await expect(component.getByRole("alert")).toContainText("Unable to load more items");
  await component.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(component.getByText("Later report.sprp",{exact:true})).toBeVisible();
  await expect(component.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
  await expect(component.getByText("Later",{exact:true})).toBeVisible();
  await expect(component.getByRole("button",{name:"Load more",exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.pageReads())).toEqual([{after:"page2",limit:200},{after:"page2",limit:200}]);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});


test("workflow navigation lists unloaded definitions and reads persisted lineage without reconstructing partial bodies",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withWorkflow/>);
  await component.getByRole("button",{name:"Workflow",exact:true}).click();
  await expect(component.getByRole("button",{name:"Saved workflow",exact:true})).toBeVisible();
  await expect(component.locator(".workflow-node")).toHaveCount(2);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual(["lineage"]);
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await component.getByRole("button",{name:"Saved workflow",exact:true}).click();
  await expect(component.getByRole("heading",{name:"Saved workflow",exact:true})).toBeVisible();
  await expect(component.locator(".workflow-node")).toHaveCount(1);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(1);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});

test("an unloaded workflow body failure can be retried without replacing its catalog entry",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withWorkflow failFirst/>);
  await component.getByRole("button",{name:"Workflow",exact:true}).click();
  await component.getByRole("button",{name:"Saved workflow",exact:true}).click();
  await expect(component.getByRole("alert")).toContainText("Unable to open this item");
  await component.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(component.getByRole("heading",{name:"Saved workflow",exact:true})).toBeVisible();
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(2);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});


test("report insertion lists unopened analysis types from metadata without loading their bodies",async({mount,page})=>{
 const component=await mount(<ProjectLazyHydrationHarness/>);
 await component.getByText("Quarterly report.sprp",{exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().reads)).toBe(1);
 await page.evaluate(()=>(window as any).__projectLazy.release());
 await expect(component.getByRole("heading",{name:"Loaded on demand",exact:true})).toBeVisible();
 await component.getByRole("button",{name:"Insert project document",exact:true}).click();
 await expect(component.getByRole("menuitem",{name:"Distribution",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:1,reports:1,analyses:0,pending:0});
});


test("selecting a native workflow shows its durable run count without reading run packets",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withWorkflow/>);
  await component.getByRole("button",{name:"Workflow",exact:true}).click();
  await expect(component.locator(".workflow-node")).toHaveCount(2);
  expect(await page.evaluate(()=>(window as any).__projectLazy.runStateReads())).toEqual([]);
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await component.getByRole("button",{name:"Saved workflow",exact:true}).click();
  await expect(component.getByRole("heading",{name:"Saved workflow",exact:true})).toBeVisible();
  await expect(component.getByText("Revision 1 · 73 runs",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__projectLazy.runStateReads())).toEqual([{epoch:7,workflowId:"saved-workflow",workflowRevision:1}]);
  expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(1);
  expect(await page.evaluate(()=>(window as any).__projectLazy.settingReads())).toEqual(["lineage"]);
  expect(await page.evaluate(()=>(window as any).__projectLazy.mutations())).toEqual([]);
});


test("refreshing native workflow run metadata preserves the user's selected input",async({mount,page})=>{
  const component=await mount(<ProjectLazyHydrationHarness withWorkflow/>);
  await component.getByRole("button",{name:"Workflow",exact:true}).click();
  await page.evaluate(()=>(window as any).__projectLazy.release());
  await component.getByRole("button",{name:"Saved workflow",exact:true}).click();
  await expect(component.getByText("Revision 1 · 73 runs",{exact:true})).toBeVisible();
  const source=component.locator(".workflow-input-row select");
  await source.selectOption("table");
  await page.evaluate(()=>(window as any).__projectLazy.appendWorkflowRun());
  await expect(component.getByText("Revision 1 · 74 runs",{exact:true})).toBeVisible();
  await expect(source).toHaveValue("table");
});

test("native project can undo a hidden table from the workspace without loading its rows",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness withLifecycle/>);
 await expect(workspace.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toHaveCount(0);
 await page.keyboard.press("Control+z");
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toBeVisible();
 await expect(workspace.getByText("Overview.spgn",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__projectLazy.windowRequests())).toEqual([]);
 expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
 await page.keyboard.press("Control+Shift+z");
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toHaveCount(0);
 expect((await page.evaluate(()=>(window as any).__projectLazy.historyCalls())).map((item:any)=>item.undo)).toEqual([true,false]);
});

test("native workspace history keeps text undo and read-only mode separate",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness withLifecycle/>);
 const report=workspace.getByText("Quarterly report.sprp",{exact:true});await expect(report).toBeVisible();
 await report.click({button:"right"});await workspace.getByText("Rename",{exact:true}).click();
 const input=workspace.locator(".ds-rename-input");await input.fill("Typing a name");await input.press("Control+z");
 expect(await page.evaluate(()=>(window as any).__projectLazy.historyCalls())).toEqual([]);
 await input.press("Escape");await page.evaluate(()=>(window as any).__projectLazy.setReadOnly(true));
 await page.keyboard.press("Control+z");expect(await page.evaluate(()=>(window as any).__projectLazy.historyCalls())).toEqual([]);
 await page.evaluate(()=>(window as any).__projectLazy.setReadOnly(false));await page.keyboard.press("Control+z");
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toBeVisible();
});

test("native history failure is visible without a table editor and can be retried",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness withLifecycle/>);
 await expect(workspace.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).__projectLazy.failHistoryRead(true));await page.keyboard.press("Control+z");
 await expect(workspace.getByText("Could not undo or redo this action.",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__projectLazy.historyCalls())).toEqual([]);
 await page.evaluate(()=>(window as any).__projectLazy.failHistoryRead(false));await page.keyboard.press("Control+z");
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toBeVisible();
});

test("native inline cell editing commits only the edited cell with its visible generation",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness/>);
 await workspace.getByText("Measurements.sptb",{exact:true}).click();
 const cell=workspace.locator(".sp-grid tbody tr:has(td.sp-cell)").first().locator("td.sp-cell").first();
 await expect(cell).toContainText("1");await cell.dblclick();const input=workspace.locator(".sp-cell-input");
 await expect(input).toBeVisible();await input.fill("7");await input.press("Enter");await expect(cell).toContainText("7");
 const mutations=await page.evaluate(()=>(window as any).__projectLazy.cellMutations());expect(mutations).toHaveLength(1);
 expect(mutations[0].updates).toEqual([{rowId:1,columnName:"value",value:"7"}]);expect(mutations[0].expectedGeneration).toBe(0);expect(mutations[0].context.datasetGenerations).toEqual([{id:"table",generation:0}]);
});

test("native table keyboard replay does not dispatch a second workspace action",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness withLifecycle/>);
 await expect(workspace.getByText("Quarterly report.sprp",{exact:true})).toBeVisible();await page.keyboard.press("Control+z");
 await workspace.getByText("Measurements.sptb",{exact:true}).click();const table=workspace.locator(".sp-spreadsheet");await expect(table).toBeVisible();await table.focus();await table.press("Control+Shift+z");
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toHaveCount(0);
 expect((await page.evaluate(()=>(window as any).__projectLazy.historyCalls())).map((item:any)=>item.undo)).toEqual([true,false]);
});

test("native graph file import avoids IDs owned by unopened documents",async({mount,page})=>{
 const workspace=await mount(<ProjectLazyHydrationHarness/>);
 await expect(workspace.getByText("Overview.spgn",{exact:true})).toBeVisible();
 await workspace.getByText("Graph",{exact:true}).click();await workspace.getByText("Import .spgh Graph File",{exact:true}).click();
 await expect(workspace.getByText("Imported graph.spgh",{exact:true})).toBeVisible();
 await expect(workspace.getByText("Overview.spgn",{exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.snapshot().pending)).toBe(0);
 const mutations=await page.evaluate(()=>(window as any).__projectLazy.mutations());const written=mutations.flatMap((patch:any)=>patch.documents??[]).find((write:any)=>write.document.summary.kind==="graph");
 expect(written.document.summary.id).not.toBe("graph");expect(written.document.body.sourceDatasetId).toBe("not-present");
 expect((await page.evaluate(()=>(window as any).__projectLazy.snapshot())).reads).toBe(0);
});


test("native project conversion can be declined without loading old data",async({mount,page})=>{
 const alerts:string[]=[];page.on("dialog",async dialog=>{alerts.push(dialog.message());await dialog.dismiss();});
 const workspace=await mount(<ProjectLazyHydrationHarness withMigration confirmMigration={false}/>);
 await workspace.getByText("File",{exact:true}).click();await workspace.locator(".menu-item").filter({hasText:"Open Project"}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.migration().prompts.length)).toBe(1);
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__projectLazy.migration().requests)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:0,reports:0,analyses:0,pending:0});expect(alerts).toEqual([]);
});

test("native project conversion cancellation retains the current project",async({mount,page})=>{
 const alerts:string[]=[];page.on("dialog",async dialog=>{alerts.push(dialog.message());await dialog.dismiss();});
 const workspace=await mount(<ProjectLazyHydrationHarness withMigration/>);
 await workspace.getByText("File",{exact:true}).click();await workspace.locator(".menu-item").filter({hasText:"Open Project"}).click();
 const cancel=workspace.getByRole("button",{name:"Cancel conversion",exact:true});await expect(cancel).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).__projectLazy.migration().requests.length)).toBe(1);
 await cancel.click();await expect(cancel).toHaveCount(0);
 await expect(workspace.getByText("Measurements.sptb",{exact:true})).toBeVisible();
 const conversion=await page.evaluate(()=>(window as any).__projectLazy.migration());expect(conversion.cancelCalls).toBe(1);
 expect(conversion.requests[0]).toMatchObject({source:"/virtual/old.spprj",destination:"/virtual/old-v5.spprj"});
 expect(await page.evaluate(()=>(window as any).__projectLazy.snapshot())).toEqual({reads:0,reports:0,analyses:0,pending:0});expect(alerts).toEqual([]);
});

import {test,expect} from "@playwright/experimental-ct-react";
import {NativeHistoryPanelHarness} from "./NativeHistoryPanelHarness";

test("native history loads bounded summaries only when shown and pages on request",async({mount,page})=>{
  const component=await mount(<NativeHistoryPanelHarness/>);
  await expect(component.getByRole("button",{name:"Show history"})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__nativeHistory.requests())).toEqual([]);
  await component.getByRole("button",{name:"Show history"}).click();
  await expect(component.locator(".history-item")).toHaveCount(2);
  await expect(component.getByText("Unrelated local history")).toHaveCount(0);
  await expect(component.getByText("Undone",{exact:true})).toBeVisible();
  await expect(component.locator(".history-item").first()).toContainText("Measurements");
  await component.getByRole("button",{name:"Load more"}).click();
  await expect(component.locator(".history-item")).toHaveCount(3);
  await expect(component.getByRole("button",{name:"Load more"})).toHaveCount(0);
  expect((await page.evaluate(()=>(window as any).__nativeHistory.requests())).map((request:any)=>request.request)).toEqual([{datasetId:null,after:null,limit:200},{datasetId:null,after:"more",limit:200}]);
});

test("native history read failures have a working retry in a read-only project",async({mount,page})=>{
  const component=await mount(<NativeHistoryPanelHarness failFirst/>);
  await component.getByRole("button",{name:"Show history"}).click();
  await expect(component.getByRole("alert")).toContainText("Unable to load history");
  await component.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(component.locator(".history-item")).toHaveCount(2);
  expect((await page.evaluate(()=>(window as any).__nativeHistory.requests())).length).toBe(2);
});

test("native snapshot names load as bounded descriptors without legacy row captures",async({mount,page})=>{
 const panel=await mount(<NativeHistoryPanelHarness/>);
 await panel.getByRole("button",{name:"Show history"}).click();
 await expect(panel.getByText(/Disk checkpoint/)).toBeVisible();
 const reads=await page.evaluate(()=>(window as any).__nativeHistory.snapshotRequests());
 expect(reads).toEqual([{epoch:707,after:null,limit:200}]);
});

test("snapshot progress listener failure releases the busy action for retry",async({mount,page})=>{
 const panel=await mount(<NativeHistoryPanelHarness writable failListenOnce/>);
 await panel.getByRole("button",{name:"Show history"}).click();await expect(panel.getByText(/Disk checkpoint/)).toBeVisible();
 await panel.getByTitle(/create snapshot/i).click();
 await expect(panel.getByRole("alert")).toContainText("injected listener failure");
 await panel.getByTitle(/create snapshot/i).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__nativeHistory.writes().length)).toBe(1);
 const name=await page.evaluate(()=>(window as any).__nativeHistory.writes()[0].payload.name);
 await expect(panel.getByText(name,{exact:false})).toBeVisible();
});

 test("native lifecycle history identifies hidden tables without loading their contents",async({mount})=>{
 const panel=await mount(<NativeHistoryPanelHarness lifecycle/>);
 await panel.getByRole("button",{name:"Show history"}).click();
 await expect(panel.locator(".history-item").first()).toContainText('Delete table "Retired measurements"');
 await expect(panel.locator(".history-item").nth(1)).toContainText('New table "Retired measurements"');
 });


test("native history shows archived descriptions without offering replay",async({mount,page})=>{
 const component=await mount(<NativeHistoryPanelHarness archived writable/>);await component.getByText("Show history",{exact:true}).click();
 const entry=component.getByText("Rename old report",{exact:true});await expect(entry).toBeVisible();
 await expect(component.getByText("From the previous project",{exact:true})).toBeVisible();
 await entry.click();expect(await page.evaluate(()=>(window as any).__nativeHistory.writes())).toEqual([]);
 await expect(entry.locator("xpath=../..")).not.toHaveClass(/history-clickable/);
});

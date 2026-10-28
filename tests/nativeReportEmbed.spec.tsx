import {expect,test} from "@playwright/experimental-ct-react";
import {NativeReportEmbedHarness} from "./NativeReportEmbedHarness";
test("a native report loads an unopened embedded table with a bounded preview",async({mount,page})=>{
 const component=await mount(<NativeReportEmbedHarness/>);
 await expect(component.getByRole("table",{name:"Unopened source"})).toContainText("42");
 expect(await page.evaluate(()=>(window as any).__nativeReportCalls)).toEqual(["list_datasets"]);
 const windows=await page.evaluate(()=>(window as any).__nativeReportWindows);
 expect(windows).toHaveLength(1);expect(windows[0].count).toBe(20);
});
test("native embed metadata failures offer retry without fetching full table data",async({mount,page})=>{
 const component=await mount(<NativeReportEmbedHarness failMetadata/>);
 await expect(page.getByRole("alert")).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__nativeReportWindows)).toEqual([]);
 await component.getByRole("button",{name:"Retry",exact:true}).click();
 await expect(component.getByRole("table",{name:"Unopened source"})).toContainText("42");
 expect(await page.evaluate(()=>(window as any).__nativeReportCalls)).toEqual(["list_datasets","list_datasets"]);
});

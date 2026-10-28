import {test,expect} from "@playwright/experimental-ct-react";
import {ProjectViewportEpochHarness} from "./ProjectViewportEpochHarness";
test("switching native projects fences old windows with identical table IDs and generations",async({mount,page})=>{
 const component=await mount(<ProjectViewportEpochHarness/>);
 await expect.poll(()=>page.evaluate(()=>(window as any).__epochViewport.reads())).toBe(1);
 await page.evaluate(()=>(window as any).__epochViewport.switch());
 await expect(component.getByText("new-project-row-1",{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).__epochViewport.releaseOld());
 await expect(component.getByText("old-project-row-1",{exact:true})).toHaveCount(0);
 await expect(component.getByText("new-project-row-1",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__epochViewport.reads())).toBe(2);
});

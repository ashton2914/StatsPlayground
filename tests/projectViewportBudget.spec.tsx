import {test,expect} from "@playwright/experimental-ct-react";
import {ProjectViewportBudgetHarness} from "./ProjectViewportBudgetHarness";
test("three real table views share two bounded cache slots and release their leases",async({mount,page})=>{
 const component=await mount(<ProjectViewportBudgetHarness/>);
 for(let index=0;index<3;index++) await expect(component.getByText(`table-${index}-row-1`,{exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).__viewportBudget.snapshot().retainedViewports)).toBe(2);
 const state=await page.evaluate(()=>(window as any).__viewportBudget.snapshot());
 expect(state.rows).toBeGreaterThan(0);expect(state.rows).toBeLessThanOrEqual(10000);expect(state.bytes).toBeLessThanOrEqual(134217728);
 await component.unmount();
 await expect.poll(()=>page.evaluate(()=>(window as any).__viewportBudget.snapshot().retainedViewports)).toBe(0);
});

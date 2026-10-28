import {test,expect} from "@playwright/experimental-ct-react";
import {ProjectRecoveryChoice} from "../src/components/ProjectRecoveryChoice";
test("recovery offers each draft and keeps starting fresh separate from recovery",async({mount})=>{
 const selected:string[]=[];let fresh=0;
 const component=await mount(<ProjectRecoveryChoice drafts={[{projectId:"p1",displayName:"Experiment",recoveryId:"opaque-1"},{projectId:"p2",displayName:"Second",recoveryId:"opaque-2"}]} onRecover={id=>{selected.push(id);}} onNew={()=>{fresh++;}}/>);
 expect(selected).toEqual([]);expect(fresh).toBe(0);
 await component.getByRole("button",{name:"Experiment"}).click();expect(selected).toEqual(["opaque-1"]);
 await component.getByRole("button",{name:"New Project"}).click();expect(fresh).toBe(1);
});
test("recovery blocks duplicate actions and shows errors without losing the choices",async({mount})=>{
 const component=await mount(<ProjectRecoveryChoice drafts={[{projectId:"p",displayName:"Experiment",recoveryId:"opaque"}]} busy error="Unable to reopen project" onRecover={()=>{}} onNew={()=>{}}/>);
 await expect(component.getByRole("alert")).toContainText("Unable to reopen project");
 await expect(component.getByRole("button",{name:"Experiment"})).toBeDisabled();
 await expect(component.getByRole("button",{name:"New Project"})).toBeDisabled();
});

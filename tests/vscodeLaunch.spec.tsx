import { expect, test } from "@playwright/experimental-ct-react";
import { VsCodeLaunchHarness } from "./VsCodeLaunchHarness";

test("requires explicit replacement approval and supports decline", async ({ mount, page }) => {
  const component = await mount(<VsCodeLaunchHarness />);
  await component.getByRole("button", {name:"Launch VS Code",exact:true}).click();
  await expect(component.getByRole("dialog")).toBeVisible();
  await expect(component.getByRole("dialog")).toContainText(".mcp.json");
  await expect(component.getByText("Different endpoint")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/private/Demo");
  await component.getByRole("button", {name:"Cancel",exact:true}).click();
  await expect(component.getByRole("dialog")).toHaveCount(0);
  await expect(component.getByRole("status")).toHaveCount(0);
  await component.getByRole("button", {name:"Launch VS Code",exact:true}).click();
  await component.getByRole("button", {name:"Replace entry and launch"}).click();
  await expect(component.getByRole("status")).toContainText("Configured Demo and launched VS Code");
});

for (const scenario of ["notFound", "launchFailed"] as const) {
  test(`retains configuration and shows manual recovery: ${scenario}`, async ({mount}) => {
    const component=await mount(<VsCodeLaunchHarness scenario={scenario} />);
    await component.getByRole("button",{name:"Launch VS Code",exact:true}).click();
    await component.getByRole("button",{name:"Configure and launch"}).click();
    await expect(component.getByRole("status")).toContainText("Open this folder manually in Stable VS Code");
  });
}
for (const scenario of ["cancel", "tracked"] as const) {
  test(`no configuration after picker cancellation or tracked refusal: ${scenario}`,async ({mount})=>{
    const component=await mount(<VsCodeLaunchHarness scenario={scenario}/>);
    await component.getByRole("button",{name:"Launch VS Code",exact:true}).click();
    await expect(component.getByRole("dialog")).toHaveCount(0);
    await expect(component.getByRole("status")).toHaveCount(0);
    if(scenario==="tracked") await expect(component.getByRole("alert")).toContainText("Git-tracked");
  });
}

test("shows the reused legacy configuration path in preview and result", async ({mount}) => {
  const component = await mount(<VsCodeLaunchHarness scenario="legacy" />);
  await component.getByRole("button", {name:"Launch VS Code",exact:true}).click();
  await expect(component.getByRole("dialog")).toContainText(".vscode/mcp.json");
  await component.getByRole("button", {name:"Configure and launch"}).click();
  await expect(component.getByRole("status")).toContainText(".vscode/mcp.json");
});

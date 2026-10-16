import { test, expect } from "@playwright/experimental-ct-react";
import { GraphBuilderNewHarness } from "./GraphBuilderNewHarness";
test.beforeEach(({page})=>{ page.on("pageerror",error=>console.error("PAGEERROR",error.message)); });
const readRequest=async (view:any)=>JSON.parse(await view.getByTestId("render-request").textContent());
test("layers parity defaults, independent settings, empty layers and add menu", async ({mount})=>{
 const view=await mount(<GraphBuilderNewHarness mode="render"/>);
 const scatter=view.getByTestId("graph-layer-points");
 await expect(scatter).toContainText("Scatter");await expect(view.getByTestId("graph-layer-line")).toHaveCount(0);
 await expect(scatter.getByLabel("Summary Statistic")).toHaveValue("none");
 await expect(scatter.getByLabel("Jitter Limit")).toHaveValue("0.5");
 await view.getByTestId("legacy-x-field").selectOption("column-x");await view.getByTestId("legacy-y-field").selectOption("column-y");
 await expect(view.getByTestId("render-metrics")).toContainText('"presented":1');
 await view.getByRole("button",{name:"Add layer",exact:true}).click();
 await expect(view.getByTestId("graph-layer-add").getByRole("button",{name:"Scatter",exact:true})).toBeDisabled();
 await view.getByTestId("graph-layer-add").getByRole("button",{name:"Line",exact:true}).click();
 const line=view.getByTestId("graph-layer-line");await expect(line.getByLabel("Summary Statistic")).toHaveValue("mean");
 for(const [label,value] of [["Connection","step"],["Summary Statistic","median"],["Fill","toZero"],["Error Interval","ci95"],["Interval Style","band"],["Missing Factors","include"],["Missing Values","break"]]) await line.getByLabel(label,{exact:true}).selectOption(value);
 await line.getByLabel("Row order").check();
 await scatter.getByLabel("Summary Statistic").selectOption("sum");await scatter.getByLabel("Jitter",{exact:true}).selectOption("normal");
 await expect.poll(async()=>{const r=await readRequest(view);return r.layers?.[1]?.options;}).toEqual({rowOrder:true,connection:"step",summaryStat:"median",fill:"toZero",errorInterval:"ci95",intervalStyle:"band",missingFactors:"include",missingValues:"break"});
 expect((await readRequest(view)).layers[0].options.summaryStat).toBe("sum");
 await view.getByRole("button",{name:"Remove Scatter",exact:true}).click();await view.getByRole("button",{name:"Remove Line",exact:true}).click();
 await expect(view.getByText("Add a graph element to begin",{exact:true})).toBeVisible();await expect(view.locator(".graph-new-canvas-host")).toHaveCount(0);
 await view.getByRole("button",{name:"Add layer",exact:true}).click();await view.getByRole("button",{name:"Scatter",exact:true}).click();await expect(scatter).toBeVisible();
});
test("layers parity migrated raw and mean Line settings stay independent",async({mount})=>{
 const view=await mount(<GraphBuilderNewHarness mode="render" legacyLayers/>);
 const lines=view.getByTestId("graph-layer-line");await expect(lines).toHaveCount(2);
 await expect(lines.nth(0).getByLabel("Summary Statistic")).toHaveValue("none");await expect(lines.nth(1).getByLabel("Summary Statistic")).toHaveValue("mean");
 await lines.nth(0).getByLabel("Connection").selectOption("spline");await lines.nth(1).getByLabel("Fill").selectOption("between");
 const doc=JSON.parse((await view.getByTestId("documents").textContent())!)[0];expect(doc.version).toBe(3);expect(doc.layers[1].options.connection).toBe("spline");expect(doc.layers[2].options.fill).toBe("between");expect(doc.layers[1].options.fill).toBe("none");
});
test("layers parity save locks every control and preserves settings",async({mount})=>{
 const view=await mount(<GraphBuilderNewHarness mode="render"/>);
 await view.getByRole("button",{name:"Begin save",exact:true}).click();
 for(const control of await view.getByTestId("graph-layer-points").locator("select,input,button").all())await expect(control).toBeDisabled();
 await expect(view.getByRole("button",{name:"Add layer",exact:true})).toBeDisabled();
});

test("statistics domain changes reacquire full view before restoring a camera", async ({ mount }) => {
  const view = await mount(<GraphBuilderNewHarness mode="summaryDomain" />);
  await view.getByTestId("legacy-x-field").selectOption("column-x");
  await view.getByTestId("legacy-y-field").selectOption("column-y");
  await expect(view.getByTestId("render-metrics")).toContainText('"presented":1');
  await view.getByRole("button", { name: "Remove Scatter", exact: true }).click();
  await view.getByRole("button", { name: "Add layer", exact: true }).click();
  await view.getByRole("button", { name: "Line", exact: true }).click();
  await expect(view.getByRole("img", { name: "Point plot frame" })).toBeVisible();
  await view.getByTestId("graph-layer-line").getByLabel("Summary Statistic").selectOption("sum");
  await expect.poll(async () => (await readRequest(view)).layers[0].options.summaryStat).toBe("sum");
  await expect.poll(async () => (await readRequest(view)).cameraDomain).toBeNull();
  await expect(view.getByTestId("y-axis-ticks")).toContainText("10000");
  await expect(view.getByRole("alert")).toHaveCount(0);
});

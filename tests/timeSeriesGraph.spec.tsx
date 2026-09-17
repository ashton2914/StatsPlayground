import { expect, test } from "@playwright/experimental-ct-react";

import { TimeSeriesGraphHarness } from "./TimeSeriesGraphHarness";

async function itemJson(component) {
  return JSON.parse(await component.getByTestId("time-series-item-json").textContent() ?? "null");
}

async function requestCount(component) {
  return Number(await component.getByTestId("time-series-request-count").textContent() ?? "0");
}

async function selectTimeSeriesLayer(component, page) {
  await component.getByRole("button", { name: "Add layer" }).click();
  await page.getByRole("button", { name: "Time Series" }).click();
}

async function expectNoAdditionalStreamAfter(component, action) {
  const before = await requestCount(component);
  await action();
  await expect.poll(() => requestCount(component)).toBe(before);
}

async function expectLastTimeSeriesInterpretation(component, interpretation) {
  await expect.poll(async () => JSON.parse(await component.getByTestId("time-series-request-json").textContent() ?? "null")?.elements?.[0]?.timeSeries?.xInterpretation).toEqual(interpretation);
}

test("activating Time Series removes incompatible raw layers and uses native DATE at full resolution", async ({ mount, page }) => {
  const component = await mount(<TimeSeriesGraphHarness />);

  await expect(component.getByRole("button", { name: "Sample" })).toBeVisible();
  await selectTimeSeriesLayer(component, page);

  await expect(component.getByRole("button", { name: "Sample" })).toHaveCount(0);
  await expect(component.getByText("Full resolution", { exact: false })).toBeVisible();
  await expect(component.getByText("9 included", { exact: false })).toBeVisible();
  await expect.poll(async () => (await itemJson(component)).modeStates.twoD.elements.map((element) => element.kind)).toEqual(["timeSeries"]);
  await expect.poll(async () => JSON.parse(await component.getByTestId("time-series-request-json").textContent() ?? "null")?.elements?.[0]?.timeSeries?.xInterpretation).toEqual({ kind: "nativeTemporal" });
});

test("Time Series blocks unsupported X interpretations until explicit allowlisted choices are selected", async ({ mount, page }) => {
  const component = await mount(<TimeSeriesGraphHarness />);
  await selectTimeSeriesLayer(component, page);
  await expectLastTimeSeriesInterpretation(component, { kind: "nativeTemporal" });

  await expectNoAdditionalStreamAfter(component, () => component.getByRole("button", { name: "Use VARCHAR X" }).click());
  await expect(component.getByText("Choose one of the supported text date formats for Screenshot Date.")).toBeVisible();
  await component.locator(".gb-layer-card", { hasText: "Time Series" }).getByRole("combobox").nth(0).selectOption("textDate");
  await component.locator(".gb-layer-card", { hasText: "Time Series" }).getByRole("combobox").nth(1).selectOption("usDate");
  await expect(component.getByText("Choose one of the supported text date formats for Screenshot Date.")).toHaveCount(0);
  await expectLastTimeSeriesInterpretation(component, { kind: "textDate", format: "usDate" });

  await expectNoAdditionalStreamAfter(component, () => component.getByRole("button", { name: "Use numeric X" }).click());
  await expect(component.getByText("Choose Sequence / elapsed value for numeric Time Series X column Elapsed.")).toBeVisible();
  await component.locator(".gb-layer-card", { hasText: "Time Series" }).getByRole("combobox").nth(0).selectOption("sequence");
  await expect(component.getByText("Choose Sequence / elapsed value for numeric Time Series X column Elapsed.")).toHaveCount(0);
  await expectLastTimeSeriesInterpretation(component, { kind: "sequence" });

  await component.locator(".gb-layer-card", { hasText: "Time Series" }).getByRole("combobox").nth(0).selectOption("nativeTemporal");
  await expectNoAdditionalStreamAfter(component, () => component.getByRole("button", { name: "Use TIME X" }).click());
  await expect(component.getByText("Standalone TIME columns cannot define Time Series order. Choose a DATE/TIMESTAMP column or an explicit text date format.")).toBeVisible();

  await expectNoAdditionalStreamAfter(component, () => component.getByRole("button", { name: "Use TIMETZ X" }).click());
  await expect(component.getByText("Standalone TIME columns cannot define Time Series order. Choose a DATE/TIMESTAMP column or an explicit text date format.")).toBeVisible();
});

test("Time Series reports invalid X row count and persists option controls", async ({ mount, page }) => {
  const component = await mount(<TimeSeriesGraphHarness invalidXRows={3} />);
  await selectTimeSeriesLayer(component, page);

  await expect(component.getByText("3 invalid X values", { exact: false })).toBeVisible();
  const editor = component.locator(".gb-layer-card", { hasText: "Time Series" });
  await editor.getByRole("combobox").nth(1).selectOption("sourceRow");
  await editor.getByRole("combobox").nth(2).selectOption("connect");
  await editor.getByRole("combobox").nth(3).selectOption("step");
  await editor.getByRole("combobox").nth(4).selectOption("show");

  await expect.poll(async () => (await itemJson(component)).modeStates.twoD.elements[0].options).toMatchObject({
    order: "sourceRow",
    missingValues: "connect",
    connection: "step",
    markerMode: "show",
  });
});
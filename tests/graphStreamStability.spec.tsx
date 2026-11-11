import { expect, test } from "@playwright/experimental-ct-react";

import { GraphStreamStabilityHarness } from "./GraphStreamStabilityHarness";

async function requestCount(component) {
  return Number(await component.getByTestId("generic-stream-request-count").textContent() ?? "0");
}

async function requestIdentity(component) {
  return await component.getByTestId("generic-stream-request-identity").textContent();
}

test("visual-only generic graph item changes keep the active stream request stable", async ({ mount }) => {
  const component = await mount(<GraphStreamStabilityHarness />);

  await expect.poll(() => requestCount(component)).toBe(1);
  const baseIdentity = await requestIdentity(component);
  const baseCount = await requestCount(component);

  await component.getByRole("button", { name: "Hide Station A" }).click();
  await expect.poll(() => requestIdentity(component)).toBe(baseIdentity);
  await expect.poll(() => requestCount(component)).toBe(baseCount);

  await component.getByRole("button", { name: "Color Station A" }).click();
  await expect.poll(() => requestIdentity(component)).toBe(baseIdentity);
  await expect.poll(() => requestCount(component)).toBe(baseCount);
});
for (const language of ["en", "zh-CN", "zh-TW", "vi"]) {
  test(`numeric graph errors show localized column guidance in ${language}`, async ({ mount }) => {
    const component = await mount(<GraphStreamStabilityHarness language={language} failure={{code:"graphNumericColumnRequired",column:"Net_Sales",role:"y"}} />);
    const alert=component.getByRole("alert");
    await expect(alert).toContainText("Net_Sales");
    await expect(alert).toContainText(language === "en" ? "numeric" : language === "vi" ? "kiểu số" : language === "zh-CN" ? "数值" : "數值");
    await expect(alert).not.toContainText("graph.errors");
  });
}
test("unknown graph backend failures do not display SQL", async ({ mount }) => {
  const component = await mount(<GraphStreamStabilityHarness failure="Database error: SELECT CAST(Net_Sales AS DOUBLE) FROM dataset_sales _row_id __sp_x" />);
  const alert=component.getByRole("alert");
  await expect(alert).toContainText("could not be loaded");
  await expect(alert).not.toContainText(/SELECT|CAST|dataset_|_row_id|__sp_/);
});

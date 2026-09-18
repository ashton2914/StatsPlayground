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
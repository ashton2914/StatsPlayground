import { expect, test } from "@playwright/experimental-ct-react";

import { FilterValueCountsHarness } from "./FilterValueCountsHarness";

test("preserves include-mode selections across async remote search subsets", async ({ mount }) => {
  const component = await mount(<FilterValueCountsHarness variant="table" />);
  const selected = component.getByLabel("Selected raw values");
  const optionList = component.locator(".gb-filter-cats-list");

  await expect(component.getByText("DV")).toBeVisible();
  await expect(component.getByText("24", { exact: true })).toBeVisible();
  await expect(component.getByText("76", { exact: true })).toBeVisible();
  await expect(component.getByText("(blank)")).toBeVisible();
  await expect(selected).toHaveText("EV");

  await component.getByPlaceholder("Search…").fill("DV");
  await expect(component.getByText("DV")).toBeVisible();
  await expect(component.getByText("24", { exact: true })).toBeVisible();
  await expect(optionList.getByText("EV")).toHaveCount(0);
  await expect(optionList.getByText("76", { exact: true })).toHaveCount(0);
  await expect(optionList.getByRole("checkbox")).toHaveCount(1);
  await component.getByText("DV").click();

  await expect(component.getByText("24", { exact: true })).toBeVisible();
  await expect(selected).toHaveText("DV | EV");
});

test("keeps the local graph-builder-compatible variant count-free while preserving raw-string selection", async ({ mount }) => {
  const component = await mount(<FilterValueCountsHarness variant="local" />);
  const selected = component.getByLabel("Selected raw values");

  await expect(component.locator(".gb-filter-cat-row-count")).toHaveCount(0);
  await component.getByPlaceholder("Search…").fill("EV");
  await expect(component.getByText("EV")).toBeVisible();
  await component.getByText("EV").click();
  await expect(selected).toHaveText("EV");
});

test("ignores stale remote responses after the search changes again", async ({ mount }) => {
  const component = await mount(<FilterValueCountsHarness variant="table" />);
  const optionList = component.locator(".gb-filter-cats-list");
  const search = component.getByPlaceholder("Search…");

  await expect(optionList.getByRole("checkbox")).toHaveCount(3);

  await search.fill("DV");
  await new Promise<void>((resolve) => setTimeout(resolve, 170));
  await search.fill("");

  await expect(optionList.getByRole("checkbox")).toHaveCount(3);
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await expect(optionList.getByRole("checkbox")).toHaveCount(3);
  await expect(optionList.getByText("EV")).toBeVisible();
  await expect(optionList.getByText("76", { exact: true })).toBeVisible();
});
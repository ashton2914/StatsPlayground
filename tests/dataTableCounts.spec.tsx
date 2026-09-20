import { expect, test } from "@playwright/experimental-ct-react";

import { DataTableCountsHarness } from "./DataTableCountsHarness";

const INITIAL_FILTER_QUERY_SIGNATURE = JSON.stringify({
  filters: [{
    op: "AND",
    rule: {
      kind: "categorical",
      field: "Build",
      selected: ["DV", "EV"],
      exclude: false,
    },
  }],
  sort: null,
});

const UNFILTERED_QUERY_SIGNATURE = JSON.stringify({
  filters: [],
  sort: null,
});

const UPDATED_FILTER_QUERY_SIGNATURE = JSON.stringify({
  filters: [{
    op: "AND",
    rule: {
      kind: "categorical",
      field: "Build",
      selected: ["DV"],
      exclude: false,
    },
  }],
  sort: null,
});

test("shows source totals without displayed rows when no table filter is active", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="unfiltered" />);

  await expect(component.getByText("Total rows").locator("..")).toContainText("100");
  await expect(component.getByText("Total columns").locator("..")).toContainText("2");
  await expect(component.getByText("Displayed rows")).toHaveCount(0);
});

test("shows displayed rows and source totals when a filter is active", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="filtered" />);

  await expect(component.getByText("Total rows").locator("..")).toContainText("100");
  await expect(component.getByText("Total columns").locator("..")).toContainText("2");
  await expect(component.getByLabel("Status dimensions")).toHaveText("24 / 100 rows × 2 cols");
  await expect(component.getByText("Displayed rows").locator("..")).toContainText("24");
  await expect(component.getByLabel("Table window query signatures")).toHaveText(
    INITIAL_FILTER_QUERY_SIGNATURE,
  );
  await expect(component.getByLabel("Descriptor request generations")).toHaveText("1,1");
  await expect(component.getByLabel("Prepared session generations")).toHaveText("1");
  await expect(component.getByLabel("Released session IDs")).toHaveText("(none)");
  await expect(component.getByLabel("Navigation session IDs")).toHaveText("session-1");
});

test("shows zero displayed rows when a filter returns no matches", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="zero-match" />);

  await expect(component.getByLabel("Status dimensions")).toHaveText("0 / 100 rows × 2 cols");
  await expect(component.getByText("Displayed rows").locator("..")).toContainText("0");
  await expect(component.getByLabel("Table window query signatures")).toHaveText(
    INITIAL_FILTER_QUERY_SIGNATURE,
  );
  await expect(component.getByLabel("Descriptor request generations")).toHaveText("1,1");
  await expect(component.getByLabel("Prepared session generations")).toHaveText("1");
  await expect(component.getByLabel("Released session IDs")).toHaveText("(none)");
  await expect(component.getByLabel("Navigation session IDs")).toHaveText("session-1");
});

test("suppresses unknown metadata totals and refreshes summary and status when metadata or filters change", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="filtered" />);

  await expect(component.getByLabel("Harness metadata state")).toHaveText("100x2@1");
  await expect(component.getByText("Total rows").locator("..")).toContainText("100");
  await expect(component.getByText("Total columns").locator("..")).toContainText("2");
  await expect(component.getByText("Displayed rows").locator("..")).toContainText("24");
  await expect(component.getByLabel("Status dimensions")).toHaveText("24 / 100 rows × 2 cols");

  await component.getByRole("button", { name: "Clear active metadata" }).click();
  await expect(component.getByLabel("Harness metadata state")).toHaveText("missing");
  await expect(component.getByLabel("Table summary")).toHaveCount(0);
  await expect(component.getByLabel("Status dimensions")).toHaveText("");

  await component.getByRole("button", { name: "Apply updated metadata" }).click();
  await expect(component.getByLabel("Harness metadata state")).toHaveText("80x3@2");
  await expect(component.getByText("Total rows").locator("..")).toContainText("80");
  await expect(component.getByText("Total columns").locator("..")).toContainText("3");
  await expect(component.getByText("Displayed rows").locator("..")).toContainText("24");
  await expect(component.getByLabel("Status dimensions")).toHaveText("24 / 80 rows × 3 cols");

  await component.getByRole("button", { name: "Apply updated filter result" }).click();
  await expect(component.getByText("Displayed rows").locator("..")).toContainText("11");
  await expect(component.getByLabel("Status dimensions")).toHaveText("11 / 80 rows × 3 cols");

  await component.getByRole("button", { name: "Clear filters" }).click();
  await expect(component.getByText("Displayed rows")).toHaveCount(0);
  await expect(component.getByLabel("Status dimensions")).toHaveText("80 rows × 3 cols");
});

test("refetches filter counts for a new generation and ignores the delayed old response", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="filtered" />);
  const optionList = component.locator(".gb-filter-cats-list");

  await expect(component.getByLabel("Status dimensions")).toHaveText("24 / 100 rows × 2 cols");
  await component.getByRole("button", { name: /Filter/ }).click();
  await expect(component.getByLabel("Filter request generations")).toHaveText("1");

  await component.getByRole("button", { name: "Apply updated metadata" }).click();
  await expect(component.getByLabel("Harness metadata state")).toHaveText("80x3@2");
  await expect(component.getByLabel("Filter request generations")).toHaveText("1,2");
  await expect(component.getByLabel("Descriptor request generations")).toHaveText("1,1,2,2");
  await expect(component.getByLabel("Prepared session generations")).toHaveText("1,2");
  await expect(component.getByLabel("Table window query signatures")).toHaveText(
    `${INITIAL_FILTER_QUERY_SIGNATURE}\n${INITIAL_FILTER_QUERY_SIGNATURE}`,
  );
  await expect(component.getByLabel("Released session IDs")).toHaveText("session-1");
  await expect(component.getByLabel("Navigation session IDs")).toHaveText("session-1,session-2");
  await expect(optionList.getByText("11", { exact: true })).toBeVisible();
  await expect(optionList.getByText("69", { exact: true })).toBeVisible();

  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await expect(optionList.getByText("11", { exact: true })).toBeVisible();
  await expect(optionList.getByText("69", { exact: true })).toBeVisible();
});

test("reissues a query restored while its stale predecessor is still in flight", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="query-race" />);
  const signatures = component.getByLabel("Table window query signatures");

  await expect(signatures).toHaveText(UNFILTERED_QUERY_SIGNATURE);

  await component.getByRole("button", { name: "Apply race filter" }).click();
  await expect(signatures).toHaveText(
    `${UNFILTERED_QUERY_SIGNATURE}\n${UPDATED_FILTER_QUERY_SIGNATURE}`,
  );

  await component.getByRole("button", { name: "Restore initial query" }).click();
  await expect(signatures).toHaveText(
    `${UNFILTERED_QUERY_SIGNATURE}\n${UPDATED_FILTER_QUERY_SIGNATURE}\n${UNFILTERED_QUERY_SIGNATURE}`,
  );
  await expect(component.getByLabel("Status dimensions")).toHaveText("100 rows × 2 cols");

  await component.getByRole("button", { name: "Resolve initial table query" }).click();
  await expect(component.getByLabel("Status dimensions")).toHaveText("100 rows × 2 cols");
});

test("does not release a shared prepared session adopted by a newer start", async ({ mount }) => {
  const component = await mount(<DataTableCountsHarness variant="session-race" />);
  const scrollbar = component.getByRole("scrollbar", { name: "Logical table rows" });

  await expect(component.getByLabel("Status dimensions")).toHaveText("6000 / 10000 rows × 2 cols");
  await scrollbar.focus();
  await scrollbar.press("End");
  await expect(component.getByLabel("Navigation starts")).toContainText("500");
  await scrollbar.press("End");
  await expect(component.getByLabel("Navigation starts")).toContainText("5500");
  await expect(component.locator(".sp-row-hdr").filter({ hasText: "6000" })).toBeVisible();

  await component.getByRole("button", { name: "Reload current revision" }).click();
  await expect(component.getByLabel("Prepared session generations")).toHaveText("1,1");

  await scrollbar.press("Home");
  await expect(component.getByLabel("Navigation starts")).toContainText("5500,0,500");
  await component.getByRole("button", { name: "Reload current revision" }).click();
  await expect(component.getByLabel("Prepared session generations")).toHaveText("1,1,1");
  await expect(component.getByLabel("Navigation session IDs")).toContainText("session-1");

  await component.getByRole("button", { name: "Resolve stale session prepare" }).click();
  await expect(component.getByLabel("Delayed prepare settled")).toHaveText("true");
  await expect(component.getByLabel("Released session IDs")).toHaveText("(none)");
});
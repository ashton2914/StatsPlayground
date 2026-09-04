import { expect, test } from "@playwright/experimental-ct-react";

import {
  StatisticalSection,
  StatisticalTableFrame,
} from "../src/components/statistical";

test("statistical tables keep one integrated title per framed table", async ({ mount }) => {
  const component = await mount(
    <StatisticalSection title="Summary Statistical">
      <StatisticalTableFrame
        title="Quantiles"
        width="standard"
        columns={[
          { key: "metric", label: "Metric" },
          { key: "value", label: "Value", numeric: true },
        ]}
        rows={[{ key: "median", cells: ["Median", "99.14"] }]}
      />
      <StatisticalTableFrame
        title="Location"
        width="compact"
        columns={[
          { key: "metric", label: "Metric" },
          { key: "value", label: "Value", numeric: true },
        ]}
        rows={[{ key: "mean", cells: ["Mean", "99.44"] }]}
      />
    </StatisticalSection>,
  );

  await expect(component).toHaveClass("sp-stat-section");
  await expect(component.locator(".sp-stat-table-frame")).toHaveCount(2);
  await expect(component.locator(".sp-stat-table-frame table")).toHaveCount(2);
  await expect(component.locator(".sp-stat-table-frame-title")).toHaveText(["Quantiles", "Location"]);
  await expect(component.locator(".sp-stat-table-frame-standard")).toHaveCSS("width", "560px");
  await expect(component.locator(".sp-stat-table-frame-compact")).toHaveCSS("width", "520px");
  await expect(component.locator(".sp-stat-table-cell-numeric").first()).toHaveCSS("text-align", "right");
});
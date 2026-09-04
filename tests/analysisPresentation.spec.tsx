import { expect, test } from "@playwright/experimental-ct-react";

import {
  AnalysisFrame,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "../src/components/analysis/presentation";
import { AnalysisGraphHarness } from "./AnalysisPresentationHarness";

test("AnalysisFrame supports recursive hierarchy and independent disclosure", async ({ mount }) => {
  const component = await mount(
    <AnalysisFrame title="Root">
      <AnalysisStack>
        <AnalysisFrame title="Child">
          <AnalysisText>Nested content</AnalysisText>
        </AnalysisFrame>
        <AnalysisText>Sibling content</AnalysisText>
      </AnalysisStack>
    </AnalysisFrame>,
  );

  const rootToggle = component.getByRole("button", { name: "Root" });
  const childToggle = component.getByRole("button", { name: "Child" });
  await expect(component).toHaveClass("analysis-ui-frame");
  await expect(component.locator(".analysis-ui-frame")).toHaveCount(1);
  await expect(rootToggle).toHaveAttribute("aria-expanded", "true");
  await expect(childToggle).toHaveAttribute("aria-expanded", "true");
  await expect(component.getByText("Nested content")).toBeVisible();

  await childToggle.click();

  await expect(childToggle).toHaveAttribute("aria-expanded", "false");
  await expect(rootToggle).toHaveAttribute("aria-expanded", "true");
  await expect(component.getByText("Nested content")).toHaveCount(0);
  await expect(component.getByText("Sibling content")).toBeVisible();
});

test("AnalysisTable owns one framed table with width and numeric alignment", async ({ mount }) => {
  const component = await mount(
    <AnalysisTable
      title="Location"
      width="compact"
      columns={[
        { key: "metric", label: "Metric" },
        { key: "value", label: "Value", numeric: true },
      ]}
      rows={[{ key: "mean", cells: ["Mean", "99.44"] }]}
    />,
  );

  await expect(component).toHaveClass(/analysis-ui-table-compact/);
  await expect(component.locator(".analysis-ui-frame")).toHaveCount(1);
  await expect(component.locator("table")).toHaveCount(1);
  await expect(component.getByRole("cell", { name: "99.44" })).toHaveCSS("text-align", "right");
});

test("AnalysisGraph forwards GraphRuntime configuration and interactions", async ({ mount }) => {
  const component = await mount(<AnalysisGraphHarness />);

  await expect(component).toHaveClass("analysis-ui-frame");
  await expect(component.getByTestId("graph-runtime-props")).toHaveText(JSON.stringify({
    item: true,
    dataset: true,
    externalDataState: true,
    minPanelHeight: 96,
    onAxisRangeChange: true,
  }));
});
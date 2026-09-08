import { expect, test } from "@playwright/experimental-ct-react";

import { ReportEmbedRecoveryHarness, ReportViewHarness } from "./reportViewHarness";

test("renders GFM directly and keeps unsafe Markdown inert", async ({ mount, page }) => {
  const remoteImageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url() === "https://example.invalid/pixel.png") {
      remoteImageRequests.push(request.url());
    }
  });
  const component = await mount(
    <ReportViewHarness initialMarkdown={`# Summary\n\n| Metric | Value |\n| --- | --- |\n| Mean | 7 |\n\n![Remote chart](https://example.invalid/pixel.png)\n\n<img src=x onerror="window.__reportXss = true" />`} />,
  );

  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(editor.locator("h1")).toHaveText("Summary");
  await expect(editor.locator("table")).toContainText("Metric");
  await expect(editor.locator("table")).toContainText("Mean");
  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor).toContainText("Remote chart");
  expect(await page.evaluate(() => (window as Window & { __reportXss?: boolean }).__reportXss)).not.toBe(true);
  expect(remoteImageRequests).toEqual([]);
});

test("inserts canonical embeds from grouped menu choices", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown={"Summary"} />);
  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");
  await editor.click();

  await component.getByRole("button", { name: "Insert project document" }).click();
  await expect(component.getByText("Tables")).toBeVisible();
  await expect(component.getByText("Graphs")).toBeVisible();
  await expect(component.getByText("Fit Y by X")).toBeVisible();
  await expect(component.getByText("Tabulate")).toBeVisible();
  await expect(component.getByText("Distributions")).toBeVisible();

  await component.getByRole("menuitem", { name: "Scatter Plot" }).click();

  await expect(editor.locator('[data-kind="graph"][data-document-id="graph-1"]')).toBeVisible();
  await expect(editor.getByText("Scatter Plot")).toBeVisible();
  await expect(component.getByTitle("Insert project document")).toBeVisible();
});

test("renders live table, graph, fit y by x, tabulate, and distribution embeds", async ({ mount }) => {
  const component = await mount(
    <ReportViewHarness
      initialMarkdown={[
        "# Live Report",
        "",
        '{{sp-embed kind="table" id="table-1"}}',
        '{{sp-embed kind="graph" id="graph-1"}}',
        '{{sp-embed kind="fitYByX" id="fit-1"}}',
        '{{sp-embed kind="tabulate" id="tab-1"}}',
        '{{sp-embed kind="distribution" id="distribution-1"}}',
      ].join("\n")}
      graphMode="stub"
      distributionGraphMode="stub"
      embedMode="live"
      embedRuntime={{
        table: {
          getDatasetGeneration: async () => 7,
          queryTableWindow: async () => ({
            columns: ["supplier", "strength"],
            columnTypes: ["VARCHAR", "DOUBLE"],
            rows: [["A", 12.3], ["B", 14.8]],
            totalRows: 2,
            start: 0,
            generation: 7,
          }),
        },
        fitYByX: {
          getDatasetGeneration: async () => 11,
          computeFitYByX: async (request) => ({
            datasetId: request.datasetId,
            generation: request.generation,
            result: {
              kind: "bivariate",
              usedRows: 12,
              excludedRows: 0,
              confidenceLevel: 0.95,
              intercept: 1.2,
              slope: 0.7,
              summaryOfFit: {
                rSquared: 0.8,
                adjustedRSquared: 0.78,
                rootMeanSquareError: 1.1,
                meanOfResponse: 10,
                observationCount: 12,
              },
              lackOfFit: { state: "notIdentifiable" },
              anova: [],
              parameterEstimates: [],
            },
          }),
        },
        tabulate: {
          getColumns: async () => [["supplier", "VARCHAR"], ["phase", "VARCHAR"], ["strength", "DOUBLE"]],
          getColumnDisplayProps: async () => [],
          run: async () => ({
            rowMembers: [["A"]],
            columnMembers: [["EV"]],
            statistics: [{ id: "count", field: "strength", kind: "count" }],
            cells: [4],
            rowTotals: [4],
            columnTotals: [4],
            grandTotals: [4],
            cellCount: 1,
            limit: 10000,
          }),
        },
        distribution: {
          getDatasetGeneration: async () => 13,
          compute: async () => {
            const frame = { columns: [], rows: [], aggregatePackets: [], totalRows: 0 } as never;
            return {
              datasetId: "table-1",
              generation: 13,
              groups: [],
              reportBlocks: [],
              graphFrames: { overview: frame, boxPlot: frame, ecdf: frame, normalQuantile: frame },
            };
          },
        },
      }}
    />,
  );

  const preview = component.locator(".sp-report-editor-surface");

  await expect(preview.locator("h1")).toHaveText("Live Report");
  await expect(preview.getByText("Source: Incoming Data").first()).toBeVisible();
  await expect(preview.getByText("supplier").first()).toBeVisible();
  await expect(preview.getByText("12.3")).toBeVisible();
  await expect(preview.getByText("Graph:Scatter Plot:Incoming Data")).toBeVisible();
  await expect(preview.locator('.sp-report-embed-card[data-kind="fitYByX"]')).toBeVisible();
  await expect(preview.locator('[data-analysis-report-kind="fitYByX"]')).toBeVisible();
  await expect(preview.getByText("Strength vs Time")).toBeVisible();
  await expect(preview.getByText("Used rows")).toBeVisible();
  await expect(preview.getByText("Grouped Summary")).toBeVisible();
  await expect(preview.getByText("4").first()).toBeVisible();
  await expect(preview.getByText("Strength Distribution")).toBeVisible();
  await expect(preview.locator("[data-analysis-report-kind='distribution']")).toBeVisible();
  await expect(preview.locator("[data-graph-role='distributionComposite']")).toBeVisible();
  await expect(preview.getByText("Distribution graph:overview")).toBeVisible();
  await expect(preview.getByText("Distribution graph:boxPlot")).toHaveCount(0);
  await expect(preview.getByText("Distribution graph:ecdf")).toHaveCount(0);
  await expect(preview.getByText("Distribution graph:normalQuantile")).toHaveCount(0);
  await expect(component.getByRole("button", { name: "Export table" })).toHaveCount(0);
});

test("renders a Distribution Analysis embed with the current Analysis presentation", async ({ mount }) => {
  const component = await mount(
    <ReportViewHarness
      initialMarkdown={'{{sp-embed kind="distribution" id="distribution-1"}}'}
      distributions={[]}
      distributionGraphMode="stub"
      embedMode="live"
    />,
  );

  await expect(component.getByText("Strength Distribution")).toBeVisible();
  await expect(component.locator("[data-analysis-document]")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await expect(component.locator(".sp-report-distribution-graphs")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='overview']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='boxPlot']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='ecdf']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='normalQuantile']")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview")).toBeVisible();
  await expect(component.getByText("Unavailable", { exact: false })).toHaveCount(0);
});

test("keeps neighboring markdown and embeds visible when one embed is missing or throws", async ({ mount }) => {
  const component = await mount(
    <ReportViewHarness
      initialMarkdown={[
        "# Mixed Report",
        "Before",
        '{{sp-embed kind="table" id="missing-table"}}',
        '{{sp-embed kind="graph" id="graph-1"}}',
        '{{sp-embed kind="fitYByX" id="fit-1"}}',
        "After",
      ].join("\n")}
      graphMode="error"
      embedMode="notComputable"
      embedRuntime={{
        fitYByX: {
          getDatasetGeneration: async () => 11,
          computeFitYByX: async (request) => ({
            datasetId: request.datasetId,
            generation: request.generation,
            result: {
              kind: "notComputable",
              personality: "bivariate",
              reason: "insufficientValidRows",
              usedRows: 1,
              excludedRows: 2,
              confidenceLevel: 0.95,
            },
          }),
        },
      }}
    />,
  );

  const preview = component.locator(".sp-report-editor-surface");

  await expect(preview.locator("h1")).toHaveText("Mixed Report");
  await expect(preview.getByText("Before", { exact: true })).toBeVisible();
  await expect(preview.getByText("After", { exact: true })).toBeVisible();
  await expect(preview.getByText("Unavailable: Tables missing-table")).toBeVisible();
  await expect(preview.getByText("graph exploded", { exact: false })).toBeVisible();
  await expect(preview.getByText("Not computable")).toBeVisible();
});

test("recovers an embed after its source revision changes", async ({ mount }) => {
  const component = await mount(<ReportEmbedRecoveryHarness />);

  await expect(component.getByText("graph exploded", { exact: false })).toBeVisible();
  await component.getByRole("button", { name: "Recover graph" }).click();
  await expect(component.getByText("Graph:Recovered Graph:Incoming Data")).toBeVisible();
  await expect(component.getByText("graph exploded", { exact: false })).toHaveCount(0);
});

test("keeps one directly editable surface on narrow viewports", async ({ mount, page }) => {
  await page.setViewportSize({ width: 720, height: 820 });
  const component = await mount(<ReportViewHarness initialMarkdown={"# Compact"} />);

  await expect(component.getByRole("tab")).toHaveCount(0);
  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(editor.locator("h1")).toHaveText("Compact");
});
import assert from "node:assert/strict";

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { AnalysisExecutionHarness } from "./AnalysisExecutionHarness";
import { AnalysisGraphVisualHarness } from "./AnalysisGraphVisualHarness";
import { AnalysisViewHarness, FitYByXAnalysisViewHarness } from "./AnalysisViewHarness";

async function paintedPixelCount(canvas: Locator) {
  return canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
}

async function directChildFrameTitles(frame: Locator) {
  return frame.evaluate((node) => {
    const stack = node.classList.contains("analysis-ui-stack")
      ? node
      : node.querySelector(":scope > .analysis-ui-frame-body > .analysis-ui-stack");
    if (!(stack instanceof HTMLElement)) return [];
    return Array.from(stack.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("analysis-ui-frame"))
      .map((child) => child.querySelector(".analysis-ui-frame-title span:last-child")?.textContent?.trim() ?? "");
  });
}

async function ensureFrameExpanded(root: Locator, title: string) {
  const button = root.getByRole("button", { name: title, exact: true }).first();
  if ((await button.getAttribute("aria-expanded")) === "false") {
    await button.click();
  }
}

function directChildFrames(root: Locator) {
  return root.locator(":scope > .analysis-ui-frame-body > .analysis-ui-stack > .analysis-ui-frame");
}

async function frameTitleText(frame: Locator) {
  return frame.locator(":scope > .analysis-ui-frame-title span:last-child").textContent();
}

async function frameWidths(frames: Locator) {
  return frames.evaluateAll((nodes) => nodes.map((node) => Math.round((node as HTMLElement).getBoundingClientRect().width)));
}

async function layoutRect(locator: Locator) {
  return locator.evaluate((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    };
  });
}

async function computedLayoutStyle(locator: Locator) {
  return locator.evaluate((node) => {
    const style = window.getComputedStyle(node as HTMLElement);
    return {
      boxSizing: style.boxSizing,
      minWidth: style.minWidth,
    };
  });
}

async function expectContainedWithin(frame: Locator, content: Locator, label: string) {
  await expect.poll(async () => {
    const [frameRect, contentRect] = await Promise.all([layoutRect(frame), layoutRect(content)]);
    return {
      left: contentRect.left >= frameRect.left - 1,
      right: contentRect.right <= frameRect.right + 1,
      top: contentRect.top >= frameRect.top - 1,
      bottom: contentRect.bottom <= frameRect.bottom + 1,
    };
  }, { message: `${label} should remain within its response frame` }).toEqual({
    left: true,
    right: true,
    top: true,
    bottom: true,
  });
}

function responseSurface(root: Locator, surface: string) {
  return root.locator(`[data-analysis-surface='${surface}']`).first();
}

async function textOverflowOffenders(root: Locator) {
  return root.evaluate((node) => {
    const selectors = [
      ".analysis-shell-titlebar",
      ".analysis-shell-source",
      ".analysis-shell-summary-row dd",
      ".analysis-ui-frame-title",
      ".analysis-ui-table th",
      ".analysis-ui-table td",
    ];

    return selectors.flatMap((selector) => Array.from(node.querySelectorAll<HTMLElement>(selector))
      .filter((element) => element.getClientRects().length > 0 && element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${selector}:${element.innerText.trim().replace(/\s+/g, " ").slice(0, 80)}`))
      .slice(0, 12);
  });
}

function distributionGraphItemId(groupIdentity: string, columnId: string) {
  return `analysis-graph:analysis-1:${encodeURIComponent(groupIdentity)}:${columnId}:distributionComposite`;
}

function expectedResponseGraphSignatures(
  sourceColumn: string,
  responseName: string,
  groupName: string,
  fitName = "Normal",
) {
  const seriesName = groupName === "Overall" ? responseName : `${responseName} | ${groupName}`;
  return [
    `histogram:${sourceColumn}|${seriesName}|`,
    `precomputedCurve:${sourceColumn}|${groupName}|${seriesName}|${seriesName} - ${fitName}`,
    `boxPlot:${sourceColumn}|${seriesName}|`,
  ].join(",");
}

test("useAnalysisExecution masks stale success synchronously when configRevision changes", async ({ mount }) => {
  const component = await mount(<AnalysisExecutionHarness />);

  await expect(component.getByTestId("visible-state")).toContainText("1:success:101.044792");

  await component.getByRole("button", { name: "Bump config revision" }).click();

  await expect(component.getByTestId("visible-state")).toContainText("2:loading:");
  await expect(component.getByTestId("state-history")).not.toContainText("2:success:101.044792");
  await expect(component.getByText("compute-calls:2")).toBeVisible();

  await component.getByRole("button", { name: "Resolve pending response" }).click();

  await expect(component.getByTestId("visible-state")).toContainText("2:success:88.5");
  await expect(component.getByText("compute-calls:2")).toBeVisible();
});

test("configRevision-only changes fence stale results and force re-execution on the mounted AnalysisView path", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);
  const documentFrame = component.locator("[data-analysis-document]");
  const topLevelFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");
  const firstValueCell = component.getByRole("cell", { name: "101.044792" }).first();
  const originalMedianRow = component.getByRole("row", { name: "Median 101.044792", exact: true });

  await expect(component.locator(".analysis-workspace")).toHaveCount(0);
  await expect(component.locator(".analysis-shell")).toHaveCount(1);
  await expect(component.locator(".analysis-shell-titlebar")).toHaveText("Strength Distribution");
  await expect(component.locator(".analysis-shell-source")).toContainText("Incoming Data");
  await expect(component.locator(".analysis-shell-summary")).toContainText("DIM1");
  await expect(component.locator(".analysis-shell-summary")).not.toContainText("55 / 100 / 145");
  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("edit-inputs-calls")).toHaveText("1");
  await expect(documentFrame).toHaveClass(/analysis-ui-stack/);
  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual(["DIM1"]);
  await expect(topLevelFrames).toHaveCount(1);
  await expect(component.locator("[data-analysis-block='graph']")).toHaveCount(1);
  await expect(component.locator("[data-analysis-block='graph']").first()).toHaveClass(/analysis-ui-frame/);
  await expect(component.locator("[data-analysis-block='report']")).toHaveCount(0);
  await expect(component.locator(".analysis-ui-graph")).toHaveCount(1);
  await expect(component.locator(".analysis-ui-graph-runtime")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveCount(1);
  await expect(component.locator("[data-graph-role='ecdf']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='normalQuantile']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='overview']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='boxPlot']")).toHaveCount(0);
  await expect(component.locator("[data-graph-role='distributionComposite']")).toHaveAttribute("data-graph-strategy", "builder");
  await expect(component.getByRole("img", { name: /five-number range/i })).toHaveCount(0);
  const responseFrame = topLevelFrames.first();
  await ensureFrameExpanded(responseFrame, "DIM1");
  await expect.poll(() => frameTitleText(responseFrame)).toBe("DIM1");
  await expect(responseFrame.getByRole("button", { name: "Distribution", exact: true })).toHaveCount(1);
  await expect(responseFrame.getByRole("button", { name: "Overall", exact: true })).toHaveCount(1);
  await expect(responseFrame.locator(".analysis-ui-table")).toHaveCount(2);
  const summary = component
    .getByRole("rowheader", { name: "N", exact: true })
    .locator("xpath=ancestor::table");
  await expect(summary).toBeVisible();
  await expect(summary.locator("tbody tr")).toHaveCount(8);
  for (const label of ["N", "N Missing", "Mean", "Median", "Std Dev", "Std Error", "Lower 95% Mean", "Upper 95% Mean"]) {
    await expect(summary.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
  }
  for (const removed of ["Mode", "Minimum", "Maximum", "Range", "Interquartile Range", "Median Absolute Deviation"]) {
    await expect(summary.getByRole("rowheader", { name: removed, exact: true })).toHaveCount(0);
  }
  await expect(firstValueCell).toBeVisible();
  await expect(originalMedianRow).toBeVisible();
  await expect(component.locator(".report-editor")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:overview:ready:native")).toBeVisible();
  await expect(component.getByTestId("composite-element-kinds")).toHaveText("histogram,normalCurve,boxplot");
  await expect(component.getByTestId("composite-packet-kinds")).toHaveText("histogram,precomputedCurve,boxPlot");
  await expect(component.getByText("Distribution graph:ecdf:ready:custom-option")).toHaveCount(0);
  await expect(component.getByText("Distribution graph:normalQuantile:ready:native")).toHaveCount(0);
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await expect(component.getByText(/generation-calls:[1-9]\d*/)).toBeVisible();
  await expect(component.getByRole("button", { name: "Statistical Report", exact: true })).toHaveCount(0);

  await component.getByRole("button", { name: "Bump config revision" }).click();

  await expect(component.getByText("Distribution graph:overview:loading:native")).toBeVisible();
  await expect(component.getByRole("button", { name: "Distribution", exact: true })).toHaveCount(1);
  await expect(component.getByRole("button", { name: "Statistical Report", exact: true })).toHaveCount(1);
  await expect(component.getByText("Loading report...")).toBeVisible();
  await expect(originalMedianRow).toHaveCount(0);
  await expect(component.getByText("compute-calls:2")).toBeVisible();
  await expect(component.getByText("definition:unchanged")).toBeVisible();
  await expect(component.locator("[data-analysis-document]")).toHaveClass("analysis-ui-frame");

  await component.getByRole("button", { name: "Resolve pending response" }).click();

  await expect(component.locator("[data-analysis-document]")).toHaveClass(/analysis-ui-stack/);
  await expect.poll(() => directChildFrameTitles(component.locator("[data-analysis-document]"))).toEqual(["DIM1"]);
  await expect(component.getByRole("row", { name: "Median 88.5", exact: true })).toBeVisible();
  await expect(originalMedianRow).toHaveCount(0);
  assert.equal(true, true);
});

test("Distribution analysis preserves graph and report frames while loading", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="loading" />);
  const documentFrame = component.locator("[data-analysis-document]");

  await expect(component.getByRole("button", { name: "DIM1", exact: true })).toHaveCount(1);
  await expect(component.getByText("Distribution graph:overview:loading:native")).toBeVisible();
  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual(["Distribution", "Statistical Report"]);
  await expect(component.getByText("Loading report...")).toBeVisible();
});

test("Distribution analysis preserves graph and report frames when execution fails", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="error" />);
  const documentFrame = component.locator("[data-analysis-document]");

  await expect(component.getByRole("button", { name: "DIM1", exact: true })).toHaveCount(1);
  await expect(component.getByText("Distribution graph:overview:error:native")).toBeVisible();
  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual(["Distribution", "Statistical Report"]);
  await expect(component.getByRole("alert")).toContainText("distribution failed");
});

test("unsupported presentation schema does not invoke generation or compute services", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="unsupportedPresentation" />);

  await expect(component.getByRole("alert")).toContainText("Unsupported analysis presentation.");
  await expect(component.getByRole("alert")).toHaveClass("analysis-ui-text");
  await expect(component.getByText("compute-calls:0")).toBeVisible();
  await expect(component.getByText("generation-calls:0")).toBeVisible();
  await expect(component.getByText(/Distribution graph:/)).toHaveCount(0);
});

test("Distribution composite exposes only its persisted response axis settings", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  await expect(component.getByRole("button", { name: "Open overview X axis" })).toHaveCount(0);
  await component.getByRole("button", { name: "Open overview Y axis" }).click();
  await expect(component.locator(".sp-dialog-title")).toHaveText("Y Axis Settings");
  await component.getByRole("button", { name: "Done" }).click();
});

test("Distribution response axis settings persist to the source X-bound graph", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  await component.getByRole("button", { name: "Open overview Y axis" }).click();
  await component.getByLabel("Min").fill("80");
  await expect(component.getByTestId("overview-x-min")).toHaveText("80");
  await expect(component.getByTestId("overview-y-min")).toHaveText("auto");
  await expect(component.getByTestId("config-revision")).toHaveText("1");
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await component.getByRole("button", { name: "Done" }).click();
});

test("Distribution response axis settings persist to a legacy Y-bound graph", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="yBound" />);

  await component.getByRole("button", { name: "Open overview Y axis" }).click();
  await component.getByLabel("Min").fill("80");
  await expect(component.getByTestId("overview-x-min")).toHaveText("auto");
  await expect(component.getByTestId("overview-y-min")).toHaveText("80");
  await expect(component.getByTestId("config-revision")).toHaveText("1");
  await expect(component.getByText("compute-calls:1")).toBeVisible();
  await component.getByRole("button", { name: "Done" }).click();
});

test("Distribution axis range persists through navigation without changing statistical revision", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness />);

  await expect(component.getByTestId("overview-x-min")).toHaveText("auto");
  await expect(component.getByTestId("config-revision")).toHaveText("1");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Zoom overview response axis" }).click();

  await expect(component.getByTestId("overview-x-min")).toHaveText("4");
  await expect(component.getByTestId("config-revision")).toHaveText("1");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Navigate away" }).click();
  await expect(component.locator("[data-analysis-document]")).toHaveCount(0);
  await component.getByRole("button", { name: "Navigate back" }).click();

  await expect(component.getByTestId("overview-x-min")).toHaveText("4");
  await expect(component.getByTestId("config-revision")).toHaveText("1");
});

test("Distribution response tree renders one top-level frame per response when By is empty", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="multiResponse" />);
  const documentFrame = component.locator("[data-analysis-document]");
  const topLevelFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");
  const fallbackGraphId = distributionGraphItemId("overall", "legacy-301A-F02");

  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual([
    "301A-F01",
    "301A-F02",
    "301A-F03",
  ]);
  await expect(topLevelFrames).toHaveCount(3);
  await expect(component.getByRole("button", { name: "301A-F01, 301A-F02, 301A-F03", exact: true })).toHaveCount(0);
  await expect(component.getByRole("button", { name: "Statistical Report", exact: true })).toHaveCount(0);
  await expect(component.getByText(/301A-F01: n =/)).toHaveCount(0);

  for (const [index, responseName] of ["301A-F01", "301A-F02", "301A-F03"].entries()) {
    const sourceColumn = responseName === "301A-F02" ? "legacy-301A-F02" : `col-${responseName}`;
    const responseFrame = topLevelFrames.nth(index);
    await ensureFrameExpanded(responseFrame, responseName);
    await expect.poll(() => frameTitleText(responseFrame)).toBe(responseName);
    await expect(responseFrame.getByRole("button", { name: "Distribution", exact: true })).toHaveCount(1);
    await expect(responseFrame.getByRole("button", { name: "Overall", exact: true })).toHaveCount(1);
    await expect(responseFrame.locator("[data-analysis-block='graph']")).toHaveCount(1);
    await expect(responseFrame.locator("[data-analysis-block='report']")).toHaveCount(0);
    await expect(responseFrame.locator("output[data-testid^='graph-sources:']")).toHaveText(sourceColumn);
    await expect(responseFrame.locator("output[data-testid^='graph-signatures:']")).toHaveText(
      expectedResponseGraphSignatures(sourceColumn, responseName, "Overall"),
    );
  }

  await expect(component.locator(`output[data-testid='graph-sources:${fallbackGraphId}']`)).toHaveText("legacy-301A-F02");
});

test("Distribution Continuous Fit selector switches the visible report and graph curve", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="multiResponse" />);
  const responseFrame = component.locator("[data-analysis-document] > .analysis-ui-frame").first();
  const sourceColumn = "col-301A-F01";
  const responseName = "301A-F01";

  await ensureFrameExpanded(responseFrame, responseName);
  const signatures = responseFrame.locator("output[data-testid^='graph-signatures:']");
  await expect(signatures).toHaveText(expectedResponseGraphSignatures(sourceColumn, responseName, "Overall"));

  const selector = responseFrame.getByRole("combobox", { name: "Continuous Fit distribution" });
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption("cauchy");

  await expect(responseFrame.getByRole("table", { name: "Cauchy Parameter Estimates" })).toBeVisible();
  await expect(signatures).toHaveText(expectedResponseGraphSignatures(sourceColumn, responseName, "Overall", "Cauchy"));
});

for (const locale of ["en", "zh-CN", "zh-TW", "vi"] as const) {
  for (const [confidenceLevel, percent] of [[0.9, "90%"], [0.95, "95%"], [0.99, "99%"], [undefined, "95%"]] as const) {
    test(`Summary confidence labels ${locale} ${confidenceLevel ?? "legacy"}`, async ({ mount }) => {
      const component = await mount(<AnalysisViewHarness summaryConfidenceLevel={confidenceLevel} locale={locale} />);
      const overall = component.locator('[data-analysis-surface="overall"]');
      const toggle = overall.locator(":scope > button");
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      const summary = overall.locator(".analysis-ui-table-compact table");
      const labels = {
        en: [`Lower ${percent} Mean`, `Upper ${percent} Mean`],
        "zh-CN": [`均值 ${percent} 下限`, `均值 ${percent} 上限`],
        "zh-TW": [`平均值 ${percent} 下限`, `平均值 ${percent} 上限`],
        vi: [`Cận dưới ${percent} của trung bình`, `Cận trên ${percent} của trung bình`],
      }[locale];
      await expect(summary.locator("tbody tr")).toHaveCount(8);
      for (const [index, label] of labels.entries()) {
        const heading = summary.getByRole("rowheader", { name: label, exact: true });
        await expect(heading).toBeVisible();
        await expect(heading.locator("..").getByRole("cell")).toHaveText(index === 0 ? "99.198" : "102.891");
      }
    });
  }
}

test("Distribution response tree shows one unavailable state for a missing response result", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="multiResponseMissingResult" />);
  const documentFrame = component.locator("[data-analysis-document]");
  const topLevelFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");

  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual(["301A-F01", "301A-F02"]);
  await ensureFrameExpanded(topLevelFrames.nth(1), "301A-F02");
  await expect(topLevelFrames.nth(1).locator("output[data-testid^='graph-sources:']")).toHaveCount(0);
  await expect(topLevelFrames.nth(1).getByText("Graph unavailable for this response.")).toHaveCount(1);
});

test("Distribution response tree nests response frames under backend group order when By is present", async ({ mount }) => {
  const component = await mount(<AnalysisViewHarness mode="multiResponseBy" />);
  const documentFrame = component.locator("[data-analysis-document]");
  const groupFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");

  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual([
    "Overall",
    "Site = A",
    "Site = B",
    "Site = Missing",
  ]);
  await expect(groupFrames).toHaveCount(4);

  for (const [groupIndex, groupTitle] of ["Overall", "Site = A", "Site = B", "Site = Missing"].entries()) {
    const groupFrame = groupFrames.nth(groupIndex);
    await ensureFrameExpanded(groupFrame, groupTitle);
    await expect.poll(() => frameTitleText(groupFrame)).toBe(groupTitle);
    await expect.poll(() => directChildFrameTitles(groupFrame)).toEqual([
      "301A-F01",
      "301A-F02",
      "301A-F03",
    ]);

    const responseFrames = directChildFrames(groupFrame);
    await expect(responseFrames).toHaveCount(3);
    for (const [responseIndex, responseName] of ["301A-F01", "301A-F02", "301A-F03"].entries()) {
      const sourceColumn = responseName === "301A-F02" ? "legacy-301A-F02" : `col-${responseName}`;
      const responseFrame = responseFrames.nth(responseIndex);
      await ensureFrameExpanded(responseFrame, responseName);
      await expect.poll(() => frameTitleText(responseFrame)).toBe(responseName);
      await expect(responseFrame.getByRole("button", { name: "Distribution", exact: true })).toHaveCount(1);
      await expect(responseFrame.getByRole("button", { name: "Overall", exact: true })).toHaveCount(1);
      await expect(responseFrame.locator("output[data-testid^='graph-sources:']")).toHaveText(sourceColumn);
      await expect(responseFrame.locator("output[data-testid^='graph-signatures:']")).toHaveText(
        expectedResponseGraphSignatures(
          sourceColumn,
          responseName,
          groupTitle === "Overall" ? "Overall" : groupTitle.replace(/ = /g, "="),
        ),
      );
    }
  }
});

test("Distribution response tree keeps layout bounded on desktop and narrow widths", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  const component = await mount(
    <div data-testid="layout-host" style={{ width: "100%", minHeight: 0 }}>
      <AnalysisViewHarness mode="multiResponseBy" />
    </div>,
  );
  const host = component.locator(".analysis-shell").first();
  const resultsPane = component.locator(".analysis-shell-results").first();
  const documentFrame = component.locator("[data-analysis-document]");
  const groupFrames = component.locator("[data-analysis-document] > .analysis-ui-frame");
  const groupTitles = ["Overall", "Site = A", "Site = B", "Site = Missing"];
  const responseTitles = ["301A-F01", "301A-F02", "301A-F03"];
  const requiredSurfaces = [
    { key: "overall", title: "Overall" },
    { key: "continuousFit", title: "Continuous Fit" },
    { key: "fitComparison", title: "Fit Comparison" },
    { key: "processCapability", title: "Process Capability" },
  ];

  await expect(documentFrame).toHaveAttribute("data-analysis-kind", "distribution");
  await expect(documentFrame).toHaveAttribute("data-analysis-tree", "response");
  await expect.poll(() => directChildFrameTitles(documentFrame)).toEqual(groupTitles);

  for (const [groupIndex, groupTitle] of groupTitles.entries()) {
    const groupFrame = groupFrames.nth(groupIndex);
    await ensureFrameExpanded(groupFrame, groupTitle);
    const responseFrames = directChildFrames(groupFrame);
    await expect(responseFrames).toHaveCount(3);
    for (const [responseIndex, responseTitle] of responseTitles.entries()) {
      const responseFrame = responseFrames.nth(responseIndex);
      await ensureFrameExpanded(responseFrame, responseTitle);
    }
  }

  const overallResponses = directChildFrames(groupFrames.first());
  const firstOverallSurface = responseSurface(overallResponses.first(), "overall");
  const firstFitSurface = responseSurface(overallResponses.first(), "continuousFit");
  await expect(firstFitSurface.locator(".distribution-fit-report-swatch")).toHaveCount(1);
  await expect(firstFitSurface.getByRole("button", { name: "Continuous Fit" })).toBeVisible();
  const firstCompactTable = firstOverallSurface.locator(".analysis-ui-table-compact").first();
  await expect(firstCompactTable).toHaveCSS("width", "520px");
  await expect.poll(async () => {
    const responseBounds = await overallResponses.first().boundingBox();
    const tableBounds = await firstCompactTable.boundingBox();
    if (!responseBounds || !tableBounds) return 0;
    return Math.round(responseBounds.x + responseBounds.width - tableBounds.x - tableBounds.width);
  }).toBeGreaterThan(100);

  const siblingWidthsBeforeCollapse = (await frameWidths(overallResponses)).slice(1);
  await groupFrames.first().getByRole("button", { name: "301A-F01", exact: true }).click();
  await expect.poll(async () => (await frameWidths(directChildFrames(groupFrames.first()))).slice(1)).toEqual(siblingWidthsBeforeCollapse);
  await groupFrames.first().getByRole("button", { name: "301A-F01", exact: true }).click();

  const assertVisibleLayout = async () => {
    expect(await textOverflowOffenders(host)).toEqual([]);
    await expect.poll(() => resultsPane.evaluate((node) => {
      const element = node as HTMLElement;
      return element.scrollWidth - element.clientWidth;
    })).toBeLessThanOrEqual(2);

    for (const groupIndex of groupTitles.keys()) {
      const responseFrames = directChildFrames(groupFrames.nth(groupIndex));
      for (const responseIndex of responseTitles.keys()) {
        const responseFrame = responseFrames.nth(responseIndex);
        await expect.poll(() => computedLayoutStyle(responseFrame)).toEqual({
          boxSizing: "border-box",
          minWidth: "0px",
        });
        await expectContainedWithin(
          responseFrame,
          responseFrame.locator("[data-analysis-block='graph']").first(),
          `group ${groupIndex + 1} response ${responseIndex + 1} graph`,
        );
        await expect.poll(() => computedLayoutStyle(responseFrame.locator("[data-analysis-block='graph']").first())).toEqual({
          boxSizing: "border-box",
          minWidth: "0px",
        });
        for (const surface of requiredSurfaces) {
          const surfaceFrame = responseSurface(responseFrame, surface.key);
          await expect(surfaceFrame, `${surface.title} should render for response ${responseIndex + 1} in group ${groupIndex + 1}`).toHaveCount(1);
          await expect.poll(() => frameTitleText(surfaceFrame)).toBe(surface.title);
          await expect.poll(() => computedLayoutStyle(surfaceFrame)).toEqual({
            boxSizing: "border-box",
            minWidth: "0px",
          });
          const table = surfaceFrame.locator(".analysis-ui-table").first();
          if (await table.count()) {
            await expect.poll(() => computedLayoutStyle(table)).toEqual({
              boxSizing: "border-box",
              minWidth: "0px",
            });
          }
          await expectContainedWithin(
            responseFrame,
            surfaceFrame,
            `group ${groupIndex + 1} response ${responseIndex + 1} surface ${surface.title}`,
          );
        }
      }
    }
  };

  await assertVisibleLayout();

  await page.setViewportSize({ width: 480, height: 1600 });
  await expect.poll(() => host.evaluate((node) => Math.round((node as HTMLElement).getBoundingClientRect().width))).toBeLessThanOrEqual(480);

  await assertVisibleLayout();
});

test("fits the painted Distribution graph without an internal vertical scroller", async ({ mount, page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const component = await mount(<AnalysisGraphVisualHarness />);
  const frames = component.locator(".analysis-ui-graph");
  const compositeCanvas = component.locator("[data-graph-role='distributionComposite'] canvas");
  const capabilityCanvas = component.locator("[data-graph-role='processCapability'] canvas");
  const expectFitPixels = async () => {
    for (const color of ["#4a6cf7", "#ef8a3a", "#2ca678", "#e74c3c", "#9168d6", "#c4ad36"]) {
      await expect.poll(() => compositeCanvas.evaluate((node, hex) => {
        const context = (node as HTMLCanvasElement).getContext("2d")!;
        const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
        const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 200 && channels.every((channel, offset) => Math.abs(pixels[index + offset] - channel) < 8)) count++;
        }
        return count;
      }, color), { message: `fitted curve ${color} must be painted` }).toBeGreaterThan(5);
    }
  };

  await expect.poll(() => browserErrors, { message: "AnalysisView must mount without browser errors" }).toEqual([]);
  await expect(page.getByTestId("visual-error")).toHaveCount(0);
  await expect(frames).toHaveCount(2);
  await expect(compositeCanvas).toHaveCount(1);
  await expect(capabilityCanvas).toHaveCount(1);
  await expect.poll(() => paintedPixelCount(compositeCanvas)).toBeGreaterThan(1_000);
  await expect.poll(() => paintedPixelCount(capabilityCanvas)).toBeGreaterThan(1_000);
  await expectFitPixels();
  await expect.poll(() => frames.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).overflowY)))
    .toEqual(["visible", "visible"]);
  await expect.poll(() => component.locator(".gc-graph")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).overflowY)))
    .toEqual(["visible", "visible"]);
  const verticalMetrics = await component
    .locator(".analysis-graph-distribution, [data-graph-role='distributionComposite'], .gc-graph")
    .evaluateAll((nodes) => nodes.map((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    })));
  assert.ok(verticalMetrics.every(({ clientHeight, scrollHeight }) => scrollHeight <= clientHeight + 1));

  await compositeCanvas.hover({ position: { x: 260, y: 120 } });
  await expect.poll(() => compositeCanvas.evaluate((node) => {
    let current: HTMLElement | null = (node as HTMLElement).parentElement;
    const cursors: string[] = [];
    while (current) {
      if (current.style.cursor) cursors.push(current.style.cursor);
      current = current.parentElement;
    }
    return cursors;
  })).toContain("grab");

  await page.mouse.move(0, 0);
  await page.screenshot({ path: "test-results/analysis-distribution-fit-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 480, height: 900 });
  await expectFitPixels();
  await expect(frames).toHaveCount(2);
  await expect.poll(() => component.locator(".gc-graph")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).overflowY)))
    .toEqual(["visible", "visible"]);
  await page.screenshot({ path: "test-results/analysis-distribution-fit-mobile.png", fullPage: true });
});

test("Fit Y by X presentation changes do not recompute and definition changes mask stale success", async ({ mount }) => {
  const component = await mount(<AnalysisExecutionHarness analysisKind="fitYByX" />);

  await expect(component.getByTestId("visible-state")).toContainText("1:success:notComputable");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Change graph presentation" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("1:success:notComputable");
  await expect(component.getByText("compute-calls:1")).toBeVisible();

  await component.getByRole("button", { name: "Change confidence" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("2:loading:");
  await expect(component.getByTestId("state-history")).not.toContainText("2:success:notComputable");
  await expect(component.getByText("compute-calls:2")).toBeVisible();

  await component.getByRole("button", { name: "Resolve pending response" }).click();
  await expect(component.getByTestId("visible-state")).toContainText("2:success:notComputable");
});

test("Fit Y by X renders through the synchronous Analysis view", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness />);

  await expect(component.locator('[data-analysis-kind="fitYByX"]')).toBeVisible();
  await component.getByRole("button", { name: "Edit Inputs" }).click();
  await expect(component.getByTestId("fit-edit-inputs-calls")).toHaveText("1");
  await expect(component.locator('[data-analysis-block="graph"]')).toBeVisible();
  await expect(component.locator('[data-analysis-block="report"]')).toBeVisible();
  await expect(component.getByText("Fit Y by X graph:Strength by Site")).toBeVisible();
  await expect(component.getByRole("button", { name: "Group Summary" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Analysis of Variance" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Effect Size" })).toBeVisible();
});

test("Fit Y by X keeps its graph visible and report reachable in the Analysis shell", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness />);
  const host = component.getByTestId("fit-analysis-host");
  const shell = host.locator(".analysis-shell");
  const results = host.locator(".analysis-shell-results");
  const graphRuntime = host.locator("[data-graph-role='main']");

  await expect(shell).toHaveCount(1);
  await expect.poll(() => shell.evaluate((node) => node.clientHeight)).toBe(480);
  await expect.poll(() => graphRuntime.evaluate((node) => node.clientHeight)).toBeGreaterThan(300);
  await expect(results).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => results.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
});

test("Fit Y by X persists axis edits and reset zoom without recomputing", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness />);

  await expect(component.getByTestId("fit-compute-calls")).toHaveText("1");
  for (const axis of ["X", "Y"] as const) {
    await component.getByRole("button", { name: `Open main ${axis} axis`, exact: true }).click();
    await expect(component.locator(".sp-dialog-title")).toHaveText(`${axis} Axis Settings`);
    if (axis === "X") {
      await component.getByLabel("Min").fill("6");
      await expect(component.getByTestId("fit-main-x-min")).toHaveText("6");
    }
    await component.getByRole("button", { name: "Done" }).click();
  }

  await component.getByRole("button", { name: "Zoom main X axis" }).click();
  await expect(component.getByTestId("fit-main-x-min")).toHaveText("4");
  await component.getByRole("button", { name: "Open main X axis menu" }).click();
  await component.getByText("Reset zoom", { exact: true }).click();
  await expect(component.getByTestId("fit-main-x-min")).toHaveText("auto");
  await expect(component.getByTestId("fit-compute-calls")).toHaveText("1");
});

test("Fit Y by X renders loading state", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="loading" />);
  await expect(component.getByText("Loading analysis results...")).toBeVisible();
});

test("Fit Y by X renders errors accessibly", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="error" />);
  await expect(component.getByRole("alert")).toContainText("fit failed");
});

test("Fit Y by X renders not-computable state", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="notComputable" />);
  await expect(component.getByText("Not computable")).toBeVisible();
  await expect(component.getByText("At least two non-empty groups are required for Oneway analysis.")).toBeVisible();
});

test("Fit Y by X renders source-missing graph and report states", async ({ mount }) => {
  const component = await mount(<FitYByXAnalysisViewHarness mode="sourceMissing" />);
  await expect(component.locator('[data-analysis-block="graph"]')).toContainText(/unavailable/i);
  await expect(component.locator('[data-analysis-block="report"]')).toContainText(/unavailable/i);
});
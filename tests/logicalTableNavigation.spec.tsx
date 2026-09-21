import { expect, test } from "@playwright/experimental-ct-react";

import { LogicalTableNavigationHarness } from "./LogicalTableNavigationHarness";

function parseStartList(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(",").filter((value) => value.length > 0).map((value) => Number(value));
}

type NavigationObservation = {
  requestId: string;
  start: number;
  sessionId: string | null;
  kind: "active" | "prefetch";
  visibleCellTextAtRequest: string | null;
  lastPaintedVisibleCellText: string | null;
  afterPaintObserved: boolean;
};

function parseNavigationObservations(raw: string | null): NavigationObservation[] {
  if (!raw) return [];
  return JSON.parse(raw) as NavigationObservation[];
}

async function dragRailToRatio(component: any, page: any, ratio: number) {
  const rail = component.getByRole("scrollbar");
  await rail.hover({ position: { x: 4, y: 8 } });
  const box = await rail.boundingBox();
  if (!box) throw new Error("logical scrollbar is not visible");
  const x = box.x + box.width / 2;
  const targetY = box.y + box.height * ratio;
  await page.mouse.down();
  await page.mouse.move(x, targetY);
  await page.mouse.up();
}

async function dragRailAcrossRatios(component: any, page: any, ratios: number[]) {
  const rail = component.getByRole("scrollbar");
  await rail.hover({ position: { x: 4, y: 8 } });
  const box = await rail.boundingBox();
  if (!box) throw new Error("logical scrollbar is not visible");
  const x = box.x + box.width / 2;
  await page.mouse.down();
  for (const ratio of ratios) {
    const targetY = box.y + box.height * ratio;
    await page.mouse.move(x, targetY);
  }
  await page.mouse.up();
}

test("renders a logical rail and viewport slots without giant vertical spacers", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness />);

  await expect(component.getByRole("scrollbar")).toBeVisible();
  await expect(component.locator('[data-viewport-slot="0"]')).toBeVisible();
  await expect.poll(() => component.locator(".sp-grid tbody td").evaluateAll((cells) => cells.some((cell) => {
    const element = cell as HTMLElement;
    const inlineHeight = element.style.height ? Number.parseFloat(element.style.height) : 0;
    return Number.isFinite(inlineHeight) && inlineHeight > 1_000_000;
  }))).toBe(false);
});

test("shows the add-row affordance only at the logical dataset end", async ({ mount, page }) => {
  const populated = await mount(<LogicalTableNavigationHarness rowCount={200} width={920} height={420} />);
  const rail = populated.getByRole("scrollbar");
  const populatedAddRow = populated.locator(".sp-add-row-hdr");

  await expect(populatedAddRow).toHaveCount(0);
  await populated.locator('td[data-row="2"][data-col="0"]').click();
  await expect(populated.locator('td[data-row="2"][data-col="0"]')).toHaveClass(/sp-cell-active/);
  await rail.focus();
  await page.keyboard.press("End");
  const maxValue = Number(await rail.getAttribute("aria-valuemax"));
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(maxValue);
  await expect(populatedAddRow).toBeVisible();
  await expect(populated.locator('td[data-row="199"]').first()).toBeVisible();
  await expect(populated.locator(".sp-grid-wrapper > .sp-grid > tbody > tr").last()).toHaveClass(/sp-add-row-tr/);

  await page.keyboard.press("Home");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await expect(populatedAddRow).toHaveCount(0);

  await page.keyboard.press("End");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(maxValue);
  await populatedAddRow.click();
  await expect(populated.getByTestId("dataset-row-count")).toHaveText("201");
  await expect(populatedAddRow).toBeVisible();
  await expect(populated.locator('td[data-row="200"]').first()).toBeVisible();

  await populatedAddRow.click();
  await expect(populated.getByTestId("dataset-row-count")).toHaveText("202");
  await expect(populated.getByTestId("mutation-pending")).toHaveText("");
  await expect(populatedAddRow).toBeVisible();

  const logicalStartAfterAppend = Number(await rail.getAttribute("aria-valuenow"));
  const firstVisibleCell = populated.locator('[data-viewport-slot="0"] td[data-col="0"]');
  await firstVisibleCell.click();
  await expect(firstVisibleCell).toHaveClass(/sp-cell-active/);
  await expect(populated.locator(".sp-spreadsheet")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeLessThan(logicalStartAfterAppend);

  await populated.getByTestId("advance-dataset-generation").click();
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
});

test("renders the logical add-row fully inside the viewport at minimum zoom", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={200} width={520} height={420} zoom={0.5} />);
  const rail = component.getByRole("scrollbar");
  const wrapper = component.locator(".sp-grid-wrapper");

  await expect(component.locator(".sp-add-row-hdr")).toHaveCount(0);
  await rail.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(Number(await rail.getAttribute("aria-valuemax")));
  const finalRow = component.locator(".sp-grid-wrapper > .sp-grid > tbody > tr").last();
  await expect(finalRow).toHaveClass(/sp-add-row-tr/);
  await expect(finalRow.locator(".sp-add-row-hdr")).toBeVisible();
  const layout = await wrapper.evaluate((element) => {
    const addRow = element.querySelector(".sp-add-row-tr");
    if (!(addRow instanceof HTMLElement)) throw new Error("add-row is missing");
    const wrapperRect = element.getBoundingClientRect();
    return {
      addRowBottom: addRow.getBoundingClientRect().bottom,
      clientBottom: wrapperRect.top + element.clientHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
  expect(layout.addRowBottom).toBeLessThanOrEqual(layout.clientBottom);
});

test("keeps the add-row affordance visible and usable with an empty dataset", async ({ mount }) => {
  const empty = await mount(<LogicalTableNavigationHarness rowCount={0} width={920} height={420} />);
  const emptyAddRow = empty.locator(".sp-add-row-hdr");

  await expect(emptyAddRow).toBeVisible();
  await expect(empty.locator(".sp-grid > tbody > tr")).toHaveCount(1);
  await expect(empty.locator(".sp-grid > tbody > tr").first()).toHaveClass(/sp-add-row-tr/);
  await emptyAddRow.click();
  await expect(empty.getByTestId("dataset-row-count")).toHaveText("1");
  await expect(empty.locator('td[data-row="0"][data-col="0"]')).toBeVisible();
});

test("corner-menu insert row appends without a row target", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={20} />);

  await component.locator(".sp-corner").click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.getByTestId("dataset-row-count")).toHaveText("21");
  await expect(component.getByTestId("add-rows-requests")).toHaveText(
    JSON.stringify([{ count: 1, beforeRowId: null, expectedGeneration: 1 }]),
  );
  await expect(component.locator(".sp-toast-error")).toHaveCount(0);
});

test("row-menu insert row uses the clicked row's stable target", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={20} />);

  await component.locator('td[data-row-hdr="2"]').click({ button: "right" });
  await component.locator(".sp-ctx-menu .sp-ctx-item").first().click();

  await expect(component.getByTestId("dataset-row-count")).toHaveText("21");
  await expect(component.getByTestId("add-rows-requests")).toHaveText(
    JSON.stringify([{ count: 1, beforeRowId: 3, expectedGeneration: 1 }]),
  );
  await expect(component.locator(".sp-toast-error")).toHaveCount(0);
});

test("dragging the logical rail reuses stable slots and shows inert placeholders until rows load", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');
  const slot0Handle = await slot0.elementHandle();

  await expect(rail).toBeVisible();
  await expect(slot0).toBeVisible();

  await dragRailToRatio(component, page, 0.9);

  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(8_900_000);
  await expect(slot0).toContainText(/89|90/);
  await expect(slot0).toHaveClass(/sp-placeholder-row/);
  await slot0.locator(".sp-placeholder-cell").first().dblclick();
  await expect(component.locator(".sp-cell-input")).toHaveCount(0);

  const placeholderHeight = await slot0.evaluate((row) => row.getBoundingClientRect().height);
  await expect.poll(() => slot0.evaluate((row) => row.classList.contains("sp-placeholder-row"))).toBe(false);
  await expect(slot0Handle?.evaluate((row) => row.isConnected)).resolves.toBe(true);
  await expect.poll(() => slot0.evaluate((row) => row.getBoundingClientRect().height)).toBe(placeholderHeight);
});

test("reloads top rows after the current dataset generation changes from a nonzero window", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');

  await dragRailToRatio(component, page, 0.9);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(8_900_000);
  await expect(slot0).not.toHaveClass(/sp-placeholder-row/);

  await component.getByTestId("advance-dataset-generation").click();

  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await expect(slot0).not.toHaveClass(/sp-placeholder-row/);
  await expect(slot0.locator('td[data-row="0"][data-col="0"] .sp-val')).toHaveText("row-1-col-1");
});

test("wheel and keyboard navigation update logical position", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness width={520} />);
  const rail = component.getByRole("scrollbar");
  const wrapper = component.locator(".sp-grid-wrapper");

  await expect(rail).toBeVisible();
  await wrapper.hover();
  await page.mouse.wheel(0, 480);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(0);

  const logicalBeforeShiftWheel = Number(await rail.getAttribute("aria-valuenow"));
  const nativeShiftWheelResult = await wrapper.evaluate((element) => {
    const event = new WheelEvent("wheel", {
      deltaY: 480,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) {
      element.scrollLeft += event.deltaY;
    }
    return {
      defaultPrevented: event.defaultPrevented,
      scrollLeft: element.scrollLeft,
    };
  });

  expect(nativeShiftWheelResult.defaultPrevented).toBe(false);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(logicalBeforeShiftWheel);
  expect(nativeShiftWheelResult.scrollLeft).toBeGreaterThan(0);

  await rail.focus();
  await page.keyboard.press("End");
  const maxValue = Number(await rail.getAttribute("aria-valuemax"));
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(maxValue);
  await page.keyboard.press("Home");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await page.keyboard.press("PageDown");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await page.keyboard.press("PageUp");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
});

test("restores the logical vertical position after the table remounts", async ({ mount, page }) => {
  const component = await mount(
    <LogicalTableNavigationHarness
      rowCount={10_000_000}
      columnCount={24}
      width={520}
      height={420}
      strictMode
    />,
  );
  const rail = component.getByRole("scrollbar");

  await dragRailToRatio(component, page, 0.62);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(0);

  const rememberedLogicalStart = Number(await rail.getAttribute("aria-valuenow"));
  await component.getByTestId("toggle-table").click();
  await expect(rail).toHaveCount(0);
  await component.getByTestId("toggle-table").click();

  const restoredRail = component.getByRole("scrollbar");
  await expect.poll(async () => Number(await restoredRail.getAttribute("aria-valuenow"))).toBe(rememberedLogicalStart);
});

test("restores the horizontal position after the table remounts", async ({ mount }) => {
  const component = await mount(
    <LogicalTableNavigationHarness rowCount={10_000_000} columnCount={24} width={520} height={420} />,
  );
  const wrapper = component.locator(".sp-grid-wrapper");

  await wrapper.evaluate((element) => {
    element.scrollLeft = 640;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBe(640);

  await component.getByTestId("toggle-table").click();
  await expect(wrapper).toHaveCount(0);
  await component.getByTestId("toggle-table").click();

  const restoredWrapper = component.locator(".sp-grid-wrapper");
  await expect.poll(() => restoredWrapper.evaluate((element) => element.scrollLeft)).toBe(640);
});

test("keeps the logical thumb fully inside the track at Home and End", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const track = component.locator(".sp-logical-scrollbar-track");
  const thumb = component.locator(".sp-logical-scrollbar-thumb");

  await expect(rail).toBeVisible();
  await rail.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => {
    const [trackBox, thumbBox] = await Promise.all([track.boundingBox(), thumb.boundingBox()]);
    if (!trackBox || !thumbBox) return false;
    return thumbBox.y >= trackBox.y && (thumbBox.y + thumbBox.height) <= (trackBox.y + trackBox.height);
  }).toBe(true);

  await page.keyboard.press("End");
  await expect.poll(async () => {
    const [trackBox, thumbBox] = await Promise.all([track.boundingBox(), thumb.boundingBox()]);
    if (!trackBox || !thumbBox) return false;
    return thumbBox.y >= trackBox.y && (thumbBox.y + thumbBox.height) <= (trackBox.y + trackBox.height);
  }).toBe(true);
});

test("selection stays attached to the logical row when slots are reused", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const targetCell = component.locator('td[data-row="2"][data-col="0"]');

  await expect(targetCell).toBeVisible();
  await targetCell.click();
  await expect(targetCell).toHaveClass(/sp-cell-active/);

  await dragRailToRatio(component, page, 0.99);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBeGreaterThan(9_800_000);
  await expect(component.locator(".sp-cell-active")).toHaveCount(0);

  await rail.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await expect(targetCell).toHaveClass(/sp-cell-active/);
});

test("keeps the released scrollbar position after selecting a cell between drags", async ({ mount, page }) => {
  await page.evaluate(() => {
    class ScrollbarInsetResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        const rect = target.getBoundingClientRect();
        queueMicrotask(() => {
          this.callback([{
            target,
            contentRect: {
              ...rect.toJSON(),
              width: rect.width,
              height: Math.max(0, rect.height - 16),
            },
          } as ResizeObserverEntry], this as unknown as ResizeObserver);
        });
      }

      unobserve() {}

      disconnect() {}
    }

    window.ResizeObserver = ScrollbarInsetResizeObserver as unknown as typeof ResizeObserver;
  });

  const component = await mount(<LogicalTableNavigationHarness width={520} />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');
  const resolvedStarts = component.getByTestId("nav-request-resolved-starts");

  await dragRailToRatio(component, page, 0.25);
  await expect.poll(() => slot0.evaluate((row) => row.classList.contains("sp-placeholder-row"))).toBe(false);
  await slot0.locator('td[data-col="0"]').click();

  await dragRailToRatio(component, page, 0.75);
  const releasedPosition = Number(await rail.getAttribute("aria-valuenow"));
  expect(releasedPosition).toBeGreaterThan(7_000_000);

  await expect.poll(async () => parseStartList(await resolvedStarts.textContent()).some((start) => (
    start > 7_000_000
  ))).toBe(true);
  await page.waitForTimeout(250);
  expect(Number(await rail.getAttribute("aria-valuenow"))).toBe(releasedPosition);
});

test("revisiting a superseded uncached range issues and resolves a fresh navigation request", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const resolvedStarts = component.getByTestId("nav-request-resolved-starts");

  await dragRailAcrossRatios(component, page, [0.45, 0.85]);

  await expect.poll(async () => parseStartList(await resolvedStarts.textContent()).some((start) => start > 8_000_000)).toBe(true);
  const lateStart = parseStartList(await resolvedStarts.textContent()).find((start) => start > 8_000_000)!;

  await dragRailToRatio(component, page, 0.45);

  await expect.poll(async () => parseStartList(await resolvedStarts.textContent()).some((start) => (
    start > 4_000_000 && start < 5_000_000
  ))).toBe(true);
  const secondResolvedStart = parseStartList(await resolvedStarts.textContent()).find((start) => (
    start > 4_000_000 && start < 5_000_000
  ))!;
  expect(secondResolvedStart).toBeLessThan(lateStart);

  const slot0 = component.locator('[data-viewport-slot="0"]');
  await expect.poll(() => slot0.evaluate((row) => row.classList.contains("sp-placeholder-row"))).toBe(false);
  await expect(slot0).toContainText(/row-/);
});

test("revisiting an actively cancelled range issues and resolves a fresh navigation request", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness rejectCancelledNavigation />);
  const starts = component.getByTestId("nav-request-starts");
  const resolvedStarts = component.getByTestId("nav-request-resolved-starts");
  const cancelledStarts = component.getByTestId("nav-request-cancelled-starts");

  await dragRailToRatio(component, page, 0.45);
  await expect.poll(async () => parseStartList(await starts.textContent()).some((start) => (
    start > 4_000_000 && start < 5_000_000
  ))).toBe(true);
  const originalStart = parseStartList(await starts.textContent()).find((start) => (
    start > 4_000_000 && start < 5_000_000
  ));
  expect(originalStart).toBeDefined();

  await dragRailToRatio(component, page, 0.85);
  await expect.poll(async () => parseStartList(await cancelledStarts.textContent())).toContain(originalStart);
  await expect.poll(async () => parseStartList(await resolvedStarts.textContent()).some((start) => (
    start > 8_000_000
  ))).toBe(true);

  await component.getByTestId("reset-navigation-telemetry").click();
  await dragRailToRatio(component, page, 0.45);

  await expect.poll(async () => parseStartList(await starts.textContent())).toContain(originalStart);
  await expect.poll(async () => parseStartList(await resolvedStarts.textContent())).toContain(originalStart);
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText(/row-/);
  await expect(component.locator(".sp-toast-error")).toHaveCount(0);
});

test("filtered navigation prepares a session before switching to the exact logical count and session-backed windows", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness initialFilterMode="ev" />);
  const rail = component.getByRole("scrollbar");

  await expect(rail).toBeVisible();
  await expect.poll(async () => (await component.getByTestId("prepared-session-ids").textContent()) ?? "").not.toBe("");
  expect(Number(await rail.getAttribute("aria-valuemax"))).toBeGreaterThan(1_000);

  await expect.poll(async () => (await component.getByTestId("session-status-calls").textContent()) ?? "").not.toBe("");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeLessThan(100);

  await dragRailToRatio(component, page, 0.9);

  await expect.poll(async () => (await component.getByTestId("nav-request-session-ids").textContent()) ?? "").toContain("session-ev");
  await expect(component.locator('[data-viewport-slot="0"]')).toContainText(/ev-row-/);
});

test("scopes logical-end follow to the active filter query", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness rowCount={200} initialFilterMode="ev" />);
  const rail = component.getByRole("scrollbar");
  const addRow = component.locator(".sp-add-row-hdr");

  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeLessThan(100);
  await rail.focus();
  await page.keyboard.press("End");
  await expect(addRow).toBeVisible();
  await addRow.click();
  await expect(component.getByTestId("dataset-row-count")).toHaveText("201");
  await expect(component.getByTestId("add-rows-requests")).toHaveText(
    JSON.stringify([{ count: 1, beforeRowId: null, expectedGeneration: 1 }]),
  );
  await expect(component.getByTestId("mutation-pending")).toHaveText("");
  await expect(component.locator(".sp-toast-error")).toHaveCount(0);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow")))
    .toBe(Number(await rail.getAttribute("aria-valuemax")));
  await expect(addRow).toBeVisible();

  await component.getByTestId("clear-filter").click();
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await expect(addRow).toHaveCount(0);
  await expect(component.locator('td[data-row="0"][data-col="0"]')).toBeVisible();
});

test("superseding a filtered signature releases the old session and never shows stale rows", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness initialFilterMode="ev" />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');

  await expect(rail).toBeVisible();
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeLessThan(100);

  await dragRailToRatio(component, page, 0.9);
  await component.getByTestId("apply-dv-filter").click();

  await expect.poll(async () => (await component.getByTestId("released-session-ids").textContent()) ?? "").toContain("session-ev");
  await expect.poll(async () => (await component.getByTestId("prepared-session-ids").textContent()) ?? "").toContain("session-dv");
  await expect(slot0).toContainText(/dv-row-/);
  await expect(slot0).not.toContainText(/ev-row-/);
});

test("filtered signature changes synchronously clear stale rows and show placeholders during a delayed replacement load", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness initialFilterMode="ev" />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');

  await expect(rail).toBeVisible();
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeLessThan(100);
  await expect(slot0).toContainText(/ev-row-/);

  await component.getByTestId("delay-next-window-load").click();
  await component.getByTestId("apply-dv-filter").click();

  await expect(slot0).toHaveClass(/sp-placeholder-row/);
  await expect(slot0).not.toContainText(/ev-row-/);
  await expect(slot0).not.toContainText(/dv-row-/);
  await expect(slot0.locator(".sp-placeholder-cell")).toHaveCount(8);
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeGreaterThan(1_000);

  await expect.poll(async () => (await component.getByTestId("released-session-ids").textContent()) ?? "").toContain("session-ev");
  await expect(slot0).toContainText(/dv-row-/);
  await expect(slot0).not.toContainText(/ev-row-/);
});

test("sorted-only navigation prepares a session and serves boundary jumps with exact counts", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const slot0 = component.locator('[data-viewport-slot="0"]');

  await expect(rail).toBeVisible();
  await component.getByTestId("apply-sort-desc").click();

  await expect.poll(async () => (await component.getByTestId("prepared-session-ids").textContent()) ?? "").toContain("session-sort-desc");
  await expect.poll(async () => (await component.getByTestId("session-exact-counts").textContent()) ?? "").toContain("37");

  await dragRailToRatio(component, page, 0.5);
  await expect.poll(async () => (await component.getByTestId("nav-request-session-ids").textContent()) ?? "").toContain("session-sort-desc");
  await expect(slot0).toContainText(/sort-desc-row-/);

  await dragRailAcrossRatios(component, page, [0, 0.5, 0.9, 0.99, 1]);
  await expect.poll(async () => {
    const [currentValue, maxValue] = await Promise.all([
      rail.getAttribute("aria-valuenow"),
      rail.getAttribute("aria-valuemax"),
    ]);
    return Number(currentValue) === Number(maxValue);
  }).toBe(true);
  await expect(slot0).toContainText(/sort-desc-row-/);
});

test("column context menu sort actions drive prepared sessions, dirty state, and natural-order restoration", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const rail = component.getByRole("scrollbar");
  const sortedHeader = component.locator('th[data-col-hdr="1"]');
  const slot0 = component.locator('[data-viewport-slot="0"]');

  await expect(rail).toBeVisible();
  await expect(component.getByTestId("project-dirty")).toHaveText("false");

  await sortedHeader.click({ button: "right" });
  await component.getByText("Sort descending", { exact: true }).click();

  await expect(component.getByTestId("project-dirty")).toHaveText("true");
  await expect(sortedHeader).toHaveAttribute("aria-sort", "descending");
  await expect(sortedHeader).toContainText("↓");
  await expect.poll(async () => (await component.getByTestId("prepared-session-ids").textContent()) ?? "").toContain("session-sort-desc");
  await expect.poll(async () => (await component.getByTestId("session-exact-counts").textContent()) ?? "").toContain("37");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuemax"))).toBeLessThan(100);

  await dragRailToRatio(component, page, 0.9);
  await expect.poll(async () => (await component.getByTestId("nav-request-session-ids").textContent()) ?? "").toContain("session-sort-desc");
  await expect(slot0).toContainText(/sort-desc-row-/);

  await sortedHeader.click({ button: "right" });
  await component.getByText("Clear sort", { exact: true }).click();

  await expect.poll(async () => (await component.getByTestId("released-session-ids").textContent()) ?? "").toContain("session-sort-desc");
  await expect(sortedHeader).not.toHaveAttribute("aria-sort", "descending");
  await sortedHeader.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => Number(await rail.getAttribute("aria-valuenow"))).toBe(0);
  await expect(slot0).toContainText(/row-/);
  await expect(slot0).not.toContainText(/sort-desc-row-/);
});

test("neighbor prefetch waits until the active window has survived a post-commit paint frame", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const observations = component.getByTestId("nav-request-observations");

  await expect(component.locator('td[data-row="0"][data-col="0"] .sp-val')).toHaveText("row-1-col-1");
  await expect.poll(async () => {
    const entries = parseNavigationObservations(await observations.textContent());
    return entries.find((entry) => entry.kind === "prefetch") ?? null;
  }).toMatchObject({
    kind: "prefetch",
    afterPaintObserved: true,
    lastPaintedVisibleCellText: "row-1-col-1",
    visibleCellTextAtRequest: "row-1-col-1",
  });
});

test("direct navigation cancels queued prefetch work from the superseded active window", async ({ mount, page }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const observations = component.getByTestId("nav-request-observations");
  const resolvedStarts = component.getByTestId("nav-request-resolved-starts");

  await expect(component.locator('td[data-row="0"][data-col="0"] .sp-val')).toHaveText("row-1-col-1");
  await component.getByTestId("reset-navigation-telemetry").click();

  await page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __task8AfterPaintGate?: {
        callbacks: Array<{ callback: () => void; cancelled: boolean }>;
        originalController: {
          schedule(callback: () => void): { cancel(): void };
        } | undefined;
      };
      __statsPlaygroundAfterPaintController?: {
        schedule(callback: () => void): { cancel(): void };
      };
      __task8ReleaseAfterPaintGate?: () => void;
      __task8RestoreAfterPaintGate?: () => void;
    };
    const existing = globalWindow.__task8AfterPaintGate;
    if (existing) return;
    const callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
    const gate = {
      callbacks,
      originalController: globalWindow.__statsPlaygroundAfterPaintController,
    };
    globalWindow.__task8AfterPaintGate = gate;
    globalWindow.__statsPlaygroundAfterPaintController = {
      schedule(callback: () => void) {
        const entry = { callback, cancelled: false };
        callbacks.push(entry);
        return {
          cancel() {
            entry.cancelled = true;
          },
        };
      },
    };
    globalWindow.__task8ReleaseAfterPaintGate = () => {
      const pendingCallbacks = gate.callbacks.splice(0, gate.callbacks.length);
      globalWindow.__statsPlaygroundAfterPaintController = gate.originalController;
      delete globalWindow.__task8AfterPaintGate;
      delete globalWindow.__task8ReleaseAfterPaintGate;
      delete globalWindow.__task8RestoreAfterPaintGate;
      for (const entry of pendingCallbacks) {
        if (entry.cancelled) continue;
        window.requestAnimationFrame(() => entry.callback());
      }
    };
    globalWindow.__task8RestoreAfterPaintGate = () => {
      globalWindow.__statsPlaygroundAfterPaintController = gate.originalController;
      delete globalWindow.__task8AfterPaintGate;
      delete globalWindow.__task8ReleaseAfterPaintGate;
      delete globalWindow.__task8RestoreAfterPaintGate;
    };
  });

  try {
    await dragRailToRatio(component, page, 0.9);
    await expect.poll(async () => parseNavigationObservations(await observations.textContent()).filter((entry) => entry.kind === "active").length).toBe(1);
    await dragRailToRatio(component, page, 0.45);
    await expect.poll(async () => parseNavigationObservations(await observations.textContent()).filter((entry) => entry.kind === "active").length).toBe(2);
    await expect.poll(async () => parseStartList(await resolvedStarts.textContent()).length).toBe(2);

    const slot0Value = component.locator('[data-viewport-slot="0"] td[data-col="0"] .sp-val').first();
    await expect(component.locator('[data-viewport-slot="0"]')).not.toHaveClass(/sp-placeholder-row/);
    await expect(slot0Value).not.toHaveText("row-1-col-1");

    await page.evaluate(() => {
      (window as typeof window & { __task8ReleaseAfterPaintGate?: () => void }).__task8ReleaseAfterPaintGate?.();
    });

    await expect.poll(async () => parseNavigationObservations(await observations.textContent()).filter((entry) => entry.kind === "prefetch").length).toBeGreaterThan(0);

    const entries = parseNavigationObservations(await observations.textContent());
    const activeEntries = entries.filter((entry) => entry.kind === "active");
    const firstActiveStart = activeEntries[0]?.start ?? null;
    const secondActiveStart = activeEntries[1]?.start ?? null;
    expect(firstActiveStart).not.toBeNull();
    expect(secondActiveStart).not.toBeNull();
    const prefetchEntries = entries.filter((entry) => entry.kind === "prefetch");
    expect(prefetchEntries.length).toBeGreaterThan(0);
    expect(prefetchEntries.some((entry) => Math.abs(entry.start - secondActiveStart!) < Math.abs(entry.start - firstActiveStart!))).toBe(true);
    expect(prefetchEntries.some((entry) => Math.abs(entry.start - secondActiveStart!) >= Math.abs(entry.start - firstActiveStart!))).toBe(false);
  } finally {
    await page.evaluate(() => {
      (window as typeof window & { __task8RestoreAfterPaintGate?: () => void }).__task8RestoreAfterPaintGate?.();
    });
  }
});

test("runtime table diagnostics include transport and cache fields", async ({ mount }) => {
  const component = await mount(<LogicalTableNavigationHarness />);
  const diagnostics = component.getByTestId("table-cache-diagnostics");

  await expect(component.locator('td[data-row="0"][data-col="0"] .sp-val')).toHaveText("row-1-col-1");
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"cacheHit"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"diagnosticJsonEncodeMs"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"postReceivePaintMs"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"diagnosticJsonBytes"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"retainedRows"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"estimatedBytes"');
  await expect.poll(async () => (await diagnostics.textContent()) ?? "").toContain('"entryCount"');
});
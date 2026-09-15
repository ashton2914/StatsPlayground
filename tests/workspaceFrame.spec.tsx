import { expect, test } from "@playwright/experimental-ct-react";

import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore";
import { WorkspaceFrameHarness } from "./WorkspaceFrameHarness";

const WORKSPACE_SIDEBAR_ID = "workspace.sidebar";
const SIDEBAR_PREFERENCE_STORAGE_KEY = "sp-layout-preferences-v1";

function measuredWidth(box: { width: number } | null, label: string) {
  if (!box) {
    throw new Error(`${label} bounding box unavailable`);
  }

  return box.width;
}

async function readStoredLayoutPreferences(page: { evaluate: <T>(pageFunction: () => T) => Promise<T> }) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sp-layout-preferences-v1");
    return raw ? JSON.parse(raw) : null;
  });
}

async function expectPanelGeometry(component: any, expectedSideWidth: number, containerWidth: number) {
  const activityWidth = measuredWidth(await component.getByTestId("activity-slot").boundingBox(), "activity");
  const sideWidth = measuredWidth(await component.getByTestId("side-slot").boundingBox(), "side");
  const mainWidth = measuredWidth(await component.getByTestId("main-slot").boundingBox(), "main");
  const separatorWidth = measuredWidth(
    await component.getByRole("separator", { name: "Resize workspace side panel" }).boundingBox(),
    "separator",
  );

  expect(activityWidth).toBeCloseTo(40, 0);
  expect(sideWidth).toBeCloseTo(expectedSideWidth, 0);
  expect(mainWidth).toBeCloseTo(containerWidth - activityWidth - sideWidth - separatorWidth, 0);
}

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => {
    localStorage.clear();
  });

  useLayoutPreferencesStore.setState({ sizes: {} });
});

test("WorkspaceFrame keyboard resize survives unmount/remount under workspace.sidebar", async ({ mount }) => {
  const containerWidth = 900;
  const component = await mount(<WorkspaceFrameHarness containerWidth={containerWidth} />);

  await expectPanelGeometry(component as any, 240, containerWidth);

  const separator = component.getByRole("separator", { name: "Resize workspace side panel" });
  await separator.press("Shift+ArrowRight");

  await expectPanelGeometry(component as any, 272, containerWidth);
  await expect.poll(async () => readStoredLayoutPreferences((component as any).page())).toEqual({
    version: 1,
    sizes: {
      "workspace.sidebar": 272,
    },
  });

  await component.unmount();

  const remounted = await mount(<WorkspaceFrameHarness containerWidth={containerWidth} />);
  await expectPanelGeometry(remounted as any, 272, containerWidth);
});

test("WorkspaceFrame double-click reset removes the persisted sidebar preference before remount", async ({ mount, page }) => {
  const containerWidth = 900;
  const component = await mount(<WorkspaceFrameHarness containerWidth={containerWidth} />);

  const separator = component.getByRole("separator", { name: "Resize workspace side panel" });
  await separator.press("Shift+ArrowRight");
  await expectPanelGeometry(component as any, 272, containerWidth);
  await expect(await readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "workspace.sidebar": 272,
    },
  });

  await separator.dblclick();
  await expectPanelGeometry(component as any, 240, containerWidth);
  await expect(await readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {},
  });

  await component.unmount();

  const remounted = await mount(<WorkspaceFrameHarness containerWidth={containerWidth} />);
  await expectPanelGeometry(remounted as any, 240, containerWidth);
});

test("WorkspaceFrame clamps the first rendered sidebar geometry to the dynamic cap", async ({ mount, page }) => {
  const containerWidth = 500;

  await page.evaluate(({ storageKey }) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sizes: {
          "workspace.sidebar": 360,
        },
      }),
    );
  }, { storageKey: SIDEBAR_PREFERENCE_STORAGE_KEY });

  useLayoutPreferencesStore.setState({
    sizes: { [WORKSPACE_SIDEBAR_ID]: 360 },
  });

  const component = await mount(
    <WorkspaceFrameHarness
      containerWidth={containerWidth}
      captureInitialSideWidth
    />,
  );

  await expect(component.getByTestId("first-side-width")).toHaveText("200");
  await expectPanelGeometry(component as any, 200, containerWidth);
});

test("WorkspaceFrame first paint keeps pane width and separator aria-valuenow aligned for persisted sidebar width", async ({ mount, page }) => {
  const containerWidth = 900;

  await page.evaluate(({ storageKey }) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sizes: {
          "workspace.sidebar": 272,
        },
      }),
    );
  }, { storageKey: SIDEBAR_PREFERENCE_STORAGE_KEY });

  useLayoutPreferencesStore.setState({
    sizes: { [WORKSPACE_SIDEBAR_ID]: 272 },
  });

  const component = await mount(
    <WorkspaceFrameHarness
      containerWidth={containerWidth}
      captureInitialSideWidth
    />,
  );

  await expect(component.getByTestId("first-side-width")).toHaveText("272");
  await expect(component.getByTestId("first-separator-valuenow")).toHaveText("272");
});
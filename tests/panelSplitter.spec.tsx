import { expect, test } from "@playwright/experimental-ct-react";

import { PanelSplitterHarness } from "./PanelSplitterHarness";

test("PanelSplitter drags, clamps, and commits with the requested orientation and direction", async ({ mount }) => {
  const component = await mount(
    <PanelSplitterHarness
      orientation="vertical"
      direction={-1}
      min={200}
      max={360}
      defaultValue={240}
      unit="px"
      label="Resize test panel"
    />,
  );

  const separator = component.getByRole("separator", { name: "Resize test panel" });

  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuemin", "200");
  await expect(separator).toHaveAttribute("aria-valuemax", "360");
  await expect(separator).toHaveAttribute("aria-valuenow", "240");

  const box = await separator.boundingBox();
  if (!box) throw new Error("separator bounding box unavailable");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await separator.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: startY,
  });
  await separator.dispatchEvent("pointermove", {
    pointerId: 1,
    pointerType: "mouse",
    buttons: 1,
    clientX: startX - 40,
    clientY: startY,
  });
  await expect(component.getByTestId("panel-value")).toHaveText("280");
  await separator.dispatchEvent("pointermove", {
    pointerId: 1,
    pointerType: "mouse",
    buttons: 1,
    clientX: startX - 200,
    clientY: startY,
  });
  await expect(component.getByTestId("panel-value")).toHaveText("360");
  await separator.dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    clientX: startX - 200,
    clientY: startY,
  });
  await expect(component.getByTestId("panel-commits")).toHaveText("360");

  await separator.dblclick();
  await expect(component.getByTestId("panel-value")).toHaveText("240");
  await separator.press("Enter");
  await expect(component.getByTestId("panel-value")).toHaveText("240");
});

test("PanelSplitter handles horizontal keyboard movement, pointer cancellation, and unmount cleanup", async ({ mount }) => {
  const component = await mount(
    <PanelSplitterHarness
      orientation="horizontal"
      min={120}
      max={240}
      defaultValue={160}
      unit="px"
      label="Resize test panel"
    />,
  );

  const separator = component.getByRole("separator", { name: "Resize test panel" });

  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await separator.press("ArrowDown");
  await expect(component.getByTestId("panel-value")).toHaveText("168");
  await expect(component.getByTestId("panel-commits")).toHaveText("168");
  await separator.press("Shift+ArrowUp");
  await expect(component.getByTestId("panel-value")).toHaveText("136");
  await expect(component.getByTestId("panel-commits")).toHaveText("168,136");
  await separator.press("Home");
  await expect(component.getByTestId("panel-value")).toHaveText("120");
  await expect(component.getByTestId("panel-commits")).toHaveText("168,136,120");
  await separator.press("End");
  await expect(component.getByTestId("panel-value")).toHaveText("240");
  await expect(component.getByTestId("panel-commits")).toHaveText("168,136,120,240");

  const box = await separator.boundingBox();
  if (!box) throw new Error("separator bounding box unavailable");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await separator.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: startY,
  });
  await separator.dispatchEvent("pointermove", {
    pointerId: 1,
    pointerType: "mouse",
    buttons: 1,
    clientX: startX,
    clientY: startY - 40,
  });
  await expect(component.getByTestId("panel-value")).toHaveText("200");
  await separator.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    clientX: startX,
    clientY: startY - 40,
  });
  await expect(component.getByTestId("panel-commits")).toHaveText("168,136,120,240,200");

  await component.unmount();
});
import { expect, test } from "@playwright/experimental-ct-react";

import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore";
import { TabulateLayoutHarness } from "./TabulateLayoutHarness";

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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.clear();
  });

  useLayoutPreferencesStore.setState({ sizes: {} });
});

test("TabulateLayout renders two desktop splitters, persists independent sizes, and resets them separately", async ({ mount, page }) => {
  const component = await mount(<TabulateLayoutHarness containerWidth={1280} />);

  const fieldsSeparator = component.getByRole("separator", { name: "Resize tabulate fields panel" });
  const configurationSeparator = component.getByRole("separator", { name: "Resize tabulate configuration panel" });

  await expect(fieldsSeparator).toHaveCount(1);
  await expect(configurationSeparator).toHaveCount(1);
  await expect(fieldsSeparator).toHaveAttribute("aria-valuenow", "300");
  await expect(configurationSeparator).toHaveAttribute("aria-valuenow", "360");

  await fieldsSeparator.press("Shift+ArrowRight");
  await configurationSeparator.press("Shift+ArrowRight");

  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("fields-slot").boundingBox(), "fields"))).toBe(332);
  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("configuration-slot").boundingBox(), "configuration"))).toBe(392);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "tabulate.fields": 332,
      "tabulate.configuration": 392,
    },
  });

  await fieldsSeparator.dblclick();
  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("fields-slot").boundingBox(), "fields"))).toBe(300);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "tabulate.configuration": 392,
    },
  });

  await configurationSeparator.dblclick();
  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("configuration-slot").boundingBox(), "configuration"))).toBe(360);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {},
  });
});

test("TabulateLayout preserves a 320px results minimum and reclamps when the container shrinks", async ({ mount }) => {
  const component = await mount(<TabulateLayoutHarness containerWidth={1280} />);

  const fieldsSeparator = component.getByRole("separator", { name: "Resize tabulate fields panel" });
  const configurationSeparator = component.getByRole("separator", { name: "Resize tabulate configuration panel" });

  await fieldsSeparator.press("End");
  await configurationSeparator.press("End");

  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("results-slot").boundingBox(), "results"))).toBeGreaterThanOrEqual(320);

  await component.getByTestId("shrink-container").click();

  await expect.poll(async () => Math.round(measuredWidth(await component.getByTestId("results-slot").boundingBox(), "results"))).toBeGreaterThanOrEqual(320);
  await expect(fieldsSeparator).toHaveAttribute("aria-valuemax", "312");
  await expect(configurationSeparator).toHaveAttribute("aria-valuemax", "392");
  await expect(fieldsSeparator).toHaveAttribute("aria-valuenow", "312");
  await expect(configurationSeparator).toHaveAttribute("aria-valuenow", "320");
});

test("TabulateLayout omits desktop splitters in narrow mode without consuming stored desktop widths", async ({ mount, page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "sp-layout-preferences-v1",
      JSON.stringify({
        version: 1,
        sizes: {
          "tabulate.fields": 388,
          "tabulate.configuration": 444,
        },
      }),
    );
  });

  useLayoutPreferencesStore.setState({
    sizes: {
      "tabulate.fields": 388,
      "tabulate.configuration": 444,
    },
  });

  const component = await mount(<TabulateLayoutHarness containerWidth={820} narrow />);

  await expect(component.getByRole("separator", { name: "Resize tabulate fields panel" })).toHaveCount(0);
  await expect(component.getByRole("separator", { name: "Resize tabulate configuration panel" })).toHaveCount(0);
  await expect.poll(async () => readStoredLayoutPreferences(page)).toEqual({
    version: 1,
    sizes: {
      "tabulate.fields": 388,
      "tabulate.configuration": 444,
    },
  });
});
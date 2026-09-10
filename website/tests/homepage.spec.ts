import { expect, test } from "@playwright/test";

test("introduces the real product and primary journey", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/StatsPlayground/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your data has more to say.",
  );
  await expect(
    page.getByRole("link", { name: "Explore the product" }),
  ).toHaveAttribute("href", "#product");
  await expect(
    page.getByRole("img", { name: /StatsPlayground workspace/i }),
  ).toBeVisible();
  await expect(page.locator("#product")).toBeVisible();
  await expect(page.locator("#capabilities")).toBeVisible();
  await expect(page.locator("#open-source")).toBeVisible();
});

test("uses real destinations for docs, source, and releases", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.locator("[data-menu-toggle]").click();
  }
  await expect(
    page.getByRole("link", { name: "Docs", exact: true }).first(),
  ).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground/tree/dev/docs",
  );
  await expect(
    page.getByRole("link", { name: "GitHub", exact: true }).first(),
  ).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground",
  );
  await expect(
    page.getByRole("link", { name: "Download", exact: true }).first(),
  ).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground/releases/latest",
  );
  await expect(
    page.getByRole("link", { name: "Community", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground/issues",
  );
});

test("renders a useful static not-found page", async ({ page }) => {
  await page.goto("/404.html");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This path wandered off.",
  );
  await expect(page.getByRole("link", { name: "Return home" })).toHaveAttribute(
    "href",
    "/",
  );
});

test("never creates horizontal page overflow", async ({ page }) => {
  await page.goto("/");
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBe(widths.viewport);
});

test("opens and closes the mobile navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  const toggle = page.locator("[data-menu-toggle]");
  const navigation = page.locator("#primary-navigation");
  await expect(toggle).toHaveAttribute("aria-label", "Open navigation");
  await expect(navigation).toHaveAttribute("hidden", "");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("aria-label", "Close navigation");
  await expect(navigation).not.toHaveAttribute("hidden", "");
  await expect(navigation).toBeVisible();
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-label", "Open navigation");
  await expect(navigation).toHaveAttribute("hidden", "");
});

test("collapses navigation when resizing from desktop to mobile", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");
  const navigation = page.locator("#primary-navigation");
  await expect(navigation).not.toHaveAttribute("hidden", "");
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(navigation).toHaveAttribute("hidden", "");
  await expect(navigation.locator('a[href="#product"]')).toHaveAttribute(
    "tabindex",
    "-1",
  );
});

test("renders reveal content immediately with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("[data-reveal]").first()).toHaveCSS("opacity", "1");
});

test("has visible keyboard focus", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toBeVisible();
});
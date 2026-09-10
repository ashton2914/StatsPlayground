import { expect, test } from "@playwright/test";

for (const image of [
  "statsplayground-workspace.webp",
  "statsplayground-analysis.webp",
]) {
  test(`${image} is usable product media`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:4321/images/${image}`);
    const metrics = await page.locator("img").evaluate(async (element) => {
      const imageElement = element as HTMLImageElement;
      await imageElement.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 56;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context?.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
      const pixels =
        context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
      const colors = new Set<string>();
      for (let index = 0; index < pixels.length; index += 16) {
        colors.add(`${pixels[index]}:${pixels[index + 1]}:${pixels[index + 2]}`);
      }
      return {
        width: imageElement.naturalWidth,
        height: imageElement.naturalHeight,
        colors: colors.size,
      };
    });

    expect(metrics.width).toBeGreaterThanOrEqual(1200);
    expect(metrics.height).toBeGreaterThanOrEqual(700);
    expect(metrics.colors).toBeGreaterThan(80);
  });
}
import { defineConfig, devices } from "@playwright/experimental-ct-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.tsx$/,
  timeout: 30_000,
  fullyParallel: false,
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
    viewport: { width: 1000, height: 700 },
    ctViteConfig: {
      resolve: {
        alias: {
          "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
      },
    },
  },
});
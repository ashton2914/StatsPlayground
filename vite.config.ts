import { realpathSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

import { resolveAppVersion } from "./scripts/appVersionCore.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.TAURI_DEV_HOST;
const fontAwesomeRoot = realpathSync(resolve(__dirname, "node_modules/@fortawesome/fontawesome-free"));

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      allow: [searchForWorkspaceRoot(__dirname), fontAwesomeRoot],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

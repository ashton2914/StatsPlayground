import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveStoredThemeMode } from "../src/stores/themeMode.ts";

assert.equal(resolveStoredThemeMode(null), "light", "a missing preference must default to light");
assert.equal(resolveStoredThemeMode("invalid"), "light", "an invalid preference must default to light");

for (const mode of ["light", "dark", "system"] as const) {
  assert.equal(resolveStoredThemeMode(mode), mode, `a saved ${mode} preference must be preserved`);
}

const expectedDarkLabels: Record<string, string> = {
  "en.json": "Dark (Experimental)",
  "zh-CN.json": "深色（试验性）",
  "zh-TW.json": "深色（試驗性）",
  "vi.json": "Tối (Thử nghiệm)",
};

for (const [localeFile, expectedLabel] of Object.entries(expectedDarkLabels)) {
  const locale = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${localeFile}`, import.meta.url), "utf8"),
  ) as { prefs: { themeDark: string } };

  assert.equal(
    locale.prefs.themeDark,
    expectedLabel,
    `${localeFile} must label the dark theme as experimental`,
  );
}

console.log("theme preferences contract tests passed");

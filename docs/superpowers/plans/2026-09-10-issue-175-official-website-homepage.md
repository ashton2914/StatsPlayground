# Issue 175 Official Website Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the first production homepage for StatsPlayground at `statsplayground.org`, with an immersive Data Canvas hero, factual product presentation, and GitHub Pages deployment.

**Architecture:** Add an independent Astro static-site package under `website/`; keep the existing root Vite/Tauri build untouched. Render the homepage from focused Astro components with one shared stylesheet, use real locally stored product captures, and deploy `website/dist` through Astro's official GitHub Pages action.

**Tech Stack:** Astro 7, TypeScript, semantic HTML/CSS, minimal browser JavaScript, Lucide Astro icons, Playwright, Node test runner, GitHub Actions, GitHub Pages

**Spec:** `docs/superpowers/specs/2026-09-10-issue-175-official-website-homepage-design.md`

## Global Constraints

- Work only in `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website` on `feat/issue-175-official-website`, based on `origin/dev@57bf662`.
- Keep the root Tauri/Vite application commands and behavior unchanged.
- Keep all website runtime dependencies inside `website/package.json` and `website/package-lock.json`.
- Configure Astro with `site: "https://statsplayground.org"` and no `base` value.
- Publish `website/public/CNAME` with the single line `statsplayground.org`.
- Use English content in phase one while preserving a future route boundary for localized content.
- Use the existing StatsPlayground icon; do not redesign the brand in this phase.
- Use a real, current StatsPlayground product capture. Do not ship the existing empty-workspace smoke screenshot or a fabricated product UI.
- Keep essential content available without runtime API calls or client-side rendering.
- Respect `prefers-reduced-motion: reduce`; motion cannot carry essential meaning.
- Use near-black green `#121715`, mint, and coral only as the hero palette; move later sections to a cool light neutral.
- Do not add a documentation shell, documentation search, blog, CMS, analytics, user accounts, or mailing-list integration.
- Do not commit, push, or create a pull request before explicit manual acceptance under the repository Issue lifecycle.
- After every first substantive edit in a task, run that task's focused check before further edits.
- Bind every command to this worktree with `npm --prefix` or `git -C`; do not rely on a terminal's current directory.

## File Structure

### Website package and deployment

- Create `website/package.json` - isolated scripts and Astro/Playwright dependencies.
- Create `website/package-lock.json` - reproducible npm dependency graph.
- Create `website/astro.config.mjs` - static output and canonical production site.
- Create `website/tsconfig.json` - Astro strict TypeScript configuration.
- Create `website/public/CNAME` - GitHub Pages custom-domain contract.
- Create `website/public/favicon.svg` - website copy of the existing app icon.
- Create `website/src/pages/index.astro` - minimal buildable entry, replaced by the approved homepage composition in Task 3.
- Create `.github/workflows/website.yml` - build and deploy only the website package.
- Create `website/tests/foundation.test.mjs` - package, domain, and workflow contract tests.

### Product media

- Create `website/public/images/statsplayground-workspace.webp` - optimized real product capture.
- Create `website/public/images/statsplayground-analysis.webp` - optimized detail capture used by the capability section.
- Create `website/tests/product-media.spec.ts` - natural-size, load, framing, and pixel-diversity assertions.

### Homepage implementation

- Create `website/src/layouts/BaseLayout.astro` - document shell, metadata, favicon, and global styles.
- Create `website/src/components/SiteHeader.astro` - responsive brand and navigation.
- Create `website/src/components/DataCanvas.astro` - decorative accessible-hidden point field and relationship line.
- Create `website/src/components/Hero.astro` - headline, actions, data canvas, and first-viewport product media.
- Create `website/src/components/ProductJourney.astro` - factual table-to-analysis-to-report workflow.
- Create `website/src/components/CoreValues.astro` - three unframed product-value statements.
- Create `website/src/components/Capabilities.astro` - curated current product capabilities and real media.
- Create `website/src/components/OpenSourceCta.astro` - GitHub, docs, and download closing actions.
- Create `website/src/components/SiteFooter.astro` - compact product/documentation/community footer.
- Modify `website/src/pages/index.astro` - homepage composition only.
- Create `website/src/pages/404.astro` - useful static not-found page.
- Create `website/src/styles/global.css` - tokens, layout, typography, responsive behavior, focus, and motion.
- Create `website/src/scripts/homepage.ts` - mobile-navigation and progressive reveal behavior.
- Create `website/tests/homepage.spec.ts` - semantic, navigation, responsive, accessibility, and visual checks.
- Create `website/playwright.config.ts` - local Astro web server and desktop/mobile projects.

### Project documentation

- Modify `README.md` - add the canonical official-site link without rewriting the existing product description.
- Modify `docs/development.md` - document website install, development, build, test, and Pages configuration commands.

---

### Task 1: Establish The Independent Astro And Pages Contract

**Files:**
- Create: `website/tests/foundation.test.mjs`
- Create: `website/package.json`
- Create: `website/package-lock.json`
- Create: `website/astro.config.mjs`
- Create: `website/tsconfig.json`
- Create: `website/public/CNAME`
- Create: `website/public/favicon.svg`
- Create: `website/src/pages/index.astro`
- Create: `.github/workflows/website.yml`

**Interfaces:**
- Consumes: repository root at `origin/dev@57bf662` and custom domain `statsplayground.org`.
- Produces: `npm --prefix website run build`, `npm --prefix website run test:contracts`, `website/dist/`, and the Pages deployment workflow consumed by final verification.

- [ ] **Step 1: Write the failing foundation contract test**

Create `website/tests/foundation.test.mjs` with tests that read the package,
Astro config, CNAME, and repository workflow:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("builds the website as an isolated Astro package", async () => {
  const packageJson = JSON.parse(await read("../package.json"));
  assert.equal(packageJson.name, "@statsplayground/website");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.scripts.build, "astro build");
  assert.equal(packageJson.scripts.check, "astro check");
  assert.ok(packageJson.dependencies.astro);
});

test("publishes the root custom domain without a repository base path", async () => {
  const config = await read("../astro.config.mjs");
  assert.match(config, /site:\s*["']https:\/\/statsplayground\.org["']/);
  assert.doesNotMatch(config, /\bbase\s*:/);
  assert.equal((await read("../public/CNAME")).trim(), "statsplayground.org");
});

test("deploys the website package through GitHub Pages", async () => {
  const workflow = await read("../../.github/workflows/website.yml");
  assert.match(workflow, /branches:\s*\[dev\]/);
  assert.match(workflow, /path:\s*website/);
  assert.match(workflow, /withastro\/action@v6/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
});
```

- [ ] **Step 2: Run RED and confirm the package is absent**

Run:

```bash
node --test /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website/tests/foundation.test.mjs
```

Expected: FAIL because `website/package.json`, `website/astro.config.mjs`,
`website/public/CNAME`, and `.github/workflows/website.yml` do not exist.

- [ ] **Step 3: Create the minimal isolated package**

Create `website/package.json`:

```json
{
  "name": "@statsplayground/website",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "check": "astro check",
    "test:contracts": "node --test tests/foundation.test.mjs",
    "test:e2e": "playwright test",
    "test": "npm run test:contracts && npm run check && npm run build && npm run test:e2e"
  }
}
```

Install current compatible package versions and commit the generated lockfile:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website install astro@latest lucide-astro@latest
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website install --save-dev @astrojs/check@latest @playwright/test@latest typescript@latest
```

Create `website/astro.config.mjs`:

```js
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://statsplayground.org",
  output: "static",
});
```

Create `website/tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict"
}
```

Copy the path data from the tracked root `public/icon.svg` into
`website/public/favicon.svg`, preserving its view box and existing license
comment. Create `website/public/CNAME` with exactly:

```text
statsplayground.org
```

Create a minimal buildable `website/src/pages/index.astro` whose complete
contents are:

```astro
---
const title = "StatsPlayground";
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
  </head>
  <body>
    <main><h1>{title}</h1></main>
  </body>
</html>
```

This is the smallest valid package entry and intentionally lacks every Task 3
homepage behavior, so the Task 3 Playwright tests still fail for the expected
missing requirements.

- [ ] **Step 4: Add the official Pages workflow**

Create `.github/workflows/website.yml` with concurrency and minimal permissions:

```yaml
name: Deploy official website

on:
  push:
    branches: [dev]
    paths:
      - "website/**"
      - ".github/workflows/website.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
      - name: Install, build, and upload website
        uses: withastro/action@v6
        with:
          path: website
          node-version: 24

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
```

- [ ] **Step 5: Run GREEN foundation checks**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:contracts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run check
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run build
```

Expected: foundation tests PASS, Astro check reports zero errors, and static
output is generated under `website/dist/`.

- [ ] **Step 6: Inspect the task boundary without committing**

Run:

```bash
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website --no-pager diff --no-ext-diff --stat
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website status --short
```

Expected: only the approved design/plan, `website/` foundation, lockfile, and
website workflow are present. Do not commit before manual acceptance.

---

### Task 2: Produce And Prove Real Product Media

**Files:**
- Create: `website/tests/product-media.spec.ts`
- Create: `website/public/images/statsplayground-workspace.webp`
- Create: `website/public/images/statsplayground-analysis.webp`

**Interfaces:**
- Consumes: the current Tauri application, `testdata/StatsPlayground_300k_test.spprj`, and the website Playwright dependency from Task 1.
- Produces: `/images/statsplayground-workspace.webp` and `/images/statsplayground-analysis.webp`, each at least 1200 by 700 pixels with nonblank product content.

- [ ] **Step 1: Write the failing media integrity test**

Create `website/tests/product-media.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

for (const image of [
  "statsplayground-workspace.webp",
  "statsplayground-analysis.webp",
]) {
  test(`${image} is a detailed real product capture`, async ({ page }) => {
    await page.setContent(`<img alt="product" src="http://127.0.0.1:4321/images/${image}">`);
    const metrics = await page.locator("img").evaluate(async (element) => {
      const imageElement = element as HTMLImageElement;
      await imageElement.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 56;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context?.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
      const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
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
```

- [ ] **Step 2: Run RED and confirm both media requests fail**

Start the empty Astro site in a persistent process:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run dev -- --host 127.0.0.1 --port 4321
```

Run the media test. Expected: FAIL because both WebP assets return 404 or cannot
decode. Keep the Astro process for the next check.

- [ ] **Step 3: Capture the real product states**

Launch the Tauri application from the Issue 175 worktree using an available
frontend port, load `testdata/StatsPlayground_300k_test.spprj`, and capture:

1. The full project workspace with populated Directory and an active Graph
   Builder or analysis view.
2. A focused analysis state with a real chart and supporting result content.

The capture must show the tracked application UI and real test-project state.
It must not show another application's chrome, private user paths, notifications,
or unrelated desktop content. Crop to a 16:10 or 16:9 product frame, then use
the macOS `sips` tool to resize only when the source is larger than needed and
convert the final assets to WebP without changing their aspect ratio. Keep at
least 1200 by 700 pixels.

Do not reuse
`docs/superpowers/artifacts/2026-08-31-distribution-phase-a-layout-capability-tauri-smoke.png`;
it shows an empty workspace and fails the product-signal requirement.

- [ ] **Step 4: Run GREEN media integrity checks**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website exec -- playwright test tests/product-media.spec.ts
```

Expected: 2 tests PASS with natural dimensions at least 1200 by 700 and more
than 80 sampled colors.

- [ ] **Step 5: Review both captures visually**

Open both WebP files with the image viewer. Confirm the product is readable,
the selected content is real, no private filesystem path is visible, no text is
cut at the crop boundary, and the two images show meaningfully different states.

---

### Task 3: Build The Semantic Homepage And Product Story

**Files:**
- Create: `website/playwright.config.ts`
- Create: `website/tests/homepage.spec.ts`
- Create: `website/src/layouts/BaseLayout.astro`
- Create: `website/src/components/SiteHeader.astro`
- Create: `website/src/components/DataCanvas.astro`
- Create: `website/src/components/Hero.astro`
- Create: `website/src/components/ProductJourney.astro`
- Create: `website/src/components/CoreValues.astro`
- Create: `website/src/components/Capabilities.astro`
- Create: `website/src/components/OpenSourceCta.astro`
- Create: `website/src/components/SiteFooter.astro`
- Modify: `website/src/pages/index.astro`
- Create: `website/src/pages/404.astro`

**Interfaces:**
- Consumes: product images from Task 2 and stable external URLs defined below.
- Produces: semantic `/` and `/404.html` static pages with `#product`, `#capabilities`, and `#open-source` anchors.

- [ ] **Step 1: Define Playwright's local server and viewports**

Create `website/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  use: { baseURL: "http://127.0.0.1:4321" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4321",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: true,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
```

- [ ] **Step 2: Write RED homepage behavior tests**

Create `website/tests/homepage.spec.ts` with these initial assertions:

```ts
import { expect, test } from "@playwright/test";

test("introduces the real product and primary journey", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/StatsPlayground/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your data has more to say.");
  await expect(page.getByRole("link", { name: "Explore the product" })).toHaveAttribute("href", "#product");
  await expect(page.getByRole("img", { name: /StatsPlayground workspace/i })).toBeVisible();
  await expect(page.locator("#product")).toBeVisible();
  await expect(page.locator("#capabilities")).toBeVisible();
  await expect(page.locator("#open-source")).toBeVisible();
});

test("uses real destinations for docs, source, and releases", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Docs", exact: true }).first()).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground/tree/dev/docs",
  );
  await expect(page.getByRole("link", { name: "GitHub", exact: true }).first()).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground",
  );
  await expect(page.getByRole("link", { name: "Download", exact: true }).first()).toHaveAttribute(
    "href",
    "https://github.com/ashton2914/StatsPlayground/releases/latest",
  );
});

test("renders a useful static not-found page", async ({ page }) => {
  await page.goto("/404.html");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This path wandered off.");
  await expect(page.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
});
```

- [ ] **Step 3: Run RED against the empty Astro package**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:e2e -- --project=desktop tests/homepage.spec.ts
```

Expected: FAIL because the homepage components, copy, links, and 404 page do not
exist.

- [ ] **Step 4: Implement the document shell and navigation**

Create `BaseLayout.astro` with `lang="en"`, canonical metadata based on
`Astro.site`, Open Graph title/description, favicon, skip link, global CSS, and
slots for page content. Use this exact default description:

```text
An open-source, local-first desktop workspace for visual data exploration and statistical analysis.
```

Create `SiteHeader.astro` with the existing spiral icon, wordmark, and these
destinations:

```ts
const links = [
  { label: "Product", href: "#product" },
  { label: "Docs", href: "https://github.com/ashton2914/StatsPlayground/tree/dev/docs" },
  { label: "GitHub", href: "https://github.com/ashton2914/StatsPlayground" },
];
const downloadUrl = "https://github.com/ashton2914/StatsPlayground/releases/latest";
```

The mobile menu button uses Lucide's `Menu` and `X` icons, has an accessible
name, and carries `aria-expanded` plus `aria-controls`.

- [ ] **Step 5: Implement the hero and data canvas**

Create `DataCanvas.astro` as `aria-hidden="true"`. Render a deterministic set of
positioned point elements, axis labels, and one coral relationship path. Do not
use random positions at runtime.

Create `Hero.astro` with:

```text
Eyebrow: Open source · Desktop · Local first
Headline: Your data has more to say.
Body: Explore, visualize, and understand it in one open-source statistics workspace built to keep the whole analytical story together.
Primary: Explore the product → #product
Secondary: Watch overview → #product-demo
```

Place `statsplayground-workspace.webp` in a semantic `figure` whose lower edge
remains visible in the first desktop viewport. Use Astro's image metadata for
stable width and height. Do not put the headline or product image in a card.

- [ ] **Step 6: Implement the factual product sections**

`ProductJourney.astro` owns `id="product"` and includes three stages:

```text
01 Shape the data — Import tables, manage column properties, and keep repeatable transformations with the project.
02 Follow the signal — Move from Graph Builder to focused statistical analyses without losing the source context.
03 Keep the reasoning — Assemble results into reports and preserve reusable workflows for the next dataset.
```

The embedded demonstration owns `id="product-demo"` and uses the full workspace
capture.

`CoreValues.astro` renders unframed bands for:

```text
Local-first ownership
Visual statistical thinking
Open and extensible
```

`Capabilities.astro` owns `id="capabilities"`, uses the analysis capture, and
lists only current capabilities:

```text
Tables & transforms
Graph Builder
Distribution & Fit Y by X
Fit Model & hypothesis testing
Reports & reusable workflows
```

`OpenSourceCta.astro` owns `id="open-source"` and links to source, existing
repository docs, and the latest Release. `SiteFooter.astro` repeats those stable
destinations and displays the repository license as Apache-2.0, matching
`LICENSE`.

- [ ] **Step 7: Compose the pages and run GREEN behavior tests**

Compose the components in `src/pages/index.astro` without business logic.
Create `src/pages/404.astro` through `BaseLayout` with the heading and home link
asserted above.

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run check
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:e2e -- --project=desktop tests/homepage.spec.ts
```

Expected: Astro check reports zero errors and the three desktop homepage tests
PASS.

---

### Task 4: Implement The Approved Visual System, Motion, And Responsive Behavior

**Files:**
- Create: `website/src/styles/global.css`
- Create: `website/src/scripts/homepage.ts`
- Modify: `website/src/layouts/BaseLayout.astro`
- Modify: `website/src/components/SiteHeader.astro`
- Modify: `website/src/components/Hero.astro`
- Modify: `website/src/components/ProductJourney.astro`
- Modify: `website/src/components/Capabilities.astro`
- Modify: `website/tests/homepage.spec.ts`

**Interfaces:**
- Consumes: semantic component classes and anchors from Task 3.
- Produces: `data-reveal` progressive enhancement, `[data-menu-toggle]` navigation behavior, desktop/mobile visual snapshots, and reduced-motion final-state behavior.

- [ ] **Step 1: Add RED responsive and motion tests**

Append these behaviors to `homepage.spec.ts`:

```ts
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
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
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
```

- [ ] **Step 2: Run RED on desktop and mobile**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:e2e -- tests/homepage.spec.ts
```

Expected: the new menu, reduced-motion, focus, or overflow assertions FAIL
because the visual and interaction layer is not implemented.

- [ ] **Step 3: Implement design tokens and stable layout geometry**

Create `global.css` with these root tokens:

```css
:root {
  --ink: #121715;
  --ink-soft: #1d2421;
  --paper: #f4f7f5;
  --paper-strong: #ffffff;
  --text: #111614;
  --text-muted: #68736e;
  --line: #d9e0dc;
  --mint: #baf4d3;
  --mint-strong: #75dca2;
  --coral: #ff7d63;
  --yellow: #f4e783;
  --content: 1200px;
  --radius: 8px;
}
```

Use a self-hosted font only if its license file is added beside the font. If no
verified font asset is available, use this dependency-free fallback stack:

```css
font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
```

Do not fetch Google Fonts at runtime. Set stable media aspect ratios, bounded
content widths, zero letter spacing, and fixed icon-button hit areas. Do not use
gradient orbs, bokeh blobs, or nested cards.

- [ ] **Step 4: Implement meaningful motion and mobile navigation**

Create `homepage.ts` with two independent behaviors:

1. Toggle the mobile navigation, `aria-expanded`, accessible button label, and
   document scroll lock; close after selecting an internal navigation link.
2. Use one `IntersectionObserver` to add `data-visible="true"` to elements with
   `data-reveal`. If IntersectionObserver is unavailable, reveal all elements.

In CSS, animate only opacity and transform. The hero sequence uses bounded
delays for eyebrow, headline, body, actions, points, relationship, and product
media. Add this exact reduced-motion override:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  [data-reveal] {
    opacity: 1;
    transform: none;
  }
}
```

- [ ] **Step 5: Finish desktop and mobile composition**

At desktop widths, keep the hero at least `min(900px, 100svh)` and expose the
upper portion of the real application frame before the fold. At mobile widths,
reduce the decorative point count with CSS, stack actions, use a deliberate
wide crop via `object-position`, and keep the next section visible below the
hero. The navigation becomes an icon toggle below 760 pixels.

Ensure the hero remains dark, while Product Journey and later content use light
surfaces with more than one accent family. Keep internal panel headings compact;
only the hero receives display-scale type.

- [ ] **Step 6: Run GREEN responsive checks and capture snapshots**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:e2e -- tests/homepage.spec.ts
```

Expected: all desktop and mobile tests PASS.

Capture full-page screenshots at 1440 by 1000 and iPhone 13 dimensions to
`test-results/website-homepage-desktop.png` and
`test-results/website-homepage-mobile.png`. Inspect both with the image viewer
for overlap, clipping, unreadable product media, blank areas, and accidental
one-note color dominance.

---

### Task 5: Document The Website And Run The Full Acceptance Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/development.md`
- Modify only for verified defects: website source, tests, or workflow files from Tasks 1-4.

**Interfaces:**
- Consumes: complete homepage, website commands, and deployment workflow.
- Produces: contributor instructions, final verification evidence, local acceptance URL, and a manually accepted tree ready for commit.

- [ ] **Step 1: Write RED documentation contract assertions**

Append to `website/tests/foundation.test.mjs`:

```js
test("documents the official site and website development commands", async () => {
  const readme = await read("../../README.md");
  const development = await read("../../docs/development.md");
  assert.match(readme, /https:\/\/statsplayground\.org/);
  assert.match(development, /npm --prefix website run dev/);
  assert.match(development, /npm --prefix website run build/);
  assert.match(development, /npm --prefix website run test/);
  assert.match(development, /GitHub Pages/);
  assert.match(development, /statsplayground\.org/);
});
```

- [ ] **Step 2: Run RED and confirm website instructions are absent**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test:contracts
```

Expected: FAIL because the root README and development guide do not yet include
the official site and isolated website commands.

- [ ] **Step 3: Add concise contributor documentation**

Add `Official website: https://statsplayground.org` near the top of `README.md`.

Add an `Official website` section to `docs/development.md` with:

```bash
npm --prefix website install
npm --prefix website run dev
npm --prefix website run check
npm --prefix website run build
npm --prefix website run test
```

Explain that `website/` is independent of the desktop application, production
output is `website/dist/`, Pages deploys from `dev` through
`.github/workflows/website.yml`, and the repository owner must select GitHub
Actions as the Pages source and configure the verified custom-domain DNS.

- [ ] **Step 4: Run GREEN documentation and website gates**

Run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run test
```

Expected: contract tests, Astro check, static build, and all Playwright desktop
and mobile tests PASS.

- [ ] **Step 5: Prove the desktop package boundary**

Install root dependencies only if the worktree does not already have them, then
run:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website run build
```

Expected: the existing TypeScript and Vite application build succeeds without
reading website source or changing its output contract.

- [ ] **Step 6: Run repository hygiene checks**

Run:

```bash
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website --no-pager diff --no-ext-diff --stat
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website --no-pager diff --no-ext-diff --check
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website status --short --untracked-files=all
```

Expected: only Issue 175 source, tests, assets, workflow, and documentation are
present; generated `website/dist/`, Playwright output, and nested `node_modules/`
remain ignored.

- [ ] **Step 7: Request independent review**

Dispatch a reviewer with Issue 175, base SHA `57bf662`, the approved design,
this plan, and the complete tracked/untracked diff. Require review of custom
domain behavior, Pages permissions, factual product claims, external links,
responsive layout, accessibility, asset privacy, reduced motion, and package
isolation. Fix every Critical or Important finding and rerun the affected
focused test plus the full website gate.

- [ ] **Step 8: Start the acceptance server**

Run the production preview as a persistent process on an available port:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website/website run preview -- --host 127.0.0.1 --port 4322
```

Verify that the process cwd, served assets, and page source belong to the Issue
175 worktree before sharing `http://127.0.0.1:4322/`.

- [ ] **Step 9: Perform manual acceptance**

Ask the user to check:

1. The Data Canvas hero feels modern, minimal, spacious, and distinct.
2. The first viewport clearly shows that StatsPlayground is a real desktop app.
3. Explore Product and Watch Overview reach the intended product content.
4. Docs, GitHub, and Download open the correct destinations.
5. Product claims and screenshots match the current application.
6. Desktop and mobile layouts contain no overlap, clipping, or unreadable text.
7. Reduced-motion mode preserves every piece of content.
8. `/404.html` provides a useful route home.

Stop for explicit acceptance. Do not commit, push, or create a pull request.

- [ ] **Step 10: Commit only after explicit acceptance**

After acceptance, rerun Steps 4-6 against the exact tree, stage only Issue 175
files, inspect the staged diff, and commit with:

```bash
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website add .github/workflows/website.yml README.md docs/development.md docs/superpowers/specs/2026-09-10-issue-175-official-website-homepage-design.md docs/superpowers/plans/2026-09-10-issue-175-official-website-homepage.md website
git -C /Users/ashton/git/ashton2914/StatsPlayground.worktrees/feat-issue-175-official-website commit -m "feat(website): launch official homepage"
```

Push and pull request creation remain separate actions governed by the GitHub
Issue workflow after manual acceptance.
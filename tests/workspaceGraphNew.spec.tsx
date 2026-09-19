import { expect, test } from "@playwright/experimental-ct-react";
import { WorkspaceGraphNewHarness } from "./WorkspaceGraphNewHarness";

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => { (window as any).__APP_VERSION__ = "0.0.0-test"; });
});

test("native-only project retains a selectable missing-source document", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness missingOnly />);
  await component.getByTestId("graph-new-document-native-one").click();
  await expect(component.locator(".graph-builder-new-stage")).toContainText("The source table is no longer available.");
  const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  expect(state.sessions[0].datasetGeneration).toBe(0);
  expect(state.documents[0].datasetId).toBe("missing-source");
  expect(state.dirty).toBe(false);
});

test("two configured documents survive Workspace save close reset open and independent tree reopen", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  await component.getByTestId("graph-new-document-native-one").click();
  await expect(component.getByLabel("X field")).toHaveValue("x");
  await expect(component.getByLabel("Raw series")).toHaveValue("line");
  await expect(component.getByRole("checkbox", { name: "Mean", exact: true })).not.toBeChecked();
  await component.getByRole("button", { name: "Close Graph Builder-new", exact: true }).click();
  await component.getByTestId("graph-new-document-native-two").click();
  await component.getByLabel("Raw series").selectOption("scatter");
  await component.getByRole("button", { name: "Close Graph Builder-new", exact: true }).click();
  const before = (await state()).documents;
  await component.locator(".menu-bar-save").click();
  await expect.poll(async () => (await state()).saveCount).toBe(1);
  expect((await state()).saved.graphBuildersNew).toEqual(before);
  expect((await state()).saved.graphBuilders).toHaveLength(1);
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Close Project", { exact: true }).click();
  await expect.poll(async () => (await state()).documents.length).toBe(0);
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Open Project", { exact: false }).click();
  await expect(component.getByTestId("graph-new-document-native-one")).toBeVisible();
  expect((await state()).documents).toEqual(before);
  expect((await state()).sessions).toEqual([]);
  expect((await state()).dirty).toBe(false);
  await component.getByTestId("graph-new-document-native-one").click();
  await expect(component.getByLabel("Raw series")).toHaveValue("line");
  await expect.poll(async () => (await state()).renderRequests.at(-1)?.cameraDomain).toEqual(before[0].camera);
  expect((await state()).sessions[0].datasetGeneration).toBe(23);
  await component.getByTestId("graph-new-document-native-two").click();
  await expect(component.getByLabel("X field")).toHaveValue("y");
  await expect(component.getByLabel("X interpretation")).toHaveValue("duration");
  await expect(component.getByLabel("Raw series")).toHaveValue("scatter");
  await component.getByText("Legacy.spgh", { exact: true }).click();
  await expect(component.locator(".graph-builder-new")).toHaveCount(0);
  expect((await state()).legacy).toHaveLength(1);
  expect((await state()).dirty).toBe(false);
});

for (const dirty of [false, true]) {
  test(`rejected project open preserves original native project and next save dirty=${dirty}`, async ({ mount, page }) => {
    const component = await mount(<WorkspaceGraphNewHarness />);
    const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
    const first = component.getByTestId("graph-new-document-native-one");
    await component.getByRole("button", { name: "New Folder", exact: true }).click();
    await component.locator(".sp-folder-row input").fill("Charts");
    await component.locator(".sp-folder-row input").press("Enter");
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await first.dispatchEvent("dragstart", { dataTransfer: transfer });
    await component.locator(".sp-folder-row").dispatchEvent("drop", { dataTransfer: transfer });
    await first.click();
    await expect(component.getByLabel("X field")).toHaveValue("x");
    await component.locator(".menu-bar-save").click();
    await expect.poll(async () => (await state()).saveCount).toBe(1);
    if (dirty) await component.getByLabel("Raw series").selectOption("scatter");
    const before = await state();
    await page.evaluate(() => (window as any).__workspacePersistence.failOpen("unsupported future native graph version"));
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept(); });
    await component.getByRole("button", { name: "File", exact: true }).click();
    await component.getByText("Open Project", { exact: false }).click();
    await expect.poll(() => dialogs.some((message) => message.includes("unsupported future"))).toBe(true);
    const after = await state();
    for (const key of ["documents", "sessions", "folders", "folderPaths", "datasets", "project", "legacy", "dirty"]) {
      expect(after[key], key).toEqual(before[key]);
    }
    await expect(component.getByLabel("X field")).toHaveValue("x");
    await expect(first).toHaveClass(/active/);
    await component.locator(".menu-bar-save").click();
    await expect.poll(async () => (await state()).saveCount).toBe(2);
    const saved = (await state()).saved;
    expect(saved.graphBuildersNew).toEqual(before.documents);
    expect(saved.graphBuildersNew).toHaveLength(2);
    expect(saved.graphNewFolders).toEqual(before.folders);
    expect(await page.evaluate(() => (window as any).__workspacePersistence.savePaths())).toEqual(["/virtual/persistence.spprj", "/virtual/persistence.spprj"]);
  });
}

test("dirty project open cancellation preserves selection and never calls open", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  const first = component.getByTestId("graph-new-document-native-one");
  await first.click();
  await component.getByLabel("Raw series").selectOption("scatter");
  const before = await state();
  page.once("dialog", (dialog) => dialog.dismiss());
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Open Project", { exact: false }).click();
  await expect(first).toHaveClass(/active/);
  const after = await state();
  expect(after.commands).not.toContain("open_project");
  for (const key of ["documents", "sessions", "folders", "folderPaths", "project", "dirty"]) expect(after[key]).toEqual(before[key]);
});

test("Save As is available and includes closed native documents", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  await component.locator(".menu-bar-save").click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().saveCount)).toBe(1);
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Save As...", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().saveCount)).toBe(2);
  const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  expect(state.saved.graphBuildersNew).toHaveLength(2);
  expect(state.commands.filter((command: string) => command === "plugin:dialog|save")).toHaveLength(2);
});

test("native rename collision and folder move rename delete preserve documents and legacy graphs", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const first = component.getByTestId("graph-new-document-native-one");
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  await first.click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Rename", { exact: true }).click();
  await first.locator("input").fill("second.spgn");
  await first.locator("input").press("Enter");
  await expect(first).toContainText("second-2.spgn");
  await component.getByRole("button", { name: "New Folder", exact: true }).click();
  await component.locator(".sp-folder-row input").fill("Charts");
  await component.locator(".sp-folder-row input").press("Enter");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await first.dispatchEvent("dragstart", { dataTransfer: transfer });
  await component.locator(".sp-folder-row").dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(async () => (await state()).folders).toEqual({ "native-one": "Charts" });
  await component.locator(".sp-folder-row").click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Rename", { exact: true }).click();
  await component.locator(".sp-folder-row input").fill("Results");
  await component.locator(".sp-folder-row input").press("Enter");
  await expect.poll(async () => (await state()).folders).toEqual({ "native-one": "Results" });
  await component.locator(".menu-bar-save").click();
  await expect.poll(async () => (await state()).saveCount).toBe(1);
  expect((await state()).saved.graphNewFolders).toEqual({ "native-one": "Results" });
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Open Project", { exact: false }).click();
  await expect(component.locator(".sp-folder").getByTestId("graph-new-document-native-one")).toBeVisible();
  expect((await state()).dirty).toBe(false);
  await component.locator(".sp-folder-row").click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Delete", { exact: true }).click();
  await expect(first).toBeVisible();
  expect((await state()).folders).toEqual({});
  expect((await state()).documents).toHaveLength(2);
  await first.click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Delete", { exact: true }).click();
  expect((await state()).documents.map((item: any) => item.id)).toEqual(["native-two"]);
  expect((await state()).legacy).toHaveLength(1);
  expect((await state()).dirty).toBe(true);
});

test("old project defaults clear native definitions and missing field identity remains diagnostic", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  await component.locator(".menu-bar-save").click();
  await expect.poll(async () => (await state()).saveCount).toBe(1);
  await page.evaluate(() => (window as any).__workspacePersistence.missingField());
  await component.getByTestId("graph-new-document-native-one").click();
  await expect(component.locator(".graph-builder-new-stage")).toContainText("unavailable");
  expect((await state()).documents[0].yColumnId).toBe("y");
  expect((await state()).dirty).toBe(false);
  await page.evaluate(() => (window as any).__workspacePersistence.legacyOpen());
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Open Project", { exact: false }).click();
  await expect.poll(async () => (await state()).documents).toEqual([]);
  expect((await state()).sessions).toEqual([]);
  expect((await state()).folders).toEqual({});
  await expect(component.getByText("Legacy.spgh", { exact: true })).toBeVisible();
  expect((await state()).dirty).toBe(false);
});

test("dataset deletion removes both native dependents and their assignments", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  await component.getByTestId("graph-new-document-native-one").click();
  await component.getByText("Measurements.sptb", { exact: true }).click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Delete", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().documents)).toEqual([]);
  const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  expect(state.sessions).toEqual([]);
  expect(state.folders).toEqual({});
  expect(state.legacy).toEqual([]);
  expect(state.dirty).toBe(true);
  await expect(component.locator(".graph-builder-new")).toHaveCount(0);
});

test("actual create action clears table selection and saves two independently edited configurations", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  for (const [xMode, rawMode] of [["numeric", "scatter"], ["duration", "pointsLine"]]) {
    await component.getByText("Measurements.sptb", { exact: true }).click();
    await component.getByRole("button", { name: "Graph", exact: true }).click();
    await component.getByRole("menuitem", { name: "Graph Builder-new", exact: true }).click();
    await component.getByLabel("X field").selectOption("x");
    await component.getByLabel("Y field", { exact: true }).selectOption("y");
    await component.getByLabel("X interpretation").selectOption(xMode);
    await component.getByLabel("Raw series").selectOption(rawMode);
    await component.getByRole("checkbox", { name: "Mean", exact: true }).uncheck();
    await component.getByRole("button", { name: "Close Graph Builder-new", exact: true }).click();
  }
  await component.locator(".menu-bar-save").click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().saveCount)).toBe(1);
  const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  expect(state.saved.graphBuildersNew.slice(2).map((item: any) => [item.xMode, item.rawMode, item.showMean])).toEqual([["numeric", "scatter", false], ["duration", "pointsLine", false]]);
  expect(state.sessions).toEqual([]);
});

test("save lock blocks edits and project replacement while failure retains dirty definitions", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  await component.getByTestId("graph-new-document-native-one").click();
  await component.getByLabel("Raw series").selectOption("scatter");
  await page.evaluate(() => { (window as any).__workspacePersistence.holdSave(); (window as any).__workspacePersistence.failSave(true); });
  await component.locator(".menu-bar-save").click();
  await expect.poll(async () => (await state()).readOnly).toBe(true);
  await expect(component.getByLabel("X field")).toBeDisabled();
  await component.getByTestId("graph-new-document-native-one").click({ button: "right" });
  await expect(component.locator(".sp-ctx-menu").getByText("Delete", { exact: true })).toHaveClass(/disabled/);
  await component.getByRole("button", { name: "File", exact: true }).click();
  await expect(component.getByText("Close Project", { exact: true })).toHaveClass(/disabled/);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => (window as any).__workspacePersistence.releaseSave());
  await expect.poll(async () => (await state()).readOnly).toBe(false);
  expect((await state()).dirty).toBe(true);
  expect((await state()).documents[0].rawMode).toBe("scatter");
});

test("dirty project close can be cancelled without losing native documents", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  await component.getByTestId("graph-new-document-native-one").click();
  await component.getByLabel("Raw series").selectOption("scatter");
  let prompted = false;
  page.once("dialog", async (dialog) => { prompted = true; await dialog.dismiss(); });
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("Close Project", { exact: true }).click();
  await expect.poll(() => prompted).toBe(true);
  await expect(component.getByTestId("graph-new-document-native-one")).toBeVisible();
  expect((await page.evaluate(() => (window as any).__workspacePersistence.snapshot())).dirty).toBe(true);
});

test("active native tree selection is idempotent and New Project resets retained documents", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness />);
  const row = component.getByTestId("graph-new-document-native-one");
  await row.click();
  await expect(component.getByLabel("X field")).toHaveValue("x");
  const transport = await page.evaluate(() => (window as any).__workspacePersistence.snapshot().sessions[0].transportId);
  await row.click();
  expect(await page.evaluate(() => (window as any).__workspacePersistence.snapshot().sessions[0].transportId)).toBe(transport);
  await component.getByRole("button", { name: "File", exact: true }).click();
  await component.getByText("New Project", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().documents)).toEqual([]);
  const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  expect(state.sessions).toEqual([]);
  expect(state.folders).toEqual({});
  expect(state.dirty).toBe(false);
});

for (const language of ["en", "zh-CN"]) {
  test(`native name admission reports localized byte and reserved errors ${language}`, async ({ mount, page }) => {
    const component = await mount(<WorkspaceGraphNewHarness />);
    const first = component.getByTestId("graph-new-document-native-one");
    await first.click({ button: "right" });
    await component.locator(".sp-ctx-menu").getByText("Rename", { exact: true }).click();
    await page.evaluate((locale) => (window as any).__workspacePersistence.language(locale), language);
    const messages: string[] = [];
    page.on("dialog", async (dialog) => { messages.push(dialog.message()); await dialog.accept(); });
    for (const [name, expected] of [["a".repeat(256), /255.*UTF-8/], ["界".repeat(86), /255.*UTF-8/], ["CON.txt", language === "en" ? /reserved.*Windows/ : /Windows.*保留/]] as const) {
      await first.locator("input").fill(name);
      await first.locator("input").press("Enter");
      await expect.poll(() => messages.at(-1)).toMatch(expected);
      const state = await page.evaluate(() => (window as any).__workspacePersistence.snapshot());
      expect(state.documents[0].name).toBe("First");
      expect(state.dirty).toBe(false);
      await first.locator("input").press("Escape");
      await page.evaluate(() => (window as any).__workspacePersistence.language("en"));
      await first.click({ button: "right" });
      await component.locator(".sp-ctx-menu").getByText("Rename", { exact: true }).click();
      await page.evaluate((locale) => (window as any).__workspacePersistence.language(locale), language);
    }
    await first.locator("input").fill("界".repeat(85));
    await first.locator("input").press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__workspacePersistence.snapshot().documents[0].name)).toBe("界".repeat(85));
  });
}

test("unsafe legacy folder rejects native assignment create and move with actionable errors", async ({ mount, page }) => {
  const component = await mount(<WorkspaceGraphNewHarness legacyFolders />);
  await expect(component.getByTestId("graph-new-document-native-one")).toBeVisible();
  const state = () => page.evaluate(() => (window as any).__workspacePersistence.snapshot());
  const reserved = component.locator(".sp-folder-row").filter({ hasText: /^CON$/ });
  const charts = component.locator(".sp-folder-row").filter({ hasText: /^Charts$/ });
  const messages: string[] = [];
  page.on("dialog", async (dialog) => { messages.push(dialog.message()); await dialog.accept(); });
  const before = await state();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await component.getByTestId("graph-new-document-native-one").dispatchEvent("dragstart", { dataTransfer: transfer });
  await reserved.dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toMatch(/reserved.*Windows/);
  await charts.dispatchEvent("dragstart", { dataTransfer: transfer });
  await reserved.dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(() => messages.length).toBe(2);
  await reserved.click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("New Subfolder", { exact: true }).click();
  await expect.poll(() => messages.length).toBe(3);
  await charts.click({ button: "right" });
  await component.locator(".sp-ctx-menu").getByText("Rename", { exact: true }).click();
  await component.locator(".sp-folder-row input").fill("AUX.log");
  await component.locator(".sp-folder-row input").press("Enter");
  await expect.poll(() => messages.length).toBe(4);
  expect(messages.every((message) => /reserved.*Windows/.test(message))).toBe(true);
  const after = await state();
  for (const key of ["documents", "folders", "folderPaths", "dirty"]) expect(after[key]).toEqual(before[key]);
  await component.locator(".sp-folder-row input").fill("Results");
  await component.locator(".sp-folder-row input").press("Enter");
  const inner = component.locator(".sp-folder-row").filter({ hasText: /^Inner$/ });
  await component.getByTestId("graph-new-document-native-one").dispatchEvent("dragstart", { dataTransfer: transfer });
  await inner.dispatchEvent("drop", { dataTransfer: transfer });
  await component.locator(".menu-bar-save").click();
  await expect.poll(async () => (await state()).saveCount).toBe(1);
  expect((await state()).saved.graphNewFolders).toEqual({ "native-one": "Results/Inner" });
  expect((await state()).folderPaths).toContain("CON");
});

for (const width of [1280, 600]) {
  test(`Workspace native document visual evidence ${width}`, async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const component = await mount(<WorkspaceGraphNewHarness />);
    await component.getByTestId("graph-new-document-native-one").click();
    await expect(component.getByRole("checkbox", { name: "Mean", exact: true })).toBeVisible();
    await expect.poll(() => component.locator(".graph-builder-new canvas").first().evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 0 && value === 31);
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`), fullPage: true });
    const graph = await component.locator(".graph-builder-new").boundingBox();
    expect(graph).not.toBeNull();
    expect(graph!.x + graph!.width).toBeLessThanOrEqual(width + 1);
  });
}
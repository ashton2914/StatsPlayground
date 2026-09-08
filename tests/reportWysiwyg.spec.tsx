import { expect, test } from "@playwright/experimental-ct-react";

import { ReportExternalUpdateHarness, ReportViewHarness } from "./reportViewHarness";

test("edits the rendered report instead of exposing Markdown source", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown={"# Direct Report\n\nBody"} />);

  await expect(component.locator("textarea")).toHaveCount(0);
  await expect(component.getByRole("tab", { name: "Preview" })).toHaveCount(0);

  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(editor.locator("h1")).toHaveText("Direct Report");
  await expect(editor).toContainText("Body");
});

test("shows an empty-report prompt and persists direct typing", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown="" />);
  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");

  await expect(editor.locator("p")).toHaveAttribute("data-placeholder", "Write Markdown here...");
  await editor.fill("Directly edited");
  await expect(component.getByTestId("report-markdown")).toHaveText("Directly edited");
});

test("formats content and inserts project documents from the toolbar", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown={"Body"} />);
  const editor = component.locator(".sp-report-editor-surface [contenteditable=true]");

  await editor.getByText("Body").selectText();
  await component.getByRole("button", { name: "Bold" }).click();
  await expect(editor.locator("strong")).toHaveText("Body");

  await component.getByRole("combobox", { name: "Text style" }).selectOption("heading2");
  await expect(editor.locator("h2")).toHaveText("Body");

  await component.getByRole("button", { name: "Insert project document" }).click();
  await component.getByRole("menuitem", { name: "Scatter Plot" }).click();
  await expect(editor.locator('[data-kind="graph"][data-document-id="graph-1"]')).toBeVisible();
  await expect(component.getByTestId("report-markdown")).toContainText('{{sp-embed kind="graph" id="graph-1"}}');
});

test("deletes selected project atoms and persists the removal", async ({ mount, page }) => {
  const component = await mount(
    <ReportViewHarness initialMarkdown={'Before\n\n{{sp-embed kind="graph" id="graph-1"}}\n\nAfter'} />,
  );
  const embed = component.locator('[data-kind="graph"][data-document-id="graph-1"]');

  await embed.click();
  await expect(embed).toHaveClass(/is-selected/);
  await page.keyboard.press("Delete");

  await expect(embed).toHaveCount(0);
  await expect(component.getByTestId("report-markdown")).not.toContainText("{{sp-embed");
});

test("loads external Markdown without emitting an editor update", async ({ mount }) => {
  const component = await mount(<ReportExternalUpdateHarness />);

  await expect(component.getByTestId("change-count")).toHaveText("0");
  await component.getByRole("button", { name: "Load external Markdown" }).click();
  await expect(component.locator(".sp-report-editor-surface h2")).toHaveText("External");
  await expect(component.getByTestId("change-count")).toHaveText("0");
});

test("fills the workspace without editing controls in read-only mode", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown={"# Read only"} readOnly />);

  await expect(component.locator(".sp-report-toolbar")).toHaveCount(0);
  await expect(component.locator(".sp-report-editor-surface [contenteditable=false] h1")).toHaveText("Read only");
  const surfaceBox = await component.locator(".sp-report-editor-surface").boundingBox();
  expect(surfaceBox?.height).toBeGreaterThan(300);
});
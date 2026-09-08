import { expect, test } from "@playwright/experimental-ct-react";

import { WorkflowPanel } from "../../src/components/workflow/WorkflowPanel";
import { WorkflowView } from "../../src/components/workflow/WorkflowView";
import type { DatasetMeta } from "../../src/types/data";
import type { ProjectLineageGraph, WorkflowDefinition } from "../../src/types/workflow";

const lineageGraph: ProjectLineageGraph = {
  id: "project-lineage",
  name: "Project lineage",
  nodes: [
    {
      nodeType: "artifact",
      id: "table-1",
      documentRef: { kind: "table", id: "dataset-1" },
      name: "Measurements",
      artifactKind: "table",
      inputPort: { id: "input", name: "input", payloadKind: "table" },
      outputPort: { id: "output", name: "output", payloadKind: "table" },
    },
    {
      nodeType: "operation",
      id: "operation-1",
      kind: "graphGeneration",
      schemaVersion: "1",
      inputPorts: [{ id: "input", name: "input", payloadKind: "table" }],
      outputPorts: [{ id: "output", name: "output", payloadKind: "graph" }],
    },
  ],
  edges: [{
    id: "edge-1",
    kind: "consumes",
    source: { nodeId: "table-1", portId: "output" },
    target: { nodeId: "operation-1", portId: "input" },
  }],
};

const directedLineageGraph: ProjectLineageGraph = {
  ...lineageGraph,
  nodes: [
    ...lineageGraph.nodes,
    {
      nodeType: "artifact",
      id: "graph-1",
      documentRef: { kind: "graph", id: "graph-1" },
      name: "Yield graph",
      artifactKind: "graph",
      inputPort: { id: "input", name: "input", payloadKind: "graph" },
      outputPort: { id: "output", name: "output", payloadKind: "graph" },
    },
  ],
  edges: [
    ...lineageGraph.edges,
    {
      id: "edge-2",
      kind: "produces",
      source: { nodeId: "operation-1", portId: "output" },
      target: { nodeId: "graph-1", portId: "input" },
    },
  ],
};

const workflow: WorkflowDefinition = {
  id: "workflow-1",
  name: "Analyze yield",
  formatVersion: "1",
  revision: 2,
  inputSlots: [{
    id: "input-1",
    name: "Measurements",
    outputPort: { id: "output", name: "output", payloadKind: "table" },
    schemaContract: {
      schemaFingerprint: "schema-1",
      columns: [{
        name: "yield",
        canonicalDuckdbType: "DOUBLE",
        required: true,
        requiredByOperationIds: ["operation-1"],
      }],
    },
  }],
  operations: [{
    id: "operation-1",
    kind: "graphGeneration",
    schemaVersion: "1",
    inputPorts: [{ id: "input", name: "input", payloadKind: "table" }],
    outputPorts: [{ id: "output", name: "output", payloadKind: "graph" }],
  }],
  edges: [{
    id: "edge-1",
    kind: "consumes",
    source: { nodeId: "input-1", portId: "output" },
    target: { nodeId: "operation-1", portId: "input" },
  }],
  outputDeclarations: [],
};

const dataset: DatasetMeta = {
  id: "dataset-1",
  name: "Current measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 20,
  colCount: 1,
  generation: 1,
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
};

test("renders workflow navigation and connected nodes", async ({ mount }) => {
  const component = await mount(
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", width: 960, height: 620 }}>
      <WorkflowPanel
        lineageGraph={lineageGraph}
        workflows={[workflow]}
        workflowRuns={[]}
        selectedId={workflow.id}
        onSelect={() => {}}
      />
      <WorkflowView lineageGraph={lineageGraph} workflow={workflow} datasets={[dataset]} />
    </div>,
  );

  await expect(component.getByRole("heading", { name: "Analyze yield" })).toBeVisible();
  await expect(component.getByRole("option", { name: "Current measurements" })).toBeAttached();
  await expect(component.locator(".workflow-node")).toHaveCount(2);
  await expect(component.locator(".workflow-canvas path")).toHaveCount(1);
  await expect(component.locator(".workflow-view")).toHaveCSS("display", "flex");
  await expect(component).toHaveScreenshot("workflow-view.png");
});

test("keeps workflow input controls inside a narrow viewport", async ({ mount, page }) => {
  await page.setViewportSize({ width: 430, height: 700 });
  const component = await mount(
    <div style={{ width: 410, height: 650 }}>
      <WorkflowView lineageGraph={lineageGraph} workflow={workflow} datasets={[dataset]} />
    </div>,
  );

  const inputRow = component.locator(".workflow-input-row");
  const view = component.locator(".workflow-view");
  const [inputBox, viewBox] = await Promise.all([inputRow.boundingBox(), view.boundingBox()]);
  expect(inputBox).not.toBeNull();
  expect(viewBox).not.toBeNull();
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(viewBox!.x + viewBox!.width);
});

test("checks the selected input table schema", async ({ mount, page }) => {
  await page.evaluate(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string) => {
          if (command === "get_columns") return [["yield", "INTEGER"]];
          if (command === "get_column_display_props") return [];
          throw new Error(`Unexpected command: ${command}`);
        },
        transformCallback: () => 1,
      },
    });
  });
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView lineageGraph={lineageGraph} workflow={workflow} datasets={[dataset]} />
    </div>,
  );

  await component.getByLabel("Measurements").selectOption(dataset.id);
  await expect(component.locator(".workflow-schema-status .invalid")).toContainText(
    "0 missing, 1 wrong type",
  );
});

test("shows a saved workflow input schema when its initial node is double-clicked", async ({ mount, page }) => {
  const workflowWithInspectableSchema: WorkflowDefinition = {
    ...workflow,
    inputSlots: [{
      ...workflow.inputSlots[0],
      schemaContract: {
        schemaFingerprint: "schema-inspectable",
        columns: [{
          ...workflow.inputSlots[0].schemaContract.columns[0],
          requiredExtras: { spec: { lsl: 90, usl: 110 } },
        }],
      },
    }],
  };
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView
        lineageGraph={lineageGraph}
        workflow={workflowWithInspectableSchema}
        datasets={[dataset]}
      />
    </div>,
  );

  await component.locator(".workflow-node-input").dblclick();
  const dialog = component.getByRole("dialog", { name: "Schema requirements" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Measurements" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "yield" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "DOUBLE" })).toBeVisible();
  await expect(dialog.getByText('spec: {"lsl":90,"usl":110}')).toBeVisible();
  await expect(dialog.getByText("operation-1")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("ignores a stale schema response after changing the input table", async ({ mount, page }) => {
  await page.evaluate(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string, args: { datasetId?: string }) => {
          if (command === "get_column_display_props") return [];
          if (command !== "get_columns") throw new Error(`Unexpected command: ${command}`);
          if (args.datasetId === "dataset-slow") {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            return [["yield", "INTEGER"]];
          }
          return [["yield", "DOUBLE"]];
        },
        transformCallback: () => 1,
      },
    });
  });
  const slowDataset = { ...dataset, id: "dataset-slow", name: "Slow incompatible table" };
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView
        lineageGraph={lineageGraph}
        workflow={workflow}
        datasets={[slowDataset, dataset]}
      />
    </div>,
  );

  const input = component.getByLabel("Measurements");
  await input.selectOption(slowDataset.id);
  await input.selectOption(dataset.id);
  await expect(component.locator(".workflow-schema-status .valid")).toContainText("Schema compatible");
  await page.waitForTimeout(150);
  await expect(component.locator(".workflow-schema-status .valid")).toContainText("Schema compatible");
});

test("blocks a table whose required column extras do not match", async ({ mount, page }) => {
  await page.evaluate(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string) => {
          if (command === "get_columns") return [["yield", "DOUBLE"]];
          if (command === "get_column_display_props") {
            return [{ colIndex: 0, extras: { spec: { lsl: 80, usl: 120 } } }];
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        transformCallback: () => 1,
      },
    });
  });
  const workflowWithRequiredSpec: WorkflowDefinition = {
    ...workflow,
    inputSlots: [{
      ...workflow.inputSlots[0],
      schemaContract: {
        schemaFingerprint: "schema-with-spec",
        columns: [{
          ...workflow.inputSlots[0].schemaContract.columns[0],
          requiredExtras: { spec: { lsl: 90, usl: 110 } },
        }],
      },
    }],
  };
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView
        lineageGraph={lineageGraph}
        workflow={workflowWithRequiredSpec}
        datasets={[dataset]}
      />
    </div>,
  );

  await component.getByLabel("Measurements").selectOption(dataset.id);
  await expect(component.locator(".workflow-schema-status .invalid")).toContainText(
    "0 missing, 0 wrong type, 1 wrong properties",
  );
});

test("selects all upstream and downstream nodes", async ({ mount, page }) => {
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView lineageGraph={directedLineageGraph} datasets={[dataset]} />
    </div>,
  );

  const nodes = component.locator(".workflow-node");
  await nodes.nth(2).click();
  await expect(nodes.nth(0)).toHaveClass(/selected/);
  await expect(nodes.nth(1)).toHaveClass(/selected/);
  await expect(nodes.nth(2)).toHaveClass(/selected/);

  await nodes.nth(2).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(nodes.nth(0)).not.toHaveClass(/selected/);
  await expect(nodes.nth(1)).not.toHaveClass(/selected/);
  await expect(nodes.nth(2)).not.toHaveClass(/selected/);

  await page.keyboard.press("Escape");
  await expect(nodes.nth(0)).not.toHaveClass(/selected/);
  await expect(nodes.nth(1)).not.toHaveClass(/selected/);
});

test("selects intersecting nodes with a drag marquee", async ({ mount, page }) => {
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView lineageGraph={lineageGraph} datasets={[dataset]} />
    </div>,
  );

  const canvas = component.locator(".workflow-canvas");
  const firstNode = component.locator(".workflow-node").first();
  const canvasBox = await canvas.boundingBox();
  const nodeBox = await firstNode.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(nodeBox).not.toBeNull();

  await page.mouse.move(nodeBox!.x - 8, nodeBox!.y - 8);
  await page.mouse.down();
  await page.mouse.move(nodeBox!.x + nodeBox!.width + 8, nodeBox!.y + nodeBox!.height + 8);
  await page.mouse.up();

  await expect(firstNode).toHaveClass(/selected/);
  await expect(component.locator(".workflow-node").nth(1)).toHaveClass(/selected/);
  await expect(canvas.locator(".workflow-selection-marquee")).toHaveCount(0);
});

test("prompts for a name and saves the selected lineage nodes", async ({ mount }) => {
  let savedWorkflowSelection: { name: string; nodeIds: string[] } | null = null;
  const component = await mount(
    <div style={{ width: 800, height: 600 }}>
      <WorkflowView
        lineageGraph={lineageGraph}
        datasets={[dataset]}
        suggestedWorkflowName="Workflow 1"
        onSaveSelection={async (name, nodeIds) => {
          savedWorkflowSelection = { name, nodeIds };
        }}
      />
    </div>,
  );

  const saveButton = component.getByRole("button", { name: "Save as workflow" });
  await expect(saveButton).toBeDisabled();
  await component.locator(".workflow-node-operation").click();
  await expect(saveButton).toBeEnabled();

  await saveButton.click();
  const nameDialog = component.getByRole("dialog", { name: "Workflow name" });
  await expect(nameDialog).toBeVisible();
  const nameInput = nameDialog.getByLabel("Workflow name");
  await expect(nameInput).toHaveValue("Workflow 1");
  await nameInput.fill("Yield review");
  await nameDialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => savedWorkflowSelection).toEqual({
    name: "Yield review",
    nodeIds: ["table-1", "operation-1"],
  });
});
import { expect, test } from "@playwright/experimental-ct-react";

import { WorkflowRunHarness } from "../WorkflowRunHarness";
import type { DatasetMeta } from "../../src/types/data";
import type { ProjectLineageGraph, WorkflowDefinition } from "../../src/types/workflow";

const lineageGraph: ProjectLineageGraph = {
  id: "project-lineage",
  name: "Project lineage",
  graphVersion: 2,
  graphHash: "graph-hash",
  nodes: [],
  edges: [],
};

const workflow: WorkflowDefinition = {
  id: "workflow-determinism",
  name: "Deterministic yield",
  formatVersion: "1",
  revision: 1,
  inputSlots: [{
    id: "input-source",
    name: "Measurements",
    outputPort: { id: "input-source:out", name: "table", payloadKind: "table" },
    schemaContract: {
      schemaFingerprint: "schema-hash",
      columns: [{
        name: "yield",
        canonicalDuckdbType: "DOUBLE",
        required: true,
        requiredByOperationIds: ["operation-graph"],
      }],
    },
  }],
  operations: [{
    id: "operation-graph",
    kind: "graphGeneration",
    schemaVersion: "1",
    inputPorts: [{ id: "operation-graph:in", name: "source", payloadKind: "table" }],
    outputPorts: [{ id: "operation-graph:out", name: "result", payloadKind: "graph" }],
  }],
  edges: [{
    id: "input-graph",
    kind: "consumes",
    source: { nodeId: "input-source", portId: "input-source:out" },
    target: { nodeId: "operation-graph", portId: "operation-graph:in" },
  }],
  outputDeclarations: [{
    id: "output-graph",
    name: "Stable graph",
    inputPort: { id: "output-graph:in", name: "input", payloadKind: "graph" },
    outputPort: { id: "output-graph:out", name: "output", payloadKind: "graph" },
    sourceEndpoint: { nodeId: "operation-graph", portId: "operation-graph:out" },
    artifactKind: "graph",
  }],
};

const dataset: DatasetMeta = {
  id: "source-table",
  name: "Current measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 3,
  colCount: 1,
  generation: 0,
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};

test("reruns a saved workflow without replacing its visible definition", async ({ mount, page }) => {
  await page.evaluate(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string) => {
          if (command === "get_columns") return [["yield", "DOUBLE"]];
          if (command === "get_column_display_props") return [];
          throw new Error(`Unexpected command: ${command}`);
        },
        transformCallback: () => 1,
      },
    });
  });
  const component = await mount(
    <WorkflowRunHarness
      lineageGraph={lineageGraph}
      workflow={workflow}
      dataset={dataset}
      outcome="success"
    />,
  );

  await component.getByLabel("Measurements").selectOption(dataset.id);
  const runButton = component.getByRole("button", { name: "Run workflow" });
  await runButton.click();
  await expect(component.getByTestId("run-count")).toHaveText("1");
  await runButton.click();
  await expect(component.getByTestId("run-count")).toHaveText("2");
  await expect(component.getByRole("heading", { name: workflow.name })).toBeVisible();
  await expect(component.getByRole("status")).toContainText("Workflow completed");
});

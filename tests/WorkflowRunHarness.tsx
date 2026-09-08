import { useState } from "react";

import { WorkflowView } from "../src/components/workflow/WorkflowView";
import type { DatasetMeta } from "../src/types/data";
import type { ProjectLineageGraph, WorkflowDefinition } from "../src/types/workflow";

interface WorkflowRunHarnessProps {
  lineageGraph: ProjectLineageGraph;
  workflow: WorkflowDefinition;
  dataset: DatasetMeta;
  outcome: "success" | "failure";
}

export function WorkflowRunHarness({
  lineageGraph,
  workflow,
  dataset,
  outcome,
}: WorkflowRunHarnessProps) {
  const [runCount, setRunCount] = useState(0);
  return (
    <>
      <WorkflowView
        lineageGraph={lineageGraph}
        workflow={workflow}
        datasets={[dataset]}
        onRun={async () => {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
          if (outcome === "failure") throw new Error("Downstream analysis failed");
          setRunCount((count) => count + 1);
        }}
      />
      <span data-testid="run-count">{runCount}</span>
    </>
  );
}
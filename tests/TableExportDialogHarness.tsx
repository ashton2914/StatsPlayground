import { useState } from "react";

import { TableExportDialog } from "../src/components/tableExport";
import type { TableExportPlan } from "../src/components/tableExport/tableExportModel";

type ExportBehavior = "success" | "cancel" | "reject" | "pending";

const datasets = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "loose", name: "Loose" },
] as const;

const tableFolders = {
  a: "Batch/One",
  b: "Batch/Two",
  loose: "",
} as const;

export function TableExportDialogHarness({ behavior = "success" }: { behavior?: ExportBehavior }) {
  const [open, setOpen] = useState(true);
  const [closeCount, setCloseCount] = useState(0);
  const [exportCount, setExportCount] = useState(0);
  const [lastPlan, setLastPlan] = useState<TableExportPlan | null>(null);

  return (
    <div>
      {open ? (
        <TableExportDialog
          datasets={datasets}
          tableFolders={tableFolders}
          projectName="Issue 153 Project"
          onExport={async (plan) => {
            setExportCount((count) => count + 1);
            setLastPlan(plan);
            if (behavior === "cancel") {
              return false;
            }
            if (behavior === "reject") {
              throw new Error("Export failed");
            }
            if (behavior === "pending") {
              return new Promise<boolean>(() => {});
            }
            return true;
          }}
          onClose={() => {
            setCloseCount((count) => count + 1);
            setOpen(false);
          }}
        />
      ) : null}
      <output data-testid="close-count">{closeCount}</output>
      <output data-testid="export-count">{exportCount}</output>
      <output data-testid="last-plan">{lastPlan ? JSON.stringify(lastPlan) : "none"}</output>
    </div>
  );
}
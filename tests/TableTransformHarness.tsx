import { useState } from "react";

import { TableTransformView } from "../src/components/tableTransform/TableTransformView";
import type { DatasetMeta } from "../src/types/data";
import type {
  TableTransformBindingState,
  TableTransformDefinition,
} from "../src/types/tableTransform";

const datasets: DatasetMeta[] = [
  {
    id: "source-a",
    name: "Incoming A",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 10,
    colCount: 2,
    generation: 1,
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
  },
  {
    id: "source-b",
    name: "Incoming B",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 12,
    colCount: 2,
    generation: 2,
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
  },
  {
    id: "stable-output",
    name: "Sorted output",
    sourcePath: null,
    sourceType: "query",
    rowCount: 10,
    colCount: 2,
    generation: 4,
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
  },
];

const definition: TableTransformDefinition = {
  id: "transform-1",
  name: "Reusable sort",
  formatVersion: "1",
  revision: 1,
  operation: {
    kind: "sort",
    sortColumns: [{ column: "value", direction: "ascending" }],
  },
  inputSlots: [{
    role: "source",
    schemaContract: { schemaFingerprint: "schema", columns: [] },
  }],
  output: { tableDocumentId: "stable-output", name: "Sorted output" },
};

const blockedBinding: TableTransformBindingState = {
  definitionId: "transform-1",
  definitionRevision: 1,
  inputs: [{ role: "source", tableDocumentId: "source-a" }],
  outputGeneration: 4,
  lastRun: { definitionRevision: 1, status: "blocked" },
  schemaReports: [{
    role: "source",
    report: {
      missingColumns: [{
        columnName: "batch",
        expectedType: "VARCHAR",
        actualType: "missing",
        affectedOperationIds: ["table-transform"],
      }],
      typeMismatches: [],
      extraColumns: [],
    },
  }],
};

export function TableTransformHarness({ readOnly = false }: { readOnly?: boolean }) {
  const [rebind, setRebind] = useState("");
  const [reruns, setReruns] = useState(0);
  const [opened, setOpened] = useState(0);

  return (
    <>
      <TableTransformView
        definition={definition}
        binding={blockedBinding}
        datasets={datasets}
        readOnly={readOnly}
        onRebind={async (role, tableDocumentId) => { setRebind(`${role}:${tableDocumentId}`); }}
        onRerun={async () => { setReruns((value) => value + 1); }}
        onOpenOutput={() => setOpened((value) => value + 1)}
      />
      <output data-testid="rebind-call">{rebind}</output>
      <output data-testid="rerun-call">{reruns}</output>
      <output data-testid="open-call">{opened}</output>
    </>
  );
}

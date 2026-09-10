import { useEffect, useState } from "react";

import i18n from "../src/i18n";
import { ManageExtrasDialog } from "../src/components/ManageExtrasDialog";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import type { TableQueryResult } from "../src/types/data";

type ImportMode = "reordered" | "missingKey";

const DATASET = {
  id: "property-table",
  name: "Property table",
  sourcePath: null,
  sourceType: "manual" as const,
  rowCount: 1,
  colCount: 3,
  generation: 0,
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
};

function queryResult(mode: ImportMode): TableQueryResult {
  if (mode === "missingKey") {
    return {
      columns: ["_row_id", "ID", "Unit"],
      columnTypes: ["INTEGER", "INTEGER", "VARCHAR"],
      rows: [[1, 99, "mm"]],
      totalRows: 1,
      page: 0,
      pageSize: 100000,
    };
  }

  return {
    columns: ["_row_id", "ID", "Column name", "Unit"],
    columnTypes: ["INTEGER", "INTEGER", "VARCHAR", "VARCHAR"],
    rows: [[1, 99, "203-A1", "mm"]],
    totalRows: 1,
    page: 0,
    pageSize: 100000,
  };
}

export function ManageExtrasImportHarness({ mode }: { mode: ImportMode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousState = useDataStore.getState();
    const previousQueryTable = dataService.queryTable;
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    let active = true;

    useDataStore.setState({ datasets: [DATASET] });
    dataService.queryTable = async () => queryResult(mode);
    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.queryTable = previousQueryTable;
      useDataStore.setState(previousState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, [mode]);

  if (!ready) return null;

  return (
    <ManageExtrasDialog
      cols={["203-A1"]}
      colExtras={[{ unit: { value: "old" } }]}
      sourceDatasetName="Measurements"
      onApply={() => {}}
      onClose={() => {}}
    />
  );
}
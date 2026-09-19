import { useEffect, useRef, useState } from "react";

import { applicationRuntime } from "../src/applicationCommands/applicationRuntime";
import type { TabulateExportTableInput } from "../src/applicationCommands/types";
import { TabulateView } from "../src/components/tabulate/TabulateView";
import i18n from "../src/i18n";
import { tabulateService } from "../src/services/tabulateService";
import { useProjectStore } from "../src/stores/useProjectStore";
import { useTabulateStore } from "../src/stores/useTabulateStore";
import type { DatasetMeta } from "../src/types/data";
import type { TabulateItem, TabulateSessionRequest, TabulateSessionStatus, TabulateWindowRequest, TabulateWindowResult } from "../src/types/tabulate";

const ITEM: TabulateItem = {
  id: "tabulate-virtual", name: "Virtual summary", sourceDatasetId: "data",
  rowFields: ["Region", "Store"], columnFields: ["Category", "Product"],
  statistics: [{ id: "mean", field: "Sales", kind: "mean" }, { id: "count", field: "Sales", kind: "count" }],
  includeRowTotals: true, includeColumnTotals: true, createdAt: "2026-09-18T00:00:00Z",
};
const DATASET: DatasetMeta = {
  id: "data", name: "Measurements", sourcePath: null, sourceType: "manual", rowCount: 10_000_000,
  colCount: 5, generation: 7, createdAt: ITEM.createdAt, updatedAt: ITEM.createdAt,
};

export interface VirtualEvidence {
  prepares: TabulateSessionRequest[];
  windows: TabulateWindowRequest[];
  totals: string[];
  cancelled: string[];
  released: string[];
  legacy: number;
  activeTotals: number;
  maximumActiveTotals: number;
  exports: TabulateExportTableInput[];
}

export function TabulateVirtualHarness({
  mode = "ready", locale = "en", readOnly = false,
}: { mode?: "ready" | "delayed" | "resource" | "expiry" | "timeout" | "prepare" | "totals" | "totalsPressure" | "totalsError" | "latePrepare"; locale?: "en" | "zh-CN"; readOnly?: boolean }) {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState(1440);
  const [dataset, setDataset] = useState(DATASET);
  const [revision, setRevision] = useState(0);
  const pending = useRef<Array<() => void>>([]);
  const evidence = useRef<VirtualEvidence>({ prepares: [], windows: [], totals: [], cancelled: [], released: [], legacy: 0, activeTotals: 0, maximumActiveTotals: 0, exports: [] });
  const item = useTabulateStore((state) => state.items[0]);

  useEffect(() => {
    const services = { ...tabulateService };
    const execute = applicationRuntime.execute;
    const store = useTabulateStore.getState();
    const project = useProjectStore.getState();
    const language = i18n.language;
    const sessions = new Map<string, { request: TabulateSessionRequest; status: TabulateSessionStatus }>();
    let serial = 0;
    let refused = false;
    let expired = false;
    let timedOut = false;
    const changed = () => setRevision((value) => value + 1);
    void i18n.changeLanguage(locale);
    useProjectStore.setState({ readOnly: false, dirty: false });
    useTabulateStore.getState().loadFromProject([structuredClone(ITEM)]);
    useProjectStore.setState({ readOnly });
    applicationRuntime.execute = (async (command: { type: string; input: TabulateExportTableInput }) => {
      if (command.type === "table.describe") return { data: { columns: ["Region", "Store", "Category", "Product", "Sales"].map((colName, colIndex) => ({ colName, colIndex, colType: colName === "Sales" ? "DOUBLE" : "VARCHAR", format: { decimals: 2 } })) }, warnings: [] };
      if (command.type === "tabulate.exportTable") {
        evidence.current.exports.push(structuredClone(command.input));
        changed();
        return { data: { outputTable: null, reran: false }, warnings: [] };
      }
      evidence.current.legacy += 1;
      changed();
      throw new Error(`Unexpected Tabulate command: ${command.type}`);
    }) as typeof execute;
    tabulateService.prepare = async (request) => {
      evidence.current.prepares.push(structuredClone(request));
      changed();
      if (mode === "resource" && !refused) { refused = true; throw new Error("tabulate_member_index_budget"); }
      const status: TabulateSessionStatus = { sessionId: `session-${++serial}`, fingerprint: `fp-${serial}`, sourceGeneration: request.sourceGeneration,
        state: mode === "prepare" ? "preparing" : "ready", rowMemberCount: 1_000_000, columnMemberCount: 100_000,
        logicalCellCount: 200_000_000_000, measuredMemberIndexBytes: 1024 };
      sessions.set(status.sessionId, { request, status });
      if (mode === "latePrepare") await new Promise<void>((resolve) => pending.current.push(resolve));
      return status;
    };
    tabulateService.getStatus = async (sessionId) => ({ ...sessions.get(sessionId)!.status, state: "ready" });
    tabulateService.queryWindow = async (request) => {
      evidence.current.windows.push({ ...request });
      changed();
      if (mode === "expiry" && request.rowStart === 200 && !expired) { expired = true; throw new Error("tabulate_session_unavailable"); }
      if (mode === "timeout" && !timedOut) { timedOut = true; throw new Error("tabulate_query_timeout"); }
      const session = sessions.get(request.sessionId)!;
      const row = (index: number) => session.request.rowFields.map((_, depth) => depth === 0 ? `Region ${Math.floor(index / 100)}` : `Store ${index}`);
      const column = (index: number) => session.request.columnFields.map((_, depth) => depth === 0 ? `Category ${Math.floor(index / 100)}` : `Product ${index}`);
      const rowCount = Math.min(request.rowCount, 1_000_000 - request.rowStart);
      const columnCount = Math.min(request.columnCount, 100_000 - request.columnStart);
      const result: TabulateWindowResult = {
        ...request, fingerprint: session.status.fingerprint,
        rowMembers: Array.from({ length: rowCount }, (_, index) => row(request.rowStart + index)),
        columnMembers: Array.from({ length: columnCount }, (_, index) => column(request.columnStart + index)),
        rowMemberBefore: request.rowStart ? row(request.rowStart - 1) : null,
        rowMemberAfter: request.rowStart + rowCount < 1_000_000 ? row(request.rowStart + rowCount) : null,
        columnMemberBefore: request.columnStart ? column(request.columnStart - 1) : null,
        columnMemberAfter: request.columnStart + columnCount < 100_000 ? column(request.columnStart + columnCount) : null,
        statistics: session.request.statistics, cells: [{ rowIndex: 0, columnIndex: 0, statisticIndex: 0, value: request.rowStart + request.columnStart + request.sourceGeneration / 100 }],
        rowTotalsReady: false, columnTotalsReady: false, rowMemberCount: 1_000_000, columnMemberCount: 100_000,
      };
      if ((mode === "delayed" && request.rowStart === 100) || mode === "totalsError") await new Promise<void>((resolve) => pending.current.push(resolve));
      return result;
    };
    tabulateService.queryTotals = async (request) => {
      evidence.current.totals.push(request.totals.kind);
      if (mode === "totalsError") throw new Error("tabulate_query_timeout");
      evidence.current.activeTotals += 1;
      evidence.current.maximumActiveTotals = Math.max(evidence.current.maximumActiveTotals, evidence.current.activeTotals);
      changed();
      if (mode === "totals" || mode === "totalsPressure") await new Promise<void>((resolve) => pending.current.push(resolve));
      evidence.current.activeTotals -= 1;
      const count = request.totals.kind === "grand" ? 1 : request.totals.count;
      const values = Array.from({ length: count * 2 }, (_, index) => ({ memberIndex: Math.floor(index / 2), statisticIndex: index % 2, value: 9876 }));
      return { ...request, fingerprint: sessions.get(request.sessionId)!.status.fingerprint,
        rowTotals: request.totals.kind === "rows" ? values : [], columnTotals: request.totals.kind === "columns" ? values : [], grandTotals: request.totals.kind === "grand" ? [9876, 9876] : [] };
    };
    tabulateService.cancelRequest = async (requestId) => { evidence.current.cancelled.push(requestId); changed(); if (mode === "totalsPressure") throw new Error("cancel unavailable"); };
    tabulateService.release = async (sessionId) => { evidence.current.released.push(sessionId); changed(); };
    setReady(true);
    return () => {
      Object.assign(tabulateService, services);
      applicationRuntime.execute = execute;
      useTabulateStore.setState(store, true);
      useProjectStore.setState(project, true);
      void i18n.changeLanguage(language);
    };
  }, [locale, mode, readOnly]);

  return <div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button onClick={() => setWidth(1100)}>Resize</button>
      <button onClick={() => setDataset((value) => ({ ...value, generation: value.generation + 1 }))}>Generation</button>
      <button onClick={() => useTabulateStore.getState().updateItem(ITEM.id, { includeRowTotals: false })}>Definition</button>
      <button onClick={() => useTabulateStore.getState().loadFromProject([{ ...ITEM, id: "replacement" }])}>Replace</button>
      <button onClick={() => pending.current.splice(0).forEach((resolve) => resolve())}>Complete A</button>
      <button onClick={() => setVisible(false)}>Unmount</button>
      <button onClick={() => useTabulateStore.getState().reset()}>Reset project</button>
      <button onClick={() => useTabulateStore.getState().loadFromProject([structuredClone(ITEM)])}>Reopen project</button>
    </div>
    <output data-testid="evidence" style={{ display: "none" }} data-revision={revision}>{JSON.stringify(evidence.current)}</output>
    <output data-testid="definitions" style={{ display: "none" }}>{JSON.stringify(useTabulateStore.getState().items)}</output>
    <div data-testid="workspace" style={{ width: `min(${width}px, 100%)`, height: 640 }}>
      {ready && visible && item ? <TabulateView item={item} dataset={dataset} existingDatasetNames={[]} /> : null}
    </div>
  </div>;
}
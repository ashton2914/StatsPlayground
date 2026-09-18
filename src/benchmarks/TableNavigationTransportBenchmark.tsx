import { useEffect, useRef, useState } from "react";

import { TableViewportRows } from "@/components/table/TableViewportRows";
import { dataService } from "@/services/dataService";
import type {
  TableNavigationBenchmarkFixture,
  TableNavigationRequest,
  TableNavigationResult,
} from "@/types/data";

interface TransportBenchmarkRun {
  runIndex: number;
  warmup: boolean;
  requestId: string;
  targetStart: number;
  queryMs: number;
  diagnosticJsonEncodeMs: number | null;
  invokeWallMs: number;
  postBackendDeliveryMs: number | null;
  postReceiveJsonReparseMs: number;
  paintMs: number;
  diagnosticJsonBytes: number | null;
  selectedColumns: number;
  resultRows: number;
  markupLength: number;
  expectedCellText: string;
  verifiedCellText: string;
  renderedRows: number;
}

interface TransportBenchmarkPayload {
  userAgent: string;
  workload: {
    rows: number;
    columns: number;
    positionPercent: number;
    visibleRows: number;
    warmupRuns: number;
    measuredRuns: number;
  };
  methodology: {
    queryMs: string;
    diagnosticJsonEncodeMs: string;
    invokeWallMs: string;
    postBackendDeliveryMs: string;
    postReceiveJsonReparseMs: string;
    paintMs: string;
    diagnosticJsonBytes: string;
  };
  payloadSnapshot: TableNavigationResult | null;
  rawRuns: TransportBenchmarkRun[];
}

interface TransportBenchmarkFailure {
  userAgent: string;
  error: string;
}

interface BenchmarkViewState {
  fixture: TableNavigationBenchmarkFixture | null;
  payload: TableNavigationResult | null;
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = import.meta.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function currentEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function formatCellValue(value: unknown) {
  return value == null ? "" : String(value);
}

function waitForCellText(root: HTMLElement, selector: string, expectedText: string, timeoutMs = 5_000) {
  return new Promise<string>((resolve, reject) => {
    const startedAt = performance.now();
    const readMatch = () => {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) {
        return null;
      }
      const nextText = element.textContent ?? "";
      return nextText === expectedText ? nextText : null;
    };

    const immediate = readMatch();
    if (immediate !== null) {
      resolve(immediate);
      return;
    }

    const observer = new MutationObserver(() => {
      const nextText = readMatch();
      if (nextText !== null) {
        observer.disconnect();
        resolve(nextText);
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        observer.disconnect();
        reject(new Error(`timed out waiting for ${selector} to equal ${JSON.stringify(expectedText)}`));
      }
    });

    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    window.setTimeout(() => {
      const timeoutValue = readMatch();
      if (timeoutValue !== null) {
        observer.disconnect();
        resolve(timeoutValue);
        return;
      }
      observer.disconnect();
      reject(new Error(`timed out waiting for ${selector} to equal ${JSON.stringify(expectedText)}`));
    }, timeoutMs);
  });
}

function computeTargetStart(totalRows: number, positionPercent: number, backendVisibleRows: number): number {
  const maxStart = Math.max(0, totalRows - backendVisibleRows);
  if (maxStart === 0) {
    return 0;
  }
  return Math.round(maxStart * (positionPercent / 100));
}

function buildRequest(
  fixture: TableNavigationBenchmarkFixture,
  start: number,
  backendVisibleRows: number,
  runIndex: number,
): TableNavigationRequest {
  return {
    version: 1,
    requestId: `table-transport-run-${runIndex + 1}`,
    datasetId: fixture.datasetId,
    generation: fixture.generation,
    start,
    count: backendVisibleRows,
    columnIds: fixture.columnIds,
    sort: null,
    filters: [],
    includeTransportDiagnostics: true,
  };
}

async function postResults(payload: TransportBenchmarkPayload | TransportBenchmarkFailure): Promise<void> {
  const callbackUrl = import.meta.env.VITE_TABLE_NAVIGATION_TRANSPORT_BENCHMARK_CALLBACK;
  if (!callbackUrl) {
    throw new Error("VITE_TABLE_NAVIGATION_TRANSPORT_BENCHMARK_CALLBACK is required");
  }
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Result receiver returned ${response.status}`);
  }
}

export function TableNavigationTransportBenchmark() {
  const rows = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_ROWS", 10_000_000);
  const columns = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_COLUMNS", 20);
  const positionPercent = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_POSITION_PERCENT", 99);
  const warmupRuns = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_WARMUP", 5);
  const measuredRuns = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_ITERATIONS", 20);
  const paintedVisibleRows = readIntegerEnv("VITE_TABLE_NAVIGATION_TRANSPORT_VISIBLE_ROWS", 40);
  const backendVisibleRows = 500;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Preparing Tauri transport benchmark...");
  const [viewState, setViewState] = useState<BenchmarkViewState>({
    fixture: null,
    payload: null,
  });
  const [output, setOutput] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function runBenchmark() {
      const fixture = await dataService.prepareTableNavigationBenchmark({ rows, columns });
      if (cancelled) {
        return;
      }
      setViewState({ fixture, payload: null });
      const start = computeTargetStart(fixture.totalRows, positionPercent, backendVisibleRows);
      const rawRuns: TransportBenchmarkRun[] = [];
      let payloadSnapshot: TableNavigationResult | null = null;

      for (let runIndex = 0; runIndex < warmupRuns + measuredRuns; runIndex += 1) {
        if (cancelled) {
          return;
        }
        setStatus(`Running invoke ${runIndex + 1}/${warmupRuns + measuredRuns}...`);
        const request = buildRequest(fixture, start, backendVisibleRows, runIndex);
        const invokeStartedAt = performance.now();
        const result = await dataService.queryTableNavigationWindow(request);
        const invokeResolvedAt = performance.now();
        const invokeResolvedEpochMs = currentEpochMs();
        if (payloadSnapshot == null) {
          payloadSnapshot = structuredClone(result);
        }

        const jsonReparseStartedAt = performance.now();
        JSON.parse(JSON.stringify(result));
        const postReceiveJsonReparseMs = performance.now() - jsonReparseStartedAt;

        const expectedCellText = formatCellValue(result.rows[0]?.[0]);
        const cellSelector = `[data-row="${result.start}"][data-col="0"] .sp-val, [data-row="${result.start}"][data-col="0"] .sp-null`;
        const paintStartedAt = performance.now();
        setViewState({ fixture, payload: result });
        const host = hostRef.current;
        if (!host) {
          throw new Error("benchmark host missing");
        }
        const verifiedCellText = await waitForCellText(host, cellSelector, expectedCellText);
        await nextAnimationFrame();
        await nextAnimationFrame();
        const paintMs = performance.now() - paintStartedAt;

        rawRuns.push({
          runIndex,
          warmup: runIndex < warmupRuns,
          requestId: request.requestId,
          targetStart: result.start,
          queryMs: result.timings.totalMs,
          diagnosticJsonEncodeMs: result.timings.diagnosticJsonEncodeMs ?? null,
          invokeWallMs: Number((invokeResolvedAt - invokeStartedAt).toFixed(3)),
          postBackendDeliveryMs: result.timings.diagnosticResponseReadyAtEpochMs == null
            ? null
            : Number((invokeResolvedEpochMs - result.timings.diagnosticResponseReadyAtEpochMs).toFixed(3)),
          postReceiveJsonReparseMs: Number(postReceiveJsonReparseMs.toFixed(3)),
          paintMs: Number(paintMs.toFixed(3)),
          diagnosticJsonBytes: result.timings.diagnosticJsonBytes ?? null,
          selectedColumns: result.columns.length,
          resultRows: result.rows.length,
          markupLength: host.innerHTML.length,
          expectedCellText,
          verifiedCellText,
          renderedRows: Math.min(paintedVisibleRows, result.rows.length),
        });

        setOutput(JSON.stringify(rawRuns[rawRuns.length - 1], null, 2));
      }

      const payload: TransportBenchmarkPayload = {
        userAgent: navigator.userAgent,
        workload: {
          rows,
          columns,
          positionPercent,
          visibleRows: paintedVisibleRows,
          warmupRuns,
          measuredRuns,
        },
        methodology: {
          queryMs: "result.timings.totalMs from the real query_table_navigation_window invoke result",
          diagnosticJsonEncodeMs: "diagnostics-gated serde_json::to_vec(result) measured inside the Tauri command before return; proxy for backend JSON encoding, not raw Tauri serializer timing",
          invokeWallMs: "frontend performance.now from invoke start until the Promise resolved with a JS object",
          postBackendDeliveryMs: "frontend resolved wall-clock epoch minus backend diagnosticResponseReadyAtEpochMs; actual post-backend Tauri delivery window on one machine clock",
          postReceiveJsonReparseMs: "benchmark-only JSON.stringify/JSON.parse of the resolved result after receipt in WKWebView; post-receive proxy, not native bridge decode timing",
          paintMs: "TableViewportRows paint until the expected visible cell is verified plus two requestAnimationFrame ticks in the Tauri WebView",
          diagnosticJsonBytes: "diagnostics-gated JSON byte length of the returned response shape",
        },
        payloadSnapshot,
        rawRuns,
      };
      setOutput(JSON.stringify(payload, null, 2));
      setStatus("Posting benchmark results...");
      await postResults(payload);
      setStatus("Benchmark complete. The runner is writing artifacts.");
    }

    runBenchmark().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      setStatus(message);
      setOutput(JSON.stringify({ userAgent: navigator.userAgent, error: message }, null, 2));
      try {
        await postResults({ userAgent: navigator.userAgent, error: message });
      } catch (postError) {
        setStatus(`${message}\nUnable to report failure: ${String(postError)}`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [columns, measuredRuns, paintedVisibleRows, positionPercent, rows, warmupRuns]);

  const payload = viewState.payload;
  const visibleColIdxs = payload == null ? [] : payload.columns.map((_, index) => index);
  const slotCount = payload == null ? 0 : Math.min(paintedVisibleRows, payload.rows.length);

  return (
    <main style={{ height: "100vh", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) 220px", gap: 12, padding: 16, boxSizing: "border-box", fontFamily: "sans-serif" }}>
      <strong>{status}</strong>
      <div ref={hostRef} style={{ minWidth: 0, minHeight: 0, overflow: "auto" }}>
        {payload == null ? null : (
          <div className="sp-sheet-shell" style={{ padding: 16 }}>
            <table className="sp-sheet-table">
              <thead>
                <tr>
                  <th className="sp-row-hdr">#</th>
                  {payload.columns.map((columnName, columnIndex) => (
                    <th key={`${columnName}-${columnIndex}`} className="sp-col-hdr">
                      {columnName}
                    </th>
                  ))}
                  <th className="sp-add-col-cell" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                <TableViewportRows
                  totalRows={payload.totalRows}
                  slotCount={slotCount}
                  logicalStart={payload.start}
                  loadedWindowStart={payload.start}
                  loadedRows={payload.rows}
                  visibleColIdxs={visibleColIdxs}
                  colFormats={visibleColIdxs.map(() => null)}
                  formatCellValue={formatCellValue}
                  selectedRows={new Set<number>()}
                  activeRowRange={new Set<number>(payload.rows.length > 0 ? [payload.start] : [])}
                  activeCell={null}
                  editCell={null}
                  editValue=""
                  editInputRef={{ current: null }}
                  selectionRange={null}
                  selectedCellsByRow={null}
                  selectedCols={new Set<number>()}
                  visibleColumnStart={0}
                  visibleColumnEnd={visibleColIdxs.length}
                  leftSpacerW={0}
                  rightSpacerW={0}
                  onEditValueChange={() => {}}
                  onCommitEdit={() => {}}
                  onCancelEdit={() => {}}
                />
              </tbody>
            </table>
          </div>
        )}
      </div>
      <textarea readOnly value={output} aria-label="Table navigation transport benchmark JSON results" style={{ width: "100%", resize: "none", boxSizing: "border-box" }} />
    </main>
  );
}
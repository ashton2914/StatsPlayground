import "@fortawesome/fontawesome-free/css/all.min.css";
import "../src/i18n";
import "../src/index.css";
import "../src/App.css";

import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { TableViewportRows } from "../src/components/table/TableViewportRows";

interface TableNavigationPayload {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  start: number;
}

interface BrowserBenchmarkResult {
  decodeMs: number;
  paintMs: number;
  markupLength: number;
  expectedCellText: string;
  verifiedCellText: string;
  renderedRows: number;
}

declare global {
  interface Window {
    __tableTransportBenchmark?: (payloadText: string, visibleRows: number) => Promise<BrowserBenchmarkResult>;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("table transport benchmark root is missing");
}

const root: Root = createRoot(rootElement);

function formatCellValue(value: unknown) {
  return value == null ? "" : String(value);
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function waitForCellText(selector: string, expectedText: string, timeoutMs = 2_000) {
  return new Promise<string>((resolve, reject) => {
    const startedAt = performance.now();
    const readMatch = () => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        return null;
      }
      return (element.textContent ?? "") === expectedText ? (element.textContent ?? "") : null;
    };

    const matchedText = readMatch();
    if (matchedText !== null) {
      resolve(matchedText);
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

    observer.observe(rootElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    window.setTimeout(() => {
      const timeoutText = readMatch();
      if (timeoutText !== null) {
        observer.disconnect();
        resolve(timeoutText);
        return;
      }
      observer.disconnect();
      reject(new Error(`timed out waiting for ${selector} to equal ${JSON.stringify(expectedText)}`));
    }, timeoutMs);
  });
}

function renderTable(payload: TableNavigationPayload, visibleRows: number) {
  const visibleColIdxs = payload.columns.map((_, index) => index);
  const slotCount = Math.min(visibleRows, payload.rows.length);

  return (
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
  );
}

window.__tableTransportBenchmark = async (payloadText, visibleRows) => {
  const decodeStartedAt = performance.now();
  const payload = JSON.parse(payloadText) as TableNavigationPayload;
  const decodeMs = performance.now() - decodeStartedAt;

  const firstRenderedRow = payload.start;
  const firstRenderedColumn = 0;
  const expectedCellText = formatCellValue(payload.rows[0]?.[firstRenderedColumn]);
  const cellSelector = `[data-row="${firstRenderedRow}"][data-col="${firstRenderedColumn}"] .sp-val, [data-row="${firstRenderedRow}"][data-col="${firstRenderedColumn}"] .sp-null`;

  const paintStartedAt = performance.now();
  root.render(renderTable(payload, visibleRows));
  const verifiedCellText = await waitForCellText(cellSelector, expectedCellText);
  await nextAnimationFrame();
  await nextAnimationFrame();
  const paintMs = performance.now() - paintStartedAt;

  return {
    decodeMs: Number(decodeMs.toFixed(3)),
    paintMs: Number(paintMs.toFixed(3)),
    markupLength: rootElement.innerHTML.length,
    expectedCellText,
    verifiedCellText,
    renderedRows: Math.min(visibleRows, payload.rows.length),
  };
};
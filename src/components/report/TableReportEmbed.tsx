import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { dataService } from "@/services/dataService";
import type { TableWindowResult } from "@/types/data";

import type { ReportResolvedSource } from "./ReportEmbed";

const DEFAULT_ROW_LIMIT = 20;
const DEFAULT_COLUMN_LIMIT = 8;

export interface TableReportEmbedRuntime {
  getDatasetGeneration?: (datasetId: string) => Promise<number>;
  queryTableWindow?: typeof dataService.queryTableWindow;
  rowLimit?: number;
  columnLimit?: number;
}

export function TableReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "table" }>;
  runtime?: TableReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "success"; result: TableWindowResult }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const getDatasetGeneration = runtime?.getDatasetGeneration ?? dataService.getDatasetGeneration;
    const queryTableWindow = runtime?.queryTableWindow ?? dataService.queryTableWindow;
    const rowLimit = runtime?.rowLimit ?? DEFAULT_ROW_LIMIT;

    setState({ status: "loading" });

    void (async () => {
      try {
        const generation = await getDatasetGeneration(source.dataset.id);
        const result = await queryTableWindow({
          datasetId: source.dataset.id,
          start: 0,
          count: rowLimit,
          sort: null,
          filters: [],
          generation,
        });
        if (!cancelled) {
          setState({ status: "success", result });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtime?.getDatasetGeneration, runtime?.queryTableWindow, runtime?.rowLimit, source.dataset.id]);

  if (state.status === "loading") {
    return <div className="sp-report-embed-card sp-report-embed-loading">{t("common.loading")}</div>;
  }

  if (state.status === "error") {
    return <div className="sp-report-embed-error">{t("report.embedError", { kind: t("report.group.table"), name: source.name, message: state.error })}</div>;
  }

  const columnLimit = runtime?.columnLimit ?? DEFAULT_COLUMN_LIMIT;
  const visibleColumns = state.result.columns.slice(0, columnLimit);

  return (
    <section className="sp-report-embed-card" data-kind="table">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div className="sp-report-embed-table-wrap">
        <table className="sp-report-embed-table" aria-label={source.name}>
          <thead>
            <tr>
              {visibleColumns.map((column) => (
                <th key={column} scope="col">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.result.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {visibleColumns.map((_, columnIndex) => (
                  <td key={`cell-${rowIndex}-${columnIndex}`}>{formatCell(row[columnIndex])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatCell(value: unknown): string {
  if (value == null) {
    return "—";
  }
  return String(value);
}
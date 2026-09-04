import type { ReactNode } from "react";

import { AnalysisFrame } from "./AnalysisFrame";

export type AnalysisTableWidth = "compact" | "standard" | "wide";

export interface AnalysisTableColumn {
  key: string;
  label: ReactNode;
  numeric?: boolean;
}

export interface AnalysisTableRow {
  key: string;
  cells: ReactNode[];
}

interface AnalysisTableProps {
  title: ReactNode;
  columns: AnalysisTableColumn[];
  rows: AnalysisTableRow[];
  width?: AnalysisTableWidth;
  ariaLabel?: string;
}

export function AnalysisTable({
  title,
  columns,
  rows,
  width = "standard",
  ariaLabel,
}: AnalysisTableProps) {
  return (
    <div className={`analysis-ui-table analysis-ui-table-${width}`}>
      <AnalysisFrame title={title}>
        <div className="analysis-ui-table-scroll">
          <table aria-label={ariaLabel}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th className={column.numeric ? "analysis-ui-table-numeric" : undefined} key={column.key} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {columns.map((column, index) => (
                    <td className={column.numeric ? "analysis-ui-table-numeric" : undefined} key={column.key}>
                      {row.cells[index]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AnalysisFrame>
    </div>
  );
}
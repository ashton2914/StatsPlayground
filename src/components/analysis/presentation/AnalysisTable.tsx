import type { ReactNode } from "react";

import { AnalysisFrame } from "./AnalysisFrame";
import { AnalysisButton, type AnalysisButtonTone } from "./AnalysisButton";

export type AnalysisTableWidth = "compact" | "standard" | "wide";

export interface AnalysisTableColumn {
  key: string;
  label: ReactNode;
  numeric?: boolean;
  rowHeader?: boolean;
}

export interface AnalysisTableRow {
  key: string;
  cells: ReactNode[];
}

export interface AnalysisTableSelection {
  selectedRowKeys: ReadonlySet<string>;
  onToggle: (rowKey: string, checked: boolean) => void;
  isDisabled?: (row: AnalysisTableRow) => boolean;
  getLabel: (row: AnalysisTableRow) => string;
}

export interface AnalysisTableRowAction {
  key: string;
  label: string;
  onInvoke: () => void;
  disabled?: boolean;
  tone?: AnalysisButtonTone;
}

interface AnalysisTableProps {
  title: ReactNode;
  columns: AnalysisTableColumn[];
  rows: AnalysisTableRow[];
  width?: AnalysisTableWidth;
  ariaLabel?: string;
  selection?: AnalysisTableSelection;
  getRowActions?: (row: AnalysisTableRow) => AnalysisTableRowAction[];
}

export function AnalysisTable({
  title,
  columns,
  rows,
  width = "standard",
  ariaLabel,
  selection,
  getRowActions,
}: AnalysisTableProps) {
  return (
    <div className={`analysis-ui-table analysis-ui-table-${width}`}>
      <AnalysisFrame title={title} contentPadding="none">
        <div className="analysis-ui-table-scroll">
          <table aria-label={ariaLabel}>
            <thead>
              <tr>
                {selection && <th className="analysis-ui-table-selection" scope="col" aria-label="Selection" />}
                {columns.map((column) => (
                  <th className={column.numeric ? "analysis-ui-table-numeric" : undefined} key={column.key} scope="col">
                    {column.label}
                  </th>
                ))}
                {getRowActions && <th className="analysis-ui-table-actions" scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {selection && (
                    <td className="analysis-ui-table-selection">
                      <input
                        type="checkbox"
                        aria-label={selection.getLabel(row)}
                        checked={selection.selectedRowKeys.has(row.key)}
                        disabled={selection.isDisabled?.(row)}
                        onChange={(event) => selection.onToggle(row.key, event.currentTarget.checked)}
                      />
                    </td>
                  )}
                  {columns.map((column, index) => column.rowHeader ? (
                    <th
                      className={column.numeric ? "analysis-ui-table-numeric" : undefined}
                      key={column.key}
                      scope="row"
                    >
                      {row.cells[index]}
                    </th>
                  ) : (
                    <td className={column.numeric ? "analysis-ui-table-numeric" : undefined} key={column.key}>
                      {row.cells[index]}
                    </td>
                  ))}
                  {getRowActions && (
                    <td className="analysis-ui-table-actions">
                      {getRowActions(row).map((action) => (
                        <AnalysisButton
                          key={action.key}
                          tone={action.tone}
                          disabled={action.disabled}
                          onClick={action.onInvoke}
                        >
                          {action.label}
                        </AnalysisButton>
                      ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AnalysisFrame>
    </div>
  );
}
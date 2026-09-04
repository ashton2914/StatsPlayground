import type { ComponentPropsWithoutRef, ReactNode } from "react";

import "./statisticalTable.css";

export type StatisticalTableWidth = "compact" | "standard" | "wide";

export interface StatisticalTableColumn {
  key: string;
  label: ReactNode;
  numeric?: boolean;
}

export interface StatisticalTableRow {
  key: string;
  cells: ReactNode[];
}

interface StatisticalSectionProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "className" | "style" | "title"> {
  title: ReactNode;
  children: ReactNode;
}

interface StatisticalTableListProps {
  children: ReactNode;
}

interface StatisticalTableFrameProps {
  title: ReactNode;
  columns: StatisticalTableColumn[];
  rows: StatisticalTableRow[];
  width?: StatisticalTableWidth;
  ariaLabel?: string;
}

export function StatisticalSection({ title, children, ...sectionProps }: StatisticalSectionProps) {
  return (
    <section className="sp-stat-section" {...sectionProps}>
      <div className="sp-stat-section-title">{title}</div>
      <div className="sp-stat-section-body">{children}</div>
    </section>
  );
}

export function StatisticalTableList({ children }: StatisticalTableListProps) {
  return <div className="sp-stat-table-list">{children}</div>;
}

export function StatisticalTableFrame({
  title,
  columns,
  rows,
  width = "standard",
  ariaLabel,
}: StatisticalTableFrameProps) {
  return (
    <section className={`sp-stat-table-frame sp-stat-table-frame-${width}`}>
      <h3 className="sp-stat-table-frame-title">{title}</h3>
      <div className="sp-stat-table-scroll">
        <table className="sp-stat-table" aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th className={column.numeric ? "sp-stat-table-cell-numeric" : undefined} key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {columns.map((column, index) => (
                  <td className={column.numeric ? "sp-stat-table-cell-numeric" : undefined} key={column.key}>
                    {row.cells[index]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
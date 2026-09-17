import { useTranslation } from "react-i18next";

interface TableShapeSummaryProps {
  totalRows: number;
  totalColumns: number;
  displayedRows: number;
  filtered: boolean;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

export function TableShapeSummary({
  totalRows,
  totalColumns,
  displayedRows,
  filtered,
}: TableShapeSummaryProps) {
  const { t } = useTranslation();

  return (
    <section className="sp-table-shape-summary" aria-label={t("dataTable.tableSummary")}>
      <div className="sp-table-shape-title">{t("dataTable.tableSummary")}</div>
      <div className="sp-table-shape-row">
        <span className="sp-table-shape-label">{t("dataTable.totalRows")}</span>
        <span className="sp-table-shape-value">{formatCount(totalRows)}</span>
      </div>
      <div className="sp-table-shape-row">
        <span className="sp-table-shape-label">{t("dataTable.totalColumns")}</span>
        <span className="sp-table-shape-value">{formatCount(totalColumns)}</span>
      </div>
      {filtered && (
        <div className="sp-table-shape-row">
          <span className="sp-table-shape-label">{t("dataTable.displayedRows")}</span>
          <span className="sp-table-shape-value">{formatCount(displayedRows)}</span>
        </div>
      )}
    </section>
  );
}
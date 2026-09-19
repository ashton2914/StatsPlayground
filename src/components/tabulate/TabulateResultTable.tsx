import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import type { ColumnDisplayProps } from "@/types/data";
import type { TabulateItem, TabulateStatistic } from "@/types/tabulate";

import type { TabulateFieldInfo } from "./TabulateFieldList";
import { formatStatisticLabel } from "./TabulateStatisticEditor";
import { buildVisibleHeaderSpans } from "./tabulateViewport";
import type { TabulateSessionController } from "./useTabulateSession";

interface TabulateResultTableProps {
  item: TabulateItem;
  session: TabulateSessionController;
  fieldsByName: ReadonlyMap<string, TabulateFieldInfo>;
  displayPropsByField: ReadonlyMap<string, ColumnDisplayProps | undefined>;
  visibleRowDepth: number;
  visibleColumnDepth: number;
  onVisibleRowDepthChange: (depth: number) => void;
  onVisibleColumnDepthChange: (depth: number) => void;
  onExport: () => void;
  exporting: boolean;
  exportDisabled: boolean;
  presentation?: "interactive" | "readOnly";
}

const ROW_LABEL_WIDTH = 148;
const STATISTIC_WIDTH = 104;
const ROW_HEIGHT = 30;

export function TabulateResultTable({ item, session, fieldsByName, displayPropsByField, visibleRowDepth, visibleColumnDepth,
  onVisibleRowDepthChange, onVisibleColumnDepthChange, onExport, exporting, exportDisabled, presentation = "interactive" }: TabulateResultTableProps) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [rowLabelWidth, setRowLabelWidth] = useState(ROW_LABEL_WIDTH);
  const navigation = useRef(session);
  navigation.current = session;
  const rowDepth = Math.max(1, visibleRowDepth);
  const headerRows = visibleColumnDepth + 1;
  const statisticCount = item.statistics.length;
  const tile = session.tile;
  const range = session.range;
  const rowCount = range?.rowCount ?? 0;
  const columnCount = range?.columnCount ?? 0;
  const rowStart = range?.rowStart ?? 0;
  const columnStart = range?.columnStart ?? 0;
  const rowMembers = tile?.rowMembers ?? [];
  const columnMembers = tile?.columnMembers ?? [];
  const rows = tile ? buildVisibleHeaderSpans(rowMembers, { before: tile.rowMemberBefore, after: tile.rowMemberAfter }) : [];
  const columns = tile ? buildVisibleHeaderSpans(columnMembers, { before: tile.columnMemberBefore, after: tile.columnMemberAfter }) : [];
  const sparse = new Map(tile?.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}:${cell.statisticIndex}`, cell.value]));
  const rowTotals = new Map(session.totals.rows?.rowTotals.map((cell) => [`${cell.memberIndex}:${cell.statisticIndex}`, cell.value]));
  const columnTotals = new Map(session.totals.columns?.columnTotals.map((cell) => [`${cell.memberIndex}:${cell.statisticIndex}`, cell.value]));
  const valueLabel = (value: number | null | undefined, statistic: TabulateStatistic) => formatValue(value, statistic, displayPropsByField.get(statistic.field), fieldsByName.get(statistic.field));
  const loading = session.phase === "preparing" || session.phase === "loading";
  const exportLabel = exporting ? t("tabulate.exportingTable") : t("tabulate.exportTable");

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const labelWidth = Math.max(64, Math.min(ROW_LABEL_WIDTH, Math.floor((element.clientWidth - 2 * STATISTIC_WIDTH) / rowDepth)));
      setRowLabelWidth(labelWidth);
      const totalsWidth = item.includeRowTotals ? statisticCount * STATISTIC_WIDTH : 0;
      navigation.current.resize(Math.max(1, Math.ceil((element.clientHeight - headerRows * ROW_HEIGHT - (item.includeColumnTotals ? ROW_HEIGHT : 0)) / ROW_HEIGHT)) + 2,
        Math.max(1, Math.ceil((element.clientWidth - rowDepth * labelWidth - totalsWidth) / (statisticCount * STATISTIC_WIDTH))) + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [headerRows, rowDepth, statisticCount, item.includeRowTotals, item.includeColumnTotals]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = navigation.current;
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
      const vertical = event.shiftKey ? 0 : event.deltaY;
      current.navigate(current.position.rowStart + Math.sign(vertical) * Math.ceil(Math.abs(vertical) / ROW_HEIGHT),
        current.position.columnStart + Math.sign(horizontal) * Math.ceil(Math.abs(horizontal) / STATISTIC_WIDTH));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  return <div className="sp-tabulate-results-shell">
    {presentation === "interactive" ? <div className="sp-tabulate-results-toolbar">
      <DepthControl label={t("tabulate.visibleRows")} depth={visibleRowDepth} maxDepth={item.rowFields.length} onChange={onVisibleRowDepthChange} />
      <DepthControl label={t("tabulate.visibleColumns")} depth={visibleColumnDepth} maxDepth={item.columnFields.length} onChange={onVisibleColumnDepthChange} />
      <button type="button" className="sp-tabulate-inline-button sp-tabulate-export-button" onClick={onExport} disabled={exportDisabled} title={exportLabel} aria-label={exportLabel} aria-busy={exporting}>
        <i className="fa-solid fa-table-arrow-up" aria-hidden="true" /><span>{exportLabel}</span>
      </button>
    </div> : null}
    <div className="sp-tabulate-session-status" role="status" aria-live="polite">
      <span>{session.errorKey ? t(`tabulate.${session.errorKey}`) : session.phase === "preparing" ? t("tabulate.preparingIndexes") : session.phase === "loading" ? t("tabulate.loadingVisibleCells") : session.loadingTotals ? t("tabulate.loadingTotals") : ""}
        {session.errorKey === "memberIndexBudget" || session.errorKey === "queryTimeout" ? ` ${t("tabulate.highCardinalityGuidance")}` : ""}</span>
      {loading || session.loadingTotals ? <button type="button" className="sp-tabulate-inline-button" onClick={session.cancel} title={t("common.cancel")} aria-label={t("common.cancel")}><i className="fa-solid fa-xmark" aria-hidden="true" /></button> : null}
      {session.errorKey ? <button type="button" className="sp-tabulate-inline-button" onClick={session.retry} title={t("tabulate.retry")} aria-label={t("tabulate.retry")}><i className="fa-solid fa-rotate-right" aria-hidden="true" /><span>{t("tabulate.retry")}</span></button> : null}
    </div>
    <div className="sp-tabulate-virtual-viewport" ref={viewport}>
      <div role="grid" aria-label={t("tabulate.gridLabel")} aria-readonly="true" aria-busy={loading}
        aria-rowcount={(session.status?.rowMemberCount ?? 0) + headerRows + Number(item.includeColumnTotals)}
        aria-colcount={rowDepth + (session.status?.columnMemberCount ?? 0) * statisticCount + (item.includeRowTotals ? statisticCount : 0)}
        className="sp-tabulate-virtual-grid" tabIndex={0}
        style={{ gridTemplateColumns: `repeat(${rowDepth}, ${rowLabelWidth}px) repeat(${Math.max(1, columnCount * statisticCount + (item.includeRowTotals ? statisticCount : 0))}, ${STATISTIC_WIDTH}px)`, gridTemplateRows: `repeat(${headerRows + rowCount + Number(item.includeColumnTotals)}, ${ROW_HEIGHT}px)` }}
        onKeyDown={(event) => {
          let nextRow = rowStart;
          let nextColumn = columnStart;
          if (event.key === "ArrowDown") nextRow += 1;
          else if (event.key === "ArrowUp") nextRow -= 1;
          else if (event.key === "ArrowRight") nextColumn += 1;
          else if (event.key === "ArrowLeft") nextColumn -= 1;
          else if (event.key === "PageDown") nextRow += Math.max(1, rowCount - 2);
          else if (event.key === "PageUp") nextRow -= Math.max(1, rowCount - 2);
          else if (event.key === "Home") { nextColumn = 0; if (event.ctrlKey || event.metaKey) nextRow = 0; }
          else if (event.key === "End") { nextColumn = (session.status?.columnMemberCount ?? 1) - 1; if (event.ctrlKey || event.metaKey) nextRow = (session.status?.rowMemberCount ?? 1) - 1; }
          else return;
          event.preventDefault();
          session.navigate(nextRow, nextColumn);
        }}>
        {Array.from({ length: headerRows }, (_, level) => <div role="row" aria-rowindex={level + 1} key={`header-${level}`} className="sp-tabulate-virtual-row">
          {level === 0 ? Array.from({ length: rowDepth }, (_, depth) => <div role="columnheader" aria-rowspan={headerRows} aria-colindex={depth + 1} key={depth} className="sp-tabulate-corner-header sp-tabulate-virtual-cell" style={{ gridRow: `1 / span ${headerRows}`, gridColumn: depth + 1, left: depth * rowLabelWidth }}>{item.rowFields[depth] ?? t("tabulate.rows")}</div>) : null}
          {columns.filter((span) => span.level === level).map((span) => <div role="columnheader" key={`${span.level}:${span.start}`} aria-colspan={span.span * statisticCount}
            aria-colindex={rowDepth + (columnStart + span.start) * statisticCount + 1} data-continues-before={span.continuesBefore} data-continues-after={span.continuesAfter}
            className="sp-tabulate-group-header sp-tabulate-virtual-cell" style={{ gridRow: level + 1, gridColumn: `${rowDepth + span.start * statisticCount + 1} / span ${span.span * statisticCount}`, top: level * ROW_HEIGHT }} title={formatMemberLabel(span.label)}>{formatMemberLabel(span.label)}</div>)}
          {level === headerRows - 1 ? Array.from({ length: columnCount }, (_, column) => item.statistics.map((statistic, index) => <div role="columnheader" key={`${column}:${statistic.id}`} className="sp-tabulate-stat-header sp-tabulate-virtual-cell"
            aria-colindex={rowDepth + (columnStart + column) * statisticCount + index + 1}
            style={{ gridRow: headerRows, gridColumn: rowDepth + column * statisticCount + index + 1, top: level * ROW_HEIGHT }} title={buildStatisticHeaderTitle(columnMembers[column] ?? [], statistic)}>{formatStatisticLabel(statistic)}<span className="sp-tabulate-stat-field">{statistic.field}</span></div>)) : null}
          {item.includeRowTotals && level === 0 ? <div role="columnheader" aria-colspan={statisticCount} aria-rowspan={headerRows} className="sp-tabulate-total-header sp-tabulate-virtual-cell" style={{ gridRow: `1 / span ${headerRows}`, gridColumn: `${rowDepth + columnCount * statisticCount + 1} / span ${statisticCount}` }}>{t("tabulate.total")}</div> : null}
        </div>)}
        {Array.from({ length: rowCount }, (_, row) => <div role="row" aria-rowindex={headerRows + rowStart + row + 1} key={`row-${rowStart + row}`} className="sp-tabulate-virtual-row">
          {visibleRowDepth === 0 ? <div role="rowheader" className="sp-tabulate-row-label sp-tabulate-virtual-cell" style={{ gridRow: headerRows + row + 1, gridColumn: 1, left: 0 }}>{t("tabulate.allRows")}</div> : rows.filter((span) => span.start === row).map((span) => <div role="rowheader" aria-rowspan={span.span} aria-colindex={span.level + 1} key={span.level}
            data-continues-before={span.continuesBefore} data-continues-after={span.continuesAfter} className="sp-tabulate-row-label sp-tabulate-virtual-cell"
            style={{ gridRow: `${headerRows + row + 1} / span ${span.span}`, gridColumn: span.level + 1, left: span.level * rowLabelWidth }} title={formatMemberLabel(span.label)}>{formatMemberLabel(span.label)}</div>)}
          {Array.from({ length: columnCount }, (_, column) => item.statistics.map((statistic, index) => {
            const address = `${row}:${column}:${index}`;
            const value = sparse.has(address) ? sparse.get(address) : ["count", "missingCount", "uniqueCount"].includes(statistic.kind) ? 0 : null;
            return <div role="gridcell" key={`${column}:${statistic.id}`} aria-colindex={rowDepth + (columnStart + column) * statisticCount + index + 1}
              data-tabulate-cell={tile ? `${rowStart + row}:${columnStart + column}:${index}` : undefined} aria-busy={!tile}
              className="sp-tabulate-virtual-cell sp-tabulate-value-cell" style={{ gridRow: headerRows + row + 1, gridColumn: rowDepth + column * statisticCount + index + 1 }}>{tile ? valueLabel(value, statistic) : "..."}</div>;
          }))}
          {item.includeRowTotals ? item.statistics.map((statistic, index) => <div role="gridcell" key={`total-${index}`} className="sp-tabulate-total-cell sp-tabulate-virtual-cell" aria-busy={!session.totals.rows}
            style={{ gridRow: headerRows + row + 1, gridColumn: rowDepth + columnCount * statisticCount + index + 1 }}>{session.totals.rows ? valueLabel(rowTotals.get(`${row}:${index}`), statistic) : "..."}</div>) : null}
        </div>)}
        {item.includeColumnTotals ? <div role="row" aria-rowindex={(session.status?.rowMemberCount ?? 0) + headerRows + 1} className="sp-tabulate-virtual-row">
          <div role="rowheader" className="sp-tabulate-total-cell sp-tabulate-virtual-cell" style={{ gridRow: headerRows + rowCount + 1, gridColumn: `1 / span ${rowDepth}` }}>{t("tabulate.total")}</div>
          {Array.from({ length: columnCount }, (_, column) => item.statistics.map((statistic, index) => <div role="gridcell" key={`${column}:${index}`} className="sp-tabulate-total-cell sp-tabulate-virtual-cell" aria-busy={!session.totals.columns}
            style={{ gridRow: headerRows + rowCount + 1, gridColumn: rowDepth + column * statisticCount + index + 1 }}>{session.totals.columns ? valueLabel(columnTotals.get(`${column}:${index}`), statistic) : "..."}</div>))}
          {item.includeRowTotals ? item.statistics.map((statistic, index) => <div role="gridcell" key={`grand-${index}`} className="sp-tabulate-total-cell sp-tabulate-virtual-cell" aria-busy={!session.totals.grand}
            style={{ gridRow: headerRows + rowCount + 1, gridColumn: rowDepth + columnCount * statisticCount + index + 1 }}>{session.totals.grand ? valueLabel(session.totals.grand.grandTotals[index], statistic) : "..."}</div>) : null}
        </div> : null}
      </div>
    </div>
    <div className="sp-tabulate-logical-navigation">
      {(["row", "column"] as const).map((axis) => {
        const start = axis === "row" ? rowStart : columnStart;
        const count = (axis === "row" ? session.status?.rowMemberCount : session.status?.columnMemberCount) ?? 0;
        const label = t(axis === "row" ? "tabulate.rowPosition" : "tabulate.columnPosition");
        const move = (value: number) => session.navigate(axis === "row" ? value : rowStart, axis === "column" ? value : columnStart);
        return <div className="sp-tabulate-axis-navigation" key={axis}>
          <label><span>{label}</span><input type="number" aria-label={label} key={`${axis}:${start}`} defaultValue={start + 1} min={1} max={Math.max(1, count)} disabled={!count}
            onBlur={(event) => move(Number(event.currentTarget.value) - 1)} onKeyDown={(event) => { if (event.key === "Enter") move(Number(event.currentTarget.value) - 1); }} /></label>
          <span className="sp-tabulate-member-count">/ {count.toLocaleString()}</span>
          <input type="range" role="scrollbar" aria-label={label} aria-orientation={axis === "row" ? "vertical" : "horizontal"} aria-valuemin={1} aria-valuemax={Math.max(1, count)} aria-valuenow={start + 1}
            min={0} max={Math.max(0, count - 1)} value={start} disabled={!count} onChange={(event) => move(Number(event.target.value))} />
        </div>;
      })}
    </div>
  </div>;
}

function DepthControl({
  label,
  depth,
  maxDepth,
  onChange,
}: {
  label: string;
  depth: number;
  maxDepth: number;
  onChange: (depth: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="sp-tabulate-depth-control">
      <span>{label}</span>
      <select value={depth} onChange={(event) => onChange(Number(event.target.value))}>
        {Array.from({ length: maxDepth + 1 }, (_, index) => index).map((value) => (
          <option key={value} value={value}>
            {value === 0 ? t("tabulate.none") : t("tabulate.visibleDepth", { value, max: maxDepth })}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildStatisticHeaderTitle(member: ReadonlyArray<unknown>, statistic: TabulateStatistic): string {
  const labels = member.map(formatMemberLabel).filter(Boolean);
  const statisticLabel = formatStatisticLabel(statistic);
  if (labels.length === 0) {
    return `${statisticLabel} · ${statistic.field}`;
  }
  return `${labels.join(" / ")} · ${statisticLabel} · ${statistic.field}`;
}

function formatMemberLabel(value: unknown): string {
  if (value == null) {
    return formatMissingLabel();
  }
  return String(value);
}

function formatMissingLabel(): string {
  return i18n.t("tabulate.missing");
}

function formatValue(
  value: number | null | undefined,
  statistic: TabulateStatistic,
  displayProps: ColumnDisplayProps | undefined,
  field: TabulateFieldInfo | undefined,
): string {
  if (value == null) {
    return "—";
  }

  if (
    statistic.kind === "count"
    || statistic.kind === "missingCount"
    || statistic.kind === "uniqueCount"
  ) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }

  if (
    statistic.kind === "rowPercentage"
    || statistic.kind === "columnPercentage"
    || statistic.kind === "totalPercentage"
  ) {
    const decimals = displayProps?.format?.decimals ?? 1;
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }

  const format = displayProps?.format;
  if (format?.kind === "currency") {
    const decimals = format.decimals ?? 2;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: format.currency ?? "USD",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }

  if (format?.kind === "scientific") {
    return value.toExponential();
  }

  if (format?.kind === "fixed") {
    const decimals = format.decimals ?? 2;
    return value.toFixed(decimals);
  }

  if (format?.kind === "percent") {
    const decimals = format.decimals ?? 1;
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }

  if (field?.numeric) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
  }

  return String(value);
}
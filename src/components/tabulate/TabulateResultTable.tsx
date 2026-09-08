import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import type { ColumnDisplayProps } from "@/types/data";
import type { TabulateItem, TabulateResult, TabulateStatistic } from "@/types/tabulate";

import type { TabulateFieldInfo } from "./TabulateFieldList";
import { formatStatisticLabel } from "./TabulateStatisticEditor";
import { buildHeaderSpans, cellIndex, totalIndex } from "./tabulateResult";

interface TabulateResultTableProps {
  item: TabulateItem;
  result: TabulateResult;
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

interface HeaderCellSpan {
  label: unknown;
  start: number;
  span: number;
}

const ROW_LABEL_WIDTH = 148;

export function TabulateResultTable({
  item,
  result,
  fieldsByName,
  displayPropsByField,
  visibleRowDepth,
  visibleColumnDepth,
  onVisibleRowDepthChange,
  onVisibleColumnDepthChange,
  onExport,
  exporting,
  exportDisabled,
  presentation = "interactive",
}: TabulateResultTableProps) {
  const { t } = useTranslation();
  const visibleRowFields = item.rowFields.slice(0, visibleRowDepth);
  const visibleColumnFields = item.columnFields.slice(0, visibleColumnDepth);
  const rowHeaderLabels = visibleRowFields.length > 0 ? visibleRowFields : [t("tabulate.rows")];
  const columnMembers = result.columnMembers;
  const rowMembers = result.rowMembers;
  const columnDepth = columnMembers[0]?.length ?? 0;
  const headerSpans = columnDepth > 0 ? buildHeaderSpans(columnMembers) : [];
  const rowLabelSpans = buildRowLabelSpans(rowMembers);
  const headerRowCount = Math.max(columnDepth, 0) + 1;
  const statisticCount = result.statistics.length;
  const hasRowTotals = result.rowTotals.length > 0;
  const hasColumnTotals = result.columnTotals.length > 0;
  const hasGrandTotals = result.grandTotals.length > 0;
  const exportLabel = exporting ? t("tabulate.exportingTable") : t("tabulate.exportTable");

  return (
    <div className="sp-tabulate-results-shell">
      {presentation === "interactive" ? (
        <div className="sp-tabulate-results-toolbar">
          <DepthControl
            label={t("tabulate.visibleRows")}
            depth={visibleRowDepth}
            maxDepth={item.rowFields.length}
            onChange={onVisibleRowDepthChange}
          />
          <DepthControl
            label={t("tabulate.visibleColumns")}
            depth={visibleColumnDepth}
            maxDepth={item.columnFields.length}
            onChange={onVisibleColumnDepthChange}
          />
          <button
            type="button"
            className={`sp-tabulate-inline-button sp-tabulate-export-button${exporting ? " is-busy" : ""}`}
            onClick={onExport}
            disabled={exportDisabled}
            title={exportLabel}
            aria-label={exportLabel}
            aria-busy={exporting}
          >
            <i className="fa-solid fa-table-arrow-up" aria-hidden="true" />
            <span>{exportLabel}</span>
          </button>
        </div>
      ) : null}

      <div className="sp-tabulate-table-wrap">
        <table className="sp-tabulate-table">
          <thead>
            {columnDepth > 0
              ? headerSpans.map((spans, level) => (
                  <tr key={`column-level-${level}`}>
                    {level === 0
                      ? rowHeaderLabels.map((label, rowLabelIndex) => (
                          <th
                            key={`row-label-header-${label}`}
                            className={`sp-tabulate-corner-header${rowLabelIndex === 0 ? " is-first" : ""}`}
                            rowSpan={headerRowCount}
                            style={{ left: rowLabelIndex * ROW_LABEL_WIDTH }}
                          >
                            {label}
                          </th>
                        ))
                      : null}

                    {spans.map((span) => (
                      <th
                        key={`${level}-${span.start}-${String(span.label)}`}
                        className="sp-tabulate-group-header"
                        colSpan={span.span * statisticCount}
                      >
                        {formatMemberLabel(span.label)}
                      </th>
                    ))}

                    {level === 0 && hasRowTotals ? (
                      <th className="sp-tabulate-group-header sp-tabulate-total-header" colSpan={statisticCount} rowSpan={columnDepth}>
                        {t("tabulate.total")}
                      </th>
                    ) : null}
                  </tr>
                ))
              : null}

            <tr>
              {columnDepth === 0
                ? rowHeaderLabels.map((label, rowLabelIndex) => (
                    <th
                      key={`row-label-flat-${label}-${visibleColumnFields.length}`}
                      className={`sp-tabulate-corner-header${rowLabelIndex === 0 ? " is-first" : ""}`}
                      style={{ left: rowLabelIndex * ROW_LABEL_WIDTH }}
                    >
                      {label}
                    </th>
                  ))
                : null}

              {columnMembers.map((member, columnIndex) =>
                result.statistics.map((statistic) => (
                  <th
                    key={`stat-${columnIndex}-${statistic.id}`}
                    className="sp-tabulate-stat-header"
                    title={buildStatisticHeaderTitle(member, statistic)}
                  >
                    {formatStatisticLabel(statistic)}
                    <span className="sp-tabulate-stat-field">{statistic.field}</span>
                  </th>
                )),
              )}

              {hasRowTotals
                ? result.statistics.map((statistic) => (
                    <th key={`row-total-${statistic.id}`} className="sp-tabulate-stat-header sp-tabulate-total-stat-header">
                      {formatStatisticLabel(statistic)}
                      <span className="sp-tabulate-stat-field">{statistic.field}</span>
                    </th>
                  ))
                : null}
            </tr>
          </thead>

          <tbody>
            {rowMembers.map((_, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {rowHeaderLabels.map((_, rowLabelIndex) => {
                  if (visibleRowFields.length === 0) {
                    if (rowIndex > 0 || rowLabelIndex > 0) {
                      return null;
                    }
                    return (
                      <th
                        key="all-rows"
                        className="sp-tabulate-row-label"
                        style={{ left: 0 }}
                      >
                        {t("tabulate.allRows")}
                      </th>
                    );
                  }

                  const span = rowLabelSpans[rowLabelIndex]?.find((candidate) => candidate.start === rowIndex);
                  if (!span) {
                    return null;
                  }

                  return (
                    <th
                      key={`row-label-${rowLabelIndex}-${rowIndex}`}
                      className="sp-tabulate-row-label"
                      rowSpan={span.span}
                      style={{ left: rowLabelIndex * ROW_LABEL_WIDTH }}
                    >
                      {formatMemberLabel(span.label)}
                    </th>
                  );
                })}

                {columnMembers.map((_, columnIndex) =>
                  result.statistics.map((statistic, statisticIndex) => (
                    <td key={`cell-${rowIndex}-${columnIndex}-${statistic.id}`}>
                      {formatValue(
                        result.cells[cellIndex(rowIndex, columnIndex, statisticIndex, columnMembers.length, statisticCount)],
                        statistic,
                        displayPropsByField.get(statistic.field),
                        fieldsByName.get(statistic.field),
                      )}
                    </td>
                  )),
                )}

                {hasRowTotals
                  ? result.statistics.map((statistic, statisticIndex) => (
                      <td key={`row-total-cell-${rowIndex}-${statistic.id}`} className="sp-tabulate-total-cell">
                        {formatValue(
                          result.rowTotals[totalIndex(rowIndex, statisticIndex, statisticCount)],
                          statistic,
                          displayPropsByField.get(statistic.field),
                          fieldsByName.get(statistic.field),
                        )}
                      </td>
                    ))
                  : null}
              </tr>
            ))}

            {hasColumnTotals ? (
              <tr className="sp-tabulate-footer-row">
                {rowHeaderLabels.map((_, rowLabelIndex) => (
                  <th
                    key={`column-total-label-${rowLabelIndex}`}
                    className="sp-tabulate-row-label sp-tabulate-footer-label"
                    style={{ left: rowLabelIndex * ROW_LABEL_WIDTH }}
                  >
                    {rowLabelIndex === 0 ? t("tabulate.total") : ""}
                  </th>
                ))}

                {columnMembers.map((_, columnIndex) =>
                  result.statistics.map((statistic, statisticIndex) => (
                    <td key={`column-total-${columnIndex}-${statistic.id}`} className="sp-tabulate-total-cell">
                      {formatValue(
                        result.columnTotals[totalIndex(columnIndex, statisticIndex, statisticCount)],
                        statistic,
                        displayPropsByField.get(statistic.field),
                        fieldsByName.get(statistic.field),
                      )}
                    </td>
                  )),
                )}

                {hasRowTotals && hasGrandTotals
                  ? result.statistics.map((statistic, statisticIndex) => (
                      <td key={`grand-total-${statistic.id}`} className="sp-tabulate-total-cell sp-tabulate-grand-total-cell">
                        {formatValue(
                          result.grandTotals[statisticIndex],
                          statistic,
                          displayPropsByField.get(statistic.field),
                          fieldsByName.get(statistic.field),
                        )}
                      </td>
                    ))
                  : null}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
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

function buildRowLabelSpans(members: ReadonlyArray<ReadonlyArray<unknown>>): HeaderCellSpan[][] {
  if (members.length === 0) {
    return [];
  }

  const depth = members[0]?.length ?? 0;
  const spansByDepth: HeaderCellSpan[][] = [];

  for (let level = 0; level < depth; level += 1) {
    const levelSpans: HeaderCellSpan[] = [];
    let start = 0;

    while (start < members.length) {
      const label = members[start][level];
      let end = start + 1;

      while (end < members.length && hasSamePrefix(members[start], members[end], level + 1)) {
        end += 1;
      }

      levelSpans.push({ label, start, span: end - start });
      start = end;
    }

    spansByDepth.push(levelSpans);
  }

  return spansByDepth;
}

function hasSamePrefix(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  prefixLength: number,
): boolean {
  for (let index = 0; index < prefixLength; index += 1) {
    if (!Object.is(left[index], right[index])) {
      return false;
    }
  }
  return true;
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
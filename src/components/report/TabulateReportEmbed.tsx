import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TabulateFieldInfo } from "@/components/tabulate/TabulateFieldList";
import { TabulateResultTable } from "@/components/tabulate/TabulateResultTable";
import { isNumericDuckDbType } from "@/components/tabulate/tabulateResult";
import { dataService } from "@/services/dataService";
import { tabulateService } from "@/services/tabulateService";
import type { ColumnDisplayProps } from "@/types/data";
import type { TabulateResult } from "@/types/tabulate";

import type { ReportResolvedSource } from "./ReportEmbed";

export interface TabulateReportEmbedRuntime {
  getColumns?: typeof dataService.getColumns;
  getColumnDisplayProps?: typeof dataService.getColumnDisplayProps;
  run?: typeof tabulateService.run;
}

export function TabulateReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "tabulate" }>;
  runtime?: TabulateReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<TabulateFieldInfo[]>([]);
  const [displayPropsByField, setDisplayPropsByField] = useState<Map<string, ColumnDisplayProps | undefined>>(new Map());
  const [result, setResult] = useState<TabulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const getColumns = runtime?.getColumns ?? dataService.getColumns;
    const getColumnDisplayProps = runtime?.getColumnDisplayProps ?? dataService.getColumnDisplayProps;
    const run = runtime?.run ?? tabulateService.run;

    setError(null);
    setResult(null);

    void (async () => {
      try {
        const [columns, displayProps, nextResult] = await Promise.all([
          getColumns(source.dataset.id),
          getColumnDisplayProps(source.dataset.id).catch(() => []),
          run({
            datasetId: source.dataset.id,
            rowFields: source.item.rowFields,
            columnFields: source.item.columnFields,
            statistics: source.item.statistics,
            includeRowTotals: source.item.includeRowTotals,
            includeColumnTotals: source.item.includeColumnTotals,
            maxResultCells: 10000,
          }),
        ]);
        if (cancelled) {
          return;
        }
        const nextFields = columns.map(([name, type]) => ({
          name,
          type,
          numeric: isNumericDuckDbType(type),
          modelingRole: isNumericDuckDbType(type) ? "Continuous" : "Nominal",
        } satisfies TabulateFieldInfo));
        const nextDisplayPropsByField = new Map<string, ColumnDisplayProps | undefined>();
        nextFields.forEach((field, index) => {
          nextDisplayPropsByField.set(field.name, displayProps.find((entry) => entry.colIndex === index));
        });
        setFields(nextFields);
        setDisplayPropsByField(nextDisplayPropsByField);
        setResult(nextResult);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtime?.getColumnDisplayProps, runtime?.getColumns, runtime?.run, source.dataset.id, source.item]);

  const fieldsByName = useMemo(() => new Map(fields.map((field) => [field.name, field])), [fields]);

  if (error) {
    return <div className="sp-report-embed-error">{t("report.embedError", { kind: t("report.group.tabulate"), name: source.name, message: error })}</div>;
  }

  if (!result) {
    return <div className="sp-report-embed-card sp-report-embed-loading">{t("common.loading")}</div>;
  }

  return (
    <section className="sp-report-embed-card" data-kind="tabulate">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <TabulateResultTable
        item={source.item}
        result={result}
        fieldsByName={fieldsByName}
        displayPropsByField={displayPropsByField}
        visibleRowDepth={source.item.rowFields.length}
        visibleColumnDepth={source.item.columnFields.length}
        onVisibleRowDepthChange={() => {}}
        onVisibleColumnDepthChange={() => {}}
        onExport={() => {}}
        exporting={false}
        exportDisabled
        presentation="readOnly"
      />
    </section>
  );
}
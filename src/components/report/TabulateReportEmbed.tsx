import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TabulateFieldInfo } from "@/components/tabulate/TabulateFieldList";
import { TabulateResultTable } from "@/components/tabulate/TabulateResultTable";
import { isNumericDuckDbType } from "@/components/tabulate/tabulateResult";
import { useTabulateSession, type TabulateSessionRuntime } from "@/components/tabulate/useTabulateSession";
import { dataService } from "@/services/dataService";
import type { ColumnDisplayProps } from "@/types/data";

import type { ReportResolvedSource } from "./ReportEmbed";
import "@/components/tabulate/tabulate.css";

export interface TabulateReportEmbedRuntime {
  getColumns?: typeof dataService.getColumns;
  getColumnDisplayProps?: typeof dataService.getColumnDisplayProps;
  session?: TabulateSessionRuntime;
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
  const [error, setError] = useState<string | null>(null);
  const session = useTabulateSession(source.item, source.dataset.generation, {
    visibleRowDepth: source.item.rowFields.length,
    visibleColumnDepth: source.item.columnFields.length,
  }, runtime?.session);

  useEffect(() => {
    let cancelled = false;
    const getColumns = runtime?.getColumns ?? dataService.getColumns;
    const getColumnDisplayProps = runtime?.getColumnDisplayProps ?? dataService.getColumnDisplayProps;

    setError(null);

    void (async () => {
      try {
        const [columns, displayProps] = await Promise.all([
          getColumns(source.dataset.id),
          getColumnDisplayProps(source.dataset.id).catch(() => []),
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
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtime?.getColumnDisplayProps, runtime?.getColumns, source.dataset.id, source.dataset.generation]);

  const fieldsByName = useMemo(() => new Map(fields.map((field) => [field.name, field])), [fields]);

  if (error) {
    return <div className="sp-report-embed-error">{t("report.embedError", { kind: t("report.group.tabulate"), name: source.name, message: error })}</div>;
  }

  return (
    <section className="sp-report-embed-card" data-kind="tabulate">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <TabulateResultTable
        item={source.item}
        session={session}
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
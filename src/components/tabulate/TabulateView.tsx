import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { dataService } from "@/services/dataService";
import { tabulateService } from "@/services/tabulateService";
import { useProjectStore } from "@/stores/useProjectStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { TabulateItem, TabulateRequest, TabulateResult, TabulateStatistic } from "@/types/tabulate";

import {
  TabulateFieldList,
  type TabulateAssignmentRole,
  type TabulateFieldInfo,
} from "./TabulateFieldList";
import {
  TabulateRoleZone,
  type TabulateDragPayload,
  type TabulateRoleZoneItem,
  type TabulateRoleZoneKind,
} from "./TabulateRoleZone";
import { TabulateResultTable } from "./TabulateResultTable";
import {
  TabulateStatisticEditor,
  defaultStatisticKindForField,
  formatStatisticLabel,
} from "./TabulateStatisticEditor";
import {
  buildTabulateExportRequest,
  canExportTabulateResult,
  canShowReadyResult,
  canAssignTabulateField,
  isLatestSequence,
  isNumericDuckDbType,
  reorderForDrop,
} from "./tabulateResult";
import "./tabulate.css";

interface TabulateViewProps {
  item: TabulateItem;
  dataset: DatasetMeta | undefined;
  onTableCreated: (dataset: DatasetMeta) => Promise<void>;
}

export function TabulateView({ item, dataset, onTableCreated }: TabulateViewProps) {
  const { t } = useTranslation();
  const updateItemRaw = useTabulateStore((state) => state.updateItem);
  const markDirtyRaw = useProjectStore((state) => state.markDirty);
  const readOnly = useProjectStore((state) => state.readOnly);
  const updateItem = (id: string, patch: Partial<TabulateItem>) => {
    if (readOnly) return;
    updateItemRaw(id, patch);
  };
  const markDirty = () => {
    if (readOnly) return;
    markDirtyRaw();
  };

  const [fields, setFields] = useState<TabulateFieldInfo[]>([]);
  const [displayPropsByField, setDisplayPropsByField] = useState<Map<string, ColumnDisplayProps | undefined>>(
    new Map(),
  );
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldLoadError, setFieldLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<TabulateResult | null>(null);
  const [completedQueryRequest, setCompletedQueryRequest] = useState<TabulateRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [visibleRowDepth, setVisibleRowDepth] = useState(item.rowFields.length);
  const [visibleColumnDepth, setVisibleColumnDepth] = useState(item.columnFields.length);
  const [editingStatistic, setEditingStatistic] = useState<TabulateStatistic | null>(null);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const [showFieldsOnNarrow, setShowFieldsOnNarrow] = useState(false);

  const previousRowDepthRef = useRef(item.rowFields.length);
  const previousColumnDepthRef = useRef(item.columnFields.length);
  const requestSequence = useRef(0);

  useEffect(() => {
    requestSequence.current += 1;
    setResult(null);
    setCompletedQueryRequest(null);
    setError(null);
    setExportError(null);
    setExporting(false);
    setLoading(false);
    setVisibleRowDepth(item.rowFields.length);
    setVisibleColumnDepth(item.columnFields.length);
    previousRowDepthRef.current = item.rowFields.length;
    previousColumnDepthRef.current = item.columnFields.length;
  }, [item.id]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1100px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
      if (event.matches) {
        setShowFieldsOnNarrow(false);
      }
    };

    setIsNarrow(mediaQuery.matches);
    if (mediaQuery.matches) {
      setShowFieldsOnNarrow(false);
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    setVisibleRowDepth((current) => {
      const previous = previousRowDepthRef.current;
      previousRowDepthRef.current = item.rowFields.length;
      if (current === previous) {
        return item.rowFields.length;
      }
      return Math.min(current, item.rowFields.length);
    });
  }, [item.rowFields.length]);

  useEffect(() => {
    setVisibleColumnDepth((current) => {
      const previous = previousColumnDepthRef.current;
      previousColumnDepthRef.current = item.columnFields.length;
      if (current === previous) {
        return item.columnFields.length;
      }
      return Math.min(current, item.columnFields.length);
    });
  }, [item.columnFields.length]);

  useEffect(() => {
    if (!dataset) {
      setFields([]);
      setDisplayPropsByField(new Map());
      setFieldLoadError(null);
      setFieldsLoading(false);
      return;
    }

    let alive = true;
    setFieldsLoading(true);
    setFieldLoadError(null);

    Promise.all([
      dataService.getColumns(dataset.id),
      dataService.getColumnDisplayProps(dataset.id).catch(() => []),
    ])
      .then(([columns, displayProps]) => {
        if (!alive) {
          return;
        }
        const nextFields = columns.map(([name, type]) => ({
          name,
          type,
          numeric: isNumericDuckDbType(type),
          modelingRole: isNumericDuckDbType(type) ? "Continuous" : "Nominal",
        } satisfies TabulateFieldInfo));
        const props = new Map<string, ColumnDisplayProps | undefined>();
        nextFields.forEach((field, index) => {
          props.set(field.name, displayProps.find((entry) => entry.colIndex === index));
        });
        setFields(nextFields);
        setDisplayPropsByField(props);
        setFieldsLoading(false);
      })
      .catch((reason: unknown) => {
        if (!alive) {
          return;
        }
        setFields([]);
        setDisplayPropsByField(new Map());
        setFieldsLoading(false);
        setFieldLoadError(String(reason));
      });

    return () => {
      alive = false;
    };
  }, [dataset]);

  const queryRequest = useMemo<TabulateRequest | null>(() => {
    if (!dataset || item.statistics.length === 0) {
      return null;
    }

    return {
      datasetId: dataset.id,
      rowFields: item.rowFields.slice(0, visibleRowDepth),
      columnFields: item.columnFields.slice(0, visibleColumnDepth),
      statistics: item.statistics,
      includeRowTotals: item.includeRowTotals,
      includeColumnTotals: item.includeColumnTotals,
      maxResultCells: 10000,
    };
  }, [dataset, item, visibleColumnDepth, visibleRowDepth]);

  const fullQueryRequest = useMemo<TabulateRequest | null>(() => {
    if (!dataset || item.statistics.length === 0) {
      return null;
    }

    return {
      datasetId: dataset.id,
      rowFields: item.rowFields,
      columnFields: item.columnFields,
      statistics: item.statistics,
      includeRowTotals: item.includeRowTotals,
      includeColumnTotals: item.includeColumnTotals,
      maxResultCells: 10000,
    };
  }, [dataset, item]);

  useEffect(() => {
    if (!queryRequest) {
      requestSequence.current += 1;
      setResult(null);
      setCompletedQueryRequest(null);
      setLoading(false);
      setError(null);
      return;
    }

    const sequence = ++requestSequence.current;
    setCompletedQueryRequest(null);
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await tabulateService.run(queryRequest);
        if (isLatestSequence(sequence, requestSequence.current)) {
          setResult(next);
          setCompletedQueryRequest(queryRequest);
          setError(null);
        }
      } catch (reason: unknown) {
        if (isLatestSequence(sequence, requestSequence.current)) {
          setCompletedQueryRequest(null);
          setError(String(reason));
        }
      } finally {
        if (isLatestSequence(sequence, requestSequence.current)) {
          setLoading(false);
        }
      }
    }, 250);

    return () => {
      requestSequence.current += 1;
      window.clearTimeout(timer);
    };
  }, [queryRequest]);

  const fieldsByName = useMemo(() => {
    return new Map(fields.map((field) => [field.name, field]));
  }, [fields]);

  const rowsItems = useMemo<readonly TabulateRoleZoneItem[]>(() => {
    return item.rowFields.map((fieldName, index) => ({
      key: fieldName,
      label: fieldName,
      hint: fieldsByName.get(fieldName)?.type ?? t("tabulate.unknownColumn"),
      draggablePayload: { kind: "roleField", role: "rows", fieldName, index },
    }));
  }, [fieldsByName, item.rowFields, t]);

  const columnsItems = useMemo<readonly TabulateRoleZoneItem[]>(() => {
    return item.columnFields.map((fieldName, index) => ({
      key: fieldName,
      label: fieldName,
      hint: fieldsByName.get(fieldName)?.type ?? t("tabulate.unknownColumn"),
      draggablePayload: { kind: "roleField", role: "columns", fieldName, index },
    }));
  }, [fieldsByName, item.columnFields, t]);

  const statisticsItems = useMemo<readonly TabulateRoleZoneItem[]>(() => {
    return item.statistics.map((statistic, index) => ({
      key: statistic.id,
      label: `${statistic.field} · ${formatStatisticLabel(statistic)}`,
      hint: fieldsByName.get(statistic.field)?.type ?? statistic.field,
      editable: true,
      draggablePayload: { kind: "statistic", statisticId: statistic.id, index },
    }));
  }, [fieldsByName, item.statistics]);

  const fieldsCollapsed = isNarrow && !showFieldsOnNarrow;
  const tooLargeError = error != null && /limit is 10000/i.test(error) && /cells/i.test(error);
  const showSourceUnavailable = dataset == null;
  const showUnconfigured = !showSourceUnavailable && item.statistics.length === 0;
  const showEmpty = !showSourceUnavailable && !showUnconfigured && !loading && error == null && result?.cellCount === 0;
  const showStandaloneError = !result && error != null && !tooLargeError;
  const showStandaloneTooLarge = !result && tooLargeError;
  const showStandaloneLoading = !result && loading;
  const showReadyTable = result != null
    && canShowReadyResult(result.cellCount, dataset != null, item.statistics.length);
  const canExport = canExportTabulateResult(
    showReadyTable,
    completedQueryRequest === queryRequest,
    loading,
    readOnly,
    exporting,
  );

  const updateCurrentItem = (patch: Partial<TabulateItem>) => {
    updateItem(item.id, patch);
    markDirty();
  };

  const handleExport = async () => {
    if (!canExport || !fullQueryRequest) {
      return;
    }

    setExporting(true);
    setExportError(null);

    try {
      const exportResult = await tabulateService.run(fullQueryRequest);
      const request = buildTabulateExportRequest(item, exportResult, {
        tableName: item.name,
        missingLabel: t("tabulate.missing"),
        statisticLabel: formatStatisticLabel,
      });
      const created = await dataService.createTableFromRows(request);
      await onTableCreated(created);
    } catch {
      setExportError(t("tabulate.exportTableFailed"));
    } finally {
      setExporting(false);
    }
  };

  const currentFieldsForRole = (role: TabulateAssignmentRole): readonly string[] => {
    if (role === "rows") {
      return item.rowFields;
    }
    if (role === "columns") {
      return item.columnFields;
    }
    return item.statistics.map((statistic) => statistic.field);
  };

  const assignField = (field: TabulateFieldInfo, role: TabulateAssignmentRole, insertIndex?: number | null) => {
    if (!canAssignTabulateField(role, currentFieldsForRole(role), field.name)) {
      return;
    }

    if (role === "statistics") {
      const nextStatistic: TabulateStatistic = {
        id: crypto.randomUUID(),
        field: field.name,
        kind: defaultStatisticKindForField(field),
      };
      const statistics = [...item.statistics];
      statistics.splice(insertIndex ?? statistics.length, 0, nextStatistic);
      updateCurrentItem({ statistics });
      return;
    }

    const key = role === "rows" ? "rowFields" : "columnFields";
    const current = [...item[key]];
    if (current.includes(field.name)) {
      return;
    }
    current.splice(insertIndex ?? current.length, 0, field.name);
    updateCurrentItem({ [key]: current });
  };

  const handleRoleDrop = (
    zone: TabulateRoleZoneKind,
    payload: TabulateDragPayload,
    insertIndex: number | null,
  ) => {
    if (zone === "statistics") {
      if (payload.kind === "statistic") {
        const next = reorderForDrop(item.statistics, payload.index, insertIndex ?? item.statistics.length);
        updateCurrentItem({ statistics: next });
        return;
      }
      const fieldName = payload.kind === "field" ? payload.fieldName : payload.fieldName;
      const field = fieldsByName.get(fieldName);
      if (!field) {
        return;
      }
      assignField(field, "statistics", insertIndex);
      return;
    }

    const targetKey = zone === "rows" ? "rowFields" : "columnFields";
    const target = [...item[targetKey]];

    if (payload.kind === "field") {
      const field = fieldsByName.get(payload.fieldName);
      if (!field || !canAssignTabulateField(zone, target, field.name)) {
        return;
      }
      target.splice(insertIndex ?? target.length, 0, field.name);
      updateCurrentItem({ [targetKey]: target });
      return;
    }

    if (payload.kind === "statistic") {
      return;
    }

    if (payload.role === zone) {
      updateCurrentItem({
        [targetKey]: reorderForDrop(target, payload.index, insertIndex ?? target.length),
      });
      return;
    }

    const sourceKey = payload.role === "rows" ? "rowFields" : "columnFields";
    const source = item[sourceKey].filter((fieldName) => fieldName !== payload.fieldName);
    const nextTarget = item[targetKey].filter((fieldName) => fieldName !== payload.fieldName);
    if (!canAssignTabulateField(zone, nextTarget, payload.fieldName)) {
      return;
    }
    nextTarget.splice(insertIndex ?? nextTarget.length, 0, payload.fieldName);
    updateCurrentItem({
      [sourceKey]: source,
      [targetKey]: nextTarget,
    });
  };

  const resultsState = showSourceUnavailable
    ? { title: t("tabulate.sourceUnavailableTitle"), detail: t("tabulate.sourceUnavailableDetail") }
    : showUnconfigured
      ? { title: t("tabulate.configureStatisticsTitle"), detail: t("tabulate.configureStatisticsDetail") }
      : showStandaloneLoading
        ? { title: t("tabulate.runningTitle"), detail: t("tabulate.runningDetail") }
        : showEmpty
          ? { title: t("tabulate.emptyTitle"), detail: t("tabulate.emptyDetail") }
          : showStandaloneTooLarge
            ? { title: t("tabulate.resultTooLargeTitle"), detail: error ?? t("tabulate.resultTooLargeDetail") }
            : showStandaloneError
              ? { title: t("tabulate.errorTitle"), detail: error ?? t("tabulate.errorDetail") }
              : null;
  const columnsToggleLabel = fieldsCollapsed
    ? t("tabulate.expandColumns")
    : t("tabulate.collapseColumns");

  return (
    <div className={`sp-tabulate-view${fieldsCollapsed ? " is-fields-collapsed" : ""}`}>
      <section className="sp-tabulate-fields-column">
        <div className="sp-panel-header sp-tabulate-collapsible-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{t("tabulate.fields")}</span>
            <span className="sp-tabulate-source-label" title={dataset?.name}>
              {dataset
                ? t("workspace.datasourceLabel", { name: dataset.name })
                : t("workspace.datasourceDeleted")}
            </span>
          </div>
          {isNarrow ? (
            <button
              type="button"
              className="sp-cols-panel-toggle"
              onClick={() => setShowFieldsOnNarrow((current) => !current)}
              title={columnsToggleLabel}
              aria-label={columnsToggleLabel}
              aria-expanded={!fieldsCollapsed}
            >
              <i className={`fa-solid ${fieldsCollapsed ? "fa-chevron-right" : "fa-chevron-left"}`} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {!fieldsCollapsed ? (
          <>
            <TabulateFieldList
              fields={fields}
              loading={fieldsLoading}
              disabled={dataset == null}
              rowFields={item.rowFields}
              columnFields={item.columnFields}
              statistics={item.statistics}
              onKeyboardAssign={assignField}
            />
            {fieldLoadError ? <div className="sp-tabulate-inline-error">{fieldLoadError}</div> : null}
          </>
        ) : (
          <div className="sp-tabulate-collapsed-rail" aria-hidden="true">
            <i className="fa-solid fa-table-list" />
          </div>
        )}
      </section>

      <section className="sp-tabulate-roles-column">
        <TabulateRoleZone
          zone="rows"
          title={t("tabulate.rows")}
          subtitle={t("tabulate.rowFieldsCount", { count: item.rowFields.length })}
          emptyHint={t("tabulate.rowsEmptyHint")}
          items={rowsItems}
          onDropPayload={handleRoleDrop}
          onMove={(index, direction) => {
            updateCurrentItem({ rowFields: reorder(item.rowFields, index, index + direction) });
          }}
          onRemove={(key) => {
            updateCurrentItem({ rowFields: item.rowFields.filter((fieldName) => fieldName !== key) });
          }}
        />

        <TabulateRoleZone
          zone="columns"
          title={t("tabulate.columns")}
          subtitle={t("tabulate.columnFieldsCount", { count: item.columnFields.length })}
          emptyHint={t("tabulate.columnsEmptyHint")}
          items={columnsItems}
          onDropPayload={handleRoleDrop}
          onMove={(index, direction) => {
            updateCurrentItem({ columnFields: reorder(item.columnFields, index, index + direction) });
          }}
          onRemove={(key) => {
            updateCurrentItem({ columnFields: item.columnFields.filter((fieldName) => fieldName !== key) });
          }}
        />

        <TabulateRoleZone
          zone="statistics"
          title={t("tabulate.statistics")}
          subtitle={t("tabulate.statisticsCount", { count: item.statistics.length })}
          emptyHint={t("tabulate.statisticsEmptyHint")}
          items={statisticsItems}
          onDropPayload={handleRoleDrop}
          onMove={(index, direction) => {
            updateCurrentItem({ statistics: reorder(item.statistics, index, index + direction) });
          }}
          onRemove={(key) => {
            updateCurrentItem({ statistics: item.statistics.filter((statistic) => statistic.id !== key) });
          }}
          onEdit={(key) => {
            const statistic = item.statistics.find((entry) => entry.id === key) ?? null;
            setEditingStatistic(statistic);
          }}
        />

        <div className="sp-tabulate-totals-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={item.includeRowTotals}
              onChange={(event) => updateCurrentItem({ includeRowTotals: event.target.checked })}
            />
            <span>{t("tabulate.rowTotals")}</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={item.includeColumnTotals}
              onChange={(event) => updateCurrentItem({ includeColumnTotals: event.target.checked })}
            />
            <span>{t("tabulate.columnTotals")}</span>
          </label>
        </div>
      </section>

      <section className="sp-tabulate-results-column">
        <div className="sp-panel-header">
          <span className="sp-panel-header-title">{t("tabulate.results")}</span>
          <span className="sp-tabulate-header-hint">
            {queryRequest
              ? t("tabulate.visibleFieldsHint", { rows: queryRequest.rowFields.length, columns: queryRequest.columnFields.length })
              : t("tabulate.waiting")}
          </span>
        </div>

        <div className="sp-tabulate-results-panel">
          {showReadyTable ? (
            <>
              <TabulateResultTable
                item={item}
                result={result}
                fieldsByName={fieldsByName}
                displayPropsByField={displayPropsByField}
                visibleRowDepth={visibleRowDepth}
                visibleColumnDepth={visibleColumnDepth}
                onVisibleRowDepthChange={setVisibleRowDepth}
                onVisibleColumnDepthChange={setVisibleColumnDepth}
                onExport={handleExport}
                exporting={exporting}
                exportDisabled={!canExport}
              />
              {loading ? <ResultBanner tone="info" message={t("tabulate.refreshingAggregate")} /> : null}
              {tooLargeError ? <ResultBanner tone="warning" message={error ?? t("tabulate.resultTooLargeTitle")} /> : null}
              {error != null && !tooLargeError ? <ResultBanner tone="error" message={error} /> : null}
              {exportError ? <ResultBanner tone="error" message={exportError} /> : null}
            </>
          ) : resultsState ? (
            <ResultStateCard title={resultsState.title} detail={resultsState.detail} />
          ) : null}
        </div>
      </section>

      {editingStatistic ? (
        <TabulateStatisticEditor
          open
          fields={fields}
          initialStatistic={editingStatistic}
          onClose={() => setEditingStatistic(null)}
          onSave={(nextStatistic) => {
            updateCurrentItem({
              statistics: item.statistics.map((statistic) => (
                statistic.id === nextStatistic.id ? nextStatistic : statistic
              )),
            });
            setEditingStatistic(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ResultStateCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="sp-tabulate-state-card" role="status">
      <div className="sp-tabulate-state-title">{title}</div>
      <div className="sp-tabulate-state-detail">{detail}</div>
    </div>
  );
}

function ResultBanner({ tone, message }: { tone: "info" | "warning" | "error"; message: string }) {
  return <div className={`sp-tabulate-result-banner is-${tone}`}>{message}</div>;
}

function reorder<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (toIndex < 0 || toIndex >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return next;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

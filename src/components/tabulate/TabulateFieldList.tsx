import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TabulateStatistic } from "@/types/tabulate";

import { TABULATE_DRAG_MIME } from "./TabulateRoleZone";

export interface TabulateFieldInfo {
  name: string;
  type: string;
  numeric: boolean;
  modelingRole: "Continuous" | "Nominal";
}

export type TabulateAssignmentRole = "rows" | "columns" | "statistics";

interface TabulateFieldListProps {
  fields: readonly TabulateFieldInfo[];
  loading: boolean;
  disabled: boolean;
  readOnly: boolean;
  rowFields: readonly string[];
  columnFields: readonly string[];
  statistics: readonly TabulateStatistic[];
  onKeyboardAssign: (field: TabulateFieldInfo, role: TabulateAssignmentRole) => void;
}

export function TabulateFieldList({
  fields,
  loading,
  disabled,
  readOnly,
  rowFields,
  columnFields,
  statistics,
  onKeyboardAssign,
}: TabulateFieldListProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const statisticFields = useMemo(() => {
    return new Set(statistics.map(({ field }) => field));
  }, [statistics]);

  const visibleFields = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return fields;
    }
    return fields.filter(({ name, type, modelingRole }) => {
      const haystack = `${name} ${type} ${modelingRole}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [fields, search]);

  return (
    <section className="sp-tabulate-panel sp-tabulate-fields-panel" aria-label={t("tabulate.availableFields")}>
      <div className="sp-tabulate-field-toolbar">
        <label className="sp-tabulate-search" aria-label={t("tabulate.searchFields")}>
          <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("tabulate.searchFields")}
            disabled={disabled || readOnly}
            aria-label={t("tabulate.searchAvailableFields")}
          />
        </label>
      </div>

      <div className="sp-cols-panel-list" role="list" aria-busy={loading}>
        {loading ? (
          <div className="sp-tabulate-empty-note">{t("tabulate.loadingFields")}</div>
        ) : null}

        {!loading && disabled ? (
          <div className="sp-tabulate-empty-note">{t("tabulate.sourceDatasetUnavailable")}</div>
        ) : null}

        {!loading && !disabled && visibleFields.length === 0 ? (
          <div className="sp-tabulate-empty-note">
            {fields.length === 0 ? t("tabulate.noFieldsAvailable") : t("tabulate.noFieldsMatchSearch")}
          </div>
        ) : null}

        {!loading && !disabled
          ? visibleFields.map((field) => {
              const assignedToRows = rowFields.includes(field.name);
              const assignedToColumns = columnFields.includes(field.name);
              const assignedToStatistics = statisticFields.has(field.name);
              const assigned = assignedToRows || assignedToColumns || assignedToStatistics;
              const typeLabel = t(`dataTable.type.${field.type}`, { defaultValue: field.type });

              return (
                <div
                  key={field.name}
                  role="listitem"
                  tabIndex={readOnly ? -1 : 0}
                  draggable={!readOnly}
                  aria-disabled={readOnly}
                  className={`sp-cols-panel-item${assigned ? " sp-cols-panel-item-selected" : ""}`}
                  title={`${field.name} (${typeLabel})`}
                  onDragStart={(event) => {
                    if (readOnly) return;
                    event.dataTransfer.effectAllowed = "copyMove";
                    event.dataTransfer.setData(
                      TABULATE_DRAG_MIME,
                      JSON.stringify({ kind: "field", fieldName: field.name }),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (readOnly) return;
                    const key = event.key.toLowerCase();
                    if (key === "r") {
                      event.preventDefault();
                      onKeyboardAssign(field, "rows");
                    } else if (key === "c") {
                      event.preventDefault();
                      onKeyboardAssign(field, "columns");
                    } else if (key === "s") {
                      event.preventDefault();
                      onKeyboardAssign(field, "statistics");
                    }
                  }}
                >
                  <span className="sp-cols-panel-item-type">{typeLabel}</span>
                  <span className="sp-cols-panel-item-name">{field.name}</span>
                  <span className="sp-cols-panel-item-drag" aria-hidden="true">☰</span>
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
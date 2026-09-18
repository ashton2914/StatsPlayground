import { useState } from "react";
import { useTranslation } from "react-i18next";

export type TabulateRoleZoneKind = "rows" | "columns" | "statistics";

export interface TabulateRoleZoneItem {
  key: string;
  label: string;
  hint: string;
  draggablePayload: TabulateDragPayload;
  editable?: boolean;
}

export type TabulateDragPayload =
  | { kind: "field"; fieldName: string }
  | { kind: "roleField"; role: "rows" | "columns"; fieldName: string; index: number }
  | { kind: "statistic"; statisticId: string; index: number };

export const TABULATE_DRAG_MIME = "application/x-statsplayground-tabulate";

interface TabulateRoleZoneProps {
  zone: TabulateRoleZoneKind;
  title: string;
  subtitle: string;
  emptyHint: string;
  items: readonly TabulateRoleZoneItem[];
  disabled: boolean;
  onDropPayload: (
    zone: TabulateRoleZoneKind,
    payload: TabulateDragPayload,
    insertIndex: number | null,
  ) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (key: string) => void;
  onEdit?: (key: string) => void;
}

export function TabulateRoleZone({
  zone,
  title,
  subtitle,
  emptyHint,
  items,
  disabled,
  onDropPayload,
  onMove,
  onRemove,
  onEdit,
}: TabulateRoleZoneProps) {
  const { t } = useTranslation();
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <section
      className={`sp-tabulate-zone sp-tabulate-zone-${zone}`}
      aria-disabled={disabled}
      onDragOver={(event) => {
        if (!hasTabulateDragType(event.dataTransfer.types)) {
          return;
        }
        if (disabled) return;
        event.preventDefault();
        if (dragOverIndex == null) {
          setDragOverIndex(items.length);
        }
      }}
      onDragLeave={() => setDragOverIndex(null)}
      onDrop={(event) => {
        if (disabled) return;
        const payload = readDragPayload(event.dataTransfer);
        setDragOverIndex(null);
        if (payload == null) {
          return;
        }
        event.preventDefault();
        onDropPayload(zone, payload, items.length);
      }}
    >
      <div className="sp-panel-header">
        <span className="sp-panel-header-title">{title}</span>
        <span className="sp-tabulate-header-hint">{subtitle}</span>
      </div>

      <div className="sp-tabulate-zone-body" role="list" aria-label={title}>
        {items.length === 0 ? <div className="sp-tabulate-empty-note">{emptyHint}</div> : null}

        {items.map((item, index) => {
          const isDropTarget = dragOverIndex === index;

          return (
            <div
              key={item.key}
              role="listitem"
              draggable={!disabled}
              aria-disabled={disabled}
              className={`sp-tabulate-zone-item${isDropTarget ? " is-drop-target" : ""}`}
              onDragStart={(event) => {
                if (disabled) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  TABULATE_DRAG_MIME,
                  JSON.stringify(item.draggablePayload),
                );
              }}
              onDragOver={(event) => {
                if (!hasTabulateDragType(event.dataTransfer.types)) {
                  return;
                }
                if (disabled) return;
                event.preventDefault();
                setDragOverIndex(index);
              }}
              onDragLeave={() => {
                if (dragOverIndex === index) {
                  setDragOverIndex(null);
                }
              }}
              onDrop={(event) => {
                event.stopPropagation();
                const payload = readDragPayload(event.dataTransfer);
                setDragOverIndex(null);
                if (disabled || payload == null) {
                  return;
                }
                event.preventDefault();
                onDropPayload(zone, payload, index);
              }}
            >
              <div className="sp-tabulate-zone-copy">
                <span className="sp-tabulate-zone-label">{item.label}</span>
                <span className="sp-tabulate-zone-hint">{item.hint}</span>
              </div>

              <div className="sp-tabulate-zone-actions">
                <button
                  type="button"
                  className="sp-tabulate-inline-button"
                  onClick={() => onMove(index, -1)}
                  disabled={disabled || index === 0}
                  title={t("tabulate.moveEarlier")}
                  aria-label={t("tabulate.moveEarlierLabel", { label: item.label })}
                >
                  <i className="fa-solid fa-chevron-up" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sp-tabulate-inline-button"
                  onClick={() => onMove(index, 1)}
                  disabled={disabled || index === items.length - 1}
                  title={t("tabulate.moveLater")}
                  aria-label={t("tabulate.moveLaterLabel", { label: item.label })}
                >
                  <i className="fa-solid fa-chevron-down" aria-hidden="true" />
                </button>
                {item.editable && onEdit ? (
                  <button
                    type="button"
                    className="sp-tabulate-inline-button"
                    onClick={() => onEdit(item.key)}
                    disabled={disabled}
                    title={t("tabulate.editStatistic")}
                    aria-label={t("tabulate.editStatisticLabel", { label: item.label })}
                  >
                    <i className="fa-solid fa-pen" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="sp-tabulate-inline-button"
                  onClick={() => onRemove(item.key)}
                  disabled={disabled}
                  title={t("tabulate.remove")}
                  aria-label={t("tabulate.removeLabel", { label: item.label })}
                >
                  <i className="fa-solid fa-xmark" aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}

        {dragOverIndex === items.length && items.length > 0 ? (
          <div className="sp-tabulate-drop-tail" aria-hidden="true" />
        ) : null}
      </div>
    </section>
  );
}

function hasTabulateDragType(types: readonly string[]): boolean {
  return types.includes(TABULATE_DRAG_MIME);
}

function readDragPayload(dataTransfer: DataTransfer): TabulateDragPayload | null {
  const raw = dataTransfer.getData(TABULATE_DRAG_MIME);
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as TabulateDragPayload;
    if (payload && typeof payload === "object" && "kind" in payload) {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}
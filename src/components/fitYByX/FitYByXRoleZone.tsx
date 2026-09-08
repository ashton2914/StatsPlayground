import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { FitYByXRole } from "./fitYByXConfig";

export interface FitYByXRoleZoneItem {
  name: string;
  hint: string;
}

export interface FitYByXDragPayload {
  fieldName: string;
}

export const FIT_Y_BY_X_DRAG_MIME = "application/x-statsplayground-fit-y-by-x";

interface FitYByXRoleZoneProps {
  role: FitYByXRole;
  title: string;
  subtitle: string;
  emptyHint: string;
  item: FitYByXRoleZoneItem | null;
  onDropPayload: (role: FitYByXRole, payload: FitYByXDragPayload) => void;
  onClear: () => void;
}

export function FitYByXRoleZone({
  role,
  title,
  subtitle,
  emptyHint,
  item,
  onDropPayload,
  onClear,
}: FitYByXRoleZoneProps) {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <section
      className={`sp-tabulate-zone sp-fit-y-by-x-zone${isDragOver ? " is-drop-target" : ""}`}
      onDragOver={(event) => {
        if (!hasFitYByXDragType(event.dataTransfer.types)) {
          return;
        }
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(event) => {
        const payload = readDragPayload(event.dataTransfer);
        setIsDragOver(false);
        if (payload == null) {
          return;
        }
        event.preventDefault();
        onDropPayload(role, payload);
      }}
    >
      <div className="sp-panel-header">
        <span className="sp-panel-header-title">{title}</span>
        <span className="sp-tabulate-header-hint">{subtitle}</span>
      </div>

      <div className="sp-tabulate-zone-body" role="list" aria-label={title}>
        {!item ? (
          <div className="sp-tabulate-empty-note">{emptyHint}</div>
        ) : (
          <div role="listitem" className="sp-tabulate-zone-item">
            <div className="sp-tabulate-zone-copy">
              <span className="sp-tabulate-zone-label">{item.name}</span>
              <span className="sp-tabulate-zone-hint">{item.hint}</span>
            </div>

            <div className="sp-tabulate-zone-actions">
              <button
                type="button"
                className="sp-tabulate-inline-button"
                onClick={onClear}
                title={t("fitYByX.removeAssignment", { defaultValue: "Remove assignment" })}
                aria-label={t("fitYByX.removeAssignmentFor", {
                  defaultValue: "Remove {{label}} assignment",
                  label: item.name,
                })}
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function hasFitYByXDragType(types: readonly string[]): boolean {
  return types.includes(FIT_Y_BY_X_DRAG_MIME);
}

function readDragPayload(dataTransfer: DataTransfer): FitYByXDragPayload | null {
  const raw = dataTransfer.getData(FIT_Y_BY_X_DRAG_MIME);
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as FitYByXDragPayload;
    if (payload && typeof payload === "object" && typeof payload.fieldName === "string") {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}
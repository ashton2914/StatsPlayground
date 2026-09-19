import { useTranslation } from "react-i18next";

import type { GraphNewOverlayGroup } from "@/services/graphNewService";

interface GraphNewOverlayLegendProps {
  groups: GraphNewOverlayGroup[];
  hiddenIds: readonly string[];
  readOnly: boolean;
  onHiddenIdsChange: (ids: string[]) => void;
}

export function GraphNewOverlayLegend({
  groups,
  hiddenIds,
  readOnly,
  onHiddenIdsChange,
}: GraphNewOverlayLegendProps) {
  const { t } = useTranslation();
  const hidden = new Set(hiddenIds);

  return (
    <fieldset className="graph-new-overlay-legend" aria-label={t("graphNew.overlayLegend")}>
      {groups.map((group) => {
        const checked = !hidden.has(group.id);
        const label = group.missing ? t("graphNew.missingGroup") : group.label;
        return (
          <label key={group.id} data-hidden={!checked || undefined}>
            <input
              type="checkbox"
              checked={checked}
              disabled={readOnly}
              aria-label={t("graphNew.showOverlayGroup", { group: label })}
              onChange={() => onHiddenIdsChange(
                checked
                  ? [...hidden, group.id].sort()
                  : [...hidden].filter((id) => id !== group.id).sort(),
              )}
            />
            <span
              className="graph-new-overlay-swatch"
              style={{
                backgroundColor: `rgba(${group.color[0]},${group.color[1]},${group.color[2]},${group.color[3] / 255})`,
              }}
            />
            <span className="graph-new-overlay-label">{label}</span>
            <output>{group.totalRows.toLocaleString()}</output>
          </label>
        );
      })}
    </fieldset>
  );
}

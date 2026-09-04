import { useTranslation } from "react-i18next";

import type { FieldRef } from "@/graphCore";

import type { DistributionRole } from "./distributionConfig";

interface DistributionRoleZoneProps {
  role: DistributionRole;
  fields: FieldRef[];
  onAssign: (fieldName: string) => void;
  onRemove: (fieldName: string) => void;
}

export function DistributionRoleZone({ role, fields, onAssign, onRemove }: DistributionRoleZoneProps) {
  const { t } = useTranslation();
  const roleLabel = t(`distribution.roles.${role === "response" ? "y" : role}`);
  return (
    <section
      className="distribution-role-zone"
      data-testid={`distribution-role-${role}`}
      aria-label={t("distribution.roleLabel", { role: roleLabel })}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const columnId = event.dataTransfer.getData("application/x-statsplayground-distribution") ||
          event.dataTransfer.getData("text/plain");
        if (columnId) onAssign(columnId);
      }}
    >
      <h4>{roleLabel}</h4>
      <div className="distribution-role-items">
        {fields.length === 0 ? (
          <span className="distribution-role-empty">{t("distribution.roleEmpty")}</span>
        ) : fields.map((field) => (
          <span className="distribution-role-chip" key={field.name}>
            <span className="distribution-role-chip-label" title={field.name}>
              {field.name}
            </span>
            <button
              type="button"
              className="btn-icon"
              data-testid={`distribution-remove-${role}-${field.name}`}
              aria-label={t("distribution.removeFromRole", { column: field.name, role: roleLabel })}
              onClick={() => onRemove(field.name)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}
import { useTranslation } from "react-i18next";

import type { FieldRef } from "@/graphCore";
import type { SpecLimitsOverride } from "@/types/distribution";

interface SpecificationLimitsEditorProps {
  responses: FieldRef[];
  specLimits: Record<string, SpecLimitsOverride>;
  onChange: (specLimits: Record<string, SpecLimitsOverride>) => void;
}

const EMPTY_LIMITS: SpecLimitsOverride = { lsl: null, target: null, usl: null };

export function SpecificationLimitsEditor({
  responses,
  specLimits,
  onChange,
}: SpecificationLimitsEditorProps) {
  const { t } = useTranslation();
  const setLimit = (response: string, key: keyof SpecLimitsOverride, raw: string) => {
    const limits = specLimits[response] ?? EMPTY_LIMITS;
    onChange({
      ...specLimits,
      [response]: {
        ...limits,
        [key]: raw.trim() === "" ? null : Number(raw),
      },
    });
  };

  return (
    <section className="distribution-spec-editor">
      {responses.map((response) => {
        const limits = specLimits[response.name] ?? EMPTY_LIMITS;
        return (
          <fieldset key={response.name}>
            <legend>{response.name}</legend>
          <div className="distribution-spec-fields">
            {(["lsl", "target", "usl"] as const).map((key) => (
              <label key={key}>
                <span>{t(`distribution.specification.${key}`)}</span>
                <input
                  type="number"
                  value={limits[key] ?? ""}
                  onChange={(event) => setLimit(response.name, key, event.target.value)}
                />
              </label>
            ))}
          </div>
          </fieldset>
        );
      })}
    </section>
  );
}
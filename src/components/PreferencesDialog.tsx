import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SUPPORTED_LOCALES, type Locale } from "@/i18n";
import { useLocaleStore } from "@/stores/useLocaleStore";
import { useThemeStore, ThemeMode } from "@/stores/useThemeStore";
import { useUpdatePreferencesStore } from "@/stores/useUpdatePreferencesStore";

import { Checkbox } from "./ui/FormControls";

interface Props {
  onClose: () => void;
}

type CategoryKey = "general" | "appearance";

export function PreferencesDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeStore();
  const { locale, setLocale } = useLocaleStore();
  const { automaticCheck, includePrerelease, setAutomaticCheck, setIncludePrerelease } = useUpdatePreferencesStore();
  const [active, setActive] = useState<CategoryKey>("general");

  const categories: { key: CategoryKey; label: string }[] = [
    { key: "general", label: t("prefs.categoryGeneral") },
    { key: "appearance", label: t("prefs.categoryAppearance") },
  ];

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div
        className="sp-dialog sp-dialog-wide pref-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">{t("prefs.title")}</div>
        <div className="sp-dialog-body pref-body">
          <nav className="pref-nav">
            {categories.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`pref-nav-item${active === c.key ? " pref-nav-item-active" : ""}`}
                onClick={() => setActive(c.key)}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div className="pref-pane">
            {active === "general" && (
              <div className="pref-section">
                <div className="pref-row">
                  <label className="sp-dialog-label" htmlFor="pref-language">
                    {t("prefs.language")}
                  </label>
                  <select
                    id="pref-language"
                    className="pref-select"
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as Locale)}
                  >
                    {SUPPORTED_LOCALES.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pref-update-options">
                  <Checkbox
                    checked={automaticCheck}
                    onChange={(event) => setAutomaticCheck(event.target.checked)}
                    hint={t("prefs.automaticUpdatesHint", { defaultValue: "Check once whenever StatsPlayground starts." })}
                  >
                    {t("prefs.automaticUpdates", { defaultValue: "Automatically check for updates" })}
                  </Checkbox>
                  <Checkbox
                    checked={includePrerelease}
                    onChange={(event) => setIncludePrerelease(event.target.checked)}
                    hint={t("prefs.previewUpdatesHint", { defaultValue: "Include preview releases when looking for a newer version." })}
                  >
                    {t("prefs.previewUpdates", { defaultValue: "Include preview releases" })}
                  </Checkbox>
                </div>
              </div>
            )}
            {active === "appearance" && (
              <div className="pref-row">
                <label className="sp-dialog-label" htmlFor="pref-theme">
                  {t("prefs.theme")}
                </label>
                <select
                  id="pref-theme"
                  className="pref-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ThemeMode)}
                >
                  <option value="light">{t("prefs.themeLight")}</option>
                  <option value="dark">{t("prefs.themeDark")}</option>
                  <option value="system">{t("prefs.themeSystem")}</option>
                </select>
              </div>
            )}
          </div>
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            {t("prefs.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

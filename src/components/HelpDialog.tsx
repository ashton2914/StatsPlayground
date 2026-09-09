import { useTranslation } from "react-i18next";

import { APP_VERSION } from "@/appVersion";

// Raw-import the project's LICENSE so the dialog always shows the exact
// text shipped at the repo root (no copy/paste drift). Vite resolves
// "?raw" to the file's UTF-8 contents as a string at build time.
import licenseText from "../../LICENSE?raw";

/** Curated acknowledgments. We don't auto-generate from
 *  package.json + Cargo.toml because the goal here is to *credit* the
 *  upstream projects in a human-readable way, not to produce a full
 *  bill-of-materials. Add an entry when you take on a meaningful new
 *  dependency. License strings use SPDX identifiers. */
type Ack = { name: string; license: string };
type Contributor = { name: string };

const ACKNOWLEDGMENTS: Ack[] = [
  // Frontend runtime
  { name: "React", license: "MIT" },
  { name: "Vite", license: "MIT" },
  { name: "TypeScript", license: "Apache-2.0" },
  { name: "Zustand", license: "MIT" },
  { name: "i18next", license: "MIT" },
  { name: "react-i18next", license: "MIT" },
  { name: "Apache ECharts", license: "Apache-2.0" },
  // Desktop shell + Rust backend
  { name: "Tauri", license: "MIT OR Apache-2.0" },
  { name: "DuckDB", license: "MIT" },
  { name: "duckdb-rs", license: "MIT" },
  { name: "rusqlite", license: "MIT" },
  { name: "serde / serde_json", license: "MIT OR Apache-2.0" },
  { name: "tokio", license: "MIT" },
  { name: "thiserror", license: "MIT OR Apache-2.0" },
  { name: "uuid", license: "MIT OR Apache-2.0" },
  { name: "zip-rs", license: "MIT" },
];

const CONTRIBUTORS: Contributor[] = [
  { name: "Ashton Huang" },
  { name: "Chi Zhang" },
  { name: "Junyi Zhu" },
  { name: "Max Xu" },
  { name: "Ryan Qiu" },
  { name: "Stanley Su" },
];

interface Props {
  mode: "about" | "license" | "contributors";
  onClose: () => void;
}

export function HelpDialog({ mode, onClose }: Props) {
  const { t } = useTranslation();

  const title = mode === "about"
    ? t("help.aboutTitle", { defaultValue: "About StatsPlayground" })
    : mode === "contributors"
      ? t("help.contributorsTitle", { defaultValue: "Contributors" })
      : t("help.licenseTitle", { defaultValue: "License" });

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div
        className="sp-dialog sp-dialog-wide sp-help-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">{title}</div>
        <div className="sp-dialog-body">
          {mode === "about" ? (
            <div className="sp-help-about">
              <div className="sp-help-appname">StatsPlayground</div>
              <div className="sp-help-version">
                {t("help.version", { defaultValue: "Version" })} {APP_VERSION}
              </div>
              <div className="sp-help-desc">
                {t("help.description", {
                  defaultValue:
                    "An ultra-lightweight, open-source, and extensible data analysis tool.",
                })}
              </div>
              <div className="sp-help-copyright">
                {t("help.copyright", {
                  defaultValue: "Copyright © 2026 Ashton Huang. All rights reserved.",
                })}
              </div>

              <div className="sp-help-section-title">
                {t("help.acknowledgments", { defaultValue: "Acknowledgments" })}
              </div>
              <div className="sp-help-section-intro">
                {t("help.acknowledgmentsIntro", {
                  defaultValue:
                    "StatsPlayground is built on top of the following open-source projects. Sincere thanks to their maintainers and contributors.",
                })}
              </div>
              <ul className="sp-help-acks">
                {ACKNOWLEDGMENTS.map((a) => (
                  <li key={a.name}>
                    <span className="sp-help-ack-name">{a.name}</span>
                    <span className="sp-help-ack-license"> — {a.license}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : mode === "contributors" ? (
            <div className="sp-help-about">
              <div className="sp-help-section-intro">
                {t("help.contributorsIntro", {
                  defaultValue: "StatsPlayground is shaped by the following contributors.",
                })}
              </div>
              <ul className="sp-help-acks">
                {CONTRIBUTORS.map((contributor) => (
                  <li key={contributor.name}>
                    <span className="sp-help-ack-name">{contributor.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <pre className="sp-help-license">{licenseText}</pre>
          )}
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            {t("help.close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </div>
  );
}

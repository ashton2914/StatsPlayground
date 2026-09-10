import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { UpdateCheckStatus } from "@/stores/updateStoreCore";

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
  { name: "Tiptap", license: "MIT" },
  { name: "react-markdown", license: "MIT" },
  { name: "remark-gfm", license: "MIT" },
  { name: "Font Awesome Free", license: "CC-BY-4.0 AND OFL-1.1 AND MIT" },
  { name: "Apache ECharts", license: "Apache-2.0" },
  { name: "zrender", license: "BSD-3-Clause" },
  { name: "ECharts GL", license: "BSD-3-Clause" },
  { name: "ClayGL", license: "BSD-3-Clause" },
  // Desktop shell + Rust backend
  { name: "Tauri", license: "MIT OR Apache-2.0" },
  { name: "DuckDB", license: "MIT" },
  { name: "duckdb-rs", license: "MIT" },
  { name: "rusqlite", license: "MIT" },
  { name: "rust-postgres", license: "MIT OR Apache-2.0" },
  { name: "rust-mysql-simple", license: "MIT OR Apache-2.0" },
  { name: "sqlparser-rs", license: "Apache-2.0" },
  { name: "statrs", license: "MIT" },
  { name: "argmin", license: "MIT OR Apache-2.0" },
  { name: "nalgebra", license: "Apache-2.0" },
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
  version: string;
  updateStatus?: UpdateCheckStatus;
  onCheckForUpdates?: () => Promise<void>;
  onClose: () => void;
}

export function HelpDialog({ version, updateStatus = "idle", onCheckForUpdates, onClose }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<"about" | "license">("about");
  const titleId = "help-dialog-title";

  const title = view === "about"
    ? t("help.aboutTitle", { defaultValue: "About StatsPlayground" })
    : t("help.licenseTitle", { defaultValue: "License" });

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div
        className="sp-dialog sp-dialog-wide sp-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title" id={titleId}>{title}</div>
        <div className="sp-dialog-body">
          {view === "about" ? (
            <div className="sp-help-about">
              <div className="sp-help-appname">StatsPlayground</div>
              <div className="sp-help-version">
                {t("help.version", { defaultValue: "Version" })} {version}
              </div>
              <div className="sp-help-desc">
                {t("help.description", {
                  defaultValue:
                    "An ultra-lightweight, open-source, and extensible data analysis tool.",
                })}
              </div>
              <div className="sp-help-copyright">
                {t("help.copyright", {
                  defaultValue: "Copyright © 2026 StatsPlayground.org contributors.",
                })}
                {" "}
                <button
                  type="button"
                  className="sp-help-license-link"
                  onClick={() => setView("license")}
                >
                  {t("help.licenseLink", {
                    defaultValue: "Licensed under the Apache License 2.0.",
                  })}
                </button>
              </div>

              {onCheckForUpdates && (
                <div className="sp-help-update-check">
                  <button
                    type="button"
                    className="sp-dialog-btn"
                    disabled={updateStatus === "checking"}
                    onClick={() => void onCheckForUpdates()}
                  >
                    {updateStatus === "checking"
                      ? t("update.checking", { defaultValue: "Checking..." })
                      : t("update.check", { defaultValue: "Check for Updates" })}
                  </button>
                  {updateStatus === "upToDate" && (
                    <span role="status" className="sp-help-update-status">
                      {t("update.upToDate", { defaultValue: "StatsPlayground is up to date." })}
                    </span>
                  )}
                  {updateStatus === "error" && (
                    <span role="alert" className="sp-help-update-status sp-help-update-error">
                      {t("update.checkFailed", { defaultValue: "Unable to check for updates. Try again later." })}
                    </span>
                  )}
                </div>
              )}

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

              <div className="sp-help-section-title">
                {t("help.contributorsTitle", { defaultValue: "Contributors" })}
              </div>
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
          {view === "license" && (
            <button className="sp-dialog-btn" onClick={() => setView("about")}>
              {t("help.backToAbout", { defaultValue: "Back to About" })}
            </button>
          )}
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            {t("help.close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";

import type { ReleaseUpdate } from "@/services/updateCheckCore";

interface Props {
  currentVersion: string;
  update: ReleaseUpdate;
  onIgnore: () => void;
  onDownload: () => void;
}

export function UpdatePrompt({ currentVersion, update, onIgnore, onDownload }: Props) {
  const { t } = useTranslation();
  const titleId = "update-prompt-title";

  return (
    <div className="sp-dialog-overlay">
      <div className="sp-dialog sp-update-prompt" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sp-dialog-title" id={titleId}>
          {t("update.availableTitle", { defaultValue: "Update available" })}
        </div>
        <div className="sp-dialog-body sp-update-prompt-body">
          <p>{t("update.availableMessage", { defaultValue: "A new version of StatsPlayground is available." })}</p>
          <dl className="sp-update-version-list">
            <div>
              <dt>{t("update.currentVersion", { defaultValue: "Current version" })}</dt>
              <dd>{currentVersion}</dd>
            </div>
            <div>
              <dt>{t("update.newVersion", { defaultValue: "New version" })}</dt>
              <dd>{update.version}</dd>
            </div>
          </dl>
          {!update.directDownload && (
            <p className="sp-update-fallback">
              {t("update.assetUnavailable", {
                defaultValue: "No direct download is available for this platform. The release page will open instead.",
              })}
            </p>
          )}
        </div>
        <div className="sp-dialog-actions">
          <button type="button" className="sp-dialog-btn" onClick={onIgnore}>
            {t("update.ignore", { defaultValue: "Ignore" })}
          </button>
          <button type="button" className="sp-dialog-btn sp-dialog-btn-primary" onClick={onDownload}>
            {t("update.download", { defaultValue: "Download Update" })}
          </button>
        </div>
      </div>
    </div>
  );
}
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";

import { APP_VERSION } from "@/appVersion";
import { useProjectStore } from "@/stores/useProjectStore";

export function WelcomePage() {
  const { t } = useTranslation();
  const { createProject, openProject, loading } = useProjectStore();
  const [projectName, setProjectName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const handleCreate = async () => {
    if (!projectName.trim()) return;
    const filePath = await save({
      title: t("welcome.saveProjectDialog"),
      defaultPath: `${projectName}.spprj`,
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
    });
    if (!filePath) return;
    await createProject(projectName.trim(), filePath);
  };

  const handleOpen = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: t("welcome.openProjectDialog"),
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      try {
        await openProject(selected as string);
      } catch (e) {
        alert(t("alert.openProjectFailed", { defaultValue: "Failed to open project: {{msg}}", msg: String(e) }));
      }
    }
  };

  return (
    <div className="welcome-page">
      <div className="welcome-card">
        <h1>StatsPlayground</h1>
        <p className="subtitle">{t("welcome.subtitle")}</p>
        <div className="version-tag">{APP_VERSION}</div>

        {!showCreate ? (
          <div className="welcome-actions">
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              {t("welcome.newProject")}
            </button>
            <button className="btn-secondary" onClick={handleOpen} disabled={loading}>
              {t("welcome.openProject")}
            </button>
          </div>
        ) : (
          <div className="create-form">
            <input
              type="text"
              placeholder={t("welcome.projectName")}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <div className="create-actions">
              <button className="btn-primary" onClick={handleCreate} disabled={loading || !projectName.trim()}>
                {loading ? t("common.creating") : t("common.create")}
              </button>
              <button className="btn-text" onClick={() => setShowCreate(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

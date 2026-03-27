import { useState } from "react";
import { useProjectStore } from "@/stores/useProjectStore";
import { save } from "@tauri-apps/plugin-dialog";

export function WelcomePage() {
  const { createProject, openProject, loading } = useProjectStore();
  const [projectName, setProjectName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const handleCreate = async () => {
    if (!projectName.trim()) return;
    const filePath = await save({
      title: "保存项目文件",
      defaultPath: `${projectName}.spprj`,
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
    });
    if (!filePath) return;
    await createProject(projectName.trim(), filePath);
  };

  const handleOpen = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "打开项目",
      filters: [{ name: "StatsPlayground Project", extensions: ["spprj"] }],
      multiple: false,
    });
    if (selected) {
      await openProject(selected as string);
    }
  };

  return (
    <div className="welcome-page">
      <div className="welcome-card">
        <h1>StatsPlayground</h1>
        <p className="subtitle">轻量级 · 跨平台 · 开源数据分析工具</p>
        <div className="version-tag">v0.1.0</div>

        {!showCreate ? (
          <div className="welcome-actions">
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              新建项目
            </button>
            <button className="btn-secondary" onClick={handleOpen} disabled={loading}>
              打开项目
            </button>
          </div>
        ) : (
          <div className="create-form">
            <input
              type="text"
              placeholder="项目名称"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <div className="create-actions">
              <button className="btn-primary" onClick={handleCreate} disabled={loading || !projectName.trim()}>
                {loading ? "创建中..." : "创建"}
              </button>
              <button className="btn-text" onClick={() => setShowCreate(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

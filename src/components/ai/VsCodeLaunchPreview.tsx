import { useTranslation } from "react-i18next";
import type { createMcpStore } from "@/stores/useMcpStore";

export function VsCodeLaunchPreview({ store }: { store: ReturnType<typeof createMcpStore> }) {
  const { t } = useTranslation();
  const plan = store((s) => s.launchPlan);
  const result = store((s) => s.launchResult);
  const error = store((s) => s.launchError);
  const busy = store((s) => s.launchBusy);
  const execute = store((s) => s.executeVsCodeLaunch);
  const cancel = store((s) => s.cancelVsCodeLaunch);
  return <>
    {plan && <div className="ai-section-block" role="dialog" aria-labelledby="vscode-launch-title">
      <h3 id="vscode-launch-title">{t("ai.mcpServer.vscode.preview", { folder: plan.workspaceDisplayName })}</h3>
      <p>{t(`ai.mcpServer.vscode.action.${plan.configurationAction}`)}</p>
      <p>{t(`ai.mcpServer.vscode.settings.${plan.settingsAction}`)}</p>
      {plan.currentEndpoint && <p>{t("ai.mcpServer.vscode.current")}: {plan.currentEndpoint}</p>}
      <p>{t("ai.mcpServer.vscode.proposed")}: {plan.settingsAction === "initializePersistent" ? t("ai.mcpServer.vscode.availablePort") : plan.proposedEndpoint}</p>
      <p>{t("ai.mcpServer.vscode.credential", { path: plan.configurationPath })}</p>
      <p>{t(`ai.mcpServer.vscode.git.${plan.gitProtection}`)}</p>
      <div className="ai-inline-actions">
        <button className="btn-primary" type="button" disabled={busy} onClick={() => void execute()}>
          {t(plan.confirmationRequired ? "ai.mcpServer.vscode.replace" : "ai.mcpServer.vscode.configure")}
        </button>
        <button className="btn-secondary" type="button" disabled={busy} onClick={cancel}>{t("common.cancel")}</button>
      </div>
    </div>}
    {result && <p role="status">{t(`ai.mcpServer.vscode.result.${result.launchResult}`, { folder: result.workspaceDisplayName })} ({result.configurationPath})</p>}
    {error && <p role="alert" className="ai-error-text">{error}</p>}
  </>;
}

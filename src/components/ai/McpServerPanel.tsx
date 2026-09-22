import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type createMcpStore } from "@/stores/useMcpStore";

type McpStoreHook = ReturnType<typeof createMcpStore>;

interface ActivityRow {
  key: string;
  requestId: string;
  label: string;
  status: string;
  meta: string;
}

function formatLiveRequestMeta(request: {
  stage: string;
  message?: string | null;
  percent?: number | null;
}): string {
  const parts = [request.stage];
  if (request.message) {
    parts.push(request.message);
  }
  if (typeof request.percent === "number") {
    parts.push(`${request.percent}%`);
  }
  return parts.join(" • ");
}

function maskToken(token: string | null): string {
  if (!token) return "Not available";
  return "•".repeat(Math.max(8, Math.min(token.length, 16)));
}

function buildClientConfig(endpoint: string, token: string, masked = false): string {
  return JSON.stringify(
    {
      mcpServers: {
        StatsPlayground: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${masked ? maskToken(token) : token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

async function defaultCopyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  }
}

export function McpServerPanel({
  store,
  onSelectSkills,
  copyText = defaultCopyText,
}: {
  store: McpStoreHook;
  onSelectSkills: () => void;
  copyText?: (value: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const status = store((state) => state.status);
  const auditEntries = store((state) => state.auditEntries);
  const authorizedRoots = store((state) => state.authorizedRoots);
  const commandRequests = store((state) => state.commandRequests);
  const pendingConfirmations = store((state) => state.pendingConfirmations);
  const settings = store((state) => state.settings);
  const settingsPort = store((state) => state.settingsPort);
  const settingsToken = store((state) => state.settingsToken);
  const settingsTokenVisible = store((state) => state.settingsTokenVisible);
  const settingsBusy = store((state) => state.settingsBusy);
  const lastError = store((state) => state.lastError);
  const setSettingsPort = store((state) => state.setSettingsPort);
  const setSettingsToken = store((state) => state.setSettingsToken);
  const toggleSettingsTokenVisible = store((state) => state.toggleSettingsTokenVisible);
  const generateSettingsToken = store((state) => state.generateSettingsToken);
  const saveSettings = store((state) => state.saveSettings);
  const startServer = store((state) => state.startServer);
  const stopServer = store((state) => state.stopServer);
  const authorizeRoot = store((state) => state.authorizeRoot);
  const revokeRoot = store((state) => state.revokeRoot);
  const allowRequest = store((state) => state.allowRequest);
  const denyRequest = store((state) => state.denyRequest);
  const [rootPath, setRootPath] = useState("");

  const activityRows = useMemo<ActivityRow[]>(() => {
    const liveRows = commandRequests
      .filter((request) => request.status === "queued"
        || request.status === "running"
        || request.status === "awaiting-confirmation"
        || request.status === "committing")
      .map((request) => ({
        key: `live:${request.requestId}`,
        requestId: request.requestId,
        label: request.command,
        status: request.status,
        meta: formatLiveRequestMeta(request),
      }));
    const auditRows = [...auditEntries]
      .reverse()
      .map((entry) => ({
        key: `audit:${entry.requestId}:${entry.timestamp}`,
        requestId: entry.requestId,
        label: entry.tool,
        status: entry.status,
        meta: entry.errorCode ?? (entry.durationMs == null ? entry.timestamp : `${entry.durationMs} ms`),
      }));
    return [...liveRows, ...auditRows].slice(0, 8);
  }, [auditEntries, commandRequests]);

  const canStart = status.state === "stopped";
  const canStop = status.state === "running";
  const canEditSettings = status.state === "stopped" && !settingsBusy;

  return (
    <section className="ai-panel ai-panel-server">
      <div className="ai-panel-header">
        <div>
          <h2>MCP Server</h2>
          <p>{t("ai.mcpServer.description", { defaultValue: "Manage the in-app MCP endpoint for external AI clients." })}</p>
        </div>
        <div className="ai-inline-actions">
          <button type="button" className="btn-secondary" onClick={() => void startServer()} disabled={!canStart}>
            {t("ai.mcpServer.start", { defaultValue: "Start server" })}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void stopServer()} disabled={!canStop}>
            {t("ai.mcpServer.stop", { defaultValue: "Stop server" })}
          </button>
        </div>
      </div>

      <div className="ai-panel-scroll">
      <div className="ai-summary-grid">
        <div className="ai-summary-item">
          <span className="ai-summary-label">{t("ai.mcpServer.state", { defaultValue: "State" })}</span>
          <span className={`ai-status-badge ai-status-${status.state}`} data-testid="mcp-server-state">{status.state}</span>
        </div>
        <div className="ai-summary-item">
          <span className="ai-summary-label">{t("ai.mcpServer.connections", { defaultValue: "Connections" })}</span>
          <span>{status.activeConnections}</span>
        </div>
        <div className="ai-summary-item">
          <span className="ai-summary-label">{t("ai.mcpServer.queued", { defaultValue: "Queued" })}</span>
          <span>{status.queuedRequests}</span>
        </div>
        <div className="ai-summary-item">
          <span className="ai-summary-label">{t("ai.mcpServer.running", { defaultValue: "Running" })}</span>
          <span>{status.runningRequests}</span>
        </div>
      </div>

      <div className="ai-section-block ai-settings-section">
        <div className="ai-section-header">
          <h3>{t("ai.mcpServer.settings", { defaultValue: "Settings" })}</h3>
        </div>
        <p className="ai-settings-hint">
          {settings === null
            ? t("ai.mcpServer.transientSettingsHint", {
              defaultValue: "No settings are saved. Start server can still use a transient configuration.",
            })
            : t("ai.mcpServer.savedSettingsHint", {
              defaultValue: "Saved settings are used the next time the MCP server starts.",
            })}
        </p>
        <div className="ai-settings-form">
          <div className="ai-settings-field">
            <label htmlFor="mcp-settings-port">
              {t("ai.mcpServer.port", { defaultValue: "Port" })}
            </label>
            <input
              id="mcp-settings-port"
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={settingsPort}
              onChange={(event) => setSettingsPort(event.target.value)}
              disabled={!canEditSettings}
            />
          </div>
          <div className="ai-settings-field">
            <label htmlFor="mcp-settings-token">
              {t("ai.mcpServer.savedToken", { defaultValue: "Token" })}
            </label>
            <div className="ai-settings-token-row">
              <input
                id="mcp-settings-token"
                type={settingsTokenVisible ? "text" : "password"}
                autoComplete="off"
                value={settingsToken}
                onChange={(event) => setSettingsToken(event.target.value)}
                disabled={!canEditSettings}
              />
              <button
                type="button"
                className="btn-sm"
                onClick={toggleSettingsTokenVisible}
                disabled={!canEditSettings}
              >
                {settingsTokenVisible
                  ? t("ai.mcpServer.hideToken", { defaultValue: "Hide token" })
                  : t("ai.mcpServer.revealToken", { defaultValue: "Reveal token" })}
              </button>
            </div>
          </div>
        </div>
        <div className="ai-inline-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void generateSettingsToken().catch(() => undefined)}
            disabled={!canEditSettings}
          >
            {t("ai.mcpServer.generateToken", { defaultValue: "Generate token" })}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void saveSettings().catch(() => undefined)}
            disabled={!canEditSettings}
          >
            {t("ai.mcpServer.saveSettings", { defaultValue: "Save settings" })}
          </button>
        </div>
      </div>

      <div className="ai-detail-grid">
        <div className="ai-detail-row">
          <div>
            <span className="ai-summary-label">{t("ai.mcpServer.endpoint", { defaultValue: "Endpoint" })}</span>
            <div className="ai-value-block">{status.endpoint ?? t("ai.mcpServer.notRunning", { defaultValue: "Not running" })}</div>
          </div>
          <button type="button" className="btn-sm" onClick={() => status.endpoint ? void copyText(status.endpoint) : undefined} disabled={!status.endpoint}>
            {t("ai.mcpServer.copyEndpoint", { defaultValue: "Copy endpoint" })}
          </button>
        </div>
        <div className="ai-detail-row">
          <div>
            <span className="ai-summary-label">{t("ai.mcpServer.token", { defaultValue: "Token" })}</span>
            <div className="ai-value-block" data-testid="mcp-token-value">{maskToken(status.token)}</div>
          </div>
          <button type="button" className="btn-sm" onClick={() => status.token ? void copyText(status.token) : undefined} disabled={!status.token}>
            {t("ai.mcpServer.copyToken", { defaultValue: "Copy token" })}
          </button>
        </div>
        <div className="ai-detail-row ai-detail-row-stack">
          <div>
            <span className="ai-summary-label">{t("ai.mcpServer.clientConfig", { defaultValue: "Client config" })}</span>
            <pre className="ai-config-preview">{status.endpoint && status.token
              ? buildClientConfig(status.endpoint, status.token, true)
              : t("ai.mcpServer.clientConfigHint", { defaultValue: "Start the server to generate a client configuration." })}</pre>
          </div>
          <button
            type="button"
            className="btn-sm"
            onClick={() => status.endpoint && status.token ? void copyText(buildClientConfig(status.endpoint, status.token)) : undefined}
            disabled={!status.endpoint || !status.token}
          >
            {t("ai.mcpServer.copyConfig", { defaultValue: "Copy client config" })}
          </button>
        </div>
      </div>

      <div className="ai-section-block">
        <div className="ai-section-header">
          <h3>{t("ai.mcpServer.authorizedRoots", { defaultValue: "Authorized output roots" })}</h3>
        </div>
        <div className="ai-inline-form">
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="/Users/ashton/Exports"
            aria-label={t("ai.mcpServer.authorizeRoot", { defaultValue: "Authorize output root" })}
          />
          <button
            type="button"
            className="btn-secondary"
            onClick={async () => {
              const trimmed = rootPath.trim();
              if (!trimmed) return;
              await authorizeRoot(trimmed);
              setRootPath("");
            }}
          >
            {t("ai.mcpServer.authorizeRootButton", { defaultValue: "Authorize root" })}
          </button>
        </div>
        <div className="ai-list">
          {authorizedRoots.length === 0 ? (
            <div className="empty-hint">{t("ai.mcpServer.noAuthorizedRoots", { defaultValue: "No output roots authorized for this session." })}</div>
          ) : authorizedRoots.map((grant) => (
            <div key={grant.rootId} className="ai-list-row">
              <span className="ai-list-primary">{grant.displayName}</span>
              <button type="button" className="btn-sm" aria-label={`Remove root ${grant.displayName}`} onClick={() => void revokeRoot(grant.rootId)}>
                {t("common.remove", { defaultValue: "Remove" })}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="ai-section-grid">
        <div className="ai-section-block">
          <div className="ai-section-header">
            <h3>{t("ai.mcpServer.confirmations", { defaultValue: "Pending confirmations" })}</h3>
          </div>
          <div className="ai-list">
            {pendingConfirmations.length === 0 ? (
              <div className="empty-hint">{t("ai.mcpServer.noConfirmations", { defaultValue: "No pending confirmations." })}</div>
            ) : pendingConfirmations.map((request) => (
              <div key={request.requestId} className="ai-list-row ai-list-row-stack">
                <div>
                  <div className="ai-list-primary">{request.command}</div>
                  <div className="ai-list-secondary">{request.requestId}</div>
                </div>
                <div className="ai-inline-actions">
                  <button type="button" className="btn-secondary" aria-label={`Allow ${request.requestId}`} onClick={() => void allowRequest(request.requestId)}>Allow</button>
                  <button type="button" className="btn-secondary" aria-label={`Deny ${request.requestId}`} onClick={() => void denyRequest(request.requestId)}>Deny</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="ai-section-block">
          <div className="ai-section-header">
            <h3>{t("ai.mcpServer.activity", { defaultValue: "Session activity" })}</h3>
          </div>
          <div className="ai-list">
            {activityRows.length === 0 ? (
              <div className="empty-hint">{t("ai.mcpServer.noActivity", { defaultValue: "No MCP activity in this session." })}</div>
            ) : activityRows.map((row) => (
              <div key={row.key} className="ai-list-row ai-list-row-stack" data-testid="mcp-activity-row">
                <div>
                  <div className="ai-list-primary">{row.label}</div>
                  <div className="ai-list-secondary">{row.requestId}</div>
                </div>
                <div className="ai-activity-meta">
                  <span className={`ai-status-badge ai-status-${row.status}`}>{row.status}</span>
                  <span className="ai-list-secondary">{row.meta}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="ai-panel-footer">
        <button type="button" className="btn-text" onClick={onSelectSkills}>
          {t("ai.skills.openPlaceholder", { defaultValue: "View Skills placeholder" })}
        </button>
        {lastError ? <span className="ai-error-text">{lastError}</span> : null}
      </div>
      </div>
    </section>
  );
}
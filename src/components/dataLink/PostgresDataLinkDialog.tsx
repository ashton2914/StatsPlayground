import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { dataLinkService } from "@/services/dataLinkService";
import { createServerConnectionDefinition } from "@/utils/serverConnectionDefaults";
import { createServerImportItems, hasServerImportNameConflict, runServerImportBatch, type ServerImportItem } from "@/utils/serverImportBatch";
import type {
  ConnectionCredentials,
  ConnectionDefinition,
  DataLinkError,
  PreviewResult,
  SourceColumn,
  SourceObjectRef,
} from "@/types/dataLink";

import "./dataLink.css";

interface PostgresDataLinkDialogProps {
  existingDatasetNames: string[];
  onClose: () => void;
  onImported: (targetName: string, connector: "postgresql" | "mysql") => Promise<void>;
}

function displayValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function normalizeError(error: unknown): DataLinkError {
  if (typeof error === "string") {
    return { category: "storage", message: error };
  }
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    const candidate = error as Partial<DataLinkError>;
    if (typeof candidate.category === "string" && typeof candidate.message === "string") {
      return candidate as DataLinkError;
    }
  }
  return { category: "query", message: "Database operation could not be completed" };
}

export function PostgresDataLinkDialog({ existingDatasetNames, onClose, onImported }: PostgresDataLinkDialogProps) {
  const { t } = useTranslation();
  const [definition, setDefinition] = useState<ConnectionDefinition>(() => createServerConnectionDefinition("postgresql", false));
  const [credentials, setCredentials] = useState<ConnectionCredentials>({
    username: "stats_reader",
    password: "",
  });
  const [connected, setConnected] = useState(false);
  const [objects, setObjects] = useState<SourceObjectRef[]>([]);
  const [selectedObject, setSelectedObject] = useState<SourceObjectRef | null>(null);
  const [columns, setColumns] = useState<SourceColumn[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [items, setItems] = useState<ServerImportItem[]>([]);
  const stopRequested = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const selectedItem = items.find((item) => item.object === selectedObject);
  const pendingItems = items.filter((item) => item.selected && item.status !== "completed");
  const nameConflict = hasServerImportNameConflict(items, [
    ...existingDatasetNames,
    ...items.filter((item) => item.status === "completed").map((item) => item.targetName),
  ]);
  const updateItem = (key: string, patch: Partial<ServerImportItem>) => {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  };
  const [busy, setBusy] = useState<"connection" | "objects" | "preview" | "import" | null>(null);
  const [error, setError] = useState<DataLinkError | null>(null);

  const setConnector = (connector: "postgresql" | "mysql") => {
    if (definition.connector === connector || busy !== null) return;
    setDefinition(createServerConnectionDefinition(connector, false));
    setCredentials({ username: "stats_reader", password: "" });
    setConnected(false);
    setObjects([]);
    setSelectedObject(null);
    setColumns([]);
    setPreview(null);
    setItems([]);
    setBatchProgress(null);
    setError(null);
  };

  const setDefinitionField = <K extends keyof ConnectionDefinition>(
    key: K,
    value: ConnectionDefinition[K],
  ) => {
    setDefinition((current) => ({ ...current, [key]: value }));
    setConnected(false);
    setObjects([]);
    setSelectedObject(null);
    setColumns([]);
    setPreview(null);
    setItems([]);
    setBatchProgress(null);
    setError(null);
  };

  const setCredentialField = <K extends keyof ConnectionCredentials>(
    key: K,
    value: ConnectionCredentials[K],
  ) => {
    setCredentials((current) => ({ ...current, [key]: value }));
    setConnected(false);
    setObjects([]);
    setSelectedObject(null);
    setColumns([]);
    setPreview(null);
    setItems([]);
    setBatchProgress(null);
    setError(null);
  };

  const testConnection = async () => {
    setBusy("connection");
    setError(null);
    try {
      await dataLinkService.testServerConnection(definition, credentials);
      setConnected(true);
    } catch (connectionError) {
      setConnected(false);
      setError(normalizeError(connectionError));
    } finally {
      setBusy(null);
    }
  };

  const discoverObjects = async () => {
    setBusy("objects");
    setError(null);
    try {
      const discovered = await dataLinkService.listServerObjects(definition, credentials);
      setObjects(discovered);
      setItems(createServerImportItems(discovered, existingDatasetNames));
      setBatchProgress(null);
      setSelectedObject(null);
      setPreview(null);
      setColumns([]);
      if (discovered.length > 0) await selectObject(discovered[0]);
    } catch (discoveryError) {
      setError(normalizeError(discoveryError));
    } finally {
      setBusy(null);
    }
  };

  const selectObject = async (object: SourceObjectRef) => {
    setSelectedObject(object);
    setColumns([]);
    setPreview(null);
    setBusy("preview");
    setError(null);
    try {
      const [nextColumns, nextPreview] = await Promise.all([
        dataLinkService.getServerSchema(definition, credentials, object),
        dataLinkService.previewServerObject(definition, credentials, object),
      ]);
      setColumns(nextColumns);
      setPreview(nextPreview);
    } catch (previewError) {
      setError(normalizeError(previewError));
    } finally {
      setBusy(null);
    }
  };

  const importSnapshot = async () => {
    if (busy || pendingItems.length === 0 || nameConflict) return;
    setBusy("import");
    setError(null);
    stopRequested.current = false;
    setStopping(false);
    setBatchProgress({ done: 0, total: pendingItems.length });
    try {
      await runServerImportBatch(
        pendingItems,
        async (item) => {
          const summary = await dataLinkService.importServerSnapshot(definition, credentials, item.object, item.targetName);
          if (summary.status !== "completed") throw summary.error ?? summary.status;
          return summary.totalRowsWritten;
        },
        (targetName) => onImported(targetName, definition.connector === "mysql" ? "mysql" : "postgresql"),
        (key, patch) => {
          updateItem(key, patch);
          if (patch.status === "completed" || patch.status === "failed") {
            setBatchProgress((current) => current ? { ...current, done: current.done + 1 } : current);
          }
        },
        () => stopRequested.current,
        (failure) => normalizeError(failure).message,
      );
    } finally {
      setBusy(null);
      setStopping(false);
    }
  };

  const isBusy = busy !== null;

  return (
    <div className="sp-dialog-overlay datalink-overlay" onMouseDown={isBusy ? undefined : onClose}>
      <div className="sp-dialog datalink-dialog postgres-datalink-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="datalink-header">
          <div>
            <h2>DataLink</h2>
            <p>{connected
              ? `${definition.host}:${definition.port} / ${definition.database}`
              : t("postgresDataLink.sessionOnly", { defaultValue: "Credentials remain in this dialog only" })}</p>
          </div>
          <div className="datalink-connector-switch" role="group" aria-label={t("dataLink.connector", { defaultValue: "Database type" })}>
            <button type="button" className={definition.connector === "postgresql" ? "active" : ""} aria-pressed={definition.connector === "postgresql"} onClick={() => setConnector("postgresql")} disabled={isBusy}>PostgreSQL</button>
            <button type="button" className={definition.connector === "mysql" ? "active" : ""} aria-pressed={definition.connector === "mysql"} onClick={() => setConnector("mysql")} disabled={isBusy}>MySQL</button>
          </div>
          <button className="datalink-close" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")} disabled={isBusy}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="postgres-datalink-body">
          <section className="postgres-connection-panel" aria-label={t("postgresDataLink.connection", { defaultValue: "Connection" })}>
            <div className="datalink-section-title">
              {t("postgresDataLink.connection", { defaultValue: "Connection" })}
              <span className={connected ? "is-connected" : ""}>{connected
                ? t("postgresDataLink.connected", { defaultValue: "Connected" })
                : t("postgresDataLink.notTested", { defaultValue: "Not tested" })}</span>
            </div>
            <div className="postgres-connection-grid">
              <label>
                <span>{t("postgresDataLink.host", { defaultValue: "Host" })}</span>
                <input value={definition.host} onChange={(event) => setDefinitionField("host", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.port", { defaultValue: "Port" })}</span>
                <input type="number" min={1} max={65535} value={definition.port} onChange={(event) => setDefinitionField("port", Number(event.target.value))} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.database", { defaultValue: "Database" })}</span>
                <input value={definition.database} onChange={(event) => setDefinitionField("database", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.username", { defaultValue: "Username" })}</span>
                <input value={credentials.username} autoComplete="username" onChange={(event) => setCredentialField("username", event.target.value)} disabled={isBusy} />
              </label>
              <label className="postgres-password-field">
                <span>{t("postgresDataLink.password", { defaultValue: "Password" })}</span>
                <input type="password" value={credentials.password} autoComplete="current-password" onChange={(event) => setCredentialField("password", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.timeout", { defaultValue: "Timeout (seconds)" })}</span>
                <input type="number" min={1} max={300} value={definition.connectTimeoutSeconds} onChange={(event) => setDefinitionField("connectTimeoutSeconds", Number(event.target.value))} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.tlsMode", { defaultValue: "TLS mode" })}</span>
                <select value={definition.tlsMode} onChange={(event) => setDefinitionField("tlsMode", event.target.value as ConnectionDefinition["tlsMode"])} disabled={isBusy}>
                  <option value="disabled">{t("postgresDataLink.tlsDisabled", { defaultValue: "Disabled" })}</option>
                  <option value="required">{t("postgresDataLink.tlsRequired", { defaultValue: "Required" })}</option>
                  <option value="verifyCa">{t("postgresDataLink.tlsVerifyCa", { defaultValue: "Verify CA" })}</option>
                  <option value="verifyFull">{t("postgresDataLink.tlsVerifyFull", { defaultValue: "Verify full" })}</option>
                </select>
              </label>
              {(definition.tlsMode === "verifyCa" || definition.tlsMode === "verifyFull") && (
                <label className="postgres-ca-field">
                  <span>{t("postgresDataLink.rootCertificate", { defaultValue: "Root CA certificates (PEM, optional)" })}</span>
                  <textarea
                    value={definition.tlsRootCertificatePem ?? ""}
                    onChange={(event) => setDefinitionField("tlsRootCertificatePem", event.target.value.trim() ? event.target.value : undefined)}
                    disabled={isBusy}
                    rows={3}
                    maxLength={262144}
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                </label>
              )}
            </div>
            <div className="postgres-connection-actions">
              <span><i className="fa-solid fa-shield-halved" aria-hidden="true" /> {t("postgresDataLink.credentialsNote", { defaultValue: "Password is discarded when this dialog closes" })}</span>
              <button className="btn-text" onClick={() => void testConnection()} disabled={isBusy || !credentials.password}>
                {busy === "connection"
                  ? t("postgresDataLink.testing", { defaultValue: "Testing..." })
                  : t("postgresDataLink.test", { defaultValue: "Test connection" })}
              </button>
              <button className="btn-primary" onClick={() => void discoverObjects()} disabled={isBusy || !connected}>
                {busy === "objects"
                  ? t("postgresDataLink.discovering", { defaultValue: "Discovering..." })
                  : t("postgresDataLink.discover", { defaultValue: "Discover objects" })}
              </button>
            </div>
          </section>

          {error && (
            <div className="datalink-error postgres-error" role="alert">
              <strong>{error.category}</strong>
              <span>{error.message}</span>
            </div>
          )}

          <div className="datalink-content postgres-browser">
            <aside className="datalink-objects">
              <div className="datalink-section-title">
                {t("dataLink.objects", { defaultValue: "Objects" })}
                <span>{objects.length}</span>
              </div>
              {items.length > 0 && (
                <label className="server-batch-select-all">
                  <input type="checkbox"
                    checked={items.some((item) => item.status !== "completed") && items.filter((item) => item.status !== "completed").every((item) => item.selected)}
                    ref={(element) => { if (element) element.indeterminate = pendingItems.length > 0 && pendingItems.length < items.filter((item) => item.status !== "completed").length; }}
                    disabled={isBusy || items.every((item) => item.status === "completed")}
                    onChange={(event) => setItems((current) => current.map((item) => item.status === "completed" ? item : { ...item, selected: event.target.checked }))}
                  />
                  {t("serverBatch.selectAll", { defaultValue: "Select all" })}
                  <span>{pendingItems.length}/{items.length}</span>
                </label>
              )}
              {objects.length === 0 ? (
                <div className="datalink-state">{connected
                  ? t("postgresDataLink.discoverPrompt", { defaultValue: "Discover accessible tables and views" })
                  : t("postgresDataLink.connectPrompt", { defaultValue: "Test the connection first" })}</div>
              ) : items.map((item) => {
                const { object, key } = item;
                const isActive = selectedObject?.catalog === object.catalog
                  && selectedObject?.schema === object.schema
                  && selectedObject?.name === object.name;
                return (
                  <div key={key} className={`datalink-object postgres-object server-batch-object${isActive ? " active" : ""}`}>
                    <input type="checkbox" checked={item.selected} disabled={isBusy || item.status === "completed"}
                      aria-label={t("serverBatch.selectObject", { name: object.name, defaultValue: "Select {{name}}" })}
                      onChange={(event) => updateItem(key, { selected: event.target.checked })} />
                    <i className={`fa-solid ${object.objectType === "view" ? "fa-eye" : "fa-table"}`} aria-hidden="true" />
                    <button className="datalink-object-preview" onClick={() => void selectObject(object)} disabled={isBusy}>
                      <span>{object.name}</span>
                      <small>{object.schema}</small>
                    </button>
                    <div className="server-batch-result" role="status">
                      {item.status !== "pending" && <span>{t(`serverBatch.${item.status}`, { defaultValue: item.status })}{item.rows !== undefined ? ` · ${item.rows.toLocaleString()}` : ""}</span>}
                      {item.message && <small className="server-batch-failure">{item.message}</small>}
                    </div>
                  </div>
                );
              })}
            </aside>

            <main className="datalink-preview">
              {busy === "preview" ? (
                <div className="datalink-state">{t("dataLink.loadingPreview", { defaultValue: "Loading preview..." })}</div>
              ) : preview ? (
                <>
                  <div className="datalink-preview-heading">
                    <div>
                      <h3>{preview.objectName}</h3>
                      <span>{t("dataLink.previewRows", { count: preview.rows.length, defaultValue: "{{count}} preview rows" })}</span>
                    </div>
                    {preview.truncated && <span>{t("dataLink.limited", { defaultValue: "Limited to 100 rows" })}</span>}
                  </div>
                  <div className="datalink-schema">
                    {columns.map((column) => (
                      <span key={column.name} title={`${column.sourceType}${column.nullable ? "" : " NOT NULL"}`}>
                        <strong>{column.name}</strong>
                        <small>{column.sourceType}{column.precision !== null ? `(${column.precision}${column.scale !== null ? `,${column.scale}` : ""})` : ""}{column.primaryKey ? " · PK" : ""}</small>
                      </span>
                    ))}
                  </div>
                  <label className="datalink-target-name">
                    <span>{t("dataLink.targetName", { defaultValue: "Target dataset name" })}</span>
                    <input
                      value={selectedItem?.targetName ?? ""}
                      onChange={(event) => { if (selectedItem) updateItem(selectedItem.key, { targetName: event.target.value }); }}
                      disabled={isBusy || selectedItem?.status === "completed"}
                    />
                  </label>
                  <div className="datalink-table-wrap">
                    <table className="datalink-table">
                      <thead><tr>{preview.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
                      <tbody>{preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>{row.map((value, columnIndex) => (
                          <td key={columnIndex} className={value === null ? "is-null" : ""}>{displayValue(value)}</td>
                        ))}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="datalink-state">{t("dataLink.selectObject", { defaultValue: "Select an object to preview" })}</div>
              )}
            </main>
          </div>
          {pendingItems.length > 0 && (
            <section className="server-batch-queue" aria-label={t("serverBatch.queue", { defaultValue: "Import queue" })}>
              {pendingItems.map((item) => (
                <label key={item.key}>
                  <span title={`${item.object.schema}.${item.object.name}`}>{item.object.name}</span>
                  <i className="fa-solid fa-arrow-right" aria-hidden="true" />
                  <input value={item.targetName} disabled={isBusy}
                    aria-label={t("serverBatch.targetFor", { name: item.object.name, defaultValue: "Target name for {{name}}" })}
                    onChange={(event) => updateItem(item.key, { targetName: event.target.value })} />
                </label>
              ))}
              {nameConflict && <div className="server-batch-failure" role="alert">{t("serverBatch.nameConflict", { defaultValue: "Target names must be nonempty, unique, and different from existing datasets." })}</div>}
            </section>
          )}
        </div>

        <footer className="datalink-actions">
          <span role="status">{batchProgress
            ? t("serverBatch.progress", { ...batchProgress, defaultValue: "{{done}} / {{total}} tables processed" })
            : t("serverBatch.selected", { count: pendingItems.length, defaultValue: "{{count}} selected" })}</span>
          {busy === "import" && <button className="btn-text" disabled={stopping} onClick={() => { stopRequested.current = true; setStopping(true); }}>
            <i className="fa-solid fa-stop" aria-hidden="true" /> {stopping
              ? t("serverBatch.stopping", { defaultValue: "Finishing current table..." })
              : t("serverBatch.stop", { defaultValue: "Stop after current table" })}
          </button>}
          <button className="btn-text" onClick={onClose} disabled={isBusy}>{t("serverBatch.close", { defaultValue: "Close" })}</button>
          <button
            className="btn-primary"
            onClick={() => void importSnapshot()}
            disabled={isBusy || !connected || pendingItems.length === 0 || nameConflict}
          >
            <i className="fa-solid fa-file-import" aria-hidden="true" />{" "}
            {busy === "import"
              ? t("postgresDataLink.importing", { defaultValue: "Importing..." })
              : t("serverBatch.importSelected", { count: pendingItems.length, defaultValue: "Import selected ({{count}})" })}
          </button>
        </footer>
      </div>
    </div>
  );
}

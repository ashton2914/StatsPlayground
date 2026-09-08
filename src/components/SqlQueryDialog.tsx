import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { dataService } from "@/services/dataService";
import { useProjectStore } from "@/stores/useProjectStore";
import type { DatasetMeta, SqlQueryResult } from "@/types/data";
import { folderAncestors, folderBaseName, normalizeFolderPath } from "@/stores/useFolderStore";
import {
  resolveProjectBasenameForKind,
  type ProjectBasenameValidationError,
} from "@/utils/projectFileNaming";
import "./sqlQueryDialog.css";

interface SqlQueryDialogProps {
  datasets: DatasetMeta[];
  tableFolders: Record<string, string>;
  onClose: () => void;
  onCreated: (dataset: DatasetMeta) => Promise<void> | void;
}

const PAGE_SIZE = 200;

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function breadcrumbs(path: string | null, rootLabel: string): string {
  if (!path) return rootLabel;
  return folderAncestors(path).map((segment) => folderBaseName(segment)).join(" / ");
}

function nextResultName(datasets: DatasetMeta[]): string {
  const base = "Query Result";
  const resolved = resolveProjectBasenameForKind(base, "table", datasets.map((dataset) => dataset.name));
  return resolved.error ? base : resolved.basename;
}

function validationMessage(t: (key: string, options?: Record<string, unknown>) => string, code: ProjectBasenameValidationError): string {
  if (code === "empty") {
    return t("sqlQuery.nameValidationEmpty");
  }
  if (code === "invalidChars") {
    return t("alert.invalidName.invalidChars", {
      defaultValue: "Name contains invalid characters: / \\ : * ? \" < > |",
    });
  }
  if (code === "edgeDots") {
    return t("alert.invalidName.edgeDots", {
      defaultValue: "Name cannot start or end with a dot or space.",
    });
  }
  if (code === "controlChars") {
    return t("alert.invalidName.controlChars", {
      defaultValue: "Name contains control characters.",
    });
  }
  return t("alert.invalidName.reserved", {
    defaultValue: "Name is reserved by Windows and cannot be used.",
  });
}

function renderCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function SqlQueryDialog({ datasets, tableFolders, onClose, onCreated }: SqlQueryDialogProps) {
  const { t } = useTranslation();
  const readOnly = useProjectStore((s) => s.readOnly);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [successfulSql, setSuccessfulSql] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const sqlRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const requestIdRef = useRef(0);

  const tableItems = useMemo(() => {
    return datasets
      .filter((dataset) => dataset.colCount > 0)
      .map((dataset) => {
        const folderPath = normalizeFolderPath(tableFolders[dataset.id] ?? null);
        return {
          dataset,
          folderPath,
          pathText: breadcrumbs(folderPath, t("sqlQuery.rootFolder")),
        };
      })
      .sort((a, b) => {
        const folderCompare = (a.folderPath ?? "").localeCompare(b.folderPath ?? "", undefined, { sensitivity: "base" });
        if (folderCompare !== 0) return folderCompare;
        return a.dataset.name.localeCompare(b.dataset.name, undefined, { sensitivity: "base" });
      });
  }, [datasets, tableFolders, t]);

  const createState = useMemo(() => {
    const trimmed = newTableName.trim();
    return { trimmed };
  }, [datasets, newTableName]);

  const trimmedSql = sql.trim();
  const totalPages = useMemo(() => (result ? Math.max(1, Math.ceil(result.totalRows / PAGE_SIZE)) : 1), [result]);
  const isPreviewCurrent = !!result && !!successfulSql && trimmedSql === successfulSql;
  const canRun = !busy && trimmedSql.length > 0;
  const canPageBack = !busy && !!result && page > 1;
  const canPageForward = !busy && !!result && page * PAGE_SIZE < result.totalRows;
  const canCreate = !busy && isPreviewCurrent && createState.trimmed.length > 0;
  const footerText = busy
    ? (showCreate ? t("sqlQuery.statusCreating") : t("sqlQuery.statusRunning"))
    : result
      ? t("sqlQuery.statusReady", { count: result.totalRows, page, totalPages })
      : t("sqlQuery.statusIdle");

  useEffect(() => {
    sqlRef.current?.focus();
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!showCreate) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [showCreate]);

  const insertTableName = (name: string) => {
    const textarea = sqlRef.current;
    const quoted = quoteIdentifier(name);
    if (!textarea) {
      setSql((current) => `${current}${quoted}`);
      return;
    }
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const nextValue = `${textarea.value.slice(0, start)}${quoted}${textarea.value.slice(end)}`;
    setSql(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const nextPos = start + quoted.length;
      textarea.setSelectionRange(nextPos, nextPos);
    });
  };

  const runQuery = async (nextPage = 1, paging = false) => {
    if (busyRef.current) return;
    const query = paging ? (successfulSql ?? trimmedSql) : trimmedSql;
    if (!query) {
      setError(t("sqlQuery.emptySql"));
      if (!paging) {
        setResult(null);
        setPage(1);
        setSuccessfulSql(null);
      }
      return;
    }

    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    setBusy(true);
    setError(null);
    if (!paging) {
      setShowCreate(false);
      setPage(1);
    }

    try {
      const nextResult = await dataService.executeSqlQuery(query, nextPage, PAGE_SIZE);
      if (requestId !== requestIdRef.current) return;
      setResult(nextResult);
      setPage(nextResult.page);
      if (!paging) {
        setSuccessfulSql(query);
      }
    } catch (error_) {
      if (requestId !== requestIdRef.current) return;
      setError(`${t("sqlQuery.queryErrorTitle")}: ${toMessage(error_)}`);
      if (!paging) {
        setResult(null);
        setPage(1);
        setSuccessfulSql(null);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const openCreatePrompt = () => {
    if (readOnly || !isPreviewCurrent || busy) return;
    setError(null);
    setNewTableName(nextResultName(datasets));
    setShowCreate(true);
  };

  const confirmCreate = async () => {
    if (readOnly || !isPreviewCurrent || busyRef.current || !successfulSql) return;
    if (!createState.trimmed) {
      setError(`${t("sqlQuery.validationErrorTitle")}: ${t("sqlQuery.nameValidationEmpty")}`);
      return;
    }
    const resolved = resolveProjectBasenameForKind(newTableName, "table", datasets.map((dataset) => dataset.name));
    if (resolved.error === "wrongExtension") {
      setError(`${t("sqlQuery.validationErrorTitle")}: ${t("sqlQuery.nameValidationWrongExtension", {
        defaultValue: "Use the {{expected}} extension for table names (not {{actual}}).",
        expected: resolved.expectedExtension,
        actual: resolved.actualExtension,
      })}`);
      return;
    }
    if (resolved.error) {
      setError(`${t("sqlQuery.validationErrorTitle")}: ${validationMessage(t, resolved.error)}`);
      return;
    }

    busyRef.current = true;
    const requestId = ++requestIdRef.current;
    setBusy(true);
    setCreating(true);
    setError(null);
    try {
      const meta = await dataService.createTableFromSqlQuery(successfulSql, resolved.basename);
      if (requestId !== requestIdRef.current) return;
      await onCreated(meta);
      onClose();
    } catch (error_) {
      if (requestId !== requestIdRef.current) return;
      setError(`${t("sqlQuery.duckdbErrorTitle")}: ${toMessage(error_)}`);
    } finally {
      if (requestId === requestIdRef.current) {
        busyRef.current = false;
        setBusy(false);
        setCreating(false);
      }
    }
  };

  const handleOverlayMouseDown = () => {
    if (!creating) onClose();
  };
  const resultRows = result?.rows ?? [];

  return (
    <div className="sp-dialog-overlay sql-query-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="sp-dialog sp-dialog-wide sql-query-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sp-dialog-title sql-query-title">{t("sqlQuery.title")}</div>
        <div className="sp-dialog-body sql-query-body">
          <div className="sql-query-layout">
            <aside className="sql-query-browser">
              <div className="sql-query-browser-head">
                <div className="sql-query-browser-title">{t("sqlQuery.browserTitle")}</div>
                <div className="sql-query-browser-hint">{t("sqlQuery.browserHint")}</div>
              </div>
              <div className="sql-query-browser-list">
                {tableItems.length === 0 ? (
                  <div className="sql-query-empty-hint">{t("sqlQuery.browserEmpty")}</div>
                ) : (
                  tableItems.map(({ dataset, pathText }) => (
                    <button
                      key={dataset.id}
                      type="button"
                      className="sql-query-table-item"
                      title={t("sqlQuery.tableBrowserTooltip")}
                      onDoubleClick={() => insertTableName(dataset.name)}
                    >
                      <span className="sql-query-table-name">{dataset.name}</span>
                      <span className="sql-query-table-path">{pathText}</span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <section className="sql-query-main">
              <div className="sql-query-toolbar">
                <button type="button" className="sql-query-toolbar-btn sql-query-toolbar-btn-primary" onClick={() => void runQuery(1, false)} disabled={!canRun} title={t("sqlQuery.runTooltip")} aria-label={t("sqlQuery.run")}>
                  <i className="fa-solid fa-play" aria-hidden="true" />
                  <span>{t("sqlQuery.run")}</span>
                </button>
                <button type="button" className="sql-query-toolbar-btn" onClick={() => { setSql(""); setResult(null); setSuccessfulSql(null); setPage(1); setError(null); setShowCreate(false); sqlRef.current?.focus(); }} disabled={busy} title={t("sqlQuery.clearTooltip")} aria-label={t("sqlQuery.clear")}>
                  <i className="fa-solid fa-eraser" aria-hidden="true" />
                  <span>{t("sqlQuery.clear")}</span>
                </button>
                <button type="button" className="sql-query-toolbar-btn" onClick={openCreatePrompt} disabled={readOnly || !isPreviewCurrent || busy} title={t("sqlQuery.createTooltip")} aria-label={t("sqlQuery.createTable")}>
                  <i className="fa-solid fa-table" aria-hidden="true" />
                  <span>{t("sqlQuery.createTable")}</span>
                </button>
                <span className="sql-query-toolbar-spacer" />
                <button type="button" className="sql-query-toolbar-btn sql-query-toolbar-btn-close" onClick={onClose} disabled={creating} title={t("sqlQuery.closeTooltip")} aria-label={t("sqlQuery.close")}>
                  <i className="fa-solid fa-xmark" aria-hidden="true" />
                  <span>{t("sqlQuery.close")}</span>
                </button>
              </div>

              <div className="sql-query-editor-shell">
                <div className="sp-dialog-label sql-query-editor-label">{t("sqlQuery.editorLabel")}</div>
                <textarea
                  ref={sqlRef}
                  className="sql-query-editor"
                  value={sql}
                  spellCheck={false}
                  placeholder={t("sqlQuery.editorPlaceholder")}
                  onChange={(event) => setSql(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      void runQuery(1, false);
                      return;
                    }
                    if (event.key === "Escape" && !showCreate) {
                      event.preventDefault();
                      onClose();
                    }
                  }}
                />
              </div>

              {showCreate && (
                <div className="sql-query-create-panel">
                  <div className="sql-query-create-field">
                    <label className="sp-dialog-label" htmlFor="sql-query-create-name">{t("sqlQuery.createPromptLabel")}</label>
                    <input
                      id="sql-query-create-name"
                      ref={nameRef}
                      className="sp-dialog-input sql-query-create-input"
                      value={newTableName}
                      placeholder={t("sqlQuery.createPromptPlaceholder")}
                      onChange={(event) => setNewTableName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (isPreviewCurrent) {
                            void confirmCreate();
                          }
                        }
                      }}
                    />
                    <div className="sql-query-create-hint">{t("sqlQuery.createPromptHint")}</div>
                  </div>
                  <button type="button" className="sql-query-toolbar-btn sql-query-toolbar-btn-primary" onClick={() => void confirmCreate()} disabled={!canCreate}>
                    <i className="fa-solid fa-circle-check" aria-hidden="true" />
                    <span>{t("sqlQuery.createPromptConfirm")}</span>
                  </button>
                  <button type="button" className="sql-query-toolbar-btn" onClick={() => setShowCreate(false)} disabled={busy}>
                    <i className="fa-solid fa-xmark" aria-hidden="true" />
                    <span>{t("sqlQuery.createPromptCancel")}</span>
                  </button>
                </div>
              )}

              <div className="sql-query-result-shell">
                <div className="sql-query-result-head">
                  <div className="sql-query-result-title">{t("sqlQuery.resultLabel")}</div>
                  <div className="sql-query-status-line">{footerText}</div>
                </div>
                <div className="sql-query-result-scroll">
                  {result ? (
                    result.columns.length > 0 ? (
                      <table className="sql-query-result-table">
                        <colgroup>
                          {result.columns.map((columnName) => (
                            <col key={columnName} style={{ width: `${Math.max(150, Math.min(280, 100 + columnName.length * 10))}px` }} />
                          ))}
                        </colgroup>
                        <thead>
                          <tr>
                            {result.columns.map((columnName, index) => (
                              <th key={columnName} className="sql-query-th">
                                <span className="sql-query-th-name">{columnName}</span>
                                <span className="sql-query-th-type">{result.columnTypes[index] ?? ""}</span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {resultRows.map((row, rowIndex) => (
                            <tr key={`${result.page}-${rowIndex}`}>
                              {row.map((cell, cellIndex) => {
                                const text = renderCell(cell);
                                return (
                                  <td key={cellIndex} className="sql-query-td" title={cell == null ? t("sqlQuery.nullValue") : text}>
                                    {cell == null ? (
                                      <span className="sql-query-null">{t("sqlQuery.nullValue")}</span>
                                    ) : text === "" ? (
                                      <span className="sql-query-empty-cell">&nbsp;</span>
                                    ) : (
                                      <span>{text}</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="sql-query-empty-result">{t("sqlQuery.emptyResult")}</div>
                    )
                  ) : (
                    <div className="sql-query-empty-result">{t("sqlQuery.emptyResult")}</div>
                  )}
                </div>
              </div>

              {error && <div className="sp-dialog-error sql-query-error">{error}</div>}
            </section>
          </div>

          <div className="sql-query-footer">
            <div className="sql-query-footer-meta">
              <span>{t("sqlQuery.totalRows", { count: result?.totalRows ?? 0 })}</span>
              <span>{t("sqlQuery.elapsed", { ms: result?.executionTimeMs ?? 0 })}</span>
              <span>{t("sqlQuery.page", { page, totalPages })}</span>
            </div>
            <div className="sql-query-page-controls">
              <button type="button" className="sql-query-toolbar-btn" onClick={() => void runQuery(page - 1, true)} disabled={!canPageBack} title={t("sqlQuery.previousTooltip")}>
                <i className="fa-solid fa-chevron-left" aria-hidden="true" />
                <span>{t("sqlQuery.previous")}</span>
              </button>
              <button type="button" className="sql-query-toolbar-btn" onClick={() => void runQuery(page + 1, true)} disabled={!canPageForward} title={t("sqlQuery.nextTooltip")}>
                <span>{t("sqlQuery.next")}</span>
                <i className="fa-solid fa-chevron-right" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
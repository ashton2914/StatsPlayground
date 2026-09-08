import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useDataLinkStore } from "@/stores/useDataLinkStore";
import type { ImportSummary, SqliteImportSelection } from "@/types/dataLink";

import "./dataLink.css";

interface SqliteDataLinkDialogProps {
  filePath: string;
  existingDatasetNames: string[];
  onClose: () => void;
  onImport: (selections: SqliteImportSelection[]) => Promise<ImportSummary>;
}

function displayValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SqliteDataLinkDialog({
    filePath,
    existingDatasetNames,
    onClose,
    onImport,
  }: SqliteDataLinkDialogProps) {
  const { t } = useTranslation();
  const {
    objects,
    selectedName,
    preview,
    selectedTables,
    targetNames,
    conflictStrategy,
    loadingObjects,
    loadingPreview,
    importing,
    summary,
    error,
    loadObjects,
    selectObject,
    applyConflictStrategy,
    toggleTable,
    setTargetName,
    setError,
  } = useDataLinkStore();
  const fileName = filePath.split(/[\\/]/).pop() ?? "SQLite";
  const existingNames = new Set(existingDatasetNames.map((name) => name.toLowerCase()));
  const tableObjects = objects.filter((object) => object.objectType === "table");
  const conflictCount = tableObjects.filter((object) => existingNames.has(object.name.toLowerCase())).length;

  useEffect(() => {
    void loadObjects(existingDatasetNames);
  }, [filePath]);

  const handleImport = async () => {
    const selections: SqliteImportSelection[] = tableObjects
      .filter((object) => selectedTables.has(object.name))
      .map((object) => ({
        sourceName: object.name,
        targetName: targetNames[object.name]?.trim() ?? "",
        action: conflictStrategy === "append" && existingNames.has(object.name.toLowerCase())
          ? "append" as const
          : "create" as const,
      }));
    if (conflictStrategy === "skip") {
      selections.push(...tableObjects
        .filter((object) => existingNames.has(object.name.toLowerCase()))
        .map((object) => ({
          sourceName: object.name,
          targetName: object.name,
          action: "skip" as const,
        })));
    }
    const createdTargets = selections
      .filter((selection) => selection.action === "create")
      .map((selection) => selection.targetName.toLowerCase());
    if (selections.some((selection) => !selection.targetName)) {
      setError(t("dataLink.targetRequired", { defaultValue: "Target names cannot be empty." }));
      return;
    }
    if (new Set(createdTargets).size !== createdTargets.length) {
      setError(t("dataLink.duplicateTarget", { defaultValue: "Target names must be unique." }));
      return;
    }
    if (createdTargets.some((name) => existingNames.has(name))) {
      setError(t("dataLink.targetExists", { defaultValue: "A selected target name already exists." }));
      return;
    }
    setError(null);
    try {
      await onImport(selections);
    } catch { /* The store owns and displays command errors. */ }
  };

  return (
    <div className="sp-dialog-overlay datalink-overlay" onMouseDown={importing ? undefined : onClose}>
      <div className="sp-dialog datalink-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="datalink-header">
          <div>
            <h2>{t("dataLink.title", { defaultValue: "SQLite DataLink" })}</h2>
            <p>{fileName}</p>
          </div>
          <button className="datalink-close" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")} disabled={importing}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="datalink-content">
          <aside className="datalink-objects">
            <div className="datalink-section-title">
              {t("dataLink.objects", { defaultValue: "Objects" })}
              <span>{objects.length}</span>
            </div>
            {loadingObjects ? (
              <div className="datalink-state">{t("common.loading")}</div>
            ) : objects.length === 0 ? (
              <div className="datalink-state">{t("dataLink.noObjects", { defaultValue: "No tables or views" })}</div>
            ) : objects.map((object) => {
              const selected = selectedTables.has(object.name);
              const conflicts = existingNames.has(object.name.toLowerCase());
              return (
                <div
                  key={object.name}
                  className={`datalink-object${selectedName === object.name ? " active" : ""}`}
                >
                  {object.objectType === "table" ? (
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => toggleTable(object.name, event.target.checked, existingDatasetNames)}
                      aria-label={t("dataLink.selectTable", { name: object.name, defaultValue: "Select {{name}}" })}
                    />
                  ) : <i className="fa-solid fa-eye" aria-hidden="true" />}
                  <button className="datalink-object-preview" onClick={() => void selectObject(object.name)}>
                    <span>{object.name}{conflicts && <em>{t("dataLink.exists", { defaultValue: "Exists" })}</em>}</span>
                    <small>{object.columns.length}</small>
                  </button>
                </div>
              );
            })}
          </aside>

          <main className="datalink-preview">
            {error && <div className="datalink-error">{error}</div>}
            {summary && (
              <div className={`datalink-summary is-${summary.status}`}>
                <i
                  className={`fa-solid ${summary.status === "completed" ? "fa-circle-check" : summary.status === "cancelled" ? "fa-circle-minus" : "fa-circle-xmark"}`}
                  aria-hidden="true"
                />
                <div>
                  <h3>{t(`dataLink.summary.${summary.status}`)}</h3>
                  <p>{t("dataLink.summary.counts", {
                    imported: summary.imported.length,
                    skipped: summary.skipped.length,
                    rows: summary.totalRowsWritten.toLocaleString(),
                  })}</p>
                  {summary.failedTable && <p>{t("dataLink.summary.failedTable", { table: summary.failedTable })}</p>}
                  {summary.error && <pre>{summary.error}</pre>}
                  {[...summary.imported, ...summary.skipped].length > 0 && (
                    <ul>
                      {summary.imported.map((table) => (
                        <li key={`${table.action}:${table.sourceName}`}>
                          <strong>{table.targetName}</strong>
                          <span>{t(`dataLink.summary.${table.action}`)} · {table.rowsWritten.toLocaleString()} {t("dataLink.summary.rows")}</span>
                        </li>
                      ))}
                      {summary.skipped.map((table) => (
                        <li key={`skip:${table.sourceName}`}>
                          <strong>{table.sourceName}</strong>
                          <span>{t("dataLink.summary.skip")}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
            {!summary && conflictCount > 0 && (
              <div className="datalink-conflicts">
                <strong>{t("dataLink.conflictsFound", { count: conflictCount, defaultValue: "{{count}} name conflicts" })}</strong>
                <div className="datalink-strategy" role="group" aria-label={t("dataLink.conflictStrategy", { defaultValue: "Conflict strategy" })}>
                  <button className={conflictStrategy === "rename" ? "active" : ""} onClick={() => applyConflictStrategy("rename", existingDatasetNames)}>
                    {t("dataLink.keepBoth", { defaultValue: "Keep both" })}
                  </button>
                  <button className={conflictStrategy === "append" ? "active" : ""} onClick={() => applyConflictStrategy("append", existingDatasetNames)}>
                    {t("dataLink.appendRows", { defaultValue: "Append rows" })}
                  </button>
                  <button className={conflictStrategy === "skip" ? "active" : ""} onClick={() => applyConflictStrategy("skip", existingDatasetNames)}>
                    {t("dataLink.skipExisting", { defaultValue: "Skip existing" })}
                  </button>
                </div>
              </div>
            )}
            {!summary && (loadingPreview ? (
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
                <div className="datalink-type-policy">
                  <i className="fa-solid fa-circle-info" aria-hidden="true" />
                  <span>{t("dataLink.typePolicy")}</span>
                </div>
                {selectedTables.has(preview.objectName) && (
                  <label className="datalink-target-name">
                    <span>{t("dataLink.targetName", { defaultValue: "Target dataset name" })}</span>
                    <input
                      value={targetNames[preview.objectName] ?? ""}
                      onChange={(event) => setTargetName(preview.objectName, event.target.value)}
                      disabled={importing || (conflictStrategy === "append" && existingNames.has(preview.objectName.toLowerCase()))}
                    />
                    {conflictStrategy === "append" && existingNames.has(preview.objectName.toLowerCase()) && (
                      <small>{t("dataLink.appendRequiresMatch", { defaultValue: "Column names, order, and types must match." })}</small>
                    )}
                  </label>
                )}
                <div className="datalink-schema">
                  {preview.columns.map((column) => (
                    <span key={column.name} title={`${column.sourceType}${column.nullable ? "" : " NOT NULL"}`}>
                      <strong>{column.name}</strong>
                      <small>{column.sourceType || "ANY"}{column.primaryKey ? " · PK" : ""}</small>
                    </span>
                  ))}
                </div>
                <div className="datalink-table-wrap">
                  <table className="datalink-table">
                    <thead><tr>{preview.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((value, columnIndex) => (
                            <td key={columnIndex} className={value === null ? "is-null" : ""}>{displayValue(value)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : !loadingObjects && <div className="datalink-state">{t("dataLink.selectObject", { defaultValue: "Select an object to preview" })}</div>)}
          </main>
        </div>

        <footer className="datalink-actions">
          {summary ? (
            <button className="btn-primary" onClick={onClose}>{t("dataLink.summary.close")}</button>
          ) : (
            <>
              <span>{t("dataLink.selectedCount", {
                count: selectedTables.size + (conflictStrategy === "skip" ? conflictCount : 0),
                defaultValue: "{{count}} tables selected",
              })}</span>
              <button className="btn-text" onClick={onClose} disabled={importing}>{t("common.cancel")}</button>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={loadingObjects || (selectedTables.size === 0 && !(conflictStrategy === "skip" && conflictCount > 0)) || importing}
              >
                {importing
                  ? t("dataLink.importing", { defaultValue: "Importing..." })
                  : t("dataLink.importSelected", { defaultValue: "Import selected" })}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

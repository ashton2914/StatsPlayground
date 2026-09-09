import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DatasetMeta } from "@/types/data.ts";

import {
  buildTableExportPlan,
  buildTableExportTree,
  selectionState,
  setTableSelection,
  type TableExportFolderNode,
  type TableExportFormat,
  type TableExportPlan,
} from "./tableExportModel.ts";

export interface TableExportDialogProps {
  datasets: readonly Pick<DatasetMeta, "id" | "name">[];
  tableFolders: Readonly<Record<string, string>>;
  projectName: string;
  onExport: (plan: TableExportPlan) => Promise<boolean>;
  onClose: () => void;
}

interface FolderCheckboxProps {
  checkedState: ReturnType<typeof selectionState>;
  label: string;
  onChange: (checked: boolean) => void;
}

function collectExpandedPaths(node: TableExportFolderNode): string[] {
  const paths: string[] = [];
  for (const folder of node.folders) {
    paths.push(folder.path, ...collectExpandedPaths(folder));
  }
  return paths;
}

function FolderCheckbox({ checkedState, label, onChange }: FolderCheckboxProps) {
  return (
    <label className="table-export-checkbox-label">
      <input
        ref={(node) => {
          if (node) {
            node.indeterminate = checkedState === "mixed";
          }
        }}
        type="checkbox"
        checked={checkedState === "checked"}
        aria-checked={checkedState === "mixed" ? "mixed" : checkedState === "checked" ? "true" : "false"}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function TableExportDialog({ datasets, tableFolders, projectName, onExport, onClose }: TableExportDialogProps) {
  const { t } = useTranslation();
  const tree = buildTableExportTree(datasets, tableFolders);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<TableExportFormat>("csv");
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set(collectExpandedPaths(tree)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const selectedCount = Array.from(selectedIds).filter((datasetId) => datasets.some((dataset) => dataset.id === datasetId)).length;
  const hasExportOptions = tree.folders.length > 0 || tree.tables.length > 0;

  const toggleFolder = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleSelection = (targetIds: readonly string[], checked: boolean) => {
    setSelectedIds((current) => setTableSelection(current, targetIds, checked));
    setError(null);
  };

  const handleExport = async () => {
    const plan = buildTableExportPlan({
      datasets,
      tableFolders,
      selectedIds,
      format,
      projectName,
    });

    if (!plan) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const exported = await onExport(plan);
      if (exported) {
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : t("tableExport.error", { defaultValue: "Export failed" }));
    } finally {
      setBusy(false);
    }
  };

  const renderFolder = (node: TableExportFolderNode, depth: number) => {
    const expanded = expandedPaths.has(node.path);
    const checkedState = selectionState(selectedIds, node.descendantIds);

    return (
      <div key={node.path} className="table-export-branch">
        <div className="table-export-row" style={{ paddingLeft: `${depth * 16}px` }}>
          <button
            type="button"
            className="table-export-toggle"
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => toggleFolder(node.path)}
          >
            <i className={`fa-solid ${expanded ? "fa-chevron-down" : "fa-chevron-right"}`} aria-hidden="true" />
          </button>
          <FolderCheckbox
            checkedState={checkedState}
            label={node.name}
            onChange={(checked) => toggleSelection(node.descendantIds, checked)}
          />
        </div>
        {expanded ? (
          <div>
            {node.folders.map((folder) => renderFolder(folder, depth + 1))}
            {node.tables.map((table) => (
              <div key={table.id} className="table-export-row table-export-row-leaf" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
                <span className="table-export-toggle-spacer" aria-hidden="true" />
                <label className="table-export-checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(table.id)}
                    onChange={(event) => toggleSelection([table.id], event.currentTarget.checked)}
                  />
                  <span>{table.name}</span>
                </label>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="sp-dialog-overlay" role="presentation">
      <section
        ref={dialogRef}
        className="sp-dialog table-export-dialog"
        aria-modal="true"
        role="dialog"
        aria-labelledby="table-export-title"
        tabIndex={-1}
      >
        <header className="sp-dialog-header">
          <div>
            <h2 id="table-export-title" className="sp-dialog-title">{t("tableExport.title", { defaultValue: "Export Tables" })}</h2>
            <p className="sp-dialog-subtitle">{t("tableExport.intro", { defaultValue: "Select the tables and output format to export." })}</p>
          </div>
        </header>

        <div className="sp-dialog-body table-export-layout">
          <div className="table-export-panel">
            <div className="table-export-panel-header">
              <h3>{t("tableExport.tablesTitle", { defaultValue: "Tables" })}</h3>
              <span className="table-export-selection-count">
                {selectedCount === 1
                  ? t("tableExport.selectedCount.one", { count: selectedCount, defaultValue: "{{count}} table selected" })
                  : t("tableExport.selectedCount.other", { count: selectedCount, defaultValue: "{{count}} tables selected" })}
              </span>
            </div>
            <div className="table-export-tree">
              {hasExportOptions ? (
                <>
                  {tree.folders.map((folder) => renderFolder(folder, 0))}
                  {tree.tables.map((table) => (
                    <div key={table.id} className="table-export-row table-export-row-leaf">
                      <span className="table-export-toggle-spacer" aria-hidden="true" />
                      <label className="table-export-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(table.id)}
                          onChange={(event) => toggleSelection([table.id], event.currentTarget.checked)}
                        />
                        <span>{table.name}</span>
                      </label>
                    </div>
                  ))}
                </>
              ) : (
                <p className="table-export-empty">{t("tableExport.empty", { defaultValue: "No tables available to export." })}</p>
              )}
            </div>
          </div>

          <div className="table-export-panel table-export-side-panel">
            <div className="table-export-panel-header">
              <h3>{t("tableExport.formatTitle", { defaultValue: "Format" })}</h3>
            </div>
            <div
              className="table-export-segmented"
              role="group"
              aria-label={t("tableExport.formatAriaLabel", { defaultValue: "Export format" })}
            >
              {([
                ["csv", t("tableExport.format.csv", { defaultValue: "CSV" })],
                ["sqlite", t("tableExport.format.sqlite", { defaultValue: "SQLite" })],
                ["sptb", t("tableExport.format.sptb", { defaultValue: "SPTB" })],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="table-export-segment"
                  aria-pressed={format === value}
                  onClick={() => {
                    setFormat(value);
                    setError(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="table-export-summary">
              <p>{t("tableExport.summarySelected", { count: selectedCount, defaultValue: "Selected: {{count}}" })}</p>
              <p>{t("tableExport.summaryProject", { projectName, defaultValue: "Project: {{projectName}}" })}</p>
            </div>

            {error ? <div className="table-export-error" role="alert">{error}</div> : null}
          </div>
        </div>

        <footer className="sp-dialog-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            {t("tableExport.cancel", { defaultValue: "Cancel" })}
          </button>
          <button type="button" className="btn-primary" disabled={selectedCount === 0 || busy} onClick={handleExport}>
            {busy
              ? t("tableExport.exporting", { defaultValue: "Exporting..." })
              : t("tableExport.export", { defaultValue: "Export" })}
          </button>
        </footer>
      </section>
    </div>
  );
}
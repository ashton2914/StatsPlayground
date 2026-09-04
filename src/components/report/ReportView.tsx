import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReportItem } from "@/types/report";

import {
  insertReportEmbed,
  ReportMarkdown,
  type ReportLinkOption,
} from "./ReportMarkdown";
import type { ReportEmbedRuntime } from "./ReportEmbed";
import "./report.css";

const NARROW_VIEW_QUERY = "(max-width: 900px)";

export type { ReportLinkOption } from "./ReportMarkdown";

interface ReportViewProps {
  item: ReportItem;
  tableOptions: readonly ReportLinkOption[];
  graphOptions: readonly ReportLinkOption[];
  fitYByXOptions: readonly ReportLinkOption[];
  tabulateOptions: readonly ReportLinkOption[];
  distributionOptions: readonly ReportLinkOption[];
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  embedRuntime?: ReportEmbedRuntime;
}

interface PendingSelection {
  start: number;
  end: number;
}

type MobilePane = "editor" | "preview";

export function ReportView({
  item,
  tableOptions,
  graphOptions,
  fitYByXOptions,
  tabulateOptions,
  distributionOptions,
  onMarkdownChange,
  readOnly = false,
  embedRuntime,
}: ReportViewProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const [isInsertMenuOpen, setIsInsertMenuOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(NARROW_VIEW_QUERY).matches;
  });
  const [mobilePane, setMobilePane] = useState<MobilePane>("editor");

  const groupedOptions = useMemo(() => [
    { kind: "table" as const, label: t("report.group.table", { defaultValue: "Tables" }), items: tableOptions },
    { kind: "graph" as const, label: t("report.group.graph", { defaultValue: "Graphs" }), items: graphOptions },
    { kind: "fitYByX" as const, label: t("report.group.fitYByX", { defaultValue: "Fit Y by X" }), items: fitYByXOptions },
    { kind: "tabulate" as const, label: t("report.group.tabulate", { defaultValue: "Tabulate" }), items: tabulateOptions },
    { kind: "distribution" as const, label: t("report.group.distribution", { defaultValue: "Distributions" }), items: distributionOptions },
  ].filter((group) => group.items.length > 0), [distributionOptions, fitYByXOptions, graphOptions, t, tableOptions, tabulateOptions]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia(NARROW_VIEW_QUERY);
    const handleChange = () => setIsNarrow(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!isInsertMenuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsInsertMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsInsertMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isInsertMenuOpen]);

  useEffect(() => {
    if (!pendingSelectionRef.current) {
      return;
    }
    const pendingSelection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    pendingSelectionRef.current = null;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
  }, [item.markdown]);

  const handleInsert = (kind: "table" | "graph" | "fitYByX" | "tabulate" | "distribution", documentId: string) => {
    const textarea = textareaRef.current;
    if (!textarea || readOnly) {
      return;
    }
    const result = insertReportEmbed(
      item.markdown,
      textarea.selectionStart,
      textarea.selectionEnd,
      { kind, documentId },
    );
    pendingSelectionRef.current = {
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    onMarkdownChange(result.markdown);
    setMobilePane("editor");
    setIsInsertMenuOpen(false);
  };

  return (
    <div className="sp-report-view">
      <div className="sp-panel-header sp-report-titlebar">
        <span className="sp-panel-header-title">{item.name}</span>
        {isNarrow ? (
          <div className="sp-report-mode-toggle" role="tablist" aria-label={t("report.modeLabel", { defaultValue: "Report view mode" })}>
            <button
              type="button"
              role="tab"
              id="report-editor-tab"
              aria-controls="report-editor-pane"
              aria-selected={mobilePane === "editor"}
              className={`sp-report-mode-btn${mobilePane === "editor" ? " is-active" : ""}`}
              onClick={() => setMobilePane("editor")}
            >
              {t("report.editor", { defaultValue: "Editor" })}
            </button>
            <button
              type="button"
              role="tab"
              id="report-preview-tab"
              aria-controls="report-preview-pane"
              aria-selected={mobilePane === "preview"}
              className={`sp-report-mode-btn${mobilePane === "preview" ? " is-active" : ""}`}
              onClick={() => setMobilePane("preview")}
            >
              {t("report.preview", { defaultValue: "Preview" })}
            </button>
          </div>
        ) : (
          <span className="sp-report-title-hint">{t("report.titleHint", { defaultValue: "Markdown editor with live preview" })}</span>
        )}
      </div>

      <div className="sp-report-panes">
        <section
          id="report-editor-pane"
          role={isNarrow ? "tabpanel" : undefined}
          aria-labelledby={isNarrow ? "report-editor-tab" : undefined}
          className={`sp-report-pane sp-report-editor-pane${isNarrow && mobilePane !== "editor" ? " is-hidden" : ""}`}
        >
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("report.editor", { defaultValue: "Editor" })}</span>
            <div className="sp-report-toolbar" ref={menuRef}>
              <button
                type="button"
                className="sp-report-insert-btn"
                title={t("report.insertTooltip", { defaultValue: "Insert project document" })}
                aria-haspopup="menu"
                aria-expanded={isInsertMenuOpen}
                onClick={() => setIsInsertMenuOpen((open) => !open)}
                disabled={readOnly || groupedOptions.length === 0}
              >
                <i className="fa-solid fa-plus" aria-hidden="true" />
                <span>{t("report.insert", { defaultValue: "Insert" })}</span>
              </button>
              {isInsertMenuOpen && (
                <div className="sp-report-insert-menu" role="menu">
                  {groupedOptions.map((group) => (
                    <div key={group.kind} className="sp-report-insert-group">
                      <div className="sp-report-insert-group-label">{group.label}</div>
                      {group.items.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitem"
                          className="sp-report-insert-item"
                          onClick={() => handleInsert(group.kind, option.id)}
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <textarea
            ref={textareaRef}
            className="sp-report-editor"
            aria-label={t("report.markdownEditorLabel", { defaultValue: "Markdown editor" })}
            spellCheck={false}
            value={item.markdown}
            onChange={(event) => onMarkdownChange(event.target.value)}
            placeholder={t("report.editorPlaceholder", { defaultValue: "Write Markdown here..." })}
            readOnly={readOnly}
          />
        </section>

        <section
          id="report-preview-pane"
          role={isNarrow ? "tabpanel" : undefined}
          aria-labelledby={isNarrow ? "report-preview-tab" : undefined}
          className={`sp-report-pane sp-report-preview-pane${isNarrow && mobilePane !== "preview" ? " is-hidden" : ""}`}
        >
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("report.preview", { defaultValue: "Preview" })}</span>
          </div>
          <div className="sp-report-preview">
            <ReportMarkdown
              markdown={item.markdown}
              embedRuntime={embedRuntime}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

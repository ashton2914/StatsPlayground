import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { useTranslation } from "react-i18next";

import type { ReportItem } from "@/types/report";

import type { ReportEmbedRuntime } from "./ReportEmbed";
import { ReportEmbedRuntimeContext, ReportProjectEmbed } from "./ReportProjectEmbed";
import { ReportToolbar } from "./ReportToolbar";
import {
  createReportEditorExtensions,
  parseReportEditorContent,
  serializeReportEditorContent,
} from "./reportEditorCodec";
import type { ReportLinkOption } from "./reportTypes";
import "./report.css";

export type { ReportLinkOption } from "./reportTypes";

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
  const currentMarkdownRef = useRef(item.markdown);
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;

  const extensions = useMemo(
    () => createReportEditorExtensions(
      ReportProjectEmbed,
      t("report.editorPlaceholder", { defaultValue: "Write Markdown here..." }),
    ),
    [t],
  );
  const editor = useEditor({
    extensions,
    content: parseReportEditorContent(item.markdown),
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: "sp-report-markdown-flow",
        "aria-label": t("report.editor", { defaultValue: "Report editor" }),
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      const markdown = serializeReportEditorContent(updatedEditor.getJSON());
      if (markdown === currentMarkdownRef.current) return;
      currentMarkdownRef.current = markdown;
      onMarkdownChangeRef.current(markdown);
    },
  });

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor || item.markdown === currentMarkdownRef.current) return;
    currentMarkdownRef.current = item.markdown;
    editor.commands.setContent(parseReportEditorContent(item.markdown), {
      emitUpdate: false,
    });
  }, [editor, item.markdown]);

  return (
    <div className={`sp-report-view${readOnly ? " is-read-only" : ""}`}>
      <div className="sp-panel-header sp-report-titlebar">
        <span className="sp-panel-header-title">{item.name}</span>
        <span className="sp-report-title-hint">
          {t("report.titleHint", { defaultValue: "Edit the report directly" })}
        </span>
      </div>
      {editor && !readOnly && (
        <ReportToolbar
          editor={editor}
          tableOptions={tableOptions}
          graphOptions={graphOptions}
          fitYByXOptions={fitYByXOptions}
          tabulateOptions={tabulateOptions}
          distributionOptions={distributionOptions}
        />
      )}
      <main className="sp-report-editor-surface">
        <ReportEmbedRuntimeContext.Provider value={embedRuntime}>
          <EditorContent editor={editor} />
        </ReportEmbedRuntimeContext.Provider>
      </main>
    </div>
  );
}
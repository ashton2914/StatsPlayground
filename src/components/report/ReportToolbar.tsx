import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";

import type { ReportEmbedKind } from "@/types/report";

import type { ReportLinkOption } from "./reportTypes";

interface ReportToolbarProps {
  editor: Editor;
  tableOptions: readonly ReportLinkOption[];
  graphOptions: readonly ReportLinkOption[];
  fitYByXOptions: readonly ReportLinkOption[];
  tabulateOptions: readonly ReportLinkOption[];
  distributionOptions: readonly ReportLinkOption[];
}

interface ToolbarButtonProps {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
}

function ToolbarButton({ label, icon, active = false, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`sp-report-tool-btn${active ? " is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <i className={icon} aria-hidden="true" />
    </button>
  );
}

export function ReportToolbar({
  editor,
  tableOptions,
  graphOptions,
  fitYByXOptions,
  tabulateOptions,
  distributionOptions,
}: ReportToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [isInsertOpen, setIsInsertOpen] = useState(false);
  const [isLinkOpen, setIsLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [, setRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setRevision((revision) => revision + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!isInsertOpen && !isLinkOpen) return undefined;
    const closePopovers = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) {
        setIsInsertOpen(false);
        setIsLinkOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsInsertOpen(false);
        setIsLinkOpen(false);
      }
    };
    window.addEventListener("pointerdown", closePopovers);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closePopovers);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isInsertOpen, isLinkOpen]);

  const groupedOptions = useMemo(() => [
    { kind: "table" as const, label: t("report.group.table", { defaultValue: "Tables" }), items: tableOptions },
    { kind: "graph" as const, label: t("report.group.graph", { defaultValue: "Graphs" }), items: graphOptions },
    { kind: "fitYByX" as const, label: t("report.group.fitYByX", { defaultValue: "Fit Y by X" }), items: fitYByXOptions },
    { kind: "tabulate" as const, label: t("report.group.tabulate", { defaultValue: "Tabulate" }), items: tabulateOptions },
    { kind: "distribution" as const, label: t("report.group.distribution", { defaultValue: "Distributions" }), items: distributionOptions },
  ].filter((group) => group.items.length > 0), [distributionOptions, fitYByXOptions, graphOptions, t, tableOptions, tabulateOptions]);

  const setTextStyle = (value: string) => {
    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }
    const level = Number(value.replace("heading", "")) as 1 | 2 | 3;
    editor.chain().focus().setHeading({ level }).run();
  };
  const currentTextStyle = editor.isActive("heading", { level: 1 })
    ? "heading1"
    : editor.isActive("heading", { level: 2 })
      ? "heading2"
      : editor.isActive("heading", { level: 3 })
        ? "heading3"
        : "paragraph";

  const insertProjectDocument = (kind: ReportEmbedKind, documentId: string) => {
    editor.chain().focus().insertContent([
      { type: "projectEmbed", attrs: { kind, documentId } },
      { type: "paragraph" },
    ]).run();
    setIsInsertOpen(false);
  };

  const openLink = () => {
    setLinkUrl(String(editor.getAttributes("link").href ?? ""));
    setIsLinkOpen(true);
    setIsInsertOpen(false);
  };
  const applyLink = () => {
    const href = linkUrl.trim();
    if (href) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    else editor.chain().focus().unsetLink().run();
    setIsLinkOpen(false);
  };

  return (
    <div className="sp-report-toolbar" ref={toolbarRef} aria-label={t("report.toolbar", { defaultValue: "Report formatting" })}>
      <label className="sp-report-style-control">
        <span className="sr-only">{t("report.textStyle", { defaultValue: "Text style" })}</span>
        <select
          aria-label={t("report.textStyle", { defaultValue: "Text style" })}
          value={currentTextStyle}
          onChange={(event) => setTextStyle(event.target.value)}
        >
          <option value="paragraph">{t("report.paragraph", { defaultValue: "Paragraph" })}</option>
          <option value="heading1">{t("report.heading1", { defaultValue: "Heading 1" })}</option>
          <option value="heading2">{t("report.heading2", { defaultValue: "Heading 2" })}</option>
          <option value="heading3">{t("report.heading3", { defaultValue: "Heading 3" })}</option>
        </select>
      </label>
      <span className="sp-report-tool-group">
        <ToolbarButton label={t("report.bold", { defaultValue: "Bold" })} icon="fa-solid fa-bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolbarButton label={t("report.italic", { defaultValue: "Italic" })} icon="fa-solid fa-italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolbarButton label={t("report.strike", { defaultValue: "Strikethrough" })} icon="fa-solid fa-strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} />
      </span>
      <span className="sp-report-tool-group">
        <ToolbarButton label={t("report.bulletList", { defaultValue: "Bullet list" })} icon="fa-solid fa-list-ul" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolbarButton label={t("report.orderedList", { defaultValue: "Numbered list" })} icon="fa-solid fa-list-ol" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolbarButton label={t("report.blockquote", { defaultValue: "Blockquote" })} icon="fa-solid fa-quote-left" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <ToolbarButton label={t("report.codeBlock", { defaultValue: "Code block" })} icon="fa-solid fa-code" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
      </span>
      <span className="sp-report-tool-popover-wrap">
        <ToolbarButton label={t("report.link", { defaultValue: "Link" })} icon="fa-solid fa-link" active={editor.isActive("link")} onClick={openLink} />
        {isLinkOpen && (
          <form className="sp-report-link-popover" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
            <input
              autoFocus
              type="text"
              value={linkUrl}
              aria-label={t("report.linkUrl", { defaultValue: "Link URL" })}
              placeholder="https://"
              onChange={(event) => setLinkUrl(event.target.value)}
            />
            <button type="submit">{t("report.apply", { defaultValue: "Apply" })}</button>
          </form>
        )}
      </span>
      <span className="sp-report-tool-popover-wrap sp-report-insert-wrap">
        <button
          type="button"
          className="sp-report-insert-btn"
          aria-label={t("report.insertTooltip", { defaultValue: "Insert project document" })}
          title={t("report.insertTooltip", { defaultValue: "Insert project document" })}
          aria-haspopup="menu"
          aria-expanded={isInsertOpen}
          disabled={groupedOptions.length === 0}
          onClick={() => { setIsInsertOpen((open) => !open); setIsLinkOpen(false); }}
        >
          <i className="fa-solid fa-plus" aria-hidden="true" />
          <span>{t("report.insert", { defaultValue: "Insert" })}</span>
        </button>
        {isInsertOpen && (
          <div className="sp-report-insert-menu" role="menu">
            {groupedOptions.map((group) => (
              <div key={group.kind} className="sp-report-insert-group">
                <div className="sp-report-insert-group-label">{group.label}</div>
                {group.items.map((option) => (
                  <button key={option.id} type="button" role="menuitem" className="sp-report-insert-item" onClick={() => insertProjectDocument(group.kind, option.id)}>
                    {option.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
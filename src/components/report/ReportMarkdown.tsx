import { Fragment, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";

import type { ReportDependency } from "@/types/report";
import type { ReportEmbedKind } from "@/types/report";
import { parseReportMarkdown } from "@/utils/reportParser";
import { formatReportEmbed } from "@/utils/reportParser";

import { ReportEmbed, type ReportEmbedRuntime } from "./ReportEmbed";

export interface InsertReportEmbedResult {
  markdown: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface ReportLinkOption {
  id: string;
  name: string;
}

export interface ReportMarkdownProps {
  markdown: string;
  embedRuntime?: ReportEmbedRuntime;
}

const EMBED_ICON_CLASS: Record<ReportEmbedKind, string> = {
  table: "fa-solid fa-table",
  graph: "fa-solid fa-chart-line",
  fitYByX: "fa-solid fa-chart-column",
  tabulate: "fa-solid fa-table-cells-large",
  distribution: "fa-solid fa-chart-bar",
};

function detectNewline(markdown: string): "\r\n" | "\n" | "\r" {
  if (markdown.includes("\r\n")) {
    return "\r\n";
  }
  if (markdown.includes("\n")) {
    return "\n";
  }
  if (markdown.includes("\r")) {
    return "\r";
  }
  return "\n";
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function startsWithLineBreak(text: string): boolean {
  return text.startsWith("\n") || text.startsWith("\r");
}

function leadingLineBreakLength(text: string): number {
  if (text.startsWith("\r\n")) {
    return 2;
  }
  if (text.startsWith("\n") || text.startsWith("\r")) {
    return 1;
  }
  return 0;
}

export function insertReportEmbed(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  dependency: ReportDependency,
): InsertReportEmbedResult {
  const directive = formatReportEmbed(dependency);
  const before = markdown.slice(0, selectionStart);
  const after = markdown.slice(selectionEnd);

  if (markdown.length === 0) {
    return {
      markdown: directive,
      selectionStart: directive.length,
      selectionEnd: directive.length,
    };
  }

  const newline = detectNewline(markdown);
  const prefix = before.length > 0 && !endsWithLineBreak(before) ? newline : "";
  const suffix = after.length > 0 && !startsWithLineBreak(after) ? newline : "";
  const inserted = `${prefix}${directive}${suffix}`;
  const nextMarkdown = `${before}${inserted}${after}`;
  const caret = `${before}${inserted}`.length + (suffix.length > 0 ? 0 : leadingLineBreakLength(after));

  return {
    markdown: nextMarkdown,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

export function ReportMarkdown({
  markdown,
  embedRuntime,
}: ReportMarkdownProps) {
  const { t } = useTranslation();

  const tokens = useMemo(() => parseReportMarkdown(markdown), [markdown]);

  if (markdown.trim().length === 0) {
    return <p className="sp-report-preview-empty">{t("report.previewEmpty", { defaultValue: "Preview updates as you type." })}</p>;
  }

  return (
    <div className="sp-report-markdown-flow">
      {tokens.map((token, index) => {
        if (token.type === "markdown") {
          return (
            <ReactMarkdown
              key={`markdown:${index}`}
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: ({ alt }) => <span className="sp-report-blocked-image">{alt ?? ""}</span>,
              }}
            >
              {token.markdown}
            </ReactMarkdown>
          );
        }
        return (
          <Fragment key={`embed:${index}`}>
            <div className="sp-report-embed-token-icon" data-kind={token.dependency.kind}>
              <i className={EMBED_ICON_CLASS[token.dependency.kind]} aria-hidden="true" />
            </div>
            <ReportEmbed dependency={token.dependency} runtime={embedRuntime} />
          </Fragment>
        );
      })}
    </div>
  );
}
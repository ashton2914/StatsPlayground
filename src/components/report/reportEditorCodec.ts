import type { AnyExtension, Extensions, JSONContent } from "@tiptap/core";
import { Node } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import type { ReportDependency, ReportEmbedKind } from "@/types/report";
import { formatReportEmbed, parseReportMarkdown } from "@/utils/reportParser";

export const ReportProjectEmbedNode = Node.create({
  name: "projectEmbed",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: null },
      documentId: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-report-project-embed]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-report-project-embed": "" }];
  },
});

const UnsupportedMarkdown = Node.create({
  name: "unsupportedMarkdown",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "pre[data-report-unsupported-markdown]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const displaySource = String(node.attrs.source ?? "")
      .replace(/^(?:\r\n|\r|\n)+/, "")
      .replace(/(?:\r\n|\r|\n)+$/, "");
    return [
      "pre",
      { ...HTMLAttributes, "data-report-unsupported-markdown": "" },
      displaySource,
    ];
  },
});

function isAllowedReportLink(url: string): boolean {
  const value = url.trim();
  if (!value || value.startsWith("//")) return false;
  const scheme = value.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase();
  return scheme ? ["http", "https", "mailto"].includes(scheme) : true;
}

export function createReportEditorExtensions(
  projectEmbedExtension?: AnyExtension,
  placeholder = "",
): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      protocols: ["http", "https", "mailto"],
      isAllowedUri: (url) => isAllowedReportLink(url),
    }),
    TableKit,
    projectEmbedExtension ?? ReportProjectEmbedNode,
    UnsupportedMarkdown,
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
}

function createMarkdownManager(): MarkdownManager {
  return new MarkdownManager({ extensions: createReportEditorExtensions() });
}

function embedNode(kind: ReportEmbedKind, documentId: string): JSONContent {
  return {
    type: "projectEmbed",
    attrs: { kind, documentId },
  };
}

const UNSUPPORTED_MARKDOWN_LINE = /^(?:\s*[-+*]\s+\[[ xX]\]\s|\s*!\[[^\]]*\]\([^)]*\)\s*$|\s*<[^>]+>\s*$)/;

function containsUnsafeMarkdownLink(line: string): boolean {
  for (const match of line.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    if (!isAllowedReportLink(match[1])) return true;
  }
  return false;
}

function parseMarkdownWithUnsupportedSources(
  manager: MarkdownManager,
  markdown: string,
): JSONContent[] {
  const content: JSONContent[] = [];
  let supportedSource = "";

  const flushSupportedSource = () => {
    if (!supportedSource) return;
    content.push(...(manager.parse(supportedSource).content ?? []));
    supportedSource = "";
  };

  for (const match of markdown.matchAll(/.*(?:\r\n|\r|\n|$)/g)) {
    const source = match[0];
    if (!source) continue;
    const line = source.replace(/(?:\r\n|\r|\n)$/, "");
    if (UNSUPPORTED_MARKDOWN_LINE.test(line) || containsUnsafeMarkdownLink(line)) {
      const leadingNewlines = supportedSource.match(/((?:\r\n|\r|\n)+)$/)?.[1] ?? "";
      supportedSource = supportedSource.slice(0, supportedSource.length - leadingNewlines.length);
      flushSupportedSource();
      const previousNode = content[content.length - 1];
      if (previousNode?.type === "unsupportedMarkdown") {
        previousNode.attrs = {
          source: `${String(previousNode.attrs?.source ?? "")}${leadingNewlines}${source}`,
        };
      } else {
        content.push({
          type: "unsupportedMarkdown",
          attrs: { source: `${leadingNewlines}${source}` },
        });
      }
    } else if (line.length === 0 && content[content.length - 1]?.type === "unsupportedMarkdown" && !supportedSource) {
      const previousNode = content[content.length - 1];
      previousNode!.attrs = {
        source: `${String(previousNode!.attrs?.source ?? "")}${source}`,
      };
    } else {
      supportedSource += source;
    }
  }
  flushSupportedSource();

  return content;
}

export function parseReportEditorContent(markdown: string): JSONContent {
  const manager = createMarkdownManager();
  const content: JSONContent[] = [];

  for (const token of parseReportMarkdown(markdown)) {
    if (token.type === "embed") {
      content.push(embedNode(token.dependency.kind, token.dependency.documentId));
      continue;
    }
    content.push(...parseMarkdownWithUnsupportedSources(manager, token.markdown));
  }

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function projectDependency(node: JSONContent): ReportDependency {
  return {
    kind: node.attrs?.kind as ReportEmbedKind,
    documentId: String(node.attrs?.documentId ?? ""),
  };
}

export function serializeReportEditorContent(document: JSONContent): string {
  const manager = createMarkdownManager();
  const sections: Array<{ type: "markdown" | "projectEmbed" | "unsupportedMarkdown"; source: string }> = [];
  let ordinaryNodes: JSONContent[] = [];

  const flushOrdinaryNodes = () => {
    if (ordinaryNodes.length === 0) return;
    sections.push({
      type: "markdown",
      source: manager.serialize({ type: "doc", content: ordinaryNodes }).trimEnd(),
    });
    ordinaryNodes = [];
  };

  for (const node of document.content ?? []) {
    if (node.type === "projectEmbed") {
      flushOrdinaryNodes();
      sections.push({ type: "projectEmbed", source: formatReportEmbed(projectDependency(node)) });
    } else if (node.type === "unsupportedMarkdown") {
      flushOrdinaryNodes();
      sections.push({ type: "unsupportedMarkdown", source: String(node.attrs?.source ?? "") });
    } else {
      ordinaryNodes.push(node);
    }
  }
  flushOrdinaryNodes();

  return sections.reduce((markdown, section, index) => {
    if (index === 0) return section.source;
    const previousSection = sections[index - 1];
    if (section.type === "unsupportedMarkdown" || previousSection.type === "unsupportedMarkdown") {
      return `${markdown}${section.source}`;
    }
    return `${markdown}\n\n${section.source}`;
  }, "");
}
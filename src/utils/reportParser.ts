import type { ReportDependency, ReportEmbedKind, ReportToken } from "@/types/report";

const REPORT_EMBED_RE = /^\{\{sp-embed kind="(table|graph|fitYByX|tabulate|distribution)" id="([^"{}\s\x00-\x1f\x7f]+)"\}\}$/;

interface FenceState {
  marker: "`" | "~";
  length: number;
}

function isFenceLine(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const markerText = match[1];
  const marker = markerText[0] as FenceState["marker"];
  if (marker === "`" && match[2].includes("`")) return null;
  return { marker, length: markerText.length };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const match = line.match(/^ {0,3}((`+)|(~+))[ \t]*$/);
  if (!match) return false;
  const markerText = match[1];
  return markerText[0] === fence.marker && markerText.length >= fence.length;
}

function splitLineSegments(text: string): Array<{ content: string; newline: string }> {
  const segments: Array<{ content: string; newline: string }> = [];
  let index = 0;
  while (index < text.length) {
    const carriageReturn = text.indexOf("\r", index);
    const lineFeed = text.indexOf("\n", index);
    let newlineIndex = -1;
    let newline = "";

    if (carriageReturn !== -1 && (lineFeed === -1 || carriageReturn < lineFeed)) {
      newlineIndex = carriageReturn;
      newline = text[carriageReturn + 1] === "\n" ? "\r\n" : "\r";
    } else if (lineFeed !== -1) {
      newlineIndex = lineFeed;
      newline = "\n";
    }

    if (newlineIndex === -1) {
      segments.push({ content: text.slice(index), newline: "" });
      break;
    }

    segments.push({ content: text.slice(index, newlineIndex), newline });
    index = newlineIndex + newline.length;
  }

  if (text.length === 0) {
    return [];
  }

  return segments;
}

function flushMarkdown(tokens: ReportToken[], buffer: string): string {
  if (!buffer) return "";
  const last = tokens[tokens.length - 1];
  if (last?.type === "markdown") {
    last.markdown += buffer;
  } else {
    tokens.push({ type: "markdown", markdown: buffer });
  }
  return "";
}

export function formatReportEmbed(dependency: ReportDependency): string {
  return `{{sp-embed kind="${dependency.kind}" id="${dependency.documentId}"}}`;
}

export function parseReportMarkdown(markdown: string): ReportToken[] {
  const tokens: ReportToken[] = [];
  let buffer = "";
  let fence: FenceState | null = null;

  for (const segment of splitLineSegments(markdown)) {
    const line = segment.content;
    const lineText = `${line}${segment.newline}`;

    if (!fence) {
      const directiveMatch = line.match(REPORT_EMBED_RE);
      if (directiveMatch) {
        buffer = flushMarkdown(tokens, buffer);
        tokens.push({
          type: "embed",
          dependency: {
            kind: directiveMatch[1] as ReportEmbedKind,
            documentId: directiveMatch[2],
          },
        });
        continue;
      }
    }

    buffer += lineText;

    if (fence) {
      if (isFenceClose(line, fence)) {
        fence = null;
      }
    } else {
      fence = isFenceLine(line);
    }
  }

  flushMarkdown(tokens, buffer);
  return tokens;
}

export function extractReportDependencies(markdown: string): ReportDependency[] {
  const seen = new Set<string>();
  const dependencies: ReportDependency[] = [];

  for (const token of parseReportMarkdown(markdown)) {
    if (token.type !== "embed") continue;
    const key = `${token.dependency.kind}\0${token.dependency.documentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push(token.dependency);
  }

  return dependencies;
}
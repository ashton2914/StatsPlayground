import assert from "node:assert/strict";

import {
  parseReportEditorContent,
  serializeReportEditorContent,
} from "../src/components/report/reportEditorCodec.ts";

const markdown = [
  "# Live Report",
  "",
  "Before **bold** text.",
  "",
  '{{sp-embed kind="graph" id="graph-1"}}',
  "",
  "After.",
].join("\n");

const document = parseReportEditorContent(markdown);

assert.equal(document.type, "doc");
assert.deepEqual(
  document.content?.find((node) => node.type === "projectEmbed")?.attrs,
  { kind: "graph", documentId: "graph-1" },
  "canonical project directives must become projectEmbed atoms",
);
assert.equal(
  serializeReportEditorContent(document),
  markdown,
  "supported Report Markdown must survive an editor round trip",
);

console.log("report editor codec contract passed");

const emptyDocument = parseReportEditorContent("");
assert.deepEqual(emptyDocument.content, [{ type: "paragraph" }]);
assert.equal(serializeReportEditorContent(emptyDocument), "");

const supportedMarkdown = [
  "## Formatting",
  "",
  "Text with **bold**, *italic*, ~~strike~~, and [link](https://example.com).",
  "",
  "- first",
  "- second",
  "",
  "1. one",
  "2. two",
  "",
  "> quote",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");

const supportedDocument = parseReportEditorContent(supportedMarkdown);
const supportedNodeTypes = new Set(supportedDocument.content?.map((node) => node.type));
for (const nodeType of ["heading", "paragraph", "bulletList", "orderedList", "blockquote", "codeBlock", "table"]) {
  assert.equal(supportedNodeTypes.has(nodeType), true, `supported Markdown must preserve ${nodeType}`);
}
const canonicalSupportedMarkdown = serializeReportEditorContent(supportedDocument);
assert.equal(
  serializeReportEditorContent(parseReportEditorContent(canonicalSupportedMarkdown)),
  canonicalSupportedMarkdown,
  "supported Markdown serialization must stabilize after canonicalization",
);

const fencedDirective = [
  "```text",
  '{{sp-embed kind="graph" id="inside-code"}}',
  "```",
].join("\n");
assert.equal(
  parseReportEditorContent(fencedDirective).content?.some((node) => node.type === "projectEmbed"),
  false,
  "embed-like text inside a code fence must remain code",
);
assert.equal(serializeReportEditorContent(parseReportEditorContent(fencedDirective)), fencedDirective);

function collectLinkHrefs(node: typeof document): string[] {
  const hrefs = node.marks
    ?.filter((mark) => mark.type === "link")
    .map((mark) => String(mark.attrs?.href)) ?? [];
  return [...hrefs, ...(node.content?.flatMap(collectLinkHrefs) ?? [])];
}

assert.deepEqual(
  collectLinkHrefs(parseReportEditorContent("[Web](https://example.com) [Project](./reports/one)")),
  ["https://example.com", "./reports/one"],
  "approved external and project-relative links must remain active",
);
assert.deepEqual(
  collectLinkHrefs(parseReportEditorContent("[Unsafe](javascript:alert(1))")),
  [],
  "script URLs must not enter the editor document",
);

for (const unsupportedSource of [
  "- [ ] unchecked task",
  "![Remote chart](https://example.invalid/pixel.png)",
  '<img src=x onerror="window.__reportXss = true" />',
]) {
  const unsupportedDocument = parseReportEditorContent(unsupportedSource);
  assert.equal(
    unsupportedDocument.content?.[0]?.type,
    "unsupportedMarkdown",
    "unsupported Markdown must remain visible as source",
  );
  assert.equal(
    serializeReportEditorContent(unsupportedDocument),
    unsupportedSource,
    "unsupported Markdown source must survive byte-for-byte",
  );
}

for (const mixedUnsupportedSource of [
  "Before\n![Remote](https://example.invalid/pixel.png)\nAfter",
  "Before\n\n- [ ] first\n- [x] second\n\nAfter",
]) {
  assert.equal(
    serializeReportEditorContent(parseReportEditorContent(mixedUnsupportedSource)),
    mixedUnsupportedSource,
    "unsupported lines must preserve their exact position and surrounding newlines",
  );
}

console.log("report editor codec compatibility passed");
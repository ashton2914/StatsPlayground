import assert from "node:assert/strict";

import { insertReportEmbed } from "../src/components/report/ReportMarkdown.tsx";
import { formatReportEmbed } from "../src/utils/reportParser.ts";
import type { ReportDependency } from "../src/types/report.ts";

const dependency: ReportDependency = {
  kind: "graph",
  documentId: "graph-7",
};

const directive = formatReportEmbed(dependency);

assert.deepEqual(insertReportEmbed("", 0, 0, dependency), {
  markdown: directive,
  selectionStart: directive.length,
  selectionEnd: directive.length,
});

assert.deepEqual(
  insertReportEmbed("Summary", 7, 7, dependency),
  {
    markdown: `Summary\n${directive}`,
    selectionStart: (`Summary\n${directive}`).length,
    selectionEnd: (`Summary\n${directive}`).length,
  },
  "inserting after plain text should move the embed to its own line",
);

assert.deepEqual(
  insertReportEmbed("Alpha\nBeta", 2, 8, dependency),
  {
    markdown: `Al\n${directive}\nta`,
    selectionStart: (`Al\n${directive}\n`).length,
    selectionEnd: (`Al\n${directive}\n`).length,
  },
  "replacing a selection should normalize both sides to line boundaries",
);

assert.deepEqual(
  insertReportEmbed("Alpha\r\nBeta", 5, 5, dependency),
  {
    markdown: `Alpha\r\n${directive}\r\nBeta`,
    selectionStart: (`Alpha\r\n${directive}\r\n`).length,
    selectionEnd: (`Alpha\r\n${directive}\r\n`).length,
  },
  "CRLF documents should preserve their newline style around inserted embeds",
);

console.log("report editor contract passed");
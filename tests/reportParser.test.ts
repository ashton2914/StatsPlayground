import assert from "node:assert/strict";

import {
  extractReportDependencies,
  parseReportMarkdown,
} from "../src/utils/reportParser.ts";

const source = [
  "Before",
  '{{sp-embed kind="graph" id="graph-1"}}',
  "After",
].join("\n");

assert.deepEqual(parseReportMarkdown(source), [
  { type: "markdown", markdown: "Before\n" },
  { type: "embed", dependency: { kind: "graph", documentId: "graph-1" } },
  { type: "markdown", markdown: "After" },
]);

assert.deepEqual(
  parseReportMarkdown(
    [
      "alpha",
      '{{sp-embed kind="table" id="table-1"}}',
      "beta",
      '{{sp-embed kind="table" id="table-1"}}',
      '```ts',
      '{{sp-embed kind="graph" id="ignored-fence"}}',
      "```",
      "gamma",
      "~~~",
      '{{sp-embed kind="fitYByX" id="ignored-fence-2"}}',
      "~~~",
      '{{sp-embed kind="tabulate" id="tab-1"}}',
      "delta",
    ].join("\n"),
  ),
  [
    { type: "markdown", markdown: "alpha\n" },
    { type: "embed", dependency: { kind: "table", documentId: "table-1" } },
    { type: "markdown", markdown: "beta\n" },
    { type: "embed", dependency: { kind: "table", documentId: "table-1" } },
    { type: "markdown", markdown: "```ts\n{{sp-embed kind=\"graph\" id=\"ignored-fence\"}}\n```\ngamma\n~~~\n{{sp-embed kind=\"fitYByX\" id=\"ignored-fence-2\"}}\n~~~\n" },
    { type: "embed", dependency: { kind: "tabulate", documentId: "tab-1" } },
    { type: "markdown", markdown: "delta" },
  ],
);

assert.deepEqual(
  parseReportMarkdown(
    "prefix\r\n" +
      '{{sp-embed kind="graph" id="graph-1"}}\r\n' +
      '{{sp-embed kind="graph" id="graph-1"}}\r\n' +
      'not {{sp-embed kind="graph" id="graph-2"}} directive\r\n' +
      '{{sp-embed kind="bad" id="graph-3"}}\r\n' +
      '{{sp-embed kind="graph" id="bad id"}}\r\n' +
      "suffix",
  ),
  [
    { type: "markdown", markdown: "prefix\r\n" },
    { type: "embed", dependency: { kind: "graph", documentId: "graph-1" } },
    { type: "embed", dependency: { kind: "graph", documentId: "graph-1" } },
    { type: "markdown", markdown: 'not {{sp-embed kind="graph" id="graph-2"}} directive\r\n{{sp-embed kind="bad" id="graph-3"}}\r\n{{sp-embed kind="graph" id="bad id"}}\r\nsuffix' },
  ],
);

assert.deepEqual(extractReportDependencies(source), [
  { kind: "graph", documentId: "graph-1" },
]);

assert.deepEqual(
  extractReportDependencies(
    [
      "```bad`info",
      '{{sp-embed kind="graph" id="visible-after-invalid-fence"}}',
    ].join("\n"),
  ),
  [{ kind: "graph", documentId: "visible-after-invalid-fence" }],
);

assert.deepEqual(
  extractReportDependencies(
    [
      "alpha",
      '{{sp-embed kind="graph" id="graph-1"}}',
      '{{sp-embed kind="table" id="table-1"}}',
      '{{sp-embed kind="graph" id="graph-1"}}',
      '{{sp-embed kind="fitYByX" id="fit-1"}}',
      '{{sp-embed kind="table" id="table-1"}}',
      '{{sp-embed kind="tabulate" id="tab-1"}}',
      "omega",
    ].join("\n"),
  ),
  [
    { kind: "graph", documentId: "graph-1" },
    { kind: "table", documentId: "table-1" },
    { kind: "fitYByX", documentId: "fit-1" },
    { kind: "tabulate", documentId: "tab-1" },
  ],
);

console.log("report-parser contract passed");
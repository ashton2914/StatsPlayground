import assert from "node:assert/strict";

import type { ReportDependency } from "../src/types/report.ts";
import { formatReportEmbed, parseReportMarkdown } from "../src/utils/reportParser.ts";

const dependency = {
  kind: "distribution",
  documentId: "distribution-3",
} as ReportDependency;
const directive = formatReportEmbed(dependency);

assert.deepEqual(parseReportMarkdown(directive), [{
  type: "embed",
  dependency,
}]);

console.log("report Distribution embed parser contract passed");
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appCss = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8").replace(/\r\n/g, "\n");
const reportTableCss = readFileSync(
  resolve(process.cwd(), "src/components/reportTable.css"),
  "utf8",
).replace(/\r\n/g, "\n");
const reportSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/FitYByXReport.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

assert.match(
  appCss,
  /\.sp-fit-y-by-x-analysis-root\s*\{[^}]*overflow-y:\s*auto;/s,
  "Fit Y by X analysis must keep graph and report content reachable through the outer scroller",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-runtime-panel,\s*\.sp-fit-y-by-x-report-panel\s*\{[^}]*flex:\s*0 0 auto;/s,
  "Fit Y by X graph and report panels must not shrink and clip their contents",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-table th,\s*\.sp-fit-y-by-x-report-table td\s*\{[^}]*border-right:\s*1px solid var\(--border-main\);/s,
  "Fit Y by X report cells must have vertical separators",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-table th\s*\{[^}]*border-right-color:\s*var\(--border-header-h\);/s,
  "Fit Y by X report headers must use a distinct separator",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-table th:last-child,\s*\.sp-fit-y-by-x-report-table td:last-child\s*\{[^}]*border-right:\s*none;/s,
  "Fit Y by X report tables must not draw a duplicate trailing separator",
);

assert.match(
  reportSource,
  /<colgroup>[\s\S]*sp-fit-y-by-x-report-column-label[\s\S]*sp-fit-y-by-x-report-column-value-wide[\s\S]*sp-fit-y-by-x-report-column-value/,
  "Fit Y by X report tables must declare fixed-width label, wide-value, and numeric columns",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-table\s*\{[^}]*width:\s*max-content;[^}]*table-layout:\s*fixed;/s,
  "Fit Y by X report tables must keep their fixed content width instead of filling the panel",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-report-sections\s*\{[^}]*align-items:\s*flex-start;/s,
  "Fit Y by X report sections must not stretch their outer borders across the panel",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-report-section\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s,
  "Fit Y by X report section borders must shrink with their tables while containing narrow-view overflow",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-column-label\s*\{[^}]*width:\s*220px;/s,
  "Fit Y by X report label columns must use a consistent fixed width",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-column-value\s*\{[^}]*width:\s*150px;/s,
  "Fit Y by X report numeric columns must use a consistent fixed width",
);

assert.match(
  reportTableCss,
  /\.sp-fit-y-by-x-report-column-value-wide\s*\{[^}]*width:\s*360px;/s,
  "Fit Y by X summary value columns must leave room for fitted equations",
);

console.log("Fit Y by X layout contract passed");
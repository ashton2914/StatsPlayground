import assert from "node:assert/strict";

import {
  DEFAULT_TIME_SERIES_OPTIONS,
  reconcileTimeSeriesElements,
  validateTimeSeriesX,
} from "../src/components/graphBuilder/timeSeriesContract.ts";

import type { ChartElement, FieldRef, RefLineX, RefLineY } from "../src/graphCore/types.ts";

const datetime = (name: string): FieldRef => ({ name, type: "datetime" });
const nominal = (name: string): FieldRef => ({ name, type: "nominal" });
const continuous = (name: string): FieldRef => ({ name, type: "continuous" });

const refLinesY: RefLineY[] = [{ id: "yl-1", y: 4, label: "Y1", style: "solid", color: "#000", width: 1 }];
const refLinesX: RefLineX[] = [{ id: "xl-1", x: 9, label: "X1", style: "solid", color: "#000", width: 1 }];

assert.deepEqual(DEFAULT_TIME_SERIES_OPTIONS, {
  xInterpretation: { kind: "nativeTemporal" },
  order: "timeAscending",
  missingValues: "break",
  connection: "line",
  markerMode: "auto",
});

assert.deepEqual(
  validateTimeSeriesX(
    datetime("数据日期"),
    "DATE",
    { kind: "nativeTemporal" },
  ),
  { valid: true, temporalKind: "date" },
);

assert.deepEqual(
  validateTimeSeriesX(
    datetime("timestamp"),
    "TIMESTAMP",
    { kind: "nativeTemporal" },
  ),
  { valid: true, temporalKind: "timestamp" },
);

assert.deepEqual(
  validateTimeSeriesX(
    datetime("timestamp with timezone"),
    "TIMESTAMPTZ",
    { kind: "nativeTemporal" },
  ),
  { valid: true, temporalKind: "timestampTz" },
);

assert.equal(
  validateTimeSeriesX(
    nominal("数据日期"),
    "VARCHAR",
    { kind: "textDate", format: "usDate" },
  ).valid,
  true,
);

assert.deepEqual(
  validateTimeSeriesX(
    nominal("captured date"),
    "VARCHAR",
    { kind: "textDate", format: "usDate" },
  ),
  { valid: true, temporalKind: "date" },
);

assert.deepEqual(
  validateTimeSeriesX(
    nominal("captured timestamp"),
    "VARCHAR",
    { kind: "textDate", format: "usDateTime" },
  ),
  { valid: true, temporalKind: "timestamp" },
);

assert.equal(
  validateTimeSeriesX(
    datetime("clock"),
    "TIME",
    { kind: "nativeTemporal" },
  ).valid,
  false,
);

assert.equal(
  validateTimeSeriesX(
    continuous("sequence"),
    "BIGINT",
    { kind: "sequence" },
  ).valid,
  true,
);

assert.deepEqual(
  validateTimeSeriesX(
    continuous("sequence"),
    "BIGINT",
    { kind: "sequence" },
  ),
  { valid: true },
);

assert.equal(
  validateTimeSeriesX(
    continuous("sequence"),
    "UHUGEINT",
    { kind: "sequence" },
  ).valid,
  true,
);

assert.equal(
  validateTimeSeriesX(
    continuous("sequence"),
    "VARCHAR",
    { kind: "sequence" },
  ).valid,
  false,
);

const reconciled = reconcileTimeSeriesElements({
  elements: [
    { kind: "timeSeries", enabled: true } as ChartElement,
    { kind: "line", enabled: true } as ChartElement,
    { kind: "fitline", enabled: true } as ChartElement,
    { kind: "boxplot", enabled: true } as ChartElement,
    { kind: "normalCurve", enabled: true } as ChartElement,
    { kind: "points", enabled: false } as ChartElement,
    { kind: "line", enabled: false } as ChartElement,
  ],
  refLinesY,
  refLinesX,
});

assert.deepEqual(reconciled.elements.map((element) => [element.kind, element.enabled]), [
  ["timeSeries", true],
  ["boxplot", true],
  ["normalCurve", true],
  ["points", false],
  ["line", false],
]);
assert.deepEqual(reconciled.elements[0]?.options, DEFAULT_TIME_SERIES_OPTIONS);
assert.deepEqual(reconciled.refLinesY, refLinesY);
assert.deepEqual(reconciled.refLinesX, refLinesX);

console.log("timeSeries contract tests passed");
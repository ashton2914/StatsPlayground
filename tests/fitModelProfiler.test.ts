import assert from "node:assert/strict";

import { createInstance } from "i18next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { FitModelProfiler } from "../src/components/fitModel/FitModelProfiler.tsx";
import {
  fitModelProfilerYDomain,
  type FitModelProfilerPoint,
} from "../src/components/fitModel/fitModelPrediction.ts";
import type { FitModelSnapshot } from "../src/types/fitModel.ts";

const snapshot: FitModelSnapshot = {
  coefficientTermIds: ["Intercept", "A", "B"],
  coefficients: [1, 2, 3],
  covariance: null,
  meanSquareError: null,
  errorDegreesOfFreedom: 0,
  confidenceLevel: 0.95,
  terms: [
    { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
    { termId: "B", kind: "main", columnNames: ["B"], label: "B" },
  ],
  centering: { method: "none", centers: [] },
  predictorRanges: [
    { columnName: "A", minimum: 0, maximum: 4, mean: 2 },
    { columnName: "B", minimum: 1, maximum: 7, mean: 4 },
  ],
};

function profilerPoint(
  predicted: number,
  meanConfidenceLower: number | null,
  meanConfidenceUpper: number | null,
  predictionLower: number | null,
  predictionUpper: number | null,
): FitModelProfilerPoint {
  return {
    value: 0,
    predicted,
    meanConfidenceLower,
    meanConfidenceUpper,
    predictionLower,
    predictionUpper,
    inferenceReason: null,
    extrapolatedColumns: [],
  };
}

const scans = [
  [
    profilerPoint(10, 9, 10.5, 5, 16),
    profilerPoint(12, 11.5, 12.5, 10.5, 13.5),
  ],
  [
    profilerPoint(13, null, null, null, null),
    profilerPoint(14, 13.5, 15, 8, 20),
  ],
];
assert.deepEqual(fitModelProfilerYDomain(scans), { min: 8.8, max: 15.2 });
assert.deepEqual(
  fitModelProfilerYDomain([[profilerPoint(20, 20, 20, 20, 20)]]),
  { min: 19, max: 21 },
);
for (const value of [0, Number.MIN_VALUE, -Number.MIN_VALUE]) {
  const domain = fitModelProfilerYDomain([[profilerPoint(value, value, value, null, null)]]);
  assert.ok(Number.isFinite(domain.min) && Number.isFinite(domain.max));
  assert.ok(domain.min < value && value < domain.max);
}
const subnormalDomain = fitModelProfilerYDomain([[
  profilerPoint(Number.MIN_VALUE, null, null, null, null),
  profilerPoint(Number.MIN_VALUE * 2, null, null, null, null),
]]);
assert.ok(Number.isFinite(subnormalDomain.min) && Number.isFinite(subnormalDomain.max));
assert.ok(subnormalDomain.min <= Number.MIN_VALUE);
assert.ok(subnormalDomain.max >= Number.MIN_VALUE * 2);
assert.ok(subnormalDomain.min < subnormalDomain.max);
for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
  assert.throws(
    () => fitModelProfilerYDomain([[profilerPoint(value, value, value, null, null)]]),
    /finite representable padded range/i,
  );
}
assert.throws(
  () => fitModelProfilerYDomain([[
    profilerPoint(-Number.MAX_VALUE, null, null, null, null),
    profilerPoint(Number.MAX_VALUE, null, null, null, null),
  ]]),
  /finite representable padded range/i,
);
assert.throws(
  () => fitModelProfilerYDomain([[profilerPoint(Number.NaN, null, null, null, null)]]),
  /non-finite/i,
);

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  initImmediate: false,
  interpolation: { escapeValue: false },
  resources: {
    en: {
      translation: {
        fitModel: {
          report: {
            profiler: {
              currentValue: "Current value",
              predicted: "Predicted",
              meanConfidenceInterval: "Mean CI",
              predictionInterval: "Prediction interval",
              notEstimable: "Not estimable",
              extrapolation: "Outside training range: {{columns}}",
            },
            chart: { series: { predicted: "Predicted", meanConfidence: "Mean CI" } },
          },
        },
      },
    },
  },
});

const html = renderToStaticMarkup(
  React.createElement(
    I18nextProvider,
    { i18n },
    React.createElement(FitModelProfiler, { snapshot, responseName: "Y" }),
  ),
);

assert.match(html, /data-profiler-column="A"/);
assert.match(html, /data-profiler-column="B"/);
assert.match(html, /data-marker-y="17"/);
assert.match(html, /data-curve-start-y="13"/);
assert.match(html, /data-curve-end-y="21"/);
assert.match(html, /sp-fit-model-profiler-track/);
assert.match(html, /aria-label="A Current value"[^>]*value="2"/);
assert.match(html, /aria-label="B Current value"[^>]*value="4"/);
assert.match(html, /Not estimable/);
assert.match(html, /sp-fit-model-profiler-value/);
assert.equal((html.match(/type="range"/g) ?? []).length, 0);
assert.equal((html.match(/type="number"/g) ?? []).length, 2);

console.log("fitModel profiler component contract passed");

import assert from "node:assert/strict";

import { createInstance } from "i18next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { FitModelProfiler } from "../src/components/fitModel/FitModelProfiler.tsx";
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
assert.match(html, /aria-label="A Current value"[^>]*value="2"/);
assert.match(html, /aria-label="B Current value"[^>]*value="4"/);
assert.match(html, /Not estimable/);
assert.equal((html.match(/type="range"/g) ?? []).length, 2);
assert.equal((html.match(/type="number"/g) ?? []).length, 2);

console.log("fitModel profiler component contract passed");

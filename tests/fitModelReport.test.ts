import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createInstance, type i18n as I18nInstance } from "i18next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";

import {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  FitModelReport,
  buildEffectSummary,
  createFitModelDefinitionConfig,
  fitModelTermId,
  logWorth,
  removeFitModelTerm,
} from "../src/components/fitModel/index.ts";
import type { FitModelReportState } from "../src/components/fitModel/useFitModelReport.ts";
import type { FitModelFittedResult, FitModelItem, FitModelResult } from "../src/types/fitModel.ts";

const VIEW_SOURCE_PATH = path.resolve(
  process.cwd(),
  "src/components/fitModel/FitModelView.tsx",
);

const testI18n = createTestI18n();

function createTestI18n(): I18nInstance {
  const instance = createInstance();
  void instance
    .use(initReactI18next)
    .init({
      lng: "en",
      fallbackLng: "en",
      initImmediate: false,
      interpolation: { escapeValue: false },
      resources: {
        en: {
          translation: {
            fitModel: {
              report: {
                title: "Fit Model report",
                loading: "Loading report...",
                stale: "Stale result",
                errorWithOldResult: "Failed to refresh. Showing previous result.",
                section: {
                  effectSummary: "Effect Summary",
                  summaryOfFit: "Summary of Fit",
                  analysisOfVariance: "Analysis of Variance",
                  parameterEstimates: "Parameter Estimates",
                  actualByPredicted: "Actual by Predicted",
                  residualByPredicted: "Residual by Predicted",
                  warnings: "Warnings",
                },
                chart: {
                  axis: {
                    predicted: "Predicted",
                    actual: "Actual",
                    residual: "Residual",
                  },
                  series: {
                    actual: "Actual",
                    residual: "Residual",
                  },
                  reference: {
                    identity: "y=x",
                    zero: "y=0",
                  },
                  tooltip: {
                    x: "Predicted",
                    yActual: "Actual",
                    yResidual: "Residual",
                  },
                },
                remove: "Remove",
                undo: "Undo",
                chartPlaceholder: "Chart placeholder",
                notComputable: "Not Computable",
              },
            },
          },
        },
      },
    });
  return instance;
}

function createItem(overrides: Partial<FitModelItem> = {}): FitModelItem {
  return {
    id: "fit-model-1",
    name: "Fit Model 1",
    sourceDatasetId: "dataset-1",
    response: { name: "Y", type: "continuous" },
    terms: [
      { kind: "main", columnNames: ["A"] },
      { kind: "main", columnNames: ["B"] },
      { kind: "interaction", columnNames: ["A", "B"] },
    ],
    centeringMethod: "mean",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function createFittedResult(overrides: Partial<FitModelFittedResult> = {}): FitModelFittedResult {
  return {
    kind: "fitted",
    usedRows: 12,
    excludedRows: 1,
    confidenceLevel: 0.95,
    responseColumn: "Y",
    predictorColumns: ["A", "B"],
    terms: [
      { termId: "main:A", kind: "main", columnNames: ["A"], label: "A" },
      { termId: "main:B", kind: "main", columnNames: ["B"], label: "B" },
      { termId: "interaction:A*B", kind: "interaction", columnNames: ["A", "B"], label: "A*B" },
    ],
    centering: {
      method: "mean",
      centers: [
        { columnName: "A", mean: 10 },
        { columnName: "B", mean: 20 },
      ],
    },
    summaryOfFit: {
      rSquared: 0.9,
      adjustedRSquared: 0.88,
      rootMeanSquareError: 1.2,
      meanOfResponse: 12.3,
      observationCount: 12,
      modelDegreesOfFreedom: 3,
      errorDegreesOfFreedom: 8,
    },
    anova: [
      {
        source: "Model",
        degreesOfFreedom: 3,
        sumOfSquares: 100,
        meanSquare: 33.333,
        fRatio: 11.1,
        pValue: 0.0001,
      },
      {
        source: "Error",
        degreesOfFreedom: 8,
        sumOfSquares: 24,
        meanSquare: 3,
        fRatio: null,
        pValue: null,
      },
    ],
    parameterEstimates: [
      {
        termId: "Intercept",
        termLabel: "Intercept",
        estimate: 1,
        standardError: 0.1,
        tRatio: 10,
        pValue: 0.01,
        lowerConfidenceLimit: 0,
        upperConfidenceLimit: 2,
      },
      {
        termId: "main:A",
        termLabel: "A",
        estimate: 2,
        standardError: 0.2,
        tRatio: 10,
        pValue: 0.05,
        lowerConfidenceLimit: 1,
        upperConfidenceLimit: 3,
      },
      {
        termId: "main:B",
        termLabel: "B",
        estimate: 3,
        standardError: 0.3,
        tRatio: 10,
        pValue: 0.001,
        lowerConfidenceLimit: 2,
        upperConfidenceLimit: 4,
      },
      {
        termId: "interaction:A*B",
        termLabel: "A*B",
        estimate: 4,
        standardError: 0.4,
        tRatio: 10,
        pValue: null,
        lowerConfidenceLimit: null,
        upperConfidenceLimit: null,
      },
    ],
    plotRows: [],
    plotRowsSampled: false,
    warnings: ["saturatedModel"],
    ...overrides,
  };
}

function renderReport(state: FitModelReportState): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: testI18n },
      React.createElement(FitModelReport, {
        item: createItem(),
        state,
        datasetMissing: false,
        loadIssue: null,
        removeMessage: null,
        onRemoveTerm: () => undefined,
        onUndoRemove: () => undefined,
      }),
    ),
  );
}

function renderReportWithItem(item: FitModelItem, state: FitModelReportState): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: testI18n },
      React.createElement(FitModelReport, {
        item,
        state,
        datasetMissing: false,
        loadIssue: null,
        removeMessage: null,
        onRemoveTerm: () => undefined,
        onUndoRemove: () => undefined,
      }),
    ),
  );
}

function testLogWorthContracts(): void {
  assert.equal(logWorth(0.05), -Math.log10(0.05));
  assert.equal(logWorth(0), 300);
  assert.equal(logWorth(1e-320), 300);
  assert.equal(logWorth(null), null);
}

function testEffectSummarySortAndPValueMapping(): void {
  const result = createFittedResult();
  const effects = buildEffectSummary(result);

  assert.deepEqual(effects.map((row) => row.termLabel), ["B", "A", "A*B"]);
  assert.equal(effects[0]?.pValue, 0.001);
  assert.equal(effects[1]?.pValue, 0.05);
  assert.equal(effects[2]?.pValue, null);
}

function testMeanCenteringDoesNotRelabelMainEffect(): void {
  const result = createFittedResult({
    terms: [
      { termId: "main:A", kind: "main", columnNames: ["A"], label: "A" },
      { termId: "interaction:A*B", kind: "interaction", columnNames: ["A", "B"], label: "A*B" },
    ],
    parameterEstimates: [
      {
        termId: "main:A",
        termLabel: "A (main)",
        estimate: 1,
        standardError: 0.1,
        tRatio: 10,
        pValue: 0.02,
        lowerConfidenceLimit: null,
        upperConfidenceLimit: null,
      },
      {
        termId: "interaction:A*B",
        termLabel: "A*B",
        estimate: 2,
        standardError: 0.2,
        tRatio: 10,
        pValue: 0.03,
        lowerConfidenceLimit: null,
        upperConfidenceLimit: null,
      },
    ],
  });

  const effects = buildEffectSummary(result);
  const main = effects.find((row) => row.termId === "main:A");
  assert.equal(main?.pValue, 0.02);
}

function testRemoveInteractionSucceeds(): void {
  const terms = createItem().terms;
  const interactionId = fitModelTermId({ kind: "interaction", columnNames: ["B", "A"] });
  const removal = removeFitModelTerm(terms, interactionId);
  assert.equal(removal.ok, true);
  if (!removal.ok) return;
  assert.equal(removal.nextTerms.some((term) => term.kind === "interaction"), false);
  assert.equal(removal.undoSnapshot.terms.length, 3);
}

function testResolvedTermIdsMatchRustForPowerAndHigherOrderInteraction(): void {
  assert.equal(fitModelTermId({ kind: "main", columnNames: ["A"] }), "A");
  assert.equal(
    fitModelTermId({ kind: "interaction", columnNames: ["C", "A", "B"] }),
    "interaction:A*B*C",
  );
  assert.equal(
    fitModelTermId({ kind: "power", columnNames: ["A"], exponent: 2 }),
    "power:A^2",
  );
  assert.equal(
    fitModelTermId({ kind: "interaction", columnNames: ["ä:x", "A", "z*y"] }),
    "interaction:tuple:1:A3:z*y4:ä:x",
  );
}

function testRemovePowerAndHigherOrderInteractionSucceeds(): void {
  const terms = [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B"] },
    { kind: "main", columnNames: ["C"] },
    { kind: "interaction", columnNames: ["A", "B", "C"] },
    { kind: "power", columnNames: ["A"], exponent: 2 },
  ] as const;

  const withoutInteraction = removeFitModelTerm(terms, "interaction:A*B*C");
  assert.equal(withoutInteraction.ok, true);
  if (!withoutInteraction.ok) return;
  assert.equal(withoutInteraction.nextTerms.some((term) => term.kind === "interaction"), false);

  const withoutPower = removeFitModelTerm(terms, "power:A^2");
  assert.equal(withoutPower.ok, true);
  if (!withoutPower.ok) return;
  assert.equal(withoutPower.nextTerms.some((term) => term.kind === "power"), false);
}

function testRemoveMainBlockedByInteraction(): void {
  const terms = createItem().terms;
  const mainId = fitModelTermId({ kind: "main", columnNames: ["A"] });
  const removal = removeFitModelTerm(terms, mainId);
  assert.equal(removal.ok, false);
  if (removal.ok) return;
  assert.equal(removal.reason, "requiredByInteraction");
}

function testRemoveLastMainBlocked(): void {
  const terms = [{ kind: "main", columnNames: ["A"] }] as const;
  const mainId = fitModelTermId({ kind: "main", columnNames: ["A"] });
  const removal = removeFitModelTerm(terms, mainId);
  assert.equal(removal.ok, false);
  if (removal.ok) return;
  assert.equal(removal.reason, "lastMainEffect");
}

function testValidMainRemovalReturnsUndoSnapshot(): void {
  const terms = [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B"] },
  ] as const;

  const removal = removeFitModelTerm(terms, fitModelTermId({ kind: "main", columnNames: ["A"] }));
  assert.equal(removal.ok, true);
  if (!removal.ok) return;

  assert.deepEqual(removal.nextTerms, [{ kind: "main", columnNames: ["B"] }]);
  assert.deepEqual(removal.undoSnapshot.terms, [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B"] },
  ]);
}

function testBlockedRemoveTransitionLeavesDefinitionUnchangedWithoutRefit(): void {
  const definition = createFitModelDefinitionConfig({
    terms: createItem().terms,
    centeringMethod: "mean",
  });
  const existingUndo = {
    definition: createFitModelDefinitionConfig({
      terms: [{ kind: "main", columnNames: ["B"] }],
      centeringMethod: "mean",
    }),
  };

  const result = applyFitModelTermRemoval(
    definition,
    fitModelTermId({ kind: "main", columnNames: ["A"] }),
    existingUndo,
  );

  assert.equal(result.ok, false);
  assert.equal(result.shouldRefit, false);
  assert.equal(result.reason, "requiredByInteraction");
  assert.strictEqual(result.nextDefinition, definition);
  assert.strictEqual(result.undoSnapshot, existingUndo);
}

function testValidRemoveTransitionReturnsUpdatedTermsAndExactUndoIdentity(): void {
  const definition = createFitModelDefinitionConfig({
    terms: createItem().terms,
    centeringMethod: "mean",
  });

  const result = applyFitModelTermRemoval(
    definition,
    fitModelTermId({ kind: "interaction", columnNames: ["B", "A"] }),
    null,
  );

  assert.equal(result.ok, true);
  assert.equal(result.shouldRefit, true);
  assert.notStrictEqual(result.nextDefinition, definition);
  assert.deepEqual(result.nextDefinition.terms, [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B"] },
  ]);
  assert.equal(result.nextDefinition.centeringMethod, "mean");
  assert.strictEqual(result.undoSnapshot.definition, definition);
}

function testUndoTransitionRestoresOnceAndClearsSnapshot(): void {
  const definition = createFitModelDefinitionConfig({
    terms: createItem().terms,
    centeringMethod: "mean",
  });
  const removal = applyFitModelTermRemoval(
    definition,
    fitModelTermId({ kind: "interaction", columnNames: ["A", "B"] }),
    null,
  );
  assert.equal(removal.ok, true);
  if (!removal.ok) return;

  const restored = applyFitModelTermUndo(removal.nextDefinition, removal.undoSnapshot);
  assert.equal(restored.restored, true);
  assert.equal(restored.shouldRefit, true);
  assert.strictEqual(restored.nextDefinition, definition);
  assert.equal(restored.nextUndoSnapshot, null);
  assert.equal(restored.nextDefinition.centeringMethod, "mean");

  const noSecondUndo = applyFitModelTermUndo(restored.nextDefinition, restored.nextUndoSnapshot);
  assert.equal(noSecondUndo.restored, false);
  assert.equal(noSecondUndo.shouldRefit, false);
  assert.strictEqual(noSecondUndo.nextDefinition, restored.nextDefinition);
  assert.equal(noSecondUndo.nextUndoSnapshot, null);
}

function testRenderFittedContracts(): void {
  const result = createFittedResult();
  const state: FitModelReportState = {
    status: "success",
    result,
    error: null,
    configurationKey: "cfg-1",
  };

  const html = renderReport(state);

  assert.match(html, /Effect Summary/);
  assert.match(html, /Summary of Fit/);
  assert.match(html, /Analysis of Variance/);
  assert.match(html, /Parameter Estimates/);
  assert.match(html, /fitted-equation-inputs/);
  assert.match(html, />1<.*\+ 2 A/);
  assert.match(html, /saturatedModel|fitModel\.report\.warning\.saturatedModel/);
  assert.match(html, /Remove/);
  assert.match(html, /Undo/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Actual by Predicted/);
  assert.match(html, /Residual by Predicted/);
}

function testRenderNotComputableContract(): void {
  const result: FitModelResult = {
    kind: "notComputable",
    reason: "insufficientRows",
    usedRows: 2,
    excludedRows: 5,
  };
  const state: FitModelReportState = {
    status: "success",
    result,
    error: null,
    configurationKey: "cfg-2",
  };
  const html = renderReport(state);

  assert.match(html, /Not Computable|fitModel\.report\.notComputable/);
  assert.match(html, /insufficientRows|fitModel\.report\.reason\.insufficientRows/);
}

function testRenderLoadingStaleAndErrorOldResultContracts(): void {
  const loadingState: FitModelReportState = {
    status: "loading",
    result: null,
    error: null,
    configurationKey: "cfg-loading",
  };
  const loadingHtml = renderReport(loadingState);
  assert.match(loadingHtml, /Loading report|fitModel\.report\.loading/);

  const staleState: FitModelReportState = {
    status: "stale",
    result: createFittedResult(),
    error: "backend timed out",
    configurationKey: "cfg-stale",
  };
  const staleHtml = renderReport(staleState);
  assert.match(staleHtml, /Stale result|fitModel\.report\.stale/);
  assert.match(staleHtml, /Failed to refresh\. Showing previous result\.|fitModel\.report\.errorWithOldResult/);
  assert.match(staleHtml, /backend timed out/);

  const errorWithOldState: FitModelReportState = {
    status: "error",
    result: createFittedResult(),
    error: "permission denied",
    configurationKey: "cfg-error-old",
  };
  const oldHtml = renderReport(errorWithOldState);
  assert.match(oldHtml, /Failed to refresh\. Showing previous result\.|fitModel\.report\.errorWithOldResult/);
  assert.match(oldHtml, /permission denied/);
}

function testStaleEquationUsesResultTermsNotCurrentItemTerms(): void {
  const staleResult = createFittedResult({
    responseColumn: "Y_old",
    terms: [
      { termId: "main:A", kind: "main", columnNames: ["A"], label: "A" },
    ],
    parameterEstimates: [
      {
        termId: "Intercept",
        termLabel: "Intercept",
        estimate: 1,
        standardError: 0.1,
        tRatio: 10,
        pValue: 0.01,
        lowerConfidenceLimit: 0,
        upperConfidenceLimit: 2,
      },
      {
        termId: "main:A",
        termLabel: "A",
        estimate: 2,
        standardError: 0.2,
        tRatio: 10,
        pValue: 0.02,
        lowerConfidenceLimit: 1,
        upperConfidenceLimit: 3,
      },
    ],
  });
  const staleState: FitModelReportState = {
    status: "stale",
    result: staleResult,
    error: null,
    configurationKey: "cfg-stale-eq",
  };

  const html = renderReportWithItem(createItem({
    response: { name: "Y_new", type: "continuous" },
    terms: [{ kind: "main", columnNames: ["B"] }],
  }), staleState);

  assert.match(html, /Y_old/);
  assert.match(html, /\+ 2 A/);
  assert.doesNotMatch(html, /Y_new/);
  assert.doesNotMatch(html, /\+ B/);
}

function testUnavailableLoadIssueRendersWithoutEquation(): void {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: testI18n },
      React.createElement(FitModelReport, {
        item: createItem({
          loadIssue: { code: "invalidPersistedDefinition", detail: "nonContinuousResponse:Yield" },
        }),
        state: {
          status: "idle",
          result: null,
          error: null,
          configurationKey: null,
        },
        datasetMissing: false,
        loadIssue: { code: "invalidPersistedDefinition", detail: "nonContinuousResponse:Yield" },
        removeMessage: null,
        onRemoveTerm: () => undefined,
        onUndoRemove: null,
      }),
    ),
  );

  assert.match(html, /Source dataset is unavailable|Source data table is unavailable|fitModel\.sourceMissing/);
  assert.doesNotMatch(html, /fitted-equation-inputs/);
}

function testViewSourceContracts(): void {
  const source = readFileSync(VIEW_SOURCE_PATH, "utf8").replace(/\r\n/g, "\n");

  assert.match(
    source,
    /useFitModelReport\(dataset && !item\.loadIssue \? item : null, dataset\?\.updatedAt \?\? null\)/,
    "FitModelView must gate report loading by dataset and dataset update signal.",
  );
}

testLogWorthContracts();
testEffectSummarySortAndPValueMapping();
testMeanCenteringDoesNotRelabelMainEffect();
testRemoveInteractionSucceeds();
testResolvedTermIdsMatchRustForPowerAndHigherOrderInteraction();
testRemovePowerAndHigherOrderInteractionSucceeds();
testRemoveMainBlockedByInteraction();
testRemoveLastMainBlocked();
testValidMainRemovalReturnsUndoSnapshot();
testBlockedRemoveTransitionLeavesDefinitionUnchangedWithoutRefit();
testValidRemoveTransitionReturnsUpdatedTermsAndExactUndoIdentity();
testUndoTransitionRestoresOnceAndClearsSnapshot();
testRenderFittedContracts();
testRenderNotComputableContract();
testRenderLoadingStaleAndErrorOldResultContracts();
testStaleEquationUsesResultTermsNotCurrentItemTerms();
testUnavailableLoadIssueRendersWithoutEquation();
testViewSourceContracts();

console.log("fitModel report contract passed");

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
                  modelSpecification: "Model Specification",
                  effectSummary: "Effect Summary",
                  summaryOfFit: "Summary of Fit",
                  analysisOfVariance: "Analysis of Variance",
                  lackOfFit: "Lack of Fit",
                  parameterEstimates: "Parameter Estimates",
                  actualByPredicted: "Actual by Predicted",
                  residualByPredicted: "Residual by Predicted",
                  featureVif: "Feature VIF",
                  residualQq: "Residual Q-Q",
                  rowDiagnostics: "Row Diagnostics",
                  warnings: "Warnings",
                },
                chart: {
                  axis: {
                    predicted: "Predicted",
                    actual: "Actual",
                    residual: "Residual",
                    theoreticalQuantile: "Theoretical quantile",
                    studentizedResidual: "Studentized residual",
                  },
                  series: {
                    actual: "Actual",
                    residual: "Residual",
                  },
                  reference: {
                    identity: "y=x",
                    zero: "y=0",
                    qq: "Q-Q reference",
                  },
                  tooltip: {
                    x: "Predicted",
                    yActual: "Actual",
                    yResidual: "Residual",
                    xQq: "Theoretical quantile",
                    yQq: "Studentized residual",
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
    construct: { kind: "manual" },
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
      { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
      { termId: "B", kind: "main", columnNames: ["B"], label: "B" },
      { termId: "interaction:A*B", kind: "interaction", columnNames: ["A", "B"], label: "A*B" },
    ],
    centering: {
      method: "mean",
      centers: [
        { columnName: "A", mean: 10 },
        { columnName: "B", mean: 20 },
      ],
    },
    snapshot: {
      coefficientTermIds: ["Intercept", "A", "B", "interaction:A*B"],
      coefficients: [1, 2, 3, 4],
      covariance: null,
      meanSquareError: 3,
      errorDegreesOfFreedom: 8,
      confidenceLevel: 0.95,
      terms: [
        { termId: "A", kind: "main", columnNames: ["A"], label: "A" },
        { termId: "B", kind: "main", columnNames: ["B"], label: "B" },
        { termId: "interaction:A*B", kind: "interaction", columnNames: ["A", "B"], label: "A*B" },
      ],
      centering: {
        method: "mean",
        centers: [
          { columnName: "A", mean: 10 },
          { columnName: "B", mean: 20 },
        ],
      },
      predictorRanges: [
        { columnName: "A", minimum: 1, maximum: 12, mean: 6.5 },
        { columnName: "B", minimum: 2, maximum: 24, mean: 13 },
      ],
    },
    diagnostics: {
      lackOfFit: {
        sumOfSquaresError: 24,
        sumOfSquaresPureError: 0,
        sumOfSquaresLackOfFit: 24,
        errorDegreesOfFreedom: 8,
        pureErrorDegreesOfFreedom: 2,
        lackOfFitDegreesOfFreedom: 6,
        meanSquarePureError: 0,
        meanSquareLackOfFit: 4,
        fRatio: null,
        pValue: null,
        reason: "pureErrorZero",
      },
      featureVif: [
        { termId: "A", termLabel: "A", value: 1, reason: null },
        { termId: "interaction:A*B", termLabel: "A*B", value: null, reason: "auxiliaryRankDeficient" },
      ],
      rows: [
        {
          rowIndex: 7,
          observed: 14,
          fitted: 11.5,
          residual: 2.5,
          studentizedResidual: 2.4,
          leverage: 0.6,
          cooksDistance: 0.4,
          meanConfidenceLower: 10,
          meanConfidenceUpper: 13,
          predictionLower: 7,
          predictionUpper: 16,
          flags: ["residualWarning", "highLeverage", "influential"],
        },
      ],
      rowsSampled: true,
      sourceRowCount: 12,
      qqRows: [
        { rowIndex: 7, theoreticalQuantile: 0, studentizedResidual: 2.4 },
      ],
      qqRowsSampled: true,
      qqSourceRowCount: 12,
      qqReason: null,
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
        termId: "A",
        termLabel: "A",
        estimate: 2,
        standardError: 0.2,
        tRatio: 10,
        pValue: 0.05,
        lowerConfidenceLimit: 1,
        upperConfidenceLimit: 3,
      },
      {
        termId: "B",
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
  assert.equal(removal.reason, "requiredByDerivedTerm");
}

function testRemoveMainBlockedByPower(): void {
  const terms = [
    { kind: "main", columnNames: ["A"] },
    { kind: "main", columnNames: ["B"] },
    { kind: "power", columnNames: ["A"], exponent: 2 },
  ] as const;
  const removal = removeFitModelTerm(terms, fitModelTermId({ kind: "main", columnNames: ["A"] }));

  assert.equal(removal.ok, false);
  if (removal.ok) return;
  assert.equal(removal.reason, "requiredByDerivedTerm");
  assert.deepEqual(removal.requiredByTermIds, ["power:A^2"]);
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
  assert.equal(result.reason, "requiredByDerivedTerm");
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
  assert.match(html, /Model Specification/);
  assert.match(html, /Summary of Fit/);
  assert.match(html, /Analysis of Variance/);
  assert.match(html, /Parameter Estimates/);
  assert.match(html, /Lower 95%/);
  assert.match(html, /Upper 95%/);
  assert.match(html, /Lack of Fit/);
  assert.match(html, /pureErrorZero|fitModel\.report\.reason\.pureErrorZero/);
  assert.match(html, /Feature VIF/);
  assert.match(html, />A<\/td><td>2<\/td><td>0\.2<\/td><td>10<\/td><td>0\.0500<\/td><td>1<\/td><td>3<\/td><td>1<\/td>/);
  assert.match(html, /auxiliaryRankDeficient|fitModel\.report\.reason\.auxiliaryRankDeficient/);
  assert.match(html, /Residual Q-Q/);
  assert.match(html, /Row Diagnostics/);
  assert.match(html, /Sampled: 1 \/ 12 rows/);
  assert.match(html, /Residual warning|fitModel\.report\.flag\.residualWarning/);
  assert.match(html, /High leverage|fitModel\.report\.flag\.highLeverage/);
  assert.match(html, /Influential|fitModel\.report\.flag\.influential/);
  assert.match(html, /data-diagnostic-filter="all"/);
  assert.match(html, /data-diagnostic-filter="flagged"/);
  const orderedSections = [
    "Model Specification",
    "Effect Summary",
    "Summary of Fit",
    "Analysis of Variance",
    "Lack of Fit",
    "Parameter Estimates",
    "Actual by Predicted",
    "Residual by Predicted",
    "Residual Q-Q",
    "Row Diagnostics",
    "Warnings",
  ];
  let previousIndex = -1;
  orderedSections.forEach((section) => {
    const sectionIndex = html.indexOf(section);
    assert.ok(sectionIndex > previousIndex, `${section} must follow the previous report section`);
    previousIndex = sectionIndex;
  });
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
testRemoveMainBlockedByPower();
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

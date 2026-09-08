import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assignFitYByXField,
  canCreateFitYByX,
  createFitYByXDialogState,
  filterFitYByXFields,
  type FitYByXFieldInfo,
} from "../src/components/fitYByX/fitYByXDialogState.ts";
import { deriveFitYByXFieldInfo } from "../src/components/fitYByX/FitYByXRoleDialog.tsx";
import type { ColumnDisplayProps, ColumnMeta } from "../src/types/data.ts";

const fitYByXBarrelSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/index.ts"),
  "utf8",
);

assert.equal(
  fitYByXBarrelSource.includes("FitYByXRoleDialog") && fitYByXBarrelSource.includes("./FitYByXRoleDialog"),
  true,
  "Fit Y by X barrel must keep exporting FitYByXRoleDialog",
);
assert.equal(
  fitYByXBarrelSource.includes("FitYByXRoleZone") && fitYByXBarrelSource.includes("./FitYByXRoleZone"),
  true,
  "Fit Y by X barrel must keep exporting FitYByXRoleZone",
);
assert.equal(fitYByXBarrelSource.includes("FitYByXView"), false, "Fit Y by X barrel must not export the obsolete live view");
assert.equal(
  fitYByXBarrelSource.includes("createDefaultFitYByXGraphConfig")
    && fitYByXBarrelSource.includes("createFitYByXItem")
    && fitYByXBarrelSource.includes("./fitYByXConfig"),
  true,
  "Fit Y by X barrel must keep exporting the public config helpers",
);
assert.equal(
  fitYByXBarrelSource.includes("FitYByXFieldInfo")
    && fitYByXBarrelSource.includes("createFitYByXDialogState")
    && fitYByXBarrelSource.includes("filterFitYByXFields"),
  true,
  "Fit Y by X barrel must keep exporting the public dialog-state and search helpers",
);

const responseField: FitYByXFieldInfo = {
  name: "height",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "height", type: "continuous" },
};

const factorField: FitYByXFieldInfo = {
  name: "site",
  sqlType: "VARCHAR",
  modelingRole: "Nominal",
  field: { name: "site", type: "nominal" },
};

const ordinalField: FitYByXFieldInfo = {
  name: "batch",
  sqlType: "VARCHAR",
  modelingRole: "Ordinal",
  field: { name: "batch", type: "ordinal" },
};

const numericOrdinalColumn: ColumnMeta = {
  colIndex: 0,
  colName: "lot",
  colType: "DOUBLE",
  role: "continuous",
  missingCount: 0,
};
const numericOrdinalDisplay: ColumnDisplayProps = {
  colIndex: 0,
  extras: { valueOrder: { values: ["1", "2"] } },
};
assert.deepEqual(deriveFitYByXFieldInfo(numericOrdinalColumn, numericOrdinalDisplay), {
  name: "lot",
  sqlType: "DOUBLE",
  modelingRole: "Ordinal",
  field: { name: "lot", type: "ordinal" },
});

let state = createFitYByXDialogState("Fit Y by X 1");
assert.equal(canCreateFitYByX(state), false);

state = assignFitYByXField(state, "response", responseField);
assert.deepEqual(state.response, responseField.field);
assert.equal(state.validationError, null);
assert.equal(canCreateFitYByX(state), false);

const invalidResponse = assignFitYByXField(state, "response", factorField);
assert.deepEqual(invalidResponse.response, responseField.field);
assert.equal(invalidResponse.validationError, "invalidResponse");

state = assignFitYByXField(state, "factor", ordinalField);
assert.deepEqual(state.factor, ordinalField.field);
assert.equal(state.validationError, null);
assert.equal(canCreateFitYByX(state), true);

const duplicateFactor = assignFitYByXField(state, "factor", responseField);
assert.deepEqual(duplicateFactor.factor, ordinalField.field);
assert.equal(duplicateFactor.validationError, "duplicateRole");

const visibleByName = filterFitYByXFields([responseField, factorField, ordinalField], "site");
assert.deepEqual(visibleByName.map(({ name }) => name), ["site"]);

const visibleBySqlType = filterFitYByXFields([responseField, factorField, ordinalField], "double");
assert.deepEqual(visibleBySqlType.map(({ name }) => name), ["height"]);

const visibleByRole = filterFitYByXFields([responseField, factorField, ordinalField], "ordinal");
assert.deepEqual(visibleByRole.map(({ name }) => name), ["batch"]);

const fitYByXAnalysisSource = readFileSync(
  resolve(process.cwd(), "src/components/analysis/renderers/FitYByXAnalysisResults.tsx"),
  "utf8",
);

assert.equal(
  fitYByXAnalysisSource.includes("workspace.analysisSourceMissing"),
  true,
  "Fit Y by X Analysis must use the shared missing-source presentation",
);
assert.equal(
  fitYByXAnalysisSource.includes("title={item.name}"),
  true,
  "Fit Y by X Analysis must preserve the analysis header when the source dataset is missing",
);
assert.equal(
  fitYByXAnalysisSource.includes("dataset?.name ?? t(\"workspace.analysisSourceMissing\")"),
  true,
  "Fit Y by X Analysis must preserve the source slot with the missing-source label",
);
assert.equal(
  fitYByXAnalysisSource.includes("item.definition.response.name") && fitYByXAnalysisSource.includes("item.definition.factor.name"),
  true,
  "Fit Y by X Analysis must preserve response and factor summary context when the dataset is missing",
);

assert.equal(
  fitYByXAnalysisSource.includes("useGraphBuilderStore"),
  false,
  "Fit Y by X Analysis must not import or reference useGraphBuilderStore",
);
assert.equal(
  fitYByXAnalysisSource.includes("analysis-graph:${item.id}:main"),
  true,
  "Fit Y by X Analysis must materialize a role-qualified embedded graph id",
);
assert.equal(
  fitYByXAnalysisSource.includes("<AnalysisGraph"),
  true,
  "Fit Y by X Analysis must mount the shared graph host when the source dataset exists",
);
assert.equal(
  fitYByXAnalysisSource.includes("React.lazy") || fitYByXAnalysisSource.includes("lazy(") || fitYByXAnalysisSource.includes("<Suspense"),
  false,
  "Fit Y by X Analysis must synchronously mount its graph without lazy or Suspense",
);
assert.equal(
  fitYByXAnalysisSource.includes("dataset == null"),
  true,
  "Fit Y by X Analysis must guard the missing-source case before mounting the graph",
);
assert.equal(
  fitYByXAnalysisSource.includes("dataset == null ? ("),
  true,
  "Fit Y by X Analysis must render the unavailable state inline within its context",
);

const fitYByXRoleDialogSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/FitYByXRoleDialog.tsx"),
  "utf8",
);
assert.equal(
  fitYByXRoleDialogSource.includes("deriveFitYByXPersonality"),
  true,
  "FitYByXRoleDialog must derive the X personality from the assigned factor",
);
assert.equal(
  fitYByXRoleDialogSource.includes("assignResponseLabel") && fitYByXRoleDialogSource.includes("field: field.name"),
  true,
  "FitYByXRoleDialog must pass field for the locale assign-response aria label interpolation",
);
assert.equal(
  fitYByXRoleDialogSource.includes("assignFactorLabel") && fitYByXRoleDialogSource.includes("field: field.name"),
  true,
  "FitYByXRoleDialog must pass field for the locale assign-factor aria label interpolation",
);
assert.equal(
  fitYByXRoleDialogSource.includes("Assign a continuous, nominal, or ordinal field for X.")
    && fitYByXRoleDialogSource.includes("Continuous, nominal, or ordinal")
    && fitYByXRoleDialogSource.includes("Drop or assign one continuous, nominal, or ordinal field.")
    && fitYByXRoleDialogSource.includes("Factor must be continuous, nominal, or ordinal."),
  true,
  "FitYByXRoleDialog must update the X copy for continuous, nominal, and ordinal factors",
);
assert.equal(
  fitYByXRoleDialogSource.includes("fitYByX.personality.${personality}")
    && fitYByXRoleDialogSource.includes("Bivariate")
    && fitYByXRoleDialogSource.includes("Oneway"),
  true,
  "FitYByXRoleDialog must localize the derived personality labels",
);
assert.equal(
  fitYByXRoleDialogSource.includes('mode: "create" | "edit"')
    && fitYByXRoleDialogSource.includes("initialValue?: FitYByXAnalysisEditorItem"),
  true,
  "FitYByXRoleDialog must expose controlled create and edit modes",
);
assert.equal(
  fitYByXRoleDialogSource.includes("disabled={mode === \"edit\"}"),
  true,
  "FitYByXRoleDialog must disable analysis name editing in edit mode",
);
assert.equal(
  fitYByXRoleDialogSource.includes('type="number"')
    && fitYByXRoleDialogSource.includes("confidenceLevel > 0")
    && fitYByXRoleDialogSource.includes("confidenceLevel < 1"),
  true,
  "FitYByXRoleDialog must require a confidence level in the open interval (0, 1)",
);

const expectedMissingFactorCopy = {
  "en.json": "Choose a continuous, nominal, or ordinal X",
  "zh-CN.json": "选择一个连续、名义或有序 X",
  "zh-TW.json": "選擇一個連續、名義或有序 X",
  "vi.json": "Chọn một X liên tục, danh nghĩa hoặc thứ tự",
} as const;

for (const localeFile of ["en.json", "zh-CN.json", "zh-TW.json", "vi.json"] as const) {
  const localeSource = readFileSync(resolve(process.cwd(), `src/i18n/locales/${localeFile}`), "utf8");
  const locale = JSON.parse(localeSource) as {
    fitYByX: { missingFactor: string; validation: { missingFactor: string } };
  };
  assert.equal(
    localeSource.includes('"personality": {')
      && localeSource.includes('"oneway":')
      && localeSource.includes('"bivariate":'),
    true,
    `Locale ${localeFile} must include the derived personality labels`,
  );
  assert.equal(locale.fitYByX.missingFactor, expectedMissingFactorCopy[localeFile]);
  assert.equal(locale.fitYByX.validation.missingFactor, expectedMissingFactorCopy[localeFile]);
}

console.log("fitYByX dialog contract tests passed");
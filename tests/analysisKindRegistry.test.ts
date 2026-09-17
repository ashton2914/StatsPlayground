import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  analysisCommandFixtures,
  analysisCommandSchemas,
  analysisCreateAdapters,
  analysisUpdateValidators,
  assertRegisteredAnalysisKind,
  type AnalysisCommandJsonSchema,
} from "../src/applicationCommands/analysisCommands.ts";
import { analysisEditorRegistry } from "../src/components/analysis/analysisEditorRegistry.ts";
import { analysisExecutors } from "../src/components/analysis/analysisExecutors.ts";
import { analysisGraphPolicies } from "../src/components/analysis/analysisGraphPolicies.ts";
import { analysisKindDescriptors } from "../src/components/analysis/analysisKindDescriptors.ts";
import { analysisReportPolicies } from "../src/components/analysis/analysisReportPolicies.ts";
import { analysisViewContracts } from "../src/components/analysis/analysisViewContracts.ts";
import type { AnalysisKind } from "../src/types/analysis.ts";

interface AnalysisKindManifestEntry {
  analysisKind: AnalysisKind;
  documentSchemaVersion: number;
  definitionKind: string;
  presentation: {
    schemaVersion: number;
    layout: string;
  };
}

interface AnalysisKindManifest {
  schemaVersion: number;
  kinds: AnalysisKindManifestEntry[];
}

type ExecutableJsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

interface ExecutableSchema {
  type: ExecutableJsonType | ExecutableJsonType[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: ExecutableSchema[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, ExecutableSchema>;
  items?: ExecutableSchema;
  additionalProperties?: boolean | ExecutableSchema;
}

const manifest = JSON.parse(readFileSync(
  new URL("../contracts/analysis/kinds.v1.json", import.meta.url),
  "utf8",
)) as AnalysisKindManifest;
const viewRegistrySource = readFileSync(
  new URL("../src/components/analysis/analysisViewRegistry.tsx", import.meta.url),
  "utf8",
);
const manifestKinds = manifest.kinds.map((entry) => entry.analysisKind).sort();
const registries = {
  descriptors: analysisKindDescriptors,
  execution: analysisExecutors,
  view: analysisViewContracts,
  editor: analysisEditorRegistry,
  graph: analysisGraphPolicies,
  report: analysisReportPolicies,
  commandCreate: analysisCreateAdapters,
  commandUpdate: analysisUpdateValidators,
  commandSchema: analysisCommandSchemas,
  commandFixture: analysisCommandFixtures,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function describeType(value: unknown): ExecutableJsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function typeMatches(schema: ExecutableSchema, value: unknown): boolean {
  const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = describeType(value);
  return expected.includes(actual);
}

function validateSchema(
  schema: ExecutableSchema,
  value: unknown,
  path = "$",
): string[] {
  const errors: string[] = [];

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateSchema(candidate, value, path).length === 0);
    if (matches.length !== 1) {
      errors.push(`${path}: expected exactly one oneOf branch to match, got ${matches.length}`);
      return errors;
    }
  }

  if (!typeMatches(schema, value)) {
    const expected = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
    errors.push(`${path}: expected ${expected}, got ${describeType(value)}`);
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path}: expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: expected minLength ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: expected minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: expected maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: expected maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        errors.push(...validateSchema(schema.items!, entry, `${path}[${index}]`));
      });
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push(`${path}.${key}: missing required property`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) {
        errors.push(...validateSchema(propertySchema, record[key], `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key}: additional property is not allowed`);
        }
      }
    } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          errors.push(...validateSchema(schema.additionalProperties, record[key], `${path}.${key}`));
        }
      }
    }
  }

  return errors;
}

function assertAccepts(schema: AnalysisCommandJsonSchema, value: unknown, message: string): void {
  assert.deepEqual(validateSchema(schema as ExecutableSchema, value), [], message);
}

function assertRejects(schema: AnalysisCommandJsonSchema, value: unknown, message: string): void {
  assert.notEqual(validateSchema(schema as ExecutableSchema, value).length, 0, message);
}

function objectProperty(schema: AnalysisCommandJsonSchema, path: string[]): ExecutableSchema {
  let current: ExecutableSchema | undefined = schema as ExecutableSchema;
  for (const segment of path) {
    current = current?.properties?.[segment];
    assert.ok(current, `schema path must exist: ${path.join(".")}`);
  }
  return current;
}

assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifestKinds, ["distribution", "fitModel", "fitYByX", "hypothesisTest"]);

for (const [layer, registry] of Object.entries(registries)) {
  assert.deepEqual(Object.keys(registry).sort(), manifestKinds, `${layer} registry must match the manifest`);
}

for (const entry of manifest.kinds) {
  const descriptor = analysisKindDescriptors[entry.analysisKind];
  assert.equal(descriptor.identity.analysisKind, entry.analysisKind);
  assert.equal(descriptor.identity.definitionKind, entry.definitionKind);
  assert.equal(descriptor.schema.document, entry.documentSchemaVersion);
  assert.equal(descriptor.schema.presentation, entry.presentation.schemaVersion);
  assert.equal(descriptor.schema.layout, entry.presentation.layout);
  assert.equal(
    descriptor.capabilities.graphEditing,
    analysisGraphPolicies[entry.analysisKind] != null,
    `${entry.analysisKind} graph capability must match its policy`,
  );
  assert.equal(
    descriptor.capabilities.reportEmbedding,
    analysisReportPolicies[entry.analysisKind] != null,
    `${entry.analysisKind} report capability must match its policy`,
  );
  assert.equal(
    analysisCommandSchemas[entry.analysisKind].analysisKind,
    entry.analysisKind,
    `${entry.analysisKind} command schema must project its manifest kind identity`,
  );
  assert.equal(
    analysisCommandFixtures[entry.analysisKind].analysisKind,
    entry.analysisKind,
    `${entry.analysisKind} command fixture must target its manifest kind`,
  );
  assertAccepts(
    analysisCommandSchemas[entry.analysisKind].create,
    analysisCommandFixtures[entry.analysisKind].create,
    `${entry.analysisKind} create fixture must satisfy its executable schema`,
  );
  assertAccepts(
    analysisCommandSchemas[entry.analysisKind].update,
    analysisCommandFixtures[entry.analysisKind].update("analysis-1", 1),
    `${entry.analysisKind} update fixture must satisfy its executable schema`,
  );
  assertAccepts(
    analysisCommandSchemas[entry.analysisKind].run,
    analysisCommandFixtures[entry.analysisKind].run("analysis-1"),
    `${entry.analysisKind} run fixture must satisfy its executable schema`,
  );
}

{
  const distributionCreateDraft = objectProperty(analysisCommandSchemas.distribution.create, ["draft"]);
  const distributionAnalysis = objectProperty(distributionCreateDraft as AnalysisCommandJsonSchema, ["analysis"]);
  const distributionGraphs = objectProperty(distributionCreateDraft as AnalysisCommandJsonSchema, ["graphs"]);
  for (const optionalField of ["name", "weight", "frequency", "by", "nestedSubgroup"]) {
    assert.ok(distributionCreateDraft.properties?.[optionalField], `distribution create must project draft.${optionalField}`);
  }
  assert.ok(distributionAnalysis.properties?.specLimits, "distribution create must project analysis.specLimits");
  assert.deepEqual(
    distributionAnalysis.properties?.fitDistributions?.items?.enum,
    ["normal", "lognormal", "exponential", "gamma", "weibull", "cauchy"],
    "distribution create must expose every supported continuous fit",
  );
  assert.deepEqual(
    Object.keys(distributionGraphs.properties ?? {}).sort(),
    ["boxPlot", "ecdf", "normalQuantile", "overview"],
    "distribution create must project every distribution graph role",
  );
}

{
  const fitYByXCreateDraft = objectProperty(analysisCommandSchemas.fitYByX.create, ["draft"]);
  assert.ok(fitYByXCreateDraft.properties?.name, "fitYByX create must project draft.name");
  assert.ok(fitYByXCreateDraft.properties?.graph, "fitYByX create must project draft.graph");
}

{
  const fitModelCreateDraft = objectProperty(analysisCommandSchemas.fitModel.create, ["draft"]);
  assert.ok(fitModelCreateDraft.properties?.name, "fitModel create must project draft.name");
  assert.ok(fitModelCreateDraft.properties?.construct, "fitModel create must project draft.construct");
  assert.ok(fitModelCreateDraft.properties?.terms, "fitModel create must project draft.terms");
}

{
  const hypothesisCreateDraft = objectProperty(analysisCommandSchemas.hypothesisTest.create, ["draft"]);
  const hypothesisUpdateDraft = objectProperty(analysisCommandSchemas.hypothesisTest.update, ["draft"]);
  assert.ok(hypothesisCreateDraft.properties?.name, "hypothesis-test create must project draft.name");
  assert.ok(hypothesisCreateDraft.properties?.definition, "hypothesis-test create must project draft.definition");
  assert.ok(hypothesisUpdateDraft.properties?.presentation, "hypothesis-test update must project draft.presentation");
}

{
  const minimalDistributionCreate: any = clone(analysisCommandFixtures.distribution.create);
  minimalDistributionCreate.draft.name = "DIM1 Analysis";
  minimalDistributionCreate.draft.weight = { name: "Weight", type: "continuous" };
  minimalDistributionCreate.draft.frequency = { name: "Frequency", type: "continuous" };
  minimalDistributionCreate.draft.by = [{ name: "Site", type: "nominal" }];
  minimalDistributionCreate.draft.nestedSubgroup = { name: "Lot", type: "nominal" };
  delete minimalDistributionCreate.draft.analysis;
  delete minimalDistributionCreate.draft.graphs;
  assertAccepts(
    analysisCommandSchemas.distribution.create,
    minimalDistributionCreate,
    "distribution create schema must accept the canonical minimal draft without optional analysis/graphs",
  );

  const validDistributionCreate: any = clone(analysisCommandFixtures.distribution.create);
  validDistributionCreate.draft.name = "DIM1 Analysis";
  validDistributionCreate.draft.weight = { name: "Weight", type: "continuous" };
  validDistributionCreate.draft.frequency = { name: "Frequency", type: "continuous" };
  validDistributionCreate.draft.by = [{ name: "Site", type: "nominal" }];
  validDistributionCreate.draft.nestedSubgroup = { name: "Lot", type: "nominal" };
  validDistributionCreate.draft.analysis.specLimits = {
    DIM1: { lsl: 80, target: 100, usl: 120 },
  };
  assertAccepts(
    analysisCommandSchemas.distribution.create,
    validDistributionCreate,
    "distribution create schema must accept every transport draft field",
  );

  const invalidDistributionGraph = clone(validDistributionCreate);
  invalidDistributionGraph.draft.graphs.overview = { mode: "4d" } as never;
  assertRejects(
    analysisCommandSchemas.distribution.create,
    invalidDistributionGraph,
    "distribution create schema must reject invalid embedded graph shapes",
  );

  const invalidDistributionGraphRole = clone(validDistributionCreate);
  delete (invalidDistributionGraphRole.draft.graphs as Partial<typeof invalidDistributionGraphRole.draft.graphs>).normalQuantile;
  assertRejects(
    analysisCommandSchemas.distribution.create,
    invalidDistributionGraphRole,
    "distribution create schema must reject missing graph roles",
  );
}

{
  const validFitYByXCreate: any = clone(analysisCommandFixtures.fitYByX.create);
  validFitYByXCreate.draft.name = "Fit Y by X 1";
  validFitYByXCreate.draft.graph = clone(analysisCommandFixtures.distribution.create.draft.graphs.overview);
  assertAccepts(
    analysisCommandSchemas.fitYByX.create,
    validFitYByXCreate,
    "fitYByX create schema must accept optional graph transport",
  );

  const minimalEmbeddedGraphCreate: any = clone(analysisCommandFixtures.fitYByX.create);
  minimalEmbeddedGraphCreate.draft.name = "Fit Y by X 2";
  minimalEmbeddedGraphCreate.draft.graph = clone(analysisCommandFixtures.distribution.create.draft.graphs.overview);
  delete minimalEmbeddedGraphCreate.draft.graph.filters;
  delete minimalEmbeddedGraphCreate.draft.graph.sampling;
  delete minimalEmbeddedGraphCreate.draft.graph.groupThemeSlots;
  assertAccepts(
    analysisCommandSchemas.fitYByX.create,
    minimalEmbeddedGraphCreate,
    "fitYByX create schema must accept the minimal embedded graph transport",
  );

  const invalidFitYByXGraph = clone(validFitYByXCreate);
  invalidFitYByXGraph.draft.graph = { mode: "2d" } as never;
  assertRejects(
    analysisCommandSchemas.fitYByX.create,
    invalidFitYByXGraph,
    "fitYByX create schema must reject incomplete embedded graph transport",
  );
}

{
  const validFitModelCreate: any = clone(analysisCommandFixtures.fitModel.create);
  validFitModelCreate.draft.name = "Fit Model 1";
  validFitModelCreate.draft.construct = { kind: "factorialToDegree", degree: 2 };
  validFitModelCreate.draft.terms = [
    { kind: "main", columnNames: ["Temperature"] },
    { kind: "interaction", columnNames: ["Temperature", "Pressure"] },
    { kind: "power", columnNames: ["Temperature"], exponent: 2 },
  ];
  assertAccepts(
    analysisCommandSchemas.fitModel.create,
    validFitModelCreate,
    "fitModel create schema must accept full construct and term unions",
  );

  for (const validConstruct of [
    { kind: "manual" },
    { kind: "fullFactorial" },
    { kind: "factorialToDegree", degree: 3 },
    { kind: "responseSurface" },
  ] as const) {
    const candidate = clone(validFitModelCreate);
    candidate.draft.construct = validConstruct;
    assertAccepts(analysisCommandSchemas.fitModel.create, candidate, `fitModel create must accept construct ${validConstruct.kind}`);
  }

  const invalidConstructMissingDegree = clone(validFitModelCreate);
  invalidConstructMissingDegree.draft.construct = { kind: "factorialToDegree" } as never;
  assertRejects(
    analysisCommandSchemas.fitModel.create,
    invalidConstructMissingDegree,
    "fitModel create schema must reject factorialToDegree without degree",
  );

  const invalidConstructExtraField = clone(validFitModelCreate);
  invalidConstructExtraField.draft.construct = { kind: "manual", degree: 2 } as never;
  assertRejects(
    analysisCommandSchemas.fitModel.create,
    invalidConstructExtraField,
    "fitModel create schema must reject construct fields from another variant",
  );

  const invalidMainTerm = clone(validFitModelCreate);
  invalidMainTerm.draft.terms = [{ kind: "main", columnNames: ["Temperature", "Pressure"] } as never];
  assertRejects(
    analysisCommandSchemas.fitModel.create,
    invalidMainTerm,
    "fitModel create schema must reject main terms with multiple columns",
  );

  const invalidInteractionTerm = clone(validFitModelCreate);
  invalidInteractionTerm.draft.terms = [{ kind: "interaction", columnNames: ["Temperature"] } as never];
  assertRejects(
    analysisCommandSchemas.fitModel.create,
    invalidInteractionTerm,
    "fitModel create schema must reject interaction terms with fewer than two columns",
  );

  const invalidPowerTerm = clone(validFitModelCreate);
  invalidPowerTerm.draft.terms = [{ kind: "power", columnNames: ["Temperature"], exponent: 3 } as never];
  assertRejects(
    analysisCommandSchemas.fitModel.create,
    invalidPowerTerm,
    "fitModel create schema must reject unsupported power exponents",
  );
}

{
  const validHypothesisCreate: any = clone(analysisCommandFixtures.hypothesisTest.create);
  validHypothesisCreate.draft.name = "Hypothesis Test 1";
  assertAccepts(
    analysisCommandSchemas.hypothesisTest.create,
    validHypothesisCreate,
    "hypothesis-test create schema must accept draft name and full long-layout definition",
  );

  const validWideHypothesisCreate = clone(validHypothesisCreate);
  validWideHypothesisCreate.draft.definition.roles = {
    layout: "wide",
    measurements: [
      { name: "Before", type: "continuous" },
      { name: "After", type: "continuous" },
    ],
    subject: { name: "PairId", type: "id" },
  };
  validWideHypothesisCreate.draft.definition.studyDesign = "pairedOrBlocked";
  assertAccepts(
    analysisCommandSchemas.hypothesisTest.create,
    validWideHypothesisCreate,
    "hypothesis-test create schema must accept the wide roles variant",
  );

  const validHypothesisUpdate: any = clone(analysisCommandFixtures.hypothesisTest.update("analysis-1", 1));
  validHypothesisUpdate.draft.presentation = {
    schemaVersion: 1,
    layout: "hypothesis-test-v1",
    activeResultTab: "audit",
    collapsedSections: ["audit", "methodEvidence"],
    graphs: {
      showRawData: true,
      showIntervals: false,
      showDiagnostics: true,
    },
    tableSort: {
      key: "pValue",
      direction: "descending",
    },
  };
  assertAccepts(
    analysisCommandSchemas.hypothesisTest.update,
    validHypothesisUpdate,
    "hypothesis-test update schema must accept optional presentation transport",
  );

  const invalidHypothesisRoles = clone(validWideHypothesisCreate);
  invalidHypothesisRoles.draft.definition.roles = {
    layout: "wide",
    response: { name: "Strength", type: "continuous" },
    condition: { name: "Site", type: "nominal" },
    subject: null,
  } as never;
  assertRejects(
    analysisCommandSchemas.hypothesisTest.create,
    invalidHypothesisRoles,
    "hypothesis-test create schema must reject invalid roles variants",
  );

  const invalidHypothesisPresentation = clone(validHypothesisUpdate);
  invalidHypothesisPresentation.draft.presentation = {
    ...invalidHypothesisPresentation.draft.presentation,
    activeResultTab: "summary",
  } as never;
  assertRejects(
    analysisCommandSchemas.hypothesisTest.update,
    invalidHypothesisPresentation,
    "hypothesis-test update schema must reject invalid presentation discriminators",
  );
}

for (const unknownKind of ["unknown", "toString", "__proto__"] as const) {
  assert.throws(
    () => assertRegisteredAnalysisKind(unknownKind as AnalysisKind),
    /Unknown analysis kind/,
    `${unknownKind} must be rejected instead of entering a generic fallback`,
  );
}

assert.notEqual(analysisReportPolicies.distribution, null, "Distribution must register Report embedding");
assert.notEqual(analysisReportPolicies.fitYByX, null, "Fit Y by X must register Report embedding");
assert.deepEqual(analysisKindDescriptors.fitModel.capabilities, {
  graphEditing: false,
  reportEmbedding: false,
});
assert.notEqual(analysisEditorRegistry.fitModel, null, "Fit Model must register an editor policy");
assert.equal(analysisGraphPolicies.fitModel, null);
assert.equal(analysisReportPolicies.fitModel, null);
assert.equal(analysisViewContracts.fitModel.presentationLayout, "fit-model-v1");
assert.match(viewRegistrySource, /fitModel:\s*FitModelAnalysisResults/);
assert.deepEqual(analysisKindDescriptors.hypothesisTest.capabilities, {
  graphEditing: false,
  reportEmbedding: true,
});
assert.equal(analysisGraphPolicies.hypothesisTest, null);
assert.notEqual(analysisReportPolicies.hypothesisTest, null);
assert.equal(
  analysisViewContracts.hypothesisTest.presentationLayout,
  "hypothesis-test-v1",
);

console.log("Analysis kind registry contract passed");
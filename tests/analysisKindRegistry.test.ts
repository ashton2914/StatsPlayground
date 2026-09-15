import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { analysisEditorRegistry } from "../src/components/analysis/analysisEditorRegistry.ts";
import { analysisExecutors } from "../src/components/analysis/analysisExecutors.ts";
import { analysisGraphPolicies } from "../src/components/analysis/analysisGraphPolicies.ts";
import { analysisKindDescriptors } from "../src/components/analysis/analysisKindDescriptors.ts";
import { analysisReportPolicies } from "../src/components/analysis/analysisReportPolicies.ts";
import { analysisViewContracts } from "../src/components/analysis/analysisViewContracts.ts";
import {
  analysisCommandFixtures,
  analysisCommandSchemas,
  analysisCreateAdapters,
  analysisUpdateValidators,
  assertRegisteredAnalysisKind,
} from "../src/applicationCommands/analysisCommands.ts";
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

function validateSchema(
  schema: { type: string; const?: unknown; nullable?: boolean; minItems?: number; minLength?: number; required?: string[]; properties?: Record<string, unknown>; items?: unknown },
  value: unknown,
  path = "$",
): string[] {
  const errors: string[] = [];
  if (value === null && schema.nullable) {
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${String(schema.const)}`);
    return errors;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return errors;
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        errors.push(...validateSchema(propertySchema as never, record[key], `${path}.${key}`));
      }
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return errors;
    }
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        errors.push(...validateSchema(schema.items as never, entry, `${path}[${index}]`));
      });
    }
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path} must be a string`);
      return errors;
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    return errors;
  }
  if (schema.type === "number" && typeof value !== "number") {
    errors.push(`${path} must be a number`);
  }
  return errors;
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
  assert.deepEqual(
    validateSchema(analysisCommandSchemas[entry.analysisKind].create, analysisCommandFixtures[entry.analysisKind].create),
    [],
    `${entry.analysisKind} create fixture must satisfy its executable schema`,
  );
  assert.deepEqual(
    validateSchema(analysisCommandSchemas[entry.analysisKind].update, analysisCommandFixtures[entry.analysisKind].update("analysis-1", 1)),
    [],
    `${entry.analysisKind} update fixture must satisfy its executable schema`,
  );
  assert.deepEqual(
    validateSchema(analysisCommandSchemas[entry.analysisKind].run, analysisCommandFixtures[entry.analysisKind].run("analysis-1")),
    [],
    `${entry.analysisKind} run fixture must satisfy its executable schema`,
  );
}

assert.match(JSON.stringify(analysisCommandSchemas.distribution.create), /responses/);
assert.match(JSON.stringify(analysisCommandSchemas.distribution.create), /fitDistributions/);
assert.match(JSON.stringify(analysisCommandSchemas.fitYByX.create), /factor/);
assert.match(JSON.stringify(analysisCommandSchemas.fitModel.create), /centeringMethod/);
assert.match(JSON.stringify(analysisCommandSchemas.fitModel.create), /terms/);
assert.match(JSON.stringify(analysisCommandSchemas.hypothesisTest.create), /selectorVersion/);

assert.notDeepEqual(
  validateSchema(analysisCommandSchemas.distribution.create, {
    ...analysisCommandFixtures.distribution.create,
    draft: {
      ...analysisCommandFixtures.distribution.create.draft,
      responses: [],
    },
  }),
  [],
  "distribution schema must reject empty responses",
);
assert.notDeepEqual(
  validateSchema(analysisCommandSchemas.fitYByX.create, {
    ...analysisCommandFixtures.fitYByX.create,
    draft: {
      response: analysisCommandFixtures.fitYByX.create.draft.response,
      confidenceLevel: analysisCommandFixtures.fitYByX.create.draft.confidenceLevel,
    },
  }),
  [],
  "fitYByX schema must require a factor field",
);
assert.notDeepEqual(
  validateSchema(analysisCommandSchemas.fitModel.create, {
    ...analysisCommandFixtures.fitModel.create,
    draft: {
      ...analysisCommandFixtures.fitModel.create.draft,
      terms: [],
    },
  }),
  [],
  "fitModel schema must reject missing model terms",
);
assert.notDeepEqual(
  validateSchema(analysisCommandSchemas.hypothesisTest.create, {
    ...analysisCommandFixtures.hypothesisTest.create,
    draft: {
      definition: {
        ...analysisCommandFixtures.hypothesisTest.create.draft.definition,
        selectorVersion: "",
      },
    },
  }),
  [],
  "hypothesisTest schema must reject an empty selectorVersion",
);

assert.throws(
  () => assertRegisteredAnalysisKind("unknown" as AnalysisKind),
  /Unknown analysis kind/,
  "unknown kinds must be rejected instead of entering a generic fallback",
);

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
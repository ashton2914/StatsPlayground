import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const manifest = JSON.parse(readFileSync(
  new URL("../contracts/analysis/kinds.v1.json", import.meta.url),
  "utf8",
)) as AnalysisKindManifest;
const manifestKinds = manifest.kinds.map((entry) => entry.analysisKind).sort();
const registries = {
  descriptors: analysisKindDescriptors,
  execution: analysisExecutors,
  view: analysisViewContracts,
  editor: analysisEditorRegistry,
  graph: analysisGraphPolicies,
  report: analysisReportPolicies,
};

assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifestKinds, ["distribution"]);

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
}

console.log("Analysis kind registry contract passed");
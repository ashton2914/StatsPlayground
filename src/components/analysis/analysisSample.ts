import { createDistributionItem } from "../distribution/distributionConfig";
import type { AnalysisDocument, DistributionAnalysisDefinition } from "../../types/analysis";
import type { DistributionItem } from "../../types/distribution";

const SAMPLE_COLUMN = "DIM1";
const NORMAL_MEAN = 100;
const NORMAL_SIGMA = 15;

export interface AnalysisSample {
  values: number[];
  rows: number[][];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createAnalysisSample(seed = 112, sampleSize = 200): AnalysisSample {
  if (!Number.isInteger(sampleSize) || sampleSize < 2) {
    throw new RangeError("sampleSize must be an integer of at least 2");
  }

  const random = createRandom(seed);
  const values: number[] = [];
  while (values.length < sampleSize) {
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    values.push(NORMAL_MEAN + NORMAL_SIGMA * radius * Math.cos(angle));
    if (values.length < sampleSize) {
      values.push(NORMAL_MEAN + NORMAL_SIGMA * radius * Math.sin(angle));
    }
  }

  return {
    values,
    rows: values.map((value) => [value]),
  };
}

function createSampleDistributionItem(input: {
  datasetId: string;
  distributionId: string;
  distributionName: string;
  createdAt: string;
}): DistributionItem {
  const response = { name: SAMPLE_COLUMN, type: "continuous" as const };
  return createDistributionItem({
    id: input.distributionId,
    name: input.distributionName,
    sourceDatasetId: input.datasetId,
    responses: [response],
    weight: null,
    frequency: null,
    by: [],
    columns: [{
      name: SAMPLE_COLUMN,
      sqlType: "DOUBLE",
      integerCompatible: false,
      field: response,
    }],
    analysis: {
      confidenceLevel: 0.95,
      specLimits: {},
      fitDistributions: ["normal"],
    },
    createdAt: input.createdAt,
  });
}

export function createAnalysisSampleDocument(input: {
  datasetId: string;
  analysisId: string;
  analysisName: string;
  createdAt: string;
}): AnalysisDocument {
  const distribution = createSampleDistributionItem({
    datasetId: input.datasetId,
    distributionId: input.analysisId,
    distributionName: input.analysisName,
    createdAt: input.createdAt,
  });
  const definition: DistributionAnalysisDefinition = {
    kind: "distribution",
    responses: structuredClone(distribution.responses),
    weight: distribution.weight,
    frequency: distribution.frequency,
    by: structuredClone(distribution.by),
    analysis: structuredClone(distribution.analysis),
    graphs: structuredClone(distribution.graphs),
  };

  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: input.analysisId,
    name: input.analysisName,
    analysisKind: "distribution",
    configRevision: 1,
    source: { datasetId: input.datasetId },
    definition,
    presentation: {
      schemaVersion: 1,
      layout: "distribution-v1",
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export const ANALYSIS_SAMPLE_COLUMN = SAMPLE_COLUMN;
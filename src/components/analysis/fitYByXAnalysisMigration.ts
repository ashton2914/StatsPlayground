import { deriveFitYByXPersonality, validateFitYByXRoles } from "../fitYByX/fitYByXConfig";
import type { AnalysisDocument } from "../../types/analysis";
import type { EmbeddedGraphConfig } from "../../types/graphBuilder";
import type { FitYByXItem } from "../../types/fitYByX";

import { createFitYByXAnalysisDocument } from "./adapters/fitYByXAnalysisAdapter";

export const FIT_Y_BY_X_DEFAULT_CONFIDENCE_LEVEL = 0.95;

export interface FitYByXAnalysisMigrationInput {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  fitYByX: FitYByXItem[];
  fitYByXFolders: Record<string, string>;
}

export interface FitYByXAnalysisMigrationResult {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  migratedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isField(value: unknown, expected: FitYByXItem["response"]): boolean {
  return isRecord(value) && value.name === expected.name && value.type === expected.type;
}

function hasValidGraphShape(item: FitYByXItem, graph: unknown): graph is EmbeddedGraphConfig {
  if (!isRecord(graph) || !["2d", "3d", "multivariate"].includes(String(graph.mode))) return false;
  if (!isRecord(graph.modeStates)) return false;
  const twoD = graph.modeStates.twoD;
  const threeD = graph.modeStates.threeD;
  const multivariate = graph.modeStates.multivariate;
  if (!isRecord(twoD) || !isRecord(threeD) || !isRecord(multivariate)) return false;
  if (!isRecord(twoD.encoding) || !Array.isArray(twoD.multiX) || !Array.isArray(twoD.multiY)) return false;
  if (!Array.isArray(twoD.elements) || !Number.isFinite(twoD.smootherLambda)) return false;
  if (!isRecord(threeD.encoding) || !Array.isArray(threeD.elements) || !Number.isFinite(threeD.smootherLambda)) return false;
  if (!Array.isArray(multivariate.columns) || multivariate.chartType !== "correlationMatrix") return false;
  return graph.mode === "2d"
    && isField(twoD.encoding.x, item.factor)
    && isField(twoD.encoding.y, item.response);
}

function validateLegacyFitYByX(item: FitYByXItem): void {
  const roles = validateFitYByXRoles({ response: item.response, factor: item.factor });
  if (!roles.ok) throw new Error(`Invalid legacy Fit Y by X ${item.id}: ${roles.error}`);
  if (item.personality !== deriveFitYByXPersonality(item.factor)) {
    throw new Error(`Invalid legacy Fit Y by X ${item.id}: personality does not match factor`);
  }
  if (!hasValidGraphShape(item, item.graph)) {
    throw new Error(`Invalid legacy Fit Y by X ${item.id}: graph is malformed`);
  }
}

export function migrateLegacyFitYByX(
  input: FitYByXAnalysisMigrationInput,
): FitYByXAnalysisMigrationResult {
  const analyses = [...input.analyses];
  const analysisFolders = { ...input.analysisFolders };
  const occupiedIds = new Set(analyses.map((analysis) => analysis.id));

  for (const item of input.fitYByX) {
    if (occupiedIds.has(item.id)) {
      throw new Error(`Cannot migrate legacy Fit Y by X with colliding Analysis id ${item.id}`);
    }
    validateLegacyFitYByX(item);
    analyses.push(createFitYByXAnalysisDocument({
      item,
      confidenceLevel: FIT_Y_BY_X_DEFAULT_CONFIDENCE_LEVEL,
      updatedAt: item.createdAt,
    }));
    occupiedIds.add(item.id);
    const folder = input.fitYByXFolders[item.id];
    if (folder !== undefined) analysisFolders[item.id] = folder;
  }

  return { analyses, analysisFolders, migratedCount: input.fitYByX.length };
}
import type { AnalysisSummaryEntry } from "../presentation";
import type {
  AnalysisDocumentPatch,
  HypothesisTestAnalysisDocument,
} from "../../../types/analysis";
import type { DatasetMeta } from "../../../types/data";
import type {
  HypothesisTestAnalysisDefinition,
  HypothesisTestAnalysisPresentation,
} from "../../../types/hypothesisTest";
import { validateHypothesisTestDefinition } from "../../hypothesisTest/hypothesisTestConfig";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface HypothesisTestAnalysisEditorItem {
  definition: HypothesisTestAnalysisDefinition;
  presentation: HypothesisTestAnalysisPresentation;
}

export function createHypothesisTestAnalysisDocument(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  definition: HypothesisTestAnalysisDefinition;
  createdAt: string;
}): HypothesisTestAnalysisDocument {
  const validation = validateHypothesisTestDefinition(input.definition);
  if (!validation.ok) throw new Error(`Invalid Hypothesis Test definition: ${validation.code}`);
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: input.id,
    name: input.name,
    analysisKind: "hypothesisTest",
    configRevision: 1,
    source: { datasetId: input.sourceDatasetId },
    definition: structuredClone(input.definition),
    presentation: {
      schemaVersion: 1,
      layout: "hypothesis-test-v1",
      activeResultTab: "results",
      collapsedSections: [],
      graphs: { showRawData: true, showIntervals: true, showDiagnostics: true },
      tableSort: null,
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function describeHypothesisTestAnalysis(
  document: HypothesisTestAnalysisDocument,
  dataset: DatasetMeta | null,
  translate: Translate,
): AnalysisSummaryEntry[] {
  const roles = document.definition.roles;
  const response = roles.layout === "long"
    ? roles.response.name
    : roles.measurements.map((field) => field.name).join(", ");
  return [
    {
      key: "analysis",
      label: translate("workspace.analysis", { defaultValue: "Analysis" }),
      value: translate("hypothesisTest.title", { defaultValue: "Hypothesis Test" }),
    },
    {
      key: "layout",
      label: translate("hypothesisTest.layout.label", { defaultValue: "Layout" }),
      value: translate(`hypothesisTest.layout.${roles.layout}`, { defaultValue: roles.layout }),
    },
    {
      key: "response",
      label: translate("hypothesisTest.response", { defaultValue: "Response" }),
      value: response,
    },
    {
      key: "studyDesign",
      label: translate("hypothesisTest.studyDesign.label", { defaultValue: "Study design" }),
      value: translate(`hypothesisTest.studyDesign.${document.definition.studyDesign}`),
    },
    {
      key: "rows",
      label: translate("workspace.analysisSummary.rows", { defaultValue: "Rows" }),
      value: dataset?.rowCount.toLocaleString() ?? "—",
    },
  ];
}

export function toHypothesisTestEditorItem(
  document: HypothesisTestAnalysisDocument,
): HypothesisTestAnalysisEditorItem {
  return {
    definition: structuredClone(document.definition),
    presentation: structuredClone(document.presentation),
  };
}

export function createHypothesisTestAnalysisPatch(
  document: HypothesisTestAnalysisDocument,
  submitted: HypothesisTestAnalysisEditorItem,
  updatedAt: string,
): AnalysisDocumentPatch {
  const validation = validateHypothesisTestDefinition(submitted.definition);
  if (!validation.ok) throw new Error(`Invalid Hypothesis Test definition: ${validation.code}`);
  const definitionChanged = JSON.stringify(document.definition) !== JSON.stringify(submitted.definition);
  return {
    definition: structuredClone(submitted.definition),
    presentation: structuredClone(submitted.presentation),
    source: structuredClone(document.source),
    configRevision: document.configRevision + (definitionChanged ? 1 : 0),
    updatedAt,
  };
}
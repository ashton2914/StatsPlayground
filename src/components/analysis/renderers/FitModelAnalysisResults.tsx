import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import {
  AnalysisFrame,
  AnalysisShell,
  AnalysisStack,
} from "@/components/analysis/presentation";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";
import {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  createFitModelDefinitionConfig,
  type FitModelUndoSnapshot,
} from "@/components/fitModel/fitModelReportModel";
import type { FitModelReportState } from "@/components/fitModel/useFitModelReport";
import type { FitModelItem, FitModelTerm } from "@/types/fitModel";

import { FitModelAnalysisReport } from "./FitModelAnalysisReport";

type FitModelAnalysisResultsProps = AnalysisKindViewProps<"fitModel">;

export function FitModelAnalysisResults({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onDefinitionChange,
}: FitModelAnalysisResultsProps) {
  const { t } = useTranslation();
  const state = useAnalysisExecution(item, dataset ?? null, runtime);
  const [undoSnapshot, setUndoSnapshot] = useState<FitModelUndoSnapshot | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const editorItem: FitModelItem = useMemo(() => ({
    id: item.id,
    name: item.name,
    sourceDatasetId: item.source.datasetId,
    response: structuredClone(item.definition.response),
    construct: structuredClone(item.definition.construct),
    terms: structuredClone(item.definition.terms),
    centeringMethod: item.definition.centeringMethod,
    createdAt: item.createdAt,
    ...(item.definition.migrationIssue ? { loadIssue: { ...item.definition.migrationIssue } } : {}),
  }), [item]);
  const definition = useMemo(() => createFitModelDefinitionConfig({
    terms: item.definition.terms,
    centeringMethod: item.definition.centeringMethod,
  }), [item.definition.centeringMethod, item.definition.terms]);
  const reportState: FitModelReportState = state.status === "success" && state.analysisKind === "fitModel"
    ? { status: "success", result: state.result, error: null, configurationKey: JSON.stringify(state.request) }
    : state.status === "error" && state.analysisKind === "fitModel"
      ? { status: "error", result: null, error: state.error, configurationKey: null }
      : { status: "loading", result: null, error: null, configurationKey: "pending" };
  const submitDefinition = (nextDefinition: ReturnType<typeof createFitModelDefinitionConfig>) => {
    onDefinitionChange?.({
      definition: {
        ...item.definition,
        terms: nextDefinition.terms.map((term) => structuredClone(term)),
        centeringMethod: nextDefinition.centeringMethod,
        migrationIssue: undefined,
      },
      configRevision: item.configRevision + 1,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleRemoveTerm = (termId: string) => {
    const removal = applyFitModelTermRemoval(definition, termId, undoSnapshot);
    if (!removal.ok) {
      const key = `fitModel.report.removeBlocked.${removal.reason}`;
      const localized = t(key);
      setRemoveMessage(localized === key ? removal.reason : localized);
      return;
    }
    setRemoveMessage(null);
    setUndoSnapshot(removal.undoSnapshot);
    submitDefinition(removal.nextDefinition);
  };

  const handleUndo = () => {
    const undo = applyFitModelTermUndo(definition, undoSnapshot);
    if (!undo.restored) return;
    submitDefinition(undo.nextDefinition);
    setUndoSnapshot(undo.nextUndoSnapshot);
    setRemoveMessage(null);
  };

  const handleAddEffect = (terms: FitModelTerm[]) => {
    setUndoSnapshot(null);
    setRemoveMessage(null);
    submitDefinition(createFitModelDefinitionConfig({
      terms,
      centeringMethod: item.definition.centeringMethod,
    }));
  };

  return (
    <AnalysisShell
      title={item.name}
      sourceName={dataset?.name ?? t("workspace.analysisSourceMissing")}
      summary={[
        { key: "response", label: t("fitModel.response"), value: item.definition.response.name },
        { key: "terms", label: t("fitModel.modelEffects"), value: item.definition.terms.length },
      ]}
      canEditInputs={canEditInputs && dataset != null}
      onEditInputs={onEditInputs}
    >
      <AnalysisFrame
        title={item.definition.response.name}
        contentPadding="compact"
        data-analysis-document
        data-analysis-kind="fitModel"
      >
        <AnalysisStack>
          <FitModelAnalysisReport
            item={editorItem}
            state={reportState}
            datasetMissing={dataset == null}
            loadIssue={editorItem.loadIssue ?? null}
            removeMessage={removeMessage}
            onAddEffect={canEditInputs && onDefinitionChange ? handleAddEffect : undefined}
            onRemoveTerm={handleRemoveTerm}
            onUndoRemove={undoSnapshot && onDefinitionChange ? handleUndo : null}
          />
        </AnalysisStack>
      </AnalysisFrame>
    </AnalysisShell>
  );
}
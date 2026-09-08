import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import {
  AnalysisFrame,
  AnalysisShell,
  AnalysisStack,
  AnalysisText,
} from "@/components/analysis/presentation";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";
import { FitModelSaveColumnsDialog } from "@/components/fitModel/FitModelSaveColumnsDialog";
import {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  createFitModelDefinitionConfig,
  type FitModelUndoSnapshot,
} from "@/components/fitModel/fitModelReportModel";
import { runFitModelSaveColumnsLifecycle } from "@/components/fitModel/fitModelSaveColumnsLifecycle";
import type { FitModelReportState } from "@/components/fitModel/useFitModelReport";
import { dataService } from "@/services/dataService";
import { fitModelService } from "@/services/fitModelService";
import { useHistoryStore } from "@/stores/useHistoryStore";
import type { FitModelItem, FitModelSavedMetric } from "@/types/fitModel";

import { FitModelAnalysisReport } from "./FitModelAnalysisReport";

type FitModelAnalysisResultsProps = AnalysisKindViewProps<"fitModel">;

export function FitModelAnalysisResults({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onDefinitionChange,
  onDatasetChanged,
}: FitModelAnalysisResultsProps) {
  const { t } = useTranslation();
  const state = useAnalysisExecution(item, dataset ?? null, runtime);
  const pendingAction = useHistoryStore((current) => current.pendingAction);
  const tryBeginTableMutation = useHistoryStore((current) => current.tryBeginTableMutation);
  const endTableMutation = useHistoryStore((current) => current.endTableMutation);
  const recordTable = useHistoryStore((current) => current.recordTable);
  const [undoSnapshot, setUndoSnapshot] = useState<FitModelUndoSnapshot | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
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
  const fittedResult = reportState.status === "success" && reportState.result.kind === "fitted"
    ? reportState.result
    : null;
  const saveColumnsDisabled = !canEditInputs || pendingAction != null || fittedResult == null || savePending;

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

  const handleSaveColumns = async (metrics: FitModelSavedMetric[]) => {
    if (!dataset || !fittedResult || saveColumnsDisabled || !tryBeginTableMutation()) return;
    setSavePending(true);
    setSaveError(null);
    try {
      const outcome = await runFitModelSaveColumnsLifecycle({
        save: async () => {
          const expectedGeneration = await dataService.getDatasetGeneration(item.source.datasetId);
          return fitModelService.saveColumns({
            datasetId: item.source.datasetId,
            expectedGeneration,
            modelName: item.name,
            responseColumn: item.definition.response.name,
            terms: item.definition.terms,
            centeringMethod: item.definition.centeringMethod,
            confidenceLevel: 0.95,
            metrics,
          });
        },
        onCommitted: () => setSaveDialogOpen(false),
        afterCommit: async (result) => {
          recordTable(t("history.saveFitModelColumns", { defaultValue: "Save Fit Model columns" }), {
            kind: "changeSet",
            datasetId: item.source.datasetId,
            changeSetId: result.changeSetId,
          });
          await onDatasetChanged?.();
        },
      });
      if (outcome.status === "saveFailed") {
        setSaveError(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      } else if (outcome.postCommitError) {
        setSaveNotice(t("fitModel.report.saveColumns.refreshFailed", {
          defaultValue: "Columns were saved, but the data view could not be refreshed. Reopen the table to see the new columns.",
        }));
      }
    } finally {
      setSavePending(false);
      endTableMutation();
    }
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
          {saveNotice ? <AnalysisText role="status">{saveNotice}</AnalysisText> : null}
          <FitModelAnalysisReport
            item={editorItem}
            state={reportState}
            datasetMissing={dataset == null}
            loadIssue={editorItem.loadIssue ?? null}
            removeMessage={removeMessage}
            onRemoveTerm={handleRemoveTerm}
            onUndoRemove={undoSnapshot && onDefinitionChange ? handleUndo : null}
            onSaveColumns={canEditInputs ? () => setSaveDialogOpen(true) : undefined}
            saveColumnsDisabled={saveColumnsDisabled}
          />
        </AnalysisStack>
        {saveDialogOpen && fittedResult ? (
          <FitModelSaveColumnsDialog
            open
            result={fittedResult}
            pending={savePending}
            error={saveError}
            onClose={() => setSaveDialogOpen(false)}
            onSave={handleSaveColumns}
          />
        ) : null}
      </AnalysisFrame>
    </AnalysisShell>
  );
}
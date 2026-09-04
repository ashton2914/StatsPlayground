import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { dataService } from "@/services/dataService";
import { fitModelService } from "@/services/fitModelService";
import { useFitModelStore } from "@/stores/useFitModelStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import type { DatasetMeta } from "@/types/data";
import type { FitModelItem, FitModelSavedMetric } from "@/types/fitModel";

import { FitModelReport } from "./FitModelReport";
import { FitModelSaveColumnsDialog } from "./FitModelSaveColumnsDialog";
import {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  createFitModelDefinitionConfig,
  type FitModelUndoSnapshot,
} from "./fitModelReportModel";
import { runFitModelSaveColumnsLifecycle } from "./fitModelSaveColumnsLifecycle";
import { useFitModelReport } from "./useFitModelReport";

export interface FitModelViewProps {
  item: FitModelItem;
  dataset: DatasetMeta | undefined;
  readOnly: boolean;
  onDatasetChanged: () => Promise<void>;
}

export function FitModelView({ item, dataset, readOnly, onDatasetChanged }: FitModelViewProps) {
  const { t } = useTranslation();
  const updateDefinition = useFitModelStore((state) => state.updateDefinition);
  const pendingAction = useHistoryStore((state) => state.pendingAction);
  const tryBeginTableMutation = useHistoryStore((state) => state.tryBeginTableMutation);
  const endTableMutation = useHistoryStore((state) => state.endTableMutation);
  const recordTable = useHistoryStore((state) => state.recordTable);
  const [undoSnapshot, setUndoSnapshot] = useState<FitModelUndoSnapshot | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const reportState = useFitModelReport(dataset && !item.loadIssue ? item : null, dataset?.updatedAt ?? null);

  const definition = useMemo(() => createFitModelDefinitionConfig({
    terms: item.terms,
    centeringMethod: item.centeringMethod,
  }), [item.centeringMethod, item.terms]);

  const termCount = useMemo(() => item.terms.length, [item.terms]);

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
    updateDefinition(item.id, removal.nextDefinition);
  };

  const handleUndo = () => {
    const undo = applyFitModelTermUndo(definition, undoSnapshot);

    if (!undo.restored) {
      return;
    }

    updateDefinition(item.id, undo.nextDefinition);
    setUndoSnapshot(undo.nextUndoSnapshot);
    setRemoveMessage(null);
  };

  const fittedResult = reportState.status === "success" && reportState.result.kind === "fitted"
    ? reportState.result
    : null;
  const saveColumnsDisabled = readOnly
    || pendingAction != null
    || fittedResult == null
    || savePending;

  const handleSaveColumns = async (metrics: FitModelSavedMetric[]) => {
    if (!dataset || !fittedResult || saveColumnsDisabled || !tryBeginTableMutation()) return;
    setSavePending(true);
    setSaveError(null);
    try {
      const outcome = await runFitModelSaveColumnsLifecycle({
        save: async () => {
          const expectedGeneration = await dataService.getDatasetGeneration(item.sourceDatasetId);
          return fitModelService.saveColumns({
            datasetId: item.sourceDatasetId,
            expectedGeneration,
            modelName: item.name,
            responseColumn: item.response.name,
            terms: item.terms,
            centeringMethod: item.centeringMethod,
            confidenceLevel: 0.95,
            metrics,
          });
        },
        onCommitted: () => setSaveDialogOpen(false),
        afterCommit: async (result) => {
          recordTable(t("history.saveFitModelColumns", { defaultValue: "Save Fit Model columns" }), {
            kind: "changeSet",
            datasetId: item.sourceDatasetId,
            changeSetId: result.changeSetId,
          });
          await onDatasetChanged();
        },
      });
      if (outcome.status === "saveFailed") {
        setSaveError(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      } else if (outcome.postCommitError) {
        setSaveNotice(t("fitModel.report.saveColumns.refreshFailed", {
          defaultValue: "Columns were saved, but the data view could not be refreshed. Reopen the table to see the new columns.",
        }));
        console.error("Failed to refresh the dataset after saving Fit Model columns", outcome.postCommitError);
      }
    } finally {
      setSavePending(false);
      endTableMutation();
    }
  };

  return (
    <div className="sp-fit-model-view">
      <section className="sp-fit-model-summary">
        <div className="sp-panel-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-source-label" title={dataset ? dataset.name : t("workspace.datasourceDeleted") }>
              {dataset
                ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
                : t("workspace.datasourceDeleted")}
            </span>
          </div>
        </div>

        <div className="sp-fit-model-summary-body">
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.response", { defaultValue: "Y, Response" })}</span>
            <span className="sp-fit-model-summary-value">{item.response.name}</span>
          </div>
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.modelTermCount", { defaultValue: "Model terms" })}</span>
            <span className="sp-fit-model-summary-value">{termCount}</span>
          </div>
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.centeringMethod", { defaultValue: "Centering" })}</span>
            <span className="sp-fit-model-summary-value">
              {t(`fitModel.centering.${item.centeringMethod}`, { defaultValue: item.centeringMethod })}
            </span>
          </div>
        </div>
      </section>

      {saveNotice ? (
        <p className="sp-fit-model-save-notice" role="status">{saveNotice}</p>
      ) : null}

      <FitModelReport
        item={item}
        state={reportState}
        datasetMissing={dataset == null}
        loadIssue={item.loadIssue ?? null}
        removeMessage={removeMessage}
        onRemoveTerm={handleRemoveTerm}
        onUndoRemove={undoSnapshot ? handleUndo : null}
        onSaveColumns={() => {
          setSaveError(null);
          setSaveNotice(null);
          setSaveDialogOpen(true);
        }}
        saveColumnsDisabled={saveColumnsDisabled}
      />
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
    </div>
  );
}

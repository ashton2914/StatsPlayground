import { useTranslation } from "react-i18next";

import type {
  DistributionDocV1,
  DistributionContinuousFitConfigV1,
  ContinuousDistributionIdV1,
  DistributionResultEnvelopeV1,
  DistributionRunFailureV1,
  DistributionRunStateV1,
  DistributionWorkspaceBootstrapV1,
  DistributionYReportPreferencesV1,
} from "@/types/distribution";

import { DistributionReport, ReportBlock } from "./DistributionReport";

import "./distribution.css";

interface DistributionWorkspaceProps {
  item?: DistributionDocV1;
  sourceAvailable?: boolean;
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  runState: DistributionRunStateV1 | null;
  result?: DistributionResultEnvelopeV1 | null;
  failure?: DistributionRunFailureV1 | null;
  onEditInputs?: () => void;
  onRun?: () => void;
  onCancel?: () => void;
  onReportPreferencesChange?: (
    yColumnId: string,
    preferences: DistributionYReportPreferencesV1,
  ) => void;
  onContinuousFitChange?: (continuousFit: DistributionContinuousFitConfigV1) => void;
}

type DistributionWorkspaceState =
  | "empty"
  | "ready"
  | "running"
  | "updating"
  | "cancelled"
  | "stale"
  | "failed"
  | "missing"
  | "unknown"
  | "corrupt";

function workspaceState(
  item: DistributionDocV1 | undefined,
  sourceAvailable: boolean,
  runState: DistributionRunStateV1 | null,
  result: DistributionResultEnvelopeV1 | null,
  failure: DistributionRunFailureV1 | null,
): DistributionWorkspaceState {
  if (!item) return "empty";
  if (item.loadStatus === "unknownVersion") return "unknown";
  if (item.loadStatus === "corrupt") return "corrupt";
  if (item.loadStatus === "missingSource" || !sourceAvailable) return "missing";
  if (runState?.status === "running") return result ? "updating" : "running";
  if (runState?.status === "cancelled") return "cancelled";
  if (runState?.status === "stale") return "stale";
  if (runState?.status === "failed" || failure) return "failed";
  return "ready";
}

export function DistributionWorkspace({
  item,
  sourceAvailable = true,
  bootstrap,
  runState,
  result = null,
  failure = null,
  onEditInputs,
  onRun,
  onCancel,
  onReportPreferencesChange,
  onContinuousFitChange,
}: DistributionWorkspaceProps) {
  const { t } = useTranslation();
  const capabilityCount = bootstrap?.capabilities.length ?? 0;
  const state = workspaceState(item, sourceAvailable, runState, result, failure);
  const isPreserved = item?.loadStatus === "unknownVersion" || item?.loadStatus === "corrupt";
  const canRun = bootstrap?.canRun === true && sourceAvailable && !isPreserved &&
    runState?.status !== "running";
  const percent = runState?.progress?.percent ?? 0;
  const availableFitIds = (bootstrap?.capabilities ?? [])
    .flatMap((capability): ContinuousDistributionIdV1[] => {
      const prefix = "fit.continuous.";
      if (!capability.id.startsWith(prefix)) return [];
      const id = capability.id.slice(prefix.length);
      return ["normal", "lognormal", "exponential", "gamma", "weibull"].includes(id)
        ? [id as ContinuousDistributionIdV1]
        : [];
    });

  return (
    <section className="distribution-workspace" aria-label={t("distribution.title")}>
      <header className="distribution-header">
        <div>
          <h2>{item?.name ?? t("distribution.title")}</h2>
          <p data-testid="distribution-empty-system">
            {t("distribution.runDisabledHint")}
          </p>
        </div>
        <div>
          <span data-testid="distribution-workspace-state">
            {t(`distribution.states.${state}`)}
          </span>
          <span className="distribution-count" data-testid="distribution-capability-count">
            {capabilityCount}
          </span>
        </div>
      </header>
      <div className="distribution-controls">
        <button type="button" data-testid="distribution-edit-inputs" disabled={isPreserved} onClick={onEditInputs}>{t("distribution.editInputs")}</button>
        <button type="button" data-testid="distribution-workspace-run" disabled={!canRun} onClick={onRun}>{t("distribution.run")}</button>
        <button type="button" disabled={!runState || runState.status !== "running"} onClick={onCancel}>{t("common.cancel")}</button>
        <progress max={100} value={percent} aria-label={t("distribution.progress")} />
      </div>
      <div className="distribution-results" data-testid="distribution-results">
        <div className="distribution-report-scroll" data-testid="distribution-report-scroll">
          {result?.groups && result.groups.length > 0 ? (
            <DistributionReport
              groups={result.groups}
              histogramMethod={item?.loadStatus === "ready" || item?.loadStatus === "missingSource"
                ? item.currentConfig.visualDiagnostics?.histogram.method
                : undefined}
              preferences={item?.loadStatus === "ready" || item?.loadStatus === "missingSource"
                ? item.currentConfig.reportPreferences
                : undefined}
              onPreferencesChange={onReportPreferencesChange}
              continuousFit={item?.loadStatus === "ready" || item?.loadStatus === "missingSource"
                ? item.currentConfig.continuousFit
                : undefined}
              onContinuousFitChange={onContinuousFitChange}
              availableFitIds={availableFitIds}
              onEditInputs={onEditInputs}
            />
          ) : (
            result?.reportBlocks.map((block) => <ReportBlock key={block.blockId} block={block} />)
          )}
        </div>
      </div>
    </section>
  );
}
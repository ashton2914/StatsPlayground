import { useTranslation } from "react-i18next";

import { AnalysisText } from "@/components/analysis/presentation";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";

import { analysisKindDescriptors } from "./analysisKindDescriptors";
import {
  analysisViewRegistry,
  type AnalysisViewRuntime,
} from "./analysisViewRegistry";

import "./analysis.css";

export type { AnalysisViewRuntime } from "./analysisViewRegistry";

interface AnalysisViewProps {
  item: AnalysisDocument;
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
  canEditInputs?: boolean;
  onEditInputs?: () => void;
  onGraphConfigChange?: Parameters<
    typeof analysisViewRegistry.distribution
  >[0]["onGraphConfigChange"];
}

type AnalysisCompatibility = "supported" | "schema" | "kind" | "presentation";

function getAnalysisCompatibility(item: AnalysisDocument): AnalysisCompatibility {
  if (item.schemaVersion !== 1) return "schema";

  const descriptor = (analysisKindDescriptors as Partial<Record<
    string,
    typeof analysisKindDescriptors.distribution
  >>)[String(item.analysisKind)];
  if (!descriptor || item.definition?.kind !== descriptor.identity.definitionKind) return "kind";
  if (
    item.presentation?.schemaVersion !== descriptor.schema.presentation
    || item.presentation.layout !== descriptor.schema.layout
  ) {
    return "presentation";
  }
  return "supported";
}

export function AnalysisView({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onGraphConfigChange,
}: AnalysisViewProps) {
  const { t } = useTranslation();
  const compatibility = getAnalysisCompatibility(item);

  if (compatibility === "schema") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis schema." })} />;
  }
  if (compatibility === "kind") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis kind." })} />;
  }
  if (compatibility === "presentation") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupportedPresentation", { defaultValue: "Unsupported analysis presentation." })} />;
  }

  const Renderer = analysisViewRegistry[item.analysisKind];
  return (
    <Renderer
      item={item}
      dataset={dataset}
      runtime={runtime}
      canEditInputs={canEditInputs}
      onEditInputs={onEditInputs}
      onGraphConfigChange={onGraphConfigChange}
    />
  );
}

function UnsupportedAnalysis({ item, message }: { item: AnalysisDocument; message: string }) {
  return (
    <div className="main-content">
      <div className="workspace-empty">
        <h2>{item.name}</h2>
        <AnalysisText role="alert">{message}</AnalysisText>
      </div>
    </div>
  );
}

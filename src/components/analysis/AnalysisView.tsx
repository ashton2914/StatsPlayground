import { useTranslation } from "react-i18next";

import { AnalysisText } from "@/components/analysis/presentation";
import type { AnalysisDocument, AnalysisDocumentPatch } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

import type { AnalysisGraphRoleByKind } from "./analysisGraphPolicies";
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
  onDefinitionChange?: (patch: AnalysisDocumentPatch) => void;
  onDatasetChanged?: () => Promise<void>;
  onGraphConfigChange?: (
    role: AnalysisGraphRoleByKind[AnalysisDocument["analysisKind"]],
    graph: EmbeddedGraphConfig,
  ) => void;
}

type AnalysisCompatibility = "supported" | "schema" | "kind" | "presentation";

function getAnalysisCompatibility(item: AnalysisDocument): AnalysisCompatibility {
  if (item.schemaVersion !== 1) return "schema";

  const descriptor = analysisKindDescriptors[item.analysisKind];
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
  onDefinitionChange,
  onDatasetChanged,
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

  if (item.analysisKind === "distribution") {
    return (
      <analysisViewRegistry.distribution
        item={item}
        dataset={dataset}
        runtime={runtime}
        canEditInputs={canEditInputs}
        onEditInputs={onEditInputs}
        onGraphConfigChange={onGraphConfigChange
          ? (role, graph) => onGraphConfigChange(role, graph)
          : undefined}
      />
    );
  }

  if (item.analysisKind === "fitModel") {
    return (
      <analysisViewRegistry.fitModel
        item={item}
        dataset={dataset}
        runtime={runtime}
        canEditInputs={canEditInputs}
        onEditInputs={onEditInputs}
        onDefinitionChange={onDefinitionChange}
        onDatasetChanged={onDatasetChanged}
      />
    );
  }

  if (item.analysisKind === "hypothesisTest") {
    return (
      <analysisViewRegistry.hypothesisTest
        item={item}
        dataset={dataset}
        runtime={runtime}
        canEditInputs={canEditInputs}
        onEditInputs={onEditInputs}
      />
    );
  }

  return (
    <analysisViewRegistry.fitYByX
      item={item}
      dataset={dataset}
      runtime={runtime}
      canEditInputs={canEditInputs}
      onEditInputs={onEditInputs}
      onGraphConfigChange={onGraphConfigChange
        ? (role, graph) => onGraphConfigChange(role, graph)
        : undefined}
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

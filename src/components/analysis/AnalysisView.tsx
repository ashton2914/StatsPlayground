import { useTranslation } from "react-i18next";

import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";

interface AnalysisViewProps {
  item: AnalysisDocument;
  dataset?: DatasetMeta;
}

export function AnalysisView({ item, dataset }: AnalysisViewProps) {
  const { t } = useTranslation();

  return (
    <div className="main-content">
      <div className="workspace-empty">
        <h2>{item.name}</h2>
        <p>
          {dataset
            ? t("workspace.datasourceLabel", { name: dataset.name })
            : t("workspace.analysisSourceMissing")}
        </p>
      </div>
    </div>
  );
}
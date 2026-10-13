import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGraphBuilderNewStore } from "@/stores/useGraphBuilderNewStore";
import type { GraphNewLayer } from "@/types/graphBuilderNew";
import { GraphLayerCard } from "../graphBuilder/shared/GraphBuilderChrome";
import { PointsOptions, LineOptions } from "../graphBuilder/shared/GraphLayerOptions";

export function GraphBuilderNewLayers({ documentId, layers, disabled }: { documentId: string; layers: GraphNewLayer[]; disabled: boolean }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const { addLayer, removeLayer, setLayerOptions } = useGraphBuilderNewStore();
  return <div className="graph-builder-new-layer-list">
    {layers.map(layer => {
      const label = layer.kind === "timeSeries" ? t("graphNewUi.timeSeries") : t(`graph.type.${layer.kind}`);
      const Editor = layer.kind === "points" ? PointsOptions : LineOptions;
      return <GraphLayerCard key={layer.id} label={label} icon={layer.kind === "points" ? "●" : "╱"} modeBadge="2D"
        testId={`graph-layer-${layer.kind}`} removeDisabled={disabled}
        removeAriaLabel={t("graphNewUi.removeLayer", { layer: label })}
        onRemove={() => removeLayer(documentId, layer.id)}>
        <div className="gb-layer-body" data-layer-id={layer.id}>
          <Editor options={{ ...layer.options }} disabled={disabled} t={t}
            onChange={patch => setLayerOptions(documentId, layer.id, patch)} />
        </div>
      </GraphLayerCard>;
    })}
    <button className="graph-builder-new-add-layer" type="button" aria-label={t("graph.addLayer")}
      disabled={disabled} aria-expanded={adding} onClick={() => setAdding(!adding)}>+</button>
    {adding && <div className="graph-builder-new-add-options" data-testid="graph-layer-add">
      {(["points", "line", "timeSeries"] as const).map(kind => <button key={kind} type="button"
        disabled={disabled || layers.some(layer => layer.kind === kind)} onClick={() => { addLayer(documentId, kind); setAdding(false); }}>
        {kind === "timeSeries" ? t("graphNewUi.timeSeries") : t(`graph.type.${kind}`)}
      </button>)}
    </div>}
  </div>;
}

export const GRAPH_SERIES_BASE_ZLEVEL = 0;
export const GRAPH_SERIES_OVERLAY_ZLEVEL = 10;

interface GraphOptionLike {
  series?: unknown;
  [key: string]: unknown;
}

interface SeriesLike {
  id?: unknown;
  zlevel?: unknown;
  markLine?: unknown;
  [key: string]: unknown;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasShowTrue(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { show?: unknown }).show === true;
}

function hasVisibleSeriesLabel(series: SeriesLike): boolean {
  const coreSeries = series as SeriesLike & {
    label?: unknown;
    endLabel?: unknown;
    upperLabel?: unknown;
  };
  if (hasShowTrue(coreSeries.label) || hasShowTrue(coreSeries.endLabel) || hasShowTrue(coreSeries.upperLabel)) {
    return true;
  }
  return false;
}

function isOverlayCarrier(series: SeriesLike): boolean {
  const id = typeof series.id === "string" ? series.id : "";
  if (id.startsWith("__ref_lines_")) return true;
  if (id.startsWith("__band_ref_lines_")) return true;
  if (id.endsWith("__fitstats")) return true;
  if (series.markLine && typeof series.markLine === "object") return true;
  if (hasVisibleSeriesLabel(series)) return true;
  return false;
}

function withSeriesLayer(series: SeriesLike): SeriesLike {
  const current = asNumber(series.zlevel);
  if (isOverlayCarrier(series)) {
    const overlay = current == null
      ? GRAPH_SERIES_OVERLAY_ZLEVEL
      : Math.max(current, GRAPH_SERIES_OVERLAY_ZLEVEL);
    return { ...series, zlevel: overlay };
  }
  const base = current == null ? GRAPH_SERIES_BASE_ZLEVEL : current;
  return { ...series, zlevel: base };
}

export function withInterleavedGraphLayers(option: GraphOptionLike): GraphOptionLike {
  if (!Array.isArray(option.series)) return option;
  const nextSeries = option.series.map((s) => {
    if (!s || typeof s !== "object") return s;
    return withSeriesLayer(s as SeriesLike);
  });
  return { ...option, series: nextSeries };
}

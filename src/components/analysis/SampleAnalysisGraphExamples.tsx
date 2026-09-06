import type { CSSProperties } from "react";

import type { GraphPanelOptionFactory } from "@/graphCore";

export function createSampleEcdfOption(responseName: string): GraphPanelOptionFactory {
  return ({ option }) => {
    const sourceSeries = Array.isArray(option.series) ? option.series : [];
    const mapAxis = (
      source: unknown,
      transform: (axis: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      if (Array.isArray(source)) {
        return source.map((axis, index) => index === 0 && axis != null && typeof axis === "object"
          ? transform(axis as Record<string, unknown>)
          : axis);
      }
      return source != null && typeof source === "object"
        ? transform(source as Record<string, unknown>)
        : source;
    };
    return {
      ...option,
      xAxis: mapAxis(option.xAxis, (axis) => ({ ...axis, type: "value", name: responseName })),
      yAxis: mapAxis(option.yAxis, (axis) => ({
        ...axis,
        type: "value",
        name: "Cumulative probability",
        data: undefined,
        min: 0,
        max: 1,
        ...(axis.axisLabel != null && typeof axis.axisLabel === "object"
          ? { axisLabel: { ...(axis.axisLabel as Record<string, unknown>), formatter: undefined } }
          : {}),
      })),
      series: sourceSeries.map((series, index) => {
        if (series == null || typeof series !== "object" || Array.isArray(series)) return series;
        const source = series as Record<string, unknown>;
        const sourceData = Array.isArray(source.data) ? source.data : [];
        const lineStyle = source.lineStyle != null && typeof source.lineStyle === "object"
          ? source.lineStyle as Record<string, unknown>
          : {};
        return {
          ...source,
          type: "line",
          data: sourceData.map((point) => Array.isArray(point) && point.length >= 2
            ? [point[1], point[0]]
            : point),
          step: "end",
          smooth: false,
          showSymbol: false,
          lineStyle: { ...lineStyle, width: 2 },
          areaStyle: index === 0 ? { opacity: 0.12 } : undefined,
        };
      }),
    };
  };
}

export interface SampleFiveNumberRangeProps {
  responseName: string;
  minimum: number;
  q1: number;
  median: number;
  q3: number;
  maximum: number;
  mean: number;
}

function position(value: number, minimum: number, maximum: number): string {
  if (maximum <= minimum) return "50%";
  const fraction = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return `${fraction * 100}%`;
}

function formatValue(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

export function SampleFiveNumberRange({
  responseName,
  minimum,
  q1,
  median,
  q3,
  maximum,
  mean,
}: SampleFiveNumberRangeProps) {
  const q1Position = position(q1, minimum, maximum);
  const q3Position = position(q3, minimum, maximum);
  const iqrWidth = maximum <= minimum ? "0%" : `${Math.max(0, ((q3 - q1) / (maximum - minimum)) * 100)}%`;

  return (
    <div
      className="analysis-sample-range"
      role="img"
      aria-label={`${responseName} five-number range`}
    >
      <div className="analysis-sample-range-scale" aria-hidden="true">
        <span className="analysis-sample-range-whisker" />
        <span
          className="analysis-sample-range-iqr"
          style={{ left: q1Position, width: iqrWidth }}
        />
        <span className="analysis-sample-range-tick analysis-sample-range-min" />
        <span
          className="analysis-sample-range-tick analysis-sample-range-q1"
          style={{ left: q1Position } as CSSProperties}
        />
        <span
          className="analysis-sample-range-tick analysis-sample-range-median"
          style={{ left: position(median, minimum, maximum) } as CSSProperties}
        />
        <span
          className="analysis-sample-range-tick analysis-sample-range-q3"
          style={{ left: q3Position } as CSSProperties}
        />
        <span className="analysis-sample-range-tick analysis-sample-range-max" />
        <span
          className="analysis-sample-range-mean"
          style={{ left: position(mean, minimum, maximum) } as CSSProperties}
        />
      </div>
      <div className="analysis-sample-range-values">
        <span>{formatValue(minimum)}</span>
        <span>{formatValue(median)}</span>
        <span>{formatValue(maximum)}</span>
      </div>
    </div>
  );
}
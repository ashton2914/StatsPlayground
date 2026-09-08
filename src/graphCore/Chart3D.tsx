/**
 * Chart3D — 基于 echarts-gl 的三维图表渲染组件。
 *
 * 由 <Graph> 在「3D 模式且存在支持 3D 的启用图层」时使用。导入
 * "echarts-gl" 以向全局 echarts 注册 grid3D / surface / scatter3D 组件，
 * 然后用 build3DOption 生成的 option 渲染。相机旋转、缩放、光照、
 * tooltip 均由 echarts-gl 原生提供，与 2D 图表共用同一套 ECharts 引擎。
 */

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
// 副作用导入：注册 3D 组件（grid3D、series-surface、series-scatter3D 等）。
import "echarts-gl";
import type { GraphSpec, GraphData } from "./types";
import { withoutGraphAnimation } from "./animation";
import { getGraphTheme } from "./theme";
import { build3DOption, type Build3DResult } from "./threeD";
import { useThemeStore } from "@/stores/useThemeStore";
import { useTranslation } from "react-i18next";
import type { GraphDataFrame } from "@/types/graphData";

interface Chart3DProps {
  spec: GraphSpec;
  data: GraphData;
  frame?: GraphDataFrame;
  built?: Build3DResult;
  title?: string;
  minHeight?: number;
}

export function Chart3D({ spec, data, frame, built: providedBuilt, title, minHeight = 240 }: Chart3DProps) {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const built = useMemo(
    () => providedBuilt ?? build3DOption(spec, data, getGraphTheme(), frame),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, data, frame, providedBuilt, themeMode],
  );

  // 初始化 / 销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const inst = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  // 更新 option。notMerge=true 以彻底替换（避免 3D 残留旧 series）。
  useEffect(() => {
    const inst = chartRef.current;
    if (!inst) return;
    if (built.option) {
      inst.setOption(withoutGraphAnimation(built.option as echarts.EChartsCoreOption), true);
    } else {
      inst.clear();
    }
  }, [built]);

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-card)", minHeight }}>
      {title && (
        <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--fg-secondary)", background: "var(--bg-header)" }}>
          {title}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        {!built.option && built.hint && (
          <div
            className="gb-empty"
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {t(built.hint.key, { defaultValue: built.hint.def })}
          </div>
        )}
      </div>
    </div>
  );
}

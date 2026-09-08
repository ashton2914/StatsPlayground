/**
 * threeD.ts — 基于 echarts-gl 的 3D 场景 option 构建。
 *
 * 由 <Chart3D> 使用。把 GraphSpec（3D 模式 + surface / points 图层）
 * 与列式数据转成 echarts-gl 的 grid3D + series-surface / series-scatter3D
 * option。曲面数据在前端按原始 X/Y 坐标聚合（均值/中位数）成规则网格，
 * 缺失组合保留为空洞，再交给 echarts-gl。
 *
 * 由于 echarts-gl 未提供官方 TS 类型，这里的 option 以宽松对象构造，
 * 交给 setOption 时按 echarts 的 core option 处理。
 */

import type { GraphSpec, GraphData } from "./types.ts";
import type { GraphTheme } from "./theme.ts";
import { DEFAULT_GROUP_KEY } from "./types.ts";
import { buildContourPolylines } from "./contours3d.ts";
import { collectFrame3DPoints, type Typed3DPoint } from "./threeDFrame.ts";
import type { GraphDataFrame } from "@/types/graphData";

/** 3D 散点上限。 */
const POINT_CAP = 8000;

type SurfaceStat = "mean" | "median";

interface SurfaceGrid {
  xs: number[];
  ys: number[];
  values: Float64Array;
  verts: number[][];
  dataShape: [number, number];
  zmin: number;
  zmax: number;
}

/** 将 #rrggbb 向黑（ratio<0）或白（ratio>0）混合，ratio∈[-1,1]。 */
function shade(hex: string, ratio: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => (ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio));
  const cl = (n: number) => Math.max(0, Math.min(255, n));
  const hx = (n: number) => cl(n).toString(16).padStart(2, "0");
  return `#${hx(mix(r))}${hx(mix(g))}${hx(mix(b))}`;
}

interface XYZ { xi: number; yi: number; zi: number }

function isMissingValue(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function colIndices(data: GraphData, x?: string, y?: string, z?: string): XYZ {
  return {
    xi: x ? data.columns.indexOf(x) : -1,
    yi: y ? data.columns.indexOf(y) : -1,
    zi: z ? data.columns.indexOf(z) : -1,
  };
}

/** 聚合一组 z 值（mean / median / sum）。 */
function aggZ(zs: number[], stat: string): number {
  const n = zs.length;
  if (n === 0) return 0;
  if (stat === "sum") { let s = 0; for (const z of zs) s += z; return s; }
  if (stat === "median") {
    const a = [...zs].sort((p, q) => p - q);
    const m = a.length;
    return m % 2 ? a[(m - 1) / 2] : (a[m / 2 - 1] + a[m / 2]) / 2;
  }
  let s = 0;
  for (const z of zs) s += z;
  return s / n;
}

/** 误差幅度：stdErr / stdDev / ci95（auto → stdErr）。样本 <2 返回 0。 */
function errMagnitude(zs: number[], kind: string): number {
  const n = zs.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const z of zs) mean += z;
  mean /= n;
  let ss = 0;
  for (const z of zs) { const d = z - mean; ss += d * d; }
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const k = kind === "auto" ? "stdErr" : kind;
  if (k === "stdDev") return sd;
  if (k === "ci95") return 1.96 * se;
  return se;
}

/** 按原始 X/Y 网格聚合，保留缺失位置为空洞（NaN）；不对 Z 值做邻域平滑。 */
function buildSurfaceData(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  stat: SurfaceStat,
  smoothness: number,
): SurfaceGrid | null {
  const { xi, yi, zi } = colIndices(data, xName, yName, zName);
  if (xi < 0 || yi < 0 || zi < 0) return null;

  const xSet = new Set<number>();
  const ySet = new Set<number>();
  const observations: { x: number; y: number; z: number }[] = [];
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    const z = Number(row[zi]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      xSet.add(x);
      ySet.add(y);
      observations.push({ x, y, z });
    }
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  if (nx < 2 || ny < 2) return null;

  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, i) => [y, i]));
  const cells: (number[] | undefined)[] = new Array(nx * ny);
  for (const observation of observations) {
    const i = xIndex.get(observation.x);
    const j = yIndex.get(observation.y);
    if (i === undefined || j === undefined) continue;
    (cells[j * nx + i] ??= []).push(observation.z);
  }

  let values = new Float64Array(nx * ny);
  values.fill(NaN);
  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    if (cell?.length) values[idx] = aggZ(cell, stat);
  }

  let hasCompleteQuad = false;
  for (let j = 0; j < ny - 1 && !hasCompleteQuad; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (
        Number.isFinite(values[j * nx + i])
        && Number.isFinite(values[j * nx + i + 1])
        && Number.isFinite(values[(j + 1) * nx + i])
        && Number.isFinite(values[(j + 1) * nx + i + 1])
      ) {
        hasCompleteQuad = true;
        break;
      }
    }
  }
  if (!hasCompleteQuad) return null;
  const blend = Math.max(0, Math.min(1, smoothness));
  if (blend > 0) {
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
    for (let pass = 0; pass < 4; pass++) {
      const next = new Float64Array(values.length);
      next.fill(NaN);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = j * nx + i;
          const current = values[idx];
          if (!Number.isFinite(current)) continue;
          let sum = 0;
          let count = 0;
          for (const [di, dj] of neighbors) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
            const neighbor = values[nj * nx + ni];
            if (!Number.isFinite(neighbor)) continue;
            sum += neighbor;
            count++;
          }
          next[idx] = count > 0 ? current * (1 - blend) + (sum / count) * blend : current;
        }
      }
      values = next;
    }
  }

  const verts: number[][] = [];
  let zmin = Infinity, zmax = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const z = values[j * nx + i];
      verts.push([xs[i], ys[j], z]);
      if (Number.isFinite(z)) {
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
      }
    }
  }
  return { xs, ys, values, verts, dataShape: [ny, nx], zmin, zmax };
}

/** 抽取 3D 散点 [x,y,z]（Z 缺省时 z=0）。 */
function buildScatterData(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string | undefined,
): { pts: number[][]; zmin: number; zmax: number } | null {
  const { xi, yi, zi } = colIndices(data, xName, yName, zName);
  if (xi < 0 || yi < 0) return null;
  const pts: number[][] = [];
  let zmin = Infinity, zmax = -Infinity;
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    let z = 0;
    if (zi >= 0) {
      z = Number(row[zi]);
      if (!Number.isFinite(z)) continue;
    }
    pts.push([x, y, z]);
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  }
  if (pts.length === 0) return null;
  if (zi < 0) { zmin = 0; zmax = 0; }
  let out = pts;
  if (pts.length > POINT_CAP) {
    out = [];
    const step = pts.length / POINT_CAP;
    for (let i = 0; i < POINT_CAP; i++) out.push(pts[Math.floor(i * step)]);
  }
  return { pts: out, zmin, zmax };
}

function buildSurfaceDataFromPoints(
  points: readonly Typed3DPoint[],
  stat: SurfaceStat,
  smoothness: number,
): SurfaceGrid | null {
  const xSet = new Set<number>();
  const ySet = new Set<number>();
  const observations: { x: number; y: number; z: number }[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z ?? NaN)) continue;
    const z = point.z as number;
    xSet.add(point.x);
    ySet.add(point.y);
    observations.push({ x: point.x, y: point.y, z });
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  if (nx < 2 || ny < 2) return null;

  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, i) => [y, i]));
  const cells: (number[] | undefined)[] = new Array(nx * ny);
  for (const observation of observations) {
    const i = xIndex.get(observation.x);
    const j = yIndex.get(observation.y);
    if (i === undefined || j === undefined) continue;
    (cells[j * nx + i] ??= []).push(observation.z);
  }

  let values = new Float64Array(nx * ny);
  values.fill(NaN);
  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    if (cell?.length) values[idx] = aggZ(cell, stat);
  }

  let hasCompleteQuad = false;
  for (let j = 0; j < ny - 1 && !hasCompleteQuad; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (
        Number.isFinite(values[j * nx + i])
        && Number.isFinite(values[j * nx + i + 1])
        && Number.isFinite(values[(j + 1) * nx + i])
        && Number.isFinite(values[(j + 1) * nx + i + 1])
      ) {
        hasCompleteQuad = true;
        break;
      }
    }
  }
  if (!hasCompleteQuad) return null;

  const blend = Math.max(0, Math.min(1, smoothness));
  if (blend > 0) {
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
    for (let pass = 0; pass < 4; pass++) {
      const next = new Float64Array(values.length);
      next.fill(NaN);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = j * nx + i;
          const current = values[idx];
          if (!Number.isFinite(current)) continue;
          let sum = 0;
          let count = 0;
          for (const [di, dj] of neighbors) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
            const neighbor = values[nj * nx + ni];
            if (!Number.isFinite(neighbor)) continue;
            sum += neighbor;
            count++;
          }
          next[idx] = count > 0 ? current * (1 - blend) + (sum / count) * blend : current;
        }
      }
      values = next;
    }
  }

  const verts: number[][] = [];
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const z = values[j * nx + i];
      verts.push([xs[i], ys[j], z]);
      if (Number.isFinite(z)) {
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
      }
    }
  }
  return { xs, ys, values, verts, dataShape: [ny, nx], zmin, zmax };
}

function buildScatterDataFromPoints(
  points: readonly Typed3DPoint[],
  requireZ: boolean,
): { pts: number[][]; zmin: number; zmax: number } | null {
  const pts: number[][] = [];
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    let z = 0;
    if (requireZ) {
      if (!Number.isFinite(point.z ?? NaN)) continue;
      z = point.z as number;
    }
    pts.push([point.x, point.y, z]);
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  if (pts.length === 0) return null;
  if (!requireZ) {
    zmin = 0;
    zmax = 0;
  }
  if (pts.length <= POINT_CAP) return { pts, zmin, zmax };
  const capped: number[][] = [];
  const step = pts.length / POINT_CAP;
  for (let i = 0; i < POINT_CAP; i++) capped.push(pts[Math.floor(i * step)]);
  return { pts: capped, zmin, zmax };
}

export interface Build3DResult {
  /** echarts-gl option（宽松类型）。空表示还不足以渲染。 */
  option: Record<string, unknown> | null;
  /** 无法渲染时的提示 key + 默认文案。 */
  hint?: { key: string; def: string };
}

export interface Built3DPanel extends Build3DResult {
  title: string;
  groupXValue: string | null;
  groupYValue: string | null;
}

export interface Built3DGraph {
  panels: Built3DPanel[];
  cols: number;
  rows: number;
}

interface Shared3DRanges {
  x?: { min: number; max: number };
  y?: { min: number; max: number };
  z?: { min: number; max: number };
}

/** 构建 3D option。当绑定不足时返回 hint。 */
export function build3DOption(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  frame?: GraphDataFrame,
): Build3DResult {
  return build3DOptionFromPoints(
    spec,
    data,
    theme,
    frame ? collectFrame3DPoints(frame) : undefined,
  );
}

function build3DOptionFromPoints(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  framePoints?: readonly Typed3DPoint[],
  sharedRanges?: Shared3DRanges,
): Build3DResult {
  const xf = spec.encoding.x;
  const yf = spec.encoding.y;
  const zf = spec.encoding.z;
  const els = spec.elements ?? [];
  const surfaceEl = els.find((e) => e.kind === "surface" && e.enabled !== false);
  const contourEl = els.find((e) => e.kind === "contour3d" && e.enabled !== false);
  const pointsEl = els.find((e) => e.kind === "scatter3d" && e.enabled !== false);
  const surfaceStat: SurfaceStat = surfaceEl?.options?.stat === "median" ? "median" : "mean";
  const rawSurfaceSmoothness = Number(surfaceEl?.options?.smoothness ?? 0);
  const surfaceSmoothness = Number.isFinite(rawSurfaceSmoothness)
    ? Math.max(0, Math.min(1, rawSurfaceSmoothness))
    : 0;
  const contourStat: SurfaceStat = contourEl?.options?.stat === "median" ? "median" : "mean";
  const rawContourSmoothness = Number(contourEl?.options?.smoothness ?? 0);
  const contourSmoothness = Number.isFinite(rawContourSmoothness)
    ? Math.max(0, Math.min(1, rawContourSmoothness))
    : 0;
  const contourLevels = Number(contourEl?.options?.levels ?? 10);

  if (!surfaceEl && !contourEl && !pointsEl) {
    return { option: null, hint: { key: "graph.threeD.addSurface", def: "Add a Surface, Contour, or Scatter layer to render in 3D." } };
  }
  if (!xf || !yf) {
    return { option: null, hint: { key: "graph.threeD.dragXY", def: "Drag columns onto X and Y (and Z) to build a 3D chart." } };
  }
  if ((surfaceEl || contourEl) && !zf) {
    return { option: null, hint: { key: "graph.threeD.dragHint", def: "Drag a column onto Z to build a 3D surface or contour plot." } };
  }

  // 分组：当绑定了 Overlay（图例）列时，按其值把数据切成多组，
  // 每组各自成一张 surface / 一簇 scatter3D，颜色取该组「渐变」标记的
  // 颜色（主题自动为每个图例分配不同色，用户可切换，跟点/线/面一致）。
  const grouping = spec.encoding.overlay ?? spec.encoding.color;
  const styles = spec.styles ?? {};
  const gradientColorOf = (key: string): string => {
    const s = styles[key];
    return s?.gradient?.color || s?.fill?.color || s?.point?.color || "#4a6cf7";
  };
  const lineColorOf = (key: string): string => {
    const s = styles[key];
    return s?.line?.color || s?.gradient?.color || s?.point?.color || s?.fill?.color || "#4a6cf7";
  };

  const series: Record<string, unknown>[] = [];
  // 记录每组占用的 series 下标 + 名称 + 主题色，之后为每组建一个作
  // 用于这些 series 的 visualMap（右上角渐变条），并着色其曲面/散点。
  const groupSeries: { name: string; color: string; indices: number[] }[] = [];
  let hasSurfaceSeries = false;

  // 渐变标尺范围。对 surface plot 用「实际曲面（插值网格）」的
  // 最高/最低（比原始数据范围更紧凑，对比度更高）；无曲面
  // （纯散点）时用散点 Z 范围。
  const hasZ = !!zf;
  let smin = Infinity, smax = -Infinity; // 曲面网格
  let pmin = Infinity, pmax = -Infinity; // 散点

  // 3D 散点设置（继承自 2D 散点）：汇总统计、误差区间、区间样式。
  const scOpts = (pointsEl?.options ?? {}) as Record<string, unknown>;
  const summaryStat = String(scOpts.summaryStat ?? "none");
  const errInterval = String(scOpts.errorInterval ?? "auto");
  const intStyle = String(scOpts.intervalStyle ?? "errorBar") === "band" ? "band" : "errorBar";
  const summarize = summaryStat !== "none" && !!zf;
  const useFramePoints = framePoints !== undefined;
  const resolvedFramePoints = framePoints ?? [];

  const addLayers = (
    gdata: GraphData | null,
    gpoints: readonly Typed3DPoint[] | null,
    name: string,
    gradientColor: string,
    lineColor: string,
  ) => {
    const indices: number[] = [];
    const buildGrid = (stat: SurfaceStat, smoothness: number): SurfaceGrid | null => (
      gpoints
        ? buildSurfaceDataFromPoints(gpoints, stat, smoothness)
        : (gdata && zf ? buildSurfaceData(gdata, xf.name, yf.name, zf.name, stat, smoothness) : null)
    );
    const surfaceGrid = surfaceEl && xf && yf && zf
      ? buildGrid(surfaceStat, 0)
      : null;
    if (surfaceEl && surfaceGrid) {
        series.push({
          type: "surface",
          name,
          data: surfaceGrid.verts,
          dataShape: surfaceGrid.dataShape,
          shading: "lambert",
          itemStyle: { color: gradientColor },
          wireframe: { show: false },
        });
        hasSurfaceSeries = true;
        indices.push(series.length - 1);
        if (surfaceGrid.zmin < smin) smin = surfaceGrid.zmin;
        if (surfaceGrid.zmax > smax) smax = surfaceGrid.zmax;
    }
    if (contourEl && xf && yf && zf) {
      const contourGrid = surfaceGrid
        && surfaceStat === contourStat
        && contourSmoothness === 0
        ? surfaceGrid
        : buildGrid(contourStat, contourSmoothness);
      if (contourGrid) {
        const zOffset = (contourGrid.zmax - contourGrid.zmin) / 1_000_000;
        const contours = buildContourPolylines(contourGrid, contourLevels);
        for (let contourIndex = 0; contourIndex < contours.length; contourIndex += 1) {
          const contour = contours[contourIndex];
          series.push({
            type: "line3D",
            coordinateSystem: "cartesian3D",
            name: `${name}__contour_${contour.level}_${contourIndex}`,
            data: contour.points.map(([x, y, z]) => [x, y, z + zOffset]),
            lineStyle: { color: lineColor, width: 2, opacity: 0.9 },
            silent: true,
          });
        }
        if (contourGrid.zmin < smin) smin = contourGrid.zmin;
        if (contourGrid.zmax > smax) smax = contourGrid.zmax;
      }
    }
    if (pointsEl && xf && yf) {
      if (!summarize) {
        // 原始散点：全部点，参与深度渐变着色。
        const sc = gpoints
          ? buildScatterDataFromPoints(gpoints, !!zf)
          : (gdata ? buildScatterData(gdata, xf.name, yf.name, zf?.name) : null);
        if (sc) {
          series.push({
            type: "scatter3D",
            name,
            data: sc.pts,
            symbolSize: 6,
            itemStyle: { color: gradientColor, opacity: 0.9 },
          });
          indices.push(series.length - 1);
          if (sc.zmin < pmin) pmin = sc.zmin;
          if (sc.zmax > pmax) pmax = sc.zmax;
        }
      } else {
        // 汇总：按 (X, Y) 坐标分箱，每个位置画一个点 (x, y, agg(Z))；
        // 误差沿 Z 方向绘制（误差棒 / 色带），跟 2D 选项一致。
        const cells = new Map<string, { x: number; y: number; zs: number[] }>();
        if (gpoints) {
          for (const point of gpoints) {
            const x = point.x;
            const y = point.y;
            const z = Number(point.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const key = `${x}|${y}`;
            let c = cells.get(key);
            if (!c) { c = { x, y, zs: [] }; cells.set(key, c); }
            c.zs.push(z);
          }
        } else if (gdata) {
          const xi = gdata.columns.indexOf(xf.name);
          const yi = gdata.columns.indexOf(yf.name);
          const zi = gdata.columns.indexOf(zf!.name);
          for (const r of gdata.rows) {
            const x = Number(r[xi]);
            const y = Number(r[yi]);
            const z = Number(r[zi]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const key = `${x}|${y}`;
            let c = cells.get(key);
            if (!c) { c = { x, y, zs: [] }; cells.set(key, c); }
            c.zs.push(z);
          }
        }
        const pts: number[][] = [];
        const errSegs: number[][][] = [];
        for (const c of cells.values()) {
          const az = aggZ(c.zs, summaryStat);
          pts.push([c.x, c.y, az]);
          if (az < pmin) pmin = az;
          if (az > pmax) pmax = az;
          if (errInterval !== "none") {
            const e = errMagnitude(c.zs, errInterval);
            if (e > 0) {
              errSegs.push([[c.x, c.y, az - e], [c.x, c.y, az + e]]);
              if (az - e < pmin) pmin = az - e;
              if (az + e > pmax) pmax = az + e;
            }
          }
        }
        if (pts.length) {
          // 误差指示（先画，位于点之下）：沿 Z 的多段线；band = 粗且半透明。
          for (let i = 0; i < errSegs.length; i++) {
            series.push({
              type: "line3D",
              coordinateSystem: "cartesian3D",
              name: `${name}__err_${i}`,
              data: errSegs[i],
              lineStyle: {
                color: lineColor,
                width: intStyle === "band" ? 8 : 2,
                opacity: intStyle === "band" ? 0.28 : 0.9,
              },
              silent: true,
            });
          }
          // 汇总点（纯色 group 色）。
          series.push({
            type: "scatter3D",
            name,
            data: pts,
            symbolSize: 8,
            itemStyle: { color: gradientColor, opacity: 1, borderWidth: 0.5, borderColor: "rgba(0,0,0,0.3)" },
          });
        }
      }
    }
    if (indices.length) groupSeries.push({ name, color: gradientColor, indices });
  };

  let grouped = false;
  if (grouping && useFramePoints) {
    const seen = new Set<string>();
    const groups: string[] = [];
    for (const point of resolvedFramePoints) {
      const key = String(point.group ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      groups.push(key);
    }
    grouped = groups.length > 0;
    const hidden = new Set(spec.hiddenGroups ?? []);
    for (const gkey of groups) {
      if (hidden.has(gkey)) continue;
      addLayers(
        null,
        resolvedFramePoints.filter((point) => String(point.group ?? "") === gkey),
        gkey,
        gradientColorOf(gkey),
        lineColorOf(gkey),
      );
    }
  } else if (grouping) {
    const gi = data.columns.indexOf(grouping.name);
    if (gi >= 0) {
      // 首次出现顺序去重分组。
      const seen = new Set<string>();
      const groups: string[] = [];
      for (const row of data.rows) {
        const gv = row[gi];
        if (isMissingValue(gv)) continue;
        const k = String(gv);
        if (!seen.has(k)) { seen.add(k); groups.push(k); }
      }
      grouped = groups.length > 0;
      // 响应图例面板的「隐藏分组」（眼睛开关）：被隐藏的组不生成任何
      // series，也不出现在图例中——与 2D 行为一致。
      const hidden = new Set(spec.hiddenGroups ?? []);
      for (const gkey of groups) {
        if (hidden.has(gkey)) continue;
        const rows = data.rows.filter((r) => String(r[gi]) === gkey);
        addLayers(
          { columns: data.columns, rows },
          null,
          gkey,
          gradientColorOf(gkey),
          lineColorOf(gkey),
        );
      }
    }
  }
  if (!grouped) {
    addLayers(
      useFramePoints ? null : data,
      useFramePoints ? resolvedFramePoints : null,
      zf?.name ?? "series",
      gradientColorOf(DEFAULT_GROUP_KEY),
      lineColorOf(DEFAULT_GROUP_KEY),
    );
  }

  if (series.length === 0) {
    return { option: null, hint: { key: "graph.threeD.notEnough", def: "Need at least 3 rows with numeric values." } };
  }

  // 标尺：有曲面则用曲面网格极值（对比度更高），否则用散点 Z 范围。
  const hasSurfRange = smax > smin;
  const rmin = sharedRanges?.z?.min ?? (hasSurfRange ? smin : pmin);
  const rmax = sharedRanges?.z?.max ?? (hasSurfRange ? smax : pmax);
  const useDepth = hasZ && rmax > rmin;

  const visualSmoothness = hasSurfaceSeries ? surfaceSmoothness : 0;
  const mainIntensity = 1.2 - 0.9 * visualSmoothness;
  const ambientIntensity = 0.3 + 0.6 * visualSmoothness;

  const axisCommon = {
    nameTextStyle: { color: theme.fgSecondary },
    axisLine: { lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgDim },
    splitLine: { lineStyle: { color: theme.gridLine } },
  };

  const option: Record<string, unknown> = {
    backgroundColor: theme.bgCanvas,
    tooltip: {},
    xAxis3D: { type: "value", name: xf.name, ...axisCommon, ...sharedRanges?.x },
    yAxis3D: { type: "value", name: yf.name, ...axisCommon, ...sharedRanges?.y },
    zAxis3D: { type: "value", name: zf?.name ?? "", ...axisCommon, ...sharedRanges?.z },
    grid3D: {
      boxWidth: 100,
      boxDepth: 100,
      boxHeight: 100,
      axisPointer: { lineStyle: { color: theme.fgDim } },
      viewControl: { autoRotate: false, rotateSensitivity: 1, zoomSensitivity: 1 },
      light: {
        main: { intensity: mainIntensity, shadow: false, alpha: 40, beta: 40 },
        ambient: { intensity: ambientIntensity },
      },
    },
    series,
  };

  // 顶部图例：仅当存在 surface 图层（用到渐变着色）时，在右上角画一个
  // 紧凑的自定义图例——每行是「组名 + 一小段渐变色条」。visualMap 只负责
  // 给曲面/散点着色（show:false），图例外观由 graphic 元素精确排版。
  if (useDepth) {
    option.visualMap = groupSeries.map((g) => ({
      type: "continuous",
      show: false,
      dimension: 2,
      seriesIndex: g.indices,
      min: rmin,
      max: rmax,
      inRange: { color: [shade(g.color, -0.4), g.color, shade(g.color, 0.6)] },
    }));

    if (surfaceEl && groupSeries.length > 0) {
      const rowH = 22;
      const top0 = 12;
      const barW = 40;
      const barH = 12;
      // 每行一个 group（右上角锚定），内部子元素用局部 x/y 定位——这样
      // 文字的 textVerticalAlign:middle 相对 y 精确居中，色条与文字对齐。
      const elements = groupSeries.map((g, i) => ({
        type: "group",
        right: 10,
        top: top0 + i * rowH,
        children: [
          {
            type: "text",
            x: -(barW + 6),
            y: barH / 2,
            style: {
              text: g.name,
              textAlign: "right",
              textVerticalAlign: "middle",
              fill: theme.fgSecondary,
              font: "11px sans-serif",
            },
          },
          {
            type: "rect",
            x: -barW,
            y: 0,
            shape: { width: barW, height: barH, r: 2 },
            style: {
              fill: {
                type: "linear",
                x: 0, y: 0, x2: 1, y2: 0,
                colorStops: [
                  { offset: 0, color: shade(g.color, -0.4) },
                  { offset: 0.5, color: g.color },
                  { offset: 1, color: shade(g.color, 0.6) },
                ],
              },
            },
          },
        ],
      }));
      option.graphic = { elements };
    }
  }

  return { option };
}

function orderedFacetKeys(
  values: readonly (string | undefined)[],
  dictionary: readonly string[],
  valueOrder?: readonly string[],
  includeDictionary = false,
): string[] {
  const present = new Set(values.filter((value): value is string => value !== undefined));
  const allowed = includeDictionary ? new Set([...dictionary, ...present]) : present;
  const natural = [
    ...dictionary.filter((value) => allowed.has(value)),
    ...values.filter((value): value is string => value !== undefined && !dictionary.includes(value)),
  ];
  const uniqueNatural = [...new Set(natural)];
  if (!valueOrder) return uniqueNatural;
  return [
    ...valueOrder.filter((value) => allowed.has(value)),
    ...uniqueNatural.filter((value) => !valueOrder.includes(value)),
  ];
}

function finiteRange(values: readonly number[]): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max > min ? { min, max } : undefined;
}

function computeShared3DRanges(
  spec: GraphSpec,
  data: GraphData,
  framePoints?: readonly Typed3DPoint[],
): Shared3DRanges {
  const xValues: number[] = [];
  const yValues: number[] = [];
  const zValues: number[] = [];
  const hiddenGroups = new Set(spec.hiddenGroups ?? []);
  if (framePoints) {
    for (const point of framePoints) {
      if (point.group !== undefined && hiddenGroups.has(point.group)) continue;
      xValues.push(point.x);
      yValues.push(point.y);
      if (point.z !== undefined) zValues.push(point.z);
    }
  } else {
    const xIndex = data.columns.indexOf(spec.encoding.x?.name ?? "");
    const yIndex = data.columns.indexOf(spec.encoding.y?.name ?? "");
    const zIndex = data.columns.indexOf(spec.encoding.z?.name ?? "");
    const groupIndex = data.columns.indexOf(spec.encoding.overlay?.name ?? "");
    for (const row of data.rows) {
      if (groupIndex >= 0 && hiddenGroups.has(String(row[groupIndex]))) continue;
      const x = Number(row[xIndex]);
      const y = Number(row[yIndex]);
      const z = zIndex >= 0 ? Number(row[zIndex]) : undefined;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (zIndex >= 0 && !Number.isFinite(z)) continue;
      xValues.push(x);
      yValues.push(y);
      if (z !== undefined) zValues.push(z);
    }
  }
  return {
    x: finiteRange(xValues),
    y: finiteRange(yValues),
    z: finiteRange(zValues),
  };
}

function buildFacetTitle(
  spec: GraphSpec,
  groupXValue: string | null,
  groupYValue: string | null,
): string {
  const parts: string[] = [];
  if (spec.encoding.groupX && groupXValue !== null) {
    parts.push(`${spec.encoding.groupX.name}=${groupXValue}`);
  }
  if (spec.encoding.groupY && groupYValue !== null) {
    parts.push(`${spec.encoding.groupY.name}=${groupYValue}`);
  }
  return parts.join(" | ");
}

export function build3DPanels(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  frame?: GraphDataFrame,
  valueOrders?: Record<string, string[]>,
): Built3DGraph {
  const groupX = spec.encoding.groupX;
  const groupY = spec.encoding.groupY;
  if (!groupX && !groupY) {
    return {
      panels: [{
        title: "",
        ...build3DOption(spec, data, theme, frame),
        groupXValue: null,
        groupYValue: null,
      }],
      cols: 1,
      rows: 1,
    };
  }

  const framePoints = frame ? collectFrame3DPoints(frame) : undefined;
  const groupXIndex = groupX ? data.columns.indexOf(groupX.name) : -1;
  const groupYIndex = groupY ? data.columns.indexOf(groupY.name) : -1;
  const xIndex = data.columns.indexOf(spec.encoding.x?.name ?? "");
  const yIndex = data.columns.indexOf(spec.encoding.y?.name ?? "");
  const zIndex = data.columns.indexOf(spec.encoding.z?.name ?? "");
  const plottableRows = framePoints ? [] : data.rows.filter((row) => {
    if (!Number.isFinite(Number(row[xIndex])) || !Number.isFinite(Number(row[yIndex]))) return false;
    return zIndex < 0 || Number.isFinite(Number(row[zIndex]));
  });
  const xValues = framePoints
    ? framePoints.map((point) => point.facetX)
    : plottableRows.map((row) => groupXIndex >= 0 && !isMissingValue(row[groupXIndex]) ? String(row[groupXIndex]) : undefined);
  const yValues = framePoints
    ? framePoints.map((point) => point.facetY)
    : plottableRows.map((row) => groupYIndex >= 0 && !isMissingValue(row[groupYIndex]) ? String(row[groupYIndex]) : undefined);
  const xKeys = groupX
    ? orderedFacetKeys(xValues, frame?.dictionaries.facetX ?? [], valueOrders?.[groupX.name], !!frame)
    : [null];
  const yKeys = groupY
    ? orderedFacetKeys(yValues, frame?.dictionaries.facetY ?? [], valueOrders?.[groupY.name], !!frame)
    : [null];
  const resolvedXKeys: Array<string | null> = xKeys.length > 0 ? xKeys : [null];
  const resolvedYKeys: Array<string | null> = yKeys.length > 0 ? yKeys : [null];
  const subSpec: GraphSpec = {
    ...spec,
    encoding: { ...spec.encoding, groupX: undefined, groupY: undefined },
  };
  const sharedRanges = computeShared3DRanges(spec, data, framePoints);
  const panels: Built3DPanel[] = [];

  for (const groupYValue of resolvedYKeys) {
    for (const groupXValue of resolvedXKeys) {
      const panelPoints = framePoints?.filter((point) => (
        (groupXValue === null || point.facetX === groupXValue)
        && (groupYValue === null || point.facetY === groupYValue)
      ));
      const panelRows = framePoints ? [] : data.rows.filter((row) => (
        (groupXValue === null || String(row[groupXIndex]) === groupXValue)
        && (groupYValue === null || String(row[groupYIndex]) === groupYValue)
      ));
      const panelData = framePoints
        ? data
        : { columns: data.columns, rows: panelRows };
      panels.push({
        title: buildFacetTitle(spec, groupXValue, groupYValue),
        ...build3DOptionFromPoints(subSpec, panelData, theme, panelPoints, sharedRanges),
        groupXValue,
        groupYValue,
      });
    }
  }

  return {
    panels,
    cols: Math.max(1, resolvedXKeys.length),
    rows: Math.max(1, resolvedYKeys.length),
  };
}

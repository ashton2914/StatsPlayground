/**
 * 图表构建器项 — 与数据表平行的项目级实体。
 *
 * 引用一个数据表作为数据源，自身仅保存编码与元素配置。
 */

import type { ChartElement, FieldRef, GroupStyleMap, RefLineY, RefLineX, YAxisConfig } from "@/graphCore";
import type { FilterRuleItem } from "./filter";
import type { GraphSampling } from "./graphData";

export type GroupThemeSlots = Record<string, Record<string, number>>;

export type GraphSlotKey =
  | "x"
  | "y"
  | "z"
  | "color"
  | "size"
  | "overlay"
  | "groupX"
  | "groupY"
  | "groupZ"
  | "wrap";

export type GraphBuilderMode = "2d" | "3d" | "multivariate";

export type Graph2DSlotKey = Exclude<GraphSlotKey, "z" | "groupZ">;
export type Graph3DSlotKey = GraphSlotKey;

export interface Graph2DState {
  /** 编码槽：字段引用（2D） */
  encoding: Partial<Record<Graph2DSlotKey, FieldRef>>;
  /** 仅转置最终显示，不改变字段绑定或后端请求。 */
  transposed?: boolean;
  /** 2D X 轴多列绑定 */
  multiX: FieldRef[];
  /** 2D Y 轴多列绑定 */
  multiY: FieldRef[];
  /** 启用的 2D 图形元素 */
  elements: ChartElement[];
  /** 平滑器 lambda 0~1 */
  smootherLambda: number;
  /** 分组样式 */
  groupStyles?: GroupStyleMap;
  /** 隐藏的图例分组 */
  hiddenGroups?: string[];
  /** Y 轴参考线 */
  refLinesY?: RefLineY[];
  /** X 轴参考线 */
  refLinesX?: RefLineX[];
  /** 自动规范线（Y） */
  autoSpecLinesY?: boolean;
  /** 自动规范线（X） */
  autoSpecLinesX?: boolean;
  /** @deprecated 历史全局规范线开关 */
  autoSpecLines?: boolean;
  /** Y 轴配置 */
  yAxis?: YAxisConfig;
  /** X 轴配置 */
  xAxis?: YAxisConfig;
}

export interface Graph3DState {
  /** 编码槽：字段引用（3D） */
  encoding: Partial<Record<Graph3DSlotKey, FieldRef>>;
  /** 启用的 3D 图形元素 */
  elements: ChartElement[];
  /** 平滑器 lambda 0~1 */
  smootherLambda: number;
  /** 分组样式 */
  groupStyles?: GroupStyleMap;
  /** 隐藏的图例分组 */
  hiddenGroups?: string[];
}

export interface MultivariateGraphState {
  columns: FieldRef[];
  chartType: "correlationMatrix";
  correlationMethod: "pearson" | "spearman" | "kendall";
}

export interface GraphBuilderItem {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 引用的数据表 ID */
  sourceDatasetId: string;
  /** 当前激活模式 */
  mode: GraphBuilderMode;
  /** 各模式独立状态快照 */
  modeStates: {
    twoD: Graph2DState;
    threeD: Graph3DState;
    multivariate: MultivariateGraphState;
  };
  /** Raw-point sampling mode persisted on the graph item. Missing
   *  values from older project files are treated as full data. */
  sampling?: GraphSampling;
  /** Persisted theme slot identity by grouping field and normalized group key. */
  groupThemeSlots?: GroupThemeSlots;
  /** JMP-style Local Data Filter rules. Each rule narrows (AND) or
   *  expands (OR) the row set fed into the graph. Stored on the item so
   *  it persists with the project and survives reloads. */
  filters?: FilterRuleItem[];
  /** 创建时间 ISO 字符串。
 *
 *  注：图所属的文件夹不属于图本身的内禀属性——按 #7 设计，文件夹只
 *  是图在 spprj 内被放置到的位置。该映射由 `useFolderStore.graphFolders`
 *  统一管理，保存时单独传给后端，绝不持久化在 .spgh 文件体里。 */
  createdAt: string;
}

export type EmbeddedGraphConfig = Pick<
  GraphBuilderItem,
  "mode" | "modeStates" | "filters" | "sampling" | "groupThemeSlots"
>;

export function isCorrelationMatrixItem(item: GraphBuilderItem): boolean {
  const asUnknown = item as unknown as {
    mode?: GraphBuilderMode;
    modeStates?: { multivariate?: { chartType?: string } };
    elements?: ChartElement[];
  };
  if (asUnknown.mode === "multivariate" && asUnknown.modeStates?.multivariate?.chartType === "correlationMatrix") {
    return true;
  }
  return (asUnknown.elements ?? []).some(
    (element: ChartElement) =>
      element.enabled !== false && element.kind === "correlationMatrix",
  );
}

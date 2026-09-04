/**
 * 图表构建器全局状态。
 *
 * 与 useDataStore（数据表）平行，统一构成项目目录。
 */

import { create } from "zustand";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { GraphSampling } from "@/types/graphData";
import { normalizeGraphBuilderItem } from "@/components/graphBuilder/graphBuilderMode";
import { migrateLegacyGraphColumnName } from "@/components/graphBuilder/graphColumnIdentity";
import { normalizeGroupThemeSlots } from "@/components/graphBuilder/graphThemeIdentity";
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

const FULL_SAMPLING: GraphSampling = { mode: "full" };

function normalizeSampling(sampling: GraphSampling | undefined): GraphSampling {
  if (!sampling || sampling.mode === "full") {
    return FULL_SAMPLING;
  }
  const size = Math.trunc(sampling.size);
  const seed = Math.trunc(sampling.seed);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(seed) || seed < 0) {
    return FULL_SAMPLING;
  }
  return { mode: "sample", size, seed };
}

function normalizeItem(item: GraphBuilderItem): GraphBuilderItem {
  const normalized = normalizeGraphBuilderItem(item);
  const groupThemeSlots = normalizeGroupThemeSlots(normalized.groupThemeSlots);
  return {
    ...normalized,
    sampling: normalizeSampling(normalized.sampling),
    groupThemeSlots: Object.keys(groupThemeSlots).length > 0 ? groupThemeSlots : undefined,
  };
}

interface GraphBuilderStore {
  items: GraphBuilderItem[];
  addItem: (item: GraphBuilderItem) => void;
  updateItem: (id: string, patch: Partial<GraphBuilderItem>) => void;
  renameItem: (id: string, name: string) => void;
  migrateLegacyColumnName: (datasetId: string, oldName: string, newName: string, sqlType: string) => void;
  deleteItem: (id: string) => void;
  /** 删除某数据表时联动删除其所有图表 */
  deleteByDataset: (datasetId: string) => void;
  /** 从项目文件批量加载 */
  loadFromProject: (items: GraphBuilderItem[]) => void;
  /** 重置（关闭项目） */
  reset: () => void;
  /** 自增计数器（用于默认命名） */
  counter: number;
  bumpCounter: (n: number) => void;
}

export const useGraphBuilderStore = create<GraphBuilderStore>((set) => ({
  items: [],
  counter: 0,
  addItem: (item) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((s) => ({ items: [...s.items, normalizeItem(item)] }));
  },
  updateItem: (id, patch) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => ({
        items: s.items.map((it) => (it.id === id ? { ...it, ...patch, sampling: normalizeSampling((patch.sampling ?? it.sampling)) } : it)),
      }));
    },
  renameItem: (id, name) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => ({
        items: s.items.map((it) => (it.id === id ? { ...it, name } : it)),
      }));
    },
  migrateLegacyColumnName: (datasetId, oldName, newName, sqlType) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => ({
        items: s.items.map((item) => (
          item.sourceDatasetId === datasetId
            ? migrateLegacyGraphColumnName(item, oldName, newName, sqlType)
            : item
        )),
      }));
    },
  deleteItem: (id) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    },
  deleteByDataset: (datasetId) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => ({
        items: s.items.filter((it) => it.sourceDatasetId !== datasetId),
      }));
    },
  loadFromProject: (items) =>
    set(() => {
      const normalized = items.map(normalizeItem);
      const maxNum = items.reduce((m, it) => {
        const match = it.name.match(/^图表(\d+)$/);
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, 0);
      return { items: normalized, counter: maxNum };
    }),
  reset: () => set({ items: [], counter: 0 }),
  bumpCounter: (n) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set({ counter: n });
  },
}));

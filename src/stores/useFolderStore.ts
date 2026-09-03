/**
 * 文件夹层级状态。
 *
 * `DIRECTORY` 标签页支持任意深度的文件夹（类似 Obsidian）。本 store 持有：
 *   1. `folders`         — 当前存在的所有文件夹路径（含空文件夹）；
 *   2. `tableFolders`    — datasetId → 文件夹路径；
 *   3. `graphFolders`    — graphId   → 文件夹路径；
 *   4. `tabulateFolders` — tabulateId → 文件夹路径；
 *   5. `collapsed`       — 折叠状态（仅 UI，不持久化到 spprj，但写 localStorage）；
 *
 * 设计要点：
 *   - 文件名使用真实显示名而非 UUID，所以重名要做 `(2)` 自动后缀；
 *     这里只在 `assignFolder` 层处理「同名不同 id」的简单查重；表/图同名
 *     在同一文件夹里能并存，因为后端 spprj 写入器按扩展名分别去重。
 *   - 文件夹路径用 `/` 作分隔符，**不**以 `/` 开头或结尾。
 *   - 删除文件夹时，将其内的文件移动到父级（不丢数据）。
 */

import { create } from "zustand";
import { useProjectStore } from "./useProjectStore";
import { assertProjectMutable } from "../utils/saveReadOnly";

const STORAGE_KEY_COLLAPSED = "sp.folderTree.collapsed";

/** 文件夹路径规范化：去除前后斜杠/空白，多余的 `//` 合并。返回 `null` 表示根目录。 */
export function normalizeFolderPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return null;
  const segs = trimmed.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  return segs.join("/");
}

/** 给定一个文件夹路径，返回所有祖先（含自身），由浅到深。根目录返回空数组。 */
export function folderAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** 文件夹路径的父级，根目录返回 `null`。 */
export function folderParent(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? null : path.slice(0, idx);
}

/** 文件夹的「短名」（最后一段）。 */
export function folderBaseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

/** 字符校验：与后端 `sanitize_name` 同步——禁止文件系统不友好的字符以及
 *  首尾的点和空白。返回错误码（用作 i18n key）或 `null` 表示合法。 */
export function validateFolderOrFileName(name: string): "empty" | "invalidChars" | "edgeDots" | null {
  if (!name) return "empty";
  if (/[/\\:*?"<>|]/.test(name)) return "invalidChars";
  if (/^[.\s]|[.\s]$/.test(name)) return "edgeDots";
  return null;
}

function loadCollapsed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, true> = {};
      for (const k of Object.keys(parsed)) {
        if (parsed[k]) out[k] = true;
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function persistCollapsed(state: Record<string, true>) {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify(state));
  } catch {
    // localStorage may be full or unavailable; non-fatal.
  }
}

interface FolderStore {
  /** 所有文件夹路径（含空文件夹与所有祖先），规范化后。 */
  folders: string[];
  /** datasetId → 文件夹路径。 */
  tableFolders: Record<string, string>;
  /** graphId   → 文件夹路径。 */
  graphFolders: Record<string, string>;
  /** tabulateId → 文件夹路径。 */
  tabulateFolders: Record<string, string>;
  /** fitYByXId → 文件夹路径。 */
  fitYByXFolders: Record<string, string>;
  /** fitModelId → 文件夹路径。 */
  fitModelFolders: Record<string, string>;
  /** distributionId → 文件夹路径。 */
  distributionFolders: Record<string, string>;
  /** 折叠态：`{path: true}` 表示该文件夹处于折叠。仅 UI 用。 */
  collapsed: Record<string, true>;

  /** 从 spprj 项目载入。会规范化输入路径。 */
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders?: Record<string, string>;
    fitModelFolders?: Record<string, string>;
    distributionFolders?: Record<string, string>;
  }) => void;

  /** 关闭项目时重置。 */
  reset: () => void;

  /** 新建一个文件夹（在指定父级下）。如果同名已存在则自动加 `(2)` 后缀。
   *  返回最终使用的完整路径。 */
  createFolder: (parent: string | null, baseName: string) => string;

  /** 重命名一个文件夹。会同步更新内部所有引用此前缀的路径。
   *  如果同级出现重名则自动加 `(2)` 后缀。返回最终的新路径。
   *  非法字符直接返回 `null`，调用方应先调用 `validateFolderOrFileName`。 */
  renameFolder: (oldPath: string, newBaseName: string) => string | null;

  /** 删除一个文件夹：其内的所有子文件夹与表 / 图都「上移」到父级，避免丢失。 */
  deleteFolder: (path: string) => void;

  /** 把一个文件夹整体移动到 `newParent` 下（`null` = 根目录）。同级重名自动后缀。
   *  禁止移动到自己的子树。返回最终路径或 `null`（非法操作）。 */
  moveFolder: (path: string, newParent: string | null) => string | null;

  /** 把单个表移动到指定文件夹（`null` = 根目录）。 */
  setTableFolder: (datasetId: string, folder: string | null) => void;
  /** 把单个图表移动到指定文件夹。 */
  setGraphFolder: (graphId: string, folder: string | null) => void;
  /** 把单个 Tabulate 配置移动到指定文件夹。 */
  setTabulateFolder: (tabulateId: string, folder: string | null) => void;
  /** 把单个 Fit Y by X 配置移动到指定文件夹。 */
  setFitYByXFolder: (fitYByXId: string, folder: string | null) => void;
  /** 把单个 Fit Model 配置移动到指定文件夹。 */
  setFitModelFolder: (fitModelId: string, folder: string | null) => void;
  /** 把单个 Distribution 配置移动到指定文件夹。 */
  setDistributionFolder: (distributionId: string, folder: string | null) => void;

  /** 清理已删除项目的归属信息。 */
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validDistributionIds: Set<string>,
    validFitModelIds?: Set<string>,
  ) => void;

  /** 切换文件夹折叠态。 */
  toggleCollapsed: (path: string) => void;
  /** 全部折叠。 */
  collapseAll: () => void;
  /** 全部展开。 */
  expandAll: () => void;
}

/** 把 `folders` 排序并去重；并补齐所有祖先。 */
function normalizeFolderList(input: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const raw of input) {
    const norm = normalizeFolderPath(raw);
    if (!norm) continue;
    for (const anc of folderAncestors(norm)) set.add(anc);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** 在「同级」下挑选一个不冲突的名字（auto-suffix `" (N)"`）。 */
function uniqueFolderPath(parent: string | null, baseName: string, existing: Set<string>): string {
  const prefix = parent ? `${parent}/` : "";
  let candidate = `${prefix}${baseName}`;
  if (!existing.has(candidate)) return candidate;
  let n = 2;
  while (existing.has(`${prefix}${baseName} (${n})`)) n++;
  return `${prefix}${baseName} (${n})`;
}

export const useFolderStore = create<FolderStore>((set, get) => ({
  folders: [],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  fitModelFolders: {},
  distributionFolders: {},
  collapsed: loadCollapsed(),

  loadFromProject: ({ folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders = {}, fitModelFolders = {}, distributionFolders = {} }) => {
    // Normalize incoming paths and rebuild assignment maps with the
    // normalized forms so subsequent lookups always agree.
    const allFolders = new Set<string>();
    const tbl: Record<string, string> = {};
    const grp: Record<string, string> = {};
    const tab: Record<string, string> = {};
    const fit: Record<string, string> = {};
    const fitModel: Record<string, string> = {};
    const distribution: Record<string, string> = {};
    for (const f of folders) {
      const n = normalizeFolderPath(f);
      if (n) for (const anc of folderAncestors(n)) allFolders.add(anc);
    }
    for (const [id, f] of Object.entries(tableFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        tbl[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    for (const [id, f] of Object.entries(graphFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        grp[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    for (const [id, f] of Object.entries(tabulateFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        tab[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    for (const [id, f] of Object.entries(fitYByXFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        fit[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    for (const [id, f] of Object.entries(fitModelFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        fitModel[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    for (const [id, f] of Object.entries(distributionFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        distribution[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    set({
      folders: Array.from(allFolders).sort((a, b) => a.localeCompare(b)),
      tableFolders: tbl,
      graphFolders: grp,
      tabulateFolders: tab,
      fitYByXFolders: fit,
      fitModelFolders: fitModel,
      distributionFolders: distribution,
    });
  },

  reset: () => {
    set({ folders: [], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, fitYByXFolders: {}, fitModelFolders: {}, distributionFolders: {} });
  },

  createFolder: (parent, baseName) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const cleaned = baseName.trim();
    const parentNorm = normalizeFolderPath(parent ?? null);
    const existing = new Set(get().folders);
    const final = uniqueFolderPath(parentNorm, cleaned, existing);
    const next = normalizeFolderList([...existing, final]);
    set({ folders: next });
    return final;
  },

  renameFolder: (oldPath, newBaseName) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const cleaned = newBaseName.trim();
    if (!cleaned) return null;
    const parent = folderParent(oldPath);
    const existing = new Set(get().folders.filter((f) => f !== oldPath && !f.startsWith(`${oldPath}/`)));
    const finalPath = uniqueFolderPath(parent, cleaned, existing);

    // Replace every reference to oldPath (and its descendants) with the new prefix.
    const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, fitModelFolders, distributionFolders } = get();
    const remap = (p: string): string => {
      if (p === oldPath) return finalPath;
      if (p.startsWith(`${oldPath}/`)) return `${finalPath}${p.slice(oldPath.length)}`;
      return p;
    };
    const newFolders = normalizeFolderList(folders.map(remap));
    const newTableFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tableFolders)) newTableFolders[id] = remap(f);
    const newGraphFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(graphFolders)) newGraphFolders[id] = remap(f);
    const newTabulateFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tabulateFolders)) newTabulateFolders[id] = remap(f);
    const newFitYByXFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitYByXFolders)) newFitYByXFolders[id] = remap(f);
    const newFitModelFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitModelFolders)) newFitModelFolders[id] = remap(f);
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) newDistributionFolders[id] = remap(f);
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      fitModelFolders: newFitModelFolders,
      distributionFolders: newDistributionFolders,
    });
    return finalPath;
  },

  deleteFolder: (path) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, fitModelFolders, distributionFolders } = get();
    const parent = folderParent(path); // may be null (move to root)
    const movePrefix = (p: string): string => {
      // `<path>` and `<path>/sub` lose their leading segment.
      if (p === path) return parent ?? "";
      if (p.startsWith(`${path}/`)) {
        const tail = p.slice(path.length + 1);
        return parent ? `${parent}/${tail}` : tail;
      }
      return p;
    };
    const newFolders = normalizeFolderList(
      folders
        .filter((f) => f !== path)
        .map((f) => (f.startsWith(`${path}/`) ? movePrefix(f) : f))
        .filter(Boolean),
    );
    const newTableFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tableFolders)) {
      const moved = movePrefix(f);
      if (moved) newTableFolders[id] = moved;
    }
    const newGraphFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(graphFolders)) {
      const moved = movePrefix(f);
      if (moved) newGraphFolders[id] = moved;
    }
    const newTabulateFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tabulateFolders)) {
      const moved = movePrefix(f);
      if (moved) newTabulateFolders[id] = moved;
    }
    const newFitYByXFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitYByXFolders)) {
      const moved = movePrefix(f);
      if (moved) newFitYByXFolders[id] = moved;
    }
    const newFitModelFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitModelFolders)) {
      const moved = movePrefix(f);
      if (moved) newFitModelFolders[id] = moved;
    }
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) {
      const moved = movePrefix(f);
      if (moved) newDistributionFolders[id] = moved;
    }
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      fitModelFolders: newFitModelFolders,
      distributionFolders: newDistributionFolders,
    });
  },

  moveFolder: (path, newParent) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    if (path === newParent) return null;
    if (newParent && (newParent === path || newParent.startsWith(`${path}/`))) {
      // Cannot move a folder into itself or its own subtree.
      return null;
    }
    const baseName = folderBaseName(path);
    const newParentNorm = normalizeFolderPath(newParent ?? null);
    if ((newParentNorm ?? null) === folderParent(path)) {
      // No-op move (same parent).
      return path;
    }
    const existing = new Set(
      get().folders.filter((f) => f !== path && !f.startsWith(`${path}/`)),
    );
    const finalPath = uniqueFolderPath(newParentNorm, baseName, existing);

    const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, fitModelFolders, distributionFolders } = get();
    const remap = (p: string): string => {
      if (p === path) return finalPath;
      if (p.startsWith(`${path}/`)) return `${finalPath}${p.slice(path.length)}`;
      return p;
    };
    const newFolders = normalizeFolderList(folders.map(remap));
    const newTableFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tableFolders)) newTableFolders[id] = remap(f);
    const newGraphFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(graphFolders)) newGraphFolders[id] = remap(f);
    const newTabulateFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(tabulateFolders)) newTabulateFolders[id] = remap(f);
    const newFitYByXFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitYByXFolders)) newFitYByXFolders[id] = remap(f);
    const newFitModelFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitModelFolders)) newFitModelFolders[id] = remap(f);
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) newDistributionFolders[id] = remap(f);
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      fitModelFolders: newFitModelFolders,
      distributionFolders: newDistributionFolders,
    });
    return finalPath;
  },

  setTableFolder: (datasetId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.tableFolders };
      if (norm) next[datasetId] = norm; else delete next[datasetId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { tableFolders: next, folders };
    });
  },

  setGraphFolder: (graphId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.graphFolders };
      if (norm) next[graphId] = norm; else delete next[graphId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { graphFolders: next, folders };
    });
  },

  setTabulateFolder: (tabulateId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.tabulateFolders };
      if (norm) next[tabulateId] = norm; else delete next[tabulateId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { tabulateFolders: next, folders };
    });
  },

  setFitYByXFolder: (fitYByXId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.fitYByXFolders };
      if (norm) next[fitYByXId] = norm; else delete next[fitYByXId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { fitYByXFolders: next, folders };
    });
  },

  setFitModelFolder: (fitModelId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.fitModelFolders };
      if (norm) next[fitModelId] = norm; else delete next[fitModelId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { fitModelFolders: next, folders };
    });
  },

  setDistributionFolder: (distributionId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.distributionFolders };
      if (norm) next[distributionId] = norm; else delete next[distributionId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { distributionFolders: next, folders };
    });
  },

  pruneAssignments: (validDatasetIds, validGraphIds, validTabulateIds, validFitYByXIds, validDistributionIds, validFitModelIds = new Set<string>()) => {
    const { tableFolders, graphFolders, tabulateFolders, fitYByXFolders, fitModelFolders, distributionFolders } = get();
    const tbl: Record<string, string> = {};
    for (const [id, f] of Object.entries(tableFolders)) if (validDatasetIds.has(id)) tbl[id] = f;
    const grp: Record<string, string> = {};
    for (const [id, f] of Object.entries(graphFolders)) if (validGraphIds.has(id)) grp[id] = f;
    const tab: Record<string, string> = {};
    for (const [id, f] of Object.entries(tabulateFolders)) if (validTabulateIds.has(id)) tab[id] = f;
    const fit: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitYByXFolders)) if (validFitYByXIds.has(id)) fit[id] = f;
    const fitModel: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitModelFolders)) if (validFitModelIds.has(id)) fitModel[id] = f;
    const distribution: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) if (validDistributionIds.has(id)) distribution[id] = f;
    set({ tableFolders: tbl, graphFolders: grp, tabulateFolders: tab, fitYByXFolders: fit, fitModelFolders: fitModel, distributionFolders: distribution });
  },

  toggleCollapsed: (path) => {
    set((s) => {
      const next: Record<string, true> = { ...s.collapsed };
      if (next[path]) delete next[path]; else next[path] = true;
      persistCollapsed(next);
      return { collapsed: next };
    });
  },

  collapseAll: () => {
    const { folders } = get();
    const next: Record<string, true> = {};
    for (const f of folders) next[f] = true;
    persistCollapsed(next);
    set({ collapsed: next });
  },

  expandAll: () => {
    persistCollapsed({});
    set({ collapsed: {} });
  },
}));

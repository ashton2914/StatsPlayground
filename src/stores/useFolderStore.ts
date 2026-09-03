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
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

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
      for (const key of Object.keys(parsed)) {
        if (parsed[key]) out[key] = true;
      }
      return out;
    }
  } catch {
    // localStorage may be unavailable; use the default state.
  }
  return {};
}

function persistCollapsed(state: Record<string, true>) {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify(state));
  } catch {
    // localStorage persistence is non-fatal.
  }
}

interface FolderStore {
  folders: string[];
  tableFolders: Record<string, string>;
  graphFolders: Record<string, string>;
  tabulateFolders: Record<string, string>;
  fitYByXFolders: Record<string, string>;
  reportFolders: Record<string, string>;
  /** distributionId → 文件夹路径。 */
  distributionFolders: Record<string, string>;
  /** analysisId → 文件夹路径。 */
  analysisFolders: Record<string, string>;
  /** 折叠态：`{path: true}` 表示该文件夹处于折叠。仅 UI 用。 */
  collapsed: Record<string, true>;
  loadFromProject: (data: {
    folders: string[];
    tableFolders: Record<string, string>;
    graphFolders: Record<string, string>;
    tabulateFolders: Record<string, string>;
    fitYByXFolders: Record<string, string>;
    reportFolders?: Record<string, string>;
    distributionFolders?: Record<string, string>;
    analysisFolders?: Record<string, string>;
  }) => void;
  reset: () => void;
  createFolder: (parent: string | null, baseName: string) => string;
  renameFolder: (oldPath: string, newBaseName: string) => string | null;
  deleteFolder: (path: string) => void;
  moveFolder: (path: string, newParent: string | null) => string | null;
  setTableFolder: (datasetId: string, folder: string | null) => void;
  setGraphFolder: (graphId: string, folder: string | null) => void;
  setTabulateFolder: (tabulateId: string, folder: string | null) => void;
  setFitYByXFolder: (fitYByXId: string, folder: string | null) => void;
  setReportFolder: (reportId: string, folder: string | null) => void;
  /** 把单个 Distribution 配置移动到指定文件夹。 */
  setDistributionFolder: (distributionId: string, folder: string | null) => void;
  /** 把单个 Analysis 文档移动到指定文件夹。 */
  setAnalysisFolder: (analysisId: string, folder: string | null) => void;

  /** 清理已删除项目的归属信息。 */
  pruneAssignments: (
    validDatasetIds: Set<string>,
    validGraphIds: Set<string>,
    validTabulateIds: Set<string>,
    validFitYByXIds: Set<string>,
    validDistributionIds?: Set<string>,
    validReportIds?: Set<string>,
    validAnalysisIds?: Set<string>,
  ) => void;
  toggleCollapsed: (path: string) => void;
  collapseAll: () => void;
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
  reportFolders: {},
  distributionFolders: {},
  analysisFolders: {},
  collapsed: loadCollapsed(),

  loadFromProject: ({ folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, reportFolders = {}, distributionFolders = {}, analysisFolders = {} }) => {
    // Normalize incoming paths and rebuild assignment maps with the
    // normalized forms so subsequent lookups always agree.
    const allFolders = new Set<string>();
    const tbl: Record<string, string> = {};
    const grp: Record<string, string> = {};
    const tab: Record<string, string> = {};
    const fit: Record<string, string> = {};
    const report: Record<string, string> = {};
    const distribution: Record<string, string> = {};
    const analysis: Record<string, string> = {};
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
    for (const [id, f] of Object.entries(reportFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        report[id] = n;
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
    for (const [id, f] of Object.entries(analysisFolders)) {
      const n = normalizeFolderPath(f);
      if (n) {
        analysis[id] = n;
        for (const anc of folderAncestors(n)) allFolders.add(anc);
      }
    }
    set({
      folders: Array.from(allFolders).sort((a, b) => a.localeCompare(b)),
      tableFolders: tbl,
      graphFolders: grp,
      tabulateFolders: tab,
      fitYByXFolders: fit,
      reportFolders: report,
      distributionFolders: distribution,
      analysisFolders: analysis,
    });
  },

  reset: () => {
    set({ folders: [], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, fitYByXFolders: {}, reportFolders: {}, distributionFolders: {}, analysisFolders: {} });
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
  const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, reportFolders, distributionFolders, analysisFolders } = get();
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
    const newReportFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(reportFolders)) newReportFolders[id] = remap(f);
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) newDistributionFolders[id] = remap(f);
    const newAnalysisFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(analysisFolders)) newAnalysisFolders[id] = remap(f);
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      reportFolders: newReportFolders,
      distributionFolders: newDistributionFolders,
      analysisFolders: newAnalysisFolders,
    });
    return finalPath;
  },

  deleteFolder: (path) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, reportFolders, distributionFolders, analysisFolders } = get();
    const parent = folderParent(path); // may be null (move to root)
    const movePrefix = (p: string): string => {
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
    const newReportFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(reportFolders)) {
      const moved = movePrefix(f);
      if (moved) newReportFolders[id] = moved;
    }
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) {
      const moved = movePrefix(f);
      if (moved) newDistributionFolders[id] = moved;
    }
    const newAnalysisFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(analysisFolders)) {
      const moved = movePrefix(f);
      if (moved) newAnalysisFolders[id] = moved;
    }
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      reportFolders: newReportFolders,
      distributionFolders: newDistributionFolders,
      analysisFolders: newAnalysisFolders,
    });
  },

  moveFolder: (path, newParent) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    if (path === newParent) return null;
    if (newParent && (newParent === path || newParent.startsWith(`${path}/`))) {
      return null;
    }
    const baseName = folderBaseName(path);
    const newParentNorm = normalizeFolderPath(newParent ?? null);
    if ((newParentNorm ?? null) === folderParent(path)) {
      return path;
    }
    const existing = new Set(get().folders.filter((f) => f !== path && !f.startsWith(`${path}/`)));
    const finalPath = uniqueFolderPath(newParentNorm, baseName, existing);

  const { folders, tableFolders, graphFolders, tabulateFolders, fitYByXFolders, reportFolders, distributionFolders, analysisFolders } = get();
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
    const newReportFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(reportFolders)) newReportFolders[id] = remap(f);
    const newDistributionFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) newDistributionFolders[id] = remap(f);
    const newAnalysisFolders: Record<string, string> = {};
    for (const [id, f] of Object.entries(analysisFolders)) newAnalysisFolders[id] = remap(f);
    set({
      folders: newFolders,
      tableFolders: newTableFolders,
      graphFolders: newGraphFolders,
      tabulateFolders: newTabulateFolders,
      fitYByXFolders: newFitYByXFolders,
      reportFolders: newReportFolders,
      distributionFolders: newDistributionFolders,
      analysisFolders: newAnalysisFolders,
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

  setReportFolder: (reportId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.reportFolders };
      if (norm) next[reportId] = norm; else delete next[reportId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { reportFolders: next, folders };
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

  setAnalysisFolder: (analysisId, folder) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const norm = normalizeFolderPath(folder);
    set((s) => {
      const next: Record<string, string> = { ...s.analysisFolders };
      if (norm) next[analysisId] = norm; else delete next[analysisId];
      const ancestors = norm ? folderAncestors(norm) : [];
      const folders = ancestors.length
        ? normalizeFolderList([...s.folders, ...ancestors])
        : s.folders;
      return { analysisFolders: next, folders };
    });
  },

  pruneAssignments: (validDatasetIds, validGraphIds, validTabulateIds, validFitYByXIds, validDistributionIds = new Set(), validReportIds = new Set(), validAnalysisIds = new Set()) => {
    const { tableFolders, graphFolders, tabulateFolders, fitYByXFolders, reportFolders, distributionFolders, analysisFolders } = get();
    const tbl: Record<string, string> = {};
    for (const [id, f] of Object.entries(tableFolders)) if (validDatasetIds.has(id)) tbl[id] = f;
    const grp: Record<string, string> = {};
    for (const [id, f] of Object.entries(graphFolders)) if (validGraphIds.has(id)) grp[id] = f;
    const tab: Record<string, string> = {};
    for (const [id, f] of Object.entries(tabulateFolders)) if (validTabulateIds.has(id)) tab[id] = f;
    const fit: Record<string, string> = {};
    for (const [id, f] of Object.entries(fitYByXFolders)) if (validFitYByXIds.has(id)) fit[id] = f;
    const report: Record<string, string> = {};
    for (const [id, f] of Object.entries(reportFolders)) if (validReportIds.has(id)) report[id] = f;
    const distribution: Record<string, string> = {};
    for (const [id, f] of Object.entries(distributionFolders)) if (validDistributionIds.has(id)) distribution[id] = f;
    const analysis: Record<string, string> = {};
    for (const [id, f] of Object.entries(analysisFolders)) if (validAnalysisIds.has(id)) analysis[id] = f;
    set({ tableFolders: tbl, graphFolders: grp, tabulateFolders: tab, fitYByXFolders: fit, reportFolders: report, distributionFolders: distribution, analysisFolders: analysis });
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

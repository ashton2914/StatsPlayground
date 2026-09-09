import type { DatasetMeta } from "@/types/data.ts";

export type TableExportFormat = "sqlite" | "sptb" | "csv";

export interface TableExportItem {
  id: string;
  name: string;
  folder: string;
}

export interface TableExportFolderNode {
  path: string;
  name: string;
  folders: TableExportFolderNode[];
  tables: TableExportItem[];
  descendantIds: string[];
}

export interface TableExportPlan {
  format: TableExportFormat;
  datasetIds: string[];
  mode: "single-file" | "sqlite-subset" | "zip";
  archivePaths: Record<string, string>;
  sqliteNames: Record<string, string>;
  suggestedFilename: string;
}

type MutableTableExportFolderNode = TableExportFolderNode & {
  descendantIds: string[];
  folders: MutableTableExportFolderNode[];
  tables: TableExportItem[];
};

function createFolderNode(path: string, name: string): MutableTableExportFolderNode {
  return {
    path,
    name,
    folders: [],
    tables: [],
    descendantIds: [],
  };
}

function normalizeFolderPath(folder: string): string {
  return folder.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitFolderPath(folder: string): string[] {
  const normalized = normalizeFolderPath(folder);
  return normalized.length === 0 ? [] : normalized.split("/");
}

function sortFolderNode(node: MutableTableExportFolderNode): void {
  node.folders.sort((left, right) => left.name.localeCompare(right.name));
  node.tables.sort((left, right) => left.name.localeCompare(right.name));
  node.folders.forEach(sortFolderNode);

  const descendantIds: string[] = [];
  for (const table of node.tables) {
    descendantIds.push(table.id);
  }
  for (const folder of node.folders) {
    descendantIds.push(...folder.descendantIds);
  }
  node.descendantIds = descendantIds;
}

function safeProjectBasename(projectName: string): string {
  const sanitized = projectName
    .replace(/[\\/:*?"<>|]+$/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/-+/g, "-")
    .replace(/[.\s]+$/g, "");

  return sanitized.length > 0 ? sanitized : "export";
}

function safeExportName(value: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/-+/g, "-")
    .replace(/[.\s]+$/g, "");

  return sanitized.length > 0 ? sanitized : "export";
}

function joinArchivePath(folder: string, name: string): string {
  const normalizedFolder = normalizeFolderPath(folder);
  return normalizedFolder.length > 0 ? `${normalizedFolder}/${name}` : name;
}

function joinSqliteName(folder: string, name: string): string {
  const normalizedFolder = normalizeFolderPath(folder);
  const parts = normalizedFolder.length > 0 ? normalizedFolder.split("/") : [];
  return [...parts, name].map(safeExportName).join("-");
}

export function buildTableExportTree(
  datasets: readonly Pick<DatasetMeta, "id" | "name">[],
  tableFolders: Readonly<Record<string, string>>,
): TableExportFolderNode {
  const root = createFolderNode("", "");
  const folderIndex = new Map<string, MutableTableExportFolderNode>();
  folderIndex.set("", root);

  for (const dataset of datasets) {
    const folderPath = normalizeFolderPath(tableFolders[dataset.id] ?? "");
    const segments = splitFolderPath(folderPath);
    let currentPath = "";
    let parent = root;

    for (const segment of segments) {
      currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
      let folderNode = folderIndex.get(currentPath);
      if (!folderNode) {
        folderNode = createFolderNode(currentPath, segment);
        folderIndex.set(currentPath, folderNode);
        parent.folders.push(folderNode);
      }
      parent = folderNode;
    }

    parent.tables.push({ id: dataset.id, name: dataset.name, folder: folderPath });
  }

  sortFolderNode(root);
  return root;
}

export function setTableSelection(
  selectedIds: ReadonlySet<string>,
  targetIds: readonly string[],
  selected: boolean,
): Set<string> {
  const nextSelection = new Set(selectedIds);
  for (const targetId of targetIds) {
    if (selected) {
      nextSelection.add(targetId);
    } else {
      nextSelection.delete(targetId);
    }
  }
  return nextSelection;
}

export function selectionState(
  selectedIds: ReadonlySet<string>,
  targetIds: readonly string[],
): "checked" | "mixed" | "unchecked" {
  if (targetIds.length === 0) {
    return "unchecked";
  }

  let selectedCount = 0;
  for (const targetId of targetIds) {
    if (selectedIds.has(targetId)) {
      selectedCount += 1;
    }
  }

  if (selectedCount === 0) {
    return "unchecked";
  }

  if (selectedCount === targetIds.length) {
    return "checked";
  }

  return "mixed";
}

export function buildTableExportPlan(args: {
  datasets: readonly Pick<DatasetMeta, "id" | "name">[];
  tableFolders: Readonly<Record<string, string>>;
  selectedIds: ReadonlySet<string>;
  format: TableExportFormat;
  projectName: string;
}): TableExportPlan | null {
  const liveDatasets = new Map(args.datasets.map((dataset) => [dataset.id, dataset] as const));
  const datasetIds = args.datasets
    .filter((dataset) => args.selectedIds.has(dataset.id))
    .map((dataset) => dataset.id);

  if (datasetIds.length === 0) {
    return null;
  }

  const archivePaths: Record<string, string> = {};
  const sqliteNames: Record<string, string> = {};

  for (const datasetId of datasetIds) {
    const dataset = liveDatasets.get(datasetId);
    if (!dataset) {
      continue;
    }

    const folder = args.tableFolders[datasetId] ?? "";
    archivePaths[datasetId] = joinArchivePath(folder, dataset.name);
    sqliteNames[datasetId] = joinSqliteName(folder, dataset.name);
  }

  const mode =
    args.format === "sqlite"
      ? "sqlite-subset"
      : datasetIds.length === 1
        ? "single-file"
        : "zip";

  return {
    format: args.format,
    datasetIds,
    mode,
    archivePaths,
    sqliteNames,
    suggestedFilename: `${safeProjectBasename(args.projectName)}-${args.format}.zip`,
  };
}
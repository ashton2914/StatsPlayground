import { CommandExecutionError } from "@/applicationCommands/runtime";
import type {
  ProjectDocumentGetInput,
  ProjectDocumentGetResult,
  ProjectDocumentKind,
  ProjectDocumentListInput,
  ProjectDocumentListResult,
  ProjectDocumentSummary,
  ProjectInspectInput,
  ProjectInspectResult,
  TableDescribeInput,
  TableDescribeResult,
  TableListInput,
  TableListItem,
  TableListResult,
} from "@/applicationCommands/types";
import { dataService } from "@/services/dataService";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDataStore } from "@/stores/useDataStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useReportStore } from "@/stores/useReportStore";
import { useTableTransformStore } from "@/stores/useTableTransformStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import type { AnalysisDocument } from "@/types/analysis";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ProjectInfo } from "@/types/project";
import type { ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";
import type { TableTransformDefinition } from "@/types/tableTransform";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MIN_TABLE_PREVIEW_LIMIT = 1;
const MAX_TABLE_PREVIEW_LIMIT = 200;
const ABSOLUTE_PATH_PATTERN = /([A-Za-z]:\\[^\s"']+|\/(Users|home|var|private|tmp)\/[^\s"']+)/g;

export interface ProjectCommandDependencies {
  getProjectState: () => {
    project: ProjectInfo | null;
    dirty: boolean;
    readOnly: boolean;
    projectRevision: number;
  };
  listDatasets: () => DatasetMeta[];
  listTableTransforms: () => TableTransformDefinition[];
  listGraphs: () => GraphBuilderItem[];
  listReports: () => ReportItem[];
  listAnalyses: () => AnalysisDocument[];
  listTabulates: () => TabulateItem[];
  getColumns: (datasetId: string) => Promise<Array<[string, string]>>;
  getColumnDisplayProps: (datasetId: string) => Promise<ColumnDisplayProps[]>;
  getDatasetGeneration: (datasetId: string) => Promise<number>;
  queryTableWindow?: typeof dataService.queryTableWindow;
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? null;
}

function redactAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function sanitizeValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactAbsolutePaths(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "filePath" || key === "sourcePath") continue;
      out[key] = sanitizeValue(entry);
    }
    return out as T;
  }
  return value;
}

function normalizePageLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new CommandExecutionError("invalid_input", `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

function toTableListItem(dataset: DatasetMeta): TableListItem {
  return {
    id: dataset.id,
    name: dataset.name,
    sourceType: dataset.sourceType,
    rowCount: dataset.rowCount,
    colCount: dataset.colCount,
    generation: dataset.generation,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    sourceName: basename(dataset.sourcePath),
  };
}

function paginateByCursor<T extends { id: string }>(items: T[], cursor: string | undefined, limit: number): {
  items: T[];
  nextCursor: string | null;
} {
  const start = cursor
    ? Math.max(0, items.findIndex((item) => item.id === cursor) + 1)
    : 0;
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < items.length ? page[page.length - 1]?.id ?? null : null,
  };
}

function summarizeDocuments(input: {
  tableTransforms: TableTransformDefinition[];
  graphs: GraphBuilderItem[];
  reports: ReportItem[];
  analyses: AnalysisDocument[];
  tabulates: TabulateItem[];
}): ProjectDocumentSummary[] {
  const summaries: ProjectDocumentSummary[] = [];
  for (const item of input.tableTransforms) {
    summaries.push({ kind: "tableTransform", id: item.id, name: item.name });
  }
  for (const item of input.graphs) {
    summaries.push({
      kind: "graph",
      id: item.id,
      name: item.name,
      sourceDatasetId: item.sourceDatasetId,
      createdAt: item.createdAt,
    });
  }
  for (const item of input.analyses) {
    summaries.push({
      kind: "analysis",
      id: item.id,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  for (const item of input.tabulates) {
    summaries.push({
      kind: "tabulate",
      id: item.id,
      name: item.name,
      sourceDatasetId: item.sourceDatasetId,
      createdAt: item.createdAt,
    });
  }
  for (const item of input.reports) {
    summaries.push({
      kind: "report",
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return summaries.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

export function createProjectCommandHandlers(
  dependencies: ProjectCommandDependencies = {
    getProjectState: () => {
      const state = useProjectStore.getState();
      return {
        project: state.project,
        dirty: state.dirty,
        readOnly: state.readOnly,
        projectRevision: state.projectRevision,
      };
    },
    listDatasets: () => useDataStore.getState().datasets,
    listTableTransforms: () => useTableTransformStore.getState().definitions,
    listGraphs: () => useGraphBuilderStore.getState().items,
    listReports: () => useReportStore.getState().items,
    listAnalyses: () => useAnalysisStore.getState().items,
    listTabulates: () => useTabulateStore.getState().items,
    getColumns: dataService.getColumns,
    getColumnDisplayProps: dataService.getColumnDisplayProps,
    getDatasetGeneration: dataService.getDatasetGeneration,
    queryTableWindow: dataService.queryTableWindow,
  },
) {
  async function inspectProject(input: ProjectInspectInput): Promise<ProjectInspectResult> {
    const state = dependencies.getProjectState();
    const datasets = dependencies.listDatasets();
    const tableTransforms = dependencies.listTableTransforms();
    const graphs = dependencies.listGraphs();
    const reports = dependencies.listReports();
    const analyses = dependencies.listAnalyses();
    const tabulates = dependencies.listTabulates();

    const output: ProjectInspectResult = {
      project: state.project
        ? {
            name: state.project.name,
            createdAt: state.project.createdAt,
            fileName: basename(state.project.filePath),
            hasProjectPath: Boolean(state.project.filePath),
          }
        : null,
      dirty: state.dirty,
      readOnly: state.readOnly,
      projectRevision: state.projectRevision,
      counts: {
        tables: datasets.length,
        tableTransforms: tableTransforms.length,
        graphs: graphs.length,
        analyses: analyses.length,
        tabulates: tabulates.length,
        reports: reports.length,
      },
    };

    if (input.includeCapabilities) {
      output.capabilities = {
        table: {
          list: true,
          describe: true,
          describePreview: true,
        },
        document: {
          list: true,
          get: true,
        },
        project: {
          inspect: true,
        },
      };
    }

    return sanitizeValue(output);
  }

  async function listProjectTables(input: TableListInput): Promise<TableListResult> {
    const limit = normalizePageLimit(input.limit);
    const datasets = dependencies.listDatasets().map(toTableListItem)
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = paginateByCursor(datasets, input.cursor, limit);
    return sanitizeValue(page);
  }

  async function describeProjectTable(input: TableDescribeInput): Promise<TableDescribeResult> {
    const dataset = dependencies.listDatasets().find((item) => item.id === input.datasetId);
    if (!dataset) {
      throw new CommandExecutionError("not_found", `Dataset ${input.datasetId} was not found`);
    }

    if (input.preview) {
      if (!Number.isInteger(input.preview.limit)
        || input.preview.limit < MIN_TABLE_PREVIEW_LIMIT
        || input.preview.limit > MAX_TABLE_PREVIEW_LIMIT) {
        throw new CommandExecutionError(
          "invalid_input",
          `preview.limit must be between ${MIN_TABLE_PREVIEW_LIMIT} and ${MAX_TABLE_PREVIEW_LIMIT}`,
        );
      }
      if (input.preview.offset != null && (!Number.isInteger(input.preview.offset) || input.preview.offset < 0)) {
        throw new CommandExecutionError("invalid_input", "preview.offset must be a non-negative integer");
      }
    }

    const [columnsRaw, displayRaw, generation] = await Promise.all([
      dependencies.getColumns(input.datasetId),
      dependencies.getColumnDisplayProps(input.datasetId),
      dependencies.getDatasetGeneration(input.datasetId),
    ]);
    const displayByIndex = new Map(displayRaw.map((item) => [item.colIndex, item]));
    const columns = columnsRaw.map(([colName, colType], colIndex) => {
      const display = displayByIndex.get(colIndex);
      return {
        colIndex,
        colName,
        colType,
        width: display?.width,
        format: display?.format,
        extras: display?.extras,
      };
    });

    const output: TableDescribeResult = {
      dataset: toTableListItem(dataset),
      generation,
      columns,
    };

    if (input.preview && dependencies.queryTableWindow) {
      const offset = input.preview.offset ?? 0;
      const limit = input.preview.limit;
      const window = await dependencies.queryTableWindow({
        datasetId: input.datasetId,
        start: offset,
        count: limit,
        sort: null,
        filters: [],
        generation,
      });

      output.preview = {
        offset,
        limit,
        totalRows: window.totalRows,
        rows: window.rows.slice(0, limit).map((row, rowOffset) => ({
          rowIndex: offset + rowOffset,
          cells: row.map((value, colIndex) => ({ colIndex, value })),
        })),
      };
    }

    return sanitizeValue(output);
  }

  async function listProjectDocuments(input: ProjectDocumentListInput): Promise<ProjectDocumentListResult> {
    const limit = normalizePageLimit(input.limit);
    const all = summarizeDocuments({
      tableTransforms: dependencies.listTableTransforms(),
      graphs: dependencies.listGraphs(),
      reports: dependencies.listReports(),
      analyses: dependencies.listAnalyses(),
      tabulates: dependencies.listTabulates(),
    });
    const filtered = input.kind ? all.filter((item) => item.kind === input.kind) : all;
    const page = paginateByCursor(filtered, input.cursor, limit);
    return sanitizeValue(page);
  }

  async function getProjectDocument(input: ProjectDocumentGetInput): Promise<ProjectDocumentGetResult> {
    const lookup: Record<ProjectDocumentKind, unknown[]> = {
      tableTransform: dependencies.listTableTransforms(),
      graph: dependencies.listGraphs(),
      analysis: dependencies.listAnalyses(),
      tabulate: dependencies.listTabulates(),
      report: dependencies.listReports(),
    };

    const collection = lookup[input.kind] as Array<{ id: string }>;
    const found = collection.find((item) => item.id === input.id);
    if (!found) {
      throw new CommandExecutionError("not_found", `${input.kind} ${input.id} was not found`);
    }

    return sanitizeValue({
      kind: input.kind,
      id: input.id,
      document: found,
    });
  }

  return {
    inspectProject,
    listProjectTables,
    describeProjectTable,
    listProjectDocuments,
    getProjectDocument,
  };
}

export function inspectProject(input: ProjectInspectInput): Promise<ProjectInspectResult> {
  return createProjectCommandHandlers().inspectProject(input);
}

export function listProjectTables(input: TableListInput): Promise<TableListResult> {
  return createProjectCommandHandlers().listProjectTables(input);
}

export function describeProjectTable(input: TableDescribeInput): Promise<TableDescribeResult> {
  return createProjectCommandHandlers().describeProjectTable(input);
}

export function listProjectDocuments(input: ProjectDocumentListInput): Promise<ProjectDocumentListResult> {
  return createProjectCommandHandlers().listProjectDocuments(input);
}

export function getProjectDocument(input: ProjectDocumentGetInput): Promise<ProjectDocumentGetResult> {
  return createProjectCommandHandlers().getProjectDocument(input);
}
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useReportStore } from "@/stores/useReportStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useWorkflowStore } from "@/stores/useWorkflowStore";
import type { AnalysisDocument } from "@/types/analysis";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";
import type { WorkflowRunCommitPacket } from "@/types/workflow";
import { extractReportDependencies } from "@/utils/reportParser";

interface WorkflowRunCommitDependencies {
  datasetIds: readonly string[];
  refreshDatasets: () => Promise<void>;
  markDirty: () => void;
}

function replaceById<Document extends { id: string }>(
  current: readonly Document[],
  replacements: readonly Document[],
): Document[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const replacement of replacements) byId.set(replacement.id, replacement);
  return [...byId.values()];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateSourceDocument(
  document: Record<string, unknown>,
  id: string,
  sourceTableId: string,
  nestedSource: boolean,
) {
  if (document.id !== id) throw new Error(`Workflow document ID does not match ${id}`);
  const source = nestedSource
    ? requireObject(document.source, `Workflow document ${id} source`).datasetId
    : document.sourceDatasetId;
  if (source !== sourceTableId) {
    throw new Error(`Workflow document ${id} source does not match ${sourceTableId}`);
  }
}

export async function applyWorkflowRunCommit(
  packet: WorkflowRunCommitPacket,
  dependencies: WorkflowRunCommitDependencies,
): Promise<void> {
  const workflowState = useWorkflowStore.getState();
  if (workflowState.workflowRuns.some((run) => run.id === packet.commitId)) return;
  if (packet.commitId !== packet.run.id) {
    throw new Error("Workflow commit ID does not match run ID");
  }
  if (packet.run.status === "failed") {
    if (packet.documents.length > 0) {
      throw new Error("Failed Workflow runs cannot publish documents");
    }
    useWorkflowStore.setState({
      workflowRuns: [...workflowState.workflowRuns, packet.run],
    });
    dependencies.markDirty();
    throw new Error(packet.run.errors[0]?.message ?? "Workflow execution failed");
  }
  if (packet.run.status !== "succeeded") {
    throw new Error("Only succeeded Workflow runs can be committed");
  }

  const outputIds = new Set(packet.run.outputBindings.map((binding) => binding.artifactDocumentId));
  const documentIds = new Set<string>();
  const datasetIds = new Set(dependencies.datasetIds);
  const graphs: GraphBuilderItem[] = [];
  const analyses: AnalysisDocument[] = [];
  const tabulates: TabulateItem[] = [];
  const reports: ReportItem[] = [];

  for (const commit of packet.documents) {
    if (!outputIds.has(commit.id)) {
      throw new Error(`Workflow document ${commit.id} has no output binding`);
    }
    if (documentIds.has(commit.id)) {
      throw new Error(`Duplicate Workflow document commit ${commit.id}`);
    }
    documentIds.add(commit.id);
    if (commit.kind === "report") continue;
    if (!datasetIds.has(commit.sourceTableId)) {
      throw new Error(`Unresolved Workflow source table ${commit.sourceTableId}`);
    }
    const document = requireObject(commit.document, `Workflow document ${commit.id}`);
    validateSourceDocument(document, commit.id, commit.sourceTableId, commit.kind === "analysis");
    if (commit.kind === "graph") graphs.push(document as unknown as GraphBuilderItem);
    else if (commit.kind === "analysis") analyses.push(document as unknown as AnalysisDocument);
    else tabulates.push(document as unknown as TabulateItem);
  }

  const resolvableDocuments = new Set([
    ...Array.from(datasetIds, (id) => `table:${id}`),
    ...graphs.map((item) => `graph:${item.id}`),
    ...analyses.map((item) => `${item.analysisKind}:${item.id}`),
    ...tabulates.map((item) => `tabulate:${item.id}`),
    ...useGraphBuilderStore.getState().items.map((item) => `graph:${item.id}`),
    ...useAnalysisStore.getState().items.map((item) => `${item.analysisKind}:${item.id}`),
    ...useTabulateStore.getState().items.map((item) => `tabulate:${item.id}`),
  ]);
  for (const commit of packet.documents) {
    if (commit.kind !== "report") continue;
    const embeddedDependencies = extractReportDependencies(commit.markdown);
    if (embeddedDependencies.length !== commit.dependencyIds.length
      || embeddedDependencies.some((dependency, index) => {
        const committed = commit.dependencyIds[index];
        return dependency.kind !== committed.kind
          || dependency.documentId !== committed.documentId;
      })) {
      throw new Error(`Workflow Report ${commit.id} dependencies do not match markdown`);
    }
    for (const dependency of commit.dependencyIds) {
      if (!resolvableDocuments.has(`${dependency.kind}:${dependency.documentId}`)) {
        throw new Error(`unresolved Report dependency ${dependency.kind}:${dependency.documentId}`);
      }
    }
    const existing = useReportStore.getState().items.find((item) => item.id === commit.id);
    const completedAt = packet.run.completedAt ?? packet.run.startedAt ?? existing?.updatedAt ?? "";
    reports.push({
      schemaVersion: 1,
      id: commit.id,
      name: commit.name,
      markdown: commit.markdown,
      createdAt: existing?.createdAt ?? packet.run.startedAt ?? completedAt,
      updatedAt: completedAt,
    });
  }

  const nextGraphs = replaceById(useGraphBuilderStore.getState().items, graphs);
  const nextAnalyses = replaceById(useAnalysisStore.getState().items, analyses);
  const nextTabulates = replaceById(useTabulateStore.getState().items, tabulates);
  const nextReports = replaceById(useReportStore.getState().items, reports);
  const nextRuns = [...workflowState.workflowRuns, packet.run];

  useGraphBuilderStore.getState().loadFromProject(nextGraphs);
  useAnalysisStore.getState().loadAnalyses(nextAnalyses);
  useTabulateStore.getState().loadFromProject(nextTabulates);
  useReportStore.getState().loadFromProject(nextReports);
  useWorkflowStore.setState({ workflowRuns: nextRuns });
  await dependencies.refreshDatasets();
  dependencies.markDirty();
}
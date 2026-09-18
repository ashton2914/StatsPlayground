import { buildAnalysisProjectPayload } from "@/components/analysis/analysisWorkspaceLifecycle";
import type { SaveProjectRequest } from "@/services/projectService";
import { useAnalysisStore } from "@/stores/useAnalysisStore";
import { useDatasetFilterStore } from "@/stores/useDatasetFilterStore";
import { useFolderStore } from "@/stores/useFolderStore";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { useReportStore } from "@/stores/useReportStore";
import { useTableTransformStore } from "@/stores/useTableTransformStore";
import { useTabulateStore } from "@/stores/useTabulateStore";
import { useWorkflowStore } from "@/stores/useWorkflowStore";

export function buildSaveProjectRequest(filePath?: string): SaveProjectRequest {
  const { snapshots } = useHistoryStore.getState();
  const graphBuilders = useGraphBuilderStore.getState().items;
  const datasetFilters = useDatasetFilterStore.getState().toProjectPayload();
  const tabulates = useTabulateStore.getState().items;
  const reportItems = useReportStore.getState().items;
  const analysisItems = useAnalysisStore.getState().items;
  const workflows = useWorkflowStore.getState().workflows;
  const logicalFolders = useWorkflowStore.getState().logicalFolders;
  const workflowRuns = useWorkflowStore.getState().workflowRuns;
  const tableTransforms = useTableTransformStore.getState().definitions;
  const tableTransformBindings = useTableTransformStore.getState().bindings;
  const folderState = useFolderStore.getState();

  const folderPayload = {
    folders: folderState.folders,
    tableFolders: folderState.tableFolders,
    graphFolders: folderState.graphFolders,
    reportFolders: folderState.reportFolders,
    tabulateFolders: folderState.tabulateFolders,
    ...buildAnalysisProjectPayload({
      analyses: analysisItems,
      analysisFolders: folderState.analysisFolders,
    }),
  };

  return {
    ...(filePath ? { filePath } : {}),
    history: [],
    snapshots,
    datasetFilters,
    graphBuilders,
    fitYByX: [],
    tabulates,
    distributions: [],
    analyses: folderPayload.analyses,
    folders: folderPayload.folders,
    tableFolders: folderPayload.tableFolders,
    graphFolders: folderPayload.graphFolders,
    fitYByXFolders: {},
    reportFolders: folderPayload.reportFolders,
    tabulateFolders: folderPayload.tabulateFolders,
    reports: reportItems,
    distributionFolders: folderPayload.distributionFolders,
    analysisFolders: folderPayload.analysisFolders,
    workflows,
    logicalFolders,
    workflowRuns,
    tableTransforms,
    tableTransformBindings,
  };
}
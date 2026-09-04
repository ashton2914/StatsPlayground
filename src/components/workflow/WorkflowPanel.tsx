import { useTranslation } from "react-i18next";
import type { ProjectLineageGraph, WorkflowDefinition, WorkflowRun } from "@/types/workflow";

interface WorkflowPanelProps {
  lineageGraph: ProjectLineageGraph;
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRun[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function WorkflowPanel({
  lineageGraph,
  workflows,
  workflowRuns,
  selectedId,
  onSelect,
}: WorkflowPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="workflow-panel">
      <div className="panel-header">
        <h3>{t("workflow.title", { defaultValue: "Workflow" })}</h3>
      </div>
      <div className="workflow-panel-list">
        <button
          type="button"
          className={`workflow-list-item${selectedId === "lineage" ? " active" : ""}`}
          onClick={() => onSelect("lineage")}
        >
          <i className="fa-solid fa-diagram-project" aria-hidden="true" />
          <span>
            <strong>{t("workflow.projectLineage", { defaultValue: "Project lineage" })}</strong>
            <small>{t("workflow.nodeCount", { defaultValue: "{{count}} nodes", count: lineageGraph.nodes.length })}</small>
          </span>
        </button>
        <div className="workflow-panel-section-label">
          {t("workflow.saved", { defaultValue: "Saved workflows" })}
        </div>
        {workflows.length === 0 ? (
          <div className="empty-hint">
            {t("workflow.empty", { defaultValue: "No saved workflows" })}
          </div>
        ) : workflows.map((workflow) => {
          const runCount = workflowRuns.filter((run) => run.workflowId === workflow.id).length;
          return (
            <button
              type="button"
              key={workflow.id}
              className={`workflow-list-item${selectedId === workflow.id ? " active" : ""}`}
              onClick={() => onSelect(workflow.id)}
            >
              <i className="fa-solid fa-code-branch" aria-hidden="true" />
              <span>
                <strong>{workflow.name}</strong>
                <small>{t("workflow.revisionRuns", {
                  defaultValue: "Revision {{revision}} · {{count}} runs",
                  revision: workflow.revision,
                  count: runCount,
                })}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
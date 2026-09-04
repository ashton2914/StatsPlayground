import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { dataService } from "@/services/dataService";
import type { DatasetMeta } from "@/types/data";
import type {
  ProjectLineageGraph,
  SchemaValidationReport,
  WorkflowDefinition,
} from "@/types/workflow";
import { layoutWorkflowGraph, WORKFLOW_NODE_SIZE } from "@/utils/workflowLayout";
import {
  isSchemaValidationBlocking,
  validateWorkflowInputSchema,
} from "@/utils/workflowSchema";

interface VisualNode {
  id: string;
  label: string;
  detail: string;
  kind: "input" | "operation" | "artifact" | "output";
}

interface VisualEdge {
  id: string;
  source: string;
  target: string;
}

interface WorkflowViewProps {
  lineageGraph: ProjectLineageGraph;
  workflow?: WorkflowDefinition;
  datasets: DatasetMeta[];
}

function lineageVisuals(graph: ProjectLineageGraph): { nodes: VisualNode[]; edges: VisualEdge[] } {
  return {
    nodes: graph.nodes.map((node) => node.nodeType === "artifact" ? {
      id: node.id,
      label: node.name,
      detail: node.artifactKind,
      kind: "artifact",
    } : {
      id: node.id,
      label: node.kind,
      detail: node.schemaVersion,
      kind: "operation",
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source.nodeId,
      target: edge.target.nodeId,
    })),
  };
}

function workflowVisuals(workflow: WorkflowDefinition): { nodes: VisualNode[]; edges: VisualEdge[] } {
  return {
    nodes: [
      ...workflow.inputSlots.map((slot) => ({
        id: slot.id,
        label: slot.name,
        detail: "table input",
        kind: "input" as const,
      })),
      ...workflow.operations.map((operation) => ({
        id: operation.id,
        label: operation.kind,
        detail: operation.schemaVersion,
        kind: "operation" as const,
      })),
      ...workflow.outputDeclarations.map((output) => ({
        id: output.id,
        label: output.name,
        detail: output.artifactKind,
        kind: "output" as const,
      })),
    ],
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source.nodeId,
      target: edge.target.nodeId,
    })),
  };
}

export function WorkflowView({ lineageGraph, workflow, datasets }: WorkflowViewProps) {
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<Record<string, SchemaValidationReport>>({});
  const [checkingSlotId, setCheckingSlotId] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<Record<string, string>>({});
  const schemaRequestIds = useRef<Record<string, number>>({});
  const visuals = useMemo(
    () => workflow ? workflowVisuals(workflow) : lineageVisuals(lineageGraph),
    [lineageGraph, workflow],
  );
  const layout = useMemo(
    () => layoutWorkflowGraph(
      visuals.nodes.map((node) => node.id),
      visuals.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    ),
    [visuals],
  );

  useEffect(() => {
    setBindings({});
    setReports({});
    setCheckError({});
  }, [workflow?.id]);

  const bindInput = async (slotId: string, datasetId: string) => {
    const requestId = (schemaRequestIds.current[slotId] ?? 0) + 1;
    schemaRequestIds.current[slotId] = requestId;
    setBindings((current) => ({ ...current, [slotId]: datasetId }));
    setReports((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
    setCheckError((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
    if (!datasetId || !workflow) return;
    const slot = workflow.inputSlots.find((candidate) => candidate.id === slotId);
    if (!slot) return;

    setCheckingSlotId(slotId);
    try {
      const columns = await dataService.getColumns(datasetId);
      if (schemaRequestIds.current[slotId] !== requestId) return;
      setReports((current) => ({
        ...current,
        [slotId]: validateWorkflowInputSchema(slot.schemaContract, columns),
      }));
    } catch (error) {
      if (schemaRequestIds.current[slotId] !== requestId) return;
      setCheckError((current) => ({ ...current, [slotId]: String(error) }));
    } finally {
      if (schemaRequestIds.current[slotId] === requestId) {
        setCheckingSlotId((current) => current === slotId ? null : current);
      }
    }
  };

  const title = workflow?.name
    ?? t("workflow.projectLineage", { defaultValue: "Project lineage" });

  return (
    <div className="workflow-view">
      <header className="workflow-view-header">
        <div>
          <span>{workflow ? t("workflow.definition", { defaultValue: "Workflow definition" }) : t("workflow.lineage", { defaultValue: "Lineage" })}</span>
          <h2>{title}</h2>
        </div>
        <div className="workflow-view-summary">
          {t("workflow.graphSummary", {
            defaultValue: "{{nodes}} nodes · {{edges}} connections",
            nodes: visuals.nodes.length,
            edges: visuals.edges.length,
          })}
        </div>
      </header>

      {workflow && workflow.inputSlots.length > 0 && (
        <section className="workflow-inputs" aria-label={t("workflow.inputs", { defaultValue: "Workflow inputs" })}>
          <h3>{t("workflow.inputs", { defaultValue: "Workflow inputs" })}</h3>
          <div className="workflow-input-grid">
            {workflow.inputSlots.map((slot) => {
              const report = reports[slot.id];
              const blocking = report ? isSchemaValidationBlocking(report) : false;
              return (
                <div className="workflow-input-row" key={slot.id}>
                  <label htmlFor={`workflow-input-${slot.id}`}>{slot.name}</label>
                  <select
                    id={`workflow-input-${slot.id}`}
                    value={bindings[slot.id] ?? ""}
                    onChange={(event) => void bindInput(slot.id, event.target.value)}
                  >
                    <option value="">{t("workflow.chooseTable", { defaultValue: "Choose input table" })}</option>
                    {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                  </select>
                  <div className="workflow-schema-status" aria-live="polite">
                    {checkingSlotId === slot.id ? (
                      <span className="checking"><i className="fa-solid fa-spinner fa-spin" aria-hidden="true" /> {t("workflow.checkingSchema", { defaultValue: "Checking schema" })}</span>
                    ) : checkError[slot.id] ? (
                      <span className="invalid"><i className="fa-solid fa-circle-exclamation" aria-hidden="true" /> {t("workflow.schemaCheckFailed", { defaultValue: "Schema check failed" })}</span>
                    ) : report ? (
                      <span className={blocking ? "invalid" : "valid"}>
                        <i className={`fa-solid ${blocking ? "fa-circle-xmark" : "fa-circle-check"}`} aria-hidden="true" />
                        {blocking
                          ? t("workflow.schemaIncompatible", {
                              defaultValue: "{{missing}} missing, {{mismatch}} wrong type",
                              missing: report.missingColumns.length,
                              mismatch: report.typeMismatches.length,
                            })
                          : t("workflow.schemaCompatible", { defaultValue: "Schema compatible" })}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {visuals.nodes.length === 0 ? (
        <div className="workspace-empty">
          <i className="fa-solid fa-diagram-project" aria-hidden="true" />
          <p>{t("workflow.noLineage", { defaultValue: "No workflow lineage is available yet." })}</p>
        </div>
      ) : (
        <div className="workflow-canvas-scroll">
          <div className="workflow-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg width={layout.width} height={layout.height} aria-hidden="true">
              {visuals.edges.map((edge) => {
                const source = layout.positions[edge.source];
                const target = layout.positions[edge.target];
                if (!source || !target) return null;
                const x1 = source.x + WORKFLOW_NODE_SIZE.width;
                const y1 = source.y + WORKFLOW_NODE_SIZE.height / 2;
                const x2 = target.x;
                const y2 = target.y + WORKFLOW_NODE_SIZE.height / 2;
                const bend = Math.max(36, (x2 - x1) / 2);
                return <path key={edge.id} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />;
              })}
            </svg>
            {visuals.nodes.map((node) => {
              const position = layout.positions[node.id];
              return (
                <div
                  className={`workflow-node workflow-node-${node.kind}`}
                  key={node.id}
                  style={{ left: position.x, top: position.y }}
                >
                  <i className={`fa-solid ${node.kind === "operation" ? "fa-gears" : node.kind === "input" ? "fa-table" : "fa-file-lines"}`} aria-hidden="true" />
                  <span><strong>{node.label}</strong><small>{node.detail}</small></span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
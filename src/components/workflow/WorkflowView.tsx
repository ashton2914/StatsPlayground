import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  mergeWorkflowTableColumns,
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
  suggestedWorkflowName?: string;
  onSaveSelection?: (name: string, nodeIds: string[]) => void | Promise<void>;
}

interface SelectionMarquee {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
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

export function WorkflowView({
  lineageGraph,
  workflow,
  datasets,
  suggestedWorkflowName = "Workflow 1",
  onSaveSelection,
}: WorkflowViewProps) {
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<Record<string, SchemaValidationReport>>({});
  const [checkingSlotId, setCheckingSlotId] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<Record<string, string>>({});
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionMarquee | null>(null);
  const [selectionName, setSelectionName] = useState<string | null>(null);
  const [inspectedSlotId, setInspectedSlotId] = useState<string | null>(null);
  const [savingSelection, setSavingSelection] = useState(false);
  const schemaRequestIds = useRef<Record<string, number>>({});
  const visuals = useMemo(
    () => workflow ? workflowVisuals(workflow) : lineageVisuals(lineageGraph),
    [lineageGraph, workflow],
  );
  const selectionNodeIdsByNode = useMemo(() => {
    const incoming = new Map(
      visuals.nodes.map((node) => [node.id, new Set<string>()]),
    );
    const outgoing = new Map(
      visuals.nodes.map((node) => [node.id, new Set<string>()]),
    );
    for (const edge of visuals.edges) {
      incoming.get(edge.target)?.add(edge.source);
      outgoing.get(edge.source)?.add(edge.target);
    }

    const selections = new Map<string, string[]>();
    for (const node of visuals.nodes) {
      const selection = new Set([node.id]);
      for (const adjacency of [incoming, outgoing]) {
        const pending = [node.id];
        while (pending.length > 0) {
          const current = pending.pop()!;
          for (const relatedId of adjacency.get(current) ?? []) {
            if (selection.has(relatedId)) continue;
            selection.add(relatedId);
            pending.push(relatedId);
          }
        }
      }
      selections.set(node.id, [...selection]);
    }
    return selections;
  }, [visuals]);
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
    setSelectedNodeIds(new Set());
    setSelectionName(null);
    setInspectedSlotId(null);
  }, [workflow?.id]);

  useEffect(() => {
    if (!inspectedSlotId) return;
    const closeInspector = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectedSlotId(null);
    };
    document.addEventListener("keydown", closeInspector);
    return () => document.removeEventListener("keydown", closeInspector);
  }, [inspectedSlotId]);

  useEffect(() => {
    if (workflow) return;
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedNodeIds(new Set());
    };
    document.addEventListener("keydown", clearSelection);
    return () => document.removeEventListener("keydown", clearSelection);
  }, [workflow]);

  const selectNode = (nodeId: string, additive: boolean) => {
    const selectionNodeIds = selectionNodeIdsByNode.get(nodeId) ?? [nodeId];
    setSelectedNodeIds((current) => {
      if (!additive) return new Set(selectionNodeIds);
      const next = new Set(current);
      const removeSelection = selectionNodeIds.every((selectedId) => next.has(selectedId));
      for (const selectedId of selectionNodeIds) {
        if (removeSelection) next.delete(selectedId);
        else next.add(selectedId);
      }
      return next;
    });
  };

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workflow || event.button !== 0 || event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectionMarquee({
      startX: event.clientX - bounds.left,
      startY: event.clientY - bounds.top,
      currentX: event.clientX - bounds.left,
      currentY: event.clientY - bounds.top,
      additive: event.ctrlKey || event.metaKey,
    });
  };

  const updateMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionMarquee) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setSelectionMarquee((current) => current ? {
      ...current,
      currentX: event.clientX - bounds.left,
      currentY: event.clientY - bounds.top,
    } : null);
  };

  const finishMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionMarquee) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const left = Math.min(selectionMarquee.startX, selectionMarquee.currentX);
    const right = Math.max(selectionMarquee.startX, selectionMarquee.currentX);
    const top = Math.min(selectionMarquee.startY, selectionMarquee.currentY);
    const bottom = Math.max(selectionMarquee.startY, selectionMarquee.currentY);
    const dragged = right - left > 3 || bottom - top > 3;
    const intersectingIds = dragged ? visuals.nodes
      .filter((node) => {
        const position = layout.positions[node.id];
        return position
          && position.x < right
          && position.x + WORKFLOW_NODE_SIZE.width > left
          && position.y < bottom
          && position.y + WORKFLOW_NODE_SIZE.height > top;
      })
      .map((node) => node.id) : [];
    const selectionIntersectingIds = new Set(
      intersectingIds.flatMap((nodeId) => selectionNodeIdsByNode.get(nodeId) ?? [nodeId]),
    );
    setSelectedNodeIds((current) => new Set(selectionMarquee.additive
      ? [...current, ...selectionIntersectingIds]
      : selectionIntersectingIds));
    setSelectionMarquee(null);
  };

  const canSaveSelection = visuals.nodes.some(
    (node) => node.kind === "operation" && selectedNodeIds.has(node.id),
  );

  const saveSelection = async () => {
    if (!onSaveSelection || !canSaveSelection || savingSelection) return;
    const name = selectionName?.trim();
    if (!name) return;
    setSavingSelection(true);
    try {
      await onSaveSelection(name, visuals.nodes
        .filter((node) => selectedNodeIds.has(node.id))
        .map((node) => node.id));
      setSelectionName(null);
    } finally {
      setSavingSelection(false);
    }
  };

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
      const [columns, displayProps] = await Promise.all([
        dataService.getColumns(datasetId),
        dataService.getColumnDisplayProps(datasetId),
      ]);
      if (schemaRequestIds.current[slotId] !== requestId) return;
      setReports((current) => ({
        ...current,
        [slotId]: validateWorkflowInputSchema(
          slot.schemaContract,
          mergeWorkflowTableColumns(columns, displayProps),
        ),
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
  const inspectedSlot = workflow?.inputSlots.find((slot) => slot.id === inspectedSlotId);

  return (
    <div className="workflow-view">
      <header className="workflow-view-header">
        <div>
          <span>{workflow ? t("workflow.definition", { defaultValue: "Workflow definition" }) : t("workflow.lineage", { defaultValue: "Lineage" })}</span>
          <h2>{title}</h2>
        </div>
        <div className="workflow-view-actions">
          <div className="workflow-view-summary">
            {t("workflow.graphSummary", {
              defaultValue: "{{nodes}} nodes · {{edges}} connections",
              nodes: visuals.nodes.length,
              edges: visuals.edges.length,
            })}
          </div>
          {!workflow && onSaveSelection && (
            <button
              type="button"
              className="workflow-save-selection"
              disabled={!canSaveSelection || savingSelection}
              onClick={() => setSelectionName(suggestedWorkflowName)}
            >
              <i className="fa-solid fa-floppy-disk" aria-hidden="true" />
              {t("workflow.saveSelection", { defaultValue: "Save as workflow" })}
            </button>
          )}
        </div>
      </header>

      {workflow && workflow.inputSlots.length > 0 && (
        <section className="workflow-inputs" aria-label={t("workflow.inputs", { defaultValue: "Workflow inputs" })}>
          <h3>{t("workflow.inputs", { defaultValue: "Workflow inputs" })}</h3>
          <div className="workflow-input-grid">
            {workflow.inputSlots.map((slot) => {
              const schemaResolved = slot.schemaContract.columns.some((column) => column.required);
              const report = reports[slot.id];
              const blocking = report ? isSchemaValidationBlocking(report) : false;
              return (
                <div className="workflow-input-row" key={slot.id}>
                  <label htmlFor={`workflow-input-${slot.id}`}>{slot.name}</label>
                  <select
                    id={`workflow-input-${slot.id}`}
                    value={bindings[slot.id] ?? ""}
                    disabled={!schemaResolved}
                    onChange={(event) => void bindInput(slot.id, event.target.value)}
                  >
                    <option value="">{t("workflow.chooseTable", { defaultValue: "Choose input table" })}</option>
                    {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                  </select>
                  <div className="workflow-schema-status" aria-live="polite">
                    {!schemaResolved ? (
                      <span className="invalid"><i className="fa-solid fa-circle-exclamation" aria-hidden="true" /> {t("workflow.schemaUnavailable", { defaultValue: "Schema requirements unavailable. Recreate this workflow." })}</span>
                    ) : checkingSlotId === slot.id ? (
                      <span className="checking"><i className="fa-solid fa-spinner fa-spin" aria-hidden="true" /> {t("workflow.checkingSchema", { defaultValue: "Checking schema" })}</span>
                    ) : checkError[slot.id] ? (
                      <span className="invalid"><i className="fa-solid fa-circle-exclamation" aria-hidden="true" /> {t("workflow.schemaCheckFailed", { defaultValue: "Schema check failed" })}</span>
                    ) : report ? (
                      <span className={blocking ? "invalid" : "valid"}>
                        <i className={`fa-solid ${blocking ? "fa-circle-xmark" : "fa-circle-check"}`} aria-hidden="true" />
                        {blocking
                          ? t("workflow.schemaIncompatible", {
                              defaultValue: "{{missing}} missing, {{mismatch}} wrong type, {{attributes}} wrong properties",
                              missing: report.missingColumns.length,
                              mismatch: report.typeMismatches.length,
                              attributes: report.attributeMismatches.length,
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
          <div
            className="workflow-canvas"
            style={{ width: layout.width, height: layout.height }}
            onPointerDown={beginMarquee}
            onPointerMove={updateMarquee}
            onPointerUp={finishMarquee}
            onPointerCancel={() => setSelectionMarquee(null)}
          >
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
              const inspectableInput = Boolean(workflow && node.kind === "input");
              return (
                <div
                  className={`workflow-node workflow-node-${node.kind}${selectedNodeIds.has(node.id) ? " selected" : ""}`}
                  key={node.id}
                  style={{ left: position.x, top: position.y }}
                  role={!workflow || inspectableInput ? "button" : undefined}
                  tabIndex={!workflow || inspectableInput ? 0 : undefined}
                  aria-pressed={workflow ? undefined : selectedNodeIds.has(node.id)}
                  title={inspectableInput
                    ? t("workflow.inspectSchemaFor", {
                        defaultValue: "View schema requirements for {{name}}",
                        name: node.label,
                      })
                    : undefined}
                  onPointerDown={(event) => {
                    if (workflow || event.button !== 0) return;
                    event.stopPropagation();
                    selectNode(node.id, event.ctrlKey || event.metaKey);
                  }}
                  onDoubleClick={inspectableInput ? () => setInspectedSlotId(node.id) : undefined}
                  onKeyDown={inspectableInput ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setInspectedSlotId(node.id);
                    }
                  } : undefined}
                >
                  <i className={`fa-solid ${node.kind === "operation" ? "fa-gears" : node.kind === "input" ? "fa-table" : "fa-file-lines"}`} aria-hidden="true" />
                  <span><strong>{node.label}</strong><small>{node.detail}</small></span>
                </div>
              );
            })}
            {selectionMarquee && (
              <div
                className="workflow-selection-marquee"
                style={{
                  left: Math.min(selectionMarquee.startX, selectionMarquee.currentX),
                  top: Math.min(selectionMarquee.startY, selectionMarquee.currentY),
                  width: Math.abs(selectionMarquee.currentX - selectionMarquee.startX),
                  height: Math.abs(selectionMarquee.currentY - selectionMarquee.startY),
                }}
              />
            )}
          </div>
        </div>
      )}

      {selectionName !== null && (
        <div className="dialog-overlay">
          <div
            className="dialog workflow-name-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-name-dialog-title"
          >
            <h3 id="workflow-name-dialog-title">
              {t("workflow.namePrompt", { defaultValue: "Workflow name" })}
            </h3>
            <div className="dialog-field">
              <label htmlFor="workflow-name-input">
                {t("workflow.namePrompt", { defaultValue: "Workflow name" })}
              </label>
              <input
                id="workflow-name-input"
                value={selectionName}
                disabled={savingSelection}
                autoFocus
                onChange={(event) => setSelectionName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveSelection();
                  } else if (event.key === "Escape") {
                    setSelectionName(null);
                  }
                }}
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={savingSelection}
                onClick={() => setSelectionName(null)}
              >
                {t("common.cancel", { defaultValue: "Cancel" })}
              </button>
              <button
                type="button"
                disabled={!selectionName.trim() || savingSelection}
                onClick={() => void saveSelection()}
              >
                {t("common.save", { defaultValue: "Save" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {inspectedSlot && (
        <div
          className="dialog-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setInspectedSlotId(null);
          }}
        >
          <div
            className="dialog workflow-schema-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-schema-dialog-title"
          >
            <div className="workflow-schema-dialog-header">
              <div>
                <h3 id="workflow-schema-dialog-title">
                  {t("workflow.schemaRequirements", { defaultValue: "Schema requirements" })}
                </h3>
                <h4>{inspectedSlot.name}</h4>
              </div>
              <button
                type="button"
                className="workflow-schema-dialog-close"
                aria-label={t("common.close", { defaultValue: "Close" })}
                title={t("common.close", { defaultValue: "Close" })}
                autoFocus
                onClick={() => setInspectedSlotId(null)}
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
            <div className="workflow-schema-table-scroll">
              <table className="workflow-schema-table">
                <thead>
                  <tr>
                    <th>{t("workflow.schemaColumn", { defaultValue: "Column" })}</th>
                    <th>{t("workflow.schemaType", { defaultValue: "DuckDB type" })}</th>
                    <th>{t("workflow.schemaProperties", { defaultValue: "Required properties" })}</th>
                    <th>{t("workflow.schemaConsumers", { defaultValue: "Consumed by" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectedSlot.schemaContract.columns.some((column) => column.required) ? inspectedSlot.schemaContract.columns
                    .filter((column) => column.required)
                    .map((column) => {
                      const extras = Object.entries(column.requiredExtras ?? {});
                      return (
                        <tr key={column.name}>
                          <td><strong>{column.name}</strong></td>
                          <td><code>{column.canonicalDuckdbType}</code></td>
                          <td>
                            {extras.length > 0
                              ? extras.map(([name, value]) => (
                                  <code key={name}>{name}: {JSON.stringify(value)}</code>
                                ))
                              : <span className="workflow-schema-none">{t("workflow.schemaNone", { defaultValue: "None" })}</span>}
                          </td>
                          <td>{column.requiredByOperationIds.join(", ")}</td>
                        </tr>
                      );
                    }) : (
                      <tr>
                        <td colSpan={4} className="workflow-schema-none">
                          {t("workflow.schemaUnavailable", { defaultValue: "Schema requirements unavailable. Recreate this workflow." })}
                        </td>
                      </tr>
                    )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
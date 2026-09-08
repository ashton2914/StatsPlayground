import type {
  ArtifactNode,
  LineageEdge,
  LineageNode,
  ProjectDocumentRef,
  ProjectLineageGraph,
} from "@/types/workflow";

import {
  projectDocumentOperations,
  type ProjectDocumentSnapshot,
  type ProjectedOperation,
} from "./operationAdapters";

function artifactNodeId(ref: ProjectDocumentRef): string {
  return `artifact:${ref.kind}:${ref.id}`;
}

function artifactNode(
  documentRef: ProjectDocumentRef,
  name: string,
  artifactKind: ArtifactNode["artifactKind"],
): ArtifactNode {
  const id = artifactNodeId(documentRef);
  return {
    nodeType: "artifact",
    id,
    documentRef,
    name,
    artifactKind,
    inputPort: { id: `${id}:input`, name: "input", payloadKind: artifactKind },
    outputPort: { id: `${id}:output`, name: "output", payloadKind: artifactKind },
  };
}

function edgeId(kind: LineageEdge["kind"], sourceNodeId: string, targetNodeId: string): string {
  return `${kind}:${sourceNodeId}->${targetNodeId}`;
}

function operationEdges(projected: ProjectedOperation): LineageEdge[] {
  const outputNodeId = artifactNodeId(projected.output.documentRef);
  const produced: LineageEdge = {
    id: edgeId("produces", projected.operation.id, outputNodeId),
    kind: "produces",
    source: {
      nodeId: projected.operation.id,
      portId: projected.operation.outputPorts[0].id,
    },
    target: { nodeId: outputNodeId, portId: `${outputNodeId}:input` },
  };
  return [
    ...projected.inputs.map((input): LineageEdge => {
      const sourceNodeId = artifactNodeId(input.sourceDocumentRef);
      return {
        id: edgeId("consumes", sourceNodeId, projected.operation.id),
        kind: "consumes",
        source: { nodeId: sourceNodeId, portId: `${sourceNodeId}:output` },
        target: { nodeId: projected.operation.id, portId: input.port.id },
      };
    }),
    produced,
  ];
}

function compareNodes(left: LineageNode, right: LineageNode): number {
  return left.id.localeCompare(right.id);
}

function compareEdges(left: LineageEdge, right: LineageEdge): number {
  return left.kind.localeCompare(right.kind)
    || left.source.nodeId.localeCompare(right.source.nodeId)
    || left.target.nodeId.localeCompare(right.target.nodeId)
    || left.id.localeCompare(right.id);
}

function assertUniqueIds(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): void {
  const duplicate = (ids: readonly string[]) => ids.find((id, index) => ids.indexOf(id) !== index);
  const duplicateNode = duplicate(nodes.map((node) => node.id));
  if (duplicateNode) throw new Error(`Duplicate project dependency node: ${duplicateNode}`);
  const duplicateEdge = duplicate(edges.map((edge) => edge.id));
  if (duplicateEdge) throw new Error(`Duplicate project dependency edge: ${duplicateEdge}`);
}

function assertResolvedEdges(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const source = nodesById.get(edge.source.nodeId);
    const target = nodesById.get(edge.target.nodeId);
    if (!source) throw new Error(`Unresolved project dependency source: ${edge.source.nodeId}`);
    if (!target) throw new Error(`Unresolved project dependency target: ${edge.target.nodeId}`);
    const sourceKind = source.nodeType === "artifact"
      ? source.outputPort.payloadKind
      : source.outputPorts.find((port) => port.id === edge.source.portId)?.payloadKind;
    const targetKind = target.nodeType === "artifact"
      ? target.inputPort.payloadKind
      : target.inputPorts.find((port) => port.id === edge.target.portId)?.payloadKind;
    if (!sourceKind || !targetKind || (sourceKind !== "any" && targetKind !== "any" && sourceKind !== targetKind)) {
      throw new Error(`Incompatible project dependency edge: ${edge.id}`);
    }
  }
}

export function buildProjectDependencyGraph(snapshot: ProjectDocumentSnapshot): ProjectLineageGraph {
  const tableArtifacts = snapshot.datasets.map((dataset) => (
    artifactNode({ kind: "table", id: dataset.id }, dataset.name, "table")
  ));
  const projected = projectDocumentOperations(snapshot);
  const nodes: LineageNode[] = [
    ...tableArtifacts,
    ...projected.map((item) => artifactNode(
      item.output.documentRef,
      item.output.name,
      item.output.artifactKind,
    )),
    ...projected.map((item) => item.operation),
  ].sort(compareNodes);
  const edges = projected.flatMap(operationEdges).sort(compareEdges);
  assertUniqueIds(nodes, edges);
  assertResolvedEdges(nodes, edges);
  return {
    id: "project-lineage",
    name: "Project lineage",
    graphVersion: 2,
    graphHash: "",
    nodes,
    edges,
  };
}

export type { ProjectDocumentSnapshot } from "./operationAdapters";
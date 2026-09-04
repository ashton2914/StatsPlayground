export interface WorkflowLayoutEdge {
  source: string;
  target: string;
}

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowGraphLayout {
  positions: Record<string, WorkflowNodePosition>;
  width: number;
  height: number;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 88;
const COLUMN_GAP = 80;
const ROW_GAP = 36;
const PADDING = 48;

export function layoutWorkflowGraph(
  nodeIds: string[],
  edges: WorkflowLayoutEdge[],
): WorkflowGraphLayout {
  const nodeSet = new Set(nodeIds);
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));

  for (const edge of edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const levels = new Map<string, number>();
  const queue = nodeIds.filter((id) => incoming.get(id) === 0);
  for (const id of queue) levels.set(id, 0);

  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    const sourceLevel = levels.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      levels.set(target, Math.max(levels.get(target) ?? 0, sourceLevel + 1));
      const remaining = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  for (const id of nodeIds) {
    if (!levels.has(id)) levels.set(id, 0);
  }

  const columns = new Map<number, string[]>();
  for (const id of nodeIds) {
    const level = levels.get(id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), id]);
  }

  const maxLevel = Math.max(0, ...columns.keys());
  const maxRows = Math.max(1, ...Array.from(columns.values(), (items) => items.length));
  const height = PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP;
  const positions: Record<string, WorkflowNodePosition> = {};

  for (const [level, ids] of columns) {
    const columnHeight = ids.length * NODE_HEIGHT + (ids.length - 1) * ROW_GAP;
    const startY = (height - columnHeight) / 2;
    ids.forEach((id, row) => {
      positions[id] = {
        x: PADDING + level * (NODE_WIDTH + COLUMN_GAP),
        y: startY + row * (NODE_HEIGHT + ROW_GAP),
      };
    });
  }

  return {
    positions,
    width: PADDING * 2 + (maxLevel + 1) * NODE_WIDTH + maxLevel * COLUMN_GAP,
    height,
  };
}

export const WORKFLOW_NODE_SIZE = {
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
};
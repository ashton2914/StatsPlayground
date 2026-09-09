import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";
import type { GraphBuilderItem } from "@/types/graphBuilder";
import type { ReportDependency, ReportItem } from "@/types/report";
import type { TabulateItem } from "@/types/tabulate";
import type {
  TableTransformDefinition,
  TableTransformProjectBinding,
} from "@/types/tableTransform";
import type {
  ArtifactKind,
  LineagePort,
  OperationKind,
  OperationNode,
  ProjectDocumentKind,
  ProjectDocumentRef,
  TableColumnConsumption,
  TableInputRequirement,
} from "@/types/workflow";
import { extractReportDependencies } from "@/utils/reportParser";

export interface ProjectDocumentSnapshot {
  datasets: readonly DatasetMeta[];
  tableTransforms?: readonly TableTransformDefinition[];
  tableTransformBindings?: readonly TableTransformProjectBinding[];
  graphs: readonly GraphBuilderItem[];
  analyses: readonly AnalysisDocument[];
  distributions?: readonly DistributionItem[];
  tabulates: readonly TabulateItem[];
  reports: readonly ReportItem[];
}

export interface ProjectedOperationInput {
  sourceDocumentRef: ProjectDocumentRef;
  port: LineagePort;
}

export interface ProjectedOperation {
  operation: OperationNode;
  inputs: ProjectedOperationInput[];
  output: {
    documentRef: ProjectDocumentRef;
    artifactKind: ArtifactKind;
    name: string;
  };
}

export interface WorkflowOperationAdapter<Document> {
  operationKind: OperationKind;
  schemaVersion: string;
  documentKind: ProjectDocumentKind;
  project: (document: Document) => ProjectedOperation;
  normalizeConfiguration: (document: Document) => unknown;
}

function artifactNodeId(ref: ProjectDocumentRef): string {
  return `artifact:${ref.kind}:${ref.id}`;
}

function operationNodeId(kind: ProjectDocumentKind, documentId: string): string {
  return `operation:${kind}:${documentId}`;
}

function inputPort(
  operationId: string,
  name: string,
  payloadKind: LineagePort["payloadKind"],
  tableRequirement?: TableInputRequirement,
): LineagePort {
  return {
    id: `${operationId}:input:${name}`,
    name,
    payloadKind,
    ...(tableRequirement ? { tableRequirement } : {}),
  };
}

function outputPort(operationId: string, payloadKind: LineagePort["payloadKind"]): LineagePort {
  return {
    id: `${operationId}:output:result`,
    name: "result",
    payloadKind,
  };
}

function tableRequirement(
  columnNames: Iterable<string>,
  requiredExtras: ReadonlyMap<string, TableColumnConsumption["requiredExtraKinds"]> = new Map(),
): TableInputRequirement {
  const names = [...new Set(columnNames)].filter((name) => name.trim().length > 0).sort();
  return {
    columns: names.map((name) => ({
      name,
      requiredExtraKinds: [...(requiredExtras.get(name) ?? [])].sort(),
    })),
    completeSchema: false,
  };
}

function activeGraphColumns(graph: GraphBuilderItem): TableInputRequirement {
  const columns = new Set<string>();
  const requiredExtras = new Map<string, TableColumnConsumption["requiredExtraKinds"]>();
  const addField = (field: { name: string } | undefined) => {
    if (field?.name.trim()) columns.add(field.name);
  };
  const state = graph.mode === "3d"
    ? graph.modeStates.threeD
    : graph.mode === "multivariate"
      ? graph.modeStates.multivariate
      : graph.modeStates.twoD;

  if ("encoding" in state) {
    Object.values(state.encoding).forEach(addField);
  }
  if ("multiX" in state) state.multiX.forEach(addField);
  if ("multiY" in state) state.multiY.forEach(addField);
  if ("columns" in state) state.columns.forEach(addField);
  graph.filters?.forEach((item) => addField(item.rule.field));

  if (graph.mode === "2d") {
    const x = graph.modeStates.twoD.encoding.x?.name;
    const y = graph.modeStates.twoD.encoding.y?.name;
    if (x && graph.modeStates.twoD.autoSpecLinesX) requiredExtras.set(x, ["spec"]);
    if (y && (graph.modeStates.twoD.autoSpecLinesY || graph.modeStates.twoD.autoSpecLines)) {
      requiredExtras.set(y, ["spec"]);
    }
  }
  return tableRequirement(columns, requiredExtras);
}

function graphConfiguration(graph: GraphBuilderItem): unknown {
  const activeState = graph.mode === "3d"
    ? graph.modeStates.threeD
    : graph.mode === "multivariate"
      ? graph.modeStates.multivariate
      : graph.modeStates.twoD;
  return {
    sourceDatasetId: graph.sourceDatasetId,
    mode: graph.mode,
    activeState,
    filters: graph.filters ?? [],
    sampling: graph.sampling ?? { mode: "full" },
    groupThemeSlots: graph.groupThemeSlots ?? {},
  };
}

export const graphOperationAdapter: WorkflowOperationAdapter<GraphBuilderItem> = {
  operationKind: "graphGeneration",
  schemaVersion: "1",
  documentKind: "graph",
  normalizeConfiguration: graphConfiguration,
  project: (graph) => {
    const operationId = operationNodeId("graph", graph.id);
    const sourceDocumentRef: ProjectDocumentRef = { kind: "table", id: graph.sourceDatasetId };
    const sourcePort = inputPort(operationId, "source", "table", activeGraphColumns(graph));
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "graphGeneration",
        schemaVersion: "1",
        configuration: graphConfiguration(graph),
        documentRef: { kind: "graph", id: graph.id },
        inputPorts: [sourcePort],
        outputPorts: [outputPort(operationId, "graph")],
      },
      inputs: [{ sourceDocumentRef, port: sourcePort }],
      output: { documentRef: { kind: "graph", id: graph.id }, artifactKind: "graph", name: graph.name },
    };
  },
};

interface BoundTableTransform {
  definition: TableTransformDefinition;
  binding: TableTransformProjectBinding;
}

function transformTableRequirement(
  definition: TableTransformDefinition,
  role: string,
): TableInputRequirement {
  const slot = definition.inputSlots.find((candidate) => candidate.role === role);
  if (!slot) throw new Error(`Missing Table Transform input contract: ${definition.id}:${role}`);
  return {
    columns: slot.schemaContract.columns.map((column) => ({
      name: column.name,
      requiredExtraKinds: Object.keys(column.requiredExtras ?? {})
        .filter((kind): kind is TableColumnConsumption["requiredExtraKinds"][number] => (
          kind === "spec" || kind === "valueOrder"
        ))
        .sort(),
    })),
    completeSchema: definition.operation.kind === "transpose",
  };
}

export const tableTransformOperationAdapter: WorkflowOperationAdapter<BoundTableTransform> = {
  operationKind: "tableTransform",
  schemaVersion: "1",
  documentKind: "tableTransform",
  normalizeConfiguration: ({ definition }) => definition,
  project: ({ definition, binding }) => {
    if (binding.definitionId !== definition.id || binding.definitionRevision !== definition.revision) {
      throw new Error(`Stale Table Transform binding: ${definition.id}`);
    }
    const operationId = operationNodeId("tableTransform", definition.id);
    const bindingByRole = new Map(binding.inputs.map((input) => [input.role, input]));
    const inputs = definition.inputSlots.map((slot) => {
      const input = bindingByRole.get(slot.role);
      if (!input) throw new Error(`Missing Table Transform input binding: ${definition.id}:${slot.role}`);
      const sourceDocumentRef: ProjectDocumentRef = { kind: "table", id: input.tableDocumentId };
      return {
        sourceDocumentRef,
        port: inputPort(
          operationId,
          slot.role,
          "table",
          transformTableRequirement(definition, slot.role),
        ),
      };
    });
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "tableTransform",
        schemaVersion: "1",
        configuration: definition,
        documentRef: { kind: "tableTransform", id: definition.id },
        inputPorts: inputs.map((input) => input.port),
        outputPorts: [outputPort(operationId, "table")],
      },
      inputs,
      output: {
        documentRef: { kind: "table", id: definition.output.tableDocumentId },
        artifactKind: "table",
        name: definition.output.name,
      },
    };
  },
};

function analysisColumns(analysis: AnalysisDocument): TableInputRequirement {
  if (analysis.analysisKind === "fitYByX") {
    return tableRequirement([
      analysis.definition.response.name,
      analysis.definition.factor.name,
    ]);
  }
  if (analysis.analysisKind === "fitModel") {
    return tableRequirement([
      analysis.definition.response.name,
      ...analysis.definition.terms.flatMap((term) => term.columnNames),
    ]);
  }
  if (analysis.analysisKind === "hypothesisTest") {
    const { roles } = analysis.definition;
    return roles.layout === "long"
      ? tableRequirement([
          roles.response.name,
          roles.condition.name,
          ...(roles.subject ? [roles.subject.name] : []),
        ])
      : tableRequirement([
          ...roles.measurements.map((field) => field.name),
          ...(roles.subject ? [roles.subject.name] : []),
        ]);
  }
  return tableRequirement([
    ...analysis.definition.responses.map((field) => field.name),
    ...analysis.definition.by.map((field) => field.name),
    ...(analysis.definition.weight ? [analysis.definition.weight.name] : []),
    ...(analysis.definition.frequency ? [analysis.definition.frequency.name] : []),
  ]);
}

function analysisConfiguration(analysis: AnalysisDocument): unknown {
  return {
    schemaVersion: analysis.schemaVersion,
    analysisKind: analysis.analysisKind,
    configRevision: analysis.configRevision,
    source: analysis.source,
    definition: analysis.definition,
    presentation: analysis.presentation,
  };
}

export const analysisOperationAdapter: WorkflowOperationAdapter<AnalysisDocument> = {
  operationKind: "analysisExecution",
  schemaVersion: "1",
  documentKind: "analysis",
  normalizeConfiguration: analysisConfiguration,
  project: (analysis) => {
    const operationId = operationNodeId("analysis", analysis.id);
    const sourceDocumentRef: ProjectDocumentRef = { kind: "table", id: analysis.source.datasetId };
    const sourcePort = inputPort(operationId, "source", "table", analysisColumns(analysis));
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "analysisExecution",
        schemaVersion: "1",
        configuration: analysisConfiguration(analysis),
        documentRef: { kind: "analysis", id: analysis.id },
        inputPorts: [sourcePort],
        outputPorts: [outputPort(operationId, "analysis")],
      },
      inputs: [{ sourceDocumentRef, port: sourcePort }],
      output: {
        documentRef: { kind: "analysis", id: analysis.id },
        artifactKind: "analysis",
        name: analysis.name,
      },
    };
  },
};

function distributionConfiguration(distribution: DistributionItem): unknown {
  return {
    sourceDatasetId: distribution.sourceDatasetId,
    responses: distribution.responses,
    weight: distribution.weight,
    frequency: distribution.frequency,
    by: distribution.by,
    analysis: distribution.analysis,
    graphs: distribution.graphs,
  };
}

export const distributionOperationAdapter: WorkflowOperationAdapter<DistributionItem> = {
  operationKind: "analysisExecution",
  schemaVersion: "1",
  documentKind: "distribution",
  normalizeConfiguration: distributionConfiguration,
  project: (distribution) => {
    const operationId = operationNodeId("distribution", distribution.id);
    const sourceDocumentRef: ProjectDocumentRef = { kind: "table", id: distribution.sourceDatasetId };
    const sourcePort = inputPort(operationId, "source", "table", tableRequirement([
      ...distribution.responses.map((field) => field.name),
      ...distribution.by.map((field) => field.name),
      ...(distribution.weight ? [distribution.weight.name] : []),
      ...(distribution.frequency ? [distribution.frequency.name] : []),
    ]));
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "analysisExecution",
        schemaVersion: "1",
        configuration: distributionConfiguration(distribution),
        documentRef: { kind: "distribution", id: distribution.id },
        inputPorts: [sourcePort],
        outputPorts: [outputPort(operationId, "distribution")],
      },
      inputs: [{ sourceDocumentRef, port: sourcePort }],
      output: {
        documentRef: { kind: "distribution", id: distribution.id },
        artifactKind: "distribution",
        name: distribution.name,
      },
    };
  },
};

function tabulateConfiguration(tabulate: TabulateItem): unknown {
  return {
    sourceDatasetId: tabulate.sourceDatasetId,
    rowFields: tabulate.rowFields,
    columnFields: tabulate.columnFields,
    statistics: tabulate.statistics,
    includeRowTotals: tabulate.includeRowTotals,
    includeColumnTotals: tabulate.includeColumnTotals,
  };
}

export const tabulateOperationAdapter: WorkflowOperationAdapter<TabulateItem> = {
  operationKind: "tabulate",
  schemaVersion: "1",
  documentKind: "tabulate",
  normalizeConfiguration: tabulateConfiguration,
  project: (tabulate) => {
    const operationId = operationNodeId("tabulate", tabulate.id);
    const sourceDocumentRef: ProjectDocumentRef = { kind: "table", id: tabulate.sourceDatasetId };
    const sourcePort = inputPort(operationId, "source", "table", tableRequirement([
      ...tabulate.rowFields,
      ...tabulate.columnFields,
      ...tabulate.statistics.map((statistic) => statistic.field),
    ]));
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "tabulate",
        schemaVersion: "1",
        configuration: tabulateConfiguration(tabulate),
        documentRef: { kind: "tabulate", id: tabulate.id },
        inputPorts: [sourcePort],
        outputPorts: [outputPort(operationId, "tabulate")],
      },
      inputs: [{ sourceDocumentRef, port: sourcePort }],
      output: {
        documentRef: { kind: "tabulate", id: tabulate.id },
        artifactKind: "tabulate",
        name: tabulate.name,
      },
    };
  },
};

function reportDependencyRef(dependency: ReportDependency): ProjectDocumentRef {
  if (
    dependency.kind === "fitYByX"
    || dependency.kind === "distribution"
    || dependency.kind === "hypothesisTest"
  ) {
    return { kind: "analysis", id: dependency.documentId };
  }
  return { kind: dependency.kind, id: dependency.documentId };
}

function reportDependencyPayload(dependency: ReportDependency): LineagePort["payloadKind"] {
  return dependency.kind === "fitYByX"
    || dependency.kind === "distribution"
    || dependency.kind === "hypothesisTest"
    ? "analysis"
    : dependency.kind;
}

export const reportOperationAdapter: WorkflowOperationAdapter<ReportItem> = {
  operationKind: "reportComposition",
  schemaVersion: "1",
  documentKind: "report",
  normalizeConfiguration: (report) => ({ schemaVersion: report.schemaVersion, markdown: report.markdown }),
  project: (report) => {
    const operationId = operationNodeId("report", report.id);
    const inputs = extractReportDependencies(report.markdown)
      .map((dependency) => ({
        sourceDocumentRef: reportDependencyRef(dependency),
        payloadKind: reportDependencyPayload(dependency),
      }))
      .sort((left, right) => artifactNodeId(left.sourceDocumentRef).localeCompare(artifactNodeId(right.sourceDocumentRef)))
      .map(({ sourceDocumentRef, payloadKind }) => {
        const name = `${sourceDocumentRef.kind}:${sourceDocumentRef.id}`;
        return {
          sourceDocumentRef,
          port: inputPort(
            operationId,
            name,
            payloadKind,
            sourceDocumentRef.kind === "table" ? { columns: [], completeSchema: true } : undefined,
          ),
        };
      });
    return {
      operation: {
        nodeType: "operation",
        id: operationId,
        kind: "reportComposition",
        schemaVersion: "1",
        configuration: reportOperationAdapter.normalizeConfiguration(report),
        documentRef: { kind: "report", id: report.id },
        inputPorts: inputs.map((input) => input.port),
        outputPorts: [outputPort(operationId, "report")],
      },
      inputs,
      output: { documentRef: { kind: "report", id: report.id }, artifactKind: "report", name: report.name },
    };
  },
};

export function projectDocumentOperations(snapshot: ProjectDocumentSnapshot): ProjectedOperation[] {
  const tableTransformBindings = new Map(
    (snapshot.tableTransformBindings ?? []).map((binding) => [binding.definitionId, binding]),
  );
  return [
    ...(snapshot.tableTransforms ?? []).map((definition) => {
      const binding = tableTransformBindings.get(definition.id);
      if (!binding) throw new Error(`Missing Table Transform binding: ${definition.id}`);
      return tableTransformOperationAdapter.project({ definition, binding });
    }),
    ...snapshot.graphs.map((document) => graphOperationAdapter.project(document)),
    ...snapshot.analyses.map((document) => analysisOperationAdapter.project(document)),
    ...(snapshot.distributions ?? []).map((document) => distributionOperationAdapter.project(document)),
    ...snapshot.tabulates.map((document) => tabulateOperationAdapter.project(document)),
    ...snapshot.reports.map((document) => reportOperationAdapter.project(document)),
  ];
}
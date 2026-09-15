import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import { createApplicationCommandRuntime } from "@/applicationCommands/runtime";
import { createTableCommandHandlers, type TableCommandDependencies } from "@/applicationCommands/tableCommands";
import {
  createTableTransformCommandHandlers,
  type TableTransformCommandDependencies,
} from "@/applicationCommands/tableTransformCommands";
import { createSqlCommandHandlers, type SqlCommandDependencies } from "@/applicationCommands/sqlCommands";
import {
  createGraphCommandHandlers,
  type GraphCommandDependencies,
} from "@/applicationCommands/graphCommands";
import {
  createReportCommandHandlers,
  type ReportCommandDependencies,
} from "@/applicationCommands/reportCommands";
import {
  createTabulateCommandHandlers,
  type TabulateCommandDependencies,
} from "@/applicationCommands/tabulateCommands";
import { useProjectStore } from "@/stores/useProjectStore";
import type {
  ApplicationCommandRegistry,
} from "@/applicationCommands/types";
import type { CommandPolicy } from "@/applicationCommands/policy";

export interface ApplicationRuntimeDependencies {
  initialRevision?: number;
  policy?: CommandPolicy;
  revision?: {
    get: () => number;
    set: (revision: number) => void;
  };
  project?: ProjectCommandDependencies;
  table?: Omit<TableCommandDependencies, "projectHandlers" | "projectDependencies">;
  tableTransform?: Omit<TableTransformCommandDependencies, "projectHandlers" | "projectDependencies">;
  sql?: Omit<SqlCommandDependencies, "projectHandlers" | "projectDependencies">;
  graph?: Partial<GraphCommandDependencies>;
  report?: Partial<ReportCommandDependencies>;
  tabulate?: Partial<TabulateCommandDependencies>;
}

export interface RegisteredApplicationRuntime extends ReturnType<typeof createApplicationCommandRuntime<ApplicationCommandRegistry>> {
  flushPendingEffects(): void;
}

export function createApplicationRuntime(
  dependencies: ApplicationRuntimeDependencies = {},
): RegisteredApplicationRuntime {
  const runtime = createApplicationCommandRuntime<ApplicationCommandRegistry>({
    initialRevision: dependencies.initialRevision,
    policy: dependencies.policy,
    revision: dependencies.revision,
  });

  const projectHandlers = createProjectCommandHandlers(dependencies.project);
  const tableHandlers = createTableCommandHandlers({
    ...dependencies.table,
    projectHandlers,
  });
  const tableTransformHandlers = createTableTransformCommandHandlers({
    ...dependencies.tableTransform,
    projectHandlers,
  });
  const sqlHandlers = createSqlCommandHandlers({
    ...dependencies.sql,
    projectHandlers,
  });
  const graphHandlers = createGraphCommandHandlers({
    ...dependencies.graph,
  });
  const reportHandlers = createReportCommandHandlers({
    ...dependencies.report,
  });
  const tabulateHandlers = createTabulateCommandHandlers({
    createTable: (input, controls) => tableHandlers.createTable(input, controls),
    ...dependencies.tabulate,
  });

  runtime.register(
    "project.inspect",
    async (input) => ({
      changed: false,
      data: await projectHandlers.inspectProject(input),
      warnings: [],
    }),
    { mode: "read", risk: "low" },
  );

  runtime.register(
    "table.create",
    async (input, context) => {
      const outcome = await tableHandlers.createTable(input, { beginCommit: () => context.beginCommit() });
      return {
        changed: true,
        data: outcome.result,
        warnings: outcome.warnings,
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "tableTransform.create",
    async (input, context) => {
      const outcome = await tableTransformHandlers.create(input, {
        signal: context.signal,
        beginCommit: () => context.beginCommit(),
      });
      return {
        changed: true,
        data: outcome.data,
        warnings: outcome.warnings,
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "tableTransform.run",
    async (input, context) => {
      const outcome = await tableTransformHandlers.run(input, {
        signal: context.signal,
        beginCommit: () => context.beginCommit(),
      });
      return {
        changed: true,
        data: outcome.data,
        warnings: outcome.warnings,
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "sql.createTable",
    async (input, context) => {
      const outcome = await sqlHandlers.createTable(input, {
        signal: context.signal,
        beginCommit: () => context.beginCommit(),
      });
      return {
        changed: true,
        data: outcome.result,
        warnings: outcome.warnings,
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "graph.create",
    async (input, context) => ({
      changed: true,
      data: graphHandlers.create(input, { beginCommit: () => context.beginCommit() }),
      warnings: [],
    }),
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "graph.update",
    async (input, context) => {
      const outcome = graphHandlers.update(input, { beginCommit: () => context.beginCommit() });
      return {
        changed: outcome.changed,
        data: outcome.data,
        warnings: [],
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "report.create",
    async (input, context) => ({
      changed: true,
      data: reportHandlers.create(input, { beginCommit: () => context.beginCommit() }),
      warnings: [],
    }),
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "report.update",
    async (input, context) => {
      const outcome = reportHandlers.update(input, { beginCommit: () => context.beginCommit() });
      return {
        changed: outcome.changed,
        data: outcome.data,
        warnings: [],
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "tabulate.create",
    async (input, context) => ({
      changed: true,
      data: await tabulateHandlers.create(input, { beginCommit: () => context.beginCommit() }),
      warnings: [],
    }),
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "tabulate.run",
    async (input, context) => {
      const outcome = await tabulateHandlers.run(input, { signal: context.signal });
      return {
        changed: false,
        data: outcome.data,
        warnings: outcome.warnings,
      };
    },
    { mode: "read", risk: "low" },
  );

  runtime.register(
    "tabulate.exportTable",
    async (input, context) => {
      const outcome = await tabulateHandlers.exportTable(input, {
        signal: context.signal,
        beginCommit: () => context.beginCommit(),
      });
      return {
        changed: true,
        data: outcome.data,
        warnings: outcome.warnings,
      };
    },
    { mode: "mutation", risk: "low" },
  );

  runtime.register(
    "table.list",
    async (input) => ({
      changed: false,
      data: await projectHandlers.listProjectTables(input),
      warnings: [],
    }),
    { mode: "read", risk: "low" },
  );

  runtime.register(
    "table.describe",
    async (input) => ({
      changed: false,
      data: await projectHandlers.describeProjectTable(input),
      warnings: [],
    }),
    { mode: "read", risk: "low" },
  );

  runtime.register(
    "document.list",
    async (input) => ({
      changed: false,
      data: await projectHandlers.listProjectDocuments(input),
      warnings: [],
    }),
    { mode: "read", risk: "low" },
  );

  runtime.register(
    "document.get",
    async (input) => ({
      changed: false,
      data: await projectHandlers.getProjectDocument(input),
      warnings: [],
    }),
    { mode: "read", risk: "low" },
  );

  return Object.assign(runtime, {
    flushPendingEffects() {
      reportHandlers.flushPendingHistory();
    },
  });
}

const projectRevisionAdapter = {
  get: () => useProjectStore.getState().projectRevision,
  set: (revision: number) => useProjectStore.getState().setRevision(revision),
};

export const applicationRuntime = createApplicationRuntime({
  revision: projectRevisionAdapter,
});

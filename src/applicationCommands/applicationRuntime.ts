import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import { createApplicationCommandRuntime } from "@/applicationCommands/runtime";
import { createTableCommandHandlers, type TableCommandDependencies } from "@/applicationCommands/tableCommands";
import type {
  ApplicationCommandRegistry,
} from "@/applicationCommands/types";
import type { CommandPolicy } from "@/applicationCommands/policy";

export interface ApplicationRuntimeDependencies {
  initialRevision?: number;
  policy?: CommandPolicy;
  project?: ProjectCommandDependencies;
  table?: Omit<TableCommandDependencies, "projectHandlers" | "projectDependencies">;
}

export function createApplicationRuntime(
  dependencies: ApplicationRuntimeDependencies = {},
) {
  const runtime = createApplicationCommandRuntime<ApplicationCommandRegistry>({
    initialRevision: dependencies.initialRevision,
    policy: dependencies.policy,
  });

  const projectHandlers = createProjectCommandHandlers(dependencies.project);
  const tableHandlers = createTableCommandHandlers({
    ...dependencies.table,
    projectHandlers,
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
    async (input, context) => ({
      changed: true,
      data: await tableHandlers.createTable(input, { beginCommit: () => context.beginCommit() }),
      warnings: [],
    }),
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

  return runtime;
}

export const applicationRuntime = createApplicationRuntime();

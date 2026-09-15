import {
  createProjectCommandHandlers,
  type ProjectCommandDependencies,
} from "@/applicationCommands/projectCommands";
import { createApplicationCommandRuntime } from "@/applicationCommands/runtime";
import { createTableCommandHandlers, type TableCommandDependencies } from "@/applicationCommands/tableCommands";
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
}

export function createApplicationRuntime(
  dependencies: ApplicationRuntimeDependencies = {},
) {
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

const projectRevisionAdapter = {
  get: () => useProjectStore.getState().projectRevision,
  set: (revision: number) => useProjectStore.getState().setRevision(revision),
};

export const applicationRuntime = createApplicationRuntime({
  revision: projectRevisionAdapter,
});

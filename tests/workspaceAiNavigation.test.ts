import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  openWorkspaceAiServer,
  openWorkspaceAiSkills,
  type WorkspaceAiNavigationState,
} from "../src/components/workspaceAiNavigation.ts";

const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const baseState: WorkspaceAiNavigationState = {
  activeTab: "files",
  activeAiSubview: "server",
};

{
  const next = openWorkspaceAiServer(baseState);

  assert.deepEqual(next, {
    activeTab: "ai",
    activeAiSubview: "server",
  });
  assert.deepEqual(baseState, {
    activeTab: "files",
    activeAiSubview: "server",
  });
  assert.match(workspaceSource, /openWorkspaceAiServer/);
}

{
  const prior = {
    activeTab: "history",
    activeAiSubview: "server",
  } satisfies WorkspaceAiNavigationState;
  const next = openWorkspaceAiSkills(prior);

  assert.deepEqual(next, {
    activeTab: "ai",
    activeAiSubview: "skills",
  });
  assert.deepEqual(prior, {
    activeTab: "history",
    activeAiSubview: "server",
  });
  assert.match(workspaceSource, /openWorkspaceAiSkills/);
}

console.log("workspace AI navigation tests passed");
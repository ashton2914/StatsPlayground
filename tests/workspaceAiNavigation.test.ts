import assert from "node:assert/strict";

import {
  applyWorkspaceAiNavigation,
  openWorkspaceAiServer,
  openWorkspaceAiSkills,
  type WorkspaceAiNavigationState,
} from "../src/components/workspaceAiNavigation.ts";

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
}

{
  const calls: string[] = [];

  applyWorkspaceAiNavigation(
    openWorkspaceAiSkills(baseState),
    {
      setActiveTab: (tab) => calls.push(`tab:${tab}`),
      setActiveAiSubview: (subview) => calls.push(`subview:${subview}`),
    },
  );

  assert.deepEqual(calls, ["tab:ai", "subview:skills"]);
}

console.log("workspace AI navigation tests passed");
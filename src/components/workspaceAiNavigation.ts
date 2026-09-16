export type WorkspaceAiNavigationTab = "files" | "history" | "workflow" | "ai";

export interface WorkspaceAiNavigationState {
  activeTab: WorkspaceAiNavigationTab;
  activeAiSubview: "server" | "skills";
}

export function openWorkspaceAiServer(
  state: WorkspaceAiNavigationState,
): WorkspaceAiNavigationState {
  return {
    ...state,
    activeTab: "ai",
    activeAiSubview: "server",
  };
}

export function openWorkspaceAiSkills(
  state: WorkspaceAiNavigationState,
): WorkspaceAiNavigationState {
  return {
    ...state,
    activeTab: "ai",
    activeAiSubview: "skills",
  };
}
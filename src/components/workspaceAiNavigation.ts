export type WorkspaceAiNavigationTab = "files" | "history" | "workflow" | "ai";

export interface WorkspaceAiNavigationState {
  activeTab: WorkspaceAiNavigationTab;
  activeAiSubview: "server" | "skills";
}

interface WorkspaceAiNavigationSetters {
  setActiveTab: (tab: WorkspaceAiNavigationTab) => void;
  setActiveAiSubview: (subview: WorkspaceAiNavigationState["activeAiSubview"]) => void;
}

export function applyWorkspaceAiNavigation(
  next: WorkspaceAiNavigationState,
  setters: WorkspaceAiNavigationSetters,
) {
  setters.setActiveTab(next.activeTab);
  setters.setActiveAiSubview(next.activeAiSubview);
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
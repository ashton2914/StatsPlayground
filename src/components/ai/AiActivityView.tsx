import { useEffect } from "react";

import { type createMcpStore, useMcpStore } from "@/stores/useMcpStore";

import { McpServerPanel } from "./McpServerPanel";
import { SkillsPanel } from "./SkillsPanel";

type McpStoreHook = ReturnType<typeof createMcpStore>;

export function AiActivityView({
  subview,
  onSelectSubview,
  store = useMcpStore,
  copyText,
}: {
  subview: "server" | "skills";
  onSelectSubview: (subview: "server" | "skills") => void;
  store?: McpStoreHook;
  copyText?: (value: string) => Promise<void>;
}) {
  useEffect(() => {
    store.getState().setViewVisible(true);
    return () => {
      store.getState().setViewVisible(false);
    };
  }, [store]);

  return (
    <div className="main-content ai-activity-view">
      {subview === "server" ? (
        <McpServerPanel
          store={store}
          onSelectSkills={() => onSelectSubview("skills")}
          copyText={copyText}
        />
      ) : (
        <SkillsPanel onBackToServer={() => onSelectSubview("server")} />
      )}
    </div>
  );
}

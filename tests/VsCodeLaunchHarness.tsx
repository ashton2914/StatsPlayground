import { useState } from "react";
import { McpServerPanel } from "../src/components/ai/McpServerPanel";
import { createMcpStore } from "../src/stores/useMcpStore";

export function VsCodeLaunchHarness({scenario = "conflict"}: {scenario?: "legacy" | "conflict" | "create" | "cancel" | "tracked" | "notFound" | "launchFailed"}) {
  const [store] = useState(() => {
    const instance = createMcpStore({launchService: {
      selectWorkspace: async () => scenario === "cancel" ? null : "/private/Demo",
      planVsCodeLaunch: async () => {
        if (scenario === "tracked") throw new Error("The workspace MCP configuration is Git-tracked.");
        return {configurationPath:scenario === "legacy" ? ".vscode/mcp.json" : ".mcp.json",planId:"plan-1",workspaceDisplayName:"Demo",configurationAction:scenario === "conflict" ? "replaceManagedEntry" : "create",confirmationRequired:scenario === "conflict",currentEndpoint:scenario === "conflict" ? "Different endpoint" : null,proposedEndpoint:"http://127.0.0.1:48123/mcp",gitProtection:"nonGit",settingsAction:"initializePersistent",warnings:["localCredential","initializePersistent"]};
      },
      executeVsCodeLaunch: async () => ({configurationPath:scenario === "legacy" ? ".vscode/mcp.json" : ".mcp.json",workspaceDisplayName:"Demo",configurationResult:"create",serverState:"running",endpoint:"http://127.0.0.1:48123/mcp",launchResult:scenario === "notFound" ? "configuredVsCodeNotFound" : scenario === "launchFailed" ? "configuredLaunchFailed" : "launched",warnings:[]}),
    }});
    instance.setState({refresh:async()=>{}});
    return instance;
  });
  return <McpServerPanel store={store} onSelectSkills={()=>{}} />;
}

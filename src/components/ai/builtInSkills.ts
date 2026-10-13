import guide from "../../../built-in-skills/sp-mcp-guide/SKILL.md?raw";
import tools from "../../../built-in-skills/sp-mcp-guide/references/tools.md?raw";
import examples from "../../../built-in-skills/sp-mcp-guide/references/examples.json?raw";
import distribution from "../../../built-in-skills/sp-distribution-analyze/SKILL.md?raw";

export const builtInSkills = [
  { id: "sp-mcp-guide", name: "SP MCP Guide", descriptionKey: "guideDescription", files: [
    { path: "SKILL.md", content: guide },
    { path: "references/tools.md", content: tools },
    { path: "references/examples.json", content: examples },
  ] },
  { id: "sp-distribution-analyze", name: "Distribution Analyze", descriptionKey: "distributionDescription", files: [
    { path: "SKILL.md", content: distribution },
  ] },
];

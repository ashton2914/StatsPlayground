import { Children, createElement, isValidElement, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { builtInSkills } from "./builtInSkills";
import "./skills.css";

function headingText(node: ReactNode): string {
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child)
    ? headingText(child.props.children) : String(child)).join("");
}
function markdownHeading(tag: "h1" | "h2" | "h3" | "h4") {
  return ({ children }: { children?: ReactNode }) => createElement(tag, {
    id: headingText(children).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"),
  }, children);
}

export function SkillsPanel({ onBackToServer }: { onBackToServer: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [filePath, setFilePath] = useState("SKILL.md");
  const skill = builtInSkills.find((entry) => entry.id === selected);
  const file = skill?.files.find((entry) => entry.path === filePath);
  return <section className="ai-panel ai-panel-skills">
    <div className="ai-panel-header">
      <div><h2>Skills</h2><p>{t("ai.skills.description")}</p></div>
    </div>
    <div className="ai-panel-scroll">
      <section aria-labelledby="built-in-skills-heading">
        <h3 id="built-in-skills-heading">Build-in</h3>
        <div className="skills-grid">
          {builtInSkills.map((entry) => <article className="ai-section-block skill-card" key={entry.id}>
            <div className="ai-section-header"><h3>{entry.name}</h3><span className="ai-status-badge">{t("ai.skills.builtIn")}</span></div>
            <p>{t(`ai.skills.${entry.descriptionKey}`)}</p>
            <code>{entry.id}</code>
            <button type="button" className="btn-secondary" aria-label={t("ai.skills.viewNamed", { name: entry.name })} onClick={() => { setSelected(entry.id); setFilePath("SKILL.md"); }}>{t("ai.skills.view")}</button>
          </article>)}
        </div>
        <p className="ai-list-secondary">{t("ai.skills.workspaceHint")}</p>
      </section>
      {skill && file && <section className="ai-section-block skill-instructions" aria-label={t("ai.skills.instructionsNamed", { name: skill.name })}>
        <div className="ai-section-header"><h3>{skill.name}</h3><button type="button" className="btn-text" onClick={() => setSelected(null)}>{t("ai.skills.close")}</button></div>
        <div className="ai-inline-actions" role="group" aria-label={t("ai.skills.files")}>
          {skill.files.map((entry) => <button className="btn-secondary" type="button" aria-pressed={entry.path === filePath} key={entry.path} onClick={() => setFilePath(entry.path)}>{entry.path}</button>)}
        </div>
        {file.path.endsWith(".json") ? <pre>{file.content}</pre> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          h1: markdownHeading("h1"), h2: markdownHeading("h2"), h3: markdownHeading("h3"), h4: markdownHeading("h4"),
          a: ({ href, children }) => {
            const localPath = href?.replace(/^\.\//, "").split("#")[0];
            if (skill.files.some((entry) => entry.path === localPath)) return <button type="button" className="btn-text" onClick={() => setFilePath(localPath!)}>{children}</button>;
            return <a href={href}>{children}</a>;
          },
        }}>{file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}</ReactMarkdown>}
      </section>}
    </div>
    <div className="ai-panel-footer"><button type="button" className="btn-text" onClick={onBackToServer}>{t("ai.skills.backToServer")}</button></div>
  </section>;
}

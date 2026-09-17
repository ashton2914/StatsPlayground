import { useTranslation } from "react-i18next";

export function SkillsPlaceholder({
  onBackToServer,
}: {
  onBackToServer: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="ai-panel ai-panel-skills">
      <div className="ai-panel-header">
        <div>
          <h2>Skills</h2>
          <p>{t("ai.skills.placeholderLead", { defaultValue: "Skills are not available in Phase 1." })}</p>
        </div>
      </div>
      <div className="ai-section-block">
        <div className="empty-hint">{t("ai.skills.placeholderBody", { defaultValue: "This placeholder is truthful by design: there is no Skill runtime, installation flow, or enablement control in the current MCP scope." })}</div>
      </div>
      <div className="ai-panel-footer">
        <button type="button" className="btn-text" onClick={onBackToServer}>
          {t("ai.skills.backToServer", { defaultValue: "Back to MCP Server" })}
        </button>
      </div>
    </section>
  );
}
import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

interface AnalysisFrameProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "className" | "style" | "title"> {
  title: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
}

export function AnalysisFrame({
  title,
  children,
  defaultExpanded = true,
  ...sectionProps
}: AnalysisFrameProps) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="analysis-ui-frame" {...sectionProps}>
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="analysis-ui-frame-title"
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true" className="analysis-ui-disclosure">{expanded ? "▾" : "▸"}</span>
        <span>{title}</span>
      </button>
      {expanded && <div className="analysis-ui-frame-body" id={bodyId}>{children}</div>}
    </section>
  );
}
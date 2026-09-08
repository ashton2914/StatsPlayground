import type { ComponentPropsWithoutRef } from "react";

type AnalysisTextProps = Omit<ComponentPropsWithoutRef<"p">, "className" | "style">;

export function AnalysisText(props: AnalysisTextProps) {
  return <p className="analysis-ui-text" {...props} />;
}
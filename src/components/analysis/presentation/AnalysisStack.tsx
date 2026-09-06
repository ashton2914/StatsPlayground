import type { ComponentPropsWithoutRef } from "react";

interface AnalysisStackProps extends Omit<ComponentPropsWithoutRef<"div">, "className" | "style"> {
  direction?: "horizontal" | "vertical";
}

export function AnalysisStack({ direction = "vertical", ...divProps }: AnalysisStackProps) {
  return <div className={`analysis-ui-stack analysis-ui-stack-${direction}`} {...divProps} />;
}
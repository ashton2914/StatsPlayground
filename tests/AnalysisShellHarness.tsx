import { useState } from "react";

import { AnalysisShell } from "../src/components/analysis/presentation";

export function AnalysisShellHarness({ disabled = false }: { disabled?: boolean }) {
  const [editCount, setEditCount] = useState(0);
  return (
    <AnalysisShell
      title="DIM1 Analysis"
      sourceName="DIM1 Sample"
      summary={[
        { key: "analysis", label: "Analysis", value: "Distribution" },
        { key: "response", label: "Response", value: "DIM1" },
        { key: "fit", label: "Fit", value: "normal" },
      ]}
      canEditInputs={!disabled}
      onEditInputs={() => setEditCount((count) => count + 1)}
    >
      <div data-testid="analysis-results">Results</div>
      <output data-testid="edit-count">{editCount}</output>
    </AnalysisShell>
  );
}
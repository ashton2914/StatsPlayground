import { useLayoutEffect, useRef, useState } from "react";

import { AnalysisShell } from "../src/components/analysis/presentation";

interface AnalysisShellHarnessProps {
  disabled?: boolean;
  containerWidth?: number;
}

export function AnalysisShellHarness({
  disabled = false,
  containerWidth = 960,
}: AnalysisShellHarnessProps) {
  const [editCount, setEditCount] = useState(0);
  const resultsRef = useRef<HTMLElement | null>(null);
  const [resultsRefReady, setResultsRefReady] = useState("pending");

  useLayoutEffect(() => {
    setResultsRefReady(resultsRef.current?.className ?? "missing");
  }, []);

  return (
    <div data-testid="analysis-shell-harness" style={{ width: containerWidth, height: 520 }}>
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
        resultsRef={resultsRef}
      >
        <div data-testid="analysis-results" style={{ minHeight: "760px" }}>
          Results
        </div>
        <output data-testid="edit-count">{editCount}</output>
        <output data-testid="results-ref-ready">{resultsRefReady}</output>
      </AnalysisShell>
    </div>
  );
}
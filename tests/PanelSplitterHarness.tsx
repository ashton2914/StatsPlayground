import { useState } from "react";

import { PanelSplitter, type PanelSplitterOrientation } from "../src/components/layout/PanelSplitter.tsx";

interface PanelSplitterHarnessProps {
  orientation: PanelSplitterOrientation;
  direction?: 1 | -1;
  min: number;
  max: number;
  defaultValue: number;
  unit: "px" | "%";
  label: string;
}

export function PanelSplitterHarness({
  orientation,
  direction,
  min,
  max,
  defaultValue,
  unit,
  label,
}: PanelSplitterHarnessProps) {
  const [value, setValue] = useState(defaultValue);
  const [commits, setCommits] = useState<number[]>([]);

  return (
    <>
      <PanelSplitter
        orientation={orientation}
        value={value}
        min={min}
        max={max}
        defaultValue={defaultValue}
        unit={unit}
        direction={direction}
        label={label}
        onChange={setValue}
        onCommit={(nextValue) => setCommits((current) => [...current, nextValue])}
        onReset={() => setValue(defaultValue)}
      />
      <output data-testid="panel-value">{value}</output>
      <output data-testid="panel-commits">{commits.join(",")}</output>
    </>
  );
}
import { useState } from "react";

import {
  GraphDropSlot,
  GraphFieldPalette,
  GraphPlaceholderButton,
} from "../src/components/graphBuilder/shared/GraphBuilderChrome";

const ITEMS = [
  {
    columnId: "first-id",
    name: "Voltage",
    sqlType: "DOUBLE",
    typeLabel: "Decimal",
  },
  {
    columnId: "second-id",
    name: "Voltage",
    sqlType: "DOUBLE",
    typeLabel: "Decimal",
  },
];

export function GraphBuilderSharedHarness() {
  const [lastDrop, setLastDrop] = useState("");
  const [clearCount, setClearCount] = useState(0);
  const [disabledDropCount, setDisabledDropCount] = useState(0);

  return (
    <div>
      <GraphFieldPalette items={ITEMS} disabled={false} />
      <GraphDropSlot
        slot="x"
        label="X"
        binding={{ columnId: "first-id", label: "Voltage" }}
        onDropFields={(fields) => setLastDrop(fields.map(({ columnId }) => columnId).join(","))}
        onClear={() => setClearCount((count) => count + 1)}
      />
      <GraphDropSlot
        slot="y"
        label="Y"
        disabled
        onDropFields={() => setDisabledDropCount((count) => count + 1)}
        onClear={() => setDisabledDropCount((count) => count + 1)}
      />
      <GraphPlaceholderButton
        label="Start Over"
        unavailableTitle="Not yet available in New Graph Builder"
      />
      <output data-testid="last-drop">{lastDrop}</output>
      <output data-testid="clear-count">{clearCount}</output>
      <output data-testid="disabled-drop-count">{disabledDropCount}</output>
    </div>
  );
}

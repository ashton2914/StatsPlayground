import { useMemo, useState, type ComponentProps } from "react";

import i18n from "../src/i18n";
import { ManageExtrasDialog } from "../src/components/ManageExtrasDialog";

type HarnessProps = Pick<
  ComponentProps<typeof ManageExtrasDialog>,
  "initialSelectedColIndices" | "initialExtraKinds"
>;

const cols = ["Column A", "Column B", "Column C"];

const colExtras = [
  { unit: { value: "mm" } },
  null,
  { spec: { lsl: 1, target: 2, usl: 3 } },
];

export function ManageExtrasDialogHarness({
  initialSelectedColIndices,
  initialExtraKinds,
}: HarnessProps) {
  const [shellTick, setShellTick] = useState(0);
  const [dialogKey, setDialogKey] = useState(0);

  const dialogProps = useMemo(() => ({
    cols,
    colExtras,
    onApply: () => {},
    onClose: () => {},
    initialSelectedColIndices,
    initialExtraKinds,
  }), [initialExtraKinds, initialSelectedColIndices]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, position: "fixed", top: 8, left: 8, zIndex: 10000 }}>
        <button className="sp-dialog-btn" onClick={() => setShellTick((value) => value + 1)}>
          Rerender shell
        </button>
        <button className="sp-dialog-btn" onClick={() => setDialogKey((value) => value + 1)}>
          Remount dialog
        </button>
        <span data-shell-tick={shellTick} />
      </div>
      <div style={{ paddingTop: 56 }}>
        <ManageExtrasDialog key={dialogKey} {...dialogProps} />
      </div>
    </div>
  );
}
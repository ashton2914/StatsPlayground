import { useRef, useState } from "react";

import { WorkspaceFrame } from "../src/components/layout/WorkspaceFrame.tsx";

interface WorkspaceFrameHarnessProps {
  containerWidth?: number;
  captureInitialSideWidth?: boolean;
}

export function WorkspaceFrameHarness({
  containerWidth = 900,
  captureInitialSideWidth = false,
}: WorkspaceFrameHarnessProps) {
  const [initialSideWidth, setInitialSideWidth] = useState<number | null>(null);
  const [initialSeparatorValueNow, setInitialSeparatorValueNow] = useState<string | null>(null);
  const recordedInitialSideWidthRef = useRef(false);

  return (
    <div
      data-testid="workspace-frame-harness"
      style={{ width: containerWidth, height: 480 }}
      ref={(node) => {
        if (!node || !captureInitialSideWidth || recordedInitialSideWidthRef.current) {
          return;
        }

        const sideSlot = node.querySelector<HTMLElement>('[data-testid="side-slot"]');
        if (!sideSlot) {
          return;
        }

        recordedInitialSideWidthRef.current = true;
        setInitialSideWidth(sideSlot.getBoundingClientRect().width);
        const separatorValue = node
          .querySelector('[role="separator"]')
          ?.getAttribute("aria-valuenow");
        setInitialSeparatorValueNow(separatorValue ?? "");
      }}
    >
      <WorkspaceFrame
        activityBar={(
          <div className="activity-bar" data-testid="activity-slot">
            <div style={{ width: "100%", height: "100%" }} />
          </div>
        )}
        sidePanel={(
          <div
            className="side-panel"
            data-testid="side-slot"
          >
            <div style={{ width: "100%", height: "100%" }} />
          </div>
        )}
      >
        <div className="main-area" data-testid="main-slot">
          <div style={{ width: "100%", height: "100%" }} />
        </div>
      </WorkspaceFrame>
      {captureInitialSideWidth ? (
        <>
          <output data-testid="first-side-width">{initialSideWidth ?? ""}</output>
          <output data-testid="first-separator-valuenow">{initialSeparatorValueNow ?? ""}</output>
        </>
      ) : null}
    </div>
  );
}
import { lazy, Suspense, useState } from "react";

import type { UpdateCheckStatus } from "../src/stores/updateStoreCore";

const HelpDialog = lazy(async () => {
  Object.assign(globalThis, { __APP_VERSION__: "0.1.0" });
  const module = await import("../src/components/HelpDialog");
  return { default: module.HelpDialog };
});

export function HelpUpdateHarness() {
  const [status, setStatus] = useState<UpdateCheckStatus>("idle");

  return (
    <Suspense fallback={<div>Loading</div>}>
      <HelpDialog
        version="0.1.0"
        updateStatus={status}
        onCheckForUpdates={async () => {
          setStatus("checking");
        }}
        onClose={() => undefined}
      />
      <button
        type="button"
        style={{ position: "fixed", zIndex: 10000, right: 0, bottom: 0 }}
        onClick={() => setStatus("upToDate")}
      >
        Complete check
      </button>
    </Suspense>
  );
}
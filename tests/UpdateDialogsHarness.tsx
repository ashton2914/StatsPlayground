import { useState } from "react";

import type { ReleaseUpdate } from "../src/services/updateCheckCore";
import type { UpdateCheckStatus } from "../src/stores/updateStoreCore";
import { UpdateDialogs } from "../src/components/UpdateDialogs";

const update: ReleaseUpdate = {
  version: "0.2.0",
  releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
  downloadUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0",
  directDownload: false,
};

export function UpdateDialogsHarness() {
  const [status, setStatus] = useState<UpdateCheckStatus>("idle");
  const [availableUpdate, setAvailableUpdate] = useState<ReleaseUpdate | null>(null);

  return (
    <UpdateDialogs
      helpOpen
      currentVersion="0.1.0"
      status={status}
      update={availableUpdate}
      onCheck={async () => {
        setAvailableUpdate(update);
        setStatus("updateAvailable");
      }}
      onCloseHelp={() => undefined}
      onIgnore={() => {
        setAvailableUpdate(null);
        setStatus("idle");
      }}
      onDownload={() => undefined}
    />
  );
}

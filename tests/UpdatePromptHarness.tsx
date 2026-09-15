import { useState } from "react";

import { UpdatePrompt } from "../src/components/UpdatePrompt";

interface Props {
  currentVersion?: string;
}

export function UpdatePromptHarness({ currentVersion = "v0.1.0" }: Props) {
  const [action, setAction] = useState("none");

  return (
    <>
      <UpdatePrompt
        currentVersion={currentVersion}
        update={{
          version: "0.2.0-preview.1",
          releaseUrl: "https://github.com/ashton2914/StatsPlayground/releases/tag/v0.2.0-preview.1",
          downloadUrl: "https://example.test/StatsPlayground-0.2.0-preview.1-macos-arm64.zip",
          directDownload: true,
        }}
        onIgnore={() => setAction("ignored")}
        onDownload={() => setAction("downloaded")}
      />
      <output data-testid="update-action">{action}</output>
    </>
  );
}
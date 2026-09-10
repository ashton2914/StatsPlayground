import type { ReleaseUpdate } from "@/services/updateCheckCore";
import type { UpdateCheckStatus } from "@/stores/updateStoreCore";

import { HelpDialog } from "./HelpDialog";
import { UpdatePrompt } from "./UpdatePrompt";

interface Props {
  helpOpen: boolean;
  currentVersion: string;
  status: UpdateCheckStatus;
  update: ReleaseUpdate | null;
  onCheck: () => Promise<void>;
  onCloseHelp: () => void;
  onIgnore: () => void;
  onDownload: () => void;
}

export function UpdateDialogs({
  helpOpen,
  currentVersion,
  status,
  update,
  onCheck,
  onCloseHelp,
  onIgnore,
  onDownload,
}: Props) {
  if (status === "updateAvailable" && update) {
    return (
      <UpdatePrompt
        currentVersion={currentVersion}
        update={update}
        onIgnore={onIgnore}
        onDownload={onDownload}
      />
    );
  }

  if (!helpOpen) return null;

  return (
    <HelpDialog
      version={currentVersion}
      updateStatus={status}
      onCheckForUpdates={onCheck}
      onClose={onCloseHelp}
    />
  );
}

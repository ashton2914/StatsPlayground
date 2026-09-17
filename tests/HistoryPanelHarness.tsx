import { useEffect, useRef, useState, type MutableRefObject } from "react";

import i18n from "../src/i18n";
import { HistoryPanel, type SnapshotMenuData } from "../src/components/HistoryPanel";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useLocaleStore } from "../src/stores/useLocaleStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { HistoryEntry, NamedSnapshot } from "../src/types/history";

const FIXTURE_HISTORY: HistoryEntry[] = [
  {
    id: "history-current",
    timestamp: "2026-09-15T00:01:00.000Z",
    description: "Edited dataset rows",
    afterState: { marker: "current" },
  },
  {
    id: "history-older",
    timestamp: "2026-09-15T00:00:00.000Z",
    description: "Imported source dataset",
    afterState: { marker: "older" },
  },
  {
    id: "history-init",
    timestamp: "2026-09-14T23:59:00.000Z",
    description: "__init__",
  },
];

const FIXTURE_SNAPSHOTS: NamedSnapshot[] = [
  {
    id: "snapshot-1",
    name: "Snapshot 20260915_000100",
    timestamp: "2026-09-15T00:01:00.000Z",
    snapshot: { kind: "fixture-1" },
  },
  {
    id: "snapshot-2",
    name: "Snapshot 20260915_000000",
    timestamp: "2026-09-15T00:00:00.000Z",
    snapshot: { kind: "fixture-2" },
  },
];

export function HistoryPanelHarness() {
  const snapRenameRef = useRef<((id: string) => void) | null>(null) as MutableRefObject<((id: string) => void) | null>;
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [lastMenu, setLastMenu] = useState<SnapshotMenuData | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousHistoryState = useHistoryStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousLocaleState = useLocaleStore.getState();
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    let active = true;

    useHistoryStore.setState({
      history: FIXTURE_HISTORY,
      snapshots: FIXTURE_SNAPSHOTS,
      currentIdx: 0,
      pendingRestore: null,
      pendingAction: null,
      historyError: null,
    });
    useProjectStore.setState({ ...previousProjectState, readOnly: false, dirty: true, saving: false, saveError: null });
    useLocaleStore.setState({ ...previousLocaleState, locale: "en" });

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      useHistoryStore.setState(previousHistoryState, true);
      useProjectStore.setState(previousProjectState, true);
      useLocaleStore.setState(previousLocaleState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, []);

  if (!ready) return null;

  return (
    <div style={{ width: 420, height: 520 }}>
      <HistoryPanel
        setBusyMessage={setBusyMessage}
        onSnapshotMenu={(menu) => setLastMenu(menu)}
        snapRenameRef={snapRenameRef}
      />
      <output data-testid="busy-message">{busyMessage ?? ""}</output>
      <output data-testid="menu-id">{lastMenu?.id ?? ""}</output>
      <output data-testid="menu-x">{lastMenu?.x ?? ""}</output>
      <output data-testid="menu-y">{lastMenu?.y ?? ""}</output>
    </div>
  );
}

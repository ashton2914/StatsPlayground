import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DistributionDocV1 } from "@/types/distribution";

interface DistributionDirectoryItemProps {
  item: DistributionDocV1;
  sourceName: string;
  selected: boolean;
  paddingLeft?: number;
  onSelect: (analysisId: string) => void;
  onRename: (analysisId: string, name: string) => void;
  onCopy: (analysisId: string) => void;
  onDelete: (analysisId: string) => void;
  onOpenSource: (analysisId: string) => void;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
}

export function DistributionDirectoryItem({
  item,
  sourceName,
  selected,
  paddingLeft,
  onSelect,
  onRename,
  onCopy,
  onDelete,
  onOpenSource,
  onDragStart,
}: DistributionDirectoryItemProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);
  const [menuOpen, setMenuOpen] = useState(false);

  const submitRename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== item.name) onRename(item.analysisId, trimmed);
    else setName(item.name);
    setRenaming(false);
  };

  return (
    <div
      className={`dataset-item ${selected ? "active" : ""}`}
      data-testid={`distribution-directory-${item.analysisId}`}
      style={{ paddingLeft }}
      draggable={!renaming}
      onDragStart={onDragStart}
      onClick={() => onSelect(item.analysisId)}
      onDoubleClick={() => {
        setName(item.name);
        setRenaming(true);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(true);
      }}
    >
      <i className="ds-icon fa-solid fa-chart-column" aria-hidden="true" />
      {renaming ? (
        <input
          className="ds-rename-input"
          aria-label={t("distribution.renameLabel", { name: item.name })}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") {
              setName(item.name);
              setRenaming(false);
            }
          }}
          onClick={(event) => event.stopPropagation()}
          autoFocus
        />
      ) : (
        <span className="ds-name">{item.name}</span>
      )}
      <span className="ds-info gb-source-tag">{sourceName}</span>
      {menuOpen && (
        <div className="sp-ctx-menu distribution-directory-menu" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="sp-ctx-item" data-testid="distribution-open-source" onClick={() => { setMenuOpen(false); onOpenSource(item.analysisId); }}>
            {t("distribution.openSource")}
          </button>
          <button
            type="button"
            className="sp-ctx-item"
            disabled={item.loadStatus === "unknownVersion" || item.loadStatus === "corrupt"}
            onClick={() => { setMenuOpen(false); onCopy(item.analysisId); }}
          >
            {t("common.copy", { defaultValue: "Copy" })}
          </button>
          <button type="button" className="sp-ctx-item sp-ctx-danger" onClick={() => { setMenuOpen(false); onDelete(item.analysisId); }}>
            {t("common.delete")}
          </button>
        </div>
      )}
    </div>
  );
}
import React from "react";

interface NormalizedSelectionRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

interface GridCellPosition {
  row: number;
  col: number;
}

export interface TableViewportRowsProps {
  totalRows: number;
  slotCount: number;
  logicalStart: number;
  loadedWindowStart: number;
  loadedRows: unknown[][];
  visibleColIdxs: number[];
  colFormats: unknown[];
  formatCellValue: (value: unknown, format: unknown) => string;
  selectedRows: ReadonlySet<number>;
  activeRowRange: ReadonlySet<number>;
  activeCell: GridCellPosition | null;
  editCell: GridCellPosition | null;
  editValue: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  selectionRange: NormalizedSelectionRange | null;
  selectedCellsByRow: Map<number, Set<number>> | null;
  selectedCols: ReadonlySet<number>;
  visibleColumnStart: number;
  visibleColumnEnd: number;
  leftSpacerW: number;
  rightSpacerW: number;
  renderEmptyPlaceholder?: boolean;
  onEditValueChange: (value: string) => void;
  onCommitEdit: (direction: "none" | "down" | "right" | "left") => void;
  onCancelEdit: () => void;
}

export function TableViewportRows({
  totalRows,
  slotCount,
  logicalStart,
  loadedWindowStart,
  loadedRows,
  visibleColIdxs,
  colFormats,
  formatCellValue,
  selectedRows,
  activeRowRange,
  activeCell,
  editCell,
  editValue,
  editInputRef,
  selectionRange,
  selectedCellsByRow,
  selectedCols,
  visibleColumnStart,
  visibleColumnEnd,
  leftSpacerW,
  rightSpacerW,
  renderEmptyPlaceholder = true,
  onEditValueChange,
  onCommitEdit,
  onCancelEdit,
}: TableViewportRowsProps) {
  const actualSlotCount = Math.min(slotCount, Math.max(0, totalRows - logicalStart));

  return (
    <>
      {Array.from({ length: actualSlotCount }, (_, slotIndex) => {
        const logicalRow = logicalStart + slotIndex;
        const localIndex = logicalRow - loadedWindowStart;
        const displayRow = localIndex >= 0 && localIndex < loadedRows.length
          ? loadedRows[localIndex]
          : undefined;
        const isPlaceholder = !displayRow;
        const isRowSelected = !isPlaceholder && selectedRows.has(logicalRow);
        const isRowActive = !isPlaceholder && activeRowRange.has(logicalRow);
        const activeCol = activeCell?.row === logicalRow ? activeCell.col : -1;
        const editingCol = editCell?.row === logicalRow ? editCell.col : -1;
        const selStartCol = selectionRange && logicalRow >= selectionRange.r1 && logicalRow <= selectionRange.r2
          ? selectionRange.c1
          : -1;
        const selEndCol = selectionRange && logicalRow >= selectionRange.r1 && logicalRow <= selectionRange.r2
          ? selectionRange.c2
          : -1;
        const selectedColsInRow = selectedCellsByRow?.get(logicalRow);

        return (
          <tr
            key={`slot-${slotIndex}`}
            data-viewport-slot={slotIndex}
            className={`sp-data-row${isPlaceholder ? " sp-placeholder-row" : ""}${isRowSelected ? " sp-row-selected" : ""}`}
            aria-hidden={isPlaceholder ? "true" : undefined}
          >
            <td
              className={`sp-row-hdr${isRowActive ? " sp-row-active" : ""}${isRowSelected ? " sp-row-selected-hdr" : ""}`}
              {...(isPlaceholder ? {} : { "data-row-hdr": logicalRow })}
            >
              {logicalRow + 1}
            </td>
            {leftSpacerW > 0 && (
              <td className="sp-col-spacer" style={{ width: leftSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
            )}
            {visibleColIdxs.map((columnIndex) => {
              if (isPlaceholder) {
                return <td key={columnIndex} className="sp-cell sp-placeholder-cell" />;
              }
              const cell = (displayRow as unknown[])[columnIndex];
              const isColSelected = selectedCols.has(columnIndex);
              const isCellActive = activeCol === columnIndex && isRowActive && !isRowSelected && !isColSelected;
              const isCellEditing = editingCol === columnIndex;
              const inRect = selStartCol >= 0 && columnIndex >= selStartCol && columnIndex <= selEndCol;
              const inDiscrete = selectedColsInRow ? selectedColsInRow.has(columnIndex) : false;
              const isCellSelected = inRect || inDiscrete;
              return (
                <td
                  key={columnIndex}
                  data-row={logicalRow}
                  data-col={columnIndex}
                  className={`sp-cell${isCellActive ? " sp-cell-active" : ""}${isCellEditing ? " sp-cell-editing" : ""}${isCellSelected ? " sp-cell-selected" : ""}${isColSelected ? " sp-col-selected-cell" : ""}`}
                >
                  <span className={cell == null ? "sp-null" : "sp-val"} style={isCellEditing ? { visibility: "hidden" } : undefined}>
                    {formatCellValue(cell, colFormats[columnIndex])}
                  </span>
                  {isCellEditing && (
                    <input
                      ref={editInputRef}
                      className="sp-cell-input"
                      value={editValue}
                      onChange={(event) => onEditValueChange(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onBlur={() => onCommitEdit("none")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onCommitEdit("down");
                        } else if (event.key === "Escape") {
                          onCancelEdit();
                        } else if (event.key === "Tab") {
                          event.preventDefault();
                          onCommitEdit(event.shiftKey ? "left" : "right");
                        }
                        event.stopPropagation();
                      }}
                    />
                  )}
                </td>
              );
            })}
            {rightSpacerW > 0 && (
              <td className="sp-col-spacer" style={{ width: rightSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
            )}
            <td className="sp-add-col-cell" />
          </tr>
        );
      })}
      {renderEmptyPlaceholder && actualSlotCount === 0 && totalRows === 0 && (
        <tr data-viewport-slot={0} className="sp-placeholder-row" aria-hidden="true">
          <td className="sp-row-hdr">1</td>
          {leftSpacerW > 0 && (
            <td className="sp-col-spacer" style={{ width: leftSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
          )}
          {Array.from({ length: Math.max(0, visibleColumnEnd - visibleColumnStart) }).map((_, index) => (
            <td key={index} className="sp-cell sp-placeholder-cell" />
          ))}
          {rightSpacerW > 0 && (
            <td className="sp-col-spacer" style={{ width: rightSpacerW, padding: 0, border: "none" }} aria-hidden="true" />
          )}
          <td className="sp-add-col-cell" />
        </tr>
      )}
    </>
  );
}
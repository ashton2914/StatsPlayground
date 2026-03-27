import { useEffect, useState, useRef } from "react";
import { dataService } from "@/services/dataService";
import type { TableQueryResult } from "@/types/data";

interface DataTableViewProps {
  datasetId: string;
}

export function DataTableView({ datasetId }: DataTableViewProps) {
  const [data, setData] = useState<TableQueryResult | null>(null);
  const [editCell, setEditCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const result = await dataService.queryTable({
        datasetId,
        page: 0,
        pageSize: 1000,
      });
      setData(result);
    } catch (e) {
      console.error("Failed to load table:", e);
      setData({ columns: [], columnTypes: [], rows: [], totalRows: 0, page: 0, pageSize: 1000 });
    }
  };

  useEffect(() => {
    load();
  }, [datasetId]);

  useEffect(() => {
    if (editCell && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editCell]);

  if (!data) return <div className="table-loading">加载中...</div>;

  // Filter out _row_id from display but keep it for operations
  const rowIdColIdx = data.columns.indexOf("_row_id");
  const displayCols = data.columns.filter((_, i) => i !== rowIdColIdx);
  const displayColTypes = data.columnTypes.filter((_, i) => i !== rowIdColIdx);

  const getRowId = (row: unknown[]): number => {
    return rowIdColIdx >= 0 ? (row[rowIdColIdx] as number) : 0;
  };

  const handleAddRow = async () => {
    await dataService.addRow(datasetId);
    await load();
  };

  const handleDeleteRow = async (row: unknown[]) => {
    const rowId = getRowId(row);
    await dataService.deleteRow(datasetId, rowId);
    await load();
  };

  const startEdit = (rowIdx: number, colIdx: number, currentValue: unknown) => {
    setEditCell({ rowIdx, colIdx });
    setEditValue(currentValue == null ? "" : String(currentValue));
  };

  const commitEdit = async (row: unknown[]) => {
    if (!editCell) return;
    const rowId = getRowId(row);
    const colName = displayCols[editCell.colIdx];
    await dataService.updateCell(datasetId, rowId, colName, editValue);
    setEditCell(null);
    await load();
  };

  const cancelEdit = () => {
    setEditCell(null);
  };

  return (
    <div className="data-table-container">
      <div className="table-toolbar">
        <button className="btn-sm" onClick={handleAddRow}>+ 添加行</button>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="row-num-col">#</th>
              {displayCols.map((col, i) => (
                <th key={i}>
                  <span className="col-name">{col}</span>
                  <span className="col-type">{displayColTypes[i]}</span>
                </th>
              ))}
              <th className="action-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={displayCols.length + 2} className="empty-table">
                  空表 — 点击"添加行"开始输入数据
                </td>
              </tr>
            ) : (
              data.rows.map((row, rowIdx) => {
                // Build display row (without _row_id)
                const displayRow = (row as unknown[]).filter((_, i) => i !== rowIdColIdx);
                return (
                  <tr key={rowIdx}>
                    <td className="row-num-col">{rowIdx + 1}</td>
                    {displayRow.map((cell, colIdx) => (
                      <td
                        key={colIdx}
                        className="editable-cell"
                        onDoubleClick={() => startEdit(rowIdx, colIdx, cell)}
                      >
                        {editCell?.rowIdx === rowIdx && editCell?.colIdx === colIdx ? (
                          <input
                            ref={inputRef}
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(row as unknown[])}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit(row as unknown[]);
                              if (e.key === "Escape") cancelEdit();
                            }}
                          />
                        ) : (
                          <span className={cell == null ? "null-value" : ""}>
                            {cell == null ? "NULL" : String(cell)}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="action-col">
                      <button className="btn-icon-sm" onClick={() => handleDeleteRow(row as unknown[])} title="删除行">
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        共 {data.totalRows} 行 · {displayCols.length} 列
      </div>
    </div>
  );
}

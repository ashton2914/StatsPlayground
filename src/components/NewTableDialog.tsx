import { useState } from "react";

interface NewTableDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, columns: { name: string; type: string }[]) => void;
}

const COLUMN_TYPES = ["VARCHAR", "INTEGER", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"];

export function NewTableDialog({ open, onClose, onCreate }: NewTableDialogProps) {
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState([{ name: "", type: "VARCHAR" }]);

  if (!open) return null;

  const addColumn = () => {
    setColumns([...columns, { name: "", type: "VARCHAR" }]);
  };

  const removeColumn = (index: number) => {
    if (columns.length <= 1) return;
    setColumns(columns.filter((_, i) => i !== index));
  };

  const updateColumn = (index: number, field: "name" | "type", value: string) => {
    const updated = [...columns];
    updated[index] = { ...updated[index], [field]: value };
    setColumns(updated);
  };

  const handleSubmit = () => {
    const validName = tableName.trim();
    const validCols = columns.filter((c) => c.name.trim());
    if (!validName || validCols.length === 0) return;
    onCreate(
      validName,
      validCols.map((c) => ({ name: c.name.trim(), type: c.type }))
    );
    // Reset
    setTableName("");
    setColumns([{ name: "", type: "VARCHAR" }]);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建数据表</h3>
        <div className="dialog-field">
          <label>表名</label>
          <input
            type="text"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder="例如：实验数据"
            autoFocus
          />
        </div>

        <div className="dialog-field">
          <label>列定义</label>
          <div className="column-list">
            {columns.map((col, i) => (
              <div key={i} className="column-row">
                <input
                  type="text"
                  value={col.name}
                  onChange={(e) => updateColumn(i, "name", e.target.value)}
                  placeholder="列名"
                />
                <select value={col.type} onChange={(e) => updateColumn(i, "type", e.target.value)}>
                  {COLUMN_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button className="btn-icon" onClick={() => removeColumn(i)} title="删除列">×</button>
              </div>
            ))}
          </div>
          <button className="btn-text" onClick={addColumn}>+ 添加列</button>
        </div>

        <div className="dialog-actions">
          <button className="btn-primary" onClick={handleSubmit} disabled={!tableName.trim()}>
            创建
          </button>
          <button className="btn-text" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

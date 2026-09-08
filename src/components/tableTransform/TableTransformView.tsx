import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DatasetMeta } from "@/types/data";
import type {
  TableTransformBindingState,
  TableTransformDefinition,
  TableTransformOperation,
} from "@/types/tableTransform";

interface TableTransformViewProps {
  definition: TableTransformDefinition;
  binding: TableTransformBindingState;
  datasets: DatasetMeta[];
  readOnly?: boolean;
  onRebind: (role: string, tableDocumentId: string) => Promise<void>;
  onRerun: () => Promise<void>;
  onOpenOutput: (tableDocumentId: string) => void;
}

function operationSummary(operation: TableTransformOperation): string {
  switch (operation.kind) {
    case "sort":
      return `Sort: ${operation.sortColumns.map(({ column, direction }) => `${column} (${direction})`).join(", ")}`;
    case "subset":
      return `Subset: ${operation.columns.join(", ")}`;
    case "transpose":
      return "Transpose";
    case "stack":
      return `Stack: ${operation.stackColumns.join(", ")}`;
    case "split":
      return `Split: ${operation.splitColumn} → ${operation.valueColumn}`;
    case "summary":
      return `Summary: ${operation.statistics.join(", ")} for ${operation.statisticColumns.join(", ")}`;
    case "join":
      return `${operation.joinType} join: ${operation.leftKey} = ${operation.rightKey}`;
    case "update":
      return `Update: ${operation.updateColumns.join(", ")} by ${operation.matchColumn}`;
    case "concatenate":
      return `Concatenate: ${operation.sourceCount} sources`;
  }
}

export function TableTransformView({
  definition,
  binding,
  datasets,
  readOnly = false,
  onRebind,
  onRerun,
  onOpenOutput,
}: TableTransformViewProps) {
  const { t } = useTranslation();
  const boundInputs = useMemo(
    () => Object.fromEntries(binding.inputs.map(({ role, tableDocumentId }) => [role, tableDocumentId])),
    [binding.inputs],
  );
  const [inputs, setInputs] = useState<Record<string, string>>(boundInputs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInputs(boundInputs);
    setError(null);
  }, [boundInputs, definition.id]);

  const changedBindings = definition.inputSlots.filter(
    ({ role }) => inputs[role] && inputs[role] !== boundInputs[role],
  );
  const output = datasets.find(({ id }) => id === definition.output.tableDocumentId);
  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="table-transform-view">
      <header className="table-transform-header">
        <div>
          <span>{t("tableTransform.definition", { defaultValue: "Table transform" })}</span>
          <h2>{definition.name}</h2>
          <p>{operationSummary(definition.operation)}</p>
        </div>
        <div className={`table-transform-status status-${binding.lastRun?.status ?? "idle"}`}>
          {binding.lastRun?.status ?? t("tableTransform.notRun", { defaultValue: "Not run" })}
        </div>
      </header>

      <section className="table-transform-inputs" aria-label={t("tableTransform.inputs", { defaultValue: "Input bindings" })}>
        <div className="table-transform-section-heading">
          <h3>{t("tableTransform.inputs", { defaultValue: "Input bindings" })}</h3>
          <button
            className="sp-dialog-btn sp-dialog-btn-primary"
            disabled={readOnly || busy || changedBindings.length === 0}
            onClick={() => void runAction(async () => {
              for (const { role } of changedBindings) await onRebind(role, inputs[role]);
            })}
          >{t("tableTransform.applyBindings", { defaultValue: "Apply bindings" })}</button>
        </div>
        <div className="table-transform-binding-grid">
          {definition.inputSlots.map(({ role }) => {
            const schemaReport = binding.schemaReports?.find((item) => item.role === role)?.report;
            return (
              <div className="table-transform-binding" key={role}>
                <label htmlFor={`table-transform-${role}`}>{role}</label>
                <select
                  id={`table-transform-${role}`}
                  value={inputs[role] ?? ""}
                  disabled={readOnly || busy}
                  onChange={(event) => setInputs((current) => ({ ...current, [role]: event.target.value }))}
                >
                  <option value="">{t("tableTransform.chooseTable", { defaultValue: "Choose input table" })}</option>
                  {datasets
                    .filter(({ id }) => id !== definition.output.tableDocumentId)
                    .map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
                </select>
                {schemaReport && (schemaReport.missingColumns.length > 0 || schemaReport.typeMismatches.length > 0) && (
                  <div className="table-transform-schema-errors" role="alert">
                    {schemaReport.missingColumns.map(({ columnName }) => (
                      <span key={`missing-${columnName}`}>{t("tableTransform.missingColumn", { defaultValue: "Missing column: {{column}}", column: columnName })}</span>
                    ))}
                    {schemaReport.typeMismatches.map(({ columnName, expectedType, actualType }) => (
                      <span key={`mismatch-${columnName}`}>{t("tableTransform.typeMismatch", {
                        defaultValue: "{{column}} requires {{expected}}, found {{actual}}",
                        column: columnName,
                        expected: expectedType,
                        actual: actualType,
                      })}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="table-transform-output" aria-label={t("tableTransform.output", { defaultValue: "Stable output" })}>
        <div>
          <span>{t("tableTransform.output", { defaultValue: "Stable output" })}</span>
          <strong>{output?.name ?? definition.output.name}</strong>
          <small>{t("tableTransform.outputGeneration", { defaultValue: "Generation {{generation}}", generation: binding.outputGeneration })}</small>
        </div>
        <button
          className="sp-dialog-btn"
          disabled={!output}
          aria-label={`Open ${output?.name ?? definition.output.name}`}
          onClick={() => onOpenOutput(definition.output.tableDocumentId)}
        ><i className="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" /> {t("tableTransform.openOutput", { defaultValue: "Open output" })}</button>
      </section>

      <footer className="table-transform-actions">
        {error && <div className="sp-dialog-error" role="alert">{error}</div>}
        <button
          className="sp-dialog-btn sp-dialog-btn-primary"
          disabled={readOnly || busy}
          onClick={() => void runAction(onRerun)}
        ><i className="fa-solid fa-rotate-right" aria-hidden="true" /> {t("tableTransform.rerun", { defaultValue: "Rerun" })}</button>
      </footer>
    </div>
  );
}
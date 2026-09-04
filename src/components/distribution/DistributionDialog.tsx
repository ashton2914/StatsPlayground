import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DistributionItem } from "@/types/distribution";

import {
  createDistributionItem,
  type DistributionFieldInfo,
  type DistributionRole,
} from "./distributionConfig";
import {
  assignDistributionField,
  canCreateDistribution,
  clearDistributionField,
  createDistributionDialogState,
  filterDistributionFields,
  type DistributionDialogState,
} from "./distributionDialogState";
import { DistributionRoleZone } from "./DistributionRoleZone";
import { SpecificationLimitsEditor } from "./SpecificationLimitsEditor";

interface DistributionDialogProps {
  open: boolean;
  datasetId: string;
  columns: DistributionFieldInfo[];
  defaultName: string;
  initialItem?: DistributionItem;
  onSubmit: (item: DistributionItem) => void | Promise<void>;
  onCancel: () => void;
}

function stateFromItem(item: DistributionItem): DistributionDialogState {
  return {
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    responses: structuredClone(item.responses),
    weight: structuredClone(item.weight),
    frequency: structuredClone(item.frequency),
    by: structuredClone(item.by),
    analysis: structuredClone(item.analysis),
    validationError: null,
  };
}

export function DistributionDialog({
  open,
  datasetId,
  columns,
  defaultName,
  initialItem,
  onSubmit,
  onCancel,
}: DistributionDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<DistributionDialogState>(() =>
    initialItem ? stateFromItem(initialItem) : createDistributionDialogState(defaultName, datasetId),
  );
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setState(initialItem
      ? stateFromItem(initialItem)
      : createDistributionDialogState(defaultName, datasetId));
    setSearch("");
  }, [datasetId, defaultName, initialItem, open]);

  if (!open) return null;

  const fieldByName = new Map(columns.map((column) => [column.field.name, column]));
  const filteredColumns = filterDistributionFields(columns, search);
  const valid = canCreateDistribution(state, columns);

  const assign = (role: DistributionRole, fieldName: string) => {
    const field = fieldByName.get(fieldName);
    if (!field) return;
    setState((current) => assignDistributionField(current, role, field));
  };

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const item = createDistributionItem({
        id: initialItem?.id ?? globalThis.crypto.randomUUID(),
        name: state.name.trim(),
        sourceDatasetId: state.sourceDatasetId,
        responses: state.responses,
        weight: state.weight,
        frequency: state.frequency,
        by: state.by,
        columns,
        analysis: state.analysis,
        createdAt: initialItem?.createdAt ?? new Date().toISOString(),
      });
      await onSubmit(item);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div
        className="dialog distribution-dialog"
        role="dialog"
        aria-label={t("distribution.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="distribution-dialog-header">
          <h3>{t("distribution.title")}</h3>
          <input
            aria-label={t("common.name", { defaultValue: "Name" })}
            value={state.name}
            onChange={(event) => setState((current) => ({ ...current, name: event.target.value }))}
          />
        </header>

        <div className="distribution-dialog-scroll">
          <div className="distribution-dialog-body">
            <aside className="distribution-column-browser">
              <label htmlFor="distribution-column-search">{t("distribution.searchColumns")}</label>
              <input
                id="distribution-column-search"
                data-testid="distribution-column-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="distribution-column-list">
                {filteredColumns.map((column) => (
                  <div
                    className="distribution-column-row"
                    data-testid={`distribution-column-${column.field.name}`}
                    draggable
                    key={column.field.name}
                    title={`${column.name} (${column.sqlType})`}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-statsplayground-distribution",
                        column.field.name,
                      );
                      event.dataTransfer.setData("text/plain", column.field.name);
                    }}
                  >
                    <span>{column.name}</span>
                    <div className="distribution-column-actions">
                      <button type="button" disabled={column.field.type !== "continuous"} onClick={() => assign("response", column.field.name)}>Y</button>
                      <button type="button" disabled={column.field.type !== "continuous"} onClick={() => assign("weight", column.field.name)}>{t("distribution.roles.weight")}</button>
                      <button type="button" disabled={!column.integerCompatible} onClick={() => assign("frequency", column.field.name)}>{t("distribution.frequencyShort")}</button>
                      <button type="button" disabled={column.field.type !== "nominal" && column.field.type !== "ordinal"} onClick={() => assign("by", column.field.name)}>By</button>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            <main className="distribution-role-grid">
              <DistributionRoleZone role="response" fields={state.responses} onAssign={(name) => assign("response", name)} onRemove={(name) => setState((current) => clearDistributionField(current, "response", name))} />
              <DistributionRoleZone role="weight" fields={state.weight ? [state.weight] : []} onAssign={(name) => assign("weight", name)} onRemove={() => setState((current) => clearDistributionField(current, "weight"))} />
              <DistributionRoleZone role="frequency" fields={state.frequency ? [state.frequency] : []} onAssign={(name) => assign("frequency", name)} onRemove={() => setState((current) => clearDistributionField(current, "frequency"))} />
              <DistributionRoleZone role="by" fields={state.by} onAssign={(name) => assign("by", name)} onRemove={(name) => setState((current) => clearDistributionField(current, "by", name))} />
            </main>
          </div>

          <label className="distribution-option">
            <span>{t("distribution.confidenceLevel")}</span>
            <input
              data-testid="distribution-confidence-level"
              type="number"
              min="0.01"
              max="0.99"
              step="0.01"
              value={state.analysis.confidenceLevel}
              onChange={(event) => setState((current) => ({
                ...current,
                analysis: { ...current.analysis, confidenceLevel: Number(event.target.value) },
              }))}
            />
          </label>

          <SpecificationLimitsEditor
            responses={state.responses}
            specLimits={state.analysis.specLimits}
            onChange={(specLimits) => setState((current) => ({
              ...current,
              analysis: { ...current.analysis, specLimits },
            }))}
          />

          {state.validationError && (
            <p className="distribution-run-hint" role="alert">{state.validationError}</p>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn-primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? t("distribution.saving") : t("common.save")}
          </button>
          <button type="button" className="btn-text" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

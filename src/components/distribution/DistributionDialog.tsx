import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DistributionItem } from "@/types/distribution";
import { Button, Field, NumberField, TextField } from "@/components/ui";

import {
  createDistributionItem,
  type DistributionFieldInfo,
  findResponsesMissingCapabilitySpecs,
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

import "./distribution.css";

export interface DistributionManagePropertiesRequest {
  datasetId: string;
  colIndices: number[];
}

interface DistributionDialogProps {
  open: boolean;
  datasetId: string;
  columns: DistributionFieldInfo[];
  defaultName: string;
  initialItem?: DistributionItem;
  onManageProperties: (request: DistributionManagePropertiesRequest) => void;
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
  onManageProperties,
  onSubmit,
  onCancel,
}: DistributionDialogProps) {
  const { t } = useTranslation();
  const dialogShellRef = useRef<HTMLDivElement>(null);
  const warningRef = useRef<HTMLDivElement>(null);
  const warningCancelRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<DistributionDialogState>(() =>
    initialItem ? stateFromItem(initialItem) : createDistributionDialogState(defaultName, datasetId),
  );
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingMissingFields, setPendingMissingFields] = useState<DistributionFieldInfo[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setState(initialItem
      ? stateFromItem(initialItem)
      : createDistributionDialogState(defaultName, datasetId));
    setSearch("");
    setPendingMissingFields(null);
  }, [datasetId, defaultName, initialItem, open]);

  useEffect(() => {
    const shell = dialogShellRef.current;
    if (!shell) return;
    if (pendingMissingFields) {
      shell.setAttribute("inert", "");
      return () => shell.removeAttribute("inert");
    }
    shell.removeAttribute("inert");
  }, [pendingMissingFields]);

  useEffect(() => {
    if (!pendingMissingFields) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    warningCancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusable = Array.from(
          warningRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
        );
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPendingMissingFields(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [pendingMissingFields]);

  if (!open) return null;

  const fieldByName = new Map(columns.map((column) => [column.field.name, column]));
  const filteredColumns = filterDistributionFields(columns, search);
  const valid = canCreateDistribution(state, columns);

  const assign = (role: DistributionRole, fieldName: string) => {
    const field = fieldByName.get(fieldName);
    if (!field) return;
    setState((current) => assignDistributionField(current, role, field));
  };

  const submitConfirmed = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const createdItem = createDistributionItem({
        id: initialItem?.id ?? globalThis.crypto.randomUUID(),
        name: state.name.trim(),
        sourceDatasetId: state.sourceDatasetId,
        responses: state.responses,
        weight: state.weight,
        frequency: state.frequency,
        by: state.by,
        columns,
        analysis: {
          ...state.analysis,
          specLimits: {},
        },
        createdAt: initialItem?.createdAt ?? new Date().toISOString(),
      });
      const item = initialItem
        ? { ...createdItem, graphs: structuredClone(initialItem.graphs) }
        : createdItem;
      await onSubmit(item);
      setPendingMissingFields(null);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    if (!valid || submitting) return;
    const missingFields = findResponsesMissingCapabilitySpecs(state.responses, columns);
    if (missingFields.length > 0) {
      setPendingMissingFields(missingFields);
      return;
    }
    await submitConfirmed();
  };

  const handleManageProperties = () => {
    if (!pendingMissingFields || pendingMissingFields.length === 0) return;
    setPendingMissingFields(null);
    onManageProperties({
      datasetId: state.sourceDatasetId,
      colIndices: pendingMissingFields.map((field) => field.colIndex),
    });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div
        className="dialog distribution-dialog"
        role="dialog"
        aria-label={t("distribution.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          ref={dialogShellRef}
          className="distribution-dialog-shell"
          aria-hidden={pendingMissingFields ? true : undefined}
        >
          <header className="distribution-dialog-header">
            <h3>{t("distribution.title")}</h3>
            <TextField
              className="distribution-name-input"
              aria-label={t("common.name", { defaultValue: "Name" })}
              value={state.name}
              onChange={(event) => setState((current) => ({ ...current, name: event.target.value }))}
            />
          </header>

          <div className="distribution-dialog-scroll">
            <div className="distribution-dialog-body">
              <aside className="distribution-column-browser">
                <Field label={t("distribution.searchColumns")}>
                  <TextField
                    data-testid="distribution-column-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </Field>
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
                        <Button size="small" disabled={column.field.type !== "continuous"} onClick={() => assign("response", column.field.name)}>Y</Button>
                        <Button size="small" disabled={column.field.type !== "continuous"} onClick={() => assign("weight", column.field.name)}>{t("distribution.roles.weight")}</Button>
                        <Button size="small" disabled={!column.integerCompatible} onClick={() => assign("frequency", column.field.name)}>{t("distribution.frequencyShort")}</Button>
                        <Button size="small" disabled={column.field.type !== "nominal" && column.field.type !== "ordinal"} onClick={() => assign("by", column.field.name)}>By</Button>
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

            <NumberField
              fieldClassName="distribution-option"
              label={t("distribution.confidenceLevel")}
              data-testid="distribution-confidence-level"
              min="0.01"
              max="0.99"
              step="0.01"
              value={state.analysis.confidenceLevel}
              onValueChange={(value) => setState((current) => ({
                ...current,
                analysis: { ...current.analysis, confidenceLevel: value ?? 0 },
              }))}
            />

            {state.validationError && (
              <p className="distribution-run-hint" role="alert">{state.validationError}</p>
            )}
          </div>

          <div className="dialog-actions">
            <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
              {submitting ? t("distribution.saving") : t("common.save")}
            </Button>
            <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
          </div>
        </div>

        {pendingMissingFields && (
          <div className="distribution-warning-overlay" role="presentation" onClick={() => setPendingMissingFields(null)}>
            <div
              ref={warningRef}
              className="distribution-missing-specs"
              role="alertdialog"
              aria-labelledby="distribution-missing-specs-title"
              aria-describedby="distribution-missing-specs-message"
              aria-modal="true"
              onClick={(event) => event.stopPropagation()}
            >
              <h4 id="distribution-missing-specs-title">{t("distribution.missingSpecs.title")}</h4>
              <p id="distribution-missing-specs-message">{t("distribution.missingSpecs.message")}</p>
              <ul className="distribution-missing-specs-list">
                {pendingMissingFields.map((field) => (
                  <li key={field.name}>{field.name}</li>
                ))}
              </ul>
              <div className="distribution-missing-specs-actions">
                <Button ref={warningCancelRef} variant="ghost" onClick={() => setPendingMissingFields(null)}>{t("common.cancel")}</Button>
                <Button variant="ghost" onClick={handleManageProperties}>{t("distribution.missingSpecs.manage")}</Button>
                <Button variant="primary" onClick={() => void submitConfirmed()}>{t("distribution.missingSpecs.continue")}</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

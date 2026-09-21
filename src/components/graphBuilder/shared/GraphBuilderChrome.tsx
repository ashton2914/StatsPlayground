import { useState, type DragEvent, type MouseEvent, type ReactNode } from "react";

import {
  decodeGraphBuilderDragFields,
  encodeGraphBuilderDragFields,
  GRAPH_FIELD_DRAG_MIME,
  type GraphBuilderDragField,
} from "./graphBuilderDragPayload";

import "./graphBuilderChrome.css";

export interface GraphFieldPaletteItem extends GraphBuilderDragField {
  typeLabel: string;
  unavailable?: boolean;
}

export interface GraphDropSlotBinding {
  columnId: string;
  label: string;
  unavailable?: boolean;
}

interface GraphFieldPaletteProps {
  items: readonly GraphFieldPaletteItem[];
  disabled: boolean;
  selectedIds?: ReadonlySet<string>;
  ariaLabel?: string;
  getItemAriaLabel?: (item: GraphFieldPaletteItem) => string;
  onItemClick?: (item: GraphFieldPaletteItem, event: MouseEvent<HTMLDivElement>) => void;
  resolveDragFields?: (
    item: GraphFieldPaletteItem,
  ) => readonly GraphBuilderDragField[];
}

export function GraphFieldPalette({
  items,
  disabled,
  selectedIds = new Set(),
  ariaLabel = "Columns",
  getItemAriaLabel = (item) => `Drag ${item.name}`,
  onItemClick,
  resolveDragFields,
}: GraphFieldPaletteProps) {
  return (
    <div
      className="gb-shared-field-palette"
      data-testid="graph-field-palette"
      role="list"
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const itemDisabled = disabled || item.unavailable === true;
        return (
          <div
            key={item.columnId}
            className={`gb-shared-field${selectedIds.has(item.columnId) ? " is-selected" : ""}${item.unavailable ? " is-unavailable" : ""}`}
            data-testid={`graph-field-${item.columnId}`}
            role="button"
            tabIndex={itemDisabled ? -1 : 0}
            aria-label={getItemAriaLabel(item)}
            aria-disabled={itemDisabled}
            draggable={!itemDisabled}
            onClick={(event) => {
              if (!itemDisabled) onItemClick?.(item, event);
            }}
            onDragStart={(event) => {
              if (itemDisabled) {
                event.preventDefault();
                return;
              }
              const fields = resolveDragFields?.(item) ?? [{
                columnId: item.columnId,
                name: item.name,
                sqlType: item.sqlType,
              }];
              const payload = encodeGraphBuilderDragFields(fields);
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(GRAPH_FIELD_DRAG_MIME, payload);
              event.dataTransfer.setData("text/plain", payload);
            }}
          >
            <span className="gb-shared-field-type">{item.typeLabel}</span>
            <span className="gb-shared-field-name">{item.name}</span>
          </div>
        );
      })}
    </div>
  );
}

export type GraphDropSlotOrientation =
  | "horizontal-top"
  | "horizontal-bottom"
  | "vertical-left"
  | "vertical-right"
  | "shelf";

interface GraphDropSlotProps {
  slot: string;
  label: string;
  binding?: GraphDropSlotBinding | null;
  bindings?: readonly GraphDropSlotBinding[];
  disabled?: boolean;
  required?: boolean;
  orientation?: GraphDropSlotOrientation;
  unavailableTitle?: string;
  dropText?: string;
  clearAriaLabel?: string;
  settings?: ReactNode;
  onOpenManager?: () => void;
  onContextMenu?: (x: number, y: number) => void;
  rejectFlash?: boolean;
  onDropFields?: (fields: readonly GraphBuilderDragField[]) => void;
  onRawDrop?: (event: DragEvent<HTMLElement>) => void;
  onClear?: () => void;
}

function readDroppedFields(event: DragEvent<HTMLElement>) {
  const custom = event.dataTransfer.getData(GRAPH_FIELD_DRAG_MIME);
  const plain = event.dataTransfer.getData("text/plain");
  return decodeGraphBuilderDragFields(custom || plain);
}

export function GraphDropSlot({
  slot,
  label,
  binding,
  bindings,
  disabled = false,
  required = false,
  orientation = "horizontal-bottom",
  unavailableTitle,
  dropText = "Drop a column",
  clearAriaLabel = `Clear ${label}`,
  settings,
  onOpenManager,
  onContextMenu,
  rejectFlash = false,
  onDropFields,
  onRawDrop,
  onClear,
}: GraphDropSlotProps) {
  const [over, setOver] = useState(false);
  const visibleBindings = bindings?.length ? bindings : binding ? [binding] : [];
  const filled = visibleBindings.length > 0;
  const multi = visibleBindings.length > 1;
  return (
    <section
      className={`gb-slot gb-slot-${orientation} gb-shared-slot gb-shared-slot-${orientation}${over ? " gb-slot-over" : ""}${filled ? " gb-slot-filled" : ""}${multi ? " gb-slot-multi" : ""}${rejectFlash ? " gb-slot-reject" : ""}${disabled ? " is-disabled" : ""}${visibleBindings.some(({ unavailable }) => unavailable) ? " is-unavailable" : ""}`}
      data-testid={`graph-slot-${slot}`}
      aria-label={`${label} drop slot`}
      aria-disabled={disabled}
      title={disabled ? unavailableTitle : undefined}
      onDragEnter={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (disabled) return;
        if (onRawDrop) {
          event.preventDefault();
          setOver(false);
          onRawDrop(event);
          return;
        }
        const fields = readDroppedFields(event);
        if (!fields || !onDropFields) return;
        event.preventDefault();
        setOver(false);
        onDropFields(fields);
      }}
      onClick={filled && onOpenManager ? onOpenManager : undefined}
      onContextMenu={(event) => {
        if (!filled || !onContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      {!filled && (
        <span className="gb-slot-label gb-shared-slot-label">
          {label}{required ? " *" : ""}
        </span>
      )}
      {multi ? (
        <span className="gb-slot-chip gb-slot-chip-multi">
          <span className="gb-slot-chip-name">
            {visibleBindings.length} cols: {visibleBindings[0].label}
          </span>
        </span>
      ) : filled ? (
        <span className="gb-slot-chip">
          <span className="gb-slot-chip-name gb-shared-slot-value">
            {visibleBindings[0].label}
          </span>
          {onClear && (
            <button
              type="button"
              className="gb-slot-chip-x gb-shared-slot-clear"
              aria-label={clearAriaLabel}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onClear();
              }}
            >
              &times;
            </button>
          )}
        </span>
      ) : (
        <span className="gb-shared-slot-value">{dropText}</span>
      )}
      {settings}
    </section>
  );
}

interface GraphPlaceholderButtonProps {
  label: string;
  unavailableTitle: string;
  className?: string;
}

export function GraphPlaceholderButton({
  label,
  unavailableTitle,
  className = "",
}: GraphPlaceholderButtonProps) {
  return (
    <button
      type="button"
      className={className}
      disabled
      title={unavailableTitle}
    >
      {label}
    </button>
  );
}

interface GraphSectionProps {
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function GraphBuilderToolbarSection({
  children,
  className = "",
  testId,
}: GraphSectionProps) {
  return <div className={`gb-shared-toolbar ${className}`} data-testid={testId}>{children}</div>;
}

interface GraphBuilderRailSectionProps extends GraphSectionProps {
  title: string;
}

export function GraphBuilderRailSection({
  title,
  children,
  className = "",
  testId,
}: GraphBuilderRailSectionProps) {
  return (
    <section className={`gb-shared-rail-section ${className}`} data-testid={testId}>
      <header className="sp-panel-header">
        <span className="sp-panel-header-title">{title}</span>
      </header>
      {children}
    </section>
  );
}

interface GraphLayerCardProps extends GraphSectionProps {
  label: string;
  onRemove?: () => void;
  removeDisabled?: boolean;
  removeAriaLabel?: string;
}

export function GraphLayerCard({
  label,
  children,
  onRemove,
  removeDisabled = false,
  removeAriaLabel = `Remove ${label}`,
  className = "",
  testId,
}: GraphLayerCardProps) {
  return (
    <section className={`gb-shared-layer-card ${className}`} data-testid={testId}>
      <header>
        <span>{label}</span>
        {onRemove && (
          <button
            type="button"
            aria-label={removeAriaLabel}
            disabled={removeDisabled}
            onClick={onRemove}
          >
            &times;
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

export function GraphInspectorSection({
  title,
  children,
  className = "",
  testId,
}: GraphBuilderRailSectionProps) {
  return (
    <section className={`gb-shared-inspector-section ${className}`} data-testid={testId}>
      <header>{title}</header>
      {children}
    </section>
  );
}

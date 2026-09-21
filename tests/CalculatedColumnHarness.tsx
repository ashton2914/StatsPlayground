import { useEffect, useState } from "react";

import i18n from "../src/i18n";
import { DataTableView } from "../src/components/DataTableView";
import { dataService } from "../src/services/dataService";
import { useDataStore } from "../src/stores/useDataStore";
import { useHistoryStore } from "../src/stores/useHistoryStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type {
  CellPosition,
  CalculatedColumnMutationResult,
  CalculatedColumnValidation,
  ColumnDescriptor,
  ColumnDisplayProps,
  DatasetMeta,
  TableWindowResult,
  UpsertCalculatedColumnRequest,
  ValidateCalculatedColumnRequest,
} from "../src/types/data";

type CalculatedColumnHarnessScenario = "matrix" | "stale";

type HarnessSnapshot = {
  validateRequests: ValidateCalculatedColumnRequest[];
  upsertRequests: UpsertCalculatedColumnRequest[];
  convertRequests: Array<{ datasetId: string; columnId: string; expectedGeneration: number }>;
  deleteColumnRequests: Array<{ datasetId: string; columnNames: string[]; expectedGeneration: number }>;
  alterColumnsTypeRequests: Array<{ datasetId: string; columnNames: string[]; newType: string; expectedGeneration: number }>;
  displayPropsWrites: Array<{ datasetId: string; props: ColumnDisplayProps[] }>;
  updateCellCalls: Array<{ datasetId: string; rowId: number; columnName: string; value: string }>;
  clearCellsCalls: Array<{ datasetId: string; cells: CellPosition[] }>;
  pasteCalls: Array<{
    datasetId: string;
    startRow: number;
    startCol: number;
    rows: string[][];
    headerNames: string[] | null;
    colTypes: string[];
    expectedGeneration?: number;
  }>;
  confirmMessages: string[];
  clipboardWrites: string[];
};

type HarnessController = {
  getSnapshot: () => HarnessSnapshot;
  setConfirmResult: (value: boolean) => void;
  setClipboardText: (value: string) => void;
  setNextValidationFailure: (value: unknown) => void;
  holdNextValidation: () => void;
  resolveHeldValidation: () => void;
  bumpGeneration: () => void;
  renameWidthAndRefresh: () => void;
  setLanguage: (value: string) => void;
  stageHistoryRefresh: (mode: "undo" | "redo") => void;
};

declare global {
  interface Window {
    __calculatedColumnHarness?: HarnessController;
  }
}

const DATASET: DatasetMeta = {
  id: "dataset-calculated-columns",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 2,
  colCount: 10,
  generation: 7,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const DISPLAY_PROPS: ColumnDisplayProps[] = [];

const BASE_VISIBLE_COLUMNS = [
  "Length",
  "Width",
  "Bracket ] Name",
  "Calculated1",
  "Area",
  "DoubleArea",
  "BrokenArea",
  "UnsupportedArea",
  "Width (mm)",
  "RenamedArea",
] as const;

const BASE_DESCRIPTORS: ColumnDescriptor[] = [
  { columnId: "length-id", name: "Length", sqlType: "DOUBLE" },
  { columnId: "width-id", name: "Width", sqlType: "DOUBLE" },
  { columnId: "bracket-id", name: "Bracket ] Name", sqlType: "VARCHAR" },
  { columnId: "calculated1-id", name: "Calculated1", sqlType: "DOUBLE" },
  {
    columnId: "area-id",
    name: "Area",
    sqlType: "DOUBLE",
    calculated: {
      formulaId: "formula-area",
      schemaVersion: "1",
      outputColumnId: "area-id",
      displayFormulaText: "ROUND([Length] * [Width], 2)",
      status: "ready",
      dependencyColumnIds: ["length-id", "width-id"],
      inferredOutputType: "continuous",
      fingerprint: "fingerprint-area",
    },
  },
  {
    columnId: "double-area-id",
    name: "DoubleArea",
    sqlType: "DOUBLE",
    calculated: {
      formulaId: "formula-double-area",
      schemaVersion: "1",
      outputColumnId: "double-area-id",
      displayFormulaText: "[Area] * 2",
      status: "ready",
      dependencyColumnIds: ["area-id"],
      inferredOutputType: "continuous",
      fingerprint: "fingerprint-double-area",
    },
  },
  {
    columnId: "broken-area-id",
    name: "BrokenArea",
    sqlType: "DOUBLE",
    calculated: {
      formulaId: "formula-broken-area",
      schemaVersion: "1",
      outputColumnId: "broken-area-id",
      displayFormulaText: "[MissingColumn] + 1",
      status: "broken",
      dependencyColumnIds: ["missing-column-id"],
      inferredOutputType: "continuous",
      fingerprint: "fingerprint-broken-area",
    },
  },
  {
    columnId: "unsupported-area-id",
    name: "UnsupportedArea",
    sqlType: "DOUBLE",
    calculated: {
      formulaId: "formula-unsupported-area",
      schemaVersion: "1",
      outputColumnId: "unsupported-area-id",
      displayFormulaText: "RUNNING_SUM([Length])",
      status: "unsupported",
      dependencyColumnIds: ["length-id"],
      inferredOutputType: "continuous",
      fingerprint: "fingerprint-unsupported-area",
    },
  },
  { columnId: "width-mm-id", name: "Width (mm)", sqlType: "DOUBLE" },
  {
    columnId: "renamed-area-id",
    name: "RenamedArea",
    sqlType: "DOUBLE",
    calculated: {
      formulaId: "formula-renamed-area",
      schemaVersion: "1",
      outputColumnId: "renamed-area-id",
      displayFormulaText: "ROUND([Width (mm)] * 3, 1)",
      status: "ready",
      dependencyColumnIds: ["width-mm-id"],
      inferredOutputType: "continuous",
      fingerprint: "fingerprint-renamed-area",
    },
  },
];

const BASE_ROWS: Array<[number, number, number, string, number, number, number, number, number, number, number]> = [
  [1, 10, 2, "A", 7, 20, 40, 0, 0, 5, 15],
  [2, 12, 3, "B", 8, 36, 72, 0, 0, 6, 18],
];

function buildWindow(columns = BASE_VISIBLE_COLUMNS, generation = DATASET.generation): TableWindowResult {
  return {
    columns: ["_row_id", ...columns],
    columnTypes: [
      "INTEGER",
      "DOUBLE",
      "DOUBLE",
      "VARCHAR",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
      "DOUBLE",
    ],
    rows: BASE_ROWS.map((row) => [...row]),
    totalRows: BASE_ROWS.length,
    start: 0,
    generation,
  };
}

function cloneDescriptors(descriptors: ColumnDescriptor[]): ColumnDescriptor[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    calculated: descriptor.calculated ? {
      ...descriptor.calculated,
      dependencyColumnIds: [...descriptor.calculated.dependencyColumnIds],
    } : undefined,
  }));
}

function inferDependencies(descriptors: ColumnDescriptor[], formulaText: string): string[] {
  const haystack = formulaText.toLowerCase();
  return descriptors
    .filter((descriptor) => {
      const name = descriptor.name.toLowerCase();
      const escaped = `[${descriptor.name.replaceAll("]", "]]")}]`.toLowerCase();
      return haystack.includes(name) || haystack.includes(escaped);
    })
    .map((descriptor) => descriptor.columnId);
}

function inferOutputType(formulaText: string): CalculatedColumnValidation["definition"]["inferredOutputType"] {
  if (/\bif\s*\(/i.test(formulaText)) return "boolean";
  return "continuous";
}

function buildValidation(
  descriptors: ColumnDescriptor[],
  request: ValidateCalculatedColumnRequest,
): CalculatedColumnValidation {
  const dependencyColumnIds = inferDependencies(descriptors, request.formulaText);
  const inferredOutputType = inferOutputType(request.formulaText);
  const normalizedOutputId = request.outputColumnId ?? `${request.outputName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-id`;
  const status = request.formulaText.includes("RUNNING_SUM")
    ? "unsupported"
    : request.formulaText.includes("MissingColumn")
      ? "broken"
      : "ready";
  const diagnostics = request.formulaText.includes("USE_LOCKED_DEPENDENCY")
    ? [{
        level: "error" as const,
        code: "formula_dependency_in_use",
        message: "formula_dependency_in_use|Length|Area>DoubleArea",
        relatedColumnIds: ["length-id", "area-id", "double-area-id"],
      }]
    : status === "broken"
    ? [{
        level: "error" as const,
        code: "missing_dependency",
        message: "missing_dependency|BrokenArea|MissingColumn",
        relatedColumnIds: ["missing-column-id"],
      }]
    : status === "unsupported"
      ? [{
          level: "warning" as const,
          code: "unsupported_function",
          message: "unsupported_function|RUNNING_SUM",
        }]
      : [];
  return {
    status,
    diagnostics,
    warningCount: {
      total: diagnostics.length,
      expression: diagnostics.length,
      dependencyGraph: 0,
      validation: 0,
    },
    definition: {
      formulaId: request.formulaId ?? `formula-${normalizedOutputId}`,
      schemaVersion: "1",
      outputColumnId: normalizedOutputId,
      expression: {
        kind: "columnRef",
        columnId: dependencyColumnIds[0] ?? "length-id",
      },
      dependencyColumnIds,
      inferredOutputType,
      fingerprint: `fingerprint-${normalizedOutputId}`,
    },
  };
}

function setDatasetGeneration(generation: number) {
  useDataStore.setState((state) => ({
    ...state,
    datasets: state.datasets.map((dataset) => dataset.id === DATASET.id
      ? { ...dataset, generation, updatedAt: `2026-09-16T00:00:0${generation}.000Z` }
      : dataset),
  }));
}

export function CalculatedColumnHarness({
  scenario,
  width = 1280,
}: {
  scenario: CalculatedColumnHarnessScenario;
  width?: number;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousDataState = useDataStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousHistoryState = useHistoryStore.getState();
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousGetDatasetGeneration = dataService.getDatasetGeneration;
    const previousQueryTableWindow = dataService.queryTableWindow;
    const previousGetColumnDisplayProps = dataService.getColumnDisplayProps;
    const previousSetColumnDisplayProps = dataService.setColumnDisplayProps;
    const previousGetColumnDescriptors = dataService.getColumnDescriptors;
    const previousValidateCalculatedColumn = dataService.validateCalculatedColumn;
    const previousUpsertCalculatedColumn = dataService.upsertCalculatedColumn;
    const previousConvertCalculatedColumnToValues = dataService.convertCalculatedColumnToValues;
    const previousDeleteColumnsWithChangeSet = dataService.deleteColumnsWithChangeSet;
    const previousAlterColumnsTypeWithChangeSet = dataService.alterColumnsTypeWithChangeSet;
    const previousUpdateCell = dataService.updateCell;
    const previousClearCells = dataService.clearCells;
    const previousPasteAtPositionWithChangeSet = dataService.pasteAtPositionWithChangeSet;
    const previousConfirm = window.confirm;
    const previousClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
    let active = true;
    let currentGeneration = DATASET.generation;
    let currentWindow: TableWindowResult = buildWindow();
    let currentDescriptors: ColumnDescriptor[] = cloneDescriptors(BASE_DESCRIPTORS);
    let confirmResult = true;
    let clipboardText = "";
    let nextValidationFailure: unknown | null = null;
    let holdNextValidation = false;
    let resolveHeldValidation: (() => void) | null = null;
    let stagedHistoryRefresh: "undo" | "redo" | null = null;
    const snapshot: HarnessSnapshot = {
      validateRequests: [],
      upsertRequests: [],
      convertRequests: [],
      deleteColumnRequests: [],
      alterColumnsTypeRequests: [],
      displayPropsWrites: [],
      updateCellCalls: [],
      clearCellsCalls: [],
      pasteCalls: [],
      confirmMessages: [],
      clipboardWrites: [],
    };

    const updateDescriptors = (nextDescriptors: ColumnDescriptor[]) => {
      currentDescriptors = cloneDescriptors(nextDescriptors);
    };

    const updateWindowColumns = (nextDescriptors: ColumnDescriptor[]) => {
      currentWindow = buildWindow(nextDescriptors.map((descriptor) => descriptor.name) as typeof BASE_VISIBLE_COLUMNS, currentGeneration);
    };

    useDataStore.setState({
      ...previousDataState,
      activeDatasetId: DATASET.id,
      datasets: [DATASET],
      statusInfo: null,
    });
    useProjectStore.setState({
      ...previousProjectState,
      readOnly: false,
      dirty: false,
      saving: false,
      saveError: null,
    });
    useHistoryStore.setState({
      ...previousHistoryState,
      historyRevision: 0,
      historyError: null,
      pendingRestore: null,
      undo: () => {
        if (stagedHistoryRefresh === "undo") {
          currentGeneration += 1;
          currentDescriptors = currentDescriptors.map((descriptor) => {
            if (descriptor.columnId === "width-id") {
              return { ...descriptor, name: "Width Undo" };
            }
            if (descriptor.columnId === "area-id" && descriptor.calculated) {
              return {
                ...descriptor,
                calculated: {
                  ...descriptor.calculated,
                  displayFormulaText: "ROUND([Length] * [Width Undo], 2)",
                },
              };
            }
            return descriptor;
          });
          updateDescriptors(currentDescriptors);
          updateWindowColumns(currentDescriptors);
          setDatasetGeneration(currentGeneration);
          stagedHistoryRefresh = null;
        }
        useHistoryStore.setState((state) => ({
          ...state,
          historyRevision: state.historyRevision + 1,
        }));
      },
      redo: () => {
        if (stagedHistoryRefresh === "redo") {
          currentGeneration += 1;
          currentDescriptors = currentDescriptors.map((descriptor) => {
            if (descriptor.columnId === "width-id") {
              return { ...descriptor, name: "Width Redo" };
            }
            if (descriptor.columnId === "area-id" && descriptor.calculated) {
              return {
                ...descriptor,
                calculated: {
                  ...descriptor.calculated,
                  displayFormulaText: "ROUND([Length] * [Width Redo], 2)",
                },
              };
            }
            return descriptor;
          });
          updateDescriptors(currentDescriptors);
          updateWindowColumns(currentDescriptors);
          setDatasetGeneration(currentGeneration);
          stagedHistoryRefresh = null;
        }
        useHistoryStore.setState((state) => ({
          ...state,
          historyRevision: state.historyRevision + 1,
        }));
      },
    });

    const clipboard = {
      readText: async () => clipboardText,
      writeText: async (value: string) => {
        snapshot.clipboardWrites.push(value);
      },
    };
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });

    dataService.getDatasetGeneration = async () => currentGeneration;
    dataService.queryTableWindow = async () => currentWindow;
    dataService.getColumnDisplayProps = async () => DISPLAY_PROPS;
    dataService.setColumnDisplayProps = async (datasetId, props) => {
      snapshot.displayPropsWrites.push({ datasetId, props });
    };
    dataService.getColumnDescriptors = async () => currentDescriptors;
    dataService.validateCalculatedColumn = async (request): Promise<CalculatedColumnValidation> => {
      snapshot.validateRequests.push(request);
      if (holdNextValidation) {
        holdNextValidation = false;
        await new Promise<void>((resolve) => {
          resolveHeldValidation = resolve;
        });
        resolveHeldValidation = null;
      }
      if (request.formulaText.includes("FORCE_VALIDATION_THROW")) {
        throw new Error(JSON.stringify({
          code: "validationFailed",
          safeMessage: 'Unexpected token near ")"',
          message: "backend parser crashed",
        }));
      }
      if (nextValidationFailure !== null) {
        const failure = nextValidationFailure;
        nextValidationFailure = null;
        throw failure;
      }
      return buildValidation(currentDescriptors, request);
    };
    dataService.upsertCalculatedColumn = async (request): Promise<CalculatedColumnMutationResult> => {
      snapshot.upsertRequests.push(request);
      currentGeneration += 1;
      const validation = buildValidation(currentDescriptors, {
        ...request,
        expectedGeneration: currentGeneration,
      });
      const columnId = request.outputColumnId ?? validation.definition.outputColumnId;
      const formulaId = request.formulaId ?? validation.definition.formulaId;
      const nextDescriptor: ColumnDescriptor = {
        columnId,
        name: request.outputName,
        sqlType: validation.definition.inferredOutputType === "boolean" ? "BOOLEAN" : "DOUBLE",
        calculated: {
          formulaId,
          schemaVersion: validation.definition.schemaVersion,
          outputColumnId: columnId,
          displayFormulaText: request.formulaText,
          status: validation.status,
          dependencyColumnIds: validation.definition.dependencyColumnIds,
          inferredOutputType: validation.definition.inferredOutputType,
          fingerprint: validation.definition.fingerprint,
        },
      };

      const targetIndex = currentDescriptors.findIndex((descriptor) => descriptor.columnId === columnId);
      if (targetIndex >= 0) {
        currentDescriptors[targetIndex] = nextDescriptor;
      } else {
        const insertIndex = request.atIndex ?? currentDescriptors.length;
        currentDescriptors.splice(insertIndex, 0, nextDescriptor);
      }

      updateDescriptors(currentDescriptors);
      updateWindowColumns(currentDescriptors);
      setDatasetGeneration(currentGeneration);

      return {
        columnId,
        datasetGeneration: currentGeneration,
        changeSetId: `change-set-${columnId}-${currentGeneration}`,
        calculated: nextDescriptor.calculated,
        diagnostics: validation.diagnostics,
        warningCount: validation.warningCount,
      };
    };
    dataService.convertCalculatedColumnToValues = async (datasetId, columnId, expectedGeneration) => {
      snapshot.convertRequests.push({ datasetId, columnId, expectedGeneration });
      currentGeneration += 1;
      const target = currentDescriptors.find((descriptor) => descriptor.columnId === columnId);
      if (target) delete target.calculated;
      updateDescriptors(currentDescriptors);
      updateWindowColumns(currentDescriptors);
      setDatasetGeneration(currentGeneration);
      return {
        columnId,
        datasetGeneration: currentGeneration,
        changeSetId: `convert-${columnId}-${currentGeneration}`,
        warningCount: { total: 0, expression: 0, dependencyGraph: 0, validation: 0 },
      };
    };
    dataService.deleteColumnsWithChangeSet = async (datasetId, columns, expectedGeneration) => {
      const columnNames = columns.map((column) => column.name);
      snapshot.deleteColumnRequests.push({ datasetId, columnNames, expectedGeneration });
      if (columnNames.includes("Length")) {
        throw new Error("formula_dependency_in_use|Length|Area>DoubleArea");
      }
      currentGeneration += 1;
      currentDescriptors = currentDescriptors.filter((descriptor) => !columnNames.includes(descriptor.name));
      updateDescriptors(currentDescriptors);
      updateWindowColumns(currentDescriptors);
      setDatasetGeneration(currentGeneration);
      return {
        columnIds: columns.map((column) => column.columnId),
        generation: currentGeneration,
        columnCount: currentDescriptors.length,
        changeSetId: `delete-columns-${currentGeneration}`,
      };
    };
    dataService.alterColumnsTypeWithChangeSet = async (datasetId, columnNames, newType, expectedGeneration) => {
      snapshot.alterColumnsTypeRequests.push({ datasetId, columnNames, newType, expectedGeneration });
      if (columnNames.includes("Area")) {
        throw new Error("calculated output column is read-only until convert to values: Area");
      }
      currentGeneration += 1;
      currentDescriptors = currentDescriptors.map((descriptor) => columnNames.includes(descriptor.name)
        ? { ...descriptor, sqlType: newType }
        : descriptor);
      updateDescriptors(currentDescriptors);
      updateWindowColumns(currentDescriptors);
      setDatasetGeneration(currentGeneration);
      return `alter-columns-${currentGeneration}`;
    };
    dataService.updateCell = async (datasetId, rowId, columnName, value) => {
      snapshot.updateCellCalls.push({ datasetId, rowId, columnName, value });
    };
    dataService.clearCells = async (datasetId, cells) => {
      snapshot.clearCellsCalls.push({ datasetId, cells });
    };
    dataService.pasteAtPositionWithChangeSet = async (datasetId, startRow, startCol, rows, headerNames, colTypes, expectedGeneration) => {
      snapshot.pasteCalls.push({ datasetId, startRow, startCol, rows, headerNames, colTypes, expectedGeneration });
      return { changeSetId: `paste-${currentGeneration}` };
    };
    window.confirm = (message?: string) => {
      snapshot.confirmMessages.push(String(message ?? ""));
      return confirmResult;
    };
    window.__calculatedColumnHarness = {
      getSnapshot: () => ({
        validateRequests: [...snapshot.validateRequests],
        upsertRequests: [...snapshot.upsertRequests],
        convertRequests: [...snapshot.convertRequests],
        deleteColumnRequests: [...snapshot.deleteColumnRequests],
        alterColumnsTypeRequests: [...snapshot.alterColumnsTypeRequests],
        displayPropsWrites: snapshot.displayPropsWrites.map((write) => ({
          datasetId: write.datasetId,
          props: write.props.map((prop) => ({ ...prop })),
        })),
        updateCellCalls: [...snapshot.updateCellCalls],
        clearCellsCalls: [...snapshot.clearCellsCalls],
        pasteCalls: [...snapshot.pasteCalls],
        confirmMessages: [...snapshot.confirmMessages],
        clipboardWrites: [...snapshot.clipboardWrites],
      }),
      setConfirmResult: (value: boolean) => {
        confirmResult = value;
      },
      setClipboardText: (value: string) => {
        clipboardText = value;
      },
      setNextValidationFailure: (value: unknown) => {
        nextValidationFailure = value;
      },
      holdNextValidation: () => {
        holdNextValidation = true;
      },
      resolveHeldValidation: () => {
        resolveHeldValidation?.();
      },
      bumpGeneration: () => {
        currentGeneration += 1;
        currentDescriptors = cloneDescriptors(currentDescriptors);
        currentWindow = { ...currentWindow, generation: currentGeneration };
        setDatasetGeneration(currentGeneration);
      },
      renameWidthAndRefresh: () => {
        currentGeneration += 1;
        currentDescriptors = currentDescriptors.map((descriptor) => {
          if (descriptor.columnId === "width-id") {
            return { ...descriptor, name: "Width Renamed" };
          }
          if (descriptor.columnId === "area-id" && descriptor.calculated) {
            return {
              ...descriptor,
              calculated: {
                ...descriptor.calculated,
                displayFormulaText: "ROUND([Length] * [Width Renamed], 2)",
              },
            };
          }
          return descriptor;
        });
        updateDescriptors(currentDescriptors);
        updateWindowColumns(currentDescriptors);
        setDatasetGeneration(currentGeneration);
        useHistoryStore.setState((state) => ({
          ...state,
          historyRevision: state.historyRevision + 1,
        }));
      },
      setLanguage: (value: string) => {
        void i18n.changeLanguage(value);
      },
      stageHistoryRefresh: (mode: "undo" | "redo") => {
        stagedHistoryRefresh = mode;
      },
    };

    if (scenario === "stale") {
      window.setTimeout(() => {
        if (!active) return;
        currentGeneration += 1;
        currentWindow = { ...currentWindow, generation: currentGeneration };
        setDatasetGeneration(currentGeneration);
      }, 650);
    }

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataService.getDatasetGeneration = previousGetDatasetGeneration;
      dataService.queryTableWindow = previousQueryTableWindow;
      dataService.getColumnDisplayProps = previousGetColumnDisplayProps;
      dataService.setColumnDisplayProps = previousSetColumnDisplayProps;
      dataService.getColumnDescriptors = previousGetColumnDescriptors;
      dataService.validateCalculatedColumn = previousValidateCalculatedColumn;
      dataService.upsertCalculatedColumn = previousUpsertCalculatedColumn;
      dataService.convertCalculatedColumnToValues = previousConvertCalculatedColumnToValues;
      dataService.deleteColumnsWithChangeSet = previousDeleteColumnsWithChangeSet;
      dataService.alterColumnsTypeWithChangeSet = previousAlterColumnsTypeWithChangeSet;
      dataService.updateCell = previousUpdateCell;
      dataService.clearCells = previousClearCells;
      dataService.pasteAtPositionWithChangeSet = previousPasteAtPositionWithChangeSet;
      window.confirm = previousConfirm;
      if (previousClipboard) {
        Object.defineProperty(window.navigator, "clipboard", previousClipboard);
      }
      delete window.__calculatedColumnHarness;
      useDataStore.setState(previousDataState, true);
      useProjectStore.setState(previousProjectState, true);
      useHistoryStore.setState(previousHistoryState, true);
      void i18n.changeLanguage(previousLanguage);
    };
  }, [scenario]);

  if (!ready) return null;

  return (
    <div style={{ width, height: 760 }}>
      <DataTableView datasetId={DATASET.id} />
    </div>
  );
}
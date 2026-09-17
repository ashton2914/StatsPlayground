import type {
  BandRefLine,
  ChartElement,
  FieldRef,
  RefLineX,
  RefLineY,
  TimeSeriesOptions,
  TimeSeriesTextDateFormat,
  TimeSeriesXInterpretation,
} from "@/graphCore/types";
import { DEFAULT_TIME_SERIES_OPTIONS } from "@/graphCore/types";

export { DEFAULT_TIME_SERIES_OPTIONS };

type TimeSeriesState = {
  elements: readonly ChartElement[];
  refLinesY?: readonly RefLineY[];
  refLinesX?: readonly RefLineX[];
  bandRefLines?: readonly BandRefLine[];
};

export interface TimeSeriesValidationOk {
  valid: true;
  temporalKind?: "date" | "timestamp" | "timestampTz";
}

export interface TimeSeriesValidationError {
  valid: false;
  message: string;
}

export type TimeSeriesValidationResult = TimeSeriesValidationOk | TimeSeriesValidationError;

const TIME_SERIES_RAW_LAYER_KINDS = new Set<ChartElement["kind"]>([
  "points",
  "line",
  "bar",
  "histogram",
  "smoother",
  "fitline",
]);

export const TIME_SERIES_TEXT_DATE_FORMATS: TimeSeriesTextDateFormat[] = [
  "isoDate",
  "isoDateTime",
  "usDate",
  "usDateTime",
  "dayFirstDate",
  "dayFirstDateTime",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeTimeSeriesTextDateFormat(value: unknown): TimeSeriesTextDateFormat | null {
  return TIME_SERIES_TEXT_DATE_FORMATS.includes(value as TimeSeriesTextDateFormat)
    ? value as TimeSeriesTextDateFormat
    : null;
}

function normalizeTimeSeriesInterpretation(value: unknown): TimeSeriesOptions["xInterpretation"] {
  if (!isObject(value) || typeof value.kind !== "string") {
    return DEFAULT_TIME_SERIES_OPTIONS.xInterpretation;
  }
  if (value.kind === "nativeTemporal" || value.kind === "sequence") {
    return { kind: value.kind };
  }
  const textDateFormat = normalizeTimeSeriesTextDateFormat(value.format);
  if (value.kind === "textDate" && textDateFormat) {
    return { kind: "textDate", format: textDateFormat };
  }
  return DEFAULT_TIME_SERIES_OPTIONS.xInterpretation;
}

export function normalizeTimeSeriesOptions(value: unknown): TimeSeriesOptions {
  if (!isObject(value)) {
    return { ...DEFAULT_TIME_SERIES_OPTIONS };
  }
  const connection = value.connection === "step" ? "step" : "line";
  const markerMode = value.markerMode === "show" || value.markerMode === "hide" ? value.markerMode : "auto";
  const missingValues = value.missingValues === "connect" ? "connect" : "break";
  const order = value.order === "sourceRow" ? "sourceRow" : "timeAscending";
  return {
    xInterpretation: normalizeTimeSeriesInterpretation(value.xInterpretation),
    order,
    missingValues,
    connection,
    markerMode,
  };
}

function normalizeSqlType(sqlType: string): string {
  return sqlType.trim().toUpperCase();
}

function normalizeSqlBaseType(sqlType: string): string {
  const withoutParameters = normalizeSqlType(sqlType).split("(")[0].trim();
  return withoutParameters.split(" ").find((part) => part.length > 0) ?? "";
}

export function isStandaloneTimeSqlType(sqlType: string): boolean {
  const normalized = normalizeSqlType(sqlType);
  const baseType = normalizeSqlBaseType(normalized);
  return (baseType === "TIME" || baseType === "TIMETZ" || baseType === "TIME_TZ")
    && !normalized.includes("TIMESTAMP");
}

function toInvalid(message: string): TimeSeriesValidationError {
  return { valid: false, message };
}

function isNativeTemporalSqlType(sqlType: string): boolean {
  return sqlType.includes("TIMESTAMP") || sqlType.includes("DATE");
}

function isTimestampWithTimezone(sqlType: string): boolean {
  return sqlType.includes("TIME ZONE") || sqlType.includes("TIMESTAMPTZ") || sqlType.includes("TIMESTAMP_TZ");
}

function isTextualDateSource(field: FieldRef): boolean {
  return field.type === "nominal" || field.type === "ordinal" || field.type === "id";
}

function isNumericSource(field: FieldRef): boolean {
  return field.type === "continuous";
}

function isNumericSqlType(sqlType: string): boolean {
  const baseType = normalizeSqlBaseType(sqlType);
  return baseType === "TINYINT"
    || baseType === "SMALLINT"
    || baseType === "INTEGER"
    || baseType === "INT"
    || baseType === "BIGINT"
    || baseType === "HUGEINT"
    || baseType === "UTINYINT"
    || baseType === "USMALLINT"
    || baseType === "UINTEGER"
    || baseType === "UBIGINT"
    || baseType === "UHUGEINT"
    || baseType === "REAL"
    || baseType === "FLOAT"
    || baseType === "DOUBLE"
    || baseType === "DECIMAL"
    || baseType === "NUMERIC"
    || baseType === "BIGNUM";
}

function isDateOnlyTextFormat(format: TimeSeriesTextDateFormat): boolean {
  return format === "isoDate" || format === "usDate" || format === "dayFirstDate";
}

export function validateTimeSeriesX(
  field: FieldRef,
  sqlType: string,
  interpretation: TimeSeriesXInterpretation,
): TimeSeriesValidationResult {
  const normalizedSqlType = normalizeSqlType(sqlType);

  if (interpretation.kind === "nativeTemporal") {
    if (field.type !== "datetime") {
      return toInvalid(`Field ${field.name} must be temporal for native time series X interpretation.`);
    }
    if (isStandaloneTimeSqlType(normalizedSqlType)) {
      return toInvalid("Standalone TIME is not supported for time series X.");
    }
    if (!isNativeTemporalSqlType(normalizedSqlType)) {
      return toInvalid(`SQL type ${sqlType} is not supported for native time series X.`);
    }
    return {
      valid: true,
      temporalKind: isTimestampWithTimezone(normalizedSqlType)
        ? "timestampTz"
        : /TIMESTAMP/.test(normalizedSqlType)
          ? "timestamp"
          : "date",
    };
  }

  if (interpretation.kind === "textDate") {
    if (!isTextualDateSource(field)) {
      return toInvalid(`Field ${field.name} must be text-like for parsed time series X.`);
    }
    if (!normalizeTimeSeriesTextDateFormat(interpretation.format)) {
      return toInvalid(`Text date format ${String(interpretation.format)} is not supported.`);
    }
    return { valid: true, temporalKind: isDateOnlyTextFormat(interpretation.format) ? "date" : "timestamp" };
  }

  if (!isNumericSource(field)) {
    return toInvalid(`Field ${field.name} must be numeric for sequence time series X.`);
  }
  if (!isNumericSqlType(normalizedSqlType)) {
    return toInvalid(`SQL type ${sqlType} is not numeric for sequence time series X.`);
  }
  return { valid: true };
}

function normalizeTimeSeriesElement(element: ChartElement): ChartElement {
  if (element.kind !== "timeSeries") {
    return element;
  }
  return {
    ...element,
    options: normalizeTimeSeriesOptions(element.options),
  };
}

export function reconcileTimeSeriesElements<T extends TimeSeriesState>(state: T): T {
  const hasTimeSeries = state.elements.some((element) => element.enabled !== false && element.kind === "timeSeries");
  const normalizedElements = state.elements.map((element) => normalizeTimeSeriesElement(element));
  if (!hasTimeSeries) {
    return {
      ...state,
      elements: normalizedElements,
    };
  }
  const elements = normalizedElements.filter((element) => element.enabled === false
    || element.kind === "timeSeries"
    || !TIME_SERIES_RAW_LAYER_KINDS.has(element.kind));
  return {
    ...state,
    elements,
  };
}
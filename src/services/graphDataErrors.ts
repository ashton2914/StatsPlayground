import i18n from "../i18n";

/** Only structured, known backend errors may contribute parameters to user copy. */
export function formatGraphDataError(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (value.code === "graphNumericColumnRequired" && typeof value.column === "string") {
      return i18n.t("graph.errors.numericColumnRequired", { column: value.column });
    }
  }
  return i18n.t("graph.errors.queryFailed");
}

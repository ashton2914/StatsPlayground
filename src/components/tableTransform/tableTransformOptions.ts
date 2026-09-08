export const TABLE_TRANSFORM_TYPES = [
  "summary",
  "subset",
  "sort",
  "stack",
  "split",
  "transpose",
  "join",
  "update",
  "concatenate",
] as const;

export type TableTransformType = (typeof TABLE_TRANSFORM_TYPES)[number];

export const DEFAULT_TABLE_TRANSFORM_TYPE: TableTransformType = "summary";
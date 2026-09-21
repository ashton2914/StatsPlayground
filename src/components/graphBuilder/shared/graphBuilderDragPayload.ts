export const GRAPH_FIELD_DRAG_MIME =
  "application/x-statsplayground-graph-fields+json";

export interface GraphBuilderDragField {
  columnId: string;
  name: string;
  sqlType: string;
}

interface GraphBuilderDragEnvelope {
  version: 1;
  fields: GraphBuilderDragField[];
}

const MAX_FIELD_COUNT = 256;
const MAX_COLUMN_ID_BYTES = 256;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateFields(value: unknown): GraphBuilderDragField[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELD_COUNT) {
    return null;
  }
  const ids = new Set<string>();
  const fields: GraphBuilderDragField[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (!hasExactKeys(record, ["columnId", "name", "sqlType"])) return null;
    const { columnId, name, sqlType } = record;
    if (typeof columnId !== "string"
      || typeof name !== "string"
      || typeof sqlType !== "string"
      || !columnId.trim()
      || !name.trim()
      || !sqlType.trim()
      || new TextEncoder().encode(columnId).length > MAX_COLUMN_ID_BYTES
      || ids.has(columnId)) {
      return null;
    }
    ids.add(columnId);
    fields.push({ columnId, name, sqlType });
  }
  return fields;
}

export function encodeGraphBuilderDragFields(
  fields: readonly GraphBuilderDragField[],
): string {
  const validated = validateFields(fields);
  if (!validated) throw new Error("graph_builder_invalid_drag_fields");
  const envelope: GraphBuilderDragEnvelope = { version: 1, fields: validated };
  return JSON.stringify(envelope);
}

export function decodeGraphBuilderDragFields(
  value: string,
): GraphBuilderDragField[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (!hasExactKeys(envelope, ["version", "fields"]) || envelope.version !== 1) return null;
  return validateFields(envelope.fields);
}

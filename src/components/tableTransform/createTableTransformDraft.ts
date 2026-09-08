import type {
  TableTransformDraft,
  TableTransformOperation,
} from "@/types/tableTransform";

function inputRoles(operation: TableTransformOperation): string[] {
  switch (operation.kind) {
    case "join":
    case "update":
      return ["left", "right"];
    case "concatenate":
      return Array.from({ length: operation.sourceCount }, (_, index) => `source-${index + 1}`);
    default:
      return ["source"];
  }
}

export function createTableTransformDraft(
  name: string,
  outputName: string,
  operation: TableTransformOperation,
  tableDocumentIds: string[],
): TableTransformDraft {
  const roles = inputRoles(operation);
  if (tableDocumentIds.length !== roles.length) {
    throw new Error(`${operation.kind} requires ${roles.length} input tables`);
  }
  if (!name.trim() || !outputName.trim() || tableDocumentIds.some((id) => !id.trim())) {
    throw new Error("Transform name, output name, and input tables are required");
  }
  return {
    name: name.trim(),
    outputName: outputName.trim(),
    operation,
    inputBindings: roles.map((role, index) => ({
      role,
      tableDocumentId: tableDocumentIds[index],
    })),
  };
}
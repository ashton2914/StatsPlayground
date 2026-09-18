export type ProjectFileExtension = ".sptb" | ".sptbtf" | ".spgh" | ".spgn" | ".spf" | ".sprp" | ".spdist" | ".span" | ".json";

export type ProjectDocumentKind = "table" | "tableTransform" | "graph" | "graphNew" | "fitYByX" | "tabulate" | "report" | "distribution" | "analysis" | "snapshot";

export type ProjectBasenameValidationError =
  | "empty"
  | "invalidChars"
  | "edgeDots"
  | "controlChars"
  | "reserved"
  | "tooLong"
  | "pathTooLong";

export class ProjectNameValidationError extends Error {
  constructor(public readonly code: ProjectBasenameValidationError) {
    super(`project_name_${code}`);
  }
}

export type ProjectBasenameResolutionError = ProjectBasenameValidationError | "wrongExtension";

export type ProjectBasenameResolution =
  | {
      basename: string;
      error: null;
      expectedExtension: ProjectFileExtension;
      actualExtension: null;
    }
  | {
      basename: null;
      error: ProjectBasenameResolutionError;
      expectedExtension: ProjectFileExtension;
      actualExtension: ProjectFileExtension | null;
    };

const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const INVALID_CHARS_RE = /[/\\:*?"<>|]/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/;

const KNOWN_EXTENSIONS: ProjectFileExtension[] = [".sptbtf", ".sptb", ".spgh", ".spgn", ".spf", ".sprp", ".spdist", ".span", ".json"];

export function projectFileExtension(kind: ProjectDocumentKind): ProjectFileExtension {
  if (kind === "table") return ".sptb";
  if (kind === "tableTransform") return ".sptbtf";
  if (kind === "graph") return ".spgh";
  if (kind === "graphNew") return ".spgn";
  if (kind === "report") return ".sprp";
  if (kind === "distribution") return ".spdist";
  if (kind === "analysis") return ".span";
  if (kind === "snapshot") return ".json";
  return ".spf";
}

export function ensureProjectFileName(name: string, kind: ProjectDocumentKind): string {
  const extension = projectFileExtension(kind);
  const normalized = normalizeProjectBasenameInput(name, extension);
  return `${normalized.basename}${extension}`;
}

export function formatSnapshotTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function lowerKnownExtension(value: string): ProjectFileExtension | null {
  const lower = value.toLowerCase();
  for (const extension of KNOWN_EXTENSIONS) {
    if (lower.endsWith(extension)) return extension;
  }
  return null;
}

export function normalizeProjectBasenameInput(
  requested: string,
  expectedExtension: ProjectFileExtension,
): {
  basename: string;
  strippedExtension: boolean;
  wrongExtension: ProjectFileExtension | null;
} {
  const trimmed = requested.trim();
  const matchedExtension = lowerKnownExtension(trimmed);
  if (!matchedExtension) {
    return {
      basename: trimmed,
      strippedExtension: false,
      wrongExtension: null,
    };
  }
  if (matchedExtension === expectedExtension) {
    return {
      basename: trimmed.slice(0, trimmed.length - matchedExtension.length),
      strippedExtension: true,
      wrongExtension: null,
    };
  }
  return {
    basename: trimmed,
    strippedExtension: false,
    wrongExtension: matchedExtension,
  };
}

export function validateProjectBasename(name: string): ProjectBasenameValidationError | null {
  if (!name) return "empty";
  if (/^[.\s\u0085]|[.\s\u0085]$/.test(name)) return "edgeDots";
  if (INVALID_CHARS_RE.test(name)) return "invalidChars";
  if (CONTROL_CHARS_RE.test(name)) return "controlChars";
  const stem = name.split(".")[0] ?? "";
  if (WINDOWS_RESERVED_STEM.test(stem)) return "reserved";
  return null;
}

export function validateNativeGraphBasename(name: string): ProjectBasenameValidationError | null {
  return validateProjectBasename(name) ?? (new TextEncoder().encode(name).length > 255 ? "tooLong" : null);
}

export function validateProjectFolderPath(path: string): ProjectBasenameValidationError | null {
  if (new TextEncoder().encode(path).length > 4096) return "pathTooLong";
  for (const component of path.split("/")) {
    const error = validateProjectBasename(component);
    if (error) return error;
  }
  return null;
}

export function assertProjectFolderPath(path: string): void {
  const error = validateProjectFolderPath(path);
  if (error) throw new ProjectNameValidationError(error);
}

export function allocateProjectBasename(
  requested: string,
  extension: ProjectFileExtension,
  existing: Iterable<string>,
  currentName?: string,
): string {
  const { basename } = normalizeProjectBasenameInput(requested, extension);
  const lowerCurrent = currentName?.toLowerCase() ?? null;
  const occupied = new Set<string>();
  for (const entry of existing) {
    const lower = entry.toLowerCase();
    if (lowerCurrent && lower === lowerCurrent) continue;
    occupied.add(lower);
  }
  if (!occupied.has(basename.toLowerCase())) return basename;
  let n = 2;
  while (occupied.has(`${basename}-${n}`.toLowerCase())) n += 1;
  return `${basename}-${n}`;
}

export function resolveProjectBasenameForKind(
  requestedName: string,
  kind: ProjectDocumentKind,
  existing: Iterable<string>,
  currentName?: string,
): ProjectBasenameResolution {
  const extension = projectFileExtension(kind);
  const normalized = normalizeProjectBasenameInput(requestedName, extension);
  if (normalized.wrongExtension) {
    return {
      basename: null,
      error: "wrongExtension",
      expectedExtension: extension,
      actualExtension: normalized.wrongExtension,
    };
  }
  const validate = kind === "graphNew" ? validateNativeGraphBasename : validateProjectBasename;
  const validationError = validate(normalized.basename);
  if (validationError) {
    return {
      basename: null,
      error: validationError,
      expectedExtension: extension,
      actualExtension: null,
    };
  }
  const basename = allocateProjectBasename(normalized.basename, extension, existing, currentName);
  const allocatedError = validate(basename);
  if (allocatedError) {
    return { basename: null, error: allocatedError, expectedExtension: extension, actualExtension: null };
  }
  return {
    basename,
    error: null,
    expectedExtension: extension,
    actualExtension: null,
  };
}

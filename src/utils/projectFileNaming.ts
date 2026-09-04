export type ProjectFileExtension = ".sptb" | ".spgh" | ".spf" | ".sprp" | ".spdist" | ".json";

export type ProjectDocumentKind = "table" | "graph" | "fitYByX" | "tabulate" | "report" | "distribution" | "snapshot";

export type ProjectBasenameValidationError =
  | "empty"
  | "invalidChars"
  | "edgeDots"
  | "controlChars"
  | "reserved";

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
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const KNOWN_EXTENSIONS: ProjectFileExtension[] = [".sptb", ".spgh", ".spf", ".sprp", ".spdist", ".json"];

export function projectFileExtension(kind: ProjectDocumentKind): ProjectFileExtension {
  if (kind === "table") return ".sptb";
  if (kind === "graph") return ".spgh";
  if (kind === "report") return ".sprp";
  if (kind === "distribution") return ".spdist";
  if (kind === "snapshot") return ".json";
  return ".spf";
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
  if (/^[.\s]|[.\s]$/.test(name)) return "edgeDots";
  if (INVALID_CHARS_RE.test(name)) return "invalidChars";
  if (CONTROL_CHARS_RE.test(name)) return "controlChars";
  const stem = name.split(".")[0] ?? "";
  if (WINDOWS_RESERVED_STEM.test(stem)) return "reserved";
  return null;
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
  const validationError = validateProjectBasename(normalized.basename);
  if (validationError) {
    return {
      basename: null,
      error: validationError,
      expectedExtension: extension,
      actualExtension: null,
    };
  }
  return {
    basename: allocateProjectBasename(normalized.basename, extension, existing, currentName),
    error: null,
    expectedExtension: extension,
    actualExtension: null,
  };
}

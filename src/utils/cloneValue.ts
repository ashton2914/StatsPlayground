export function cloneValue<T>(value: T): T {
  const structuredCloneFn = (globalThis as {
    structuredClone?: <Value>(input: Value) => Value;
  }).structuredClone;
  if (typeof structuredCloneFn === "function") {
    return structuredCloneFn(value);
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
import assert from "node:assert/strict";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.get(key) ?? null;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, value);
  },
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

const { useUpdatePreferencesStore } = await import("../src/stores/useUpdatePreferencesStore.ts");

assert.deepEqual(
  {
    automaticCheck: useUpdatePreferencesStore.getState().automaticCheck,
    includePrerelease: useUpdatePreferencesStore.getState().includePrerelease,
  },
  { automaticCheck: true, includePrerelease: true },
  "both update preferences must default to enabled",
);

useUpdatePreferencesStore.getState().setAutomaticCheck(false);
useUpdatePreferencesStore.getState().setIncludePrerelease(false);

assert.equal(localStorage.getItem("sp-update-automatic-check"), "false");
assert.equal(localStorage.getItem("sp-update-include-prerelease"), "false");

console.log("update preference store tests passed");
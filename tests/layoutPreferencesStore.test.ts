import assert from "node:assert/strict";

import { readLayoutPreferences, type LayoutPreferences } from "../src/stores/useLayoutPreferencesStore.ts";

function createMemoryStorage(initialValue?: string) {
  const values = new Map<string, string>();

  if (initialValue !== undefined) {
    values.set("sp-layout-preferences-v1", initialValue);
  }

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

  return {
    storage,
    readPersisted() {
      return values.has("sp-layout-preferences-v1")
        ? JSON.parse(values.get("sp-layout-preferences-v1") ?? "null") as LayoutPreferences
        : undefined;
    },
  };
}

function createThrowingStorage() {
  const storage: Storage = {
    get length() {
      return 0;
    },
    clear() {
      throw new Error("storage failure");
    },
    getItem() {
      throw new Error("storage failure");
    },
    key() {
      throw new Error("storage failure");
    },
    removeItem() {
      throw new Error("storage failure");
    },
    setItem() {
      throw new Error("storage failure");
    },
  };

  return storage;
}

const validStorage = createMemoryStorage(
  JSON.stringify({
    version: 1,
    sizes: {
      "workspace.sidebar": 320,
      "history.stack": 60,
    },
  }),
);

assert.deepEqual(readLayoutPreferences(validStorage.storage), {
  "workspace.sidebar": 320,
  "history.stack": 60,
});

assert.deepEqual(
  readLayoutPreferences(
    createMemoryStorage(
      JSON.stringify({
        version: 1,
        sizes: {
          "workspace.sidebar": 336,
          "history.stack": Number.NaN,
          "graphBuilder.rightRail": Number.POSITIVE_INFINITY,
          unknown: 200,
        },
      }),
    ).storage,
  ),
  {
    "workspace.sidebar": 336,
  },
);

assert.deepEqual(readLayoutPreferences(createMemoryStorage("{ not json").storage), {});
assert.deepEqual(readLayoutPreferences(createThrowingStorage()), {});

const writableStorage = createMemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: writableStorage.storage });

const { useLayoutPreferencesStore } = await import("../src/stores/useLayoutPreferencesStore.ts");

assert.equal(useLayoutPreferencesStore.getState().setPanelSize("workspace.sidebar", 336), undefined);
assert.deepEqual(writableStorage.readPersisted(), {
  version: 1,
  sizes: {
    "workspace.sidebar": 336,
  },
});

useLayoutPreferencesStore.getState().resetPanelSize("workspace.sidebar");
assert.equal(useLayoutPreferencesStore.getState().sizes["workspace.sidebar"], undefined);
assert.deepEqual(writableStorage.readPersisted(), {
  version: 1,
  sizes: {},
});

useLayoutPreferencesStore.getState().setPanelSize("workspace.sidebar", 336);

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: createThrowingStorage() });

useLayoutPreferencesStore.getState().setPanelSize("history.stack", 72);
assert.equal(useLayoutPreferencesStore.getState().sizes["history.stack"], 72);

useLayoutPreferencesStore.getState().resetPanelSize("history.stack");
assert.equal(useLayoutPreferencesStore.getState().sizes["history.stack"], undefined);

console.log("layout preference store tests passed");
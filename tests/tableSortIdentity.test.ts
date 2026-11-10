import assert from "node:assert/strict";
import { reconcileTableSortIdentity } from "../src/utils/tableSortIdentity.ts";
import { createTableNavigationSortStore } from "../src/stores/useTableNavigationSortStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";

const before = [{ columnId: "build", name: "Build-1", sqlType: "VARCHAR" }];
const after = [{ columnId: "build", name: "Build-2", sqlType: "VARCHAR" }];
for (const descending of [false, true]) {
  const original = { column: "Build-1", descending };
  assert.deepEqual(reconcileTableSortIdentity(original, before, after), { column: "Build-2", descending });
  assert.deepEqual(reconcileTableSortIdentity({ column: "Build-2", descending }, after, before), original);
  assert.equal(reconcileTableSortIdentity(original, before, before), original, "unchanged or failed rename retains sort");
  assert.equal(reconcileTableSortIdentity(original, before, []), null, "deleted column clears sort");
  assert.equal(reconcileTableSortIdentity(original, before, [{ ...before[0], columnId: "replacement" }]), null, "same-name replacement must not inherit the old column's sort");
  assert.deepEqual(reconcileTableSortIdentity(original, [], before), original, "initial mount resolves an existing name");
  assert.equal(reconcileTableSortIdentity(original, [], after), null, "unknown persisted name is cleared");
}
assert.equal(reconcileTableSortIdentity(null, before, after), null);
const previousReadOnly = useProjectStore.getState().readOnly;
try {
  useProjectStore.setState({ readOnly: false });
  const store = createTableNavigationSortStore();
  store.getState().replaceSort("a", { column: "Build-1", descending: true });
  store.getState().replaceSort("b", { column: "Unrelated", descending: false });
  useProjectStore.setState({ readOnly: true });
  assert.throws(() => store.getState().replaceSort("a", null), "user sorting remains locked during save");
  store.getState().reconcileColumns("a", before, after);
  assert.deepEqual(store.getState().byDataset.a, { column: "Build-2", descending: true });
  store.getState().reconcileColumns("a", after, []);
  assert.equal(store.getState().byDataset.a, undefined);
  assert.deepEqual(store.getState().byDataset.b, { column: "Unrelated", descending: false });
} finally {
  useProjectStore.setState({ readOnly: previousReadOnly });
}
console.log("table sort identity regressions passed");

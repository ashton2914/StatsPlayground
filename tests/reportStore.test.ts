import assert from "node:assert/strict";

import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useReportStore } from "../src/stores/useReportStore.ts";
import type { ReportItem } from "../src/types/report.ts";

function makeReportItem(overrides: Partial<ReportItem> & Pick<ReportItem, "id" | "name">): ReportItem {
  return {
    schemaVersion: 1,
    markdown: "initial markdown",
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

useProjectStore.setState({ readOnly: false });
useReportStore.getState().reset();

const initialItem = makeReportItem({ id: "report-1", name: "Report 1" });
useReportStore.getState().addItem(initialItem);

assert.deepEqual(useReportStore.getState().items, [initialItem]);
assert.equal(useReportStore.getState().counter, 1);
assert.equal(useReportStore.getState().nextName(), "Report 2");
assert.equal(useReportStore.getState().counter, 2);

useReportStore.getState().updateMarkdown(
  "report-1",
  "updated markdown",
  "2026-09-02T10:05:00.000Z",
);
assert.deepEqual(useReportStore.getState().items[0], {
  ...initialItem,
  markdown: "updated markdown",
  updatedAt: "2026-09-02T10:05:00.000Z",
});

useReportStore.getState().renameItem("report-1", "Report 7");
assert.equal(useReportStore.getState().items[0]?.name, "Report 7");
assert.equal(useReportStore.getState().counter, 7);

useReportStore.getState().deleteItem("report-1");
assert.deepEqual(useReportStore.getState().items, []);

useReportStore.getState().loadFromProject([
  makeReportItem({ id: "report-2", name: "Report 2" }),
  makeReportItem({ id: "report-5", name: "Report 5" }),
  makeReportItem({ id: "custom", name: "Notes" }),
]);
assert.deepEqual(useReportStore.getState().items.map((item) => item.name), ["Report 2", "Report 5", "Notes"]);
assert.equal(useReportStore.getState().counter, 5);
assert.equal(useReportStore.getState().nextName(), "Report 6");

useProjectStore.setState({ readOnly: true });

assert.throws(() => useReportStore.getState().addItem(makeReportItem({ id: "blocked", name: "Report 9" })), /read-only/i);
assert.throws(() => useReportStore.getState().updateMarkdown("report-2", "blocked", "2026-09-02T10:10:00.000Z"), /read-only/i);
assert.throws(() => useReportStore.getState().renameItem("report-2", "Report 8"), /read-only/i);
assert.throws(() => useReportStore.getState().deleteItem("report-2"), /read-only/i);
assert.throws(() => useReportStore.getState().nextName(), /read-only/i);

useReportStore.getState().loadFromProject([makeReportItem({ id: "report-8", name: "Report 8" })]);
assert.deepEqual(useReportStore.getState().items.map((item) => item.name), ["Report 8"]);
assert.equal(useReportStore.getState().counter, 8);

useReportStore.getState().reset();
assert.deepEqual(useReportStore.getState().items, []);
assert.equal(useReportStore.getState().counter, 0);

useProjectStore.setState({ readOnly: false });
assert.equal(useReportStore.getState().nextName(), "Report 1");

console.log("report store contract passed");
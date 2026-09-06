import assert from "node:assert/strict";

import { createSampleEcdfOption } from "../src/components/analysis/SampleAnalysisGraphExamples.tsx";

const optionFactory = createSampleEcdfOption("DIM1");
const result = optionFactory({
  panelIndex: 0,
  title: "",
  option: {
    xAxis: [{ type: "value", name: "" }],
    yAxis: [{ type: "category", data: [""] }],
    series: [{ type: "line", data: [[0, 54.8], [0.5, 99.1], [1, 145.3]] }],
  },
});

assert.deepEqual(result.xAxis, [{ type: "value", name: "DIM1" }]);
assert.deepEqual(result.yAxis, [{
  type: "value",
  name: "Cumulative probability",
  data: undefined,
  min: 0,
  max: 1,
}]);
assert.deepEqual(result.series, [{
  type: "line",
  data: [[54.8, 0], [99.1, 0.5], [145.3, 1]],
  step: "end",
  smooth: false,
  showSymbol: false,
  lineStyle: { width: 2 },
  areaStyle: { opacity: 0.12 },
}]);

const objectAxisResult = optionFactory({
  panelIndex: 0,
  title: "",
  option: {
    xAxis: { type: "value", name: "" },
    yAxis: { type: "category", data: [""], axisLabel: { formatter: (value: string) => value } },
    series: [{ type: "line", data: [[0, 87.4], [1, 121.3]] }],
  },
});
assert.deepEqual(objectAxisResult.xAxis, { type: "value", name: "DIM1" });
assert.deepEqual(objectAxisResult.yAxis, {
  type: "value",
  name: "Cumulative probability",
  data: undefined,
  min: 0,
  max: 1,
  axisLabel: { formatter: undefined },
});

console.log("Sample Analysis graph example contract passed");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type CompatibilityStatus =
  | "documentedCompatible"
  | "validatedCompatible"
  | "compatibilityPending"
  | "intentionalDifference";

type VisualCase = {
  caseId: string;
  compatibilityStatus: CompatibilityStatus;
  expected: unknown;
  input: unknown;
  inputHash: string;
  jmpVersion: string;
  methodId: string;
  schemaVersion: string;
};

type CompareResult = {
  caseId: string;
  status: CompatibilityStatus;
  compatible: boolean;
};

type NormalInput = {
  values: number[];
  frequencies?: number[];
  mode: string;
};

type NormalExpected = {
  formula: string;
  observedValues: number[];
  probabilities: number[];
  normalScores: number[];
  recorded: string;
};

const MAX_DOCUMENTED_NORMAL_COMPACT_VALUES = 32;
const MAX_DOCUMENTED_NORMAL_LOGICAL_VALUES = 64;

const FIXTURE_PATH = new URL("./fixtures/distribution/jmp19-visual-diagnostics-v1.json", import.meta.url);

const parseCases = (): VisualCase[] => {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { schemaVersion: string; cases: VisualCase[] };
  assert.equal(parsed.schemaVersion, "1");
  assert.ok(Array.isArray(parsed.cases));
  return parsed.cases;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;

const MACHINE_ENUM_ALLOWLIST = new Set<string>([
  "machineOnly",
  "missingEvidence",
  "count",
  "probability",
  "density",
  "weightUnsupported",
  "tiesRulePending",
  "freqPending",
  "n1To20",
  "outlier",
  "constant",
  "mixedSign",
  "narrowDecimal",
  "boundary",
  "documentedFormula",
  "pendingOnly",
  "recorded",
  "ties",
  "freq",
  "weight",
  "positive",
  "negative",
  "zero",
  "decimal",
  "repeated",
  "extremeScale",
  "unique",
  "freqUnique",
]);

const BANNED_KEY_PATTERN = /(screenshot|image|helpText|helpBody|path|columnName|rawOutput|notes|comment)/i;

const isAllowedEnum = (value: string): boolean =>
  MACHINE_ENUM_ALLOWLIST.has(value);

const assertMachineValueShape = (value: unknown, path: string): void => {
  if (value === null) return;
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMachineValueShape(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    assert.ok(isAllowedEnum(value), `${path} contains non-machine enum string`);
    return;
  }
  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      assert.match(key, /^[a-z][a-zA-Z0-9]*$/);
      assert.doesNotMatch(key, BANNED_KEY_PATTERN);
      assertMachineValueShape(child, `${path}.${key}`);
    });
    return;
  }
  assert.fail(`${path} contains unsupported value type`);
};

const expandFrequencies = (values: number[], frequencies?: number[]): number[] => {
  if (frequencies === undefined) return values.slice();

  assert.equal(values.length, frequencies.length, "frequencies length must match values length");
  const expanded: number[] = [];
  values.forEach((value, index) => {
    const freq = frequencies[index];
    assert.ok(Number.isInteger(freq) && freq > 0, "frequency must be a positive integer");
    for (let i = 0; i < freq; i += 1) {
      expanded.push(value);
    }
  });
  return expanded;
};

const hasTies = (values: number[]): boolean => {
  const sorted = values.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      return true;
    }
  }
  return false;
};

const compatibleFloat = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= 1e-10 ||
  Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected));

const inverseNormalCdf = (p: number): number => {
  assert.ok(Number.isFinite(p) && p > 0 && p < 1, "p must be in (0,1)");

  const a1 = -39.69683028665376;
  const a2 = 220.9460984245205;
  const a3 = -275.9285104469687;
  const a4 = 138.357751867269;
  const a5 = -30.66479806614716;
  const a6 = 2.506628277459239;

  const b1 = -54.47609879822406;
  const b2 = 161.5858368580409;
  const b3 = -155.6989798598866;
  const b4 = 66.80131188771972;
  const b5 = -13.28068155288572;

  const c1 = -0.007784894002430293;
  const c2 = -0.3223964580411365;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;

  const d1 = 0.007784695709041462;
  const d2 = 0.3224671290700398;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }

  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
  }

  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
};

const compareDocumentedNormal = (caseItem: VisualCase): CompareResult => {
  const typedInput = caseItem.input as NormalInput;
  const typedExpected = caseItem.expected as NormalExpected;

  assert.equal(typedInput.mode, "machineOnly");
  assert.ok(typedInput.values.length > 0, "documented normal compact values cannot be empty");
  assert.ok(
    typedInput.values.length <= MAX_DOCUMENTED_NORMAL_COMPACT_VALUES,
    "documented normal compact fixture must stay bounded",
  );
  typedInput.values.forEach((value) => assert.ok(Number.isFinite(value), "normal input value must be finite"));

  const logicalValues = expandFrequencies(typedInput.values, typedInput.frequencies);
  assert.ok(logicalValues.length > 0, "logical sample cannot be empty");
  assert.ok(
    logicalValues.length <= MAX_DOCUMENTED_NORMAL_LOGICAL_VALUES,
    "documented normal logical fixture must stay bounded",
  );
  logicalValues.forEach((value) => assert.ok(Number.isFinite(value), "normal logical value must be finite"));

  const observedValues = logicalValues.slice().sort((a, b) => a - b);
  assert.equal(hasTies(observedValues), false, "documented normal cases must be tie-free until ties semantics is evidenced");

  assert.equal(typedExpected.formula, "documentedFormula");
  assert.equal(typedExpected.recorded, "recorded");
  assert.equal(typedExpected.observedValues.length, observedValues.length);
  assert.deepEqual(typedExpected.observedValues, observedValues);
  assert.equal(typedExpected.probabilities.length, typedExpected.normalScores.length);
  assert.equal(typedExpected.probabilities.length, observedValues.length);

  typedExpected.probabilities.forEach((actualP, i) => {
    const rank = i + 1;
    const expectedP = rank / (observedValues.length + 1);
    const expectedZ = inverseNormalCdf(expectedP);
    assert.ok(compatibleFloat(actualP, expectedP));
    assert.ok(compatibleFloat(typedExpected.normalScores[i], expectedZ));
  });

  return {
    caseId: caseItem.caseId,
    status: "documentedCompatible",
    compatible: true,
  };
};

const buildDocumentedNormalCase = (
  caseId: string,
  values: number[],
  expectedObservedValues: number[],
  frequencies?: number[],
): VisualCase => {
  const input: NormalInput = {
    values,
    mode: "machineOnly",
    ...(frequencies === undefined ? {} : { frequencies }),
  };

  const logicalLength = frequencies === undefined
    ? values.length
    : frequencies.reduce((acc, freq) => acc + freq, 0);

  const probabilities = Array.from({ length: logicalLength }, (_, index) => (index + 1) / (logicalLength + 1));
  const normalScores = probabilities.map((p) => inverseNormalCdf(p));

  return {
    caseId,
    compatibilityStatus: "documentedCompatible",
    expected: {
      formula: "documentedFormula",
      observedValues: expectedObservedValues,
      probabilities,
      normalScores,
      recorded: "recorded",
    },
    input,
    inputHash: sha256(input),
    jmpVersion: "19",
    methodId: "normalScore.documented.rankOverNPlus1",
    schemaVersion: "1",
  };
};

const assertDocumentedNormalMutationGuards = (): void => {
  const baseline = buildDocumentedNormalCase(
    "normalscore.documented.mutation.guard",
    [3, -1, 2],
    [-1, 2, 3],
  );
  compareDocumentedNormal(baseline);

  const wrongOrderCase: VisualCase = {
    ...baseline,
    caseId: "normalscore.documented.mutation.guard.wrongorder",
    expected: {
      ...(baseline.expected as NormalExpected),
      observedValues: [2, -1, 3],
    },
  };
  assert.throws(() => compareDocumentedNormal(wrongOrderCase));

  const wrongValueCase: VisualCase = {
    ...baseline,
    caseId: "normalscore.documented.mutation.guard.wrongvalue",
    expected: {
      ...(baseline.expected as NormalExpected),
      observedValues: [-1, 2, 4],
    },
  };
  assert.throws(() => compareDocumentedNormal(wrongValueCase));
};

assertDocumentedNormalMutationGuards();

const compareCase = (caseItem: VisualCase): CompareResult => {
  const forcedPendingMethods = [
    "histogram.jmpAuto",
    "normalScore.pending",
  ];

  if (forcedPendingMethods.some((prefix) => caseItem.methodId.startsWith(prefix))) {
    return {
      caseId: caseItem.caseId,
      status: "compatibilityPending",
      compatible: false,
    };
  }

  if (caseItem.methodId.startsWith("normalScore.documented")) {
    return compareDocumentedNormal(caseItem);
  }

  return {
    caseId: caseItem.caseId,
    status: caseItem.compatibilityStatus,
    compatible: caseItem.compatibilityStatus === "documentedCompatible" || caseItem.compatibilityStatus === "validatedCompatible",
  };
};

const cases = parseCases();

assert.ok(cases.length > 0);
for (const caseItem of cases) {
  assert.deepEqual(Object.keys(caseItem).sort(), [
    "caseId",
    "compatibilityStatus",
    "expected",
    "input",
    "inputHash",
    "jmpVersion",
    "methodId",
    "schemaVersion",
  ]);

  assert.equal(caseItem.schemaVersion, "1");
  assert.match(caseItem.inputHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(caseItem.inputHash, sha256(caseItem.input));

  assert.match(caseItem.caseId, /^[a-z0-9]+(\.[a-z0-9]+)+$/);
  assert.match(caseItem.methodId, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/);
  assert.equal(caseItem.jmpVersion, "19");

  assertMachineValueShape(caseItem.input, "input");
  assertMachineValueShape(caseItem.expected, "expected");

  Object.keys(caseItem).forEach((key) => assert.doesNotMatch(key, BANNED_KEY_PATTERN));
  const serialized = JSON.stringify(caseItem);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\|\/Users\//);
}

const results = cases.map(compareCase);

for (const result of results) {
  const caseItem = cases.find((item) => item.caseId === result.caseId);
  assert.ok(caseItem, `missing case for result ${result.caseId}`);
  assert.equal(result.status, caseItem.compatibilityStatus);

  if (caseItem.methodId.startsWith("histogram.jmpAuto")) {
    assert.equal(result.compatible, false);
  }
}

const documentedCompatibleIds = results
  .filter((item) => item.status === "documentedCompatible")
  .map((item) => item.caseId)
  .sort();
const compatibilityPendingIds = results
  .filter((item) => item.status === "compatibilityPending")
  .map((item) => item.caseId)
  .sort();

assert.deepEqual(documentedCompatibleIds, [
  "normalscore.documented.freq.n5.unique",
  "normalscore.documented.n1.unique",
  "normalscore.documented.n10.unique",
  "normalscore.documented.n2.unique",
  "normalscore.documented.n3.unique",
  "normalscore.documented.n5.unique",
]);

const requiredPendingIds = [
  "histogram.jmpauto.pending.boundary.count",
  "histogram.jmpauto.pending.constant.probability",
  "histogram.jmpauto.pending.mixedsign.density",
  "histogram.jmpauto.pending.narrowdecimal.count",
  "histogram.jmpauto.pending.outlier.probability",
  "normalscore.pending.ties.n5",
];

requiredPendingIds.forEach((id) => {
  assert.ok(compatibilityPendingIds.includes(id), `missing required pending case ${id}`);
});

const histogramCases = cases.filter(
  (item) => item.methodId.startsWith("histogram.jmpAuto") && item.compatibilityStatus === "compatibilityPending",
);
const histogramClasses = new Set(
  histogramCases.map((item) => (item.input as Record<string, unknown>).datasetClass),
);
const histogramScales = new Set(
  histogramCases.map((item) => (item.input as Record<string, unknown>).scale),
);
assert.deepEqual(new Set(["constant", "narrowDecimal", "mixedSign", "outlier", "boundary"]), histogramClasses);
assert.deepEqual(new Set(["count", "probability", "density"]), histogramScales);

const tiePending = cases.find((item) => item.caseId === "normalscore.pending.ties.n5");
assert.ok(tiePending, "missing normal ties pending case");
assert.equal(tiePending.compatibilityStatus, "compatibilityPending");

assert.ok(compatibilityPendingIds.length >= requiredPendingIds.length);

const distributionCss = readFileSync(
  new URL("../src/components/distribution/distribution.css", import.meta.url),
  "utf8",
);
const viewSource = readFileSync(
  new URL("../src/components/distribution/DistributionView.tsx", import.meta.url),
  "utf8",
);

assert.match(distributionCss, /\.distribution-view\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(distributionCss, /\.distribution-graph-runtime\s*\{[^}]*height:\s*clamp\(/s);
assert.doesNotMatch(distributionCss, /\.distribution-graph-(?:grid|region|runtime)\s*\{[^}]*overflow-y:\s*auto/s);
assert.equal((viewSource.match(/className="distribution-view"/g) ?? []).length, 1);
assert.doesNotMatch(viewSource, /distribution-workspace|distribution-chart/);

console.log("distribution visual compatibility contracts OK");

export const TABULATE_QUALIFICATION_SOURCE_ROWS = 10_000_000;
export const TABULATE_LOGICAL_CELL_TIERS = Object.freeze([100_000, 1_000_000, 10_000_000]);
export const TABULATE_MIN_SETTLED_SAMPLES = 30;

const REQUIRED_SAMPLE_KEYS = Object.freeze([
  "tilePayloadBytes",
  "backendTileMs",
]);
const OPTIONAL_LAYER_KEYS = Object.freeze(["ipcRoundTripMs", "visibleInteractionMs"]);

const isNonNegativeFinite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function buildTabulateBenchmarkMatrix() {
  return TABULATE_LOGICAL_CELL_TIERS.map((logicalCells) => ({
    sourceRows: TABULATE_QUALIFICATION_SOURCE_ROWS,
    logicalCells,
    samples: TABULATE_MIN_SETTLED_SAMPLES,
  }));
}

export function parseTabulateBenchmarkArgs(args = []) {
  const values = {
    sourceRows: TABULATE_QUALIFICATION_SOURCE_ROWS,
    logicalCells: 1_000_000,
    samples: TABULATE_MIN_SETTLED_SAMPLES,
  };
  const keys = new Map([
    ["source-rows", "sourceRows"],
    ["logical-cells", "logicalCells"],
    ["samples", "samples"],
  ]);

  for (const argument of args) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    const key = match ? keys.get(match[1]) : undefined;
    if (!match || !key) {
      throw new Error(`Unknown Tabulate benchmark argument: ${argument}`);
    }
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${match[1]} must be an integer`);
    }
    values[key] = value;
  }

  if (!isPositiveInteger(values.sourceRows) || values.sourceRows > TABULATE_QUALIFICATION_SOURCE_ROWS) {
    throw new Error("Source rows must be between 1 and 10,000,000");
  }
  if (!isPositiveInteger(values.logicalCells) || values.logicalCells > 10_000_000) {
    throw new Error("Logical cells must be between 1 and 10,000,000");
  }
  if (!isPositiveInteger(values.samples) || values.samples > 300) {
    throw new Error("Samples must be between 1 and 300");
  }

  return {
    ...values,
    qualification: values.sourceRows === TABULATE_QUALIFICATION_SOURCE_ROWS
      && TABULATE_LOGICAL_CELL_TIERS.includes(values.logicalCells)
      && values.samples >= TABULATE_MIN_SETTLED_SAMPLES,
  };
}

export function summarizeSettledSamples(values) {
  if (!Array.isArray(values) || values.length < TABULATE_MIN_SETTLED_SAMPLES
    || !values.every(isNonNegativeFinite)) {
    throw new Error(`At least ${TABULATE_MIN_SETTLED_SAMPLES} settled samples are required`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
  };
}

export function validateTabulateBenchmarkPayload(payload) {
  const failures = [];
  const requiredPositive = ["sourceRows", "rowMembers", "columnMembers", "statisticCount", "logicalCells"];
  const requiredMetrics = [
    "nonemptyGroups",
    "memberIndexBytes",
    "wholeProcessRssBytes",
    "preparationMs",
    "totalsMs",
    "cancellationLatencyMs",
  ];

  for (const key of requiredPositive) {
    if (!isPositiveInteger(payload?.[key])) failures.push(`${key} must be a positive integer`);
  }
  for (const key of requiredMetrics) {
    if (!isNonNegativeFinite(payload?.[key])) failures.push(`${key} must be a non-negative finite number`);
  }

  const metrics = {};
  for (const key of REQUIRED_SAMPLE_KEYS) {
    const values = payload?.[key];
    if (payload?.outcome === "controlled_refusal" && Array.isArray(values) && values.length === 0) {
      metrics[key] = { sampleCount: 0, p50: null, p95: null };
      continue;
    }
    if (!Array.isArray(values) || values.length === 0 || !values.every(isNonNegativeFinite)) {
      failures.push(`${key} must contain finite non-negative samples`);
      metrics[key] = { sampleCount: Array.isArray(values) ? values.length : 0, p50: null, p95: null };
      continue;
    }
    if (values.length >= TABULATE_MIN_SETTLED_SAMPLES) {
      metrics[key] = { sampleCount: values.length, ...summarizeSettledSamples(values) };
    } else {
      metrics[key] = { sampleCount: values.length, p50: null, p95: null };
      if (payload?.qualification !== false) {
        failures.push(`${key} requires ${TABULATE_MIN_SETTLED_SAMPLES} settled samples for qualification`);
      }
    }
  }
  for (const key of OPTIONAL_LAYER_KEYS) {
    const layer = payload?.[key];
    if (layer?.status === "unmeasured" && Array.isArray(layer.samples) && layer.samples.length === 0) {
      metrics[key] = { status: "unmeasured", sampleCount: 0, p50: null, p95: null };
      continue;
    }
    failures.push(`${key} must be explicitly unmeasured when no production-layer samples exist`);
    metrics[key] = { status: "invalid", sampleCount: 0, p50: null, p95: null };
  }

  if (payload?.outcome === "completed") {
    if (payload.exactReturnedCells !== true) failures.push("completed outcome requires exact returned cells");
    if (isNonNegativeFinite(payload.nonemptyGroups) && payload.nonemptyGroups > payload.logicalCells) {
      failures.push("nonemptyGroups cannot exceed logicalCells");
    }
  } else if (payload?.outcome === "controlled_refusal") {
    if (typeof payload.refusalCode !== "string" || payload.refusalCode.length === 0) {
      failures.push("controlled refusal requires refusalCode");
    }
  } else {
    failures.push("outcome must be completed or controlled_refusal");
  }

  return {
    valid: failures.length === 0,
    failures,
    qualification: payload?.qualification === true
      && payload?.outcome === "completed"
      && failures.length === 0,
    memory: {
      memberIndexBytes: payload?.memberIndexBytes,
      wholeProcessRssBytes: payload?.wholeProcessRssBytes,
    },
    metrics,
  };
}

function nearestRank(sorted, rank) {
  return sorted[Math.ceil((rank / 100) * sorted.length) - 1];
}

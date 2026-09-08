import type {
  FitModelInferenceReason,
  FitModelSnapshot,
} from "@/types/fitModel";

const DEFAULT_SCAN_POINTS = 101;
const MAX_SCAN_POINTS = 101;

export interface FitModelPointPrediction {
  predicted: number;
  meanConfidenceLower: number | null;
  meanConfidenceUpper: number | null;
  predictionLower: number | null;
  predictionUpper: number | null;
  inferenceReason: FitModelInferenceReason | null;
  extrapolatedColumns: string[];
}

export interface FitModelProfilerPoint extends FitModelPointPrediction {
  value: number;
}

function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Fit Model prediction requires finite ${label}`);
  }
  return value;
}

function featureVector(
  snapshot: FitModelSnapshot,
  values: Readonly<Record<string, number>>,
): number[] {
  const expectedIds = ["Intercept", ...snapshot.terms.map((term) => term.termId)];
  if (
    expectedIds.length !== snapshot.coefficients.length
    || expectedIds.length !== snapshot.coefficientTermIds.length
    || expectedIds.some((id, index) => snapshot.coefficientTermIds[index] !== id)
    || snapshot.coefficients.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Fit Model snapshot coefficient order or dimensions are invalid");
  }

  const centers = new Map(snapshot.centering.centers.map((center) => [center.columnName, assertFinite(center.mean, `center ${center.columnName}`)]));
  const valueFor = (columnName: string): number => {
    const value = values[columnName];
    if (typeof value !== "number") {
      throw new Error(`Fit Model prediction is missing ${columnName}`);
    }
    return assertFinite(value, `value ${columnName}`);
  };
  const centeredValue = (columnName: string): number => {
    const value = valueFor(columnName);
    if (snapshot.centering.method === "none") return value;
    const center = centers.get(columnName);
    if (center === undefined) throw new Error(`Fit Model prediction is missing center ${columnName}`);
    return value - center;
  };

  const vector = [1];
  for (const term of snapshot.terms) {
    let feature: number;
    if (term.kind === "main") {
      if (term.columnNames.length !== 1) throw new Error(`Invalid main term ${term.termId}`);
      feature = valueFor(term.columnNames[0]);
    } else if (term.kind === "power") {
      if (term.columnNames.length !== 1) throw new Error(`Invalid power term ${term.termId}`);
      feature = centeredValue(term.columnNames[0]) ** 2;
    } else {
      if (term.columnNames.length < 2) throw new Error(`Invalid interaction term ${term.termId}`);
      feature = term.columnNames.reduce((product, columnName) => product * centeredValue(columnName), 1);
    }
    vector.push(assertFinite(feature, `feature ${term.termId}`));
  }
  return vector;
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const adjusted = value - 1;
  let series = 0.9999999999998099;
  coefficients.forEach((coefficient, index) => {
    series += coefficient / (adjusted + index + 1);
  });
  const shifted = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(shifted) - shifted + Math.log(series);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const epsilon = 3e-14;
  const floor = 1e-300;
  const maxIterations = 200;
  const sum = a + b;
  const aPlusOne = a + 1;
  const aMinusOne = a - 1;
  let c = 1;
  let denominator = 1 - (sum * x) / aPlusOne;
  if (Math.abs(denominator) < floor) denominator = floor;
  denominator = 1 / denominator;
  let result = denominator;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const even = 2 * iteration;
    let coefficient = (iteration * (b - iteration) * x) / ((aMinusOne + even) * (a + even));
    denominator = 1 + coefficient * denominator;
    if (Math.abs(denominator) < floor) denominator = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    denominator = 1 / denominator;
    result *= denominator * c;

    coefficient = -((a + iteration) * (sum + iteration) * x) / ((a + even) * (a + even + 1));
    denominator = 1 + coefficient * denominator;
    if (Math.abs(denominator) < floor) denominator = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    denominator = 1 / denominator;
    const delta = denominator * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const scale = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2)
    ? (scale * betaContinuedFraction(a, b, x)) / a
    : 1 - (scale * betaContinuedFraction(b, a, 1 - x)) / b;
}

function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (value === 0) return 0.5;
  const beta = regularizedBeta(degreesOfFreedom / (degreesOfFreedom + value * value), degreesOfFreedom / 2, 0.5);
  return value > 0 ? 1 - beta / 2 : beta / 2;
}

function studentTQuantile(probability: number, degreesOfFreedom: number): number {
  if (!(probability > 0 && probability < 1) || !(degreesOfFreedom > 0)) return Number.NaN;
  if (probability < 0.5) return -studentTQuantile(1 - probability, degreesOfFreedom);
  let lower = 0;
  let upper = 1;
  while (studentTCdf(upper, degreesOfFreedom) < probability && upper < 1e10) upper *= 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (studentTCdf(midpoint, degreesOfFreedom) < probability) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

export function predictFitModelPoint(
  snapshot: FitModelSnapshot,
  values: Readonly<Record<string, number>>,
): FitModelPointPrediction {
  if (Object.values(values).some((value) => !Number.isFinite(value))) {
    throw new Error("Fit Model prediction requires finite values");
  }
  const vector = featureVector(snapshot, values);
  const predicted = assertFinite(vector.reduce((sum, feature, index) => sum + feature * snapshot.coefficients[index], 0), "prediction");
  const extrapolatedColumns = snapshot.predictorRanges
    .filter((range) => {
      const value = values[range.columnName];
      if (typeof value !== "number") throw new Error(`Fit Model prediction is missing ${range.columnName}`);
      assertFinite(range.minimum, `minimum ${range.columnName}`);
      assertFinite(range.maximum, `maximum ${range.columnName}`);
      assertFinite(value, `value ${range.columnName}`);
      return value < range.minimum || value > range.maximum;
    })
    .map((range) => range.columnName);

  const covariance = snapshot.covariance;
  const mse = snapshot.meanSquareError;
  const size = vector.length;
  const inferenceValid = covariance !== null
    && typeof mse === "number"
    && Number.isFinite(mse)
    && mse > 0
    && snapshot.errorDegreesOfFreedom > 0
    && snapshot.confidenceLevel > 0
    && snapshot.confidenceLevel < 1
    && covariance.length === size
    && covariance.every((row) => row.length === size && row.every(Number.isFinite));
  if (!inferenceValid || covariance === null || mse === null) {
    return { predicted, meanConfidenceLower: null, meanConfidenceUpper: null, predictionLower: null, predictionUpper: null, inferenceReason: "inferenceNotEstimable", extrapolatedColumns };
  }

  const meanVariance = vector.reduce((total, rowValue, row) => total + covariance[row].reduce(
    (sum, covarianceValue, column) => sum + rowValue * covarianceValue * vector[column],
    0,
  ), 0);
  const critical = studentTQuantile(0.5 + snapshot.confidenceLevel / 2, snapshot.errorDegreesOfFreedom);
  if (!Number.isFinite(meanVariance) || meanVariance < 0 || !Number.isFinite(critical)) {
    return { predicted, meanConfidenceLower: null, meanConfidenceUpper: null, predictionLower: null, predictionUpper: null, inferenceReason: "inferenceNotEstimable", extrapolatedColumns };
  }
  const meanMargin = critical * Math.sqrt(meanVariance);
  const predictionMargin = critical * Math.sqrt(mse + meanVariance);
  const bounds = [predicted - meanMargin, predicted + meanMargin, predicted - predictionMargin, predicted + predictionMargin];
  if (!bounds.every(Number.isFinite)) {
    return { predicted, meanConfidenceLower: null, meanConfidenceUpper: null, predictionLower: null, predictionUpper: null, inferenceReason: "inferenceNotEstimable", extrapolatedColumns };
  }
  return {
    predicted,
    meanConfidenceLower: bounds[0],
    meanConfidenceUpper: bounds[1],
    predictionLower: bounds[2],
    predictionUpper: bounds[3],
    inferenceReason: null,
    extrapolatedColumns,
  };
}

export function scanFitModelPredictor(
  snapshot: FitModelSnapshot,
  values: Readonly<Record<string, number>>,
  columnName: string,
  points = DEFAULT_SCAN_POINTS,
): FitModelProfilerPoint[] {
  const range = snapshot.predictorRanges.find((candidate) => candidate.columnName === columnName);
  if (!range) throw new Error(`Fit Model predictor range is missing ${columnName}`);
  const count = Math.min(MAX_SCAN_POINTS, Math.max(2, Math.trunc(points)));
  assertFinite(range.minimum, `minimum ${columnName}`);
  assertFinite(range.maximum, `maximum ${columnName}`);
  return Array.from({ length: count }, (_, index) => {
    const value = range.minimum + ((range.maximum - range.minimum) * index) / (count - 1);
    return { value, ...predictFitModelPoint(snapshot, { ...values, [columnName]: value }) };
  });
}

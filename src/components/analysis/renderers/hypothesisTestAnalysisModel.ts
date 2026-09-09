import type {
  HypothesisTestMethodResult,
  HypothesisTestResponse,
  HypothesisTestValue,
} from "@/types/hypothesisTest";

export interface HypothesisTestDisplaySection {
  key: string;
  title: string;
  columns: Array<{ key: string; label: string; numeric?: boolean; rowHeader?: boolean }>;
  rows: Array<{ key: string; cells: Array<string | number> }>;
  defaultExpanded?: boolean;
}

export interface HypothesisTestDisplayModel {
  conclusion: string;
  robustness: string | null;
  primary: HypothesisTestDisplaySection;
  sections: HypothesisTestDisplaySection[];
}

function formatNumber(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) < 0.0001 || Math.abs(value) >= 1_000_000) return value.toExponential(4);
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);
}

export function formatHypothesisTestValue(value: HypothesisTestValue): string {
  return value.state === "available" ? formatNumber(value.value) : `Unavailable: ${value.reason}`;
}

function primaryRows(result: HypothesisTestMethodResult) {
  return [
    { key: "estimate", cells: [result.estimate.estimand, formatHypothesisTestValue(result.estimate.estimate)] },
    { key: "interval", cells: [`${formatNumber(result.estimate.confidenceLevel * 100)}% interval`, `${formatHypothesisTestValue(result.estimate.lower)} to ${formatHypothesisTestValue(result.estimate.upper)}`] },
    { key: "effect", cells: [result.effectSize.kind, formatHypothesisTestValue(result.effectSize.estimate)] },
    { key: "statistic", cells: [result.statisticName, formatNumber(result.statistic)] },
    { key: "df", cells: ["Degrees of freedom", result.degreesOfFreedom.map(formatNumber).join(", ") || "N/A"] },
    { key: "p", cells: ["p-value", formatNumber(result.pValue)] },
  ];
}

export function createHypothesisTestDisplayModel(
  response: HypothesisTestResponse,
): HypothesisTestDisplayModel {
  const conflicting = response.sensitivityResults.find(
    (entry) => entry.robustness === "substantivelyConflicting" || entry.robustness === "statisticallySensitive",
  );
  const conclusion = response.primaryResult.conclusion === "difference"
    ? `Evidence supports a difference (${response.selectionDecision.executedMethod}).`
    : `Evidence is insufficient to establish a difference (${response.selectionDecision.executedMethod}).`;
  const sections: HypothesisTestDisplaySection[] = [
    {
      key: "evidence",
      title: "Method evidence",
      columns: [
        { key: "code", label: "Evidence", rowHeader: true },
        { key: "grade", label: "Assessment" },
        { key: "value", label: "Value", numeric: true },
      ],
      rows: response.diagnostics.map((entry, index) => ({
        key: `${entry.code}-${index}`,
        cells: [entry.code, entry.grade, formatHypothesisTestValue(entry.value)],
      })),
    },
    {
      key: "sensitivity",
      title: "Sensitivity analysis",
      columns: [
        { key: "method", label: "Method", rowHeader: true },
        { key: "robustness", label: "Robustness" },
        { key: "estimate", label: "Estimate", numeric: true },
        { key: "p", label: "p-value", numeric: true },
      ],
      rows: response.sensitivityResults.map((entry) => ({
        key: entry.method.methodId,
        cells: [
          entry.method.methodId,
          entry.robustness,
          formatHypothesisTestValue(entry.method.estimate.estimate),
          formatNumber(entry.method.pValue),
        ],
      })),
    },
  ];

  if (response.postHocResult) {
    sections.push({
      key: "postHoc",
      title: `Post-hoc comparisons: ${response.postHocResult.family}`,
      columns: [
        { key: "comparison", label: "Comparison", rowHeader: true },
        { key: "estimate", label: "Estimate", numeric: true },
        { key: "adjustedP", label: "Adjusted p-value", numeric: true },
        { key: "interval", label: "Simultaneous interval" },
      ],
      rows: response.postHocResult.comparisons.map((entry) => ({
        key: `${entry.left}:${entry.right}`,
        cells: [
          `${entry.left} vs ${entry.right}`,
          formatHypothesisTestValue(entry.estimate),
          formatNumber(entry.adjustedPValue),
          `${formatHypothesisTestValue(entry.lower)} to ${formatHypothesisTestValue(entry.upper)}`,
        ],
      })),
    });
  }

  sections.push(
    {
      key: "exclusions",
      title: "Excluded observations",
      columns: [
        { key: "identity", label: "Identity", rowHeader: true },
        { key: "condition", label: "Condition" },
        { key: "reason", label: "Reason" },
      ],
      rows: response.exclusions.map((entry, index) => ({
        key: `${entry.identity}-${index}`,
        cells: [entry.identity, entry.condition ?? "N/A", entry.reasonCode],
      })),
      defaultExpanded: false,
    },
    {
      key: "audit",
      title: "Method audit",
      columns: [
        { key: "field", label: "Field", rowHeader: true },
        { key: "value", label: "Value" },
      ],
      rows: [
        { key: "selector", cells: ["Selector version", response.methodAudit.selectorVersion] },
        { key: "method", cells: ["Method version", response.methodAudit.methodVersion] },
        { key: "formula", cells: ["Formula version", response.methodAudit.formulaVersion] },
        { key: "path", cells: ["Inference path", response.methodAudit.inferencePath] },
        { key: "corrections", cells: ["Corrections", response.methodAudit.correctionCodes.join(", ") || "None"] },
        { key: "executed", cells: ["Executed at", response.methodAudit.executedAt] },
      ],
      defaultExpanded: false,
    },
  );

  return {
    conclusion,
    robustness: conflicting ? `Sensitivity warning: ${conflicting.robustness} (${conflicting.method.methodId}).` : null,
    primary: {
      key: "primary",
      title: "Primary result",
      columns: [
        { key: "quantity", label: "Quantity", rowHeader: true },
        { key: "value", label: "Value", numeric: true },
      ],
      rows: primaryRows(response.primaryResult),
    },
    sections,
  };
}
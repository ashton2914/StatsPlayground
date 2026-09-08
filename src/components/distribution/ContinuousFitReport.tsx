import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { AnalysisStack, AnalysisTable, AnalysisText } from "@/components/analysis/presentation";
import type {
  CapabilityTypedValueV1,
  ContinuousDistributionIdV1,
  DistributionFitComparisonDataV1,
  DistributionFitDataV1,
  DistributionFitParameterV1,
} from "@/types/distribution";

function formatValue(value: CapabilityTypedValueV1, t?: TFunction): string {
  if (value.state !== "available" || value.value === null || !Number.isFinite(value.value)) {
    return value.reasonCode && t ? formatReason(t, value.reasonCode) : value.reasonCode ?? "—";
  }
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(value.value);
}

function reasonCategory(code: string): string | null {
  if (!code.startsWith("distribution.fit.")) return null;
  if (code.includes("DomainInvalid")) return "domainInvalid";
  if (code.includes("constantSample")) return "constantSample";
  if (code.includes("observationsEmpty")) return "observationsEmpty";
  if (code.includes("optimizer") || code.includes("iterationLimit") || code.includes("toleranceInvalid")) return "optimizationFailed";
  if (code.includes("curve") || code.includes("pdf")) return "curveInvalid";
  if (code.includes("Likelihood") || code.includes("Criteria") || code.includes("aicc")) return "metricInvalid";
  if (code.includes("parameterInference") || code.includes("parameterInformation") || code.includes("parameterInterval")) return "parameterInferenceUnavailable";
  if (code.includes("estimate")) return "estimateInvalid";
  if (code.includes("observation") || code.includes("effectiveN") || code.includes("positiveTransform")) return "inputInvalid";
  return null;
}

function formatReason(t: TFunction, code: string): string {
  const category = reasonCategory(code);
  return category
    ? t(`distribution.fitReasons.${category}`, { defaultValue: code })
    : code;
}

function negativeTwoLogLikelihood(value: CapabilityTypedValueV1): CapabilityTypedValueV1 {
  if (value.state !== "available" || value.value === null || !Number.isFinite(value.value)) {
    return value;
  }
  return { ...value, value: -2 * value.value };
}

interface DisplayParameter {
  parameterId: string;
  labelId: string;
  estimate: CapabilityTypedValueV1;
  standardError: CapabilityTypedValueV1;
  lowerConfidence: CapabilityTypedValueV1;
  upperConfidence: CapabilityTypedValueV1;
}

function displayParameters(
  distributionId: ContinuousDistributionIdV1,
  parameters: DistributionFitParameterV1[],
): DisplayParameter[] {
  const rows = parameters.map((parameter) => {
    let labelId = parameter.parameterId;
    if (distributionId === "normal" && parameter.parameterId === "scale") labelId = "dispersion";
    if (distributionId === "lognormal" && parameter.parameterId === "logLocation") labelId = "scale";
    if (distributionId === "lognormal" && parameter.parameterId === "logScale") labelId = "shape";
    return {
      ...parameter,
      labelId,
    };
  });
  return rows;
}

export function ContinuousFitReport({ data }: { data: DistributionFitDataV1 }) {
  const { t } = useTranslation();
  const distribution = t(`distribution.fit.distributions.${data.distributionId}`, {
    defaultValue: data.distributionId,
  });

  if (data.status !== "available") {
    const reason = data.reasonCode
      ? formatReason(t, data.reasonCode)
      : t(`distribution.fit.states.${data.status}`, { defaultValue: data.status });
    return (
      <AnalysisText>
          {t("distribution.fit.unavailable", {
            defaultValue: "Fit unavailable: {{reason}}",
            reason,
          })}
      </AnalysisText>
    );
  }

  const parameters = displayParameters(data.distributionId, data.parameters);
  const measures = [
    ["negativeTwoLogLikelihood", negativeTwoLogLikelihood(data.logLikelihood)],
    ["aicc", data.aicc],
    ["bic", data.bic],
  ] as const;

  return (
    <AnalysisStack>
      <AnalysisText>
        {t(`distribution.compatibility.${data.provenance.compatibilityStatus}`)}
      </AnalysisText>
      <AnalysisTable
        title={t("distribution.fit.parameters", { defaultValue: "Parameter Estimates" })}
        width="wide"
        ariaLabel={`${distribution} ${t("distribution.fit.parameters", { defaultValue: "Parameter Estimates" })}`}
        columns={[
          { key: "parameter", label: t("distribution.fit.parameter", { defaultValue: "Parameter" }), rowHeader: true },
          { key: "estimate", label: t("distribution.fit.estimate", { defaultValue: "Estimate" }), numeric: true },
          { key: "standardError", label: t("distribution.fitStandardError", { defaultValue: "Std Error" }), numeric: true },
          { key: "lowerConfidence", label: t("distribution.fitLower95", { defaultValue: "Lower 95%" }), numeric: true },
          { key: "upperConfidence", label: t("distribution.fitUpper95", { defaultValue: "Upper 95%" }), numeric: true },
        ]}
        rows={parameters.map((parameter) => ({
          key: parameter.parameterId,
          cells: [
            t(`distribution.fit.parametersById.${parameter.labelId}`, { defaultValue: parameter.labelId }),
            formatValue(parameter.estimate, t),
            formatValue(parameter.standardError, t),
            formatValue(parameter.lowerConfidence, t),
            formatValue(parameter.upperConfidence, t),
          ],
        }))}
      />
      <AnalysisTable
        title={t("distribution.fit.measures", { defaultValue: "Measures" })}
        width="compact"
        ariaLabel={`${distribution} ${t("distribution.fit.measuresAria", { defaultValue: "measures" })}`}
        columns={[
          { key: "measure", label: t("distribution.fit.measure", { defaultValue: "Measure" }), rowHeader: true },
          { key: "value", label: t("distribution.report.value"), numeric: true },
        ]}
        rows={measures.map(([metricId, value]) => ({
          key: metricId,
          cells: [t(`distribution.fit.metrics.${metricId}`, { defaultValue: metricId }), formatValue(value)],
        }))}
      />
      {data.distributionId === "lognormal" && (
        <AnalysisText>
          {t("distribution.fit.lognormalNaturalLogNote", {
            defaultValue: "Parameters use the natural logarithm of the response.",
          })}
        </AnalysisText>
      )}
      <AnalysisText>
        {t("distribution.fit.convergence", { defaultValue: "Convergence" })}: {t(`distribution.fit.states.${data.convergence.status}`, { defaultValue: data.convergence.status })}
        {data.convergence.reasonCode ? ` (${formatReason(t, data.convergence.reasonCode)})` : ""}
      </AnalysisText>
    </AnalysisStack>
  );
}

export function ContinuousFitComparisonReport({ data }: { data: DistributionFitComparisonDataV1 }) {
  const { t } = useTranslation();
  return (
    <AnalysisTable
      title={t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}
      width="wide"
      ariaLabel={t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}
      columns={[
        { key: "distribution", label: t("distribution.fit.distribution", { defaultValue: "Distribution" }), rowHeader: true },
        { key: "aicc", label: "AICc", numeric: true },
        { key: "aic", label: "AIC", numeric: true },
        { key: "bic", label: "BIC", numeric: true },
        { key: "status", label: t("distribution.fit.status", { defaultValue: "Status" }) },
      ]}
      rows={data.rows.map((row) => ({
        key: row.distributionId,
        cells: [
          t(`distribution.fit.distributions.${row.distributionId}`, { defaultValue: row.distributionId }),
          formatValue(row.aicc),
          formatValue(row.aic),
          formatValue(row.bic),
          row.reasonCode
            ? formatReason(t, row.reasonCode)
            : t(`distribution.fit.states.${row.status}`, { defaultValue: row.status }),
        ],
      }))}
    />
  );
}

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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
      <div className="distribution-fit-report">
        <p className="distribution-report-unavailable">
          {t("distribution.fit.unavailable", {
            defaultValue: "Fit unavailable: {{reason}}",
            reason,
          })}
        </p>
      </div>
    );
  }

  const parameters = displayParameters(data.distributionId, data.parameters);
  const measures = [
    ["negativeTwoLogLikelihood", negativeTwoLogLikelihood(data.logLikelihood)],
    ["aicc", data.aicc],
    ["bic", data.bic],
  ] as const;

  return (
    <div className="distribution-fit-report">
      <p className="distribution-compatibility-status">
        {t(`distribution.compatibility.${data.provenance.compatibilityStatus}`)}
      </p>
      <div className="distribution-fit-tables">
        <table className="sp-fit-y-by-x-report-table distribution-fit-table" aria-label={`${distribution} ${t("distribution.fit.parameters", { defaultValue: "Parameter Estimates" })}`}>
          <caption>{t("distribution.fit.parameters", { defaultValue: "Parameter Estimates" })}</caption>
          <thead><tr>
            <th scope="col">{t("distribution.fit.parameter", { defaultValue: "Parameter" })}</th>
            <th scope="col">{t("distribution.fit.estimate", { defaultValue: "Estimate" })}</th>
            <th scope="col">{t("distribution.fitStandardError", { defaultValue: "Std Error" })}</th>
            <th scope="col">{t("distribution.fitLower95", { defaultValue: "Lower 95%" })}</th>
            <th scope="col">{t("distribution.fitUpper95", { defaultValue: "Upper 95%" })}</th>
          </tr></thead>
          <tbody>
            {parameters.map((parameter) => (
              <tr key={parameter.parameterId}>
                <th scope="row">{t(`distribution.fit.parametersById.${parameter.labelId}`, { defaultValue: parameter.labelId })}</th>
                <td>{formatValue(parameter.estimate, t)}</td>
                <td>{formatValue(parameter.standardError, t)}</td>
                <td>{formatValue(parameter.lowerConfidence, t)}</td>
                <td>{formatValue(parameter.upperConfidence, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="sp-fit-y-by-x-report-table distribution-fit-table" aria-label={`${distribution} ${t("distribution.fit.measuresAria", { defaultValue: "measures" })}`}>
          <caption>{t("distribution.fit.measures", { defaultValue: "Measures" })}</caption>
          <thead><tr><th scope="col">{t("distribution.fit.measure", { defaultValue: "Measure" })}</th><th scope="col">{t("distribution.report.value")}</th></tr></thead>
          <tbody>
            {measures.map(([metricId, value]) => (
              <tr key={metricId}>
                <th scope="row">{t(`distribution.fit.metrics.${metricId}`, { defaultValue: metricId })}</th>
                <td>{formatValue(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.distributionId === "lognormal" && (
        <p className="distribution-fit-parameter-note">
          {t("distribution.fit.lognormalNaturalLogNote", {
            defaultValue: "Parameters use the natural logarithm of the response.",
          })}
        </p>
      )}
      <p className="distribution-fit-convergence">
        {t("distribution.fit.convergence", { defaultValue: "Convergence" })}: {t(`distribution.fit.states.${data.convergence.status}`, { defaultValue: data.convergence.status })}
        {data.convergence.reasonCode ? ` (${formatReason(t, data.convergence.reasonCode)})` : ""}
      </p>
    </div>
  );
}

export function ContinuousFitComparisonReport({ data }: { data: DistributionFitComparisonDataV1 }) {
  const { t } = useTranslation();
  return (
    <table className="sp-fit-y-by-x-report-table distribution-fit-table distribution-fit-comparison" aria-label={t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}>
      <caption>{t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}</caption>
      <thead>
        <tr>
          <th>{t("distribution.fit.distribution", { defaultValue: "Distribution" })}</th>
          <th>AICc</th>
          <th>AIC</th>
          <th>BIC</th>
          <th>{t("distribution.fit.status", { defaultValue: "Status" })}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => (
          <tr key={row.distributionId}>
            <th scope="row">{t(`distribution.fit.distributions.${row.distributionId}`, { defaultValue: row.distributionId })}</th>
            <td>{formatValue(row.aicc)}</td>
            <td>{formatValue(row.aic)}</td>
            <td>{formatValue(row.bic)}</td>
            <td>{row.reasonCode
              ? formatReason(t, row.reasonCode)
              : t(`distribution.fit.states.${row.status}`, { defaultValue: row.status })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

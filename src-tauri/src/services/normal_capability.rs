use serde::{Deserialize, Serialize};
use statrs::distribution::{ChiSquared, ContinuousCDF, Normal};

use crate::error::AppError;
use crate::services::distribution_kernel::HistogramBinDataV1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SpecificationSourceV1 {
    ColumnProperty,
    AnalysisOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecificationLimitsV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
    pub source: SpecificationSourceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpecificationOverrideV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecificationResolutionV1 {
    pub limits: Option<SpecificationLimitsV1>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalProcessSummaryV1 {
    pub n: u64,
    pub mean: f64,
    pub moving_range_average: Option<f64>,
    pub d2: f64,
    pub within_sigma: Option<f64>,
    pub overall_sigma: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NumericStateV1 {
    Available,
    NotApplicable,
    Unavailable,
    Unbounded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TypedValueV1 {
    pub state: NumericStateV1,
    pub value: Option<f64>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StabilityIndexV1 {
    pub value: TypedValueV1,
    pub method_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalCapabilityIndicesV1 {
    pub cp: TypedValueV1,
    pub cpk: TypedValueV1,
    pub cpl: TypedValueV1,
    pub cpu: TypedValueV1,
    pub cpm_within: TypedValueV1,
    pub pp: TypedValueV1,
    pub ppk: TypedValueV1,
    pub ppl: TypedValueV1,
    pub ppu: TypedValueV1,
    pub cpm_overall: TypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityIntervalV1 {
    pub lower: TypedValueV1,
    pub upper: TypedValueV1,
    pub interval_method: Option<String>,
    pub limiting_side: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityIntervalProvenanceV1 {
    pub distribution_crate: String,
    pub distribution_crate_version: String,
    pub parameterization: String,
    pub inverse_cdf_algorithm_id: String,
    pub method_version: String,
    pub within_effective_degrees_of_freedom: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalCapabilityIntervalsV1 {
    pub confidence_level: f64,
    pub cp: CapabilityIntervalV1,
    pub cpk: CapabilityIntervalV1,
    pub cpl: CapabilityIntervalV1,
    pub cpu: CapabilityIntervalV1,
    pub cpm_within: CapabilityIntervalV1,
    pub pp: CapabilityIntervalV1,
    pub ppk: CapabilityIntervalV1,
    pub ppl: CapabilityIntervalV1,
    pub ppu: CapabilityIntervalV1,
    pub cpm_overall: CapabilityIntervalV1,
    pub provenance: CapabilityIntervalProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TypedCountV1 {
    pub state: NumericStateV1,
    pub value: Option<u64>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProportionIntervalV1 {
    pub lower: TypedValueV1,
    pub upper: TypedValueV1,
    pub interval_method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedNonconformanceTailV1 {
    pub count: TypedCountV1,
    pub proportion: TypedValueV1,
    pub ppm: TypedValueV1,
    pub proportion_interval: ProportionIntervalV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedNonconformanceV1 {
    pub below: ObservedNonconformanceTailV1,
    pub above: ObservedNonconformanceTailV1,
    pub total: ObservedNonconformanceTailV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedNonconformanceTailV1 {
    pub proportion: TypedValueV1,
    pub ppm: TypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedNonconformanceBySigmaV1 {
    pub below: ExpectedNonconformanceTailV1,
    pub above: ExpectedNonconformanceTailV1,
    pub total: ExpectedNonconformanceTailV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalNonconformanceV1 {
    pub observed: ObservedNonconformanceV1,
    pub expected_within: ExpectedNonconformanceBySigmaV1,
    pub expected_overall: ExpectedNonconformanceBySigmaV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityChartBinV1 {
    pub lower: f64,
    pub upper: f64,
    pub count: f64,
    pub probability: f64,
    pub density: f64,
    pub below_count: f64,
    pub above_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityChartSpecificationLinesV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityChartCoordinateV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDensitySeriesV1 {
    pub state: NumericStateV1,
    pub reason_code: Option<String>,
    pub coordinates: Vec<CapabilityChartCoordinateV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityChartProvenanceV1 {
    pub capability_method: String,
    pub normal_density_method: String,
    pub computation_id: String,
    pub spec_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalCapabilityChartDataV1 {
    pub bins: Vec<CapabilityChartBinV1>,
    pub specification_lines: CapabilityChartSpecificationLinesV1,
    pub overall_density: CapabilityDensitySeriesV1,
    pub within_density: Option<CapabilityDensitySeriesV1>,
    pub provenance: CapabilityChartProvenanceV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ColumnSpecificationInput {
    lsl: Option<f64>,
    target: Option<f64>,
    usl: Option<f64>,
}

pub fn resolve_specification_limits(
    column_spec: Option<&serde_json::Value>,
    override_value: Option<&SpecificationOverrideV1>,
) -> Result<SpecificationResolutionV1, AppError> {
    if let Some(override_value) = override_value {
        let limits = SpecificationLimitsV1 {
            lsl: override_value.lsl,
            target: override_value.target,
            usl: override_value.usl,
            source: SpecificationSourceV1::AnalysisOverride,
        };
        validate_limits(&limits)
            .map_err(|_| AppError::InvalidParam("capability.invalidOverride.v1".to_string()))?;
        return Ok(SpecificationResolutionV1 {
            limits: has_boundary(&limits).then_some(limits),
            warning: None,
        });
    }

    let Some(column_spec) = column_spec else {
        return Ok(SpecificationResolutionV1 {
            limits: None,
            warning: None,
        });
    };
    let parsed = serde_json::from_value::<ColumnSpecificationInput>(column_spec.clone());
    let Ok(parsed) = parsed else {
        return Ok(invalid_column_resolution());
    };
    let limits = SpecificationLimitsV1 {
        lsl: parsed.lsl,
        target: parsed.target,
        usl: parsed.usl,
        source: SpecificationSourceV1::ColumnProperty,
    };
    if validate_limits(&limits).is_err() {
        return Ok(invalid_column_resolution());
    }
    Ok(SpecificationResolutionV1 {
        limits: has_boundary(&limits).then_some(limits),
        warning: None,
    })
}

pub fn normal_process_summary(observations_in_row_order: &[f64]) -> NormalProcessSummaryV1 {
    let n = observations_in_row_order.len() as u64;
    let d2 = 2.0 / std::f64::consts::PI.sqrt();
    if observations_in_row_order.is_empty() {
        return NormalProcessSummaryV1 {
            n,
            mean: f64::NAN,
            moving_range_average: None,
            d2,
            within_sigma: None,
            overall_sigma: None,
        };
    }
    let mean = compensated_sum(observations_in_row_order.iter().copied()) / n as f64;
    let moving_range_average = (n >= 2).then(|| {
        compensated_sum(
            observations_in_row_order
                .windows(2)
                .map(|pair| (pair[1] - pair[0]).abs()),
        ) / (n - 1) as f64
    });
    let overall_sigma = (n >= 2).then(|| {
        (compensated_sum(observations_in_row_order.iter().map(|value| {
            let deviation = *value - mean;
            deviation * deviation
        })) / (n - 1) as f64)
            .max(0.0)
            .sqrt()
    });
    NormalProcessSummaryV1 {
        n,
        mean,
        moving_range_average,
        d2,
        within_sigma: moving_range_average.map(|value| value / d2),
        overall_sigma,
    }
}

pub fn stability_index(summary: &NormalProcessSummaryV1) -> StabilityIndexV1 {
    let value = match (summary.overall_sigma, summary.within_sigma) {
        (Some(overall), Some(within)) if overall.is_finite() && within.is_finite() => {
            if within <= 0.0 {
                unavailable("capability.stabilityWithinSigmaZero.v1")
            } else {
                available(overall / within)
            }
        }
        _ => unavailable("capability.stabilitySigmaUnavailable.v1"),
    };
    StabilityIndexV1 {
        value,
        method_id: "capability.stability.overallToWithin.v1".to_string(),
    }
}

fn validate_limits(limits: &SpecificationLimitsV1) -> Result<(), ()> {
    if [limits.lsl, limits.target, limits.usl]
        .into_iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(());
    }
    if limits
        .lsl
        .zip(limits.usl)
        .is_some_and(|(lsl, usl)| lsl >= usl)
    {
        return Err(());
    }
    if limits
        .target
        .zip(limits.lsl)
        .is_some_and(|(target, lsl)| target < lsl)
        || limits
            .target
            .zip(limits.usl)
            .is_some_and(|(target, usl)| target > usl)
    {
        return Err(());
    }
    Ok(())
}

fn has_boundary(limits: &SpecificationLimitsV1) -> bool {
    limits.lsl.is_some() || limits.usl.is_some()
}

fn invalid_column_resolution() -> SpecificationResolutionV1 {
    SpecificationResolutionV1 {
        limits: None,
        warning: Some("capability.invalidColumnSpec.v1".to_string()),
    }
}

fn compensated_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut sum = 0.0;
    let mut correction = 0.0;
    for value in values {
        let next = sum + value;
        correction += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    sum + correction
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use sha2::{Digest, Sha256};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MovingRangeCapabilityFixtureV1 {
        schema_version: String,
        case_id: String,
        observations: Vec<f64>,
        specification: SpecificationLimitsV1,
        expected_summary: MovingRangeExpectedSummaryV1,
        public_method_expected: MovingRangeExpectedIntervalsV1,
        jmp19_observed_rounded: MovingRangeExpectedIntervalsV1,
        compatibility_status: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MovingRangeExpectedSummaryV1 {
        n: u64,
        mean: f64,
        moving_range_average: f64,
        within_sigma: f64,
        overall_sigma: f64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MovingRangeExpectedIntervalsV1 {
        within_effective_degrees_of_freedom: Option<f64>,
        cpl_lower: f64,
        cpl_upper: f64,
        cpu_lower: f64,
        cpu_upper: f64,
    }

    #[test]
    fn moving_range_fixture_loads_in_source_row_order() {
        let fixture: MovingRangeCapabilityFixtureV1 = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/distribution/process-capability-moving-range-v1.json"
        )))
        .expect("moving range fixture should deserialize");

        assert_eq!(fixture.schema_version, "1");
        assert_eq!(fixture.case_id, "missingRegion.salesAmount.n51");
        assert_eq!(fixture.observations.len(), 51);
        assert_eq!(fixture.observations.first().copied(), Some(318.29));
        let canonical_observations =
            serde_json::to_vec(&fixture.observations).expect("observations should serialize");
        assert_eq!(
            format!("{:x}", Sha256::digest(canonical_observations)),
            "a187a58ebfc96ab515dbf2077611641e033b95d20c3b6d45868a4e8cb168666a"
        );

        let summary = normal_process_summary(&fixture.observations);
        assert_eq!(summary.n, fixture.expected_summary.n);
        assert_close(summary.mean, fixture.expected_summary.mean);
        assert_close(
            summary.moving_range_average.expect("moving range average"),
            fixture.expected_summary.moving_range_average,
        );
        assert_close(
            summary.within_sigma.expect("within sigma"),
            fixture.expected_summary.within_sigma,
        );
        assert_close(
            summary.overall_sigma.expect("overall sigma"),
            fixture.expected_summary.overall_sigma,
        );

        let indices = capability_indices(&summary, &fixture.specification);
        assert_close(
            indices.cpl.value.expect("Cpl point estimate"),
            -0.264393149632642,
        );
        assert_close(
            indices.cpu.value.expect("Cpu point estimate"),
            1.37464479402943,
        );
        assert_eq!(fixture.compatibility_status, "compatibilityPending");
        assert!(fixture
            .public_method_expected
            .within_effective_degrees_of_freedom
            .is_some());
        assert!(fixture
            .jmp19_observed_rounded
            .within_effective_degrees_of_freedom
            .is_none());
        assert_ne!(
            fixture.public_method_expected.cpl_lower,
            fixture.jmp19_observed_rounded.cpl_lower
        );
        assert_ne!(
            fixture.public_method_expected.cpl_upper,
            fixture.jmp19_observed_rounded.cpl_upper
        );
        assert_ne!(
            fixture.public_method_expected.cpu_lower,
            fixture.jmp19_observed_rounded.cpu_lower
        );
        assert_ne!(
            fixture.public_method_expected.cpu_upper,
            fixture.jmp19_observed_rounded.cpu_upper
        );
    }

    fn assert_close(actual: f64, expected: f64) {
        let tolerance = 1e-10_f64.max(expected.abs() * 1e-9);
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected}, got {actual}"
        );
    }

    fn load_moving_range_fixture() -> MovingRangeCapabilityFixtureV1 {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/distribution/process-capability-moving-range-v1.json"
        )))
        .expect("moving range fixture should deserialize")
    }

    #[test]
    fn stability_index_is_overall_sigma_over_within_sigma_with_method_provenance() {
        let summary = NormalProcessSummaryV1 {
            n: 10,
            mean: 5.0,
            moving_range_average: Some(1.0),
            d2: 1.0,
            within_sigma: Some(2.0),
            overall_sigma: Some(3.0),
        };

        let stability = stability_index(&summary);

        assert_eq!(stability.value.state, NumericStateV1::Available);
        assert_eq!(stability.value.value, Some(1.5));
        assert_eq!(
            stability.method_id,
            "capability.stability.overallToWithin.v1"
        );
    }

    #[test]
    fn stability_index_is_unavailable_when_within_sigma_is_zero() {
        let summary = NormalProcessSummaryV1 {
            n: 3,
            mean: 5.0,
            moving_range_average: Some(0.0),
            d2: 1.0,
            within_sigma: Some(0.0),
            overall_sigma: Some(0.0),
        };

        let stability = stability_index(&summary);

        assert_eq!(stability.value.state, NumericStateV1::Unavailable);
        assert_eq!(stability.value.value, None);
        assert_eq!(
            stability.value.reason_code.as_deref(),
            Some("capability.stabilityWithinSigmaZero.v1")
        );

        let negative = stability_index(&NormalProcessSummaryV1 {
            within_sigma: Some(-1.0),
            overall_sigma: Some(1.0),
            ..summary
        });
        assert_eq!(negative.value.state, NumericStateV1::Unavailable);
        assert_eq!(negative.value.value, None);
    }

    #[test]
    fn stability_index_is_unavailable_when_sigma_is_missing() {
        let summary = NormalProcessSummaryV1 {
            n: 1,
            mean: 5.0,
            moving_range_average: None,
            d2: 1.0,
            within_sigma: None,
            overall_sigma: None,
        };

        let stability = stability_index(&summary);

        assert_eq!(stability.value.state, NumericStateV1::Unavailable);
        assert_eq!(stability.value.value, None);
        assert_eq!(
            stability.value.reason_code.as_deref(),
            Some("capability.stabilitySigmaUnavailable.v1")
        );
    }

    #[test]
    fn moving_range_fixture_stability_index_matches_n51_expected_value() {
        let fixture = load_moving_range_fixture();
        let summary = normal_process_summary(&fixture.observations);

        let stability = stability_index(&summary);

        assert_eq!(summary.n, 51);
        let value = stability.value.value.expect("available stability index");
        assert!(
            (value - 1.218682).abs() < 0.0000005,
            "expected approximately 1.218682, got {value}"
        );
    }

    #[test]
    fn moving_range_effective_df_drives_within_cp_interval() {
        let summary = NormalProcessSummaryV1 {
            n: 51,
            mean: 5.0,
            moving_range_average: Some(2.0 / std::f64::consts::PI.sqrt()),
            d2: 2.0 / std::f64::consts::PI.sqrt(),
            within_sigma: Some(1.0),
            overall_sigma: Some(1.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: Some(5.0),
            usl: Some(10.0),
            source: SpecificationSourceV1::AnalysisOverride,
        };
        let indices = capability_indices(&summary, &limits);
        let intervals = capability_intervals(&summary, &indices, 0.95);

        assert_eq!(intervals.confidence_level, 0.95);
        assert_close(
            intervals
                .provenance
                .within_effective_degrees_of_freedom
                .expect("Within effective degrees of freedom"),
            30.43832706934947,
        );

        let moving_range_count = (summary.n - 1) as f64;
        let d2 = 2.0 / std::f64::consts::PI.sqrt();
        let variance = 2.0 * (1.0 - 2.0 / std::f64::consts::PI);
        let adjacent_covariance = 1.0 / 3.0 + (2.0 * 3.0_f64.sqrt() - 4.0) / std::f64::consts::PI;
        let relative_variance = (moving_range_count * variance
            + 2.0 * (moving_range_count - 1.0) * adjacent_covariance)
            / (moving_range_count * moving_range_count * d2 * d2);
        let effective_df = 1.0 / (2.0 * relative_variance);
        assert_close(effective_df, 30.43832706934947);

        let chi = ChiSquared::new(effective_df).expect("positive effective DF");
        let cp = indices.cp.value.expect("Cp point estimate");
        assert_close(
            intervals.cp.lower.value.expect("Cp lower"),
            cp * (chi.inverse_cdf(0.025) / effective_df).sqrt(),
        );
        assert_close(
            intervals.cp.upper.value.expect("Cp upper"),
            cp * (chi.inverse_cdf(0.975) / effective_df).sqrt(),
        );
        assert_eq!(
            intervals.cp.interval_method.as_deref(),
            Some("movingRangeEffectiveDfChiSquare.v1")
        );
    }

    #[test]
    fn capability_intervals_serialize_camel_case_fields() {
        let fixture = load_moving_range_fixture();
        let summary = normal_process_summary(&fixture.observations);
        let indices = capability_indices(&summary, &fixture.specification);
        let serialized = serde_json::to_value(capability_intervals(&summary, &indices, 0.95))
            .expect("capability intervals should serialize");

        assert_eq!(serialized["confidenceLevel"], 0.95);
        assert!(serialized.get("confidence_level").is_none());
        assert!(serialized["provenance"]
            .get("withinEffectiveDegreesOfFreedom")
            .is_some());
        assert!(serialized["provenance"]
            .get("within_effective_degrees_of_freedom")
            .is_none());
        assert!(serialized["cpl"]["lower"].is_object());
        assert!(serialized["cpl"]["upper"].is_object());
    }

    #[test]
    fn moving_range_fixture_uses_public_n51_intervals_and_preserves_overall() {
        let fixture = load_moving_range_fixture();
        let summary = normal_process_summary(&fixture.observations);
        let indices = capability_indices(&summary, &fixture.specification);
        let intervals = capability_intervals(&summary, &indices, 0.95);
        let expected = fixture.public_method_expected;

        assert_close(
            intervals.cpl.lower.value.expect("Cpl lower"),
            expected.cpl_lower,
        );
        assert_close(
            intervals.cpl.upper.value.expect("Cpl upper"),
            expected.cpl_upper,
        );
        assert_close(
            intervals.cpu.lower.value.expect("Cpu lower"),
            expected.cpu_lower,
        );
        assert_close(
            intervals.cpu.upper.value.expect("Cpu upper"),
            expected.cpu_upper,
        );
        assert_eq!(
            intervals.cpl.interval_method.as_deref(),
            Some("movingRangeEffectiveDfWald.v1")
        );
        assert_eq!(
            intervals.cpu.interval_method.as_deref(),
            Some("movingRangeEffectiveDfWald.v1")
        );
        assert_eq!(
            intervals.cpk.interval_method.as_deref(),
            Some("movingRangeEffectiveDfWald.v1")
        );

        let overall_df = (summary.n - 1) as f64;
        let chi = ChiSquared::new(overall_df).expect("positive overall DF");
        let pp = indices.pp.value.expect("Pp point estimate");
        assert_close(
            intervals.pp.lower.value.expect("Pp lower"),
            pp * (chi.inverse_cdf(0.025) / overall_df).sqrt(),
        );
        assert_close(
            intervals.pp.upper.value.expect("Pp upper"),
            pp * (chi.inverse_cdf(0.975) / overall_df).sqrt(),
        );

        let normal = Normal::new(0.0, 1.0).expect("standard normal");
        let z = normal.inverse_cdf(0.975);
        for (point, interval) in [
            (&indices.ppl, &intervals.ppl),
            (&indices.ppu, &intervals.ppu),
        ] {
            let value = point.value.expect("overall side point estimate");
            let standard_error =
                (1.0 / (9.0 * summary.n as f64) + value * value / (2.0 * overall_df)).sqrt();
            assert_close(
                interval.lower.value.expect("overall side lower"),
                value - z * standard_error,
            );
            assert_close(
                interval.upper.value.expect("overall side upper"),
                value + z * standard_error,
            );
            assert_eq!(interval.interval_method.as_deref(), Some("wald.v1"));
        }
        assert_eq!(
            intervals.pp.interval_method.as_deref(),
            Some("chiSquare.v1")
        );
        assert_eq!(intervals.ppk.interval_method.as_deref(), Some("wald.v1"));
    }

    #[test]
    fn resolves_column_specs_and_target_only_is_absent() {
        let none = resolve_specification_limits(None, None).expect("no spec");
        assert!(none.limits.is_none());

        let target_only = serde_json::json!({ "target": 10.0 });
        let resolved = resolve_specification_limits(Some(&target_only), None).expect("target only");
        assert!(resolved.limits.is_none());

        let double_sided = serde_json::json!({ "lsl": 0.0, "target": 5.0, "usl": 10.0 });
        let resolved =
            resolve_specification_limits(Some(&double_sided), None).expect("double spec");
        assert_eq!(
            resolved.limits.as_ref().and_then(|limits| limits.lsl),
            Some(0.0)
        );
        assert_eq!(
            resolved.limits.as_ref().and_then(|limits| limits.usl),
            Some(10.0)
        );
        assert_eq!(
            resolved.limits.as_ref().map(|limits| limits.source),
            Some(SpecificationSourceV1::ColumnProperty)
        );
    }

    #[test]
    fn override_replaces_column_fields_without_writeback() {
        let column = serde_json::json!({ "lsl": 0.0, "target": 5.0, "usl": 10.0 });
        let override_value = SpecificationOverrideV1 {
            lsl: Some(1.0),
            target: None,
            usl: Some(9.0),
        };
        let resolved =
            resolve_specification_limits(Some(&column), Some(&override_value)).expect("override");
        let limits = resolved.limits.expect("limits");
        assert_eq!(limits.lsl, Some(1.0));
        assert_eq!(limits.target, None);
        assert_eq!(limits.usl, Some(9.0));
        assert_eq!(limits.source, SpecificationSourceV1::AnalysisOverride);
        assert_eq!(column["lsl"], 0.0);
    }

    #[test]
    fn invalid_column_spec_warns_but_invalid_override_fails() {
        let invalid_column = serde_json::json!({ "lsl": 10.0, "usl": 5.0 });
        let resolved = resolve_specification_limits(Some(&invalid_column), None)
            .expect("invalid column spec is nonfatal");
        assert!(resolved.limits.is_none());
        assert_eq!(
            resolved.warning.as_deref(),
            Some("capability.invalidColumnSpec.v1")
        );

        let invalid_override = SpecificationOverrideV1 {
            lsl: Some(10.0),
            target: None,
            usl: Some(5.0),
        };
        assert!(matches!(
            resolve_specification_limits(None, Some(&invalid_override)),
            Err(AppError::InvalidParam(code)) if code == "capability.invalidOverride.v1"
        ));
    }

    #[test]
    fn process_summary_uses_row_order_for_moving_ranges() {
        let summary = normal_process_summary(&[1.0, 10.0, 2.0]);
        assert_eq!(summary.n, 3);
        assert_eq!(summary.mean, 13.0 / 3.0);
        assert_eq!(summary.moving_range_average, Some(8.5));
        assert!((summary.d2 - 2.0 / std::f64::consts::PI.sqrt()).abs() < 1e-12);
        let sorted = normal_process_summary(&[1.0, 2.0, 10.0]);
        assert_ne!(summary.moving_range_average, sorted.moving_range_average);
    }

    #[test]
    fn computes_double_sided_within_and_overall_indices() {
        let summary = NormalProcessSummaryV1 {
            n: 10,
            mean: 5.0,
            moving_range_average: Some(2.0 / std::f64::consts::PI.sqrt()),
            d2: 2.0 / std::f64::consts::PI.sqrt(),
            within_sigma: Some(1.0),
            overall_sigma: Some(2.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: Some(5.0),
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let indices = capability_indices(&summary, &limits);
        assert_eq!(indices.cp.value, Some(10.0 / 6.0));
        assert_eq!(indices.cpk.value, Some(5.0 / 3.0));
        assert_eq!(indices.pp.value, Some(10.0 / 12.0));
        assert_eq!(indices.ppk.value, Some(5.0 / 6.0));
        assert_eq!(indices.cpm_within.value, Some(10.0 / 6.0));
    }

    #[test]
    fn one_sided_and_mean_outside_specs_use_typed_states() {
        let summary = NormalProcessSummaryV1 {
            n: 5,
            mean: 12.0,
            moving_range_average: Some(1.0),
            d2: 1.0,
            within_sigma: Some(1.0),
            overall_sigma: Some(1.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: None,
            target: None,
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let indices = capability_indices(&summary, &limits);
        assert_eq!(indices.cpu.value, Some(-2.0 / 3.0));
        assert_eq!(indices.cp.state, NumericStateV1::NotApplicable);
        assert_eq!(indices.cpl.state, NumericStateV1::NotApplicable);
        assert_eq!(indices.cpk.state, NumericStateV1::NotApplicable);
    }

    #[test]
    fn zero_sigma_indices_are_unbounded_without_serializing_infinity() {
        let summary = NormalProcessSummaryV1 {
            n: 3,
            mean: 5.0,
            moving_range_average: Some(0.0),
            d2: 1.0,
            within_sigma: Some(0.0),
            overall_sigma: Some(0.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: None,
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let indices = capability_indices(&summary, &limits);
        assert_eq!(indices.cp.state, NumericStateV1::Unbounded);
        assert_eq!(indices.cp.value, None);
        assert_eq!(indices.ppk.state, NumericStateV1::Unbounded);
    }

    #[test]
    fn moving_range_effective_df_intervals_are_unavailable_when_sample_is_too_small() {
        let summary = NormalProcessSummaryV1 {
            n: 2,
            mean: 5.0,
            moving_range_average: Some(1.0),
            d2: 1.0,
            within_sigma: Some(1.0),
            overall_sigma: Some(1.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: Some(5.0),
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let indices = capability_indices(&summary, &limits);
        let intervals = capability_intervals(&summary, &indices, 0.95);
        assert_eq!(intervals.confidence_level, 0.95);
        assert_eq!(
            intervals.provenance.within_effective_degrees_of_freedom,
            None
        );
        assert_eq!(intervals.cp.lower.state, NumericStateV1::Unavailable);
        assert_eq!(
            intervals.cp.lower.reason_code.as_deref(),
            Some("capability.intervalSampleTooSmall.v1")
        );
        assert_eq!(
            intervals.cp.interval_method.as_deref(),
            Some("movingRangeEffectiveDfChiSquare.v1")
        );
        for interval in [&intervals.cpl, &intervals.cpu, &intervals.cpk] {
            assert_eq!(interval.lower.state, NumericStateV1::Unavailable);
            assert_eq!(
                interval.lower.reason_code.as_deref(),
                Some("capability.intervalSampleTooSmall.v1")
            );
            assert_eq!(
                interval.interval_method.as_deref(),
                Some("movingRangeEffectiveDfWald.v1")
            );
        }
        assert_eq!(
            intervals.pp.interval_method.as_deref(),
            Some("chiSquare.v1")
        );
        assert_eq!(intervals.ppl.interval_method.as_deref(), Some("wald.v1"));
    }

    #[test]
    fn intervals_use_chi_square_and_wald_and_defer_cpm() {
        let summary = NormalProcessSummaryV1 {
            n: 10,
            mean: 5.0,
            moving_range_average: Some(2.0 / std::f64::consts::PI.sqrt()),
            d2: 2.0 / std::f64::consts::PI.sqrt(),
            within_sigma: Some(1.0),
            overall_sigma: Some(2.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: Some(5.0),
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let indices = capability_indices(&summary, &limits);
        let intervals = capability_intervals(&summary, &indices, 0.95);
        assert_eq!(
            intervals.cp.interval_method.as_deref(),
            Some("movingRangeEffectiveDfChiSquare.v1")
        );
        assert_eq!(
            intervals.pp.interval_method.as_deref(),
            Some("chiSquare.v1")
        );
        assert_eq!(
            intervals.cpu.interval_method.as_deref(),
            Some("movingRangeEffectiveDfWald.v1")
        );
        assert_eq!(intervals.cpk.limiting_side.as_deref(), Some("both"));
        assert_eq!(
            intervals.cpm_within.lower.state,
            NumericStateV1::Unavailable
        );
        assert_eq!(
            intervals.cpm_within.lower.reason_code.as_deref(),
            Some("capability.cpmIntervalDeferred.v1")
        );
    }

    #[test]
    fn observed_nonconformance_uses_strict_boundary_and_wilson_ci() {
        let summary = NormalProcessSummaryV1 {
            n: 4,
            mean: 5.0,
            moving_range_average: Some(1.0),
            d2: 1.0,
            within_sigma: Some(1.0),
            overall_sigma: Some(1.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(5.0),
            target: None,
            usl: Some(10.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let values = vec![5.0, 4.0, 10.0, 11.0];
        let metrics = nonconformance_metrics(&summary, &limits, &values, 0.95);
        assert_eq!(metrics.observed.below.count.value, Some(1));
        assert_eq!(metrics.observed.above.count.value, Some(1));
        assert_eq!(metrics.observed.total.count.value, Some(2));
        assert_eq!(metrics.observed.total.proportion.value, Some(0.5));
        assert_eq!(metrics.observed.total.ppm.value, Some(500_000.0));
        assert_eq!(
            metrics.observed.below.proportion_interval.lower.state,
            NumericStateV1::Available
        );
        assert_eq!(
            metrics.observed.above.proportion_interval.upper.state,
            NumericStateV1::Available
        );
    }

    #[test]
    fn expected_nonconformance_handles_one_sided_and_sigma_zero_exactly() {
        let summary = NormalProcessSummaryV1 {
            n: 4,
            mean: 10.0,
            moving_range_average: Some(0.0),
            d2: 1.0,
            within_sigma: Some(0.0),
            overall_sigma: Some(0.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: None,
            target: None,
            usl: Some(9.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let metrics = nonconformance_metrics(&summary, &limits, &[10.0, 10.0, 10.0, 10.0], 0.95);
        assert_eq!(
            metrics.expected_within.below.proportion.state,
            NumericStateV1::NotApplicable
        );
        assert_eq!(
            metrics.expected_overall.below.proportion.state,
            NumericStateV1::NotApplicable
        );
        assert_eq!(metrics.expected_within.above.proportion.value, Some(1.0));
        assert_eq!(metrics.expected_overall.above.ppm.value, Some(1_000_000.0));
        assert_eq!(metrics.expected_within.total.proportion.value, Some(1.0));
    }

    #[test]
    fn capability_chart_data_reuses_bins_and_computes_density_coordinates() {
        let summary = NormalProcessSummaryV1 {
            n: 4,
            mean: 3.0,
            moving_range_average: Some(1.0),
            d2: 1.0,
            within_sigma: Some(1.0),
            overall_sigma: Some(1.5),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(2.0),
            target: Some(3.0),
            usl: Some(4.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let histogram = vec![
            HistogramBinDataV1 {
                lower: 0.0,
                upper: 2.0,
                count: 1.0,
                probability: 0.25,
                density: 0.125,
            },
            HistogramBinDataV1 {
                lower: 2.0,
                upper: 4.0,
                count: 2.0,
                probability: 0.5,
                density: 0.25,
            },
            HistogramBinDataV1 {
                lower: 4.0,
                upper: 6.0,
                count: 1.0,
                probability: 0.25,
                density: 0.125,
            },
        ];

        let chart = capability_chart_data(
            &limits,
            &summary,
            &[1.0, 2.5, 3.5, 5.0],
            &histogram,
            "snapshot-1",
            "spec:sha256:test",
        );

        assert_eq!(chart.bins[0].below_count, 1.0);
        assert_eq!(chart.bins[2].above_count, 1.0);
        assert_eq!(chart.specification_lines.source, "columnProperty");
        assert_eq!(
            chart.provenance.capability_method,
            "capability.normal.individuals"
        );
        assert_eq!(
            chart.provenance.normal_density_method,
            "normal.pdf.closedForm.v1"
        );
        assert_eq!(chart.provenance.computation_id, "snapshot-1");
        assert_eq!(chart.provenance.spec_fingerprint, "spec:sha256:test");
        assert_eq!(chart.overall_density.state, NumericStateV1::Available);
        assert!(chart.overall_density.coordinates.len() > histogram.len());
        let within = chart.within_density.expect("within density");
        assert_eq!(within.state, NumericStateV1::Available);
        assert!(within.coordinates.iter().all(|point| point.y.is_finite()));
    }

    #[test]
    fn capability_chart_density_uses_typed_unavailable_for_zero_sigma() {
        let summary = NormalProcessSummaryV1 {
            n: 3,
            mean: 1.0,
            moving_range_average: Some(0.0),
            d2: 1.0,
            within_sigma: Some(0.0),
            overall_sigma: Some(0.0),
        };
        let limits = SpecificationLimitsV1 {
            lsl: Some(0.0),
            target: None,
            usl: Some(2.0),
            source: SpecificationSourceV1::ColumnProperty,
        };
        let histogram = vec![HistogramBinDataV1 {
            lower: 0.0,
            upper: 2.0,
            count: 3.0,
            probability: 1.0,
            density: 0.5,
        }];

        let chart = capability_chart_data(
            &limits,
            &summary,
            &[1.0, 1.0, 1.0],
            &histogram,
            "snapshot-2",
            "spec:sha256:test2",
        );

        assert_eq!(chart.overall_density.state, NumericStateV1::Unavailable);
        assert_eq!(
            chart.overall_density.reason_code.as_deref(),
            Some("capability.sigmaZero.v1")
        );
        let within = chart.within_density.expect("within density");
        assert_eq!(within.state, NumericStateV1::Unavailable);
        assert_eq!(
            within.reason_code.as_deref(),
            Some("capability.sigmaZero.v1")
        );
        assert!(chart.overall_density.coordinates.is_empty());
    }
}

pub fn capability_indices(
    summary: &NormalProcessSummaryV1,
    limits: &SpecificationLimitsV1,
) -> NormalCapabilityIndicesV1 {
    let within = indices_for_sigma(summary.mean, summary.within_sigma, limits, true);
    let overall = indices_for_sigma(summary.mean, summary.overall_sigma, limits, false);
    NormalCapabilityIndicesV1 {
        cp: within.potential,
        cpk: within.performance,
        cpl: within.lower,
        cpu: within.upper,
        cpm_within: within.target,
        pp: overall.potential,
        ppk: overall.performance,
        ppl: overall.lower,
        ppu: overall.upper,
        cpm_overall: overall.target,
    }
}

pub fn capability_intervals(
    summary: &NormalProcessSummaryV1,
    indices: &NormalCapabilityIndicesV1,
    confidence_level: f64,
) -> NormalCapabilityIntervalsV1 {
    let provenance = CapabilityIntervalProvenanceV1 {
        distribution_crate: "statrs".to_string(),
        distribution_crate_version: "0.18.0".to_string(),
        parameterization:
            "withinMovingRangeEffectiveDf, overallChiSquared(df=n-1), standardNormal(0,1)"
                .to_string(),
        inverse_cdf_algorithm_id: "statrs.inverseCdf.v1".to_string(),
        method_version: "1.1.0".to_string(),
        within_effective_degrees_of_freedom: (summary.n >= 3)
            .then(|| moving_range_effective_degrees_of_freedom(summary.n)),
    };
    let alpha = 1.0 - confidence_level;
    let overall_degrees_of_freedom = summary.n.saturating_sub(1) as f64;
    if summary.n < 3 {
        return NormalCapabilityIntervalsV1 {
            confidence_level,
            cp: unavailable_interval_from_point(
                &indices.cp,
                "capability.intervalSampleTooSmall.v1",
                Some("movingRangeEffectiveDfChiSquare.v1"),
            ),
            cpk: unavailable_interval_from_point(
                &indices.cpk,
                "capability.intervalSampleTooSmall.v1",
                Some("movingRangeEffectiveDfWald.v1"),
            ),
            cpl: unavailable_interval_from_point(
                &indices.cpl,
                "capability.intervalSampleTooSmall.v1",
                Some("movingRangeEffectiveDfWald.v1"),
            ),
            cpu: unavailable_interval_from_point(
                &indices.cpu,
                "capability.intervalSampleTooSmall.v1",
                Some("movingRangeEffectiveDfWald.v1"),
            ),
            cpm_within: unavailable_interval_from_point(
                &indices.cpm_within,
                "capability.cpmIntervalDeferred.v1",
                None,
            ),
            pp: unavailable_interval_from_point(
                &indices.pp,
                "capability.intervalSampleTooSmall.v1",
                Some("chiSquare.v1"),
            ),
            ppk: unavailable_interval_from_point(
                &indices.ppk,
                "capability.intervalSampleTooSmall.v1",
                Some("wald.v1"),
            ),
            ppl: unavailable_interval_from_point(
                &indices.ppl,
                "capability.intervalSampleTooSmall.v1",
                Some("wald.v1"),
            ),
            ppu: unavailable_interval_from_point(
                &indices.ppu,
                "capability.intervalSampleTooSmall.v1",
                Some("wald.v1"),
            ),
            cpm_overall: unavailable_interval_from_point(
                &indices.cpm_overall,
                "capability.cpmIntervalDeferred.v1",
                None,
            ),
            provenance,
        };
    }

    let within_degrees_of_freedom = moving_range_effective_degrees_of_freedom(summary.n);
    let cp = chi_square_interval(
        &indices.cp,
        within_degrees_of_freedom,
        alpha,
        "movingRangeEffectiveDfChiSquare.v1",
    );
    let pp = chi_square_interval(
        &indices.pp,
        overall_degrees_of_freedom,
        alpha,
        "chiSquare.v1",
    );
    let cpl = wald_interval(
        &indices.cpl,
        summary.n,
        within_degrees_of_freedom,
        alpha,
        "movingRangeEffectiveDfWald.v1",
    );
    let cpu = wald_interval(
        &indices.cpu,
        summary.n,
        within_degrees_of_freedom,
        alpha,
        "movingRangeEffectiveDfWald.v1",
    );
    let ppl = wald_interval(
        &indices.ppl,
        summary.n,
        overall_degrees_of_freedom,
        alpha,
        "wald.v1",
    );
    let ppu = wald_interval(
        &indices.ppu,
        summary.n,
        overall_degrees_of_freedom,
        alpha,
        "wald.v1",
    );

    NormalCapabilityIntervalsV1 {
        confidence_level,
        cp,
        cpk: combine_performance_interval(
            &indices.cpl,
            &indices.cpu,
            &cpl,
            &cpu,
            "movingRangeEffectiveDfWald.v1",
        ),
        cpl,
        cpu,
        cpm_within: unavailable_interval_from_point(
            &indices.cpm_within,
            "capability.cpmIntervalDeferred.v1",
            None,
        ),
        pp,
        ppk: combine_performance_interval(&indices.ppl, &indices.ppu, &ppl, &ppu, "wald.v1"),
        ppl,
        ppu,
        cpm_overall: unavailable_interval_from_point(
            &indices.cpm_overall,
            "capability.cpmIntervalDeferred.v1",
            None,
        ),
        provenance,
    }
}

fn moving_range_effective_degrees_of_freedom(n: u64) -> f64 {
    let moving_range_count = n.saturating_sub(1) as f64;
    let d2 = 2.0 / std::f64::consts::PI.sqrt();
    let variance = 2.0 * (1.0 - 2.0 / std::f64::consts::PI);
    let adjacent_covariance = 1.0 / 3.0 + (2.0 * 3.0_f64.sqrt() - 4.0) / std::f64::consts::PI;
    let relative_variance = (moving_range_count * variance
        + 2.0 * (moving_range_count - 1.0) * adjacent_covariance)
        / (moving_range_count * moving_range_count * d2 * d2);
    1.0 / (2.0 * relative_variance)
}

pub fn nonconformance_metrics(
    summary: &NormalProcessSummaryV1,
    limits: &SpecificationLimitsV1,
    observations_in_row_order: &[f64],
    confidence_level: f64,
) -> NormalNonconformanceV1 {
    let n = observations_in_row_order.len() as u64;
    let below_count = limits.lsl.map(|lsl| {
        observations_in_row_order
            .iter()
            .filter(|value| **value < lsl)
            .count() as u64
    });
    let above_count = limits.usl.map(|usl| {
        observations_in_row_order
            .iter()
            .filter(|value| **value > usl)
            .count() as u64
    });
    let total_count = match (below_count, above_count) {
        (Some(below), Some(above)) => Some(below + above),
        (Some(below), None) => Some(below),
        (None, Some(above)) => Some(above),
        (None, None) => None,
    };

    let observed = ObservedNonconformanceV1 {
        below: observed_tail(n, below_count, confidence_level),
        above: observed_tail(n, above_count, confidence_level),
        total: observed_tail(n, total_count, confidence_level),
    };
    let expected_within = expected_nonconformance(
        summary.mean,
        summary.within_sigma,
        limits,
        "capability.withinSigmaUnavailable.v1",
    );
    let expected_overall = expected_nonconformance(
        summary.mean,
        summary.overall_sigma,
        limits,
        "capability.overallSigmaUnavailable.v1",
    );

    NormalNonconformanceV1 {
        observed,
        expected_within,
        expected_overall,
    }
}

pub fn capability_chart_data(
    limits: &SpecificationLimitsV1,
    summary: &NormalProcessSummaryV1,
    observations_in_row_order: &[f64],
    histogram_bins: &[HistogramBinDataV1],
    computation_id: &str,
    spec_fingerprint: &str,
) -> NormalCapabilityChartDataV1 {
    let mut bins = histogram_bins
        .iter()
        .map(|bin| CapabilityChartBinV1 {
            lower: bin.lower,
            upper: bin.upper,
            count: bin.count,
            probability: bin.probability,
            density: bin.density,
            below_count: 0.0,
            above_count: 0.0,
        })
        .collect::<Vec<_>>();

    for value in observations_in_row_order {
        let Some(bin_index) = find_histogram_bin_index(*value, &bins) else {
            continue;
        };
        if limits.lsl.is_some_and(|lsl| *value < lsl) {
            bins[bin_index].below_count += 1.0;
        }
        if limits.usl.is_some_and(|usl| *value > usl) {
            bins[bin_index].above_count += 1.0;
        }
    }

    NormalCapabilityChartDataV1 {
        bins,
        specification_lines: CapabilityChartSpecificationLinesV1 {
            lsl: limits.lsl,
            target: limits.target,
            usl: limits.usl,
            source: match limits.source {
                SpecificationSourceV1::ColumnProperty => "columnProperty",
                SpecificationSourceV1::AnalysisOverride => "analysisOverride",
            }
            .to_string(),
        },
        overall_density: normal_density_series(
            summary.mean,
            summary.overall_sigma,
            histogram_bins,
            "capability.overallSigmaUnavailable.v1",
        ),
        within_density: Some(normal_density_series(
            summary.mean,
            summary.within_sigma,
            histogram_bins,
            "capability.withinSigmaUnavailable.v1",
        )),
        provenance: CapabilityChartProvenanceV1 {
            capability_method: "capability.normal.individuals".to_string(),
            normal_density_method: "normal.pdf.closedForm.v1".to_string(),
            computation_id: computation_id.to_string(),
            spec_fingerprint: spec_fingerprint.to_string(),
        },
    }
}

fn find_histogram_bin_index(value: f64, bins: &[CapabilityChartBinV1]) -> Option<usize> {
    if !value.is_finite() || bins.is_empty() {
        return None;
    }
    let last_index = bins.len() - 1;
    bins.iter().enumerate().find_map(|(index, bin)| {
        (value >= bin.lower && (value < bin.upper || (index == last_index && value <= bin.upper)))
            .then_some(index)
    })
}

fn normal_density_series(
    mean: f64,
    sigma: Option<f64>,
    histogram_bins: &[HistogramBinDataV1],
    unavailable_reason: &str,
) -> CapabilityDensitySeriesV1 {
    if histogram_bins.is_empty() {
        return density_unavailable("capability.histogramUnavailable.v1");
    }
    if !mean.is_finite() {
        return density_unavailable("capability.normalDensityInvalidMean.v1");
    }
    let Some(sigma) = sigma else {
        return density_unavailable(unavailable_reason);
    };
    if !sigma.is_finite() || sigma < 0.0 {
        return density_unavailable("capability.normalDensityInvalidSigma.v1");
    }
    if sigma == 0.0 {
        return density_unavailable("capability.sigmaZero.v1");
    }
    let start = histogram_bins[0].lower;
    let end = histogram_bins[histogram_bins.len() - 1].upper;
    if !(start.is_finite() && end.is_finite()) || end <= start {
        return density_unavailable("capability.histogramUnavailable.v1");
    }
    let segments = histogram_bins.len().max(8) * 8;
    let coordinates = (0..=segments)
        .map(|index| {
            let ratio = index as f64 / segments as f64;
            let x = start + ratio * (end - start);
            let y = normal_pdf(mean, sigma, x);
            CapabilityChartCoordinateV1 { x, y }
        })
        .collect::<Vec<_>>();
    if coordinates.iter().any(|point| !point.y.is_finite()) {
        return density_unavailable("capability.normalDensityNonFinite.v1");
    }
    CapabilityDensitySeriesV1 {
        state: NumericStateV1::Available,
        reason_code: None,
        coordinates,
    }
}

fn normal_pdf(mean: f64, sigma: f64, x: f64) -> f64 {
    let sigma_squared = sigma * sigma;
    let exponent = -((x - mean) * (x - mean)) / (2.0 * sigma_squared);
    (1.0 / (sigma * (2.0 * std::f64::consts::PI).sqrt())) * exponent.exp()
}

fn density_unavailable(reason: &str) -> CapabilityDensitySeriesV1 {
    CapabilityDensitySeriesV1 {
        state: NumericStateV1::Unavailable,
        reason_code: Some(reason.to_string()),
        coordinates: Vec::new(),
    }
}

struct SigmaIndices {
    potential: TypedValueV1,
    performance: TypedValueV1,
    lower: TypedValueV1,
    upper: TypedValueV1,
    target: TypedValueV1,
}

fn indices_for_sigma(
    mean: f64,
    sigma: Option<f64>,
    limits: &SpecificationLimitsV1,
    within: bool,
) -> SigmaIndices {
    let unavailable_reason = if within {
        "capability.withinSigmaUnavailable.v1"
    } else {
        "capability.overallSigmaUnavailable.v1"
    };
    let Some(sigma) = sigma else {
        return SigmaIndices::all_unavailable(unavailable_reason);
    };
    if sigma == 0.0 {
        return SigmaIndices::for_zero_sigma(limits);
    }
    let lower = limits
        .lsl
        .map(|lsl| available((mean - lsl) / (3.0 * sigma)))
        .unwrap_or_else(not_applicable);
    let upper = limits
        .usl
        .map(|usl| available((usl - mean) / (3.0 * sigma)))
        .unwrap_or_else(not_applicable);
    let double_sided = limits.lsl.zip(limits.usl);
    let potential = double_sided
        .map(|(lsl, usl)| available((usl - lsl) / (6.0 * sigma)))
        .unwrap_or_else(not_applicable);
    let performance = match (lower.value, upper.value) {
        (Some(lower), Some(upper)) => available(lower.min(upper)),
        _ => not_applicable(),
    };
    let target = match (limits.lsl, limits.target, limits.usl) {
        (Some(lsl), Some(target), Some(usl)) => {
            available((usl - lsl) / (6.0 * (sigma * sigma + (mean - target).powi(2)).sqrt()))
        }
        _ => not_applicable(),
    };
    SigmaIndices {
        potential,
        performance,
        lower,
        upper,
        target,
    }
}

impl SigmaIndices {
    fn all_unavailable(reason: &str) -> Self {
        let value = || unavailable(reason);
        Self {
            potential: value(),
            performance: value(),
            lower: value(),
            upper: value(),
            target: value(),
        }
    }

    fn for_zero_sigma(limits: &SpecificationLimitsV1) -> Self {
        let lower = if limits.lsl.is_some() {
            unbounded()
        } else {
            not_applicable()
        };
        let upper = if limits.usl.is_some() {
            unbounded()
        } else {
            not_applicable()
        };
        let double_sided = limits.lsl.is_some() && limits.usl.is_some();
        Self {
            potential: if double_sided {
                unbounded()
            } else {
                not_applicable()
            },
            performance: if double_sided {
                unbounded()
            } else {
                not_applicable()
            },
            lower,
            upper,
            target: if double_sided && limits.target.is_some() {
                unbounded()
            } else {
                not_applicable()
            },
        }
    }
}

fn available(value: f64) -> TypedValueV1 {
    TypedValueV1 {
        state: NumericStateV1::Available,
        value: Some(value),
        reason_code: None,
    }
}

fn not_applicable() -> TypedValueV1 {
    TypedValueV1 {
        state: NumericStateV1::NotApplicable,
        value: None,
        reason_code: None,
    }
}

fn unavailable(reason: &str) -> TypedValueV1 {
    TypedValueV1 {
        state: NumericStateV1::Unavailable,
        value: None,
        reason_code: Some(reason.to_string()),
    }
}

fn unbounded() -> TypedValueV1 {
    TypedValueV1 {
        state: NumericStateV1::Unbounded,
        value: None,
        reason_code: Some("capability.sigmaZero.v1".to_string()),
    }
}

fn not_applicable_count() -> TypedCountV1 {
    TypedCountV1 {
        state: NumericStateV1::NotApplicable,
        value: None,
        reason_code: None,
    }
}

fn available_count(value: u64) -> TypedCountV1 {
    TypedCountV1 {
        state: NumericStateV1::Available,
        value: Some(value),
        reason_code: None,
    }
}

fn unavailable_count(reason: &str) -> TypedCountV1 {
    TypedCountV1 {
        state: NumericStateV1::Unavailable,
        value: None,
        reason_code: Some(reason.to_string()),
    }
}

fn unavailable_interval_from_point(
    point: &TypedValueV1,
    reason: &str,
    method: Option<&str>,
) -> CapabilityIntervalV1 {
    let unavailable = || TypedValueV1 {
        state: NumericStateV1::Unavailable,
        value: None,
        reason_code: Some(reason.to_string()),
    };
    let not_app = || TypedValueV1 {
        state: NumericStateV1::NotApplicable,
        value: None,
        reason_code: None,
    };
    let (lower, upper) = match point.state {
        NumericStateV1::NotApplicable => (not_app(), not_app()),
        NumericStateV1::Unbounded => (unbounded(), unbounded()),
        _ => (unavailable(), unavailable()),
    };
    CapabilityIntervalV1 {
        lower,
        upper,
        interval_method: method.map(str::to_string),
        limiting_side: None,
        warnings: Vec::new(),
    }
}

fn chi_square_interval(
    point: &TypedValueV1,
    dof: f64,
    alpha: f64,
    method: &str,
) -> CapabilityIntervalV1 {
    if point.state == NumericStateV1::NotApplicable {
        return CapabilityIntervalV1 {
            lower: not_applicable(),
            upper: not_applicable(),
            interval_method: Some(method.to_string()),
            limiting_side: None,
            warnings: Vec::new(),
        };
    }
    if point.state == NumericStateV1::Unbounded {
        return CapabilityIntervalV1 {
            lower: unbounded(),
            upper: unbounded(),
            interval_method: Some(method.to_string()),
            limiting_side: None,
            warnings: Vec::new(),
        };
    }
    let Some(value) = point.value else {
        return unavailable_interval_from_point(
            point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    };
    let chi = match ChiSquared::new(dof) {
        Ok(distribution) => distribution,
        Err(_) => {
            return unavailable_interval_from_point(
                point,
                "capability.intervalUnavailable.v1",
                Some(method),
            );
        }
    };
    let lower_q = chi.inverse_cdf(alpha / 2.0);
    let upper_q = chi.inverse_cdf(1.0 - alpha / 2.0);
    let lower = value * (lower_q / dof).sqrt();
    let upper = value * (upper_q / dof).sqrt();
    if !(lower.is_finite() && upper.is_finite()) {
        return unavailable_interval_from_point(
            point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    }
    CapabilityIntervalV1 {
        lower: available(lower),
        upper: available(upper),
        interval_method: Some(method.to_string()),
        limiting_side: None,
        warnings: Vec::new(),
    }
}

fn wald_interval(
    point: &TypedValueV1,
    n: u64,
    degrees_of_freedom: f64,
    alpha: f64,
    method: &str,
) -> CapabilityIntervalV1 {
    if point.state == NumericStateV1::NotApplicable {
        return CapabilityIntervalV1 {
            lower: not_applicable(),
            upper: not_applicable(),
            interval_method: Some(method.to_string()),
            limiting_side: None,
            warnings: Vec::new(),
        };
    }
    if point.state == NumericStateV1::Unbounded {
        return CapabilityIntervalV1 {
            lower: unbounded(),
            upper: unbounded(),
            interval_method: Some(method.to_string()),
            limiting_side: None,
            warnings: Vec::new(),
        };
    }
    let Some(value) = point.value else {
        return unavailable_interval_from_point(
            point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    };
    let standard_normal = match Normal::new(0.0, 1.0) {
        Ok(distribution) => distribution,
        Err(_) => {
            return unavailable_interval_from_point(
                point,
                "capability.intervalUnavailable.v1",
                Some(method),
            );
        }
    };
    let z = standard_normal.inverse_cdf(1.0 - alpha / 2.0);
    let sample = n as f64;
    let standard_error = (1.0 / (9.0 * sample) + value * value / (2.0 * degrees_of_freedom)).sqrt();
    let lower = value - z * standard_error;
    let upper = value + z * standard_error;
    if !(lower.is_finite() && upper.is_finite()) {
        return unavailable_interval_from_point(
            point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    }
    CapabilityIntervalV1 {
        lower: available(lower),
        upper: available(upper),
        interval_method: Some(method.to_string()),
        limiting_side: None,
        warnings: Vec::new(),
    }
}

fn combine_performance_interval(
    lower_point: &TypedValueV1,
    upper_point: &TypedValueV1,
    lower_interval: &CapabilityIntervalV1,
    upper_interval: &CapabilityIntervalV1,
    method: &str,
) -> CapabilityIntervalV1 {
    if lower_point.state == NumericStateV1::NotApplicable
        || upper_point.state == NumericStateV1::NotApplicable
    {
        return CapabilityIntervalV1 {
            lower: not_applicable(),
            upper: not_applicable(),
            interval_method: Some(method.to_string()),
            limiting_side: None,
            warnings: Vec::new(),
        };
    }
    if lower_point.state == NumericStateV1::Unbounded
        && upper_point.state == NumericStateV1::Unbounded
    {
        return CapabilityIntervalV1 {
            lower: unbounded(),
            upper: unbounded(),
            interval_method: Some(method.to_string()),
            limiting_side: Some("both".to_string()),
            warnings: Vec::new(),
        };
    }

    let Some(lower_value) = lower_point.value else {
        return unavailable_interval_from_point(
            lower_point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    };
    let Some(upper_value) = upper_point.value else {
        return unavailable_interval_from_point(
            upper_point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    };

    let tie = (lower_value - upper_value).abs() <= 1e-12;
    if tie {
        let l1 = lower_interval.lower.value;
        let u1 = lower_interval.upper.value;
        let l2 = upper_interval.lower.value;
        let u2 = upper_interval.upper.value;
        if let (Some(l1), Some(u1), Some(l2), Some(u2)) = (l1, u1, l2, u2) {
            let intersection_lower = l1.max(l2);
            let intersection_upper = u1.min(u2);
            if intersection_lower <= intersection_upper {
                return CapabilityIntervalV1 {
                    lower: available(intersection_lower),
                    upper: available(intersection_upper),
                    interval_method: Some(method.to_string()),
                    limiting_side: Some("both".to_string()),
                    warnings: Vec::new(),
                };
            }
            return CapabilityIntervalV1 {
                lower: available(l1.min(l2)),
                upper: available(u1.max(u2)),
                interval_method: Some(method.to_string()),
                limiting_side: Some("both".to_string()),
                warnings: vec!["capability.equalSidesApproximation.v1".to_string()],
            };
        }
        return unavailable_interval_from_point(
            lower_point,
            "capability.intervalUnavailable.v1",
            Some(method),
        );
    }

    if lower_value < upper_value {
        let mut interval = lower_interval.clone();
        interval.limiting_side = Some("lower".to_string());
        interval
    } else {
        let mut interval = upper_interval.clone();
        interval.limiting_side = Some("upper".to_string());
        interval
    }
}

fn observed_tail(
    n: u64,
    count: Option<u64>,
    confidence_level: f64,
) -> ObservedNonconformanceTailV1 {
    let Some(count) = count else {
        return ObservedNonconformanceTailV1 {
            count: not_applicable_count(),
            proportion: not_applicable(),
            ppm: not_applicable(),
            proportion_interval: ProportionIntervalV1 {
                lower: not_applicable(),
                upper: not_applicable(),
                interval_method: None,
            },
        };
    };
    if n == 0 {
        return ObservedNonconformanceTailV1 {
            count: unavailable_count("capability.intervalSampleTooSmall.v1"),
            proportion: unavailable("capability.intervalSampleTooSmall.v1"),
            ppm: unavailable("capability.intervalSampleTooSmall.v1"),
            proportion_interval: ProportionIntervalV1 {
                lower: unavailable("capability.intervalSampleTooSmall.v1"),
                upper: unavailable("capability.intervalSampleTooSmall.v1"),
                interval_method: Some("wilson.v1".to_string()),
            },
        };
    }
    let proportion = count as f64 / n as f64;
    let (lower, upper) = wilson_interval(count, n, confidence_level).unwrap_or((
        unavailable("capability.intervalUnavailable.v1"),
        unavailable("capability.intervalUnavailable.v1"),
    ));
    ObservedNonconformanceTailV1 {
        count: available_count(count),
        proportion: available(proportion),
        ppm: available(proportion * 1_000_000.0),
        proportion_interval: ProportionIntervalV1 {
            lower,
            upper,
            interval_method: Some("wilson.v1".to_string()),
        },
    }
}

fn wilson_interval(
    count: u64,
    n: u64,
    confidence_level: f64,
) -> Option<(TypedValueV1, TypedValueV1)> {
    let standard_normal = Normal::new(0.0, 1.0).ok()?;
    let z = standard_normal.inverse_cdf(1.0 - (1.0 - confidence_level) / 2.0);
    let sample = n as f64;
    let p_hat = count as f64 / sample;
    let z2 = z * z;
    let denominator = 1.0 + z2 / sample;
    let center = (p_hat + z2 / (2.0 * sample)) / denominator;
    let radius = z * ((p_hat * (1.0 - p_hat) + z2 / (4.0 * sample)) / sample).sqrt() / denominator;
    let lower = (center - radius).max(0.0);
    let upper = (center + radius).min(1.0);
    if !(lower.is_finite() && upper.is_finite()) {
        return None;
    }
    Some((available(lower), available(upper)))
}

fn expected_nonconformance(
    mean: f64,
    sigma: Option<f64>,
    limits: &SpecificationLimitsV1,
    sigma_unavailable_reason: &str,
) -> ExpectedNonconformanceBySigmaV1 {
    let below = expected_tail_probability(mean, sigma, limits.lsl, true, sigma_unavailable_reason);
    let above = expected_tail_probability(mean, sigma, limits.usl, false, sigma_unavailable_reason);
    let total_proportion = sum_expected_proportions(&below.proportion, &above.proportion);
    ExpectedNonconformanceBySigmaV1 {
        below,
        above,
        total: ExpectedNonconformanceTailV1 {
            ppm: total_proportion
                .value
                .map(|value| available(value * 1_000_000.0))
                .unwrap_or_else(|| mirror_state(&total_proportion)),
            proportion: total_proportion,
        },
    }
}

fn expected_tail_probability(
    mean: f64,
    sigma: Option<f64>,
    limit: Option<f64>,
    lower_tail: bool,
    sigma_unavailable_reason: &str,
) -> ExpectedNonconformanceTailV1 {
    let Some(limit) = limit else {
        return ExpectedNonconformanceTailV1 {
            proportion: not_applicable(),
            ppm: not_applicable(),
        };
    };
    let Some(sigma) = sigma else {
        return ExpectedNonconformanceTailV1 {
            proportion: unavailable(sigma_unavailable_reason),
            ppm: unavailable(sigma_unavailable_reason),
        };
    };
    let probability = if sigma == 0.0 {
        if lower_tail {
            if mean < limit {
                1.0
            } else {
                0.0
            }
        } else if mean > limit {
            1.0
        } else {
            0.0
        }
    } else {
        let distribution = match Normal::new(mean, sigma) {
            Ok(distribution) => distribution,
            Err(_) => {
                return ExpectedNonconformanceTailV1 {
                    proportion: unavailable("capability.intervalUnavailable.v1"),
                    ppm: unavailable("capability.intervalUnavailable.v1"),
                };
            }
        };
        if lower_tail {
            distribution.cdf(limit)
        } else {
            distribution.sf(limit)
        }
    };
    if !probability.is_finite() {
        return ExpectedNonconformanceTailV1 {
            proportion: unavailable("capability.intervalUnavailable.v1"),
            ppm: unavailable("capability.intervalUnavailable.v1"),
        };
    }
    ExpectedNonconformanceTailV1 {
        proportion: available(probability),
        ppm: available(probability * 1_000_000.0),
    }
}

fn sum_expected_proportions(lower: &TypedValueV1, upper: &TypedValueV1) -> TypedValueV1 {
    if lower.state == NumericStateV1::NotApplicable && upper.state == NumericStateV1::NotApplicable
    {
        return not_applicable();
    }
    match (lower.value, upper.value) {
        (Some(lower), Some(upper)) => available(lower + upper),
        (Some(lower), None) if upper.state == NumericStateV1::NotApplicable => available(lower),
        (None, Some(upper)) if lower.state == NumericStateV1::NotApplicable => available(upper),
        (None, None) if lower.state == NumericStateV1::NotApplicable => mirror_state(upper),
        (None, None) if upper.state == NumericStateV1::NotApplicable => mirror_state(lower),
        _ => unavailable("capability.intervalUnavailable.v1"),
    }
}

fn mirror_state(value: &TypedValueV1) -> TypedValueV1 {
    match value.state {
        NumericStateV1::Available => value
            .value
            .map(available)
            .unwrap_or_else(|| unavailable("capability.intervalUnavailable.v1")),
        NumericStateV1::NotApplicable => not_applicable(),
        NumericStateV1::Unavailable => unavailable(
            value
                .reason_code
                .as_deref()
                .unwrap_or("capability.intervalUnavailable.v1"),
        ),
        NumericStateV1::Unbounded => unbounded(),
    }
}

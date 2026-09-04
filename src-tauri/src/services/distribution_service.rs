use crate::error::AppError;
use sha2::{Digest, Sha256};

use crate::engine::distribution_executor::{
    prepare_continuous_groups, resolve_distribution_requests, PreparedGroupV1,
};
use crate::models::distribution::{
    BlackBoxCaseV1, BoxPlotCoordinatesV1, CapabilityDescriptorV1, CapabilityTypedCountV1,
    CapabilityTypedValueV1, DistributionChartDataV1, DistributionChartProvenanceV1,
    DistributionCoordinateV1, DistributionFitComparisonDataV1, DistributionFitComparisonRowV1,
    DistributionFitConvergenceStatusV1, DistributionFitConvergenceV1, DistributionFitDataV1,
    DistributionFitProvenanceV1, DistributionFitStatusV1, DistributionFittedCurveDataV1,
    DistributionGraphFrames, DistributionGroupResult, DistributionGroupResultV1,
    DistributionQuantileValueV1, DistributionReportBlock,
    DistributionReportBlockV1, DistributionReportResponse, DistributionRequest,
    DistributionRequestV1, DistributionSummaryDataV1,
    DistributionYResult, DistributionYResultV1, GraphDataFrameDto, HistogramBinV1,
    Jmp19CompatibilityStatusV1, ProcessCapabilityChartBinV1,
    ProcessCapabilityChartDataV1, ProcessCapabilityChartProvenanceV1, ProcessCapabilityDataV1,
    ProcessCapabilityDensitySeriesV1, ProcessCapabilityExpectedNonconformanceBySigmaV1,
    ProcessCapabilityExpectedTailV1, ProcessCapabilityIndicesV1,
    ProcessCapabilityIntervalProvenanceV1, ProcessCapabilityIntervalV1,
    ProcessCapabilityIntervalsV1, ProcessCapabilityNonconformanceV1,
    ProcessCapabilityObservedNonconformanceV1, ProcessCapabilityObservedTailV1,
    ProcessCapabilityProportionIntervalV1, ProcessCapabilitySpecificationLinesV1,
    ProcessCapabilitySpecificationV1, ProcessCapabilityStabilityIndexV1,
    ProcessCapabilitySummaryV1,
};
use crate::models::graph_data::{
    BoxPlotEntry, BoxPlotOutlier, BoxPlotPacket, GraphAggregatePacket, GraphRawPointDisposition,
    GraphSampling, HistogramBin, HistogramPacket, PrecomputedCurveInterpolation,
    PrecomputedCurvePacket, PrecomputedCurvePoint, PrecomputedPoint, PrecomputedPointPacket,
    DISTRIBUTION_BOX_PLOT_ELEMENT_ID, DISTRIBUTION_ECDF_ELEMENT_ID,
    DISTRIBUTION_NORMAL_QUANTILE_LOWER_ELEMENT_ID, DISTRIBUTION_NORMAL_QUANTILE_POINTS_ELEMENT_ID,
    DISTRIBUTION_NORMAL_QUANTILE_REFERENCE_ELEMENT_ID,
    DISTRIBUTION_NORMAL_QUANTILE_UPPER_ELEMENT_ID, DISTRIBUTION_OVERVIEW_FITTED_CURVES_ELEMENT_ID,
    DISTRIBUTION_OVERVIEW_HISTOGRAM_ELEMENT_ID, GRAPH_SCATTER_RENDER_BUDGET,
};
use crate::services::distribution_fit::{
    attach_parameter_inference, build_pdf_curve, effective_n, fit_information_criteria,
    objective_failure, FitFailureClassificationV1, FitFailureV1, FitMetricSetV1,
    FitModelRegistrationV1, FitObservationV1, STAGE1_FIT_REGISTRY,
};
use crate::services::distribution_kernel::{
    continuous_summary, histogram, normal_quantile_plot, normal_quantile_plot_with_priorities,
    tukey_box, weighted_ecdf, weighted_type6, NormalQuantileKernelStatusV1,
};
use crate::services::normal_capability::{
    capability_chart_data, capability_indices, capability_intervals, nonconformance_metrics,
    normal_process_summary, resolve_specification_limits, stability_index,
    CapabilityDensitySeriesV1, CapabilityIntervalV1, NormalCapabilityChartDataV1,
    NormalCapabilityIntervalsV1, NormalNonconformanceV1, NumericStateV1, SpecificationOverrideV1,
    SpecificationSourceV1, TypedCountV1, TypedValueV1,
};
use crate::state::AppState;

pub struct DistributionService<'a> {
    state: &'a AppState,
}

struct OneShotExecutionContext {
    provenance_id: String,
}

#[derive(serde::Serialize)]
struct OneShotExecutionResult {
    groups: Vec<DistributionGroupResultV1>,
    report_blocks: Vec<DistributionReportBlockV1>,
}

impl<'a> DistributionService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn list_distribution_capabilities(&self) -> Result<Vec<CapabilityDescriptorV1>, AppError> {
        Ok([
            "quantile.type6.weighted",
            "summary.continuous.core",
            "histogram.freedmanDiaconis",
            "boxplot.tukey.weighted",
            "ecdf.weighted",
            "capability.normal.individuals",
            "fit.continuous.normal",
            "fit.continuous.lognormal",
            "fit.continuous.exponential",
            "fit.continuous.gamma",
            "fit.continuous.weibull",
        ]
        .into_iter()
        .map(|id| CapabilityDescriptorV1 {
            id: id.to_string(),
            title_key: format!("distribution.capability.{id}"),
            scope: "continuousY".to_string(),
            menu_scope: "distribution".to_string(),
            status_key: "distribution.capability.available".to_string(),
        })
        .collect())
    }

    pub fn compute_distribution_report(
        &self,
        request: &DistributionRequest,
    ) -> Result<DistributionReportResponse, AppError> {
        let resolved_requests = {
            let engine = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            resolve_distribution_requests(&engine, request)?
        };
        let mut groups = Vec::<DistributionGroupResult>::new();
        let mut report_blocks = Vec::<DistributionReportBlock>::new();

        for resolved in resolved_requests {
            let response_column = resolved.y_columns.first().ok_or_else(|| {
                AppError::InvalidParam("distribution.config.yRequired".to_string())
            })?;
            let context = OneShotExecutionContext {
                provenance_id: deterministic_provenance_id(
                    &request.dataset_id,
                    request.generation,
                    &response_column.column_id,
                ),
            };
            let result = self.execute_one_shot(&resolved, &context)?;
            for legacy_group in result.groups {
                let converted_results = legacy_group
                    .y_results
                    .into_iter()
                    .map(|value| DistributionYResult {
                        y_column: value.y_column,
                        y_name: value.y_name,
                        quantiles: value.quantiles,
                        blocks: value.blocks.into_iter().map(wrap_report_block).collect(),
                    })
                    .collect::<Vec<_>>();
                if let Some(existing) = groups
                    .iter_mut()
                    .find(|value| value.group_key == legacy_group.group_key)
                {
                    existing.y_results.extend(converted_results);
                } else {
                    groups.push(DistributionGroupResult {
                        group_key: legacy_group.group_key,
                        group_names: legacy_group.group_names,
                        y_results: converted_results,
                    });
                }
            }
            report_blocks.extend(result.report_blocks.into_iter().map(wrap_report_block));
        }
        let graph_frames = build_graph_frames(request, &groups)?;
        Ok(DistributionReportResponse {
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            groups,
            report_blocks,
            graph_frames,
        })
    }

    fn execute_one_shot(
        &self,
        request: &DistributionRequestV1,
        context: &OneShotExecutionContext,
    ) -> Result<OneShotExecutionResult, AppError> {
        let prepared_by_y = {
            let engine = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            if let Some(expected) = request.source_data_version.as_deref() {
                let expected = expected.parse::<u64>().map_err(|_| {
                    AppError::InvalidParam("distribution.run.staleGeneration".to_string())
                })?;
                let dataset_id = request.source_dataset_id.as_deref().ok_or_else(|| {
                    AppError::InvalidParam("distribution.run.sourceRequired".to_string())
                })?;
                if engine.get_dataset_generation(dataset_id)? != expected {
                    return Err(AppError::InvalidParam(
                        "distribution.run.staleGeneration".to_string(),
                    ));
                }
            }
            let descriptors = engine
                .get_distribution_columns(request.source_dataset_id.as_deref().ok_or_else(
                    || AppError::InvalidParam("distribution.run.sourceRequired".to_string()),
                )?)?
                .into_iter()
                .map(|column| (column.column_id, (column.name, column.index)))
                .collect::<std::collections::HashMap<_, _>>();
            let group_names = request
                .by_column_ids
                .iter()
                .map(|column_id| {
                    descriptors
                        .get(column_id)
                        .map(|(name, _)| name.clone())
                        .ok_or_else(|| {
                            AppError::InvalidParam("distribution.config.columnUnknown".to_string())
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            request
                .y_columns
                .iter()
                .map(|y| {
                    let (name, index) =
                        descriptors.get(&y.column_id).cloned().ok_or_else(|| {
                            AppError::InvalidParam("distribution.config.columnUnknown".to_string())
                        })?;
                    prepare_continuous_groups(&engine, request, y).map(|mut groups| {
                        if !request.by_column_ids.is_empty() {
                            groups.insert(0, overall_group(&groups));
                        }
                        (y.clone(), name, index, groups, group_names.clone())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut report_blocks = Vec::new();
        let mut group_results = Vec::<DistributionGroupResultV1>::new();
        let dataset_id = request
            .source_dataset_id
            .as_deref()
            .ok_or_else(|| AppError::InvalidParam("distribution.run.sourceRequired".to_string()))?;
        let capability_override = capability_override(request)?;
        for (y, y_name, y_index, groups, group_names) in prepared_by_y {
            let specification = self.column_specification(dataset_id, y_index as usize)?;
            let specification =
                resolve_specification_limits(specification.as_ref(), capability_override.as_ref())?;
            let normal_quantile_priority_values = specification
                .limits
                .as_ref()
                .map(|limits| {
                    [limits.lsl, limits.target, limits.usl]
                        .into_iter()
                        .flatten()
                        .filter(|value| value.is_finite())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (group_index, group) in groups.iter().enumerate() {
                let prefix = format!("{}-{group_index}", y.column_id);
                let summary = continuous_summary(group, request.confidence_level)?;
                let quantiles = [
                    0.0, 0.005, 0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975, 0.995, 1.0,
                ]
                .into_iter()
                .map(|probability| {
                    weighted_type6(&group.observations, probability)
                        .map(|value| DistributionQuantileValueV1 { probability, value })
                })
                .collect::<Result<Vec<_>, _>>()?;
                let mut blocks = Vec::new();
                if !request.histograms_only {
                    blocks.push(DistributionReportBlockV1 {
                        schema_version: "1".to_string(),
                        block_id: format!("{prefix}-summary"),
                        kind: "summary".to_string(),
                        title_key: "distribution.report.summary".to_string(),
                        status: "available".to_string(),
                        summary_data: Some(DistributionSummaryDataV1 {
                            n: summary.n,
                            n_missing: summary.n_missing,
                            mean: summary.mean,
                            std_dev: summary.std_dev,
                            std_error: summary.std_error,
                            mean_ci_lower: summary.mean_ci_lower,
                            mean_ci_upper: summary.mean_ci_upper,
                            minimum: summary.minimum,
                            maximum: summary.maximum,
                            median: summary.median,
                            primary_mode: summary.primary_mode,
                            mode_is_unique: summary.mode_is_unique,
                            range: summary.range,
                            iqr: summary.iqr,
                            mad: summary.mad,
                        }),
                        capability_data: None,
                        distribution_fit_data: None,
                        distribution_fit_comparison_data: None,
                        chart_data: None,
                    });
                }
                let histogram = histogram(group, &request.visual_diagnostics.histogram)?;
                let histogram_bins_for_capability = histogram.bins.clone();
                let histogram_method_id = match request.visual_diagnostics.histogram.method {
                    crate::models::distribution::HistogramMethodV1::JmpAuto => {
                        "histogram.jmpAuto.fallback.fd"
                    }
                    crate::models::distribution::HistogramMethodV1::FreedmanDiaconis => {
                        "histogram.freedmanDiaconis"
                    }
                    crate::models::distribution::HistogramMethodV1::Scott => "histogram.scott",
                    crate::models::distribution::HistogramMethodV1::Sturges => "histogram.sturges",
                    crate::models::distribution::HistogramMethodV1::FixedCount => {
                        "histogram.fixedCount"
                    }
                    crate::models::distribution::HistogramMethodV1::FixedWidth => {
                        "histogram.fixedWidth"
                    }
                };
                let histogram_compatibility = match request.visual_diagnostics.histogram.method {
                    crate::models::distribution::HistogramMethodV1::JmpAuto => {
                        Jmp19CompatibilityStatusV1::CompatibilityPending
                    }
                    crate::models::distribution::HistogramMethodV1::FreedmanDiaconis
                    | crate::models::distribution::HistogramMethodV1::Scott
                    | crate::models::distribution::HistogramMethodV1::Sturges
                    | crate::models::distribution::HistogramMethodV1::FixedCount
                    | crate::models::distribution::HistogramMethodV1::FixedWidth => {
                        Jmp19CompatibilityStatusV1::IntentionalDifference
                    }
                };
                blocks.push(DistributionReportBlockV1 {
                    schema_version: "1".to_string(),
                    block_id: format!("{prefix}-histogram"),
                    kind: "histogram".to_string(),
                    title_key: "distribution.report.histogram".to_string(),
                    status: "available".to_string(),
                    summary_data: None,
                    capability_data: None,
                    distribution_fit_data: None,
                    distribution_fit_comparison_data: None,
                    chart_data: Some(DistributionChartDataV1::HistogramData {
                        schema_version: "1".to_string(),
                        provenance: chart_provenance_with_status(
                            histogram_method_id,
                            histogram_compatibility,
                            context,
                        ),
                        bins: histogram
                            .bins
                            .iter()
                            .map(|bin| HistogramBinV1 {
                                lower: bin.lower,
                                upper: bin.upper,
                                count: bin.count,
                                probability: bin.probability,
                                density: bin.density,
                            })
                            .collect(),
                    }),
                });
                if !request.histograms_only {
                    let normal_quantile = if normal_quantile_priority_values.is_empty() {
                        normal_quantile_plot(
                            group,
                            request.weight_column_id.is_some(),
                            request.visual_diagnostics.normal_quantile_confidence_level,
                            2_000,
                        )?
                    } else {
                        normal_quantile_plot_with_priorities(
                            group,
                            request.weight_column_id.is_some(),
                            request.visual_diagnostics.normal_quantile_confidence_level,
                            2_000,
                            &normal_quantile_priority_values,
                            &[],
                        )?
                    };
                    let normal_quantile_points_status = if matches!(
                        normal_quantile.status,
                        NormalQuantileKernelStatusV1::Available
                    ) && !normal_quantile.has_ties
                        && request.weight_column_id.is_none()
                    {
                        Jmp19CompatibilityStatusV1::DocumentedCompatible
                    } else {
                        Jmp19CompatibilityStatusV1::CompatibilityPending
                    };
                    blocks.push(DistributionReportBlockV1 {
                        schema_version: "1".to_string(),
                        block_id: format!("{prefix}-normal-quantile"),
                        kind: "normalQuantile".to_string(),
                        title_key: "distribution.report.normalQuantilePlot".to_string(),
                        status: match normal_quantile.status {
                            NormalQuantileKernelStatusV1::Available => "available",
                            NormalQuantileKernelStatusV1::Unavailable => "unavailable",
                            NormalQuantileKernelStatusV1::Failed => "failed",
                        }
                        .to_string(),
                        summary_data: None,
                        capability_data: None,
                        distribution_fit_data: None,
                        distribution_fit_comparison_data: None,
                        chart_data: Some(DistributionChartDataV1::NormalQuantileData {
                            schema_version: "1".to_string(),
                            provenance: chart_provenance_with_status(
                                "normalScore.documented.rankOverNPlus1",
                                normal_quantile_points_status.clone(),
                                context,
                            ),
                            payload: crate::models::distribution::NormalQuantileDataV1 {
                                points: normal_quantile
                                    .points
                                    .iter()
                                    .map(|point| crate::models::distribution::NormalQuantilePointV1 {
                                        rank: point.rank as f64,
                                        probability: point.probability,
                                        normal_score: point.normal_score,
                                        observed_value: point.observed_value,
                                    })
                                    .collect(),
                                reference_line: normal_quantile
                                    .reference_line
                                    .iter()
                                    .map(|point| DistributionCoordinateV1 {
                                        x: point.x,
                                        y: point.probability,
                                    })
                                    .collect(),
                                confidence_band: normal_quantile
                                    .confidence_band
                                    .iter()
                                    .map(|point| {
                                        crate::models::distribution::NormalQuantileBandPointV1 {
                                            x: point.x,
                                            lower: point.lower,
                                            upper: point.upper,
                                        }
                                    })
                                    .collect(),
                                status: match normal_quantile.status {
                                    NormalQuantileKernelStatusV1::Available => {
                                        crate::models::distribution::DiagnosticDataStatusV1::Available
                                    }
                                    NormalQuantileKernelStatusV1::Unavailable => {
                                        crate::models::distribution::DiagnosticDataStatusV1::Unavailable
                                    }
                                    NormalQuantileKernelStatusV1::Failed => {
                                        crate::models::distribution::DiagnosticDataStatusV1::Failed
                                    }
                                },
                                reason_code: normal_quantile.reason_code,
                                provenance: chart_provenance_with_status(
                                    "normalScore.documented.rankOverNPlus1",
                                    normal_quantile_points_status,
                                    context,
                                ),
                                reference_line_provenance: chart_provenance_with_status(
                                    "normalQuantile.referenceLine.public.v1",
                                    Jmp19CompatibilityStatusV1::CompatibilityPending,
                                    context,
                                ),
                                confidence_band_provenance: chart_provenance_with_status(
                                    "normalQuantile.pointwiseBand.public.v1",
                                    Jmp19CompatibilityStatusV1::CompatibilityPending,
                                    context,
                                ),
                            },
                        }),
                    });

                    let candidate_registrations = fit_candidates(request);
                    if !candidate_registrations.is_empty() {
                        let fit_observations = group
                            .observations
                            .iter()
                            .map(FitObservationV1::try_from)
                            .collect::<Result<Vec<_>, _>>()?;
                        let (x_min, x_max) = fit_extent(group, &histogram_bins_for_capability)?;
                        let candidate_ids = candidate_registrations
                            .iter()
                            .map(|registration| registration.distribution_id.clone())
                            .collect::<Vec<_>>();
                        let mut fit_payloads =
                            execute_fit_candidates(&candidate_registrations, |registration| {
                                build_fit_payload(
                                    registration,
                                    &fit_observations,
                                    x_min,
                                    x_max,
                                    &prefix,
                                    &candidate_ids,
                                    context,
                                )
                            })?;
                        fit_payloads.sort_by(|left, right| {
                            distribution_id(left.distribution_id.clone())
                                .cmp(distribution_id(right.distribution_id.clone()))
                        });
                        for payload in &fit_payloads {
                            blocks.push(DistributionReportBlockV1 {
                                schema_version: "1".to_string(),
                                block_id: format!(
                                    "{prefix}-fit-{}",
                                    distribution_id(payload.distribution_id.clone())
                                ),
                                kind: "continuousFit".to_string(),
                                title_key: "distribution.report.continuousFit".to_string(),
                                status: fit_status(payload.status.clone()).to_string(),
                                summary_data: None,
                                capability_data: None,
                                distribution_fit_data: Some(payload.clone()),
                                distribution_fit_comparison_data: None,
                                chart_data: None,
                            });
                        }
                        if request.continuous_fit.fit_all {
                            let mut rows = fit_payloads
                                .iter()
                                .map(fit_comparison_row)
                                .collect::<Vec<_>>();
                            rows.sort_by(compare_fit_rows);
                            blocks.push(DistributionReportBlockV1 {
                                schema_version: "1".to_string(),
                                block_id: format!("{prefix}-fit-comparison"),
                                kind: "fitComparison".to_string(),
                                title_key: "distribution.report.fitComparison".to_string(),
                                status: "available".to_string(),
                                summary_data: None,
                                capability_data: None,
                                distribution_fit_data: None,
                                distribution_fit_comparison_data: Some(
                                    DistributionFitComparisonDataV1 {
                                        schema_version: "1".to_string(),
                                        comparison_id: format!("{prefix}-fit-comparison"),
                                        candidate_registry_ids: candidate_ids,
                                        rows,
                                    },
                                ),
                                chart_data: None,
                            });
                        }
                    }

                    let box_plot = tukey_box(group, request.confidence_level)?;
                    blocks.push(DistributionReportBlockV1 {
                        schema_version: "1".to_string(),
                        block_id: format!("{prefix}-box"),
                        kind: "boxPlot".to_string(),
                        title_key: "distribution.report.boxPlot".to_string(),
                        status: "available".to_string(),
                        summary_data: None,
                        capability_data: None,
                        distribution_fit_data: None,
                        distribution_fit_comparison_data: None,
                        chart_data: Some(DistributionChartDataV1::BoxPlotData {
                            schema_version: "1".to_string(),
                            provenance: chart_provenance("boxplot.tukey.weighted", context),
                            coordinates: BoxPlotCoordinatesV1 {
                                lower_whisker: box_plot.lower_whisker,
                                lower_quartile: box_plot.lower_quartile,
                                median: box_plot.median,
                                upper_quartile: box_plot.upper_quartile,
                                upper_whisker: box_plot.upper_whisker,
                                outliers: box_plot
                                    .outliers
                                    .into_iter()
                                    .map(|item| item.value)
                                    .collect(),
                            },
                        }),
                    });
                    let ecdf = weighted_ecdf(group)?;
                    blocks.push(DistributionReportBlockV1 {
                        schema_version: "1".to_string(),
                        block_id: format!("{prefix}-ecdf"),
                        kind: "ecdf".to_string(),
                        title_key: "distribution.report.ecdf".to_string(),
                        status: "available".to_string(),
                        summary_data: None,
                        capability_data: None,
                        distribution_fit_data: None,
                        distribution_fit_comparison_data: None,
                        chart_data: Some(DistributionChartDataV1::CdfData {
                            schema_version: "1".to_string(),
                            provenance: chart_provenance("ecdf.weighted", context),
                            points: ecdf
                                .points
                                .into_iter()
                                .map(|point| DistributionCoordinateV1 {
                                    x: point.x,
                                    y: point.probability,
                                })
                                .collect(),
                        }),
                    });
                    if request
                        .enabled_capability_ids
                        .iter()
                        .any(|id| id == "capability.normal.individuals")
                    {
                        if let Some(limits) = &specification.limits {
                            if request.weight_column_id.is_none()
                                && request.frequency_column_id.is_none()
                            {
                                let mut ordered = group.observations.clone();
                                ordered.sort_by_key(|value| value.row_id);
                                let values =
                                    ordered.iter().map(|value| value.y).collect::<Vec<_>>();
                                let process_summary = normal_process_summary(&values);
                                let stability = stability_index(&process_summary);
                                let indices = capability_indices(&process_summary, limits);
                                let intervals = capability_intervals(
                                    &process_summary,
                                    &indices,
                                    request.confidence_level,
                                );
                                let nonconformance = nonconformance_metrics(
                                    &process_summary,
                                    limits,
                                    &values,
                                    request.confidence_level,
                                );
                                let capability_chart = capability_chart_data(
                                    limits,
                                    &process_summary,
                                    &values,
                                    &histogram_bins_for_capability,
                                    &context.provenance_id,
                                    &specification_fingerprint(limits)?,
                                );
                                blocks.push(DistributionReportBlockV1 {
                                    schema_version: "1".to_string(),
                                    block_id: format!("{prefix}-capability"),
                                    kind: "processCapability".to_string(),
                                    title_key: "distribution.report.processCapability".to_string(),
                                    status: "available".to_string(),
                                    summary_data: None,
                                    capability_data: Some(ProcessCapabilityDataV1 {
                                        specification: ProcessCapabilitySpecificationV1 {
                                            lsl: limits.lsl,
                                            target: limits.target,
                                            usl: limits.usl,
                                            source: match limits.source {
                                                SpecificationSourceV1::ColumnProperty => {
                                                    "columnProperty"
                                                }
                                                SpecificationSourceV1::AnalysisOverride => {
                                                    "analysisOverride"
                                                }
                                            }
                                            .to_string(),
                                        },
                                        process_summary: ProcessCapabilitySummaryV1 {
                                            n: process_summary.n,
                                            mean: process_summary.mean,
                                            moving_range_average: process_summary
                                                .moving_range_average,
                                            d2: process_summary.d2,
                                            within_sigma: process_summary.within_sigma,
                                            overall_sigma: process_summary.overall_sigma,
                                            stability_index: ProcessCapabilityStabilityIndexV1 {
                                                value: map_capability_value(stability.value),
                                                method_id: stability.method_id,
                                            },
                                        },
                                        indices: map_capability_indices(indices),
                                        intervals: map_capability_intervals(intervals),
                                        nonconformance: map_nonconformance(nonconformance),
                                        chart_data: Some(map_capability_chart_data(
                                            capability_chart,
                                        )),
                                        warnings: specification
                                            .warning
                                            .clone()
                                            .into_iter()
                                            .collect(),
                                    }),
                                    distribution_fit_data: None,
                                    distribution_fit_comparison_data: None,
                                    chart_data: None,
                                });
                            }
                        }
                    }
                }
                report_blocks.extend(blocks.iter().cloned());
                let y_result = DistributionYResultV1 {
                    y_column: y.clone(),
                    y_name: y_name.clone(),
                    quantiles,
                    blocks,
                };
                if let Some(existing) = group_results
                    .iter_mut()
                    .find(|result| result.group_key == group.key)
                {
                    existing.y_results.push(y_result);
                } else {
                    group_results.push(DistributionGroupResultV1 {
                        group_key: group.key.clone(),
                        group_names: group_names.clone(),
                        y_results: vec![y_result],
                    });
                }
            }
        }
        Ok(OneShotExecutionResult {
            groups: group_results,
            report_blocks,
        })
    }

    fn column_specification(
        &self,
        dataset_id: &str,
        column_index: usize,
    ) -> Result<Option<serde_json::Value>, AppError> {
        let display = self
            .state
            .column_display
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        Ok(display
            .get(dataset_id)
            .and_then(|columns| {
                columns
                    .iter()
                    .find(|column| column.col_index == column_index)
            })
            .and_then(|column| column.extras.as_ref())
            .and_then(|extras| extras.get("spec"))
            .cloned())
    }

    pub fn validate_black_box_case(&self, case: &BlackBoxCaseV1) -> Result<(), AppError> {
        if case.schema_version != "1" {
            return Err(AppError::InvalidParam(
                "unsupported black-box case schema version".to_string(),
            ));
        }
        if !is_machine_id(&case.case_id) || !is_machine_id(&case.action_id) {
            return Err(AppError::InvalidParam(
                "black-box case and action IDs must be machine-readable".to_string(),
            ));
        }
        let provenance = &case.provenance;
        if !is_sha256(&provenance.source_ledger_hash)
            || !is_sha256(&provenance.input_hash)
            || !is_sha256(&provenance.output_hash)
            || !is_sha256(&provenance.review_artifact_hash)
            || !is_machine_id(&provenance.tool_version)
            || !is_machine_id(&provenance.seed)
        {
            return Err(AppError::InvalidParam(
                "black-box provenance is incomplete".to_string(),
            ));
        }
        for (key, value) in &case.inputs {
            if !is_machine_id(key) || !black_box_value_is_sanitized(value) {
                return Err(AppError::InvalidParam(
                    "black-box inputs must be structured machine values".to_string(),
                ));
            }
        }
        for observation in case.expected.iter().chain(&case.observed) {
            if !black_box_observation_is_sanitized(observation) {
                return Err(AppError::InvalidParam(
                    "black-box observations must be structured machine values".to_string(),
                ));
            }
        }
        if case.warnings.iter().any(|warning| !is_machine_id(warning)) {
            return Err(AppError::InvalidParam(
                "black-box warnings must be machine-readable codes".to_string(),
            ));
        }
        Ok(())
    }
}

fn wrap_report_block(block: DistributionReportBlockV1) -> DistributionReportBlock {
    let reason_code = match &block.distribution_fit_data {
        Some(payload) => payload.reason_code.clone(),
        None => match &block.chart_data {
            Some(DistributionChartDataV1::NormalQuantileData { payload, .. }) => {
                payload.reason_code.clone()
            }
            _ => None,
        },
    }
    .or_else(|| {
        (block.status != "available")
            .then(|| format!("distribution.{}.{}", block.kind, block.status))
    });
    DistributionReportBlock { block, reason_code }
}

fn build_graph_frames(
    request: &DistributionRequest,
    groups: &[DistributionGroupResult],
) -> Result<DistributionGraphFrames, AppError> {
    let mut overview = Vec::new();
    let mut box_plot = Vec::new();
    let mut ecdf = Vec::new();
    let mut normal_quantile = Vec::new();
    let mut histogram_bins = Vec::new();
    let mut box_entries = Vec::new();
    let mut source_rows = 0_u64;
    let mut processed_rows = 0_u64;

    for group in groups {
        let group_name = graph_group_name(&group.group_names, &group.group_key);
        for y_result in &group.y_results {
            let series_name = graph_series_name(&y_result.y_name, &group_name);
            let series_key = graph_series_key(&y_result.y_name, &group.group_key)?;
            let mut result_count = 0_u64;
            for item in &y_result.blocks {
                let block = &item.block;
                if let Some(summary) = &block.summary_data {
                    source_rows = source_rows.max(summary.n.saturating_add(summary.n_missing));
                    processed_rows = processed_rows.max(summary.n);
                    result_count = summary.n;
                }
                match &block.chart_data {
                    Some(DistributionChartDataV1::HistogramData { bins, .. }) => {
                        for bin in bins {
                            histogram_bins.push(HistogramBin {
                                group: Some(series_name.clone()),
                                category: Some(group_name.clone()),
                                source_column: Some(y_result.y_name.clone()),
                                facet_x: None,
                                facet_y: None,
                                facet_z: None,
                                wrap: None,
                                bin_start: bin.lower,
                                bin_end: bin.upper,
                                count: graph_count(bin.count)?,
                            });
                        }
                    }
                    Some(DistributionChartDataV1::BoxPlotData { coordinates, .. }) => {
                        box_entries.push(BoxPlotEntry {
                            group: Some(series_name.clone()),
                            category: Some(group_name.clone()),
                            source_column: Some(y_result.y_name.clone()),
                            facet_x: None,
                            facet_y: None,
                            facet_z: None,
                            wrap: None,
                            count: result_count,
                            min: coordinates.lower_whisker,
                            q1: coordinates.lower_quartile,
                            median: coordinates.median,
                            q3: coordinates.upper_quartile,
                            max: coordinates.upper_whisker,
                            whisker_low: coordinates.lower_whisker,
                            whisker_high: coordinates.upper_whisker,
                            outliers: coordinates
                                .outliers
                                .iter()
                                .map(|value| BoxPlotOutlier {
                                    value: *value,
                                    row_id: None,
                                    source_column: Some(y_result.y_name.clone()),
                                })
                                .collect(),
                        });
                    }
                    Some(DistributionChartDataV1::CdfData { points, .. }) => {
                        ecdf.push(GraphAggregatePacket::PrecomputedCurve(
                            PrecomputedCurvePacket {
                                element_id: DISTRIBUTION_ECDF_ELEMENT_ID.to_string(),
                                series_id: Some(format!("{series_key}:ecdf")),
                                series_name: Some(series_name.clone()),
                                interpolation: PrecomputedCurveInterpolation::StepEnd,
                                points: points
                                    .iter()
                                    .map(|point| PrecomputedCurvePoint {
                                        x: point.x,
                                        y: point.y,
                                    })
                                    .collect(),
                            },
                        ));
                    }
                    Some(DistributionChartDataV1::NormalQuantileData { payload, .. }) => {
                        normal_quantile.push(GraphAggregatePacket::PrecomputedPoints(
                            PrecomputedPointPacket {
                                element_id: DISTRIBUTION_NORMAL_QUANTILE_POINTS_ELEMENT_ID
                                    .to_string(),
                                series_id: Some(format!("{series_key}:normalQuantile:points")),
                                series_name: Some(series_name.clone()),
                                points: payload
                                    .points
                                    .iter()
                                    .map(|point| PrecomputedPoint {
                                        x: point.normal_score,
                                        y: point.observed_value,
                                        label: None,
                                        group: Some(series_name.clone()),
                                    })
                                    .collect(),
                            },
                        ));
                        for (element_id, role, points) in [
                            (
                                DISTRIBUTION_NORMAL_QUANTILE_REFERENCE_ELEMENT_ID,
                                "reference",
                                payload.reference_line.clone(),
                            ),
                            (
                                DISTRIBUTION_NORMAL_QUANTILE_LOWER_ELEMENT_ID,
                                "lower",
                                payload
                                    .confidence_band
                                    .iter()
                                    .map(|point| DistributionCoordinateV1 {
                                        x: point.x,
                                        y: point.lower,
                                    })
                                    .collect(),
                            ),
                            (
                                DISTRIBUTION_NORMAL_QUANTILE_UPPER_ELEMENT_ID,
                                "upper",
                                payload
                                    .confidence_band
                                    .iter()
                                    .map(|point| DistributionCoordinateV1 {
                                        x: point.x,
                                        y: point.upper,
                                    })
                                    .collect(),
                            ),
                        ] {
                            normal_quantile.push(GraphAggregatePacket::PrecomputedCurve(
                                PrecomputedCurvePacket {
                                    element_id: element_id.to_string(),
                                    series_id: Some(format!("{series_key}:normalQuantile:{role}")),
                                    series_name: Some(series_name.clone()),
                                    interpolation: PrecomputedCurveInterpolation::Linear,
                                    points: points
                                        .into_iter()
                                        .map(|point| PrecomputedCurvePoint {
                                            x: point.x,
                                            y: point.y,
                                        })
                                        .collect(),
                                },
                            ));
                        }
                    }
                    _ => {}
                }
                if let Some(fit) = &block.distribution_fit_data {
                    if let Some(curve) = &fit.fitted_curve {
                        let fit_name = format!(
                            "{series_name} - {}",
                            distribution_id(fit.distribution_id.clone())
                        );
                        overview.push(GraphAggregatePacket::PrecomputedCurve(
                            PrecomputedCurvePacket {
                                element_id: DISTRIBUTION_OVERVIEW_FITTED_CURVES_ELEMENT_ID
                                    .to_string(),
                                series_id: Some(format!(
                                    "{series_key}:fit:{}",
                                    distribution_id(fit.distribution_id.clone())
                                )),
                                series_name: Some(fit_name),
                                interpolation: PrecomputedCurveInterpolation::Linear,
                                points: curve
                                    .points
                                    .iter()
                                    .map(|point| PrecomputedCurvePoint {
                                        x: point.x,
                                        y: point.y,
                                    })
                                    .collect(),
                            },
                        ));
                    }
                }
            }
        }
    }

    let total_count = histogram_bins.iter().try_fold(0_u64, |total, bin| {
        total
            .checked_add(bin.count)
            .ok_or_else(|| AppError::Stats("distribution.graph.countOverflow".to_string()))
    })?;
    let min_value = histogram_bins
        .iter()
        .map(|bin| bin.bin_start)
        .reduce(f64::min);
    let max_value = histogram_bins
        .iter()
        .map(|bin| bin.bin_end)
        .reduce(f64::max);
    let bin_width = histogram_bins
        .first()
        .map_or(0.0, |bin| bin.bin_end - bin.bin_start);
    overview.insert(
        0,
        GraphAggregatePacket::Histogram(HistogramPacket {
            x_column: None,
            y_column: DISTRIBUTION_OVERVIEW_HISTOGRAM_ELEMENT_ID.to_string(),
            group_column: request.by_columns.first().cloned(),
            source_column: Some("responseColumn".to_string()),
            bin_count: u32::try_from(histogram_bins.len())
                .map_err(|_| AppError::Stats("distribution.graph.binCountOverflow".to_string()))?,
            min_value,
            max_value,
            missing_count: 0,
            bin_width,
            total_count,
            bins: histogram_bins,
        }),
    );
    box_plot.push(GraphAggregatePacket::BoxPlot(BoxPlotPacket {
        x_column: request.by_columns.first().cloned(),
        y_column: DISTRIBUTION_BOX_PLOT_ELEMENT_ID.to_string(),
        group_column: request.by_columns.first().cloned(),
        source_column: Some("responseColumn".to_string()),
        entries: box_entries,
    }));

    let frame = |role: &str, aggregates| GraphDataFrameDto {
        request_id: format!("distribution:{role}"),
        dataset_id: request.dataset_id.clone(),
        generation: request.generation,
        source_rows,
        processed_rows,
        sampling: GraphSampling::Full,
        dictionaries: std::collections::HashMap::new(),
        extents: std::collections::HashMap::new(),
        raw_chunks: Vec::new(),
        aggregates,
        raw_point_disposition: GraphRawPointDisposition::Empty {
            valid_rows: 0,
            budget: GRAPH_SCATTER_RENDER_BUDGET,
        },
    };
    Ok(DistributionGraphFrames {
        overview: frame("overview", overview),
        box_plot: frame("boxPlot", box_plot),
        ecdf: frame("ecdf", ecdf),
        normal_quantile: frame("normalQuantile", normal_quantile),
    })
}

fn deterministic_provenance_id(
    dataset_id: &str,
    generation: u64,
    response_column_id: &str,
) -> String {
    let digest = Sha256::digest(format!("{dataset_id}\0{generation}\0{response_column_id}"));
    format!("distribution:sha256:{digest:x}")
}

fn graph_group_name(
    names: &[String],
    values: &[crate::models::distribution::DistributionGroupValueV1],
) -> String {
    if values.is_empty() {
        return "Overall".to_string();
    }
    names
        .iter()
        .zip(values)
        .map(|(name, value)| format!("{name}={}", graph_group_value(value)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn graph_group_value(value: &crate::models::distribution::DistributionGroupValueV1) -> String {
    use crate::models::distribution::DistributionGroupValueV1;
    match value {
        DistributionGroupValueV1::Missing => "Missing".to_string(),
        DistributionGroupValueV1::Boolean { value } => value.to_string(),
        DistributionGroupValueV1::Number { value } => value.to_string(),
        DistributionGroupValueV1::Text { value } => value.clone(),
        DistributionGroupValueV1::DateTime { utc_millis } => utc_millis.to_string(),
    }
}

fn graph_series_name(response_name: &str, group_name: &str) -> String {
    if group_name == "Overall" {
        response_name.to_string()
    } else {
        format!("{response_name} | {group_name}")
    }
}

fn graph_series_key(
    response_name: &str,
    group_key: &[crate::models::distribution::DistributionGroupValueV1],
) -> Result<String, AppError> {
    let canonical = serde_json::to_vec(&(response_name, group_key))
        .map_err(|error| AppError::InvalidParam(error.to_string()))?;
    let digest = Sha256::digest(canonical);
    Ok(format!("distribution:series:{digest:x}"))
}

fn graph_count(value: f64) -> Result<u64, AppError> {
    if !value.is_finite() || value < 0.0 || value > u64::MAX as f64 {
        return Err(AppError::Stats(
            "distribution.graph.countInvalid".to_string(),
        ));
    }
    Ok(value.round() as u64)
}

fn overall_group(groups: &[PreparedGroupV1]) -> PreparedGroupV1 {
    let mut observations = groups
        .iter()
        .flat_map(|group| group.observations.iter().cloned())
        .collect::<Vec<_>>();
    observations.sort_by_key(|observation| observation.row_id);
    PreparedGroupV1 {
        key: Vec::new(),
        observations,
        source_rows: groups.iter().map(|group| group.source_rows).sum(),
        n_missing: groups.iter().map(|group| group.n_missing).sum(),
        excluded_rows: groups.iter().map(|group| group.excluded_rows).sum(),
    }
}

fn fit_candidates(request: &DistributionRequestV1) -> Vec<&'static FitModelRegistrationV1> {
    let mut candidates = STAGE1_FIT_REGISTRY
        .iter()
        .filter(|registration| {
            request.continuous_fit.fit_all
                || request
                    .continuous_fit
                    .enabled_distribution_ids
                    .contains(&registration.distribution_id)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|registration| distribution_id(registration.distribution_id.clone()));
    candidates
}

fn execute_fit_candidates<T>(
    candidates: &[&'static FitModelRegistrationV1],
    mut execute: impl FnMut(&'static FitModelRegistrationV1) -> Result<T, AppError>,
) -> Result<Vec<T>, AppError> {
    let mut results = Vec::with_capacity(candidates.len());
    for &candidate in candidates {
        results.push(execute(candidate)?);
    }
    Ok(results)
}

fn fit_extent(
    group: &PreparedGroupV1,
    bins: &[crate::services::distribution_kernel::HistogramBinDataV1],
) -> Result<(f64, f64), AppError> {
    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    for value in group
        .observations
        .iter()
        .map(|observation| observation.y)
        .chain(bins.iter().flat_map(|bin| [bin.lower, bin.upper]))
    {
        if value.is_finite() {
            x_min = x_min.min(value);
            x_max = x_max.max(value);
        }
    }
    if !x_min.is_finite() || !x_max.is_finite() || x_max <= x_min {
        return Err(AppError::Stats(
            "distribution.fit.extentInvalid.v1".to_string(),
        ));
    }
    Ok((x_min, x_max))
}

fn build_fit_payload(
    registration: &FitModelRegistrationV1,
    observations: &[FitObservationV1],
    x_min: f64,
    x_max: f64,
    prefix: &str,
    candidate_ids: &[crate::models::distribution::ContinuousDistributionIdV1],
    context: &OneShotExecutionContext,
) -> Result<DistributionFitDataV1, AppError> {
    let effective_n = effective_n(observations)?;
    let provenance = fit_provenance(registration, candidate_ids, context);
    let model = registration.model();
    let fit_id = format!(
        "{prefix}-fit-{}",
        distribution_id(registration.distribution_id.clone())
    );
    let mut estimate = match model.fit(observations) {
        Ok(estimate) => estimate,
        Err(failure) => {
            return Ok(failed_fit_payload(
                registration,
                fit_id,
                effective_n,
                provenance,
                failure,
            ));
        }
    };
    let metrics = match isolated_fit_metrics(
        estimate.log_likelihood,
        registration.estimated_parameter_count,
        effective_n,
    ) {
        Ok(metrics) => metrics,
        Err(failure) => {
            return Ok(failed_fit_payload(
                registration,
                fit_id,
                effective_n,
                provenance,
                failure,
            ));
        }
    };
    let curve = match build_pdf_curve(model.as_ref(), &estimate, x_min, x_max) {
        Ok(points) => DistributionFittedCurveDataV1 {
            schema_version: "1".to_string(),
            points,
            provenance: provenance.clone(),
        },
        Err(failure) => {
            return Ok(failed_fit_payload(
                registration,
                fit_id,
                effective_n,
                provenance,
                failure,
            ));
        }
    };

    attach_parameter_inference(&mut estimate, observations);

    let parameters = estimate.parameters;
    debug_assert_eq!(parameters.len(), registration.estimated_parameter_count);

    Ok(DistributionFitDataV1 {
        schema_version: "1".to_string(),
        fit_id,
        distribution_id: registration.distribution_id.clone(),
        parameterization_id: registration.parameterization_id.to_string(),
        status: DistributionFitStatusV1::Available,
        reason_code: None,
        parameters,
        estimated_parameter_count: registration.estimated_parameter_count,
        effective_n,
        log_likelihood: available_fit_metric(estimate.log_likelihood)?,
        aic: metrics.aic,
        aicc: metrics.aicc,
        bic: metrics.bic,
        goodness_of_fit: Vec::new(),
        fitted_curve: Some(curve),
        diagnostics: Vec::new(),
        convergence: estimate.convergence,
        provenance,
        warnings: Vec::new(),
    })
}

fn failed_fit_payload(
    registration: &FitModelRegistrationV1,
    fit_id: String,
    effective_n: f64,
    provenance: DistributionFitProvenanceV1,
    failure: FitFailureV1,
) -> DistributionFitDataV1 {
    let status = match failure.classification {
        FitFailureClassificationV1::Input | FitFailureClassificationV1::Domain => {
            DistributionFitStatusV1::Unavailable
        }
        FitFailureClassificationV1::Optimizer
        | FitFailureClassificationV1::Objective
        | FitFailureClassificationV1::Curve => DistributionFitStatusV1::Failed,
    };
    let metric = unavailable_fit_metric(&failure.reason_code);
    DistributionFitDataV1 {
        schema_version: "1".to_string(),
        fit_id,
        distribution_id: registration.distribution_id.clone(),
        parameterization_id: registration.parameterization_id.to_string(),
        status,
        reason_code: Some(failure.reason_code.clone()),
        parameters: Vec::new(),
        estimated_parameter_count: registration.estimated_parameter_count,
        effective_n,
        log_likelihood: metric.clone(),
        aic: metric.clone(),
        aicc: metric.clone(),
        bic: metric,
        goodness_of_fit: Vec::new(),
        fitted_curve: None,
        diagnostics: Vec::new(),
        convergence: DistributionFitConvergenceV1 {
            status: DistributionFitConvergenceStatusV1::Failed,
            reason_code: Some(failure.reason_code),
            optimizer_id: registration.optimizer_id.to_string(),
            optimizer_version: registration.optimizer_version.to_string(),
            iterations: 0,
            tolerance: registration.convergence_tolerance,
            objective: None,
            gradient_norm: None,
        },
        provenance,
        warnings: Vec::new(),
    }
}

fn fit_provenance(
    registration: &FitModelRegistrationV1,
    candidate_ids: &[crate::models::distribution::ContinuousDistributionIdV1],
    context: &OneShotExecutionContext,
) -> DistributionFitProvenanceV1 {
    DistributionFitProvenanceV1 {
        method_id: registration.method_id.to_string(),
        method_version: registration.method_version.to_string(),
        parameterization_id: registration.parameterization_id.to_string(),
        optimizer_id: registration.optimizer_id.to_string(),
        optimizer_version: registration.optimizer_version.to_string(),
        initialization_strategy_id: registration.initialization_strategy_id.to_string(),
        convergence_tolerance: registration.convergence_tolerance,
        iteration_limit: registration.iteration_limit,
        dependency_versions: std::collections::BTreeMap::from([
            ("statrs".to_string(), "0.18.0".to_string()),
            ("argmin".to_string(), "0.11.0".to_string()),
        ]),
        computation_id: context.provenance_id.clone(),
        candidate_registry_ids: candidate_ids.to_vec(),
        compatibility_status: Jmp19CompatibilityStatusV1::CompatibilityPending,
    }
}

fn fit_comparison_row(payload: &DistributionFitDataV1) -> DistributionFitComparisonRowV1 {
    DistributionFitComparisonRowV1 {
        distribution_id: payload.distribution_id.clone(),
        status: payload.status.clone(),
        reason_code: payload.reason_code.clone(),
        aic: payload.aic.clone(),
        aicc: payload.aicc.clone(),
        bic: payload.bic.clone(),
    }
}

fn isolated_fit_metrics(
    log_likelihood: f64,
    parameter_count: usize,
    effective_n: f64,
) -> Result<FitMetricSetV1, FitFailureV1> {
    fit_information_criteria(log_likelihood, parameter_count, effective_n)
        .map_err(|_| objective_failure("distribution.fit.informationCriteriaInvalid.v1"))
}

fn compare_fit_rows(
    left: &DistributionFitComparisonRowV1,
    right: &DistributionFitComparisonRowV1,
) -> std::cmp::Ordering {
    let left_success = left.status == DistributionFitStatusV1::Available;
    let right_success = right.status == DistributionFitStatusV1::Available;
    match right_success.cmp(&left_success) {
        std::cmp::Ordering::Equal => {}
        ordering => return ordering,
    }
    if left_success {
        match (
            finite_fit_metric(&left.aicc),
            finite_fit_metric(&right.aicc),
        ) {
            (Some(left_aicc), Some(right_aicc)) => {
                if !fit_values_tied(left_aicc, right_aicc) {
                    return left_aicc.total_cmp(&right_aicc);
                }
                return distribution_id(left.distribution_id.clone())
                    .cmp(distribution_id(right.distribution_id.clone()));
            }
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            (None, None) => {}
        }
        match compare_optional_metric(&left.aic, &right.aic) {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    distribution_id(left.distribution_id.clone())
        .cmp(distribution_id(right.distribution_id.clone()))
}

fn compare_optional_metric(
    left: &CapabilityTypedValueV1,
    right: &CapabilityTypedValueV1,
) -> std::cmp::Ordering {
    match (finite_fit_metric(left), finite_fit_metric(right)) {
        (Some(left), Some(right)) if fit_values_tied(left, right) => std::cmp::Ordering::Equal,
        (Some(left), Some(right)) => left.total_cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn finite_fit_metric(metric: &CapabilityTypedValueV1) -> Option<f64> {
    (metric.state == "available")
        .then_some(metric.value)
        .flatten()
        .filter(|value| value.is_finite())
}

fn fit_values_tied(left: f64, right: f64) -> bool {
    let difference = (left - right).abs();
    difference <= 1e-10 || difference <= 1e-9 * left.abs().max(right.abs())
}

fn available_fit_metric(value: f64) -> Result<CapabilityTypedValueV1, AppError> {
    if !value.is_finite() {
        return Err(AppError::Stats(
            "distribution.fit.logLikelihoodInvalid.v1".to_string(),
        ));
    }
    Ok(CapabilityTypedValueV1 {
        state: "available".to_string(),
        value: Some(value),
        reason_code: None,
    })
}

fn unavailable_fit_metric(reason_code: &str) -> CapabilityTypedValueV1 {
    CapabilityTypedValueV1 {
        state: "unavailable".to_string(),
        value: None,
        reason_code: Some(reason_code.to_string()),
    }
}

fn distribution_id(
    distribution: crate::models::distribution::ContinuousDistributionIdV1,
) -> &'static str {
    use crate::models::distribution::ContinuousDistributionIdV1;
    match distribution {
        ContinuousDistributionIdV1::Normal => "normal",
        ContinuousDistributionIdV1::Lognormal => "lognormal",
        ContinuousDistributionIdV1::Exponential => "exponential",
        ContinuousDistributionIdV1::Gamma => "gamma",
        ContinuousDistributionIdV1::Weibull => "weibull",
        ContinuousDistributionIdV1::Unknown => "unknown",
    }
}

fn fit_status(status: DistributionFitStatusV1) -> &'static str {
    match status {
        DistributionFitStatusV1::Available => "available",
        DistributionFitStatusV1::Unavailable => "unavailable",
        DistributionFitStatusV1::Failed => "failed",
    }
}

fn map_capability_indices(
    indices: crate::services::normal_capability::NormalCapabilityIndicesV1,
) -> ProcessCapabilityIndicesV1 {
    ProcessCapabilityIndicesV1 {
        cp: map_capability_value(indices.cp),
        cpk: map_capability_value(indices.cpk),
        cpl: map_capability_value(indices.cpl),
        cpu: map_capability_value(indices.cpu),
        cpm_within: map_capability_value(indices.cpm_within),
        pp: map_capability_value(indices.pp),
        ppk: map_capability_value(indices.ppk),
        ppl: map_capability_value(indices.ppl),
        ppu: map_capability_value(indices.ppu),
        cpm_overall: map_capability_value(indices.cpm_overall),
    }
}

fn map_capability_value(value: TypedValueV1) -> CapabilityTypedValueV1 {
    CapabilityTypedValueV1 {
        state: match value.state {
            NumericStateV1::Available => "available",
            NumericStateV1::NotApplicable => "notApplicable",
            NumericStateV1::Unavailable => "unavailable",
            NumericStateV1::Unbounded => "unbounded",
        }
        .to_string(),
        value: value.value,
        reason_code: value.reason_code,
    }
}

fn map_capability_count(value: TypedCountV1) -> CapabilityTypedCountV1 {
    CapabilityTypedCountV1 {
        state: match value.state {
            NumericStateV1::Available => "available",
            NumericStateV1::NotApplicable => "notApplicable",
            NumericStateV1::Unavailable => "unavailable",
            NumericStateV1::Unbounded => "unbounded",
        }
        .to_string(),
        value: value.value,
        reason_code: value.reason_code,
    }
}

fn map_capability_interval(value: CapabilityIntervalV1) -> ProcessCapabilityIntervalV1 {
    ProcessCapabilityIntervalV1 {
        lower: map_capability_value(value.lower),
        upper: map_capability_value(value.upper),
        interval_method: value.interval_method,
        limiting_side: value.limiting_side,
        warnings: value.warnings,
    }
}

fn map_capability_intervals(value: NormalCapabilityIntervalsV1) -> ProcessCapabilityIntervalsV1 {
    ProcessCapabilityIntervalsV1 {
        confidence_level: value.confidence_level,
        cp: map_capability_interval(value.cp),
        cpk: map_capability_interval(value.cpk),
        cpl: map_capability_interval(value.cpl),
        cpu: map_capability_interval(value.cpu),
        cpm_within: map_capability_interval(value.cpm_within),
        pp: map_capability_interval(value.pp),
        ppk: map_capability_interval(value.ppk),
        ppl: map_capability_interval(value.ppl),
        ppu: map_capability_interval(value.ppu),
        cpm_overall: map_capability_interval(value.cpm_overall),
        provenance: ProcessCapabilityIntervalProvenanceV1 {
            distribution_crate: value.provenance.distribution_crate,
            distribution_crate_version: value.provenance.distribution_crate_version,
            parameterization: value.provenance.parameterization,
            inverse_cdf_algorithm_id: value.provenance.inverse_cdf_algorithm_id,
            method_version: value.provenance.method_version,
            within_effective_degrees_of_freedom: value
                .provenance
                .within_effective_degrees_of_freedom,
        },
    }
}

fn map_nonconformance(value: NormalNonconformanceV1) -> ProcessCapabilityNonconformanceV1 {
    ProcessCapabilityNonconformanceV1 {
        observed: ProcessCapabilityObservedNonconformanceV1 {
            below: map_observed_tail(value.observed.below),
            above: map_observed_tail(value.observed.above),
            total: map_observed_tail(value.observed.total),
        },
        expected_within: map_expected_sigma(value.expected_within),
        expected_overall: map_expected_sigma(value.expected_overall),
    }
}

fn map_observed_tail(
    value: crate::services::normal_capability::ObservedNonconformanceTailV1,
) -> ProcessCapabilityObservedTailV1 {
    ProcessCapabilityObservedTailV1 {
        count: map_capability_count(value.count),
        proportion: map_capability_value(value.proportion),
        ppm: map_capability_value(value.ppm),
        proportion_interval: ProcessCapabilityProportionIntervalV1 {
            lower: map_capability_value(value.proportion_interval.lower),
            upper: map_capability_value(value.proportion_interval.upper),
            interval_method: value.proportion_interval.interval_method,
        },
    }
}

fn map_expected_sigma(
    value: crate::services::normal_capability::ExpectedNonconformanceBySigmaV1,
) -> ProcessCapabilityExpectedNonconformanceBySigmaV1 {
    ProcessCapabilityExpectedNonconformanceBySigmaV1 {
        below: map_expected_tail(value.below),
        above: map_expected_tail(value.above),
        total: map_expected_tail(value.total),
    }
}

fn map_expected_tail(
    value: crate::services::normal_capability::ExpectedNonconformanceTailV1,
) -> ProcessCapabilityExpectedTailV1 {
    ProcessCapabilityExpectedTailV1 {
        proportion: map_capability_value(value.proportion),
        ppm: map_capability_value(value.ppm),
    }
}

fn map_capability_chart_data(value: NormalCapabilityChartDataV1) -> ProcessCapabilityChartDataV1 {
    ProcessCapabilityChartDataV1 {
        bins: value
            .bins
            .into_iter()
            .map(|bin| ProcessCapabilityChartBinV1 {
                lower: bin.lower,
                upper: bin.upper,
                count: bin.count,
                probability: bin.probability,
                density: bin.density,
                below_count: bin.below_count,
                above_count: bin.above_count,
            })
            .collect(),
        specification_lines: ProcessCapabilitySpecificationLinesV1 {
            lsl: value.specification_lines.lsl,
            target: value.specification_lines.target,
            usl: value.specification_lines.usl,
            source: value.specification_lines.source,
        },
        overall_density: map_capability_density_series(value.overall_density),
        within_density: value.within_density.map(map_capability_density_series),
        provenance: ProcessCapabilityChartProvenanceV1 {
            capability_method: value.provenance.capability_method,
            normal_density_method: value.provenance.normal_density_method,
            computation_id: value.provenance.computation_id,
            spec_fingerprint: value.provenance.spec_fingerprint,
        },
    }
}

fn map_capability_density_series(
    value: CapabilityDensitySeriesV1,
) -> ProcessCapabilityDensitySeriesV1 {
    ProcessCapabilityDensitySeriesV1 {
        state: match value.state {
            NumericStateV1::Available => "available",
            NumericStateV1::NotApplicable => "notApplicable",
            NumericStateV1::Unavailable => "unavailable",
            NumericStateV1::Unbounded => "unbounded",
        }
        .to_string(),
        reason_code: value.reason_code,
        coordinates: value
            .coordinates
            .into_iter()
            .map(|point| DistributionCoordinateV1 {
                x: point.x,
                y: point.y,
            })
            .collect(),
    }
}

fn specification_fingerprint(
    limits: &crate::services::normal_capability::SpecificationLimitsV1,
) -> Result<String, AppError> {
    let canonical = serde_json::to_vec(&serde_json::json!({
        "lsl": limits.lsl,
        "target": limits.target,
        "usl": limits.usl,
        "source": match limits.source {
            SpecificationSourceV1::ColumnProperty => "columnProperty",
            SpecificationSourceV1::AnalysisOverride => "analysisOverride",
        }
    }))
    .map_err(|error| AppError::InvalidParam(format!("invalid specification: {error}")))?;
    let digest = Sha256::digest(canonical);
    Ok(format!("spec:sha256:{digest:x}"))
}

fn capability_override(
    request: &DistributionRequestV1,
) -> Result<Option<SpecificationOverrideV1>, AppError> {
    let matches = request
        .capability_overrides
        .iter()
        .filter(|item| item.capability_id == "capability.normal.individuals")
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() > 1 {
        return Err(AppError::InvalidParam(
            "capability.invalidOverride.v1".to_string(),
        ));
    }
    let envelope = matches[0];
    if envelope.payload_schema_version != "1" {
        return Err(AppError::InvalidParam(
            "capability.invalidOverride.v1".to_string(),
        ));
    }
    serde_json::from_value::<SpecificationOverrideV1>(envelope.payload.clone())
        .map(Some)
        .map_err(|_| AppError::InvalidParam("capability.invalidOverride.v1".to_string()))
}

fn chart_provenance(
    method_id: &str,
    context: &OneShotExecutionContext,
) -> DistributionChartProvenanceV1 {
    chart_provenance_with_status(
        method_id,
        Jmp19CompatibilityStatusV1::CompatibilityPending,
        context,
    )
}

fn chart_provenance_with_status(
    method_id: &str,
    compatibility_status: Jmp19CompatibilityStatusV1,
    context: &OneShotExecutionContext,
) -> DistributionChartProvenanceV1 {
    chart_provenance_with_status_and_version(method_id, "1.0.0", compatibility_status, context)
}

fn chart_provenance_with_status_and_version(
    method_id: &str,
    method_version: &str,
    compatibility_status: Jmp19CompatibilityStatusV1,
    context: &OneShotExecutionContext,
) -> DistributionChartProvenanceV1 {
    DistributionChartProvenanceV1 {
        method_id: method_id.to_string(),
        method_version: method_version.to_string(),
        compatibility_status,
        computation_id: context.provenance_id.clone(),
    }
}

fn validate_run_request(request: &DistributionRequestV1) -> Result<(), AppError> {
    use std::collections::HashSet;

    if request.schema_version != "1" {
        return Err(AppError::InvalidParam(
            "distribution.run.unsupportedSchemaVersion".to_string(),
        ));
    }
    if request.analysis_id.trim().is_empty() || request.config_revision == 0 {
        return Err(AppError::InvalidParam(
            "distribution.run.invalidIdentity".to_string(),
        ));
    }
    if request
        .source_dataset_id
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return Err(AppError::InvalidParam(
            "distribution.run.sourceRequired".to_string(),
        ));
    }
    if request.y_columns.is_empty() {
        return Err(AppError::InvalidParam(
            "distribution.config.yRequired".to_string(),
        ));
    }
    if !request.confidence_level.is_finite()
        || request.confidence_level <= 0.0
        || request.confidence_level >= 1.0
    {
        return Err(AppError::InvalidParam(
            "distribution.config.confidenceOutOfRange".to_string(),
        ));
    }
    let histogram = &request.visual_diagnostics.histogram;
    if matches!(
        histogram.method,
        crate::models::distribution::HistogramMethodV1::FixedCount
    ) {
        let Some(fixed_count) = histogram.fixed_count else {
            return Err(AppError::InvalidParam(
                "distribution.config.histogramFixedCountOutOfRange".to_string(),
            ));
        };
        if !(1..=1000).contains(&fixed_count) {
            return Err(AppError::InvalidParam(
                "distribution.config.histogramFixedCountOutOfRange".to_string(),
            ));
        }
    }
    if matches!(
        histogram.method,
        crate::models::distribution::HistogramMethodV1::FixedWidth
    ) {
        let Some(fixed_width) = histogram.fixed_width else {
            return Err(AppError::InvalidParam(
                "distribution.config.histogramFixedWidthInvalid".to_string(),
            ));
        };
        if !fixed_width.is_finite() || fixed_width <= 0.0 {
            return Err(AppError::InvalidParam(
                "distribution.config.histogramFixedWidthInvalid".to_string(),
            ));
        }
    }
    let normal_quantile_confidence = request.visual_diagnostics.normal_quantile_confidence_level;
    if !normal_quantile_confidence.is_finite()
        || normal_quantile_confidence <= 0.0
        || normal_quantile_confidence >= 1.0
    {
        return Err(AppError::InvalidParam(
            "distribution.config.normalQuantileConfidenceOutOfRange".to_string(),
        ));
    }
    if request.continuous_fit.fit_all && !request.continuous_fit.enabled_distribution_ids.is_empty()
    {
        return Err(AppError::InvalidParam(
            "distribution.config.continuousFitSelectionConflict".to_string(),
        ));
    }
    let mut fit_ids = HashSet::new();
    for distribution in &request.continuous_fit.enabled_distribution_ids {
        if matches!(
            distribution,
            crate::models::distribution::ContinuousDistributionIdV1::Unknown
        ) {
            return Err(AppError::InvalidParam(
                "distribution.config.continuousFitUnknown".to_string(),
            ));
        }
        if !fit_ids.insert(distribution_id(distribution.clone())) {
            return Err(AppError::InvalidParam(
                "distribution.config.continuousFitDuplicate".to_string(),
            ));
        }
    }
    let mut occupied = HashSet::new();
    for column in &request.y_columns {
        if column.modeling_type
            != crate::models::distribution::DistributionModelingTypeV1::Continuous
        {
            return Err(AppError::InvalidParam(
                "distribution.config.yTypeIncompatible".to_string(),
            ));
        }
        if !occupied.insert(column.column_id.as_str()) {
            return Err(AppError::InvalidParam(
                "distribution.config.roleDuplicate".to_string(),
            ));
        }
    }
    for column_id in [
        request.weight_column_id.as_deref(),
        request.frequency_column_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !occupied.insert(column_id) {
            return Err(AppError::InvalidParam(
                "distribution.config.roleConflict".to_string(),
            ));
        }
    }
    for column_id in &request.by_column_ids {
        if !occupied.insert(column_id.as_str()) {
            return Err(AppError::InvalidParam(
                "distribution.config.roleConflict".to_string(),
            ));
        }
    }
    if request.resource_budget.max_groups == 0
        || request.resource_budget.max_rows_per_group == 0
        || request.resource_budget.max_total_rows == 0
        || request.resource_budget.max_total_bytes == 0
    {
        return Err(AppError::InvalidParam(
            "distribution.run.invalidResourceBudget".to_string(),
        ));
    }
    let mut enabled_capabilities = HashSet::new();
    if request.enabled_capability_ids.iter().any(|capability_id| {
        capability_id.is_empty() || !enabled_capabilities.insert(capability_id)
    }) {
        return Err(AppError::InvalidParam(
            "distribution.config.duplicateCapability".to_string(),
        ));
    }
    let mut override_keys = HashSet::new();
    for capability_override in &request.capability_overrides {
        if capability_override.schema_version != "1"
            || capability_override.capability_id.is_empty()
            || capability_override.payload_schema_version.is_empty()
            || !enabled_capabilities.contains(&capability_override.capability_id)
            || !override_keys.insert((
                capability_override.capability_id.as_str(),
                capability_override.payload_schema_version.as_str(),
            ))
        {
            return Err(AppError::InvalidParam(
                "distribution.config.invalidCapabilityOverride".to_string(),
            ));
        }
    }
    Ok(())
}

fn is_machine_id(value: &str) -> bool {
    if value.is_empty() || std::path::Path::new(value).is_absolute() {
        return false;
    }
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        })
}

fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit())
    })
}

fn black_box_value_is_sanitized(value: &crate::models::distribution::BlackBoxValueV1) -> bool {
    use crate::models::distribution::BlackBoxValueV1;
    match value {
        BlackBoxValueV1::Number(number) => number.is_finite(),
        BlackBoxValueV1::Boolean(_) | BlackBoxValueV1::Null => true,
        BlackBoxValueV1::Code(code) => is_machine_id(code),
        BlackBoxValueV1::NumberList(values) => values.iter().all(|value| value.is_finite()),
        BlackBoxValueV1::CodeList(values) => values.iter().all(|value| is_machine_id(value)),
    }
}

fn black_box_observation_is_sanitized(
    observation: &crate::models::distribution::BlackBoxObservationV1,
) -> bool {
    use crate::models::distribution::BlackBoxObservationV1;
    match observation {
        BlackBoxObservationV1::Numeric { output_id, value } => {
            is_machine_id(output_id) && value.is_finite()
        }
        BlackBoxObservationV1::Enumeration { output_id, value } => {
            is_machine_id(output_id) && is_machine_id(value)
        }
        BlackBoxObservationV1::Status { output_id, .. } => is_machine_id(output_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::distribution::{
        BlackBoxObservationV1, BlackBoxProvenanceV1, BlackBoxStatusV1, BlackBoxValueV1,
        DistributionColumnRefV1, DistributionModeV1, DistributionModelingTypeV1,
        DistributionRequest, DistributionRequestV1, ObservationContributionPolicyV1,
        ResourceBudgetV1,
    };
    use crate::services::data_service::DataService;
    use std::collections::HashMap;

    fn run_request() -> DistributionRequestV1 {
        DistributionRequestV1 {
            schema_version: "1".to_string(),
            analysis_id: "analysis-1".to_string(),
            config_revision: 3,
            source_dataset_id: Some("missing-dataset".to_string()),
            source_data_version: None,
            mode: DistributionModeV1::Continuous,
            y_columns: vec![DistributionColumnRefV1 {
                column_id: "value".to_string(),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: None,
            frequency_column_id: None,
            by_column_ids: Vec::new(),
            filter_expr: crate::models::distribution::FilterExprV1::And { exprs: Vec::new() },
            confidence_level: 0.95,
            histograms_only: false,
            continuous_fit: crate::models::distribution::DistributionContinuousFitConfigV1::default(
            ),
            visual_diagnostics:
                crate::models::distribution::DistributionVisualDiagnosticsConfigV1::default(),
            enabled_capability_ids: Vec::new(),
            capability_overrides: Vec::new(),
            observation_policy: ObservationContributionPolicyV1::strict_v1()
                .expect("observation policy"),
            resource_budget: ResourceBudgetV1::default(),
            exact: true,
        }
    }

    fn one_shot_context(config_revision: u64) -> OneShotExecutionContext {
        OneShotExecutionContext {
            provenance_id: format!("distribution:test:{config_revision}"),
        }
    }

    fn create_value_freq_weight_dataset(
        state: &AppState,
        table_name: &str,
        rows: &[(f64, u64, f64)],
    ) -> (String, String, String, String) {
        let data = DataService::new(state);
        let dataset = data
            .create_table(
                table_name,
                &["value".into(), "freq".into(), "weight".into()],
                &["DOUBLE".into(), "BIGINT".into(), "DOUBLE".into()],
            )
            .expect("create dataset");
        for (value, frequency, weight) in rows {
            let row_id = data.add_row(&dataset.id).expect("add row");
            data.update_cell(&dataset.id, row_id, "value", &value.to_string())
                .expect("update value");
            data.update_cell(&dataset.id, row_id, "freq", &frequency.to_string())
                .expect("update freq");
            data.update_cell(&dataset.id, row_id, "weight", &weight.to_string())
                .expect("update weight");
        }
        let descriptors = state
            .db
            .lock()
            .expect("db")
            .get_distribution_columns(&dataset.id)
            .expect("columns");
        let value_id = descriptors
            .iter()
            .find(|column| column.name == "value")
            .expect("value descriptor")
            .column_id
            .clone();
        let freq_id = descriptors
            .iter()
            .find(|column| column.name == "freq")
            .expect("freq descriptor")
            .column_id
            .clone();
        let weight_id = descriptors
            .iter()
            .find(|column| column.name == "weight")
            .expect("weight descriptor")
            .column_id
            .clone();
        (dataset.id, value_id, freq_id, weight_id)
    }

    #[test]
    fn one_shot_report_echoes_generation_and_omits_lifecycle_fields() {
        let state = AppState::new().expect("test state");
        let (dataset_id, _, _, _) = create_value_freq_weight_dataset(
            &state,
            "One Shot Distribution",
            &[(1.0, 1, 2.0), (4.0, 1, 1.0)],
        );
        let generation = state
            .db
            .lock()
            .expect("db")
            .get_dataset_generation(&dataset_id)
            .expect("dataset generation");
        let request = DistributionRequest {
            dataset_id: dataset_id.clone(),
            generation,
            response_columns: vec!["value".to_string()],
            weight_column: Some("weight".to_string()),
            freq_column: None,
            by_columns: Vec::new(),
            confidence_level: 0.95,
            spec_limits: HashMap::new(),
            fit_distributions: Vec::new(),
        };

        let response = DistributionService::new(&state)
            .compute_distribution_report(&request)
            .expect("one-shot report");
        assert_eq!(response.dataset_id, dataset_id);
        assert_eq!(response.generation, generation);
        for frame in [
            &response.graph_frames.overview,
            &response.graph_frames.box_plot,
            &response.graph_frames.ecdf,
            &response.graph_frames.normal_quantile,
        ] {
            assert_eq!(frame.dataset_id, response.dataset_id);
            assert_eq!(frame.generation, generation);
        }
        let unavailable = response
            .report_blocks
            .iter()
            .find(|block| block.block.kind == "normalQuantile")
            .expect("normal quantile block");
        assert_eq!(unavailable.block.status, "unavailable");
        assert_eq!(
            unavailable.reason_code.as_deref(),
            Some("normalQuantile.weightUnsupported.v1")
        );

        let serialized = serde_json::to_value(&response).expect("serialize one-shot report");
        let graph_frames = serialized["graphFrames"]
            .as_object()
            .expect("graph frames object");
        let mut graph_roles = graph_frames.keys().map(String::as_str).collect::<Vec<_>>();
        graph_roles.sort_unstable();
        assert_eq!(
            graph_roles,
            vec!["boxPlot", "ecdf", "normalQuantile", "overview"]
        );
        fn assert_lifecycle_free(value: &serde_json::Value) {
            match value {
                serde_json::Value::Array(values) => {
                    values.iter().for_each(assert_lifecycle_free);
                }
                serde_json::Value::Object(values) => {
                    for (key, child) in values {
                        assert!(
                            !["runId", "snapshotId", "cancelToken", "progress"]
                                .contains(&key.as_str()),
                            "unexpected lifecycle field {key}"
                        );
                        assert_lifecycle_free(child);
                    }
                }
                _ => {}
            }
        }
        assert_lifecycle_free(&serialized);
    }

    #[test]
    fn one_shot_compute_is_repeatable_and_aggregates_all_responses_and_groups() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table(
                "Grouped Responses",
                &["height".into(), "width".into(), "region".into()],
                &["DOUBLE".into(), "DOUBLE".into(), "VARCHAR".into()],
            )
            .expect("create dataset");
        for (height, width, region) in [
            ("1", "10", "East"),
            ("2", "20", "East"),
            ("3", "30", "West"),
            ("4", "40", "West"),
        ] {
            let row_id = data.add_row(&dataset.id).expect("add row");
            data.update_cell(&dataset.id, row_id, "height", height)
                .expect("height");
            data.update_cell(&dataset.id, row_id, "width", width)
                .expect("width");
            data.update_cell(&dataset.id, row_id, "region", region)
                .expect("region");
        }
        let generation = state
            .db
            .lock()
            .expect("db")
            .get_dataset_generation(&dataset.id)
            .expect("generation");
        let request = DistributionRequest {
            dataset_id: dataset.id,
            generation,
            response_columns: vec!["height".to_string(), "width".to_string()],
            weight_column: None,
            freq_column: None,
            by_columns: vec!["region".to_string()],
            confidence_level: 0.95,
            spec_limits: HashMap::new(),
            fit_distributions: vec![
                crate::models::distribution::ContinuousDistributionIdV1::Normal,
            ],
        };
        let service = DistributionService::new(&state);
        let first = service
            .compute_distribution_report(&request)
            .expect("first compute");
        let second = service
            .compute_distribution_report(&request)
            .expect("second compute");

        assert_eq!(first.groups.len(), 3, "overall plus both By groups");
        assert!(first.groups.iter().all(|group| group.y_results.len() == 2));
        assert_eq!(first.graph_frames.overview.aggregates.len(), 7);
        let histograms = first
            .graph_frames
            .overview
            .aggregates
            .iter()
            .filter_map(|packet| match packet {
                GraphAggregatePacket::Histogram(packet) => Some(packet),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(histograms.len(), 1);
        assert!(histograms[0].bins.iter().all(|bin| bin.group.is_some()
            && bin.category.is_some()
            && bin.source_column.is_some()));
        let boxes = first
            .graph_frames
            .box_plot
            .aggregates
            .iter()
            .filter_map(|packet| match packet {
                GraphAggregatePacket::BoxPlot(packet) => Some(packet),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].entries.len(), 6);
        assert!(boxes[0].entries.iter().all(|entry| entry.group.is_some()
            && entry.category.is_some()
            && entry.source_column.is_some()));
        assert_eq!(first.graph_frames.ecdf.aggregates.len(), 6);
        assert_eq!(first.graph_frames.normal_quantile.aggregates.len(), 24);
        assert_eq!(
            serde_json::to_value(&first.graph_frames).expect("first frames"),
            serde_json::to_value(&second.graph_frames).expect("second frames"),
            "ordinary deterministic provenance must produce stable packet identities",
        );
    }

    mod continuous_fit {
        use super::*;
        use crate::models::distribution::{ContinuousDistributionIdV1, DistributionFitStatusV1};
        use serde::Deserialize;
        use std::fs;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CapabilityFixtureV1 {
            observations: Vec<f64>,
        }

        fn assert_close(actual: f64, expected: f64) {
            let absolute = (actual - expected).abs();
            let relative = absolute / expected.abs().max(1.0);
            assert!(
                absolute <= 1e-10 || relative <= 1e-9,
                "expected {expected}, got {actual}"
            );
        }

        fn execute_fit_request(
            state: &AppState,
            rows: &[(f64, u64, f64)],
            configure: impl FnOnce(&mut DistributionRequestV1, &str, &str),
        ) -> Result<OneShotExecutionResult, AppError> {
            let (dataset_id, value_id, frequency_id, weight_id) =
                create_value_freq_weight_dataset(state, "Continuous Fit", rows);
            let mut request = run_request();
            request.source_dataset_id = Some(dataset_id);
            request.y_columns[0].column_id = value_id;
            configure(&mut request, &frequency_id, &weight_id);
            let context = OneShotExecutionContext {
                provenance_id: "distribution:test:continuous-fit".to_string(),
            };
            DistributionService::new(state).execute_one_shot(&request, &context)
        }

        fn fit_payloads(
            result: &OneShotExecutionResult,
        ) -> Vec<&crate::models::distribution::DistributionFitDataV1> {
            result
                .report_blocks
                .iter()
                .filter_map(|block| block.distribution_fit_data.as_ref())
                .collect()
        }

        #[test]
        fn selected_normal_gamma_have_stable_blocks_and_backend_curves() {
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(
                &state,
                &[(1.0, 1, 1.0), (2.0, 1, 1.0), (4.0, 1, 1.0), (8.0, 1, 1.0)],
                |request, _, _| {
                    request.continuous_fit.enabled_distribution_ids = vec![
                        ContinuousDistributionIdV1::Normal,
                        ContinuousDistributionIdV1::Gamma,
                    ];
                },
            )
            .expect("selected fits");

            let blocks = &result.groups[0].y_results[0].blocks;
            let normal_quantile_index = blocks
                .iter()
                .position(|block| block.kind == "normalQuantile")
                .expect("normal quantile block");
            assert_eq!(blocks[normal_quantile_index + 1].kind, "continuousFit");
            assert_eq!(
                blocks[normal_quantile_index + 1].block_id,
                format!(
                    "{}-0-fit-gamma",
                    result.groups[0].y_results[0].y_column.column_id
                )
            );
            assert_eq!(blocks[normal_quantile_index + 2].kind, "continuousFit");
            assert_eq!(
                blocks[normal_quantile_index + 2].block_id,
                format!(
                    "{}-0-fit-normal",
                    result.groups[0].y_results[0].y_column.column_id
                )
            );
            assert_eq!(blocks[normal_quantile_index + 3].kind, "boxPlot");

            let payloads = fit_payloads(&result);
            assert_eq!(payloads.len(), 2);
            assert!(payloads.iter().all(|payload| {
                payload.status == DistributionFitStatusV1::Available
                    && payload
                        .fitted_curve
                        .as_ref()
                        .is_some_and(|curve| curve.points.len() == 256)
            }));
            let gamma = payloads
                .iter()
                .find(|payload| payload.distribution_id == ContinuousDistributionIdV1::Gamma)
                .unwrap();
            assert_eq!(gamma.estimated_parameter_count, 2);
            assert!(!gamma
                .parameters
                .iter()
                .any(|parameter| parameter.parameter_id == "location"));
            assert!(gamma.parameters.iter().all(|parameter| {
                parameter.standard_error.value.is_some_and(f64::is_finite)
                    && parameter.lower_confidence.value.is_some_and(f64::is_finite)
                    && parameter.upper_confidence.value.is_some_and(f64::is_finite)
            }));
        }

        #[test]
        fn exponential_n51_payload_uses_one_estimated_parameter_for_information_criteria() {
            let path = format!(
                "{}/../tests/fixtures/distribution/process-capability-moving-range-v1.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let fixture: CapabilityFixtureV1 =
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            let rows = fixture
                .observations
                .into_iter()
                .map(|value| (value, 1, 1.0))
                .collect::<Vec<_>>();
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(&state, &rows, |request, _, _| {
                request.continuous_fit.enabled_distribution_ids =
                    vec![ContinuousDistributionIdV1::Exponential];
            })
            .expect("exponential fit");
            let fit = fit_payloads(&result)[0];

            assert_eq!(fit.status, DistributionFitStatusV1::Available);
            assert_eq!(fit.estimated_parameter_count, 1);
            assert_eq!(fit.parameters.len(), 1);
            assert!(!fit
                .parameters
                .iter()
                .any(|parameter| parameter.parameter_id == "location"));
            assert!(fit.parameters[0]
                .standard_error
                .value
                .is_some_and(f64::is_finite));
            assert!(fit.parameters[0]
                .lower_confidence
                .value
                .is_some_and(f64::is_finite));
            assert!(fit.parameters[0]
                .upper_confidence
                .value
                .is_some_and(f64::is_finite));
            assert_close(-2.0 * fit.log_likelihood.value.unwrap(), 740.6183972);
            assert_close(fit.aicc.value.unwrap(), 742.7000298);
            assert_close(fit.bic.value.unwrap(), 744.5502228);
        }

        #[test]
        fn fit_all_isolates_domain_failures_and_emits_one_sorted_comparison() {
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(
                &state,
                &[(-2.0, 1, 1.0), (-1.0, 1, 1.0), (1.0, 1, 1.0), (3.0, 1, 1.0)],
                |request, _, _| request.continuous_fit.fit_all = true,
            )
            .expect("fit all partial failure");

            let payloads = fit_payloads(&result);
            assert_eq!(payloads.len(), 5);
            let normal = payloads
                .iter()
                .find(|payload| payload.distribution_id == ContinuousDistributionIdV1::Normal)
                .expect("normal fit");
            assert_eq!(normal.status, DistributionFitStatusV1::Available);
            assert!(payloads
                .iter()
                .filter(|payload| { payload.distribution_id != ContinuousDistributionIdV1::Normal })
                .all(|payload| {
                    payload.status == DistributionFitStatusV1::Unavailable
                        && payload.reason_code.is_some()
                        && payload.fitted_curve.is_none()
                }));

            let comparison_blocks = result
                .report_blocks
                .iter()
                .filter(|block| block.kind == "fitComparison")
                .collect::<Vec<_>>();
            assert_eq!(comparison_blocks.len(), 1);
            let comparison =
                serde_json::to_value(comparison_blocks[0]).expect("serialize comparison block");
            let rows = comparison["distributionFitComparisonData"]["rows"]
                .as_array()
                .expect("typed comparison rows");
            assert_eq!(rows.len(), 5);
            assert_eq!(rows[0]["distributionId"], "normal");
            assert!(rows[1..].windows(2).all(|pair| {
                pair[0]["distributionId"].as_str() <= pair[1]["distributionId"].as_str()
            }));
        }

        #[test]
        fn fit_all_positive_payloads_expose_only_inferred_free_parameters() {
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(
                &state,
                &[
                    (0.5, 1, 1.0),
                    (1.0, 1, 1.0),
                    (2.0, 1, 1.0),
                    (4.0, 1, 1.0),
                    (8.0, 1, 1.0),
                ],
                |request, _, _| request.continuous_fit.fit_all = true,
            )
            .expect("fit all positive data");
            let payloads = fit_payloads(&result);

            assert_eq!(payloads.len(), 5);
            for payload in payloads {
                assert_eq!(payload.status, DistributionFitStatusV1::Available);
                assert_eq!(payload.parameters.len(), payload.estimated_parameter_count);
                assert!(!payload.parameters.iter().any(|parameter| {
                    parameter.parameter_id == "location"
                        && payload.distribution_id != ContinuousDistributionIdV1::Normal
                }));
                assert!(payload.parameters.iter().all(|parameter| {
                    parameter.value.value.is_some_and(f64::is_finite)
                        && parameter.standard_error.value.is_some_and(f64::is_finite)
                        && parameter.lower_confidence.value.is_some_and(f64::is_finite)
                        && parameter.upper_confidence.value.is_some_and(f64::is_finite)
                }));
            }
        }

        #[test]
        fn validation_rejects_duplicate_unknown_and_conflicting_selection() {
            let mut duplicate = run_request();
            duplicate.continuous_fit.enabled_distribution_ids = vec![
                ContinuousDistributionIdV1::Normal,
                ContinuousDistributionIdV1::Normal,
            ];
            assert!(matches!(
                validate_run_request(&duplicate),
                Err(AppError::InvalidParam(code)) if code == "distribution.config.continuousFitDuplicate"
            ));

            let mut unknown = run_request();
            unknown.continuous_fit.enabled_distribution_ids =
                vec![ContinuousDistributionIdV1::Unknown];
            assert!(matches!(
                validate_run_request(&unknown),
                Err(AppError::InvalidParam(code)) if code == "distribution.config.continuousFitUnknown"
            ));

            let mut conflict = run_request();
            conflict.continuous_fit.fit_all = true;
            conflict.continuous_fit.enabled_distribution_ids =
                vec![ContinuousDistributionIdV1::Normal];
            assert!(matches!(
                validate_run_request(&conflict),
                Err(AppError::InvalidParam(code)) if code == "distribution.config.continuousFitSelectionConflict"
            ));
        }

        #[test]
        fn histograms_only_suppresses_fit_and_comparison_blocks() {
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(
                &state,
                &[(1.0, 1, 1.0), (2.0, 1, 1.0), (4.0, 1, 1.0)],
                |request, _, _| {
                    request.histograms_only = true;
                    request.continuous_fit.fit_all = true;
                },
            )
            .expect("histograms only");
            assert!(result
                .report_blocks
                .iter()
                .all(|block| { block.kind != "continuousFit" && block.kind != "fitComparison" }));
        }

        #[test]
        fn frequency_expansion_and_weight_effective_n_are_preserved() {
            let compact_state = AppState::new().expect("compact state");
            let compact = execute_fit_request(
                &compact_state,
                &[(1.0, 2, 1.0), (4.0, 1, 1.0)],
                |request, frequency_id, _| {
                    request.frequency_column_id = Some(frequency_id.to_string());
                    request.continuous_fit.enabled_distribution_ids =
                        vec![ContinuousDistributionIdV1::Normal];
                },
            )
            .expect("compact frequency fit");
            let expanded_state = AppState::new().expect("expanded state");
            let expanded = execute_fit_request(
                &expanded_state,
                &[(1.0, 1, 1.0), (1.0, 1, 1.0), (4.0, 1, 1.0)],
                |request, _, _| {
                    request.continuous_fit.enabled_distribution_ids =
                        vec![ContinuousDistributionIdV1::Normal];
                },
            )
            .expect("expanded frequency fit");
            let compact_fit = fit_payloads(&compact)[0];
            let expanded_fit = fit_payloads(&expanded)[0];
            assert_eq!(compact_fit.parameters, expanded_fit.parameters);
            assert_eq!(compact_fit.log_likelihood, expanded_fit.log_likelihood);
            assert_eq!(compact_fit.aic, expanded_fit.aic);

            let weighted_state = AppState::new().expect("weighted state");
            let weighted = execute_fit_request(
                &weighted_state,
                &[(1.0, 2, 1.0), (4.0, 1, 3.0)],
                |request, frequency_id, weight_id| {
                    request.frequency_column_id = Some(frequency_id.to_string());
                    request.weight_column_id = Some(weight_id.to_string());
                    request.continuous_fit.enabled_distribution_ids =
                        vec![ContinuousDistributionIdV1::Normal];
                },
            )
            .expect("weighted fit");
            assert!((fit_payloads(&weighted)[0].effective_n - 25.0 / 11.0).abs() < 1e-12);
        }

        #[test]
        fn available_fit_serialization_has_only_finite_numbers() {
            let state = AppState::new().expect("test state");
            let result = execute_fit_request(
                &state,
                &[(1.0, 1, 1.0), (2.0, 1, 1.0), (4.0, 1, 1.0), (8.0, 1, 1.0)],
                |request, _, _| request.continuous_fit.fit_all = true,
            )
            .expect("fit all");
            let serialized = serde_json::to_string(&result).expect("serialize fit result");
            assert!(!serialized.contains("NaN"));
            assert!(!serialized.contains("Infinity"));
        }

        fn comparison_row(
            distribution_id: ContinuousDistributionIdV1,
            status: DistributionFitStatusV1,
            aic: Option<f64>,
            aicc: Option<f64>,
        ) -> DistributionFitComparisonRowV1 {
            let metric = |value: Option<f64>| CapabilityTypedValueV1 {
                state: if value.is_some() {
                    "available"
                } else {
                    "unavailable"
                }
                .to_string(),
                value,
                reason_code: None,
            };
            DistributionFitComparisonRowV1 {
                distribution_id,
                status,
                reason_code: None,
                aic: metric(aic),
                aicc: metric(aicc),
                bic: metric(None),
            }
        }

        #[test]
        fn comparison_uses_aicc_then_aic_fallback_and_stable_id_ties() {
            let normal = comparison_row(
                ContinuousDistributionIdV1::Normal,
                DistributionFitStatusV1::Available,
                Some(1.0),
                Some(10.0 + 5e-11),
            );
            let gamma = comparison_row(
                ContinuousDistributionIdV1::Gamma,
                DistributionFitStatusV1::Available,
                Some(100.0),
                Some(10.0),
            );
            assert_eq!(compare_fit_rows(&gamma, &normal), std::cmp::Ordering::Less);

            let normal_without_aicc = comparison_row(
                ContinuousDistributionIdV1::Normal,
                DistributionFitStatusV1::Available,
                Some(20.0),
                None,
            );
            let gamma_without_aicc = comparison_row(
                ContinuousDistributionIdV1::Gamma,
                DistributionFitStatusV1::Available,
                Some(10.0),
                None,
            );
            assert_eq!(
                compare_fit_rows(&gamma_without_aicc, &normal_without_aicc),
                std::cmp::Ordering::Less
            );

            let failed_gamma = comparison_row(
                ContinuousDistributionIdV1::Gamma,
                DistributionFitStatusV1::Failed,
                None,
                None,
            );
            assert_eq!(
                compare_fit_rows(&normal_without_aicc, &failed_gamma),
                std::cmp::Ordering::Less
            );
        }

        #[test]
        fn non_finite_derived_fit_metrics_are_isolated_as_objective_failures() {
            let failure = isolated_fit_metrics(-f64::MAX, 2, 10.0)
                .expect_err("overflowing information criteria must be isolated");
            assert_eq!(
                failure.classification,
                FitFailureClassificationV1::Objective
            );
            assert_eq!(
                failure.reason_code,
                "distribution.fit.informationCriteriaInvalid.v1"
            );
        }
    }

    fn extract_normal_quantile_payload(
        result: &OneShotExecutionResult,
    ) -> &crate::models::distribution::NormalQuantileDataV1 {
        let block = result
            .report_blocks
            .iter()
            .find(|candidate| candidate.kind == "normalQuantile")
            .expect("normal quantile block");
        match block.chart_data.as_ref().expect("normal quantile chart") {
            crate::models::distribution::DistributionChartDataV1::NormalQuantileData {
                payload,
                ..
            } => payload,
            _ => panic!("normal quantile block must contain normalQuantileData"),
        }
    }

    fn assert_normal_quantile_payload_finite(
        payload: &crate::models::distribution::NormalQuantileDataV1,
    ) {
        for point in &payload.points {
            assert!(point.rank.is_finite());
            assert!(point.probability.is_finite());
            assert!(point.normal_score.is_finite());
            assert!(point.observed_value.is_finite());
        }
        for point in &payload.reference_line {
            assert!(point.x.is_finite());
            assert!(point.y.is_finite());
        }
        for band in &payload.confidence_band {
            assert!(band.x.is_finite());
            assert!(band.lower.is_finite());
            assert!(band.upper.is_finite());
        }
    }

    #[test]
    fn run_request_rejects_normal_quantile_confidence_outside_open_interval() {
        let mut low = run_request();
        low.visual_diagnostics.normal_quantile_confidence_level = 0.0;
        let low_error =
            validate_run_request(&low).expect_err("normal quantile confidence 0 must reject");
        assert!(matches!(
            low_error,
            AppError::InvalidParam(code)
                if code == "distribution.config.normalQuantileConfidenceOutOfRange"
        ));

        let mut high = run_request();
        high.visual_diagnostics.normal_quantile_confidence_level = 1.0;
        let high_error =
            validate_run_request(&high).expect_err("normal quantile confidence 1 must reject");
        assert!(matches!(
            high_error,
            AppError::InvalidParam(code)
                if code == "distribution.config.normalQuantileConfidenceOutOfRange"
        ));
    }

    #[test]
    fn run_request_rejects_histogram_fixed_count_out_of_range() {
        let mut request = run_request();
        request.visual_diagnostics.histogram.method =
            crate::models::distribution::HistogramMethodV1::FixedCount;
        request.visual_diagnostics.histogram.fixed_count = Some(0);

        let error = validate_run_request(&request).expect_err("fixedCount=0 must reject");
        assert!(matches!(
            error,
            AppError::InvalidParam(code)
                if code == "distribution.config.histogramFixedCountOutOfRange"
        ));

        request.visual_diagnostics.histogram.fixed_count = Some(1001);
        let error = validate_run_request(&request).expect_err("fixedCount=1001 must reject");
        assert!(matches!(
            error,
            AppError::InvalidParam(code)
                if code == "distribution.config.histogramFixedCountOutOfRange"
        ));
    }

    #[test]
    fn run_request_rejects_histogram_fixed_width_non_positive_or_non_finite() {
        let mut request = run_request();
        request.visual_diagnostics.histogram.method =
            crate::models::distribution::HistogramMethodV1::FixedWidth;
        request.visual_diagnostics.histogram.fixed_width = Some(0.0);

        let zero_error = validate_run_request(&request).expect_err("fixedWidth=0 must reject");
        assert!(matches!(
            zero_error,
            AppError::InvalidParam(code)
                if code == "distribution.config.histogramFixedWidthInvalid"
        ));

        request.visual_diagnostics.histogram.fixed_width = Some(f64::NAN);
        let nan_error = validate_run_request(&request).expect_err("fixedWidth=NaN must reject");
        assert!(matches!(
            nan_error,
            AppError::InvalidParam(code)
                if code == "distribution.config.histogramFixedWidthInvalid"
        ));
    }

    #[test]
    fn run_request_rejects_conflicting_roles_before_registry_dispatch() {
        let mut request = run_request();
        request.by_column_ids.push("value".to_string());

        let error = validate_run_request(&request).expect_err("role conflict must reject");
        assert!(matches!(
            error,
            AppError::InvalidParam(code) if code == "distribution.config.roleConflict"
        ));
    }

    fn synthetic_black_box_case() -> BlackBoxCaseV1 {
        BlackBoxCaseV1 {
            schema_version: "1".to_string(),
            case_id: "case.synthetic.001".to_string(),
            action_id: "distribution.synthetic.summary".to_string(),
            provenance: BlackBoxProvenanceV1 {
                source_ledger_hash: format!("sha256:{}", "1".repeat(64)),
                input_hash: format!("sha256:{}", "2".repeat(64)),
                output_hash: format!("sha256:{}", "3".repeat(64)),
                tool_version: "validator.v1".to_string(),
                seed: "seed.synthetic.001".to_string(),
                review_artifact_hash: format!("sha256:{}", "4".repeat(64)),
            },
            inputs: std::collections::BTreeMap::from([(
                "parameter.alpha".to_string(),
                BlackBoxValueV1::Number(0.05),
            )]),
            expected: vec![BlackBoxObservationV1::Status {
                output_id: "result.status".to_string(),
                value: BlackBoxStatusV1::Available,
            }],
            observed: vec![BlackBoxObservationV1::Numeric {
                output_id: "result.value".to_string(),
                value: 1.25,
            }],
            warnings: vec!["warning.synthetic.none".to_string()],
        }
    }

    #[test]
    fn capability_registry_exposes_only_implemented_methods() {
        let state = AppState::new().expect("test state");
        let capabilities = DistributionService::new(&state)
            .list_distribution_capabilities()
            .expect("capabilities");

        assert_eq!(
            capabilities
                .iter()
                .map(|capability| capability.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "quantile.type6.weighted",
                "summary.continuous.core",
                "histogram.freedmanDiaconis",
                "boxplot.tukey.weighted",
                "ecdf.weighted",
                "capability.normal.individuals",
                "fit.continuous.normal",
                "fit.continuous.lognormal",
                "fit.continuous.exponential",
                "fit.continuous.gamma",
                "fit.continuous.weibull",
            ],
        );
        assert!(!capabilities.iter().any(|capability| [
            "cauchy",
            "studentT",
            "shash",
            "johnson",
            "mixture",
            "smoothCurve"
        ]
        .iter()
        .any(|future| capability.id.contains(future))));
    }

    #[test]
    fn executes_continuous_descriptive_report_blocks() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table("Run Data", &["value".into()], &["DOUBLE".into()])
            .expect("create dataset");
        for value in ["1", "2", "3", "4", "5"] {
            let row_id = data.add_row(&dataset.id).expect("add row");
            data.update_cell(&dataset.id, row_id, "value", value)
                .expect("update value");
        }
        let descriptor = state
            .db
            .lock()
            .expect("db")
            .get_distribution_columns(&dataset.id)
            .expect("columns")
            .remove(0);
        state.column_display.lock().expect("display props").insert(
            dataset.id.clone(),
            vec![crate::models::table::ColumnDisplayProps {
                col_index: descriptor.index as usize,
                width: None,
                format: None,
                extras: Some(std::collections::BTreeMap::from([(
                    "spec".to_string(),
                    serde_json::json!({ "lsl": 0.0, "target": 3.0, "usl": 6.0 }),
                )])),
            }],
        );
        let mut request = run_request();
        request.source_dataset_id = Some(dataset.id);
        request.y_columns[0].column_id = descriptor.column_id;
        request.weight_column_id = None;
        request.frequency_column_id = None;
        request.enabled_capability_ids = DistributionService::new(&state)
            .list_distribution_capabilities()
            .expect("capabilities")
            .into_iter()
            .map(|capability| capability.id)
            .collect();
        let context = one_shot_context(request.config_revision);

        let result = DistributionService::new(&state)
            .execute_one_shot(&request, &context)
            .expect("execute distribution");
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].y_results.len(), 1);
        assert_eq!(result.groups[0].y_results[0].quantiles.len(), 11);
        assert_eq!(result.groups[0].y_results[0].quantiles[0].probability, 0.0);
        assert_eq!(result.groups[0].y_results[0].quantiles[10].probability, 1.0);
        assert_eq!(
            result.groups[0].y_results[0]
                .blocks
                .iter()
                .map(|block| block.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "summary",
                "histogram",
                "normalQuantile",
                "boxPlot",
                "ecdf",
                "processCapability",
            ]
        );
        assert_eq!(result.report_blocks.len(), 6);
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains("quantileBoxData"));
        assert!(!serialized.contains("stemAndLeafData"));
        let capability = result
            .report_blocks
            .iter()
            .find(|block| block.kind == "processCapability")
            .expect("process capability block");
        let capability_data = capability
            .capability_data
            .as_ref()
            .expect("capability data");
        let capability_chart = capability_data
            .chart_data
            .as_ref()
            .expect("capability chart data");
        let histogram_block = result
            .report_blocks
            .iter()
            .find(|block| block.kind == "histogram")
            .expect("histogram block");
        let histogram_bins = match histogram_block
            .chart_data
            .as_ref()
            .expect("histogram chart")
        {
            crate::models::distribution::DistributionChartDataV1::HistogramData {
                bins, ..
            } => bins,
            _ => panic!("histogram block must contain histogramData"),
        };
        assert_eq!(capability_chart.bins.len(), histogram_bins.len());
        assert!(capability_chart
            .bins
            .iter()
            .zip(histogram_bins.iter())
            .all(|(left, right)| {
                left.lower == right.lower
                    && left.upper == right.upper
                    && left.count == right.count
                    && left.probability.is_finite()
                    && left.density.is_finite()
            }));
        assert_eq!(
            capability_chart.specification_lines.source,
            capability_data.specification.source
        );
        assert_eq!(
            capability_chart.provenance.capability_method,
            "capability.normal.individuals"
        );
        assert_eq!(
            capability_chart.provenance.computation_id,
            context.provenance_id
        );
        assert!(capability_chart.overall_density.coordinates.len() >= 2);
        assert!(capability_chart.within_density.is_some());
        assert_eq!(capability_data.specification.lsl, Some(0.0));
        assert_eq!(capability_data.specification.usl, Some(6.0));
        assert_eq!(capability_data.process_summary.n, 5);
        assert_eq!(capability_data.indices.cp.state, "available");
        assert_eq!(capability_data.intervals.confidence_level, 0.95);
        assert!(capability_data
            .intervals
            .provenance
            .within_effective_degrees_of_freedom
            .is_some());
        assert!(result
            .report_blocks
            .iter()
            .any(|block| block.kind == "summary"));
        assert!(result.report_blocks.iter().any(|block| {
            block.chart_data.as_ref().is_some_and(|chart| {
                matches!(
                    chart,
                    crate::models::distribution::DistributionChartDataV1::HistogramData { .. }
                )
            })
        }));
        let histogram_block = result
            .report_blocks
            .iter()
            .find(|block| block.kind == "histogram")
            .expect("histogram block");
        if let crate::models::distribution::DistributionChartDataV1::HistogramData {
            provenance,
            ..
        } = histogram_block
            .chart_data
            .as_ref()
            .expect("histogram chart data")
        {
            assert_eq!(provenance.method_id, "histogram.jmpAuto.fallback.fd");
            assert_eq!(
                provenance.compatibility_status,
                Jmp19CompatibilityStatusV1::CompatibilityPending
            );
        } else {
            panic!("histogram block must contain histogram data");
        }
        assert!(result.report_blocks.iter().any(|block| {
            block.chart_data.as_ref().is_some_and(|chart| {
                matches!(
                    chart,
                    crate::models::distribution::DistributionChartDataV1::BoxPlotData { .. }
                )
            })
        }));
        assert!(result.report_blocks.iter().any(|block| {
            block.chart_data.as_ref().is_some_and(|chart| {
                matches!(
                    chart,
                    crate::models::distribution::DistributionChartDataV1::CdfData { .. }
                )
            })
        }));
        request.enabled_capability_ids.clear();
        let disabled_result = DistributionService::new(&state)
            .execute_one_shot(&request, &context)
            .expect("execute without normal capability");
        assert!(!disabled_result
            .report_blocks
            .iter()
            .any(|block| block.kind == "processCapability"));
    }

    #[test]
    fn normal_quantile_service_integration_sets_provenance_and_typed_statuses() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let context = one_shot_context(9);

        let (unique_dataset, unique_value_id, _unique_freq_id, _unique_weight_id) =
            create_value_freq_weight_dataset(
                &state,
                "Normal Unique",
                &[(-2.0, 1, 1.0), (0.0, 1, 1.0), (3.0, 1, 1.0)],
            );
        let mut unique_request = run_request();
        unique_request.source_dataset_id = Some(unique_dataset);
        unique_request.y_columns[0].column_id = unique_value_id;
        let unique_result = service
            .execute_one_shot(&unique_request, &context)
            .expect("unique normal quantile result");
        let unique_payload = extract_normal_quantile_payload(&unique_result);
        assert_eq!(
            unique_payload.status,
            crate::models::distribution::DiagnosticDataStatusV1::Available
        );
        assert_eq!(unique_payload.reason_code, None);
        assert_eq!(
            unique_payload.provenance.compatibility_status,
            Jmp19CompatibilityStatusV1::DocumentedCompatible,
        );
        assert_eq!(
            unique_payload
                .reference_line_provenance
                .compatibility_status,
            Jmp19CompatibilityStatusV1::CompatibilityPending,
        );
        assert_eq!(
            unique_payload
                .confidence_band_provenance
                .compatibility_status,
            Jmp19CompatibilityStatusV1::CompatibilityPending,
        );

        let (ties_dataset, ties_value_id, _ties_freq_id, _ties_weight_id) =
            create_value_freq_weight_dataset(
                &state,
                "Normal Ties",
                &[(-2.0, 1, 1.0), (-2.0, 1, 1.0), (3.0, 1, 1.0)],
            );
        let mut ties_request = run_request();
        ties_request.source_dataset_id = Some(ties_dataset);
        ties_request.y_columns[0].column_id = ties_value_id;
        let ties_result = service
            .execute_one_shot(&ties_request, &context)
            .expect("ties normal quantile result");
        let ties_payload = extract_normal_quantile_payload(&ties_result);
        assert_eq!(
            ties_payload.status,
            crate::models::distribution::DiagnosticDataStatusV1::Available
        );
        assert_eq!(
            ties_payload.provenance.compatibility_status,
            Jmp19CompatibilityStatusV1::CompatibilityPending,
        );

        let (freq_dataset, freq_value_id, freq_column_id, _freq_weight_id) =
            create_value_freq_weight_dataset(
                &state,
                "Normal Freq Ties",
                &[(-2.0, 2, 1.0), (3.0, 1, 1.0)],
            );
        let mut freq_request = run_request();
        freq_request.source_dataset_id = Some(freq_dataset);
        freq_request.y_columns[0].column_id = freq_value_id;
        freq_request.frequency_column_id = Some(freq_column_id);
        let freq_result = service
            .execute_one_shot(&freq_request, &context)
            .expect("freq normal quantile result");
        let freq_payload = extract_normal_quantile_payload(&freq_result);
        assert_eq!(
            freq_payload.status,
            crate::models::distribution::DiagnosticDataStatusV1::Available
        );
        assert_eq!(
            freq_payload.provenance.compatibility_status,
            Jmp19CompatibilityStatusV1::CompatibilityPending,
        );

        let (weight_dataset, weight_value_id, _weight_freq_id, weight_column_id) =
            create_value_freq_weight_dataset(
                &state,
                "Normal Weight Unsupported",
                &[(1.0, 1, 2.0), (4.0, 1, 1.0)],
            );
        let mut weight_request = run_request();
        weight_request.source_dataset_id = Some(weight_dataset);
        weight_request.y_columns[0].column_id = weight_value_id;
        weight_request.weight_column_id = Some(weight_column_id);
        let weight_result = service
            .execute_one_shot(&weight_request, &context)
            .expect("weighted normal quantile result");
        let weight_payload = extract_normal_quantile_payload(&weight_result);
        assert_eq!(
            weight_payload.status,
            crate::models::distribution::DiagnosticDataStatusV1::Unavailable
        );
        assert_eq!(
            weight_payload.reason_code.as_deref(),
            Some("normalQuantile.weightUnsupported.v1"),
        );
        assert_eq!(
            weight_payload.provenance.compatibility_status,
            Jmp19CompatibilityStatusV1::CompatibilityPending,
        );
        assert!(weight_payload.points.is_empty());
        assert!(weight_payload.reference_line.is_empty());
        assert!(weight_payload.confidence_band.is_empty());
        assert!(!weight_result
            .report_blocks
            .iter()
            .any(|block| block.kind == "stemAndLeaf"));
    }

    #[test]
    fn normal_quantile_service_payloads_avoid_nan_serialization_for_small_and_constant_groups() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let context = one_shot_context(10);

        for (dataset_name, rows) in [
            ("Normal N1", vec![(7.0, 1_u64, 1.0)]),
            ("Normal N2", vec![(1.0, 1_u64, 1.0), (2.0, 1_u64, 1.0)]),
            (
                "Normal Constant",
                vec![(5.0, 1_u64, 1.0), (5.0, 1_u64, 1.0), (5.0, 1_u64, 1.0)],
            ),
        ] {
            let (dataset_id, value_id, _freq_id, _weight_id) =
                create_value_freq_weight_dataset(&state, dataset_name, &rows);
            let mut request = run_request();
            request.source_dataset_id = Some(dataset_id);
            request.y_columns[0].column_id = value_id;
            let result = service
                .execute_one_shot(&request, &context)
                .expect("normal quantile finite result");

            let payload = extract_normal_quantile_payload(&result);
            assert_eq!(
                payload.status,
                crate::models::distribution::DiagnosticDataStatusV1::Available
            );
            assert_normal_quantile_payload_finite(payload);

            let serialized = serde_json::to_string(&result).expect("serialize distribution result");
            assert!(!serialized.contains("NaN"));
        }
    }

    #[test]
    fn histograms_only_result_has_no_normal_quantile_block() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let (dataset_id, value_id, _freq_id, _weight_id) = create_value_freq_weight_dataset(
            &state,
            "Histogram Only",
            &[(1.0, 1, 1.0), (2.0, 1, 1.0), (3.0, 1, 1.0)],
        );
        let context = one_shot_context(11);

        let mut request = run_request();
        request.source_dataset_id = Some(dataset_id);
        request.y_columns[0].column_id = value_id;
        request.histograms_only = true;

        let result = service
            .execute_one_shot(&request, &context)
            .expect("histograms only result");
        assert!(!result
            .report_blocks
            .iter()
            .any(|block| block.kind == "normalQuantile"));
        assert!(!result
            .report_blocks
            .iter()
            .any(|block| block.kind == "quantileBox"));
        assert!(!result
            .report_blocks
            .iter()
            .any(|block| block.kind == "stemAndLeaf"));
        assert!(!result.report_blocks.iter().any(|block| {
            block.chart_data.as_ref().is_some_and(|chart| {
                matches!(
                    chart,
                    crate::models::distribution::DistributionChartDataV1::NormalQuantileData { .. }
                )
            })
        }));
    }

    #[test]
    fn applies_normal_capability_override_payload() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table("Override Data", &["value".into()], &["DOUBLE".into()])
            .expect("create dataset");
        for value in ["1", "2", "3", "4", "5"] {
            let row_id = data.add_row(&dataset.id).expect("add row");
            data.update_cell(&dataset.id, row_id, "value", value)
                .expect("update value");
        }
        let descriptor = state
            .db
            .lock()
            .expect("db")
            .get_distribution_columns(&dataset.id)
            .expect("columns")
            .remove(0);
        state.column_display.lock().expect("display props").insert(
            dataset.id.clone(),
            vec![crate::models::table::ColumnDisplayProps {
                col_index: descriptor.index as usize,
                width: None,
                format: None,
                extras: Some(std::collections::BTreeMap::from([(
                    "spec".to_string(),
                    serde_json::json!({ "lsl": 0.0, "target": 3.0, "usl": 6.0 }),
                )])),
            }],
        );

        let mut request = run_request();
        request.source_dataset_id = Some(dataset.id);
        request.y_columns[0].column_id = descriptor.column_id;
        request.weight_column_id = None;
        request.frequency_column_id = None;
        request.enabled_capability_ids = vec!["capability.normal.individuals".to_string()];
        request.capability_overrides =
            vec![crate::models::distribution::CapabilityOverrideEnvelopeV1 {
                schema_version: "1".to_string(),
                capability_id: "capability.normal.individuals".to_string(),
                payload_schema_version: "1".to_string(),
                payload: serde_json::json!({ "lsl": 1.0, "target": null, "usl": 5.5 }),
            }];
        let context = one_shot_context(request.config_revision);

        let result = DistributionService::new(&state)
            .execute_one_shot(&request, &context)
            .expect("execute distribution");
        let capability = result
            .report_blocks
            .iter()
            .find(|block| block.kind == "processCapability")
            .expect("process capability block");
        let capability_data = capability
            .capability_data
            .as_ref()
            .expect("capability data");
        assert_eq!(capability_data.specification.source, "analysisOverride");
        assert_eq!(capability_data.specification.lsl, Some(1.0));
        assert_eq!(capability_data.specification.target, None);
        assert_eq!(capability_data.specification.usl, Some(5.5));
    }

    #[test]
    fn places_overall_before_by_groups() {
        use crate::models::distribution::DistributionGroupValueV1;

        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table(
                "Grouped Run Data",
                &["value".into(), "region".into()],
                &["DOUBLE".into(), "VARCHAR".into()],
            )
            .expect("create dataset");
        for (value, region) in [("1", "East"), ("2", "West")] {
            let row_id = data.add_row(&dataset.id).expect("add row");
            data.update_cell(&dataset.id, row_id, "value", value)
                .expect("update value");
            data.update_cell(&dataset.id, row_id, "region", region)
                .expect("update region");
        }
        let descriptors = state
            .db
            .lock()
            .expect("db")
            .get_distribution_columns(&dataset.id)
            .expect("columns");
        let value_id = descriptors
            .iter()
            .find(|column| column.name == "value")
            .expect("value column")
            .column_id
            .clone();
        let region_id = descriptors
            .iter()
            .find(|column| column.name == "region")
            .expect("region column")
            .column_id
            .clone();
        let mut request = run_request();
        request.source_dataset_id = Some(dataset.id);
        request.y_columns[0].column_id = value_id;
        request.by_column_ids = vec![region_id];
        let context = one_shot_context(request.config_revision);

        let result = DistributionService::new(&state)
            .execute_one_shot(&request, &context)
            .expect("execute grouped distribution");

        assert_eq!(result.groups.len(), 3);
        assert!(result.groups[0].group_key.is_empty());
        assert_eq!(result.groups[1].group_names, vec!["region"]);
        assert_eq!(
            result.groups[1].group_key,
            vec![DistributionGroupValueV1::Text {
                value: "East".to_string(),
            }]
        );
        assert_eq!(
            result.groups[2].group_key,
            vec![DistributionGroupValueV1::Text {
                value: "West".to_string(),
            }]
        );
        assert_eq!(result.groups[0].y_results[0].quantiles[5].value, 1.5);
    }

    #[test]
    fn black_box_case_validator_rejects_free_text_and_paths() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let valid = synthetic_black_box_case();
        service.validate_black_box_case(&valid).expect("valid case");

        let mut free_text = valid.clone();
        free_text.observed = vec![BlackBoxObservationV1::Enumeration {
            output_id: "result.label".to_string(),
            value: "a copied product sentence".to_string(),
        }];
        assert!(service.validate_black_box_case(&free_text).is_err());

        let mut absolute_path = valid.clone();
        absolute_path.action_id = "C:\\private\\capture.png".to_string();
        assert!(service.validate_black_box_case(&absolute_path).is_err());

        let mut missing_hash = valid;
        missing_hash.provenance.output_hash.clear();
        assert!(service.validate_black_box_case(&missing_hash).is_err());

        let mut malformed_hash = synthetic_black_box_case();
        malformed_hash.provenance.input_hash = "sha256:not-hex".to_string();
        assert!(service.validate_black_box_case(&malformed_hash).is_err());

        let mut relative_screenshot = synthetic_black_box_case();
        relative_screenshot.action_id = "screenshots/capture.png".to_string();
        assert!(service
            .validate_black_box_case(&relative_screenshot)
            .is_err());

        let mut invalid_seed = synthetic_black_box_case();
        invalid_seed.provenance.seed = "seed with spaces".to_string();
        assert!(service.validate_black_box_case(&invalid_seed).is_err());
    }
}

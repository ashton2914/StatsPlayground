use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::graph_data::{GraphAggregatePacket, GraphRawPointDisposition, GraphSampling};

pub type DistributionSchemaVersionV1 = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionModeV1 {
    EmptySystem,
    Continuous,
    Ordinal,
    Nominal,
    DiscreteNumeric,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionModelingTypeV1 {
    Continuous,
    Ordinal,
    Nominal,
    DiscreteNumeric,
    #[serde(rename = "datetime")]
    DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionColumnRefV1 {
    pub column_id: String,
    pub modeling_type: DistributionModelingTypeV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionColumnDescriptorV1 {
    pub column_id: String,
    pub name: String,
    pub sql_type: String,
    pub role: String,
    pub index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DistributionGroupValueV1 {
    Missing,
    Boolean { value: bool },
    Number { value: f64 },
    Text { value: String },
    DateTime { utc_millis: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContinuousDistributionIdV1 {
    Normal,
    Lognormal,
    Exponential,
    Gamma,
    Weibull,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionFitStatusV1 {
    Available,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionFitConvergenceStatusV1 {
    Converged,
    NotConverged,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionContinuousFitDiagnosticsV1 {
    pub goodness_of_fit: bool,
    pub qq_plot: bool,
    pub cdf_plot: bool,
    pub pp_plot: bool,
}

impl Default for DistributionContinuousFitDiagnosticsV1 {
    fn default() -> Self {
        Self {
            goodness_of_fit: false,
            qq_plot: false,
            cdf_plot: false,
            pp_plot: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionContinuousFitConfigV1 {
    pub enabled_distribution_ids: Vec<ContinuousDistributionIdV1>,
    pub fit_all: bool,
    pub diagnostics: DistributionContinuousFitDiagnosticsV1,
}

impl Default for DistributionContinuousFitConfigV1 {
    fn default() -> Self {
        Self {
            enabled_distribution_ids: Vec::new(),
            fit_all: false,
            diagnostics: DistributionContinuousFitDiagnosticsV1::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitCapabilityV1 {
    pub distribution_id: ContinuousDistributionIdV1,
    pub method_id: String,
    pub method_version: String,
    pub parameterization_id: String,
    pub implemented: bool,
    pub compatibility_status: Jmp19CompatibilityStatusV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitParameterV1 {
    pub parameter_id: String,
    #[serde(rename = "estimate")]
    pub value: CapabilityTypedValueV1,
    pub standard_error: CapabilityTypedValueV1,
    pub lower_confidence: CapabilityTypedValueV1,
    pub upper_confidence: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitMetricV1 {
    pub metric_id: String,
    pub value: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitConvergenceV1 {
    pub status: DistributionFitConvergenceStatusV1,
    pub reason_code: Option<String>,
    pub optimizer_id: String,
    pub optimizer_version: String,
    pub iterations: u64,
    pub tolerance: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_norm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitProvenanceV1 {
    pub method_id: String,
    pub method_version: String,
    pub parameterization_id: String,
    pub optimizer_id: String,
    pub optimizer_version: String,
    pub initialization_strategy_id: String,
    pub convergence_tolerance: f64,
    pub iteration_limit: u64,
    pub dependency_versions: BTreeMap<String, String>,
    #[serde(skip_serializing)]
    pub computation_id: String,
    pub candidate_registry_ids: Vec<ContinuousDistributionIdV1>,
    pub compatibility_status: Jmp19CompatibilityStatusV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFittedCurveDataV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub points: Vec<DistributionCoordinateV1>,
    pub provenance: DistributionFitProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitGoodnessOfFitV1 {
    pub test_id: String,
    pub statistic: CapabilityTypedValueV1,
    pub p_value: CapabilityTypedValueV1,
    pub status: DistributionFitStatusV1,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitDiagnosticDataV1 {
    pub diagnostic_id: String,
    pub status: DistributionFitStatusV1,
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_data: Option<DistributionChartDataV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitDataV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub fit_id: String,
    pub distribution_id: ContinuousDistributionIdV1,
    pub parameterization_id: String,
    pub status: DistributionFitStatusV1,
    pub reason_code: Option<String>,
    pub parameters: Vec<DistributionFitParameterV1>,
    #[serde(default)]
    pub estimated_parameter_count: usize,
    pub effective_n: f64,
    pub log_likelihood: CapabilityTypedValueV1,
    pub aic: CapabilityTypedValueV1,
    pub aicc: CapabilityTypedValueV1,
    pub bic: CapabilityTypedValueV1,
    pub goodness_of_fit: Vec<DistributionFitGoodnessOfFitV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fitted_curve: Option<DistributionFittedCurveDataV1>,
    pub diagnostics: Vec<DistributionFitDiagnosticDataV1>,
    pub convergence: DistributionFitConvergenceV1,
    pub provenance: DistributionFitProvenanceV1,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitComparisonRowV1 {
    pub distribution_id: ContinuousDistributionIdV1,
    pub status: DistributionFitStatusV1,
    pub reason_code: Option<String>,
    pub aic: CapabilityTypedValueV1,
    pub aicc: CapabilityTypedValueV1,
    pub bic: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFitComparisonDataV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub comparison_id: String,
    pub candidate_registry_ids: Vec<ContinuousDistributionIdV1>,
    pub rows: Vec<DistributionFitComparisonRowV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FilterExprV1 {
    And {
        exprs: Vec<FilterExprV1>,
    },
    Or {
        exprs: Vec<FilterExprV1>,
    },
    Not {
        expr: Box<FilterExprV1>,
    },
    IsNull {
        field_id: String,
        negate: bool,
    },
    NumericRange {
        field_id: String,
        min: Option<f64>,
        max: Option<f64>,
        include_min: bool,
        include_max: bool,
    },
    CategorySet {
        field_id: String,
        values: Vec<String>,
        negate: bool,
    },
    DateRange {
        field_id: String,
        start: Option<String>,
        end: Option<String>,
        include_start: bool,
        include_end: bool,
        time_zone: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityOverrideEnvelopeV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub capability_id: String,
    pub payload_schema_version: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionYReportPreferencesV1 {
    pub overview: bool,
    pub histogram: bool,
    pub outlier_box_plot: bool,
    pub specification_lines: bool,
    pub quantiles: bool,
    pub summary: bool,
    pub horizontal_tables: bool,
    pub normal_quantile_plot: bool,
    pub ecdf: bool,
    pub process_capability: bool,
    #[serde(default = "default_true")]
    pub capability_histogram: bool,
    #[serde(default = "default_true")]
    pub capability_process_summary: bool,
    #[serde(default = "default_true")]
    pub capability_within: bool,
    #[serde(default = "default_true")]
    pub capability_overall: bool,
    #[serde(default = "default_true")]
    pub capability_nonconformance: bool,
    #[serde(default = "default_histogram_scale")]
    pub histogram_scale: HistogramScaleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit_overlays: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit_details: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HistogramMethodV1 {
    JmpAuto,
    FreedmanDiaconis,
    Scott,
    Sturges,
    FixedCount,
    FixedWidth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HistogramScaleV1 {
    Count,
    Probability,
    Density,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionHistogramDiagnosticsConfigV1 {
    #[serde(default = "default_histogram_method")]
    pub method: HistogramMethodV1,
    #[serde(default)]
    pub fixed_count: Option<u64>,
    #[serde(default)]
    pub fixed_width: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionVisualDiagnosticsConfigV1 {
    #[serde(default)]
    pub histogram: DistributionHistogramDiagnosticsConfigV1,
    #[serde(default = "default_normal_quantile_confidence_level")]
    pub normal_quantile_confidence_level: f64,
}

impl Default for DistributionHistogramDiagnosticsConfigV1 {
    fn default() -> Self {
        Self {
            method: default_histogram_method(),
            fixed_count: None,
            fixed_width: None,
        }
    }
}

impl Default for DistributionVisualDiagnosticsConfigV1 {
    fn default() -> Self {
        Self {
            histogram: DistributionHistogramDiagnosticsConfigV1::default(),
            normal_quantile_confidence_level: default_normal_quantile_confidence_level(),
        }
    }
}

fn default_histogram_method() -> HistogramMethodV1 {
    HistogramMethodV1::JmpAuto
}

fn default_normal_quantile_confidence_level() -> f64 {
    0.95
}

fn default_true() -> bool {
    true
}

fn default_histogram_scale() -> HistogramScaleV1 {
    HistogramScaleV1::Count
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionAnalysisConfigV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub source_dataset_id: String,
    pub y_columns: Vec<DistributionColumnRefV1>,
    pub weight_column_id: Option<String>,
    pub frequency_column_id: Option<String>,
    pub by_column_ids: Vec<String>,
    pub filter_expr: FilterExprV1,
    pub confidence_level: f64,
    pub histograms_only: bool,
    #[serde(default)]
    pub continuous_fit: DistributionContinuousFitConfigV1,
    #[serde(default)]
    pub visual_diagnostics: DistributionVisualDiagnosticsConfigV1,
    pub enabled_capability_ids: Vec<String>,
    pub capability_overrides: Vec<CapabilityOverrideEnvelopeV1>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub report_preferences: std::collections::BTreeMap<String, DistributionYReportPreferencesV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionConfigErrorV1 {
    pub code: String,
    pub message_key: String,
    pub field_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContributionDimensionV1 {
    pub code: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContributionPolicyV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub dimensions: Vec<ObservationContributionDimensionV1>,
}

impl ObservationContributionPolicyV1 {
    pub fn strict_v1() -> Result<Self, AppError> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/distribution/observation-contribution-v1.json"
        )))
        .map_err(|error| AppError::InvalidParam(format!("invalid observation policy: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudgetV1 {
    pub max_groups: u64,
    pub max_rows_per_group: u64,
    pub max_total_rows: u64,
    pub max_total_bytes: u64,
}

impl Default for ResourceBudgetV1 {
    fn default() -> Self {
        Self {
            max_groups: 1_000,
            max_rows_per_group: 100_000,
            max_total_rows: 1_000_000,
            max_total_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRequestV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub analysis_id: String,
    pub config_revision: u64,
    pub source_dataset_id: Option<String>,
    pub source_data_version: Option<String>,
    pub mode: DistributionModeV1,
    pub y_columns: Vec<DistributionColumnRefV1>,
    pub weight_column_id: Option<String>,
    pub frequency_column_id: Option<String>,
    pub by_column_ids: Vec<String>,
    pub filter_expr: FilterExprV1,
    pub confidence_level: f64,
    pub histograms_only: bool,
    #[serde(default)]
    pub continuous_fit: DistributionContinuousFitConfigV1,
    #[serde(default)]
    pub visual_diagnostics: DistributionVisualDiagnosticsConfigV1,
    pub enabled_capability_ids: Vec<String>,
    pub capability_overrides: Vec<CapabilityOverrideEnvelopeV1>,
    pub observation_policy: ObservationContributionPolicyV1,
    pub resource_budget: ResourceBudgetV1,
    pub exact: bool,
}

pub type DistributionFitKind = ContinuousDistributionIdV1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecLimitsOverride {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRequest {
    pub dataset_id: String,
    pub generation: u64,
    pub response_columns: Vec<String>,
    pub weight_column: Option<String>,
    pub freq_column: Option<String>,
    pub by_columns: Vec<String>,
    pub confidence_level: f64,
    pub spec_limits: HashMap<String, SpecLimitsOverride>,
    pub fit_distributions: Vec<DistributionFitKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionChartKindV1 {
    HistogramData,
    BoxPlotData,
    NormalQuantileData,
    QqData,
    PpData,
    CdfData,
    FittedCurveData,
    DiagnosticCoordinateData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Jmp19CompatibilityStatusV1 {
    DocumentedCompatible,
    ValidatedCompatible,
    CompatibilityPending,
    IntentionalDifference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionChartProvenanceV1 {
    pub method_id: String,
    pub method_version: String,
    pub compatibility_status: Jmp19CompatibilityStatusV1,
    #[serde(skip_serializing)]
    pub computation_id: String,
}

pub type DiagnosticProvenanceV1 = DistributionChartProvenanceV1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramBinV1 {
    pub lower: f64,
    pub upper: f64,
    pub count: f64,
    pub probability: f64,
    pub density: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxPlotCoordinatesV1 {
    pub lower_whisker: f64,
    pub lower_quartile: f64,
    pub median: f64,
    pub upper_quartile: f64,
    pub upper_whisker: f64,
    pub outliers: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionCoordinateV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalQuantilePointV1 {
    pub rank: f64,
    pub probability: f64,
    pub normal_score: f64,
    pub observed_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalQuantileBandPointV1 {
    pub x: f64,
    pub lower: f64,
    pub upper: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticDataStatusV1 {
    Available,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalQuantileDataV1 {
    pub points: Vec<NormalQuantilePointV1>,
    pub reference_line: Vec<DistributionCoordinateV1>,
    pub confidence_band: Vec<NormalQuantileBandPointV1>,
    pub status: DiagnosticDataStatusV1,
    pub reason_code: Option<String>,
    pub provenance: DiagnosticProvenanceV1,
    pub reference_line_provenance: DiagnosticProvenanceV1,
    pub confidence_band_provenance: DiagnosticProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DistributionChartDataV1 {
    HistogramData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        bins: Vec<HistogramBinV1>,
    },
    BoxPlotData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        coordinates: BoxPlotCoordinatesV1,
    },
    NormalQuantileData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        payload: NormalQuantileDataV1,
    },
    QqData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    PpData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    CdfData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    FittedCurveData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    DiagnosticCoordinateData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionReportBlockV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub block_id: String,
    pub kind: String,
    pub title_key: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_data: Option<DistributionSummaryDataV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_data: Option<ProcessCapabilityDataV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution_fit_data: Option<DistributionFitDataV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution_fit_comparison_data: Option<DistributionFitComparisonDataV1>,
    pub chart_data: Option<DistributionChartDataV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionReportBlock {
    #[serde(flatten)]
    pub block: DistributionReportBlockV1,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilitySpecificationV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilitySummaryV1 {
    pub n: u64,
    pub mean: f64,
    pub moving_range_average: Option<f64>,
    pub d2: f64,
    pub within_sigma: Option<f64>,
    pub overall_sigma: Option<f64>,
    pub stability_index: ProcessCapabilityStabilityIndexV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityStabilityIndexV1 {
    pub value: CapabilityTypedValueV1,
    pub method_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTypedValueV1 {
    pub state: String,
    pub value: Option<f64>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityIndicesV1 {
    pub cp: CapabilityTypedValueV1,
    pub cpk: CapabilityTypedValueV1,
    pub cpl: CapabilityTypedValueV1,
    pub cpu: CapabilityTypedValueV1,
    pub cpm_within: CapabilityTypedValueV1,
    pub pp: CapabilityTypedValueV1,
    pub ppk: CapabilityTypedValueV1,
    pub ppl: CapabilityTypedValueV1,
    pub ppu: CapabilityTypedValueV1,
    pub cpm_overall: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityIntervalV1 {
    pub lower: CapabilityTypedValueV1,
    pub upper: CapabilityTypedValueV1,
    pub interval_method: Option<String>,
    pub limiting_side: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityIntervalProvenanceV1 {
    pub distribution_crate: String,
    pub distribution_crate_version: String,
    pub parameterization: String,
    pub inverse_cdf_algorithm_id: String,
    pub method_version: String,
    pub within_effective_degrees_of_freedom: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityIntervalsV1 {
    pub confidence_level: f64,
    pub cp: ProcessCapabilityIntervalV1,
    pub cpk: ProcessCapabilityIntervalV1,
    pub cpl: ProcessCapabilityIntervalV1,
    pub cpu: ProcessCapabilityIntervalV1,
    pub cpm_within: ProcessCapabilityIntervalV1,
    pub pp: ProcessCapabilityIntervalV1,
    pub ppk: ProcessCapabilityIntervalV1,
    pub ppl: ProcessCapabilityIntervalV1,
    pub ppu: ProcessCapabilityIntervalV1,
    pub cpm_overall: ProcessCapabilityIntervalV1,
    pub provenance: ProcessCapabilityIntervalProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTypedCountV1 {
    pub state: String,
    pub value: Option<u64>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityProportionIntervalV1 {
    pub lower: CapabilityTypedValueV1,
    pub upper: CapabilityTypedValueV1,
    pub interval_method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityObservedTailV1 {
    pub count: CapabilityTypedCountV1,
    pub proportion: CapabilityTypedValueV1,
    pub ppm: CapabilityTypedValueV1,
    pub proportion_interval: ProcessCapabilityProportionIntervalV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityObservedNonconformanceV1 {
    pub below: ProcessCapabilityObservedTailV1,
    pub above: ProcessCapabilityObservedTailV1,
    pub total: ProcessCapabilityObservedTailV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityExpectedTailV1 {
    pub proportion: CapabilityTypedValueV1,
    pub ppm: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityExpectedNonconformanceBySigmaV1 {
    pub below: ProcessCapabilityExpectedTailV1,
    pub above: ProcessCapabilityExpectedTailV1,
    pub total: ProcessCapabilityExpectedTailV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityNonconformanceV1 {
    pub observed: ProcessCapabilityObservedNonconformanceV1,
    pub expected_within: ProcessCapabilityExpectedNonconformanceBySigmaV1,
    pub expected_overall: ProcessCapabilityExpectedNonconformanceBySigmaV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityChartBinV1 {
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
pub struct ProcessCapabilitySpecificationLinesV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityDensitySeriesV1 {
    pub state: String,
    pub reason_code: Option<String>,
    pub coordinates: Vec<DistributionCoordinateV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityChartProvenanceV1 {
    pub capability_method: String,
    pub normal_density_method: String,
    #[serde(skip_serializing)]
    pub computation_id: String,
    pub spec_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityChartDataV1 {
    pub bins: Vec<ProcessCapabilityChartBinV1>,
    pub specification_lines: ProcessCapabilitySpecificationLinesV1,
    pub overall_density: ProcessCapabilityDensitySeriesV1,
    pub within_density: Option<ProcessCapabilityDensitySeriesV1>,
    pub provenance: ProcessCapabilityChartProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCapabilityDataV1 {
    pub specification: ProcessCapabilitySpecificationV1,
    pub process_summary: ProcessCapabilitySummaryV1,
    pub indices: ProcessCapabilityIndicesV1,
    pub intervals: ProcessCapabilityIntervalsV1,
    pub nonconformance: ProcessCapabilityNonconformanceV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_data: Option<ProcessCapabilityChartDataV1>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionSummaryDataV1 {
    pub n: u64,
    pub n_missing: u64,
    pub mean: f64,
    pub std_dev: Option<f64>,
    pub std_error: Option<f64>,
    pub mean_ci_lower: Option<f64>,
    pub mean_ci_upper: Option<f64>,
    pub minimum: f64,
    pub maximum: f64,
    pub median: f64,
    pub primary_mode: f64,
    pub mode_is_unique: bool,
    pub range: f64,
    pub iqr: f64,
    pub mad: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionQuantileValueV1 {
    pub probability: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionYResultV1 {
    pub y_column: DistributionColumnRefV1,
    pub y_name: String,
    pub quantiles: Vec<DistributionQuantileValueV1>,
    pub blocks: Vec<DistributionReportBlockV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionGroupResultV1 {
    pub group_key: Vec<DistributionGroupValueV1>,
    #[serde(default)]
    pub group_names: Vec<String>,
    pub y_results: Vec<DistributionYResultV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionYResult {
    pub y_column: DistributionColumnRefV1,
    pub y_name: String,
    pub quantiles: Vec<DistributionQuantileValueV1>,
    pub blocks: Vec<DistributionReportBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionGroupResult {
    pub group_key: Vec<DistributionGroupValueV1>,
    #[serde(default)]
    pub group_names: Vec<String>,
    pub y_results: Vec<DistributionYResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphExtentDto {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataFrameDto {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub source_rows: u64,
    pub processed_rows: u64,
    pub sampling: GraphSampling,
    pub dictionaries: HashMap<String, Vec<String>>,
    pub extents: HashMap<String, GraphExtentDto>,
    pub raw_chunks: Vec<serde_json::Value>,
    pub aggregates: Vec<GraphAggregatePacket>,
    pub raw_point_disposition: GraphRawPointDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionGraphFrames {
    pub overview: GraphDataFrameDto,
    pub box_plot: GraphDataFrameDto,
    pub ecdf: GraphDataFrameDto,
    pub normal_quantile: GraphDataFrameDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionReportResponse {
    pub dataset_id: String,
    pub generation: u64,
    pub groups: Vec<DistributionGroupResult>,
    pub report_blocks: Vec<DistributionReportBlock>,
    pub graph_frames: DistributionGraphFrames,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptorV1 {
    pub id: String,
    pub title_key: String,
    pub scope: String,
    pub menu_scope: String,
    pub status_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum BlackBoxValueV1 {
    Number(f64),
    Boolean(bool),
    Code(String),
    NumberList(Vec<f64>),
    CodeList(Vec<String>),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BlackBoxObservationV1 {
    Numeric {
        output_id: String,
        value: f64,
    },
    Enumeration {
        output_id: String,
        value: String,
    },
    Status {
        output_id: String,
        value: BlackBoxStatusV1,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlackBoxStatusV1 {
    Available,
    Unavailable,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlackBoxProvenanceV1 {
    pub source_ledger_hash: String,
    pub input_hash: String,
    pub output_hash: String,
    pub tool_version: String,
    pub seed: String,
    pub review_artifact_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlackBoxCaseV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub case_id: String,
    pub action_id: String,
    pub provenance: BlackBoxProvenanceV1,
    pub inputs: BTreeMap<String, BlackBoxValueV1>,
    pub expected: Vec<BlackBoxObservationV1>,
    pub observed: Vec<BlackBoxObservationV1>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLedgerEntryV1 {
    pub artifact_id: String,
    pub origin_kind: String,
    pub allowed_field_keys: Vec<String>,
    pub input_hash: String,
    pub output_hash: String,
    pub review_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegalReviewRecordV1 {
    pub artifact_id: String,
    pub status: String,
    pub requested_at: String,
    pub reviewer_role: String,
    pub artifact_hash: String,
    pub notes_hash: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionLoadStatusV1 {
    #[default]
    Ready,
    UnknownVersion,
    MissingSource,
    Corrupt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionIssueV1 {
    pub analysis_id: String,
    pub kind: DistributionLoadStatusV1,
    pub message_key: String,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dataset_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::graph_data::{
        GraphRawPointDisposition, GraphSampling, GRAPH_SCATTER_RENDER_BUDGET,
    };
    use proptest::prelude::*;
    use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
    use serde_json::json;

    fn empty_graph_frame(role: &str) -> GraphDataFrameDto {
        GraphDataFrameDto {
            request_id: format!("distribution:{role}"),
            dataset_id: "dataset-1".to_string(),
            generation: 7,
            source_rows: 0,
            processed_rows: 0,
            sampling: GraphSampling::Full,
            dictionaries: HashMap::new(),
            extents: HashMap::new(),
            raw_chunks: Vec::new(),
            aggregates: Vec::new(),
            raw_point_disposition: GraphRawPointDisposition::Empty {
                valid_rows: 0,
                budget: GRAPH_SCATTER_RENDER_BUDGET,
            },
        }
    }

    #[test]
    fn distribution_request_round_trips_camel_case_wire_fields() {
        let value = json!({
            "datasetId": "dataset-1",
            "generation": 7,
            "responseColumns": ["height", "width"],
            "weightColumn": "weight",
            "freqColumn": "frequency",
            "byColumns": ["region", "batch"],
            "confidenceLevel": 0.95,
            "specLimits": {
                "height": { "lsl": 1.0, "target": 2.0, "usl": 3.0 }
            },
            "fitDistributions": ["normal", "gamma"]
        });
        let request: DistributionRequest =
            serde_json::from_value(value.clone()).expect("deserialize one-shot request");

        assert_eq!(request.response_columns, vec!["height", "width"]);
        assert_eq!(request.by_columns, vec!["region", "batch"]);
        assert_eq!(
            serde_json::to_value(request).expect("serialize request"),
            value
        );
    }

    #[test]
    fn distribution_report_response_serializes_exact_frames_and_no_lifecycle_fields() {
        let response = DistributionReportResponse {
            dataset_id: "dataset-1".to_string(),
            generation: 7,
            groups: Vec::new(),
            report_blocks: vec![DistributionReportBlock {
                block: DistributionReportBlockV1 {
                    schema_version: "1".to_string(),
                    block_id: "height-normal-quantile".to_string(),
                    kind: "normalQuantile".to_string(),
                    title_key: "distribution.report.normalQuantilePlot".to_string(),
                    status: "unavailable".to_string(),
                    summary_data: None,
                    capability_data: None,
                    distribution_fit_data: None,
                    distribution_fit_comparison_data: None,
                    chart_data: None,
                },
                reason_code: Some("normalQuantile.weightUnsupported.v1".to_string()),
            }],
            graph_frames: DistributionGraphFrames {
                overview: empty_graph_frame("overview"),
                box_plot: empty_graph_frame("boxPlot"),
                ecdf: empty_graph_frame("ecdf"),
                normal_quantile: empty_graph_frame("normalQuantile"),
            },
        };
        let value = serde_json::to_value(response).expect("serialize one-shot response");

        assert_eq!(value["generation"], 7);
        assert_eq!(value["reportBlocks"][0]["status"], "unavailable");
        assert_eq!(
            value["reportBlocks"][0]["reasonCode"],
            "normalQuantile.weightUnsupported.v1"
        );
        let mut keys = value["graphFrames"]
            .as_object()
            .expect("graph frames")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, vec!["boxPlot", "ecdf", "normalQuantile", "overview"]);
        let serialized = value.to_string();
        for forbidden in ["runId", "snapshotId", "cancelToken", "progress"] {
            assert!(
                !serialized.contains(forbidden),
                "unexpected field {forbidden}"
            );
        }
    }

    #[test]
    fn fit_convergence_serializes_optional_objective_and_gradient_norm_only_when_present() {
        let without_optionals = DistributionFitConvergenceV1 {
            status: DistributionFitConvergenceStatusV1::Converged,
            reason_code: None,
            optimizer_id: "closed-form".to_string(),
            optimizer_version: "1".to_string(),
            iterations: 1,
            tolerance: 0.0,
            objective: None,
            gradient_norm: None,
        };
        let without_optionals_json = serde_json::to_value(&without_optionals)
            .expect("serialize fit convergence without optionals");
        assert_eq!(without_optionals_json.get("objective"), None);
        assert_eq!(without_optionals_json.get("gradientNorm"), None);

        let with_optionals = DistributionFitConvergenceV1 {
            objective: Some(12.5),
            gradient_norm: Some(0.25),
            ..without_optionals
        };
        let with_optionals_json = serde_json::to_value(&with_optionals)
            .expect("serialize fit convergence with optionals");
        assert_eq!(with_optionals_json["objective"], json!(12.5));
        assert_eq!(with_optionals_json["gradientNorm"], json!(0.25));
    }

    #[test]
    fn distribution_request_v1_serializes_camel_case_and_versioned_filter_ast() {
        let request = DistributionRequestV1 {
            schema_version: "1".to_string(),
            analysis_id: "dist-001".to_string(),
            config_revision: 7,
            source_dataset_id: Some("ds-42".to_string()),
            source_data_version: Some("17".to_string()),
            mode: DistributionModeV1::Continuous,
            y_columns: vec![DistributionColumnRefV1 {
                column_id: "sales-amount-id".to_string(),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: Some("sample-weight-id".to_string()),
            frequency_column_id: None,
            by_column_ids: vec!["region-id".to_string()],
            filter_expr: FilterExprV1::And {
                exprs: vec![FilterExprV1::CategorySet {
                    field_id: "region".to_string(),
                    values: vec!["East".to_string()],
                    negate: false,
                }],
            },
            confidence_level: 0.95,
            histograms_only: false,
            continuous_fit: DistributionContinuousFitConfigV1::default(),
            visual_diagnostics: DistributionVisualDiagnosticsConfigV1::default(),
            enabled_capability_ids: Vec::new(),
            capability_overrides: Vec::new(),
            observation_policy: ObservationContributionPolicyV1::strict_v1()
                .expect("load strict observation policy"),
            resource_budget: ResourceBudgetV1 {
                max_groups: 1_000,
                max_rows_per_group: 100_000,
                max_total_rows: 1_000_000,
                max_total_bytes: 64 * 1024 * 1024,
            },
            exact: true,
        };

        let json = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(json["analysisId"], "dist-001");
        assert_eq!(json["configRevision"], 7);
        assert_eq!(json["filterExpr"]["kind"], "and");
        assert_eq!(json["filterExpr"]["exprs"][0]["kind"], "categorySet");
    }

    #[test]
    fn missing_continuous_fit_defaults_to_disabled() {
        let request = serde_json::json!({
            "schemaVersion": "1",
            "analysisId": "dist-001",
            "configRevision": 1,
            "sourceDatasetId": "ds-42",
            "sourceDataVersion": "17",
            "mode": "continuous",
            "yColumns": [{"columnId": "sales-amount-id", "modelingType": "continuous"}],
            "weightColumnId": null,
            "frequencyColumnId": null,
            "byColumnIds": [],
            "filterExpr": {"kind": "and", "exprs": []},
            "confidenceLevel": 0.95,
            "histogramsOnly": false,
            "visualDiagnostics": DistributionVisualDiagnosticsConfigV1::default(),
            "enabledCapabilityIds": [],
            "capabilityOverrides": [],
            "observationPolicy": ObservationContributionPolicyV1::strict_v1()
                .expect("load strict observation policy"),
            "resourceBudget": ResourceBudgetV1::default(),
            "exact": true
        });
        let parsed: DistributionRequestV1 = serde_json::from_value(request).expect("parse request");
        assert!(parsed.continuous_fit.enabled_distribution_ids.is_empty());
        assert!(!parsed.continuous_fit.fit_all);
        assert!(!parsed.continuous_fit.diagnostics.goodness_of_fit);
        assert!(!parsed.continuous_fit.diagnostics.qq_plot);
        assert!(!parsed.continuous_fit.diagnostics.cdf_plot);
        assert!(!parsed.continuous_fit.diagnostics.pp_plot);
    }

    #[test]
    fn strict_observation_policy_covers_every_phase_zero_dimension() {
        let policy =
            ObservationContributionPolicyV1::strict_v1().expect("load strict observation policy");
        let actual = policy
            .dimensions
            .iter()
            .map(|dimension| dimension.code.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "yMissing",
            "weightMissing",
            "weightZero",
            "weightNegative",
            "weightNonFinite",
            "frequencyMissing",
            "frequencyZero",
            "frequencyNegative",
            "frequencyNonInteger",
            "frequencyNonFinite",
            "weightAndFrequency",
            "byMissing",
            "emptyGroup",
            "singleObservation",
            "constantColumn",
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(actual, expected);
    }

    #[test]
    fn analysis_config_v1_serializes_roles_and_overrides_in_camel_case() {
        let config = DistributionAnalysisConfigV1 {
            schema_version: "1".to_string(),
            source_dataset_id: "dataset-1".to_string(),
            y_columns: vec![DistributionColumnRefV1 {
                column_id: "col-y".to_string(),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: Some("col-weight".to_string()),
            frequency_column_id: Some("col-freq".to_string()),
            by_column_ids: vec!["col-date".to_string()],
            filter_expr: FilterExprV1::IsNull {
                field_id: "col-group".to_string(),
                negate: true,
            },
            confidence_level: 0.95,
            histograms_only: false,
            continuous_fit: DistributionContinuousFitConfigV1::default(),
            visual_diagnostics: DistributionVisualDiagnosticsConfigV1 {
                histogram: DistributionHistogramDiagnosticsConfigV1 {
                    method: HistogramMethodV1::JmpAuto,
                    fixed_count: None,
                    fixed_width: None,
                },
                normal_quantile_confidence_level: 0.95,
            },
            enabled_capability_ids: vec!["capability.synthetic".to_string()],
            capability_overrides: vec![CapabilityOverrideEnvelopeV1 {
                schema_version: "1".to_string(),
                capability_id: "capability.synthetic".to_string(),
                payload_schema_version: "1".to_string(),
                payload: serde_json::json!({ "enabled": true }),
            }],
            report_preferences: std::collections::BTreeMap::from([(
                "col-y".to_string(),
                DistributionYReportPreferencesV1 {
                    overview: true,
                    histogram: true,
                    outlier_box_plot: true,
                    specification_lines: true,
                    quantiles: true,
                    summary: false,
                    horizontal_tables: true,
                    normal_quantile_plot: false,
                    ecdf: true,
                    process_capability: true,
                    capability_histogram: true,
                    capability_process_summary: true,
                    capability_within: true,
                    capability_overall: true,
                    capability_nonconformance: false,
                    histogram_scale: HistogramScaleV1::Count,
                    fit_overlays: None,
                    fit_details: None,
                },
            )]),
        };

        let json = serde_json::to_value(config).expect("serialize analysis config");
        assert_eq!(json["sourceDatasetId"], "dataset-1");
        assert_eq!(json["confidenceLevel"], 0.95);
        assert_eq!(json["histogramsOnly"], false);
        assert_eq!(json["enabledCapabilityIds"][0], "capability.synthetic");
        assert_eq!(json["capabilityOverrides"][0]["payloadSchemaVersion"], "1");
        assert_eq!(json["visualDiagnostics"]["histogram"]["method"], "jmpAuto");
        assert_eq!(json["reportPreferences"]["col-y"]["ecdf"], true);
        assert_eq!(json["reportPreferences"]["col-y"]["summary"], false);
        assert_eq!(
            serde_json::to_value(DistributionModelingTypeV1::DateTime)
                .expect("serialize datetime modeling type"),
            serde_json::json!("datetime")
        );
    }

    #[test]
    fn distribution_chart_kind_v1_is_closed_and_payloads_are_precomputed() {
        let kinds = [
            DistributionChartKindV1::HistogramData,
            DistributionChartKindV1::BoxPlotData,
            DistributionChartKindV1::NormalQuantileData,
            DistributionChartKindV1::QqData,
            DistributionChartKindV1::PpData,
            DistributionChartKindV1::CdfData,
            DistributionChartKindV1::FittedCurveData,
            DistributionChartKindV1::DiagnosticCoordinateData,
        ];
        let json = serde_json::to_value(kinds).expect("serialize chart kinds");
        assert_eq!(
            json,
            serde_json::json!([
                "histogramData",
                "boxPlotData",
                "normalQuantileData",
                "qqData",
                "ppData",
                "cdfData",
                "fittedCurveData",
                "diagnosticCoordinateData"
            ])
        );

        let chart = DistributionChartDataV1::HistogramData {
            schema_version: "1".to_string(),
            provenance: DistributionChartProvenanceV1 {
                method_id: "histogram-v1".to_string(),
                method_version: "1.0.0".to_string(),
                compatibility_status: Jmp19CompatibilityStatusV1::CompatibilityPending,
                computation_id: "distribution:test:histogram".to_string(),
            },
            bins: vec![HistogramBinV1 {
                lower: 0.0,
                upper: 1.0,
                count: 3.0,
                probability: 1.0,
                density: 1.0,
            }],
        };
        let serialized = serde_json::to_value(chart).expect("serialize chart data");
        assert_eq!(serialized["kind"], "histogramData");
        assert!(serialized.get("observations").is_none());
        assert_eq!(serialized["bins"][0]["probability"], 1.0);
        assert_eq!(serialized["bins"][0]["density"], 1.0);
    }

    fn filter_expr_strategy() -> impl Strategy<Value = FilterExprV1> {
        let leaf = prop_oneof![
            "[a-z]{1,8}".prop_map(|field_id| FilterExprV1::IsNull {
                field_id,
                negate: false,
            }),
            (
                "[a-z]{1,8}",
                -1_000_000i32..=1_000_000,
                -1_000_000i32..=1_000_000
            )
                .prop_map(|(field_id, left, right)| FilterExprV1::NumericRange {
                    field_id,
                    min: Some(left.min(right) as f64),
                    max: Some(left.max(right) as f64),
                    include_min: true,
                    include_max: true,
                },),
        ];
        leaf.prop_recursive(4, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|exprs| FilterExprV1::And { exprs }),
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|exprs| FilterExprV1::Or { exprs }),
                inner.prop_map(|expr| FilterExprV1::Not {
                    expr: Box::new(expr)
                }),
            ]
        })
    }

    #[test]
    fn filter_expr_v1_round_trips_with_deterministic_property_stream() {
        let config = Config {
            cases: 128,
            ..Config::default()
        };
        let rng = TestRng::deterministic_rng(RngAlgorithm::ChaCha);
        let mut runner = TestRunner::new_with_rng(config, rng);
        runner
            .run(&filter_expr_strategy(), |expr| {
                let json = serde_json::to_string(&expr).expect("serialize filter");
                let restored = serde_json::from_str(&json).expect("deserialize filter");
                prop_assert_eq!(expr, restored);
                Ok(())
            })
            .expect("deterministic FilterExpr property test");
    }
}

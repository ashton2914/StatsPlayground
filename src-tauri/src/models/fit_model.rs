use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelCenteringMethod {
    None,
    Mean,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelTermKind {
    Main,
    Interaction,
    Power,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelTerm {
    pub kind: FitModelTermKind,
    pub column_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exponent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelRequest {
    pub dataset_id: String,
    pub generation: u64,
    pub response_column: String,
    pub terms: Vec<FitModelTerm>,
    pub centering_method: FitModelCenteringMethod,
    pub confidence_level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum FitModelSavedMetric {
    Predicted,
    Residual,
    StudentizedResidual,
    Leverage,
    CooksDistance,
    MeanConfidenceLower,
    MeanConfidenceUpper,
    PredictionLower,
    PredictionUpper,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveFitModelColumnsRequest {
    pub dataset_id: String,
    pub expected_generation: u64,
    pub model_name: String,
    pub response_column: String,
    pub terms: Vec<FitModelTerm>,
    pub centering_method: FitModelCenteringMethod,
    pub confidence_level: f64,
    pub metrics: Vec<FitModelSavedMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelSavedColumn {
    pub metric: FitModelSavedMetric,
    pub column_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveFitModelColumnsResult {
    pub change_set_id: String,
    pub generation: u64,
    pub columns: Vec<FitModelSavedColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelNotComputableReason {
    InsufficientRows,
    RankDeficient,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelWarningCode {
    SaturatedModel,
    ConstantResponse,
    PerfectFit,
    IllConditioned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelPlotRow {
    pub row_index: u64,
    pub observed: f64,
    pub fitted: f64,
    pub residual: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelParameterEstimate {
    pub term_id: String,
    pub term_label: String,
    pub estimate: f64,
    pub standard_error: Option<f64>,
    pub t_ratio: Option<f64>,
    pub p_value: Option<f64>,
    pub lower_confidence_limit: Option<f64>,
    pub upper_confidence_limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelAnovaRow {
    pub source: String,
    pub degrees_of_freedom: u64,
    pub sum_of_squares: f64,
    pub mean_square: Option<f64>,
    pub f_ratio: Option<f64>,
    pub p_value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelSummaryOfFit {
    pub r_squared: Option<f64>,
    pub adjusted_r_squared: Option<f64>,
    pub root_mean_square_error: Option<f64>,
    pub mean_of_response: f64,
    pub observation_count: u64,
    pub model_degrees_of_freedom: u64,
    pub error_degrees_of_freedom: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelCenter {
    pub column_name: String,
    pub mean: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelResolvedTerm {
    pub term_id: String,
    pub kind: FitModelTermKind,
    pub column_names: Vec<String>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelCentering {
    pub method: FitModelCenteringMethod,
    pub centers: Vec<FitModelCenter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelPredictorRange {
    pub column_name: String,
    pub minimum: f64,
    pub maximum: f64,
    pub mean: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelSnapshot {
    pub coefficient_term_ids: Vec<String>,
    pub coefficients: Vec<f64>,
    pub covariance: Option<Vec<Vec<f64>>>,
    pub mean_square_error: Option<f64>,
    pub error_degrees_of_freedom: u64,
    pub confidence_level: f64,
    pub terms: Vec<FitModelResolvedTerm>,
    pub centering: FitModelCentering,
    pub predictor_ranges: Vec<FitModelPredictorRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelInferenceReason {
    NoReplicates,
    LackOfFitDegreesOfFreedomZero,
    PureErrorZero,
    InferenceNotEstimable,
    ConstantFeature,
    AuxiliaryRankDeficient,
    InsufficientDiagnosticRows,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelLackOfFitResult {
    pub sum_of_squares_error: f64,
    pub sum_of_squares_pure_error: f64,
    pub sum_of_squares_lack_of_fit: f64,
    pub error_degrees_of_freedom: u64,
    pub pure_error_degrees_of_freedom: u64,
    pub lack_of_fit_degrees_of_freedom: u64,
    pub mean_square_pure_error: Option<f64>,
    pub mean_square_lack_of_fit: Option<f64>,
    pub f_ratio: Option<f64>,
    pub p_value: Option<f64>,
    pub reason: Option<FitModelInferenceReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelVifRow {
    pub term_id: String,
    pub term_label: String,
    pub value: Option<f64>,
    pub reason: Option<FitModelInferenceReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitModelDiagnosticFlag {
    ResidualWarning,
    ResidualSevere,
    HighLeverage,
    Influential,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelRowDiagnostic {
    pub row_index: u64,
    pub observed: f64,
    pub fitted: f64,
    pub residual: f64,
    pub studentized_residual: Option<f64>,
    pub leverage: Option<f64>,
    pub cooks_distance: Option<f64>,
    pub mean_confidence_lower: Option<f64>,
    pub mean_confidence_upper: Option<f64>,
    pub prediction_lower: Option<f64>,
    pub prediction_upper: Option<f64>,
    pub flags: Vec<FitModelDiagnosticFlag>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelQqRow {
    pub row_index: u64,
    pub theoretical_quantile: f64,
    pub studentized_residual: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelDiagnostics {
    pub lack_of_fit: FitModelLackOfFitResult,
    pub feature_vif: Vec<FitModelVifRow>,
    pub rows: Vec<FitModelRowDiagnostic>,
    pub rows_sampled: bool,
    pub source_row_count: u64,
    pub qq_rows: Vec<FitModelQqRow>,
    pub qq_rows_sampled: bool,
    pub qq_source_row_count: u64,
    pub qq_reason: Option<FitModelInferenceReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelPrediction {
    pub predicted: f64,
    pub mean_confidence_lower: Option<f64>,
    pub mean_confidence_upper: Option<f64>,
    pub prediction_lower: Option<f64>,
    pub prediction_upper: Option<f64>,
    pub inference_reason: Option<FitModelInferenceReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelFittedResult {
    pub used_rows: u64,
    pub excluded_rows: u64,
    pub confidence_level: f64,
    pub response_column: String,
    pub predictor_columns: Vec<String>,
    pub terms: Vec<FitModelResolvedTerm>,
    pub centering: FitModelCentering,
    pub snapshot: FitModelSnapshot,
    pub diagnostics: FitModelDiagnostics,
    pub summary_of_fit: FitModelSummaryOfFit,
    pub anova: Vec<FitModelAnovaRow>,
    pub parameter_estimates: Vec<FitModelParameterEstimate>,
    pub plot_rows: Vec<FitModelPlotRow>,
    pub plot_rows_sampled: bool,
    pub warnings: Vec<FitModelWarningCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelNotComputableResult {
    pub reason: FitModelNotComputableReason,
    pub used_rows: u64,
    pub excluded_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FitModelResult {
    Fitted(Box<FitModelFittedResult>),
    NotComputable(FitModelNotComputableResult),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_model_request_serializes_exact_camel_case_fields() {
        let request = FitModelRequest {
            dataset_id: "ds-1".into(),
            generation: 3,
            response_column: "Y".into(),
            terms: vec![FitModelTerm {
                kind: FitModelTermKind::Main,
                column_names: vec!["A".into()],
                exponent: None,
            }],
            centering_method: FitModelCenteringMethod::Mean,
            confidence_level: 0.95,
        };

        let value = serde_json::to_value(&request).expect("serialization should succeed");
        assert_eq!(value["datasetId"], "ds-1");
        assert_eq!(value["responseColumn"], "Y");
        assert!(value.get("columnNames").is_none());
        assert_eq!(value["terms"][0]["columnNames"], serde_json::json!(["A"]));
        assert!(value["terms"][0].get("exponent").is_none());
        assert_eq!(value["centeringMethod"], "mean");
        assert_eq!(value["confidenceLevel"], 0.95);

        let power: FitModelTerm = serde_json::from_value(serde_json::json!({
            "kind": "power",
            "columnNames": ["A"],
            "exponent": 2
        }))
        .expect("power term should deserialize");
        assert_eq!(power.kind, FitModelTermKind::Power);
        assert_eq!(power.exponent, Some(2));
    }

    #[test]
    fn save_fit_model_columns_contract_uses_nine_camel_case_metrics() {
        let request: SaveFitModelColumnsRequest = serde_json::from_value(serde_json::json!({
            "datasetId": "ds-1",
            "expectedGeneration": 4,
            "modelName": "Response Surface",
            "responseColumn": "Y",
            "terms": [{ "kind": "main", "columnNames": ["A"] }],
            "centeringMethod": "mean",
            "confidenceLevel": 0.95,
            "metrics": [
                "predicted",
                "residual",
                "studentizedResidual",
                "leverage",
                "cooksDistance",
                "meanConfidenceLower",
                "meanConfidenceUpper",
                "predictionLower",
                "predictionUpper"
            ]
        }))
        .expect("save request should deserialize");

        assert_eq!(request.metrics.len(), 9);
        assert_eq!(request.metrics[0], FitModelSavedMetric::Predicted);
        assert_eq!(request.metrics[8], FitModelSavedMetric::PredictionUpper);
        let result = SaveFitModelColumnsResult {
            change_set_id: "change-1".into(),
            generation: 5,
            columns: vec![FitModelSavedColumn {
                metric: FitModelSavedMetric::Predicted,
                column_name: "Response Surface Predicted".into(),
            }],
        };
        let value = serde_json::to_value(result).expect("save result should serialize");
        assert_eq!(value["changeSetId"], "change-1");
        assert_eq!(value["generation"], 5);
        assert_eq!(value["columns"][0]["metric"], "predicted");
        assert_eq!(
            value["columns"][0]["columnName"],
            "Response Surface Predicted"
        );
    }

    #[test]
    fn fit_model_result_serializes_variant_kind_tags() {
        let fitted = FitModelResult::Fitted(Box::new(FitModelFittedResult {
            used_rows: 2,
            excluded_rows: 0,
            confidence_level: 0.95,
            response_column: "Y".into(),
            predictor_columns: vec!["A".into()],
            terms: vec![FitModelResolvedTerm {
                term_id: "A".into(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".into()],
                label: "A".into(),
            }],
            centering: FitModelCentering {
                method: FitModelCenteringMethod::None,
                centers: vec![],
            },
            snapshot: FitModelSnapshot {
                coefficient_term_ids: vec!["Intercept".into(), "A".into()],
                coefficients: vec![0.0, 1.0],
                covariance: None,
                mean_square_error: None,
                error_degrees_of_freedom: 0,
                confidence_level: 0.95,
                terms: vec![FitModelResolvedTerm {
                    term_id: "A".into(),
                    kind: FitModelTermKind::Main,
                    column_names: vec!["A".into()],
                    label: "A".into(),
                }],
                centering: FitModelCentering {
                    method: FitModelCenteringMethod::None,
                    centers: vec![],
                },
                predictor_ranges: vec![],
            },
            diagnostics: FitModelDiagnostics {
                lack_of_fit: FitModelLackOfFitResult {
                    sum_of_squares_error: 0.0,
                    sum_of_squares_pure_error: 0.0,
                    sum_of_squares_lack_of_fit: 0.0,
                    error_degrees_of_freedom: 0,
                    pure_error_degrees_of_freedom: 0,
                    lack_of_fit_degrees_of_freedom: 0,
                    mean_square_pure_error: None,
                    mean_square_lack_of_fit: None,
                    f_ratio: None,
                    p_value: None,
                    reason: Some(FitModelInferenceReason::InferenceNotEstimable),
                },
                feature_vif: vec![],
                rows: vec![],
                rows_sampled: false,
                source_row_count: 0,
                qq_rows: vec![],
                qq_rows_sampled: false,
                qq_source_row_count: 0,
                qq_reason: Some(FitModelInferenceReason::InferenceNotEstimable),
            },
            summary_of_fit: FitModelSummaryOfFit {
                r_squared: Some(0.9),
                adjusted_r_squared: Some(0.8),
                root_mean_square_error: Some(1.0),
                mean_of_response: 1.0,
                observation_count: 2,
                model_degrees_of_freedom: 1,
                error_degrees_of_freedom: 0,
            },
            anova: vec![],
            parameter_estimates: vec![],
            plot_rows: vec![],
            plot_rows_sampled: false,
            warnings: vec![],
        }));
        let not_computable = FitModelResult::NotComputable(FitModelNotComputableResult {
            reason: FitModelNotComputableReason::InsufficientRows,
            used_rows: 1,
            excluded_rows: 2,
        });

        let fitted_value = serde_json::to_value(&fitted).expect("serialization should succeed");
        let not_value =
            serde_json::to_value(&not_computable).expect("serialization should succeed");

        assert_eq!(fitted_value["kind"], "fitted");
        assert_eq!(not_value["kind"], "notComputable");
    }
}

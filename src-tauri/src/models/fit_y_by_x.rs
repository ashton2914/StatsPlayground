use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitYByXPersonality {
    Oneway,
    Bivariate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitYByXRequest {
    pub dataset_id: String,
    pub generation: u64,
    pub response_column: String,
    pub factor_column: String,
    pub personality: FitYByXPersonality,
    pub confidence_level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitYByXResponse {
    pub dataset_id: String,
    pub generation: u64,
    pub result: FitYByXResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitYByXRows {
    pub source_rows: u64,
    pub rows: Vec<FitYByXRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FitYByXRow {
    Oneway { y: f64, group: String },
    Bivariate { x: f64, y: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FitYByXResult {
    Oneway(OnewayResult),
    Bivariate(BivariateResult),
    NotComputable(NotComputableResult),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitYByXNotComputableReason {
    InsufficientValidRows,
    InsufficientGroups,
    ConstantFactor,
    NoResidualDegreesOfFreedom,
    NoWithinGroupDegreesOfFreedom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotComputableResult {
    pub personality: FitYByXPersonality,
    pub reason: FitYByXNotComputableReason,
    pub used_rows: u64,
    pub excluded_rows: u64,
    pub confidence_level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnovaRow {
    pub source: String,
    pub degrees_of_freedom: u64,
    pub sum_of_squares: f64,
    pub mean_square: Option<f64>,
    pub f_ratio: Option<f64>,
    pub p_value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRow {
    pub term: String,
    pub estimate: f64,
    pub standard_error: Option<f64>,
    pub t_ratio: Option<f64>,
    pub p_value: Option<f64>,
    pub lower_confidence_limit: Option<f64>,
    pub upper_confidence_limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnewayGroupSummary {
    pub group: String,
    pub count: u64,
    pub mean: f64,
    pub standard_deviation: Option<f64>,
    pub standard_error: Option<f64>,
    pub lower_confidence_limit: Option<f64>,
    pub upper_confidence_limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnewayEffectSizes {
    pub eta_squared: f64,
    pub omega_squared: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnewayResult {
    pub used_rows: u64,
    pub excluded_rows: u64,
    pub confidence_level: f64,
    pub group_summaries: Vec<OnewayGroupSummary>,
    pub anova: Vec<AnovaRow>,
    pub effect_sizes: OnewayEffectSizes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryOfFit {
    pub r_squared: Option<f64>,
    pub adjusted_r_squared: Option<f64>,
    pub root_mean_square_error: Option<f64>,
    pub mean_of_response: f64,
    pub observation_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LackOfFitAvailable {
    pub rows: Vec<AnovaRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LackOfFitResult {
    Available(LackOfFitAvailable),
    NotIdentifiable,
}

impl LackOfFitResult {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available(_))
    }

    pub fn available(&self) -> Option<&LackOfFitAvailable> {
        match self {
            Self::Available(value) => Some(value),
            Self::NotIdentifiable => None,
        }
    }

    pub fn is_not_identifiable(&self) -> bool {
        matches!(self, Self::NotIdentifiable)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BivariateResult {
    pub used_rows: u64,
    pub excluded_rows: u64,
    pub confidence_level: f64,
    pub intercept: f64,
    pub slope: f64,
    pub summary_of_fit: SummaryOfFit,
    pub lack_of_fit: LackOfFitResult,
    pub anova: Vec<AnovaRow>,
    pub parameter_estimates: Vec<EstimateRow>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_y_by_x_result_serializes_with_camel_case_tags() {
        let result = FitYByXResult::NotComputable(NotComputableResult {
            personality: FitYByXPersonality::Bivariate,
            reason: FitYByXNotComputableReason::ConstantFactor,
            used_rows: 3,
            excluded_rows: 1,
            confidence_level: 0.95,
        });

        let value = serde_json::to_value(&result).expect("serialization should succeed");

        assert_eq!(value["kind"], "notComputable");
        assert_eq!(value["usedRows"], 3);
        assert_eq!(value["excludedRows"], 1);
        assert_eq!(value["confidenceLevel"], 0.95);
        assert_eq!(value["reason"], "constantFactor");
        assert_eq!(value["personality"], "bivariate");
    }

    #[test]
    fn fit_y_by_x_request_and_nested_tags_deserialize_from_camel_case_json() {
        let request: FitYByXRequest = serde_json::from_value(serde_json::json!({
            "datasetId": "ds1",
            "generation": 7,
            "responseColumn": "y",
            "factorColumn": "x",
            "personality": "oneway",
            "confidenceLevel": 0.95
        }))
        .expect("request should deserialize");

        assert_eq!(request.dataset_id, "ds1");
        assert_eq!(request.generation, 7);
        assert_eq!(request.personality, FitYByXPersonality::Oneway);

        let response = FitYByXResponse {
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            result: FitYByXResult::NotComputable(NotComputableResult {
                personality: FitYByXPersonality::Oneway,
                reason: FitYByXNotComputableReason::InsufficientGroups,
                used_rows: 1,
                excluded_rows: 0,
                confidence_level: 0.95,
            }),
        };
        let response_value = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(response_value["datasetId"], "ds1");
        assert_eq!(response_value["generation"], 7);
        assert_eq!(response_value["result"]["kind"], "notComputable");

        let lack_of_fit = LackOfFitResult::Available(LackOfFitAvailable {
            rows: vec![AnovaRow {
                source: "Lack Of Fit".into(),
                degrees_of_freedom: 1,
                sum_of_squares: 1.0,
                mean_square: Some(1.0),
                f_ratio: Some(2.0),
                p_value: Some(0.2),
            }],
        });

        let value = serde_json::to_value(&lack_of_fit).expect("serialization should succeed");
        assert_eq!(value["state"], "available");
        assert!(value["rows"].is_array());

        let oneway = FitYByXResult::Oneway(OnewayResult {
            used_rows: 2,
            excluded_rows: 1,
            confidence_level: 0.95,
            group_summaries: vec![OnewayGroupSummary {
                group: "A".into(),
                count: 1,
                mean: 1.0,
                standard_deviation: None,
                standard_error: None,
                lower_confidence_limit: None,
                upper_confidence_limit: None,
            }],
            anova: vec![AnovaRow {
                source: "Within".into(),
                degrees_of_freedom: 0,
                sum_of_squares: 0.0,
                mean_square: None,
                f_ratio: None,
                p_value: None,
            }],
            effect_sizes: OnewayEffectSizes {
                eta_squared: 1.0,
                omega_squared: None,
            },
        });

        let oneway_value = serde_json::to_value(&oneway).expect("serialization should succeed");
        assert_eq!(oneway_value["kind"], "oneway");
        assert_eq!(oneway_value["effectSizes"]["etaSquared"], 1.0);
        assert!(oneway_value["effectSizes"]["omegaSquared"].is_null());
    }
}

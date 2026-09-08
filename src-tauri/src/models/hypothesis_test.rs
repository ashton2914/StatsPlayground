use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestMethodId {
    StudentTwoSampleT,
    WelchTwoSampleT,
    MannWhitneyU,
    OneWayAnova,
    WelchAnova,
    KruskalWallis,
    PairedT,
    WilcoxonSignedRank,
    RandomizedBlockAnova,
    Friedman,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestStudyDesign {
    Independent,
    PairedOrBlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestSelectionMode {
    Automatic,
    Guided,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HypothesisTestAlternative {
    TwoSided,
    Less,
    Greater,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestFieldRef {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "layout", rename_all = "camelCase")]
pub enum HypothesisTestRoles {
    Long {
        response: HypothesisTestFieldRef,
        condition: HypothesisTestFieldRef,
        subject: Option<HypothesisTestFieldRef>,
    },
    Wide {
        measurements: Vec<HypothesisTestFieldRef>,
        subject: Option<HypothesisTestFieldRef>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestManualSelection {
    pub method_id: HypothesisTestMethodId,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestDefinition {
    pub kind: String,
    pub roles: HypothesisTestRoles,
    pub study_design: HypothesisTestStudyDesign,
    pub selection_mode: HypothesisTestSelectionMode,
    pub manual_selection: Option<HypothesisTestManualSelection>,
    pub alternative: HypothesisTestAlternative,
    pub alpha: f64,
    pub confidence_level: f64,
    pub level_order: Vec<String>,
    pub reference_level: Option<String>,
    pub post_hoc: String,
    pub selector_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestRequest {
    pub analysis_kind: String,
    pub analysis_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub config_revision: u64,
    pub definition: HypothesisTestDefinition,
    pub request_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HypothesisTestValue {
    Available { value: f64 },
    Unavailable { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestEstimate {
    pub estimand: String,
    pub estimate: HypothesisTestValue,
    pub lower: HypothesisTestValue,
    pub upper: HypothesisTestValue,
    pub confidence_level: f64,
    pub simultaneous: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestEffectSize {
    pub kind: String,
    pub estimate: HypothesisTestValue,
    pub formula_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestMethodResult {
    pub state: String,
    pub method_id: HypothesisTestMethodId,
    pub statistic_name: String,
    pub statistic: f64,
    pub degrees_of_freedom: Vec<f64>,
    pub p_value: f64,
    pub direction: String,
    pub conclusion: String,
    pub estimate: HypothesisTestEstimate,
    pub effect_size: HypothesisTestEffectSize,
    pub formula_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestCompatibility {
    pub method_id: HypothesisTestMethodId,
    pub state: String,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestDiagnosticEvidence {
    pub code: String,
    pub grade: String,
    pub value: HypothesisTestValue,
    pub parameters: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestSelectionDecision {
    pub selector_version: String,
    pub recommended_method: HypothesisTestMethodId,
    pub executed_method: HypothesisTestMethodId,
    pub certainty: String,
    pub reason_codes: Vec<String>,
    pub overridden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestSensitivityResult {
    pub method: HypothesisTestMethodResult,
    pub robustness: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestPostHocComparison {
    pub left: String,
    pub right: String,
    pub estimate: HypothesisTestValue,
    pub raw_p_value: f64,
    pub adjusted_p_value: f64,
    pub adjustment: String,
    pub lower: HypothesisTestValue,
    pub upper: HypothesisTestValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestPostHocResult {
    pub state: String,
    pub family: String,
    pub comparisons: Vec<HypothesisTestPostHocComparison>,
    pub compact_letters: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestExclusion {
    pub identity: String,
    pub reason_code: String,
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestAudit {
    pub selector_version: String,
    pub method_version: String,
    pub formula_version: String,
    pub inference_path: String,
    pub correction_codes: Vec<String>,
    pub executed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestPlotObservation {
    pub condition: String,
    pub value: f64,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestPlotSummary {
    pub condition: String,
    pub count: u64,
    pub mean: f64,
    pub median: f64,
    pub lower_quartile: f64,
    pub upper_quartile: f64,
    pub minimum: f64,
    pub maximum: f64,
    pub mean_interval_lower: HypothesisTestValue,
    pub mean_interval_upper: HypothesisTestValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestQqPoint {
    pub theoretical: f64,
    pub observed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestPlotData {
    pub study_structure: String,
    pub conditions: Vec<String>,
    pub observations: Vec<HypothesisTestPlotObservation>,
    pub summaries: Vec<HypothesisTestPlotSummary>,
    pub diagnostic_kind: String,
    pub diagnostic_values: Vec<f64>,
    pub qq_points: Vec<HypothesisTestQqPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisTestResponse {
    pub analysis_kind: String,
    pub analysis_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub config_revision: u64,
    pub selector_version: String,
    pub request_fingerprint: String,
    pub retained_observations: u64,
    pub plot_data: HypothesisTestPlotData,
    pub exclusions: Vec<HypothesisTestExclusion>,
    pub compatibility: Vec<HypothesisTestCompatibility>,
    pub diagnostics: Vec<HypothesisTestDiagnosticEvidence>,
    pub selection_decision: HypothesisTestSelectionDecision,
    pub primary_result: HypothesisTestMethodResult,
    pub sensitivity_results: Vec<HypothesisTestSensitivityResult>,
    pub post_hoc_result: Option<HypothesisTestPostHocResult>,
    pub warnings: Vec<String>,
    pub method_audit: HypothesisTestAudit,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hypothesis_test_request_and_response_use_stable_camel_case_contracts() {
        let request: HypothesisTestRequest = serde_json::from_value(serde_json::json!({
            "analysisKind": "hypothesisTest",
            "analysisId": "analysis-1",
            "datasetId": "dataset-1",
            "generation": 3,
            "configRevision": 2,
            "definition": {
                "kind": "hypothesisTest",
                "roles": {
                    "layout": "long",
                    "response": { "name": "Strength", "type": "continuous" },
                    "condition": { "name": "Site", "type": "nominal" },
                    "subject": null
                },
                "studyDesign": "independent",
                "selectionMode": "automatic",
                "manualSelection": null,
                "alternative": "twoSided",
                "alpha": 0.05,
                "confidenceLevel": 0.95,
                "levelOrder": [],
                "referenceLevel": null,
                "postHoc": "automatic",
                "selectorVersion": "1"
            },
            "requestFingerprint": "fingerprint"
        })).expect("request should deserialize");
        assert_eq!(request.analysis_kind, "hypothesisTest");

        let value = serde_json::to_value(HypothesisTestResponse {
            analysis_kind: "hypothesisTest".into(),
            analysis_id: "analysis-1".into(),
            dataset_id: "dataset-1".into(),
            generation: 3,
            config_revision: 2,
            selector_version: "1".into(),
            request_fingerprint: "fingerprint".into(),
            retained_observations: 12,
            plot_data: HypothesisTestPlotData {
                study_structure: "independent".into(),
                conditions: vec!["A".into(), "B".into()],
                observations: vec![],
                summaries: vec![],
                diagnostic_kind: "groupResiduals".into(),
                diagnostic_values: vec![],
                qq_points: vec![],
            },
            exclusions: vec![],
            compatibility: vec![],
            diagnostics: vec![],
            selection_decision: HypothesisTestSelectionDecision {
                selector_version: "1".into(),
                recommended_method: HypothesisTestMethodId::WelchTwoSampleT,
                executed_method: HypothesisTestMethodId::WelchTwoSampleT,
                certainty: "high".into(),
                reason_codes: vec![],
                overridden: false,
            },
            primary_result: sample_result(),
            sensitivity_results: vec![],
            post_hoc_result: None,
            warnings: vec![],
            method_audit: HypothesisTestAudit {
                selector_version: "1".into(),
                method_version: "1".into(),
                formula_version: "1".into(),
                inference_path: "parametric".into(),
                correction_codes: vec![],
                executed_at: "2026-09-08T00:00:00Z".into(),
            },
        }).expect("response should serialize");

        assert_eq!(value["analysisKind"], "hypothesisTest");
        assert_eq!(value["selectionDecision"]["recommendedMethod"], "welchTwoSampleT");
        assert_eq!(value["primaryResult"]["methodId"], "welchTwoSampleT");
        assert_eq!(value["methodAudit"]["selectorVersion"], "1");
    }

    fn sample_result() -> HypothesisTestMethodResult {
        HypothesisTestMethodResult {
            state: "computed".into(),
            method_id: HypothesisTestMethodId::WelchTwoSampleT,
            statistic_name: "t".into(),
            statistic: 2.1,
            degrees_of_freedom: vec![9.5],
            p_value: 0.04,
            direction: "positive".into(),
            conclusion: "difference".into(),
            estimate: HypothesisTestEstimate {
                estimand: "meanDifference".into(),
                estimate: HypothesisTestValue::Available { value: 1.2 },
                lower: HypothesisTestValue::Available { value: 0.1 },
                upper: HypothesisTestValue::Available { value: 2.3 },
                confidence_level: 0.95,
                simultaneous: false,
            },
            effect_size: HypothesisTestEffectSize {
                kind: "hedgesG".into(),
                estimate: HypothesisTestValue::Available { value: 0.6 },
                formula_version: "1".into(),
            },
            formula_version: "1".into(),
        }
    }
}
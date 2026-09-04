use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::table::TableWindowFilter;

pub const GRAPH_SCATTER_RENDER_BUDGET: usize = 8_000;
pub const DISTRIBUTION_OVERVIEW_HISTOGRAM_ELEMENT_ID: &str = "distribution.overview.histogram";
pub const DISTRIBUTION_OVERVIEW_FITTED_CURVES_ELEMENT_ID: &str =
    "distribution.overview.fittedCurves";
pub const DISTRIBUTION_BOX_PLOT_ELEMENT_ID: &str = "distribution.boxPlot";
pub const DISTRIBUTION_ECDF_ELEMENT_ID: &str = "distribution.ecdf";
pub const DISTRIBUTION_NORMAL_QUANTILE_POINTS_ELEMENT_ID: &str =
    "distribution.normalQuantile.points";
pub const DISTRIBUTION_NORMAL_QUANTILE_REFERENCE_ELEMENT_ID: &str =
    "distribution.normalQuantile.reference";
pub const DISTRIBUTION_NORMAL_QUANTILE_LOWER_ELEMENT_ID: &str = "distribution.normalQuantile.lower";
pub const DISTRIBUTION_NORMAL_QUANTILE_UPPER_ELEMENT_ID: &str = "distribution.normalQuantile.upper";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphFieldBinding {
    pub role: String,
    pub column: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CorrelationMethod {
    Pearson,
    Spearman,
    Kendall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphElementRequest {
    pub kind: String,
    pub summary_stat: String,
    #[serde(default)]
    pub correlation_method: Option<CorrelationMethod>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphViewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GraphSampling {
    Full,
    Sample { size: usize, seed: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataRequest {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub fields: Vec<GraphFieldBinding>,
    pub filters: Vec<TableWindowFilter>,
    pub elements: Vec<GraphElementRequest>,
    pub sampling: GraphSampling,
    pub raw_point_budget: usize,
    pub viewport: GraphViewport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphPayloadType {
    F64,
    U32,
    I64,
    U8,
}

impl GraphPayloadType {
    pub fn byte_width(&self) -> usize {
        match self {
            Self::F64 => 8,
            Self::U32 => 4,
            Self::I64 => 8,
            Self::U8 => 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphTypedSliceDescriptor {
    #[serde(rename = "type")]
    pub payload_type: GraphPayloadType,
    pub offset: usize,
    pub byte_length: usize,
}

impl GraphTypedSliceDescriptor {
    pub fn new(payload_type: GraphPayloadType, offset: usize, byte_length: usize) -> Self {
        Self {
            payload_type,
            offset,
            byte_length,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphAxisEncoding {
    Numeric,
    Categorical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChunkHeader {
    pub request_id: String,
    pub generation: u64,
    pub chunk_index: u32,
    pub row_offset: u64,
    pub row_count: usize,
    pub source_rows: u64,
    pub processed_rows: u64,
    pub projected_columns: Vec<String>,
    pub dictionaries: BTreeMap<String, Vec<String>>,
    pub validity_ranges: BTreeMap<String, GraphTypedSliceDescriptor>,
    pub x_values: GraphTypedSliceDescriptor,
    pub y_values: GraphTypedSliceDescriptor,
    pub row_ids: GraphTypedSliceDescriptor,
    pub z_values: Option<GraphTypedSliceDescriptor>,
    pub group_codes: Option<GraphTypedSliceDescriptor>,
    pub size_values: Option<GraphTypedSliceDescriptor>,
    pub source_codes: Option<GraphTypedSliceDescriptor>,
    pub facet_x_codes: Option<GraphTypedSliceDescriptor>,
    pub facet_y_codes: Option<GraphTypedSliceDescriptor>,
    pub facet_z_codes: Option<GraphTypedSliceDescriptor>,
    pub wrap_codes: Option<GraphTypedSliceDescriptor>,
    pub role_vectors: BTreeMap<String, GraphTypedSliceDescriptor>,
    pub x_encoding: GraphAxisEncoding,
    pub final_chunk: bool,
}

impl GraphChunkHeader {
    pub fn validate_layout(&self, payload_len: usize) -> Result<(), String> {
        let mut slices: Vec<&GraphTypedSliceDescriptor> =
            vec![&self.x_values, &self.y_values, &self.row_ids];

        if let Some(group_codes) = &self.group_codes {
            slices.push(group_codes);
        }
        if let Some(z_values) = &self.z_values {
            slices.push(z_values);
        }
        if let Some(size_values) = &self.size_values {
            slices.push(size_values);
        }
        if let Some(source_codes) = &self.source_codes {
            slices.push(source_codes);
        }
        if let Some(facet_x_codes) = &self.facet_x_codes {
            slices.push(facet_x_codes);
        }
        if let Some(facet_y_codes) = &self.facet_y_codes {
            slices.push(facet_y_codes);
        }
        if let Some(facet_z_codes) = &self.facet_z_codes {
            slices.push(facet_z_codes);
        }
        if let Some(wrap_codes) = &self.wrap_codes {
            slices.push(wrap_codes);
        }

        for descriptor in self.role_vectors.values() {
            slices.push(descriptor);
        }

        for descriptor in self.validity_ranges.values() {
            slices.push(descriptor);
        }

        let expected_validity_bytes = self.row_count.div_ceil(8);
        for (key, descriptor) in &self.validity_ranges {
            if descriptor.payload_type != GraphPayloadType::U8 {
                return Err(format!("validity range {key} must use u8 payload type"));
            }
            if descriptor.byte_length != expected_validity_bytes {
                return Err(format!(
                    "validity range {key} byte length {} must equal {} for row_count {}",
                    descriptor.byte_length, expected_validity_bytes, self.row_count
                ));
            }
        }

        for descriptor in &slices {
            if descriptor.offset % 8 != 0 {
                return Err(format!(
                    "slice offset {} is not 8-byte aligned",
                    descriptor.offset
                ));
            }

            let type_width = descriptor.payload_type.byte_width();
            if descriptor.offset % type_width != 0 {
                return Err(format!(
                    "slice offset {} is not aligned for {:?}",
                    descriptor.offset, descriptor.payload_type
                ));
            }
            if descriptor.byte_length % type_width != 0 {
                return Err(format!(
                    "slice byte length {} is not divisible by {:?}",
                    descriptor.byte_length, descriptor.payload_type
                ));
            }

            let end = descriptor
                .offset
                .checked_add(descriptor.byte_length)
                .ok_or_else(|| "slice range overflow".to_string())?;

            if end > payload_len {
                return Err(format!(
                    "slice range [{}..{}) exceeds payload length {}",
                    descriptor.offset, end, payload_len
                ));
            }
        }

        let mut ranges: Vec<(usize, usize)> = slices
            .iter()
            .map(|descriptor| {
                (
                    descriptor.offset,
                    descriptor.offset + descriptor.byte_length,
                )
            })
            .collect();
        ranges.sort_unstable_by_key(|range| range.0);

        for pair in ranges.windows(2) {
            let prev = pair[0];
            let next = pair[1];
            if prev == next {
                continue;
            }
            if prev.1 > next.0 {
                return Err(format!(
                    "slice overlap detected between [{}..{}) and [{}..{})",
                    prev.0, prev.1, next.0, next.1
                ));
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphRawPointOmissionReason {
    PointBudgetExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphRawPointDisposition {
    Included {
        valid_rows: u64,
        budget: usize,
    },
    Empty {
        valid_rows: u64,
        budget: usize,
    },
    Omitted {
        reason: GraphRawPointOmissionReason,
        valid_rows: u64,
        budget: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataCompletion {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub source_rows: u64,
    pub processed_rows: u64,
    pub chunks_sent: u32,
    pub cancelled: bool,
    pub raw_point_disposition: GraphRawPointDisposition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_request_deserializes_with_camel_case_fields() {
        let request: GraphDataRequest = serde_json::from_value(serde_json::json!({
            "requestId": "req-1",
            "datasetId": "dataset-id",
            "generation": 7,
            "fields": [
                { "role": "x", "column": "region" },
                { "role": "y", "column": "cost" }
            ],
            "filters": [],
            "elements": [{ "kind": "points", "summaryStat": "none" }],
            "sampling": { "mode": "full" },
            "rawPointBudget": 8000,
            "viewport": { "width": 1200, "height": 700 }
        }))
        .unwrap();

        assert_eq!(request.request_id, "req-1");
        assert!(matches!(request.sampling, GraphSampling::Full));
        assert_eq!(
            serde_json::to_value(&request).unwrap()["rawPointBudget"],
            8000
        );
    }

    #[test]
    fn graph_completion_round_trips_raw_point_dispositions() {
        let dispositions = [
            serde_json::json!({
                "status": "included",
                "validRows": 7,
                "budget": 8000
            }),
            serde_json::json!({
                "status": "empty",
                "validRows": 0,
                "budget": 8000
            }),
            serde_json::json!({
                "status": "omitted",
                "reason": "pointBudgetExceeded",
                "validRows": 8001,
                "budget": 8000
            }),
        ];

        for raw_point_disposition in dispositions {
            let completion: GraphDataCompletion = serde_json::from_value(serde_json::json!({
                "requestId": "req-1",
                "datasetId": "dataset-id",
                "generation": 7,
                "sourceRows": 8001,
                "processedRows": 8001,
                "chunksSent": 0,
                "cancelled": false,
                "rawPointDisposition": raw_point_disposition
            }))
            .unwrap();

            assert_eq!(
                serde_json::to_value(completion).unwrap()["rawPointDisposition"],
                raw_point_disposition
            );
        }
    }

    #[test]
    fn chunk_layout_requires_eight_byte_alignment_and_non_overlapping_slices() {
        let header = GraphChunkHeader {
            request_id: "req-1".into(),
            generation: 3,
            chunk_index: 0,
            row_offset: 0,
            row_count: 2,
            source_rows: 2,
            processed_rows: 2,
            projected_columns: vec!["_row_id".into(), "x".into(), "y".into()],
            dictionaries: std::collections::BTreeMap::new(),
            validity_ranges: std::collections::BTreeMap::from([(
                "x".into(),
                GraphTypedSliceDescriptor::new(GraphPayloadType::U8, 72, 1),
            )]),
            x_values: GraphTypedSliceDescriptor::new(GraphPayloadType::F64, 0, 16),
            y_values: GraphTypedSliceDescriptor::new(GraphPayloadType::F64, 16, 16),
            row_ids: GraphTypedSliceDescriptor::new(GraphPayloadType::I64, 32, 16),
            z_values: None,
            group_codes: Some(GraphTypedSliceDescriptor::new(GraphPayloadType::U32, 48, 8)),
            size_values: Some(GraphTypedSliceDescriptor::new(
                GraphPayloadType::F64,
                56,
                16,
            )),
            source_codes: None,
            facet_x_codes: None,
            facet_y_codes: None,
            facet_z_codes: None,
            wrap_codes: None,
            role_vectors: std::collections::BTreeMap::new(),
            x_encoding: GraphAxisEncoding::Categorical,
            final_chunk: true,
        };

        assert!(header.validate_layout(80).is_ok());

        let mut misaligned = header.clone();
        misaligned.x_values.offset = 4;
        assert!(misaligned.validate_layout(80).is_err());

        let mut overlapping = header.clone();
        overlapping.y_values.offset = 8;
        assert!(overlapping.validate_layout(80).is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GraphAggregatePacket {
    Histogram(HistogramPacket),
    Heatmap(HeatmapPacket),
    BoxPlot(BoxPlotPacket),
    Summary(SummaryPacket),
    CorrelationMatrix(CorrelationMatrixPacket),
    PrecomputedPoints(PrecomputedPointPacket),
    PrecomputedCurve(PrecomputedCurvePacket),
}

pub const GRAPH_VIRTUAL_VALUE_COLUMN: &str = "__sp_value__";
pub const GRAPH_VIRTUAL_SOURCE_COLUMN: &str = "__sp_variable__";

impl GraphAggregatePacket {
    #[cfg(test)]
    pub fn histogram_total_count(&self) -> Option<u64> {
        match self {
            Self::Histogram(packet) => Some(packet.total_count),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramPacket {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_column: Option<String>,
    pub y_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
    pub bin_count: u32,
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
    pub missing_count: u64,
    pub bin_width: f64,
    pub total_count: u64,
    pub bins: Vec<HistogramBin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramBin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_y: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_z: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<String>,
    pub bin_start: f64,
    pub bin_end: f64,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapPacket {
    pub x_column: String,
    pub y_column: String,
    pub group_column: Option<String>,
    pub source_column: Option<String>,
    pub x_bin_count: u32,
    pub y_bin_count: u32,
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub missing_count: u64,
    pub x_bin_width: f64,
    pub y_bin_width: f64,
    pub total_count: u64,
    pub cells: Vec<HeatmapCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapCell {
    pub group: Option<String>,
    pub category: Option<String>,
    pub source_column: Option<String>,
    pub facet_x: Option<String>,
    pub facet_y: Option<String>,
    pub facet_z: Option<String>,
    pub wrap: Option<String>,
    pub x_bin_index: i64,
    pub y_bin_index: i64,
    pub x_bin_start: f64,
    pub x_bin_end: f64,
    pub y_bin_start: f64,
    pub y_bin_end: f64,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxPlotPacket {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_column: Option<String>,
    pub y_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
    pub entries: Vec<BoxPlotEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxPlotEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_y: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet_z: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<String>,
    pub count: u64,
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    pub whisker_low: f64,
    pub whisker_high: f64,
    pub outliers: Vec<BoxPlotOutlier>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxPlotOutlier {
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputedPointPacket {
    pub element_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_name: Option<String>,
    pub points: Vec<PrecomputedPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputedPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PrecomputedCurveInterpolation {
    Linear,
    StepEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputedCurvePacket {
    pub element_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_name: Option<String>,
    pub interpolation: PrecomputedCurveInterpolation,
    pub points: Vec<PrecomputedCurvePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputedCurvePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPacket {
    pub x_column: Option<String>,
    pub y_column: String,
    pub group_column: Option<String>,
    pub source_column: Option<String>,
    pub summaries: Vec<SummaryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryEntry {
    pub group: Option<String>,
    pub category: Option<String>,
    pub source_column: Option<String>,
    pub facet_x: Option<String>,
    pub facet_y: Option<String>,
    pub facet_z: Option<String>,
    pub wrap: Option<String>,
    pub count: u64,
    pub mean: f64,
    pub median: f64,
    pub stddev: f64,
    pub min: f64,
    pub max: f64,
    pub interval_low: Option<f64>,
    pub interval_high: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CorrelationUnavailableReason {
    InsufficientData,
    ZeroVariance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationMatrixCell {
    pub x_index: u32,
    pub y_index: u32,
    pub coefficient: Option<f64>,
    pub sample_count: u64,
    pub unavailable_reason: Option<CorrelationUnavailableReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationMatrixPacket {
    pub method: CorrelationMethod,
    pub columns: Vec<String>,
    pub cells: Vec<CorrelationMatrixCell>,
}

#[cfg(test)]
mod correlation_matrix_tests {
    use super::*;

    #[test]
    fn correlation_matrix_packet_serializes_with_camel_case_and_kind_tag() {
        let packet = GraphAggregatePacket::CorrelationMatrix(CorrelationMatrixPacket {
            method: CorrelationMethod::Spearman,
            columns: vec!["a".to_string(), "b".to_string()],
            cells: vec![CorrelationMatrixCell {
                x_index: 0,
                y_index: 1,
                coefficient: None,
                sample_count: 3,
                unavailable_reason: Some(CorrelationUnavailableReason::ZeroVariance),
            }],
        });

        let value = serde_json::to_value(packet).expect("serialize correlation packet");

        assert_eq!(value["kind"], serde_json::json!("correlationMatrix"));
        assert_eq!(value["method"], serde_json::json!("spearman"));
        assert_eq!(value["cells"][0]["sampleCount"], serde_json::json!(3));
        assert_eq!(value["cells"][0]["coefficient"], serde_json::Value::Null);
        assert_eq!(
            value["cells"][0]["unavailableReason"],
            serde_json::json!("zeroVariance")
        );
    }
}

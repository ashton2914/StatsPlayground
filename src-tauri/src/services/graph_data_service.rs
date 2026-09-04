use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use duckdb::types::Value;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::engine::duckdb_engine::GraphProjectionStats;
use crate::error::AppError;
use crate::models::graph_data::{
    GraphAggregatePacket, GraphAxisEncoding, GraphChunkHeader, GraphDataCompletion,
    GraphDataRequest, GraphPayloadType, GraphRawPointDisposition, GraphRawPointOmissionReason,
    GraphTypedSliceDescriptor, GRAPH_SCATTER_RENDER_BUDGET, GRAPH_VIRTUAL_SOURCE_COLUMN,
};
use crate::state::AppState;

const INITIAL_PAYLOAD_BUDGET_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
struct CancellationEntry {
    cancelled: bool,
    nonce: u64,
}

fn cancelled_requests() -> &'static Mutex<HashMap<String, CancellationEntry>> {
    static CANCELLED_REQUESTS: OnceLock<Mutex<HashMap<String, CancellationEntry>>> =
        OnceLock::new();
    CANCELLED_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy)]
struct RequestRun {
    nonce: u64,
    pre_cancelled: bool,
}

#[derive(Debug)]
enum GraphSinkError {
    Closed,
    Invalid(String),
}

trait GraphChunkSink {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError>;

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError>;

    fn send_aggregate(&mut self, packet: &GraphAggregatePacket) -> Result<(), GraphSinkError>;

    fn send_terminal(&mut self, completion: &GraphDataCompletion) -> Result<(), GraphSinkError>;
}

struct ChannelChunkSink<'a> {
    on_chunk: &'a Channel<InvokeResponseBody>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamHeaderMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    header: &'a GraphChunkHeader,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamCompletionMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    completion: &'a GraphDataCompletion,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamAggregateMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    packet: &'a GraphAggregatePacket,
}

impl GraphChunkSink for ChannelChunkSink<'_> {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
        let message = GraphStreamHeaderMessage {
            message_type: "header",
            header,
        };
        let serialized = serde_json::to_string(&message)
            .map_err(|error| GraphSinkError::Invalid(error.to_string()))?;
        if self
            .on_chunk
            .send(InvokeResponseBody::from(serialized))
            .is_err()
        {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
        if self
            .on_chunk
            .send(InvokeResponseBody::from(payload))
            .is_err()
        {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }

    fn send_aggregate(&mut self, packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
        let message = GraphStreamAggregateMessage {
            message_type: "aggregate",
            packet,
        };
        let serialized = serde_json::to_string(&message)
            .map_err(|error| GraphSinkError::Invalid(error.to_string()))?;
        if self
            .on_chunk
            .send(InvokeResponseBody::from(serialized))
            .is_err()
        {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }

    fn send_terminal(&mut self, completion: &GraphDataCompletion) -> Result<(), GraphSinkError> {
        let message = GraphStreamCompletionMessage {
            message_type: "complete",
            completion,
        };
        let serialized = serde_json::to_string(&message)
            .map_err(|error| GraphSinkError::Invalid(error.to_string()))?;
        if self
            .on_chunk
            .send(InvokeResponseBody::from(serialized))
            .is_err()
        {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }
}

#[cfg(any(test, feature = "perf-harness"))]
#[derive(Default)]
struct CollectingChunkSink {
    chunks: Vec<GraphDataChunk>,
    pending_header: Option<GraphChunkHeader>,
    aggregate_packets: Vec<GraphAggregatePacket>,
    terminal_completion: Option<GraphDataCompletion>,
}

#[cfg(any(test, feature = "perf-harness"))]
impl CollectingChunkSink {
    #[cfg(test)]
    fn into_result(self) -> Result<(Vec<GraphDataChunk>, GraphDataCompletion), AppError> {
        if self.pending_header.is_some() {
            return Err(AppError::Database(
                "graph chunk header was not followed by payload".to_string(),
            ));
        }
        let completion = self.terminal_completion.ok_or_else(|| {
            AppError::Database("graph sink did not receive terminal completion".to_string())
        })?;
        Ok((self.chunks, completion))
    }
}

#[cfg(any(test, feature = "perf-harness"))]
impl GraphChunkSink for CollectingChunkSink {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
        if self.pending_header.is_some() {
            return Err(GraphSinkError::Invalid(
                "graph sink received a header before payload".to_string(),
            ));
        }
        self.pending_header = Some(header.clone());
        Ok(())
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
        let Some(header) = self.pending_header.take() else {
            return Err(GraphSinkError::Invalid(
                "graph sink received payload before header".to_string(),
            ));
        };
        self.chunks.push(GraphDataChunk { header, payload });
        Ok(())
    }

    fn send_aggregate(&mut self, packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
        self.aggregate_packets.push(packet.clone());
        Ok(())
    }

    fn send_terminal(&mut self, completion: &GraphDataCompletion) -> Result<(), GraphSinkError> {
        if self.pending_header.is_some() {
            return Err(GraphSinkError::Invalid(
                "graph sink received terminal marker before payload".to_string(),
            ));
        }
        self.terminal_completion = Some(completion.clone());
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GraphDataChunk {
    pub header: GraphChunkHeader,
    pub payload: Vec<u8>,
}

#[cfg(any(test, feature = "perf-harness"))]
#[derive(Debug, Clone)]
pub(crate) struct GraphBenchmarkResult {
    pub completion: GraphDataCompletion,
    pub selected_columns: usize,
    pub projected_columns: Vec<String>,
    pub operation_ms: u128,
    pub query_ms: u128,
    pub encode_ms: u128,
    pub transferred_bytes: u64,
    pub projection_passes: u32,
}

#[derive(Default)]
struct StreamMetrics {
    encode_ms: u128,
    projection_passes: u32,
}

#[cfg(test)]
thread_local! {
    static TIMING_OBSERVATION_STARTS: Cell<u64> = const { Cell::new(0) };
}

fn begin_timing_observation() -> Instant {
    #[cfg(test)]
    {
        TIMING_OBSERVATION_STARTS.with(|starts| {
            starts.set(starts.get().saturating_add(1));
        });
    }
    Instant::now()
}

#[cfg(test)]
fn reset_timing_observation_starts() {
    TIMING_OBSERVATION_STARTS.with(|starts| starts.set(0));
}

#[cfg(test)]
fn timing_observation_starts() -> u64 {
    TIMING_OBSERVATION_STARTS.with(Cell::get)
}

pub struct GraphDataService<'a> {
    state: &'a AppState,
}

impl<'a> GraphDataService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn stream(
        &self,
        request: &GraphDataRequest,
        on_chunk: &Channel<InvokeResponseBody>,
    ) -> Result<GraphDataCompletion, AppError> {
        let mut sink = ChannelChunkSink { on_chunk };
        self.stream_with_sink(request, &mut sink)
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), AppError> {
        if request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "request_id must not be blank".to_string(),
            ));
        }
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let entry = cancelled
            .entry(request_id.to_string())
            .or_insert(CancellationEntry {
                cancelled: false,
                nonce: 0,
            });
        entry.cancelled = true;
        entry.nonce = entry.nonce.saturating_add(1);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn collect_for_harness(
        &self,
        request: &GraphDataRequest,
    ) -> Result<(Vec<GraphDataChunk>, GraphDataCompletion), AppError> {
        let mut sink = CollectingChunkSink::default();
        let completion = self.stream_with_sink(request, &mut sink)?;
        if completion.cancelled {
            return Err(AppError::InvalidParam(
                "request was cancelled during graph projection".to_string(),
            ));
        }
        sink.into_result()
    }

    #[cfg(any(test, feature = "perf-harness"))]
    pub(crate) fn collect_benchmark_result(
        &self,
        request: &GraphDataRequest,
    ) -> Result<GraphBenchmarkResult, AppError> {
        let mut sink = CollectingChunkSink::default();
        let started = Instant::now();
        let mut metrics = StreamMetrics::default();
        let completion = self.stream_with_sink_observed(request, &mut sink, Some(&mut metrics))?;
        if completion.cancelled {
            return Err(AppError::InvalidParam(
                "request was cancelled during graph projection".to_string(),
            ));
        }

        let selected_columns = sink
            .chunks
            .first()
            .map(|chunk| chunk.header.projected_columns.len())
            .unwrap_or(0);
        let projected_columns = sink
            .chunks
            .first()
            .map(|chunk| chunk.header.projected_columns.clone())
            .unwrap_or_default();

        let mut transferred = 0u64;
        for chunk in &sink.chunks {
            let header_message = GraphStreamHeaderMessage {
                message_type: "header",
                header: &chunk.header,
            };
            let header_bytes = serde_json::to_vec(&header_message)
                .map_err(|error| AppError::InvalidParam(error.to_string()))?;
            transferred = transferred
                .checked_add(u64::try_from(header_bytes.len()).map_err(|_| {
                    AppError::InvalidParam("header payload length overflow".to_string())
                })?)
                .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
            transferred = transferred
                .checked_add(u64::try_from(chunk.payload.len()).map_err(|_| {
                    AppError::InvalidParam("graph payload length overflow".to_string())
                })?)
                .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
        }

        for packet in &sink.aggregate_packets {
            let aggregate_message = GraphStreamAggregateMessage {
                message_type: "aggregate",
                packet,
            };
            let aggregate_bytes = serde_json::to_vec(&aggregate_message)
                .map_err(|error| AppError::InvalidParam(error.to_string()))?;
            transferred = transferred
                .checked_add(u64::try_from(aggregate_bytes.len()).map_err(|_| {
                    AppError::InvalidParam("aggregate payload length overflow".to_string())
                })?)
                .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
        }

        let terminal_message = GraphStreamCompletionMessage {
            message_type: "complete",
            completion: &completion,
        };
        let terminal_bytes = serde_json::to_vec(&terminal_message)
            .map_err(|error| AppError::InvalidParam(error.to_string()))?;
        transferred = transferred
            .checked_add(u64::try_from(terminal_bytes.len()).map_err(|_| {
                AppError::InvalidParam("terminal payload length overflow".to_string())
            })?)
            .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;

        let operation_ms = started.elapsed().as_millis();
        let encode_ms = metrics.encode_ms;
        let query_ms = operation_ms.saturating_sub(encode_ms);

        Ok(GraphBenchmarkResult {
            completion,
            selected_columns,
            projected_columns,
            operation_ms,
            query_ms,
            encode_ms,
            transferred_bytes: transferred,
            projection_passes: metrics.projection_passes,
        })
    }

    #[cfg(test)]
    pub fn collect_for_test(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphDataChunk>, AppError> {
        self.collect_for_harness(request).map(|(chunks, _)| chunks)
    }

    #[cfg(test)]
    pub fn collect_aggregates_for_test(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphAggregatePacket>, AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.collect_graph_aggregate_packets(request)
    }

    fn stream_with_sink<S: GraphChunkSink>(
        &self,
        request: &GraphDataRequest,
        sink: &mut S,
    ) -> Result<GraphDataCompletion, AppError> {
        self.stream_with_sink_observed(request, sink, None)
    }

    fn stream_with_sink_observed<S: GraphChunkSink>(
        &self,
        request: &GraphDataRequest,
        sink: &mut S,
        metrics: Option<&mut StreamMetrics>,
    ) -> Result<GraphDataCompletion, AppError> {
        let observed = metrics.is_some();
        let encode_ms_cell = Cell::new(0u128);
        let projection_passes_cell = Cell::new(0u32);

        let record_encode = |started: Instant| {
            if observed {
                encode_ms_cell.set(
                    encode_ms_cell
                        .get()
                        .saturating_add(started.elapsed().as_millis()),
                );
            }
        };

        if request.request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "request_id must not be blank".to_string(),
            ));
        }
        if request.dataset_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "dataset_id must not be blank".to_string(),
            ));
        }
        if request.fields.is_empty() {
            return Err(AppError::InvalidParam(
                "graph request must include at least one field".to_string(),
            ));
        }
        if request.raw_point_budget == 0 || request.raw_point_budget > GRAPH_SCATTER_RENDER_BUDGET {
            return Err(AppError::InvalidParam(format!(
                "raw_point_budget must be between 1 and {GRAPH_SCATTER_RENDER_BUDGET}"
            )));
        }
        if let crate::models::graph_data::GraphSampling::Sample { size, .. } = request.sampling {
            if size == 0 || size > request.raw_point_budget {
                return Err(AppError::InvalidParam(format!(
                    "sample size must be between 1 and raw_point_budget ({})",
                    request.raw_point_budget
                )));
            }
        }
        let buffer_raw_points = request.elements.iter().any(|element| {
            element.kind.eq_ignore_ascii_case("points")
                && element.summary_stat.eq_ignore_ascii_case("none")
        }) && !request
            .fields
            .iter()
            .any(|field| field.role.eq_ignore_ascii_case("z"));
        let run = self.begin_request_run(&request.request_id)?;
        if run.pre_cancelled {
            let completion = GraphDataCompletion {
                request_id: request.request_id.clone(),
                dataset_id: request.dataset_id.clone(),
                generation: request.generation,
                source_rows: 0,
                processed_rows: 0,
                chunks_sent: 0,
                cancelled: true,
                raw_point_disposition: GraphRawPointDisposition::Empty {
                    valid_rows: 0,
                    budget: request.raw_point_budget,
                },
            };
            sink.send_terminal(&completion)
                .map_err(Self::map_sink_error_to_app_error)?;
            self.finish_request_run(&request.request_id, run.nonce, true)?;
            return Ok(completion);
        }

        let result = (|| -> Result<GraphDataCompletion, AppError> {
            // Streamed raw chunks always carry row-aligned row ids so every mode
            // (line/points/3D) preserves source-row provenance and interaction identity.
            let include_row_id = true;
            let db = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;

            let (aggregate_packets, aggregates_cancelled) = db
                .collect_graph_aggregate_packets_with_cancel(request, || {
                    self.is_cancelled(&request.request_id, run.nonce)
                })?;

            if aggregates_cancelled {
                let encode_started = if observed {
                    Some(begin_timing_observation())
                } else {
                    None
                };
                let completion = self.emit_aggregate_cancelled_terminal(request, sink)?;
                if let Some(encode_started) = encode_started {
                    record_encode(encode_started);
                }
                return Ok(completion);
            }

            if request_is_aggregate_only(request, &aggregate_packets) {
                for packet in &aggregate_packets {
                    let encode_started = if observed {
                        Some(begin_timing_observation())
                    } else {
                        None
                    };
                    sink.send_aggregate(packet)
                        .map_err(Self::map_sink_error_to_app_error)?;
                    if let Some(encode_started) = encode_started {
                        record_encode(encode_started);
                    }
                }

                let completion = GraphDataCompletion {
                    request_id: request.request_id.clone(),
                    dataset_id: request.dataset_id.clone(),
                    generation: request.generation,
                    source_rows: 0,
                    processed_rows: 0,
                    chunks_sent: 0,
                    cancelled: false,
                    raw_point_disposition: GraphRawPointDisposition::Empty {
                        valid_rows: 0,
                        budget: request.raw_point_budget,
                    },
                };

                let encode_started = if observed {
                    Some(begin_timing_observation())
                } else {
                    None
                };
                sink.send_terminal(&completion)
                    .map_err(Self::map_sink_error_to_app_error)?;
                if let Some(encode_started) = encode_started {
                    record_encode(encode_started);
                }
                return Ok(completion);
            }

            let metadata: RefCell<Option<ProjectionMetadata>> = RefCell::new(None);
            let accumulator: RefCell<Option<ChunkAccumulator>> = RefCell::new(None);
            let mut chunk_index: u32 = 0;
            let mut row_offset: u64 = 0;
            let mut processed_rows: u64 = 0;
            let mut source_rows: u64 = 0;
            let mut chunks_sent: u32 = 0;
            let mut cancelled = false;
            let mut projection_callbacks: u32 = 0;
            let mut valid_rows: u64 = 0;
            let mut raw_points_omitted = false;
            let buffered_chunks: RefCell<Vec<GraphDataChunk>> = RefCell::new(Vec::new());

            let stats = db.stream_graph_projection_rows(
                request,
                include_row_id,
                |stats| {
                    projection_callbacks = projection_callbacks.saturating_add(1);
                    if observed {
                        projection_passes_cell.set(projection_callbacks);
                    }
                    if projection_callbacks > 1 {
                        return Err(AppError::Database(
                            "graph projection callback invoked multiple times".to_string(),
                        ));
                    }
                    let resolved = ProjectionMetadata::new(request, include_row_id, stats)?;
                    *accumulator.borrow_mut() = Some(ChunkAccumulator::new(&resolved));
                    *metadata.borrow_mut() = Some(resolved);
                    Ok(())
                },
                |row_id, values, row_source_rows| {
                    let encode_started = if observed {
                        Some(begin_timing_observation())
                    } else {
                        None
                    };
                    source_rows = row_source_rows;
                    if self.is_cancelled(&request.request_id, run.nonce)? {
                        cancelled = true;
                        return Ok(false);
                    }

                    let metadata_ref = metadata.borrow();
                    let metadata = metadata_ref.as_ref().ok_or_else(|| {
                        AppError::Database("graph projection metadata not initialized".to_string())
                    })?;
                    let mut accumulator_ref = accumulator.borrow_mut();
                    let accumulator = accumulator_ref.as_mut().ok_or_else(|| {
                        AppError::Database("graph chunk accumulator not initialized".to_string())
                    })?;

                    let renderable = is_renderable_xy(metadata, &values)?;
                    if renderable {
                        valid_rows = valid_rows.checked_add(1).ok_or_else(|| {
                            AppError::InvalidParam("graph valid row count overflow".into())
                        })?;
                    }
                    processed_rows = processed_rows.checked_add(1).ok_or_else(|| {
                        AppError::InvalidParam("graph processed row count overflow".into())
                    })?;

                    if buffer_raw_points
                        && !raw_points_omitted
                        && valid_rows > request.raw_point_budget as u64
                    {
                        raw_points_omitted = true;
                        buffered_chunks.borrow_mut().clear();
                        *accumulator = ChunkAccumulator::new(metadata);
                    }
                    if raw_points_omitted {
                        return Ok(true);
                    }
                    if buffer_raw_points && !renderable {
                        return Ok(true);
                    }

                    accumulator.push_row(metadata, row_id, &values)?;

                    if accumulator.row_count() >= accumulator.rows_per_chunk {
                        let chunk = accumulator.finish_chunk(
                            metadata,
                            request,
                            chunk_index,
                            row_offset,
                            source_rows,
                            processed_rows,
                            false,
                        )?;
                        if buffer_raw_points {
                            buffered_chunks.borrow_mut().push(chunk);
                        } else {
                            if let Err(error) = self.send_chunk(sink, chunk) {
                                if self.is_cancelled(&request.request_id, run.nonce)? {
                                    cancelled = true;
                                    return Ok(false);
                                }
                                return Err(error);
                            }
                            chunks_sent = chunks_sent.saturating_add(1);
                        }
                        chunk_index = chunk_index.saturating_add(1);
                        row_offset = processed_rows;
                    }
                    if let Some(encode_started) = encode_started {
                        record_encode(encode_started);
                    }
                    Ok(true)
                },
            )?;

            if projection_callbacks != 1 {
                return Err(AppError::Database(
                    "graph projection callback was not invoked exactly once".to_string(),
                ));
            }

            source_rows = stats.source_rows;
            if !cancelled && !raw_points_omitted && (!buffer_raw_points || valid_rows > 0) {
                let metadata_ref = metadata.borrow();
                let metadata = metadata_ref.as_ref().ok_or_else(|| {
                    AppError::Database("graph projection metadata not initialized".to_string())
                })?;
                let mut accumulator_ref = accumulator.borrow_mut();
                let accumulator = accumulator_ref.as_mut().ok_or_else(|| {
                    AppError::Database("graph chunk accumulator not initialized".to_string())
                })?;

                let chunk = accumulator.finish_chunk(
                    metadata,
                    request,
                    chunk_index,
                    row_offset,
                    source_rows,
                    processed_rows,
                    true,
                )?;
                let encode_started = if observed {
                    Some(begin_timing_observation())
                } else {
                    None
                };
                if buffer_raw_points {
                    buffered_chunks.borrow_mut().push(chunk);
                    for chunk in buffered_chunks.borrow_mut().drain(..) {
                        self.send_chunk(sink, chunk)?;
                        chunks_sent = chunks_sent.saturating_add(1);
                    }
                } else if let Err(error) = self.send_chunk(sink, chunk) {
                    if self.is_cancelled(&request.request_id, run.nonce)? {
                        cancelled = true;
                    } else {
                        return Err(error);
                    }
                } else {
                    chunks_sent = chunks_sent.saturating_add(1);
                }
                if let Some(encode_started) = encode_started {
                    record_encode(encode_started);
                }
            }

            if !cancelled {
                for packet in &aggregate_packets {
                    let encode_started = if observed {
                        Some(begin_timing_observation())
                    } else {
                        None
                    };
                    sink.send_aggregate(packet)
                        .map_err(Self::map_sink_error_to_app_error)?;
                    if let Some(encode_started) = encode_started {
                        record_encode(encode_started);
                    }
                }
            }

            let completion = GraphDataCompletion {
                request_id: request.request_id.clone(),
                dataset_id: request.dataset_id.clone(),
                generation: request.generation,
                source_rows,
                processed_rows,
                chunks_sent,
                cancelled,
                raw_point_disposition: if buffer_raw_points && raw_points_omitted {
                    GraphRawPointDisposition::Omitted {
                        reason: GraphRawPointOmissionReason::PointBudgetExceeded,
                        valid_rows,
                        budget: request.raw_point_budget,
                    }
                } else if buffer_raw_points && valid_rows == 0 {
                    GraphRawPointDisposition::Empty {
                        valid_rows: 0,
                        budget: request.raw_point_budget,
                    }
                } else {
                    GraphRawPointDisposition::Included {
                        valid_rows,
                        budget: request.raw_point_budget,
                    }
                },
            };

            let encode_started = if observed {
                Some(begin_timing_observation())
            } else {
                None
            };
            sink.send_terminal(&completion)
                .map_err(Self::map_sink_error_to_app_error)?;
            if let Some(encode_started) = encode_started {
                record_encode(encode_started);
            }

            Ok(completion)
        })();

        let observed_cancelled = matches!(&result, Ok(completion) if completion.cancelled);
        self.finish_request_run(&request.request_id, run.nonce, observed_cancelled)?;
        if let Some(value) = metrics {
            value.encode_ms = encode_ms_cell.get();
            value.projection_passes = projection_passes_cell.get();
        }
        result
    }

    fn emit_aggregate_cancelled_terminal<S: GraphChunkSink>(
        &self,
        request: &GraphDataRequest,
        sink: &mut S,
    ) -> Result<GraphDataCompletion, AppError> {
        let completion = GraphDataCompletion {
            request_id: request.request_id.clone(),
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            source_rows: 0,
            processed_rows: 0,
            chunks_sent: 0,
            cancelled: true,
            raw_point_disposition: GraphRawPointDisposition::Empty {
                valid_rows: 0,
                budget: request.raw_point_budget,
            },
        };
        sink.send_terminal(&completion)
            .map_err(Self::map_sink_error_to_app_error)?;
        Ok(completion)
    }

    #[cfg(test)]
    fn emit_aggregate_cancelled_terminal_for_test<S: GraphChunkSink>(
        &self,
        request: &GraphDataRequest,
        sink: &mut S,
    ) -> Result<GraphDataCompletion, AppError> {
        self.emit_aggregate_cancelled_terminal(request, sink)
    }

    fn send_chunk<S: GraphChunkSink>(
        &self,
        sink: &mut S,
        chunk: GraphDataChunk,
    ) -> Result<(), AppError> {
        sink.send_header(&chunk.header)
            .map_err(Self::map_sink_error_to_app_error)?;
        sink.send_payload(chunk.payload)
            .map_err(Self::map_sink_error_to_app_error)?;
        Ok(())
    }

    fn map_sink_error_to_app_error(error: GraphSinkError) -> AppError {
        match error {
            GraphSinkError::Closed => {
                AppError::InvalidParam("graph data channel closed".to_string())
            }
            GraphSinkError::Invalid(message) => AppError::InvalidParam(message),
        }
    }

    fn begin_request_run(&self, request_id: &str) -> Result<RequestRun, AppError> {
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let entry = cancelled
            .entry(request_id.to_string())
            .or_insert(CancellationEntry {
                cancelled: false,
                nonce: 0,
            });
        entry.nonce = entry.nonce.saturating_add(1);
        let pre_cancelled = entry.cancelled;
        if pre_cancelled {
            entry.cancelled = false;
        }
        Ok(RequestRun {
            nonce: entry.nonce,
            pre_cancelled,
        })
    }

    fn is_cancelled(&self, request_id: &str, run_nonce: u64) -> Result<bool, AppError> {
        let cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(entry) = cancelled.get(request_id) else {
            return Ok(false);
        };
        Ok(entry.cancelled && entry.nonce > run_nonce)
    }

    fn finish_request_run(
        &self,
        request_id: &str,
        run_nonce: u64,
        observed_cancelled: bool,
    ) -> Result<(), AppError> {
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let remove_entry = if let Some(entry) = cancelled.get(request_id) {
            if entry.nonce == run_nonce {
                true
            } else {
                observed_cancelled && entry.cancelled && entry.nonce == run_nonce.saturating_add(1)
            }
        } else {
            false
        };
        if remove_entry {
            cancelled.remove(request_id);
        }
        Ok(())
    }
}

fn request_is_aggregate_only(
    request: &GraphDataRequest,
    aggregate_packets: &[GraphAggregatePacket],
) -> bool {
    if request.elements.is_empty() {
        return false;
    }

    let correlation_only = request
        .elements
        .iter()
        .all(|element| element.kind.eq_ignore_ascii_case("correlationMatrix"))
        && aggregate_packets
            .iter()
            .all(|packet| matches!(packet, GraphAggregatePacket::CorrelationMatrix(_)));
    let normal_curve_only = request
        .elements
        .iter()
        .all(|element| element.kind.eq_ignore_ascii_case("normalCurve"))
        && aggregate_packets
            .iter()
            .all(|packet| matches!(packet, GraphAggregatePacket::Summary(_)));

    !aggregate_packets.is_empty() && (correlation_only || normal_curve_only)
}

fn is_renderable_xy(metadata: &ProjectionMetadata, values: &[Value]) -> Result<bool, AppError> {
    let x = values
        .get(metadata.x_index)
        .ok_or_else(|| AppError::Database("x value missing from graph projection".to_string()))?;
    let x_valid = match metadata.x_payload_type {
        GraphPayloadType::F64 => value_to_f64(x).is_some(),
        GraphPayloadType::U32 => value_to_category(x).is_some(),
        _ => false,
    };
    let y = values
        .get(metadata.y_index)
        .ok_or_else(|| AppError::Database("y value missing from graph projection".to_string()))?;
    Ok(x_valid && value_to_f64(y).is_some())
}

struct ProjectionMetadata {
    projected_columns: Vec<String>,
    include_row_id: bool,
    x_index: usize,
    y_index: usize,
    z_index: Option<usize>,
    source_index: Option<usize>,
    group_x_index: Option<usize>,
    group_y_index: Option<usize>,
    group_z_index: Option<usize>,
    wrap_index: Option<usize>,
    group_index: Option<usize>,
    size_index: Option<usize>,
    x_payload_type: GraphPayloadType,
    x_encoding: GraphAxisEncoding,
}

impl ProjectionMetadata {
    fn new(
        request: &GraphDataRequest,
        include_row_id: bool,
        stats: &GraphProjectionStats,
    ) -> Result<Self, AppError> {
        let mut role_columns: HashMap<String, String> = HashMap::new();
        for field in &request.fields {
            role_columns
                .entry(field.role.to_ascii_lowercase())
                .or_insert_with(|| field.column.clone());
        }

        let x_column = role_columns.get("x");
        let y_column = role_columns.get("y");

        let has_backend_projection_aliases = stats
            .projected_columns
            .iter()
            .any(|column| column == "__sp_x")
            && stats
                .projected_columns
                .iter()
                .any(|column| column == "__sp_y");
        let has_melt_value_alias = stats
            .projected_columns
            .iter()
            .any(|column| column == "__sp_value__");

        let resolved_x_column = if has_backend_projection_aliases {
            "__sp_x"
        } else if let Some(column) = x_column {
            column.as_str()
        } else if stats
            .projected_columns
            .iter()
            .any(|column| column == "__sp_x")
        {
            "__sp_x"
        } else {
            stats
                .projected_columns
                .first()
                .map(String::as_str)
                .ok_or_else(|| {
                    AppError::InvalidParam("graph request has no projected x column".to_string())
                })?
        };
        let resolved_y_column = if has_backend_projection_aliases {
            "__sp_y"
        } else if has_melt_value_alias {
            "__sp_value__"
        } else if let Some(column) = y_column {
            column
        } else {
            return Err(AppError::InvalidParam(
                "graph request is missing role y".to_string(),
            ));
        };

        let x_index = stats
            .projected_columns
            .iter()
            .position(|column| column == resolved_x_column)
            .ok_or_else(|| AppError::InvalidParam("unknown graph column for role x".to_string()))?;
        let y_index = stats
            .projected_columns
            .iter()
            .position(|column| column == resolved_y_column)
            .ok_or_else(|| AppError::InvalidParam("unknown graph column for role y".to_string()))?;

        let resolve_role_index = |role: &str, alias: &str| {
            if has_backend_projection_aliases {
                stats
                    .projected_columns
                    .iter()
                    .position(|name| name == alias)
            } else {
                role_columns.get(role).and_then(|column| {
                    stats
                        .projected_columns
                        .iter()
                        .position(|name| name == column)
                })
            }
        };

        let group_index = if has_backend_projection_aliases {
            stats
                .projected_columns
                .iter()
                .position(|name| name == "__sp_group")
        } else {
            role_columns.get("group").and_then(|column| {
                stats
                    .projected_columns
                    .iter()
                    .position(|name| name == column)
            })
        };
        let size_index = if has_backend_projection_aliases {
            stats
                .projected_columns
                .iter()
                .position(|name| name == "__sp_size")
        } else {
            role_columns.get("size").and_then(|column| {
                stats
                    .projected_columns
                    .iter()
                    .position(|name| name == column)
            })
        };
        let z_index = resolve_role_index("z", "__sp_z");
        let group_x_index = resolve_role_index("groupx", "__sp_groupx");
        let group_y_index = resolve_role_index("groupy", "__sp_groupy");
        let group_z_index = resolve_role_index("groupz", "__sp_groupz");
        let wrap_index = resolve_role_index("wrap", "__sp_wrap");
        let source_index = stats
            .projected_columns
            .iter()
            .position(|name| name == GRAPH_VIRTUAL_SOURCE_COLUMN);

        let x_type = stats
            .projected_column_types
            .get(x_index)
            .ok_or_else(|| AppError::InvalidParam("x column type missing".to_string()))?;
        let (x_payload_type, x_encoding) = if is_numeric_type(x_type) {
            (GraphPayloadType::F64, GraphAxisEncoding::Numeric)
        } else {
            (GraphPayloadType::U32, GraphAxisEncoding::Categorical)
        };

        let mut projected_columns = Vec::new();
        if include_row_id {
            projected_columns.push("_row_id".to_string());
        }
        projected_columns.extend(stats.projected_columns.iter().cloned());

        Ok(Self {
            projected_columns,
            include_row_id,
            x_index,
            y_index,
            z_index,
            source_index,
            group_x_index,
            group_y_index,
            group_z_index,
            wrap_index,
            group_index,
            size_index,
            x_payload_type,
            x_encoding,
        })
    }

    fn rows_per_chunk(&self) -> usize {
        let mut row_width = self.x_payload_type.byte_width() + GraphPayloadType::F64.byte_width();
        if self.include_row_id {
            row_width += GraphPayloadType::I64.byte_width();
        }
        if self.group_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.size_index.is_some() {
            row_width += GraphPayloadType::F64.byte_width();
        }
        if self.z_index.is_some() {
            row_width += GraphPayloadType::F64.byte_width();
        }
        if self.source_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.group_x_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.group_y_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.group_z_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.wrap_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        row_width += 2;
        if self.group_index.is_some() {
            row_width += 1;
        }
        if self.size_index.is_some() {
            row_width += 1;
        }
        if self.z_index.is_some() {
            row_width += 1;
        }
        if self.source_index.is_some() {
            row_width += 1;
        }
        if self.group_x_index.is_some() {
            row_width += 1;
        }
        if self.group_y_index.is_some() {
            row_width += 1;
        }
        if self.group_z_index.is_some() {
            row_width += 1;
        }
        if self.wrap_index.is_some() {
            row_width += 1;
        }
        // Reserve fixed headroom for per-slice alignment padding so payload stays under budget.
        let payload_budget = INITIAL_PAYLOAD_BUDGET_BYTES.saturating_sub(64);
        std::cmp::max(1, payload_budget / row_width)
    }
}

struct ChunkAccumulator {
    rows_per_chunk: usize,
    x_numeric_values: Vec<f64>,
    x_categorical_values: Vec<u32>,
    y_values: Vec<f64>,
    row_ids: Vec<i64>,
    z_values: Vec<f64>,
    group_codes: Vec<u32>,
    size_values: Vec<f64>,
    source_codes: Vec<u32>,
    facet_x_codes: Vec<u32>,
    facet_y_codes: Vec<u32>,
    facet_z_codes: Vec<u32>,
    wrap_codes: Vec<u32>,
    x_validity: Vec<u8>,
    y_validity: Vec<u8>,
    z_validity: Vec<u8>,
    group_validity: Vec<u8>,
    size_validity: Vec<u8>,
    source_validity: Vec<u8>,
    facet_x_validity: Vec<u8>,
    facet_y_validity: Vec<u8>,
    facet_z_validity: Vec<u8>,
    wrap_validity: Vec<u8>,
    x_dictionary: Vec<String>,
    x_dictionary_index: HashMap<String, u32>,
    group_dictionary: Vec<String>,
    group_dictionary_index: HashMap<String, u32>,
    source_dictionary: Vec<String>,
    source_dictionary_index: HashMap<String, u32>,
    facet_x_dictionary: Vec<String>,
    facet_x_dictionary_index: HashMap<String, u32>,
    facet_y_dictionary: Vec<String>,
    facet_y_dictionary_index: HashMap<String, u32>,
    facet_z_dictionary: Vec<String>,
    facet_z_dictionary_index: HashMap<String, u32>,
    wrap_dictionary: Vec<String>,
    wrap_dictionary_index: HashMap<String, u32>,
}

impl ChunkAccumulator {
    fn new(metadata: &ProjectionMetadata) -> Self {
        let rows_per_chunk = metadata.rows_per_chunk();
        Self {
            rows_per_chunk,
            x_numeric_values: Vec::with_capacity(rows_per_chunk),
            x_categorical_values: Vec::with_capacity(rows_per_chunk),
            y_values: Vec::with_capacity(rows_per_chunk),
            row_ids: Vec::with_capacity(rows_per_chunk),
            z_values: Vec::with_capacity(rows_per_chunk),
            group_codes: Vec::with_capacity(rows_per_chunk),
            size_values: Vec::with_capacity(rows_per_chunk),
            source_codes: Vec::with_capacity(rows_per_chunk),
            facet_x_codes: Vec::with_capacity(rows_per_chunk),
            facet_y_codes: Vec::with_capacity(rows_per_chunk),
            facet_z_codes: Vec::with_capacity(rows_per_chunk),
            wrap_codes: Vec::with_capacity(rows_per_chunk),
            x_validity: Vec::with_capacity(rows_per_chunk),
            y_validity: Vec::with_capacity(rows_per_chunk),
            z_validity: Vec::with_capacity(rows_per_chunk),
            group_validity: Vec::with_capacity(rows_per_chunk),
            size_validity: Vec::with_capacity(rows_per_chunk),
            source_validity: Vec::with_capacity(rows_per_chunk),
            facet_x_validity: Vec::with_capacity(rows_per_chunk),
            facet_y_validity: Vec::with_capacity(rows_per_chunk),
            facet_z_validity: Vec::with_capacity(rows_per_chunk),
            wrap_validity: Vec::with_capacity(rows_per_chunk),
            x_dictionary: Vec::new(),
            x_dictionary_index: HashMap::new(),
            group_dictionary: Vec::new(),
            group_dictionary_index: HashMap::new(),
            source_dictionary: Vec::new(),
            source_dictionary_index: HashMap::new(),
            facet_x_dictionary: Vec::new(),
            facet_x_dictionary_index: HashMap::new(),
            facet_y_dictionary: Vec::new(),
            facet_y_dictionary_index: HashMap::new(),
            facet_z_dictionary: Vec::new(),
            facet_z_dictionary_index: HashMap::new(),
            wrap_dictionary: Vec::new(),
            wrap_dictionary_index: HashMap::new(),
        }
    }

    fn row_count(&self) -> usize {
        self.y_values.len()
    }

    fn push_row(
        &mut self,
        metadata: &ProjectionMetadata,
        row_id: Option<i64>,
        values: &[Value],
    ) -> Result<(), AppError> {
        let x = values.get(metadata.x_index).ok_or_else(|| {
            AppError::Database("x value missing from graph projection".to_string())
        })?;
        match metadata.x_payload_type {
            GraphPayloadType::F64 => {
                if let Some(value) = value_to_f64(x) {
                    self.x_numeric_values.push(value);
                    self.x_validity.push(1);
                } else {
                    self.x_numeric_values.push(0.0);
                    self.x_validity.push(0);
                }
            }
            GraphPayloadType::U32 => {
                if let Some(label) = value_to_category(x) {
                    let code =
                        upsert_code(&mut self.x_dictionary, &mut self.x_dictionary_index, &label)?;
                    self.x_categorical_values.push(code);
                    self.x_validity.push(1);
                } else {
                    self.x_categorical_values.push(0);
                    self.x_validity.push(0);
                }
            }
            _ => {
                return Err(AppError::Database(
                    "unsupported x payload type for graph chunk".to_string(),
                ));
            }
        }

        let y = values.get(metadata.y_index).ok_or_else(|| {
            AppError::Database("y value missing from graph projection".to_string())
        })?;
        if let Some(value) = value_to_f64(y) {
            self.y_values.push(value);
            self.y_validity.push(1);
        } else {
            self.y_values.push(0.0);
            self.y_validity.push(0);
        }

        if metadata.include_row_id {
            self.row_ids.push(row_id.ok_or_else(|| {
                AppError::Database("row id missing for point interaction".to_string())
            })?);
        }

        if let Some(group_index) = metadata.group_index {
            let group = values.get(group_index).ok_or_else(|| {
                AppError::Database("group value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(group) {
                let code = upsert_code(
                    &mut self.group_dictionary,
                    &mut self.group_dictionary_index,
                    &label,
                )?;
                self.group_codes.push(code);
                self.group_validity.push(1);
            } else {
                self.group_codes.push(0);
                self.group_validity.push(0);
            }
        }

        if let Some(size_index) = metadata.size_index {
            let size = values.get(size_index).ok_or_else(|| {
                AppError::Database("size value missing from graph projection".to_string())
            })?;
            if let Some(value) = value_to_f64(size) {
                self.size_values.push(value);
                self.size_validity.push(1);
            } else {
                self.size_values.push(0.0);
                self.size_validity.push(0);
            }
        }

        if let Some(z_index) = metadata.z_index {
            let z = values.get(z_index).ok_or_else(|| {
                AppError::Database("z value missing from graph projection".to_string())
            })?;
            if let Some(value) = value_to_f64(z) {
                self.z_values.push(value);
                self.z_validity.push(1);
            } else {
                self.z_values.push(0.0);
                self.z_validity.push(0);
            }
        }

        if let Some(source_index) = metadata.source_index {
            let source = values.get(source_index).ok_or_else(|| {
                AppError::Database("source value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(source) {
                let code = upsert_code(
                    &mut self.source_dictionary,
                    &mut self.source_dictionary_index,
                    &label,
                )?;
                self.source_codes.push(code);
                self.source_validity.push(1);
            } else {
                self.source_codes.push(0);
                self.source_validity.push(0);
            }
        }

        if let Some(group_x_index) = metadata.group_x_index {
            let group_x = values.get(group_x_index).ok_or_else(|| {
                AppError::Database("groupX value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(group_x) {
                let code = upsert_code(
                    &mut self.facet_x_dictionary,
                    &mut self.facet_x_dictionary_index,
                    &label,
                )?;
                self.facet_x_codes.push(code);
                self.facet_x_validity.push(1);
            } else {
                self.facet_x_codes.push(0);
                self.facet_x_validity.push(0);
            }
        }

        if let Some(group_y_index) = metadata.group_y_index {
            let group_y = values.get(group_y_index).ok_or_else(|| {
                AppError::Database("groupY value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(group_y) {
                let code = upsert_code(
                    &mut self.facet_y_dictionary,
                    &mut self.facet_y_dictionary_index,
                    &label,
                )?;
                self.facet_y_codes.push(code);
                self.facet_y_validity.push(1);
            } else {
                self.facet_y_codes.push(0);
                self.facet_y_validity.push(0);
            }
        }

        if let Some(group_z_index) = metadata.group_z_index {
            let group_z = values.get(group_z_index).ok_or_else(|| {
                AppError::Database("groupZ value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(group_z) {
                let code = upsert_code(
                    &mut self.facet_z_dictionary,
                    &mut self.facet_z_dictionary_index,
                    &label,
                )?;
                self.facet_z_codes.push(code);
                self.facet_z_validity.push(1);
            } else {
                self.facet_z_codes.push(0);
                self.facet_z_validity.push(0);
            }
        }

        if let Some(wrap_index) = metadata.wrap_index {
            let wrap = values.get(wrap_index).ok_or_else(|| {
                AppError::Database("wrap value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(wrap) {
                let code = upsert_code(
                    &mut self.wrap_dictionary,
                    &mut self.wrap_dictionary_index,
                    &label,
                )?;
                self.wrap_codes.push(code);
                self.wrap_validity.push(1);
            } else {
                self.wrap_codes.push(0);
                self.wrap_validity.push(0);
            }
        }

        Ok(())
    }

    fn finish_chunk(
        &mut self,
        metadata: &ProjectionMetadata,
        request: &GraphDataRequest,
        chunk_index: u32,
        row_offset: u64,
        source_rows: u64,
        processed_rows: u64,
        final_chunk: bool,
    ) -> Result<GraphDataChunk, AppError> {
        let row_count = self.row_count();
        let mut payload = Vec::new();

        let x_values = match metadata.x_payload_type {
            GraphPayloadType::F64 => {
                descriptor_from_f64(&mut payload, &self.x_numeric_values, GraphPayloadType::F64)
            }
            GraphPayloadType::U32 => descriptor_from_u32(
                &mut payload,
                &self.x_categorical_values,
                GraphPayloadType::U32,
            ),
            _ => {
                return Err(AppError::Database(
                    "unsupported x payload type while encoding graph chunk".to_string(),
                ));
            }
        };

        let y_values = descriptor_from_f64(&mut payload, &self.y_values, GraphPayloadType::F64);
        let row_ids = if metadata.include_row_id {
            descriptor_from_i64(&mut payload, &self.row_ids, GraphPayloadType::I64)
        } else {
            GraphTypedSliceDescriptor::new(GraphPayloadType::I64, payload.len(), 0)
        };

        let group_codes = if metadata.group_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.group_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let z_values = if metadata.z_index.is_some() {
            Some(descriptor_from_f64(
                &mut payload,
                &self.z_values,
                GraphPayloadType::F64,
            ))
        } else {
            None
        };

        let size_values = if metadata.size_index.is_some() {
            Some(descriptor_from_f64(
                &mut payload,
                &self.size_values,
                GraphPayloadType::F64,
            ))
        } else {
            None
        };

        let source_codes = if metadata.source_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.source_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let facet_x_codes = if metadata.group_x_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.facet_x_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let facet_y_codes = if metadata.group_y_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.facet_y_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let facet_z_codes = if metadata.group_z_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.facet_z_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let wrap_codes = if metadata.wrap_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.wrap_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let x_validity_bitmap = pack_validity_bitmap(&self.x_validity);
        let y_validity_bitmap = pack_validity_bitmap(&self.y_validity);
        let z_validity_bitmap = pack_validity_bitmap(&self.z_validity);
        let group_validity_bitmap = pack_validity_bitmap(&self.group_validity);
        let size_validity_bitmap = pack_validity_bitmap(&self.size_validity);
        let source_validity_bitmap = pack_validity_bitmap(&self.source_validity);
        let facet_x_validity_bitmap = pack_validity_bitmap(&self.facet_x_validity);
        let facet_y_validity_bitmap = pack_validity_bitmap(&self.facet_y_validity);
        let facet_z_validity_bitmap = pack_validity_bitmap(&self.facet_z_validity);
        let wrap_validity_bitmap = pack_validity_bitmap(&self.wrap_validity);

        let mut validity_ranges = BTreeMap::new();
        validity_ranges.insert(
            "x".to_string(),
            descriptor_from_u8(&mut payload, &x_validity_bitmap, GraphPayloadType::U8),
        );
        validity_ranges.insert(
            "y".to_string(),
            descriptor_from_u8(&mut payload, &y_validity_bitmap, GraphPayloadType::U8),
        );
        if metadata.group_index.is_some() {
            validity_ranges.insert(
                "group".to_string(),
                descriptor_from_u8(&mut payload, &group_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.size_index.is_some() {
            validity_ranges.insert(
                "size".to_string(),
                descriptor_from_u8(&mut payload, &size_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.z_index.is_some() {
            validity_ranges.insert(
                "z".to_string(),
                descriptor_from_u8(&mut payload, &z_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.source_index.is_some() {
            validity_ranges.insert(
                "source".to_string(),
                descriptor_from_u8(&mut payload, &source_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.group_x_index.is_some() {
            validity_ranges.insert(
                "facetX".to_string(),
                descriptor_from_u8(&mut payload, &facet_x_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.group_y_index.is_some() {
            validity_ranges.insert(
                "facetY".to_string(),
                descriptor_from_u8(&mut payload, &facet_y_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.group_z_index.is_some() {
            validity_ranges.insert(
                "facetZ".to_string(),
                descriptor_from_u8(&mut payload, &facet_z_validity_bitmap, GraphPayloadType::U8),
            );
        }
        if metadata.wrap_index.is_some() {
            validity_ranges.insert(
                "wrap".to_string(),
                descriptor_from_u8(&mut payload, &wrap_validity_bitmap, GraphPayloadType::U8),
            );
        }

        let mut dictionaries = BTreeMap::new();
        if metadata.x_payload_type == GraphPayloadType::U32 {
            dictionaries.insert("x".to_string(), self.x_dictionary.clone());
        }
        if metadata.group_index.is_some() {
            dictionaries.insert("group".to_string(), self.group_dictionary.clone());
        }
        if metadata.source_index.is_some() {
            dictionaries.insert("source".to_string(), self.source_dictionary.clone());
        }
        if metadata.group_x_index.is_some() {
            dictionaries.insert("facetX".to_string(), self.facet_x_dictionary.clone());
        }
        if metadata.group_y_index.is_some() {
            dictionaries.insert("facetY".to_string(), self.facet_y_dictionary.clone());
        }
        if metadata.group_z_index.is_some() {
            dictionaries.insert("facetZ".to_string(), self.facet_z_dictionary.clone());
        }
        if metadata.wrap_index.is_some() {
            dictionaries.insert("wrap".to_string(), self.wrap_dictionary.clone());
        }

        let mut role_vectors = BTreeMap::new();
        if let Some(descriptor) = &z_values {
            role_vectors.insert("z".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &group_codes {
            role_vectors.insert("group".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &size_values {
            role_vectors.insert("size".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &source_codes {
            role_vectors.insert("source".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &facet_x_codes {
            role_vectors.insert("groupX".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &facet_y_codes {
            role_vectors.insert("groupY".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &facet_z_codes {
            role_vectors.insert("groupZ".to_string(), descriptor.clone());
        }
        if let Some(descriptor) = &wrap_codes {
            role_vectors.insert("wrap".to_string(), descriptor.clone());
        }

        let header = GraphChunkHeader {
            request_id: request.request_id.clone(),
            generation: request.generation,
            chunk_index,
            row_offset,
            row_count,
            source_rows,
            processed_rows,
            projected_columns: metadata.projected_columns.clone(),
            dictionaries,
            validity_ranges,
            x_values,
            y_values,
            row_ids,
            z_values,
            group_codes,
            size_values,
            source_codes,
            facet_x_codes,
            facet_y_codes,
            facet_z_codes,
            wrap_codes,
            role_vectors,
            x_encoding: metadata.x_encoding.clone(),
            final_chunk,
        };
        header
            .validate_layout(payload.len())
            .map_err(AppError::InvalidParam)?;

        self.reset_for_next_chunk();
        Ok(GraphDataChunk { header, payload })
    }

    fn reset_for_next_chunk(&mut self) {
        self.x_numeric_values.clear();
        self.x_categorical_values.clear();
        self.y_values.clear();
        self.row_ids.clear();
        self.z_values.clear();
        self.group_codes.clear();
        self.size_values.clear();
        self.source_codes.clear();
        self.facet_x_codes.clear();
        self.facet_y_codes.clear();
        self.facet_z_codes.clear();
        self.wrap_codes.clear();
        self.x_validity.clear();
        self.y_validity.clear();
        self.z_validity.clear();
        self.group_validity.clear();
        self.size_validity.clear();
        self.source_validity.clear();
        self.facet_x_validity.clear();
        self.facet_y_validity.clear();
        self.facet_z_validity.clear();
        self.wrap_validity.clear();
        self.x_dictionary.clear();
        self.x_dictionary_index.clear();
        self.group_dictionary.clear();
        self.group_dictionary_index.clear();
        self.source_dictionary.clear();
        self.source_dictionary_index.clear();
        self.facet_x_dictionary.clear();
        self.facet_x_dictionary_index.clear();
        self.facet_y_dictionary.clear();
        self.facet_y_dictionary_index.clear();
        self.facet_z_dictionary.clear();
        self.facet_z_dictionary_index.clear();
        self.wrap_dictionary.clear();
        self.wrap_dictionary_index.clear();
    }
}

fn upsert_code(
    dictionary: &mut Vec<String>,
    index: &mut HashMap<String, u32>,
    value: &str,
) -> Result<u32, AppError> {
    if let Some(existing) = index.get(value) {
        return Ok(*existing);
    }
    let code = u32::try_from(dictionary.len()).map_err(|_| {
        AppError::InvalidParam("too many categorical values for graph payload".to_string())
    })?;
    dictionary.push(value.to_string());
    index.insert(value.to_string(), code);
    Ok(code)
}

fn pack_validity_bitmap(flags: &[u8]) -> Vec<u8> {
    if flags.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0u8; flags.len().div_ceil(8)];
    for (row_index, flag) in flags.iter().enumerate() {
        if *flag == 0 {
            continue;
        }
        out[row_index >> 3] |= 1u8 << (row_index & 7);
    }
    out
}

fn is_numeric_type(column_type: &str) -> bool {
    let normalized = column_type.to_ascii_uppercase();
    normalized.contains("INT")
        || normalized.contains("DECIMAL")
        || normalized.contains("NUMERIC")
        || normalized.contains("DOUBLE")
        || normalized.contains("FLOAT")
        || normalized.contains("REAL")
}

fn value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::TinyInt(value) => Some(*value as f64),
        Value::SmallInt(value) => Some(*value as f64),
        Value::Int(value) => Some(*value as f64),
        Value::BigInt(value) => Some(*value as f64),
        Value::UTinyInt(value) => Some(*value as f64),
        Value::USmallInt(value) => Some(*value as f64),
        Value::UInt(value) => Some(*value as f64),
        Value::UBigInt(value) => Some(*value as f64),
        Value::Float(value) => Some(*value as f64),
        Value::Double(value) => Some(*value),
        Value::Text(value) => value.parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_category(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Text(value) => Some(value.clone()),
        Value::Boolean(value) => Some(value.to_string()),
        Value::TinyInt(value) => Some(value.to_string()),
        Value::SmallInt(value) => Some(value.to_string()),
        Value::Int(value) => Some(value.to_string()),
        Value::BigInt(value) => Some(value.to_string()),
        Value::UTinyInt(value) => Some(value.to_string()),
        Value::USmallInt(value) => Some(value.to_string()),
        Value::UInt(value) => Some(value.to_string()),
        Value::UBigInt(value) => Some(value.to_string()),
        Value::Float(value) => Some(value.to_string()),
        Value::Double(value) => Some(value.to_string()),
        _ => Some(format!("{value:?}")),
    }
}

fn pad_to_eight(payload: &mut Vec<u8>) {
    let aligned = (payload.len() + 7) & !7;
    if aligned > payload.len() {
        payload.resize(aligned, 0);
    }
}

fn descriptor_from_f64(
    payload: &mut Vec<u8>,
    values: &[f64],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 8)
}

fn descriptor_from_i64(
    payload: &mut Vec<u8>,
    values: &[i64],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 8)
}

fn descriptor_from_u32(
    payload: &mut Vec<u8>,
    values: &[u32],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 4)
}

fn descriptor_from_u8(
    payload: &mut Vec<u8>,
    values: &[u8],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    payload.extend_from_slice(values);
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    use duckdb::params;

    use crate::models::graph_data::{
        GraphDataRequest, GraphElementRequest, GraphFieldBinding, GraphSampling, GraphViewport,
    };
    use crate::models::table::{TableWindowFilter, TableWindowFilterRule};
    use crate::state::AppState;

    mod aggregate {
        use super::*;
        use crate::models::graph_data::{CorrelationMethod, GraphAggregatePacket};

        fn faceted_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
            GraphDataRequest {
                request_id: format!("request-{dataset_id}-facet"),
                dataset_id: dataset_id.to_string(),
                generation,
                fields: vec![
                    GraphFieldBinding {
                        role: "x".to_string(),
                        column: "region".to_string(),
                    },
                    GraphFieldBinding {
                        role: "y".to_string(),
                        column: "m1".to_string(),
                    },
                    GraphFieldBinding {
                        role: "z".to_string(),
                        column: "zv".to_string(),
                    },
                    GraphFieldBinding {
                        role: "group".to_string(),
                        column: "segment".to_string(),
                    },
                    GraphFieldBinding {
                        role: "groupX".to_string(),
                        column: "facet_x".to_string(),
                    },
                    GraphFieldBinding {
                        role: "groupY".to_string(),
                        column: "facet_y".to_string(),
                    },
                    GraphFieldBinding {
                        role: "groupZ".to_string(),
                        column: "facet_z".to_string(),
                    },
                    GraphFieldBinding {
                        role: "wrap".to_string(),
                        column: "facet_wrap".to_string(),
                    },
                    GraphFieldBinding {
                        role: "multiY0".to_string(),
                        column: "m1".to_string(),
                    },
                    GraphFieldBinding {
                        role: "multiY1".to_string(),
                        column: "m2".to_string(),
                    },
                ],
                filters: vec![TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "batch".to_string(),
                        selected: vec!["B0".to_string(), "B1".to_string()],
                        exclude: false,
                    },
                }],
                elements: vec![
                    GraphElementRequest {
                        kind: "points".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "histogram".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "heatmap".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "boxplot".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "summary".to_string(),
                        summary_stat: "mean".to_string(),
                        correlation_method: None,
                    },
                ],
                sampling: GraphSampling::Full,
                raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
                viewport: GraphViewport {
                    width: 1400,
                    height: 900,
                },
            }
        }

        fn seed_faceted_dataset(state: &AppState, dataset_id: &str) {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                dataset_id,
                "Faceted Graph Dataset",
                &[
                    "region".into(),
                    "segment".into(),
                    "facet_x".into(),
                    "facet_y".into(),
                    "facet_z".into(),
                    "facet_wrap".into(),
                    "batch".into(),
                    "zv".into(),
                    "m1".into(),
                    "m2".into(),
                ],
                &[
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                    "DOUBLE".into(),
                    "DOUBLE".into(),
                    "DOUBLE".into(),
                ],
            )
            .expect("create table");
            let table = format!("dataset_{}", dataset_id.replace('-', "_"));
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO \"{table}\" (_row_id, region, segment, facet_x, facet_y, facet_z, facet_wrap, batch, zv, m1, m2) VALUES
                         (1, 'North', 'S1', 'L', 'Top', 'Front', 'W1', 'B0', 10.0, 1.0, 100.0),
                         (2, 'North', 'S1', 'R', 'Top', 'Front', 'W2', 'B1', 20.0, 2.0, 200.0),
                         (3, 'South', 'S2', 'L', 'Bottom', 'Back', 'W1', 'B0', 30.0, 3.0, 300.0),
                         (4, 'South', 'S2', 'R', 'Bottom', 'Back', 'W2', 'B1', 40.0, 4.0, 400.0)"
                    ),
                    [],
                )
                .expect("insert rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 4 WHERE id = $1",
                    params![dataset_id],
                )
                .expect("update row count");
        }

        fn aggregate_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
            let mut request = build_request(dataset_id, generation);
            request.elements = vec![
                GraphElementRequest {
                    kind: "histogram".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: None,
                },
                GraphElementRequest {
                    kind: "boxplot".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: None,
                },
                GraphElementRequest {
                    kind: "points".to_string(),
                    summary_stat: "mean".to_string(),
                    correlation_method: None,
                },
            ];
            request.fields = vec![
                GraphFieldBinding {
                    role: "x".to_string(),
                    column: "region".to_string(),
                },
                GraphFieldBinding {
                    role: "y".to_string(),
                    column: "cost".to_string(),
                },
                GraphFieldBinding {
                    role: "group".to_string(),
                    column: "region".to_string(),
                },
            ];
            request.filters = vec![TableWindowFilter {
                op: "AND".to_string(),
                rule: TableWindowFilterRule::Categorical {
                    field: "region".to_string(),
                    selected: vec!["North".to_string(), "South".to_string()],
                    exclude: false,
                },
            }];
            request
        }

        fn aggregate_melt_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
            GraphDataRequest {
                request_id: format!("request-{dataset_id}-melt"),
                dataset_id: dataset_id.to_string(),
                generation,
                fields: vec![
                    GraphFieldBinding {
                        role: "x".to_string(),
                        column: "region".to_string(),
                    },
                    GraphFieldBinding {
                        role: "y".to_string(),
                        column: "m1".to_string(),
                    },
                    GraphFieldBinding {
                        role: "group".to_string(),
                        column: "region".to_string(),
                    },
                    GraphFieldBinding {
                        role: "multiY0".to_string(),
                        column: "m1".to_string(),
                    },
                    GraphFieldBinding {
                        role: "multiY1".to_string(),
                        column: "m2".to_string(),
                    },
                    GraphFieldBinding {
                        role: "filter".to_string(),
                        column: "batch".to_string(),
                    },
                ],
                filters: vec![TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "batch".to_string(),
                        selected: vec!["B0".to_string(), "B1".to_string()],
                        exclude: false,
                    },
                }],
                elements: vec![
                    GraphElementRequest {
                        kind: "histogram".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "boxplot".to_string(),
                        summary_stat: "none".to_string(),
                        correlation_method: None,
                    },
                    GraphElementRequest {
                        kind: "summary".to_string(),
                        summary_stat: "median".to_string(),
                        correlation_method: None,
                    },
                ],
                sampling: GraphSampling::Full,
                raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
                viewport: GraphViewport {
                    width: 1280,
                    height: 720,
                },
            }
        }

        fn multi_x_axis_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
            let mut request = aggregate_melt_request(dataset_id, generation);
            request.fields = vec![
                GraphFieldBinding {
                    role: "multiX0".to_string(),
                    column: "m1".to_string(),
                },
                GraphFieldBinding {
                    role: "multiX1".to_string(),
                    column: "m2".to_string(),
                },
            ];
            request.filters.clear();
            request.elements = vec![
                GraphElementRequest {
                    kind: "points".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: None,
                },
                GraphElementRequest {
                    kind: "boxplot".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: None,
                },
            ];
            request
        }

        fn direct_filtered_rows(state: &AppState, dataset_id: &str) -> i64 {
            let db = state.db.lock().expect("db lock");
            let table = format!("dataset_{}", dataset_id.replace('-', "_"));
            let sql =
                format!("SELECT COUNT(*) FROM \"{table}\" WHERE region IN ('North', 'South')");
            db.conn()
                .query_row(&sql, [], |row| row.get(0))
                .expect("count")
        }

        fn assert_close(actual: f64, expected: f64, tol: f64, label: &str) {
            let delta = (actual - expected).abs();
            assert!(
                delta <= tol,
                "{label} mismatch: actual={actual}, expected={expected}, |delta|={delta}, tol={tol}"
            );
        }

        fn seed_correlation_dataset(state: &AppState, dataset_id: &str) {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                dataset_id,
                "Correlation Matrix Dataset",
                &[
                    "a".into(),
                    "b".into(),
                    "c".into(),
                    "label".into(),
                    "batch".into(),
                ],
                &[
                    "DOUBLE".into(),
                    "DOUBLE".into(),
                    "DOUBLE".into(),
                    "VARCHAR".into(),
                    "VARCHAR".into(),
                ],
            )
            .expect("create correlation table");
            let table = format!("dataset_{}", dataset_id.replace('-', "_"));
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO \"{table}\" (_row_id, a, b, c, label, batch) VALUES
                         (1, 1.0, 2.0, 3.0, 'x', 'B0'),
                         (2, 2.0, 4.0, 2.0, 'y', 'B0'),
                         (3, 3.0, 6.0, 1.0, 'z', 'B1'),
                         (4, 4.0, 8.0, NULL, 'w', 'B1'),
                         (5, 5.0, 10.0, 5.0, 'v', 'B2'),
                         (6, 6.0, 'Infinity'::DOUBLE, 7.0, 'u', 'B2')"
                    ),
                    [],
                )
                .expect("insert correlation rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 6 WHERE id = $1",
                    params![dataset_id],
                )
                .expect("update correlation row count");
        }

        fn correlation_request(
            dataset_id: &str,
            generation: u64,
            method: Option<CorrelationMethod>,
            count: usize,
        ) -> GraphDataRequest {
            let mut fields = Vec::new();
            for index in 0..count {
                let column = match index {
                    0 => "a",
                    1 => "b",
                    2 => "c",
                    _ => "a",
                };
                fields.push(GraphFieldBinding {
                    role: format!("multiX{index}"),
                    column: column.to_string(),
                });
            }
            GraphDataRequest {
                request_id: format!("request-{dataset_id}-correlation"),
                dataset_id: dataset_id.to_string(),
                generation,
                fields,
                filters: Vec::new(),
                elements: vec![GraphElementRequest {
                    kind: "correlationMatrix".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: method,
                }],
                sampling: GraphSampling::Full,
                raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
                viewport: GraphViewport {
                    width: 1200,
                    height: 700,
                },
            }
        }

        #[test]
        fn correlation_matrix_packet_has_expected_shape_and_symmetry() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-correlation-matrix";
            seed_correlation_dataset(&state, dataset_id);

            let service = GraphDataService::new(&state);
            let mut request =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Pearson), 3);
            request.filters = vec![TableWindowFilter {
                op: "AND".to_string(),
                rule: TableWindowFilterRule::Categorical {
                    field: "batch".to_string(),
                    selected: vec!["B0".to_string(), "B1".to_string(), "B2".to_string()],
                    exclude: false,
                },
            }];

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("correlation aggregate packets");

            assert_eq!(packets.len(), 1);
            let packet = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::CorrelationMatrix(value) => Some(value),
                    _ => None,
                })
                .expect("correlation matrix packet");

            assert_eq!(packet.columns, vec!["a", "b", "c"]);
            assert_eq!(packet.cells.len(), 9);
            assert_eq!((packet.cells[0].x_index, packet.cells[0].y_index), (0, 0));
            assert_eq!((packet.cells[8].x_index, packet.cells[8].y_index), (2, 2));
            assert_eq!(packet.cells[1].coefficient, packet.cells[3].coefficient);
            assert_eq!(packet.cells[1].sample_count, packet.cells[3].sample_count);
        }

        #[test]
        fn correlation_matrix_rejects_invalid_binding_shapes_and_methods() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-correlation-invalid";
            seed_correlation_dataset(&state, dataset_id);

            let service = GraphDataService::new(&state);

            let one_column =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Spearman), 1);
            assert!(matches!(
                service.collect_aggregates_for_test(&one_column),
                Err(AppError::InvalidParam(_))
            ));

            let twenty_one_columns =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Spearman), 21);
            assert!(matches!(
                service.collect_aggregates_for_test(&twenty_one_columns),
                Err(AppError::InvalidParam(_))
            ));

            let mut duplicate_bindings =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Kendall), 2);
            duplicate_bindings.fields[1].column = "a".to_string();
            assert!(matches!(
                service.collect_aggregates_for_test(&duplicate_bindings),
                Err(AppError::InvalidParam(_))
            ));

            let mut non_numeric =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Pearson), 2);
            non_numeric.fields[1].column = "label".to_string();
            assert!(matches!(
                service.collect_aggregates_for_test(&non_numeric),
                Err(AppError::InvalidParam(_))
            ));

            let mut mixed_prefixes =
                correlation_request(dataset_id, 0, Some(CorrelationMethod::Pearson), 2);
            mixed_prefixes.fields[1].role = "multiY1".to_string();
            assert!(matches!(
                service.collect_aggregates_for_test(&mixed_prefixes),
                Err(AppError::InvalidParam(_))
            ));

            let missing_method = correlation_request(dataset_id, 0, None, 3);
            assert!(matches!(
                service.collect_aggregates_for_test(&missing_method),
                Err(AppError::InvalidParam(_))
            ));
        }

        #[test]
        fn correlation_matrix_supports_decimal_and_unsigned_numeric_columns() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-correlation-decimal-unsigned";
            {
                let db = state.db.lock().expect("db lock");
                db.create_empty_table(
                    dataset_id,
                    "Correlation Decimal Unsigned",
                    &["d".into(), "u".into()],
                    &["DECIMAL(12,2)".into(), "UINTEGER".into()],
                )
                .expect("create decimal/unsigned table");
                let table = format!("dataset_{}", dataset_id.replace('-', "_"));
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, d, u) VALUES
                             (1, 1.00::DECIMAL(12,2), 10::UINTEGER),
                             (2, 2.00::DECIMAL(12,2), 20::UINTEGER),
                             (3, 3.00::DECIMAL(12,2), 30::UINTEGER),
                             (4, 4.00::DECIMAL(12,2), 40::UINTEGER)"
                        ),
                        [],
                    )
                    .expect("insert decimal/unsigned rows");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = 4 WHERE id = $1",
                        params![dataset_id],
                    )
                    .expect("update decimal/unsigned row count");
            }

            let service = GraphDataService::new(&state);
            let request = GraphDataRequest {
                request_id: "request-decimal-unsigned-correlation".to_string(),
                dataset_id: dataset_id.to_string(),
                generation: 0,
                fields: vec![
                    GraphFieldBinding {
                        role: "multiX0".to_string(),
                        column: "d".to_string(),
                    },
                    GraphFieldBinding {
                        role: "multiX1".to_string(),
                        column: "u".to_string(),
                    },
                ],
                filters: Vec::new(),
                elements: vec![GraphElementRequest {
                    kind: "correlationMatrix".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: Some(CorrelationMethod::Pearson),
                }],
                sampling: GraphSampling::Full,
                raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
                viewport: GraphViewport {
                    width: 1200,
                    height: 700,
                },
            };

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("correlation aggregate packets");
            let packet = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::CorrelationMatrix(value) => Some(value),
                    _ => None,
                })
                .expect("correlation matrix packet");

            assert_eq!(packet.columns, vec!["d", "u"]);
            let off_diagonal = packet
                .cells
                .iter()
                .find(|cell| cell.x_index == 0 && cell.y_index == 1)
                .expect("off-diagonal cell");
            assert_eq!(off_diagonal.sample_count, 4);
            let coefficient = off_diagonal.coefficient.expect("coefficient value");
            assert!((coefficient - 1.0).abs() <= 1e-12);
        }

        #[test]
        fn aggregate_packets_match_full_data_sql_counts_across_scales() {
            for row_count in [0usize, 1, 10, 5_000, 300_000] {
                let state = AppState::new().expect("state");
                let dataset_id = format!("agg-scale-{row_count}");
                seed_dataset(&state, &dataset_id, row_count);

                let service = GraphDataService::new(&state);
                let request = aggregate_request(&dataset_id, 0);
                let packets = service
                    .collect_aggregates_for_test(&request)
                    .expect("aggregate packets");

                let expected_filtered = direct_filtered_rows(&state, &dataset_id);
                let histogram_total = packets
                    .iter()
                    .filter_map(|packet| packet.histogram_total_count())
                    .sum::<u64>();
                assert_eq!(histogram_total as i64, expected_filtered);
            }
        }

        #[test]
        fn heatmap_packet_emits_non_empty_cells_with_exact_total() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "agg-heatmap", 10_000);

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request("agg-heatmap", 0);
            request.fields[0].column = "cost".to_string();
            request.elements.push(GraphElementRequest {
                kind: "heatmap".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            });

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let heatmap = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Heatmap(value) => Some(value),
                    _ => None,
                })
                .expect("heatmap packet");

            assert!(!heatmap.cells.is_empty(), "heatmap cells must be emitted");
            let packet_total = heatmap.cells.iter().map(|cell| cell.count).sum::<u64>();
            assert_eq!(packet_total, heatmap.total_count);
        }

        #[test]
        fn heatmap_packet_matches_direct_sql_cells_edges_and_missing_count() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-heatmap-equality";
            {
                let db = state.db.lock().expect("db lock");
                db.create_empty_table(
                    dataset_id,
                    "Heatmap Equality",
                    &["region".into(), "cost".into(), "score".into()],
                    &["VARCHAR".into(), "DOUBLE".into(), "DOUBLE".into()],
                )
                .expect("create table");
                let table = "dataset_agg_heatmap_equality";
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, region, cost, score) VALUES
                             (1, 'North', 0.0, 0.0),
                             (2, 'North', 0.5, 0.5),
                             (3, 'South', 1.0, 1.0),
                             (4, 'South', 1.0, NULL),
                             (5, 'South', NULL, 1.0),
                             (6, 'East', 0.25, 0.75)"
                        ),
                        [],
                    )
                    .expect("insert rows");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = 6 WHERE id = $1",
                        params![dataset_id],
                    )
                    .expect("update row count");
            }

            let service = GraphDataService::new(&state);
            let request = GraphDataRequest {
                request_id: format!("request-{dataset_id}"),
                dataset_id: dataset_id.to_string(),
                generation: 0,
                fields: vec![
                    GraphFieldBinding {
                        role: "x".to_string(),
                        column: "cost".to_string(),
                    },
                    GraphFieldBinding {
                        role: "y".to_string(),
                        column: "score".to_string(),
                    },
                    GraphFieldBinding {
                        role: "group".to_string(),
                        column: "region".to_string(),
                    },
                ],
                filters: vec![TableWindowFilter {
                    op: "AND".to_string(),
                    rule: TableWindowFilterRule::Categorical {
                        field: "region".to_string(),
                        selected: vec!["North".to_string(), "South".to_string()],
                        exclude: false,
                    },
                }],
                elements: vec![GraphElementRequest {
                    kind: "heatmap".to_string(),
                    summary_stat: "none".to_string(),
                    correlation_method: None,
                }],
                sampling: GraphSampling::Full,
                raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
                viewport: GraphViewport {
                    width: 1200,
                    height: 700,
                },
            };

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let heatmap = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Heatmap(value) => Some(value),
                    _ => None,
                })
                .expect("heatmap packet");

            assert_eq!(heatmap.total_count, 3);
            assert_eq!(heatmap.missing_count, 2);

            let db = state.db.lock().expect("db lock");
            let expected_sql = "
                WITH valid AS (
                    SELECT
                        CAST(region AS VARCHAR) AS grp,
                        CAST(cost AS DOUBLE) AS x,
                        CAST(score AS DOUBLE) AS y
                    FROM dataset_agg_heatmap_equality
                    WHERE region IN ('North', 'South')
                      AND cost IS NOT NULL
                      AND score IS NOT NULL
                      AND isfinite(cost)
                      AND isfinite(score)
                )
                SELECT
                    grp,
                    CASE
                        WHEN ? <= 0 THEN 0
                        WHEN x = ? THEN ? - 1
                        ELSE CAST(FLOOR((x - ?) / ?) AS BIGINT)
                    END AS x_idx,
                    CASE
                        WHEN ? <= 0 THEN 0
                        WHEN y = ? THEN ? - 1
                        ELSE CAST(FLOOR((y - ?) / ?) AS BIGINT)
                    END AS y_idx,
                    COUNT(*) AS cnt
                FROM valid
                GROUP BY grp, x_idx, y_idx
                ORDER BY grp, x_idx, y_idx
            ";
            let mut stmt = db
                .conn()
                .prepare(expected_sql)
                .expect("prepare expected heatmap sql");
            let mut rows = stmt
                .query(params![
                    heatmap.x_bin_width.max(1e-12),
                    heatmap.x_max.unwrap_or(0.0),
                    i64::from(heatmap.x_bin_count),
                    heatmap.x_min.unwrap_or(0.0),
                    heatmap.x_bin_width.max(1e-12),
                    heatmap.y_bin_width.max(1e-12),
                    heatmap.y_max.unwrap_or(0.0),
                    i64::from(heatmap.y_bin_count),
                    heatmap.y_min.unwrap_or(0.0),
                    heatmap.y_bin_width.max(1e-12),
                ])
                .expect("query expected heatmap sql");

            let mut expected = std::collections::HashMap::<(Option<String>, i64, i64), u64>::new();
            while let Some(row) = rows.next().expect("next expected heatmap row") {
                let grp: Option<String> = row.get(0).expect("grp");
                let x_idx: i64 = row.get(1).expect("x idx");
                let y_idx: i64 = row.get(2).expect("y idx");
                let cnt: i64 = row.get(3).expect("cnt");
                let x_idx = x_idx.clamp(0, i64::from(heatmap.x_bin_count) - 1);
                let y_idx = y_idx.clamp(0, i64::from(heatmap.y_bin_count) - 1);
                expected.insert(
                    (grp, x_idx, y_idx),
                    u64::try_from(cnt).expect("non-negative count"),
                );
            }

            let mut actual = std::collections::HashMap::<(Option<String>, i64, i64), u64>::new();
            for cell in &heatmap.cells {
                actual.insert(
                    (cell.group.clone(), cell.x_bin_index, cell.y_bin_index),
                    cell.count,
                );
                let expected_x_start =
                    heatmap.x_min.unwrap_or(0.0) + (cell.x_bin_index as f64) * heatmap.x_bin_width;
                let expected_y_start =
                    heatmap.y_min.unwrap_or(0.0) + (cell.y_bin_index as f64) * heatmap.y_bin_width;
                assert_close(
                    cell.x_bin_start,
                    expected_x_start,
                    1e-9,
                    "heatmap x_bin_start",
                );
                assert_close(
                    cell.y_bin_start,
                    expected_y_start,
                    1e-9,
                    "heatmap y_bin_start",
                );
            }

            assert_eq!(actual, expected);
        }

        #[test]
        fn summary_packet_reports_exact_median() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "agg-summary", 101);

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request("agg-summary", 0);
            request.elements = vec![GraphElementRequest {
                kind: "summary".to_string(),
                summary_stat: "median".to_string(),
                correlation_method: None,
            }];

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let summary = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Summary(value) => Some(value),
                    _ => None,
                })
                .expect("summary packet");

            let has_finite_median = summary
                .summaries
                .iter()
                .any(|entry| entry.median.is_finite());
            assert!(has_finite_median, "summary packet must include median");
        }

        #[test]
        fn summary_packet_matches_direct_sql_median_and_intervals_for_grouped_melt() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-summary-equality";
            {
                let db = state.db.lock().expect("db lock");
                db.create_empty_table(
                    dataset_id,
                    "Summary Equality",
                    &["region".into(), "batch".into(), "m1".into(), "m2".into()],
                    &[
                        "VARCHAR".into(),
                        "VARCHAR".into(),
                        "DOUBLE".into(),
                        "DOUBLE".into(),
                    ],
                )
                .expect("create table");
                let table = "dataset_agg_summary_equality";
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, region, batch, m1, m2) VALUES
                             (1, 'North', 'B0', 10.0, 100.0),
                             (2, 'North', 'B1', 20.0, NULL),
                             (3, 'South', 'B0', NULL, 300.0),
                             (4, 'South', 'B1', 40.0, 400.0),
                             (5, 'South', 'B2', 50.0, 500.0)"
                        ),
                        [],
                    )
                    .expect("insert rows");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = 5 WHERE id = $1",
                        params![dataset_id],
                    )
                    .expect("update row count");
            }

            let service = GraphDataService::new(&state);
            let request = aggregate_melt_request(dataset_id, 0);
            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let summary = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Summary(value) => Some(value),
                    _ => None,
                })
                .expect("summary packet");

            let db = state.db.lock().expect("db lock");
            let expected_sql = "
                WITH melted AS (
                    SELECT CAST(region AS VARCHAR) AS grp, CAST(region AS VARCHAR) AS cat, CAST('m1' AS VARCHAR) AS src, CAST(m1 AS DOUBLE) AS y, batch
                    FROM dataset_agg_summary_equality
                    UNION ALL
                    SELECT CAST(region AS VARCHAR) AS grp, CAST(region AS VARCHAR) AS cat, CAST('m2' AS VARCHAR) AS src, CAST(m2 AS DOUBLE) AS y, batch
                    FROM dataset_agg_summary_equality
                ),
                valid AS (
                    SELECT grp, cat, src, y
                    FROM melted
                    WHERE batch IN ('B0', 'B1') AND y IS NOT NULL AND isfinite(y)
                )
                SELECT
                    grp,
                    cat,
                    src,
                    COUNT(*) AS n,
                    AVG(y) AS mean_y,
                    quantile_cont(y, 0.50) AS median_y,
                    COALESCE(stddev_samp(y), 0.0) AS std_y,
                    MIN(y) AS min_y,
                    MAX(y) AS max_y
                FROM valid
                GROUP BY grp, cat, src
                ORDER BY grp, cat, src
            ";
            let mut stmt = db
                .conn()
                .prepare(expected_sql)
                .expect("prepare expected summary sql");
            let mut rows = stmt.query([]).expect("query expected summary sql");
            let mut expected = std::collections::HashMap::<
                (Option<String>, Option<String>, Option<String>),
                (u64, f64, f64, f64, f64, f64),
            >::new();
            while let Some(row) = rows.next().expect("next expected summary row") {
                let grp: Option<String> = row.get(0).expect("grp");
                let cat: Option<String> = row.get(1).expect("cat");
                let src: Option<String> = row.get(2).expect("src");
                let n: i64 = row.get(3).expect("n");
                let mean: f64 = row.get(4).expect("mean");
                let median: f64 = row.get(5).expect("median");
                let std: f64 = row.get(6).expect("std");
                let min: f64 = row.get(7).expect("min");
                let max: f64 = row.get(8).expect("max");
                expected.insert(
                    (grp, cat, src),
                    (
                        u64::try_from(n).expect("n >= 0"),
                        mean,
                        median,
                        std,
                        min,
                        max,
                    ),
                );
            }

            assert_eq!(summary.summaries.len(), expected.len());
            for entry in &summary.summaries {
                let key = (
                    entry.group.clone(),
                    entry.category.clone(),
                    entry.source_column.clone(),
                );
                let Some((n, mean, median, std, min, max)) = expected.get(&key) else {
                    panic!("missing expected summary entry for key: {:?}", key);
                };
                assert_eq!(entry.count, *n);
                assert_close(entry.mean, *mean, 1e-9, "summary mean");
                assert_close(entry.median, *median, 1e-9, "summary median");
                assert_close(entry.stddev, *std, 1e-9, "summary stddev");
                assert_close(entry.min, *min, 1e-9, "summary min");
                assert_close(entry.max, *max, 1e-9, "summary max");
                let margin = if *n > 1 {
                    1.96 * *std / (*n as f64).sqrt()
                } else {
                    0.0
                };
                assert_close(
                    entry.interval_low.unwrap_or(entry.mean),
                    entry.mean - margin,
                    1e-9,
                    "summary interval_low",
                );
                assert_close(
                    entry.interval_high.unwrap_or(entry.mean),
                    entry.mean + margin,
                    1e-9,
                    "summary interval_high",
                );
            }
        }

        #[test]
        fn aggregate_packets_preserve_melt_source_identity_and_match_direct_sql() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-melt-source";
            {
                let db = state.db.lock().expect("db lock");
                db.create_empty_table(
                    dataset_id,
                    "Aggregate Melt Source",
                    &["region".into(), "batch".into(), "m1".into(), "m2".into()],
                    &[
                        "VARCHAR".into(),
                        "VARCHAR".into(),
                        "DOUBLE".into(),
                        "DOUBLE".into(),
                    ],
                )
                .expect("create table");
                let table = "dataset_agg_melt_source";
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, region, batch, m1, m2) VALUES
                             (1, 'North', 'B0', 10.0, 100.0),
                             (2, 'North', 'B1', 20.0, NULL),
                             (3, 'South', 'B0', NULL, 300.0),
                             (4, 'South', 'B1', 40.0, 400.0),
                             (5, 'South', 'B2', 50.0, 500.0)"
                        ),
                        [],
                    )
                    .expect("insert rows");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = 5 WHERE id = $1",
                        params![dataset_id],
                    )
                    .expect("update row count");
            }

            let service = GraphDataService::new(&state);
            let request = aggregate_melt_request(dataset_id, 0);
            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");

            let histogram = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Histogram(value) => Some(value),
                    _ => None,
                })
                .expect("histogram packet");
            let summary = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Summary(value) => Some(value),
                    _ => None,
                })
                .expect("summary packet");
            let boxplot = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::BoxPlot(value) => Some(value),
                    _ => None,
                })
                .expect("boxplot packet");

            let histogram_sources = histogram
                .bins
                .iter()
                .filter_map(|bin| bin.source_column.as_deref())
                .collect::<std::collections::HashSet<_>>();
            assert!(histogram_sources.contains("m1"));
            assert!(histogram_sources.contains("m2"));

            let summary_sources = summary
                .summaries
                .iter()
                .filter_map(|entry| entry.source_column.as_deref())
                .collect::<std::collections::HashSet<_>>();
            assert!(summary_sources.contains("m1"));
            assert!(summary_sources.contains("m2"));

            let outlier_sources = boxplot
                .entries
                .iter()
                .filter_map(|entry| entry.source_column.as_deref())
                .collect::<std::collections::HashSet<_>>();
            assert!(outlier_sources.contains("m1") || outlier_sources.contains("m2"));

            let db = state.db.lock().expect("db lock");
            let expected: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*)
                     FROM (
                        SELECT m1 AS v, batch FROM dataset_agg_melt_source
                        UNION ALL
                        SELECT m2 AS v, batch FROM dataset_agg_melt_source
                     ) t
                     WHERE batch IN ('B0','B1') AND v IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .expect("direct melt count");
            assert_eq!(histogram.total_count as i64, expected);
        }

        #[test]
        fn raw_chunks_emit_requested_role_vectors_and_melt_source_alignment() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-role-vectors";
            seed_faceted_dataset(&state, dataset_id);

            let service = GraphDataService::new(&state);
            let request = faceted_request(dataset_id, 0);
            let chunks = service.collect_for_test(&request).expect("chunks");

            let first = chunks.first().expect("at least one chunk");
            assert!(
                first.header.role_vectors.contains_key("z"),
                "expected z role vector descriptor"
            );
            assert!(
                first.header.role_vectors.contains_key("source"),
                "expected source role vector descriptor"
            );
            assert!(
                first.header.role_vectors.contains_key("groupX"),
                "expected groupX role vector descriptor"
            );
            assert!(
                first.header.role_vectors.contains_key("groupY"),
                "expected groupY role vector descriptor"
            );
            assert!(
                first.header.role_vectors.contains_key("groupZ"),
                "expected groupZ role vector descriptor"
            );
            assert!(
                first.header.role_vectors.contains_key("wrap"),
                "expected wrap role vector descriptor"
            );

            let source_desc = first
                .header
                .role_vectors
                .get("source")
                .expect("source role descriptor");
            let source_codes = extract_u32_slice(first, source_desc);
            assert_eq!(source_codes.len(), first.header.row_count);
            let row_ids = extract_i64_slice(first, &first.header.row_ids);
            assert_eq!(row_ids.len(), source_codes.len());

            let z_desc = first
                .header
                .role_vectors
                .get("z")
                .expect("z role descriptor");
            let z_values = extract_f64_slice(first, z_desc);
            assert_eq!(z_values.len(), first.header.row_count);
            assert!(
                z_values.iter().all(|value| value.is_finite()),
                "z role vector must contain finite values"
            );

            let facet_z_desc = first
                .header
                .role_vectors
                .get("groupZ")
                .expect("groupZ role descriptor");
            let facet_z_codes = extract_u32_slice(first, facet_z_desc);
            assert_eq!(facet_z_codes.len(), first.header.row_count);

            let source_dictionary = first
                .header
                .dictionaries
                .get("source")
                .cloned()
                .unwrap_or_default();
            assert!(source_dictionary.iter().any(|value| value == "m1"));
            assert!(source_dictionary.iter().any(|value| value == "m2"));

            let facet_z_dictionary = first
                .header
                .dictionaries
                .get("facetZ")
                .cloned()
                .unwrap_or_default();
            assert!(facet_z_dictionary.iter().any(|value| value == "Front"));
            assert!(facet_z_dictionary.iter().any(|value| value == "Back"));
        }

        #[test]
        fn raw_chunks_project_multi_x_columns_as_categorical_axis_values() {
            let state = AppState::new().expect("state");
            let dataset_id = "multi-x-axis";
            seed_faceted_dataset(&state, dataset_id);

            let service = GraphDataService::new(&state);
            let request = multi_x_axis_request(dataset_id, 0);
            let chunks = service.collect_for_test(&request).expect("chunks");

            assert_eq!(
                chunks
                    .iter()
                    .map(|chunk| chunk.header.row_count)
                    .sum::<usize>(),
                8,
            );
            assert!(chunks
                .iter()
                .all(|chunk| chunk.header.x_encoding == GraphAxisEncoding::Categorical));
            let x_values = chunks
                .iter()
                .flat_map(|chunk| chunk.header.dictionaries.get("x").into_iter().flatten())
                .cloned()
                .collect::<HashSet<_>>();
            assert_eq!(
                x_values,
                HashSet::from(["m1".to_string(), "m2".to_string()])
            );

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let boxplot = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::BoxPlot(value) => Some(value),
                    _ => None,
                })
                .expect("boxplot packet");
            assert_eq!(boxplot.entries.len(), 2);
            assert!(boxplot.entries.iter().all(|entry| entry.count == 4));
        }

        #[test]
        fn aggregate_packets_include_explicit_facet_and_group_dimensions() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-facet-dims";
            seed_faceted_dataset(&state, dataset_id);

            let service = GraphDataService::new(&state);
            let request = faceted_request(dataset_id, 0);
            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");

            let histogram = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Histogram(value) => Some(value),
                    _ => None,
                })
                .expect("histogram packet");
            assert!(
                histogram.bins.iter().all(|entry| entry.facet_x.is_some()),
                "histogram bins must carry facet_x"
            );
            assert!(
                histogram.bins.iter().all(|entry| entry.facet_y.is_some()),
                "histogram bins must carry facet_y"
            );
            assert!(
                histogram.bins.iter().all(|entry| entry.facet_z.is_some()),
                "histogram bins must carry facet_z"
            );
            assert!(
                histogram.bins.iter().all(|entry| entry.wrap.is_some()),
                "histogram bins must carry wrap"
            );

            let heatmap = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Heatmap(value) => Some(value),
                    _ => None,
                })
                .expect("heatmap packet");
            assert!(
                heatmap.cells.iter().all(|entry| entry.facet_x.is_some()),
                "heatmap cells must carry facet_x"
            );
            assert!(
                heatmap.cells.iter().all(|entry| entry.facet_y.is_some()),
                "heatmap cells must carry facet_y"
            );
            assert!(
                heatmap.cells.iter().all(|entry| entry.facet_z.is_some()),
                "heatmap cells must carry facet_z"
            );
            assert!(
                heatmap.cells.iter().all(|entry| entry.wrap.is_some()),
                "heatmap cells must carry wrap"
            );

            let boxplot = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::BoxPlot(value) => Some(value),
                    _ => None,
                })
                .expect("boxplot packet");
            assert!(
                boxplot.entries.iter().all(|entry| entry.facet_x.is_some()),
                "boxplot entries must carry facet_x"
            );
            assert!(
                boxplot.entries.iter().all(|entry| entry.facet_y.is_some()),
                "boxplot entries must carry facet_y"
            );
            assert!(
                boxplot.entries.iter().all(|entry| entry.facet_z.is_some()),
                "boxplot entries must carry facet_z"
            );
            assert!(
                boxplot.entries.iter().all(|entry| entry.wrap.is_some()),
                "boxplot entries must carry wrap"
            );

            let summary = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::Summary(value) => Some(value),
                    _ => None,
                })
                .expect("summary packet");
            assert!(
                summary
                    .summaries
                    .iter()
                    .all(|entry| entry.facet_x.is_some()),
                "summary entries must carry facet_x"
            );
            assert!(
                summary
                    .summaries
                    .iter()
                    .all(|entry| entry.facet_y.is_some()),
                "summary entries must carry facet_y"
            );
            assert!(
                summary
                    .summaries
                    .iter()
                    .all(|entry| entry.facet_z.is_some()),
                "summary entries must carry facet_z"
            );
            assert!(
                summary.summaries.iter().all(|entry| entry.wrap.is_some()),
                "summary entries must carry wrap"
            );
        }

        #[test]
        fn boxplot_packet_emits_outliers_with_identity() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "agg-box", 200);
            {
                let db = state.db.lock().expect("db lock");
                let table = "dataset_agg_box";
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, region, cost) VALUES (900001, 'North', 1000000.0), (900002, 'South', -1000000.0)"
                        ),
                        [],
                    )
                    .expect("insert outliers");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = row_count + 2 WHERE id = $1",
                        params!["agg-box"],
                    )
                    .expect("update row count");
            }

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request("agg-box", 0);
            request.elements = vec![GraphElementRequest {
                kind: "boxplot".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }];

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let boxplot = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::BoxPlot(value) => Some(value),
                    _ => None,
                })
                .expect("boxplot packet");

            let any_outlier = boxplot
                .entries
                .iter()
                .flat_map(|entry| entry.outliers.iter())
                .next();
            assert!(any_outlier.is_some(), "boxplot outliers should be emitted");
            assert!(
                any_outlier.and_then(|item| item.row_id).is_some(),
                "outlier row id should be present"
            );
        }

        #[test]
        fn boxplot_packet_matches_direct_sql_quantiles_whiskers_and_outlier_ids() {
            let state = AppState::new().expect("state");
            let dataset_id = "agg-box-equality";
            {
                let db = state.db.lock().expect("db lock");
                db.create_empty_table(
                    dataset_id,
                    "Box Equality",
                    &["region".into(), "cost".into()],
                    &["VARCHAR".into(), "DOUBLE".into()],
                )
                .expect("create table");
                let table = "dataset_agg_box_equality";
                db.conn()
                    .execute(
                        &format!(
                            "INSERT INTO \"{table}\" (_row_id, region, cost) VALUES
                             (11, 'North', 1.0),
                             (12, 'North', 2.0),
                             (13, 'North', 3.0),
                             (14, 'North', 4.0),
                             (15, 'North', 100.0),
                             (21, 'South', 10.0),
                             (22, 'South', 11.0),
                             (23, 'South', 12.0),
                             (24, 'South', 13.0),
                             (25, 'South', 200.0)"
                        ),
                        [],
                    )
                    .expect("insert rows");
                db.conn()
                    .execute(
                        "UPDATE _meta_datasets SET row_count = 10 WHERE id = $1",
                        params![dataset_id],
                    )
                    .expect("update row count");
            }

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request(dataset_id, 0);
            request.elements = vec![GraphElementRequest {
                kind: "boxplot".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }];

            let packets = service
                .collect_aggregates_for_test(&request)
                .expect("aggregate packets");
            let boxplot = packets
                .iter()
                .find_map(|packet| match packet {
                    GraphAggregatePacket::BoxPlot(value) => Some(value),
                    _ => None,
                })
                .expect("boxplot packet");

            let db = state.db.lock().expect("db lock");
            let stats_sql = "
                WITH valid AS (
                    SELECT
                        CAST(region AS VARCHAR) AS grp,
                        CAST(region AS VARCHAR) AS cat,
                        CAST('cost' AS VARCHAR) AS src,
                        CAST(cost AS DOUBLE) AS y
                    FROM dataset_agg_box_equality
                    WHERE region IN ('North', 'South') AND cost IS NOT NULL AND isfinite(cost)
                ),
                stats AS (
                    SELECT
                        grp,
                        cat,
                        src,
                        COUNT(*) AS n,
                        MIN(y) AS min_y,
                        quantile_cont(y, 0.25) AS q1,
                        quantile_cont(y, 0.50) AS median,
                        quantile_cont(y, 0.75) AS q3,
                        MAX(y) AS max_y
                    FROM valid
                    GROUP BY grp, cat, src
                ),
                whiskers AS (
                    SELECT
                        s.grp,
                        s.cat,
                        s.src,
                        MIN(v.y) FILTER (WHERE v.y >= (s.q1 - 1.5 * (s.q3 - s.q1)) AND v.y <= (s.q3 + 1.5 * (s.q3 - s.q1))) AS whisker_low,
                        MAX(v.y) FILTER (WHERE v.y >= (s.q1 - 1.5 * (s.q3 - s.q1)) AND v.y <= (s.q3 + 1.5 * (s.q3 - s.q1))) AS whisker_high
                    FROM stats s
                    JOIN valid v
                      ON v.grp IS NOT DISTINCT FROM s.grp
                     AND v.cat IS NOT DISTINCT FROM s.cat
                     AND v.src IS NOT DISTINCT FROM s.src
                    GROUP BY s.grp, s.cat, s.src
                )
                SELECT
                    s.grp,
                    s.cat,
                    s.src,
                    s.n,
                    s.min_y,
                    s.q1,
                    s.median,
                    s.q3,
                    s.max_y,
                    COALESCE(w.whisker_low, s.min_y) AS whisker_low,
                    COALESCE(w.whisker_high, s.max_y) AS whisker_high
                FROM stats s
                LEFT JOIN whiskers w
                  ON w.grp IS NOT DISTINCT FROM s.grp
                 AND w.cat IS NOT DISTINCT FROM s.cat
                 AND w.src IS NOT DISTINCT FROM s.src
                ORDER BY s.grp, s.cat, s.src
            ";
            let mut stmt = db.conn().prepare(stats_sql).expect("prepare box stats sql");
            let mut rows = stmt.query([]).expect("query box stats sql");
            let mut expected_stats = std::collections::HashMap::<
                (Option<String>, Option<String>, Option<String>),
                (u64, f64, f64, f64, f64, f64, f64, f64),
            >::new();
            while let Some(row) = rows.next().expect("next box stats row") {
                let grp: Option<String> = row.get(0).expect("grp");
                let cat: Option<String> = row.get(1).expect("cat");
                let src: Option<String> = row.get(2).expect("src");
                let n: i64 = row.get(3).expect("n");
                let min: f64 = row.get(4).expect("min");
                let q1: f64 = row.get(5).expect("q1");
                let median: f64 = row.get(6).expect("median");
                let q3: f64 = row.get(7).expect("q3");
                let max: f64 = row.get(8).expect("max");
                let whisker_low: f64 = row.get(9).expect("whisker low");
                let whisker_high: f64 = row.get(10).expect("whisker high");
                expected_stats.insert(
                    (grp, cat, src),
                    (
                        u64::try_from(n).expect("n >= 0"),
                        min,
                        q1,
                        median,
                        q3,
                        max,
                        whisker_low,
                        whisker_high,
                    ),
                );
            }

            let outlier_sql = "
                WITH valid AS (
                    SELECT
                        CAST(_row_id AS BIGINT) AS row_id,
                        CAST(region AS VARCHAR) AS grp,
                        CAST(region AS VARCHAR) AS cat,
                        CAST('cost' AS VARCHAR) AS src,
                        CAST(cost AS DOUBLE) AS y
                    FROM dataset_agg_box_equality
                    WHERE region IN ('North', 'South') AND cost IS NOT NULL AND isfinite(cost)
                ),
                bounds AS (
                    SELECT
                        grp,
                        cat,
                        src,
                        quantile_cont(y, 0.25) - 1.5 * (quantile_cont(y, 0.75) - quantile_cont(y, 0.25)) AS lo,
                        quantile_cont(y, 0.75) + 1.5 * (quantile_cont(y, 0.75) - quantile_cont(y, 0.25)) AS hi
                    FROM valid
                    GROUP BY grp, cat, src
                )
                SELECT v.grp, v.cat, v.src, v.row_id
                FROM valid v
                JOIN bounds b
                  ON v.grp IS NOT DISTINCT FROM b.grp
                 AND v.cat IS NOT DISTINCT FROM b.cat
                 AND v.src IS NOT DISTINCT FROM b.src
                WHERE v.y < b.lo OR v.y > b.hi
                ORDER BY v.grp, v.cat, v.src, v.row_id
            ";
            let mut outlier_stmt = db.conn().prepare(outlier_sql).expect("prepare outlier sql");
            let mut outlier_rows = outlier_stmt.query([]).expect("query outlier sql");
            let mut expected_outliers = std::collections::HashMap::<
                (Option<String>, Option<String>, Option<String>),
                std::collections::BTreeSet<i64>,
            >::new();
            while let Some(row) = outlier_rows.next().expect("next outlier row") {
                let grp: Option<String> = row.get(0).expect("grp");
                let cat: Option<String> = row.get(1).expect("cat");
                let src: Option<String> = row.get(2).expect("src");
                let row_id: i64 = row.get(3).expect("row id");
                expected_outliers
                    .entry((grp, cat, src))
                    .or_default()
                    .insert(row_id);
            }

            assert_eq!(boxplot.entries.len(), expected_stats.len());
            for entry in &boxplot.entries {
                let key = (
                    entry.group.clone(),
                    entry.category.clone(),
                    entry.source_column.clone(),
                );
                let Some((n, min, q1, median, q3, max, whisker_low, whisker_high)) =
                    expected_stats.get(&key)
                else {
                    panic!("missing expected box stats for key: {:?}", key);
                };
                assert_eq!(entry.count, *n);
                assert_close(entry.min, *min, 1e-9, "box min");
                assert_close(entry.q1, *q1, 1e-9, "box q1");
                assert_close(entry.median, *median, 1e-9, "box median");
                assert_close(entry.q3, *q3, 1e-9, "box q3");
                assert_close(entry.max, *max, 1e-9, "box max");
                assert_close(entry.whisker_low, *whisker_low, 1e-9, "box whisker_low");
                assert_close(entry.whisker_high, *whisker_high, 1e-9, "box whisker_high");

                let actual_outlier_ids = entry
                    .outliers
                    .iter()
                    .filter_map(|outlier| outlier.row_id)
                    .collect::<std::collections::BTreeSet<_>>();
                let expected_ids = expected_outliers.get(&key).cloned().unwrap_or_default();
                assert_eq!(actual_outlier_ids, expected_ids);
            }
        }

        #[test]
        fn sampled_raw_rows_keep_minority_groups_with_same_seed() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "agg-strata", 50_000);

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request("agg-strata", 0);
            request.sampling = GraphSampling::Sample {
                size: 1000,
                seed: 17,
            };
            request.elements = vec![GraphElementRequest {
                kind: "points".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }];

            let first = service.collect_for_test(&request).expect("first sample");
            let second = service.collect_for_test(&request).expect("second sample");

            let first_ids = first
                .iter()
                .flat_map(|chunk| extract_i64_slice(chunk, &chunk.header.row_ids))
                .collect::<Vec<_>>();
            let second_ids = second
                .iter()
                .flat_map(|chunk| extract_i64_slice(chunk, &chunk.header.row_ids))
                .collect::<Vec<_>>();
            assert_eq!(first_ids, second_ids);

            assert!(
                !first_ids.is_empty(),
                "sample should include at least one row"
            );
        }

        #[test]
        fn aggregate_packets_are_identical_between_full_and_sample() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "agg-parity", 25_000);

            let service = GraphDataService::new(&state);
            let full_request = aggregate_request("agg-parity", 0);
            let mut sample_request = aggregate_request("agg-parity", 0);
            sample_request.sampling = GraphSampling::Sample {
                size: 2_500,
                seed: 20260820,
            };

            let full_packets = service
                .collect_aggregates_for_test(&full_request)
                .expect("full packets");
            let sample_packets = service
                .collect_aggregates_for_test(&sample_request)
                .expect("sample packets");

            let full_bytes = serde_json::to_vec(&full_packets).expect("serialize full");
            let sample_bytes = serde_json::to_vec(&sample_packets).expect("serialize sample");
            assert_eq!(full_bytes, sample_bytes);
        }

        #[test]
        fn sampled_raw_rows_are_deterministic_for_the_same_seed() {
            let state = AppState::new().expect("state");
            seed_dataset(&state, "sample-repro", 30_000);

            let service = GraphDataService::new(&state);
            let mut request = aggregate_request("sample-repro", 0);
            request.sampling = GraphSampling::Sample {
                size: 3_000,
                seed: 17,
            };
            request.elements = vec![GraphElementRequest {
                kind: "points".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }];

            let first = service.collect_for_test(&request).expect("first sample");
            let second = service.collect_for_test(&request).expect("second sample");

            let first_ids = first
                .iter()
                .flat_map(|chunk| extract_i64_slice(chunk, &chunk.header.row_ids))
                .collect::<Vec<_>>();
            let second_ids = second
                .iter()
                .flat_map(|chunk| extract_i64_slice(chunk, &chunk.header.row_ids))
                .collect::<Vec<_>>();
            assert_eq!(first_ids, second_ids);
        }
    }

    fn build_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
        GraphDataRequest {
            request_id: format!("request-{dataset_id}"),
            dataset_id: dataset_id.to_string(),
            generation,
            fields: vec![
                GraphFieldBinding {
                    role: "x".to_string(),
                    column: "region".to_string(),
                },
                GraphFieldBinding {
                    role: "y".to_string(),
                    column: "cost".to_string(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "points".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        }
    }

    fn seed_dataset(state: &AppState, dataset_id: &str, rows: usize) {
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            dataset_id,
            &format!("Dataset {dataset_id}"),
            &["region".into(), "cost".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .expect("create table");

        if rows > 0 {
            let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
            let upper_bound = i64::try_from(rows)
                .ok()
                .and_then(|value| value.checked_add(1))
                .expect("rows upper bound");
            let insert_sql = format!(
                "INSERT INTO \"{table_name}\" (_row_id, region, cost)
                 SELECT i,
                    CASE (i % 5)
                        WHEN 1 THEN 'North'
                        WHEN 2 THEN 'South'
                        WHEN 3 THEN 'East'
                        WHEN 4 THEN 'West'
                        ELSE 'Central'
                    END,
                    CAST(i - 1 AS DOUBLE) * 1.5
                 FROM range(1, CAST(? AS BIGINT)) AS generated(i)"
            );
            db.conn()
                .execute(&insert_sql, params![upper_bound])
                .expect("bulk insert rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                    params![rows as i64, dataset_id],
                )
                .expect("update row count");
        }
    }

    #[test]
    fn collect_for_test_handles_scale_matrix() {
        for row_count in [0usize, 1, 10, 5_000, 300_000] {
            let state = AppState::new().expect("state");
            let dataset_id = format!("scale-{row_count}");
            seed_dataset(&state, &dataset_id, row_count);

            let service = GraphDataService::new(&state);
            let request = build_request(&dataset_id, 0);
            let (chunks, completion) = service.collect_for_harness(&request).expect("result");

            if row_count == 0 {
                assert!(chunks.is_empty());
                assert!(matches!(
                    completion.raw_point_disposition,
                    GraphRawPointDisposition::Empty { valid_rows: 0, .. }
                ));
            } else if row_count > GRAPH_SCATTER_RENDER_BUDGET {
                assert!(chunks.is_empty());
                assert!(matches!(
                    completion.raw_point_disposition,
                    GraphRawPointDisposition::Omitted {
                        reason: GraphRawPointOmissionReason::PointBudgetExceeded,
                        valid_rows,
                        ..
                    } if valid_rows == row_count as u64
                ));
            } else {
                assert_eq!(
                    chunks
                        .iter()
                        .map(|chunk| chunk.header.row_count)
                        .sum::<usize>(),
                    row_count
                );
                assert!(chunks.last().expect("final chunk").header.final_chunk);
                assert_eq!(
                    chunks[0].header.projected_columns,
                    vec!["_row_id", "region", "cost"]
                );
                assert!(matches!(
                    completion.raw_point_disposition,
                    GraphRawPointDisposition::Included { valid_rows, .. }
                        if valid_rows == row_count as u64
                ));
            }
        }
    }

    #[test]
    fn full_points_above_budget_omit_raw_chunks_but_keep_exact_aggregates() {
        let state = AppState::new().expect("state");
        let row_count = GRAPH_SCATTER_RENDER_BUDGET + 1;
        seed_dataset(&state, "points-over-budget", row_count);

        let service = GraphDataService::new(&state);
        let mut request = build_request("points-over-budget", 0);
        request.elements.push(GraphElementRequest {
            kind: "histogram".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
        });
        let mut sink = CollectingChunkSink::default();
        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("stream result");

        assert_eq!(completion.chunks_sent, 0);
        assert!(sink.chunks.is_empty());
        assert!(!sink.aggregate_packets.is_empty());
        assert!(matches!(
            completion.raw_point_disposition,
            GraphRawPointDisposition::Omitted {
                reason: GraphRawPointOmissionReason::PointBudgetExceeded,
                valid_rows,
                budget: GRAPH_SCATTER_RENDER_BUDGET,
            } if valid_rows == row_count as u64
        ));
    }

    #[test]
    fn zero_valid_points_emit_empty_disposition_without_raw_chunks() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "points-empty", 3);
        let db = state.db.lock().expect("db lock");
        db.conn()
            .execute("UPDATE \"dataset_points_empty\" SET cost = NULL", [])
            .expect("clear point values");
        drop(db);

        let service = GraphDataService::new(&state);
        let request = build_request("points-empty", 0);
        let (chunks, completion) = service.collect_for_harness(&request).expect("result");

        assert!(chunks.is_empty());
        assert_eq!(completion.chunks_sent, 0);
        assert!(matches!(
            completion.raw_point_disposition,
            GraphRawPointDisposition::Empty {
                valid_rows: 0,
                budget: GRAPH_SCATTER_RENDER_BUDGET,
            }
        ));
    }

    #[test]
    fn sample_within_budget_includes_raw_chunks() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "points-sample-budget", 30_000);
        let service = GraphDataService::new(&state);
        let mut request = build_request("points-sample-budget", 0);
        request.sampling = GraphSampling::Sample {
            size: 3_000,
            seed: 17,
        };
        let (chunks, completion) = service.collect_for_harness(&request).expect("result");

        assert!(!chunks.is_empty());
        assert!(matches!(
            completion.raw_point_disposition,
            GraphRawPointDisposition::Included {
                valid_rows,
                budget: GRAPH_SCATTER_RENDER_BUDGET,
            } if valid_rows <= GRAPH_SCATTER_RENDER_BUDGET as u64
        ));
    }

    #[test]
    fn rejects_invalid_raw_point_and_sample_budgets() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "invalid-point-budget", 1);
        let service = GraphDataService::new(&state);

        for budget in [0, GRAPH_SCATTER_RENDER_BUDGET + 1] {
            let mut request = build_request("invalid-point-budget", 0);
            request.raw_point_budget = budget;
            assert!(matches!(
                service.collect_for_harness(&request),
                Err(AppError::InvalidParam(message)) if message.contains("raw_point_budget")
            ));
        }

        let mut request = build_request("invalid-point-budget", 0);
        request.sampling = GraphSampling::Sample {
            size: GRAPH_SCATTER_RENDER_BUDGET + 1,
            seed: 7,
        };
        assert!(matches!(
            service.collect_for_harness(&request),
            Err(AppError::InvalidParam(message)) if message.contains("sample size")
        ));
    }

    #[test]
    fn collect_for_test_rejects_stale_generation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "stale-gen", 3);

        let db = state.db.lock().expect("db lock");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                params!["stale-gen"],
            )
            .expect("update generation");
        drop(db);

        let service = GraphDataService::new(&state);
        let request = build_request("stale-gen", 0);
        let error = service
            .collect_for_test(&request)
            .expect_err("stale generation must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
        );
    }

    #[test]
    fn collect_for_test_rejects_unknown_column() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "unknown-column", 3);

        let service = GraphDataService::new(&state);
        let mut request = build_request("unknown-column", 0);
        request.fields[0].column = "missing".to_string();

        let error = service
            .collect_for_test(&request)
            .expect_err("unknown column must fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown graph column"))
        );
    }

    #[test]
    fn collect_for_test_keeps_row_ids_unique_across_chunk_boundaries() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "chunk-ids", 300_000);

        let service = GraphDataService::new(&state);
        let mut request = build_request("chunk-ids", 0);
        request.elements = vec![GraphElementRequest {
            kind: "line".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
        }];
        let chunks = service.collect_for_test(&request).expect("chunks");

        let mut all_ids = HashSet::new();
        for chunk in &chunks {
            for value in extract_i64_slice(chunk, &chunk.header.row_ids) {
                assert!(all_ids.insert(value));
            }
        }
        assert_eq!(all_ids.len(), 300_000);
    }

    #[test]
    fn collect_for_test_line_only_request_emits_row_ids_for_every_row() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "line-row-ids", 12);

        let service = GraphDataService::new(&state);
        let mut request = build_request("line-row-ids", 0);
        request.elements = vec![GraphElementRequest {
            kind: "line".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
        }];

        let chunks = service.collect_for_test(&request).expect("chunks");
        let mut all_ids = HashSet::new();
        let mut total_rows = 0usize;
        for chunk in &chunks {
            let row_ids = extract_i64_slice(chunk, &chunk.header.row_ids);
            assert_eq!(row_ids.len(), chunk.header.row_count);
            total_rows += chunk.header.row_count;
            for row_id in row_ids {
                assert!(all_ids.insert(row_id));
            }
        }

        assert_eq!(total_rows, 12);
        assert_eq!(all_ids.len(), 12);
    }

    #[test]
    fn collect_for_test_applies_filters_before_encoding() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "filtered", 20);

        let service = GraphDataService::new(&state);
        let mut request = build_request("filtered", 0);
        request.filters = vec![TableWindowFilter {
            op: "AND".to_string(),
            rule: TableWindowFilterRule::Categorical {
                field: "region".to_string(),
                selected: vec!["North".to_string()],
                exclude: false,
            },
        }];

        let chunks = service.collect_for_test(&request).expect("chunks");
        let total_rows = chunks
            .iter()
            .map(|chunk| chunk.header.row_count)
            .sum::<usize>();
        assert_eq!(total_rows, 4);
    }

    #[test]
    fn collect_for_test_emits_bitpacked_validity_for_all_roles() {
        let state = AppState::new().expect("state");
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            "validity-packed",
            "Validity Packed",
            &[
                "xv".into(),
                "yv".into(),
                "zv".into(),
                "grp".into(),
                "sizev".into(),
                "src".into(),
                "fx".into(),
                "fy".into(),
                "fz".into(),
                "wrapv".into(),
            ],
            &[
                "DOUBLE".into(),
                "DOUBLE".into(),
                "DOUBLE".into(),
                "VARCHAR".into(),
                "DOUBLE".into(),
                "VARCHAR".into(),
                "VARCHAR".into(),
                "VARCHAR".into(),
                "VARCHAR".into(),
                "VARCHAR".into(),
            ],
        )
        .expect("create table");

        let table_name = "dataset_validity_packed";
        let x_flags = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0];
        let y_flags = [1, 1, 0, 1, 1, 0, 1, 0, 0, 1];
        let z_flags = [0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
        let group_flags = [1, 1, 1, 0, 0, 1, 0, 1, 1, 0];
        let size_flags = [1, 0, 1, 0, 1, 0, 1, 0, 1, 1];
        let source_flags = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
        let facet_x_flags = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0];
        let facet_y_flags = [0, 0, 1, 1, 0, 0, 1, 1, 0, 1];
        let facet_z_flags = [1, 1, 0, 0, 1, 1, 0, 0, 1, 0];
        let wrap_flags = [0, 1, 1, 1, 0, 1, 1, 0, 1, 1];

        for row in 0..10usize {
            let row_id = i64::try_from(row + 1).expect("row id");
            let x = if x_flags[row] == 1 {
                Some(row as f64 + 0.25)
            } else {
                None
            };
            let y = if y_flags[row] == 1 {
                Some(row as f64 + 10.0)
            } else {
                None
            };
            let z = if z_flags[row] == 1 {
                Some(row as f64 + 100.0)
            } else {
                None
            };
            let group_value = if group_flags[row] == 1 {
                Some(format!("G{}", row % 3))
            } else {
                None
            };
            let size = if size_flags[row] == 1 {
                Some(row as f64 + 1.0)
            } else {
                None
            };
            let source_value = if source_flags[row] == 1 {
                Some(format!("S{}", row % 2))
            } else {
                None
            };
            let facet_x_value = if facet_x_flags[row] == 1 {
                Some(format!("FX{}", row % 2))
            } else {
                None
            };
            let facet_y_value = if facet_y_flags[row] == 1 {
                Some(format!("FY{}", row % 2))
            } else {
                None
            };
            let facet_z_value = if facet_z_flags[row] == 1 {
                Some(format!("FZ{}", row % 2))
            } else {
                None
            };
            let wrap_value = if wrap_flags[row] == 1 {
                Some(format!("W{}", row % 2))
            } else {
                None
            };

            let insert_sql = format!(
                "INSERT INTO \"{table_name}\" (_row_id, xv, yv, zv, grp, sizev, src, fx, fy, fz, wrapv)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
            );
            db.conn()
                .execute(
                    &insert_sql,
                    params![
                        row_id,
                        x,
                        y,
                        z,
                        group_value,
                        size,
                        source_value,
                        facet_x_value,
                        facet_y_value,
                        facet_z_value,
                        wrap_value,
                    ],
                )
                .expect("insert row");
        }
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                params![10i64, "validity-packed"],
            )
            .expect("update row count");
        drop(db);

        let service = GraphDataService::new(&state);
        let request = GraphDataRequest {
            request_id: "request-validity-packed".to_string(),
            dataset_id: "validity-packed".to_string(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "x".to_string(),
                    column: "xv".to_string(),
                },
                GraphFieldBinding {
                    role: "y".to_string(),
                    column: "yv".to_string(),
                },
                GraphFieldBinding {
                    role: "z".to_string(),
                    column: "zv".to_string(),
                },
                GraphFieldBinding {
                    role: "group".to_string(),
                    column: "grp".to_string(),
                },
                GraphFieldBinding {
                    role: "size".to_string(),
                    column: "sizev".to_string(),
                },
                GraphFieldBinding {
                    role: "groupX".to_string(),
                    column: "fx".to_string(),
                },
                GraphFieldBinding {
                    role: "groupY".to_string(),
                    column: "fy".to_string(),
                },
                GraphFieldBinding {
                    role: "groupZ".to_string(),
                    column: "fz".to_string(),
                },
                GraphFieldBinding {
                    role: "wrap".to_string(),
                    column: "wrapv".to_string(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "points".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        };

        let chunks = service.collect_for_test(&request).expect("chunks");
        assert_eq!(chunks.len(), 1);
        let chunk = &chunks[0];
        assert_eq!(chunk.header.row_count, 10);

        let expected_bytes: [(&str, [u8; 2]); 9] = [
            ("x", [0xAD, 0x01]),
            ("y", [0x5B, 0x02]),
            ("z", [0xD6, 0x02]),
            ("group", [0xA7, 0x01]),
            ("size", [0x55, 0x03]),
            ("facetX", [0x99, 0x01]),
            ("facetY", [0xCC, 0x02]),
            ("facetZ", [0x33, 0x01]),
            ("wrap", [0x6E, 0x03]),
        ];

        for (key, expected) in expected_bytes {
            let descriptor = chunk
                .header
                .validity_ranges
                .get(key)
                .unwrap_or_else(|| panic!("missing validity descriptor for {key}"));
            assert_eq!(
                descriptor.byte_length, 2,
                "unexpected byte length for {key}"
            );
            let encoded = extract_u8_slice(chunk, descriptor);
            assert_eq!(encoded, expected, "unexpected validity bitmap for {key}");
        }
    }

    fn extract_i64_slice(
        chunk: &GraphDataChunk,
        descriptor: &crate::models::graph_data::GraphTypedSliceDescriptor,
    ) -> Vec<i64> {
        let mut result = Vec::new();
        let mut offset = descriptor.offset;
        let end = descriptor.offset + descriptor.byte_length;
        while offset < end {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&chunk.payload[offset..offset + 8]);
            result.push(i64::from_ne_bytes(bytes));
            offset += 8;
        }
        result
    }

    fn extract_u32_slice(
        chunk: &GraphDataChunk,
        descriptor: &crate::models::graph_data::GraphTypedSliceDescriptor,
    ) -> Vec<u32> {
        let mut result = Vec::new();
        let mut offset = descriptor.offset;
        let end = descriptor.offset + descriptor.byte_length;
        while offset < end {
            let mut bytes = [0u8; 4];
            bytes.copy_from_slice(&chunk.payload[offset..offset + 4]);
            result.push(u32::from_ne_bytes(bytes));
            offset += 4;
        }
        result
    }

    fn extract_f64_slice(
        chunk: &GraphDataChunk,
        descriptor: &crate::models::graph_data::GraphTypedSliceDescriptor,
    ) -> Vec<f64> {
        let mut result = Vec::new();
        let mut offset = descriptor.offset;
        let end = descriptor.offset + descriptor.byte_length;
        while offset < end {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&chunk.payload[offset..offset + 8]);
            result.push(f64::from_ne_bytes(bytes));
            offset += 8;
        }
        result
    }

    fn extract_u8_slice(
        chunk: &GraphDataChunk,
        descriptor: &crate::models::graph_data::GraphTypedSliceDescriptor,
    ) -> Vec<u8> {
        let end = descriptor.offset + descriptor.byte_length;
        chunk.payload[descriptor.offset..end].to_vec()
    }

    #[derive(Default)]
    struct BoundedSink {
        first_header_processed_rows: Option<u64>,
        first_header_source_rows: Option<u64>,
        pending_chunks: usize,
        max_pending_chunks: usize,
        pending_payload_bytes: usize,
        max_pending_payload_bytes: usize,
    }

    impl GraphChunkSink for BoundedSink {
        fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            if self.first_header_processed_rows.is_none() {
                self.first_header_processed_rows = Some(header.processed_rows);
                self.first_header_source_rows = Some(header.source_rows);
            }
            self.pending_chunks = self.pending_chunks.saturating_add(1);
            self.max_pending_chunks = self.max_pending_chunks.max(self.pending_chunks);
            Ok(())
        }

        fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
            self.pending_payload_bytes = self.pending_payload_bytes.saturating_add(payload.len());
            self.max_pending_payload_bytes = self
                .max_pending_payload_bytes
                .max(self.pending_payload_bytes);
            self.pending_payload_bytes = self.pending_payload_bytes.saturating_sub(payload.len());
            self.pending_chunks = self.pending_chunks.saturating_sub(1);
            Ok(())
        }

        fn send_aggregate(&mut self, _packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
            Ok(())
        }

        fn send_terminal(
            &mut self,
            _completion: &GraphDataCompletion,
        ) -> Result<(), GraphSinkError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct OrderingSink {
        events: Vec<&'static str>,
    }

    impl GraphChunkSink for OrderingSink {
        fn send_header(&mut self, _header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            self.events.push("header");
            Ok(())
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), GraphSinkError> {
            self.events.push("payload");
            Ok(())
        }

        fn send_aggregate(&mut self, _packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
            self.events.push("aggregate");
            Ok(())
        }

        fn send_terminal(
            &mut self,
            _completion: &GraphDataCompletion,
        ) -> Result<(), GraphSinkError> {
            self.events.push("complete");
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        header_count: usize,
        payload_count: usize,
        aggregate_packets: Vec<GraphAggregatePacket>,
        terminal_completion: Option<GraphDataCompletion>,
    }

    impl GraphChunkSink for RecordingSink {
        fn send_header(&mut self, _header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            self.header_count = self.header_count.saturating_add(1);
            Ok(())
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), GraphSinkError> {
            self.payload_count = self.payload_count.saturating_add(1);
            Ok(())
        }

        fn send_aggregate(&mut self, packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
            self.aggregate_packets.push(packet.clone());
            Ok(())
        }

        fn send_terminal(
            &mut self,
            completion: &GraphDataCompletion,
        ) -> Result<(), GraphSinkError> {
            self.terminal_completion = Some(completion.clone());
            Ok(())
        }
    }

    struct ClosedSink;

    impl GraphChunkSink for ClosedSink {
        fn send_header(&mut self, _header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }

        fn send_aggregate(&mut self, _packet: &GraphAggregatePacket) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }

        fn send_terminal(
            &mut self,
            _completion: &GraphDataCompletion,
        ) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }
    }

    #[test]
    fn stream_with_sink_emits_first_chunk_before_all_rows_and_bounds_inflight_payload() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "bounded-stream", 300_000);

        let service = GraphDataService::new(&state);
        let mut request = build_request("bounded-stream", 0);
        request.elements = vec![GraphElementRequest {
            kind: "line".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
        }];
        let mut sink = BoundedSink::default();

        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("stream completion");

        assert!(!completion.cancelled);
        assert_eq!(completion.processed_rows, 300_000);
        assert!(completion.chunks_sent > 1);

        let first_processed = sink
            .first_header_processed_rows
            .expect("expected at least one header event");
        let first_source = sink
            .first_header_source_rows
            .expect("expected source row metadata on first header");
        assert!(first_processed < first_source);
        assert!(sink.max_pending_chunks <= 1);
        assert!(sink.max_pending_payload_bytes <= INITIAL_PAYLOAD_BUDGET_BYTES);
    }

    #[test]
    fn stream_with_sink_normal_curve_only_omits_raw_chunks() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "normal-curve-only", 128);
        let service = GraphDataService::new(&state);
        let mut request = build_request("normal-curve-only", 0);
        request.fields = vec![GraphFieldBinding {
            role: "y".to_string(),
            column: "cost".to_string(),
        }];
        request.elements = vec![GraphElementRequest {
            kind: "normalCurve".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
        }];
        let mut sink = RecordingSink::default();

        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("normal curve stream completion");

        assert_eq!(sink.header_count, 0);
        assert_eq!(sink.payload_count, 0);
        assert_eq!(sink.aggregate_packets.len(), 1);
        assert!(matches!(
            sink.aggregate_packets.first(),
            Some(GraphAggregatePacket::Summary(_))
        ));
        assert_eq!(completion.chunks_sent, 0);
        assert!(matches!(
            completion.raw_point_disposition,
            GraphRawPointDisposition::Empty { .. }
        ));
    }

    #[test]
    fn stream_with_sink_respects_pre_start_cancellation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "prestart-cancel", 128);

        let service = GraphDataService::new(&state);
        let request = build_request("prestart-cancel", 0);
        service.cancel(&request.request_id).expect("cancel request");

        let mut sink = OrderingSink::default();
        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("prestart cancellation should be observed");

        assert!(completion.cancelled);
        assert_eq!(completion.processed_rows, 0);
        assert_eq!(completion.chunks_sent, 0);
        assert_eq!(sink.events, vec!["complete"]);
    }

    #[test]
    fn stream_with_sink_short_circuits_when_aggregate_collection_is_cancelled() {
        let state = AppState::new().expect("state");
        let service = GraphDataService::new(&state);
        let request = build_request("prestart-cancel", 0);
        let mut sink = OrderingSink::default();

        let completion = service
            .emit_aggregate_cancelled_terminal_for_test(&request, &mut sink)
            .expect("aggregate cancellation completion");

        assert!(completion.cancelled);
        assert_eq!(completion.source_rows, 0);
        assert_eq!(completion.processed_rows, 0);
        assert_eq!(completion.chunks_sent, 0);
        assert_eq!(sink.events, vec!["complete"]);
    }

    #[test]
    fn stream_with_sink_orders_all_raw_chunks_before_aggregate_then_terminal() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "ordered-events", 300_000);

        let service = GraphDataService::new(&state);
        let mut request = build_request("ordered-events", 0);
        request.elements = vec![
            GraphElementRequest {
                kind: "line".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            },
            GraphElementRequest {
                kind: "histogram".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: None,
            },
        ];
        let mut sink = OrderingSink::default();

        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("stream completion");
        assert!(!completion.cancelled);
        assert!(!sink.events.is_empty());
        assert_eq!(sink.events.last().copied(), Some("complete"));
        let terminal_index = sink.events.len() - 1;
        let first_aggregate = sink
            .events
            .iter()
            .position(|event| *event == "aggregate")
            .expect("expected at least one aggregate event");

        let raw_events = &sink.events[..first_aggregate];
        assert!(raw_events.len() >= 4);
        assert_eq!(raw_events.len() % 2, 0);
        for pair in raw_events.chunks(2) {
            assert_eq!(pair[0], "header");
            assert_eq!(pair[1], "payload");
        }

        let aggregate_events = &sink.events[first_aggregate..terminal_index];
        assert!(!aggregate_events.is_empty());
        assert!(aggregate_events.iter().all(|event| *event == "aggregate"));
    }

    #[test]
    fn stream_with_sink_correlation_only_request_skips_projection_and_commits_aggregate_terminal() {
        let state = AppState::new().expect("state");
        let dataset_id = "stream-correlation-only";
        {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                dataset_id,
                "Stream Correlation Only",
                &["a".into(), "b".into(), "c".into()],
                &["DOUBLE".into(), "DOUBLE".into(), "DOUBLE".into()],
            )
            .expect("create correlation table");
            let table = format!("dataset_{}", dataset_id.replace('-', "_"));
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO \"{table}\" (_row_id, a, b, c) VALUES
                         (1, 1.0, 2.0, 3.0),
                         (2, 2.0, 4.0, 2.0),
                         (3, 3.0, 6.0, 1.0),
                         (4, 4.0, 8.0, 0.0)"
                    ),
                    [],
                )
                .expect("insert correlation rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 4 WHERE id = $1",
                    params![dataset_id],
                )
                .expect("update row count");
        }

        let service = GraphDataService::new(&state);
        let request = GraphDataRequest {
            request_id: format!("request-{dataset_id}-correlation-only-stream"),
            dataset_id: dataset_id.to_string(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "multiY0".to_string(),
                    column: "a".to_string(),
                },
                GraphFieldBinding {
                    role: "multiY1".to_string(),
                    column: "b".to_string(),
                },
                GraphFieldBinding {
                    role: "multiY2".to_string(),
                    column: "c".to_string(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "correlationMatrix".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: Some(crate::models::graph_data::CorrelationMethod::Spearman),
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        };

        let mut sink = RecordingSink::default();
        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("correlation-only stream completion");

        assert_eq!(sink.header_count, 0);
        assert_eq!(sink.payload_count, 0);
        assert_eq!(sink.aggregate_packets.len(), 1);
        assert!(matches!(
            sink.aggregate_packets.first(),
            Some(GraphAggregatePacket::CorrelationMatrix(_))
        ));

        let terminal = sink
            .terminal_completion
            .clone()
            .expect("terminal completion must be emitted");
        assert!(!terminal.cancelled);
        assert_eq!(terminal.chunks_sent, 0);
        assert_eq!(completion, terminal);
    }

    #[test]
    fn stream_with_sink_correlation_only_request_rejects_stale_generation() {
        let state = AppState::new().expect("state");
        let dataset_id = "stream-correlation-only-stale";
        {
            let db = state.db.lock().expect("db lock");
            db.create_empty_table(
                dataset_id,
                "Stream Correlation Only Stale",
                &["a".into(), "b".into(), "c".into()],
                &["DOUBLE".into(), "DOUBLE".into(), "DOUBLE".into()],
            )
            .expect("create correlation table");
            let table = format!("dataset_{}", dataset_id.replace('-', "_"));
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO \"{table}\" (_row_id, a, b, c) VALUES
                         (1, 1.0, 2.0, 3.0),
                         (2, 2.0, 4.0, 2.0),
                         (3, 3.0, 6.0, 1.0),
                         (4, 4.0, 8.0, 0.0)"
                    ),
                    [],
                )
                .expect("insert correlation rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 4, generation = 1 WHERE id = $1",
                    params![dataset_id],
                )
                .expect("update row count and generation");
        }

        let service = GraphDataService::new(&state);
        let request = GraphDataRequest {
            request_id: format!("request-{dataset_id}-correlation-only-stream"),
            dataset_id: dataset_id.to_string(),
            generation: 0,
            fields: vec![
                GraphFieldBinding {
                    role: "multiY0".to_string(),
                    column: "a".to_string(),
                },
                GraphFieldBinding {
                    role: "multiY1".to_string(),
                    column: "b".to_string(),
                },
                GraphFieldBinding {
                    role: "multiY2".to_string(),
                    column: "c".to_string(),
                },
            ],
            filters: Vec::new(),
            elements: vec![GraphElementRequest {
                kind: "correlationMatrix".to_string(),
                summary_stat: "none".to_string(),
                correlation_method: Some(crate::models::graph_data::CorrelationMethod::Spearman),
            }],
            sampling: GraphSampling::Full,
            raw_point_budget: GRAPH_SCATTER_RENDER_BUDGET,
            viewport: GraphViewport {
                width: 1200,
                height: 700,
            },
        };

        let mut sink = RecordingSink::default();
        let error = service
            .stream_with_sink(&request, &mut sink)
            .expect_err("stale generation must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation"))
        );
    }

    #[test]
    fn stream_with_sink_maps_closed_sink_to_invalid_param() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "closed-sink", 8);

        let service = GraphDataService::new(&state);
        let request = build_request("closed-sink", 0);
        let mut sink = ClosedSink;

        let error = service
            .stream_with_sink(&request, &mut sink)
            .expect_err("closed sink should fail");
        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("graph data channel closed"))
        );
    }

    #[test]
    fn stream_with_sink_without_metrics_does_not_start_timing_observation() {
        reset_timing_observation_starts();

        let state = AppState::new().expect("state");
        seed_dataset(&state, "no-observe-clock", 64);

        let service = GraphDataService::new(&state);
        let request = build_request("no-observe-clock", 0);
        let mut sink = OrderingSink::default();

        let completion = service
            .stream_with_sink_observed(&request, &mut sink, None)
            .expect("stream completion");

        assert!(!completion.cancelled);
        assert_eq!(completion.processed_rows, 64);
        assert_eq!(timing_observation_starts(), 0);
    }
}

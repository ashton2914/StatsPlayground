use std::collections::BTreeSet;
use std::time::Instant;

use duckdb::params;
use serde::Serialize;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
#[cfg(test)]
use crate::models::graph_data::{GraphAggregatePacket, GraphChunkHeader, GraphDataCompletion};
use crate::models::graph_data::{
    GraphDataRequest, GraphElementRequest, GraphFieldBinding, GraphRawPointDisposition,
    GraphSampling, GraphTimeSeriesConnection, GraphTimeSeriesDisposition,
    GraphTimeSeriesMarkerMode, GraphTimeSeriesMissingValues, GraphTimeSeriesOrder, GraphViewport,
    TimeSeriesXInterpretation,
};
use crate::models::save::SaveProjectRequest;
use crate::services::calculated_column_service::{
    CalculatedColumnService, UpsertCalculatedColumnInput,
};
#[cfg(test)]
use crate::services::graph_data_service::GraphDataChunk;
use crate::services::graph_data_service::GraphDataService;
use crate::services::project_service::{seed_save_project, ProjectService};
use crate::services::spprj_archive;
use crate::services::streaming_project_writer::with_save_perf_observer;
use crate::services::table_mutation_coordinator::{execute_table_mutation, TableMutationEffects};
use crate::state::AppState;

const DEFAULT_CALCULATED_CHAIN_DEPTH: usize = 5;
const CALCULATED_MEDIAN_THRESHOLD_MS: u128 = 2_000;
const CALCULATED_MEMORY_GROWTH_BUDGET_MULTIPLIER: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Query,
    Paste,
    Restore,
    Graph,
    TimeSeriesGraph,
    Save,
    Datalink,
    Calculated,
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    rows: usize,
    columns: usize,
    operation: Operation,
    chain_depth: usize,
    runs: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceReport {
    rows: usize,
    columns: usize,
    operation: Operation,
    setup_ms: u128,
    operation_ms: u128,
    total_ms: u128,
    result_rows: usize,
    selected_columns: usize,
    query_ms: Option<u128>,
    encode_ms: Option<u128>,
    decode_ms: Option<DesktopOnlyMetric>,
    draw_ms: Option<DesktopOnlyMetric>,
    processed_rows: Option<u64>,
    source_rows: Option<u64>,
    chunks: Option<u32>,
    transferred_bytes: Option<u64>,
    projection_passes: Option<u32>,
    invalid_x_count: Option<u64>,
    archive_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_retained_batch_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_encoded_batch_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_combined_batch_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    save_stage_ms: Option<SaveStageReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_memory: Option<ProcessMemoryReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chain_depth: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runs_ms: Option<Vec<u128>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    median_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_memory_method: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    physical_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calculated_result_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_budget_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_growth_budget_multiplier: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qualification_passed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qualification_failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    machine: Option<MachineReport>,
}

impl PerformanceReport {
    fn qualification_failure(&self) -> Option<&str> {
        self.qualification_failure.as_deref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopOnlyMetric {
    DesktopOnly,
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamHeaderMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    header: &'a GraphChunkHeader,
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamCompletionMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    completion: &'a GraphDataCompletion,
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamAggregateMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    packet: &'a GraphAggregatePacket,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveStageReport {
    plan: u128,
    query_fetch: u128,
    batch_encode: u128,
    zip_write: u128,
    zip_finish: u128,
    sync_all: u128,
    validation: u128,
    replacement: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemoryReport {
    baseline_working_set_bytes: u64,
    peak_working_set_bytes: u64,
    delta_working_set_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineReport {
    os: String,
    arch: String,
    cpu: String,
    physical_memory_bytes: Option<u64>,
    app_version: String,
    duckdb_version: String,
}

#[cfg(windows)]
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut core::ffi::c_void;
}

#[cfg(windows)]
#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCounters,
        counters_size: u32,
    ) -> i32;
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcTaskInfo {
    virtual_size: u64,
    resident_size: u64,
    total_user: u64,
    total_system: u64,
    threads_user: u64,
    threads_system: u64,
    policy: i32,
    faults: i32,
    pageins: i32,
    cow_faults: i32,
    messages_sent: i32,
    messages_received: i32,
    syscalls_mach: i32,
    syscalls_unix: i32,
    csw: i32,
    threadnum: i32,
    numrunning: i32,
    priority: i32,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut core::ffi::c_void,
        buffersize: i32,
    ) -> i32;
}

fn process_memory_method() -> Option<&'static str> {
    #[cfg(windows)]
    {
        Some("GetProcessMemoryInfo working_set_size")
    }
    #[cfg(target_os = "macos")]
    {
        Some("proc_pidinfo PROC_PIDTASKINFO resident_size")
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

fn current_working_set_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        let process = unsafe { GetCurrentProcess() };
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let ok = unsafe {
            GetProcessMemoryInfo(
                process,
                &mut counters,
                std::mem::size_of::<ProcessMemoryCounters>() as u32,
            )
        };
        if ok == 0 {
            None
        } else {
            Some(counters.working_set_size as u64)
        }
    }
    #[cfg(target_os = "macos")]
    {
        const PROC_PIDTASKINFO: i32 = 4;
        let mut info = ProcTaskInfo {
            virtual_size: 0,
            resident_size: 0,
            total_user: 0,
            total_system: 0,
            threads_user: 0,
            threads_system: 0,
            policy: 0,
            faults: 0,
            pageins: 0,
            cow_faults: 0,
            messages_sent: 0,
            messages_received: 0,
            syscalls_mach: 0,
            syscalls_unix: 0,
            csw: 0,
            threadnum: 0,
            numrunning: 0,
            priority: 0,
        };
        let expected_size = std::mem::size_of::<ProcTaskInfo>();
        let actual_size = unsafe {
            proc_pidinfo(
                std::process::id() as i32,
                PROC_PIDTASKINFO,
                0,
                (&mut info as *mut ProcTaskInfo).cast(),
                expected_size as i32,
            )
        };
        if actual_size == expected_size as i32 {
            Some(info.resident_size)
        } else {
            None
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

fn measure_peak_working_set_during<T>(run: impl FnOnce() -> T) -> (T, Option<ProcessMemoryReport>) {
    let Some(baseline) = current_working_set_bytes() else {
        let outcome = run();
        return (outcome, None);
    };

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(baseline));
    let stop_reader = std::sync::Arc::clone(&stop);
    let peak_reader = std::sync::Arc::clone(&peak);
    let sampler = std::thread::spawn(move || {
        while !stop_reader.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(current) = current_working_set_bytes() {
                let mut seen = peak_reader.load(std::sync::atomic::Ordering::Relaxed);
                while current > seen {
                    match peak_reader.compare_exchange_weak(
                        seen,
                        current,
                        std::sync::atomic::Ordering::Relaxed,
                        std::sync::atomic::Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(next_seen) => seen = next_seen,
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if let Some(current) = current_working_set_bytes() {
            let mut seen = peak_reader.load(std::sync::atomic::Ordering::Relaxed);
            while current > seen {
                match peak_reader.compare_exchange_weak(
                    seen,
                    current,
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(next_seen) => seen = next_seen,
                }
            }
        }
    });

    let outcome = run();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = sampler.join();

    let peak_working_set_bytes = peak.load(std::sync::atomic::Ordering::Relaxed);
    let delta_working_set_bytes = peak_working_set_bytes.saturating_sub(baseline);
    (
        outcome,
        Some(ProcessMemoryReport {
            baseline_working_set_bytes: baseline,
            peak_working_set_bytes,
            delta_working_set_bytes,
        }),
    )
}

fn parse_positive_usize(flag: &str, value: Option<String>) -> Result<usize, AppError> {
    let value = value.ok_or_else(|| AppError::InvalidParam(format!("missing value for {flag}")))?;
    let parsed = value
        .parse::<usize>()
        .map_err(|_| AppError::InvalidParam(format!("invalid value for {flag}: {value}")))?;
    if parsed == 0 {
        return Err(AppError::InvalidParam(format!("{flag} must be at least 1")));
    }
    Ok(parsed)
}

fn parse_args<I>(args: I) -> Result<Options, AppError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = Options {
        rows: 100_000,
        columns: 20,
        operation: Operation::Query,
        chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
        runs: 1,
    };
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--rows" => options.rows = parse_positive_usize(&flag, args.next())?,
            "--columns" => options.columns = parse_positive_usize(&flag, args.next())?,
            "--chain-depth" => options.chain_depth = parse_positive_usize(&flag, args.next())?,
            "--runs" => options.runs = parse_positive_usize(&flag, args.next())?,
            "--operation" => {
                let value = args.next().ok_or_else(|| {
                    AppError::InvalidParam("missing value for --operation".into())
                })?;
                options.operation = match value.as_str() {
                    "query" => Operation::Query,
                    "paste" => Operation::Paste,
                    "restore" => Operation::Restore,
                    "graph" => Operation::Graph,
                    "time-series-graph" | "time_series_graph" => Operation::TimeSeriesGraph,
                    "save" => Operation::Save,
                    "datalink" => Operation::Datalink,
                    "calculated" => Operation::Calculated,
                    _ => {
                        return Err(AppError::InvalidParam(format!(
                            "unknown operation: {value}"
                        )))
                    }
                };
            }
            _ => return Err(AppError::InvalidParam(format!("unknown argument: {flag}"))),
        }
    }
    Ok(options)
}

fn build_graph_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
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
            time_series: None,
        }],
        sampling: GraphSampling::Full,
        raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
        viewport: GraphViewport {
            width: 1200,
            height: 700,
        },
    }
}

fn build_time_series_graph_request(
    dataset_id: &str,
    generation: u64,
    series_count: usize,
) -> GraphDataRequest {
    let mut fields = vec![
        GraphFieldBinding {
            role: "x".to_string(),
            column: "captured_at".to_string(),
        },
        GraphFieldBinding {
            role: "y".to_string(),
            column: "reading_1".to_string(),
        },
    ];
    if series_count > 1 {
        for index in 0..series_count {
            fields.push(GraphFieldBinding {
                role: format!("multiY{index}"),
                column: format!("reading_{}", index + 1),
            });
        }
    }

    GraphDataRequest {
        request_id: format!("request-{dataset_id}"),
        dataset_id: dataset_id.to_string(),
        generation,
        fields,
        filters: Vec::new(),
        elements: vec![GraphElementRequest {
            kind: "timeSeries".to_string(),
            summary_stat: "none".to_string(),
            correlation_method: None,
            time_series: Some(crate::models::graph_data::GraphTimeSeriesRequest {
                x_interpretation: TimeSeriesXInterpretation::NativeTemporal,
                order: GraphTimeSeriesOrder::TimeAscending,
                missing_values: GraphTimeSeriesMissingValues::Break,
                marker_mode: GraphTimeSeriesMarkerMode::Auto,
                connection: GraphTimeSeriesConnection::Line,
            }),
        }],
        sampling: GraphSampling::Full,
        raw_point_budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
        viewport: GraphViewport {
            width: 1200,
            height: 700,
        },
    }
}

fn seed_graph_benchmark_dataset(
    state: &AppState,
    dataset_id: &str,
    rows: usize,
) -> Result<(), AppError> {
    let db = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    db.create_empty_table(
        dataset_id,
        "Performance Graph Baseline",
        &["region".into(), "cost".into()],
        &["VARCHAR".into(), "DOUBLE".into()],
    )?;

    if rows > 0 {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let upper_bound = i64::try_from(rows)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| AppError::InvalidParam("benchmark row count is too large".into()))?;
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
        db.conn().execute(&insert_sql, params![upper_bound])?;
        db.conn().execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![rows as i64, dataset_id],
        )?;
    }

    Ok(())
}

fn seed_time_series_benchmark_dataset(
    state: &AppState,
    dataset_id: &str,
    rows: usize,
    series_count: usize,
) -> Result<(), AppError> {
    let db = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let mut column_names = vec!["captured_at".to_string()];
    let mut column_types = vec!["DATE".to_string()];
    for index in 0..series_count {
        column_names.push(format!("reading_{}", index + 1));
        column_types.push("DOUBLE".to_string());
    }
    db.create_empty_table(
        dataset_id,
        "Performance Time Series Baseline",
        &column_names,
        &column_types,
    )?;

    if rows > 0 {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let upper_bound = i64::try_from(rows)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| AppError::InvalidParam("benchmark row count is too large".into()))?;
        let reading_columns = (0..series_count)
            .map(|index| format!("reading_{}", index + 1))
            .collect::<Vec<_>>();
        let reading_exprs = (0..series_count)
            .map(|index| {
                format!(
                    "CASE WHEN i % 100 = 0 THEN NULL ELSE CAST(i AS DOUBLE) * {}.0 END",
                    index + 1
                )
            })
            .collect::<Vec<_>>();
        let insert_sql = format!(
            "INSERT INTO \"{table_name}\" (_row_id, captured_at, {})
             SELECT i,
                DATE '2026-01-01' + CAST(((i - 1) / 2) AS INTEGER),
                {}
             FROM range(1, CAST(? AS BIGINT)) AS generated(i)",
            reading_columns.join(", "),
            reading_exprs.join(", ")
        );
        db.conn().execute(&insert_sql, params![upper_bound])?;
        db.conn().execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![rows as i64, dataset_id],
        )?;
    }

    Ok(())
}

fn invalid_time_series_x_count(disposition: &Option<GraphTimeSeriesDisposition>) -> u64 {
    match disposition {
        Some(GraphTimeSeriesDisposition::Included { invalid_x_rows, .. })
        | Some(GraphTimeSeriesDisposition::InvalidTimeSeriesX { invalid_x_rows, .. }) => {
            *invalid_x_rows
        }
        None => 0,
    }
}

#[cfg(test)]
fn measure_transferred_bytes(
    chunks: &[GraphDataChunk],
    aggregates: &[GraphAggregatePacket],
    completion: &GraphDataCompletion,
) -> Result<u64, AppError> {
    let mut transferred = 0u64;
    for chunk in chunks {
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
        transferred =
            transferred
                .checked_add(u64::try_from(chunk.payload.len()).map_err(|_| {
                    AppError::InvalidParam("graph payload length overflow".to_string())
                })?)
                .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
    }

    for packet in aggregates {
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
        completion,
    };
    let terminal_bytes = serde_json::to_vec(&terminal_message)
        .map_err(|error| AppError::InvalidParam(error.to_string()))?;
    transferred =
        transferred
            .checked_add(u64::try_from(terminal_bytes.len()).map_err(|_| {
                AppError::InvalidParam("terminal payload length overflow".to_string())
            })?)
            .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;

    Ok(transferred)
}

fn execute_graph(options: Options, total_started: Instant) -> Result<PerformanceReport, AppError> {
    if options.columns < 2 {
        return Err(AppError::InvalidParam(
            "graph requires at least 2 columns".into(),
        ));
    }

    let setup_started = Instant::now();
    let state = AppState::new()?;
    let dataset_id = "performance-graph-baseline";
    seed_graph_benchmark_dataset(&state, dataset_id, options.rows)?;
    let generation = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.get_dataset_generation(dataset_id)?
    };
    let request = build_graph_request(dataset_id, generation);
    let setup_ms = setup_started.elapsed().as_millis();

    let expected_rows = u64::try_from(options.rows)
        .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?;
    let service = GraphDataService::new(&state);
    let capture = service.collect_benchmark_result(&request)?;
    let completion = capture.completion;
    let operation_ms = capture.operation_ms;

    if completion.processed_rows != expected_rows {
        return Err(AppError::InvalidParam(format!(
            "graph service processed_rows mismatch: expected {expected_rows}, got {}",
            completion.processed_rows
        )));
    }
    if capture.projection_passes != 1 {
        return Err(AppError::InvalidParam(format!(
            "graph projection pass mismatch: expected 1, got {}",
            capture.projection_passes
        )));
    }
    let selected_columns = capture.selected_columns;
    let raw_points_included = matches!(
        completion.raw_point_disposition,
        GraphRawPointDisposition::Included { .. }
    );
    let expected_selected_columns = if raw_points_included { 3 } else { 0 };
    if selected_columns != expected_selected_columns {
        return Err(AppError::InvalidParam(format!(
            "graph service selected column mismatch: expected {expected_selected_columns}, got {selected_columns}"
        )));
    }
    let expected_projected_columns = if raw_points_included {
        vec![
            "_row_id".to_string(),
            "region".to_string(),
            "cost".to_string(),
        ]
    } else {
        Vec::new()
    };
    if capture.projected_columns != expected_projected_columns {
        return Err(AppError::InvalidParam(format!(
            "graph projected columns mismatch: expected {:?}, got {:?}",
            expected_projected_columns, capture.projected_columns
        )));
    }

    let query_ms = capture.query_ms;
    let encode_ms = capture.encode_ms;
    let transferred_bytes = capture.transferred_bytes;

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows: usize::try_from(completion.processed_rows).map_err(|_| {
            AppError::InvalidParam("graph processed row count does not fit usize".to_string())
        })?,
        selected_columns,
        query_ms: Some(query_ms),
        encode_ms: Some(encode_ms),
        decode_ms: Some(DesktopOnlyMetric::DesktopOnly),
        draw_ms: Some(DesktopOnlyMetric::DesktopOnly),
        processed_rows: Some(completion.processed_rows),
        source_rows: Some(completion.source_rows),
        chunks: Some(capture.chunks),
        transferred_bytes: Some(transferred_bytes),
        projection_passes: Some(capture.projection_passes),
        invalid_x_count: Some(invalid_time_series_x_count(
            &completion.time_series_disposition,
        )),
        archive_bytes: 0,
        max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory: None,
        chain_depth: None,
        runs_ms: None,
        median_ms: None,
        process_memory_method: None,
        physical_input_bytes: None,
        calculated_result_bytes: None,
        memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: None,
        qualification_failure: None,
        machine: None,
    })
}

fn execute_time_series_graph(
    options: Options,
    total_started: Instant,
) -> Result<PerformanceReport, AppError> {
    let series_count = options.columns.clamp(1, 4);
    if options.rows % series_count != 0 {
        return Err(AppError::InvalidParam(format!(
            "time series benchmark rows must divide evenly across {series_count} series"
        )));
    }
    let physical_rows = options.rows / series_count;
    let setup_started = Instant::now();
    let state = AppState::new()?;
    let dataset_id = "performance-time-series-baseline";
    seed_time_series_benchmark_dataset(&state, dataset_id, physical_rows, series_count)?;
    let generation = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.get_dataset_generation(dataset_id)?
    };
    let request = build_time_series_graph_request(dataset_id, generation, series_count);
    let setup_ms = setup_started.elapsed().as_millis();

    let expected_rows = u64::try_from(options.rows)
        .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?;
    let service = GraphDataService::new(&state);
    let capture = service.collect_benchmark_result(&request)?;
    let completion = capture.completion;
    let operation_ms = capture.operation_ms;

    if completion.source_rows != expected_rows {
        return Err(AppError::InvalidParam(format!(
            "time series source_rows mismatch: expected {expected_rows}, got {}",
            completion.source_rows
        )));
    }
    if completion.processed_rows != expected_rows {
        return Err(AppError::InvalidParam(format!(
            "time series processed_rows mismatch: expected {expected_rows}, got {}",
            completion.processed_rows
        )));
    }
    if capture.projection_passes != 1 {
        return Err(AppError::InvalidParam(format!(
            "time series projection pass mismatch: expected 1, got {}",
            capture.projection_passes
        )));
    }

    Ok(PerformanceReport {
        rows: options.rows,
        columns: series_count,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows: usize::try_from(completion.processed_rows).map_err(|_| {
            AppError::InvalidParam("time series processed row count does not fit usize".to_string())
        })?,
        selected_columns: capture.selected_columns,
        query_ms: Some(capture.query_ms),
        encode_ms: Some(capture.encode_ms),
        decode_ms: Some(DesktopOnlyMetric::DesktopOnly),
        draw_ms: Some(DesktopOnlyMetric::DesktopOnly),
        processed_rows: Some(completion.processed_rows),
        source_rows: Some(completion.source_rows),
        chunks: Some(capture.chunks),
        transferred_bytes: Some(capture.transferred_bytes),
        projection_passes: Some(capture.projection_passes),
        invalid_x_count: Some(invalid_time_series_x_count(
            &completion.time_series_disposition,
        )),
        archive_bytes: 0,
        max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory: None,
        chain_depth: None,
        runs_ms: None,
        median_ms: None,
        process_memory_method: None,
        physical_input_bytes: None,
        calculated_result_bytes: None,
        memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: None,
        qualification_failure: None,
        machine: None,
    })
}

fn execute(options: Options) -> Result<PerformanceReport, AppError> {
    if options.operation == Operation::Save {
        return execute_save(options);
    }
    if options.operation == Operation::Datalink {
        return execute_datalink(options);
    }
    if options.operation == Operation::Calculated {
        return execute_calculated(options);
    }

    let total_started = Instant::now();
    if options.operation == Operation::Graph {
        return execute_graph(options, total_started);
    }
    if options.operation == Operation::TimeSeriesGraph {
        return execute_time_series_graph(options, total_started);
    }

    let setup_started = Instant::now();
    let db = DuckDbEngine::new_in_memory()?;
    db.seed_benchmark_table(
        "performance-baseline",
        "Performance Baseline",
        options.rows,
        options.columns,
    )?;
    let setup_ms = setup_started.elapsed().as_millis();

    let operation_started = Instant::now();
    let (result_rows, selected_columns) = match options.operation {
        Operation::Query => (
            db.query_table("performance-baseline", 0, 500, None, None)?
                .rows
                .len(),
            0,
        ),
        Operation::Paste => {
            let paste_columns = options.columns.min(10);
            let rows = (0..options.rows)
                .map(|row| {
                    (0..paste_columns)
                        .map(|column| (row + column).to_string())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            db.paste_at_position(
                "performance-baseline",
                0,
                0,
                &rows,
                None,
                &vec!["BIGINT".to_string(); paste_columns],
            )?;
            (rows.len(), 0)
        }
        Operation::Restore => {
            let snapshot = db.query_table("performance-baseline", 0, options.rows, None, None)?;
            db.restore_snapshot(
                "performance-baseline",
                &snapshot.columns[1..],
                &snapshot.column_types[1..],
                &snapshot.rows,
            )?;
            (snapshot.rows.len(), 0)
        }
        Operation::Graph => unreachable!("graph operation is handled by execute_graph"),
        Operation::TimeSeriesGraph => {
            unreachable!("time series graph operation is handled by execute_time_series_graph")
        }
        Operation::Save => unreachable!("save is handled before this branch"),
        Operation::Datalink => unreachable!("datalink is handled before this branch"),
        Operation::Calculated => unreachable!("calculated is handled before this branch"),
    };
    let operation_ms = operation_started.elapsed().as_millis();

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows,
        selected_columns,
        query_ms: None,
        encode_ms: None,
        decode_ms: None,
        draw_ms: None,
        processed_rows: None,
        source_rows: None,
        chunks: None,
        transferred_bytes: None,
        projection_passes: None,
        invalid_x_count: None,
        archive_bytes: 0,
        max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory: None,
        chain_depth: None,
        runs_ms: None,
        median_ms: None,
        process_memory_method: None,
        physical_input_bytes: None,
        calculated_result_bytes: None,
        memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: None,
        qualification_failure: None,
        machine: None,
    })
}

fn execute_calculated(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    let setup_started = Instant::now();
    let state = AppState::new()?;
    let dataset_id = "performance-calculated-baseline";
    {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.seed_benchmark_table(
            dataset_id,
            "Performance Calculated Baseline",
            options.rows,
            options.columns,
        )?;
    }
    seed_calculated_chain(&state, dataset_id, options.chain_depth)?;
    mutate_calculated_source_column(&state, dataset_id, 0)?;
    validate_calculated_chain_outputs(&state, dataset_id, options.chain_depth)?;
    let setup_ms = setup_started.elapsed().as_millis();

    let mut runs_ms = Vec::with_capacity(options.runs);
    let mut process_memory = None;
    for run_index in 0..options.runs {
        let run_started = Instant::now();
        let (run_result, run_memory) = measure_peak_working_set_during(|| {
            mutate_calculated_source_column(&state, dataset_id, run_index + 1)?;
            validate_calculated_chain_outputs(&state, dataset_id, options.chain_depth)?;
            Ok::<_, AppError>(())
        });
        run_result?;
        runs_ms.push(run_started.elapsed().as_millis());
        process_memory = merge_peak_memory_reports(process_memory, run_memory);
    }
    let median_ms = median(&runs_ms).ok_or_else(|| {
        AppError::InvalidParam("calculated benchmark requires at least one run".into())
    })?;
    let physical_input_bytes = estimate_physical_input_bytes(options.rows, options.columns)?;
    let calculated_result_bytes =
        estimate_calculated_result_bytes(options.rows, options.chain_depth)?;
    let memory_budget_bytes = physical_input_bytes
        .checked_add(calculated_result_bytes)
        .and_then(|bytes| bytes.checked_mul(CALCULATED_MEMORY_GROWTH_BUDGET_MULTIPLIER))
        .ok_or_else(|| AppError::InvalidParam("calculated memory budget overflow".into()))?;
    let qualification_failure =
        calculated_qualification_failure(median_ms, process_memory.as_ref(), memory_budget_bytes);
    let duckdb_version = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        duckdb_version(&db)
    };

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms: median_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows: options.rows,
        selected_columns: options.chain_depth,
        query_ms: None,
        encode_ms: None,
        decode_ms: None,
        draw_ms: None,
        processed_rows: Some(
            u64::try_from(options.rows)
                .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?,
        ),
        source_rows: None,
        chunks: None,
        transferred_bytes: None,
        projection_passes: None,
        invalid_x_count: None,
        archive_bytes: 0,
        max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory,
        chain_depth: Some(options.chain_depth),
        runs_ms: Some(runs_ms),
        median_ms: Some(median_ms),
        process_memory_method: process_memory_method(),
        physical_input_bytes: Some(physical_input_bytes),
        calculated_result_bytes: Some(calculated_result_bytes),
        memory_budget_bytes: Some(memory_budget_bytes),
        memory_growth_budget_multiplier: Some(CALCULATED_MEMORY_GROWTH_BUDGET_MULTIPLIER),
        qualification_passed: Some(qualification_failure.is_none()),
        qualification_failure,
        machine: Some(machine_report(duckdb_version)),
    })
}

fn seed_calculated_chain(
    state: &AppState,
    dataset_id: &str,
    chain_depth: usize,
) -> Result<(), AppError> {
    let calculated = CalculatedColumnService::new(state);
    let mut dependency = "value_1".to_string();
    for level in 1..=chain_depth {
        let output_name = format!("calc_{level}");
        calculated.upsert(&UpsertCalculatedColumnInput {
            dataset_id: dataset_id.to_string(),
            output_name: output_name.clone(),
            formula_text: format!("{dependency} + {level}"),
            at_index: None,
            output_column_id: None,
            formula_id: None,
            expected_generation: None,
        })?;
        dependency = output_name;
    }
    Ok(())
}

fn mutate_calculated_source_column(
    state: &AppState,
    dataset_id: &str,
    offset: usize,
) -> Result<(), AppError> {
    let db = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let source_column_id = db
        .get_user_column_descriptors(dataset_id)?
        .into_iter()
        .find(|column| column.name == "value_1")
        .map(|column| column.column_id)
        .ok_or_else(|| AppError::Database("benchmark source column value_1 is missing".into()))?;
    let offset = i64::try_from(offset)
        .map_err(|_| AppError::InvalidParam("calculated mutation offset is too large".into()))?;
    execute_table_mutation(&db, dataset_id, None, |engine| {
        let table_name =
            DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
        engine.conn().execute(
            &format!("UPDATE {table_name} SET \"value_1\" = CAST(\"_row_id\" AS BIGINT) + $1"),
            params![offset],
        )?;
        Ok(TableMutationEffects {
            value: (),
            changed_column_ids: BTreeSet::from([source_column_id.clone()]),
            change_set_id: None,
            recompute_column_ids: None,
        })
    })
}

fn validate_calculated_chain_outputs(
    state: &AppState,
    dataset_id: &str,
    chain_depth: usize,
) -> Result<(), AppError> {
    let db = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    let mut cumulative = 0i64;
    for level in 1..=chain_depth {
        cumulative = cumulative
            .checked_add(i64::try_from(level).map_err(|_| {
                AppError::InvalidParam("calculated chain depth is too large".into())
            })?)
            .ok_or_else(|| AppError::InvalidParam("calculated chain sum overflow".into()))?;
        let column_name = DuckDbEngine::quote_identifier(&format!("calc_{level}"));
        let mismatches: i64 = db.conn().query_row(
            &format!(
                "SELECT COUNT(*) FROM {table_name} WHERE {column_name} IS DISTINCT FROM \"value_1\" + $1"
            ),
            params![cumulative],
            |row| row.get(0),
        )?;
        if mismatches != 0 {
            return Err(AppError::InvalidParam(format!(
                "calculated output calc_{level} mismatch count: {mismatches}"
            )));
        }
    }
    Ok(())
}

fn median(values: &[u128]) -> Option<u128> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

fn estimate_physical_input_bytes(rows: usize, columns: usize) -> Result<u64, AppError> {
    estimate_bytes(rows, columns)
}

fn merge_peak_memory_reports(
    existing: Option<ProcessMemoryReport>,
    next: Option<ProcessMemoryReport>,
) -> Option<ProcessMemoryReport> {
    match (existing, next) {
        (None, None) => None,
        (Some(report), None) | (None, Some(report)) => Some(report),
        (Some(existing), Some(next)) => {
            if next.delta_working_set_bytes > existing.delta_working_set_bytes {
                Some(next)
            } else {
                Some(existing)
            }
        }
    }
}

fn estimate_calculated_result_bytes(rows: usize, chain_depth: usize) -> Result<u64, AppError> {
    estimate_bytes(rows, chain_depth)
}

fn estimate_bytes(rows: usize, columns: usize) -> Result<u64, AppError> {
    let cells = rows
        .checked_mul(columns)
        .ok_or_else(|| AppError::InvalidParam("benchmark byte estimate overflow".into()))?;
    u64::try_from(cells)
        .ok()
        .and_then(|value| value.checked_mul(8))
        .ok_or_else(|| AppError::InvalidParam("benchmark byte estimate overflow".into()))
}

fn calculated_qualification_failure(
    median_ms: u128,
    process_memory: Option<&ProcessMemoryReport>,
    memory_budget_bytes: u64,
) -> Option<String> {
    if median_ms > CALCULATED_MEDIAN_THRESHOLD_MS {
        return Some(format!(
            "median {median_ms} ms exceeds {CALCULATED_MEDIAN_THRESHOLD_MS} ms threshold"
        ));
    }
    let Some(process_memory) = process_memory else {
        return Some("process memory measurement unavailable".to_string());
    };
    if process_memory.delta_working_set_bytes > memory_budget_bytes {
        return Some(format!(
            "working-set delta {} bytes exceeds {} byte budget",
            process_memory.delta_working_set_bytes, memory_budget_bytes
        ));
    }
    None
}

fn duckdb_version(db: &DuckDbEngine) -> String {
    db.conn()
        .query_row("SELECT version()", [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|error| format!("unknown ({error})"))
}

fn machine_report(duckdb_version: String) -> MachineReport {
    MachineReport {
        os: format!("{} {}", std::env::consts::OS, os_version()),
        arch: std::env::consts::ARCH.to_string(),
        cpu: cpu_brand(),
        physical_memory_bytes: physical_memory_bytes(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        duckdb_version,
    }
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        sysctl_string("kern.osproductversion").unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}

fn cpu_brand() -> String {
    #[cfg(target_os = "macos")]
    {
        sysctl_string("machdep.cpu.brand_string").unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}

fn physical_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        sysctl_u64("hw.memsize")
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn sysctl_string(name: &str) -> Option<String> {
    let mut size = 0usize;
    let name = std::ffi::CString::new(name).ok()?;
    let first = unsafe {
        sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if first != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    let second = unsafe {
        sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if second != 0 {
        return None;
    }
    buffer.truncate(size);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    String::from_utf8(buffer).ok()
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &str) -> Option<u64> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut value = 0u64;
    let mut size = std::mem::size_of::<u64>();
    let result = unsafe {
        sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result == 0 && size == std::mem::size_of::<u64>() {
        Some(value)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
#[link(name = "System")]
extern "C" {
    fn sysctlbyname(
        name: *const std::ffi::c_char,
        oldp: *mut core::ffi::c_void,
        oldlenp: *mut usize,
        newp: *mut core::ffi::c_void,
        newlen: usize,
    ) -> i32;
}

fn execute_datalink(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    let setup_started = Instant::now();
    let source_path = std::env::temp_dir().join(format!(
        "stats_playground_datalink_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let source_path_text = source_path.to_string_lossy().into_owned();
    let column_defs = (0..options.columns)
        .map(|column| match column % 4 {
            0 => format!("value_{column} INTEGER"),
            1 => format!("value_{column} REAL"),
            2 => format!("value_{column} TEXT"),
            _ => format!("value_{column} BLOB"),
        })
        .collect::<Vec<_>>();
    let value_exprs = (0..options.columns)
        .map(|column| match column % 4 {
            0 => "row_number".to_string(),
            1 => "CAST(row_number AS REAL) / 10.0".to_string(),
            2 => "printf('row-%d', row_number)".to_string(),
            _ => "CAST(printf('blob-%d', row_number) AS BLOB)".to_string(),
        })
        .collect::<Vec<_>>();
    let sqlite = rusqlite::Connection::open(&source_path)?;
    sqlite.execute(
        &format!("CREATE TABLE benchmark_data ({})", column_defs.join(", ")),
        [],
    )?;
    sqlite.execute(
        &format!(
            "WITH RECURSIVE source(row_number) AS (\
             SELECT 1 UNION ALL SELECT row_number + 1 FROM source WHERE row_number < ?1\
             ) INSERT INTO benchmark_data SELECT {} FROM source",
            value_exprs.join(", ")
        ),
        [i64::try_from(options.rows)
            .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?],
    )?;
    drop(sqlite);
    let db = DuckDbEngine::new_in_memory()?;
    let setup_ms = setup_started.elapsed().as_millis();

    let operation_started = Instant::now();
    let (import_result, process_memory) = measure_peak_working_set_during(|| {
        db.import_selected_sqlite(
            &source_path_text,
            &[(
                "benchmark_data".to_string(),
                "DataLink Benchmark".to_string(),
                false,
            )],
            &|_, _, _, _, _| {},
            &|| false,
        )
    });
    let operation_ms = operation_started.elapsed().as_millis();
    let remove_result = std::fs::remove_file(&source_path).map_err(AppError::from);
    let imported = import_result?;
    remove_result?;
    let result_rows = imported
        .first()
        .map(|(_, _, rows_written)| *rows_written)
        .unwrap_or(0);

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows,
        selected_columns: 0,
        query_ms: None,
        encode_ms: None,
        decode_ms: None,
        draw_ms: None,
        processed_rows: None,
        source_rows: None,
        chunks: None,
        transferred_bytes: None,
        projection_passes: None,
        invalid_x_count: None,
        archive_bytes: 0,
        max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory,
        chain_depth: None,
        runs_ms: None,
        median_ms: None,
        process_memory_method: process_memory_method(),
        physical_input_bytes: None,
        calculated_result_bytes: None,
        memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: None,
        qualification_failure: None,
        machine: None,
    })
}

fn execute_save(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    let setup_started = Instant::now();
    let state = AppState::new()?;
    let archive_path = seed_save_project(&state, options.rows, options.columns)?;
    let setup_ms = setup_started.elapsed().as_millis();

    let history = vec![serde_json::json!({
        "kind": "benchmark",
        "label": "save",
    })];
    let snapshots = vec![serde_json::json!({
        "id": "snapshot-bench-1",
        "datasetId": "save-current-baseline",
        "rows": [1],
    })];
    let graph_builders = vec![serde_json::json!({
        "id": "graph-bench-1",
        "name": "Benchmark Graph",
        "graphType": "line",
        "xField": "col_1",
        "yField": "col_2",
    })];
    let tabulates = vec![serde_json::json!({
        "id": "tab-bench-1",
        "name": "Benchmark Tabulate",
        "sourceDatasetId": "save-current-baseline",
        "rowFields": ["col_1"],
        "columnFields": [],
        "statistics": ["count"]
    })];
    let folders = vec!["Bench".to_string(), "Bench/Sub".to_string()];
    let table_folders = std::collections::HashMap::from([(
        "save-current-baseline".to_string(),
        "Bench/Sub".to_string(),
    )]);
    let graph_folders =
        std::collections::HashMap::from([("graph-bench-1".to_string(), "Bench".to_string())]);
    let tabulate_folders =
        std::collections::HashMap::from([("tab-bench-1".to_string(), "Bench/Sub".to_string())]);

    let observed_perf = std::sync::Arc::new(std::sync::Mutex::new(
        crate::models::save::SavePerfMetrics::default(),
    ));
    let observed_perf_capture = std::sync::Arc::clone(&observed_perf);
    let operation_started = Instant::now();
    let (save_result, process_memory) = measure_peak_working_set_during(|| {
        with_save_perf_observer(
            move |metrics| {
                if let Ok(mut slot) = observed_perf_capture.lock() {
                    *slot = metrics;
                }
            },
            || {
                ProjectService::new(&state).save_project(
                    SaveProjectRequest {
                        file_path: None,
                        history,
                        snapshots,
                        graph_builders,
                        fit_y_by_x: Vec::new(),
                        fit_models: Vec::new(),
                        reports: Vec::new(),
                        distributions: Vec::new(),
                        analyses: Vec::new(),
                        tabulates,
                        folders,
                        table_folders,
                        graph_folders,
                        fit_y_by_x_folders: std::collections::HashMap::new(),
                        fit_model_folders: std::collections::HashMap::new(),
                        report_folders: std::collections::HashMap::new(),
                        distribution_folders: std::collections::HashMap::new(),
                        analysis_folders: std::collections::HashMap::new(),
                        tabulate_folders,
                        dataset_filters: std::collections::HashMap::new(),
                        workflows: Vec::new(),
                        logical_folders: Vec::new(),
                        workflow_runs: Vec::new(),
                        table_transforms: Vec::new(),
                        table_transform_bindings: Vec::new(),
                    },
                    None,
                )
            },
        )
    });
    let operation_ms = operation_started.elapsed().as_millis();
    let observed_perf = observed_perf.lock().map(|slot| *slot).unwrap_or_default();

    let save_metrics_result = match save_result {
        Ok(_) => {
            let archive_bytes = std::fs::metadata(&archive_path)
                .map(|metadata| metadata.len())
                .map_err(AppError::from)?;
            let result_rows = spprj_archive::count_project_rows_streaming(&archive_path)?;
            Ok((archive_bytes, result_rows, observed_perf))
        }
        Err(error) => Err(error),
    };

    remove_benchmark_artifacts(&archive_path);
    let (archive_bytes, result_rows, save_perf_metrics) = save_metrics_result?;

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows,
        selected_columns: 0,
        query_ms: None,
        encode_ms: None,
        decode_ms: None,
        draw_ms: None,
        processed_rows: None,
        source_rows: None,
        chunks: None,
        transferred_bytes: None,
        projection_passes: None,
        invalid_x_count: None,
        archive_bytes,
        max_retained_batch_bytes: Some(save_perf_metrics.max_retained_batch_bytes as u64),
        max_encoded_batch_bytes: Some(save_perf_metrics.max_encoded_batch_bytes as u64),
        max_combined_batch_bytes: Some(save_perf_metrics.max_combined_batch_bytes as u64),
        save_stage_ms: Some(SaveStageReport {
            plan: save_perf_metrics.plan_ms,
            query_fetch: save_perf_metrics.query_fetch_ms,
            batch_encode: save_perf_metrics.batch_encode_ms,
            zip_write: save_perf_metrics.zip_write_ms,
            zip_finish: save_perf_metrics.zip_finish_ms,
            sync_all: save_perf_metrics.sync_all_ms,
            validation: save_perf_metrics.validation_ms,
            replacement: save_perf_metrics.replacement_ms,
        }),
        process_memory,
        chain_depth: None,
        runs_ms: None,
        median_ms: None,
        process_memory_method: process_memory_method(),
        physical_input_bytes: None,
        calculated_result_bytes: None,
        memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: None,
        qualification_failure: None,
        machine: None,
    })
}

fn remove_benchmark_artifacts(archive_path: &str) {
    let path = std::path::Path::new(archive_path);
    let temp_dir = std::env::temp_dir();
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if parent != temp_dir {
        return;
    }
    if !file_name.starts_with("stats_playground_save_current_") || !file_name.ends_with(".spprj") {
        return;
    }

    let _ = std::fs::remove_file(path);

    let tmp_candidate = format!("{}.tmp", archive_path);
    let tmp_path = std::path::Path::new(&tmp_candidate);
    if tmp_path.is_dir() {
        let _ = std::fs::remove_dir_all(tmp_path);
    } else {
        let _ = std::fs::remove_file(tmp_path);
    }
}

pub fn run_cli() -> Result<(), String> {
    let options = parse_args(std::env::args().skip(1)).map_err(|error| error.to_string())?;
    let report = execute(options).map_err(|error| error.to_string())?;
    let json = serde_json::to_string(&report).map_err(|error| error.to_string())?;
    println!("{json}");
    if let Some(failure) = report.qualification_failure() {
        return Err(failure.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::graph_data::{
        GraphAggregatePacket, GraphAxisEncoding, HistogramBin, HistogramPacket,
    };
    use crate::models::table::{CellUpdate, CreateTableFromRowsRequest};
    use crate::services::calculated_column_service::{
        CalculatedColumnService, UpsertCalculatedColumnInput,
    };
    use crate::services::data_service::DataService;

    fn owned_archive_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "stats_playground_save_current_{}.spprj",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn performance_cli_uses_reference_defaults() {
        let options = parse_args(Vec::<String>::new()).unwrap();

        assert_eq!(options.rows, 100_000);
        assert_eq!(options.columns, 20);
        assert_eq!(options.operation, Operation::Query);
    }

    #[test]
    fn performance_cli_rejects_unknown_operation() {
        let error = parse_args(["--operation", "unknown"].map(String::from)).unwrap_err();

        assert!(matches!(error, crate::error::AppError::InvalidParam(_)));
    }

    #[test]
    fn performance_cli_parses_graph_operation() {
        let options = parse_args(["--operation", "graph"].map(String::from)).unwrap();

        assert_eq!(options.operation, Operation::Graph);
    }

    #[test]
    fn performance_cli_parses_datalink_operation() {
        let options = parse_args(["--operation", "datalink"].map(String::from)).unwrap();

        assert_eq!(options.operation, Operation::Datalink);
    }

    #[test]
    fn performance_cli_parses_calculated_operation_and_chain_depth() {
        let options =
            parse_args(["--operation", "calculated", "--chain-depth", "5"].map(String::from))
                .unwrap();

        assert_eq!(options.operation, Operation::Calculated);
        assert_eq!(options.chain_depth, 5);
    }

    #[test]
    fn performance_cli_rejects_zero_calculated_chain_depth() {
        let error =
            parse_args(["--operation", "calculated", "--chain-depth", "0"].map(String::from))
                .unwrap_err();

        assert!(matches!(error, crate::error::AppError::InvalidParam(_)));
        assert!(error
            .to_string()
            .contains("--chain-depth must be at least 1"));
    }

    #[test]
    fn performance_calculated_harness_recomputes_five_level_chain_before_timing() {
        let state = AppState::new().expect("state");
        let data = DataService::new(&state);
        let dataset_id = data
            .create_table_from_rows(&CreateTableFromRowsRequest {
                name: "Calculated Perf Harness".to_string(),
                column_names: vec!["Source".to_string()],
                column_types: vec!["DOUBLE".to_string()],
                rows: vec![vec![serde_json::json!(1.0)], vec![serde_json::json!(2.0)]],
            })
            .expect("seed source rows")
            .id;

        seed_calculated_chain(&state, &dataset_id, 5).expect("seed formula chain");
        data.update_cells(
            &dataset_id,
            &[
                CellUpdate {
                    row_id: 1,
                    column_name: "Source".to_string(),
                    value: Some("10".to_string()),
                },
                CellUpdate {
                    row_id: 2,
                    column_name: "Source".to_string(),
                    value: Some("20".to_string()),
                },
            ],
            None,
        )
        .expect("mutate source through production coordinator");

        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Calc1"),
            vec![11.0, 21.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Calc2"),
            vec![13.0, 23.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Calc3"),
            vec![16.0, 26.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Calc4"),
            vec![20.0, 30.0]
        );
        assert_eq!(
            numeric_column_values(&state, &dataset_id, "Calc5"),
            vec![25.0, 35.0]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn current_working_set_bytes_returns_some_for_current_process_on_macos() {
        assert!(current_working_set_bytes().is_some());
    }

    #[test]
    fn performance_cli_executes_calculated_operation_on_mixed_seed_table() {
        let report = execute(Options {
            rows: 10,
            columns: 4,
            operation: Operation::Calculated,
            chain_depth: 2,
            runs: 1,
        })
        .unwrap();

        assert_eq!(report.result_rows, 10);
        assert_eq!(report.selected_columns, 2);
        assert_eq!(report.runs_ms.as_ref().map(Vec::len), Some(1));
        assert!(report.qualification_passed.is_some());
    }

    #[test]
    fn performance_cli_parses_time_series_graph_operation() {
        let options = parse_args(["--operation", "time-series-graph"].map(String::from)).unwrap();

        assert_eq!(options.operation, Operation::TimeSeriesGraph);
    }

    #[test]
    fn performance_cli_executes_each_operation() {
        for operation in [
            Operation::Query,
            Operation::Paste,
            Operation::Restore,
            Operation::Graph,
            Operation::Save,
            Operation::Datalink,
        ] {
            let report = execute(Options {
                rows: 25,
                columns: 4,
                operation,
                chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
                runs: 1,
            })
            .unwrap();

            assert_eq!(report.rows, 25);
            assert_eq!(report.columns, 4);
            assert_eq!(report.operation, operation);
            assert_eq!(report.result_rows, 25);
            assert_eq!(
                report.selected_columns,
                if operation == Operation::Graph { 3 } else { 0 }
            );

            let json = serde_json::to_value(&report).unwrap();
            assert!(json.get("setupMs").is_some());
            assert!(json.get("operationMs").is_some());
            assert!(json.get("totalMs").is_some());
            assert!(json.get("archiveBytes").is_some());
            if operation == Operation::Save {
                assert!(report.archive_bytes > 0);
                assert!(report.max_retained_batch_bytes.is_some());
                assert!(report.max_encoded_batch_bytes.is_some());
                assert!(report.max_combined_batch_bytes.is_some());
                assert!(report.save_stage_ms.is_some());
                assert!(json.get("maxRetainedBatchBytes").is_some());
                assert!(json.get("maxEncodedBatchBytes").is_some());
                assert!(json.get("maxCombinedBatchBytes").is_some());
                assert!(json.get("saveStageMs").is_some());
            } else {
                assert!(report.max_retained_batch_bytes.is_none());
                assert!(report.max_encoded_batch_bytes.is_none());
                assert!(report.max_combined_batch_bytes.is_none());
                assert!(report.save_stage_ms.is_none());
                assert!(json.get("maxRetainedBatchBytes").is_none());
                assert!(json.get("maxEncodedBatchBytes").is_none());
                assert!(json.get("maxCombinedBatchBytes").is_none());
                assert!(json.get("saveStageMs").is_none());
            }
        }
    }

    fn seed_calculated_chain(
        state: &AppState,
        dataset_id: &str,
        chain_depth: usize,
    ) -> Result<(), AppError> {
        let calculated = CalculatedColumnService::new(state);
        let mut dependency = "Source".to_string();
        for level in 1..=chain_depth {
            let output_name = format!("Calc{level}");
            calculated.upsert(&UpsertCalculatedColumnInput {
                dataset_id: dataset_id.to_string(),
                output_name: output_name.clone(),
                formula_text: format!("{dependency} + {level}"),
                at_index: None,
                output_column_id: None,
                formula_id: None,
                expected_generation: None,
            })?;
            dependency = output_name;
        }
        Ok(())
    }

    fn numeric_column_values(state: &AppState, dataset_id: &str, column_name: &str) -> Vec<f64> {
        let table = DataService::new(state)
            .query_table(dataset_id, 0, 100, None, None)
            .expect("query dataset");
        let column_index = table
            .columns
            .iter()
            .position(|candidate| candidate == column_name)
            .unwrap_or_else(|| panic!("missing column {column_name}"));
        table
            .rows
            .into_iter()
            .map(|row| {
                row[column_index]
                    .as_f64()
                    .unwrap_or_else(|| panic!("expected numeric {column_name}"))
            })
            .collect()
    }

    #[test]
    fn performance_cli_streams_graph_via_production_service() {
        let report = execute(Options {
            rows: 10_000,
            columns: 20,
            operation: Operation::Graph,
            chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
            runs: 1,
        })
        .unwrap();

        assert_eq!(report.result_rows, 10_000);
        assert_eq!(report.selected_columns, 0);
        assert_eq!(report.processed_rows, Some(10_000));
    }

    #[test]
    fn performance_cli_reports_graph_metrics_shape() {
        let report = execute(Options {
            rows: 10,
            columns: 20,
            operation: Operation::Graph,
            chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
            runs: 1,
        })
        .unwrap();

        let json = serde_json::to_value(report).unwrap();
        assert_eq!(
            json.get("operation").and_then(|value| value.as_str()),
            Some("graph")
        );
        assert!(json
            .get("queryMs")
            .and_then(|value| value.as_u64())
            .is_some());
        assert!(json
            .get("encodeMs")
            .and_then(|value| value.as_u64())
            .is_some());
        assert_eq!(
            json.get("decodeMs").and_then(|value| value.as_str()),
            Some("desktop_only")
        );
        assert_eq!(
            json.get("drawMs").and_then(|value| value.as_str()),
            Some("desktop_only")
        );
        assert_eq!(
            json.get("processedRows").and_then(|value| value.as_u64()),
            Some(10)
        );
        assert!(json
            .get("transferredBytes")
            .and_then(|value| value.as_u64())
            .is_some_and(|value| value > 0));
    }

    #[test]
    fn performance_cli_reports_time_series_temporal_transfer_metrics() {
        let report = execute(Options {
            rows: 300_000,
            columns: 4,
            operation: Operation::TimeSeriesGraph,
            chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
            runs: 1,
        })
        .unwrap();

        assert_eq!(report.result_rows, 300_000);
        assert_eq!(report.processed_rows, Some(300_000));
        assert_eq!(report.source_rows, Some(300_000));
        assert_eq!(report.invalid_x_count, Some(0));
        assert_eq!(report.projection_passes, Some(1));
        assert!(report.chunks.is_some_and(|chunks| chunks > 0));
        assert!(report.transferred_bytes.is_some_and(|bytes| bytes > 0));
        assert!(report.query_ms.is_some());
        assert!(report.encode_ms.is_some());
    }

    #[test]
    fn performance_cli_graph_projection_timings_are_single_pass_partition() {
        let state = AppState::new().expect("state");
        let dataset_id = "perf-single-pass";
        seed_graph_benchmark_dataset(&state, dataset_id, 1024).expect("seed");
        let generation = {
            let db = state.db.lock().expect("db lock");
            db.get_dataset_generation(dataset_id).expect("generation")
        };
        let request = build_graph_request(dataset_id, generation);
        let service = GraphDataService::new(&state);

        let capture = service
            .collect_benchmark_result(&request)
            .expect("benchmark capture");

        assert_eq!(capture.projection_passes, 1);
        assert_eq!(capture.selected_columns, 3);
        assert_eq!(
            capture.projected_columns,
            vec![
                "_row_id".to_string(),
                "region".to_string(),
                "cost".to_string()
            ]
        );
        assert!(capture.query_ms > 0 || capture.encode_ms > 0);
    }

    #[test]
    fn measure_transferred_bytes_counts_aggregate_events() {
        let chunk = GraphDataChunk {
            header: GraphChunkHeader {
                request_id: "req-agg".to_string(),
                generation: 1,
                chunk_index: 0,
                row_offset: 0,
                row_count: 1,
                source_rows: 1,
                processed_rows: 1,
                projected_columns: vec![
                    "_row_id".to_string(),
                    "region".to_string(),
                    "cost".to_string(),
                ],
                dictionaries: Default::default(),
                validity_ranges: Default::default(),
                x_values: crate::models::graph_data::GraphTypedSliceDescriptor::new(
                    crate::models::graph_data::GraphPayloadType::U32,
                    0,
                    4,
                ),
                y_values: crate::models::graph_data::GraphTypedSliceDescriptor::new(
                    crate::models::graph_data::GraphPayloadType::F64,
                    8,
                    8,
                ),
                row_ids: crate::models::graph_data::GraphTypedSliceDescriptor::new(
                    crate::models::graph_data::GraphPayloadType::I64,
                    16,
                    8,
                ),
                z_values: None,
                group_codes: None,
                size_values: None,
                source_codes: None,
                facet_x_codes: None,
                facet_y_codes: None,
                facet_z_codes: None,
                wrap_codes: None,
                role_vectors: Default::default(),
                x_encoding: GraphAxisEncoding::Categorical,
                temporal_metadata: None,
                final_chunk: true,
            },
            payload: vec![1, 2, 3, 4, 5],
        };
        let aggregate = GraphAggregatePacket::Histogram(HistogramPacket {
            x_column: Some("region".to_string()),
            y_column: "cost".to_string(),
            group_column: Some("region".to_string()),
            source_column: None,
            bin_count: 1,
            min_value: Some(0.0),
            max_value: Some(1.0),
            missing_count: 0,
            bin_width: 1.0,
            total_count: 1,
            bins: vec![HistogramBin {
                group: Some("North".to_string()),
                category: Some("North".to_string()),
                source_column: None,
                facet_x: None,
                facet_y: None,
                facet_z: None,
                wrap: None,
                bin_start: 0.0,
                bin_end: 1.0,
                count: 1,
            }],
        });
        let completion = GraphDataCompletion {
            request_id: "req-agg".to_string(),
            dataset_id: "dataset-agg".to_string(),
            generation: 1,
            source_rows: 1,
            processed_rows: 1,
            chunks_sent: 1,
            cancelled: false,
            raw_point_disposition: crate::models::graph_data::GraphRawPointDisposition::Included {
                valid_rows: 1,
                budget: crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET,
            },
            time_series_disposition: None,
        };

        let actual = measure_transferred_bytes(
            std::slice::from_ref(&chunk),
            std::slice::from_ref(&aggregate),
            &completion,
        )
        .expect("transferred bytes");

        let header_bytes = serde_json::to_vec(&GraphStreamHeaderMessage {
            message_type: "header",
            header: &chunk.header,
        })
        .expect("header bytes")
        .len() as u64;
        let payload_bytes = chunk.payload.len() as u64;
        let aggregate_bytes = serde_json::to_vec(&GraphStreamAggregateMessage {
            message_type: "aggregate",
            packet: &aggregate,
        })
        .expect("aggregate bytes")
        .len() as u64;
        let terminal_bytes = serde_json::to_vec(&GraphStreamCompletionMessage {
            message_type: "complete",
            completion: &completion,
        })
        .expect("terminal bytes")
        .len() as u64;
        let expected = header_bytes + payload_bytes + aggregate_bytes + terminal_bytes;

        assert_eq!(actual, expected);
    }

    #[test]
    fn performance_cli_rejects_graph_when_columns_below_two() {
        let result = execute(Options {
            rows: 10,
            columns: 1,
            operation: Operation::Graph,
            chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
            runs: 1,
        });

        match result {
            Ok(_) => panic!("expected graph to reject columns < 2"),
            Err(error) => {
                assert!(matches!(error, AppError::InvalidParam(_)));
                assert!(error
                    .to_string()
                    .contains("graph requires at least 2 columns"));
            }
        }
    }

    fn performance_cli_rejects_legacy_save_current_alias() {
        let error = parse_args(
            [
                "--rows",
                "100",
                "--columns",
                "4",
                "--operation",
                "save_current",
            ]
            .map(String::from),
        )
        .unwrap_err();

        assert!(matches!(error, crate::error::AppError::InvalidParam(_)));
    }

    #[test]
    fn performance_cli_measures_current_project_save() {
        let report = execute(Options {
            rows: 300_000,
            columns: 20,
            operation: Operation::Save,
            chain_depth: DEFAULT_CALCULATED_CHAIN_DEPTH,
            runs: 1,
        })
        .unwrap();

        assert_eq!(report.result_rows, 300_000);
        assert!(report.archive_bytes > 0);
    }

    #[test]
    fn cleanup_removes_owned_archive_and_tmp_directory() {
        let archive_path = owned_archive_path();
        std::fs::write(&archive_path, b"archive").unwrap();
        let tmp_path = std::path::PathBuf::from(format!("{}.tmp", archive_path.to_string_lossy()));
        std::fs::create_dir_all(&tmp_path).unwrap();

        remove_benchmark_artifacts(archive_path.to_str().unwrap());

        assert!(!archive_path.exists());
        assert!(!tmp_path.exists());
    }

    #[test]
    fn cleanup_does_not_touch_non_owned_paths() {
        let temp_dir = std::env::temp_dir();
        let non_owned = temp_dir.join(format!("do_not_touch_{}.spprj", uuid::Uuid::new_v4()));
        std::fs::write(&non_owned, b"keep").unwrap();
        let non_owned_tmp =
            std::path::PathBuf::from(format!("{}.tmp", non_owned.to_string_lossy()));
        std::fs::write(&non_owned_tmp, b"keep-tmp").unwrap();

        remove_benchmark_artifacts(non_owned.to_str().unwrap());

        assert!(non_owned.exists());
        assert!(non_owned_tmp.exists());

        let _ = std::fs::remove_file(non_owned);
        let _ = std::fs::remove_file(non_owned_tmp);
    }
}

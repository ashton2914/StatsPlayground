const MUTATION_CHILD_NONCE_ENV: &str = "STATSPLAYGROUND_MUTATION_CHILD_NONCE";
const MUTATION_CHILD_PARENT_PID_ENV: &str = "STATSPLAYGROUND_MUTATION_CHILD_PARENT_PID";

#[derive(Debug, PartialEq, Eq)]
struct MutationChildRequest {
    parent_process_id: u32,
    nonce: String,
}

#[derive(Clone)]
struct MutationParentAuthorization {
    parent_process_id: u32,
    nonce: String,
}

struct RuntimeSourceProvenance {
    head: String,
    dirty: bool,
}

fn binary_source_commit() -> &'static str {
    env!("STATSPLAYGROUND_BINARY_SOURCE_COMMIT")
}

fn binary_source_dirty() -> bool {
    env!("STATSPLAYGROUND_BINARY_SOURCE_DIRTY") == "true"
}

fn binary_build_profile() -> &'static str {
    env!("STATSPLAYGROUND_BINARY_BUILD_PROFILE")
}

fn binary_qualification_available() -> bool {
    env!("STATSPLAYGROUND_QUALIFICATION_AVAILABLE") == "true"
}

fn validate_binary_qualification_available(available: bool) -> Result<(), AppError> {
    if !available {
        return Err(AppError::InvalidParam(
            "perf-harness source provenance is unavailable; qualification is refused".into(),
        ));
    }
    Ok(())
}

fn git_output(args: &[&str]) -> Result<String, AppError> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::FileIO(format!(
            "git {} failed while validating benchmark provenance: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| AppError::FileIO(error.to_string()))
}

fn runtime_source_provenance() -> Result<RuntimeSourceProvenance, AppError> {
    Ok(RuntimeSourceProvenance {
        head: git_output(&["rev-parse", "HEAD"])?,
        dirty: !git_output(&["status", "--porcelain=v1", "--untracked-files=normal"])?.is_empty(),
    })
}

fn validate_source_provenance(
    binary_commit: &str,
    binary_dirty: bool,
    runtime_head: &str,
    runtime_dirty: bool,
) -> Result<(), AppError> {
    if binary_commit != runtime_head {
        return Err(AppError::InvalidParam(format!(
            "binary source commit {binary_commit} does not match runtime HEAD {runtime_head}"
        )));
    }
    if binary_dirty || runtime_dirty {
        return Err(AppError::InvalidParam(
            "mutation qualification requires a clean source tree at compile time and runtime"
                .into(),
        ));
    }
    Ok(())
}

fn take_mutation_child_request(
    args: &mut Vec<String>,
) -> Result<Option<MutationChildRequest>, AppError> {
    let Some(child_index) = args
        .iter()
        .position(|argument| argument == "--mutation-child")
    else {
        return Ok(None);
    };
    args.remove(child_index);
    if child_index >= args.len() {
        return Err(AppError::InvalidParam(
            "--mutation-child requires a parent nonce".into(),
        ));
    }
    let nonce = args.remove(child_index);
    let parent_flag_index = args
        .iter()
        .position(|argument| argument == "--mutation-parent-pid")
        .ok_or_else(|| {
            AppError::InvalidParam("--mutation-child requires --mutation-parent-pid".into())
        })?;
    args.remove(parent_flag_index);
    if parent_flag_index >= args.len() {
        return Err(AppError::InvalidParam(
            "--mutation-parent-pid requires a value".into(),
        ));
    }
    let parent_process_id = args
        .remove(parent_flag_index)
        .parse::<u32>()
        .map_err(|_| AppError::InvalidParam("mutation parent PID must be an integer".into()))?;
    Ok(Some(MutationChildRequest {
        parent_process_id,
        nonce,
    }))
}

fn validate_mutation_child_authorization(
    request: &MutationChildRequest,
    environment_nonce: Option<&str>,
    environment_parent_pid: Option<&str>,
    actual_parent_process_id: Option<u32>,
    current_process_id: u32,
) -> Result<(), AppError> {
    let expected_parent_pid = environment_parent_pid
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value != 0 && *value != current_process_id);
    if environment_nonce != Some(request.nonce.as_str())
        || expected_parent_pid != Some(request.parent_process_id)
        || actual_parent_process_id != Some(request.parent_process_id)
    {
        return Err(AppError::InvalidParam(
            "mutation child parent authorization is invalid".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn actual_parent_process_id() -> Option<u32> {
    unsafe extern "C" {
        fn getppid() -> i32;
    }
    u32::try_from(unsafe { getppid() }).ok().filter(|value| *value != 0)
}

#[cfg(windows)]
fn actual_parent_process_id() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = std::mem::zeroed::<PROCESSENTRY32W>();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let current_process_id = std::process::id();
        let mut result = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == current_process_id {
                    result = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        result.filter(|value| *value != 0)
    }
}

#[cfg(not(any(unix, windows)))]
fn actual_parent_process_id() -> Option<u32> {
    None
}

fn mutation_sample_plan(sample_count: usize, warmup_count: usize) -> Result<Vec<String>, AppError> {
    if sample_count != 5 || warmup_count != 1 {
        return Err(AppError::InvalidParam(
            "mutation qualification requires one warmup and five measured child processes".into(),
        ));
    }
    let mut plan = vec!["warmup".into()];
    plan.extend((1..=sample_count).map(|index| format!("measured-{index}")));
    Ok(plan)
}

fn mutation_parent_authorization() -> MutationParentAuthorization {
    let nonce = rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    MutationParentAuthorization {
        parent_process_id: std::process::id(),
        nonce,
    }
}

fn duckdb_retained_memory_bytes(db: &DuckDbEngine) -> Result<u64, AppError> {
    let bytes: i64 = db.conn().query_row(
        "SELECT COALESCE(sum(memory_usage_bytes), 0) FROM duckdb_memory()",
        [],
        |row| row.get(0),
    )?;
    u64::try_from(bytes)
        .map_err(|_| AppError::Database("DuckDB retained memory became negative".into()))
}

fn execute_table_mutation_sample(
    operation: Operation,
    rows: usize,
    columns: usize,
) -> Result<TableMutationSampleReport, AppError> {
    const DATASET_ID: &str = "performance-table-mutation";

    let sample_started = Instant::now();
    let state = AppState::new()?;
    let (generation, target_row_id, deleted_column, retained_memory_before_bytes) = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.seed_benchmark_table(DATASET_ID, "Performance Table Mutation", rows, columns)?;
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(DATASET_ID));
        let target_row_id = db.conn().query_row(
            &format!(
                "SELECT \"_row_id\" FROM {table}
                 ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\" LIMIT 1 OFFSET ?"
            ),
            params![rows / 2],
            |row| row.get::<_, i64>(0),
        )?;
        let deleted_column = db
            .get_user_column_descriptors(DATASET_ID)?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::InvalidParam("mutation fixture requires a column".into()))?;
        (
            db.get_dataset_generation(DATASET_ID)?,
            target_row_id,
            ColumnDescriptor {
                column_id: deleted_column.column_id,
                name: deleted_column.name,
                sql_type: deleted_column.sql_type,
                calculated: None,
            },
            duckdb_retained_memory_bytes(&db)?,
        )
    };
    let setup_ms = sample_started.elapsed().as_millis();

    reset_full_anchor_rebuild_counter();
    reset_rebalanced_rows();
    reset_full_table_row_updates();
    reset_table_mutation_perf_metrics();
    let total_started = Instant::now();
    let service = DataService::new(&state);
    let (mutation_result, process_memory) =
        measure_peak_working_set_during(|| -> Result<(String, Option<i64>), AppError> {
            match operation {
                Operation::AppendRow => {
                    let result = service.add_rows(DATASET_ID, 1, None, generation)?;
                    Ok((result.change_set_id, result.row_ids.first().copied()))
                }
                Operation::InsertMiddleRow => {
                    let result =
                        service.add_rows(DATASET_ID, 1, Some(target_row_id), generation)?;
                    Ok((result.change_set_id, result.row_ids.first().copied()))
                }
                Operation::AddColumn => {
                    let result = service.add_columns_with_change_set(
                        DATASET_ID,
                        &[ColumnDescriptor {
                            column_id: uuid::Uuid::new_v4().to_string(),
                            name: "qualification_empty_column".into(),
                            sql_type: "VARCHAR".into(),
                            calculated: None,
                        }],
                        None,
                        generation,
                    )?;
                    Ok((result.change_set_id, None))
                }
                Operation::DeleteRows => {
                    let result = service.delete_rows_with_change_set(
                        DATASET_ID,
                        &[target_row_id],
                        generation,
                    )?;
                    Ok((result.change_set_id, None))
                }
                Operation::DeleteColumn => {
                    let result = service.delete_columns_with_change_set(
                        DATASET_ID,
                        std::slice::from_ref(&deleted_column),
                        generation,
                    )?;
                    Ok((result.change_set_id, None))
                }
                _ => Err(AppError::InvalidParam(
                    "operation is not a table mutation qualification".into(),
                )),
            }
        });
    let (change_set_id, inserted_row_id) = mutation_result?;
    let phase_metrics = table_mutation_perf_metrics();

    let reload_started = Instant::now();
    let _ = service.query_table_navigation_window(&TableNavigationRequest {
        version: 1,
        request_id: "performance-table-mutation-reload".into(),
        dataset_id: DATASET_ID.into(),
        generation: generation + 1,
        start: 0,
        count: 500,
        column_ids: service
            .get_column_descriptors(DATASET_ID)?
            .into_iter()
            .map(|column| column.column_id)
            .collect(),
        sort: None,
        filters: Vec::new(),
        session_id: None,
        include_transport_diagnostics: false,
    })?;
    let reload_ms = reload_started.elapsed().as_millis();
    let total_wall_ms = total_started.elapsed().as_millis();

    let (
        full_snapshot_tables,
        sparse_anchor_integrity,
        compact_snapshot_shape,
        inserted_precedes_target,
        retained_memory_after_bytes,
    ) = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let full_snapshot_tables: usize = db.conn().query_row(
            "SELECT count(*) FROM information_schema.tables
             WHERE table_name LIKE '_history_full_before_%'",
            [],
            |row| row.get(0),
        )?;
        let current_generation = db.get_dataset_generation(DATASET_ID)?;
        let meta = db.get_dataset_meta(DATASET_ID)?;
        let row_count = usize::try_from(meta.row_count)
            .map_err(|_| AppError::Database("row count does not fit usize".into()))?;
        let manifest_valid = db
            .validate_natural_anchor_manifest(
                DATASET_ID,
                i64::try_from(current_generation)
                    .map_err(|_| AppError::Database("generation does not fit i64".into()))?,
                meta.row_count,
            )
            .is_ok();
        let anchor_count: usize = db.conn().query_row(
            "SELECT count(*) FROM _table_navigation_anchors
             WHERE dataset_id = ? AND generation = ?",
            params![DATASET_ID, current_generation],
            |row| row.get(0),
        )?;
        let sparse_anchor_integrity = manifest_valid
            && anchor_count <= row_count.div_ceil(NATURAL_ANCHOR_STRIDE).saturating_add(2);
        let (recorded_operation, storage_kind, snapshot_table): (
            String,
            String,
            Option<String>,
        ) = db.conn().query_row(
            "SELECT delta.operation, changes.storage_kind, delta.snapshot_table
             FROM _history_delta_change_sets AS delta
             JOIN _history_change_sets AS changes ON changes.id = delta.id
             WHERE delta.id = ?",
            params![&change_set_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let expected_operation = match operation {
            Operation::AppendRow | Operation::InsertMiddleRow => "add_rows",
            Operation::AddColumn => "add_columns",
            Operation::DeleteRows => "delete_rows",
            Operation::DeleteColumn => "delete_columns",
            _ => unreachable!("validated table mutation operation"),
        };
        let expected_storage = match operation {
            Operation::AppendRow | Operation::InsertMiddleRow | Operation::DeleteRows => {
                "row_delta"
            }
            Operation::AddColumn | Operation::DeleteColumn => "column_delta",
            _ => unreachable!("validated table mutation operation"),
        };
        let compact_snapshot_shape = match (operation, snapshot_table.as_deref()) {
            (Operation::AppendRow | Operation::InsertMiddleRow | Operation::AddColumn, None) => true,
            (Operation::DeleteRows, Some(snapshot)) if snapshot.starts_with("_history_rows_") => {
                let snapshot = DuckDbEngine::quote_identifier(snapshot);
                let snapshot_rows: usize = db.conn().query_row(
                    &format!("SELECT count(*) FROM {snapshot}"),
                    [],
                    |row| row.get(0),
                )?;
                snapshot_rows == 1
            }
            (Operation::DeleteColumn, Some(snapshot))
                if snapshot.starts_with("_history_columns_") =>
            {
                let snapshot_columns: usize = db.conn().query_row(
                    "SELECT count(*) FROM information_schema.columns WHERE table_name = ?",
                    params![snapshot],
                    |row| row.get(0),
                )?;
                let snapshot = DuckDbEngine::quote_identifier(snapshot);
                let snapshot_rows: usize = db.conn().query_row(
                    &format!("SELECT count(*) FROM {snapshot}"),
                    [],
                    |row| row.get(0),
                )?;
                snapshot_columns == 2 && snapshot_rows == rows
            }
            _ => false,
        } && recorded_operation == expected_operation
            && storage_kind == expected_storage;
        let inserted_precedes_target = if operation == Operation::InsertMiddleRow {
            let inserted_row_id = inserted_row_id.ok_or_else(|| {
                AppError::Database("middle insertion did not return a row ID".into())
            })?;
            let table =
                DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(DATASET_ID));
            let adjacent: usize = db.conn().query_row(
                &format!(
                    "SELECT count(*) FROM (
                         SELECT \"_row_id\", lead(\"_row_id\") OVER (
                             ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
                         ) AS next_row_id FROM {table}
                     ) AS ordered_rows
                     WHERE \"_row_id\" = ? AND next_row_id = ?"
                ),
                params![inserted_row_id, target_row_id],
                |row| row.get(0),
            )?;
            Some(adjacent == 1)
        } else {
            None
        };
        (
            full_snapshot_tables,
            sparse_anchor_integrity,
            compact_snapshot_shape,
            inserted_precedes_target,
            duckdb_retained_memory_bytes(&db)?,
        )
    };

    Ok(TableMutationSampleReport {
        report_kind: "sample".into(),
        process_id: std::process::id(),
        sample_kind: std::env::var("STATSPLAYGROUND_MUTATION_SAMPLE_KIND")
            .unwrap_or_else(|_| "direct".into()),
        binary_source_commit: binary_source_commit().into(),
        binary_source_clean: !binary_source_dirty(),
        build_profile: binary_build_profile().into(),
        machine: {
            let db = DuckDbEngine::new_in_memory()?;
            machine_report(duckdb_version(&db))
        },
        setup_ms,
        mutation_ms: u128::from(phase_metrics.mutation_ns).div_ceil(1_000_000),
        history_ms: u128::from(phase_metrics.history_ns).div_ceil(1_000_000),
        anchor_ms: u128::from(phase_metrics.anchor_ns).div_ceil(1_000_000),
        metadata_ms: u128::from(phase_metrics.metadata_ns).div_ceil(1_000_000),
        reload_ms: Some(reload_ms),
        total_wall_ms,
        full_snapshot_tables,
        full_anchor_rebuilds: full_anchor_rebuild_counter(),
        full_table_row_updates: full_table_row_updates(),
        rebalanced_rows: rebalanced_rows(),
        sparse_anchor_integrity,
        compact_snapshot_shape,
        inserted_precedes_target,
        retained_memory_before_bytes,
        retained_memory_after_bytes,
        process_memory,
    })
}

fn validate_distinct_child_processes(process_ids: &[u32]) -> Result<(), AppError> {
    let unique = process_ids.iter().copied().collect::<std::collections::BTreeSet<_>>();
    if unique.len() != process_ids.len() {
        return Err(AppError::Stats(
            "mutation qualification samples did not use distinct child processes".into(),
        ));
    }
    Ok(())
}

fn structural_qualification_failures(
    full_snapshot_tables: usize,
    full_anchor_rebuilds: usize,
    full_table_row_updates: usize,
    rebalanced_rows: usize,
    sparse_anchor_integrity: bool,
    compact_snapshot_shape: bool,
    inserted_precedes_target: Option<bool>,
    memory_near_doubling: bool,
) -> Vec<String> {
    let mut failures = Vec::new();
    for (count, label) in [
        (full_snapshot_tables, "full history snapshots"),
        (full_anchor_rebuilds, "full anchor rebuilds"),
        (full_table_row_updates, "full-table row updates"),
    ] {
        if count != 0 {
            failures.push(format!("{count} {label} observed"));
        }
    }
    if rebalanced_rows > 8_192 {
        failures.push(format!("local rebalance touched {rebalanced_rows} rows, exceeding 8192"));
    }
    if !sparse_anchor_integrity {
        failures.push("sparse anchor manifest integrity failed".into());
    }
    if !compact_snapshot_shape {
        failures.push("compact history snapshot shape failed".into());
    }
    if inserted_precedes_target == Some(false) {
        failures.push("middle insertion did not precede its target".into());
    }
    if memory_near_doubling {
        failures.push("retained or process memory approached dataset-copy doubling".into());
    }
    failures
}

fn launch_table_mutation_child(
    operation: Operation,
    rows: usize,
    columns: usize,
    sample_kind: &str,
    authorization: &MutationParentAuthorization,
) -> Result<TableMutationSampleReport, AppError> {
    let operation_arg = serde_json::to_value(operation)
        .map_err(|error| AppError::Stats(error.to_string()))?
        .as_str()
        .ok_or_else(|| AppError::Stats("mutation operation did not serialize as text".into()))?
        .replace('_', "-");
    let output = std::process::Command::new(
        std::env::current_exe().map_err(|error| AppError::FileIO(error.to_string()))?,
    )
    .args([
        "--mutation-child",
        &authorization.nonce,
        "--mutation-parent-pid",
        &authorization.parent_process_id.to_string(),
        "--rows",
        &rows.to_string(),
        "--columns",
        &columns.to_string(),
        "--operation",
        &operation_arg,
    ])
    .env("STATSPLAYGROUND_MUTATION_SAMPLE_KIND", sample_kind)
    .env(MUTATION_CHILD_NONCE_ENV, &authorization.nonce)
    .env(
        MUTATION_CHILD_PARENT_PID_ENV,
        authorization.parent_process_id.to_string(),
    )
    .output()
    .map_err(|error| AppError::FileIO(error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::Stats(format!(
            "mutation child failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::Stats(format!("invalid mutation child report: {error}")))
}

fn execute_table_mutation_qualification(
    operation: Operation,
    rows: usize,
    columns: usize,
    sample_count: usize,
    warmup_count: usize,
) -> Result<TableMutationPerformanceReport, AppError> {
    if !operation.is_table_mutation()
        || rows != 2_000_000
        || columns != 8
        || sample_count != 5
        || warmup_count != 1
    {
        return Err(AppError::InvalidParam(
            "mutation qualification protocol requires 2000000 rows, 8 columns, 5 samples, and 1 warmup".into(),
        ));
    }
    validate_binary_qualification_available(binary_qualification_available())?;
    let runtime_provenance = runtime_source_provenance()?;
    validate_source_provenance(
        binary_source_commit(),
        binary_source_dirty(),
        &runtime_provenance.head,
        runtime_provenance.dirty,
    )?;
    let parent_profile = binary_build_profile();
    let authorization = mutation_parent_authorization();
    let sample_plan = mutation_sample_plan(sample_count, warmup_count)?;
    let mut child_samples = Vec::with_capacity(sample_plan.len());
    for sample_kind in &sample_plan {
        child_samples.push(launch_table_mutation_child(
            operation,
            rows,
            columns,
            sample_kind,
            &authorization,
        )?);
    }
    let warmup_sample = child_samples.remove(0);
    let samples = child_samples;
    let all_samples = std::iter::once(&warmup_sample).chain(samples.iter()).collect::<Vec<_>>();
    validate_distinct_child_processes(
        &all_samples.iter().map(|sample| sample.process_id).collect::<Vec<_>>(),
    )?;
    let parent_machine = all_samples[0].machine.clone();
    let parent_machine_json = serde_json::to_value(&parent_machine)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    if all_samples.iter().zip(sample_plan.iter()).any(|(sample, sample_kind)| {
        sample.report_kind != "sample"
            || &sample.sample_kind != sample_kind
            || sample.binary_source_commit != binary_source_commit()
            || sample.binary_source_clean != !binary_source_dirty()
            || sample.build_profile != parent_profile
            || serde_json::to_value(&sample.machine).ok().as_ref() != Some(&parent_machine_json)
    }) {
        return Err(AppError::Stats(
            "mutation child provenance does not match parent provenance".into(),
        ));
    }
    let final_runtime_provenance = runtime_source_provenance()?;
    validate_source_provenance(
        binary_source_commit(),
        binary_source_dirty(),
        &final_runtime_provenance.head,
        final_runtime_provenance.dirty,
    )?;
    let total_wall_ms = samples
        .iter()
        .map(|sample| sample.total_wall_ms)
        .collect::<Vec<_>>();
    let median_ms = median(&total_wall_ms)
        .ok_or_else(|| AppError::Stats("mutation samples unexpectedly empty".into()))?;
    let stage_median = |select: fn(&TableMutationSampleReport) -> u128| {
        median(&samples.iter().map(select).collect::<Vec<_>>()).unwrap_or_default()
    };
    let max_of = |select: fn(&TableMutationSampleReport) -> usize| {
        samples.iter().map(select).max().unwrap_or_default()
    };
    let max_timing = |select: fn(&TableMutationSampleReport) -> u128| {
        samples.iter().map(select).max().unwrap_or_default()
    };
    let inserted_precedes_target = (operation == Operation::InsertMiddleRow).then(|| {
        samples
            .iter()
            .all(|sample| sample.inserted_precedes_target == Some(true))
    });
    let memory_near_doubling = samples.iter().any(|sample| {
        let process = sample.process_memory.as_ref().is_some_and(|memory| {
            u128::from(memory.peak_working_set_bytes) * 10
                >= u128::from(memory.baseline_working_set_bytes) * 18
        });
        let retained = sample.retained_memory_before_bytes > 0
            && u128::from(sample.retained_memory_after_bytes) * 10
                >= u128::from(sample.retained_memory_before_bytes) * 18;
        process || retained
    });
    Ok(TableMutationPerformanceReport {
        mutation_ms: stage_median(|sample| sample.mutation_ms),
        mutation_max_ms: max_timing(|sample| sample.mutation_ms),
        history_ms: stage_median(|sample| sample.history_ms),
        history_max_ms: max_timing(|sample| sample.history_ms),
        anchor_ms: stage_median(|sample| sample.anchor_ms),
        anchor_max_ms: max_timing(|sample| sample.anchor_ms),
        metadata_ms: stage_median(|sample| sample.metadata_ms),
        metadata_max_ms: max_timing(|sample| sample.metadata_ms),
        reload_ms: median(
            &samples
                .iter()
                .filter_map(|sample| sample.reload_ms)
                .collect::<Vec<_>>(),
        ),
        reload_max_ms: samples.iter().filter_map(|sample| sample.reload_ms).max(),
        median_ms,
        max_ms: total_wall_ms.iter().copied().max().unwrap_or(median_ms),
        threshold_ms: operation
            .qualification_threshold_ms()
            .ok_or_else(|| AppError::InvalidParam("missing mutation threshold".into()))?,
        sample_count,
        warmup_count,
        warmup_sample: Box::new(warmup_sample),
        full_snapshot_tables: max_of(|sample| sample.full_snapshot_tables),
        full_anchor_rebuilds: max_of(|sample| sample.full_anchor_rebuilds),
        full_table_row_updates: max_of(|sample| sample.full_table_row_updates),
        rebalanced_rows: max_of(|sample| sample.rebalanced_rows),
        sparse_anchor_integrity: samples.iter().all(|sample| sample.sparse_anchor_integrity),
        compact_snapshot_shape: samples.iter().all(|sample| sample.compact_snapshot_shape),
        inserted_precedes_target,
        memory_near_doubling,
        binary_source_commit: binary_source_commit().into(),
        binary_source_clean: !binary_source_dirty(),
        runtime_head: final_runtime_provenance.head,
        runtime_source_clean: !final_runtime_provenance.dirty,
        build_profile: parent_profile.into(),
        process_memory_method: process_memory_method(),
        samples,
    })
}

fn execute_table_mutation_report(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    if options.rows != 2_000_000 {
        return Err(AppError::InvalidParam(
            "table mutation qualification requires exactly 2000000 rows".into(),
        ));
    }
    let table_mutation = execute_table_mutation_qualification(
        options.operation,
        options.rows,
        options.columns,
        options.runs,
        1,
    )?;
    let mut failures = structural_qualification_failures(
        table_mutation.full_snapshot_tables,
        table_mutation.full_anchor_rebuilds,
        table_mutation.full_table_row_updates,
        table_mutation.rebalanced_rows,
        table_mutation.sparse_anchor_integrity,
        table_mutation.compact_snapshot_shape,
        table_mutation.inserted_precedes_target,
        table_mutation.memory_near_doubling,
    );
    if table_mutation.max_ms > table_mutation.threshold_ms {
        failures.push(format!(
            "maximum wall {} ms exceeds {} ms threshold",
            table_mutation.max_ms, table_mutation.threshold_ms
        ));
    }
    let qualification_failure = (!failures.is_empty()).then(|| failures.join("; "));
    let runs_ms = table_mutation
        .samples
        .iter()
        .map(|sample| sample.total_wall_ms)
        .collect::<Vec<_>>();
    let process_memory = table_mutation
        .samples
        .iter()
        .filter_map(|sample| sample.process_memory.clone())
        .max_by_key(|memory| memory.peak_working_set_bytes);
    let setup_ms = median(
        &table_mutation
            .samples
            .iter()
            .map(|sample| sample.setup_ms)
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    let operation_ms = table_mutation.max_ms;
    let anchor_ms = table_mutation.anchor_ms;
    let median_ms = table_mutation.median_ms;
    let result_rows = match options.operation {
        Operation::AppendRow | Operation::InsertMiddleRow => options.rows + 1,
        Operation::DeleteRows => options.rows - 1,
        _ => options.rows,
    };
    let selected_columns = match options.operation {
        Operation::AddColumn => options.columns + 1,
        Operation::DeleteColumn => options.columns - 1,
        _ => options.columns,
    };
    Ok(PerformanceReport {
        rows: options.rows, columns: options.columns, operation: options.operation,
        setup_ms, operation_ms, position_percent: None, target_start: None,
        lock_wait_ms: None, count_ms: None, anchor_ms: Some(anchor_ms),
        total_ms: total_started.elapsed().as_millis(), result_rows, selected_columns,
        query_ms: None, encode_ms: None, stdout_write_ms: None, decode_ms: None,
        draw_ms: None, processed_rows: None, source_rows: Some(options.rows as u64),
        chunks: None, transferred_bytes: None, projection_passes: None,
        invalid_x_count: None, archive_bytes: 0, max_retained_batch_bytes: None,
        max_encoded_batch_bytes: None, max_combined_batch_bytes: None,
        save_stage_ms: None, open_stage_ms: None, process_memory, graph_new: None,
        chain_depth: None,
        runs_ms: Some(runs_ms), median_ms: Some(median_ms),
        process_memory_method: process_memory_method(), physical_input_bytes: None,
        calculated_result_bytes: None, memory_budget_bytes: None,
        memory_growth_budget_multiplier: None,
        qualification_passed: Some(qualification_failure.is_none()),
        qualification_failure,
        machine: Some({
            let db = DuckDbEngine::new_in_memory()?;
            machine_report(duckdb_version(&db))
        }),
        tabulate: None,
        table_mutation: Some(table_mutation),
    })
}

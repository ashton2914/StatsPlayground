# Performance Baselines

StatsPlayground performance work uses deterministic DuckDB-generated data so
measurements do not include CSV parsing, network access, or fixture file I/O.
Run baselines from `src-tauri` with a release build:

```powershell
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation query
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation paste
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation restore
cargo run --release --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
cargo run --release --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation save
cargo run --release --example performance_baseline --features perf-harness -- --rows 1000000 --columns 20 --operation datalink
cargo run --release --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation calculated --chain-depth 5 --runs 5
```

The last stdout line is machine-readable JSON:

```json
{"rows":300000,"columns":20,"operation":"graph","setupMs":231,"operationMs":562,"totalMs":795,"resultRows":300000,"selectedColumns":3,"queryMs":552,"encodeMs":10,"decodeMs":"desktop_only","drawMs":"desktop_only","processedRows":300000,"transferredBytes":6078360}
```

Fields:

- `setupMs`: create the in-memory engine and generate the managed table with a
  set-based DuckDB `range()` query.
- `operationMs`: time spent in the selected application operation.
- `totalMs`: setup and operation wall-clock time.
- `resultRows`: rows returned or affected by the operation.
- `selectedColumns`: projected column count reported by `graph`.
- `queryMs`: backend projection/query pass time for the graph request.
- `encodeMs`: backend graph chunk encoding overhead.
- `decodeMs` / `drawMs`: `desktop_only` placeholders in CLI runs because Node
  benchmarks do not run repository Canvas/WebView rendering.
- `processedRows`: graph service completion row count.
- `transferredBytes`: header + payload + terminal bytes emitted by the graph
  stream.
- `archiveBytes`: output archive size in bytes for `save` (`0` for
  non-save operations).
- `maxRetainedBatchBytes`: peak retained row-batch bytes observed while the
  streaming save writer iterates table batches (present only for `save`). This
  is a conservative estimate based on row values and container capacities.
- `maxEncodedBatchBytes`: peak allocation capacity of the active encoded
  output chunk.
- `maxCombinedBatchBytes`: peak conservative sum of the retained row-batch
  estimate and encoded buffer capacities, including the pre-flush state. It is
  diagnostic rather than a hard cap or OS process-memory measurement.
- `saveStageMs`: elapsed milliseconds attributed to planning, query/fetch,
  batch encoding, ZIP writes/finish, file sync, validation, and replacement.
- `processMemory`: sampled process working-set baseline, peak, and delta during
  memory-qualified operations. Windows uses `GetProcessMemoryInfo`; macOS uses
  dependency-free `proc_pidinfo(PROC_PIDTASKINFO)` resident size. Unsupported
  platforms omit this field and cannot pass a memory-required qualification.
- `chainDepth`: number of calculated columns in the dependency chain for
  `calculated`.
- `runsMs`: elapsed milliseconds for each timed calculated source-column
  mutation and recalculation run.
- `medianMs`: median of `runsMs`; this is the qualification wall-time value for
  `calculated`.
- `processMemoryMethod`: process memory source used for the sampled working-set
  measurement.
- `physicalInputBytes`: estimated source table bytes for `calculated`, using 8
  bytes per physical cell.
- `calculatedResultBytes`: estimated calculated-result bytes, using 8 bytes per
  calculated cell.
- `memoryBudgetBytes`: maximum allowed working-set growth for `calculated`,
  computed as 2x (`physicalInputBytes` + `calculatedResultBytes`).
- `qualificationPassed` / `qualificationFailure`: pass/fail decision for
  thresholded benchmark operations. `calculated` fails when `medianMs` exceeds
  2000 ms, process memory is unavailable, or working-set delta exceeds the
  memory budget.

The current `paste` baseline deliberately includes construction of the nested
string payload consumed by `paste_at_position`. This represents part of the
existing end-to-end cost and exposes its peak-memory weakness, but it is not a
pure DuckDB ingestion measurement. Pressure runs can require several hundred
megabytes until Phase 4 replaces this payload with streaming TSV ingestion.

## Recorded Baseline

Date: 2026-08-18

Machine: Intel Core i7-1850H-class Windows laptop with NVMe storage, using the
Rust `release` profile. The first build took several minutes; compilation time
is excluded from the JSON operation timings.

| Rows | Columns | Operation | Setup | Operation | Total | Result rows |
|---:|---:|---|---:|---:|---:|---:|
| 100,000 | 20 | query | 108 ms | 7 ms | 116 ms | 500 |
| 100,000 | 20 | query (Phase 1 exit, 2026-08-19) | 150 ms | 9 ms | 159 ms | 500 |

## SQLite DataLink Baseline

Date: 2026-09-04

Profile: Rust `release`, using a generated SQLite table with repeating INTEGER,
REAL, TEXT, and BLOB columns. `operationMs` measures the production
`SqliteConnector` to DuckDB Appender and transaction path. SQLite fixture
generation is included in `setupMs`, not `operationMs`.

| Rows | Columns | Setup | Import | Total | Peak working-set delta |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 20 | 246 ms | 781 ms | 1,032 ms | 33,587,200 bytes (32.0 MiB) |
| 1,000,000 | 20 | 2,207 ms | 7,119 ms | 9,476 ms | 296,767,488 bytes (283.0 MiB) |

Both runs imported the requested row count successfully. The working-set delta
includes the final dataset retained by the in-memory DuckDB engine, SQLite and
DuckDB page caches, and bounded ingestion buffers. It therefore measures total
process growth during import, not transient ingestion-buffer memory alone.

## Calculated Columns Baseline

Date: 2026-09-16

Command:

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation calculated --chain-depth 5 --runs 5
```

Profile and workload:

- Rust `release` profile (`performance_baseline` example, `perf-harness` feature)
- Deterministic managed table seed: 300,000 rows x 20 columns
- Five-column linear calculated dependency chain
- One warm-up source-column mutation followed by five timed source-column
  mutations through the production table mutation coordinator
- Per-run process resident-size sampling via macOS
  `proc_pidinfo(PROC_PIDTASKINFO)`

Recorded JSON:

```json
{"rows":300000,"columns":20,"operation":"calculated","setupMs":598,"operationMs":108,"totalMs":1140,"resultRows":300000,"selectedColumns":5,"queryMs":null,"encodeMs":null,"decodeMs":null,"drawMs":null,"processedRows":300000,"transferredBytes":null,"archiveBytes":0,"processMemory":{"baselineWorkingSetBytes":473710592,"peakWorkingSetBytes":528564224,"deltaWorkingSetBytes":54853632},"chainDepth":5,"runsMs":[108,103,108,109,110],"medianMs":108,"processMemoryMethod":"proc_pidinfo PROC_PIDTASKINFO resident_size","physicalInputBytes":48000000,"calculatedResultBytes":12000000,"memoryBudgetBytes":120000000,"memoryGrowthBudgetMultiplier":2,"qualificationPassed":true,"machine":{"os":"macos 27.0","arch":"aarch64","cpu":"Apple M3 Pro","physicalMemoryBytes":38654705664,"appVersion":"0.1.0","duckdbVersion":"v1.5.5"}}
```

Acceptance decision:

- Wall-time gate passed: median 108 ms, below the 2000 ms threshold.
- Memory gate passed: peak per-run working-set delta 54,853,632 bytes, below the
  120,000,000 byte budget.
- All five runs completed against 300,000 rows and a five-level dependency chain.

## Save Current Baseline (Task 1)

Date: 2026-08-21

Machine facts:

- HP ZBook Power G7 Mobile Workstation
- Intel(R) Core(TM) i7-10850H CPU @ 2.70GHz (6 cores / 12 logical processors)
- 34,129,793,024 bytes RAM (~31.8 GiB)

Required command:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation save
```

Profile and project shape:

- Rust `release` profile (`performance_baseline` example, `perf-harness` feature)
- Deterministic managed table seed: 300,000 rows x 20 columns
- Representative non-empty project metadata included in the save payload

Task 1 baseline JSON (recorded 2026-08-21):

```json
{"rows":300000,"columns":20,"operation":"savecurrent","setupMs":277,"operationMs":3674,"totalMs":4708,"resultRows":300000,"archiveBytes":15830873}
```

Task 8 final review-hardened save JSONs (recorded 2026-08-24):

```json
{"rows":300000,"columns":20,"operation":"save","setupMs":256,"operationMs":2104,"totalMs":4413,"resultRows":300000,"archiveBytes":20635182,"maxRetainedBatchBytes":8195356,"maxEncodedBatchBytes":1048576,"maxCombinedBatchBytes":8195612,"saveStageMs":{"plan":1,"queryFetch":1414,"batchEncode":220,"zipWrite":280,"zipFinish":0,"syncAll":27,"validation":9,"replacement":4},"processMemory":{"baselineWorkingSetBytes":110669824,"peakWorkingSetBytes":132132864,"deltaWorkingSetBytes":21463040}}
{"rows":300000,"columns":20,"operation":"save","setupMs":253,"operationMs":2182,"totalMs":4569,"resultRows":300000,"archiveBytes":20635182,"maxRetainedBatchBytes":8195356,"maxEncodedBatchBytes":1048576,"maxCombinedBatchBytes":8195612,"saveStageMs":{"plan":1,"queryFetch":1456,"batchEncode":247,"zipWrite":291,"zipFinish":0,"syncAll":35,"validation":12,"replacement":4},"processMemory":{"baselineWorkingSetBytes":98922496,"peakWorkingSetBytes":132530176,"deltaWorkingSetBytes":33607680}}
```

Measured operation summary:

- `operationMs`: 2104 ms and 2182 ms (2143 ms median), 40.6-42.7 percent
  faster than the 3674 ms Task 1 baseline and 87.8-88.3 percent faster than
  the first 17925 ms streaming draft.
- `resultRows`: 300000; the benchmark reopens the archive and counts the
  streamed rows outside `operationMs`.
- `maxRetainedBatchBytes`: 8195356 bytes, below the 8 MiB retained-batch cap.
- `processMemory.deltaWorkingSetBytes`: 21463040-33607680 bytes
  (~20.5-32.1 MiB), below the 100 MB gate.
- `saveStageMs.queryFetch`: 1414-1456 ms after caching the repeated keyset
  statement; `saveStageMs.validation`: 9-12 ms after limiting pre-placement
  validation to the approved ZIP, manifest, expected-entry, and small-metadata
  contract.

Acceptance decision:

- The original strict wall-time gate required at least 50 percent improvement
  (`operationMs <= 1837`). The final run is 142 ms above that threshold.
- On 2026-08-24, the current performance was explicitly accepted for Task 8.
  The final review-hardened median is 2143 ms, within the 2200 ms practical
  acceptance threshold; further reduction to 1837 ms remains a non-blocking
  optimization target because the remaining cost is dominated by DuckDB row
  fetch/value materialization and ZIP output.
- The memory gate passed. Archive shape and row count remain covered by the
  compatibility, writer, and benchmark reopen checks.

Automated responsiveness evidence:

- Progress cadence is covered by the streaming writer throttle, checkpoint,
  and heartbeat tests.
- Read-only access between save batches is covered by
  `stream_writer_allows_read_interleaving_between_batches`.
- Interactive desktop UI heartbeat and read-query latency are external
  acceptance items and are not claimed by this headless benchmark.

Known baseline risk (not addressed by Task 1): destination replacement still
uses remove-before-rename semantics, so a crash between those steps remains a
post-remove/pre-rename risk window.

This baseline demonstrates that set-based DuckDB generation and bounded reads
are already fast. It does not measure the current WebView full-table JSON IPC,
React state copies, SQL isolation snapshot copy, or project JSON restoration;
those are measured by the other operations and phase-specific instrumentation.

Absolute timing thresholds do not run in normal CI because shared runner
hardware varies. Normal tests assert fixture shape and bounded result sizes.
Release acceptance compares phase timings and memory on the same machine class.

## Task 5 Natural-Order 10M Table Navigation Benchmark (2026-09-17)

Command:

```powershell
/Users/ashton/git/ashton2914/StatsPlayground.worktrees/224-10m-table-navigation/src-tauri/target/release/examples/performance_baseline --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Environment facts:

- Date: 2026-09-17
- OS: macOS
- Build profile: Rust `release`
- Dataset shape: 10,000,000 rows x 20 columns
- Navigation mode: natural-order table navigation at 99%

Exact JSON emitted by the benchmark:

```json
{"rows":10000000,"columns":20,"operation":"table_navigation","setupMs":2914,"operationMs":12,"positionPercent":99,"targetStart":9899505,"lockWaitMs":0,"countMs":0,"anchorMs":0,"totalMs":2927,"resultRows":500,"selectedColumns":21,"queryMs":11,"encodeMs":0,"decodeMs":null,"drawMs":null,"processedRows":null,"transferredBytes":116921,"archiveBytes":0}
```

Interpretation:

- `queryMs` was 11 ms, which is comfortably under the 100 ms cold natural-jump target.
- The legacy Task 1 navigation baseline recorded `queryMs` 1140 ms, so this run is materially faster on the settled navigation path.
- `setupMs` was 2914 ms, but it is excluded from settled navigation latency because it creates and seeds the 10M table and its natural-order anchors.
- The returned viewport had 500 rows, 21 selected columns including `_row_id`, and 116921 transferred bytes.

## Task 8 Transport Gate (2026-09-17)

Decision: APPROVED. Retain JSON transport; no Arrow IPC implementation is introduced.

Environment facts:

- OS: macOS
- CPU: Apple M3 Pro
- Node: v24.20.0
- Build profile: Rust `release` (`performance_baseline` with `perf-harness`)
- Dataset shape: 10,000,000 rows
- Viewport shape: 500 backend rows, 40 painted frontend rows
- Navigation mode: natural-order table navigation at 99%

Actual invoke evidence:

- A real macOS Tauri invoke runner exists locally in `src/benchmarks/TableNavigationTransportBenchmark.tsx` and is launched by `scripts/measureTableNavigationTransport.mjs`.
- Both workloads ran in release Tauri/WKWebView with 5 warmups and 20 measured invokes at the 99% position.
- Both artifacts report `progress.done: true`, 25 completed runs, and 20 measured runs.

| Workload | Query p95 | Diagnostic JSON encode p95 | Invoke wall p95 | Post-backend delivery p95 | JSON reparse p95 | Paint p95 | JSON bytes p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 columns | 7 ms | 0 ms | 10 ms | 1 ms | 1 ms | 25 ms | 117045 |
| 200 columns | 38 ms | 3 ms | 53 ms | 15 ms | 3 ms | 22 ms | 1282804 |

Required backend benchmark command:

```powershell
cd src-tauri && cargo run --release --example performance_baseline --features perf-harness -- --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Retained backend benchmark JSON artifact:

```json
{"rows":10000000,"columns":20,"operation":"table_navigation","setupMs":2442,"operationMs":10,"positionPercent":99,"targetStart":9899505,"lockWaitMs":0,"countMs":0,"anchorMs":0,"totalMs":2453,"resultRows":500,"selectedColumns":21,"queryMs":9,"encodeMs":0,"transferMs":null,"decodeMs":null,"drawMs":null,"processedRows":null,"transferredBytes":116920,"archiveBytes":0}
```

Valid retained browser snapshot replay evidence from the current artifacts:

| Workload | Snapshot JSON parse p50 / p95 | Browser paint p50 / p95 | Snapshot bytes p50 / p95 |
| --- | ---: | ---: | ---: |
| 20 columns | 0.3 / 0.3 ms | 30.1 / 31.0 ms | 116920 / 116920 |
| 200 columns | 1.9 / 2.0 ms | 44.9 / 46.6 ms | 1282678 / 1282678 |

Interpretation:

- The required encode, delivery, and decode-proxy P95 slices are below the 20 ms gate for both workloads.
- The 200-column invoke wall P95 is 53 ms, below the 100 ms settled-navigation target.
- CLI stdout capture must not be labeled or interpreted as Tauri transfer. The perf harness now uses `stdoutWriteMs` for `--payload-stdout` captures to make that distinction explicit.
- Ordinary navigation no longer requests diagnostics by default; runtime diagnostic JSON encode and size measurements are now opt-in so the product path does not pay duplicate serialization overhead outside dedicated measurement work.
- These are explicitly named proxy slices rather than internal Tauri serializer/bridge instrumentation. They approve JSON for this gate; Windows WebView acceptance remains in Task 9.

## Task 9 Automated Acceptance (2026-09-17)

The macOS automated regression gate passed five table-focused TypeScript scripts, 21 Playwright component cases, the frontend production build, 29 focused Rust table-navigation tests, command registration classification, and `cargo build`.

The full Rust suite passed 819 of 820 runnable tests with 18 ignored. The remaining failure is the unrelated Distribution archive case `distribution_v4_rejects_missing_duplicate_mismatched_and_unsafe_manifest_entries` on a branch 71 commits behind `origin/dev`. Strict `cargo clippy -- -D warnings` is still blocked by the existing repository-wide lint baseline in unrelated code.

Full cross-platform acceptance is not claimed. Windows WebView2 execution and the complete 0/50/90/99/100 natural-order plus prepared-session matrix on both platforms remain pending external evidence.

## GraphBuilderView Old-Path Baseline (Pending Desktop Capture)

Task 1 requires a manual baseline note for the old `GraphBuilderView` path at
300,000 rows and 20 columns. This environment can run the Rust perf harness,
but cannot produce a reproducible desktop WebView wall-time and peak-working-set
measurement without the interactive UI session.

Use this release command to keep the data shape aligned with the baseline run:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

## Task 8 Unified Graph Gate (2026-08-21)

Command:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

Environment facts:

- OS: Windows
- Build profile: Rust `release` with `--features perf-harness`
- Operation mode: Full Data (no sampling fallback)
- Graph request: `x=region`, `y=cost`, `elements=[points]`
- Processed rows: `300000`

Recorded JSON:

```json
{"rows":300000,"columns":20,"operation":"graph","setupMs":231,"operationMs":562,"totalMs":795,"resultRows":300000,"selectedColumns":3,"queryMs":552,"encodeMs":10,"decodeMs":"desktop_only","drawMs":"desktop_only","processedRows":300000,"transferredBytes":6078360}
```

Desktop gate status:

- Cold complete-frame: `PENDING_DESKTOP_CAPTURE`
- Warm complete-frame: `PENDING_DESKTOP_CAPTURE`
- WebView tasks >200 ms: `PENDING_DESKTOP_CAPTURE`
- Desktop transferred bytes (WebView-observed): `PENDING_DESKTOP_CAPTURE`
- Peak working set: `PENDING_DESKTOP_CAPTURE`

Reason pending: this non-interactive CLI harness can verify backend graph
streaming and byte counts, but it cannot objectively drive and measure a full
desktop WebView frame lifecycle for the existing 300,000-row project.

Executable desktop capture instructions:

1. Start the desktop app and open a project containing one table with exactly
  `300000` rows.
2. Open Graph Builder, ensure sampling mode is Full Data, and bind `region` to
  X and `cost` to Y.
3. Use DevTools Performance panel to capture cold and warm complete-frame runs.
4. Record long tasks over 200 ms and transferred bytes from the stream events.
5. In a second PowerShell shell, run the working-set capture script below while
  triggering the graph render.

```powershell
$proc = Get-Process -Name StatsPlayground -ErrorAction Stop
$baseline = [pscustomobject]@{
  WorkingSet64 = $proc.WorkingSet64
  PeakWorkingSet64 = $proc.PeakWorkingSet64
}

"READY: put focus on the desktop UI action that triggers graph render."
"Press Enter here at the exact moment you click render in the UI."
Read-Host | Out-Null
$start = Get-Date
"START marker: $($start.ToString('o'))"

"Press Enter here when the graph is fully painted and interactive."
Read-Host | Out-Null
$stop = Get-Date
"STOP marker:  $($stop.ToString('o'))"

$proc = Get-Process -Id $proc.Id -ErrorAction Stop
$capture = [pscustomobject]@{
  WallMs = [math]::Round(($stop - $start).TotalMilliseconds, 3)
  WorkingSet64 = $proc.WorkingSet64
  PeakWorkingSet64 = $proc.PeakWorkingSet64
  DeltaWorkingSet64 = $proc.WorkingSet64 - $baseline.WorkingSet64
  DeltaPeakWorkingSet64 = $proc.PeakWorkingSet64 - $baseline.PeakWorkingSet64
}
$capture | Format-List
```

Manual UI actions (old `GraphBuilderView` path, desktop app):

1. Start StatsPlayground desktop build that still uses old `GraphBuilderView`.
2. Create/open a workspace and load a table with exactly 300,000 rows and 20
   columns.
3. Open graph builder and choose a graph type that renders immediately from the
   selected table (no additional filters/transforms).
4. Ensure the table is selected as graph input, then trigger the final action
  that renders the chart while running the canonical capture script above.

Timing note:

- The command block above captures both wall-time (`WallMs`) and memory deltas
  using explicit start/stop markers.
- For repeatability, run three captures and record median `WallMs` and highest
  `PeakWorkingSet64`.

Recorded values:

- Old-path wall time (ms): PENDING_DESKTOP_CAPTURE
- Old-path peak working set (bytes): PENDING_DESKTOP_CAPTURE

## Task 6 Unified Graph Benchmark (2026-08-25)

Requested benchmark command from task brief:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph_projection
```

Observed command result: the current harness rejects `graph_projection` with
`Invalid parameter: unknown operation: graph_projection`.

Supported equivalent used for this baseline:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

Environment facts:

- Date: 2026-08-25
- OS: Windows
- Build profile: Rust `release` with `--features perf-harness`
- Data mode: Full Data (benchmark graph request)
- Shape: 300,000 rows x 20 columns

Raw JSON emitted by benchmark:

```json
{"rows":300000,"columns":20,"operation":"graph","setupMs":62,"operationMs":204,"totalMs":267,"resultRows":300000,"selectedColumns":3,"queryMs":200,"encodeMs":4,"decodeMs":"desktop_only","drawMs":"desktop_only","processedRows":300000,"transferredBytes":6078360,"archiveBytes":0}
```

Observed values:

- `resultRows`: 300000
- `selectedColumns`: 3
- `processedRows`: 300000
- `transferredBytes`: 6078360 bytes
- `setupMs`: 62 ms
- `operationMs`: 204 ms
- `totalMs`: 267 ms

Outer process timing (PowerShell stopwatch around process start -> exit):

- Wall time: 2735.154 ms

Peak working-set capture method (PowerShell external sampler while process ran):

- Baseline working set: 17735680 bytes
- Baseline peak working set: 17735680 bytes
- Max observed working set: 22863872 bytes
- Max observed peak working set: 23007232 bytes
- Delta working set: 5128192 bytes
- Delta peak working set: 5271552 bytes

Notes:

- `decodeMs` and `drawMs` remain `desktop_only` in CLI runs and are not
  interpreted as measured desktop frame timings.
- This run reports only fields emitted by the harness JSON and externally
  sampled process working-set data.
- Harness operation parsing currently accepts `graph` and rejects
  `graph_projection` as an unknown operation.
- In this harness, `graph` executes one graph projection pass and emits the
  projection telemetry fields (`selectedColumns`, `resultRows`,
  `processedRows`, `transferredBytes`) for that pass.
- Therefore `--operation graph` is the current projection benchmark command,
  not a semantically different substitute for a separate `graph_projection`
  mode.

## Task 1 Table Navigation Baseline (2026-09-17)

Command run once for the 10M-row table-navigation gate:

```powershell
/Users/ashton/git/ashton2914/StatsPlayground.worktrees/224-10m-table-navigation/src-tauri/target/release/examples/performance_baseline --rows 10000000 --columns 20 --operation table-navigation --position-percent 99
```

Environment facts:

- OS: macOS
- Build profile: Rust `release` with `--features perf-harness`
- Executable: `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/224-10m-table-navigation/src-tauri/target/release/examples/performance_baseline`
- Dataset shape: 10,000,000 rows x 20 columns
- Position: 99%

Captured JSON:

```json
{"rows":10000000,"columns":20,"operation":"table_navigation","setupMs":2398,"operationMs":1147,"positionPercent":99,"targetStart":9899505,"lockWaitMs":0,"countMs":6,"anchorMs":0,"totalMs":3546,"resultRows":500,"selectedColumns":0,"queryMs":1140,"encodeMs":0,"decodeMs":null,"drawMs":null,"processedRows":null,"transferredBytes":116767,"archiveBytes":0}
```

Measured stage values:

- `setupMs`: 2398 ms
- `operationMs`: 1147 ms
- `totalMs`: 3546 ms
- `positionPercent`: 99
- `targetStart`: 9899505
- `lockWaitMs`: 0 ms
- `countMs`: 6 ms
- `anchorMs`: 0 ms
- `resultRows`: 500
- `selectedColumns`: 0
- `queryMs`: 1140 ms
- `encodeMs`: 0 ms
- `transferredBytes`: 116767 bytes
- `archiveBytes`: 0
- `decodeMs` / `drawMs` / `processedRows`: `null`

Artifact:

- [task-1-benchmark.json](../.superpowers/sdd/2026-09-17-10m-row-table-random-navigation/task-1-benchmark.json)

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
- `processMemory`: Windows-only sampled process working-set baseline, peak, and
  delta during `save`; it is omitted on other platforms. This is the
  acceptance measurement for additional process memory on the recorded Windows
  machine.

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

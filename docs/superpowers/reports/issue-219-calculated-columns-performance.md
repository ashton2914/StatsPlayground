# Issue 219 Calculated Columns Performance Evidence

Date: 2026-09-16

Worktree: `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/219-calculated-table-columns`

Command:

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation calculated --chain-depth 5 --runs 5
```

Benchmark shape:

- Rows: 300,000
- Physical columns: 20
- Operation: `calculated`
- Calculated dependency chain depth: 5
- Timed runs: 5
- Warm-up: one source-column mutation before timing
- Execution path: production `execute_table_mutation` with calculated-column recalculation

Machine metadata:

- OS: macos 27.0
- Architecture: aarch64
- CPU: Apple M3 Pro
- Physical memory: 38,654,705,664 bytes
- App version: 0.1.0
- DuckDB version: v1.5.5

Memory measurement:

- Method: `proc_pidinfo PROC_PIDTASKINFO resident_size`
- Baseline working set: 473,710,592 bytes
- Peak working set: 528,564,224 bytes
- Delta working set: 54,853,632 bytes
- Physical input estimate: 48,000,000 bytes
- Calculated result estimate: 12,000,000 bytes
- Budget multiplier: 2
- Memory budget: 120,000,000 bytes

Timing:

- Runs: 108 ms, 103 ms, 108 ms, 109 ms, 110 ms
- Median: 108 ms
- Threshold: 2,000 ms

Recorded JSON:

```json
{"rows":300000,"columns":20,"operation":"calculated","setupMs":598,"operationMs":108,"totalMs":1140,"resultRows":300000,"selectedColumns":5,"queryMs":null,"encodeMs":null,"decodeMs":null,"drawMs":null,"processedRows":300000,"transferredBytes":null,"archiveBytes":0,"processMemory":{"baselineWorkingSetBytes":473710592,"peakWorkingSetBytes":528564224,"deltaWorkingSetBytes":54853632},"chainDepth":5,"runsMs":[108,103,108,109,110],"medianMs":108,"processMemoryMethod":"proc_pidinfo PROC_PIDTASKINFO resident_size","physicalInputBytes":48000000,"calculatedResultBytes":12000000,"memoryBudgetBytes":120000000,"memoryGrowthBudgetMultiplier":2,"qualificationPassed":true,"machine":{"os":"macos 27.0","arch":"aarch64","cpu":"Apple M3 Pro","physicalMemoryBytes":38654705664,"appVersion":"0.1.0","duckdbVersion":"v1.5.5"}}
```

Result: PASS

- Wall-time qualification passed: 108 ms median is below 2,000 ms.
- Memory qualification passed: 54,853,632 bytes is below the 120,000,000 byte budget.
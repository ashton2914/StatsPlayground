# Large-table mutation qualification

The native performance harness qualifies the production compact row and column
mutation paths against a fixture of exactly 2,000,000 rows and eight physical
columns. Mutation qualification rejects any other row count, column count,
measured-sample count, or warmup count.

## Run policy

Use the release example binary, one operation per process:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --release \
  --features perf-harness --example performance_baseline -- \
  --rows 2000000 --columns 8 --operation append-row
```

Replace `append-row` with `insert-middle-row`, `add-column`, `delete-rows`,
or `delete-column`. The parent launches one warmup child process and five
measured child processes via `current_exe`; every child seeds one fixture,
runs one production mutation/reload, emits one sample, and exits. The parent
rejects repeated PIDs, child failures, or source/build/platform provenance
mismatches. Each sample records its PID and role. `medianMs` and `maxMs` are
reported; five samples are not labeled P95. `maxMs`, not the median, is the
qualification value. Mutation mode fixes `--runs` at 5; other harness
operations retain their one-run default.

The example target is required. Running the package binary without
`--example performance_baseline` starts the Tauri desktop application rather
than the CLI harness.

## Metrics

- Mutation qualification is nested under `mutationQualification`; it is not
  flattened into the common report, so JSON keys are unambiguous.
- `mutationMs`, `historyMs`, `anchorMs`, `metadataMs`, and `reloadMs` are
  independently aggregated medians. Their corresponding `*MaxMs` fields are
  independent maxima. Phase statistics are not additive and must not be
  summed to reconstruct `medianMs` or `maxMs`.
- Production phase spans are disjoint: mutation covers the physical row/schema
  mutation; history covers schema capture and compact delta/snapshot writes;
  anchor covers natural-order allocation/resolution and sparse-anchor
  publication/copy; metadata covers row/column counts and generation
  publication; reload covers the production current-window query.
- `totalWallMs` additionally includes transaction begin/commit, generation
  validation/fencing, descriptor/dependency resolution, orchestration between
  measured spans, memory-sampler startup/join, and other production work not
  assigned to a phase. Fixture setup and post-run structural audits are
  excluded from `totalWallMs`.
- Each `samples[]` entry contains `totalWallMs`, all phase timings, DuckDB
  retained memory before/after, and whole-process RSS baseline/peak/delta.
- `processMemoryMethod` identifies the platform RSS API.
- `setupMs` is fixture creation and is excluded from the mutation threshold.
- Structural fields must show no `_history_full_before_*` table, no full anchor
  rebuild, no observed unbounded/global row-order update affecting at least
  90% of the dataset, at most 8,192 locally rebalanced rows,
  valid sparse anchor/manifest state, and the expected compact delta snapshot.
- `memoryNearDoubling` fails when retained memory or RSS reaches at least 1.8×
  its pre-mutation baseline.

Thresholds are append row 1,000 ms; middle insert 2,000 ms; add empty column
2,000 ms; delete a row/small row set 2,000 ms; and delete one column 5,000 ms.
Any timing, memory, fixture, or structural failure sets
`qualificationPassed = false` and makes the harness exit unsuccessfully.

## Superseded initial baseline

The figures below came from the initial same-process sampler and are retained
only for historical comparison. They are not current qualification evidence;
the fix-round independent-process baseline follows after source freeze.

Source commit: `8f60b4e88da056e3bd7eafa08944b4f9fae2152e`  
Profile: release  
Platform: macOS 27.0, aarch64, Apple M3 Pro, 36 GiB physical memory  
DuckDB: v1.5.5  
Samples: one warmup plus five measured samples per operation

| Operation | Runs (ms) | Median | Max / threshold | Mutation | History | Anchor | Metadata | Reload |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Append row | 69, 67, 67, 67, 67 | 67 | 69 / 1,000 | 1 | 3 | 47 | 1 | 14 |
| Insert middle row | 82, 73, 77, 77, 75 | 77 | 82 / 2,000 | 1 | 3 | 55 | 1 | 14 |
| Add empty column | 36, 35, 35, 36, 36 | 36 | 36 / 2,000 | 8 | 3 | 3 | 1 | 14 |
| Delete one row | 36, 36, 37, 36, 36 | 36 | 37 / 2,000 | 1 | 4 | 17 | 1 | 14 |
| Delete one column | 46, 44, 39, 45, 45 | 45 | 46 / 5,000 | 1 | 19 | 3 | 1 | 13 |

All five operations passed every structural assertion. Middle insertion
preceded its requested target. No operation approached a retained-memory or RSS
doubling. Maximum observed RSS deltas ranged from 49,152 bytes to 4,653,056
bytes; DuckDB retained memory after mutation ranged from 34,770,944 to
47,749,120 bytes from a 30,353,408-byte baseline.

Raw JSON evidence and the detailed run report are durable ignored SDD artifacts
under `.superpowers/sdd/2026-09-20-issue-241-large-table-mutations/`.

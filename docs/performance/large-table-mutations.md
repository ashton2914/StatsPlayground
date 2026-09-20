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
authorizes child mode with a per-parent random nonce and the operating-system
parent PID. Direct or incorrectly authorized `--mutation-child` invocations
fail before fixture creation. Children emit `reportKind: "sample"` and never
emit `qualificationPassed`; only the parent applies qualification thresholds.
The parent rejects repeated PIDs, child failures, or source/build/platform
provenance mismatches. Each sample records its PID and role. `medianMs` and `maxMs` are
reported; five samples are not labeled P95. `maxMs`, not the median, is the
qualification value. Mutation mode fixes `--runs` at 5; other harness
operations retain their one-run default.

The build script records the authoritative Git commit, dirty state, and build
profile in the executable at compile time. Before launching children and again
after collecting them, the parent requires the embedded source to have been
clean (`binarySourceClean`), runtime `HEAD` to equal `binarySourceCommit`, and
the runtime worktree to remain clean (`runtimeSourceClean`). Children must
report the same compile-time provenance.

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
  rebuild, no observed unbounded/global row-order update, no bounded update
  affecting at least 90% of the dataset, at most 8,192 locally rebalanced rows,
  valid sparse anchor/manifest state, and the expected compact delta snapshot.
- `memoryNearDoubling` fails when retained memory or RSS reaches at least 1.8×
  its pre-mutation baseline.

Thresholds are append row 1,000 ms; middle insert 2,000 ms; add empty column
2,000 ms; delete a row/small row set 2,000 ms; and delete one column 5,000 ms.
Any timing, memory, fixture, or structural failure sets
`qualificationPassed = false` and makes the harness exit unsuccessfully.

## Independent-process baseline: 2026-09-21 (fix round 2)

Measured source commit: `2ac7363d6c393d81ab1cb851fe4300913fc4476d`

Profile: release

Platform: macOS 27.0, aarch64, Apple M3 Pro, 36 GiB physical memory

DuckDB: v1.5.5

Samples: one warmup child plus five measured child processes per operation

Phase columns show median/max milliseconds.

| Operation | Runs (ms) | Median | Max / threshold | Mutation | History | Anchor | Metadata | Reload |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Append row | 77, 76, 71, 70, 74 | 74 | 77 / 1,000 | 1/1 | 3/3 | 50/51 | 1/1 | 14/15 |
| Insert middle row | 82, 84, 81, 81, 83 | 82 | 84 / 2,000 | 1/1 | 3/3 | 57/60 | 1/1 | 15/15 |
| Add empty column | 37, 37, 36, 37, 35 | 37 | 37 / 2,000 | 8/8 | 4/4 | 3/3 | 1/1 | 15/16 |
| Delete one row | 42, 36, 43, 44, 44 | 43 | 44 / 2,000 | 1/1 | 4/4 | 17/18 | 1/1 | 14/15 |
| Delete one column | 44, 47, 48, 40, 44 | 44 | 48 / 5,000 | 1/2 | 20/20 | 3/3 | 1/1 | 14/15 |

All five operations passed every structural assertion. Middle insertion
preceded its requested target. No operation approached a retained-memory or RSS
doubling. Every operation records six distinct child PIDs and one sample per
child. Maximum observed RSS deltas ranged from 507,904 bytes to 79,888,384
bytes; DuckDB retained memory after mutation ranged from 34,770,944 to
47,749,120 bytes from a 30,353,408-byte baseline.

Raw JSON evidence and the detailed run report are durable ignored SDD artifacts
under `.superpowers/sdd/2026-09-20-issue-241-large-table-mutations/`.

# Large-table mutation qualification

The native performance harness qualifies the production compact row and column
mutation paths against a fixture of exactly 2,000,000 rows and eight physical
columns. Mutation qualification rejects any other row count.

## Run policy

Use the release example binary, one operation per process:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --release \
  --features perf-harness --example performance_baseline -- \
  --rows 2000000 --columns 8 --operation append-row
```

Replace `append-row` with `insert-middle-row`, `add-column`, `delete-rows`,
or `delete-column`. Each invocation performs one unreported warmup and five
measured samples on independently seeded fixtures. `medianMs` and `maxMs` are
reported; five samples are not labeled P95. `maxMs`, not the median, is the
qualification value.

The example target is required. Running the package binary without
`--example performance_baseline` starts the Tauri desktop application rather
than the CLI harness.

## Metrics

- `mutationMs`, `historyMs`, `anchorMs`, and `metadataMs` are median native
  timings observed at production compact-mutation phase boundaries.
- `reloadMs` is the median production current-window reload.
- Each `samples[]` entry contains `totalWallMs`, all phase timings, DuckDB
  retained memory before/after, and whole-process RSS baseline/peak/delta.
- `processMemoryMethod` identifies the platform RSS API.
- `setupMs` is fixture creation and is excluded from the mutation threshold.
- Structural fields must show no `_history_full_before_*` table, no full anchor
  rebuild, no full-table row update, at most 8,192 locally rebalanced rows,
  valid sparse anchor/manifest state, and the expected compact delta snapshot.
- `memoryNearDoubling` fails when retained memory or RSS reaches at least 1.8×
  its pre-mutation baseline.

Thresholds are append row 1,000 ms; middle insert 2,000 ms; add empty column
2,000 ms; delete a row/small row set 2,000 ms; and delete one column 5,000 ms.
Any timing, memory, fixture, or structural failure sets
`qualificationPassed = false` and makes the harness exit unsuccessfully.

## Baseline: 2026-09-21

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

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

With `perf-harness`, the build script requires Git and records its authoritative
commit, dirty state, and build profile in the executable at compile time.
Without that feature, it does not invoke Git and emits explicit
`unavailable`/not-qualified metadata so ordinary source-archive and package
builds remain supported. Before launching children and again after collecting
them, the qualification parent requires available metadata, clean embedded
source (`binarySourceClean`), runtime `HEAD` equal to `binarySourceCommit`, and
a clean runtime worktree (`runtimeSourceClean`). Children must report the same
compile-time provenance.

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
- `services/row_order_update_boundary.rs` is the sole production authority for
  SQL that updates `_row_order`. A test recursively scans every Rust source
  below `src-tauri/src`, excluding `target`, `generated`, and AST items marked
  `#[cfg(test)]`. The test uses `syn` to parse Rust syntax and visit production
  expressions. It decodes normal, raw, byte, and raw-byte literals, recursively
  evaluates literal-only `concat!`, and treats unresolved macros containing
  `_row_order` plus update-building tokens as update constructions. Comments
  are discarded by the Rust parser, while comment-like text inside strings
  remains data. Production `macro_rules!` bodies are inspected before their
  invocations, unresolved empty code-generating macros fail closed, and
  `include!` fails closed. Literal and literal-`concat!` paths passed to
  `include_str!`/`include_bytes!` are resolved relative to the containing Rust
  source (including `CARGO_MANIFEST_DIR`), constrained to the repository root,
  read, and scanned. Missing, nonliteral, unreadable, non-UTF-8, or out-of-root
  inputs fail closed. Legitimate JSON includes are permitted only because their
  verified content contains no row-order UPDATE. The authority must contain
  exactly one production construction; every other production module must
  contain zero.
- `memoryNearDoubling` fails when retained memory or RSS reaches at least 1.8×
  its pre-mutation baseline.

Thresholds are append row 1,000 ms; middle insert 2,000 ms; add empty column
2,000 ms; delete a row/small row set 2,000 ms; and delete one column 5,000 ms.
Any timing, memory, fixture, or structural failure sets
`qualificationPassed = false` and makes the harness exit unsuccessfully.

## Independent-process baseline: 2026-09-21 (fix round 4)

Measured source commit: `e5da17e97bdb10afbfa56e991a3ca0779e913c5c`

Profile: release

Platform: macOS 27.0, aarch64, Apple M3 Pro, 36 GiB physical memory

DuckDB: v1.5.5

Samples: one warmup child plus five measured child processes per operation

Phase columns show median/max milliseconds.

| Operation | Runs (ms) | Median | Max / threshold | Mutation | History | Anchor | Metadata | Reload |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Append row | 71, 74, 74, 77, 68 | 74 | 77 / 1,000 | 1/1 | 3/3 | 50/51 | 1/1 | 14/14 |
| Insert middle row | 87, 85, 79, 83, 84 | 84 | 87 / 2,000 | 1/1 | 3/3 | 59/60 | 1/1 | 14/15 |
| Add empty column | 38, 37, 36, 37, 37 | 37 | 38 / 2,000 | 8/8 | 4/4 | 3/3 | 1/1 | 14/16 |
| Delete one row | 42, 36, 36, 37, 37 | 37 | 42 / 2,000 | 1/1 | 4/4 | 17/17 | 1/1 | 14/14 |
| Delete one column | 44, 43, 46, 47, 40 | 44 | 47 / 5,000 | 1/2 | 20/21 | 3/3 | 1/1 | 14/14 |

All five operations passed every structural assertion. Middle insertion
preceded its requested target. No operation approached a retained-memory or RSS
doubling. Every operation records six distinct child PIDs and one sample per
child. Maximum observed RSS deltas ranged from 376,832 bytes to 81,657,856
bytes; DuckDB retained memory after mutation ranged from 34,508,800 to
47,749,120 bytes from 30,091,264–30,353,408-byte baselines.

Raw JSON evidence and the detailed run report are durable ignored SDD artifacts
under `.superpowers/sdd/2026-09-20-issue-241-large-table-mutations/`.

## Task 9 release-gate repair: 2026-09-21

The deterministic serial gate initially reported 12 failures. Nine were legacy
generation-zero fixtures without controlled natural-anchor manifests. The
tabulate fixture now uses the managed-table helper and publishes rebuilt
manifests after fixture mutations; SQLite append now advances the generation
before replacing the old row-count metadata, then rebuilds the new generation.

The remaining failures were unified-history v2 contract gaps: full-history
column replay no longer reapplies ordinal metadata after add/delete replay,
unchanged columns are expected in the complete history schema, and the
canonical archive result now includes the empty-history cursor (`-1`).

Parallel execution exposed process-global test state. Test builds now isolate
Graph New cache pools, benchmark cache directories, anchor observers, and
row-order counters per test/thread. Production and `perf-harness` builds retain
the process-global memory budget and atomic qualification counters.

Final Rust results:

- `cargo test -- --test-threads=1`: 1,407 passed, 18 ignored; integration
  suites also passed (3 build-provenance and 7 MCP HTTP tests).
- `cargo test`: the same 1,407 passed and 18 ignored under ordinary parallel
  execution; integration suites also passed.
- The existing MCP HTTP start test intermittently reset its loopback connection
  on the first full-suite attempt. Its exact isolated rerun passed (1/1), and
  both final full commands passed on retry; no issue-241 code touches that
  server path.
- `cargo fmt -- --check`: blocked by pre-existing repository-wide formatting
  drift, beginning in `src/commands/graph_new_commands.rs`.
- `cargo clippy --all-targets --all-features -- -D warnings`: blocked by the
  pre-existing warning baseline (including unused `TabulateTotalsKind`,
  `validation_result_hash`, and unrelated dead code). No suppression was added.

### Review follow-up

The empty-source tabulate fixture now advances generation zero before its
controlled rebuild. The rebuild therefore publishes the empty-table manifest
for generation one and removes the stale generation-zero manifest instead of
rewriting generation zero with post-delete state. The focused regression passed
(1/1), all tabulate session tests passed (46/46), and the final ordinary
parallel Rust gate passed (1,407 passed, 18 ignored, plus all integration
tests).

### Final release qualification

The release gate reran all five qualifications from clean source commit
`4d4917e325ee7c44ad94692d2ee417a25263826d` using a fresh external Cargo target
directory so compile-time provenance could not reuse an earlier dirty build
script result.

| Operation | Runs (ms) | Median | Max / threshold |
| --- | --- | ---: | ---: |
| Append row | 75, 77, 72, 76, 71 | 75 | 77 / 1,000 |
| Insert middle row | 86, 84, 79, 81, 86 | 84 | 86 / 2,000 |
| Add empty column | 37, 37, 37, 37, 38 | 37 | 38 / 2,000 |
| Delete one row | 44, 36, 41, 38, 42 | 41 | 44 / 2,000 |
| Delete one column | 42, 40, 44, 44, 45 | 44 | 45 / 5,000 |

Every report records one warmup and five measured child processes with unique
PIDs, clean matching compile/runtime provenance, zero full snapshots, zero full
anchor rebuilds, zero forbidden row-order updates, zero rebalanced rows, valid
sparse anchors/manifests, the expected compact snapshot shape, and no
near-doubling of retained memory or RSS. Middle insertion precedes its stable
target. The raw reports are stored outside the repository in the session
artifact directory.

Those measurements did not exercise bounded rebalance (`rebalancedRows = 0`).
Compact add-row history now persists nullable before-images and explicit
after-images for every existing row touched by a bounded rebalance (at most
8,192), and unified history archive v2 validates and restores that metadata.
Because this changes production mutation and archive source after `4d4917e`,
the qualification above is retained as historical evidence only; it does not
bind the new source. A clean five-operation 2,000,000-row qualification must be
rerun before release, including a scenario that reports a nonzero bounded
rebalance count.

Archive compatibility coverage now also rewrites real saved project members to
legacy bare JSON integers before reopening them. The v1 delta route restores
and replays separate `i128::MIN` and `i128::MAX` `rowOrder` change sets. The
unified v2 route restores `rowOrder` plus nullable rebalance before-images and
MIN/MAX after-images, exercises Undo/Redo, and saves again. The test reads the
resaved `history/timeline.v2.json` member as structured JSON and verifies every
non-null migrated key is the exact canonical decimal string. After another
reopen and replay, both routes verify dataset row existence, exact order keys,
natural order, and generation rather than only restored history metadata.
These route tests passed without requiring another production change after the
full-range decoder fix.

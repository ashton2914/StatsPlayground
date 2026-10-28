# Native v5 validation observations

This is manual automation evidence from the macOS Tauri/WKWebView application,
not a release latency qualification or user acceptance sign-off.

## Build and fixture

- Canonical Issue 282 worktree, HEAD/base `3a362f6ebed9dd9f2435aac56cdf5bd75a84052f`.
  Remote `origin/dev` was read back at this same SHA on 2026-10-26.
- Explicit `project-v5,perf-harness` debug build. Default v5 enablement remains off.
- Isolated app product `StatsPlayground Issue 282`, identifier
  `com.statsplayground.issue282.acceptance`; no installed app was replaced.
- Generated fixture: 2,000,000 rows × 20 columns, seed282, about240MiB;
  [seed report](fixture-seed.json). The fixture contains `Data` and `Report`.

## Observed before the viewport repair

1. On open, the directory showed `Data.sptb 2000000×20` and `Report.sprp` while
   the editor still asked to select a table. No table was auto-selected.
2. Selecting Data displayed row1/c0=0 and total2,000,000 rows/20columns. Cache
   diagnostics showed500 rows, one entry,181.3KiB.
3. Jumping to A1000001 selected c0=1000000. Neighbor paging showed2,000 rows,
   three entries,723.7KiB. Visible row labels and linked values matched their
   real positions; the selected value was read from the formula bar.
4. Writing42424242 through the formula bar persisted the value, but the viewport
   unexpectedly returned to row0. This is a product defect, not a passing case.
5. Jumping back showed row1,000,001/c0=42424242. Ctrl+S displayed Saved.
6. Quit and a fresh app launch, then open the same named project, again showed
   only directory metadata until Data was selected. Jumping to A1000001 showed
   the durable value42424242 in both the formula bar and the actual table cell.
   Cache diagnostics remained bounded (4,000rows/five entries/about1.4MiB).

The prior empty unnamed draft was offered for recovery on restart. It was
preserved; choosing New Project allowed opening the named fixture. No recovery
files were deleted.

## Viewport repair status

A component fixture reproduces native acknowledgement ordering: the data store
advances table generation before the cell handler finishes its refresh. The
formula-bar case failed by losing the edited distant cell; inline editing served
as a control. The repair holds the owned refresh until acknowledged generation
and current-window reload complete, preserving selection/scroll. Both focused
cases and the55-test mutation/scroll/navigation/App group passed; typecheck
passed. Native-window repetition passed in the rebuilt isolated bundle. A1000001 was
changed from42424242 to42424243 through the actual formula bar. After commit,
visible row1,000,001 showed42424243, the formula reference advanced to A1000002
with its correct original value1000001, and the logical scrollbar remained at
999981. Cache diagnostics showed3,500rows/four entries/about1.2MiB. Ctrl+S
showed Saved. The test app was then quit and its running state read back as
false. [Exact source/binary identity and observations](fixed-bundle.json).

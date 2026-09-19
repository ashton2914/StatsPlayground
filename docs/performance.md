# Performance Baselines

## Issue 235 Native Overlay Qualification (2026-09-19)

Required 2M source SHA: `14c3f1842567e643bc2435463fdfe24b2209e5a3`  
Stretch 10M source SHA: `2441e9f2a99082e6a7c438c06b7cd15ead7152af`
(10M was not rerun after the later harness-only Clippy cleanup, the backend
regression fix, or Fix Round 1; its single controlled-refusal sample remains
tied to that earlier reviewed SHA)  
Platform: macOS 27.0 (`Darwin arm64`), Apple M3 Pro  
Evidence: `.cache/issue235-overlay/performance/overlay-2m-14c3f1842567e643bc2435463fdfe24b2209e5a3.json`,
`.cache/issue235-overlay/performance/overlay-10m.json`

This section records single release-harness samples from
`src-tauri/target/release/examples/performance_baseline` with
`--features perf-harness`. These are not P95 measurements. The CLI harness
measures native backend/build, native render, and GPU readback separately.
WebView presentation is separate and **unmeasured** here
(`webviewPresentationMetric = "unmeasured_cli_harness_no_webview_presentation"`).
`accountedMemoryBytes` is graph-owned in-memory tile accounting only.
`cpuCacheBytes`, `persistentCacheBytes`, and `gpuAllocatedBytes` are layer-local
cache allocations. `processRssBytes` is whole-process RSS sampled from the OS.

### Required 2M qualification

- Request: `--operation graph --graph-new-rows 2000000 --graph-new-overlay-groups 8`
- Qualification result: `qualificationPassed = true`
- Source/finite shape: `sourceRows = 2,000,000`, `processedRows = 2,000,000`,
  `finiteRows = 2,000,000`, `excludedNonFiniteRows = 0`
- Build summary: `operationMs = 10,776`, `scanCompleteMs = 3420`,
  `overviewReadyMs = 3795`, `pyramidCompleteMs = 3795`,
  `spoolBytes = 52,000,000`, `accountedMemoryBytes = 248,462,336`,
  `tileCount = 1`, `tileBytes = 60,000,100`, `levels = 1`,
  build-time `processRssBytes = 509,083,648`
- Overlay shape: 9 groups total (8 nonmissing + Missing), with exact counts:
  `group-0..group-6 = 285,714` each, `group-7 = 1`, `(Missing) = 1`
- Minority evidence: `minorityGroupRows = 1` (<0.1% of finite rows);
  `missingGroupRows = 1`
- Identity stability: `coldGraphKey = hiddenGraphKey = shownGraphKey =
  a3d56c1f0142b21c35f6f9edf22a59424ef99adf07e680297a7ed8f0708f02c7`
- Cold phase camera/domain:
  `{"xMin":0.00001,"xMax":0.99999,"yMin":0.0000011920928955078125,"yMax":0.9499999999999884}`
- Camera stability across the bounded camera + hide/show interaction:
  `{"xMin":0.25000500000000003,"xMax":0.7499950000000001,"yMin":0.23750089406966873,"yMax":0.7125002980232151}`
- Query counts: warm/camera/hide/show `sourceProjectionQueryCount = 0`
- Marks: cold `selectedMarks = 2,000,000`, hide `selectedMarks = 1,999,999`,
  show `selectedMarks = 2,000,000`; every phase remained `exactVisible = true`

| Phase | wallMs | buildMs | renderMs | readbackMs | projection queries | selectedMarks | visibleRows | cpuCacheBytes | persistentCacheBytes | gpuAllocatedBytes | processCpuReservedBytes | processRssBytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 4786.920833 | 3774.543708 | 302.403125 | 48.735541 | 1 | 2000000 | 2000000 | 60007792 | 60001905 | 96590980 | 260011888 | 905068544 |
| warm | 346.81404100000003 | 0.0 | 279.371125 | 47.346625 | 0 | 2000000 | 2000000 | 60007792 | 60001905 | 96590980 | 260011888 | 825065472 |
| camera | 321.576916 | 0.0 | 278.10825 | 23.151625 | 0 | 2000000 | 2000000 | 60007792 | 60001905 | 96591500 | 260011888 | 825081856 |
| hide | 346.13091699999995 | 0.0 | 300.776709 | 28.216333 | 0 | 1999999 | 1999999 | 60007792 | 60001905 | 96591500 | 260011888 | 982499328 |
| show | 340.931042 | 0.0 | 300.626625 | 24.981416 | 0 | 2000000 | 2000000 | 60007792 | 60001905 | 96591500 | 260011888 | 1059913728 |

### Bounded 10M stretch

- Request: `--operation graph --graph-new-rows 10000000 --graph-new-overlay-groups 8`
- Result: controlled refusal before a cold completion was emitted
- `groupedOverlay.outcome = "controlled_refusal"`
- `groupedOverlay.refusalCode = "graph_new_cache_pressure"`
- Top-level harness fields remained:
  `sourceRows = 10,000,000`, `rows = 10,000,000`, `operationMs = 2106`,
  `processRssBytes = 180,649,984`

This single 10M sample is stretch evidence only, not a percentile. Because the
run refused with `graph_new_cache_pressure`, there are no cold/warm/camera/hide/show
phase timings for the 10M JSON. The bottleneck is the existing graph cache /
GPU admission budget, not DuckDB projection cardinality.

## Tabulate Viewport Qualification

The Tabulate viewport benchmark generates its source table in an in-memory
DuckDB database with a parameterized `range`; it does not read, copy, or retain
a source-data artifact. Qualification uses exactly 10,000,000 source rows and
logical grids of 100,000, 1,000,000, and 10,000,000 cells. A smaller invocation
is a smoke check only.

Run a bounded smoke check with:

```bash
node scripts/runTabulateViewportBenchmark.mjs \
  --source-rows=100000 --logical-cells=100000 --samples=3
```

The native harness prepares one production `TabulateSessionService` session,
then issues repeated production window queries capped at 128 rows by 64 columns
and one statistic. `preparationMs`, `backendTileMs`, `totalsMs`, and
`cancellationLatencyMs` are native backend measurements. `tilePayloadBytes` is
the serialized bounded window response. `memberIndexBytes` is the session's
accounted member-index allocation. `wholeProcessRssBytes` is separately sampled
process RSS and includes DuckDB, the harness, and other process allocations; it
is not a member-index or graph-only budget.

The CLI runner does not cross Tauri IPC or present a WebView frame. Therefore
`ipcRoundTripMs` and `visibleInteractionMs` are explicitly reported as
`unmeasured`, never copied from backend timings or filled with zero. Platform
results are separate because RSS collection uses the host process API. At least
30 settled samples are required before P50/P95 are calculated. Fewer samples
retain sample counts with null percentiles and cannot be qualification evidence.

A completed tier must report exact logical cardinality and an exact bounded
window; truncation or a false completed result is invalid. A stable controlled
10M-tier resource refusal may be reported as `controlled_refusal` with its code,
but it is not converted into success. The full matrix is run only after source
and review fixes are frozen so its evidence describes the reviewed revision.

Production resource regressions in `tabulate_session_service.rs` force the
member-index budget, two-session quota, five-minute expiry, active and queued
cancellation, cleanup failure, explicit release, shutdown, and stale-generation
recovery. They assert failed sessions never become ready or retain measured
bytes, temporary objects are dropped, active identities are removed before
cleanup waits, and a valid replacement request can recover.

## Typed-X Review Corrections (2026-09-18)

Five reviewed issues now have focused regression evidence:

1. Raw lines use f64 segment clipping before f32 conversion when the camera
  precision check requires rebasing. Offscreen/re-entry pixels are checked
  against an independent analytic crossing. Normal cameras retain indexed
  point-buffer reuse; the fallback reserves 16 bytes/segment instead of 8.
2. Time coordinates subtract an exact integer epoch origin before conversion,
  choosing an exact seconds/milliseconds/microseconds/nanoseconds unit.
  Native TIMESTAMP_NS and strict ISO text retain distinct nanosecond instants
  and duplicate ordering. Ranges exceeding exact relative integer coordinates
  are diagnosed, not silently merged. Cache policy is `typed-x-v3-relative-time`.
  Frontend labels reconstruct integer time and measure text widths, preserving
  submillisecond digits. Eight DOM cases cover nanoseconds, microsecond time,
  microsecond duration and Unicode categories at 960/390px, including alignment.
3. Admission may reclaim an inactive raw GPU buffer under pressure, resetting
  only its reuse metadata. Scatter/Mean remain present, and re-enabling raw
  lines restores identical pixels. Normal toggles retain reusable buffers.
4. Category admission uses bounded row-ID pages and a bounded first-seen
  dictionary before projection. Oversized/high-cardinality inputs fail before
  full materialization; no full-text category window sort remains. Auto has a
  cold scalar classification query; projection counters are not total SQL
  counters. Unicode labels and stable first-seen ordering have regression tests.
5. Completion ticks retain the finite values produced by `numeric_ticks`.
  TypeScript uses overflow-safe normalization, with real Rust completion replay
  for `[-1e308, 1e308]` and rejection of misplaced/nonfinite ticks.

Final-source release measurements below supersede the earlier round for these
changes. CSV bytes, modification time and SHA-256 remained unchanged; production
and test source hashes are recorded before/after the run. The CSV was not copied.
Both axes retain all 2,032,293 observations, with zero exclusions, 2,032,292 raw
segments (zero in Scatter), and 1,674,063 / 1,727,165 Mean groups respectively.

| X | Import/metadata ms | Cold ms | Warm ms | Camera ms | Disk ms | Scatter/Line/Points+line ms |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Test Time (Duration) | 7743.88 | 3345.30 | 339.19 | 273.25 | 1274.28 | 274.90 / 289.65 / 328.10 |
| DPT (Time) | 7790.17 | 2772.88 | 334.43 | 277.27 | 1280.23 | 265.87 / 284.53 / 316.37 |

Every post-cold run has zero source projections. Cold/warm/disk RGBA are
identical per axis. All 18 native PNGs round-trip losslessly; all 18 saved
completions and RGBA payloads pass the real frontend parser/receiver with mocked
invoke and stale-frame fencing. Mean toggles change 162,744 / 162,713 pixels,
all inside the plot; disabled frames have zero red pixels. Native curves and
frontend typed-label screenshots were visually inspected. Native PNGs do not
include the separately rendered HTML X labels; CT uses synthetic frame pixels.

Retained GPU allocation peaks at 131,709,472 / 132,559,104 bytes under the
unchanged 256 MiB admission cap. Whole-process maximum RSS is 1,550,041,088 /
1,592,213,504 bytes, including import, DuckDB and harness memory. These RSS
measurements are not graph-only budgets or evidence of a memory optimization.

Final checks: 166 serial Rust `graph_new` tests, five TS suites, 48 isolated CTs,
`tsc -b`, Vite, Cargo build and standard Clippy pass. Cargo build reports 72
warnings, Clippy 129 and release build 68; Vite reports its large-chunk warning.
Evidence is under `.cache/issue221-phase1/review-final/`; CT output is isolated
under `.cache/issue221-phase1/ct-reviewed/`. Prior evidence remains intact.
These are single macOS backend samples, not P95 or production WebView timings.
Independent controller review, native desktop acceptance and Windows/Linux
verification remain pending. Mean defaults and source-cache retention policies
are unchanged; no commit, push, CSV mutation or dependency additions were made.

## Typed X And Raw Lines (2026-09-18)

Historical pre-review implementation and measurement snapshot follows.

Graph Builder-new accepts every schema descriptor for X; Y remains numeric.
Session-only interpretation modes are Auto, Numeric, Time, Duration and Category.
Auto preserves SQL numeric values, projects native DATE/TIMESTAMP epochs, and
recognizes strict ISO timestamps, `hours:mm:ss[.fraction]` and
`:days:hours:mm:ss[.fraction]` elapsed values. Hours need not wrap at 24.
Text DPT uses DuckDB's month/day 12-hour parser only when a valid day above 12
disambiguates the column. Other or ambiguous text becomes first-seen categories.
Offset timestamps use UTC; naive timestamps retain wall-clock values without
local timezone conversion. Mixed naive/offset text is categorical in Auto and
diagnosed as unrepresentable in explicit Time. Explicit parsing excludes invalid
pairs, preserving source gaps. Categories are bounded to 16,384 labels, 512 bytes
per label and about 1 MiB total; overflow produces a diagnostic, not truncation.

Scatter, Line and Points + line share the complete exact point geometry.
Raw segments sort each contiguous valid source run by interpreted X, then row ID;
missing/invalid source rows break runs. Lines never connect sampled LOD points.
Above 2.1M finite pairs raw lines are unavailable; scatter can remain approximate.
Mean remains a separate default-on grouped layer. Mode/Mean switches preserve
the camera and use cached data without SQL; interpretation changes invalidate
the graph key and reset the camera. No old Graph Builder/project state is changed.

Raw indices occupy 8 bytes per segment and reuse the existing GPU point buffer.
The exact CPU working allowance is now 100 bytes/point (previously 84), including
raw ordering/index storage. The disk restore admission ceiling is 320 MiB within
the unchanged shared 768 MiB CPU budget. GPU admission still includes retained,
replacement and staging allocations under 256 MiB. Typed axis metadata is part
of the checksummed cache, keyed by the `typed-x-v2` interpretation policy.
Only bounded tick metadata crosses IPC; frontend labels use the same positions
and plot rectangle as the Rust grid. Native RGBA exports omit those HTML labels.

One macOS release measurement round used the immutable 702,927,046-byte CSV,
SHA-256 `879a7eee206a7e780bd666a4bd2e36f973a2fe35b0b10b647f700769d4014886`.
Both axes retained 2,032,293/2,032,293 rows with no exclusions and 2,032,292 raw
segments at 1280 x 720. The importer resolved Test Time/Step Time as VARCHAR and
DPT as TIMESTAMP. Raw lines and Mean were enabled except the named toggle runs.

| X | Import/metadata ms | Cold ms | Warm ms | Camera ms | Disk ms | Scatter/Line/Points+line ms |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Test Time | 7644.25 | 3102.96 | 312.05 | 243.37 | 1236.64 | 258.14 / 256.37 / 280.82 |
| DPT | 7814.89 | 2498.99 | 286.93 | 255.62 | 1248.94 | 264.49 / 245.17 / 271.70 |

Mean groups were 1,674,063 and 1,727,165 respectively. Every non-cold run used zero
source projections. Retained GPU allocations peaked at 131,709,472 / 132,559,104
bytes. Whole-process maximum RSS was 1,115,226,112 / 1,208,516,608 bytes, including
DuckDB/import/harness memory; these are not graph-only memory peaks. Source hash,
size and modification time remained unchanged. Cold/warm/disk RGBA were identical
per axis; all 18 PNGs round-trip losslessly, and all 18 saved completions/payloads
pass the production TypeScript validator with the recorded modes and stale fence.

Evidence: `.cache/issue221-phase1/native-manifest.json`, `native-duration/`,
`native-time/`, `replay-*.json`, and isolated CT output under `ct/final/`.
Important timing caveat: this single release round preceded the final direct
native-epoch projection and mixed-timezone guard. Final source passes 161 serial
`graph_new` tests (including native typed CSV fixtures), five TS suites, 40 CTs,
TypeScript/Vite, Cargo build and standard Clippy (warnings remain). The recorded
release timings are not measurements of those last changes. No second actual
CSV round was run. No production WebView timing, P95, native desktop acceptance,
independent code review or Windows/Linux certification is claimed.

## Graph Builder-new Recovery (2026-09-18)

Derived-cache namespaces remain unique to each AppState lifetime. Restart never
restores old dataset IDs. New Unix namespaces contain a locked `owner-v1` marker
and a bounded generated-file identity journal; startup can retire abandoned
namespaces only after acquiring that marker's nonblocking OS lock. Live parallel
processes are retained without PID heuristics. Legacy namespaces without a
verifiable marker are deliberately left alone.

Cleanup inspects at most 64 root entries, 1,024 journal records and 128 KiB of
marker data per namespace, and retires at most 1 GiB per initialization. Unknown,
corrupt, linked, replaced and oversized entries fail closed. Unix operations use
`rustix` directory-relative no-follow handles and private lifetime directories.
This dependency already existed transitively; the manifest now declares it.
POSIX does not provide an atomic inode-conditional unlink: the final leaf
identity check and unlink remain separate operations. Protection against a
malicious concurrent writer running under the same user identity is not claimed.

Disk initialization runs on a blocking worker, not the UI setup thread; failure
leaves the memory cache usable. Windows/non-Unix disk caching is intentionally
disabled until equivalent handle-relative ownership/deletion is implemented and
verified. Common path validation also rejects Windows reparse attributes.
Windows and Linux native validation remain pending; macOS evidence is not
cross-platform certification. Do not manually clean existing user caches as an
installation step.

The shared scene/probe renderer latches typed device-loss, validation, internal,
readback and out-of-memory failures without exposing driver messages. Confirmed
device loss gets at most one recreation per request, after releasing the old
renderer. Invalid requests, resource pressure and OOM do not retry. Cancellation
is checked before recreation and before returning a frame. Poll waits are bounded
to five seconds, callback waits to one second, and staging buffers unmap on every
exit path. Failed frames are not published; subsequent requests can create a new
renderer. No frontend frame-clearing behavior was changed.

Evidence is retained under `.cache/issue221-recovery/`. Deterministic injected
faults test recovery policy and readback cleanup without killing a device. Native
macOS tests additionally exercise real GPU pixels and both production entry
points. These are correctness checks, not WebView/P95 performance measurements.
Strict Clippy remains a failing repository gate; unrelated existing warnings are
not repaired by this slice. Independent controller review is still required.

## Graph Builder-new Mean Overlay (2026-09-18)

Mean is the arithmetic mean of every finite Y for each identical finite X,
connected in ascending X order. Signed zero groups together; nonfinite pairs
are excluded. This is neither a global horizontal mean nor a moving average.
The default-on checkbox is session-only. The red two-logical-pixel line and
frame-bound legend preserve blue scatter, axis titles and the desired camera.
English and Simplified Chinese availability messages are included. Fewer than
two X groups produce no segment; incomplete/approximate retained data disables
Mean instead of reporting a representative-point mean as complete.

Rust lazily caches the sorted full mean per resident exact graph key (up to
2,100,000 finite pairs). A Kulisch-style integer superaccumulator sums finite
values exactly in units of 2^-1074 using two 34-limb magnitudes. Integer division
precedes the single round-to-nearest-even conversion, including subnormal ties;
the sum may exceed f64 range without overflowing the mean. All six permutations
of [1e300, 1e-24, -1e300] yield 3.333333333333333e-25.
Toggle/camera reuse performs no aggregation or source projection.
Disk restore reconstructs the mean from the complete retained tile, not the CSV.
Normal camera changes reuse GPU line geometry; deep zoom uses clipped f64
endpoints before f32 conversion when the precision bound requires replacement.
No point or mean arrays cross the frontend IPC boundary.

Mean vector capacity is charged as resident memory within the existing exact
working reservation: mean 16 B/point + scene 24 B/point + maximum simultaneous
renderer scratch 40 B/point fits its 84 B/point allowance. Reservation stays
stable after lazy computation. The existing sort/compaction retains O(N) vector
capacity; accumulator storage is 544 bytes of stack scratch reused per group,
within the fixed 4096-byte allowance, not allocated for each of the 729,286 groups.
GPU admission includes retained resources,
replacement buffers, bounded upload staging, and replacement render/readback
targets under the unchanged 256 MiB cap. Under pressure only, Mean-off reclaims
the inactive line buffer and clears only its reuse metadata/draw count before
recalculating admission. The native 2M-group Mean-on to 2.1M-point Mean-off test
reclaims 31,999,968 bytes, preserves points, then reuploads the correct line on
re-enable. Requested lines are never dropped; toggles/cameras retain reuse when
the allocation fits. The shared graph CPU cap stays 768 MiB.

Final isolated macOS release run, 1280 x 720, Rec# / Voltage (V):
2,032,293 finite pairs, 729,286 X groups; import/metadata 7832.23 ms excluded below.

| Native Scenario | Wall ms | Source Projections |
| --- | ---: | ---: |
| Cold Mean on | 1687.46 | 1 |
| Warm Mean on | 268.31 | 0 |
| Camera Mean on | 248.60 | 0 |
| Disk restore Mean on | 1229.36 | 0 |
| Full-domain Mean off | 253.57 | 0 |
| Full-domain Mean on again | 260.72 | 0 |
| Comparison Mean on | 252.00 | 0 |
| Comparison Mean off | 246.43 | 0 |

Comparison uses a renderer-only anisotropic override X=[0,120000], Y=[3,4.5],
not the IPC camera policy. Point uploads remain one; Mean uploads remain one
through warm/camera and rise to two only after disk restore, not on toggles.
Shared graph CPU reservation peaks at 227,627,568 bytes; retained GPU allocation
is 100,335,904 bytes. Whole-process maximum RSS is 928,415,744 bytes, including
DuckDB import and the benchmark, not a graph-cache-only measurement.

Fresh evidence is under `.cache/issue221-mean/native-reviewed-final/`: report, eight
native RGBA/PNG pairs, SHA-256 source check, pixel audit and production parser
replay. Full/comparison on-off differences are exactly 85,057/438,387 red pixels;
disabled frames have zero red pixels and no changes occur outside the plot.
All remaining pixels are unchanged. Both disabled images match the preserved
`native-budget-final` Mean-off images byte-for-byte after PNG decode.
Saved native cold/camera frames pass the
real Channel, header parser, receiver and completion validator with mocked
invoke. These are single-run backend timings, not WebView latency or P95.
The existing no-watch application was neither stopped nor replaced.

Review-fix TDD: two numeric tests failed then passed; the native pressure
transition failed with cache pressure then passed. All 10 mean-focused tests and
140 serial `graph_new` Rust tests pass, including every finite exponent, both
signs, all cancellation permutations, carry, subnormal rounding and checkpoints.
Fresh Vite, Cargo, release build and production-parser replay passed. Standard
Clippy passed with 127 existing warnings; not warning-free. The prior five TS
contracts, 28 scoped component cases and tsc evidence remain preserved; frontend
sources were unchanged, so CT was not rerun. Review logs use the `review-` prefix
under `.cache/issue221-mean/`. A post-run wrapper initially expected a non-null
Mean-off group count; the saved successful native run passed the corrected audit
without reimporting the CSV.
Independent controller review and live application inspection remain separate.
HEAD and all earlier exact-scatter edits are preserved; no commit or push.

## Graph Builder-new Last Two Review Fixes (2026-09-18)

The production `graphNewService` completion validator now accepts up to
2,100,000 submitted marks. Exact whole geometry is identified by
`selectedMarks === finiteRows`, independently of the viewport's `visibleRows`.
Non-whole exact selections still require submitted/visible equality; approximate
selections cannot exceed known visibility. Safe-integer, nonnegative, finite,
source-total, inspection-count, camera and frame-bound checks remain enforced.
No renderer count is trimmed and no other geometry consumer is changed.

Construction admission now performs a nonmutating CPU/disk feasibility check,
then atomically acquires only the additional shared-pool bytes while transferring
the minimum unpinned CPU LRU prefix into its construction reservation. Existing
claims are not released into a race window; surplus is released only after the
victims are dropped. Disk reclamation follows CPU reservation. Pinned entries,
external coordinator claims and pending reservations remain charged. Tests use
three distinct compact-exact keys with representative 227,627,328-byte resident
claims, avoiding large duplicate allocations: two warm claims plus 512 MiB
construction fit the unchanged 768 MiB pool after one unpinned eviction.
Oversized, pinned, external-held and pending failures preserve warm entries,
disk contents and counters; 16 shared-pool contention rounds admit exactly one
winner, retain the losing entry and release claims exactly once.

TDD evidence from main-workspace tasks: the real-service regression failed with
`graph_new_render_failed` (exit 1), then passed; the construction group failed
only the feasible third-key admission (6 passed / 1 failed, exit 101), then all
7 passed. The additional contention check raises that focused group to 8.
Final gates passed 130 serial `graph_new` Rust tests, five TS contract scripts,
24 existing component cases, `tsc -b`, Vite and Cargo builds. Standard Clippy
completed with 126 existing warnings, not a strict warning-free gate.

`tests/graphNewService.test.ts` exercises the real Tauri Channel, header parser,
binary receiver, completion validator and stale camera fence, mocking only the
native invoke boundary. A first replay passed with the saved native cold/camera
RGBA and unchanged completions. **Evidence-loss incident:** the subsequent CT
run used Playwright's default `test-results` output and cleared that shared
directory, deleting prior native reports/images and initial RED/GREEN/replay
logs. Those original pixel artifacts are not restored; historical artifact links
below are unavailable, and historical timings are not new qualification evidence.
Always use a dedicated CT output, e.g. `--output=test-results/issue221-last2-ct`.

The native cold/camera completion objects read before cleanup are retained in
the existing service test. Reproducible `--recorded-native` mode replays these
unchanged objects (2,032,293 submitted, 2,032,293/7 visible) with an explicitly
synthetic valid one-pixel header/RGBA. This proves production parser acceptance,
not live Canvas/WebView presentation or restored native pixel evidence:

```bash
node_modules/.bin/tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts --recorded-native test-results/issue221-last2-native-parser.json
```

Saved results: `test-results/issue221-last2-native-parser.json`,
`test-results/issue221-last2-gates.json`, and `test-results/issue221-last2-*.log`.
Independent repository rereview remains **pending controller review**: the
delegate could not inspect files with its available tools and issued no verdict.
HEAD remains `98e89c6ee16f46bd8ab32de8c85008209b32e4b6`; all pre-existing dirty
source edits remain. No commit, push, dependencies, source CSV edit, extra source
query, release benchmark rerun or existing-app termination was performed.
Status localization is deferred because the nearby Graph Builder-new view has
no localization integration; no unrelated UI scope was added.

## Graph Builder-new Compact Exact Slice (2026-09-17)

Status: **Exact native scatter verified for all 2,032,293 finite pairs in
the supplied real CSV. Internal cap: 2,100,000, subject to existing budgets.**

The waveform regression reproduced representative loss: only 417 of 8,193
finite source points were selected. A fitting bounded-policy source now uses
one complete level-zero tile, skipping deeper pyramid/bucket construction.
Camera requests retain the same point slots and count visible rows separately;
`selectedMarks` therefore includes offscreen points. The existing renderer
clips them and can reuse its point buffer. Research raw-index mode and the
above-cap approximate pyramid remain available without policy substitution.
Insufficient construction budgets also retain the approximate fallback.

Binary persistence uses the existing format, with strict complete-source
validation for the larger tile and bounded identity
`graph-new-v6-compact-exact-2100000`, invalidating older sampled caches. Decoded-cache
and working-copy reservations account for the complete tile rather than a
fixed 8 MiB decoded limit. The above-million regression, cap+1 fallback, memory refusal,
cancellation, exact disk round-trip, camera reuse and old approximate path
are covered by the serial tests. The above-million RED produced eight levels
instead of one; GREEN preserves every source point through the renderer.

Four review repairs are now covered by focused RED/GREEN checks. Decoders
preallocate validated counts instead of using fallible `collect()`, whose excess
capacity prevented the complete tile from staying in the decoded cache. Tests
at 2,032,293 and 2,100,000 points account actual vector capacities and prove warm
decodes survive corruption/truncation of their own backing file until eviction.
Tile classification now follows the same interpolated boundaries as persistence,
preserving exact outer endpoints, including subnormal and adjacent-large values.
The -6..7 midpoint fixture round-trips below and above the exact cap under an
8 MiB construction budget without relaxing corruption validation. Status now
distinguishes `7 visible; 2,032,293 submitted`. After construction buffers are
dropped, the service shrinks its construction reservation to retained memory
before cache admission; success/failure tests preserve the previous pinned graph
through replacement. Metadata under/overcounts and nonfinite exclusions are
also covered through the actual scan path.

The 40-byte GPU mark layout is unchanged. Two 4M geometry buffers alone would
exceed 256 MiB, so the cap is conservatively 2.1M instead. At this cap, existing
112-byte-per-point construction accounting plus scratch stays below 256 MiB;
retained/replacement GPU geometry and two 1280x720 targets also fit. Maximum
4K retained/replacement targets can still trigger `graph_new_cache_pressure`;
this is a safe refusal, not a promise of exact rendering at every viewport.
No CPU/GPU budget was raised. These reservations are not overall process RSS:
the existing shared graph CPU pool is 768 MiB and DuckDB has its own budget.
Large scenes above 50,000 marks use a 1px logical radius (2px diameter), passed
through the existing camera uniform; smaller scenes retain a 3px radius.
Native DPR-1/2 pixel tests preserve geometry-upload reuse.

The release harness accepts a read-only CSV and a new artifact directory:

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml --features perf-harness --example performance_baseline -- --graph-new-csv "$CSV_SOURCE" "$ARTIFACT_DIRECTORY"
```

It imports with the existing DuckDB importer (1 GB database memory limit,
four threads), resolves `Rec#` and `Voltage (V)` by metadata identity, and
audits finite pairs. Sources above the cap produce `scopeExceeded: true`
without rendering or silently sampling. Within-cap runs measure cold, warm,
isotropic camera and disk restore through the native renderer, retaining raw
RGBA frames. A separately labelled renderer-only comparison pass uses
X=0..120000 and Y=3..4.5 without changing the IPC equal-ratio camera policy.
Times exclude WebView presentation and there is no Mean overlay.

The supplied 702,927,046-byte CSV has 52 columns and **2,032,293 rows, all
finite in the selected pair**. `Rec#` is BIGINT, range 1 to 729,286;
`Voltage (V)` is DOUBLE, range 2.682 to 10. The X maximum is not the row
count. Import plus metadata/finite-domain auditing took **7,994.08 ms** in the
final release run. Source length and modification time were unchanged.

Already-loaded native backend timings, one run each, at 1280x720 DPR 1:

| Pass | Wall ms | Source build ms | Native call ms | Prepare/submit ms | Readback ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold full domain | 1440.90 | 536.17 | 333.14 | 244.00 | 65.55 |
| Warm full domain | 283.97 | 0 | 275.71 | 224.43 | 49.61 |
| Isotropic camera | 243.39 | 0 | 236.08 | 227.28 | 6.98 |
| Disk restore | 1055.24 | 0 | 252.29 | 223.49 | 27.11 |
| Comparison domain | 243.92 | 0 | 234.45 | 222.48 | 10.17 |

`renderMs` is CPU preparation plus queue submission, including content hashing
and affine validation, not GPU-only execution time. Readback includes GPU wait.
`nativeOuterOverheadMs` is the residual outside these phases, including initial
renderer setup. Wall time additionally includes service selection, decoding,
scene materialization and cache work. Comparison wall time also includes its
bounded harness-only point clone and visible-row count.

Every pass submitted 2,032,293 marks, with source projection counts 1/0/0/0/0
and only one geometry upload across all five frames. Full-domain visible rows
were 2,032,293; comparison visible rows were 391,538. The isotropic middle-half
camera has Y=4.5115..8.1705 and contains only seven points, explaining its sparse
image. Retained graph CPU allocation is 56,910,620 bytes for cold/warm/camera,
and 56,910,860 after disk restore, including the now-retained decoded tile.
The largest post-frame CPU reservation is 227,627,568 bytes, not a construction
peak. Retained GPU allocation reaches 88,667,328 bytes; the exact persistent
packet occupies 56,904,504 bytes. macOS `/usr/bin/time -l` measured **847,151,104
bytes maximum resident set size** and **1,232,717,120 bytes peak memory footprint**
for the whole release process, including CSV import, DuckDB, native rendering
and harness buffers. These OS metrics are distinct from graph reservations and
do not imply a 768 MiB whole-process limit or a measured graph-only RSS peak.
Raw resource evidence is `test-results/review4-release-csv-rss.log`.

Evidence is local and ignored under `test-results/issue221-real-csv-review4917/`:
`report.json`, `cold.png`, `warm.png`, `disk.png`, `comparison.png`, `camera.png`, corresponding raw
`.rgba` files, and `image-evidence.json` with raw hashes. PNG conversion is
lossless; all five decode at 1280x720. Cold/warm/disk RGBA hashes are identical.
The comparison frame contains 588,788
blue pixels, with visible fine structure instead of the 6px-dot saturated fill.
Its top-level domain/visible count describe the renderer-only override; nested
`completion` retains the service full-domain count and cache metrics.
No Mean overlay, JMP parity, desktop presentation timing or P95 is claimed.
Compared with the preserved pre-review run in `test-results/issue221-real-csv-final917/`,
warm wall time fell from 582.50 to 283.97 ms, camera from 563.78 to 243.39 ms,
and comparison from 566.56 to 243.92 ms. These single warm/camera samples meet
300 ms; they are not a percentile qualification or controlled speedup benchmark.
Cold and disk wall time still exceed one second. O(N) hashing, affine validation
and materialization remain; cache reuse does not make them free.

Final checks: **127 related Rust tests passed serially**, four targeted TS scripts,
24 component tests, Cargo/Vite builds and TypeScript checking passed. Clippy
completed with existing warnings. Release build completed in 143.04 seconds.
Statuses are in `test-results/review4-verified-status.json` and
`test-results/review4-release-status.json`; logs use `test-results/review4-*.log`.
An independent review of supplied current code excerpts reported no actionable
Critical/Important findings. Full repository review remains unverified because
the delegate lacked the permitted filesystem/task tools; this is not a full
review clearance. Native UI acceptance remains pending. No app restart,
dependency installation, staging, commit or push was performed. Earlier measurements below are
historical, not measurements of this compact-exact implementation.

## Graph Builder-new Camera And Cache (2026-09-17)

The user confirmed native point plotting, then prioritized pan/zoom and caches
over hover/table selection. Pointer pan, pointer-anchored wheel zoom, reset,
resize/DPR camera retention and a 75 ms settled debounce are implemented.
Gestures locally reproject the plot raster; preview uses bounded cropping,
frozen/faded axes and hatched uncovered areas, not the planned overscan.

Completed keys survive close/reopen in CPU LRU, with a pinned active graph and
8 MiB decoded-tile LRU per pyramid. CPU reservations are capped at 768 MiB
across coordinators, leaving 256 MiB for the singleton GPU renderer. Identical
scenes reuse geometry; changed-camera geometry still uploads. These are
retained-cache budgets, not overall process RSS or construction limits.

Derived disk files use app-cache lifetime namespaces, streaming checksums,
format/key validation and a 1 GiB per-coordinator backing budget. Identity is
scoped to AppState lifetime and database-reset epoch, not application restarts.
Optional persistence failure falls back to memory-only caching. Missing files
release bookkeeping; rejected replacement files are not deleted.

The release `performance_baseline --graph-new-rows 100000,1000000,10000000`
workload now emits measured `cacheWarm` samples via the production renderer
at 1920 x 1080, DPR 1. Payloads are validated and discarded, so times exclude
WebView presentation. Existing static selector placeholders remain labelled.

| Rows | CPU reopen | Disk-only reopen | Settled camera | Full pyramid |
| ---: | ---: | ---: | ---: | ---: |
| 100,000 | 3.10 ms | 93.19 ms | 2.43 ms | 1,547 ms |
| 1,000,000 | 3.45 ms | 331.84 ms | 2.26 ms | 2,174 ms |
| 10,000,000 | 6.73 ms | 2,875.49 ms | 5.06 ms | 7,921 ms |

All warm/camera samples performed zero source projections and four generation
checks; zero projections does not imply zero metadata SQL after settling.
No render request is sent during active dragging. Whole-matrix max RSS was
553,713,664 bytes; maximum sampled GPU allocation was 16,754,752 bytes and
graph CPU reservation 21,501,536 bytes. Raw evidence is in
`test-results/task8-release-matrix.json` and `task8-release-resources.log`.
These single samples are not P95 qualification. Mock-frame CT measured
7.7 ms local preview and 76.9 ms settled request dispatch, not native latency.

Final checks after review repairs: 88 Rust tests, 21 component tests, five TS
scripts, frontend/backend builds and scoped whitespace checks passed. Builds
retain warnings. Independent review cleared cache accounting, startup fallback
and resize retention fixes. A new isolated native dev instance was launched
without terminating the user's original window; gesture acceptance is pending.

Task 8 remains partly complete: disk reopen misses 300 ms at 1M/10M and first
interactive overview still waits for the full pyramid, exceeding three seconds
at 10M. Uniform-only GPU camera updates, overscan, crash-orphan cleanup,
filesystem rename-race hardening, Windows validation and native P95 remain
unfinished. Hover/click linkage is deferred. No broad cache cleanup runs.

## Graph Builder-new Full-Source LOD (2026-09-17)

Task 5 headless release matrix completed on macOS. This measures source
projection and disk-backed LOD construction, not WebView rendering or an
improvement relative to ECharts. This historical measurement predates the
renderer integration and camera/cache results above.

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml --features perf-harness --example performance_baseline
/usr/bin/time -l src-tauri/target/release/examples/performance_baseline --graph-new-rows 100000,1000000,10000000
```

Configuration: eight levels, 4,096 maximum points per tile, 16,384-row scan
batches, and a 512 MiB construction-accounting limit. Each build uses one
source projection of row identity and the two numeric columns. Every run
processed all requested rows, excluded zero non-finite rows, and observed
`AppError::Cancelled` in its separate cancellation probe.

| Source rows | Scan complete | Overview / full pyramid | Tiles | Tile bytes | Spool bytes | Accounted peak bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 35 ms | 1,510 ms | 21,525 | 5,078,192 | 5,600,000 | 13,858,240 |
| 1,000,000 | 95 ms | 2,068 ms | 21,845 | 29,051,004 | 56,000,000 | 14,469,992 |
| 10,000,000 | 786 ms | 7,541 ms | 21,845 | 268,440,112 | 560,000,000 | 18,818,880 |

The complete benchmark process took 13.97 s wall time, excluding compilation.
macOS `/usr/bin/time -l` measured **503,037,952 bytes maximum resident set size**
and 481,690,608 bytes peak memory footprint across the whole matrix. This
includes DuckDB, generated source data, selections, and cancellation probes;
it is neither a per-build memory delta nor graph-owned memory alone. The
per-run JSON `processRssBytes` remains `null` on macOS. `accountedMemoryBytes`
is a construction-buffer/index estimate with capacity and overlap checks,
not an OS measurement or a hard cap on all process allocations.

Limitations: overview availability currently coincides with full pyramid
completion; no early overview is delivered yet. Both interaction query-count
fields report zero with metric
`unmeasured_static_placeholder_from_headless_selector`; these are explicitly
unmeasured placeholders, not live UI query telemetry. Disk spool and tile
storage grow with input size even though in-memory construction is bounded.
This single deterministic workload is not a P95 or cross-platform qualification.

Recovery validation: 50 `graph_new_` Rust tests passed, including observed
RED/GREEN regressions for scan-capacity budgeting and asymmetric cross-zero
tile bounds. Release compilation passed with warnings, including currently
unwired graph-new APIs; this is not a warning-free Clippy result. The original
crash cause was not diagnosed and is not attributed to these fixes.

## Graph Builder-new 4K Transport Gate (2026-09-17)

Status: **Strict gate FAIL - accepted exception; Task 4 authorized**

Command:

```bash
npm run benchmark:graph-new-transport
```

The release benchmark used a Tauri channel with raw RGBA8 payloads and an
explicit one-frame pull contract. Rust enforces exactly one frame per probe;
the WebView requests the next frame only after the current frame is coherent
and presented. No Base64, data URL, JSON pixel array, or unbounded frame queue
is accepted. The machine-readable report is written to
`test-results/graph-new-transport/report.json`.

| Output | Readback-to-present P95 | Compositor FPS P95 | Frame-time P95 | Longest avoidable task | Queue depth | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1920 x 1080 | 31.30 ms | 55.56 FPS | 18 ms | 2 ms | 1 | Diagnostic pass |
| 3840 x 2160 | 30.51 ms | 50.00 FPS | 20 ms | 1 ms | 1 | **FAIL** |

The 4K run presented all 30 requested frames, used three bounded resident frame
buffers at peak (99,532,800 bytes), and reported zero dropped, stale, or torn
frames. Its binary transfer and presentation latency passed the 100 ms budget.
It failed only the compositor budgets: at least 55 FPS and at most 18 ms P95.

Architecture decision checkpoint: choose **reduced resolution/cadence**, using
the reduced-cadence branch while retaining 3840 x 2160 coherent output. On
2026-09-17, the measured shortfall was explicitly accepted as sufficient for
the current milestone: 50.00 FPS and 20 ms remain a strict-gate failure, but
transport optimization is deferred and Task 4 is authorized. This exception
does not revise the benchmark thresholds or claim a strict pass. The
WebView-side WebGPU and Plan C native-composition options remain unauthorized.

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

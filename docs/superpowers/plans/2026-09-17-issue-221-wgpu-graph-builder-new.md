# Issue 221 Graph Builder-new wgpu Point Plot Implementation Plan

## Revised Phase-One Scope (2026-09-18)

The user's latest instruction supersedes the numeric-X-only MVP scope and the
priority of optional interactions below. Preserve existing work and implement
these vertical slices in order:

- [x] Implement bounded owned-cache orphan retirement, corrupt-cache fallback,
  and a single typed GPU-device-loss retry with cancellation fencing. Unix uses
  handle-relative filesystem operations; Windows/non-Unix disk caching fails
  closed to memory-only. Native Windows/Linux validation remains open, and
  malicious concurrent same-user filesystem writers are outside the cleanup
  guarantee (leaf identity-check/unlink is not atomic).
- [x] Accept all X column types with explicit numeric, temporal, duration, or
  categorical semantics. Text-stored dates/durations must not silently become
  arbitrary numbers; ambiguous text can remain categorical or require an
  explicit interpretation. Keep Y numeric.
- [x] Provide points, raw connecting lines, and points-plus-lines. Order numeric
  and temporal X numerically and categoricals deterministically, retain stable
  source ordering for duplicate X, and distinguish raw lines from grouped Mean.
  Missing values must not create invented connections across gaps.
- [x] Verify native backend and frontend contract/component paths for the real
  2,032,293-row Duration/Time point-line workflow; retain complete source pairs.
- [ ] Finish native desktop manual acceptance and production WebView/P95
  measurement. Existing benchmark preflight confirms synthetic-frame transport
  coverage only; no new P95 run is claimed. Do not redesign or repeatedly
  optimize solely to satisfy an old threshold.

Overscan, hover/tooltip and table-selection linkage are deferred enhancements,
not blockers for this revised phase. Maintain existing resource budgets and
generation/cancellation checks. Platform-independent tests and actual native
platform verification must be reported separately; macOS success is not proof
of Windows/Linux behavior. Checkpoints and source data must be preserved.

## Current Status (2026-09-18)

Five reviewed corrections have focused RED/GREEN evidence: raw deep-zoom
clipping, exact relative-time coordinates/labels, inactive raw GPU reclamation,
bounded pre-projection category admission, and finite extreme-domain completion
ticks. Final checks pass: 166 serial Rust tests, five TS suites, 48 isolated CTs,
TypeScript/Vite, Cargo build and standard Clippy (129 warnings). Fresh actual-CSV
release runs follow the last production change, retaining 2,032,293 observations
on both Duration and Time, with zero post-cold source projections. All 18 native
frames pass production frontend replay; PNG curves and DOM labels were inspected.
Source hashes, unchanged-CSV checks, counts, timings and warning summaries live
under `.cache/issue221-phase1/review-final/`. CT output uses `ct-reviewed/` only.
See the latest `docs/performance.md` section for results and limitations.
Independent actual-source review found no blocking Critical/Important issues.
Native desktop acceptance, production WebView/P95 and Windows/Linux verification
remain pending. The updated native app was launched on port 3132 with the title
`StatsPlayground - Issue 221 Time Series`. Latest backend release single samples:
Duration cold/warm/camera 3345/339/273 ms; Time 2773/334/277 ms. Import and WebView
presentation are excluded; these are not P95 measurements. Resource limits and
explicit unsupported-precision/category-cap diagnostics remain intentional.
HEAD and all earlier evidence remain unchanged; no commit or push was made.

### Previous Typed-X Snapshot

Typed-X/raw-line phase: 161 serial Rust tests, five TS suites, 40 isolated CTs,
TypeScript/Vite, Cargo build and standard Clippy pass (warnings remain).
`.cache/issue221-phase1/` retains one actual CSV release round for Test Time and
DPT: all 2,032,293 rows, 2,032,292 raw segments, zero warm/camera/disk/mode SQL,
18 lossless PNGs and production-validator replays. This round predates the final
native-time projection/mixed-zone guard; it is not a final-source timing claim.
See `docs/performance.md` for formats, resource limits and measured values.
Independent review, native desktop acceptance and WebView/P95 remain unverified.

This snapshot supersedes historical progress notes below, not their original
requirements or missing verification evidence. Recovery checkpoints are
`7bd1d37` and `98e89c6`; subsequent exact-rendering, Mean, and field-list changes
remain uncommitted. The user accepted the Mean overlay on 2026-09-18; this is
not acceptance of the complete MVP.

| Task | Status | Remaining acceptance |
| --- | --- | --- |
| 1 Transport contract | Implemented | Included in final integration gate |
| 2 Offscreen producer | Implemented | Included in final integration gate |
| 3 WebView transport gate | Partial | Strict 4K gate still fails; approved exception permits continuation |
| 4 Independent session shell | Implemented | All X fields selectable; explicit interpretation and raw modes; Y numeric |
| 5 Full-source LOD | Partial | Budget-permitting exact rendering up to 2.1M finite pairs; larger data remains approximate; 10M early overview target open |
| 6 Point scene and axes | Implemented | Shared point/indexed raw-line buffers; typed tick overlay; native desktop acceptance pending |
| 7 Interaction and identity | Partial | Overscan, hover/tooltip, row hit testing and table selection outstanding |
| 8 Cache budgets | Partial | CPU/GPU reuse, pressure admission, owned-orphan cleanup and bounded GPU recovery implemented; native Windows/Linux validation and adversarial same-user path races remain outside verified scope |
| 9 Integrated performance gate | Partial | Backend harnesses exist; production WebView/P95 and unified failure-policy gate outstanding |
| 10 Final hardening | Partial | Complete repository gate and full MVP manual acceptance outstanding |

The accepted additional Mean layer groups all finite Y values by identical X,
sorts X, and draws a switchable line. It is unavailable when complete source
points are not retained; it is not a general overlay engine. The real CSV has
2,032,293 finite pairs and 729,286 Mean groups. Latest Mean backend release
single samples: cold 1,687.46 ms, warm 268.31 ms, camera 248.60 ms, disk restore
1,229.36 ms. Import is separate; these are not WebView latency or P95 results.
Evidence is under `.cache/issue221-mean/native-reviewed-final/` and documented
in `docs/performance.md`.

Latest scoped checks: 140 Rust tests, five TS scripts, 37 component tests,
TypeScript and frontend/backend builds passed across the applicable slices.
Field-list changes were frontend-only. Ordinary Clippy warnings remain; the
strict final Clippy gate is not claimed passed. Historical missing RED evidence
and earlier failed budgets below remain unchanged.

Categorical/time axes, configurable axes/reference lines, drag-and-drop,
themes, general multi-layer charts, project persistence and other mark types
are separate feature-parity work, not completed by the original numeric-point
MVP or the Mean addition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate, session-only, light-theme point-plot path that represents at least 10,000,000 source rows while proving the 4K Rust-to-WebView frame boundary before investing in DuckDB, LOD, and product UI.

**Architecture:** Slice 0 renders a synthetic offscreen `wgpu` scene and measures a bounded latest-wins binary transport into the actual Tauri WebView. Only a passing 4K gate unlocks a versioned `GraphKey` tile pyramid, offscreen point renderer, compositor-based gesture reprojection, stable row identity, and bounded caches; the existing ECharts Graph Builder remains untouched.

**Tech Stack:** Tauri 2.11, Rust 2021, `wgpu` 30.0.1, DuckDB, React 19, TypeScript 5.7, Zustand 5, Playwright Component Testing.

**Spec:** `docs/superpowers/specs/2026-09-17-issue-221-wgpu-graph-builder-new-design.md`

## Global Constraints

- Work only in the isolated `issue/221-wgpu-graph-builder-new` worktree based at `530a9e1`; never modify the primary checkout.
- Keep the current Graph Builder, ECharts renderer, graph documents, and `.spprj` schema unchanged.
- MVP scope is light-theme continuous X/Y point plots only; no persistence, dark theme, other marks, Analysis, 3D, or Plan C.
- Do not start Task 4 or later unless the Task 3 4K gate passes on the baseline integrated-GPU machine class.
- A 3840 x 2160 RGBA8 frame is 33,177,600 bytes; Base64, data URLs, JSON pixel arrays, frontend-visible temporary paths, and unbounded event queues are prohibited.
- Keep at most one frame in readback/transfer and one complete frame pending presentation per view; newer camera generations supersede older work.
- Measure WebView compositor FPS separately from newly published Rust-frame cadence.
- Acceptance budgets: overview <=3,000 ms; warm reopen <=300 ms; gesture DuckDB queries = 0; compositor P95 >=55 FPS and <=18 ms; settled LOD <=200 ms; 4K readback-to-present P95 <=100 ms; avoidable main-thread task <=50 ms.
- Cache budgets: <=256 MiB GPU per graph and <=1 GiB graph cache per process, degraded only by safe LRU eviction.
- Rust commands delegate to services and return `Result<T, AppError>`; no non-test `unwrap()` or `expect()`.
- Dynamic SQL identifiers resolve from validated metadata and use the existing quoting boundary; values remain parameterized.
- Use focused tests after every edit. Run the complete frontend/Rust gate only once after all MVP slices are complete.
- Do not commit, push, or create a pull request until the GitHub lifecycle's explicit manual-acceptance gate authorizes it.

---

### Task 1: Transport Contract And Latest-Wins State Machine

**Files:**
- Create: `src/types/graphNew.ts`
- Create: `src/services/graphNewTransport.ts`
- Create: `tests/graphNewTransport.test.ts`

**Interfaces:**
- Produces: `GraphNewFrameHeader`, `GraphNewFrameMetrics`, `GraphNewTransportEvent`, and `createGraphNewFrameReceiver(options)`.
- `createGraphNewFrameReceiver` consumes structured headers plus binary `ArrayBuffer` payloads and emits only complete, current-generation frames.
- Later tasks rely on `begin(header)`, `acceptPayload(token, payload)`, `canPresent(token)`, `markPresented(token, presentedAtMs)`, `cancelGeneration(generation)`, and `snapshot()`. The raw binary envelope must carry the complete token so payload correlation never depends on message adjacency.

- [x] **Step 1: Write the failing receiver tests**

```ts
import assert from "node:assert/strict";
import {
  createGraphNewFrameReceiver,
  type GraphNewFrameHeader,
} from "../src/services/graphNewTransport.ts";

const header = (frameId: number, cameraGeneration: number): GraphNewFrameHeader => ({
  requestId: "transport-spike",
  datasetGeneration: 1,
  rendererGeneration: 1,
  cameraGeneration,
  frameId,
  width: 4,
  height: 2,
  format: "rgba8",
  byteLength: 32,
});

const committed: number[] = [];
const receiver = createGraphNewFrameReceiver({
  activeIdentity: () => ({
    requestId: "transport-spike",
    datasetGeneration: 1,
    rendererGeneration: 1,
    cameraGeneration: 2,
  }),
  onFrame: (frame) => committed.push(frame.header.frameId),
});

const stale = header(1, 1);
const current = header(2, 2);
receiver.begin(stale);
receiver.acceptPayload(stale, new ArrayBuffer(32));
receiver.begin(current);
receiver.acceptPayload(current, new ArrayBuffer(32));

assert.deepEqual(committed, [2]);
assert.equal(receiver.snapshot().maximumQueueDepth, 1);
assert.equal(receiver.snapshot().droppedSupersededFrames, 1);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts`

Expected: FAIL with module-not-found for `src/services/graphNewTransport.ts`.

- [x] **Step 3: Implement the minimal transport state machine**

```ts
export interface GraphNewFrameIdentity {
  requestId: string;
  datasetGeneration: number;
  rendererGeneration: number;
  cameraGeneration: number;
}

export interface GraphNewFrameHeader extends GraphNewFrameIdentity {
  frameId: number;
  width: number;
  height: number;
  format: "rgba8" | "png";
  byteLength: number;
}

export interface GraphNewFrameToken extends GraphNewFrameIdentity {
  frameId: number;
}

export interface GraphNewFrame {
  header: GraphNewFrameHeader;
  payload: ArrayBuffer;
}

export function createGraphNewFrameReceiver(options: {
  activeIdentity: () => GraphNewFrameIdentity;
  onFrame: (frame: GraphNewFrame) => void;
}) {
  let pending: GraphNewFrameHeader | null = null;
  let droppedSupersededFrames = 0;
  return {
    begin(header: GraphNewFrameHeader) {
      if (pending) droppedSupersededFrames += 1;
      pending = header;
    },
    acceptPayload(token: GraphNewFrameToken, payload: ArrayBuffer) {
      const header = pending;
      if (!header || !tokensMatch(tokenFromHeader(header), token)) return;
      pending = null;
      if (payload.byteLength !== header.byteLength) return;
      const active = options.activeIdentity();
      const current = header.requestId === active.requestId
        && header.datasetGeneration === active.datasetGeneration
        && header.rendererGeneration === active.rendererGeneration
        && header.cameraGeneration === active.cameraGeneration;
      if (current) options.onFrame({ header, payload });
      else droppedSupersededFrames += 1;
    },
    canPresent(token: GraphNewFrameToken) {
      return pendingPresentation !== null
        && tokensMatch(pendingPresentation, token);
    },
    snapshot() {
      return {
        maximumQueueDepth: pending ? 1 : 0,
        droppedSupersededFrames,
      };
    },
  };
}
```

Implement strict finite/integer dimension checks, exact byte-length checks, duplicate rejection, cancellation, and presentation metrics in the same module without accepting byte arrays.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts`

Expected: PASS, including stale-generation, duplicate, malformed-size, cancellation, and queue-depth cases.

- [x] **Step 5: Review checkpoint**

Inspect only the three task files. Reject any `number[]`, Base64, data URL, or queue with length greater than one.

---

### Task 2: Synthetic wgpu Offscreen Frame Producer

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/models/graph_new.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Create: `src-tauri/src/services/graph_new_transport_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/commands/graph_new_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 header shape in camelCase over IPC.
- Produces: `GraphNewTransportProbeRequest`, `GraphNewFrameHeader`, `GraphNewTransportProbeCompletion`, `GraphNewTransportService::probe`, Tauri command `probe_graph_new_transport`.
- Binary payloads are sent through `Channel<InvokeResponseBody>` using `InvokeResponseBody::from(Vec<u8>)`.

- [x] **Step 1: Write failing Rust unit tests for validation and row padding**

```rust
#[test]
fn rejects_frame_dimensions_above_4k_gate() {
    let request = GraphNewTransportProbeRequest::rgba8(4096, 2160, 1);
    let error = request.validate().expect_err("width above gate must fail");
    assert!(error.to_string().contains("width"));
}

#[test]
fn padded_bytes_per_row_is_wgpu_aligned() {
    assert_eq!(padded_bytes_per_row(3840), 15_360);
    assert_eq!(padded_bytes_per_row(1921) % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT, 0);
}
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_transport_service::tests --lib && popd >/dev/null`

Expected: FAIL because the module and types do not exist.

- [x] **Step 3: Add pinned GPU dependencies**

```toml
wgpu = "=30.0.1"
bytemuck = { version = "=1.24.0", features = ["derive"] }
pollster = "=0.4.0"
```

Use `wgpu` default native backends for the first measured spike. Do not add a window/surface crate.

- [x] **Step 4: Implement validation and synthetic rendering**

Create one adapter/device/queue, an RGBA8 offscreen texture, a minimal WGSL shader that draws deterministic points over a light background, and a reusable MAP_READ staging buffer. Copy texture rows using 256-byte-aligned `bytes_per_row`, remove row padding into one pooled `Vec<u8>`, and emit explicit timing fields:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewTransportProbeCompletion {
    pub request_id: String,
    pub frames_requested: u32,
    pub frames_sent: u32,
    pub dropped_superseded_frames: u32,
    pub peak_transport_bytes: u64,
    pub maximum_queue_depth: u32,
    pub render_ms: Vec<f64>,
    pub readback_ms: Vec<f64>,
}
```

The service owns rendering and cancellation; the command only constructs the service and delegates.

- [x] **Step 5: Send structured headers and raw payloads**

```rust
on_frame
    .send(InvokeResponseBody::from(serialized_header))
    .map_err(|_| AppError::InvalidParam("graph-new frame channel closed".into()))?;
on_frame
    .send(InvokeResponseBody::from(rgba_bytes))
    .map_err(|_| AppError::InvalidParam("graph-new frame channel closed".into()))?;
```

Never serialize pixel bytes. Ensure a cancelled or superseded generation drops before send.

- [x] **Step 6: Run focused Rust verification**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_transport_service::tests --lib && cargo test graph_new_commands::tests --lib && popd >/dev/null`

Expected: PASS with validation, alignment, deterministic pixel, cancellation, and bounded-buffer tests.

- [x] **Step 7: Run the touched-target compile check**

Run: `pushd src-tauri >/dev/null && cargo check --lib && popd >/dev/null`

Expected: PASS without warnings introduced by the new modules.

---

### Task 3: Production-Shaped WebView Transport Gate

**Files:**
- Create: `src/services/graphNewService.ts`
- Create: `src/benchmarks/GraphNewTransportBenchmark.tsx`
- Create: `src/benchmarks/graphNewTransportMetrics.ts`
- Create: `tests/graphNewTransportMetrics.test.ts`
- Create: `scripts/runGraphNewTransportBudget.mjs`
- Modify: `package.json`
- Modify: `docs/performance.md`

**Interfaces:**
- Consumes: `probe_graph_new_transport` and Task 1 receiver.
- Produces: `GraphNewTransportReportV1`, script command `npm run benchmark:graph-new-transport`, and a PASS/FAIL process exit code.
- `GraphNewTransportReportV1` has separate `rustFrameHz` and `compositorFpsP95` fields.

- [x] **Step 1: Write failing metric-policy tests**

```ts
import assert from "node:assert/strict";
import { evaluateGraphNewTransportGate } from "../src/benchmarks/graphNewTransportMetrics.ts";

const verdict = evaluateGraphNewTransportGate({
  width: 3840,
  height: 2160,
  readbackToPresentP95Ms: 101,
  compositorFpsP95: 60,
  compositorFrameTimeP95Ms: 16,
  longestAvoidableMainThreadTaskMs: 20,
  maximumQueueDepth: 1,
  usedTextPixelEncoding: false,
  tornOrStaleFrames: 0,
});
assert.equal(verdict.pass, false);
assert.deepEqual(verdict.failedBudgets, ["readbackToPresentP95Ms"]);
```

Cover every gate independently, including queue depth >1 and text encoding.

- [x] **Step 2: Run metric tests and verify RED**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransportMetrics.test.ts`

Expected: FAIL because the metrics module does not exist.

- [x] **Step 3: Implement pure gate evaluation and make tests GREEN**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransportMetrics.test.ts`

Expected: PASS with exact thresholds from Global Constraints.

- [x] **Step 4: Implement the actual Tauri WebView benchmark**

The benchmark requests deterministic 1080p and 4K frame sequences, consumes raw channel payloads only as `ArrayBuffer`/typed views, creates `ImageBitmap` or updates a canvas without Base64, and records:

```ts
export interface GraphNewTransportSample {
  frameId: number;
  renderMs: number;
  readbackMs: number;
  transferMs: number;
  decodeMs: number;
  presentMs: number;
  readbackToPresentMs: number;
  payloadBytes: number;
}
```

Use `requestAnimationFrame` during scripted CSS transform pan/zoom to measure compositor responsiveness while replacement frames arrive. Observe long tasks and mark stale/torn frames with deterministic corner pixels.

- [x] **Step 5: Implement bounded automation**

Add:

```json
"benchmark:graph-new-transport": "node scripts/runGraphNewTransportBudget.mjs"
```

The script starts the actual Tauri release application with a benchmark route, waits for one JSON report, writes `test-results/graph-new-transport/report.json`, shuts down owned processes, and exits nonzero when the 4K gate fails.

- [x] **Step 6: Run focused frontend checks**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphNewTransportMetrics.test.ts && npx vite build`

Expected: PASS.

- [x] **Step 7: Run the release 1080p/4K gate**

Run: `npm run benchmark:graph-new-transport`

Expected: machine-readable report contains both resolutions, stage P50/P95/max, compositor P95, Rust-frame Hz, payload bytes, peak buffers/bytes, dropped frames, maximum queue depth, stale/torn count, and a final verdict.

- [x] **Step 8: Enforce the architecture decision**

If PASS: record the report path and transport mechanism in `docs/performance.md`, then continue to Task 4.

If FAIL: stop implementation. Record which budget failed and open an Issue 221 decision checkpoint choosing exactly one of reduced resolution/cadence, WebView-side WebGPU, or separately authorized Plan C. Do not implement Task 4 or later.

Recorded result (2026-09-17): FAIL at 3840 x 2160 on compositor FPS P95
(50.00 FPS, required at least 55) and compositor frame-time P95 (20 ms,
required at most 18 ms). Readback-to-present P95 was 30.51 ms. The selected
checkpoint is reduced cadence while retaining 4K coherent output. Task 4 is
unblocked by an explicit user-approved exception on 2026-09-17. The strict
gate remains failed; transport optimization is deferred and the measured
50.00 FPS / 20 ms result must not be represented as a pass.

---

### Task 4: Session-Only Graph Builder-new Shell

**Files:**
- Create: `src/types/graphBuilderNew.ts`
- Create: `src/stores/useGraphBuilderNewStore.ts`
- Create: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Create: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `src/components/Workspace.tsx`
- Create: `tests/workspaceGraphBuilderNew.test.ts`
- Create: `tests/GraphBuilderNewHarness.tsx`
- Create: `tests/graphBuilderNew.spec.tsx`

**Interfaces:**
- Consumes: current dataset metadata and numeric column descriptors only.
- Produces: temporary `GraphBuilderNewSession { id, datasetId, datasetGeneration, xColumnId, yColumnId }` and one independently closable workspace surface.

- [x] **Step 1: Write failing lifecycle/source-contract tests**

Assert that the Graph menu contains `Graph Builder-new`, creation does not call folder/project persistence or history, project save/open payloads do not reference the new store, and the current Graph Builder handler remains byte-for-byte behaviorally independent.

Run: `npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts`

Expected: FAIL because the menu and session store do not exist.

- [x] **Step 2: Implement the minimal store and Workspace entry**

Use a dedicated Zustand store with `open(datasetId, generation)`, `setColumns(id, xColumnId, yColumnId)`, and `close(id)`. Do not reuse `useGraphBuilderStore` and do not mark the project dirty.

- [x] **Step 3: Implement field selection and states**

Render numeric X/Y selectors, empty/loading/error states, and a transport capability diagnostic. Keep the view session-only and light-theme.

- [x] **Step 4: Run focused lifecycle and component tests**

Run: `npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts && npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx`

Expected: PASS for menu opening, current-dataset binding, numeric-only fields, closing, and persistence isolation.

Recorded result (2026-09-17): lifecycle/source contracts passed, all six
Playwright component tests passed on an isolated CT port, and `npm run build`
passed. The existing Graph Builder path remains independent and the new shell
does not enter project save, history, folder, or dirty-state flows.

---

### Task 5: GraphKey, Tile Format, And Full-Source LOD

**Files:**
- Create: `src-tauri/src/models/graph_new_data.rs`
- Create: `src-tauri/src/services/graph_new_key.rs`
- Create: `src-tauri/src/services/graph_new_tile.rs`
- Create: `src-tauri/src/services/graph_new_lod.rs`
- Create: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/perf_harness.rs`

**Interfaces:**
- Produces: `GraphKey::canonical`, `GraphNewTileHeader::decode`, `TilePyramidBuilder::push_batch`, `TilePyramid::select(camera)`, and `GraphNewService::build(request, progress_sink)`.
- Graph identity uses dataset ID/generation, stable X/Y column IDs, normalized filter identity, renderer contract version, tile format version, and domain policy.

- [x] **Step 1: Write failing GraphKey and tile-format tests**

Cover display-name independence, generation/version invalidation, deterministic hashing, round trip, bad magic/version/length/checksum rejection, and path-safe diagnostics.

- [ ] **Step 2: Verify RED**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_ --lib && popd >/dev/null`

Expected: FAIL because modules do not exist.

Recovery note: the initial missing-module RED transcript was not retained, so
Step 2 remains unchecked as historical evidence only. Recovery directly
observed RED/GREEN for scan-capacity and asymmetric-domain regressions.

- [x] **Step 3: Implement canonical key and versioned SoA tile format**

Use explicit little-endian fields, checked arithmetic, finite coordinates, counts, row IDs, checksum, and format constants. Never use native struct layout as the disk contract.

- [x] **Step 4: Write failing deterministic LOD tests**

Generate dense and sparse points, feed them in different batch sizes, and assert identical representatives, exact all-source counts, finite exclusion counters, and bounded selected marks for a fixed viewport.

- [x] **Step 5: Implement streaming pyramid construction**

Project only `_row_id`, X, and Y through validated identifiers. Process bounded DuckDB batches into global bounds, coarse overview, progressively finer tiles, counts, deterministic representatives, and retained row identity. Check cancellation and generation between batches.

- [x] **Step 6: Run focused LOD tests**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_ --lib && popd >/dev/null`

Expected: PASS for determinism, count preservation, invalid-value exclusion, cancellation, stale generation, and bounded memory.

- [x] **Step 7: Add and run headless scale workloads**

Run: `pushd src-tauri >/dev/null && cargo run --release --features perf-harness --example performance_baseline -- --graph-new-rows 100000,1000000,10000000 && popd >/dev/null`

Expected: JSON records processed/excluded rows, overview/pyramid times, tile counts/bytes, peak memory, cancellation, and zero gesture-query count placeholder derived from the headless camera selector.

Recorded recovery result (2026-09-17): 50 focused Rust tests passed and the
release scale matrix completed. The 100k / 1M / 10M full builds took
1,510 / 2,068 / 7,541 ms; whole-matrix OS peak RSS was 503,037,952 bytes.
See `docs/performance.md` for exact counts, storage, accounting, and limitations.
Overview-ready currently equals full-build completion, and gesture-query counts
are explicitly unmeasured static placeholders. Early overview delivery and
live rendering/interaction qualification are not claimed by this milestone.

---

### Task 6: Point Scene, Axes, And Approved Frame Transport

**Files:**
- Create: `src-tauri/src/services/graph_new_renderer.rs`
- Create: `src-tauri/src/services/graph_new_ticks.rs`
- Create: `src-tauri/src/services/graph_new_text.rs`
- Modify: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/graph_new_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/graphNewService.ts`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`

**Interfaces:**
- Consumes: selected LOD tiles and the Task 3 approved transport.
- Produces: `GraphNewRenderer::render(scene)`, stable numeric ticks, bounded glyph atlas, clipping, and coherent light-theme frames.

- [x] **Step 1: Write failing tick, transform, clipping, and pixel tests**

Assert stable ticks for constant/tiny/large domains, camera transform coordinates, plot clipping, deterministic light-theme background/grid/point pixels, and 1x/2x DPR dimensions.

- [x] **Step 2: Verify RED**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_ --lib && popd >/dev/null`

Expected: FAIL because renderer modules do not exist.

- [x] **Step 3: Implement the minimal scene renderer**

Use GPU point buffers, one camera uniform, plot scissor/clip, light-theme grid/axes, and one bounded cross-platform glyph atlas. Reuse adapter/device/queue and staging buffers established by Slice 0.

- [x] **Step 4: Connect the view through the approved transport**

Render a previous coherent frame until the complete current-identity bitmap is decoded, then atomically replace it. Surface stable reason codes without raw driver details or paths.

- [x] **Step 5: Run focused Rust/frontend checks**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_ --lib && popd >/dev/null && npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts && PLAYWRIGHT_CT_PORT=3121 npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx`

Expected: PASS with deterministic screenshots for the light-theme point plot.

Recorded Task 6 result (2026-09-17): observed missing-API RED, then 64 focused
Rust tests, 15 component tests, four TypeScript contract scripts, app/component
typechecks, and frontend/backend builds passed. Builds retain warnings.
Native GPU tests exercise points, clipping, ticks and DPR; browser component
pixel/screenshots use deterministic mocked raw frames, not native IPC.

The view now selects numeric fields and presents the native light-theme point
scene using one active request, a latest-only pending request and one
session/key-bound LOD cache. Resize reuses the cache. Temporary view unmount
cancels work without permanently retiring a retained session. Aspect-preserving
frame caps and readable numeric tick labels have regression coverage. Numeric
glyphs are bounded to the atlas; frontend owns axis titles. Task 7 gestures,
hit testing and table selection are not implemented yet.

Review ruling: all reachable UI blockers were repaired. Runtime closure does
not retain permanent UUID tombstones after another session takes ownership;
crafted retired-ID reuse with a newly higher generation is outside the current
single-producer UI contract. Delayed lower-generation requests remain rejected.

Manual acceptance pending: isolated native dev app started with devUrl
`http://127.0.0.1:3122`. In that desktop instance, open a table, choose
Graph -> Graph Builder-new, select X/Y, resize, switch Workflow/Files and
return, then close/reopen. Browser preview alone cannot exercise native IPC.
No commit or push has been performed.

---

### Task 7: Interaction, Hit Testing, And Stale Fencing

Priority update (2026-09-17): the user confirmed native point drawing and
acceptable initial speed, then prioritized pan/zoom and cache/performance work.
Execute camera Steps 1-2 and their focused verification first, then Task 8.
Defer hover, hit testing and table-selection Steps 3-4 until that work is
verified. Task 7 as a whole remains incomplete while those items are deferred;
do not claim tooltip/click acceptance from camera-only tests.

**Files:**
- Create: `src/services/graphNewCamera.ts`
- Create: `tests/graphNewCamera.test.ts`
- Create: `src-tauri/src/services/graph_new_hit_test.rs`
- Modify: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`

**Interfaces:**
- Produces: affine gesture reprojection, settled camera requests, bounded tile spatial hit test, tooltip identity, and click `{ rowId, xColumnId, yColumnId }`.

- [x] **Step 1: Write failing camera-settle tests**

Assert wheel/pointer transforms immediately update CSS/canvas presentation, coalesce repeated gestures, emit one settled request, and never increment the query counter.

- [ ] **Step 2: Implement camera state and settled scheduling**

Keep gesture transforms in the WebView compositor, apply overscan, show provisional axis state, and request one fresh Rust frame after settle.

Camera core implemented and verified: pointer pan, wheel anchoring, reset,
75 ms settle, latest-only frames and zoom retention across resize/DPR. Camera
cache misses never trigger source scans. Preview currently uses bounded crop,
not overscan, so Step 2 remains partially complete. Hover/click remain deferred.
Final checks: 88 Rust, 21 CT, five TS scripts and frontend/backend builds passed.
Native gesture acceptance and P95 qualification remain pending.

- [ ] **Step 3: Write failing Rust hit-test tests**

Cover nearest visible point, dense-cell ambiguity, out-of-plot input, stale dataset generation, and a strict bounded candidate count.

- [ ] **Step 4: Implement bounded hit testing and row identity verification**

Use only displayed tile indexes; never query DuckDB on hover, click, pan, or zoom. Verify dataset generation before calling the existing table-selection bridge.

- [ ] **Step 5: Run focused interaction tests**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts && npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx && pushd src-tauri >/dev/null && cargo test graph_new_hit_test::tests graph_new_service::tests --lib && popd >/dev/null`

Expected: PASS for pan/zoom, settled replacement, tooltip, stable click identity, stale-frame preservation, and zero interaction queries.

---

### Task 8: Persistent, CPU, And GPU Cache Budgets

#### Approved Performance-First Default (2026-09-17)

The user's decision to prioritize performance supersedes the lossless-index
prerequisite for the current default. Production build/select/persistence use
bounded LOD, restoring the 4096 fine retained-point cap. Full source scanning and
global finite/excluded counts remain exact, but retained marks and arbitrary
anomaly visibility are not complete. Approximate partial viewport counts are
`visibleRows: null`; `exactVisible` requires proof from complete retained tiles.

- [x] Behavioral RED/GREEN for zero default raw payload/work, bounded marks and memory.
- [x] LOD-only roundtrip, cache mode/key separation, valid-checksum legacy-schema rejection.
- [x] Preserve raw recovery/ordinal/checksum tests with explicit research opt-in.
- [x] Nullable completion validation and approximate/count-unknown UI RED/GREEN.
- [x] Full graph_new Rust suite: 102 passed; preserve source, camera, cache and security fixes.
- [ ] Complete TS/CT and frontend/backend builds, then one fresh release 100K/1M/10M matrix.

The production key is `graph-new-v4-bounded-lod`, schema `GNPC0003`; research uses
a separate key/schema and is not a public request option. Existing transient LOD
construction spools and capacity/cancellation/epoch/path guards remain. Default
cache reservations exclude raw index ownership and 64 MiB raw-query scratch.
Full raw retrieval is deferred, not removed from the future goal. No feature
parity work is added. Current evidence belongs in
`test-results/step8-performance-first-handoff.md`; the lossless and task8 handoffs
remain historical comparison records. Controller review and native acceptance
remain separate, and the broader Task 8 acceptance below stays open.

Status (2026-09-17): partly implemented, not fully accepted. Real CPU/decoded
LRU, lifetime-scoped disk restore and identical-scene GPU reuse are integrated.
Review fixes for missing-file accounting and optional startup fallback passed.
See `docs/performance.md` for measurements and the remaining disk-latency,
uniform-only GPU, filesystem-race and orphan-cleanup gaps. The original full
acceptance checklist below remains open until those requirements are met.

**Files:**
- Create: `src-tauri/src/services/graph_new_cache.rs`
- Modify: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src-tauri/src/services/graph_new_renderer.rs`
- Modify: `src-tauri/src/perf_harness.rs`

**Interfaces:**
- Produces: `GraphNewCacheCoordinator` with persistent/CPU/GPU tiers, per-graph and process LRU limits, version invalidation, corruption deletion/rebuild, and warm reopen metrics.

- [ ] **Step 1: Write failing cache tests**

Cover 256 MiB per-graph GPU eviction, 1 GiB process eviction, pinned-current tile protection, corrupt checksum rebuild, incompatible version miss, generation miss, and derived-file-only deletion.

- [ ] **Step 2: Verify RED**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_cache::tests --lib && popd >/dev/null`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement cache tiers and deterministic invalidation**

Store versioned tiles only under the application cache directory. Keep absolute paths and raw I/O errors out of IPC diagnostics. Track bytes and evictions per tier.

- [ ] **Step 4: Run focused cache and warm-reopen tests**

Run: `pushd src-tauri >/dev/null && cargo test graph_new_cache::tests graph_new_service::tests --lib && popd >/dev/null`

Expected: PASS, including safe pressure degradation and rebuild after corruption.

---

### Task 9: Integrated 10M Performance And Failure Gate

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src/benchmarks/GraphNewTransportBenchmark.tsx`
- Modify: `src/benchmarks/graphNewTransportMetrics.ts`
- Modify: `scripts/runGraphNewTransportBudget.mjs`
- Modify: `docs/performance.md`
- Create: `tests/graphNewPerformancePolicy.test.ts`

**Interfaces:**
- Produces: one release report covering scan, LOD, caches, render/transport, compositor interaction, hit testing, cancellation, corruption, device loss, and stale-frame outcomes.

- [ ] **Step 1: Write failing integrated policy tests**

Assert each acceptance threshold independently and verify that compositor FPS cannot substitute for Rust-frame cadence or transport latency.

- [ ] **Step 2: Implement report aggregation and run focused policy tests**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewPerformancePolicy.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the release 100K/1M/10M matrix once**

Run: `npm run benchmark:graph-new-transport -- --rows 100000,1000000,10000000 --resolutions 1920x1080,3840x2160`

Expected: report records all required stage timings, counts, bytes, query count, cache pressure, frame distributions, identity latency, stale/torn count, and explicit pass/fail reasons.

- [ ] **Step 4: Record measured evidence**

Append the machine class, release SHA, command, report path, and exact results to `docs/performance.md`. Do not soften failed budgets into averages.

---

### Task 10: Final Hardening And MVP Decision

**Files:**
- Modify only files identified by failing focused checks or review findings.

**Interfaces:**
- Produces: verified MVP tree, independent review disposition, and manual-acceptance artifact.

- [ ] **Step 1: Run affected focused suites**

Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphNewTransportMetrics.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphNewPerformancePolicy.test.ts && npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx`

Run: `pushd src-tauri >/dev/null && cargo test graph_new --lib && cargo check --lib && popd >/dev/null`

Expected: all graph-new focused checks PASS.

- [ ] **Step 2: Run the one final repository gate**

Run: `npx vite build`

Run: `pushd src-tauri >/dev/null && cargo build && cargo test && cargo clippy -- -D warnings && popd >/dev/null`

Run: `git --no-pager diff --no-ext-diff --check`

Expected: all required gates PASS. If repository-wide pre-existing failures occur, record exact untouched-file evidence and do not claim the gate passed.

- [ ] **Step 3: Request independent review**

Provide Issue 221, this plan, base SHA `530a9e1`, current head, untracked files, performance report, and explicit focus on binary transport copies, backpressure, stale fencing, SQL validation, cache paths, GPU loss, and existing Graph Builder isolation. Fix all Critical/Important findings and rerun affected checks.

- [ ] **Step 4: Start the exact worktree application for manual acceptance**

Run: `npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/221-wgpu-graph-builder-new run tauri -- dev`

Verify the process executable, frontend path, and port belong to this worktree. Ask the user to test opening/closing `Graph Builder-new`, selecting numeric X/Y, first overview, pan/zoom, tooltip/click identity, fallback diagnostics, and unchanged existing Graph Builder.

- [ ] **Step 5: Stop at manual acceptance**

Do not commit, push, or create a PR until the user explicitly accepts the running application. After acceptance, follow the GitHub Issue lifecycle to create scoped conventional commits, push without force, and open a PR to `dev`; never commit directly on `dev`.

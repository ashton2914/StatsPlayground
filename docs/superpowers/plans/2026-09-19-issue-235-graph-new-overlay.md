# Issue 235 Graph Builder-new Overlay and Legend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, high-performance Overlay channel and accessible Legend to Graph Builder-new, with stable colors, group-safe Point/Raw Line/Mean rendering, zero-query visibility toggles, a required 2M-row qualification, and a bounded 10M-row stretch run.

**Architecture:** Rust extends the existing one-pass Graph Builder-new projection with a bounded 64-entry Overlay dictionary and carries compact `u16` group codes through `SourcePoint`, tile v2, the LOD pyramid, grouped Raw/Mean geometry, and `wgpu`. React persists the selected Overlay field and hidden group IDs, validates backend-owned group metadata, and renders a bounded HTML Legend; hidden IDs affect only presentation buffers and never `GraphKey` or DuckDB projection.

**Tech Stack:** Tauri 2.11, Rust 2021, DuckDB, `wgpu` 30.0.1, React 19, TypeScript 5.7, Zustand 5, Playwright Component Testing.

**Spec:** `docs/superpowers/specs/2026-09-19-issue-235-graph-new-overlay-design.md`

## Global Constraints

- Work only in `/Users/ashton/git/ashton2914/StatsPlayground.worktrees/235-graph-new-overlay` on `issue/235-graph-new-overlay`; never commit directly to `dev`.
- Keep WIP at one task. Each task must complete RED, minimal implementation, focused GREEN, affected checks, review, and one Conventional Commit before the next task starts.
- Do not add or upgrade dependencies.
- Overlay admits at most 64 distinct groups including the missing-value group; the 65th fails with `graph_new_overlay_too_many_groups`.
- Overlay labels are at most 512 UTF-8 bytes. Hidden IDs are unique full `sha256:<64 lowercase hex>` strings and are capped at 64.
- Missing Overlay values form a distinct synthetic group; missing X/Y keeps the existing exclusion semantics.
- `overlayColumnId` changes `GraphKey`; `hiddenOverlayGroupIds` never changes `GraphKey`, camera, source projection, or persistent cache identity.
- Preserve the current no-Overlay blue Point/Raw/Mean appearance and behavior.
- Preserve the current 512 MiB construction default, 1 GiB construction maximum, 768 MiB CPU graph-cache share, 256 MiB GPU cache, 1 GiB persistent cache, and 2,100,000-mark scene ceiling.
- All SQL identifiers must resolve through dataset metadata and existing quoting helpers; values stay parameterized.
- Rust production code returns `Result<T, AppError>` and must not add `unwrap()` or `expect()`.
- Version incompatible derived data explicitly: renderer contract 2, tile format 2, `GNPC0004`, and `graph-new-v7-overlay-compact-exact-2100000`.
- Archive loading accepts exact Graph Builder-new document versions 1 and 2; in-memory state is always version 2; migration does not dirty the project.
- A warm camera render or Legend toggle must report `sourceProjectionQueryCount == 0`.
- Required acceptance is at least 2,000,000 finite X/Y rows. The 10,000,000-row run is a bounded stretch measurement, and a single run is never labeled P95.
- Isolate every Playwright output under `.cache/issue235-overlay/<task>/ct`; never use the shared `test-results` evidence directory.
- Add direct documentation updates to `docs/performance.md` in the performance task.

## File Structure

### New files

- `src-tauri/src/services/graph_new_overlay.rs` — bounded group dictionary, stable identity/color derivation, missing group, enabled mask, and internal grouped geometry types.
- `src/components/graphBuilderNew/GraphNewOverlayLegend.tsx` — accessible, bounded HTML Legend; no backend calls and no palette logic.

### Existing files with changed responsibility

- `src/types/graphBuilderNew.ts` — version-1 archive input, normalized version-2 document/session, Overlay persistence types.
- `src/types/project.ts`, `src/services/projectService.ts` — legacy v1 open payload typing and normalized v2 save payload typing.
- `src/stores/useGraphBuilderNewStore.ts` — version migration, Overlay selection, hidden group state, dirty/read-only semantics.
- `src/services/graphNewService.ts` — strict Overlay request/completion validation and safe reason mapping.
- `src/components/graphBuilderNew/GraphBuilderNewView.tsx` — Overlay field selection and missing-field handling.
- `src/components/graphBuilderNew/GraphNewCanvas.tsx` — validated group metadata state, hidden-ID render requests, and Legend composition.
- `src/components/graphBuilderNew/GraphBuilderNewView.css` — bounded Legend layout, swatches, hidden state, focus, and narrow-width behavior.
- `src/i18n/locales/en.json`, `src/i18n/locales/zh-CN.json` — Overlay, Missing, visibility, and bounded-cardinality messages.
- `src-tauri/src/models/graph_new.rs` — Overlay IPC models and render request/completion fields.
- `src-tauri/src/models/graph_new_data.rs` — optional Overlay build identity.
- `src-tauri/src/services/graph_new_key.rs` — optional Overlay key identity and format-version changes.
- `src-tauri/src/services/graph_new_tile.rs` — tile v2 group-code column and byte accounting.
- `src-tauri/src/services/graph_new_lod.rs` — grouped source shape, catalog persistence, minority-safe admission, grouped Raw/Mean caches.
- `src-tauri/src/services/graph_new_service.rs` — metadata validation, one-pass Overlay projection, hidden-ID resolution, grouped scene construction.
- `src-tauri/src/services/graph_new_renderer.rs` — per-group Point/Raw/Mean colors and visibility-filtered GPU buffers.
- `src-tauri/src/services/graph_new_cache.rs` — versioned resource accounting and visibility reuse assertions.
- `src-tauri/src/services/mod.rs` — register `graph_new_overlay`.
- `src-tauri/src/services/spprj_archive.rs` — exact v1/v2 native graph archive validation.
- `src-tauri/src/perf_harness.rs` — deterministic grouped Graph-new workload and 2M/10M evidence fields.
- `tests/graphNewService.test.ts` — IPC validation and zero-query Overlay completion contracts.
- `tests/workspaceGraphBuilderNew.test.ts` — document migration and store behavior.
- `tests/GraphBuilderNewHarness.tsx` — Overlay descriptors, group completions, hidden requests, and query counters.
- `tests/graphBuilderNew.spec.tsx` — field/Legend/persistence/read-only/component acceptance.
- `tests/WorkspaceGraphNewHarness.tsx`, `tests/workspaceGraphNew.spec.tsx` — workspace reopen and archive lifecycle.
- `docs/performance.md` — required and stretch measurement provenance.

---

### Task 1: Versioned Document and IPC Contracts

**Files:**
- Modify: `src/types/graphBuilderNew.ts`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/stores/useGraphBuilderNewStore.ts`
- Modify: `src/services/graphNewService.ts`
- Modify: `src-tauri/src/models/graph_new.rs`
- Modify: `src-tauri/src/models/graph_new_data.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `tests/workspaceGraphBuilderNew.test.ts`
- Modify: `tests/graphNewService.test.ts`
- Modify: `tests/WorkspaceGraphNewHarness.tsx`
- Modify: `tests/workspaceGraphNew.spec.tsx`

**Interfaces:**
- Consumes: Existing `GraphBuilderNewDocument` v1, `GraphNewRenderRequest`, `GraphNewRenderCompletion`, and archive exact-field validation.
- Produces: `PersistedGraphBuilderNewDocument`, normalized `GraphBuilderNewDocument` v2, `setOverlay(id, overlayColumnId)`, `setHiddenOverlayGroups(id, ids)`, Rust/TS `GraphNewOverlayGroup`, and strict optional Overlay request fields.

- [ ] **Step 1: Restore existing frontend dependencies once**

Run:

```bash
cd /Users/ashton/git/ashton2914/StatsPlayground.worktrees/235-graph-new-overlay
test -d node_modules || npm ci
```

Expected: existing lockfile installs without changing `package.json` or `package-lock.json`.

- [ ] **Step 2: Write failing document migration and store tests**

Add tests to `tests/workspaceGraphBuilderNew.test.ts` that load this legacy value and assert normalized v2 state without dirty feedback:

```ts
const legacy = {
  version: 1, id: "legacy", name: "Legacy", datasetId: "dataset-1",
  xColumnId: "x", yColumnId: "y", showMean: true,
  xMode: "auto", rawMode: "scatter", camera: null,
} as const;

useProjectStore.setState({ dirty: false, readOnly: false });
useGraphBuilderNewStore.getState().loadFromProject([legacy]);
assert.deepEqual(useGraphBuilderNewStore.getState().items[0], {
  ...legacy,
  version: 2,
  overlayColumnId: null,
  hiddenOverlayGroupIds: [],
});
assert.equal(useProjectStore.getState().dirty, false);

const id = useGraphBuilderNewStore.getState().items[0].id;
useGraphBuilderNewStore.getState().setOverlay(id, "overlay");
useGraphBuilderNewStore.getState().setHiddenOverlayGroups(id, [
  `sha256:${"a".repeat(64)}`,
]);
assert.equal(useGraphBuilderNewStore.getState().items[0].overlayColumnId, "overlay");
assert.deepEqual(useGraphBuilderNewStore.getState().items[0].hiddenOverlayGroupIds, [
  `sha256:${"a".repeat(64)}`,
]);
```

Also assert that changing Overlay clears hidden IDs and preserves `camera`.

- [ ] **Step 3: Run the store test to verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts
```

Expected: FAIL because version 1 is rejected and `setOverlay` / `setHiddenOverlayGroups` do not exist.

- [ ] **Step 4: Define v1 input and normalized v2 document types**

Implement these exact public shapes in `src/types/graphBuilderNew.ts`:

```ts
export interface GraphBuilderNewDocumentV1 {
  version: 1;
  id: string;
  name: string;
  datasetId: string;
  xColumnId: string | null;
  yColumnId: string | null;
  showMean: boolean;
  xMode: GraphNewXMode;
  rawMode: GraphNewRawMode;
  camera: GraphBuilderNewCamera | null;
}

export interface GraphBuilderNewDocument {
  version: 2;
  id: string;
  name: string;
  datasetId: string;
  xColumnId: string | null;
  yColumnId: string | null;
  overlayColumnId: string | null;
  hiddenOverlayGroupIds: string[];
  showMean: boolean;
  xMode: GraphNewXMode;
  rawMode: GraphNewRawMode;
  camera: GraphBuilderNewCamera | null;
}

export type PersistedGraphBuilderNewDocument =
  | GraphBuilderNewDocumentV1
  | GraphBuilderNewDocument;
```

Update `GraphBuilderNewSession` so it carries v2 Overlay fields and keeps runtime-only identity separate from the persisted shape.
Type `OpenProjectResult.graphBuildersNew` as
`PersistedGraphBuilderNewDocument[]`; keep
`SaveProjectRequest.graphBuildersNew` as normalized
`GraphBuilderNewDocument[]`. `projectService.openProject` passes the persisted
union to `loadFromProject`; save continues to receive only store-owned v2
documents.

- [ ] **Step 5: Normalize documents and add guarded store actions**

In `useGraphBuilderNewStore.ts`, add:

```ts
const GROUP_ID = /^sha256:[0-9a-f]{64}$/;

function normalizeDocument(
  item: PersistedGraphBuilderNewDocument,
): GraphBuilderNewDocument {
  const overlayColumnId = item.version === 2 ? item.overlayColumnId : null;
  const hiddenOverlayGroupIds =
    item.version === 2 ? [...item.hiddenOverlayGroupIds] : [];
  if (hiddenOverlayGroupIds.length > 64
    || new Set(hiddenOverlayGroupIds).size !== hiddenOverlayGroupIds.length
    || hiddenOverlayGroupIds.some((id) => !GROUP_ID.test(id))
    || (!overlayColumnId && hiddenOverlayGroupIds.length > 0)) {
    throw new Error("graph_new_invalid_overlay_state");
  }
  return {
    ...item,
    version: 2,
    overlayColumnId,
    hiddenOverlayGroupIds,
    camera: copyCamera(item.camera),
  };
}
```

Add `setOverlay` and `setHiddenOverlayGroups` to the store interface and implementation. `setOverlay` clears hidden IDs when identity changes and does not clear camera. `setHiddenOverlayGroups` validates, copies, sorts, respects `assertProjectMutable`, and marks dirty only for a real change.

- [ ] **Step 6: Write failing TS IPC validation tests**

In `tests/graphNewService.test.ts`, add a valid completion group:

```ts
const overlayId = `sha256:${"1".repeat(64)}`;
const overlayGroup = {
  id: overlayId,
  code: 1,
  label: "A",
  color: [31, 111, 235, 255],
  totalRows: 3,
  missing: false,
};
const overlayRequest = {
  ...cameraRequest,
  overlayColumnId: "group-column",
  hiddenOverlayGroupIds: [overlayId],
};
const overlayCompletion = {
  ...cameraCompletion,
  overlayActive: true,
  overlayGroups: [overlayGroup],
  hiddenOverlayGroups: 1,
};
```

Assert the valid shape passes, then assert rejection for duplicate IDs/codes, malformed hashes, 65 hidden IDs, hidden IDs without Overlay, RGBA values outside `0..255`, a label over 512 UTF-8 bytes, and group counts whose sum differs from `finiteRows`.

- [ ] **Step 7: Run the IPC test to verify RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts
```

Expected: FAIL because Overlay request/completion fields are not defined or validated.

- [ ] **Step 8: Add matching Rust and TypeScript IPC models**

Add this Rust model in `src-tauri/src/models/graph_new.rs`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNewOverlayGroup {
    pub id: String,
    pub code: u16,
    pub label: String,
    pub color: [u8; 4],
    pub total_rows: u64,
    pub missing: bool,
}
```

Add `overlay_column_id: Option<String>` and
`hidden_overlay_group_ids: Vec<String>` to `GraphNewRenderRequest`; add
`overlay_groups`, `overlay_active`, and `hidden_overlay_groups` to completion.
Add only `overlay_column_id` to `GraphNewBuildRequest`. No-Overlay service
responses must populate false/empty/zero explicitly.

Mirror the fields in `graphNewService.ts`. Extend `validateRenderRequest`,
`validateCompletion`, and `safeReason` with the exact limits and safe Overlay
reason codes from the spec.

- [ ] **Step 9: Add exact v1/v2 archive validation**

Refactor `validate_graph_builder_new_value` in `spprj_archive.rs` into a version
dispatch. Version 1 keeps the current ten fields. Version 2 requires exactly:

```rust
let fields = [
    "version", "id", "name", "datasetId", "xColumnId", "yColumnId",
    "overlayColumnId", "hiddenOverlayGroupIds", "showMean", "xMode",
    "rawMode", "camera",
];
```

Validate the optional Overlay column ID and every hidden ID, reject duplicates,
reject more than 64, and reject nonempty hidden state without Overlay. Add Rust
archive tests proving v1 acceptance, v2 round trip, and malformed v2 rejection.

- [ ] **Step 10: Run focused GREEN checks**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts
cargo test --manifest-path src-tauri/Cargo.toml graph_new -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_builder_new -- --test-threads=1
```

Expected: all selected tests pass; the serial Graph-new count is nonzero and has zero failures.

- [ ] **Step 11: Run affected workspace/archive component checks**

Run:

```bash
npx playwright test -c playwright-ct.config.ts \
  tests/workspaceGraphNew.spec.tsx \
  --output=.cache/issue235-overlay/task1/ct
```

Expected: PASS with output isolated under the task directory.

- [ ] **Step 12: Commit Task 1**

```bash
git add src/types/graphBuilderNew.ts \
  src/types/project.ts \
  src/services/projectService.ts \
  src/stores/useGraphBuilderNewStore.ts \
  src/services/graphNewService.ts \
  src-tauri/src/models/graph_new.rs \
  src-tauri/src/models/graph_new_data.rs \
  src-tauri/src/services/spprj_archive.rs \
  tests/workspaceGraphBuilderNew.test.ts \
  tests/graphNewService.test.ts \
  tests/WorkspaceGraphNewHarness.tsx \
  tests/workspaceGraphNew.spec.tsx
git commit -m "feat(graph): version native overlay contracts" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Group Dictionary, GraphKey, Tile v2, and Cache Metadata

**Files:**
- Create: `src-tauri/src/services/graph_new_overlay.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/graph_new_key.rs`
- Modify: `src-tauri/src/services/graph_new_tile.rs`
- Modify: `src-tauri/src/services/graph_new_lod.rs`
- Modify: `src-tauri/src/services/graph_new_cache.rs`

**Interfaces:**
- Consumes: Task 1 `GraphNewOverlayGroup` and optional `overlay_column_id`.
- Produces: `OverlayDictionary`, `OverlayCatalog`, `EnabledOverlayMask`, `SourcePoint::with_group`, tile `group_codes`, renderer/tile/key version 2, and persisted catalog metadata.

- [ ] **Step 1: Write failing dictionary tests in the new module**

Create `graph_new_overlay.rs` with tests specifying:

```rust
#[test]
fn dictionary_distinguishes_missing_literal_and_stabilizes_color() {
    let mut dictionary = OverlayDictionary::new("VARCHAR");
    let missing = dictionary.observe(None).expect("missing");
    let literal = dictionary.observe(Some("(Missing)")).expect("literal");
    let a = dictionary.observe(Some("A")).expect("A");
    assert_ne!(missing, literal);
    let catalog = dictionary.finish();
    assert_eq!(catalog.groups.iter().map(|group| group.total_rows).sum::<u64>(), 3);
    let first = catalog.group(a).expect("A").color;

    let mut rebuilt = OverlayDictionary::new("VARCHAR");
    let rebuilt_a = rebuilt.observe(Some("A")).expect("A");
    assert_eq!(rebuilt.finish().group(rebuilt_a).expect("A").color, first);
}

#[test]
fn dictionary_rejects_sixty_fifth_group_and_oversized_label() {
    let mut dictionary = OverlayDictionary::new("VARCHAR");
    for value in 0..64 {
        dictionary.observe(Some(&format!("group-{value}"))).expect("within cap");
    }
    assert!(matches!(
        dictionary.observe(Some("group-64")),
        Err(AppError::InvalidParam(message))
            if message == "graph_new_overlay_too_many_groups"
    ));
    assert!(dictionary.observe(Some(&"x".repeat(513))).is_err());
}
```

- [ ] **Step 2: Run dictionary tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new_overlay -- --test-threads=1
```

Expected: compile FAIL because the module and types do not exist.

- [ ] **Step 3: Implement bounded identity, color, catalog, and enabled mask**

Implement:

```rust
pub const MAX_OVERLAY_GROUPS: usize = 64;
pub const MAX_OVERLAY_LABEL_BYTES: usize = 512;
pub const ALL_ROWS_GROUP_CODE: u16 = 0;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OverlayCatalog {
    pub active: bool,
    pub groups: Vec<GraphNewOverlayGroup>,
}

pub struct OverlayDictionary {
    sql_type: String,
    groups_by_identity: BTreeMap<String, u16>,
    groups: Vec<GraphNewOverlayGroup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnabledOverlayMask(u64);
```

`observe` uses `missing` or `value:<sql_type>:<label>` as digest input, assigns a
first-seen `u16` code, increments exact count, and returns the code. Derive
nonmissing color only from the full SHA-256 bytes with fixed saturation and
lightness; missing is `[107, 114, 128, 255]`. `finish` sorts the public group
vector missing-last by `(label, id)` without changing internal codes.
`EnabledOverlayMask::from_hidden(&OverlayCatalog, &[String])` rejects unknown
IDs with `graph_new_overlay_group_missing`.

- [ ] **Step 4: Write failing GraphKey tests**

Extend `sample_parts()` with `overlay_column_id: None`. Add:

```rust
#[test]
fn overlay_column_changes_key_but_visibility_does_not_enter_key() {
    let baseline = GraphKey::canonical(&sample_parts()).expect("baseline");
    let mut grouped = sample_parts();
    grouped.overlay_column_id = Some("lot-column".into());
    let grouped = GraphKey::canonical(&grouped).expect("grouped");
    assert_ne!(baseline.hash_hex, grouped.hash_hex);
    assert_eq!(grouped.diagnostics.overlay_state, "hashed");
}
```

Update hostile-string coverage to prove raw Overlay column IDs do not appear in
diagnostics.

- [ ] **Step 5: Run GraphKey tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new_key -- --test-threads=1
```

Expected: compile FAIL because `overlay_column_id` and `overlay_state` do not exist.

- [ ] **Step 6: Version GraphKey and add optional Overlay identity**

Add the optional field to key parts, canonical JSON, and hashed diagnostics.
Set:

```rust
pub const GRAPH_NEW_RENDERER_CONTRACT_VERSION: u16 = 2;
pub const GRAPH_NEW_TILE_FORMAT_VERSION: u16 = 2;
```

Use `graph-new-v7-overlay-compact-exact-2100000` for bounded keys. Keep lossless
research keys unchanged and reject Overlay for the lossless constructor.

- [ ] **Step 7: Write failing tile v2 tests**

Update the tile round-trip fixture to include:

```rust
group_codes: vec![0, 1, 1],
```

Assert round trip equality, mismatched parallel length rejection, payload-length
rejection when the group-code bytes are removed, and explicit rejection of a
format-1 header.

- [ ] **Step 8: Run tile tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new_tile -- --test-threads=1
```

Expected: compile FAIL because `GraphNewTile` has no `group_codes`.

- [ ] **Step 9: Add group codes to source, spool, tile, and byte accounting**

Preserve existing constructors and add an explicit grouped constructor:

```rust
pub struct SourcePoint {
    pub row_id: i64,
    pub x: f64,
    pub y: f64,
    pub group_code: u16,
}

impl SourcePoint {
    pub fn new(row_id: i64, x: f64, y: f64) -> Self {
        Self::with_group(row_id, x, y, ALL_ROWS_GROUP_CODE)
    }

    pub fn with_group(row_id: i64, x: f64, y: f64, group_code: u16) -> Self {
        Self { row_id, x, y, group_code }
    }
}
```

Append `u16` codes to tile payloads and raw/bucket spool records. Replace every
fixed 24/28/32-byte estimate with checked calculations based on the concrete
columns. Include code capacity in `resident_bytes`, decoded cache limits,
construction estimates, encoded bytes, and checksums.

- [ ] **Step 10: Persist and validate the Overlay catalog with the pyramid**

Set bounded magic to `GNPC0004`. Add `overlay: OverlayCatalog` to
`TilePyramid` and `TilePyramidBuilder`. Serialize the catalog before tile index
metadata with a checked length. On read, validate:

```rust
for tile in decoded_tiles {
    if tile.group_codes.iter().any(|code| !overlay.contains_code(*code)) {
        return Err(AppError::Stats("graph_new_invalid_cache".into()));
    }
}
```

No-Overlay pyramids use `OverlayCatalog::default()` and code 0. Old magic is an
incompatible cache miss, not an in-place migration.

- [ ] **Step 11: Run focused and affected Rust GREEN checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new_overlay -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_key -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_tile -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_lod -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_cache -- --test-threads=1
```

Expected: all selected tests pass with nonzero execution counts.

- [ ] **Step 12: Commit Task 2**

```bash
git add src-tauri/src/services/graph_new_overlay.rs \
  src-tauri/src/services/mod.rs \
  src-tauri/src/services/graph_new_key.rs \
  src-tauri/src/services/graph_new_tile.rs \
  src-tauri/src/services/graph_new_lod.rs \
  src-tauri/src/services/graph_new_cache.rs
git commit -m "feat(graph): carry overlay groups through native cache" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: One-Pass Projection and Minority-Safe LOD

**Files:**
- Modify: `src-tauri/src/services/graph_new_overlay.rs`
- Modify: `src-tauri/src/services/graph_new_lod.rs`
- Modify: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src-tauri/src/services/graph_new_cache.rs`

**Interfaces:**
- Consumes: Task 2 dictionary/catalog, grouped `SourcePoint`, tile v2, and keyed optional Overlay identity.
- Produces: one-pass X/Y/Overlay projection, exact group counts, and `stratified_representatives(points, capacity)` used by every approximate tile.

- [ ] **Step 1: Write failing stratified admission tests**

Add a direct LOD test with 10,000 dominant points, one minority point, and one
missing-group point in one tile:

```rust
let mut points = (1..=10_000)
    .map(|row| SourcePoint::with_group(row, 0.5, 0.5, 1))
    .collect::<Vec<_>>();
points.push(SourcePoint::with_group(10_001, 0.5, 0.5, 2));
points.push(SourcePoint::with_group(10_002, 0.5, 0.5, 0));
let retained = stratified_representatives(points, 64).expect("retained");
assert_eq!(retained.len(), 64);
assert!(retained.iter().any(|point| point.group_code == 0));
assert!(retained.iter().any(|point| point.group_code == 2));
assert_eq!(
    retained.iter().filter(|point| point.group_code == 1).count(),
    62,
);
```

Add a tie test proving largest-remainder allocation uses group code and retained
points use the smallest row IDs within each group.

- [ ] **Step 2: Run the LOD test to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml stratified_representatives -- --test-threads=1
```

Expected: compile FAIL because the admission helper does not exist.

- [ ] **Step 3: Implement deterministic group allocation**

Implement a private helper with this exact contract:

```rust
fn stratified_representatives(
    points: impl IntoIterator<Item = SourcePoint>,
    capacity: usize,
) -> Result<Vec<SourcePoint>, AppError>
```

Build per-group counts and max-heaps ordered by row ID. Allocate one slot per
present group, then distribute remaining slots by
`population * remaining / total_population`; assign leftover slots by descending
remainder and ascending group code. Emit groups by code and points by row ID.
Reject `capacity < present_group_count` with `graph_new_cache_pressure`.

- [ ] **Step 4: Replace approximate coarse and fine admission**

For coarse levels, replace the single `representative` with bounded per-group
representatives and emit one or more points per tile. For the finest level,
replace the global `BinaryHeap<RowIdPoint>` with the same stratified helper.
Distribute overflow counts onto the first retained point of the corresponding
group, not onto an unrelated group. Preserve total tile source count and the
global `max_tile_points` ceiling.

- [ ] **Step 5: Write failing service projection tests**

Add service tests that seed:

```text
row_id | x | y | lot
1      | 1 | 5 | A
2      | 2 | 6 | NULL
3      | 3 | 7 | (Missing)
4      | 4 | 8 | A
```

Build with `overlay_column_id = Some("lot-id")` and assert:

```rust
assert_eq!(result.query_count, 1);
assert_eq!(result.pyramid.overlay.groups.len(), 3);
assert_eq!(
    result.pyramid.overlay.groups.iter().map(|group| group.total_rows).sum::<u64>(),
    4,
);
assert_ne!(
    result.pyramid.overlay.groups.iter().find(|group| group.missing).unwrap().id,
    result.pyramid.overlay.groups.iter().find(|group| group.label == "(Missing)" && !group.missing).unwrap().id,
);
```

Add 65 distinct groups and a 513-byte value, asserting the exact safe failures
and no completed cache admission.

- [ ] **Step 6: Run service projection tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml overlay_projection -- --test-threads=1
```

Expected: FAIL because the service does not resolve or project Overlay.

- [ ] **Step 7: Extend the metadata-validated projection**

Resolve the optional column from the existing `bindings` map. Add SQL
expressions for:

```sql
CASE WHEN <overlay_identifier> IS NULL THEN TRUE ELSE FALSE END,
CASE WHEN <overlay_identifier> IS NULL
     THEN NULL
     ELSE CAST(<overlay_identifier> AS VARCHAR)
END
```

Append them to both category and noncategory projection builders. Do not
interpolate values. In the row loop, call `OverlayDictionary::observe` only
for finite X/Y pairs, then create `SourcePoint::with_group`. Set the finished
catalog on the builder before `finish_with_control`.

- [ ] **Step 8: Include Overlay in every service GraphKey construction**

Populate `overlay_column_id` in the cold build and render paths. Keep hidden IDs
out of key parts. Extend cache tests to compare cold, warm, and hidden-set keys
and assert the same hash for different hidden sets.

- [ ] **Step 9: Run focused and affected GREEN checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml stratified_representatives -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml overlay_projection -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_service -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_lod -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_cache -- --test-threads=1
```

Expected: all selected tests pass; cold Overlay projection count is 1.

- [ ] **Step 10: Commit Task 3**

```bash
git add src-tauri/src/services/graph_new_overlay.rs \
  src-tauri/src/services/graph_new_lod.rs \
  src-tauri/src/services/graph_new_service.rs \
  src-tauri/src/services/graph_new_cache.rs
git commit -m "feat(graph): build minority-safe overlay lod" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Group-Safe Raw Line, Mean, and Native Rendering

**Files:**
- Modify: `src-tauri/src/services/graph_new_overlay.rs`
- Modify: `src-tauri/src/services/graph_new_lod.rs`
- Modify: `src-tauri/src/services/graph_new_service.rs`
- Modify: `src-tauri/src/services/graph_new_renderer.rs`
- Modify: `src-tauri/src/services/graph_new_cache.rs`

**Interfaces:**
- Consumes: Task 3 catalog, group-coded selected points, and exact/approximate selection.
- Produces: `GroupedLineSegment`, `GroupedMeanPoint`, enabled-mask scene input, per-group Point/Raw/Mean GPU color, and zero-query visibility renders.

- [ ] **Step 1: Write failing grouped Raw Line and Mean tests**

Define the expected internal types in tests:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupedLineSegment {
    pub indices: [u32; 2],
    pub group_code: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupedMeanPoint {
    pub group_code: u16,
    pub x: f64,
    pub y: f64,
}
```

Use interleaved source rows from groups 1 and 2. Assert every Raw segment has
equal endpoint group codes and Mean output equals:

```rust
vec![
    GroupedMeanPoint { group_code: 1, x: 1.0, y: 3.0 },
    GroupedMeanPoint { group_code: 1, x: 2.0, y: 5.0 },
    GroupedMeanPoint { group_code: 2, x: 1.0, y: 30.0 },
    GroupedMeanPoint { group_code: 2, x: 2.0, y: 50.0 },
]
```

Add a no-Overlay fixture asserting the existing segment order/count and Mean
values remain unchanged under code 0.

- [ ] **Step 2: Run grouped geometry tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml grouped_raw_and_mean -- --test-threads=1
```

Expected: compile or assertion FAIL because Raw and Mean are not group-aware.

- [ ] **Step 3: Build grouped Raw and Mean caches**

Move `GroupedLineSegment` and `GroupedMeanPoint` into
`graph_new_overlay.rs`. Change `TileStore.raw_line` and `TileStore.mean` to
cache these exact types.

Raw construction partitions each contiguous valid source run by group before
sorting `(x, row_id)` and emits only same-group pairs. Mean sorts
`(group_code, x)`, uses the existing cancellation-aware finite mean, and emits
one point per `(group_code, x)`. Keep availability tied to
`mean_available()`.

- [ ] **Step 4: Write failing renderer color and visibility tests**

Create a scene with two group colors and hide one group. Assert:

```rust
assert_eq!(scene.enabled_point_count(), 2);
let frame = render_scene(&scene).expect("frame");
assert!(frame_contains_rgba(&frame.rgba, [220, 38, 38, 255]));
assert!(!frame_contains_rgba(&frame.rgba, [37, 99, 235, 255]));
```

Add tests that:

- Point marks receive catalog color rather than `BLUE`.
- Raw/Mean segment endpoint colors match their group.
- No segment crosses a group boundary.
- Hiding all groups produces axes/grid with zero point/line geometry.
- No-Overlay pixels match the existing blue baseline fixture.
- Repeating one hidden mask hits GPU geometry reuse; changing only the mask may
  upload filtered buffers but does not change CPU/persistent cache counters.

- [ ] **Step 5: Run renderer tests to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new_renderer -- --test-threads=1
```

Expected: FAIL because `Mark.color` is still constant blue and grouped scene
inputs do not exist.

- [ ] **Step 6: Extend scene and GPU preparation**

Add to `GraphNewScene`:

```rust
pub(crate) overlay: OverlayCatalog,
pub(crate) enabled_groups: EnabledOverlayMask,
pub(crate) mean: Option<Arc<Vec<GroupedMeanPoint>>>,
```

Change `ScenePresentation.raw_line` to grouped segments. Filter disabled group
codes while preparing GPU instances. Resolve Point/Raw/Mean color from the
catalog. Include the enabled mask in renderer content hashes and retained
source identity. Keep the no-Overlay code-0 path on the current `BLUE`, red
Mean, and blue Raw colors.

- [ ] **Step 7: Resolve hidden IDs after cache lookup**

In `GraphNewService::render_with`, call:

```rust
let enabled_groups = EnabledOverlayMask::from_hidden(
    &built.pyramid.overlay,
    &request.hidden_overlay_group_ids,
)?;
```

Filter completion `selected_marks` and exact `visible_rows` to enabled groups,
while leaving `finite_rows`, group counts, and camera domain all-group. Return
the sorted group metadata and hidden count. A hidden-only render must follow
the CPU cache path and report zero projection queries.

- [ ] **Step 8: Add service zero-query toggle tests**

Render cold, then camera, then hide, then show using one runtime/cache. Assert:

```rust
assert_eq!(cold.source_projection_query_count, 1);
assert_eq!(camera.source_projection_query_count, 0);
assert_eq!(hidden.source_projection_query_count, 0);
assert_eq!(shown.source_projection_query_count, 0);
assert_eq!(cold.camera_domain, hidden.camera_domain);
assert_eq!(cold.persistent_cache_bytes, hidden.persistent_cache_bytes);
assert!(hidden.selected_marks < shown.selected_marks);
```

- [ ] **Step 9: Run Task 4 GREEN checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml grouped_raw_and_mean -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_renderer -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml overlay_visibility_reuses_cache -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new_service -- --test-threads=1
```

Expected: all selected tests pass with zero cross-group segments and zero warm
projection queries.

- [ ] **Step 10: Commit Task 4**

```bash
git add src-tauri/src/services/graph_new_overlay.rs \
  src-tauri/src/services/graph_new_lod.rs \
  src-tauri/src/services/graph_new_service.rs \
  src-tauri/src/services/graph_new_renderer.rs \
  src-tauri/src/services/graph_new_cache.rs
git commit -m "feat(graph): render native overlay groups" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Overlay Field and Accessible Legend Visibility Loop

**Files:**
- Create: `src/components/graphBuilderNew/GraphNewOverlayLegend.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `src/components/graphBuilderNew/GraphNewCanvas.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `src/services/graphNewService.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `tests/GraphBuilderNewHarness.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`
- Modify: `tests/workspaceGraphBuilderNew.test.ts`

**Interfaces:**
- Consumes: Task 1 store actions and Task 4 validated completion groups.
- Produces: `GraphNewOverlayLegend`, Overlay selector, persisted hidden IDs, localized unavailable/error states, and latest-wins zero-query visibility renders.

- [ ] **Step 1: Write failing Overlay field component tests**

Extend `GraphBuilderNewHarness` with descriptors `lot-column` and
`removed-overlay`. Add CT assertions:

```ts
await component.getByLabel("Overlay field").selectOption("lot-column");
await expect(component.getByTestId("render-request"))
  .toContainText('"overlayColumnId":"lot-column"');
expect(
  JSON.parse((await component.getByTestId("documents").textContent())!)[0],
).toMatchObject({
  version: 2,
  overlayColumnId: "lot-column",
  hiddenOverlayGroupIds: [],
});
```

Add missing-field and read-only cases matching current X/Y behavior. Assert
Overlay changes preserve the saved camera.

- [ ] **Step 2: Run Overlay field CT to verify RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts \
  tests/graphBuilderNew.spec.tsx \
  -g "Overlay field" \
  --output=.cache/issue235-overlay/task5-field/ct
```

Expected: FAIL because the selector does not exist.

- [ ] **Step 3: Add Overlay selection to the view**

In `GraphBuilderNewView`, derive `overlayColumnIds` from all descriptors, retain
missing selections as disabled options, and render:

```tsx
<label>
  <span>{t("graphNew.overlayField")}</span>
  <select
    aria-label={t("graphNew.overlayField")}
    value={session.overlayColumnId ?? ""}
    disabled={readOnly || loading || stale || missingDataset || Boolean(error)}
    onChange={(event) => setOverlay(session.id, event.target.value || null)}
  >
    <option value="">{t("graphNew.noOverlay")}</option>
    {columns.map((column) => (
      <option key={column.columnId} value={column.columnId}>{column.name}</option>
    ))}
  </select>
</label>
```

Pass Overlay and hidden IDs to `GraphNewCanvas`. Include Overlay in the render
identity/key but do not include hidden IDs in camera identity.

- [ ] **Step 4: Write failing Legend behavior tests**

Make the harness completion return three sorted groups: A, B, and Missing, with
exact counts and colors. Add CT assertions:

```ts
const legend = component.getByRole("group", { name: "Overlay legend" });
await expect(legend.getByText("A")).toBeVisible();
await expect(legend.getByText("2,000,000")).toBeVisible();
await expect(legend.getByText("(Missing)")).toBeVisible();

const cameraBefore = JSON.parse(
  (await component.getByTestId("documents").textContent())!,
)[0].camera;
await legend.getByRole("checkbox", { name: "Show A" }).uncheck();
await expect(component.getByTestId("render-request"))
  .toContainText(`"hiddenOverlayGroupIds":["${groupAId}"]`);
await expect(component.getByTestId("render-metrics"))
  .toContainText('"sourceProjectionQueries":0');
expect(
  JSON.parse((await component.getByTestId("documents").textContent())!)[0].camera,
).toEqual(cameraBefore);
```

Also assert keyboard toggle, swatch CSS color, Missing localization in English
and Chinese, 64-item bounded scrolling, project dirty change, persisted reopen,
and read-only disabled controls.

- [ ] **Step 5: Run Legend CT to verify RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts \
  tests/graphBuilderNew.spec.tsx \
  -g "Overlay legend" \
  --output=.cache/issue235-overlay/task5-legend/ct
```

Expected: FAIL because the Legend component and hidden-state request loop do not exist.

- [ ] **Step 6: Implement the focused Legend component**

Create:

```tsx
interface GraphNewOverlayLegendProps {
  groups: GraphNewOverlayGroup[];
  hiddenIds: readonly string[];
  readOnly: boolean;
  onHiddenIdsChange: (ids: string[]) => void;
}

export function GraphNewOverlayLegend({
  groups,
  hiddenIds,
  readOnly,
  onHiddenIdsChange,
}: GraphNewOverlayLegendProps) {
  const { t } = useTranslation();
  const hidden = new Set(hiddenIds);
  return (
    <fieldset className="graph-new-overlay-legend" aria-label={t("graphNew.overlayLegend")}>
      {groups.map((group) => {
        const checked = !hidden.has(group.id);
        const label = group.missing ? t("graphNew.missingGroup") : group.label;
        return (
          <label key={group.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={readOnly}
              aria-label={t("graphNew.showOverlayGroup", { group: label })}
              onChange={() => onHiddenIdsChange(
                checked
                  ? [...hidden, group.id].sort()
                  : [...hidden].filter((id) => id !== group.id).sort(),
              )}
            />
            <span
              className="graph-new-overlay-swatch"
              style={{
                backgroundColor: `rgba(${group.color[0]},${group.color[1]},${group.color[2]},${group.color[3] / 255})`,
              }}
            />
            <span>{label}</span>
            <output>{group.totalRows.toLocaleString()}</output>
          </label>
        );
      })}
    </fieldset>
  );
}
```

Keep this component presentation-only. It receives already validated groups and
never calls Tauri or computes colors.

- [ ] **Step 7: Wire completion state and hidden renders**

In `GraphNewCanvas`, store `overlayGroups` from the last coherent completion.
Include `overlayColumnId` and sorted `hiddenOverlayGroupIds` in every request.
Render the Legend only when `overlayActive` is true. Call the store callback on
toggle; let the existing latest-wins queue cancel superseded visibility frames
with preserved cache.

Do not add hidden IDs to `cameraState.identity`. Keep `full`, `desired`, and
`presented` camera values through a visibility render.

- [ ] **Step 8: Add styles and localization**

Add a 240px maximum-height scroll region, focus-visible outline, disabled and
hidden states, fixed swatch size, count alignment, and narrow-width containment.
Add these keys to both locale files:

```json
{
  "overlayField": "Overlay field",
  "noOverlay": "No overlay",
  "overlayLegend": "Overlay legend",
  "missingGroup": "(Missing)",
  "showOverlayGroup": "Show {{group}}",
  "overlayTooManyGroups": "Overlay supports at most 64 groups.",
  "overlayValueTooLarge": "An Overlay value is too large to display."
}
```

Use equivalent Chinese strings in `zh-CN.json`; keep interpolation keys identical.

- [ ] **Step 9: Run focused GREEN tests**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts
npx playwright test -c playwright-ct.config.ts \
  tests/graphBuilderNew.spec.tsx \
  --output=.cache/issue235-overlay/task5/ct
```

Expected: all store/service tests and the complete Graph Builder-new component
suite pass.

- [ ] **Step 10: Run frontend affected build checks**

Run:

```bash
npx tsc -b
npx vite build
```

Expected: both commands exit 0; existing Vite chunk warnings may remain but no
new TypeScript error is allowed.

- [ ] **Step 11: Commit Task 5**

```bash
git add src/components/graphBuilderNew/GraphNewOverlayLegend.tsx \
  src/components/graphBuilderNew/GraphBuilderNewView.tsx \
  src/components/graphBuilderNew/GraphNewCanvas.tsx \
  src/components/graphBuilderNew/GraphBuilderNewView.css \
  src/services/graphNewService.ts \
  src/i18n/locales/en.json \
  src/i18n/locales/zh-CN.json \
  tests/GraphBuilderNewHarness.tsx \
  tests/graphBuilderNew.spec.tsx \
  tests/workspaceGraphBuilderNew.test.ts
git commit -m "feat(graph): add native overlay legend" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: 2M Qualification, 10M Stretch Evidence, and Final Hardening

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`
- Modify: any Issue 235 file only when a failing qualification or review proves a defect in that file
- Test: all Graph Builder-new Rust, TS, and component suites

**Interfaces:**
- Consumes: Complete Overlay vertical slice from Tasks 1-5.
- Produces: machine-readable grouped benchmark report, required 2M evidence, bounded 10M stretch evidence, final verification record, and documented limitations.

- [ ] **Step 1: Write failing performance harness test**

Extend the Graph-new benchmark options with:

```rust
graph_new_overlay_groups: Option<u16>,
```

Add a test invoking 2,000 rows with 8 groups and asserting:

```rust
assert_eq!(run.overlay_groups, 9); // eight values plus missing
assert!(run.minority_group_rows > 0);
assert_eq!(run.camera_projection_query_count, 0);
assert_eq!(run.hide_projection_query_count, 0);
assert_eq!(run.show_projection_query_count, 0);
assert!(run.hidden_selected_marks < run.shown_selected_marks);
assert_eq!(run.cold_graph_key, run.hidden_graph_key);
assert_eq!(run.cold_camera, run.hidden_camera);
```

Seed one missing group and one minority group below 0.1% with deterministic
DuckDB expressions; do not allocate row JSON in Rust.

- [ ] **Step 2: Run the harness test to verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  perf_harness::tests::performance_cli_executes_grouped_graph_new_matrix \
  -- --exact --test-threads=1
```

Expected: compile FAIL because grouped benchmark fields and runs do not exist.

- [ ] **Step 3: Implement cold/warm/camera/hide/show benchmark runs**

Generate the Overlay column in the existing parameterized DuckDB `range`
fixture. Use production `GraphNewService` requests for:

```text
cold:   full domain, no hidden IDs
warm:   full domain, no hidden IDs
camera: bounded camera, no hidden IDs
hide:   same camera, minority group hidden
show:   same camera, no hidden IDs
```

Record source rows, finite rows, exact group counts, minority/missing counts,
GraphKey hash, source projection queries, selected marks, camera, build,
render, readback, cache bytes, GPU bytes, and process RSS. Preserve backend,
readback, and WebView presentation as separate layers.

- [ ] **Step 4: Run harness GREEN and serial Graph-new tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  perf_harness::tests::performance_cli_executes_grouped_graph_new_matrix \
  -- --exact --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_new -- --test-threads=1
```

Expected: grouped harness passes and the full serial Graph-new suite has zero failures.

- [ ] **Step 5: Build the frozen release benchmark source**

Run:

```bash
git status --short
git rev-parse HEAD
cargo build --release --manifest-path src-tauri/Cargo.toml \
  --example performance_baseline
```

Expected: only intended Task 6 files are modified before the build; release
example exits 0. Record the exact full SHA before measurements.

- [ ] **Step 6: Run the required 2M qualification once**

Run:

```bash
mkdir -p .cache/issue235-overlay/performance
src-tauri/target/release/examples/performance_baseline \
  --operation graph \
  --graph-new-rows 2000000 \
  --graph-new-overlay-groups 8 \
  > .cache/issue235-overlay/performance/overlay-2m.json
```

Expected report:

- 2,000,000 processed finite rows;
- nine groups including Missing;
- nonzero minority count;
- cold build succeeds within existing resource budgets;
- exact compact geometry is retained;
- camera/hide/show source projection query count is 0;
- hidden GraphKey and camera equal cold/current identities;
- no controlled refusal or unsafe error.

If any required assertion fails, stop measurement work, write a focused failing
test for the first defect, fix only that defect, rerun its focused/affected
checks, freeze a new SHA, and rerun the 2M qualification. Do not proceed to 10M
with a failed 2M gate.

- [ ] **Step 7: Run the bounded 10M stretch once**

Run:

```bash
src-tauri/target/release/examples/performance_baseline \
  --operation graph \
  --graph-new-rows 10000000 \
  --graph-new-overlay-groups 8 \
  > .cache/issue235-overlay/performance/overlay-10m.json
```

Expected: a complete machine-readable success or controlled-refusal report.
Do not rerun solely to improve a noncritical number. Do not label this single
sample P95.

- [ ] **Step 8: Document exact evidence and limitations**

Add an `Issue 235 Native Overlay Qualification (2026-09-19)` section to
`docs/performance.md` containing:

- source SHA and platform;
- 2M required and 10M stretch row/group shapes;
- cold/warm/camera/hide/show backend, render, and readback timings;
- projection query counts;
- selected marks and exact/approximate state;
- CPU/persistent/GPU bytes and whole-process RSS with layer definitions;
- explicit statement that WebView presentation is separate/unmeasured unless a
  live run was performed;
- explicit statement that single samples are not P95;
- exact controlled-refusal or bottleneck text if 10M does not complete.

- [ ] **Step 9: Run final frontend gates**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphNewTransport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts
npx playwright test -c playwright-ct.config.ts \
  tests/graphBuilderNew.spec.tsx \
  tests/workspaceGraphNew.spec.tsx \
  --output=.cache/issue235-overlay/final/ct
npx tsc -b
npx vite build
```

Expected: all commands exit 0 and Playwright output stays isolated.

- [ ] **Step 10: Run final backend gates**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml graph_new -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml graph_builder_new -- --test-threads=1
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

Expected: tests and build exit 0. Record existing Clippy warnings separately;
no new warning caused by Issue 235 is accepted.

- [ ] **Step 11: Perform native manual acceptance**

Launch the exact worktree:

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/235-graph-new-overlay \
  run tauri -- dev
```

Verify on a real project:

1. Select X, Y, and an 8-group Overlay.
2. Confirm labels, counts, stable colors, Missing, Point, Raw Line, and Mean.
3. Pan/zoom, hide a minority group, show it, and confirm camera does not jump.
4. Save, close, reopen, and confirm Overlay and hidden state persist.
5. Open a v1 Graph Builder-new project and confirm it loads without dirty state.
6. Confirm read-only mode disables Overlay and Legend edits.
7. Confirm 65 groups produces the localized bounded-cardinality error and
   preserves the last coherent frame.

Record platform, app commit, dataset shape, and result in `docs/performance.md`.

- [ ] **Step 12: Request independent code review**

Invoke the `requesting-code-review` skill against the complete branch diff.
Resolve every Critical/Important finding with a focused RED/GREEN cycle.
Document any accepted Minor residual risk in `docs/performance.md`.

- [ ] **Step 13: Re-run only invalidated final gates**

If review changes Rust, rerun Step 10 plus the affected frontend boundary test.
If review changes TypeScript/React, rerun Step 9. If production behavior or
performance source changes, freeze the new SHA and rerun Step 6; ask before
rerunning the user-bounded 10M stretch.

- [ ] **Step 14: Commit Task 6**

```bash
git add src-tauri/src/perf_harness.rs docs/performance.md
git commit -m "perf(graph): qualify native overlay at scale" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Before committing, inspect `git diff --cached --stat` and unstage any path not
owned by Issue 235. Do not add `.cache/issue235-overlay`; it is local evidence.

---

## Completion Checklist

- [ ] All six task commits exist on `issue/235-graph-new-overlay`.
- [ ] Worktree is clean and `dev` remains untouched.
- [ ] v1 native graph documents normalize to v2 without dirty feedback.
- [ ] v2 Overlay selection and hidden groups round trip through `.spprj`.
- [ ] Overlay key identity changes caches; hidden IDs do not.
- [ ] Tile/pyramid v2 rejects incompatible or corrupt group data.
- [ ] 64 groups work and the 65th fails explicitly.
- [ ] Missing and literal `(Missing)` remain different identities.
- [ ] Minority groups survive approximate tile admission.
- [ ] Point, Raw Line, and Mean stay inside group boundaries.
- [ ] Legend colors/counts/visibility/accessibility/read-only behavior pass.
- [ ] Camera and source cache survive hide/show.
- [ ] Camera and Legend toggles issue zero source projections.
- [ ] Required 2M qualification passes.
- [ ] Bounded 10M stretch result is preserved and honestly labeled.
- [ ] Full affected frontend/backend gates, independent review, and native
  manual acceptance complete.

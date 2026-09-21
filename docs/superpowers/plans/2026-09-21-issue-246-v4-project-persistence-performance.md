# Issue 246 v4 Project Persistence Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce release-profile save and open latency for a 2,000,000-row by 20-column v4 ZIP/JSON project while cutting open RSS below 1.5 GiB and preserving existing project compatibility and atomicity.

**Architecture:** Save uses a direct `(natural_order_key, row_id)` keyset cursor and byte-governed batches. Open uses a `ZipArchive<File>` metadata pass, header-only table plans, and bounded row batches written into the existing staged DuckDB restore flow; noncanonical table field order uses the existing buffered parser explicitly.

**Tech Stack:** Rust 2021, Tauri v2, DuckDB, serde/serde_json, zip, existing `perf-harness` release example.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-246-v4-project-persistence-performance-design.md`

## Global Constraints

- Current v4 remains ZIP/JSON; do not introduce Parquet or change Tauri IPC.
- Release targets are: 2M save median <= 8,000 ms, 2M open median <= 5,000 ms, and every 2M open RSS delta <= 1.5 GiB.
- Restore exactly 2,000,000 rows in every qualification sample.
- Preserve the save writer's 4 MiB target and 8 MiB hard retained-batch limit.
- Preserve sibling temporary-file validation, `sync_all`, and atomic replacement.
- Preserve staged open semantics: no live project state changes before every restore and migration step succeeds.
- Keep legacy single-file JSON and standalone `.sptb` behavior unchanged.
- Use release builds for performance evidence; debug builds are functional diagnostics only.
- Run one diagnostic performance sample during development; run the five-sample matrix only after source and review are frozen.
- Return `Result<T, AppError>` and do not add `unwrap()` or `expect()` outside tests.
- Use parameterized DuckDB values; generated identifiers continue through existing validated quoting helpers.
- Every implementation commit includes `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File Structure

- Modify `src-tauri/src/engine/duckdb_engine.rs`: direct archive cursor, batch cursor result, cursor and ordering regression tests.
- Modify `src-tauri/src/services/streaming_project_writer.rs`: consume the direct cursor, raise the row safety ceiling, retain byte limits and save failure behavior.
- Create `src-tauri/src/services/streaming_table_reader.rs`: header scan, canonical streamed row parser, bounded JSON row batching, and parser-only tests.
- Modify `src-tauri/src/services/mod.rs`: register the focused streaming table reader module.
- Modify `src-tauri/src/services/spprj_archive.rs`: file-backed open archive plan, small-document metadata pass, canonical/compatibility table source selection, and archive compatibility tests.
- Create `src-tauri/src/services/project_table_restore.rs`: shared table restore session used by buffered and streaming rows.
- Modify `src-tauri/src/services/project_service.rs`: use the archive plan and shared restore session while preserving migrations, recovery, progress, and final live-state swap.
- Modify `src-tauri/src/perf_harness.rs`: retain the Issue 246 save/open benchmark, add final qualification metadata only if required by the matrix.
- Modify `src-tauri/src/perf_table_mutation.rs`: keep `PerformanceReport` initialization exhaustive.
- Modify `docs/performance.md`: baseline corrections, diagnostic results, final five-sample evidence, and limitations.

---

### Task 1: Freeze and Commit the Investigation Baseline

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src-tauri/src/perf_table_mutation.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `docs/performance.md`

**Interfaces:**
- Consumes: Existing `performance_baseline` example and save performance observer.
- Produces: `Operation::Open`, `OpenPerfMetrics`, `OpenStageReport`, isolated open fixture generation, row-count validation, and documented debug/release baseline.

- [ ] **Step 1: Inspect the existing uncommitted investigation diff**

Run:

```bash
git status --short
git diff --check
git diff -- src-tauri/src/perf_harness.rs \
  src-tauri/src/perf_table_mutation.rs \
  src-tauri/src/services/project_service.rs \
  docs/performance.md
```

Expected: only Issue 246 instrumentation and documentation changes; no broad
formatting diff and no generated benchmark archives.

- [ ] **Step 2: Run the focused instrumentation tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests
cargo test --manifest-path src-tauri/Cargo.toml services::streaming_project_writer::tests
cargo test --manifest-path src-tauri/Cargo.toml perf_harness::tests::performance_cli
cargo test --manifest-path src-tauri/Cargo.toml \
  perf_harness::tests::project_open_benchmark_rejects_incomplete_restore
cargo test --manifest-path src-tauri/Cargo.toml \
  perf_harness::tests::open_fixture_guard_cleans_archive_on_drop
```

Expected: 50 project-service tests, 29 streaming-writer tests, 30 matching
performance CLI tests, and both focused regression tests pass.

- [ ] **Step 3: Build the release harness**

Run:

```bash
cargo build --release \
  --manifest-path src-tauri/Cargo.toml \
  --features perf-harness \
  --example performance_baseline
```

Expected: release build exits zero. Existing unrelated warnings may remain, but
this task must introduce no new warning.

- [ ] **Step 4: Commit only the investigation baseline**

```bash
git add src-tauri/src/perf_harness.rs \
  src-tauri/src/perf_table_mutation.rs \
  src-tauri/src/services/project_service.rs \
  docs/performance.md
git commit -m "test(performance): measure large project open"
```

Expected: the approved design commit remains separate, and the working tree is
clean before optimization work begins.

---

### Task 2: Add a Direct Natural-Order Archive Cursor

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: `NATURAL_ORDER_SQL`, `ArchiveKeysetReadPlan`, `ArchiveBatchRow`.
- Produces:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ArchiveCursor {
    pub natural_order_key: i128,
    pub row_id: i64,
}

pub(crate) struct ArchiveBatch {
    pub rows: Vec<ArchiveBatchRow>,
    pub retained_bytes_estimate: usize,
    pub next_cursor: Option<ArchiveCursor>,
}

pub(crate) fn read_archive_keyset_batch(
    &self,
    plan: &ArchiveKeysetReadPlan,
    after: Option<ArchiveCursor>,
    row_limit: usize,
    target_batch_bytes: usize,
    hard_batch_bytes: usize,
) -> Result<ArchiveBatch, AppError>;
```

- [ ] **Step 1: Write failing direct-cursor regression tests**

Add tests beside the existing archive batch tests:

```rust
#[test]
fn archive_keyset_cursor_survives_deleting_the_previous_batch_tail() {
    let db = DuckDbEngine::new_in_memory().unwrap();
    db.seed_benchmark_table("archive-cursor-delete", "Archive Cursor", 12, 3)
        .unwrap();
    let plan = db
        .prepare_archive_keyset_read("archive-cursor-delete")
        .unwrap();

    let first = db
        .read_archive_keyset_batch(&plan, None, 4, 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    let cursor = first.next_cursor.expect("first cursor");
    db.conn()
        .execute(
            "DELETE FROM dataset_archive_cursor_delete WHERE _row_id = ?",
            duckdb::params![cursor.row_id],
        )
        .unwrap();

    let second = db
        .read_archive_keyset_batch(
            &plan,
            Some(cursor),
            16,
            1024 * 1024,
            2 * 1024 * 1024,
        )
        .unwrap();

    assert_eq!(
        second.rows.iter().map(|row| row.row_id).collect::<Vec<_>>(),
        (5_i64..=12).collect::<Vec<_>>()
    );
}

#[test]
fn archive_keyset_cursor_preserves_hugeint_order_and_row_id_ties() {
    let db = DuckDbEngine::new_in_memory().unwrap();
    db.create_empty_table(
        "archive-cursor-order",
        "Archive Cursor Order",
        &["value".to_string()],
        &["BIGINT".to_string()],
    )
    .unwrap();
    for (row_id, order_key) in [
        (1_i64, i128::MIN),
        (2_i64, 0_i128),
        (3_i64, 0_i128),
        (4_i64, i128::MAX),
    ] {
        db.conn()
            .execute(
                "INSERT INTO dataset_archive_cursor_order
                 (_row_id, value, _row_order) VALUES (?, ?, ?)",
                duckdb::params![row_id, row_id * 10, order_key],
            )
            .unwrap();
    }
    db.conn()
        .execute(
            "UPDATE _meta_datasets
             SET row_count = 4, next_row_id = 5
             WHERE id = 'archive-cursor-order'",
            [],
        )
        .unwrap();
    let plan = db
        .prepare_archive_keyset_read("archive-cursor-order")
        .unwrap();

    let mut cursor = None;
    let mut actual = Vec::new();
    loop {
        let batch = db
            .read_archive_keyset_batch(
                &plan,
                cursor,
                2,
                1024 * 1024,
                2 * 1024 * 1024,
            )
            .unwrap();
        if batch.rows.is_empty() {
            break;
        }
        actual.extend(batch.rows.iter().map(|row| row.row_id));
        cursor = batch.next_cursor;
    }

    assert_eq!(actual, vec![1, 2, 3, 4]);
}
```

The second test must insert explicit `_row_order` values using bound
`duckdb::params!`, query the expected IDs independently, and compare the full
sequence rather than checking only its length.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  archive_keyset_cursor_survives_deleting_the_previous_batch_tail
cargo test --manifest-path src-tauri/Cargo.toml \
  archive_keyset_cursor_preserves_hugeint_order_and_row_id_ties
```

Expected: compilation fails because `ArchiveCursor`, `next_cursor`, and the new
method signature do not exist.

- [ ] **Step 3: Change the prepared query to bind the cursor directly**

Update `prepare_archive_keyset_read` so the hidden order key is selected after
the row ID:

```rust
let select_sql = format!(
    "SELECT \"_row_id\", {NATURAL_ORDER_SQL} AS \"__archive_order_key\"{select_projection}
     FROM {table_name}
     WHERE ?
        OR {NATURAL_ORDER_SQL} > ?
        OR ({NATURAL_ORDER_SQL} = ? AND \"_row_id\" > ?)
     ORDER BY {NATURAL_ORDER_SQL}, \"_row_id\"
     LIMIT ?"
);
```

Bind `after.is_none()`, the cursor key twice, cursor row ID, and row limit.
Use zero only as the ignored value when the first boolean is true:

```rust
let cursor = after.unwrap_or(ArchiveCursor {
    natural_order_key: 0,
    row_id: 0,
});
let mut query_rows = stmt.query(duckdb::params![
    after.is_none(),
    cursor.natural_order_key,
    cursor.natural_order_key,
    cursor.row_id,
    row_limit as i64,
])?;
```

Read row ID from index 0, natural-order key from index 1, and user values from
index 2 onward. Update `next_cursor` only after a row is retained in the batch.

- [ ] **Step 4: Run direct-cursor and existing archive batch tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml archive_keyset
cargo test --manifest-path src-tauri/Cargo.toml archive_retained
```

Expected: new and existing archive batch tests pass; retained-byte estimates
remain at or below their asserted hard limits.

- [ ] **Step 5: Commit the engine cursor**

```bash
git add src-tauri/src/engine/duckdb_engine.rs
git commit -m "perf(project): use direct archive keyset cursor"
```

---

### Task 3: Use Byte-Governed Save Batches

**Files:**
- Modify: `src-tauri/src/services/streaming_project_writer.rs`

**Interfaces:**
- Consumes: `ArchiveCursor` and `ArchiveBatch::next_cursor` from Task 2.
- Produces: writer loop driven by `Option<ArchiveCursor>` and
  `MAX_ROWS_PER_BATCH: usize = 65_536`.

- [ ] **Step 1: Write a failing multi-batch writer regression**

Add a test that seeds at least 20,000 short rows, saves them, counts table rows
through `spprj_archive::count_project_rows_streaming`, and captures save
performance metrics:

```rust
#[test]
fn streaming_save_uses_byte_budget_across_large_row_batches() {
    let state = AppState::new().unwrap();
    let archive = temp_path("byte-budget");
    let dataset = seed_benchmark_dataset(&state, 20_000);
    let snapshot = save_snapshot(&archive, vec![dataset]);

    let observed = Arc::new(Mutex::new(SavePerfMetrics::default()));
    let captured = Arc::clone(&observed);
    let guard = state.save_coordinator.begin_save().unwrap();
    let writer = StreamingProjectWriter::new(&state, &guard);
    with_save_perf_observer(
        move |metrics| *captured.lock().unwrap() = metrics,
        || writer.write(&snapshot, &archive, None),
    )
    .unwrap();

    assert_eq!(
        spprj_archive::count_project_rows_streaming(archive.to_str().unwrap()).unwrap(),
        20_000
    );
    let metrics = *observed.lock().unwrap();
    assert!(metrics.max_retained_batch_bytes <= HARD_BATCH_BYTES);
    assert!(metrics.max_combined_batch_bytes <= HARD_BATCH_BYTES);
    std::fs::remove_file(archive).unwrap();
}
```

Import `SavePerfMetrics` and `with_save_perf_observer` into the existing test
module. Use the existing `temp_path`, `seed_benchmark_dataset`,
`save_snapshot`, and save-coordinator guard rather than introducing a second
archive fixture framework.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  streaming_save_uses_byte_budget_across_large_row_batches
```

Expected: fail to compile or fail an assertion while the writer still uses the
row-ID cursor and `ROW_LIMIT_PER_BATCH = 4096`.

- [ ] **Step 3: Update the writer loop**

Replace:

```rust
let mut next_row_id = 0i64;
```

with:

```rust
let mut cursor: Option<ArchiveCursor> = None;
```

Call:

```rust
let batch = db.read_archive_keyset_batch(
    &plan,
    cursor,
    MAX_ROWS_PER_BATCH,
    target_batch_bytes,
    HARD_BATCH_BYTES,
)?;
```

After successfully encoding every retained row:

```rust
cursor = batch.next_cursor;
```

Keep `target_batch_bytes`, encoded-buffer flushing, retained-byte release, and
test hooks unchanged. Replace `ROW_LIMIT_PER_BATCH` with:

```rust
const MAX_ROWS_PER_BATCH: usize = 65_536;
```

- [ ] **Step 4: Run save correctness and failure tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::streaming_project_writer::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_service::tests
```

Expected: all writer and project-service tests pass, including interleaved
mutation, validation failure, replacement failure, and temporary cleanup.

- [ ] **Step 5: Run one release save diagnostic**

Run:

```bash
cargo build --release \
  --manifest-path src-tauri/Cargo.toml \
  --features perf-harness \
  --example performance_baseline
src-tauri/target/release/examples/performance_baseline \
  --rows 2000000 --columns 20 --operation save
```

Expected: exact `resultRows = 2000000`, retained batch <= 8 MiB, and a recorded
diagnostic result. This is not the final five-sample qualification.

If save exceeds 8 seconds, record the new `queryFetch`, `batchEncode`, and
`zipWrite` values before changing another variable.

- [ ] **Step 6: Commit the writer integration**

```bash
git add src-tauri/src/services/streaming_project_writer.rs
git commit -m "perf(project): enlarge bounded save batches"
```

---

### Task 4: Build the Streaming Table Parser

**Files:**
- Create: `src-tauri/src/services/streaming_table_reader.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Interfaces:**
- Consumes: `spprj_archive::TableColumn`, `serde_json::Value`, `AppError`.
- Produces:

```rust
pub(crate) const STREAM_ROW_TARGET_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct StreamedTableHeader {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub version: String,
    pub columns: Vec<TableColumn>,
}

pub(crate) enum TableHeaderScan {
    Canonical(StreamedTableHeader),
    RequiresBufferedCompatibility,
}

pub(crate) trait TableBatchSink {
    fn begin_table(&mut self, header: &StreamedTableHeader) -> Result<(), AppError>;
    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError>;
    fn finish_table(&mut self, row_count: usize) -> Result<(), AppError>;
}

pub(crate) fn scan_table_header<R: Read>(
    reader: R,
) -> Result<TableHeaderScan, AppError>;

pub(crate) fn stream_table_rows<R: Read, S: TableBatchSink>(
    reader: R,
    expected: &StreamedTableHeader,
    sink: &mut S,
) -> Result<usize, AppError>;
```

- [ ] **Step 1: Write parser RED tests with a recording sink**

Create tests in the new module:

```rust
#[derive(Default)]
struct RecordingSink {
    started: usize,
    rows: Vec<Vec<Value>>,
    finished: Vec<usize>,
    max_batch_estimate: usize,
    max_row_estimate: usize,
}

impl TableBatchSink for RecordingSink {
    fn begin_table(&mut self, _header: &StreamedTableHeader) -> Result<(), AppError> {
        self.started += 1;
        Ok(())
    }

    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
        self.max_batch_estimate = self.max_batch_estimate.max(
            rows.iter()
                .flatten()
                .map(estimate_json_value_bytes)
                .sum::<usize>(),
        );
        self.max_row_estimate = self.max_row_estimate.max(
            rows.iter()
                .map(|row| row.iter().map(estimate_json_value_bytes).sum::<usize>())
                .max()
                .unwrap_or_default(),
        );
        self.rows.extend_from_slice(rows);
        Ok(())
    }

    fn finish_table(&mut self, row_count: usize) -> Result<(), AppError> {
        self.finished.push(row_count);
        Ok(())
    }
}

impl RecordingSink {
    fn row_ids(&self) -> Vec<i64> {
        self.rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect()
    }
}

fn canonical_table_json(rows: usize) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": "table-1",
        "name": "Data",
        "sourceType": "manual",
        "version": "3",
        "columns": [{"name": "x", "colType": "DOUBLE"}],
        "rows": (1..=rows)
            .map(|row_id| serde_json::json!([row_id, row_id as f64 / 2.0]))
            .collect::<Vec<_>>(),
    }))
    .unwrap()
}

#[test]
fn canonical_table_streams_header_and_bounded_row_batches() {
    let json = canonical_table_json(12_000);
    let header = match scan_table_header(json.as_bytes()).unwrap() {
        TableHeaderScan::Canonical(header) => header,
        TableHeaderScan::RequiresBufferedCompatibility => panic!("canonical table"),
    };
    let mut sink = RecordingSink::default();
    let rows = stream_table_rows(json.as_bytes(), &header, &mut sink).unwrap();

    assert_eq!(rows, 12_000);
    assert_eq!(sink.started, 1);
    assert_eq!(sink.finished, vec![12_000]);
    assert_eq!(sink.row_ids(), (1_i64..=12_000).collect::<Vec<_>>());
    assert!(sink.max_batch_estimate <= STREAM_ROW_TARGET_BYTES + sink.max_row_estimate);
}

#[test]
fn rows_before_columns_selects_buffered_compatibility() {
    let json = br#"{
      "id":"table-1","rows":[[1,2.0]],"name":"Data",
      "sourceType":"manual","version":"3","columns":[{"name":"x","colType":"DOUBLE"}]
    }"#;
    assert!(matches!(
        scan_table_header(&json[..]).unwrap(),
        TableHeaderScan::RequiresBufferedCompatibility
    ));
}

#[test]
fn streaming_table_rejects_trailing_json() {
    let canonical = canonical_table_json(10);
    let header = match scan_table_header(canonical.as_slice()).unwrap() {
        TableHeaderScan::Canonical(header) => header,
        TableHeaderScan::RequiresBufferedCompatibility => panic!("canonical table"),
    };
    let mut json = canonical;
    json.extend_from_slice(b"{}");
    let error = stream_table_rows(json.as_slice(), &header, &mut RecordingSink::default())
        .unwrap_err();
    assert!(matches!(error, AppError::FileIO(_)));
}
```

Also add exact tests for missing required header fields, duplicate fields,
malformed rows, sink failure propagation, and one row larger than the target
batch.

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::streaming_table_reader::tests
```

Expected: compilation fails because the module and interfaces do not exist.

- [ ] **Step 3: Implement header scanning**

Use a custom serde map visitor. Parse required fields until the `rows` key.
When `rows` arrives:

```rust
if id.is_none()
    || name.is_none()
    || source_type.is_none()
    || version.is_none()
    || columns.is_none()
{
    return Ok(TableHeaderScan::RequiresBufferedCompatibility);
}
```

For the canonical case, stop before deserializing the row array and return the
owned header. Detect duplicate named fields explicitly; do not let the last
value silently win.

- [ ] **Step 4: Implement bounded row streaming**

Parse the object again, verify every header field equals `expected`, and use a
custom row-array visitor. Accumulate `Vec<Vec<Value>>` until the estimated
retained JSON size reaches `STREAM_ROW_TARGET_BYTES`, then call
`sink.append_rows(&rows)` and clear the batch.

Use a recursive saturating estimator:

```rust
fn estimate_json_value_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(_) | Value::Number(_) => std::mem::size_of::<Value>(),
        Value::String(value) => std::mem::size_of::<Value>() + value.capacity(),
        Value::Array(values) => {
            std::mem::size_of::<Value>()
                + values.capacity() * std::mem::size_of::<Value>()
                + values.iter().map(estimate_json_value_bytes).sum::<usize>()
        }
        Value::Object(values) => {
            std::mem::size_of::<Value>()
                + values
                    .iter()
                    .map(|(key, value)| key.capacity() + estimate_json_value_bytes(value))
                    .sum::<usize>()
        }
    }
}
```

A single row may exceed the target and must be delivered alone rather than
rejected, preserving v4 compatibility. Preserve the original `AppError` from a
sink failure instead of replacing it with a generic serde error.

- [ ] **Step 5: Run parser tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::streaming_table_reader::tests
```

Expected: all parser tests pass with exact row order and propagated sink errors.

- [ ] **Step 6: Commit the parser**

```bash
git add src-tauri/src/services/streaming_table_reader.rs \
  src-tauri/src/services/mod.rs
git commit -m "feat(project): add streaming table parser"
```

---

### Task 5: Add a File-Backed Open Archive Plan

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: `scan_table_header`, `TableHeaderScan`, existing `TableDoc` parser,
  manifest validators, and small-document readers.
- Produces:

```rust
pub(crate) enum ProjectTablePayload {
    Stream {
        entry: TableEntryRef,
        header: StreamedTableHeader,
    },
    Buffered {
        entry: TableEntryRef,
        doc: TableDoc,
    },
}

pub(crate) struct OpenProjectArchive {
    pub bundle: ProjectBundle,
    table_payloads: Vec<ProjectTablePayload>,
    zip: Option<zip::ZipArchive<std::fs::File>>,
}

impl OpenProjectArchive {
    pub(crate) fn open(path: &str) -> Result<Self, AppError>;
    pub(crate) fn restore_tables<S: ProjectArchiveTableSink>(
        &mut self,
        sink: &mut S,
    ) -> Result<(), AppError>;
}

pub(crate) trait ProjectArchiveTableSink {
    fn restore_streamed(
        &mut self,
        entry: &TableEntryRef,
        header: &StreamedTableHeader,
        reader: &mut dyn Read,
    ) -> Result<(), AppError>;

    fn restore_buffered(
        &mut self,
        entry: &TableEntryRef,
        doc: &TableDoc,
    ) -> Result<(), AppError>;
}
```

- [ ] **Step 1: Write archive-plan RED tests**

Add tests in `spprj_archive.rs`:

```rust
#[test]
fn open_archive_plan_streams_canonical_table_entries_from_file() {
    let path = write_v4_project_with_table(canonical_table_doc());
    let mut archive = OpenProjectArchive::open(path.to_str().unwrap()).unwrap();
    let mut sink = RecordingProjectTableSink::default();

    archive.restore_tables(&mut sink).unwrap();

    assert_eq!(sink.streamed_ids, vec!["table-1"]);
    assert!(sink.buffered_ids.is_empty());
    assert!(archive.bundle.tables[0].rows.is_empty());
}

#[test]
fn open_archive_plan_buffers_rows_before_header_fields() {
    let path = write_v4_project_with_raw_table(rows_first_table_json());
    let mut archive = OpenProjectArchive::open(path.to_str().unwrap()).unwrap();
    let mut sink = RecordingProjectTableSink::default();

    archive.restore_tables(&mut sink).unwrap();

    assert_eq!(sink.buffered_ids, vec!["table-1"]);
    assert!(sink.streamed_ids.is_empty());
}

#[test]
fn existing_read_project_file_still_materializes_table_rows() {
    let path = write_v4_project_with_table(canonical_table_doc());
    let bundle = read_project_file(path.to_str().unwrap()).unwrap();
    assert_eq!(bundle.tables[0].rows.len(), 2);
}
```

The recording streaming method must call `stream_table_rows` so this test
exercises a real ZIP file reader rather than only recording invocation.

Define the test fixtures in the same module with these exact contracts:

```rust
fn canonical_table_doc() -> TableDoc {
    TableDoc {
        id: "table-1".into(),
        name: "Data".into(),
        source_type: "manual".into(),
        version: "3".into(),
        columns: vec![TableColumn {
            column_id: Some(uuid::Uuid::new_v4().to_string()),
            name: "x".into(),
            col_type: "DOUBLE".into(),
            width: None,
            format: None,
            extras: None,
            calculated: None,
        }],
        rows: vec![
            vec![serde_json::json!(1), serde_json::json!(1.5)],
            vec![serde_json::json!(2), serde_json::json!(2.5)],
        ],
    }
}

fn write_v4_project_with_table(doc: TableDoc) -> tempfile::TempPath;
fn write_v4_project_with_raw_table(raw_table: Vec<u8>) -> tempfile::TempPath;
fn rows_first_table_json() -> Vec<u8>;
```

`write_v4_project_with_table` must call the existing test `build_bundle` and
`write_project_archive` helpers. `write_v4_project_with_raw_table` first writes
that canonical archive, then rewrites only the indexed `.sptb` entry while
copying every other ZIP entry byte-for-byte. `rows_first_table_json` serializes
the same `canonical_table_doc` values with the `rows` key before `columns`; it
must not alter IDs, names, types, or values.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml open_archive_plan
cargo test --manifest-path src-tauri/Cargo.toml \
  existing_read_project_file_still_materializes_table_rows
```

Expected: compilation fails because `OpenProjectArchive` does not exist.

- [ ] **Step 3: Implement ZIP signature detection without whole-file read**

Open `std::fs::File`, read the first four bytes, and seek back to offset zero.
For ZIP input, construct `ZipArchive<File>`. For legacy JSON, keep the existing
full JSON parser and convert its table docs into `ProjectTablePayload::Buffered`.

Do not expose the project path or raw `File` outside the service layer.

- [ ] **Step 4: Split ZIP metadata parsing from table payload restoration**

Refactor the existing ZIP parser so manifest and small documents are parsed
once. For each manifest table:

1. Open the entry.
2. Run `scan_table_header`.
3. For `Canonical`, validate manifest/body ID and v4 name, push an empty-row
   `TableDoc` header into `bundle.tables`, and store `ProjectTablePayload::Stream`.
4. For `RequiresBufferedCompatibility`, reopen the entry, parse and validate
   the complete `TableDoc`, push an empty-row header into `bundle.tables`, and
   store the full doc in `ProjectTablePayload::Buffered`.

Keep `read_project_file` as the public fully materializing API by using an
internal collecting sink. Standalone table import therefore remains unchanged.

- [ ] **Step 5: Restore table payloads by stable ID after migrations**

`restore_tables` must resolve the possibly renamed header from
`archive.bundle.tables` by stable ID before invoking the sink. This preserves
`normalize_visible_document_names` behavior: migrations run against header
metadata before a staged DuckDB table is created.

The streamed variant reopens the ZIP entry and passes its `ZipFile` as
`&mut dyn Read`. The buffered variant passes the retained `TableDoc`.

- [ ] **Step 6: Run archive compatibility tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::spprj_archive::tests
```

Expected: all existing archive tests and the new plan tests pass, including v4
identity/name rejection and legacy JSON reads.

- [ ] **Step 7: Commit the archive plan**

```bash
git add src-tauri/src/services/spprj_archive.rs
git commit -m "feat(project): plan file-backed archive restore"
```

---

### Task 6: Share Buffered and Streaming DuckDB Restore

**Files:**
- Create: `src-tauri/src/services/project_table_restore.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/project_service.rs`

**Interfaces:**
- Consumes: `StreamedTableHeader`, `TableBatchSink`, existing archive-cell
  conversion, calculated-column validation, display metadata, and DuckDB
  appender.
- Produces:

```rust
pub(crate) struct ProjectTableRestoreSession<'a> {
    // owns header, row-ID set, progress state, and an active DB transaction
}

impl<'a> ProjectTableRestoreSession<'a> {
    pub(crate) fn begin(
        state: &'a AppState,
        header: StreamedTableHeader,
        rows_total: Option<usize>,
        progress: Option<&'a dyn Fn(usize, usize)>,
    ) -> Result<Self, AppError>;

    pub(crate) fn append_rows(
        &mut self,
        rows: &[Vec<Value>],
    ) -> Result<(), AppError>;

    pub(crate) fn finish(self) -> Result<String, AppError>;
    pub(crate) fn abort(self, error: AppError) -> AppError;
}
```

- [ ] **Step 1: Write shared-session RED tests**

Create tests in `project_table_restore.rs`:

```rust
#[test]
fn restore_session_matches_buffered_restore_values_and_metadata() {
    let doc = mixed_archive_table_doc();
    let expected = restore_with_existing_buffered_path(&doc);
    let actual = restore_in_two_batches(&doc);
    assert_eq!(actual.rows, expected.rows);
    assert_eq!(actual.columns, expected.columns);
    assert_eq!(actual.display, expected.display);
    assert_eq!(actual.calculated, expected.calculated);
}

#[test]
fn restore_session_rolls_back_duplicate_row_id() {
    let state = AppState::new().unwrap();
    let mut session = ProjectTableRestoreSession::begin(
        &state,
        basic_streamed_header(),
        None,
        None,
    )
    .unwrap();
    let error = session
        .append_rows(&[json_row(1, 10), json_row(1, 20)])
        .unwrap_err();
    let _ = session.abort(error);

    assert!(state.db.lock().unwrap().get_dataset_meta("table-1").is_err());
}

#[test]
fn restore_session_reports_indeterminate_progress_in_bounded_steps() {
    // Append 12,000 rows in three batches.
    // Assert progress is [(5000, 0), (10000, 0), (12000, 0)].
}
```

Use the repository's existing table-doc fixtures and query helpers. Do not
build a second JSON-to-DuckDB conversion implementation in tests.

Define the local test helpers with these contracts:

```rust
struct RestoredTableObservation {
    rows: Vec<Vec<duckdb::types::Value>>,
    columns: Vec<(String, String)>,
    display: Vec<ColumnDisplayProps>,
    calculated: Vec<ArchivedCalculatedColumn>,
}

fn mixed_archive_table_doc() -> TableDoc;
fn restore_with_existing_buffered_path(doc: &TableDoc) -> RestoredTableObservation;
fn restore_in_two_batches(doc: &TableDoc) -> RestoredTableObservation;
fn basic_streamed_header() -> StreamedTableHeader;
fn json_row(row_id: i64, value: i64) -> Vec<serde_json::Value>;
```

`mixed_archive_table_doc` must include null, tagged non-scalar archive values,
display metadata, and one ready calculated-column descriptor using existing
project-service test constructors. Both observation helpers query the restored
DuckDB table and metadata tables using the same projection and ordering; their
only difference is buffered versus two-batch input.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_table_restore::tests
```

Expected: compilation fails because the module and session do not exist.

- [ ] **Step 3: Extract restore preparation and finalization**

Move the reusable logic from `restore_table_doc_with_progress` into the new
session:

- Version and v3 calculated-column structure validation.
- Internal-name remapping and canonical column lookup.
- `BEGIN TRANSACTION` and empty table creation.
- Row width, positive integer row ID, and unique row ID validation.
- `json_to_duckdb_param` conversion and appender writes.
- Row count metadata, calculated-column validation, archive column IDs, and
  display properties.
- `COMMIT` on `finish`; explicit `ROLLBACK` on `abort`.

Open one DuckDB appender per bounded batch, append every converted row, flush,
and release it before returning. Do not store an appender that borrows a mutex
guard inside the session.

- [ ] **Step 4: Make the session implement `TableBatchSink`**

Implement:

```rust
impl TableBatchSink for ProjectTableRestoreSession<'_> {
    fn begin_table(&mut self, header: &StreamedTableHeader) -> Result<(), AppError> {
        if self.header.id != header.id {
            return Err(AppError::FileIO("streamed table header changed".into()));
        }
        Ok(())
    }

    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
        ProjectTableRestoreSession::append_rows(self, rows)
    }

    fn finish_table(&mut self, row_count: usize) -> Result<(), AppError> {
        if row_count != self.rows_written {
            return Err(AppError::FileIO(format!(
                "streamed row count mismatch: parsed {row_count}, restored {}",
                self.rows_written
            )));
        }
        Ok(())
    }
}
```

Avoid method recursion by using fully qualified calls where trait and inherent
method names overlap.

- [ ] **Step 5: Route the existing buffered method through the session**

Convert `TableDoc` metadata into `StreamedTableHeader`, create a session with
`rows_total = Some(doc.rows.len())`, append rows in bounded slices, and finish.

The public methods remain:

```rust
pub fn restore_table_doc(&self, doc: &TableDoc) -> Result<String, AppError>;
pub fn restore_table_doc_with_progress(
    &self,
    doc: &TableDoc,
    progress_cb: Option<&dyn Fn(usize, usize)>,
) -> Result<String, AppError>;
```

- [ ] **Step 6: Run restore and project-service tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_table_restore::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_service::tests
```

Expected: new session tests and all existing project-service restore,
calculated-column, migration, and rollback tests pass.

- [ ] **Step 7: Commit the shared restore session**

```bash
git add src-tauri/src/services/project_table_restore.rs \
  src-tauri/src/services/project_service.rs \
  src-tauri/src/services/mod.rs
git commit -m "refactor(project): share bounded table restore"
```

---

### Task 7: Integrate Streaming Restore into Project Open

**Files:**
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/project_table_restore.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: `OpenProjectArchive`, `ProjectArchiveTableSink`,
  `ProjectTableRestoreSession`, and existing staged `AppState`.
- Produces: project open path that streams canonical ZIP tables and buffers
  only legacy JSON or explicitly noncanonical table objects.

- [ ] **Step 1: Write end-to-end RED tests**

Add focused project-service tests:

```rust
#[test]
fn open_project_streams_canonical_v4_tables() {
    let path = save_project_fixture(12_000, 6);
    reset_streaming_table_reader_counters();
    let state = AppState::new().unwrap();

    ProjectService::new(&state)
        .open_project(path.to_str().unwrap(), None)
        .unwrap();

    assert_eq!(dataset_row_count(&state, "fixture-table"), 12_000);
    assert_eq!(streamed_table_count(), 1);
    assert_eq!(buffered_compatibility_table_count(), 0);
}

#[test]
fn open_project_uses_buffered_compatibility_for_rows_first_table() {
    let path = rows_first_v4_project();
    reset_streaming_table_reader_counters();
    let state = AppState::new().unwrap();

    ProjectService::new(&state)
        .open_project(path.to_str().unwrap(), None)
        .unwrap();

    assert_eq!(dataset_row_count(&state, "table-1"), 2);
    assert_eq!(streamed_table_count(), 0);
    assert_eq!(buffered_compatibility_table_count(), 1);
}

#[test]
fn streamed_open_failure_preserves_live_project() {
    let state = seeded_live_project();
    let rejected = v4_project_with_duplicate_row_id_after_first_batch();

    let error = ProjectService::new(&state)
        .open_project(rejected.to_str().unwrap(), None)
        .unwrap_err();

    assert!(matches!(error, AppError::InvalidParam(_)));
    assert_live_project_unchanged(&state);
}
```

Counters must be `#[cfg(test)]` only and thread-local, matching existing test
instrumentation patterns.

Define these project-service test fixtures in the same test module:

```rust
fn save_project_fixture(rows: usize, columns: usize) -> tempfile::TempPath;
fn rows_first_v4_project() -> tempfile::TempPath;
fn seeded_live_project() -> AppState;
fn v4_project_with_duplicate_row_id_after_first_batch() -> tempfile::TempPath;
fn dataset_row_count(state: &AppState, dataset_id: &str) -> i64;
fn assert_live_project_unchanged(state: &AppState);
```

`save_project_fixture` must use `seed_benchmark_table` and the production
streaming writer. `rows_first_v4_project` must reuse the ZIP-entry rewrite
helper already present in the project-service tests. The duplicate fixture
must place the second copy of a positive row ID after at least 5,000 valid rows
so failure occurs after one bounded append. `seeded_live_project` and
`assert_live_project_unchanged` must record and compare project identity,
dataset IDs, row counts, and the first/last row values rather than checking only
that some project remains open.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  open_project_streams_canonical_v4_tables
cargo test --manifest-path src-tauri/Cargo.toml \
  open_project_uses_buffered_compatibility_for_rows_first_table
cargo test --manifest-path src-tauri/Cargo.toml \
  streamed_open_failure_preserves_live_project
```

Expected: streaming counter assertions fail because `open_project` still calls
the fully materializing `read_project_file`.

- [ ] **Step 3: Open metadata before restoring tables**

Replace:

```rust
let mut bundle = spprj_archive::read_project_file(file_path)?;
```

with:

```rust
let mut archive = spprj_archive::OpenProjectArchive::open(file_path)?;
{
    let bundle = &mut archive.bundle;
    // Run format checks and metadata migrations in this scope.
}
archive.restore_tables(&mut staged_table_sink)?;
```

Run format checks, graph-filter migration, lineage refresh, visible-name
normalization, and dataset-name migration against the header-only bundle before
calling `archive.restore_tables`. End the mutable `bundle` borrow before
calling `restore_tables`, then read final metadata from `archive.bundle`.

- [ ] **Step 4: Implement the staged archive table sink**

Add a private adapter in `project_service.rs`:

```rust
struct StagedProjectTableSink<'a> {
    state: &'a AppState,
    progress: Option<&'a dyn Fn(usize, usize, &str, usize, usize)>,
    table_index: usize,
    table_total: usize,
}
```

For `restore_streamed`:

1. Accept the migrated header resolved by `OpenProjectArchive::restore_tables`.
2. Start `ProjectTableRestoreSession` with `rows_total = None`.
3. Call `stream_table_rows(reader, header, &mut session)`.
4. Abort explicitly on parser or sink error.
5. Finish and verify the returned dataset ID.

For `restore_buffered`, replace the buffered doc's metadata with the migrated
header fields while retaining its rows, then call the existing buffered restore
method.

Emit table progress with `rowsTotal = 0` for streamed rows and the exact total
for the compatibility path.

- [ ] **Step 5: Preserve recovery and finalization ordering**

After archive tables are restored into `staged_state`, retain the existing
ordering for:

- Recovered workflow tables.
- Dataset generation restoration.
- Calculated metadata validation.
- Graph/document migration results.
- History reconciliation.
- Display metadata.
- The final simultaneous live DB/display/project swap.

Compute `OpenPerfMetrics.table_restore_ms` around streamed and recovered table
restoration. Compute `archive_read_parse_ms` around metadata/archive planning,
not around row restoration.

- [ ] **Step 6: Run project open and archive suites**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_service::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::spprj_archive::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  perf_harness::tests::performance_cli_measures_complete_project_open
```

Expected: canonical v4 uses streaming, rows-first v4 uses buffered
compatibility, all rejection tests preserve live state, and the benchmark
restores its exact expected row count.

- [ ] **Step 7: Run one release open diagnostic**

Run:

```bash
cargo build --release \
  --manifest-path src-tauri/Cargo.toml \
  --features perf-harness \
  --example performance_baseline
src-tauri/target/release/examples/performance_baseline \
  --rows 2000000 --columns 20 --operation open
```

Expected: exact `resultRows = 2000000`, open stage timings are present, and RSS
is measured from a clean parent process. This is diagnostic, not final evidence.

If RSS exceeds 1.5 GiB, capture retained row-ID and batch estimates before
changing validation. If time exceeds 5 seconds while RSS passes, profile row
conversion/appender work before changing archive format.

- [ ] **Step 8: Commit streaming project open**

```bash
git add src-tauri/src/services/project_service.rs \
  src-tauri/src/services/project_table_restore.rs \
  src-tauri/src/services/spprj_archive.rs
git commit -m "perf(project): stream v4 table restore"
```

---

### Task 8: Close Compatibility, Review, and Qualification Gates

**Files:**
- Modify: `src-tauri/src/services/streaming_table_reader.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`

**Interfaces:**
- Consumes: completed save cursor and streaming open implementation.
- Produces: frozen reviewed source and final five-sample qualification evidence.

- [ ] **Step 1: Add the long-string bounded-memory fixture**

Extend `seed_benchmark_table` or add a dedicated perf-harness-only seeder:

```rust
pub(crate) fn seed_project_persistence_stress_table(
    &self,
    id: &str,
    rows: usize,
    string_bytes: usize,
) -> Result<(), AppError>;
```

Generate bound SQL values with:

- Unique high-cardinality strings.
- Repeated strings.
- Nulls.
- BIGINT and DOUBLE columns.

Use a smaller default tier such as 300,000 rows and 256-byte strings. The test
asserts exact restoration and bounded batches; it does not reuse the synthetic
2M latency threshold.

- [ ] **Step 2: Run the affected correctness suites**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  services::streaming_project_writer::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::streaming_table_reader::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::spprj_archive::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_table_restore::tests
cargo test --manifest-path src-tauri/Cargo.toml \
  services::project_service::tests
cargo test --manifest-path src-tauri/Cargo.toml perf_harness::tests
```

Expected: all suites pass with zero failures. Record exact counts in the final
Issue 246 update.

- [ ] **Step 3: Run backend quality gates**

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: build and tests exit zero; clippy introduces no new warning attributable
to this branch. If unrelated baseline warnings prevent a zero-warning clippy
run, capture the exact baseline and verify no changed-file warning.

- [ ] **Step 4: Request independent code review**

Review the complete branch diff against the design, focusing on:

- Cursor no-gap/no-duplicate behavior under interleaving.
- Byte-cap accounting.
- JSON field-order compatibility.
- Staged rollback and live-state preservation.
- Sink error propagation.
- Progress callback bounds.
- Benchmark fixture isolation and timing semantics.

Fix every confirmed Important-or-higher issue with a focused regression, rerun
the affected suite, and repeat review until no significant issue remains.

- [ ] **Step 5: Freeze the source revision**

Run:

```bash
git status --short
git rev-parse HEAD
cargo build --release \
  --manifest-path src-tauri/Cargo.toml \
  --features perf-harness \
  --example performance_baseline
```

Expected: no uncommitted source changes. Record the exact SHA and release binary
path before collecting final samples.

- [ ] **Step 6: Run the final five-sample 2M save matrix**

Run the frozen binary five times sequentially:

```bash
src-tauri/target/release/examples/performance_baseline \
  --rows 2000000 --columns 20 --operation save
```

Store every JSON output outside Playwright/test-runner cleanup directories.
Calculate the median `operationMs`. Verify every sample has:

- `resultRows = 2000000`.
- `maxRetainedBatchBytes <= 8388608`.
- `maxCombinedBatchBytes <= 8388608`.

Expected: median `operationMs <= 8000`.

- [ ] **Step 7: Run the final five-sample 2M open matrix**

Run the frozen binary five times sequentially:

```bash
src-tauri/target/release/examples/performance_baseline \
  --rows 2000000 --columns 20 --operation open
```

Verify every sample has:

- `resultRows = 2000000`.
- `processMemory.deltaWorkingSetBytes <= 1610612736`.
- Present `openStageMs`.

Expected: median `operationMs <= 5000` and every RSS delta <= 1.5 GiB.

- [ ] **Step 8: Run 300k, 1M, and string-stress regression samples**

Run one sequential release sample for each standard size and operation:

```bash
for rows in 300000 1000000; do
  src-tauri/target/release/examples/performance_baseline \
    --rows "$rows" --columns 20 --operation save
  src-tauri/target/release/examples/performance_baseline \
    --rows "$rows" --columns 20 --operation open
done
```

Run the dedicated 300k string-stress save/open command added in Step 1.
Expected: exact row counts, bounded save batches, and no small-tier regression
relative to the frozen Issue 246 baseline.

- [ ] **Step 9: Update documentation and Issue 246**

In `docs/performance.md`, record:

- Frozen SHA, machine, profile, and exact commands.
- All five raw 2M save/open samples.
- Medians and RSS maxima.
- 300k/1M regression samples.
- String-stress fixture shape and results.
- Whether each target passed.
- Remaining bottleneck and the v5 decision recommendation.

Post the same evidence summary to Issue 246 and read it back to confirm it was
written to the correct issue.

- [ ] **Step 10: Commit final tests and evidence**

```bash
git add src-tauri/src/services/streaming_table_reader.rs \
  src-tauri/src/services/spprj_archive.rs \
  src-tauri/src/services/project_service.rs \
  src-tauri/src/perf_harness.rs \
  docs/performance.md
git commit -m "test(performance): qualify v4 project persistence"
```

- [ ] **Step 11: Stop for manual acceptance**

Do not push or create a PR until the user has reviewed:

- Functional release-build save/open behavior.
- Exact performance table.
- Compatibility and rollback results.
- The recommendation to stop at v4 or begin a separate v5 design.

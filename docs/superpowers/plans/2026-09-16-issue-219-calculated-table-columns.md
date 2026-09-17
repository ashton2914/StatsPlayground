# Issue 219 Calculated Table Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend-owned, materialized calculated Table columns with UUID-bound formulas, atomic dependency recalculation, exact archive/history identity, read-only result cells, and a text editor with autocomplete.

**Architecture:** DuckDB remains the live authority: `_meta_columns` owns column identity, `_meta_calculated_columns` owns versioned formula definitions, and physical table columns own materialized values. Rust parses formulas into a closed AST, validates types and dependencies, emits allowlisted DuckDB expressions, and coordinates source mutation, dependent recomputation, history capture, and one generation increment in a single transaction. TableDoc V3 serializes that live model, while TypeScript receives read-only calculated metadata and never evaluates formulas.

**Tech Stack:** Rust 2021, DuckDB 1.10505.0, serde/serde_json, uuid 1, sha2 0.10.9, sqlparser 0.62.0, Tauri v2, React 19, TypeScript 5.7, Zustand 5, i18next, Playwright Component Testing.

**Spec:** `docs/superpowers/specs/2026-09-16-issue-219-calculated-table-columns-design.md`

## Global Constraints

- Work only in `StatsPlayground.worktrees/219-calculated-table-columns` on `feat/219-calculated-table-columns`; target `dev` and never commit directly to `dev`.
- Follow strict TDD: write one focused failing test, observe the expected failure, add the smallest implementation, and rerun the same test before widening scope.
- Do not add Cargo or npm dependencies; `sqlparser`, `sha2`, and `uuid` are already available.
- Rust commands remain thin, return `Result<T, AppError>`, and are registered in `tauri::generate_handler!`; non-test code must not use `unwrap()` or `expect()`.
- User formula text must never be concatenated into SQL. Only typed AST enums, typed literals, and UUID-resolved identifiers may reach SQL generation.
- Formula metadata must not use `ColumnDisplayProps.extras` or the multi-column extras import/export grid.
- A source mutation, dependent materialization, history capture, and exactly one dataset-generation increment commit or roll back together.
- V1 supports only numeric/Boolean/null literals, column references, parentheses, unary `+`/`-`/`NOT`, arithmetic, comparisons, `AND`/`OR`, `ABS`, bounded `ROUND`, scalar row-wise `MIN`/`MAX`, `COALESCE`, and `IF`.
- Calculated outputs are backend-enforced read-only until Convert to Values removes the definition while preserving UUID, name, type, order, and values.
- Normal dependency deletion is blocked with direct and transitive paths. A formula is never rebound by display name.
- Original project reopen preserves exact IDs. Standalone import/copy creates fresh table, column, and formula IDs and rewrites internal references transactionally.
- Extend `src-tauri/src/services/spprj_archive.rs` without changing Analysis document behavior or weakening its existing validators.
- All shipped locale files (`en`, `zh-CN`, `zh-TW`, `vi`) receive the same calculated-column key set.
- Do not create implementation commits, push, create a PR, or merge before user manual acceptance. Tasks 1-8 end in reviewable working-tree checkpoints; after acceptance Task 9 creates the implementation commit and PR preparation begins.

---

### Task 1: Shared Formula Models And TableDoc V3 Contract

**Files:**
- Create: `src-tauri/src/models/calculated_column.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Test: inline `#[cfg(test)]` modules in `src-tauri/src/models/calculated_column.rs` and `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Consumes: Existing `ColumnDescriptor`, `TableDoc`, `TableColumn`, serde camelCase conventions, and TableDoc V1/V2 readers.
- Produces: `CalculatedExpressionV1`, `CalculatedColumnDefinitionV1`, `ArchivedCalculatedColumn`, `CalculatedColumnDescriptor`, diagnostic/warning models, canonical AST dependency/fingerprint/remap/graph helpers, and identity-bearing `TableColumn` V3 used by every later task.

- [ ] **Step 1: Write failing serde and compatibility tests**

Add tests that construct the exact V3 shape and prove legacy compatibility:

```rust
#[test]
fn table_doc_v3_round_trip_preserves_column_and_formula_ids() {
    let definition = calculated_fixture("formula-a", "column-c", "column-a");
    let doc = TableDoc {
        id: "dataset-a".into(),
        name: "Measurements".into(),
        source_type: "manual".into(),
        version: "3".into(),
        columns: vec![TableColumn {
            column_id: Some("column-c".into()),
            name: "Area".into(),
            col_type: "DOUBLE".into(),
            width: None,
            format: None,
            extras: None,
            calculated: Some(ArchivedCalculatedColumn::Ready { definition }),
        }],
        rows: vec![vec![json!(1), json!(12.5)]],
    };

    let decoded: TableDoc = serde_json::from_value(serde_json::to_value(&doc).unwrap()).unwrap();
    assert_eq!(decoded.version, "3");
    assert_eq!(decoded.columns[0].column_id.as_deref(), Some("column-c"));
    assert_eq!(decoded.columns[0].calculated, doc.columns[0].calculated);
}

#[test]
fn legacy_table_column_without_identity_remains_readable() {
    let doc: TableDoc = serde_json::from_value(json!({
        "id": "legacy", "name": "Legacy", "sourceType": "csv", "version": "2",
        "columns": [{ "name": "A", "colType": "DOUBLE" }],
        "rows": [[1, 2.0]]
    })).unwrap();
    assert_eq!(doc.columns[0].column_id, None);
    assert_eq!(doc.columns[0].calculated, None);
}
```

Add model-invariant tests that derive first-occurrence dependency IDs, produce the
same fingerprint after a display-only rename, rewrite every UUID through a total
old-to-new map, reject a missing map entry, and reject direct/indirect cycles.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_doc_v3 --lib
cargo test --manifest-path src-tauri/Cargo.toml legacy_table_column_without_identity --lib
```

Expected: compilation fails because the calculated models and `TableColumn.column_id` / `calculated` fields do not exist.

- [ ] **Step 3: Add the versioned Rust models**

Define exhaustively tagged enums; keep operators/functions typed so raw text cannot become SQL:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CalculatedExpressionV1 {
    ColumnRef { column_id: String },
    NumberLiteral { value: CalculatedNumber },
    BooleanLiteral { value: bool },
    NullLiteral,
    Unary { operator: UnaryOperator, operand: Box<Self> },
    Binary { operator: BinaryOperator, left: Box<Self>, right: Box<Self> },
    Comparison { operator: ComparisonOperator, left: Box<Self>, right: Box<Self> },
    Logical { operator: LogicalOperator, left: Box<Self>, right: Box<Self> },
    Function { function: CalculatedFunction, arguments: Vec<Self> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnDefinitionV1 {
    pub formula_id: String,
    pub schema_version: String,
    pub output_column_id: String,
    pub expression: CalculatedExpressionV1,
    pub dependency_column_ids: Vec<String>,
    pub inferred_output_type: CalculatedOutputType,
    pub fingerprint: String,
}
```

Represent integer and floating literals without accepting non-finite JSON values. Add `CalculatedColumnStatus`, `CalculatedColumnDiagnostic`, `CalculatedColumnWarningCount`, validation request/result, upsert request, and mutation result with `#[serde(rename_all = "camelCase")]`.

Add pure `expression_dependency_ids`, `definition_fingerprint`,
`remap_definition`, and `validate_definition_graph` functions beside the model.
Their inputs are typed ASTs, never display formula text. `remap_definition`
assigns the caller-provided output/formula IDs, rewrites every `ColumnRef`,
re-derives dependencies, and recomputes the fingerprint.

- [ ] **Step 4: Extend Table and archive projections**

Add optional calculated metadata to `ColumnDescriptor`. Add optional `column_id` and `calculated` fields to `TableColumn`; require both during V3 validation while leaving them optional only for V1/V2 deserialization. Keep `default_doc_version()` at `"1"` for genuinely unversioned legacy reads; explicit new writers will use `"3"`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_column --lib
cargo test --manifest-path src-tauri/Cargo.toml table_doc_v3 --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all focused tests pass and `cargo check` reports no model/serde errors.

- [ ] **Step 6: Record the Task 1 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: only Task 1 files are changed; leave them uncommitted for the required
post-AI-review manual acceptance gate.

### Task 2: Exact Column Identity In Engine History

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: Existing `_meta_columns.column_id`, `_history_change_sets`, `_history_change_set_columns`, `apply_change_set`, `drop_change_set`, add/delete/alter column change-set methods.
- Produces: `UserColumnDescriptor`, exact-ID metadata insertion, identity-bearing change-set rows, and undo/redo that never mints replacement UUIDs.

- [ ] **Step 1: Write a failing identity replay test**

```rust
#[test]
fn delete_column_change_set_restores_exact_column_id() {
    let engine = engine_with_numeric_table("identity-history", &["A", "B"]);
    let before = engine.get_user_column_descriptors("identity-history").unwrap();
    let b_id = before.iter().find(|column| column.name == "B").unwrap().column_id.clone();
    let generation = engine.get_dataset_generation("identity-history").unwrap();

    let change_set = engine
        .delete_columns_with_change_set("identity-history", &["B".into()], generation)
        .unwrap();
    engine.apply_change_set(&change_set, true).unwrap();

    let restored = engine.get_user_column_descriptors("identity-history").unwrap();
    assert_eq!(restored.iter().find(|column| column.name == "B").unwrap().column_id, b_id);
}
```

Add sibling tests for add-column undo/redo and alter-column type/name replay.

- [ ] **Step 2: Run the identity replay test and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml delete_column_change_set_restores_exact_column_id --lib
```

Expected: the restored column receives a different UUID because `apply_change_set` inserts `_meta_columns` without `column_id`.

- [ ] **Step 3: Add canonical descriptor and exact insertion helpers**

Introduce:

```rust
pub(crate) struct UserColumnDescriptor {
    pub column_id: String,
    pub col_index: i32,
    pub name: String,
    pub sql_type: String,
}

pub(crate) fn get_user_column_descriptors(
    &self,
    dataset_id: &str,
) -> Result<Vec<UserColumnDescriptor>, AppError>;

fn insert_meta_column_with_id(
    &self,
    dataset_id: &str,
    column: &UserColumnDescriptor,
) -> Result<(), AppError>;
```

Validate IDs with `Uuid::parse_str` at archive/import boundaries. Live generated IDs continue to use DuckDB's UUID default.

- [ ] **Step 4: Persist before/after identity in change sets**

Add nullable `before_column_id` and `after_column_id` columns to `_history_change_set_columns`, populate them in every schema change-set producer, and update `apply_change_set` to insert the recorded ID when recreating a column. Extend `drop_change_set` only as needed for new metadata rows; preserve existing value snapshot tables.

- [ ] **Step 5: Verify exact identity and generation behavior and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml column_change_set --lib
cargo test --manifest-path src-tauri/Cargo.toml apply_change_set --lib
cargo test --manifest-path src-tauri/Cargo.toml generation_once --lib
```

Expected: add/delete/alter replay preserves exact IDs, and each forward/undo/redo action increments generation once.

- [ ] **Step 6: Record the Task 2 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: Task 1-2 changes remain reviewable and uncommitted.

### Task 3: TableDoc V3 Save, Restore, Streaming, And Import Remap

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/archive_cell.rs`
- Test: inline tests in those files

**Interfaces:**
- Consumes: Task 1 archive/formula models plus canonical dependency/fingerprint/remap/graph helpers, and Task 2 exact identity helpers.
- Produces: strict V3 validation, exact reopen identity, V1/V2 read-old/write-new migration, equivalent ordinary/streaming V3 output, and transactional standalone import remapping.

- [ ] **Step 1: Write failing archive lifecycle tests**

Add four focused tests:

```rust
#[test]
fn compose_and_restore_v3_preserve_exact_column_ids() {
    let source = project_service_with_table("source");
    let expected = source.engine().get_user_column_descriptors("source").unwrap();
    let doc = source.compose_table_doc("source").unwrap();
    assert_eq!(doc.version, "3");

    let target = empty_project_service();
    target.restore_table_doc(&doc).unwrap();
    assert_eq!(target.engine().get_user_column_descriptors("source").unwrap(), expected);
}

#[test]
fn import_v3_reissues_column_and_formula_ids_and_rewrites_refs() { /* assert disjoint ID sets and equivalent AST topology */ }

#[test]
fn legacy_v2_restore_mints_ids_and_resaves_as_v3() { /* assert ordinary columns and V3 output */ }

#[test]
fn streaming_and_composed_table_docs_have_equal_v3_columns() { /* compare decoded columns */ }
```

The import fixture must contain two chained formulas so both output and dependency references are exercised.

- [ ] **Step 2: Run archive tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml compose_and_restore_v3 --lib
cargo test --manifest-path src-tauri/Cargo.toml import_v3_reissues --lib
cargo test --manifest-path src-tauri/Cargo.toml streaming_and_composed_table_docs --lib
```

Expected: V2 output omits IDs, restore mints IDs, import changes only dataset ID, and streaming uses `TABLE_DOC_VERSION = "2"`.

- [ ] **Step 3: Implement strict V3 structural archive validation**

Add `validate_table_doc_structure(doc: &TableDoc) -> Result<TableDocValidation, AppError>` and invoke it from standalone reads and project bundle validation. For V3 reject invalid/duplicate `columnId`s, mismatched calculated output IDs, AST/dependency-list disagreement, invalid fingerprints, and cycles among present supported definitions. Preserve unknown schema definitions as `ArchivedCalculatedColumn::Preserved` without interpreting or rebinding them. A structurally valid supported definition with a missing dependency is retained with a derived `broken` diagnostic and its materialized values; it is not rebound by name and does not reject the entire project. Full type checking and stored-value comparison require Task 5's evaluator and are deliberately deferred there.

- [ ] **Step 4: Compose and restore exact identities**

Change `compose_table_doc` to query `(column_id, col_name, col_type)` in visible order and attach the matching calculated definition projection. Change `restore_table_doc_with_progress` to accept `"3"`; create physical schema and rows, replace generated metadata IDs with V3 IDs in the same transaction, then install structurally validated definitions or preserved `broken`/`unsupported` metadata. Keep V1/V2 on generated ordinary IDs and never infer formulas from names, values, or extras.

- [ ] **Step 5: Make streaming save V3-equivalent**

Set `TABLE_DOC_VERSION` to `"3"`. Extend `ArchiveKeysetReadPlan.columns` from tuples to `ArchiveColumnPlan { column_id, name, sql_type, calculated }`; use the same projection helper as `compose_table_doc`. Keep physical row streaming unchanged.

- [ ] **Step 6: Implement fresh-namespace import**

Before `restore_table_doc`, map every source column ID to a new UUID, assign new formula IDs, recursively rewrite every `ColumnRef.column_id` and output ID, recompute dependency arrays and fingerprints, and validate the remapped document. Perform remap and restore as one failure-atomic operation; a missing map entry fails without creating a dataset.

- [ ] **Step 7: Run archive and existing save regression suites and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_doc --lib
cargo test --manifest-path src-tauri/Cargo.toml standalone_export_table --lib
cargo test --manifest-path src-tauri/Cargo.toml streaming_project_writer --lib
cargo test --manifest-path src-tauri/Cargo.toml project_service --lib
```

Expected: V1/V2 fixtures remain readable, all new saves are V3, original restore preserves IDs, and import remaps all identities.

- [ ] **Step 8: Record the Task 3 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: archive changes are cleanly scoped and all implementation remains
uncommitted.

### Task 4: Pure Formula Parser, Type Checker, Formatter, Graph, And SQL Compiler

**Files:**
- Create: `src-tauri/src/services/calculated_column_expression.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/services/calculated_column_expression.rs`

**Interfaces:**
- Consumes: Task 1 expression enums and a `FormulaColumn { column_id, name, sql_type }` catalog.
- Produces: `parse_and_validate_formula`, `format_formula`, candidate-graph/topological validation built on Task 1 helpers, and `CompiledCalculatedExpression { value_sql, fault_predicates }`.

- [ ] **Step 1: Write parser and semantics tests first**

Use table-driven tests with exact normalized ASTs and output types:

```rust
#[test]
fn parses_precedence_and_resolves_names_to_ids() {
    let validated = parse_and_validate_formula(
        "ROUND(Length * Width + 2, 1)",
        &numeric_columns(),
        None,
        &[],
    ).unwrap();
    assert_eq!(validated.definition.dependency_column_ids, vec!["length-id", "width-id"]);
    assert_eq!(validated.definition.inferred_output_type, CalculatedOutputType::Double);
    assert_eq!(validated.normalized_display_formula, "ROUND(Length * Width + 2, 1)");
}

#[test]
fn rejects_sql_that_is_not_in_the_formula_language() {
    for text in ["A; DROP TABLE x", "SELECT A", "SUM(A)", "A OVER ()", "random()"] {
        assert!(matches!(parse(text), Err(FormulaError::Syntax { .. } | FormulaError::Unsupported { .. })));
    }
}
```

Add separate tests for bracket escaping (`[Upper ]] Limit]`), unary/logical/comparison precedence, null logic, every function arity, `ROUND` integer-literal range `-15..15`, type promotion, `IF(NULL, a, b)`, first-occurrence dependency order, unknown/ambiguous names, self-reference, direct/indirect cycles, fingerprint stability across whitespace/rename, remap, maximum formula length/token count/depth, and scalar rather than aggregate `MIN`/`MAX`.

- [ ] **Step 2: Run formula tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_column_expression --lib
```

Expected: compilation fails because the expression service does not exist.

- [ ] **Step 3: Implement a bounded tokenizer and recursive-descent parser**

Use `sqlparser` tokenization only where it cannot expand the grammar; own the formula grammar and reject unconsumed tokens. Enforce constants such as:

```rust
const MAX_FORMULA_BYTES: usize = 16_384;
const MAX_FORMULA_TOKENS: usize = 2_048;
const MAX_EXPRESSION_DEPTH: usize = 64;
const ROUND_DIGITS_MIN: i64 = -15;
const ROUND_DIGITS_MAX: i64 = 15;
```

Resolve unquoted/simple and bracketed identifiers against current names during parse and store only UUIDs in AST nodes.

- [ ] **Step 4: Implement type inference, normalization, formatting, and hashing integration**

Infer only `BIGINT`, `DOUBLE`, and `BOOLEAN`; reject unsupported source types when referenced. Build the normalized definition, then call Task 1's `definition_fingerprint` over `(schemaVersion, normalized AST, dependency IDs, output type)`. Format ASTs using current names and bracket escaping without changing the stored definition or fingerprint.

- [ ] **Step 5: Implement graph validation and allowlisted SQL compilation**

Return stable dependency paths and topological order. Compile enums exhaustively. Resolve each `columnId` through a trusted catalog, quote the resolved physical identifier with `DuckDbEngine::quote_identifier`, and emit typed literal values rather than source substrings. Produce explicit fault predicates for divide-by-zero, non-finite `DOUBLE`, and `BIGINT` overflow; legitimate nulls must not increment faults.

- [ ] **Step 6: Run focused domain tests and property tests and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_column_expression --lib
cargo test --manifest-path src-tauri/Cargo.toml formula_fingerprint --lib
cargo test --manifest-path src-tauri/Cargo.toml formula_sql --lib
```

Expected: every V1 node and rejection path passes; generated SQL contains no raw submitted formula string.

- [ ] **Step 7: Record the Task 4 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: formula-domain changes remain uncommitted and ready for the next
dependent task.

### Task 5: Calculated Metadata, Validation, Materialization, And Formula Lifecycle

**Files:**
- Create: `src-tauri/src/services/calculated_column_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Test: inline tests in `src-tauri/src/services/calculated_column_service.rs` and `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: Tasks 1-4 contracts, exact identities, parser/compiler, and existing `DataService` engine ownership.
- Produces: `_meta_calculated_columns`, authoritative validation, `upsert_calculated_column`, `convert_calculated_column_to_values`, descriptor projection, dependency deletion protection, and set-based topological materialization.

- [ ] **Step 1: Write failing lifecycle and rollback tests**

```rust
#[test]
fn chained_columns_materialize_in_topological_order() {
    let service = calculated_service_with_rows(&[(1, 2.0, 3.0), (2, 4.0, 5.0)]);
    let area = service.upsert(new_formula("Area", "Length * Width")).unwrap();
    let doubled = service.upsert(new_formula("DoubleArea", "Area * 2")).unwrap();
    assert_eq!(service.values(&area.output.column_id), vec![6.0, 20.0]);
    assert_eq!(service.values(&doubled.output.column_id), vec![12.0, 40.0]);
}

#[test]
fn failed_materialization_rolls_back_schema_metadata_values_and_generation() {
    let before = service.snapshot_state();
    service.inject_materialization_failure_after_metadata();
    assert!(service.upsert(new_formula("Area", "Length * Width")).is_err());
    assert_eq!(service.snapshot_state(), before);
}
```

Add tests for side-effect-free validation, create at index, ordinary-to-calculated conversion, formula edit with type change, rename/reorder fingerprint stability, direct/indirect cycle rejection, warning counts, read-only output mutation rejection, blocked deletion paths, deleting an unreferenced calculated column, Convert to Values identity preservation, downstream validity, V3 restore type mismatch, stored-value mismatch, supported missing dependency as `broken`, and unknown schema as `unsupported`.

- [ ] **Step 2: Run service tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_column_service --lib
```

Expected: compilation fails because the service and metadata table do not exist.

- [ ] **Step 3: Add metadata schema and projections**

Create `_meta_calculated_columns` exactly once in `DuckDbEngine::new_in_memory` with output ID primary key, dataset ID, unique formula ID, schema version, expression JSON, dependency JSON, output type, and fingerprint. Add parameterized insert/update/delete/query helpers. Extend `get_column_descriptors` to join and format calculated metadata; derive `ready`, `broken`, or `unsupported` instead of trusting persisted status.

- [ ] **Step 4: Implement authoritative validation and materialization**

`CalculatedColumnService::validate` repeats generation, parse, type, graph, and downstream-impact checks without mutation. `upsert` repeats validation inside a transaction, creates/converts/edits the physical column, stores metadata, and performs one set-based `UPDATE` per affected output in topological order. Query fault predicates in the same transaction and return stable warning-code counts.

Extend V3 restore after physical rows and metadata are staged: type-check every
supported ready definition, evaluate it in topological order into temporary
expressions, and compare typed results with stored materialized values. Reject
type, fingerprint, or value mismatches with `formula_archive_inconsistent` and
roll back the complete restored dataset. Retain `broken` and `unsupported`
definitions plus stored values read-only without attempting evaluation.

- [ ] **Step 5: Implement deletion protection and Convert to Values**

Resolve deletion candidates to UUIDs, return direct/transitive dependency paths in `formula_dependency_in_use`, and perform no mutation on rejection. Convert to Values deletes only formula metadata; preserve the physical column and allow later ordinary edits/type changes subject to downstream compatibility.

- [ ] **Step 6: Verify formula lifecycle and rollback and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_column_service --lib
cargo test --manifest-path src-tauri/Cargo.toml calculated_materialization --lib
cargo test --manifest-path src-tauri/Cargo.toml calculated_delete --lib
cargo test --manifest-path src-tauri/Cargo.toml calculated_convert_to_values --lib
```

Expected: all lifecycle, warning, graph, and failure-atomic tests pass.

- [ ] **Step 7: Record the Task 5 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: service and engine changes remain uncommitted.

### Task 6: Unified Mutation Coordinator And Formula-Aware History

**Files:**
- Create: `src-tauri/src/services/table_mutation_coordinator.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/commands/history_commands.rs`
- Test: inline tests in coordinator and engine modules

**Interfaces:**
- Consumes: Task 5 metadata/materializer, mutation permit at command boundary, all current engine mutation methods, and backend change-set replay.
- Produces: one coordinator path for forward/undo/redo mutation, affected-closure recomputation, exact formula snapshots, and one generation increment.

- [ ] **Step 1: Write failing source-mutation integration tests**

Create one test per mutation family, using a base column plus a two-level calculated chain:

```rust
#[test]
fn batch_source_update_recomputes_chain_and_bumps_generation_once() {
    let fixture = mutation_fixture_with_chain();
    let before_generation = fixture.generation();
    fixture.update_cells(vec![cell(1, "Length", "10")]).unwrap();
    assert_eq!(fixture.values("Area"), vec![30.0]);
    assert_eq!(fixture.values("DoubleArea"), vec![60.0]);
    assert_eq!(fixture.generation(), before_generation + 1);
    assert_eq!(fixture.history_entries(), 1);
}
```

Cover single/batch edit, clear, paste that adds columns, row add/delete, source type change, calculated rename/reorder, dependency deletion rejection, Table Update, atomic dataset replacement used by refresh/Data Link, and undo/redo. Add a regression proving `paste_at_position_inner` does not cause nested generation increments.

- [ ] **Step 2: Run one representative test and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml batch_source_update_recomputes_chain_and_bumps_generation_once --lib
```

Expected: source values change but calculated outputs do not recompute.

- [ ] **Step 3: Introduce one transaction coordinator**

Define an internal result that carries changed UUIDs and optional change-set identity:

```rust
pub(crate) struct TableMutationEffects<T> {
    pub value: T,
    pub changed_column_ids: BTreeSet<String>,
    pub change_set_id: Option<String>,
}

pub(crate) fn execute_table_mutation<T>(
    engine: &DuckDbEngine,
    dataset_id: &str,
    expected_generation: Option<u64>,
    operation: impl FnOnce(&DuckDbEngine) -> Result<TableMutationEffects<T>, AppError>,
) -> Result<T, AppError>;
```

The coordinator begins the transaction, checks generation, invokes only non-transactional/non-bumping inner mutators, recomputes the deduplicated dependent closure, records one change set, sets generation once, and commits. Replace `with_row_mutation` and nested paste calls with coordinator-compatible inner helpers.

- [ ] **Step 4: Make history snapshots formula-aware**

Add before/after calculated-definition JSON columns to `_history_change_set_columns`. Include every physically changed downstream output in the before/after value snapshot tables. Update `apply_change_set` to restore exact column IDs, formula IDs/definitions, types, values, and calculated metadata before setting one new generation. Update `drop_change_set` to remove only history-owned rows/tables.

- [ ] **Step 5: Route every relevant mutation path**

Move these methods through the coordinator or a tested coordinator-compatible inner helper: `update_cell`, `update_cells_if_generation`, `clear_cells`, `paste_at_position_if_generation`, `paste_at_position_with_change_set`, `add_row`, `add_rows`, `apply_added_rows`, `delete_row`, `delete_rows`, `delete_rows_with_change_set`, `add_column_with_change_set`, `add_columns_with_change_set`, `add_valued_columns_with_change_set`, `delete_column`, `delete_columns_with_change_set`, `alter_column_with_change_set`, `alter_columns_type_with_change_set`, `change_column_type`, `rename_column`, `reorder_column_if_generation`, `update_table`, `copy_and_update_table`, `replace_dataset_atomically`, `replace_datasets_atomically`, `apply_change_set`, and `restore_snapshot`. Replacement paths must either preserve compatible calculated definitions and recompute them before commit, or reject a replacement whose schema removes/changes a referenced UUID; they must never silently mint IDs and rebind by name.

Do not recalculate on rename/reorder. Reject direct edits, clears, paste targets, or explicit type changes against calculated outputs before changing any row.

- [ ] **Step 6: Run mutation, history, and permit coverage and confirm GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calculated_mutation --lib
cargo test --manifest-path src-tauri/Cargo.toml change_set --lib
cargo test --manifest-path src-tauri/Cargo.toml generation_once --lib
cargo test --manifest-path src-tauri/Cargo.toml mutation_guard_coverage --lib
```

Expected: each mutation and replay action is atomic, yields one history entry, and increments generation exactly once.

- [ ] **Step 7: Record the Task 6 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: the complete backend remains uncommitted pending the final lifecycle
gate.

### Task 7: Tauri Commands, TypeScript Contracts, And Editor State

**Files:**
- Create: `src-tauri/src/commands/calculated_column_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`
- Create: `src/components/calculatedColumnEditorState.ts`
- Test: `tests/calculatedColumnContracts.test.ts`
- Test: `tests/calculatedColumnEditorState.test.ts`

**Interfaces:**
- Consumes: Rust requests/results from Tasks 1 and 5, existing Tauri invocation pattern, dataset generation, and current descriptors.
- Produces: `validate_calculated_column`, `upsert_calculated_column`, `convert_calculated_column_to_values`, mirrored TS unions/interfaces, service wrappers, autocomplete tokens, and stale-generation-safe draft state.

- [ ] **Step 1: Write failing command and TS contract tests**

`tests/calculatedColumnContracts.test.ts` must read command/registration/service sources and assert the same three command names plus camelCase request fields. Add compile-time exhaustive AST tests:

```ts
const expression: CalculatedExpressionV1 = {
  kind: "function",
  function: "round",
  arguments: [
    { kind: "columnRef", columnId: "length-id" },
    { kind: "numberLiteral", value: { kind: "integer", value: 2 } },
  ],
};
assert.equal(expression.kind, "function");
```

`tests/calculatedColumnEditorState.test.ts` must assert that a generation change preserves `draftText`, clears prior validation, and never auto-submits.

- [ ] **Step 2: Run contract tests and confirm RED**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnEditorState.test.ts
```

Expected: imports/contract assertions fail because no TS calculated models, commands, wrappers, or editor reducer exist.

- [ ] **Step 3: Add thin Rust commands and registration**

Use the approved command surface:

```rust
#[tauri::command]
pub fn validate_calculated_column(
    state: State<'_, AppState>,
    request: ValidateCalculatedColumnRequest,
) -> Result<CalculatedColumnValidation, AppError>;

#[tauri::command]
pub fn upsert_calculated_column(
    state: State<'_, AppState>,
    request: UpsertCalculatedColumnRequest,
) -> Result<CalculatedColumnMutationResult, AppError>;

#[tauri::command]
pub fn convert_calculated_column_to_values(
    state: State<'_, AppState>,
    dataset_id: String,
    column_id: String,
    expected_generation: u64,
) -> Result<CalculatedColumnMutationResult, AppError>;
```

Validation is read-only. Upsert/convert acquire the existing save-coordinator mutation permit and delegate to `DataService`. Add both mutators to mutation-guard coverage and all commands to `tauri::generate_handler!`.

- [ ] **Step 4: Mirror contracts and service wrappers in TypeScript**

Use discriminated unions matching Rust camelCase exactly. Extend `ColumnDescriptor` with optional calculated metadata. Add:

```ts
validateCalculatedColumn: (request: ValidateCalculatedColumnRequest) =>
  invoke<CalculatedColumnValidation>("validate_calculated_column", { request }),
upsertCalculatedColumn: (request: UpsertCalculatedColumnRequest) =>
  invoke<CalculatedColumnMutationResult>("upsert_calculated_column", { request }),
convertCalculatedColumnToValues: (datasetId: string, columnId: string, expectedGeneration: number) =>
  invoke<CalculatedColumnMutationResult>("convert_calculated_column_to_values", {
    datasetId, columnId, expectedGeneration,
  }),
```

- [ ] **Step 5: Implement pure draft/autocomplete helpers**

Keep `draftText`, `validatedText`, `validatedGeneration`, validation status, and diagnostics separate. Generate autocomplete entries from descriptors and the fixed V1 function catalog. Insert bracket-escaped current names but retain no UUIDs in the editable text. On stale generation, preserve the draft and return to pending validation.

- [ ] **Step 6: Run contract, editor, typecheck, and Rust registration tests and confirm GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnEditorState.test.ts
npx tsc -p tsconfig.app.json --noEmit
cargo test --manifest-path src-tauri/Cargo.toml mutation_guard_coverage --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: TS/Rust contracts align and every mutating command is permit-guarded.

- [ ] **Step 7: Record the Task 7 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: command and TypeScript contract changes remain uncommitted.

### Task 8: Calculated Column Editor And Read-Only Table UX

**Files:**
- Create: `src/components/CalculatedColumnDialog.tsx`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/CalculatedColumnHarness.tsx`
- Create: `tests/calculatedColumn.spec.tsx`
- Create: `tests/calculatedColumnLocale.test.ts`

**Interfaces:**
- Consumes: Task 7 descriptors, service wrappers, pure editor state, existing `DataTableView` mutation/history callbacks, and i18next.
- Produces: add/edit/convert UI, formula autocomplete and diagnostics, calculated status in headers, backend-aware read-only behavior, stale validation recovery, and localized messages.

- [ ] **Step 1: Write failing Playwright CT scenarios**

Mock only the IPC boundary in `CalculatedColumnHarness`; exercise real dialog and `DataTableView` behavior. Cover:

```ts
test("creates a calculated column from text and backend validation", async ({ mount, page }) => {
  await mount(<CalculatedColumnHarness scenario="create" />);
  await page.getByRole("button", { name: "Calculated Column" }).click();
  await page.getByLabel("Formula").fill("ROUND(Length * Width, 2)");
  await expect(page.getByText("Output type: DOUBLE")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("columnheader", { name: /Area/ })).toHaveAttribute("data-calculated", "ready");
});
```

Add scenarios for autocomplete escaping, existing-column conversion, edit formula, inferred type/dependencies/downstream impact, collision-safe suggested name, calculated cell edit/clear/paste blocking, Convert to Values, dependency-delete diagnostics, `broken`/`unsupported`, source rename display normalization, stale-generation draft preservation, undo/redo refresh, and narrow 760 px layout without overlap.

- [ ] **Step 2: Run one component scenario and confirm RED**

Run:

```bash
npx playwright test -c playwright-ct.config.ts tests/calculatedColumn.spec.tsx --grep "creates a calculated column"
```

Expected: test fails because the dialog and entry point do not exist.

- [ ] **Step 3: Build the dialog**

Use a compact modal with a labeled output-name input, text expression editor, searchable Columns/Functions menus, normalized preview, inferred type, dependency/downstream lists, warning counts, and structured diagnostics. Apply remains disabled unless `validatedText === draftText` and `validatedGeneration` equals the current dataset generation. Use existing button/dialog classes and Font Awesome icons; do not add formula metadata to `ManageExtrasDialog`.

- [ ] **Step 4: Wire entry points and calculated presentation**

Add **Calculated Column** to Add Column and the column context menu. Ordinary columns offer **Calculated Formula**; calculated columns offer **Edit Formula** and **Convert to Values**. Fetch `getColumnDescriptors` with each dataset generation, show a formula icon/status attribute in header and Columns panel, and format tooltip text from backend metadata.

- [ ] **Step 5: Enforce UI mutation guards before IPC**

Guard `commitEdit`, `writeActiveCellValue`, `clearCells`, cut, keyboard Delete/Backspace, and paste range intersection using descriptor IDs/status. Show the localized `calculated_column_read_only` diagnostic and do not call mutation services. Keep backend rejection as the final authority. After any successful calculated mutation, record the returned opaque change-set ID using the existing `recordTable` path and refresh generation/descriptors/window.

- [ ] **Step 6: Add complete locale parity**

Add the same keys under `dataTable.calculatedColumn` in all four locales: actions, fields, functions, statuses, warning labels, every diagnostic code, dependency paths, stale validation, read-only mutation, and Convert to Values confirmation. The locale parity test recursively compares key sets.

- [ ] **Step 7: Run component and frontend regression tests and confirm GREEN**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnLocale.test.ts
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnEditorState.test.ts
npx playwright test -c playwright-ct.config.ts tests/calculatedColumn.spec.tsx
npx playwright test -c playwright-ct.config.ts tests/dataTableView.spec.tsx tests/dataTableSplitters.spec.tsx
npm run build
```

If `tests/dataTableView.spec.tsx` does not exist at execution time, run the existing DataTableView-focused specs returned by `rg --files tests | rg 'dataTable.*spec\.tsx$'`; record the exact files in the task report rather than silently skipping UI regression coverage.

Expected: all calculated scenarios, locale parity, existing Table CT specs, and production build pass.

- [ ] **Step 8: Record the Task 8 review checkpoint without committing**

```bash
git diff --check
git status --short
```

Expected: all implementation remains uncommitted and ready for performance,
full verification, independent review, and manual acceptance.

### Task 9: Performance Qualification, Full Verification, And AI Review

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src-tauri/examples/performance_baseline.rs`
- Modify: `docs/performance.md`
- Create: `docs/superpowers/reports/issue-219-calculated-columns-performance.md`
- Modify only if failures expose task-owned defects: files changed in Tasks 1-8

**Interfaces:**
- Consumes: completed backend/UI feature and the spec's 300,000-row five-level dependency-chain threshold.
- Produces: repeatable `calculated` benchmark operation, recorded hardware/run evidence, clean repository gates, and an independent review report ready for manual acceptance.

- [ ] **Step 1: Write a failing perf-harness contract test**

Add a test proving CLI parsing accepts `--operation calculated` and rejects chain depth zero. Add a small deterministic harness test that seeds five formulas, mutates the full source column, and verifies all five outputs before timing is recorded. On macOS, add a test that `current_working_set_bytes()` returns `Some` for the current process so the required memory gate cannot degrade to an omitted measurement.

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml perf_harness --features perf-harness
```

Expected: parsing fails because `Operation::Calculated` does not exist.

- [ ] **Step 3: Implement the calculated benchmark operation**

Seed 300,000 rows using `seed_benchmark_table`, add a five-column linear formula chain, warm up once, then run five source-column mutations through the production coordinator. Extend the existing 5 ms process sampler on macOS with `proc_pidinfo(PROC_PIDTASKINFO)` FFI from libproc, mirroring the existing dependency-free Windows FFI; keep unsupported platforms explicit rather than treating absent memory as a pass. Record each elapsed duration and process peak RSS, the median, DuckDB/app version, OS, CPU, and physical/result byte estimate. Exit nonzero when median exceeds 2.0 seconds, when memory measurement is unavailable on the qualification machine, or when peak resident-memory growth exceeds 2.0 times the physical input plus calculated-result bytes.

- [ ] **Step 4: Run and record the required benchmark**

Run:

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation calculated --chain-depth 5 --runs 5
```

Copy exact machine metadata, all five runs, median, peak-memory method, byte estimate, and pass/fail result into `docs/superpowers/reports/issue-219-calculated-columns-performance.md`. A failed threshold blocks manual acceptance and requires design revision; do not switch to partial or asynchronous values.

- [ ] **Step 5: Run full backend gates and confirm GREEN**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Before staging any formatter output, inspect scope and retain only task-owned changes. Expected: zero formatting differences, clippy warnings, or failed tests.

- [ ] **Step 6: Run full frontend and archive gates**

Run:

```bash
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnEditorState.test.ts
npx tsx --tsconfig tsconfig.app.json tests/calculatedColumnLocale.test.ts
npx tsx --tsconfig tsconfig.app.json tests/historyTimeline.test.ts
npx playwright test -c playwright-ct.config.ts tests/calculatedColumn.spec.tsx
npm run test:analysis
npm run test:distribution
npm run build
git diff --check origin/dev...HEAD
```

Expected: zero failures. Analysis/Distribution suites protect the shared archive file touched by this feature.

- [ ] **Step 7: Inspect final scope and request independent review**

Run bounded status/diff-stat checks, then dispatch an independent reviewer with Issue 219, the approved spec, base `2f5d978`, current HEAD, and the complete diff including untracked files. Require review of formula injection, transaction rollback, ID remap, history replay, direct-edit bypasses, unknown-schema preservation, and performance evidence.

Fix every Critical or Important finding through a fresh RED/GREEN cycle and rerun affected focused plus full gates. Repeat review after behavioral repairs.

- [ ] **Step 8: Start the app for manual acceptance**

Run the dev server from the Issue 219 worktree:

```bash
npm run tauri dev
```

Provide the user this acceptance checklist and stop:

1. Create `Area = ROUND(Length * Width, 2)` using autocomplete.
2. Rename/reorder `Length` and confirm formula binding and displayed formula remain correct.
3. Create a chained formula and edit source values; confirm both outputs update together.
4. Confirm calculated cells reject edit, clear, and paste.
5. Confirm deleting a dependency reports direct/transitive paths.
6. Convert one output to values and edit it as an ordinary column.
7. Undo/redo formula creation, source edit, conversion, and deletion.
8. Save/reopen the project and export/import `.sptb`; confirm reopen preserves identity and import creates an independent copy.
9. Inspect narrow and desktop layouts plus `broken`/`unsupported` fixture states.

Do not commit review repairs, push, or create the PR until the user explicitly accepts the running application. After acceptance, run fresh verification, commit any final review/performance files, push without force, and create the Issue 219 PR targeting `dev` under the GitHub Issue Development Flow.

- [ ] **Step 9: After explicit manual acceptance, verify and create the implementation commit**

Rerun Steps 4-6 on the exact accepted tree, confirm the independent review has
no unresolved Critical or Important finding, inspect the complete staged diff,
then create one feature commit:

```bash
git add src src-tauri tests docs/performance.md docs/superpowers/plans/2026-09-16-issue-219-calculated-table-columns.md docs/superpowers/reports/issue-219-calculated-columns-performance.md
git diff --cached --check
git commit -m "feat(table): add calculated columns"
```

Verify the commit contains no generated/cache files or unrelated changes. Push
without force and create a PR from `feat/219-calculated-table-columns` to `dev`
with `Closes #219`, exact verification evidence, manual acceptance, head SHA,
worktree path, and the cleanup allowlist required by the GitHub Issue Development
Flow. Do not merge automatically.
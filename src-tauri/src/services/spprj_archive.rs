//! Spprj archive layer.
//!
//! v2 `.spprj` files are ZIP containers whose internal layout mirrors the
//! user-facing folder tree inside the DIRECTORY tab. Each table and graph
//! lives at the path the user sees in the UI:
//!
//! ```text
//! manifest.json                ProjectManifest (project metadata + index)
//! <folder>/<name>.sptb         TableDoc as JSON (one per dataset)
//! <folder>/<name>.spgh         GraphDoc as JSON (one per graph builder)
//! .history.json                opaque [HistoryEntry]    (optional)
//! .snapshots.json              opaque [Snapshot]        (optional)
//! ```
//!
//! Extracting the archive yields a tidy directory tree the user can browse
//! with any zip tool — exactly what they see inside StatsPlayground.
//!
//! Design principle (issue #7): an `.spprj` is conceptually just a folder of
//! files. The folder a `.sptb` / `.spgh` lives in is encoded ONLY by its
//! archive path — never duplicated inside the file body or as a separate
//! `folder` field on the manifest entry. `manifest.json` is pure metadata:
//! project name, version, created_at, the list of folders that exist
//! (including empty ones), and a `{id → file}` index for tables and graphs.
//!
//! v1 `.spprj` files (`tables/<uuid>.sptb`, `graphs/<uuid>.spgh`, no folders)
//! still open: the reader does NOT migrate at read time. Migration to v2
//! happens implicitly on the next save, when the writer re-derives filenames
//! from display names and lays them out under the user's folder tree.
//!
//! Even older legacy single-file JSON `.spprj` documents are still detected
//! via a first-byte sniff and parsed via `LegacySpprj`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::models::distribution::DistributionLoadStatusV1;

#[cfg(test)]
type BeforeDestinationMutationHook = Box<dyn Fn(&str, &str) -> Result<(), AppError>>;

#[cfg(test)]
type ValidateTableEntryOpenHook = Box<dyn Fn(&str, u64, u64) -> Result<(), AppError>>;

#[cfg(test)]
thread_local! {
    static BEFORE_DESTINATION_MUTATION_HOOK: std::cell::RefCell<Option<BeforeDestinationMutationHook>> =
        std::cell::RefCell::new(None);
    static VALIDATE_TABLE_ENTRY_OPEN_HOOK: std::cell::RefCell<Option<ValidateTableEntryOpenHook>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(crate) fn install_test_before_destination_mutation_hook(
    hook: Option<BeforeDestinationMutationHook>,
) {
    BEFORE_DESTINATION_MUTATION_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
pub(crate) fn install_test_validate_table_entry_open_hook(
    hook: Option<ValidateTableEntryOpenHook>,
) {
    VALIDATE_TABLE_ENTRY_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
fn run_before_destination_mutation_hook(path: &str, tmp_path: &str) -> Result<(), AppError> {
    BEFORE_DESTINATION_MUTATION_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(path, tmp_path)?;
        }
        Ok(())
    })
}

#[cfg(test)]
fn run_validate_table_entry_open_hook(
    entry_name: &str,
    entry_size: u64,
    body_bytes_read: u64,
) -> Result<(), AppError> {
    VALIDATE_TABLE_ENTRY_OPEN_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(entry_name, entry_size, body_bytes_read)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn run_validate_table_entry_open_hook(
    _entry_name: &str,
    _entry_size: u64,
    _body_bytes_read: u64,
) -> Result<(), AppError> {
    Ok(())
}

#[cfg(not(test))]
fn run_before_destination_mutation_hook(_path: &str, _tmp_path: &str) -> Result<(), AppError> {
    Ok(())
}

// ----------------------------------------------------------------------------
// Public document types — these are the in-memory representation. The on-disk
// JSON shape mirrors the field names exactly (camelCase via serde rename).
// ----------------------------------------------------------------------------

/// The top-level index for a `.spprj` archive. Stored as `manifest.json`.
///
/// Per-dataset and per-graph payloads are NOT inlined here — they live in
/// separate ZIP entries pointed to by `tables` / `graphs` relative paths. This
/// is what enables "open just one table" and "share a single graph" workflows.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub name: String,
    pub version: String,
    pub created_at: String,
    /// Index of table entries.
    #[serde(default)]
    pub tables: Vec<TableEntryRef>,
    /// Index of graph entries.
    #[serde(default)]
    pub graphs: Vec<GraphEntryRef>,
    /// All folders that exist in the project, including empty ones.
    /// Paths use `/` as the separator and never start or end with `/`.
    /// Implicit ancestors (e.g. `a` for `a/b`) are still listed explicitly.
    #[serde(default)]
    pub folders: Vec<String>,
    /// `tableId -> folder path` manifest metadata. Missing means a legacy
    /// archive whose folder layout must be derived from entry paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_folders: Option<HashMap<String, String>>,
    /// `graphId -> folder path` manifest metadata. Missing means a legacy
    /// archive whose folder layout must be derived from entry paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_folders: Option<HashMap<String, String>>,
    #[serde(default)]
    pub fit_y_by_x: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_y_by_x_folders: HashMap<String, String>,
    #[serde(default)]
    pub fit_models: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_model_folders: HashMap<String, String>,
    #[serde(default)]
    pub tabulates: Vec<serde_json::Value>,
    #[serde(default)]
    pub tabulate_folders: HashMap<String, String>,
    #[serde(default)]
    pub distributions: Vec<DistributionEntryRefV1>,
    #[serde(default)]
    pub derived_formulas: Vec<DerivedFormulaEntryRefV1>,
    #[serde(default)]
    pub distribution_issues: Vec<Value>,
    #[serde(default)]
    pub distribution_folders: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionEntryRefV1 {
    pub analysis_id: String,
    pub name: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaEntryRefV1 {
    pub formula_id: String,
    pub analysis_id: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionDocV1 {
    pub schema_version: String,
    pub analysis_id: String,
    pub name: String,
    pub source_dataset_id: String,
    pub status: String,
    #[serde(default = "default_config_revision")]
    pub config_revision: u64,
    pub current_config: Value,
    #[serde(default)]
    pub load_status: DistributionLoadStatusV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_envelope: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
}

fn default_config_revision() -> u64 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaDocV1 {
    pub formula_id: String,
    pub schema_version: String,
    pub analysis_id: String,
    pub source_dataset_id: String,
    pub source_column_ids: Vec<String>,
    pub output_column_name: String,
    pub ast: Value,
    pub fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionArchiveEnvelopeV1 {
    pub schema_version: String,
    pub body: DistributionDocV1,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DistributionArchiveRecordV1 {
    Parsed(DistributionArchiveEnvelopeV1),
    UnknownVersion {
        analysis_id: String,
        schema_version: String,
        raw_envelope: Value,
    },
    Corrupt {
        analysis_id: String,
        raw_text: String,
    },
}

impl DistributionArchiveRecordV1 {
    pub fn analysis_id(&self) -> &str {
        match self {
            Self::Parsed(envelope) => &envelope.body.analysis_id,
            Self::UnknownVersion { analysis_id, .. } | Self::Corrupt { analysis_id, .. } => {
                analysis_id
            }
        }
    }
}

pub fn distribution_records_from_values(
    values: Vec<Value>,
) -> Result<Vec<DistributionArchiveRecordV1>, AppError> {
    values
        .into_iter()
        .map(|value| {
            let doc: DistributionDocV1 = serde_json::from_value(value).map_err(|error| {
                AppError::InvalidParam(format!("invalid distribution document: {error}"))
            })?;
            Ok(match doc.load_status {
                DistributionLoadStatusV1::UnknownVersion => {
                    DistributionArchiveRecordV1::UnknownVersion {
                        analysis_id: doc.analysis_id,
                        schema_version: doc.schema_version,
                        raw_envelope: doc.raw_envelope.unwrap_or_else(|| serde_json::json!({})),
                    }
                }
                DistributionLoadStatusV1::Corrupt => DistributionArchiveRecordV1::Corrupt {
                    analysis_id: doc.analysis_id,
                    raw_text: doc.raw_text.unwrap_or_default(),
                },
                DistributionLoadStatusV1::Ready | DistributionLoadStatusV1::MissingSource => {
                    DistributionArchiveRecordV1::Parsed(DistributionArchiveEnvelopeV1 {
                        schema_version: "1".to_string(),
                        body: DistributionDocV1 {
                            raw_envelope: None,
                            raw_text: None,
                            ..doc
                        },
                    })
                }
            })
        })
        .collect()
}

pub fn derived_formula_envelopes_from_values(
    values: Vec<Value>,
) -> Result<Vec<DerivedFormulaArchiveEnvelopeV1>, AppError> {
    values
        .into_iter()
        .map(|value| {
            let body: DerivedFormulaDocV1 = serde_json::from_value(value).map_err(|error| {
                AppError::InvalidParam(format!("invalid derived formula document: {error}"))
            })?;
            Ok(DerivedFormulaArchiveEnvelopeV1 {
                schema_version: "1".to_string(),
                body,
            })
        })
        .collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaArchiveEnvelopeV1 {
    pub schema_version: String,
    pub body: DerivedFormulaDocV1,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableEntryRef {
    pub id: String,
    pub name: String,
    /// Relative path inside the archive — for v2 this is `<folder>/<name>.sptb`
    /// (or `<name>.sptb` at the root). For v1 reads this stays `tables/<id>.sptb`.
    /// The folder is derived from `dirname(file)` on read; never duplicated here.
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntryRef {
    pub id: String,
    /// Display name of the graph, used to derive the archive filename in v2.
    /// v1 manifests didn't have this — defaults to empty string then.
    #[serde(default)]
    pub name: String,
    /// Relative path inside the archive, e.g. `<folder>/<name>.spgh`.
    /// The folder is derived from `dirname(file)` on read; never duplicated here.
    pub file: String,
}

/// One table file (`.sptb`). Self-contained: includes its own id/name so that
/// importing a standalone `.sptb` back into a project doesn't lose anything.
/// Per issue #7, this body does NOT carry folder information — a file is
/// just a file; where it lives is the folder it sits in.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableDoc {
    pub id: String,
    pub name: String,
    pub source_type: String,
    /// Doc format version — bump if the rows/columns shape changes.
    #[serde(default = "default_doc_version")]
    pub version: String,
    pub columns: Vec<TableColumn>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_id: Option<String>,
    pub name: String,
    pub col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<TableColumnFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, Value>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnFormat {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// One graph file (`.spgh`). The body is opaque JSON owned by the frontend
/// (graph builder config). We require an `id` field at the top level so the
/// manifest can index it; `name` is pulled into the named field so the writer
/// can build the archive path. Per issue #7, folder info is NOT carried here.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphDoc {
    pub id: String,
    /// Display name — used to derive the `<name>.spgh` filename in v2.
    /// Defaults to empty (the writer falls back to the id then).
    #[serde(default)]
    pub name: String,
    /// Doc format version.
    #[serde(default = "default_doc_version")]
    pub version: String,
    /// Frontend-owned opaque payload (everything except the named fields).
    #[serde(flatten)]
    pub body: serde_json::Map<String, Value>,
}

fn default_doc_version() -> String {
    "1".to_string()
}

// ----------------------------------------------------------------------------
// Bundle = the in-memory shape of an entire project, ready to write or just
// loaded from disk. project_service.rs builds this when saving and consumes
// it when loading.
// ----------------------------------------------------------------------------

#[derive(Clone)]
pub struct ProjectBundle {
    pub manifest: ProjectManifest,
    pub tables: Vec<TableDoc>,
    pub graphs: Vec<GraphDoc>,
    pub fit_y_by_x: Vec<Value>,
    pub fit_models: Vec<Value>,
    pub tabulates: Vec<Value>,
    pub distributions: Vec<DistributionArchiveRecordV1>,
    pub derived_formulas: Vec<DerivedFormulaArchiveEnvelopeV1>,
    pub history: Vec<Value>,
    pub snapshots: Vec<Value>,
}

// ----------------------------------------------------------------------------
// Legacy single-file `.spprj` JSON format. We keep the old shape verbatim so
// that existing project files on disk still open. New saves always emit the
// new ZIP format.
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySpprj {
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    datasets: Vec<LegacyDataset>,
    #[serde(default)]
    history: Option<Vec<Value>>,
    #[serde(default)]
    snapshots: Option<Vec<Value>>,
    #[serde(default)]
    graph_builders: Option<Vec<Value>>,
    #[serde(default)]
    fit_y_by_x: Option<Vec<Value>>,
    #[serde(default)]
    fit_y_by_x_folders: Option<HashMap<String, String>>,
    #[serde(default)]
    fit_models: Option<Vec<Value>>,
    #[serde(default)]
    fit_model_folders: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDataset {
    id: String,
    name: String,
    #[serde(default)]
    source_type: String,
    columns: Vec<TableColumn>,
    rows: Vec<Vec<Value>>,
}

// ----------------------------------------------------------------------------
// Read API
// ----------------------------------------------------------------------------

/// Sniff the first bytes of a file and decide whether it is a ZIP archive
/// (new format) or a JSON document (legacy).
pub fn read_project_file(path: &str) -> Result<ProjectBundle, AppError> {
    let bytes = std::fs::read(path)?;
    if is_zip(&bytes) {
        read_zip_bundle(&bytes)
    } else {
        read_legacy_json(&bytes)
    }
}

pub fn build_graph_docs(raw_graph_builders: Vec<Value>) -> Vec<GraphDoc> {
    raw_graph_builders
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let (id, name, body) = lift_id_name(raw, index);
            GraphDoc {
                id,
                name,
                version: default_doc_version(),
                body,
            }
        })
        .collect()
}

pub fn validate_archive_manifest_and_entries(
    archive_path: &Path,
    expected_manifest: &ProjectManifest,
    expected_extra_entries: &[&str],
) -> Result<(), AppError> {
    let file = std::fs::File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive during validation: {e}")))?;

    let mut manifest_entry = zip
        .by_name("manifest.json")
        .map_err(|e| AppError::FileIO(format!("Project archive missing manifest.json: {e}")))?;
    let mut manifest_bytes = Vec::new();
    manifest_entry
        .read_to_end(&mut manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Failed reading manifest.json: {e}")))?;
    drop(manifest_entry);

    let actual_manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json during validation: {e}")))?;

    let expected_json = serde_json::to_value(expected_manifest)
        .map_err(|e| AppError::FileIO(format!("Failed to encode expected manifest: {e}")))?;
    let actual_json = serde_json::to_value(&actual_manifest)
        .map_err(|e| AppError::FileIO(format!("Failed to encode actual manifest: {e}")))?;
    if expected_json != actual_json {
        return Err(AppError::FileIO(
            "Validated archive manifest differs from expected snapshot".to_string(),
        ));
    }

    for table in &expected_manifest.tables {
        let table_entry = zip.by_name(&table.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing table entry {}: {e}", table.file))
        })?;
        run_validate_table_entry_open_hook(&table.file, table_entry.size(), 0)?;
        drop(table_entry);
    }
    for graph in &expected_manifest.graphs {
        let mut graph_entry = zip.by_name(&graph.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing graph entry {}: {e}", graph.file))
        })?;
        serde_json::from_reader::<_, serde::de::IgnoredAny>(&mut graph_entry).map_err(|e| {
            AppError::FileIO(format!(
                "Archive graph entry {} is not valid JSON: {e}",
                graph.file
            ))
        })?;
    }
    for entry in expected_extra_entries {
        let mut extra_entry = zip
            .by_name(entry)
            .map_err(|e| AppError::FileIO(format!("Archive missing entry {}: {e}", entry)))?;
        serde_json::from_reader::<_, serde::de::IgnoredAny>(&mut extra_entry).map_err(|e| {
            AppError::FileIO(format!("Archive entry {} is not valid JSON: {e}", entry))
        })?;
    }

    Ok(())
}

pub fn count_project_rows_streaming(path: &str) -> Result<usize, AppError> {
    let bytes = std::fs::read(path)?;
    if !is_zip(&bytes) {
        let bundle = read_legacy_json(&bytes)?;
        return Ok(bundle.tables.iter().map(|table| table.rows.len()).sum());
    }

    let cursor = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive: {e}")))?;

    let manifest_bytes = read_entry_bytes(&mut zip, "manifest.json")
        .ok_or_else(|| AppError::FileIO("Project archive missing manifest.json".into()))?;
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json: {e}")))?;

    let mut total_rows = 0usize;
    for table in manifest.tables {
        let mut table_entry = zip
            .by_name(&table.file)
            .map_err(|e| AppError::FileIO(format!("Missing table entry: {} ({e})", table.file)))?;
        total_rows = total_rows.saturating_add(count_rows_in_table_json(&mut table_entry)?);
    }

    Ok(total_rows)
}

fn count_rows_in_table_json<R: Read>(reader: R) -> Result<usize, AppError> {
    struct RowsCountSeed;

    impl<'de> DeserializeSeed<'de> for RowsCountSeed {
        type Value = usize;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct RowsVisitor;

            impl<'de> Visitor<'de> for RowsVisitor {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("a JSON array of table rows")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while seq.next_element::<IgnoredAny>()?.is_some() {
                        count = count.saturating_add(1);
                    }
                    Ok(count)
                }
            }

            deserializer.deserialize_seq(RowsVisitor)
        }
    }

    struct TableVisitor;

    impl<'de> Visitor<'de> for TableVisitor {
        type Value = usize;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a table JSON object")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut rows_count: Option<usize> = None;
            while let Some(key) = map.next_key::<String>()? {
                if key == "rows" {
                    rows_count = Some(map.next_value_seed(RowsCountSeed)?);
                } else {
                    let _: IgnoredAny = map.next_value()?;
                }
            }
            rows_count.ok_or_else(|| serde::de::Error::missing_field("rows"))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let row_count = serde::de::Deserializer::deserialize_any(&mut deserializer, TableVisitor)
        .map_err(|e| AppError::FileIO(format!("Invalid table JSON while counting rows: {e}")))?;
    deserializer
        .end()
        .map_err(|e| AppError::FileIO(format!("Trailing table JSON content: {e}")))?;
    Ok(row_count)
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..2] == b"PK"
}

fn read_zip_bundle(bytes: &[u8]) -> Result<ProjectBundle, AppError> {
    let cursor = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive: {}", e)))?;

    let manifest_bytes = read_entry_bytes(&mut zip, "manifest.json")
        .ok_or_else(|| AppError::FileIO("Project archive missing manifest.json".into()))?;
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json: {}", e)))?;

    let mut tables = Vec::with_capacity(manifest.tables.len());
    for entry in &manifest.tables {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing table entry: {}", entry.file)))?;
        let doc: TableDoc = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::FileIO(format!("Invalid table file {}: {}", entry.file, e)))?;
        tables.push(doc);
    }
    let mut graphs = Vec::with_capacity(manifest.graphs.len());
    for entry in &manifest.graphs {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing graph entry: {}", entry.file)))?;
        let doc = parse_graph_doc(&bytes, &entry.id)
            .map_err(|e| AppError::FileIO(format!("Invalid graph file {}: {}", entry.file, e)))?;
        graphs.push(doc);
    }

    let history = read_entry_bytes(&mut zip, ".history.json")
        .or_else(|| read_entry_bytes(&mut zip, "history.json"))
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let snapshots = read_entry_bytes(&mut zip, ".snapshots.json")
        .or_else(|| read_entry_bytes(&mut zip, "snapshots.json"))
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let fit_y_by_x = manifest.fit_y_by_x.clone();
    let fit_models = manifest
        .fit_models
        .iter()
        .cloned()
        .map(strip_transient_fit_model_fields)
        .collect();
    let tabulates = manifest.tabulates.clone();
    let mut distributions = Vec::with_capacity(manifest.distributions.len());
    for entry in &manifest.distributions {
        let bytes = read_entry_bytes(&mut zip, &entry.file).ok_or_else(|| {
            AppError::FileIO(format!("Missing distribution entry: {}", entry.file))
        })?;
        let raw_text = String::from_utf8_lossy(&bytes).to_string();
        let raw_envelope: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                distributions.push(DistributionArchiveRecordV1::Corrupt {
                    analysis_id: entry.analysis_id.clone(),
                    raw_text,
                });
                continue;
            }
        };
        let schema_version = raw_envelope
            .get("schemaVersion")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if schema_version != "1" {
            distributions.push(DistributionArchiveRecordV1::UnknownVersion {
                analysis_id: entry.analysis_id.clone(),
                schema_version,
                raw_envelope,
            });
            continue;
        }
        match serde_json::from_value::<DistributionArchiveEnvelopeV1>(raw_envelope) {
            Ok(envelope) => distributions.push(DistributionArchiveRecordV1::Parsed(envelope)),
            Err(_) => distributions.push(DistributionArchiveRecordV1::Corrupt {
                analysis_id: entry.analysis_id.clone(),
                raw_text,
            }),
        }
    }
    let mut derived_formulas = Vec::with_capacity(manifest.derived_formulas.len());
    for entry in &manifest.derived_formulas {
        let bytes = read_entry_bytes(&mut zip, &entry.file).ok_or_else(|| {
            AppError::FileIO(format!("Missing derived formula entry: {}", entry.file))
        })?;
        let envelope = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::FileIO(format!(
                "Invalid derived formula file {}: {error}",
                entry.file
            ))
        })?;
        derived_formulas.push(envelope);
    }

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        fit_y_by_x,
        fit_models,
        tabulates,
        distributions,
        derived_formulas,
        history,
        snapshots,
    })
}

fn read_entry_bytes<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut entry = zip.by_name(name).ok()?;
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out).ok()?;
    Some(out)
}

fn read_legacy_json(bytes: &[u8]) -> Result<ProjectBundle, AppError> {
    let legacy: LegacySpprj = serde_json::from_slice(bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid project file: {}", e)))?;

    // v0 (legacy single-file JSON) had no folder concept — every table /
    // graph lives at the project root. Synthesize root-level paths so the
    // path-derived folder logic in open_project naturally returns `None`.
    let mut tables = Vec::with_capacity(legacy.datasets.len());
    let mut table_refs = Vec::with_capacity(legacy.datasets.len());
    for ds in legacy.datasets {
        table_refs.push(TableEntryRef {
            id: ds.id.clone(),
            name: ds.name.clone(),
            file: format!("{}.sptb", ds.id),
        });
        tables.push(TableDoc {
            id: ds.id,
            name: ds.name,
            source_type: ds.source_type,
            version: default_doc_version(),
            columns: ds.columns,
            rows: ds.rows,
        });
    }

    // Legacy graph builders had no top-level id field separate from the body.
    // Try to lift `id`/`builderId`/`name` out for the manifest; otherwise synthesize.
    let mut graphs = Vec::new();
    let mut graph_refs = Vec::new();
    if let Some(gbs) = legacy.graph_builders {
        for (idx, raw) in gbs.into_iter().enumerate() {
            let (id, name, body) = lift_id_name(raw, idx);
            graph_refs.push(GraphEntryRef {
                id: id.clone(),
                name: name.clone(),
                file: format!("{}.spgh", id),
            });
            graphs.push(GraphDoc {
                id,
                name,
                version: default_doc_version(),
                body,
            });
        }
    }

    let fit_y_by_x = legacy.fit_y_by_x.unwrap_or_default();
    let fit_y_by_x_folders = legacy.fit_y_by_x_folders.unwrap_or_default();
    let fit_models = legacy
        .fit_models
        .unwrap_or_default()
        .into_iter()
        .map(strip_transient_fit_model_fields)
        .collect::<Vec<_>>();
    let fit_model_folders = legacy.fit_model_folders.unwrap_or_default();

    let manifest = ProjectManifest {
        name: legacy.name,
        version: if legacy.version.is_empty() {
            "0.1.0".into()
        } else {
            legacy.version
        },
        created_at: legacy.created_at,
        tables: table_refs,
        graphs: graph_refs,
        folders: Vec::new(),
        table_folders: None,
        graph_folders: None,
        fit_y_by_x: fit_y_by_x.clone(),
        fit_y_by_x_folders,
        fit_models: fit_models.clone(),
        fit_model_folders,
        tabulates: Vec::new(),
        tabulate_folders: HashMap::new(),
        distributions: Vec::new(),
        derived_formulas: Vec::new(),
        distribution_issues: Vec::new(),
        distribution_folders: HashMap::new(),
    };

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        fit_y_by_x,
        fit_models,
        tabulates: Vec::new(),
        distributions: Vec::new(),
        derived_formulas: Vec::new(),
        history: legacy.history.unwrap_or_default(),
        snapshots: legacy.snapshots.unwrap_or_default(),
    })
}

/// Pull `id` and `name` out of an opaque graph builder JSON value for use in
/// the manifest, returning `(id, name, body)`. `id`, `name`, `version`, and
/// any legacy `folder` field are *removed* from the returned body so the
/// GraphDoc that flattens it won't emit duplicate keys on serialization, and
/// so legacy in-body folder hints can never silently override the
/// path-derived folder.
fn lift_id_name(
    raw: Value,
    fallback_idx: usize,
) -> (String, String, serde_json::Map<String, Value>) {
    let mut map = match raw {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            map.remove("builderId")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_else(|| format!("graph_{}", fallback_idx));
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    map.remove("version");
    map.remove("folder"); // legacy: drop in-body folder; archive path is the source of truth.
    (id, name, map)
}

// ----------------------------------------------------------------------------
// Write API
// ----------------------------------------------------------------------------

/// Build a `ProjectBundle` from per-doc inputs.
///
/// Folder routing is supplied OUT-OF-BAND via `table_folders` and
/// `graph_folders` (id → folder path); per issue #7 the file bodies
/// themselves carry no folder information. The writer now emits stable
/// archive paths based only on ids: `tables/<dataset-id>.sptb` and
/// `graphs/<graph-id>.spgh`.
pub fn build_bundle(
    name: String,
    version: String,
    created_at: String,
    tables: Vec<TableDoc>,
    graphs: Vec<GraphDoc>,
    fit_y_by_x: Vec<Value>,
    fit_models: Vec<Value>,
    tabulates: Vec<Value>,
    distributions: Vec<DistributionArchiveRecordV1>,
    derived_formulas: Vec<DerivedFormulaArchiveEnvelopeV1>,
    distribution_issues: Vec<Value>,
    folders: Vec<String>,
    table_folders: &HashMap<String, String>,
    graph_folders: &HashMap<String, String>,
    fit_y_by_x_folders: &HashMap<String, String>,
    fit_model_folders: &HashMap<String, String>,
    tabulate_folders: &HashMap<String, String>,
    distribution_folders: &HashMap<String, String>,
    history: Vec<Value>,
    snapshots: Vec<Value>,
) -> ProjectBundle {
    let sanitized_fit_y_by_x: Vec<Value> = fit_y_by_x
        .into_iter()
        .map(strip_transient_fit_y_by_x_fields)
        .collect();
    let sanitized_fit_models: Vec<Value> = fit_models
        .into_iter()
        .map(strip_transient_fit_model_fields)
        .collect();

    let mut table_refs: Vec<TableEntryRef> = Vec::with_capacity(tables.len());
    for t in tables.iter() {
        table_refs.push(TableEntryRef {
            id: t.id.clone(),
            name: t.name.clone(),
            file: format!("tables/{}.sptb", t.id),
        });
    }

    let mut graph_refs: Vec<GraphEntryRef> = Vec::with_capacity(graphs.len());
    for g in graphs.iter() {
        graph_refs.push(GraphEntryRef {
            id: g.id.clone(),
            name: g.name.clone(),
            file: format!("graphs/{}.spgh", g.id),
        });
    }

    let distribution_refs = distributions
        .iter()
        .map(|record| {
            let analysis_id = record.analysis_id().to_string();
            let name = match record {
                DistributionArchiveRecordV1::Parsed(envelope) => envelope.body.name.clone(),
                _ => String::new(),
            };
            DistributionEntryRefV1 {
                analysis_id: analysis_id.clone(),
                name,
                file: format!("distributions/{analysis_id}.spdist"),
            }
        })
        .collect::<Vec<_>>();
    let derived_formula_refs = derived_formulas
        .iter()
        .map(|envelope| DerivedFormulaEntryRefV1 {
            formula_id: envelope.body.formula_id.clone(),
            analysis_id: envelope.body.analysis_id.clone(),
            file: format!("derived-formulas/{}.spformula", envelope.body.formula_id),
        })
        .collect::<Vec<_>>();

    // Collapse `folders` to a sorted, deduplicated, normalized list. Includes
    // any implicit ancestor folders for completeness so an extractor sees the
    // full tree even if the user only created `a/b/c` directly.
    let normalized_folders = normalize_folder_list(folders);

    ProjectBundle {
        manifest: ProjectManifest {
            name,
            version,
            created_at,
            tables: table_refs,
            graphs: graph_refs,
            folders: normalized_folders,
            table_folders: Some(table_folders.clone()),
            graph_folders: Some(graph_folders.clone()),
            fit_y_by_x: sanitized_fit_y_by_x.clone(),
            fit_y_by_x_folders: fit_y_by_x_folders.clone(),
            fit_models: sanitized_fit_models.clone(),
            fit_model_folders: fit_model_folders.clone(),
            tabulates: tabulates.clone(),
            tabulate_folders: tabulate_folders.clone(),
            distributions: distribution_refs,
            derived_formulas: derived_formula_refs,
            distribution_issues,
            distribution_folders: distribution_folders.clone(),
        },
        tables,
        graphs,
        fit_y_by_x: sanitized_fit_y_by_x,
        fit_models: sanitized_fit_models,
        tabulates,
        distributions,
        derived_formulas,
        history,
        snapshots,
    }
}

fn strip_transient_fit_y_by_x_fields(value: Value) -> Value {
    match value {
        Value::Object(mut map) => {
            map.remove("result");
            map.remove("reportState");
            Value::Object(map)
        }
        other => other,
    }
}

fn strip_transient_fit_model_fields(value: Value) -> Value {
    match value {
        Value::Object(mut map) => {
            map.remove("result");
            map.remove("plotRows");
            map.remove("reportState");
            Value::Object(map)
        }
        other => other,
    }
}

/// Write a `ProjectBundle` to disk as a zip archive at `path`.
///
/// Strategy: write to `<path>.tmp` first, then rename over the original. Gives
/// us a much safer path than a direct in-place overwrite on Windows.
pub fn write_project_archive(bundle: &ProjectBundle, path: &str) -> Result<(), AppError> {
    let tmp_path = format!("{}.tmp", path);
    {
        let file = std::fs::File::create(&tmp_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let dir_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        write_zip_json_entry_pretty(&mut zip, "manifest.json", &bundle.manifest, opts)?;

        // Emit explicit directory entries for every folder so extraction
        // produces the full tree (including empty folders the user created).
        // Also include implicit ancestors of any table/graph file path.
        let mut all_dirs: HashSet<String> = HashSet::new();
        for f in &bundle.manifest.folders {
            for anc in folder_ancestors(f) {
                all_dirs.insert(anc);
            }
        }
        for t in &bundle.manifest.tables {
            if let Some(parent) = parent_folder(&t.file) {
                for anc in folder_ancestors(&parent) {
                    all_dirs.insert(anc);
                }
            }
        }
        for g in &bundle.manifest.graphs {
            if let Some(parent) = parent_folder(&g.file) {
                for anc in folder_ancestors(&parent) {
                    all_dirs.insert(anc);
                }
            }
        }
        // Sort so the archive's central directory has a stable order.
        let mut dirs_sorted: Vec<String> = all_dirs.into_iter().collect();
        dirs_sorted.sort();
        for d in &dirs_sorted {
            zip.add_directory(format!("{}/", d), dir_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        // Map each TableDoc / GraphDoc by id so we can pair them with the
        // manifest entry that holds the authoritative archive path.
        let table_by_id: HashMap<&str, &TableDoc> =
            bundle.tables.iter().map(|t| (t.id.as_str(), t)).collect();
        let graph_by_id: HashMap<&str, &GraphDoc> =
            bundle.graphs.iter().map(|g| (g.id.as_str(), g)).collect();
        let distribution_by_id: HashMap<&str, &DistributionArchiveRecordV1> = bundle
            .distributions
            .iter()
            .map(|record| (record.analysis_id(), record))
            .collect();
        let formula_by_id: HashMap<&str, &DerivedFormulaArchiveEnvelopeV1> = bundle
            .derived_formulas
            .iter()
            .map(|envelope| (envelope.body.formula_id.as_str(), envelope))
            .collect();

        for entry in &bundle.manifest.tables {
            if let Some(doc) = table_by_id.get(entry.id.as_str()) {
                write_zip_json_entry(&mut zip, &entry.file, doc, opts)?;
            }
        }
        for entry in &bundle.manifest.graphs {
            if let Some(doc) = graph_by_id.get(entry.id.as_str()) {
                write_zip_json_entry(&mut zip, &entry.file, doc, opts)?;
            }
        }
        for entry in &bundle.manifest.distributions {
            if let Some(record) = distribution_by_id.get(entry.analysis_id.as_str()) {
                let bytes = match record {
                    DistributionArchiveRecordV1::Parsed(envelope) => serde_json::to_vec(envelope),
                    DistributionArchiveRecordV1::UnknownVersion { raw_envelope, .. } => {
                        serde_json::to_vec(raw_envelope)
                    }
                    DistributionArchiveRecordV1::Corrupt { raw_text, .. } => {
                        Ok(raw_text.as_bytes().to_vec())
                    }
                }
                .map_err(|error| AppError::FileIO(error.to_string()))?;
                write_zip_entry(&mut zip, &entry.file, &bytes, opts)?;
            }
        }
        for entry in &bundle.manifest.derived_formulas {
            if let Some(envelope) = formula_by_id.get(entry.formula_id.as_str()) {
                write_zip_json_entry(&mut zip, &entry.file, envelope, opts)?;
            }
        }
        if !bundle.history.is_empty() {
            write_zip_json_entry(&mut zip, ".history.json", &bundle.history, opts)?;
        }
        if !bundle.snapshots.is_empty() {
            write_zip_json_entry(&mut zip, ".snapshots.json", &bundle.snapshots, opts)?;
        }
        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
    }

    if let Err(error) = run_before_destination_mutation_hook(path, &tmp_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    if std::path::Path::new(path).exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn write_zip_entry<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    data: &[u8],
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    zip.write_all(data)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

fn write_zip_json_entry<W: Write + Seek, T: Serialize>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &T,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    serde_json::to_writer(&mut *zip, value).map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

fn write_zip_json_entry_pretty<W: Write + Seek, T: Serialize>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &T,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    serde_json::to_writer_pretty(&mut *zip, value).map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

// ----------------------------------------------------------------------------
// Single-file table / graph IO (for share / re-import workflows)
// ----------------------------------------------------------------------------

/// Write a single `TableDoc` to a `.sptb` file (just JSON on disk for now).
pub fn write_table_file(doc: &TableDoc, path: &str) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Read a `.sptb` file from disk into a `TableDoc`.
pub fn read_table_file(path: &str) -> Result<TableDoc, AppError> {
    let bytes = std::fs::read(path)?;
    let doc: TableDoc = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid .sptb file: {}", e)))?;
    Ok(doc)
}

/// Write a single `GraphDoc` to a `.spgh` file.
pub fn write_graph_file(doc: &GraphDoc, path: &str) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Read a `.spgh` file from disk into a `GraphDoc`.
pub fn read_graph_file(path: &str) -> Result<GraphDoc, AppError> {
    let bytes = std::fs::read(path)?;
    parse_graph_doc(&bytes, "").map_err(|e| AppError::FileIO(format!("Invalid .spgh file: {}", e)))
}

/// Tolerant `.spgh` parser. Reads the bytes into a generic `serde_json::Value`
/// first so legacy files written before this fix — which carry a duplicate
/// top-level `id` key (one from the named struct field, one re-emitted by the
/// flattened `body`) — still load. `serde_json::Map` keeps only the last value
/// for duplicate keys, so the resulting map has a single `id` entry. We then
/// lift `id`, `name`, and `version` into the named struct fields so `body` no
/// longer carries them. Any in-body `folder` field from pre-#7 files is
/// silently discarded — the folder a graph lives in is now decided purely by
/// the archive path. `fallback_id` is used when the file omits `id` entirely.
fn parse_graph_doc(bytes: &[u8], fallback_id: &str) -> Result<GraphDoc, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut map = match value {
        Value::Object(m) => m,
        _ => return Err("graph file is not a JSON object".into()),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            map.remove("builderId")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_else(|| fallback_id.to_string());
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let version = map
        .remove("version")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(default_doc_version);
    // Pre-#7 files may have stuffed a `folder` field inside the body —
    // strip it so it can never override the path-derived folder.
    map.remove("folder");
    Ok(GraphDoc {
        id,
        name,
        version,
        body: map,
    })
}

// ----------------------------------------------------------------------------
// Folder + name helpers
// ----------------------------------------------------------------------------

/// Characters disallowed inside a folder or file name segment. Matches the
/// strictest cross-platform filesystem rules so that extracted archives are
/// portable to any OS.
const FORBIDDEN_NAME_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_windows_reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default();
    WINDOWS_RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str())
}

pub(crate) fn validate_portable_basename(name: &str, subject: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{subject} cannot be empty"));
    }
    if name.starts_with(|c: char| c.is_whitespace() || c == '.')
        || name.ends_with(|c: char| c.is_whitespace() || c == '.')
    {
        return Err(format!(
            "{subject} has leading or trailing whitespace/dot: {}",
            name
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!("{subject} contains control character: {}", name));
    }
    if name.chars().any(|ch| FORBIDDEN_NAME_CHARS.contains(&ch)) {
        return Err(format!(
            "{subject} contains invalid filesystem characters: {}",
            name
        ));
    }
    if is_windows_reserved_stem(name) {
        return Err(format!(
            "{subject} is a reserved Windows device name: {}",
            name
        ));
    }
    Ok(())
}

pub(crate) fn normalize_unsafe_portable_basename(name: &str, fallback: &str) -> String {
    let sanitize = |source: &str| -> String {
        source
            .chars()
            .map(|ch| {
                if ch.is_control() || FORBIDDEN_NAME_CHARS.contains(&ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect::<String>()
            .trim_matches(|ch: char| ch.is_whitespace() || ch == '.')
            .to_string()
    };

    let mut candidate = sanitize(name);
    if candidate.is_empty() {
        candidate = sanitize(fallback);
    }
    if candidate.is_empty() {
        candidate = "untitled".to_string();
    }
    if is_windows_reserved_stem(&candidate) {
        candidate = format!("_{candidate}");
    }
    candidate
}

/// Sanitize a user-visible name for use as an archive filename component.
/// Replaces forbidden chars with `_`, trims leading/trailing whitespace and
/// dots, and falls back to `fallback` (typically the entry id) if the result
/// is empty.
pub fn sanitize_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if FORBIDDEN_NAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalize a folder path. Returns `None` for root (empty / `None` / `"/"`).
/// Splits on `/` and `\`, sanitizes each segment, and rejoins with `/`.
pub fn normalize_folder(folder: Option<&str>) -> Option<String> {
    let raw = folder?.trim();
    if raw.is_empty() {
        return None;
    }
    let segs: Vec<String> = raw
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty())
        .map(|s| sanitize_name(s, "_"))
        .collect();
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    }
}

/// Normalize a list of folder paths and add implicit ancestors so the writer
/// can emit a complete directory tree on extraction.
fn normalize_folder_list(folders: Vec<String>) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    for f in folders {
        if let Some(norm) = normalize_folder(Some(&f)) {
            for anc in folder_ancestors(&norm) {
                out.insert(anc);
            }
        }
    }
    let mut sorted: Vec<String> = out.into_iter().collect();
    sorted.sort();
    sorted
}

/// Parent folder of an archive entry path, or `None` if at root.
pub fn parent_folder(file: &str) -> Option<String> {
    let idx = file.rfind('/')?;
    Some(file[..idx].to_string())
}

/// All ancestor folder paths of `folder`, including `folder` itself, in
/// shallow-to-deep order (e.g. `["a", "a/b", "a/b/c"]`). Returns empty vec
/// when the input is empty.
fn folder_ancestors(folder: &str) -> Vec<String> {
    let parts: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::with_capacity(parts.len());
    for i in 1..=parts.len() {
        out.push(parts[..i].join("/"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn table_doc(id: &str, name: &str) -> TableDoc {
        TableDoc {
            id: id.into(),
            name: name.into(),
            source_type: "manual".into(),
            version: "1".into(),
            columns: vec![],
            rows: vec![],
        }
    }

    fn graph_doc(id: &str, name: &str) -> GraphDoc {
        GraphDoc {
            id: id.into(),
            name: name.into(),
            version: "1".into(),
            body: serde_json::Map::new(),
        }
    }

    fn build_bundle(
        name: String,
        version: String,
        created_at: String,
        tables: Vec<TableDoc>,
        graphs: Vec<GraphDoc>,
        fit_y_by_x: Vec<Value>,
        tabulates: Vec<Value>,
        folders: Vec<String>,
        table_folders: &HashMap<String, String>,
        graph_folders: &HashMap<String, String>,
        fit_y_by_x_folders: &HashMap<String, String>,
        tabulate_folders: &HashMap<String, String>,
        history: Vec<Value>,
        snapshots: Vec<Value>,
    ) -> ProjectBundle {
        super::build_bundle(
            name,
            version,
            created_at,
            tables,
            graphs,
            fit_y_by_x,
            Vec::new(),
            tabulates,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            folders,
            table_folders,
            graph_folders,
            fit_y_by_x_folders,
            &HashMap::new(),
            tabulate_folders,
            &HashMap::new(),
            history,
            snapshots,
        )
    }

    #[test]
    fn build_bundle_uses_stable_id_paths_and_explicit_folder_maps() {
        let table = table_doc("table-id", "Sales");
        let graph = graph_doc("graph-id", "Revenue");
        let table_folders = HashMap::from([(String::from("table-id"), String::from("Raw/2026"))]);
        let graph_folders = HashMap::from([(String::from("graph-id"), String::from("Reports"))]);

        let bundle = build_bundle(
            "Project".into(),
            "3.0.0".into(),
            "now".into(),
            vec![table],
            vec![graph],
            vec![],
            vec![],
            vec!["Raw/2026".into(), "Reports".into()],
            &table_folders,
            &graph_folders,
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );

        assert_eq!(bundle.manifest.tables[0].file, "tables/table-id.sptb");
        assert_eq!(bundle.manifest.graphs[0].file, "graphs/graph-id.spgh");
        assert_eq!(bundle.manifest.table_folders.as_ref(), Some(&table_folders));
        assert_eq!(bundle.manifest.graph_folders.as_ref(), Some(&graph_folders));
    }

    #[test]
    fn manifest_round_trip_preserves_empty_folder_maps() {
        let manifest = ProjectManifest {
            name: "Project".into(),
            version: "3.0.0".into(),
            created_at: "now".into(),
            tables: vec![],
            graphs: vec![],
            folders: vec![],
            table_folders: Some(HashMap::new()),
            graph_folders: Some(HashMap::new()),
            fit_y_by_x: vec![],
            fit_y_by_x_folders: HashMap::new(),
            fit_models: vec![],
            fit_model_folders: HashMap::new(),
            tabulates: vec![],
            tabulate_folders: HashMap::new(),
            distributions: vec![],
            derived_formulas: vec![],
            distribution_issues: vec![],
            distribution_folders: HashMap::new(),
        };

        let json = serde_json::to_vec(&manifest).expect("serialize manifest");
        let round_trip: ProjectManifest =
            serde_json::from_slice(&json).expect("deserialize manifest");

        assert_eq!(round_trip.table_folders, Some(HashMap::new()));
        assert_eq!(round_trip.graph_folders, Some(HashMap::new()));
        assert!(round_trip.fit_y_by_x.is_empty());
        assert!(round_trip.fit_y_by_x_folders.is_empty());
    }

    use serde_json::json;

    fn temp_project_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "statsplayground-spprj-{}-{}.spprj",
            name,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn tabulate_round_trip_preserves_opaque_json_and_folder_map() {
        let path = temp_project_path("tabulate-round-trip");
        let tabulate = json!({
            "id": "tab-1",
            "name": "Tabulate 1",
            "sourceDatasetId": "table-1",
            "rowFields": ["Region"],
            "columnFields": [],
            "statistics": [],
        });
        let folders = HashMap::from([("tab-1".to_string(), "Reports".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![tabulate.clone()],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.tabulates, vec![tabulate.clone()]);
        assert_eq!(loaded.manifest.tabulate_folders, folders);
        assert_eq!(loaded.tabulates, vec![tabulate]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_round_trip_preserves_opaque_json_and_folder_map() {
        let path = temp_project_path("fit-y-by-x-round-trip");
        let fit = json!({
            "id": "fit-1",
            "sourceDatasetId": "table-1",
            "response": { "name": "height", "type": "continuous" },
            "factor": { "name": "site", "type": "nominal" }
        });
        let folders = HashMap::from([("fit-1".to_string(), "Analyses".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            vec![fit.clone()],
            Vec::new(),
            vec!["Analyses".to_string()],
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.fit_y_by_x, vec![fit.clone()]);
        assert_eq!(loaded.manifest.fit_y_by_x_folders, folders);
        assert_eq!(loaded.fit_y_by_x, vec![fit]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_model_round_trip_preserves_definition_and_strips_transient_results() {
        let path = temp_project_path("fit-model-round-trip");
        let fit_model = json!({
            "id": "fit-model-1",
            "name": "Fit Model 1",
            "sourceDatasetId": "table-1",
            "response": { "name": "yield", "type": "continuous" },
            "terms": [{ "kind": "main", "columnNames": ["temperature"] }],
            "centeringMethod": "none",
            "createdAt": "2026-09-02T00:00:00Z",
            "result": { "kind": "fitted" },
            "plotRows": [{ "observed": 1.0 }],
            "reportState": { "status": "success" }
        });
        let expected = json!({
            "id": "fit-model-1",
            "name": "Fit Model 1",
            "sourceDatasetId": "table-1",
            "response": { "name": "yield", "type": "continuous" },
            "terms": [{ "kind": "main", "columnNames": ["temperature"] }],
            "centeringMethod": "none",
            "createdAt": "2026-09-02T00:00:00Z"
        });
        let fit_model_folders =
            HashMap::from([("fit-model-1".to_string(), "Analyses".to_string())]);
        let empty_folders = HashMap::new();

        let bundle = super::build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-09-02T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![fit_model],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec!["Analyses".to_string()],
            &empty_folders,
            &empty_folders,
            &empty_folders,
            &fit_model_folders,
            &empty_folders,
            &empty_folders,
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.fit_models, vec![expected.clone()]);
        assert_eq!(loaded.manifest.fit_model_folders, fit_model_folders);
        assert_eq!(loaded.fit_models, vec![expected]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_archive_preserves_definition_fields_without_computed_results() {
        let path = temp_project_path("fit-y-by-x-definition-only");
        let fit = json!({
            "id": "fit-1",
            "name": "Fit Y by X 2",
            "sourceDatasetId": "table-1",
            "response": { "name": "height", "type": "continuous" },
            "factor": { "name": "age", "type": "continuous" },
            "personality": "bivariate",
            "graph": {
                "mode": "2d",
                "modeStates": {
                    "twoD": {
                        "encoding": {
                            "x": { "name": "age", "type": "continuous" },
                            "y": { "name": "height", "type": "continuous" }
                        },
                        "multiX": [],
                        "multiY": [],
                        "elements": [
                            { "kind": "points", "enabled": true },
                            {
                                "kind": "fitline",
                                "enabled": true,
                                "options": { "fitType": "polynomial", "degree": 1, "showFitCI": true }
                            }
                        ],
                        "smootherLambda": 0.4
                    },
                    "threeD": {
                        "encoding": {},
                        "elements": [{ "kind": "scatter3d", "enabled": true }],
                        "smootherLambda": 0.4
                    },
                    "multivariate": {
                        "columns": [],
                        "chartType": "correlationMatrix",
                        "correlationMethod": "pearson"
                    }
                },
                "filters": [],
                "sampling": { "mode": "full" }
            },
            "result": {
                "kind": "bivariate",
                "usedRows": 42,
                "excludedRows": 3,
                "summaryOfFit": {
                    "rsquare": 0.91,
                    "rsquareAdj": 0.9,
                    "rootMeanSquareError": 1.25,
                    "meanOfResponse": 18.4,
                    "observations": 42
                },
                "parameterEstimates": [
                    {
                        "term": "Intercept",
                        "estimate": 1.5,
                        "stdError": 0.2,
                        "tRatio": 7.5,
                        "probGtAbsT": 0.001
                    },
                    {
                        "term": "age",
                        "estimate": 0.8,
                        "stdError": 0.1,
                        "tRatio": 8.0,
                        "probGtAbsT": 0.001
                    }
                ]
            },
            "reportState": {
                "selectedTab": "report",
                "expandedSections": ["summaryOfFit", "parameterEstimates"]
            },
            "createdAt": "2026-08-31T00:00:00.000Z"
        });
        let mut expected_fit = fit.clone();
        expected_fit
            .as_object_mut()
            .expect("fit should be an object")
            .remove("result");
        expected_fit
            .as_object_mut()
            .expect("fit should be an object")
            .remove("reportState");
        let folders = HashMap::from([("fit-1".to_string(), "Analyses/Bivariate".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-31T00:00:00.000Z".to_string(),
            Vec::new(),
            Vec::new(),
            vec![fit.clone()],
            Vec::new(),
            vec!["Analyses".to_string(), "Analyses/Bivariate".to_string()],
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let archive = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        let mut manifest_entry = zip.by_name("manifest.json").unwrap();
        let mut manifest_bytes = Vec::new();
        manifest_entry.read_to_end(&mut manifest_bytes).unwrap();
        let manifest_json: Value = serde_json::from_slice(&manifest_bytes).unwrap();

        let persisted_fit = manifest_json
            .get("fitYByX")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_object)
            .unwrap();

        assert_eq!(persisted_fit.get("name"), fit.get("name"));
        assert_eq!(persisted_fit.get("response"), fit.get("response"));
        assert_eq!(persisted_fit.get("factor"), fit.get("factor"));
        assert_eq!(persisted_fit.get("personality"), fit.get("personality"));
        assert_eq!(persisted_fit.get("graph"), fit.get("graph"));
        assert_eq!(persisted_fit.get("createdAt"), fit.get("createdAt"));
        assert!(!persisted_fit.contains_key("result"));
        assert!(!persisted_fit.contains_key("reportState"));

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.manifest.fit_y_by_x, vec![expected_fit.clone()]);
        assert_eq!(loaded.fit_y_by_x, vec![expected_fit]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tabulate_missing_manifest_fields_default_cleanly() {
        let path = temp_project_path("tabulate-defaults");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({
            "name": "Compat Project",
            "version": "2.0.0",
            "createdAt": "2026-08-14T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": [],
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(&manifest_bytes).unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(loaded.manifest.tabulates.is_empty());
        assert!(loaded.manifest.tabulate_folders.is_empty());
        assert!(loaded.tabulates.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_missing_manifest_fields_default_cleanly() {
        let path = temp_project_path("fit-y-by-x-defaults");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({
            "name": "Compat Project",
            "version": "2.0.0",
            "createdAt": "2026-08-14T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": [],
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(&manifest_bytes).unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(loaded.manifest.fit_y_by_x.is_empty());
        assert!(loaded.manifest.fit_y_by_x_folders.is_empty());
        assert!(loaded.fit_y_by_x.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_archive_accepts_table_entry_without_deep_table_body_validation() {
        let path = temp_project_path("validate-table-open-only");

        let mut table = table_doc("table-1", "Table 1");
        table.rows = (0_i64..40_000_i64)
            .map(|row| vec![json!(row), json!(row * 2), json!(format!("row-{row}"))])
            .collect();
        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen_clone = std::sync::Arc::clone(&seen);
        install_test_validate_table_entry_open_hook(Some(Box::new(
            move |entry_name, entry_size, body_bytes_read| {
                if entry_name.ends_with(".sptb") {
                    seen_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                    assert!(entry_size > 1_000_000);
                    assert_eq!(body_bytes_read, 0);
                }
                Ok(())
            },
        )));

        validate_archive_manifest_and_entries(&path, &bundle.manifest, &[]).unwrap();
        install_test_validate_table_entry_open_hook(None);

        assert!(seen.load(std::sync::atomic::Ordering::SeqCst));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_archive_rejects_missing_expected_table_entry() {
        let path = temp_project_path("validate-missing-entry");
        let missing_path = temp_project_path("validate-missing-entry-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&missing_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            if entry.name().ends_with(".sptb") {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            output_zip.write_all(&bytes).unwrap();
        }
        output_zip.finish().unwrap();

        let error = validate_archive_manifest_and_entries(&missing_path, &bundle.manifest, &[])
            .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("missing table entry"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(missing_path);
    }

    #[test]
    fn validate_archive_rejects_truncated_archive_file() {
        let path = temp_project_path("validate-truncated-archive");
        let truncated_path = temp_project_path("validate-truncated-archive-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let mut bytes = std::fs::read(&path).unwrap();
        bytes.truncate(bytes.len().saturating_sub(24));
        std::fs::write(&truncated_path, &bytes).unwrap();

        let error = validate_archive_manifest_and_entries(&truncated_path, &bundle.manifest, &[])
            .unwrap_err();
        assert!(matches!(error, AppError::FileIO(_)));

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(truncated_path);
    }

    #[test]
    fn validate_archive_rejects_missing_manifest() {
        let path = temp_project_path("validate-missing-manifest");
        let missing_manifest_path = temp_project_path("validate-missing-manifest-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&missing_manifest_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            if entry.name() == "manifest.json" {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            output_zip.write_all(&bytes).unwrap();
        }
        output_zip.finish().unwrap();

        let error =
            validate_archive_manifest_and_entries(&missing_manifest_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("missing manifest.json"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(missing_manifest_path);
    }

    #[test]
    fn validate_archive_rejects_invalid_manifest_json() {
        let path = temp_project_path("validate-bad-manifest");
        let bad_manifest_path = temp_project_path("validate-bad-manifest-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&bad_manifest_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            if entry.name() == "manifest.json" {
                output_zip.write_all(br#"{"name":"broken""#).unwrap();
            } else {
                output_zip.write_all(&bytes).unwrap();
            }
        }
        output_zip.finish().unwrap();

        let error =
            validate_archive_manifest_and_entries(&bad_manifest_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Invalid manifest.json"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(bad_manifest_path);
    }
}

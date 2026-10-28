use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHeader {
    pub project_id: String,
    pub format_version: String,
    pub minimum_reader: u32,
    pub minimum_writer: u32,
    pub committed_revision: u64,
    pub created_at: String,
    pub engine_version: String,
    pub storage_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetGeneration {
    pub id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRevision {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRevision {
    pub key: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWriteContext {
    pub operation_id: String,
    pub expected_project_id: String,
    pub expected_epoch: u64,
    pub expected_revision: u64,
    #[serde(default)]
    pub request_digest: String,
    #[serde(default)]
    pub document_revisions: Vec<DocumentRevision>,
    #[serde(default)]
    pub dataset_generations: Vec<DatasetGeneration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommit<T> {
    pub operation_id: String,
    pub epoch: u64,
    pub committed_revision: u64,
    pub value: T,
    pub changed_dataset_generations: Vec<DatasetGeneration>,
    #[serde(default,skip_serializing_if="Vec::is_empty")]
    pub changed_dataset_metadata:Vec<crate::models::table::DatasetMeta>,
    pub changed_document_revisions: Vec<DocumentRevision>,
    #[serde(default)]
    pub changed_setting_revisions: Vec<SettingRevision>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_filter_settings: Vec<ProjectSettingRecord>,
    #[serde(default)]
    pub changed_history_entries: Vec<ProjectHistorySummary>,
    #[serde(default)]
    pub changed_directory_entries: Vec<ProjectDocumentSummary>,
    #[serde(default)]
    pub deleted_directory_ids: Vec<String>,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(tag="status",rename_all="camelCase",rename_all_fields="camelCase")]
// Keep the typed receipt inline in this IPC response envelope.
#[allow(clippy::large_enum_variant)]
pub enum ProjectOperationResolution {
    Committed {commit:ProjectCommit<serde_json::Value>},
    Cancelled {operation_id:String,epoch:u64,committed_revision:u64},
}



#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectDocumentKind {
    Table,
    Graph,
    GraphNew,
    Analysis,
    Report,
    Tabulate,
    Workflow,
    Transform,
    Snapshot,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocumentSummary {
    pub id: String,
    pub kind: ProjectDocumentKind,
    pub name: String,
    pub folder: String,
    pub revision: u64,
    pub dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocumentBody {
    pub summary: ProjectDocumentSummary,
    pub schema_version: u32,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWrite {
    pub expected_revision: Option<u64>,
    pub document: ProjectDocumentBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryMove {
    pub id: String,
    pub expected_revision: u64,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingRecord {
    pub key: String,
    pub revision: u64,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingWrite {
    pub key: String,
    pub expected_revision: Option<u64>,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectRecordPatch {
    pub documents: Vec<DocumentWrite>,
    pub deleted_document_ids: Vec<String>,
    pub settings: Vec<ProjectSettingWrite>,
    pub directory_moves: Vec<DirectoryMove>,
    pub created_folders: Vec<String>,
    pub deleted_folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPageRequest {
    pub after: Option<String>,
    pub limit: usize,
}

impl Default for CatalogPageRequest {
    fn default() -> Self {
        Self {
            after: None,
            limit: 200,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<ProjectDocumentSummary>,
    pub next_cursor: Option<String>,
    pub committed_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageRequest {
    pub dataset_id: Option<String>,
    pub after: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTableLifecycleEvent {
    pub id:String,
    pub dataset_id:String,
    #[serde(default)]
    pub dataset_generation:Option<u64>,
    pub operation:String,
    pub applied:bool,
    pub revision:u64,
    pub history_ordinal:u64,
    pub project_revision:u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistorySummary {
    pub id: String,
    pub dataset_id: String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub dataset_name:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub description:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub timestamp:Option<String>,
    pub operation: String,
    pub applied: bool,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryPage {
    pub items: Vec<ProjectHistorySummary>,
    pub next_cursor: Option<String>,
    pub committed_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenSummary {
    pub project: crate::models::project::ProjectInfo,
    pub header: ProjectHeader,
    pub epoch: u64,
    pub writable: bool,
    pub directory: CatalogPage,
    pub settings_revision: u64,
    pub datasets: Vec<crate::models::table::DatasetMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshotOutcome {
    pub active: Option<ProjectOpenSummary>,
    pub error: Option<String>,
    pub destination_published: bool,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectMigrationPreflight {
    pub format_version:String,
    pub destination:std::path::PathBuf,
    pub destination_exists:bool,
    pub required_writer:u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPersistenceStatus {
    pub epoch: u64,
    pub committed_revision: u64,
    pub writable: bool,
}

/// Existing IPC keeps its legacy value shape; native calls carry a durable receipt.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
// The legacy generic payload and native receipt share the existing wire shape.
#[allow(clippy::large_enum_variant)]
pub enum ProjectMutationResult<T> {
    Legacy(T),
    Committed(ProjectCommit<T>),
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectPasteRequest {
    pub dataset_id:String,
    pub start_row:usize,
    pub start_col:usize,
    pub rows:Vec<Vec<String>>,
    pub header_names:Option<Vec<String>>,
    pub col_types:Vec<String>,
    pub expected_generation:u64,
    pub row_ids:Option<Vec<i64>>,
    pub column_ids:Vec<String>,
}

/// A named data snapshot descriptor never contains table row arrays or storage paths.
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectDataSnapshotDescriptor {
    pub id:String,
    pub name:String,
    pub revision:u64,
    pub created_at:String,
    pub table_count:usize,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectDataSnapshotPage {
    pub items:Vec<ProjectDataSnapshotDescriptor>,
    pub next_cursor:Option<String>,
    pub committed_revision:u64,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectDataSnapshotRestored {
    pub kind:String,
    pub snapshot_id:String,
    pub table_history_reset:bool,
    #[serde(default)]
    pub table_count:usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProjectWorkflowRunState {
    pub workflow_id:String,
    pub workflow_revision:u64,
    pub committed_revision:u64,
    pub total_count:u64,
    pub latest_run_id:Option<String>,
    pub latest_output_bindings:Option<Vec<crate::services::workflow_domain::WorkflowOutputBinding>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryFrontier {
    pub entry: Option<ProjectHistorySummary>,
    pub committed_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTableImportResult { pub id: String }

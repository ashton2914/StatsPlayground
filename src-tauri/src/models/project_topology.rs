use serde::{Deserialize, Serialize};
use super::project_persistence::ProjectDocumentKind;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectTableNode { pub id:String, pub name:String, pub folder:String, pub revision:u64 }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectTransformInput { pub role:String, pub table_id:String }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectTransformLink {
    pub id:String, pub name:String, pub revision:u64, pub operation_kind:String, pub folder:String,
    pub inputs:Vec<ProjectTransformInput>, pub output_table_id:String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectOwnedDocument { pub id:String, pub kind:ProjectDocumentKind, pub table_id:String, pub revision:u64, pub name:String, pub folder:String, pub analysis_kind:Option<String> }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectTopologyDiagnostic { pub code:String, pub id:String }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectTopology {
    pub epoch:u64, pub committed_revision:u64, pub folders:Vec<String>, pub tables:Vec<ProjectTableNode>,
    pub transforms:Vec<ProjectTransformLink>, pub owned_documents:Vec<ProjectOwnedDocument>,
    pub diagnostics:Vec<ProjectTopologyDiagnostic>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub enum ProjectActionScope { Component, Descendants }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectActionPreview {
    pub epoch:u64, pub committed_revision:u64, pub target_table_id:String, pub scope:ProjectActionScope,
    pub table_ids:Vec<String>, pub transform_ids:Vec<String>, pub owned_document_ids:Vec<String>,
    pub blockers:Vec<ProjectTopologyDiagnostic>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ProjectGroupMoveRequest { pub target_table_id:String, pub destination_folder:String, pub expected_topology_revision:u64 }
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectGroupCopyResult { pub table_ids:Vec<String>, pub id_map:std::collections::BTreeMap<String,String> }

#[derive(Debug,Clone,Serialize,Deserialize,schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectGroupExportRequest {pub target_table_id:String,pub file_path:String,pub expected_topology_revision:u64}
#[derive(Debug,Clone,Serialize,Deserialize,schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectGroupImportRequest {pub file_path:String,pub destination_folder:String}
#[derive(Debug,Clone,Serialize,Deserialize,schemars::JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct ProjectGroupTransferResult {pub file_path:String,pub table_count:usize,pub source_revision:u64}

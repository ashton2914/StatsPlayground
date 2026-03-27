use serde::{Deserialize, Serialize};

/// Project metadata stored in .spprj file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub file_path: String,
    pub created_at: String,
}

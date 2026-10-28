use super::project_database::ProjectDatabase;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDescriptor {
    pub project_id: String,
    pub display_name: String,
    pub recovery_id: String,
}
#[derive(Serialize, Deserialize)]
struct RegistryEntry {
    descriptor: DraftDescriptor,
    named: bool,
}
pub struct ProjectDraftRegistry;
impl ProjectDraftRegistry {
    pub fn create(registry_root: &Path) -> Result<ProjectDatabase, AppError> {
        std::fs::create_dir_all(registry_root)?;
        let recovery_id = uuid::Uuid::new_v4().to_string();
        let database =
            ProjectDatabase::create(&registry_root.join(format!("{recovery_id}.spprj")), true)?;
        let entry = RegistryEntry {
            descriptor: DraftDescriptor {
                project_id: database.header()?.project_id,
                display_name: "Untitled".into(),
                recovery_id: recovery_id.clone(),
            },
            named: false,
        };
        Self::write(registry_root, &recovery_id, &entry)?;
        Ok(database)
    }
    fn write(root: &Path, id: &str, entry: &RegistryEntry) -> Result<(), AppError> {
        use std::io::Write;
        let mut temporary = tempfile::Builder::new()
            .prefix(".draft-registry-")
            .tempfile_in(root)?;
        temporary
            .write_all(&serde_json::to_vec(entry).map_err(|e| AppError::FileIO(e.to_string()))?)?;
        temporary.as_file().sync_all()?;
        super::streaming_project_writer::replace_archive_atomically_os(
            temporary.path(),
            &root.join(format!("{id}.json")),
        )?;
        #[cfg(unix)]
        std::fs::File::open(root)?.sync_all()?;
        Ok(())
    }
    fn read(root: &Path, id: &str) -> Result<RegistryEntry, AppError> {
        let parsed = uuid::Uuid::parse_str(id)
            .map_err(|_| AppError::InvalidParam("project_recovery_id_invalid".into()))?;
        if parsed.to_string() != id {
            return Err(AppError::InvalidParam("project_recovery_id_invalid".into()));
        }
        let path = root.join(format!("{id}.json"));
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(AppError::InvalidParam(
                "project_recovery_path_invalid".into(),
            ));
        }
        let bytes = std::fs::read(path)?;
        let entry: RegistryEntry =
            serde_json::from_slice(&bytes).map_err(|e| AppError::FileIO(e.to_string()))?;
        if entry.descriptor.recovery_id != id {
            return Err(AppError::InvalidParam("project_recovery_id_invalid".into()));
        }
        Ok(entry)
    }
    pub fn resolve(root: &Path, id: &str) -> Result<PathBuf, AppError> {
        let entry = Self::read(root, id)?;
        if entry.named {
            return Err(AppError::InvalidParam("project_draft_already_named".into()));
        }
        let path = root.join(format!("{id}.spprj"));
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(AppError::InvalidParam(
                "project_recovery_path_invalid".into(),
            ));
        }
        let root = std::fs::canonicalize(root)?;
        let path = std::fs::canonicalize(path)?;
        if path.parent() != Some(root.as_path()) {
            return Err(AppError::InvalidParam(
                "project_recovery_path_invalid".into(),
            ));
        }
        Ok(path)
    }
    pub fn list_recoverable(root: &Path) -> Result<Vec<DraftDescriptor>, AppError> {
        if !root.exists() {
            return Ok(vec![]);
        }
        let mut entries = vec![];
        for file in std::fs::read_dir(root)? {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            let path = file.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            let entry = Self::read(root, id)?;
            if !entry.named {
                Self::resolve(root, id)?;
                entries.push(entry.descriptor);
            }
        }
        entries.sort_by(|a, b| a.recovery_id.cmp(&b.recovery_id));
        Ok(entries)
    }
    pub fn mark_named(root: &Path, project_id: &str) -> Result<(), AppError> {
        for descriptor in Self::list_recoverable(root)? {
            if descriptor.project_id == project_id {
                let mut entry = Self::read(root, &descriptor.recovery_id)?;
                entry.named = true;
                Self::write(root, &descriptor.recovery_id, &entry)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_v5_lifecycle_draft_registry_survives_restart_without_exposing_paths() {
        let root = tempfile::tempdir().unwrap();
        let database = ProjectDraftRegistry::create(root.path()).unwrap();
        let id = database.header().unwrap().project_id;
        let path = database.path().to_path_buf();
        database.prepare_close(database.epoch()).unwrap();
        drop(database);
        std::fs::write(root.path().join("unknown-recovery.spprj"), b"retain").unwrap();
        let entries = ProjectDraftRegistry::list_recoverable(root.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].project_id, id);
        let json = serde_json::to_string(&entries[0]).unwrap();
        assert!(!json.contains(&path.to_string_lossy().to_string()));
        assert!(!json.contains("path"));
        assert_eq!(
            ProjectDraftRegistry::resolve(root.path(), &entries[0].recovery_id).unwrap(),
            path
        );
        assert!(ProjectDraftRegistry::resolve(root.path(), "../unknown").is_err());
        ProjectDraftRegistry::mark_named(root.path(), &id).unwrap();
        assert!(ProjectDraftRegistry::list_recoverable(root.path())
            .unwrap()
            .is_empty());
        assert!(path.exists(), "naming never deletes the recovery copy");
        assert_eq!(
            std::fs::read(root.path().join("unknown-recovery.spprj")).unwrap(),
            b"retain"
        );
    }
}

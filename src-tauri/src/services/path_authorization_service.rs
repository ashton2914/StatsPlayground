use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputRootGrant {
    pub root_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedCsvTargetInspection {
    pub target_exists: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutputPathStatus {
    CreateNew,
    OverwriteExisting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedOutputPath {
    pub path: PathBuf,
    pub status: OutputPathStatus,
}

#[derive(Default)]
pub struct PathAuthorizationService {
    roots: HashMap<String, AuthorizedRoot>,
}

#[derive(Clone, Debug)]
struct AuthorizedRoot {
    canonical_path: PathBuf,
    resolved_path: PathBuf,
}

impl PathAuthorizationService {
    pub fn authorize_output_root(&mut self, root_path: &Path) -> Result<OutputRootGrant, AppError> {
        if !root_path.is_absolute() {
            return Err(AppError::InvalidParam(
                "output root must be an absolute directory path".to_string(),
            ));
        }

        let canonical_root = fs::canonicalize(root_path).map_err(|error| {
            AppError::InvalidParam(format!("output root must be an existing directory: {error}"))
        })?;
        if !canonical_root.is_dir() {
            return Err(AppError::InvalidParam(
                "output root must be a directory".to_string(),
            ));
        }

        let root_id = Uuid::new_v4().to_string();
        let display_name = output_root_display_name(&canonical_root);
        self.roots.insert(
            root_id.clone(),
            AuthorizedRoot {
                canonical_path: canonical_root,
                resolved_path: root_path.to_path_buf(),
            },
        );

        Ok(OutputRootGrant {
            root_id,
            display_name,
        })
    }

    pub fn revoke_output_root(&mut self, root_id: &str) -> Result<(), AppError> {
        self.roots.remove(root_id).map(|_| ()).ok_or_else(|| {
            AppError::InvalidParam(format!("unknown output root id: {root_id}"))
        })
    }

    pub fn resolve_output(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<ResolvedOutputPath, AppError> {
        let root = self.roots.get(root_id).ok_or_else(|| {
            AppError::InvalidParam(format!("unknown output root id: {root_id}"))
        })?;

        let relative = Path::new(relative_path);
        if relative_path.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "relative output path must not be empty".to_string(),
            ));
        }
        if relative.is_absolute() {
            return Err(AppError::InvalidParam(
                "relative output path must not be absolute".to_string(),
            ));
        }

        let mut target = root.resolved_path.clone();
        for component in relative.components() {
            match component {
                Component::Normal(segment) => target.push(segment),
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(AppError::InvalidParam(
                        "relative output path must not contain parent traversal".to_string(),
                    ));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(AppError::InvalidParam(
                        "relative output path must stay within the authorized root".to_string(),
                    ));
                }
            }
        }

        let existing_ancestor = nearest_existing_ancestor(&target).ok_or_else(|| {
            AppError::InvalidParam("relative output path has no existing authorized parent".to_string())
        })?;
        let canonical_ancestor = fs::canonicalize(&existing_ancestor)?;
        if !canonical_ancestor.starts_with(&root.canonical_path) {
            return Err(AppError::InvalidParam(
                "relative output path escapes the authorized root".to_string(),
            ));
        }

        if target.exists() && target.is_dir() {
            return Err(AppError::InvalidParam(
                "output path must reference a file, not a directory".to_string(),
            ));
        }

        let target_exists = relative_target_exists(&target)?;

        Ok(ResolvedOutputPath {
            path: target,
            status: if target_exists {
                OutputPathStatus::OverwriteExisting
            } else {
                OutputPathStatus::CreateNew
            },
        })
    }
}

fn output_root_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "root".to_string())
}

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

fn relative_target_exists(path: &Path) -> Result<bool, AppError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::FileIO(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::{OutputPathStatus, PathAuthorizationService};
    use crate::error::AppError;
    use tempfile::TempDir;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn service() -> PathAuthorizationService {
        PathAuthorizationService::default()
    }

    #[test]
    fn resolve_output_rejects_absolute_relative_paths() {
        let temp = TempDir::new().expect("temp dir");
        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        let error = service
            .resolve_output(&grant.root_id, "/tmp/out.csv")
            .expect_err("absolute relative-path must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    fn resolve_output_rejects_parent_traversal() {
        let temp = TempDir::new().expect("temp dir");
        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        let error = service
            .resolve_output(&grant.root_id, "../escape.csv")
            .expect_err("parent traversal must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    fn resolve_output_rejects_missing_root_id() {
        let service = service();
        let error = service
            .resolve_output("missing-root", "nested/out.csv")
            .expect_err("unknown root id must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    #[cfg(unix)]
    fn resolve_output_rejects_symlink_escape() {
        let temp = TempDir::new().expect("temp dir");
        let escape_root = TempDir::new().expect("escape dir");
        std::fs::create_dir_all(temp.path().join("nested")).expect("nested dir");
        symlink(escape_root.path(), temp.path().join("nested").join("outside"))
            .expect("symlink escape");

        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        let error = service
            .resolve_output(&grant.root_id, "nested/outside/leak.csv")
            .expect_err("symlink escape must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    fn resolve_output_allows_nested_new_file_when_existing_parent_is_safe() {
        let temp = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(temp.path().join("nested").join("safe")).expect("safe parent");

        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        let resolved = service
            .resolve_output(&grant.root_id, "nested/safe/new-export.csv")
            .expect("resolve nested new file");

        assert_eq!(resolved.path, temp.path().join("nested").join("safe").join("new-export.csv"));
        assert_eq!(resolved.status, OutputPathStatus::CreateNew);
    }

    #[test]
    fn revoked_root_cannot_be_used_again() {
        let temp = TempDir::new().expect("temp dir");
        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        service
            .revoke_output_root(&grant.root_id)
            .expect("revoke root");

        let error = service
            .resolve_output(&grant.root_id, "out.csv")
            .expect_err("revoked root must be rejected");

        assert!(matches!(error, AppError::InvalidParam(_)));
    }

    #[test]
    fn resolve_output_classifies_existing_target_as_overwrite() {
        let temp = TempDir::new().expect("temp dir");
        let target = temp.path().join("nested").join("existing.csv");
        std::fs::create_dir_all(target.parent().expect("target parent")).expect("target parent dir");
        std::fs::write(&target, b"existing").expect("seed target");

        let mut service = service();
        let grant = service
            .authorize_output_root(temp.path())
            .expect("authorize root");

        let resolved = service
            .resolve_output(&grant.root_id, "nested/existing.csv")
            .expect("resolve existing target");

        assert_eq!(resolved.path, target);
        assert_eq!(resolved.status, OutputPathStatus::OverwriteExisting);
    }

    #[test]
    #[cfg(unix)]
    fn authorize_filesystem_root_uses_non_absolute_display_name() {
        let mut service = service();

        let grant = service
            .authorize_output_root(std::path::Path::new("/"))
            .expect("authorize filesystem root");

        assert!(!grant.display_name.starts_with('/'));
        assert!(!grant.display_name.is_empty());
    }
}
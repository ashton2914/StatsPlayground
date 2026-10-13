//! Publish the bundled instructions without replacing workspace-authored skills.
use crate::{error::AppError, services::vscode_workspace::failure};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

const MANIFEST: &str = ".github/skills/.sp-built-in.json";
const FILES: &[(&str, &str)] = &[
    (
        ".github/skills/sp-mcp-guide/SKILL.md",
        include_str!("../../../built-in-skills/sp-mcp-guide/SKILL.md"),
    ),
    (
        ".github/skills/sp-mcp-guide/references/tools.md",
        include_str!("../../../built-in-skills/sp-mcp-guide/references/tools.md"),
    ),
    (
        ".github/skills/sp-mcp-guide/references/examples.json",
        include_str!("../../../built-in-skills/sp-mcp-guide/references/examples.json"),
    ),
    (
        ".github/skills/sp-distribution-analyze/SKILL.md",
        include_str!("../../../built-in-skills/sp-distribution-analyze/SKILL.md"),
    ),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncSummary {
    pub directory: &'static str,
    pub installed: Vec<String>,
    pub updated: Vec<String>,
    pub unchanged: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    files: BTreeMap<String, String>,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn io_error(_: std::io::Error) -> AppError {
    failure("Cannot synchronize built-in skills. Check workspace permissions.")
}

// Open each component separately and reject links before traversing it. All paths
// are from the embedded allowlist; directory handles keep writes inside the root.
fn parent(root: &Dir, path: &str, create: bool) -> Result<Option<Dir>, AppError> {
    let mut dir = root.try_clone().map_err(io_error)?;
    let components: Vec<_> = path.split('/').collect();
    for name in &components[..components.len() - 1] {
        reject_link(&dir, name)?;
        if create && !dir.try_exists(name).map_err(io_error)? {
            dir.create_dir(name).map_err(io_error)?;
        }
        match dir.open_dir(name) {
            Ok(next) => dir = next,
            Err(e) if !create && e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(Some(dir))
}
fn reject_link(dir: &Dir, name: &str) -> Result<(), AppError> {
    match dir.symlink_metadata(name) {
        Ok(meta) => {
            let linked = meta.file_type().is_symlink();
            #[cfg(windows)]
            let linked = {
                use cap_std::fs::MetadataExt;
                linked || meta.file_attributes() & 0x400 != 0
            };
            if linked {
                return Err(failure("A built-in skill path is a symbolic link or reparse point. Choose another workspace."));
            }
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e)),
    }
}
fn read(root: &Dir, path: &str) -> Result<Option<Vec<u8>>, AppError> {
    let Some(dir) = parent(root, path, false)? else {
        return Ok(None);
    };
    let name = path.rsplit('/').next().unwrap();
    reject_link(&dir, name)?;
    match dir.metadata(name) {
        Ok(meta) if !meta.is_file() || meta.len() > 2 * 1024 * 1024 => {
            return Err(failure(
                "A built-in skill target is not a regular file or exceeds 2 MiB.",
            ))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
        _ => (),
    }
    dir.read(name).map(Some).map_err(io_error)
}
fn identity(dir: &Dir) -> Result<same_file::Handle, AppError> {
    same_file::Handle::from_file(dir.try_clone().map_err(io_error)?.into_std_file())
        .map_err(io_error)
}
fn directories(root: &Dir) -> Result<BTreeMap<String, Option<same_file::Handle>>, AppError> {
    let mut result = BTreeMap::new();
    result.insert(String::new(), Some(identity(root)?));
    for (path, _) in FILES.iter().copied().chain(std::iter::once((MANIFEST, ""))) {
        let parts: Vec<_> = path.split('/').collect();
        for length in 1..parts.len() {
            let path = parts[..length].join("/");
            let probe = format!("{path}/probe");
            let handle = parent(root, &probe, false)?
                .as_ref()
                .map(identity)
                .transpose()?;
            result.insert(path, handle);
        }
    }
    Ok(result)
}

pub struct SkillInstallPlan {
    path: PathBuf,
    root: Dir,
    sources: BTreeMap<String, Option<Vec<u8>>>,
    identities: BTreeMap<String, Option<same_file::Handle>>,
    pub summary: SkillSyncSummary,
}
impl SkillInstallPlan {
    pub fn inspect(path: &Path) -> Result<Self, AppError> {
        let root = Dir::open_ambient_dir(path, ambient_authority()).map_err(io_error)?;
        let identities = directories(&root)?;
        let mut sources = BTreeMap::new();
        let old_manifest = read(&root, MANIFEST)?;
        let manifest = match &old_manifest {
            Some(bytes) => {
                let m: Manifest = serde_json::from_slice(bytes).map_err(|_| {
                    failure("Invalid built-in skill manifest. Resolve it before launching.")
                })?;
                if m.schema_version != 1 {
                    return Err(failure("Unsupported built-in skill manifest version."));
                }
                m
            }
            None => Manifest::default(),
        };
        let mut summary = SkillSyncSummary {
            directory: ".github/skills",
            installed: vec![],
            updated: vec![],
            unchanged: vec![],
        };
        for &(name, bundled) in FILES {
            let current = read(&root, name)?;
            match &current {
                None => summary.installed.push(name.into()),
                Some(bytes) if bytes == bundled.as_bytes() => summary.unchanged.push(name.into()),
                Some(bytes) if manifest.files.get(name) == Some(&hash(bytes)) => summary.updated.push(name.into()),
                Some(_) => return Err(failure(&format!("Built-in skill conflict: {name} contains workspace changes. Back up or move that file before launching; it was not overwritten."))),
            }
            sources.insert(name.into(), current);
        }
        sources.insert(MANIFEST.into(), old_manifest);
        Ok(Self {
            path: path.to_owned(),
            root,
            sources,
            identities,
            summary,
        })
    }
    pub fn validate(&self) -> Result<(), AppError> {
        let current = Dir::open_ambient_dir(&self.path, ambient_authority()).map_err(io_error)?;
        if directories(&current)? != self.identities {
            return Err(failure(
                "Skill launch plan is stale. Select the workspace again.",
            ));
        }
        for (name, source) in &self.sources {
            if read(&current, name)? != *source {
                return Err(failure(
                    "Skill files changed after preview. Select the workspace again.",
                ));
            }
        }
        Ok(())
    }
    pub fn install(mut self) -> Result<SkillSyncSummary, AppError> {
        self.validate()?;
        for &(path, _) in FILES {
            parent(&self.root, path, true)?;
        }
        // Newly created directories are now part of the freshness boundary.
        let current = Dir::open_ambient_dir(&self.path, ambient_authority()).map_err(io_error)?;
        if identity(&current)? != identity(&self.root)? {
            return Err(failure("Workspace changed during skill synchronization."));
        }
        let new_identities = directories(&current)?;
        for (path, expected) in &self.identities {
            if expected.is_some() && new_identities.get(path) != Some(expected) {
                return Err(failure("Skill directory changed during synchronization."));
            }
        }
        self.identities = new_identities;
        self.validate()?;
        let manifest = Manifest {
            schema_version: 1,
            files: FILES
                .iter()
                .map(|(name, bytes)| ((*name).into(), hash(bytes.as_bytes())))
                .collect(),
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|_| failure("Cannot encode skill manifest."))?;
        let mut written: Vec<(String, Vec<u8>, Option<Vec<u8>>)> = vec![];
        let result = (|| {
            for (path, bytes) in FILES
                .iter()
                .map(|(p, b)| (*p, b.as_bytes()))
                .chain(std::iter::once((MANIFEST, manifest_bytes.as_slice())))
            {
                self.validate()?;
                let old = self.sources[path].clone();
                if old.as_deref() == Some(bytes) {
                    continue;
                }
                let write_result =
                    atomic_write(&self.root, path, bytes, old.as_deref(), || self.validate());
                if read(&self.root, path)?.as_deref() == Some(bytes) {
                    written.push((path.into(), bytes.to_vec(), old));
                }
                write_result?;
                self.sources.insert(path.into(), Some(bytes.to_vec()));
            }
            self.validate()
        })();
        if let Err(error) = result {
            // Restore only bytes we wrote, never changes made by another writer.
            for (path, bytes, old) in written.into_iter().rev() {
                if directories(
                    &Dir::open_ambient_dir(&self.path, ambient_authority()).map_err(io_error)?,
                )? != self.identities
                {
                    return Err(failure("Skill synchronization failed and workspace paths changed. Inspect the partial installation before retrying."));
                }
                if read(&self.root, &path)?.as_deref() != Some(bytes.as_slice()) {
                    return Err(failure("Skill synchronization failed with concurrent edits. Inspect the partial installation before retrying."));
                }
                if let Some(old) = old {
                    atomic_write(&self.root, &path, &old, Some(&bytes), || Ok(()))?;
                } else {
                    atomic_remove(&self.root, &path, &bytes, || Ok(()))?;
                }
            }
            return Err(error);
        }
        Ok(self.summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn publishes_both_skills_and_repeated_install_preserves_other_skills() {
        let workspace = TempDir::new().unwrap();
        let summary = SkillInstallPlan::inspect(workspace.path())
            .unwrap()
            .install()
            .unwrap();
        assert_eq!(summary.installed.len(), 4);
        let other = workspace.path().join(".github/skills/user-skill");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("SKILL.md"), "user instructions").unwrap();
        let summary = SkillInstallPlan::inspect(workspace.path())
            .unwrap()
            .install()
            .unwrap();
        assert!(summary.installed.is_empty());
        assert!(summary.updated.is_empty());
        assert_eq!(summary.unchanged.len(), 4);
        assert_eq!(
            std::fs::read_to_string(other.join("SKILL.md")).unwrap(),
            "user instructions"
        );
    }
    #[test]
    fn modified_skill_blocks_install_without_changing_it() {
        let workspace = TempDir::new().unwrap();
        SkillInstallPlan::inspect(workspace.path())
            .unwrap()
            .install()
            .unwrap();
        let path = workspace
            .path()
            .join(".github/skills/sp-distribution-analyze/SKILL.md");
        std::fs::write(&path, "user customization").unwrap();
        assert!(SkillInstallPlan::inspect(workspace.path()).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "user customization");
    }
    #[test]
    fn edit_during_staging_is_preserved() {
        let workspace = TempDir::new().unwrap();
        let root = Dir::open_ambient_dir(workspace.path(), ambient_authority()).unwrap();
        root.write("SKILL.md", b"old managed bytes").unwrap();
        let result = atomic_write(
            &root,
            "SKILL.md",
            b"new bundled bytes",
            Some(b"old managed bytes"),
            || {
                root.write("SKILL.md", b"concurrent user edit").unwrap();
                Ok(())
            },
        );
        assert!(
            result.is_err(),
            "staging must not overwrite concurrent user content"
        );
        assert_eq!(root.read("SKILL.md").unwrap(), b"concurrent user edit");
    }
    #[test]
    fn rollback_preserves_a_user_save_between_check_and_delete() {
        let workspace = TempDir::new().unwrap();
        let root = Dir::open_ambient_dir(workspace.path(), ambient_authority()).unwrap();
        root.write("SKILL.md", b"published bytes").unwrap();
        let result = atomic_remove(&root, "SKILL.md", b"published bytes", || {
            root.write("SKILL.md", b"user save during rollback")
                .unwrap();
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(root.read("SKILL.md").unwrap(), b"user save during rollback");
    }
    #[test]
    fn updates_only_previously_published_bytes() {
        let workspace = TempDir::new().unwrap();
        SkillInstallPlan::inspect(workspace.path())
            .unwrap()
            .install()
            .unwrap();
        let path = ".github/skills/sp-mcp-guide/SKILL.md";
        std::fs::write(workspace.path().join(path), "previous bundled version").unwrap();
        let mut manifest: Manifest =
            serde_json::from_slice(&std::fs::read(workspace.path().join(MANIFEST)).unwrap())
                .unwrap();
        manifest
            .files
            .insert(path.into(), hash(b"previous bundled version"));
        std::fs::write(
            workspace.path().join(MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let plan = SkillInstallPlan::inspect(workspace.path()).unwrap();
        assert_eq!(plan.summary.updated, vec![path]);
        plan.install().unwrap();
        assert_ne!(
            std::fs::read_to_string(workspace.path().join(path)).unwrap(),
            "previous bundled version"
        );
    }
    #[test]
    fn preview_is_read_only_and_late_edits_are_not_overwritten() {
        let workspace = TempDir::new().unwrap();
        let plan = SkillInstallPlan::inspect(workspace.path()).unwrap();
        assert!(!workspace.path().join(".github").exists());
        std::fs::create_dir_all(workspace.path().join(".github/skills/sp-mcp-guide")).unwrap();
        let path = workspace
            .path()
            .join(".github/skills/sp-mcp-guide/SKILL.md");
        std::fs::write(&path, "late edit").unwrap();
        assert!(plan.install().is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "late edit");
    }
    #[test]
    fn invalid_manifest_is_preserved() {
        let workspace = TempDir::new().unwrap();
        std::fs::create_dir_all(workspace.path().join(".github/skills")).unwrap();
        std::fs::write(workspace.path().join(MANIFEST), "malformed").unwrap();
        assert!(SkillInstallPlan::inspect(workspace.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(workspace.path().join(MANIFEST)).unwrap(),
            "malformed"
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_linked_paths_without_writing_outside_workspace() {
        use std::os::unix::fs::symlink;
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), workspace.path().join(".github")).unwrap();
        assert!(SkillInstallPlan::inspect(workspace.path()).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn replaced_directory_invalidates_plan_even_when_bytes_match() {
        let workspace = TempDir::new().unwrap();
        SkillInstallPlan::inspect(workspace.path())
            .unwrap()
            .install()
            .unwrap();
        let plan = SkillInstallPlan::inspect(workspace.path()).unwrap();
        std::fs::rename(
            workspace.path().join(".github"),
            workspace.path().join("old-github"),
        )
        .unwrap();
        std::fs::create_dir_all(workspace.path().join(".github/skills")).unwrap();
        assert!(plan.install().is_err());
    }
}
fn atomic_write(
    root: &Dir,
    path: &str,
    bytes: &[u8],
    expected: Option<&[u8]>,
    validate: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let dir = parent(root, path, false)?.ok_or_else(|| failure("Skill directory disappeared."))?;
    let name = path.rsplit('/').next().unwrap();
    reject_link(&dir, name)?;
    let temp = format!(".sp-skill-{}.tmp", uuid::Uuid::new_v4());
    let backup = format!(".sp-skill-{}.backup", uuid::Uuid::new_v4());
    let mut displaced = false;
    let mut published = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = dir.open_with(&temp, &options).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        validate()?;
        reject_link(&dir, name)?;
        if let Some(expected) = expected {
            // Keep the actual displaced inode until verification completes. A
            // concurrent save between preview and replacement is recoverable.
            dir.rename(name, &dir, &backup).map_err(io_error)?;
            displaced = true;
            if dir.read(&backup).map_err(io_error)? != expected {
                return Err(failure(
                    "Skill changed during synchronization. User changes were preserved.",
                ));
            }
        }
        // Publishing with a link is atomic and cannot clobber a concurrently
        // created target. Both files are on the same workspace filesystem.
        dir.hard_link(&temp, &dir, name).map_err(io_error)?;
        published = true;
        if dir.read(name).map_err(io_error)? != bytes {
            return Err(failure("Skill read-back verification failed."));
        }
        if displaced {
            if dir.read(&backup).map_err(io_error)?.as_slice() != expected.unwrap() {
                return Err(failure(
                    "Skill changed during synchronization. User changes were preserved.",
                ));
            }
            dir.remove_file(&backup).map_err(io_error)?;
            displaced = false;
        }
        Ok(())
    })();
    if result.is_err() && displaced {
        // A replacement written by another actor stays untouched. In that case
        // retain the displaced file beside it rather than overwrite either.
        if published && dir.read(name).ok().as_deref() == Some(bytes) {
            let _ = atomic_remove(root, path, bytes, || Ok(()));
        }
        if dir.hard_link(&backup, &dir, name).is_ok() {
            let _ = dir.remove_file(&backup);
        } else {
            return Err(failure(&format!("Skill synchronization interrupted by concurrent edits. The previous file is preserved as {backup}; inspect it before retrying.")));
        }
    }
    if dir.try_exists(&temp).unwrap_or(false) {
        let _ = dir.remove_file(&temp);
    }
    result
}

fn atomic_remove(
    root: &Dir,
    path: &str,
    expected: &[u8],
    validate: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let dir = parent(root, path, false)?.ok_or_else(|| failure("Skill directory disappeared."))?;
    let name = path.rsplit('/').next().unwrap();
    if read(root, path)?.as_deref() != Some(expected) {
        return Err(failure("Skill rollback encountered user changes."));
    }
    validate()?;
    reject_link(&dir, name)?;
    let backup = format!(".sp-skill-{}.rollback", uuid::Uuid::new_v4());
    dir.rename(name, &dir, &backup).map_err(io_error)?;
    match dir.read(&backup) {
        Ok(bytes) if bytes == expected => dir.remove_file(&backup).map_err(io_error),
        _ => {
            if dir.hard_link(&backup, &dir, name).is_ok() {
                let _ = dir.remove_file(&backup);
                Err(failure(
                    "Skill rollback encountered concurrent user changes; they were preserved.",
                ))
            } else {
                Err(failure(&format!("Skill rollback encountered concurrent edits. The displaced file is preserved as {backup}; inspect it before retrying.")))
            }
        }
    }
}

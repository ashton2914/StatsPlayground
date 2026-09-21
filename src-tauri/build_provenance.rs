#[derive(Debug, PartialEq, Eq)]
pub struct GitProvenance {
    pub source_commit: String,
    pub source_dirty: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BuildProvenance {
    pub source_commit: String,
    pub source_dirty: bool,
    pub qualification_available: bool,
}

pub fn resolve_build_provenance(
    perf_harness_enabled: bool,
    load_git: impl FnOnce() -> Result<GitProvenance, String>,
) -> Result<BuildProvenance, String> {
    if !perf_harness_enabled {
        return Ok(BuildProvenance {
            source_commit: "unavailable".into(),
            source_dirty: true,
            qualification_available: false,
        });
    }
    let git = load_git()?;
    if git.source_commit.is_empty() {
        return Err("Git returned an empty source commit".into());
    }
    Ok(BuildProvenance {
        source_commit: git.source_commit,
        source_dirty: git.source_dirty,
        qualification_available: true,
    })
}

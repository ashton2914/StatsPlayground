#[path = "../build_provenance.rs"]
mod build_provenance;

use build_provenance::{resolve_build_provenance, GitProvenance};

#[test]
fn ordinary_build_succeeds_without_invoking_git() {
    let metadata =
        resolve_build_provenance(false, || panic!("ordinary builds must not invoke Git"))
            .expect("ordinary no-git build metadata");

    assert_eq!(metadata.source_commit, "unavailable");
    assert!(metadata.source_dirty);
    assert!(!metadata.qualification_available);
}

#[test]
fn perf_harness_build_fails_closed_without_git() {
    let error = resolve_build_provenance(true, || {
        Err("git executable or repository unavailable".into())
    })
    .expect_err("qualification build must require Git");

    assert!(error.contains("git executable or repository unavailable"));
}

#[test]
fn perf_harness_build_uses_authoritative_git_metadata() {
    let metadata = resolve_build_provenance(true, || {
        Ok(GitProvenance {
            source_commit: "0123456789abcdef".into(),
            source_dirty: false,
        })
    })
    .expect("qualification metadata");

    assert_eq!(metadata.source_commit, "0123456789abcdef");
    assert!(!metadata.source_dirty);
    assert!(metadata.qualification_available);
}

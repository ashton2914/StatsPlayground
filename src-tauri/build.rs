use std::path::{Path, PathBuf};
use std::process::Command;

mod build_provenance;

use build_provenance::{resolve_build_provenance, GitProvenance};

fn git(manifest_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("--no-pager")
        .arg("-C")
        .arg(manifest_dir)
        .args(args)
        .output()
        .map_err(|error| format!("failed to execute git {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("git {} returned non-UTF-8 output: {error}", args.join(" ")))
}

fn git_optional(manifest_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("--no-pager")
        .arg("-C")
        .arg(manifest_dir)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn watch_git_path(path: PathBuf) {
    println!("cargo:rerun-if-changed={}", path.display());
}

fn load_git_provenance(manifest_dir: &Path) -> Result<GitProvenance, String> {
    Ok(GitProvenance {
        source_commit: git(manifest_dir, &["rev-parse", "HEAD"])?,
        source_dirty: !git(
            manifest_dir,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        )?
        .is_empty(),
    })
}

fn project_v5_source_fingerprint(root:&Path)->Result<String,String> {
    use std::io::Write;
    use std::process::Stdio;
    const SCOPES:&str=include_str!("../scripts/projectV5SourceScopes.json");
    // Shared scope list; parse this string-only JSON without adding build dependencies.
    let scopes=SCOPES.trim().trim_start_matches('[').trim_end_matches(']').split(',').map(|value|value.trim().trim_matches('"')).collect::<Vec<_>>();
    let listing=Command::new("git").arg("--no-pager").arg("-C").arg(root).args(["ls-files","--cached","--others","--exclude-standard","-z","--"]).args(&scopes).output().map_err(|e|e.to_string())?;
    if !listing.status.success(){return Err("could not enumerate source files".into());}
    let listing=String::from_utf8(listing.stdout).map_err(|e|e.to_string())?;
    let files=listing.split('\0').filter(|value|!value.is_empty()).collect::<std::collections::BTreeSet<_>>();
    let mut bytes=b"StatsPlayground source fingerprint v1\0".to_vec();
    for name in files {
        let path=root.join(name);watch_git_path(path.clone());bytes.extend_from_slice(name.as_bytes());bytes.push(0);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>bytes.push(0),
            Err(error)=>return Err(error.to_string()),
            Ok(metadata)=>{if !metadata.is_file(){return Err(format!("source fingerprint requires a regular file: {name}"));}
                let body=std::fs::read(path).map_err(|e|e.to_string())?;bytes.push(1);bytes.extend_from_slice(&(body.len() as u64).to_le_bytes());bytes.extend_from_slice(&body);
            }
        }
    }
    let mut child=Command::new("git").arg("--no-pager").arg("-C").arg(root).args(["hash-object","--stdin"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    child.stdin.take().ok_or("source hash stdin unavailable")?.write_all(&bytes).map_err(|e|e.to_string())?;
    let output=child.wait_with_output().map_err(|e|e.to_string())?;
    if !output.status.success(){return Err("could not hash source tree".into());}
    String::from_utf8(output.stdout).map(|value|value.trim().to_string()).map_err(|e|e.to_string())
}

fn main() {
    // Force cargo to re-run this build script (which re-embeds the bundle
    // icons into the binary) whenever any file under icons/ changes.
    // Without this, `tauri dev` keeps showing a stale dock icon after the
    // PNG/ICNS files are regenerated.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=examples");
    println!("cargo:rerun-if-changed=tests");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=build_provenance.rs");
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../tests");
    println!("cargo:rerun-if-changed=../docs");
    println!("cargo:rerun-if-changed=../scripts");

    let manifest_dir = match std::env::var_os("CARGO_MANIFEST_DIR") {
        Some(value) => PathBuf::from(value),
        None => panic!("CARGO_MANIFEST_DIR must be set"),
    };
    let perf_harness_enabled = std::env::var_os("CARGO_FEATURE_PERF_HARNESS").is_some();
    let provenance =
        match resolve_build_provenance(perf_harness_enabled, || load_git_provenance(&manifest_dir))
        {
            Ok(value) => value,
            Err(error) => panic!("perf-harness source provenance unavailable: {error}"),
        };
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".into());

    println!(
        "cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_COMMIT={}",
        provenance.source_commit
    );
    println!(
        "cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_DIRTY={}",
        provenance.source_dirty
    );
    println!(
        "cargo:rustc-env=STATSPLAYGROUND_QUALIFICATION_AVAILABLE={}",
        provenance.qualification_available
    );
    println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_BUILD_PROFILE={profile}");

    if perf_harness_enabled {
        let source_root = PathBuf::from(
            git(&manifest_dir, &["rev-parse", "--show-toplevel"])
                .unwrap_or_else(|error| panic!("{error}")),
        );
        let fingerprint=project_v5_source_fingerprint(&source_root).unwrap_or_else(|error|panic!("perf source fingerprint unavailable: {error}"));
        println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH={fingerprint}");
        let git_dir = PathBuf::from(
            git(&manifest_dir, &["rev-parse", "--absolute-git-dir"])
                .unwrap_or_else(|error| panic!("{error}")),
        );
        let common_dir = PathBuf::from(
            git(&manifest_dir, &["rev-parse", "--git-common-dir"])
                .unwrap_or_else(|error| panic!("{error}")),
        );
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            source_root.join(common_dir)
        };
        watch_git_path(git_dir.join("HEAD"));
        watch_git_path(git_dir.join("index"));
        watch_git_path(common_dir.join("packed-refs"));
        if let Some(symbolic_head) = git_optional(&manifest_dir, &["symbolic-ref", "-q", "HEAD"]) {
            watch_git_path(common_dir.join(symbolic_head));
        }
    }

    if !perf_harness_enabled {println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_TREE_HASH=unavailable");}
    tauri_build::build()
}

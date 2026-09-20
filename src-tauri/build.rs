use std::path::{Path, PathBuf};
use std::process::Command;

fn git(manifest_dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(manifest_dir)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("failed to execute git {}: {error}", args.join(" ")));
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    String::from_utf8(output.stdout)
        .unwrap_or_else(|error| panic!("git {} returned non-UTF-8 output: {error}", args.join(" ")))
        .trim()
        .to_string()
}

fn git_optional(manifest_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
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

fn main() {
    // Force cargo to re-run this build script (which re-embeds the bundle
    // icons into the binary) whenever any file under icons/ changes.
    // Without this, `tauri dev` keeps showing a stale dock icon after the
    // PNG/ICNS files are regenerated.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=examples");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../tests");
    println!("cargo:rerun-if-changed=../docs");

    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"),
    );
    let source_commit = git(&manifest_dir, &["rev-parse", "HEAD"]);
    let source_root = PathBuf::from(git(&manifest_dir, &["rev-parse", "--show-toplevel"]));
    let source_dirty = !git(
        &manifest_dir,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .is_empty();
    let profile = std::env::var("PROFILE").expect("PROFILE must be set");

    println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_COMMIT={source_commit}");
    println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_SOURCE_DIRTY={source_dirty}");
    println!("cargo:rustc-env=STATSPLAYGROUND_BINARY_BUILD_PROFILE={profile}");

    let git_dir = PathBuf::from(git(&manifest_dir, &["rev-parse", "--absolute-git-dir"]));
    let common_dir = PathBuf::from(git(&manifest_dir, &["rev-parse", "--git-common-dir"]));
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

    tauri_build::build()
}

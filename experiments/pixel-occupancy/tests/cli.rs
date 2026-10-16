use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn real_files_match_across_storage_modes_and_refuse_overwrite_and_corruption() {
    let root = std::env::temp_dir().join(format!(
        "pixel-lab-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let bin = env!("CARGO_BIN_EXE_pixel-occupancy-lab");
    let data = root.join("points.bin");
    let gen = || {
        Command::new(bin)
            .args(["generate", "--data"])
            .arg(&data)
            .args(["--points", "100007", "--profile", "clusters"])
            .output()
            .unwrap()
    };
    assert!(gen().status.success());
    let before = fs::read(&data).unwrap();
    assert!(!gen().status.success());
    assert_eq!(fs::read(&data).unwrap(), before);
    let mut checksum = None;
    for storage in ["resident", "mmap", "stream"] {
        let out = root.join(storage);
        let r = Command::new(bin)
            .args(["run", "--data"])
            .arg(&data)
            .arg("--out")
            .arg(&out)
            .args([
                "--storage",
                storage,
                "--repeats",
                "1",
                "--width",
                "32",
                "--height",
                "32",
            ])
            .output()
            .unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(out.join("report.json")).unwrap()).unwrap();
        let rows = report["rows"].as_array().unwrap();
        let actual = rows.iter().find(|r| r["stage"] == "read_checksum").unwrap()["checksum"]
            .as_u64()
            .unwrap();
        if let Some(expected) = checksum {
            assert_eq!(actual, expected);
        }
        checksum = Some(actual);
        for r in rows.iter().filter(|r| r["stage"] == "indexed") {
            assert_eq!(r["missing_pixels"], 0);
            assert_eq!(r["extra_pixels"], 0);
        }
        assert!(out.join("full.ppm").exists());
        assert!(out.join("measurements.jsonl").exists());
    }
    // All records must be covered by the index, including the last partial block.
    let meta = data.with_extension("json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    value["blocks"][0]["len"] = serde_json::json!(1);
    fs::write(&meta, serde_json::to_vec(&value).unwrap()).unwrap();
    let bad = Command::new(bin)
        .args(["run", "--data"])
        .arg(&data)
        .arg("--out")
        .arg(root.join("bad"))
        .output()
        .unwrap();
    assert!(!bad.status.success());
    assert!(!root.join("bad/report.json").exists());
    fs::remove_dir_all(root).unwrap();
}

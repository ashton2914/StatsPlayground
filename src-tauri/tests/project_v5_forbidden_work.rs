#![cfg(all(feature="project-v5",feature="perf-harness"))]
#[allow(dead_code)]
#[path="support/project_v5.rs"] mod process;
#[test]
fn ordinary_small_edit_and_reopen_do_not_perform_bulk_lifecycle_work() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("bounded.spprj");process::run(&path,"seed",&["--rows","30000","--columns","20"]);
    for scenario in ["catalog","window","scroll","edit","close"] {
        let report=process::run(&path,scenario,&["--samples","2"]);assert_eq!(report["verification"]["passed"],true);
        assert_eq!(report["samples"].as_array().unwrap().len(),2);
        assert_eq!(report["source"]["treeHash"].as_str().unwrap().len(),40);
        for sample in report["samples"].as_array().unwrap() {
            for counter in ["archiveRestoredRows","archiveWriterCalls","fullDatabaseCopies","fullBeforeImageCopies","fullAnchorRebuilds"] {assert_eq!(sample["forbiddenWork"][counter],0,"{scenario}/{counter}");}
            assert!(sample["backendMs"].as_f64().unwrap().is_finite());
            assert_eq!(sample["verification"]["passed"],true);
            assert!(sample["uiReadyMs"].is_null(),"native process cannot observe rendered UI");
            if cfg!(target_os="macos") {assert!(sample["checkpointBytes"].as_u64().is_some());assert!(sample["checkpointMethod"].as_str().unwrap().contains("proc_pid_rusage"));}
            else{assert!(sample["checkpointBytes"].is_null());}
        }
    }
}

#[test]
fn real_bulk_controls_make_each_boundary_counter_nonzero() {
    let directory=tempfile::tempdir().unwrap();
    for (control,counters) in [
        ("archive",vec!["archiveRestoredRows","archiveWriterCalls"]),
        ("database-copy",vec!["fullDatabaseCopies"]),
        ("before-image",vec!["fullBeforeImageCopies"]),
        ("anchors",vec!["fullAnchorRebuilds"]),
        ("full-count",vec!["fullWindowCounts"]),
    ] {
        let path=directory.path().join(format!("{control}.spprj"));process::run(&path,"seed",&[]);
        let report=process::run(&path,"counter-control",&["--control",control]);
        assert_eq!(report["verification"]["passed"],true);
        for counter in counters {assert!(report["forbiddenWork"][counter].as_u64().unwrap()>0,"positive control {control}/{counter}");}
    }
}
#[test]
fn checkpoint_bytes_are_observed_at_the_checkpoint_boundary() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("checkpoint.spprj");process::run(&path,"seed",&[]);
    let report=process::run(&path,"counter-control",&["--control","checkpoint"]);
    assert_eq!(report["verification"]["passed"],true);
    if cfg!(target_os="macos") {
        assert!(report["checkpointBytes"].as_u64().unwrap()>0);
        assert!(report["checkpointMethod"].as_str().unwrap().contains("proc_pid_rusage"));
    }else{assert!(report["checkpointBytes"].is_null());}
}
#[test]
fn natural_window_probe_retains_actual_analyzed_sql_plans() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("profile.spprj");process::run(&path,"seed",&["--rows","300000","--columns","20"]);
    let report=process::run(&path,"profile",&[]);assert_eq!(report["verification"]["passed"],true);
    let profiles=report["profiling"]["queries"].as_array().unwrap();assert_eq!(profiles.len(),3);
    for query in profiles {assert!(query["plan"].is_object()||query["plan"].is_array());assert!(query["sql"].as_str().unwrap().contains("_row_order"));}
    assert_eq!(report["forbiddenWork"]["fullWindowCounts"],0);
}
fn source_scan_rows(plan:&serde_json::Value,scans:&mut Vec<u64>) {
    match plan {
        serde_json::Value::Object(fields)=>{
            if fields.get("operator_type").and_then(|value|value.as_str())==Some("TABLE_SCAN")&&plan["extra_info"]["Table"].as_str().is_some_and(|table|table.ends_with(".dataset_perf_data")) {
                scans.push(plan["operator_rows_scanned"].as_u64().expect("real scan-row observation"));
            }
            for value in fields.values(){source_scan_rows(value,scans);}
        },
        serde_json::Value::Array(values)=>for value in values{source_scan_rows(value,scans);},
        _=>{},
    }
}
#[test]
fn natural_window_queries_do_not_scan_the_full_source() {
    let directory=tempfile::tempdir().unwrap();
    for mode in ["fallback","materialized","mixed"] {
    let path=directory.path().join(format!("bounded-{mode}.spprj"));process::run(&path,"seed",&["--rows","300000","--columns","20","--order-mode",mode]);
    let report=process::run(&path,"profile",&[]);
    assert_eq!(report["profiling"]["verifiedNoFullScan"],true);
    for (index,query) in report["profiling"]["queries"].as_array().unwrap().iter().enumerate(){
        let mut scans=Vec::new();source_scan_rows(&query["plan"],&mut scans);
        assert!(!scans.is_empty(),"profile must contain a real user-table scan");
        let scanned:u64=scans.iter().sum();assert!(scanned<300000,"{mode} window {index} scanned {scanned} source rows while returning only500");
    }
    }
}

#[test]
fn stress_fixture_tiers_create_real_catalog_and_long_string_data() {
    let directory=tempfile::tempdir().unwrap();
    let many=process::run(&directory.path().join("many.spprj"),"seed",&["--rows","8","--columns","20","--tier","many-documents"]);
    assert_eq!(many["fixture"]["tier"],"many-documents");
    assert_eq!(many["fixture"]["tableCount"],501);assert_eq!(many["fixture"]["documentCount"],10001);
    let long=process::run(&directory.path().join("long.spprj"),"seed",&["--rows","8","--columns","20","--tier","long-strings"]);
    assert_eq!(long["fixture"]["tier"],"long-strings");assert_eq!(long["fixture"]["longStringChars"],512);
}

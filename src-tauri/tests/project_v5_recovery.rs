#![cfg(all(feature="project-v5",feature="perf-harness"))]
#[path="support/project_v5.rs"] mod process;

#[test]
fn committed_wal_recovers_exact_data_documents_history_and_receipts_in_a_fresh_process() {
    for mutation in ["cell","document"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("committed.spprj");
        let seed=process::run(&path,"seed",&["--rows","32","--columns","20","--seed","282"]);assert_eq!(seed["verification"]["passed"],true);
        let child=process::pause(&path,"crash-commit",mutation);
        let wal=std::path::PathBuf::from(format!("{}.wal",path.display()));assert!(std::fs::metadata(wal).unwrap().len()>0,"the recovery test must exercise committed WAL rather than a clean checkpoint");
        process::kill(child);
        let wal=std::path::PathBuf::from(format!("{}.wal",path.display()));let before_db=std::fs::read(&path).unwrap();let before_wal=std::fs::read(&wal).unwrap();
        assert!(process::rejected(&path,"verify",&["--read-only","true"]).contains("project_requires_writable_recovery"));
        assert_eq!(std::fs::read(&path).unwrap(),before_db);assert_eq!(std::fs::read(&wal).unwrap(),before_wal);
        let verified=process::run(&path,"verify",&["--mutation",mutation,"--expected-committed","true","--replay","true"]);
        assert_eq!(verified["verification"]["passed"],true);assert_eq!(verified["verification"]["receiptReplayed"],true);
        assert_eq!(verified["verification"]["cellValue"],if mutation=="cell"{999999}else{0});
        assert_eq!(verified["verification"]["historyCount"],if mutation=="cell"{1}else{0});
        assert_eq!(verified["verification"]["reportMarkdown"],if mutation=="document"{"changed in crash probe"}else{"initial report"});
    }
}

#[test]
fn killed_uncommitted_mutation_leaves_no_partial_data_document_or_history() {
    for mutation in ["cell","document"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("uncommitted.spprj");process::run(&path,"seed",&["--rows","32","--columns","20"]);
        process::kill(process::pause(&path,"crash-uncommitted",mutation));
        let verified=process::run(&path,"verify",&["--mutation",mutation,"--expected-committed","false"]);
        assert_eq!(verified["verification"]["passed"],true);assert_eq!(verified["verification"]["cellValue"],0);assert_eq!(verified["verification"]["historyCount"],0);assert_eq!(verified["verification"]["reportMarkdown"],"initial report");
    }
}


#[test]
fn writable_storage_recovery_never_initializes_or_upgrades_rejected_application_files() {
    for marker in ["unmarked","future"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("foreign.spprj");
        process::run(&path,"seed-invalid-marker",&["--marker",marker]);
        process::kill(process::pause_with(&path,"crash-invalid-marker",&["--marker",marker]));
        let report=process::run(&path,"verify-invalid-marker",&["--marker",marker]);
        assert_eq!(report["verification"]["passed"],true);assert_eq!(report["verification"]["applicationSchemaUnchanged"],true);assert_eq!(report["verification"]["projectInstalled"],false);assert_eq!(report["verification"]["sentinelValue"],999);
    }
}

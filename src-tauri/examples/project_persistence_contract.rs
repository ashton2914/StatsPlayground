fn main() {
    let path = std::env::args_os().nth(1).expect("project path argument required");
    if let Err(error) = stats_playground_lib::project_persistence_harness::serve(std::path::Path::new(&path)) {
        eprintln!("project_persistence_contract failed: {error}");
        std::process::exit(1);
    }
}

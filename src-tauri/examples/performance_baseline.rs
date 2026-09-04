fn main() {
    if let Err(error) = stats_playground_lib::perf_harness::run_cli() {
        eprintln!("performance_baseline failed: {error}");
        std::process::exit(1);
    }
}

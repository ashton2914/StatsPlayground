fn main() {
    if let Err(error)=stats_playground_lib::perf_project_v5::run() {eprintln!("project persistence probe failed: {error}");std::process::exit(1);}
}

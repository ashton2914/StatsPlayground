#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};
    use std::path::PathBuf;

    use crate::error::AppError;
    use crate::models::table::TableWindowRequest;
    use crate::services::data_service::DataService;
    use crate::services::spprj_archive::{self, GraphDoc};
    use crate::state::AppState;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CommandClass {
        Mutation,
        ReadOnly,
        SaveFlow,
    }

    fn parse_registered_commands(lib_source: &str) -> Vec<String> {
        let marker = "tauri::generate_handler![";
        let start = lib_source
            .find(marker)
            .expect("generate_handler list must exist")
            + marker.len();
        let rest = &lib_source[start..];
        let end = rest
            .find("])")
            .expect("generate_handler list must terminate with ])");
        rest[..end]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.trim_end_matches(','))
            .map(str::to_string)
            .collect()
    }

    fn command_classes() -> HashMap<&'static str, CommandClass> {
        HashMap::from([
            ("commands::data_commands::import_file", CommandClass::Mutation),
            ("commands::data_commands::list_datasets", CommandClass::ReadOnly),
            ("commands::data_commands::delete_dataset", CommandClass::Mutation),
            ("commands::data_commands::query_table", CommandClass::ReadOnly),
            (
                "commands::data_commands::query_table_window",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::get_dataset_generation",
                CommandClass::ReadOnly,
            ),
            ("commands::data_commands::locate_table_row", CommandClass::ReadOnly),
            (
                "commands::data_commands::query_table_filter_values",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::execute_sql_query",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::create_table_from_sql_query",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::create_table_from_rows",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::create_table", CommandClass::Mutation),
            ("commands::data_commands::add_row", CommandClass::Mutation),
            ("commands::data_commands::add_rows", CommandClass::Mutation),
            (
                "commands::data_commands::apply_added_rows",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::update_cell", CommandClass::Mutation),
            ("commands::data_commands::clear_cells", CommandClass::Mutation),
            ("commands::data_commands::update_cells", CommandClass::Mutation),
            ("commands::data_commands::delete_row", CommandClass::Mutation),
            ("commands::data_commands::delete_rows", CommandClass::Mutation),
            (
                "commands::data_commands::delete_rows_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::delete_columns_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::alter_column_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::alter_columns_type_with_change_set",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::rename_dataset", CommandClass::Mutation),
            ("commands::data_commands::add_column", CommandClass::Mutation),
            (
                "commands::data_commands::add_column_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::add_columns_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::insert_column_at",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::reorder_column", CommandClass::Mutation),
            (
                "commands::data_commands::reorder_column_if_generation",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::delete_column", CommandClass::Mutation),
            ("commands::data_commands::rename_column", CommandClass::Mutation),
            (
                "commands::data_commands::change_column_type",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::paste_at_position",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::paste_at_position_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::apply_table_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::drop_table_change_set",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::restore_snapshot", CommandClass::Mutation),
            (
                "commands::data_commands::get_column_display_props",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::set_column_display_props",
                CommandClass::Mutation,
            ),
            ("commands::stats_commands::get_column_stats", CommandClass::ReadOnly),
            (
                "commands::stats_commands::get_descriptive_stats",
                CommandClass::ReadOnly,
            ),
            ("commands::tabulate_commands::tabulate", CommandClass::ReadOnly),
            ("commands::io_commands::export_csv", CommandClass::ReadOnly),
            ("commands::io_commands::import_sqlite", CommandClass::Mutation),
            ("commands::io_commands::export_sqlite", CommandClass::ReadOnly),
            ("commands::io_commands::export_csv_zip", CommandClass::ReadOnly),
            (
                "commands::io_commands::export_csv_zip_subset",
                CommandClass::ReadOnly,
            ),
            (
                "commands::io_commands::export_sqlite_subset",
                CommandClass::ReadOnly,
            ),
            (
                "commands::history_commands::capture_project_snapshot",
                CommandClass::ReadOnly,
            ),
            (
                "commands::history_commands::restore_project_snapshot",
                CommandClass::Mutation,
            ),
            (
                "commands::graph_data_commands::stream_graph_data",
                CommandClass::ReadOnly,
            ),
            (
                "commands::graph_data_commands::cancel_graph_data",
                CommandClass::ReadOnly,
            ),
            ("commands::project_commands::init_project", CommandClass::Mutation),
            (
                "commands::project_commands::create_project",
                CommandClass::Mutation,
            ),
            ("commands::project_commands::open_project", CommandClass::Mutation),
            ("commands::project_commands::save_project", CommandClass::SaveFlow),
            (
                "commands::project_commands::get_current_project",
                CommandClass::ReadOnly,
            ),
            ("commands::project_commands::export_table", CommandClass::ReadOnly),
            (
                "commands::project_commands::export_tables_sptb_zip",
                CommandClass::ReadOnly,
            ),
            ("commands::project_commands::import_table", CommandClass::Mutation),
            ("commands::project_commands::export_graph", CommandClass::ReadOnly),
            ("commands::project_commands::import_graph", CommandClass::ReadOnly),
            ("commands::table_commands::get_columns", CommandClass::ReadOnly),
            ("commands::table_commands::sort_table", CommandClass::Mutation),
            ("commands::table_commands::subset_table", CommandClass::Mutation),
            (
                "commands::table_commands::transpose_table",
                CommandClass::Mutation,
            ),
            ("commands::table_commands::stack_table", CommandClass::Mutation),
            ("commands::table_commands::split_table", CommandClass::Mutation),
            ("commands::table_commands::summary_table", CommandClass::Mutation),
            ("commands::table_commands::join_tables", CommandClass::Mutation),
            ("commands::table_commands::update_table", CommandClass::Mutation),
            (
                "commands::table_commands::concatenate_tables",
                CommandClass::Mutation,
            ),
        ])
    }

    fn functions_requiring_mutation_permit() -> [(&'static str, &'static str); 48] {
        [
            ("data_commands.rs", "import_file"),
            ("data_commands.rs", "delete_dataset"),
            ("data_commands.rs", "create_table_from_sql_query"),
            ("data_commands.rs", "create_table_from_rows"),
            ("data_commands.rs", "create_table"),
            ("data_commands.rs", "add_row"),
            ("data_commands.rs", "add_rows"),
            ("data_commands.rs", "apply_added_rows"),
            ("data_commands.rs", "update_cell"),
            ("data_commands.rs", "clear_cells"),
            ("data_commands.rs", "update_cells"),
            ("data_commands.rs", "delete_row"),
            ("data_commands.rs", "delete_rows"),
            ("data_commands.rs", "delete_rows_with_change_set"),
            ("data_commands.rs", "delete_columns_with_change_set"),
            ("data_commands.rs", "alter_column_with_change_set"),
            ("data_commands.rs", "alter_columns_type_with_change_set"),
            ("data_commands.rs", "rename_dataset"),
            ("data_commands.rs", "add_column"),
            ("data_commands.rs", "add_column_with_change_set"),
            ("data_commands.rs", "add_columns_with_change_set"),
            ("data_commands.rs", "insert_column_at"),
            ("data_commands.rs", "reorder_column"),
            ("data_commands.rs", "reorder_column_if_generation"),
            ("data_commands.rs", "delete_column"),
            ("data_commands.rs", "rename_column"),
            ("data_commands.rs", "change_column_type"),
            ("data_commands.rs", "paste_at_position"),
            ("data_commands.rs", "paste_at_position_with_change_set"),
            ("data_commands.rs", "apply_table_change_set"),
            ("data_commands.rs", "drop_table_change_set"),
            ("data_commands.rs", "restore_snapshot"),
            ("data_commands.rs", "set_column_display_props"),
            ("table_commands.rs", "sort_table"),
            ("table_commands.rs", "subset_table"),
            ("table_commands.rs", "transpose_table"),
            ("table_commands.rs", "stack_table"),
            ("table_commands.rs", "split_table"),
            ("table_commands.rs", "summary_table"),
            ("table_commands.rs", "join_tables"),
            ("table_commands.rs", "update_table"),
            ("table_commands.rs", "concatenate_tables"),
            ("io_commands.rs", "import_sqlite"),
            ("history_commands.rs", "restore_project_snapshot"),
            ("project_commands.rs", "init_project"),
            ("project_commands.rs", "create_project"),
            ("project_commands.rs", "open_project"),
            ("project_commands.rs", "import_table"),
        ]
    }

    fn extract_function_slice<'a>(module_source: &'a str, function_name: &str) -> &'a str {
        let public_header = format!("pub fn {function_name}");
        let crate_header = format!("pub(crate) fn {function_name}");
        let function_start = module_source
            .find(&public_header)
            .or_else(|| module_source.find(&crate_header))
            .unwrap_or_else(|| panic!("{function_name} must exist for mutation coverage"));
        let function_body = &module_source[function_start..];

        let body_start = function_body
            .find('{')
            .expect("function body must start with {");
        let mut depth = 0usize;
        let mut end = None;
        for (idx, ch) in function_body[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth = depth
                        .checked_sub(1)
                        .expect("brace depth should never underflow");
                    if depth == 0 {
                        end = Some(body_start + idx + 1);
                        break;
                    }
                }
                _ => {}
            }
        }

        let function_end = end.expect("function body must have a closing brace");
        &function_body[..function_end]
    }

    fn assert_module_helper_routes_to_save_coordinator(module_source: &str, file_name: &str) {
        let helper_slice = extract_function_slice(module_source, "acquire_mutation_permit");
        assert!(
            helper_slice.contains("state.save_coordinator.mutation_permit()"),
            "{file_name}::acquire_mutation_permit must delegate to save_coordinator.mutation_permit"
        );
    }

    fn assert_has_permit_statement(module_source: &str, function_name: &str, file_name: &str) {
        let function_slice = extract_function_slice(module_source, function_name);
        let body = function_slice
            .split_once('{')
            .map(|(_, rest)| rest)
            .unwrap_or(function_slice);
        let first_statement = body
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != "{" && !line.starts_with("//"))
            .next()
            .unwrap_or("");

        let has_direct_permit = first_statement.starts_with("let _permit = acquire_mutation_permit(");
        let delegated_permit = if has_direct_permit {
            true
        } else {
            first_statement
                .split('(')
                .next()
                .map(str::trim)
                .filter(|callee| callee.ends_with("_entry"))
                .map(|callee| {
                    let callee_slice = extract_function_slice(module_source, callee);
                    let callee_body = callee_slice
                        .split_once('{')
                        .map(|(_, rest)| rest)
                        .unwrap_or(callee_slice);
                    let callee_first_statement = callee_body
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty() && *line != "{" && !line.starts_with("//"))
                        .next()
                        .unwrap_or("");
                    callee_first_statement.starts_with("let _permit = acquire_mutation_permit(")
                })
                .unwrap_or(false)
        };

        assert!(
            delegated_permit,
            "{file_name}::{function_name} must acquire mutation permit at command entry (directly or via a dedicated entry helper)"
        );

        assert!(
            !function_slice.contains("drop(_permit)"),
            "{file_name}::{function_name} must keep mutation permit alive through delegated service return"
        );
    }

    fn temp_file_path(prefix: &str, suffix: &str) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "stats_playground_{prefix}_{}{}",
            uuid::Uuid::new_v4(),
            suffix
        ));
        path.to_string_lossy().to_string()
    }

    fn seed_numeric_dataset(state: &AppState) -> (String, u64) {
        let service = DataService::new(state);
        let dataset = service
            .create_table(
                "guard-seed",
                &["value".to_string()],
                &["INTEGER".to_string()],
            )
            .expect("seed table should be created");
        let row_id = service
            .add_row(&dataset.id)
            .expect("seed row should be created");
        service
            .update_cell(&dataset.id, row_id, "value", "42")
            .expect("seed row should be updated");
        let generation = service
            .get_dataset_generation(&dataset.id)
            .expect("dataset generation should be readable");
        (dataset.id, generation)
    }

    #[test]
    fn command_classification_covers_every_registered_handler() {
        let lib_source = include_str!("../lib.rs");
        let registered = parse_registered_commands(lib_source);
        let classifications = command_classes();

        let registered_set: BTreeSet<&str> = registered.iter().map(String::as_str).collect();
        let classified_set: BTreeSet<&str> = classifications.keys().copied().collect();

        assert_eq!(
            registered_set, classified_set,
            "classification table must enumerate every command in generate_handler and only those commands"
        );
    }

    #[test]
    fn mutating_commands_in_guarded_families_require_permit_acquisition() {
        let data_source = include_str!("data_commands.rs");
        let table_source = include_str!("table_commands.rs");
        let io_source = include_str!("io_commands.rs");
        let history_source = include_str!("history_commands.rs");
        let project_source = include_str!("project_commands.rs");

        assert_module_helper_routes_to_save_coordinator(data_source, "data_commands.rs");
        assert_module_helper_routes_to_save_coordinator(table_source, "table_commands.rs");
        assert_module_helper_routes_to_save_coordinator(io_source, "io_commands.rs");
        assert_module_helper_routes_to_save_coordinator(history_source, "history_commands.rs");
        assert_module_helper_routes_to_save_coordinator(project_source, "project_commands.rs");

        for (file_name, function_name) in functions_requiring_mutation_permit() {
            let source = match file_name {
                "data_commands.rs" => data_source,
                "table_commands.rs" => table_source,
                "io_commands.rs" => io_source,
                "history_commands.rs" => history_source,
                "project_commands.rs" => project_source,
                _ => panic!("unexpected file in permit coverage list: {file_name}"),
            };

            assert_has_permit_statement(source, function_name, file_name);
        }
    }

    #[test]
    fn save_project_remains_outside_mutation_permit_path() {
        let source = include_str!("project_commands.rs");
        let save_start = source
            .find("pub async fn save_project(")
            .expect("save_project command must exist");
        let save_body = &source[save_start..];
        let save_end = save_body.find("\n#[tauri::command").unwrap_or(save_body.len());
        let save_slice = &save_body[..save_end];

        assert!(
            !save_slice.contains("mutation_permit"),
            "save_project must not acquire a mutation permit; it is guarded by SaveGuard"
        );
    }

    #[test]
    fn save_blocks_mutation_permit_across_all_guarded_command_families() {
        let state = AppState::new().expect("app state should initialize");
        let _save_guard = state
            .save_coordinator
            .begin_save()
            .expect("save guard should start");

        let data = crate::commands::data_commands::delete_dataset_entry(&state, "missing")
            .expect_err("data family mutation command must be blocked while save is active");
        assert!(matches!(data, AppError::ReadOnly(_)));

        let table = crate::commands::table_commands::sort_table_entry(
            &state,
            "missing",
            &[],
            &[],
            "sorted",
        )
        .expect_err("table family mutation command must be blocked while save is active");
        assert!(matches!(table, AppError::ReadOnly(_)));

        let io = crate::commands::io_commands::import_sqlite_entry(
            &state,
            "missing.sqlite",
            |_table_name, _table_index, _table_total, _rows_done, _rows_total| {},
        )
        .expect_err("io family mutation command must be blocked while save is active");
        assert!(matches!(io, AppError::ReadOnly(_)));

        let history = crate::commands::history_commands::restore_project_snapshot_entry(
            &state,
            &crate::commands::history_commands::ProjectDataSnapshot { datasets: vec![] },
            |_dataset_index, _dataset_total, _dataset_name| {},
        )
        .expect_err("history family mutation command must be blocked while save is active");
        assert!(matches!(history, AppError::ReadOnly(_)));

        let project_path = temp_file_path("blocked_create_project", ".spprj");
        let project = crate::commands::project_commands::create_project_entry(
            &state,
            "blocked",
            &project_path,
        )
        .expect_err("project family mutation command must be blocked while save is active");
        assert!(matches!(project, AppError::ReadOnly(_)));
    }

    #[test]
    fn save_does_not_block_command_read_paths() {
        let state = AppState::new().expect("app state should initialize");
        let (dataset_id, generation) = seed_numeric_dataset(&state);

        let export_path = temp_file_path("read_export_csv", ".csv");
        let graph_path = temp_file_path("read_import_graph", ".spgh");
        let graph_doc = GraphDoc {
            id: "graph-read-1".to_string(),
            name: "Graph Read".to_string(),
            version: "1".to_string(),
            body: serde_json::Map::from_iter([(
                "graphType".to_string(),
                serde_json::Value::String("line".to_string()),
            )]),
        };
        spprj_archive::write_graph_file(&graph_doc, &graph_path)
            .expect("graph fixture should be writable");

        let _save_guard = state
            .save_coordinator
            .begin_save()
            .expect("save guard should start");

        let table_window = crate::commands::data_commands::query_table_window_entry(
            &state,
            &TableWindowRequest {
                dataset_id: dataset_id.clone(),
                start: 0,
                count: 10,
                sort: None,
                filters: vec![],
                generation,
            },
        )
        .expect("table-window command path should succeed during save");
        assert_eq!(table_window.total_rows, 1);

        let graph = crate::commands::project_commands::import_graph_entry(&state, &graph_path)
            .expect("graph read path should succeed during save");
        assert_eq!(
            graph.get("id").and_then(serde_json::Value::as_str),
            Some("graph-read-1")
        );

        let stats = crate::services::stats_service::StatsService::new(&state)
            .get_descriptive_stats(&dataset_id)
            .expect("stats read path should succeed during save");
        assert_eq!(stats.dataset_id, dataset_id);
        assert!(!stats.columns.is_empty());

        crate::commands::io_commands::export_csv_entry(&state, &dataset_id, &export_path)
            .expect("export read path should succeed during save");
        let export_bytes = std::fs::metadata(PathBuf::from(&export_path))
            .expect("export output should exist")
            .len();
        assert!(export_bytes > 0, "export output should be non-empty");

        let project = crate::commands::project_commands::get_current_project_entry(&state)
            .expect("current-project read path should succeed during save");
        assert!(project.is_none());

        let _ = std::fs::remove_file(export_path);
        let _ = std::fs::remove_file(graph_path);
    }
}

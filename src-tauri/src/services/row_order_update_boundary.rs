use duckdb::params;

use crate::engine::duckdb_engine::DuckDbEngine;
#[cfg(test)]
use crate::engine::duckdb_engine::NATURAL_ORDER_SQL;
use crate::error::AppError;

#[cfg(any(test, feature = "perf-harness"))]
static REBALANCED_ROWS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(any(test, feature = "perf-harness"))]
static FULL_TABLE_ROW_UPDATES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[derive(Clone, Copy)]
enum RowOrderUpdateScope {
    BoundedLocal { dataset_rows: usize },
    GlobalUnbounded { dataset_rows: usize },
}

#[derive(Clone, Copy)]
pub(crate) enum RowOrderUpdateKind {
    BoundedLocal,
    GlobalUnbounded,
}

pub(crate) struct RowOrderUpdateBoundary {
    scope: RowOrderUpdateScope,
    affected_rows: usize,
}

impl RowOrderUpdateBoundary {
    pub(crate) fn update_by_id(
        &mut self,
        engine: &DuckDbEngine,
        table_name: &str,
        row_id: i64,
        row_order: i128,
    ) -> Result<(), AppError> {
        let sql = format!("UPDATE {table_name} SET \"_row_order\" = ? WHERE \"_row_id\" = ?");
        self.affected_rows = self
            .affected_rows
            .saturating_add(engine.conn().execute(&sql, params![row_order, row_id])?);
        Ok(())
    }

    pub(crate) fn finish(self) -> usize {
        #[cfg(any(test, feature = "perf-harness"))]
        observe_row_order_update(self.affected_rows, self.scope);
        #[cfg(not(any(test, feature = "perf-harness")))]
        let _ = self.scope;
        self.affected_rows
    }
}

pub(crate) fn begin_row_order_update(
    engine: &DuckDbEngine,
    table_name: &str,
    kind: RowOrderUpdateKind,
) -> Result<RowOrderUpdateBoundary, AppError> {
    #[cfg(any(test, feature = "perf-harness"))]
    let dataset_rows =
        engine
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table_name}"), [], |row| {
                row.get(0)
            })?;
    #[cfg(not(any(test, feature = "perf-harness")))]
    let dataset_rows = {
        let _ = (engine, table_name);
        0
    };
    let scope = match kind {
        RowOrderUpdateKind::BoundedLocal => RowOrderUpdateScope::BoundedLocal { dataset_rows },
        RowOrderUpdateKind::GlobalUnbounded => {
            RowOrderUpdateScope::GlobalUnbounded { dataset_rows }
        }
    };
    Ok(RowOrderUpdateBoundary {
        scope,
        affected_rows: 0,
    })
}

#[cfg(any(test, feature = "perf-harness"))]
fn observe_row_order_update(affected_rows: usize, scope: RowOrderUpdateScope) {
    let (dataset_rows, bounded_local_rebalance) = match scope {
        RowOrderUpdateScope::BoundedLocal { dataset_rows } => (dataset_rows, true),
        RowOrderUpdateScope::GlobalUnbounded { dataset_rows } => (dataset_rows, false),
    };
    let near_dataset_size =
        dataset_rows > 0 && affected_rows.saturating_mul(10) >= dataset_rows.saturating_mul(9);
    if bounded_local_rebalance {
        REBALANCED_ROWS.fetch_add(affected_rows, std::sync::atomic::Ordering::Relaxed);
    }
    if !bounded_local_rebalance || near_dataset_size {
        FULL_TABLE_ROW_UPDATES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn rebalanced_rows() -> usize {
    REBALANCED_ROWS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn reset_rebalanced_rows() {
    REBALANCED_ROWS.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn full_table_row_updates() -> usize {
    FULL_TABLE_ROW_UPDATES.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(any(test, feature = "perf-harness"))]
pub(crate) fn reset_full_table_row_updates() {
    FULL_TABLE_ROW_UPDATES.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn execute_global_row_order_update_for_test(
    engine: &DuckDbEngine,
    dataset_id: &str,
) -> Result<usize, AppError> {
    let table_name = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    let mut statement = engine.conn().prepare(&format!(
        "SELECT \"_row_id\", {NATURAL_ORDER_SQL} FROM {table_name}"
    ))?;
    let updates = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut boundary =
        begin_row_order_update(engine, &table_name, RowOrderUpdateKind::GlobalUnbounded)?;
    for (row_id, row_order) in updates {
        boundary.update_by_id(engine, &table_name, row_id, row_order)?;
    }
    Ok(boundary.finish())
}

#[cfg(test)]
pub(crate) use source_contract::{
    source_contains_row_order_update, source_contract_violations,
    source_contract_violations_for_sources,
};

#[cfg(test)]
mod source_contract {
    const AUTHORITY_PATH: &str = "services/row_order_update_boundary.rs";

    fn production_portion(source: &str) -> &str {
        source
            .split("\n#[cfg(test)]\nmod ")
            .next()
            .unwrap_or(source)
    }

    fn without_comments(source: &str) -> String {
        let bytes = source.as_bytes();
        let mut result = String::with_capacity(source.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index..].starts_with(b"//") {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                result.push('\n');
            } else if bytes[index..].starts_with(b"/*") {
                index += 2;
                while index + 1 < bytes.len() && !bytes[index..].starts_with(b"*/") {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
                result.push(' ');
            } else {
                result.push(bytes[index] as char);
                index += 1;
            }
        }
        result
    }

    fn canonical_statement(statement: &str) -> String {
        statement
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .flat_map(char::to_lowercase)
            .collect()
    }

    fn string_literal_content(source: &str) -> String {
        let bytes = source.as_bytes();
        let mut result = String::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'"' {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\\' && index + 1 < bytes.len() {
                        result.push(bytes[index + 1] as char);
                        index += 2;
                    } else if bytes[index] == b'"' {
                        index += 1;
                        break;
                    } else {
                        result.push(bytes[index] as char);
                        index += 1;
                    }
                }
            } else {
                index += 1;
            }
        }
        result
    }

    fn row_order_update_occurrences(source: &str) -> usize {
        without_comments(production_portion(source))
            .split(';')
            .map(string_literal_content)
            .map(|statement| canonical_statement(&statement))
            .filter(|statement| statement.contains("update") && statement.contains("_row_order"))
            .count()
    }

    pub(crate) fn source_contains_row_order_update(source: &str) -> bool {
        row_order_update_occurrences(source) > 0
    }

    pub(crate) fn source_contract_violations_for_sources<'a>(
        sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Vec<String> {
        let mut violations = sources
            .into_iter()
            .filter(|(path, source)| {
                *path != AUTHORITY_PATH && source_contains_row_order_update(source)
            })
            .map(|(path, _)| path.to_string())
            .collect::<Vec<_>>();
        violations.sort();
        violations
    }

    pub(crate) fn source_contract_violations(
        source_root: &std::path::Path,
    ) -> Result<Vec<String>, String> {
        fn collect(
            root: &std::path::Path,
            directory: &std::path::Path,
            sources: &mut Vec<(String, String)>,
        ) -> Result<(), String> {
            let mut entries = std::fs::read_dir(directory)
                .map_err(|error| format!("read {}: {error}", directory.display()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("read {}: {error}", directory.display()))?;
            entries.sort_by_key(std::fs::DirEntry::file_name);
            for entry in entries {
                let path = entry.path();
                if path.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some("target" | "generated")) {
                        collect(root, &path, sources)?;
                    }
                } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|error| error.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/");
                    let source = std::fs::read_to_string(&path)
                        .map_err(|error| format!("read {}: {error}", path.display()))?;
                    sources.push((relative, source));
                }
            }
            Ok(())
        }

        let mut sources = Vec::new();
        collect(source_root, source_root, &mut sources)?;
        let authority = sources
            .iter()
            .find(|(path, _)| path == AUTHORITY_PATH)
            .ok_or_else(|| format!("missing row-order UPDATE authority {AUTHORITY_PATH}"))?;
        let authority_count = row_order_update_occurrences(&authority.1);
        let borrowed = sources
            .iter()
            .map(|(path, source)| (path.as_str(), source.as_str()))
            .collect::<Vec<_>>();
        let mut violations = source_contract_violations_for_sources(borrowed);
        if authority_count != 1 {
            violations.push(format!(
                "{AUTHORITY_PATH}: expected one canonical UPDATE, found {authority_count}"
            ));
        }
        Ok(violations)
    }
}

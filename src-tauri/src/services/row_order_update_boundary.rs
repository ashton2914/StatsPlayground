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
    use std::collections::HashSet;

    use proc_macro2::{TokenStream, TokenTree};
    use syn::parse::Parser;
    use syn::punctuated::Punctuated;
    use syn::visit::{self, Visit};
    use syn::{Attribute, Expr, ExprMacro, Item, ItemMacro, Lit, Macro, Path, Token};

    const AUTHORITY_PATH: &str = "services/row_order_update_boundary.rs";

    fn item_attributes(item: &Item) -> &[Attribute] {
        match item {
            Item::Const(item) => &item.attrs,
            Item::Enum(item) => &item.attrs,
            Item::ExternCrate(item) => &item.attrs,
            Item::Fn(item) => &item.attrs,
            Item::ForeignMod(item) => &item.attrs,
            Item::Impl(item) => &item.attrs,
            Item::Macro(item) => &item.attrs,
            Item::Mod(item) => &item.attrs,
            Item::Static(item) => &item.attrs,
            Item::Struct(item) => &item.attrs,
            Item::Trait(item) => &item.attrs,
            Item::TraitAlias(item) => &item.attrs,
            Item::Type(item) => &item.attrs,
            Item::Union(item) => &item.attrs,
            Item::Use(item) => &item.attrs,
            _ => &[],
        }
    }

    fn is_test_only(item: &Item) -> bool {
        item_attributes(item).iter().any(|attribute| {
            attribute.path().is_ident("cfg")
                && attribute
                    .parse_args::<syn::Path>()
                    .is_ok_and(|path| path.is_ident("test"))
        })
    }

    fn canonical(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .flat_map(char::to_lowercase)
            .collect()
    }

    fn literal_value(literal: &Lit) -> Option<String> {
        match literal {
            Lit::Str(value) => Some(value.value()),
            Lit::ByteStr(value) => Some(String::from_utf8_lossy(&value.value()).into_owned()),
            _ => None,
        }
    }

    fn evaluate_literal_expression(expression: &Expr) -> Option<String> {
        match expression {
            Expr::Lit(expression) => literal_value(&expression.lit),
            Expr::Group(expression) => evaluate_literal_expression(&expression.expr),
            Expr::Paren(expression) => evaluate_literal_expression(&expression.expr),
            Expr::Macro(expression) if expression.mac.path.is_ident("concat") => {
                let arguments = Punctuated::<Expr, Token![,]>::parse_terminated
                    .parse2(expression.mac.tokens.clone())
                    .ok()?;
                let mut value = String::new();
                for argument in arguments {
                    value.push_str(&evaluate_literal_expression(&argument)?);
                }
                Some(value)
            }
            _ => None,
        }
    }

    #[derive(Default)]
    struct ExpressionTokens {
        literals: Vec<String>,
        identifiers: Vec<String>,
    }

    impl ExpressionTokens {
        fn collect_macro_tokens(&mut self, tokens: TokenStream) {
            for token in tokens {
                match token {
                    TokenTree::Group(group) => self.collect_macro_tokens(group.stream()),
                    TokenTree::Ident(identifier) => self.identifiers.push(identifier.to_string()),
                    TokenTree::Literal(literal) => {
                        if let Ok(literal) = syn::parse_str::<Lit>(&literal.to_string()) {
                            if let Some(value) = literal_value(&literal) {
                                self.literals.push(value);
                            }
                        }
                    }
                    TokenTree::Punct(_) => {}
                }
            }
        }

        fn contains_row_order_update(&self) -> bool {
            let literal_text = canonical(&self.literals.join(""));
            if !literal_text.contains("_row_order") {
                return false;
            }
            let mut construction_text = literal_text.replace("_row_order", "");
            construction_text.push_str(&canonical(&self.identifiers.join("")));
            construction_text.contains("update")
        }
    }

    impl<'ast> Visit<'ast> for ExpressionTokens {
        fn visit_expr_macro(&mut self, expression: &'ast ExprMacro) {
            if expression.mac.path.is_ident("concat") {
                if let Some(value) = evaluate_literal_expression(&Expr::Macro(expression.clone())) {
                    self.literals.push(value);
                    return;
                }
            }
            self.collect_macro_tokens(expression.mac.tokens.clone());
        }

        fn visit_lit(&mut self, literal: &'ast Lit) {
            if let Some(value) = literal_value(literal) {
                self.literals.push(value);
            }
        }

        fn visit_macro(&mut self, node: &'ast Macro) {
            self.collect_macro_tokens(node.tokens.clone());
        }
    }

    fn expression_contains_row_order_update(expression: &Expr) -> bool {
        let mut tokens = ExpressionTokens::default();
        tokens.visit_expr(expression);
        tokens.contains_row_order_update()
    }

    fn macro_name(path: &Path) -> Option<String> {
        path.segments
            .last()
            .map(|segment| segment.ident.to_string())
    }

    fn external_content_macro_is_unsafe(name: &str, tokens: TokenStream) -> bool {
        match name {
            "include" => true,
            "include_str" | "include_bytes" => {
                let mut content = ExpressionTokens::default();
                content.collect_macro_tokens(tokens);
                !content
                    .literals
                    .last()
                    .is_some_and(|path| path.to_ascii_lowercase().ends_with(".json"))
            }
            _ => false,
        }
    }

    fn tokens_contain_unsafe_external_macro(tokens: TokenStream) -> bool {
        let tokens = tokens.into_iter().collect::<Vec<_>>();
        for (index, token) in tokens.iter().enumerate() {
            if let TokenTree::Group(group) = token {
                if tokens_contain_unsafe_external_macro(group.stream()) {
                    return true;
                }
            }
            let Some(TokenTree::Ident(identifier)) = tokens.get(index) else {
                continue;
            };
            let Some(TokenTree::Punct(punctuation)) = tokens.get(index + 1) else {
                continue;
            };
            let Some(TokenTree::Group(arguments)) = tokens.get(index + 2) else {
                continue;
            };
            if punctuation.as_char() == '!'
                && external_content_macro_is_unsafe(&identifier.to_string(), arguments.stream())
            {
                return true;
            }
        }
        false
    }

    fn macro_definition_is_unsafe(item: &ItemMacro) -> bool {
        let mut tokens = ExpressionTokens::default();
        tokens.collect_macro_tokens(item.mac.tokens.clone());
        tokens.contains_row_order_update()
            || tokens_contain_unsafe_external_macro(item.mac.tokens.clone())
    }

    #[derive(Default)]
    struct ProductionMacroCollector {
        names: HashSet<String>,
    }

    impl<'ast> Visit<'ast> for ProductionMacroCollector {
        fn visit_item(&mut self, item: &'ast Item) {
            if is_test_only(item) {
                return;
            }
            if let Item::Macro(item) = item {
                if item.mac.path.is_ident("macro_rules") {
                    if let Some(identifier) = &item.ident {
                        self.names.insert(identifier.to_string());
                    }
                }
            }
            visit::visit_item(self, item);
        }
    }

    fn safe_empty_macro(path: &Path) -> bool {
        let full_path = path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect::<Vec<_>>()
            .join("::");
        matches!(
            full_path.as_str(),
            "vec" | "unreachable" | "todo" | "panic" | "tauri::generate_context"
        )
    }

    struct ProductionUpdateVisitor<'a> {
        occurrences: usize,
        local_macros: &'a HashSet<String>,
    }

    impl<'ast> Visit<'ast> for ProductionUpdateVisitor<'_> {
        fn visit_item(&mut self, item: &'ast Item) {
            if is_test_only(item) {
                return;
            }
            if let Item::Macro(item) = item {
                if item.mac.path.is_ident("macro_rules") {
                    if macro_definition_is_unsafe(item) {
                        self.occurrences += 1;
                    }
                    return;
                }
            }
            visit::visit_item(self, item);
        }

        fn visit_expr(&mut self, expression: &'ast Expr) {
            if let Expr::Macro(expression) = expression {
                let name = macro_name(&expression.mac.path);
                let is_local = expression.mac.path.leading_colon.is_none()
                    && expression.mac.path.segments.len() == 1
                    && name
                        .as_ref()
                        .is_some_and(|name| self.local_macros.contains(name));
                let unresolved_empty = expression.mac.tokens.is_empty()
                    && !is_local
                    && !safe_empty_macro(&expression.mac.path);
                let unresolved_external = name.as_ref().is_some_and(|name| {
                    external_content_macro_is_unsafe(name, expression.mac.tokens.clone())
                });
                if unresolved_empty || unresolved_external {
                    self.occurrences += 1;
                    return;
                }
            }
            let can_construct_sql = matches!(
                expression,
                Expr::Array(_) | Expr::Binary(_) | Expr::Lit(_) | Expr::Macro(_) | Expr::Tuple(_)
            );
            if can_construct_sql && expression_contains_row_order_update(expression) {
                self.occurrences += 1;
            } else {
                visit::visit_expr(self, expression);
            }
        }
    }

    fn row_order_update_occurrences(source: &str) -> Result<usize, String> {
        let syntax = syn::parse_file(source).map_err(|error| error.to_string())?;
        let mut macros = ProductionMacroCollector::default();
        macros.visit_file(&syntax);
        let mut visitor = ProductionUpdateVisitor {
            occurrences: 0,
            local_macros: &macros.names,
        };
        visitor.visit_file(&syntax);
        Ok(visitor.occurrences)
    }

    pub(crate) fn source_contains_row_order_update(source: &str) -> bool {
        match row_order_update_occurrences(source) {
            Ok(count) => count > 0,
            Err(_) => true,
        }
    }

    pub(crate) fn source_contract_violations_for_sources<'a>(
        sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Vec<String> {
        let mut violations = sources
            .into_iter()
            .filter_map(
                |(path, source)| match row_order_update_occurrences(source) {
                    Ok(0) if path != AUTHORITY_PATH => None,
                    Ok(_) if path != AUTHORITY_PATH => Some(path.to_string()),
                    Err(error) => Some(format!("{path}: Rust parse failed: {error}")),
                    Ok(_) => None,
                },
            )
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
        let authority_count = row_order_update_occurrences(&authority.1)
            .map_err(|error| format!("parse {AUTHORITY_PATH}: {error}"))?;
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

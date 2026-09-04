#![allow(dead_code)]

use std::collections::HashSet;

use sqlparser::ast::{
    Cte, Expr, Function, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Join,
    JoinConstraint, JoinOperator, JsonPathElem, LimitClause, NamedWindowDefinition, ObjectName,
    ObjectNamePart, OrderBy, OrderByExpr, PivotValueSource, Query, Select, SelectItem, SetExpr,
    Statement, TableFactor, TableWithJoins, WindowFrameBound, WindowType, With,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

use crate::error::AppError;

const DYNAMIC_QUERY_FUNCTIONS: &[&str] = &["query", "query_table"];

pub fn normalize_identifier(name: &str) -> String {
    name.to_lowercase()
}

pub fn validate_read_only_query(
    sql: &str,
    allowed_tables: &HashSet<String>,
) -> Result<String, AppError> {
    let dialect = DuckDbDialect {};
    let statements = Parser::parse_sql(&dialect, sql)
        .map_err(|error| AppError::InvalidParam(format!("invalid SQL: {error}")))?;

    if statements.len() != 1 {
        return invalid("exactly one query statement is required");
    }

    let statement = statements.into_iter().next().ok_or_else(|| {
        AppError::InvalidParam("exactly one query statement is required".to_string())
    })?;

    match &statement {
        Statement::Query(query) => {
            let mut validator = RelationValidator::new(allowed_tables);
            validator.validate_query(query)?;
            Ok(statement.to_string())
        }
        _ => invalid("only SELECT queries are allowed"),
    }
}

struct RelationValidator<'a> {
    allowed_tables: &'a HashSet<String>,
    cte_scopes: Vec<HashSet<String>>,
}

impl<'a> RelationValidator<'a> {
    fn new(allowed_tables: &'a HashSet<String>) -> Self {
        Self {
            allowed_tables,
            cte_scopes: Vec::new(),
        }
    }

    fn validate_query(&mut self, query: &Query) -> Result<(), AppError> {
        let scope_depth = self.cte_scopes.len();
        self.cte_scopes.push(HashSet::new());

        if let Some(with) = &query.with {
            self.validate_with(with)?;
        }

        self.validate_set_expr(query.body.as_ref())?;

        if let Some(order_by) = &query.order_by {
            self.validate_order_by(order_by)?;
        }

        if let Some(limit_clause) = &query.limit_clause {
            self.validate_limit_clause(limit_clause)?;
        }

        if query.fetch.is_some() {
            return invalid("FETCH is not allowed");
        }

        if !query.locks.is_empty() {
            return invalid("locking clauses are not allowed");
        }

        if query.for_clause.is_some() {
            return invalid("FOR clauses are not allowed");
        }

        if query.settings.is_some() {
            return invalid("SETTINGS is not allowed");
        }

        if query.format_clause.is_some() {
            return invalid("FORMAT is not allowed");
        }

        if !query.pipe_operators.is_empty() {
            return invalid("pipe operators are not allowed");
        }

        self.cte_scopes.truncate(scope_depth);
        Ok(())
    }

    fn validate_with(&mut self, with: &With) -> Result<(), AppError> {
        if with.recursive {
            return invalid("recursive CTEs are not allowed");
        }

        for cte in &with.cte_tables {
            self.validate_cte(cte)?;
        }

        Ok(())
    }

    fn validate_cte(&mut self, cte: &Cte) -> Result<(), AppError> {
        if cte.from.is_some() {
            return invalid("CTE FROM clauses are not allowed");
        }

        self.validate_query(cte.query.as_ref())?;

        self.current_scope_mut()?
            .insert(normalize_identifier(&cte.alias.name.value));
        Ok(())
    }

    fn validate_set_expr(&mut self, set_expr: &SetExpr) -> Result<(), AppError> {
        match set_expr {
            SetExpr::Select(select) => self.validate_select(select.as_ref()),
            SetExpr::Query(query) => self.validate_query(query.as_ref()),
            SetExpr::SetOperation { left, right, .. } => {
                self.validate_set_expr(left.as_ref())?;
                self.validate_set_expr(right.as_ref())
            }
            SetExpr::Table(_) => invalid("TABLE queries are not allowed"),
            SetExpr::Values(_) => invalid("VALUES queries are not allowed"),
            SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_) => {
                invalid("mutating statements are not allowed")
            }
        }
    }

    fn validate_select(&mut self, select: &Select) -> Result<(), AppError> {
        if !select.optimizer_hints.is_empty() {
            return invalid("optimizer hints are not allowed");
        }

        if select.top.is_some() {
            return invalid("TOP is not allowed");
        }

        if select.into.is_some() {
            return invalid("SELECT INTO is not allowed");
        }

        if !select.lateral_views.is_empty() {
            return invalid("lateral views are not allowed");
        }

        if !select.connect_by.is_empty() {
            return invalid("CONNECT BY is not allowed");
        }

        if !select.named_window.is_empty() {
            for window in &select.named_window {
                self.validate_named_window_definition(window)?;
            }
        }

        if select.value_table_mode.is_some() {
            return invalid("value table mode is not allowed");
        }

        for item in &select.projection {
            self.validate_select_item(item)?;
        }

        for table_with_joins in &select.from {
            self.validate_table_with_joins(table_with_joins)?;
        }

        if let Some(prewhere) = &select.prewhere {
            self.validate_expr(prewhere)?;
        }

        if let Some(selection) = &select.selection {
            self.validate_expr(selection)?;
        }

        match &select.group_by {
            GroupByExpr::All(_) => {}
            GroupByExpr::Expressions(exprs, _) => self.validate_exprs(exprs)?,
        }

        self.validate_exprs(&select.cluster_by)?;
        self.validate_exprs(&select.distribute_by)?;

        for order_by in &select.sort_by {
            self.validate_order_by_expr(order_by)?;
        }

        if let Some(having) = &select.having {
            self.validate_expr(having)?;
        }

        if let Some(qualify) = &select.qualify {
            self.validate_expr(qualify)?;
        }

        Ok(())
    }

    fn validate_named_window_definition(
        &mut self,
        definition: &NamedWindowDefinition,
    ) -> Result<(), AppError> {
        match &definition.1 {
            sqlparser::ast::NamedWindowExpr::NamedWindow(_) => Ok(()),
            sqlparser::ast::NamedWindowExpr::WindowSpec(spec) => {
                self.validate_exprs(&spec.partition_by)?;
                for order_by in &spec.order_by {
                    self.validate_order_by_expr(order_by)?;
                }
                if let Some(frame) = &spec.window_frame {
                    self.validate_window_frame_bound(&frame.start_bound)?;
                    if let Some(end_bound) = &frame.end_bound {
                        self.validate_window_frame_bound(end_bound)?;
                    }
                }
                Ok(())
            }
        }
    }

    fn validate_window_frame_bound(&mut self, bound: &WindowFrameBound) -> Result<(), AppError> {
        match bound {
            WindowFrameBound::CurrentRow => Ok(()),
            WindowFrameBound::Preceding(Some(expr)) | WindowFrameBound::Following(Some(expr)) => {
                self.validate_expr(expr.as_ref())
            }
            WindowFrameBound::Preceding(None) | WindowFrameBound::Following(None) => Ok(()),
        }
    }

    fn validate_select_item(&mut self, item: &SelectItem) -> Result<(), AppError> {
        match item {
            SelectItem::UnnamedExpr(expr)
            | SelectItem::ExprWithAlias { expr, .. }
            | SelectItem::ExprWithAliases { expr, .. } => self.validate_expr(expr),
            SelectItem::QualifiedWildcard(kind, options) => {
                self.validate_wildcard_additional_options(options)?;
                match kind {
                    sqlparser::ast::SelectItemQualifiedWildcardKind::ObjectName(_) => Ok(()),
                    sqlparser::ast::SelectItemQualifiedWildcardKind::Expr(expr) => {
                        self.validate_expr(expr)
                    }
                }
            }
            SelectItem::Wildcard(options) => self.validate_wildcard_additional_options(options),
        }
    }

    fn validate_wildcard_additional_options(
        &mut self,
        options: &sqlparser::ast::WildcardAdditionalOptions,
    ) -> Result<(), AppError> {
        if let Some(replace) = &options.opt_replace {
            for item in &replace.items {
                self.validate_expr(&item.expr)?;
            }
        }

        Ok(())
    }

    fn validate_table_with_joins(
        &mut self,
        table_with_joins: &TableWithJoins,
    ) -> Result<(), AppError> {
        self.validate_table_factor(&table_with_joins.relation)?;
        for join in &table_with_joins.joins {
            self.validate_join(join)?;
        }
        Ok(())
    }

    fn validate_join(&mut self, join: &Join) -> Result<(), AppError> {
        self.validate_table_factor(&join.relation)?;

        match &join.join_operator {
            JoinOperator::Join(constraint)
            | JoinOperator::Inner(constraint)
            | JoinOperator::Left(constraint)
            | JoinOperator::LeftOuter(constraint)
            | JoinOperator::Right(constraint)
            | JoinOperator::RightOuter(constraint)
            | JoinOperator::FullOuter(constraint)
            | JoinOperator::CrossJoin(constraint)
            | JoinOperator::Semi(constraint)
            | JoinOperator::LeftSemi(constraint)
            | JoinOperator::RightSemi(constraint)
            | JoinOperator::Anti(constraint)
            | JoinOperator::LeftAnti(constraint)
            | JoinOperator::RightAnti(constraint)
            | JoinOperator::StraightJoin(constraint) => self.validate_join_constraint(constraint),
            JoinOperator::AsOf {
                match_condition,
                constraint,
            } => {
                self.validate_expr(match_condition)?;
                self.validate_join_constraint(constraint)
            }
            JoinOperator::CrossApply
            | JoinOperator::OuterApply
            | JoinOperator::ArrayJoin
            | JoinOperator::LeftArrayJoin
            | JoinOperator::InnerArrayJoin => invalid("unsupported join operator"),
        }
    }

    fn validate_join_constraint(&mut self, constraint: &JoinConstraint) -> Result<(), AppError> {
        match constraint {
            JoinConstraint::On(expr) => self.validate_expr(expr),
            JoinConstraint::Using(_) | JoinConstraint::Natural | JoinConstraint::None => Ok(()),
        }
    }

    fn validate_table_factor(&mut self, table_factor: &TableFactor) -> Result<(), AppError> {
        match table_factor {
            TableFactor::Table {
                name,
                args,
                with_hints,
                version,
                with_ordinality,
                partitions,
                json_path,
                sample,
                index_hints,
                ..
            } => {
                if args.is_some() {
                    return invalid("table functions are not allowed");
                }

                if !with_hints.is_empty()
                    || version.is_some()
                    || *with_ordinality
                    || !partitions.is_empty()
                    || json_path.is_some()
                    || sample.is_some()
                    || !index_hints.is_empty()
                {
                    return invalid("unsupported table relation modifiers");
                }

                let relation_name = self.unqualified_relation_name(name)?;
                self.validate_relation_name(&relation_name)
            }
            TableFactor::Derived {
                subquery, sample, ..
            } => {
                if sample.is_some() {
                    return invalid("sampling derived tables is not allowed");
                }
                self.validate_query(subquery.as_ref())
            }
            TableFactor::NestedJoin {
                table_with_joins, ..
            } => self.validate_table_with_joins(table_with_joins.as_ref()),
            TableFactor::Pivot {
                table,
                aggregate_functions,
                value_column,
                value_source,
                default_on_null,
                ..
            } => {
                self.validate_table_factor(table.as_ref())?;
                for aggregate in aggregate_functions {
                    self.validate_expr(&aggregate.expr)?;
                }
                self.validate_exprs(value_column)?;
                match value_source {
                    PivotValueSource::List(values) => {
                        for value in values {
                            self.validate_expr(&value.expr)?;
                        }
                    }
                    PivotValueSource::Any(order_by) => {
                        for order_by_expr in order_by {
                            self.validate_order_by_expr(order_by_expr)?;
                        }
                    }
                    PivotValueSource::Subquery(query) => self.validate_query(query.as_ref())?,
                }
                if let Some(default_on_null) = default_on_null {
                    self.validate_expr(default_on_null)?;
                }
                Ok(())
            }
            TableFactor::Unpivot {
                table,
                value,
                columns,
                ..
            } => {
                self.validate_table_factor(table.as_ref())?;
                self.validate_expr(value)?;
                for column in columns {
                    self.validate_expr(&column.expr)?;
                }
                Ok(())
            }
            TableFactor::MatchRecognize {
                table,
                partition_by,
                order_by,
                measures,
                symbols,
                ..
            } => {
                self.validate_table_factor(table.as_ref())?;
                self.validate_exprs(partition_by)?;
                for order_by_expr in order_by {
                    self.validate_order_by_expr(order_by_expr)?;
                }
                for measure in measures {
                    self.validate_expr(&measure.expr)?;
                }
                for symbol in symbols {
                    self.validate_expr(&symbol.definition)?;
                }
                Ok(())
            }
            TableFactor::TableFunction { .. }
            | TableFactor::Function { .. }
            | TableFactor::UNNEST { .. }
            | TableFactor::JsonTable { .. }
            | TableFactor::OpenJsonTable { .. }
            | TableFactor::XmlTable { .. }
            | TableFactor::SemanticView { .. } => invalid("table functions are not allowed"),
        }
    }

    fn validate_order_by(&mut self, order_by: &OrderBy) -> Result<(), AppError> {
        match &order_by.kind {
            sqlparser::ast::OrderByKind::All(_) => {}
            sqlparser::ast::OrderByKind::Expressions(exprs) => {
                for expr in exprs {
                    self.validate_order_by_expr(expr)?;
                }
            }
        }

        if let Some(interpolate) = &order_by.interpolate {
            if let Some(exprs) = &interpolate.exprs {
                for expr in exprs {
                    if let Some(value) = &expr.expr {
                        self.validate_expr(value)?;
                    }
                }
            }
        }

        Ok(())
    }

    fn validate_order_by_expr(&mut self, expr: &OrderByExpr) -> Result<(), AppError> {
        self.validate_expr(&expr.expr)?;
        if let Some(with_fill) = &expr.with_fill {
            if let Some(from) = &with_fill.from {
                self.validate_expr(from)?;
            }
            if let Some(to) = &with_fill.to {
                self.validate_expr(to)?;
            }
            if let Some(step) = &with_fill.step {
                self.validate_expr(step)?;
            }
        }
        Ok(())
    }

    fn validate_limit_clause(&mut self, limit_clause: &LimitClause) -> Result<(), AppError> {
        match limit_clause {
            LimitClause::LimitOffset {
                limit,
                offset,
                limit_by,
            } => {
                if let Some(limit) = limit {
                    self.validate_expr(limit)?;
                }
                if let Some(offset) = offset {
                    self.validate_expr(&offset.value)?;
                }
                self.validate_exprs(limit_by)
            }
            LimitClause::OffsetCommaLimit { offset, limit } => {
                self.validate_expr(offset)?;
                self.validate_expr(limit)
            }
        }
    }

    fn validate_exprs(&mut self, exprs: &[Expr]) -> Result<(), AppError> {
        for expr in exprs {
            self.validate_expr(expr)?;
        }
        Ok(())
    }

    fn validate_expr(&mut self, expr: &Expr) -> Result<(), AppError> {
        match expr {
            Expr::Identifier(_)
            | Expr::CompoundIdentifier(_)
            | Expr::Value(_)
            | Expr::TypedString(_)
            | Expr::Wildcard(_)
            | Expr::QualifiedWildcard(_, _) => Ok(()),
            Expr::CompoundFieldAccess { root, access_chain } => {
                self.validate_expr(root.as_ref())?;
                for access in access_chain {
                    match access {
                        sqlparser::ast::AccessExpr::Dot(value) => {
                            self.validate_expr(value)?;
                        }
                        sqlparser::ast::AccessExpr::Subscript(subscript) => match subscript {
                            sqlparser::ast::Subscript::Index { index } => {
                                self.validate_expr(index)?;
                            }
                            sqlparser::ast::Subscript::Slice {
                                lower_bound,
                                upper_bound,
                                stride,
                            } => {
                                if let Some(lower_bound) = lower_bound {
                                    self.validate_expr(lower_bound)?;
                                }
                                if let Some(upper_bound) = upper_bound {
                                    self.validate_expr(upper_bound)?;
                                }
                                if let Some(stride) = stride {
                                    self.validate_expr(stride)?;
                                }
                            }
                        },
                    }
                }
                Ok(())
            }
            Expr::JsonAccess { value, path } => {
                self.validate_expr(value.as_ref())?;
                for element in &path.path {
                    match element {
                        JsonPathElem::Dot { .. } => {}
                        JsonPathElem::Bracket { key } | JsonPathElem::ColonBracket { key } => {
                            self.validate_expr(key)?;
                        }
                    }
                }
                Ok(())
            }
            Expr::IsFalse(inner)
            | Expr::IsNotFalse(inner)
            | Expr::IsTrue(inner)
            | Expr::IsNotTrue(inner)
            | Expr::IsNull(inner)
            | Expr::IsNotNull(inner)
            | Expr::IsUnknown(inner)
            | Expr::IsNotUnknown(inner)
            | Expr::Nested(inner) => self.validate_expr(inner.as_ref()),
            Expr::IsDistinctFrom(left, right) | Expr::IsNotDistinctFrom(left, right) => {
                self.validate_expr(left.as_ref())?;
                self.validate_expr(right.as_ref())
            }
            Expr::IsNormalized { expr, .. } => self.validate_expr(expr.as_ref()),
            Expr::InList { expr, list, .. } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_exprs(list)
            }
            Expr::InSubquery { expr, subquery, .. } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_query(subquery.as_ref())
            }
            Expr::InUnnest { expr, .. } => {
                self.validate_expr(expr.as_ref())?;
                invalid("UNNEST is not allowed")
            }
            Expr::Between {
                expr, low, high, ..
            } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_expr(low.as_ref())?;
                self.validate_expr(high.as_ref())
            }
            Expr::BinaryOp { left, right, .. } => {
                self.validate_expr(left.as_ref())?;
                self.validate_expr(right.as_ref())
            }
            Expr::Like { expr, pattern, .. }
            | Expr::ILike { expr, pattern, .. }
            | Expr::SimilarTo { expr, pattern, .. }
            | Expr::RLike { expr, pattern, .. } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_expr(pattern.as_ref())
            }
            Expr::AnyOp { left, right, .. } | Expr::AllOp { left, right, .. } => {
                self.validate_expr(left.as_ref())?;
                self.validate_expr(right.as_ref())
            }
            Expr::UnaryOp { expr, .. } => self.validate_expr(expr.as_ref()),
            Expr::Convert { expr, styles, .. } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_exprs(styles)
            }
            Expr::Cast { expr, .. } => {
                self.validate_expr(expr.as_ref())?;
                Ok(())
            }
            Expr::AtTimeZone {
                timestamp,
                time_zone,
            } => {
                self.validate_expr(timestamp.as_ref())?;
                self.validate_expr(time_zone.as_ref())
            }
            Expr::Extract { expr, .. } | Expr::Collate { expr, .. } => {
                self.validate_expr(expr.as_ref())
            }
            Expr::Ceil { expr, field } | Expr::Floor { expr, field } => {
                self.validate_expr(expr.as_ref())?;
                let _ = field;
                Ok(())
            }
            Expr::Position { expr, r#in } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_expr(r#in.as_ref())
            }
            Expr::Substring {
                expr,
                substring_from,
                substring_for,
                ..
            } => {
                self.validate_expr(expr.as_ref())?;
                if let Some(from) = substring_from {
                    self.validate_expr(from.as_ref())?;
                }
                if let Some(for_expr) = substring_for {
                    self.validate_expr(for_expr.as_ref())?;
                }
                Ok(())
            }
            Expr::Trim {
                expr,
                trim_what,
                trim_characters,
                ..
            } => {
                self.validate_expr(expr.as_ref())?;
                if let Some(trim_what) = trim_what {
                    self.validate_expr(trim_what.as_ref())?;
                }
                if let Some(trim_characters) = trim_characters {
                    self.validate_exprs(trim_characters)?;
                }
                Ok(())
            }
            Expr::Overlay {
                expr,
                overlay_what,
                overlay_from,
                overlay_for,
            } => {
                self.validate_expr(expr.as_ref())?;
                self.validate_expr(overlay_what.as_ref())?;
                self.validate_expr(overlay_from.as_ref())?;
                if let Some(overlay_for) = overlay_for {
                    self.validate_expr(overlay_for.as_ref())?;
                }
                Ok(())
            }
            Expr::Prefixed { value, .. } => self.validate_expr(value.as_ref()),
            Expr::Function(function) => self.validate_function(function),
            Expr::Case {
                operand,
                conditions,
                else_result,
                ..
            } => {
                if let Some(operand) = operand {
                    self.validate_expr(operand.as_ref())?;
                }
                for condition in conditions {
                    self.validate_expr(&condition.condition)?;
                    self.validate_expr(&condition.result)?;
                }
                if let Some(else_result) = else_result {
                    self.validate_expr(else_result.as_ref())?;
                }
                Ok(())
            }
            Expr::Exists { subquery, .. } | Expr::Subquery(subquery) => {
                self.validate_query(subquery.as_ref())
            }
            Expr::GroupingSets(groups) | Expr::Cube(groups) | Expr::Rollup(groups) => {
                for group in groups {
                    self.validate_exprs(group)?;
                }
                Ok(())
            }
            Expr::Tuple(exprs) => self.validate_exprs(exprs),
            Expr::Array(array) => self.validate_exprs(&array.elem),
            Expr::Map(map) => {
                for entry in &map.entries {
                    self.validate_expr(entry.key.as_ref())?;
                    self.validate_expr(entry.value.as_ref())?;
                }
                Ok(())
            }
            Expr::Struct { values, .. } => self.validate_exprs(values),
            Expr::Named { expr, .. } => self.validate_expr(expr.as_ref()),
            Expr::Dictionary(fields) => {
                for field in fields {
                    self.validate_expr(&field.value)?;
                }
                Ok(())
            }
            Expr::Interval(interval) => {
                self.validate_expr(interval.value.as_ref())?;
                Ok(())
            }
            _ => invalid("unsupported expression variant"),
        }
    }

    fn validate_function(&mut self, function: &Function) -> Result<(), AppError> {
        if self.is_dynamic_query_function(&function.name) {
            return invalid("dynamic query functions are not allowed");
        }

        self.validate_function_arguments(&function.parameters)?;
        self.validate_function_arguments(&function.args)?;

        if let Some(filter) = &function.filter {
            self.validate_expr(filter.as_ref())?;
        }

        if let Some(over) = &function.over {
            self.validate_window_type(over)?;
        }

        for order_by in &function.within_group {
            self.validate_order_by_expr(order_by)?;
        }

        Ok(())
    }

    fn validate_window_type(&mut self, window_type: &WindowType) -> Result<(), AppError> {
        match window_type {
            WindowType::NamedWindow(_) => Ok(()),
            WindowType::WindowSpec(spec) => {
                self.validate_exprs(&spec.partition_by)?;
                for order_by in &spec.order_by {
                    self.validate_order_by_expr(order_by)?;
                }
                if let Some(frame) = &spec.window_frame {
                    self.validate_window_frame_bound(&frame.start_bound)?;
                    if let Some(end_bound) = &frame.end_bound {
                        self.validate_window_frame_bound(end_bound)?;
                    }
                }
                Ok(())
            }
        }
    }

    fn validate_function_arguments(
        &mut self,
        arguments: &FunctionArguments,
    ) -> Result<(), AppError> {
        match arguments {
            FunctionArguments::None => Ok(()),
            FunctionArguments::Subquery(query) => self.validate_query(query.as_ref()),
            FunctionArguments::List(list) => {
                for argument in &list.args {
                    self.validate_function_arg(argument)?;
                }
                for clause in &list.clauses {
                    match clause {
                        sqlparser::ast::FunctionArgumentClause::OrderBy(order_by) => {
                            for expr in order_by {
                                self.validate_order_by_expr(expr)?;
                            }
                        }
                        sqlparser::ast::FunctionArgumentClause::Limit(expr) => {
                            self.validate_expr(expr)?;
                        }
                        sqlparser::ast::FunctionArgumentClause::Having(bound) => {
                            self.validate_expr(&bound.1)?;
                        }
                        _ => {}
                    }
                }
                Ok(())
            }
        }
    }

    fn validate_function_arg(&mut self, argument: &FunctionArg) -> Result<(), AppError> {
        match argument {
            FunctionArg::Named { arg, .. } | FunctionArg::ExprNamed { arg, .. } => {
                self.validate_function_arg_expr(arg)
            }
            FunctionArg::Unnamed(arg) => self.validate_function_arg_expr(arg),
        }
    }

    fn validate_function_arg_expr(&mut self, expr: &FunctionArgExpr) -> Result<(), AppError> {
        match expr {
            FunctionArgExpr::Expr(expr) => self.validate_expr(expr),
            FunctionArgExpr::QualifiedWildcard(_) | FunctionArgExpr::Wildcard => Ok(()),
            FunctionArgExpr::WildcardWithOptions(_) => invalid("wildcard options are not allowed"),
        }
    }

    fn is_dynamic_query_function(&self, name: &ObjectName) -> bool {
        let Some(last_part) = name.0.last() else {
            return false;
        };

        let Some(ident) = last_part.as_ident() else {
            return true;
        };

        let normalized = normalize_identifier(&ident.value);
        DYNAMIC_QUERY_FUNCTIONS
            .iter()
            .any(|blocked| normalized == *blocked)
    }

    fn unqualified_relation_name(&self, name: &ObjectName) -> Result<String, AppError> {
        if name.0.len() != 1 {
            return invalid("qualified relations are not allowed");
        }

        match &name.0[0] {
            ObjectNamePart::Identifier(ident) => Ok(ident.value.clone()),
            ObjectNamePart::Function(_) => invalid("dynamic object names are not allowed"),
        }
    }

    fn validate_relation_name(&self, name: &str) -> Result<(), AppError> {
        let normalized = normalize_identifier(name);
        if self.is_cte_visible(&normalized) || self.allowed_tables.contains(&normalized) {
            return Ok(());
        }

        invalid(format!("unknown relation: {name}"))
    }

    fn is_cte_visible(&self, name: &str) -> bool {
        self.cte_scopes
            .iter()
            .rev()
            .any(|scope| scope.contains(name))
    }

    fn current_scope_mut(&mut self) -> Result<&mut HashSet<String>, AppError> {
        self.cte_scopes
            .last_mut()
            .ok_or_else(|| AppError::InvalidParam("internal CTE scope error".to_string()))
    }
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, AppError> {
    Err(AppError::InvalidParam(reason.into()))
}

#[cfg(test)]
mod tests {
    use super::{normalize_identifier, validate_read_only_query};

    use std::collections::HashSet;

    fn allowed() -> HashSet<String> {
        ["Sales", "Costs", "Order Details", "MixedCase"]
            .into_iter()
            .map(normalize_identifier)
            .collect()
    }

    #[test]
    fn accepts_project_tables_ctes_derived_queries_and_joins() {
        for sql in [
            "SELECT * FROM Sales",
            "WITH totals AS (SELECT * FROM Sales) SELECT * FROM totals",
            "SELECT * FROM (SELECT * FROM Sales) s",
            "SELECT * FROM Sales JOIN Costs USING (id)",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_ok(), "{sql}");
        }
    }

    #[test]
    fn rejects_non_project_and_active_relation_sources() {
        for sql in [
            "SELECT * FROM _meta_datasets",
            "SELECT * FROM information_schema.tables",
            "SELECT * FROM read_csv('secret.csv')",
            "SELECT * FROM query('SELECT 1')",
            "SELECT * FROM Missing",
            "TABLE Sales",
            "DELETE FROM Sales",
            "SELECT 1; SELECT 2",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_err(), "{sql}");
        }
    }

    #[test]
    fn accepts_nested_cte_scope_and_scalar_subqueries() {
        for sql in [
            "WITH outer_cte AS (WITH inner_cte AS (SELECT * FROM Sales) SELECT * FROM inner_cte) SELECT (SELECT COUNT(*) FROM outer_cte) FROM outer_cte",
            "SELECT * FROM Sales WHERE id IN (SELECT id FROM Costs)",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_ok(), "{sql}");
        }
    }

    #[test]
    fn accepts_quoted_names_case_insensitive_tables_and_cte_shadowing() {
        for sql in [
            "SELECT * FROM \"Order Details\"",
            "SELECT * FROM mixedcase",
            "WITH sales AS (SELECT * FROM Costs) SELECT * FROM sales",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_ok(), "{sql}");
        }
    }

    #[test]
    fn rejects_qualified_relations_table_functions_and_unknown_ctes() {
        for sql in [
            "SELECT * FROM main.Sales",
            "WITH scoped AS (SELECT * FROM Sales) SELECT * FROM missing_cte",
            "SELECT * FROM UNNEST([1, 2, 3])",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_err(), "{sql}");
        }
    }

    #[test]
    fn rejects_hidden_forbidden_sources_in_wildcard_options() {
        for sql in [
            "SELECT * REPLACE ((SELECT 1 FROM read_csv('secret.csv')) AS payload) FROM Sales",
            "SELECT Sales.* REPLACE ((SELECT 1 FROM read_csv('secret.csv')) AS payload) FROM Sales",
        ] {
            assert!(validate_read_only_query(sql, &allowed()).is_err(), "{sql}");
        }
    }

    #[test]
    fn rejects_hidden_forbidden_sources_in_json_path_keys() {
        let sql = "SELECT payload:[(SELECT 1 FROM read_csv('secret.csv'))] FROM Sales";

        assert!(validate_read_only_query(sql, &allowed()).is_err(), "{sql}");
    }
}

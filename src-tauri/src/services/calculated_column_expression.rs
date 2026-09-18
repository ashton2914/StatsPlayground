use std::collections::{HashMap, HashSet};

use sqlparser::keywords::Keyword;
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer, Word},
};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::models::calculated_column::{
    definition_fingerprint, expression_dependency_ids, CalculatedBinaryOperatorV1,
    CalculatedColumnDefinitionV1, CalculatedComparisonOperatorV1, CalculatedExpressionV1,
    CalculatedFunctionV1, CalculatedLogicalOperatorV1, CalculatedNumber, CalculatedOutputTypeV1,
    CalculatedUnaryOperatorV1,
};

const SCHEMA_VERSION_V1: &str = "1";
const DEFAULT_FORMULA_ID: &str = "formula-under-test";
const DEFAULT_OUTPUT_COLUMN_ID: &str = "output-under-test";
const MAX_FORMULA_BYTES: usize = 16_384;
const MAX_FORMULA_TOKENS: usize = 2_048;
const MAX_EXPRESSION_DEPTH: usize = 64;
const ROUND_DIGITS_MIN: i64 = -15;
const ROUND_DIGITS_MAX: i64 = 15;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaColumn {
    pub column_id: String,
    pub name: String,
    pub sql_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormulaError {
    Syntax {
        message: String,
    },
    Unsupported {
        message: String,
    },
    UnknownIdentifier {
        identifier: String,
    },
    AmbiguousIdentifier {
        identifier: String,
        column_ids: Vec<String>,
    },
    Type {
        message: String,
    },
    Limits {
        message: String,
    },
    DependencyGraph {
        message: String,
        path: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedCalculatedFormula {
    pub definition: CalculatedColumnDefinitionV1,
    pub normalized_display_formula: String,
    pub typed_expression: TypedCalculatedExpression,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledCalculatedExpression {
    pub value_sql: String,
    pub fault_predicates: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TypedCalculatedExpression {
    pub expression: CalculatedExpressionV1,
    pub output_type: TypedCalculatedOutput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypedCalculatedOutput {
    BigInt,
    Double,
    Boolean,
    Null,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaSqlColumn {
    pub column_id: String,
    pub sql_type: String,
    pub physical_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaGraphValidation {
    pub topological_output_column_ids: Vec<String>,
    pub dependency_paths: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ParsedFormulaExpression {
    Identifier {
        name: String,
        quoted: bool,
    },
    NumberLiteral {
        value: CalculatedNumber,
    },
    BooleanLiteral {
        value: bool,
    },
    NullLiteral,
    Unary {
        operator: CalculatedUnaryOperatorV1,
        operand: Box<Self>,
    },
    Group {
        expression: Box<Self>,
    },
    Binary {
        operator: CalculatedBinaryOperatorV1,
        left: Box<Self>,
        right: Box<Self>,
    },
    Comparison {
        operator: CalculatedComparisonOperatorV1,
        left: Box<Self>,
        right: Box<Self>,
    },
    Logical {
        operator: CalculatedLogicalOperatorV1,
        left: Box<Self>,
        right: Box<Self>,
    },
    Function {
        function: CalculatedFunctionV1,
        arguments: Vec<Self>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FormulaType {
    BigInt,
    Double,
    Boolean,
    Null,
}

pub fn parse(text: &str) -> Result<ParsedFormulaExpression, FormulaError> {
    let tokens = tokenize(text)?;
    let mut parser = FormulaParser::new(tokens);
    let expression = parser.parse_expression()?;
    if parser.has_remaining() {
        return Err(FormulaError::Syntax {
            message: format!(
                "unexpected token {} at end of formula",
                token_description(parser.peek())
            ),
        });
    }
    ensure_expression_depth(&expression)?;
    Ok(expression)
}

pub fn parse_and_validate_formula(
    text: &str,
    columns: &[FormulaColumn],
    output_column_id: Option<&str>,
    _existing_definitions: &[CalculatedColumnDefinitionV1],
) -> Result<ValidatedCalculatedFormula, FormulaError> {
    let parsed = parse(text)?;
    let catalog = FormulaCatalog::new(columns);
    let (expression, inferred_type) = bind_expression(&parsed, &catalog, output_column_id)?;
    let normalized_display_formula = format_formula(&expression, columns)?;
    let definition = CalculatedColumnDefinitionV1 {
        formula_id: DEFAULT_FORMULA_ID.to_string(),
        schema_version: SCHEMA_VERSION_V1.to_string(),
        output_column_id: output_column_id
            .unwrap_or(DEFAULT_OUTPUT_COLUMN_ID)
            .to_string(),
        dependency_column_ids: expression_dependency_ids(&expression),
        inferred_output_type: inferred_type.into_v1(),
        fingerprint: String::new(),
        expression,
    };
    let typed_expression = TypedCalculatedExpression {
        expression: definition.expression.clone(),
        output_type: inferred_type.into_public(),
    };
    let fingerprint = definition_fingerprint(&definition);

    Ok(ValidatedCalculatedFormula {
        definition: CalculatedColumnDefinitionV1 {
            fingerprint,
            ..definition
        },
        normalized_display_formula,
        typed_expression,
    })
}

pub fn format_formula(
    expression: &CalculatedExpressionV1,
    columns: &[FormulaColumn],
) -> Result<String, FormulaError> {
    let names_by_id = columns
        .iter()
        .map(|column| (column.column_id.as_str(), column.name.as_str()))
        .collect::<HashMap<_, _>>();
    format_expression(expression, 0, false, &names_by_id)
}

pub fn compile_formula_sql(
    expression: &TypedCalculatedExpression,
    columns: &[FormulaSqlColumn],
) -> Result<CompiledCalculatedExpression, FormulaError> {
    let catalog = FormulaSqlCatalog::new(columns)?;
    let compiled = compile_sql_expression(&expression.expression, &catalog)?;
    if compiled.output_type != formula_type_from_public(expression.output_type) {
        return Err(FormulaError::Type {
            message: "typed SQL compiler received an expression with mismatched output type"
                .to_string(),
        });
    }

    let mut fault_predicates = compiled.fault_predicates;
    let value_sql = if compiled.output_type == FormulaType::Double {
        let raw_sql = compiled.value_sql;
        let non_finite_fault = format!("(({raw_sql}) IS NOT NULL AND NOT isfinite(({raw_sql})))");
        fault_predicates.push(non_finite_fault.clone());
        format!("CASE WHEN {non_finite_fault} THEN NULL ELSE ({raw_sql}) END")
    } else {
        compiled.value_sql
    };

    Ok(CompiledCalculatedExpression {
        value_sql,
        fault_predicates,
    })
}

pub fn validate_formula_graph(
    candidate: &CalculatedColumnDefinitionV1,
    existing_definitions: &[CalculatedColumnDefinitionV1],
    columns: &[FormulaColumn],
) -> Result<FormulaGraphValidation, FormulaError> {
    let mut definitions_by_output = HashMap::<&str, &CalculatedColumnDefinitionV1>::new();
    for definition in existing_definitions
        .iter()
        .chain(std::iter::once(candidate))
    {
        let expected_dependencies = expression_dependency_ids(&definition.expression);
        if expected_dependencies != definition.dependency_column_ids {
            return Err(FormulaError::DependencyGraph {
                message: format!(
                    "definition {} dependency ids do not match its expression",
                    definition.output_column_id
                ),
                path: vec![definition.output_column_id.clone()],
            });
        }
        if definition_fingerprint(definition) != definition.fingerprint {
            return Err(FormulaError::DependencyGraph {
                message: format!(
                    "definition {} fingerprint does not match its canonical form",
                    definition.output_column_id
                ),
                path: vec![definition.output_column_id.clone()],
            });
        }
        if definitions_by_output
            .insert(definition.output_column_id.as_str(), definition)
            .is_some()
        {
            return Err(FormulaError::DependencyGraph {
                message: format!(
                    "duplicate calculated output column id {}",
                    definition.output_column_id
                ),
                path: vec![definition.output_column_id.clone()],
            });
        }
    }

    let base_column_ids = columns
        .iter()
        .map(|column| column.column_id.as_str())
        .collect::<HashSet<_>>();
    let mut visiting = Vec::<String>::new();
    let mut visited = HashSet::<String>::new();
    let mut topological_output_column_ids = Vec::<String>::new();
    visit_graph(
        candidate.output_column_id.as_str(),
        &definitions_by_output,
        &base_column_ids,
        &mut visiting,
        &mut visited,
        &mut topological_output_column_ids,
    )?;

    let mut dependency_paths = Vec::new();
    let mut current_path = vec![candidate.output_column_id.clone()];
    collect_dependency_paths(
        candidate.output_column_id.as_str(),
        &definitions_by_output,
        &base_column_ids,
        &mut current_path,
        &mut dependency_paths,
    )?;

    Ok(FormulaGraphValidation {
        topological_output_column_ids,
        dependency_paths,
    })
}

fn collect_dependency_paths(
    output_column_id: &str,
    definitions_by_output: &HashMap<&str, &CalculatedColumnDefinitionV1>,
    base_column_ids: &HashSet<&str>,
    current_path: &mut Vec<String>,
    dependency_paths: &mut Vec<Vec<String>>,
) -> Result<(), FormulaError> {
    let Some(definition) = definitions_by_output.get(output_column_id) else {
        return Ok(());
    };

    for dependency_column_id in &definition.dependency_column_ids {
        current_path.push(dependency_column_id.clone());
        if definitions_by_output.contains_key(dependency_column_id.as_str()) {
            collect_dependency_paths(
                dependency_column_id,
                definitions_by_output,
                base_column_ids,
                current_path,
                dependency_paths,
            )?;
        } else if base_column_ids.contains(dependency_column_id.as_str()) {
            dependency_paths.push(current_path.clone());
        } else {
            return Err(FormulaError::DependencyGraph {
                message: format!(
                    "missing dependency column {dependency_column_id} for calculated column {output_column_id}"
                ),
                path: current_path.clone(),
            });
        }
        current_path.pop();
    }
    Ok(())
}
fn visit_graph(
    output_column_id: &str,
    definitions_by_output: &HashMap<&str, &CalculatedColumnDefinitionV1>,
    base_column_ids: &HashSet<&str>,
    visiting: &mut Vec<String>,
    visited: &mut HashSet<String>,
    topological_output_column_ids: &mut Vec<String>,
) -> Result<(), FormulaError> {
    if visited.contains(output_column_id) {
        return Ok(());
    }
    if let Some(index) = visiting.iter().position(|value| value == output_column_id) {
        let mut path = visiting[index..].to_vec();
        path.push(output_column_id.to_string());
        return Err(FormulaError::DependencyGraph {
            message: format!("calculated column cycle detected at {output_column_id}"),
            path,
        });
    }

    let Some(definition) = definitions_by_output.get(output_column_id) else {
        return Ok(());
    };

    visiting.push(output_column_id.to_string());
    for dependency_column_id in &definition.dependency_column_ids {
        if definitions_by_output.contains_key(dependency_column_id.as_str()) {
            visit_graph(
                dependency_column_id,
                definitions_by_output,
                base_column_ids,
                visiting,
                visited,
                topological_output_column_ids,
            )?;
        } else if !base_column_ids.contains(dependency_column_id.as_str()) {
            let mut path = visiting.clone();
            path.push(dependency_column_id.clone());
            return Err(FormulaError::DependencyGraph {
                message: format!(
                    "missing dependency column {dependency_column_id} for calculated column {output_column_id}"
                ),
                path,
            });
        }
    }
    visiting.pop();
    visited.insert(output_column_id.to_string());
    topological_output_column_ids.push(output_column_id.to_string());
    Ok(())
}

fn tokenize(text: &str) -> Result<Vec<Token>, FormulaError> {
    if text.len() > MAX_FORMULA_BYTES {
        return Err(FormulaError::Limits {
            message: format!("formula exceeds maximum byte length of {MAX_FORMULA_BYTES}"),
        });
    }

    let filtered = tokenize_with_bracket_identifiers(text)?;
    if filtered.len() > MAX_FORMULA_TOKENS {
        return Err(FormulaError::Limits {
            message: format!("formula exceeds maximum token count of {MAX_FORMULA_TOKENS}"),
        });
    }
    Ok(filtered)
}

fn bind_expression(
    expression: &ParsedFormulaExpression,
    catalog: &FormulaCatalog<'_>,
    output_column_id: Option<&str>,
) -> Result<(CalculatedExpressionV1, FormulaType), FormulaError> {
    match expression {
        ParsedFormulaExpression::Identifier { name, quoted } => {
            let column = catalog.resolve(name, *quoted)?;
            if output_column_id.is_some_and(|current_id| current_id == column.column_id) {
                return Err(FormulaError::Unsupported {
                    message: format!("formula cannot reference its own output column {name}"),
                });
            }
            Ok((
                CalculatedExpressionV1::ColumnRef {
                    column_id: column.column_id.to_string(),
                },
                column.formula_type.ok_or_else(|| FormulaError::Type {
                    message: format!(
                        "column {name} has unsupported source type {}",
                        column.sql_type
                    ),
                })?,
            ))
        }
        ParsedFormulaExpression::NumberLiteral { value } => Ok((
            CalculatedExpressionV1::NumberLiteral {
                value: value.clone(),
            },
            match value {
                CalculatedNumber::Integer(_) => FormulaType::BigInt,
                CalculatedNumber::Float(_) => FormulaType::Double,
            },
        )),
        ParsedFormulaExpression::BooleanLiteral { value } => Ok((
            CalculatedExpressionV1::BooleanLiteral { value: *value },
            FormulaType::Boolean,
        )),
        ParsedFormulaExpression::NullLiteral => {
            Ok((CalculatedExpressionV1::NullLiteral, FormulaType::Null))
        }
        ParsedFormulaExpression::Group { expression } => {
            bind_expression(expression, catalog, output_column_id)
        }
        ParsedFormulaExpression::Unary { operator, operand } => {
            let (bound_operand, operand_type) =
                bind_expression(operand, catalog, output_column_id)?;
            let result_type = infer_unary_type(operator, operand_type)?;
            Ok((
                CalculatedExpressionV1::Unary {
                    operator: operator.clone(),
                    operand: Box::new(bound_operand),
                },
                result_type,
            ))
        }
        ParsedFormulaExpression::Binary {
            operator,
            left,
            right,
        } => {
            let (bound_left, left_type) = bind_expression(left, catalog, output_column_id)?;
            let (bound_right, right_type) = bind_expression(right, catalog, output_column_id)?;
            let result_type = infer_binary_type(operator, left_type, right_type)?;
            Ok((
                CalculatedExpressionV1::Binary {
                    operator: operator.clone(),
                    left: Box::new(bound_left),
                    right: Box::new(bound_right),
                },
                result_type,
            ))
        }
        ParsedFormulaExpression::Comparison {
            operator,
            left,
            right,
        } => {
            let (bound_left, left_type) = bind_expression(left, catalog, output_column_id)?;
            let (bound_right, right_type) = bind_expression(right, catalog, output_column_id)?;
            infer_comparison_type(left_type, right_type)?;
            Ok((
                CalculatedExpressionV1::Comparison {
                    operator: operator.clone(),
                    left: Box::new(bound_left),
                    right: Box::new(bound_right),
                },
                FormulaType::Boolean,
            ))
        }
        ParsedFormulaExpression::Logical {
            operator,
            left,
            right,
        } => {
            let (bound_left, left_type) = bind_expression(left, catalog, output_column_id)?;
            let (bound_right, right_type) = bind_expression(right, catalog, output_column_id)?;
            ensure_boolean(left_type, "logical left operand")?;
            ensure_boolean(right_type, "logical right operand")?;
            Ok((
                CalculatedExpressionV1::Logical {
                    operator: operator.clone(),
                    left: Box::new(bound_left),
                    right: Box::new(bound_right),
                },
                FormulaType::Boolean,
            ))
        }
        ParsedFormulaExpression::Function {
            function,
            arguments,
        } => bind_function(function, arguments, catalog, output_column_id),
    }
}

fn bind_function(
    function: &CalculatedFunctionV1,
    arguments: &[ParsedFormulaExpression],
    catalog: &FormulaCatalog<'_>,
    output_column_id: Option<&str>,
) -> Result<(CalculatedExpressionV1, FormulaType), FormulaError> {
    if matches!(function, CalculatedFunctionV1::Round) {
        validate_round_precision(arguments)?;
    }
    let bound_arguments = arguments
        .iter()
        .map(|argument| bind_expression(argument, catalog, output_column_id))
        .collect::<Result<Vec<_>, _>>()?;
    let argument_types = bound_arguments
        .iter()
        .map(|(_, formula_type)| *formula_type)
        .collect::<Vec<_>>();
    let bound_expression = CalculatedExpressionV1::Function {
        function: function.clone(),
        arguments: bound_arguments
            .into_iter()
            .map(|(expression, _)| expression)
            .collect(),
    };
    let inferred_type = infer_function_type(function, &argument_types)?;
    Ok((bound_expression, inferred_type))
}

fn infer_unary_type(
    operator: &CalculatedUnaryOperatorV1,
    operand_type: FormulaType,
) -> Result<FormulaType, FormulaError> {
    match operator {
        CalculatedUnaryOperatorV1::Plus | CalculatedUnaryOperatorV1::Minus => {
            ensure_numeric(operand_type, "unary operand")?;
            Ok(operand_type)
        }
        CalculatedUnaryOperatorV1::Not => {
            ensure_boolean(operand_type, "NOT operand")?;
            Ok(FormulaType::Boolean)
        }
    }
}

fn infer_binary_type(
    operator: &CalculatedBinaryOperatorV1,
    left_type: FormulaType,
    right_type: FormulaType,
) -> Result<FormulaType, FormulaError> {
    ensure_numeric(left_type, "arithmetic left operand")?;
    ensure_numeric(right_type, "arithmetic right operand")?;
    Ok(match operator {
        CalculatedBinaryOperatorV1::Divide => FormulaType::Double,
        CalculatedBinaryOperatorV1::Add
        | CalculatedBinaryOperatorV1::Subtract
        | CalculatedBinaryOperatorV1::Multiply => promote_numeric_types(left_type, right_type),
    })
}

fn infer_comparison_type(
    left_type: FormulaType,
    right_type: FormulaType,
) -> Result<(), FormulaError> {
    if left_type == FormulaType::Null || right_type == FormulaType::Null {
        return Ok(());
    }
    if left_type == right_type {
        return Ok(());
    }
    if is_numeric(left_type) && is_numeric(right_type) {
        return Ok(());
    }
    Err(FormulaError::Type {
        message: format!(
            "cannot compare {} with {}",
            left_type.label(),
            right_type.label()
        ),
    })
}

fn infer_function_type(
    function: &CalculatedFunctionV1,
    argument_types: &[FormulaType],
) -> Result<FormulaType, FormulaError> {
    match function {
        CalculatedFunctionV1::Abs => {
            require_arity(function, argument_types, 1)?;
            ensure_numeric(argument_types[0], "ABS argument")?;
            Ok(argument_types[0])
        }
        CalculatedFunctionV1::Coalesce => {
            if argument_types.len() < 2 {
                return Err(FormulaError::Type {
                    message: "COALESCE requires at least two arguments".to_string(),
                });
            }
            merge_types(argument_types)
        }
        CalculatedFunctionV1::If => {
            require_arity(function, argument_types, 3)?;
            ensure_boolean_or_null(argument_types[0], "IF condition")?;
            merge_types(&argument_types[1..])
        }
        CalculatedFunctionV1::Max | CalculatedFunctionV1::Min => {
            if argument_types.len() < 2 {
                return Err(FormulaError::Type {
                    message: format!(
                        "{} requires at least two arguments",
                        function_name(function)
                    ),
                });
            }
            merge_types(argument_types)
        }
        CalculatedFunctionV1::Round => {
            if !(argument_types.len() == 1 || argument_types.len() == 2) {
                return Err(FormulaError::Type {
                    message: "ROUND requires one or two arguments".to_string(),
                });
            }
            ensure_numeric(argument_types[0], "ROUND value")?;
            if argument_types.len() == 2
                && !matches!(argument_types[1], FormulaType::BigInt | FormulaType::Null)
            {
                return Err(FormulaError::Type {
                    message: "ROUND precision must be an integer literal".to_string(),
                });
            }
            Ok(argument_types[0])
        }
    }
}

fn require_arity(
    function: &CalculatedFunctionV1,
    argument_types: &[FormulaType],
    expected: usize,
) -> Result<(), FormulaError> {
    if argument_types.len() == expected {
        Ok(())
    } else {
        Err(FormulaError::Type {
            message: format!(
                "{} requires {expected} argument(s)",
                function_name(function)
            ),
        })
    }
}

fn merge_types(argument_types: &[FormulaType]) -> Result<FormulaType, FormulaError> {
    let mut merged = FormulaType::Null;
    for formula_type in argument_types {
        if *formula_type == FormulaType::Null {
            continue;
        }
        if merged == FormulaType::Null {
            merged = *formula_type;
            continue;
        }
        if is_numeric(merged) && is_numeric(*formula_type) {
            merged = promote_numeric_types(merged, *formula_type);
            continue;
        }
        if merged == *formula_type {
            continue;
        }
        return Err(FormulaError::Type {
            message: format!(
                "incompatible argument types: {} and {}",
                merged.label(),
                formula_type.label()
            ),
        });
    }
    Ok(merged)
}

fn ensure_numeric(formula_type: FormulaType, context: &str) -> Result<(), FormulaError> {
    if is_numeric(formula_type) || formula_type == FormulaType::Null {
        Ok(())
    } else {
        Err(FormulaError::Type {
            message: format!("{context} must be numeric, found {}", formula_type.label()),
        })
    }
}

fn ensure_boolean(formula_type: FormulaType, context: &str) -> Result<(), FormulaError> {
    if formula_type == FormulaType::Boolean || formula_type == FormulaType::Null {
        Ok(())
    } else {
        Err(FormulaError::Type {
            message: format!("{context} must be boolean, found {}", formula_type.label()),
        })
    }
}

fn ensure_boolean_or_null(formula_type: FormulaType, context: &str) -> Result<(), FormulaError> {
    ensure_boolean(formula_type, context)
}

fn is_numeric(formula_type: FormulaType) -> bool {
    matches!(formula_type, FormulaType::BigInt | FormulaType::Double)
}

fn promote_numeric_types(left: FormulaType, right: FormulaType) -> FormulaType {
    if left == FormulaType::Double || right == FormulaType::Double {
        FormulaType::Double
    } else {
        FormulaType::BigInt
    }
}

impl FormulaType {
    fn label(self) -> &'static str {
        match self {
            Self::BigInt => "BIGINT",
            Self::Double => "DOUBLE",
            Self::Boolean => "BOOLEAN",
            Self::Null => "NULL",
        }
    }

    fn into_v1(self) -> CalculatedOutputTypeV1 {
        match self {
            Self::BigInt => CalculatedOutputTypeV1::Integer,
            Self::Double => CalculatedOutputTypeV1::Continuous,
            Self::Boolean => CalculatedOutputTypeV1::Boolean,
            Self::Null => CalculatedOutputTypeV1::Null,
        }
    }

    fn into_public(self) -> TypedCalculatedOutput {
        match self {
            Self::BigInt => TypedCalculatedOutput::BigInt,
            Self::Double => TypedCalculatedOutput::Double,
            Self::Boolean => TypedCalculatedOutput::Boolean,
            Self::Null => TypedCalculatedOutput::Null,
        }
    }
}

struct FormulaCatalog<'a> {
    exact_names: HashMap<&'a str, Vec<ResolvedColumn<'a>>>,
    simple_names: HashMap<String, Vec<ResolvedColumn<'a>>>,
}

#[derive(Clone, Copy)]
struct ResolvedColumn<'a> {
    column_id: &'a str,
    formula_type: Option<FormulaType>,
    sql_type: &'a str,
}

impl<'a> FormulaCatalog<'a> {
    fn new(columns: &'a [FormulaColumn]) -> Self {
        let mut exact_names = HashMap::<&'a str, Vec<ResolvedColumn<'a>>>::new();
        let mut simple_names = HashMap::<String, Vec<ResolvedColumn<'a>>>::new();
        for column in columns {
            let resolved = ResolvedColumn {
                column_id: &column.column_id,
                formula_type: sql_type_to_formula_type(&column.sql_type),
                sql_type: &column.sql_type,
            };
            exact_names.entry(&column.name).or_default().push(resolved);
            if let Some(simple_name) = normalize_simple_identifier(&column.name) {
                simple_names.entry(simple_name).or_default().push(resolved);
            }
        }
        Self {
            exact_names,
            simple_names,
        }
    }

    fn resolve(&self, identifier: &str, quoted: bool) -> Result<ResolvedColumn<'a>, FormulaError> {
        let matches = if quoted {
            self.exact_names
                .get(identifier)
                .cloned()
                .unwrap_or_default()
        } else if let Some(simple_name) = normalize_simple_identifier(identifier) {
            self.simple_names
                .get(&simple_name)
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        match matches.as_slice() {
            [] => Err(FormulaError::UnknownIdentifier {
                identifier: identifier.to_string(),
            }),
            [column] => {
                if let Some(formula_type) = column.formula_type {
                    Ok(ResolvedColumn {
                        column_id: column.column_id,
                        formula_type: Some(formula_type),
                        sql_type: column.sql_type,
                    })
                } else {
                    Err(FormulaError::Type {
                        message: format!(
                            "column {identifier} has unsupported source type {}",
                            column.sql_type
                        ),
                    })
                }
            }
            columns => Err(FormulaError::AmbiguousIdentifier {
                identifier: identifier.to_string(),
                column_ids: columns
                    .iter()
                    .map(|column| column.column_id.to_string())
                    .collect(),
            }),
        }
    }
}

fn tokenize_with_bracket_identifiers(text: &str) -> Result<Vec<Token>, FormulaError> {
    let dialect = GenericDialect {};
    let mut tokens = Vec::new();
    let mut remaining = text;

    while let Some(bracket_start) = remaining.find('[') {
        let (prefix, suffix) = remaining.split_at(bracket_start);
        tokenize_standard_segment(prefix, &dialect, &mut tokens)?;
        let (identifier, rest) = parse_bracket_identifier(suffix)?;
        tokens.push(Token::Word(Word {
            value: identifier,
            quote_style: Some('['),
            keyword: Keyword::NoKeyword,
        }));
        remaining = rest;
    }

    tokenize_standard_segment(remaining, &dialect, &mut tokens)?;
    Ok(tokens)
}

fn tokenize_standard_segment(
    segment: &str,
    dialect: &GenericDialect,
    tokens: &mut Vec<Token>,
) -> Result<(), FormulaError> {
    if segment.is_empty() {
        return Ok(());
    }

    let standard_tokens = Tokenizer::new(dialect, segment)
        .tokenize()
        .map_err(|error| FormulaError::Syntax {
            message: error.to_string(),
        })?;
    tokens.extend(
        standard_tokens
            .into_iter()
            .filter(|token| !matches!(token, Token::Whitespace(_))),
    );
    Ok(())
}

fn parse_bracket_identifier(text: &str) -> Result<(String, &str), FormulaError> {
    let Some(mut rest) = text.strip_prefix('[') else {
        return Err(FormulaError::Syntax {
            message: "expected '['".to_string(),
        });
    };
    let mut identifier = String::new();

    loop {
        let Some(character) = rest.chars().next() else {
            return Err(FormulaError::Syntax {
                message: "unterminated bracketed identifier".to_string(),
            });
        };
        rest = &rest[character.len_utf8()..];
        if character == ']' {
            if let Some(next_rest) = rest.strip_prefix(']') {
                identifier.push(']');
                rest = next_rest;
                continue;
            }
            return Ok((identifier, rest));
        }
        identifier.push(character);
    }
}

fn validate_round_precision(arguments: &[ParsedFormulaExpression]) -> Result<(), FormulaError> {
    if arguments.len() < 2 {
        return Ok(());
    }
    let digits =
        parse_integer_literal_expression(&arguments[1]).ok_or_else(|| FormulaError::Type {
            message: "ROUND precision must be an integer literal".to_string(),
        })?;
    if !(ROUND_DIGITS_MIN..=ROUND_DIGITS_MAX).contains(&digits) {
        return Err(FormulaError::Limits {
            message: format!(
                "ROUND precision must be between {ROUND_DIGITS_MIN} and {ROUND_DIGITS_MAX}"
            ),
        });
    }
    Ok(())
}

fn parse_integer_literal_expression(expression: &ParsedFormulaExpression) -> Option<i64> {
    match expression {
        ParsedFormulaExpression::NumberLiteral {
            value: CalculatedNumber::Integer(value),
        } => Some(*value),
        ParsedFormulaExpression::Group { expression } => {
            parse_integer_literal_expression(expression)
        }
        ParsedFormulaExpression::Unary {
            operator: CalculatedUnaryOperatorV1::Plus,
            operand,
        } => parse_integer_literal_expression(operand),
        ParsedFormulaExpression::Unary {
            operator: CalculatedUnaryOperatorV1::Minus,
            operand,
        } => parse_integer_literal_expression(operand)?.checked_neg(),
        _ => None,
    }
}

fn sql_type_to_formula_type(sql_type: &str) -> Option<FormulaType> {
    let normalized = sql_type.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "BOOLEAN" => Some(FormulaType::Boolean),
        "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "UTINYINT" | "USMALLINT" | "UINTEGER"
        | "UBIGINT" | "HUGEINT" => Some(FormulaType::BigInt),
        "FLOAT" | "REAL" | "DOUBLE" | "DECIMAL" | "NUMERIC" => Some(FormulaType::Double),
        _ => None,
    }
}

fn formula_type_from_public(output_type: TypedCalculatedOutput) -> FormulaType {
    match output_type {
        TypedCalculatedOutput::BigInt => FormulaType::BigInt,
        TypedCalculatedOutput::Double => FormulaType::Double,
        TypedCalculatedOutput::Boolean => FormulaType::Boolean,
        TypedCalculatedOutput::Null => FormulaType::Null,
    }
}

struct FormulaSqlCatalog<'a> {
    by_column_id: HashMap<&'a str, SqlResolvedColumn<'a>>,
}

#[derive(Clone, Copy)]
struct SqlResolvedColumn<'a> {
    column_id: &'a str,
    formula_type: Option<FormulaType>,
    sql_type: &'a str,
    physical_name: &'a str,
}

#[derive(Clone, Debug)]
struct CompiledSqlNode {
    value_sql: String,
    output_type: FormulaType,
    fault_predicates: Vec<String>,
}

impl<'a> FormulaSqlCatalog<'a> {
    fn new(columns: &'a [FormulaSqlColumn]) -> Result<Self, FormulaError> {
        let mut by_column_id = HashMap::new();
        for column in columns {
            by_column_id.insert(
                column.column_id.as_str(),
                SqlResolvedColumn {
                    column_id: &column.column_id,
                    formula_type: sql_type_to_formula_type(&column.sql_type),
                    sql_type: &column.sql_type,
                    physical_name: &column.physical_name,
                },
            );
        }
        Ok(Self { by_column_id })
    }

    fn resolve(&self, column_id: &str) -> Result<SqlResolvedColumn<'a>, FormulaError> {
        let column = self.by_column_id.get(column_id).copied().ok_or_else(|| {
            FormulaError::UnknownIdentifier {
                identifier: column_id.to_string(),
            }
        })?;
        if column.formula_type.is_none() {
            return Err(FormulaError::Type {
                message: format!(
                    "sql compiler column {} has unsupported type {}",
                    column.column_id, column.sql_type
                ),
            });
        }
        Ok(column)
    }
}

fn compile_sql_expression(
    expression: &CalculatedExpressionV1,
    catalog: &FormulaSqlCatalog<'_>,
) -> Result<CompiledSqlNode, FormulaError> {
    match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => {
            let column = catalog.resolve(column_id)?;
            Ok(CompiledSqlNode {
                value_sql: DuckDbEngine::quote_identifier(column.physical_name),
                output_type: column.formula_type.ok_or_else(|| FormulaError::Type {
                    message: format!(
                        "sql compiler column {} has unsupported type {}",
                        column.column_id, column.sql_type
                    ),
                })?,
                fault_predicates: Vec::new(),
            })
        }
        CalculatedExpressionV1::NumberLiteral { value } => Ok(CompiledSqlNode {
            value_sql: format_number(value),
            output_type: match value {
                CalculatedNumber::Integer(_) => FormulaType::BigInt,
                CalculatedNumber::Float(_) => FormulaType::Double,
            },
            fault_predicates: Vec::new(),
        }),
        CalculatedExpressionV1::BooleanLiteral { value } => Ok(CompiledSqlNode {
            value_sql: if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            },
            output_type: FormulaType::Boolean,
            fault_predicates: Vec::new(),
        }),
        CalculatedExpressionV1::NullLiteral => Ok(CompiledSqlNode {
            value_sql: "NULL".to_string(),
            output_type: FormulaType::Null,
            fault_predicates: Vec::new(),
        }),
        CalculatedExpressionV1::Unary { operator, operand } => {
            let operand = compile_sql_expression(operand, catalog)?;
            compile_unary_sql(operator, operand)
        }
        CalculatedExpressionV1::Binary {
            operator,
            left,
            right,
        } => {
            let left = compile_sql_expression(left, catalog)?;
            let right = compile_sql_expression(right, catalog)?;
            compile_binary_sql(operator, left, right)
        }
        CalculatedExpressionV1::Comparison {
            operator,
            left,
            right,
        } => {
            let left = compile_sql_expression(left, catalog)?;
            let right = compile_sql_expression(right, catalog)?;
            infer_comparison_type(left.output_type, right.output_type)?;
            let mut fault_predicates = left.fault_predicates;
            fault_predicates.extend(right.fault_predicates);
            Ok(CompiledSqlNode {
                value_sql: format!(
                    "(({}) {} ({}))",
                    left.value_sql,
                    comparison_symbol(operator),
                    right.value_sql
                ),
                output_type: FormulaType::Boolean,
                fault_predicates,
            })
        }
        CalculatedExpressionV1::Logical {
            operator,
            left,
            right,
        } => {
            let left = compile_sql_expression(left, catalog)?;
            let right = compile_sql_expression(right, catalog)?;
            ensure_boolean(left.output_type, "logical left operand")?;
            ensure_boolean(right.output_type, "logical right operand")?;
            let mut fault_predicates = left.fault_predicates;
            fault_predicates.extend(right.fault_predicates);
            Ok(CompiledSqlNode {
                value_sql: format!(
                    "(({}) {} ({}))",
                    left.value_sql,
                    logical_symbol(operator),
                    right.value_sql
                ),
                output_type: FormulaType::Boolean,
                fault_predicates,
            })
        }
        CalculatedExpressionV1::Function {
            function,
            arguments,
        } => compile_function_sql(function, arguments, catalog),
    }
}

fn compile_unary_sql(
    operator: &CalculatedUnaryOperatorV1,
    operand: CompiledSqlNode,
) -> Result<CompiledSqlNode, FormulaError> {
    let result_type = infer_unary_type(operator, operand.output_type)?;
    match operator {
        CalculatedUnaryOperatorV1::Plus => Ok(CompiledSqlNode {
            value_sql: format!("(+({}))", operand.value_sql),
            output_type: result_type,
            fault_predicates: operand.fault_predicates,
        }),
        CalculatedUnaryOperatorV1::Minus if result_type == FormulaType::BigInt => {
            let raw_sql = format!("(-CAST(({}) AS HUGEINT))", operand.value_sql);
            let value_sql = format!("TRY_CAST({raw_sql} AS BIGINT)");
            let mut fault_predicates = operand.fault_predicates;
            fault_predicates.push(format!(
                "(({}) IS NOT NULL AND {value_sql} IS NULL)",
                operand.value_sql
            ));
            Ok(CompiledSqlNode {
                value_sql,
                output_type: result_type,
                fault_predicates,
            })
        }
        CalculatedUnaryOperatorV1::Minus => Ok(CompiledSqlNode {
            value_sql: format!("(-CAST(({}) AS DOUBLE))", operand.value_sql),
            output_type: result_type,
            fault_predicates: operand.fault_predicates,
        }),
        CalculatedUnaryOperatorV1::Not => Ok(CompiledSqlNode {
            value_sql: format!("(NOT ({}))", operand.value_sql),
            output_type: FormulaType::Boolean,
            fault_predicates: operand.fault_predicates,
        }),
    }
}

fn compile_binary_sql(
    operator: &CalculatedBinaryOperatorV1,
    left: CompiledSqlNode,
    right: CompiledSqlNode,
) -> Result<CompiledSqlNode, FormulaError> {
    let result_type = infer_binary_type(operator, left.output_type, right.output_type)?;
    let mut fault_predicates = left.fault_predicates;
    fault_predicates.extend(right.fault_predicates);

    if matches!(operator, CalculatedBinaryOperatorV1::Divide) {
        let divide_fault = format!(
            "(({}) IS NOT NULL AND ({}) = 0)",
            right.value_sql, right.value_sql
        );
        let value_sql = format!(
            "CASE WHEN ({}) IS NULL THEN NULL WHEN ({}) = 0 THEN NULL ELSE (CAST(({}) AS DOUBLE) / CAST(({}) AS DOUBLE)) END",
            right.value_sql, right.value_sql, left.value_sql, right.value_sql
        );
        fault_predicates.push(divide_fault);
        return Ok(CompiledSqlNode {
            value_sql,
            output_type: result_type,
            fault_predicates,
        });
    }

    if result_type == FormulaType::BigInt {
        let operator_sql = binary_symbol(operator);
        let hugeint_sql = format!(
            "(CAST(({}) AS HUGEINT) {operator_sql} CAST(({}) AS HUGEINT))",
            left.value_sql, right.value_sql
        );
        let value_sql = format!("TRY_CAST({hugeint_sql} AS BIGINT)");
        fault_predicates.push(format!(
            "(({}) IS NOT NULL AND ({}) IS NOT NULL AND {value_sql} IS NULL)",
            left.value_sql, right.value_sql
        ));
        return Ok(CompiledSqlNode {
            value_sql,
            output_type: result_type,
            fault_predicates,
        });
    }

    let left_sql = if left.output_type == FormulaType::Double {
        left.value_sql
    } else {
        format!("CAST(({}) AS DOUBLE)", left.value_sql)
    };
    let right_sql = if right.output_type == FormulaType::Double {
        right.value_sql
    } else {
        format!("CAST(({}) AS DOUBLE)", right.value_sql)
    };
    Ok(CompiledSqlNode {
        value_sql: format!("(({left_sql}) {} ({right_sql}))", binary_symbol(operator)),
        output_type: result_type,
        fault_predicates,
    })
}

fn compile_function_sql(
    function: &CalculatedFunctionV1,
    arguments: &[CalculatedExpressionV1],
    catalog: &FormulaSqlCatalog<'_>,
) -> Result<CompiledSqlNode, FormulaError> {
    let compiled_arguments = arguments
        .iter()
        .map(|argument| compile_sql_expression(argument, catalog))
        .collect::<Result<Vec<_>, _>>()?;
    let argument_types = compiled_arguments
        .iter()
        .map(|argument| argument.output_type)
        .collect::<Vec<_>>();
    let result_type = infer_function_type(function, &argument_types)?;
    let mut fault_predicates = compiled_arguments
        .iter()
        .flat_map(|argument| argument.fault_predicates.clone())
        .collect::<Vec<_>>();
    let strict_null_predicate = || {
        compiled_arguments
            .iter()
            .map(|argument| format!("({}) IS NULL", argument.value_sql))
            .collect::<Vec<_>>()
            .join(" OR ")
    };

    let value_sql = match function {
        CalculatedFunctionV1::Abs if result_type == FormulaType::BigInt => {
            let value_sql = format!(
                "TRY_CAST(ABS(CAST(({}) AS HUGEINT)) AS BIGINT)",
                compiled_arguments[0].value_sql
            );
            fault_predicates.push(format!(
                "(({}) IS NOT NULL AND {value_sql} IS NULL)",
                compiled_arguments[0].value_sql
            ));
            value_sql
        }
        CalculatedFunctionV1::Abs => {
            format!("ABS(CAST(({}) AS DOUBLE))", compiled_arguments[0].value_sql)
        }
        CalculatedFunctionV1::Coalesce => format!(
            "COALESCE({})",
            compiled_arguments
                .iter()
                .map(|argument| argument.value_sql.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        CalculatedFunctionV1::If => format!(
            "CASE WHEN ({}) THEN ({}) ELSE ({}) END",
            compiled_arguments[0].value_sql,
            compiled_arguments[1].value_sql,
            compiled_arguments[2].value_sql
        ),
        CalculatedFunctionV1::Max => format!(
            "CASE WHEN {} THEN NULL ELSE GREATEST({}) END",
            strict_null_predicate(),
            compiled_arguments
                .iter()
                .map(|argument| argument.value_sql.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        CalculatedFunctionV1::Min => format!(
            "CASE WHEN {} THEN NULL ELSE LEAST({}) END",
            strict_null_predicate(),
            compiled_arguments
                .iter()
                .map(|argument| argument.value_sql.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        CalculatedFunctionV1::Round if result_type == FormulaType::BigInt => {
            let digits = round_digits_from_bound_expression(arguments.get(1))?;
            let rounded_sql = format!(
                "ROUND(CAST(({}) AS DOUBLE), {digits})",
                compiled_arguments[0].value_sql
            );
            let value_sql = format!("TRY_CAST({rounded_sql} AS BIGINT)");
            fault_predicates.push(format!(
                "(({}) IS NOT NULL AND {value_sql} IS NULL)",
                compiled_arguments[0].value_sql
            ));
            value_sql
        }
        CalculatedFunctionV1::Round => {
            let digits = round_digits_from_bound_expression(arguments.get(1))?;
            format!(
                "ROUND(CAST(({}) AS DOUBLE), {digits})",
                compiled_arguments[0].value_sql
            )
        }
    };

    Ok(CompiledSqlNode {
        value_sql,
        output_type: result_type,
        fault_predicates,
    })
}

fn round_digits_from_bound_expression(
    argument: Option<&CalculatedExpressionV1>,
) -> Result<i64, FormulaError> {
    match argument {
        None => Ok(0),
        Some(argument) => extract_integer_literal(argument).ok_or_else(|| FormulaError::Type {
            message: "ROUND precision must remain an integer literal after validation".to_string(),
        }),
    }
}

fn extract_integer_literal(expression: &CalculatedExpressionV1) -> Option<i64> {
    match expression {
        CalculatedExpressionV1::NumberLiteral {
            value: CalculatedNumber::Integer(value),
        } => Some(*value),
        CalculatedExpressionV1::Unary {
            operator: CalculatedUnaryOperatorV1::Plus,
            operand,
        } => extract_integer_literal(operand),
        CalculatedExpressionV1::Unary {
            operator: CalculatedUnaryOperatorV1::Minus,
            operand,
        } => extract_integer_literal(operand)?.checked_neg(),
        _ => None,
    }
}

fn normalize_simple_identifier(value: &str) -> Option<String> {
    let mut chars = value.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|character| character.is_ascii_alphanumeric() || character == '_') {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn format_expression(
    expression: &CalculatedExpressionV1,
    parent_precedence: u8,
    is_right_child: bool,
    names_by_id: &HashMap<&str, &str>,
) -> Result<String, FormulaError> {
    let current_precedence = expression_precedence(expression);
    let formatted = match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => {
            let Some(name) = names_by_id.get(column_id.as_str()) else {
                return Err(FormulaError::UnknownIdentifier {
                    identifier: column_id.clone(),
                });
            };
            format_identifier(name)
        }
        CalculatedExpressionV1::NumberLiteral { value } => format_number(value),
        CalculatedExpressionV1::BooleanLiteral { value } => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        CalculatedExpressionV1::NullLiteral => "NULL".to_string(),
        CalculatedExpressionV1::Unary { operator, operand } => {
            let operand = format_expression(operand, current_precedence, false, names_by_id)?;
            format!("{}{operand}", unary_symbol(operator))
        }
        CalculatedExpressionV1::Binary {
            operator,
            left,
            right,
        } => {
            let left = format_expression(left, current_precedence, false, names_by_id)?;
            let right = format_expression(right, current_precedence, true, names_by_id)?;
            format!("{left} {} {right}", binary_symbol(operator))
        }
        CalculatedExpressionV1::Comparison {
            operator,
            left,
            right,
        } => {
            let left = format_expression(left, current_precedence, false, names_by_id)?;
            let right = format_expression(right, current_precedence, true, names_by_id)?;
            format!("{left} {} {right}", comparison_symbol(operator))
        }
        CalculatedExpressionV1::Logical {
            operator,
            left,
            right,
        } => {
            let left = format_expression(left, current_precedence, false, names_by_id)?;
            let right = format_expression(right, current_precedence, true, names_by_id)?;
            format!("{left} {} {right}", logical_symbol(operator))
        }
        CalculatedExpressionV1::Function {
            function,
            arguments,
        } => {
            let arguments = arguments
                .iter()
                .map(|argument| format_expression(argument, 0, false, names_by_id))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            format!("{}({arguments})", function_name(function))
        }
    };

    let needs_parentheses = current_precedence < parent_precedence
        || (is_right_child
            && current_precedence == parent_precedence
            && matches!(
                expression,
                CalculatedExpressionV1::Binary { .. }
                    | CalculatedExpressionV1::Comparison { .. }
                    | CalculatedExpressionV1::Logical { .. }
            ));
    if needs_parentheses {
        Ok(format!("({formatted})"))
    } else {
        Ok(formatted)
    }
}

fn expression_precedence(expression: &CalculatedExpressionV1) -> u8 {
    match expression {
        CalculatedExpressionV1::Logical {
            operator: CalculatedLogicalOperatorV1::Or,
            ..
        } => 1,
        CalculatedExpressionV1::Logical {
            operator: CalculatedLogicalOperatorV1::And,
            ..
        } => 2,
        CalculatedExpressionV1::Comparison { .. } => 3,
        CalculatedExpressionV1::Binary {
            operator: CalculatedBinaryOperatorV1::Add | CalculatedBinaryOperatorV1::Subtract,
            ..
        } => 4,
        CalculatedExpressionV1::Binary {
            operator: CalculatedBinaryOperatorV1::Multiply | CalculatedBinaryOperatorV1::Divide,
            ..
        } => 5,
        CalculatedExpressionV1::Unary { .. } => 6,
        CalculatedExpressionV1::ColumnRef { .. }
        | CalculatedExpressionV1::NumberLiteral { .. }
        | CalculatedExpressionV1::BooleanLiteral { .. }
        | CalculatedExpressionV1::NullLiteral
        | CalculatedExpressionV1::Function { .. } => 7,
    }
}

fn format_identifier(name: &str) -> String {
    if normalize_simple_identifier(name).is_some() {
        name.to_string()
    } else {
        format!("[{}]", name.replace(']', "]]"))
    }
}

fn format_number(value: &CalculatedNumber) -> String {
    match value {
        CalculatedNumber::Integer(value) => value.to_string(),
        CalculatedNumber::Float(value) => {
            let mut text = value.get().to_string();
            if !text.contains(['.', 'e', 'E']) {
                text.push_str(".0");
            }
            text
        }
    }
}

fn unary_symbol(operator: &CalculatedUnaryOperatorV1) -> &'static str {
    match operator {
        CalculatedUnaryOperatorV1::Plus => "+",
        CalculatedUnaryOperatorV1::Minus => "-",
        CalculatedUnaryOperatorV1::Not => "NOT ",
    }
}

fn binary_symbol(operator: &CalculatedBinaryOperatorV1) -> &'static str {
    match operator {
        CalculatedBinaryOperatorV1::Add => "+",
        CalculatedBinaryOperatorV1::Subtract => "-",
        CalculatedBinaryOperatorV1::Multiply => "*",
        CalculatedBinaryOperatorV1::Divide => "/",
    }
}

fn comparison_symbol(operator: &CalculatedComparisonOperatorV1) -> &'static str {
    match operator {
        CalculatedComparisonOperatorV1::Eq => "=",
        CalculatedComparisonOperatorV1::NotEq => "<>",
        CalculatedComparisonOperatorV1::Lt => "<",
        CalculatedComparisonOperatorV1::Lte => "<=",
        CalculatedComparisonOperatorV1::Gt => ">",
        CalculatedComparisonOperatorV1::Gte => ">=",
    }
}

fn logical_symbol(operator: &CalculatedLogicalOperatorV1) -> &'static str {
    match operator {
        CalculatedLogicalOperatorV1::And => "AND",
        CalculatedLogicalOperatorV1::Or => "OR",
    }
}

fn function_name(function: &CalculatedFunctionV1) -> &'static str {
    match function {
        CalculatedFunctionV1::Abs => "ABS",
        CalculatedFunctionV1::Coalesce => "COALESCE",
        CalculatedFunctionV1::If => "IF",
        CalculatedFunctionV1::Max => "MAX",
        CalculatedFunctionV1::Min => "MIN",
        CalculatedFunctionV1::Round => "ROUND",
    }
}

fn token_description(token: Option<&Token>) -> String {
    token
        .map(ToString::to_string)
        .unwrap_or_else(|| "<end>".to_string())
}

struct FormulaParser {
    tokens: Vec<Token>,
    index: usize,
}

impl FormulaParser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, index: 0 }
    }

    fn parse_expression(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let mut expression = self.parse_and()?;
        while self.consume_keyword("OR") {
            let right = self.parse_and()?;
            expression = ParsedFormulaExpression::Logical {
                operator: CalculatedLogicalOperatorV1::Or,
                left: Box::new(expression),
                right: Box::new(right),
            };
        }
        Ok(expression)
    }

    fn parse_and(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let mut expression = self.parse_comparison()?;
        while self.consume_keyword("AND") {
            let right = self.parse_comparison()?;
            expression = ParsedFormulaExpression::Logical {
                operator: CalculatedLogicalOperatorV1::And,
                left: Box::new(expression),
                right: Box::new(right),
            };
        }
        Ok(expression)
    }

    fn parse_comparison(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let mut expression = self.parse_additive()?;
        if let Some(operator) = self.consume_comparison_operator() {
            let right = self.parse_additive()?;
            expression = ParsedFormulaExpression::Comparison {
                operator,
                left: Box::new(expression),
                right: Box::new(right),
            };
        }
        Ok(expression)
    }

    fn parse_additive(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let mut expression = self.parse_multiplicative()?;
        loop {
            let operator = if self.consume_token(&Token::Plus) {
                Some(CalculatedBinaryOperatorV1::Add)
            } else if self.consume_token(&Token::Minus) {
                Some(CalculatedBinaryOperatorV1::Subtract)
            } else {
                None
            };
            let Some(operator) = operator else {
                return Ok(expression);
            };
            let right = self.parse_multiplicative()?;
            expression = ParsedFormulaExpression::Binary {
                operator,
                left: Box::new(expression),
                right: Box::new(right),
            };
        }
    }

    fn parse_multiplicative(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let mut expression = self.parse_unary()?;
        loop {
            let operator = if self.consume_token(&Token::Mul) {
                Some(CalculatedBinaryOperatorV1::Multiply)
            } else if self.consume_token(&Token::Div) {
                Some(CalculatedBinaryOperatorV1::Divide)
            } else {
                None
            };
            let Some(operator) = operator else {
                return Ok(expression);
            };
            let right = self.parse_unary()?;
            expression = ParsedFormulaExpression::Binary {
                operator,
                left: Box::new(expression),
                right: Box::new(right),
            };
        }
    }

    fn parse_unary(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        let operator = if self.consume_token(&Token::Plus) {
            Some(CalculatedUnaryOperatorV1::Plus)
        } else if self.consume_token(&Token::Minus) {
            Some(CalculatedUnaryOperatorV1::Minus)
        } else if self.consume_keyword("NOT") {
            Some(CalculatedUnaryOperatorV1::Not)
        } else {
            None
        };
        if let Some(operator) = operator {
            let operand = self.parse_unary()?;
            Ok(ParsedFormulaExpression::Unary {
                operator,
                operand: Box::new(operand),
            })
        } else {
            self.parse_primary()
        }
    }

    fn parse_primary(&mut self) -> Result<ParsedFormulaExpression, FormulaError> {
        match self.next_token() {
            Some(Token::LParen) => {
                let expression = self.parse_expression()?;
                self.expect_token(Token::RParen, "expected ')' to close expression")?;
                Ok(ParsedFormulaExpression::Group {
                    expression: Box::new(expression),
                })
            }
            Some(Token::Number(text, _)) => Ok(ParsedFormulaExpression::NumberLiteral {
                value: parse_number(&text)?,
            }),
            Some(Token::Word(word)) => self.parse_word(word),
            Some(Token::SingleQuotedString(_))
            | Some(Token::DoubleQuotedString(_))
            | Some(Token::NationalStringLiteral(_)) => Err(FormulaError::Unsupported {
                message: "string literals are not supported in formula V1".to_string(),
            }),
            Some(other) => Err(FormulaError::Syntax {
                message: format!("unexpected token {}", other),
            }),
            None => Err(FormulaError::Syntax {
                message: "unexpected end of formula".to_string(),
            }),
        }
    }

    fn parse_word(&mut self, word: Word) -> Result<ParsedFormulaExpression, FormulaError> {
        if word.quote_style.is_none() {
            if word.value.eq_ignore_ascii_case("TRUE") {
                return Ok(ParsedFormulaExpression::BooleanLiteral { value: true });
            }
            if word.value.eq_ignore_ascii_case("FALSE") {
                return Ok(ParsedFormulaExpression::BooleanLiteral { value: false });
            }
            if word.value.eq_ignore_ascii_case("NULL") {
                return Ok(ParsedFormulaExpression::NullLiteral);
            }
        }

        if self.consume_token(&Token::LParen) {
            let function = parse_function_name(&word)?;
            let mut arguments = Vec::new();
            if !self.consume_token(&Token::RParen) {
                loop {
                    arguments.push(self.parse_expression()?);
                    if self.consume_token(&Token::Comma) {
                        continue;
                    }
                    self.expect_token(Token::RParen, "expected ')' after function arguments")?;
                    break;
                }
            }
            return Ok(ParsedFormulaExpression::Function {
                function,
                arguments,
            });
        }

        if word.quote_style.is_none() && is_reserved_non_formula_keyword(&word.value) {
            return Err(FormulaError::Unsupported {
                message: format!("keyword {} is not supported in formula V1", word.value),
            });
        }

        Ok(ParsedFormulaExpression::Identifier {
            name: word.value,
            quoted: word.quote_style.is_some(),
        })
    }

    fn consume_comparison_operator(&mut self) -> Option<CalculatedComparisonOperatorV1> {
        let operator = match self.peek()? {
            Token::Eq | Token::DoubleEq => CalculatedComparisonOperatorV1::Eq,
            Token::Neq => CalculatedComparisonOperatorV1::NotEq,
            Token::Lt => CalculatedComparisonOperatorV1::Lt,
            Token::LtEq => CalculatedComparisonOperatorV1::Lte,
            Token::Gt => CalculatedComparisonOperatorV1::Gt,
            Token::GtEq => CalculatedComparisonOperatorV1::Gte,
            _ => return None,
        };
        self.index += 1;
        Some(operator)
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        match self.peek() {
            Some(Token::Word(word))
                if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(keyword) =>
            {
                self.index += 1;
                true
            }
            _ => false,
        }
    }

    fn expect_token(&mut self, expected: Token, message: &str) -> Result<(), FormulaError> {
        if self.consume_token(&expected) {
            Ok(())
        } else {
            Err(FormulaError::Syntax {
                message: message.to_string(),
            })
        }
    }

    fn consume_token(&mut self, expected: &Token) -> bool {
        if self.peek() == Some(expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn next_token(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.index).cloned();
        if token.is_some() {
            self.index += 1;
        }
        token
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn has_remaining(&self) -> bool {
        self.index < self.tokens.len()
    }
}

fn ensure_expression_depth(expression: &ParsedFormulaExpression) -> Result<(), FormulaError> {
    let depth = parsed_expression_depth(expression);
    if depth > MAX_EXPRESSION_DEPTH {
        Err(FormulaError::Limits {
            message: format!("formula exceeds maximum expression depth of {MAX_EXPRESSION_DEPTH}"),
        })
    } else {
        Ok(())
    }
}

fn parsed_expression_depth(expression: &ParsedFormulaExpression) -> usize {
    match expression {
        ParsedFormulaExpression::Identifier { .. }
        | ParsedFormulaExpression::NumberLiteral { .. }
        | ParsedFormulaExpression::BooleanLiteral { .. }
        | ParsedFormulaExpression::NullLiteral => 0,
        ParsedFormulaExpression::Unary { operand, .. }
        | ParsedFormulaExpression::Group {
            expression: operand,
        } => 1 + parsed_expression_depth(operand),
        ParsedFormulaExpression::Binary { left, right, .. }
        | ParsedFormulaExpression::Comparison { left, right, .. }
        | ParsedFormulaExpression::Logical { left, right, .. } => {
            1 + parsed_expression_depth(left).max(parsed_expression_depth(right))
        }
        ParsedFormulaExpression::Function { arguments, .. } => {
            1 + arguments
                .iter()
                .map(parsed_expression_depth)
                .max()
                .unwrap_or(0)
        }
    }
}

fn parse_number(text: &str) -> Result<CalculatedNumber, FormulaError> {
    if text.contains(['.', 'e', 'E']) {
        let value = text.parse::<f64>().map_err(|error| FormulaError::Syntax {
            message: format!("invalid floating-point literal {text}: {error}"),
        })?;
        CalculatedNumber::try_from(value).map_err(|message| FormulaError::Syntax { message })
    } else {
        text.parse::<i64>()
            .map(CalculatedNumber::Integer)
            .map_err(|error| FormulaError::Syntax {
                message: format!("invalid integer literal {text}: {error}"),
            })
    }
}

fn parse_function_name(word: &Word) -> Result<CalculatedFunctionV1, FormulaError> {
    if word.quote_style.is_some() {
        return Err(FormulaError::Unsupported {
            message: "quoted function names are not supported in formula V1".to_string(),
        });
    }

    match word.value.to_ascii_uppercase().as_str() {
        "ABS" => Ok(CalculatedFunctionV1::Abs),
        "COALESCE" => Ok(CalculatedFunctionV1::Coalesce),
        "IF" => Ok(CalculatedFunctionV1::If),
        "MAX" => Ok(CalculatedFunctionV1::Max),
        "MIN" => Ok(CalculatedFunctionV1::Min),
        "ROUND" => Ok(CalculatedFunctionV1::Round),
        _ => Err(FormulaError::Unsupported {
            message: format!("function {} is not supported in formula V1", word.value),
        }),
    }
}

fn is_reserved_non_formula_keyword(word: &str) -> bool {
    matches!(
        word.to_ascii_uppercase().as_str(),
        "SELECT"
            | "FROM"
            | "WHERE"
            | "GROUP"
            | "BY"
            | "HAVING"
            | "OVER"
            | "WINDOW"
            | "CASE"
            | "WHEN"
            | "THEN"
            | "ELSE"
            | "END"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    use crate::models::calculated_column::remap_definition;

    fn numeric_columns() -> Vec<FormulaColumn> {
        vec![
            FormulaColumn {
                column_id: "length-id".to_string(),
                name: "Length".to_string(),
                sql_type: "DOUBLE".to_string(),
            },
            FormulaColumn {
                column_id: "width-id".to_string(),
                name: "Width".to_string(),
                sql_type: "DOUBLE".to_string(),
            },
        ]
    }

    fn mixed_columns() -> Vec<FormulaColumn> {
        let mut columns = numeric_columns();
        columns.push(FormulaColumn {
            column_id: "flag-id".to_string(),
            name: "Flag".to_string(),
            sql_type: "BOOLEAN".to_string(),
        });
        columns.push(FormulaColumn {
            column_id: "label-id".to_string(),
            name: "Label".to_string(),
            sql_type: "VARCHAR".to_string(),
        });
        columns.push(FormulaColumn {
            column_id: "dup-a".to_string(),
            name: "Dupe".to_string(),
            sql_type: "DOUBLE".to_string(),
        });
        columns.push(FormulaColumn {
            column_id: "dup-b".to_string(),
            name: "dupe".to_string(),
            sql_type: "DOUBLE".to_string(),
        });
        columns.push(FormulaColumn {
            column_id: "upper-limit-id".to_string(),
            name: "Upper ] Limit".to_string(),
            sql_type: "DOUBLE".to_string(),
        });
        columns
    }

    fn renamed_numeric_columns() -> Vec<FormulaColumn> {
        vec![
            FormulaColumn {
                column_id: "length-id".to_string(),
                name: "Len".to_string(),
                sql_type: "DOUBLE".to_string(),
            },
            FormulaColumn {
                column_id: "width-id".to_string(),
                name: "Wid".to_string(),
                sql_type: "DOUBLE".to_string(),
            },
            FormulaColumn {
                column_id: "count-id".to_string(),
                name: "Count".to_string(),
                sql_type: "BIGINT".to_string(),
            },
        ]
    }

    fn numeric_sql_columns() -> Vec<FormulaSqlColumn> {
        vec![
            FormulaSqlColumn {
                column_id: "length-id".to_string(),
                sql_type: "DOUBLE".to_string(),
                physical_name: "length value".to_string(),
            },
            FormulaSqlColumn {
                column_id: "width-id".to_string(),
                sql_type: "DOUBLE".to_string(),
                physical_name: "width\"value".to_string(),
            },
            FormulaSqlColumn {
                column_id: "count-id".to_string(),
                sql_type: "BIGINT".to_string(),
                physical_name: "count_value".to_string(),
            },
        ]
    }

    fn depth_formula_with_parentheses(levels: usize) -> String {
        let mut formula = "Length".to_string();
        for _ in 0..levels {
            formula = format!("({formula})");
        }
        formula
    }

    fn depth_formula_with_unary(levels: usize) -> String {
        format!("{}Length", "- ".repeat(levels))
    }

    fn depth_formula_with_function(levels: usize) -> String {
        let mut formula = "Length".to_string();
        for _ in 0..levels {
            formula = format!("ABS({formula})");
        }
        formula
    }

    fn definition_with_output(
        output_column_id: &str,
        expression: CalculatedExpressionV1,
        inferred_output_type: CalculatedOutputTypeV1,
    ) -> CalculatedColumnDefinitionV1 {
        let mut definition = CalculatedColumnDefinitionV1 {
            formula_id: format!("formula-{output_column_id}"),
            schema_version: SCHEMA_VERSION_V1.to_string(),
            output_column_id: output_column_id.to_string(),
            dependency_column_ids: expression_dependency_ids(&expression),
            inferred_output_type,
            fingerprint: String::new(),
            expression,
        };
        definition.fingerprint = definition_fingerprint(&definition);
        definition
    }

    #[test]
    fn calculated_column_expression_parses_precedence_and_resolves_names_to_ids() {
        let validated = parse_and_validate_formula(
            "ROUND(Length * Width + 2, 1)",
            &numeric_columns(),
            None,
            &[],
        )
        .unwrap();
        assert_eq!(
            validated.definition.dependency_column_ids,
            vec!["length-id", "width-id"]
        );
        assert_eq!(
            validated.definition.inferred_output_type,
            CalculatedOutputTypeV1::Continuous
        );
        assert_eq!(
            validated.normalized_display_formula,
            "ROUND(Length * Width + 2, 1)"
        );
    }

    #[test]
    fn calculated_column_expression_rejects_sql_that_is_not_in_the_formula_language() {
        for text in [
            "A; DROP TABLE x",
            "SELECT A",
            "SUM(A)",
            "A OVER ()",
            "random()",
        ] {
            assert!(matches!(
                parse(text),
                Err(FormulaError::Syntax { .. } | FormulaError::Unsupported { .. })
            ));
        }
    }

    #[test]
    fn calculated_column_expression_formats_bracketed_identifiers() {
        let validated =
            parse_and_validate_formula("[Upper ]] Limit] + 1", &mixed_columns(), None, &[])
                .unwrap();

        assert_eq!(
            validated.definition.dependency_column_ids,
            vec!["upper-limit-id"]
        );
        assert_eq!(validated.normalized_display_formula, "[Upper ]] Limit] + 1");
    }

    #[test]
    fn calculated_column_expression_rejects_unsupported_source_type_references() {
        let error = parse_and_validate_formula("Label", &mixed_columns(), None, &[])
            .expect_err("varchar columns should not be allowed in formula v1");

        assert!(matches!(error, FormulaError::Type { .. }));
    }

    #[test]
    fn calculated_column_expression_rejects_ambiguous_unquoted_identifiers() {
        let error = parse_and_validate_formula("Dupe + 1", &mixed_columns(), None, &[])
            .expect_err("unquoted duplicate names should be ambiguous");

        assert!(matches!(error, FormulaError::AmbiguousIdentifier { .. }));
    }

    #[test]
    fn calculated_column_expression_rejects_round_precision_out_of_range() {
        let error = parse_and_validate_formula("ROUND(Length, -16)", &numeric_columns(), None, &[])
            .expect_err("ROUND precision outside the brief bounds should fail");

        assert!(matches!(
            error,
            FormulaError::Limits { .. } | FormulaError::Type { .. }
        ));
    }

    #[test]
    fn calculated_column_expression_accepts_structural_depth_64_for_parentheses_unary_and_functions(
    ) {
        for formula in [
            depth_formula_with_parentheses(64),
            depth_formula_with_unary(64),
            depth_formula_with_function(64),
        ] {
            let validated = parse_and_validate_formula(&formula, &numeric_columns(), None, &[])
                .expect("structural depth 64 should be accepted");
            assert_eq!(
                validated.definition.dependency_column_ids,
                vec!["length-id"]
            );
        }
    }

    #[test]
    fn calculated_column_expression_rejects_structural_depth_65_for_parentheses_unary_and_functions(
    ) {
        for formula in [
            depth_formula_with_parentheses(65),
            depth_formula_with_unary(65),
            depth_formula_with_function(65),
        ] {
            let error = parse_and_validate_formula(&formula, &numeric_columns(), None, &[])
                .expect_err("structural depth 65 should be rejected");
            assert!(matches!(error, FormulaError::Limits { .. }));
        }
    }

    #[test]
    fn calculated_column_expression_enforces_exact_formula_byte_limit() {
        let accepted = format!("1{}", " ".repeat(MAX_FORMULA_BYTES - 1));
        assert_eq!(accepted.len(), MAX_FORMULA_BYTES);
        parse(&accepted).expect("formula at byte limit should parse");

        let rejected = format!("{accepted} ");
        assert_eq!(rejected.len(), MAX_FORMULA_BYTES + 1);
        let error = parse(&rejected).expect_err("formula over byte limit should fail");

        assert!(matches!(error, FormulaError::Limits { .. }));
    }

    #[test]
    fn calculated_column_expression_enforces_exact_formula_token_limit() {
        let accepted = format!(
            "COALESCE({})",
            std::iter::repeat_n("1", (MAX_FORMULA_TOKENS - 2) / 2)
                .collect::<Vec<_>>()
                .join(", ")
        );
        assert_eq!(
            tokenize_with_bracket_identifiers(&accepted).unwrap().len(),
            MAX_FORMULA_TOKENS
        );
        parse(&accepted).expect("formula at token limit should parse");

        let rejected = format!("NOT {accepted}");
        assert_eq!(
            tokenize_with_bracket_identifiers(&rejected).unwrap().len(),
            MAX_FORMULA_TOKENS + 1
        );
        let error = parse(&rejected).expect_err("formula over token limit should fail");

        assert!(matches!(error, FormulaError::Limits { .. }));
    }

    #[test]
    fn calculated_column_expression_rejects_unknown_identifier() {
        let error = parse_and_validate_formula("Missing + 1", &numeric_columns(), None, &[])
            .expect_err("unknown identifiers should be rejected");

        assert!(matches!(
            error,
            FormulaError::UnknownIdentifier { ref identifier } if identifier == "Missing"
        ));
    }

    #[test]
    fn calculated_column_expression_rejects_direct_self_reference() {
        let error =
            parse_and_validate_formula("Length + 1", &numeric_columns(), Some("length-id"), &[])
                .expect_err("direct self-reference should be rejected");

        assert!(matches!(error, FormulaError::Unsupported { .. }));
    }

    #[test]
    fn calculated_column_expression_covers_operator_semantics() {
        struct Case {
            formula: &'static str,
            expected_type: CalculatedOutputTypeV1,
            expected_display: &'static str,
        }

        let cases = [
            Case {
                formula: "+Length",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "+Length",
            },
            Case {
                formula: "-Length",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "-Length",
            },
            Case {
                formula: "NOT Flag",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "NOT Flag",
            },
            Case {
                formula: "Length + Width",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "Length + Width",
            },
            Case {
                formula: "Length - Width",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "Length - Width",
            },
            Case {
                formula: "Length * Width",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "Length * Width",
            },
            Case {
                formula: "Length / Width",
                expected_type: CalculatedOutputTypeV1::Continuous,
                expected_display: "Length / Width",
            },
            Case {
                formula: "Length = Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length = Width",
            },
            Case {
                formula: "Length <> Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length <> Width",
            },
            Case {
                formula: "Length < Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length < Width",
            },
            Case {
                formula: "Length <= Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length <= Width",
            },
            Case {
                formula: "Length > Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length > Width",
            },
            Case {
                formula: "Length >= Width",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Length >= Width",
            },
            Case {
                formula: "Flag AND TRUE",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Flag AND TRUE",
            },
            Case {
                formula: "Flag OR FALSE",
                expected_type: CalculatedOutputTypeV1::Boolean,
                expected_display: "Flag OR FALSE",
            },
        ];

        for case in cases {
            let validated = parse_and_validate_formula(case.formula, &mixed_columns(), None, &[])
                .unwrap_or_else(|error| panic!("{} should validate: {error:?}", case.formula));
            assert_eq!(
                validated.definition.inferred_output_type,
                case.expected_type
            );
            assert_eq!(validated.normalized_display_formula, case.expected_display);
        }
    }

    #[test]
    fn calculated_column_expression_enforces_function_arity_and_if_null_contract() {
        struct RejectionCase {
            formula: &'static str,
        }

        let rejection_cases = [
            RejectionCase { formula: "ABS()" },
            RejectionCase {
                formula: "ABS(Length, Width)",
            },
            RejectionCase { formula: "ROUND()" },
            RejectionCase {
                formula: "ROUND(Length, Width, 1)",
            },
            RejectionCase { formula: "MIN()" },
            RejectionCase {
                formula: "MIN(Length)",
            },
            RejectionCase { formula: "MAX()" },
            RejectionCase {
                formula: "MAX(Length)",
            },
            RejectionCase {
                formula: "COALESCE()",
            },
            RejectionCase {
                formula: "COALESCE(Length)",
            },
            RejectionCase { formula: "IF()" },
            RejectionCase {
                formula: "IF(Flag, Length)",
            },
            RejectionCase {
                formula: "IF(Flag, Length, Width, Length)",
            },
        ];

        for case in rejection_cases {
            let error = parse_and_validate_formula(case.formula, &mixed_columns(), None, &[])
                .expect_err("invalid arity should be rejected");
            assert!(matches!(error, FormulaError::Type { .. }));
        }

        for formula in [
            "ABS(Length)",
            "ROUND(Length)",
            "ROUND(Length, 1)",
            "MIN(Length, Width)",
            "MAX(Length, Width)",
            "COALESCE(NULL, Length)",
            "COALESCE(NULL, Length, Width)",
            "IF(Flag, Length, Width)",
        ] {
            parse_and_validate_formula(formula, &mixed_columns(), None, &[])
                .unwrap_or_else(|error| panic!("{} should validate: {error:?}", formula));
        }

        let validated =
            parse_and_validate_formula("IF(NULL, Length, Width)", &mixed_columns(), None, &[])
                .expect("IF(NULL, a, b) should be allowed and typed from its branches");
        assert_eq!(
            validated.definition.inferred_output_type,
            CalculatedOutputTypeV1::Continuous
        );
        assert_eq!(
            validated.normalized_display_formula,
            "IF(NULL, Length, Width)"
        );
    }

    #[test]
    fn formula_fingerprint_ignores_whitespace_and_output_column_identity() {
        let first =
            parse_and_validate_formula("Length + Width", &numeric_columns(), Some("out-a"), &[])
                .expect("first parse should succeed");
        let second =
            parse_and_validate_formula("  Length+Width  ", &numeric_columns(), Some("out-b"), &[])
                .expect("second parse should succeed");

        assert_eq!(first.definition.fingerprint, second.definition.fingerprint);
    }

    #[test]
    fn formula_fingerprint_is_stable_across_display_name_renames() {
        let original = parse_and_validate_formula("Length + Width", &numeric_columns(), None, &[])
            .expect("original parse should succeed");
        let renamed =
            parse_and_validate_formula("Len + Wid", &renamed_numeric_columns(), None, &[])
                .expect("renamed parse should succeed");

        assert_eq!(
            original.definition.expression,
            renamed.definition.expression
        );
        assert_eq!(
            original.definition.fingerprint,
            renamed.definition.fingerprint
        );
    }

    proptest! {
        #[test]
        fn formula_fingerprint_property_is_stable_across_whitespace_variants(
            leading in "[ \t]{0,3}",
            plus_left in "[ \t]{0,3}",
            plus_right in "[ \t]{0,3}",
            trailing in "[ \t]{0,3}"
        ) {
            let base = parse_and_validate_formula("Length + Width", &numeric_columns(), None, &[])
                .expect("base parse should succeed");
            let variant = format!(
                "{leading}Length{plus_left}+{plus_right}Width{trailing}"
            );
            let reparsed = parse_and_validate_formula(&variant, &numeric_columns(), None, &[])
                .expect("variant parse should succeed");

            prop_assert_eq!(base.definition.expression, reparsed.definition.expression);
            prop_assert_eq!(base.definition.fingerprint, reparsed.definition.fingerprint);
        }
    }

    #[test]
    fn calculated_column_expression_graph_returns_topological_order() {
        let first = definition_with_output(
            "calc-a",
            CalculatedExpressionV1::ColumnRef {
                column_id: "length-id".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let second = definition_with_output(
            "calc-b",
            CalculatedExpressionV1::Binary {
                operator: CalculatedBinaryOperatorV1::Add,
                left: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "calc-a".to_string(),
                }),
                right: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "width-id".to_string(),
                }),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let candidate = definition_with_output(
            "calc-c",
            CalculatedExpressionV1::Binary {
                operator: CalculatedBinaryOperatorV1::Multiply,
                left: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "calc-b".to_string(),
                }),
                right: Box::new(CalculatedExpressionV1::NumberLiteral {
                    value: CalculatedNumber::Integer(2),
                }),
            },
            CalculatedOutputTypeV1::Continuous,
        );

        let graph = validate_formula_graph(&candidate, &[first, second], &numeric_columns())
            .expect("acyclic definitions should validate");
        assert_eq!(
            graph.topological_output_column_ids,
            vec!["calc-a", "calc-b", "calc-c"]
        );
        assert_eq!(
            graph.dependency_paths,
            vec![
                vec!["calc-c", "calc-b", "calc-a", "length-id"],
                vec!["calc-c", "calc-b", "width-id"],
            ]
        );
    }

    #[test]
    fn calculated_column_expression_graph_returns_stable_branching_success_paths() {
        let first = definition_with_output(
            "calc-a",
            CalculatedExpressionV1::Binary {
                operator: CalculatedBinaryOperatorV1::Add,
                left: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "length-id".to_string(),
                }),
                right: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "width-id".to_string(),
                }),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let second = definition_with_output(
            "calc-b",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-a".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let candidate = definition_with_output(
            "calc-c",
            CalculatedExpressionV1::Function {
                function: CalculatedFunctionV1::Max,
                arguments: vec![
                    CalculatedExpressionV1::ColumnRef {
                        column_id: "calc-b".to_string(),
                    },
                    CalculatedExpressionV1::ColumnRef {
                        column_id: "length-id".to_string(),
                    },
                    CalculatedExpressionV1::ColumnRef {
                        column_id: "width-id".to_string(),
                    },
                ],
            },
            CalculatedOutputTypeV1::Continuous,
        );

        let graph = validate_formula_graph(&candidate, &[first, second], &numeric_columns())
            .expect("branching dependencies should validate");
        assert_eq!(
            graph.topological_output_column_ids,
            vec!["calc-a", "calc-b", "calc-c"]
        );
        assert_eq!(
            graph.dependency_paths,
            vec![
                vec!["calc-c", "calc-b", "calc-a", "length-id"],
                vec!["calc-c", "calc-b", "calc-a", "width-id"],
                vec!["calc-c", "length-id"],
                vec!["calc-c", "width-id"],
            ]
        );
    }

    #[test]
    fn calculated_column_expression_graph_reports_missing_dependency_paths() {
        let broken = definition_with_output(
            "calc-b",
            CalculatedExpressionV1::ColumnRef {
                column_id: "missing-calc".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let candidate = definition_with_output(
            "calc-c",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-b".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );

        let error = validate_formula_graph(&candidate, &[broken], &numeric_columns())
            .expect_err("missing dependencies should fail safely");
        assert!(matches!(
            error,
            FormulaError::DependencyGraph { ref path, .. } if path == &vec!["calc-c".to_string(), "calc-b".to_string(), "missing-calc".to_string()]
        ));
    }

    #[test]
    fn calculated_column_expression_graph_reports_indirect_cycle_path() {
        let first = definition_with_output(
            "calc-a",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-c".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let second = definition_with_output(
            "calc-b",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-a".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );
        let candidate = definition_with_output(
            "calc-c",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-b".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );

        let error = validate_formula_graph(&candidate, &[first, second], &numeric_columns())
            .expect_err("cycle should fail with stable path");
        assert!(matches!(
            error,
            FormulaError::DependencyGraph { ref path, .. } if path == &vec!["calc-c".to_string(), "calc-b".to_string(), "calc-a".to_string(), "calc-c".to_string()]
        ));
    }

    #[test]
    fn calculated_column_expression_graph_reports_direct_cycle_path() {
        let candidate = definition_with_output(
            "calc-a",
            CalculatedExpressionV1::ColumnRef {
                column_id: "calc-a".to_string(),
            },
            CalculatedOutputTypeV1::Continuous,
        );

        let error = validate_formula_graph(&candidate, &[], &numeric_columns())
            .expect_err("direct cycles should be rejected with an explicit path");
        assert!(matches!(
            error,
            FormulaError::DependencyGraph { ref path, .. } if path == &vec!["calc-a".to_string(), "calc-a".to_string()]
        ));
    }

    #[test]
    fn calculated_column_expression_remap_definition_preserves_fingerprint_when_ids_are_stable() {
        let validated =
            parse_and_validate_formula("Length + Width", &numeric_columns(), Some("out-a"), &[])
                .expect("formula should validate");
        let remapped = remap_definition(
            &validated.definition,
            "formula-remapped",
            "out-b",
            &HashMap::from([
                ("length-id".to_string(), "length-remapped".to_string()),
                ("width-id".to_string(), "width-remapped".to_string()),
            ]),
        )
        .expect("explicit remap should succeed");

        assert_eq!(
            remapped.dependency_column_ids,
            vec!["length-remapped", "width-remapped"]
        );
        assert_eq!(remapped.formula_id, "formula-remapped");
        assert_eq!(remapped.output_column_id, "out-b");
        assert_eq!(
            remapped.expression,
            CalculatedExpressionV1::Binary {
                operator: CalculatedBinaryOperatorV1::Add,
                left: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "length-remapped".to_string(),
                }),
                right: Box::new(CalculatedExpressionV1::ColumnRef {
                    column_id: "width-remapped".to_string(),
                }),
            }
        );
        assert_eq!(remapped.fingerprint, definition_fingerprint(&remapped));
    }

    #[test]
    fn formula_sql_uses_trusted_physical_identifiers_and_not_raw_formula_text() {
        let validated = parse_and_validate_formula(
            "ROUND(Len * Wid + 2, 1)",
            &renamed_numeric_columns(),
            None,
            &[],
        )
        .expect("formula should validate");

        let compiled = compile_formula_sql(&validated.typed_expression, &numeric_sql_columns())
            .expect("sql compilation should succeed");

        assert!(compiled.value_sql.contains("\"length value\""));
        assert!(compiled.value_sql.contains("\"width\"\"value\""));
        assert!(!compiled.value_sql.contains("ROUND(Len * Wid + 2, 1)"));
    }

    #[test]
    fn formula_sql_uses_scalar_min_max_semantics() {
        let validated =
            parse_and_validate_formula("MIN(Len, Wid)", &renamed_numeric_columns(), None, &[])
                .expect("min formula should validate");

        let compiled = compile_formula_sql(&validated.typed_expression, &numeric_sql_columns())
            .expect("sql compilation should succeed");

        assert!(compiled.value_sql.contains("LEAST("));
        assert!(!compiled.value_sql.contains("MIN("));
        assert!(compiled.value_sql.contains("CASE WHEN"));
        assert!(compiled.value_sql.contains("(\"length value\") IS NULL"));
        assert!(compiled.value_sql.contains("(\"width\"\"value\") IS NULL"));
    }

    #[test]
    fn formula_sql_reports_divide_by_zero_without_counting_nulls() {
        let validated =
            parse_and_validate_formula("Len / Wid", &renamed_numeric_columns(), None, &[])
                .expect("division formula should validate");

        let compiled = compile_formula_sql(&validated.typed_expression, &numeric_sql_columns())
            .expect("sql compilation should succeed");

        assert!(compiled.value_sql.contains("CASE WHEN"));
        assert!(compiled
            .fault_predicates
            .iter()
            .any(|predicate| { predicate.contains("IS NOT NULL") && predicate.contains("= 0") }));
    }

    #[test]
    fn formula_sql_flags_non_finite_double_results_explicitly() {
        let typed_expression = TypedCalculatedExpression {
            expression: CalculatedExpressionV1::ColumnRef {
                column_id: "length-id".to_string(),
            },
            output_type: TypedCalculatedOutput::Double,
        };

        let compiled = compile_formula_sql(&typed_expression, &numeric_sql_columns())
            .expect("double expressions should emit a non-finite guard");

        assert!(compiled.value_sql.contains("isfinite"));
        assert!(compiled.fault_predicates.iter().any(|predicate| predicate
            .contains("IS NOT NULL")
            && predicate.contains("NOT isfinite")));
    }

    #[test]
    fn formula_sql_detects_bigint_overflow_with_try_cast() {
        let validated =
            parse_and_validate_formula("Count + 1", &renamed_numeric_columns(), None, &[])
                .expect("bigint formula should validate");

        let compiled = compile_formula_sql(&validated.typed_expression, &numeric_sql_columns())
            .expect("sql compilation should succeed");

        assert!(compiled.value_sql.contains("TRY_CAST"));
        assert!(compiled
            .fault_predicates
            .iter()
            .any(|predicate| predicate.contains("TRY_CAST")));
    }
}

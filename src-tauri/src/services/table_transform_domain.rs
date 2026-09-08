use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlparser::ast::{BinaryOperator, Expr, SetExpr, Statement, UnaryOperator, Value};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

use crate::error::AppError;
use crate::services::spprj_archive::TableColumn;
use crate::services::workflow_domain::{
    canonical_duckdb_type, schema_fingerprint, SchemaColumnRequirement, SchemaContract,
};

const TABLE_TRANSFORM_FORMAT_VERSION: &str = "1";
const CONTRACT_OPERATION_ID: &str = "table-transform";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidParam(message.into())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformDefinition {
    pub id: String,
    pub name: String,
    pub format_version: String,
    pub revision: u64,
    pub operation: TableTransformOperation,
    #[serde(default)]
    pub input_slots: Vec<TableTransformInputSlot>,
    pub output: TableTransformOutput,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformInputSlot {
    pub role: String,
    pub schema_contract: SchemaContract,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformOutput {
    pub table_document_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TableTransformOperation {
    Sort {
        sort_columns: Vec<SortColumn>,
    },
    Subset {
        columns: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<TableFilterExpression>,
    },
    Transpose,
    Stack {
        stack_columns: Vec<String>,
        id_columns: Vec<String>,
    },
    Split {
        split_column: String,
        value_column: String,
        id_columns: Vec<String>,
    },
    Summary {
        statistic_columns: Vec<String>,
        group_columns: Vec<String>,
        statistics: Vec<SummaryStatistic>,
    },
    Join {
        join_type: JoinType,
        left_key: String,
        right_key: String,
    },
    Update {
        match_column: String,
        update_columns: Vec<String>,
    },
    Concatenate {
        source_count: usize,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortColumn {
    pub column: String,
    pub direction: SortDirection,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SummaryStatistic {
    N,
    Mean,
    Std,
    Min,
    Max,
    Sum,
    Median,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JoinType {
    Inner,
    Left,
    Right,
    Full,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TableFilterExpression {
    Logical {
        operator: TableFilterLogicalOperator,
        left: Box<TableFilterExpression>,
        right: Box<TableFilterExpression>,
    },
    Not {
        expression: Box<TableFilterExpression>,
    },
    Comparison {
        column: String,
        operator: TableFilterComparisonOperator,
        value: TableFilterScalar,
    },
    IsNull {
        column: String,
        negated: bool,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableFilterLogicalOperator {
    And,
    Or,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableFilterComparisonOperator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum TableFilterScalar {
    String(String),
    Number(String),
    Boolean(bool),
    Null,
}

pub fn required_input_roles(operation: &TableTransformOperation) -> Vec<String> {
    match operation {
        TableTransformOperation::Join { .. } | TableTransformOperation::Update { .. } => {
            vec!["left".to_string(), "right".to_string()]
        }
        TableTransformOperation::Concatenate { source_count } => (1..=*source_count)
            .map(|index| format!("source-{index}"))
            .collect(),
        _ => vec!["source".to_string()],
    }
}

pub fn parse_filter_expression(
    input: &str,
    source_columns: &[TableColumn],
) -> Result<TableFilterExpression, AppError> {
    if input.trim().is_empty() {
        return Err(invalid("filter expression is required"));
    }
    if input.contains("--") || input.contains("/*") || input.contains("*/") {
        return Err(invalid("filter comments are not supported"));
    }

    let sql = format!("SELECT * FROM __table_transform_source WHERE {input}");
    let mut statements = Parser::parse_sql(&GenericDialect {}, &sql)
        .map_err(|error| invalid(format!("invalid filter expression: {error}")))?;
    if statements.len() != 1 {
        return Err(invalid("filter must contain exactly one expression"));
    }

    let selection = match statements.pop() {
        Some(Statement::Query(query)) => match *query.body {
            SetExpr::Select(select) => select.selection,
            _ => None,
        },
        _ => None,
    }
    .ok_or_else(|| invalid("filter must contain exactly one expression"))?;

    let allowed_columns = source_columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    normalize_filter_expression(selection, &allowed_columns)
}

pub fn derive_input_contracts(
    operation: &TableTransformOperation,
    source_schemas: &HashMap<String, Vec<TableColumn>>,
) -> Result<Vec<TableTransformInputSlot>, AppError> {
    validate_operation(operation)?;
    let requirements = required_columns_by_role(operation);
    let mut slots = Vec::new();

    for role in required_input_roles(operation) {
        let source_columns = source_schemas
            .get(role.as_str())
            .ok_or_else(|| invalid(format!("missing source schema for role {role}")))?;
        let required_names = requirements.get(role.as_str()).cloned().unwrap_or_default();
        let columns = contract_columns(source_columns, &required_names, role.as_str())?;
        slots.push(TableTransformInputSlot {
            role,
            schema_contract: SchemaContract {
                schema_fingerprint: schema_fingerprint(&columns),
                columns,
            },
        });
    }

    Ok(slots)
}

pub fn validate_table_transform_definition(
    definition: &TableTransformDefinition,
) -> Result<(), AppError> {
    require_non_empty(&definition.id, "transform id")?;
    require_non_empty(&definition.name, "transform name")?;
    require_non_empty(
        &definition.output.table_document_id,
        "output table document id",
    )?;
    require_non_empty(&definition.output.name, "output name")?;
    if definition.format_version != TABLE_TRANSFORM_FORMAT_VERSION {
        return Err(invalid(format!(
            "unsupported table transform format version: {}",
            definition.format_version
        )));
    }
    validate_operation(&definition.operation)?;

    let expected_roles = required_input_roles(&definition.operation);
    let actual_roles = definition
        .input_slots
        .iter()
        .map(|slot| slot.role.clone())
        .collect::<Vec<_>>();
    let unique_roles = actual_roles.iter().collect::<HashSet<_>>();
    if unique_roles.len() != actual_roles.len() {
        return Err(invalid("table transform input roles must be unique"));
    }
    if actual_roles != expected_roles {
        return Err(invalid(format!(
            "table transform input roles must be {}",
            expected_roles.join(", ")
        )));
    }

    let requirements = required_columns_by_role(&definition.operation);
    for slot in &definition.input_slots {
        validate_schema_contract_shape(&slot.schema_contract, &slot.role)?;
        let contract_columns = slot
            .schema_contract
            .columns
            .iter()
            .filter(|column| column.required)
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        for required_name in requirements.get(slot.role.as_str()).into_iter().flatten() {
            if !contract_columns.contains(required_name.as_str()) {
                return Err(invalid(format!(
                    "input role {} contract is missing required column {}",
                    slot.role, required_name
                )));
            }
        }
    }

    Ok(())
}

fn validate_schema_contract_shape(contract: &SchemaContract, role: &str) -> Result<(), AppError> {
    let mut names = HashSet::new();
    for column in &contract.columns {
        require_non_empty(&column.name, "schema contract column name")?;
        require_non_empty(&column.canonical_duckdb_type, "schema contract column type")?;
        if !names.insert(column.name.as_str()) {
            return Err(invalid(format!(
                "input role {role} contract contains duplicate column {}",
                column.name
            )));
        }
    }
    if contract.schema_fingerprint != schema_fingerprint(&contract.columns) {
        return Err(invalid(format!(
            "input role {role} schema fingerprint does not match its columns"
        )));
    }
    Ok(())
}

fn normalize_filter_expression(
    expression: Expr,
    allowed_columns: &HashSet<&str>,
) -> Result<TableFilterExpression, AppError> {
    match expression {
        Expr::Nested(expression) => normalize_filter_expression(*expression, allowed_columns),
        Expr::UnaryOp {
            op: UnaryOperator::Not,
            expr,
        } => Ok(TableFilterExpression::Not {
            expression: Box::new(normalize_filter_expression(*expr, allowed_columns)?),
        }),
        Expr::BinaryOp { left, op, right }
            if matches!(op, BinaryOperator::And | BinaryOperator::Or) =>
        {
            let operator = if op == BinaryOperator::And {
                TableFilterLogicalOperator::And
            } else {
                TableFilterLogicalOperator::Or
            };
            Ok(TableFilterExpression::Logical {
                operator,
                left: Box::new(normalize_filter_expression(*left, allowed_columns)?),
                right: Box::new(normalize_filter_expression(*right, allowed_columns)?),
            })
        }
        Expr::BinaryOp { left, op, right } => {
            let column = column_name(*left, allowed_columns)?;
            let operator = comparison_operator(op)?;
            let value = scalar_value(*right)?;
            Ok(TableFilterExpression::Comparison {
                column,
                operator,
                value,
            })
        }
        Expr::IsNull(expression) => Ok(TableFilterExpression::IsNull {
            column: column_name(*expression, allowed_columns)?,
            negated: false,
        }),
        Expr::IsNotNull(expression) => Ok(TableFilterExpression::IsNull {
            column: column_name(*expression, allowed_columns)?,
            negated: true,
        }),
        _ => Err(invalid("unsupported filter expression")),
    }
}

fn column_name(expression: Expr, allowed_columns: &HashSet<&str>) -> Result<String, AppError> {
    let name = match expression {
        Expr::Identifier(identifier) => identifier.value,
        Expr::Nested(expression) => return column_name(*expression, allowed_columns),
        _ => return Err(invalid("filter comparison must start with a column")),
    };
    if !allowed_columns.contains(name.as_str()) {
        return Err(invalid(format!("unknown filter column: {name}")));
    }
    Ok(name)
}

fn comparison_operator(op: BinaryOperator) -> Result<TableFilterComparisonOperator, AppError> {
    match op {
        BinaryOperator::Eq => Ok(TableFilterComparisonOperator::Equal),
        BinaryOperator::NotEq => Ok(TableFilterComparisonOperator::NotEqual),
        BinaryOperator::Gt => Ok(TableFilterComparisonOperator::GreaterThan),
        BinaryOperator::GtEq => Ok(TableFilterComparisonOperator::GreaterThanOrEqual),
        BinaryOperator::Lt => Ok(TableFilterComparisonOperator::LessThan),
        BinaryOperator::LtEq => Ok(TableFilterComparisonOperator::LessThanOrEqual),
        _ => Err(invalid("unsupported filter comparison operator")),
    }
}

fn scalar_value(expression: Expr) -> Result<TableFilterScalar, AppError> {
    match expression {
        Expr::Nested(expression) => scalar_value(*expression),
        Expr::Value(value) => match value.value {
            Value::SingleQuotedString(value) => Ok(TableFilterScalar::String(value)),
            Value::Number(value, _) => Ok(TableFilterScalar::Number(value)),
            Value::Boolean(value) => Ok(TableFilterScalar::Boolean(value)),
            Value::Null => Ok(TableFilterScalar::Null),
            _ => Err(invalid("unsupported filter scalar value")),
        },
        _ => Err(invalid("filter comparison requires a scalar value")),
    }
}

fn required_columns_by_role(operation: &TableTransformOperation) -> HashMap<String, Vec<String>> {
    let mut requirements = HashMap::new();
    match operation {
        TableTransformOperation::Sort { sort_columns } => {
            requirements.insert(
                "source".to_string(),
                sort_columns
                    .iter()
                    .map(|column| column.column.clone())
                    .collect(),
            );
        }
        TableTransformOperation::Subset { columns, filter } => {
            let mut names = columns.clone();
            if let Some(filter) = filter {
                collect_filter_columns(filter, &mut names);
            }
            requirements.insert("source".to_string(), deduplicate(names));
        }
        TableTransformOperation::Transpose => {}
        TableTransformOperation::Stack {
            stack_columns,
            id_columns,
        } => {
            requirements.insert(
                "source".to_string(),
                deduplicate(stack_columns.iter().chain(id_columns).cloned().collect()),
            );
        }
        TableTransformOperation::Split {
            split_column,
            value_column,
            id_columns,
        } => {
            let mut names = vec![split_column.clone(), value_column.clone()];
            names.extend(id_columns.iter().cloned());
            requirements.insert("source".to_string(), deduplicate(names));
        }
        TableTransformOperation::Summary {
            statistic_columns,
            group_columns,
            ..
        } => {
            requirements.insert(
                "source".to_string(),
                deduplicate(
                    statistic_columns
                        .iter()
                        .chain(group_columns)
                        .cloned()
                        .collect(),
                ),
            );
        }
        TableTransformOperation::Join {
            left_key,
            right_key,
            ..
        } => {
            requirements.insert("left".to_string(), vec![left_key.clone()]);
            requirements.insert("right".to_string(), vec![right_key.clone()]);
        }
        TableTransformOperation::Update {
            match_column,
            update_columns,
        } => {
            let mut names = vec![match_column.clone()];
            names.extend(update_columns.iter().cloned());
            let names = deduplicate(names);
            requirements.insert("left".to_string(), names.clone());
            requirements.insert("right".to_string(), names);
        }
        TableTransformOperation::Concatenate { .. } => {}
    }
    requirements
}

fn contract_columns(
    source_columns: &[TableColumn],
    required_names: &[String],
    role: &str,
) -> Result<Vec<SchemaColumnRequirement>, AppError> {
    let source_by_name = source_columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<HashMap<_, _>>();
    let names = if required_names.is_empty() && role == "source" {
        source_columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>()
    } else {
        required_names.to_vec()
    };

    names
        .iter()
        .map(|name| {
            let source = source_by_name.get(name.as_str()).ok_or_else(|| {
                invalid(format!(
                    "column {name} does not exist in source schema for role {role}"
                ))
            })?;
            Ok(SchemaColumnRequirement {
                name: name.clone(),
                canonical_duckdb_type: canonical_duckdb_type(&source.col_type),
                required: true,
                required_by_operation_ids: vec![CONTRACT_OPERATION_ID.to_string()],
            })
        })
        .collect()
}

fn collect_filter_columns(expression: &TableFilterExpression, columns: &mut Vec<String>) {
    match expression {
        TableFilterExpression::Logical { left, right, .. } => {
            collect_filter_columns(left, columns);
            collect_filter_columns(right, columns);
        }
        TableFilterExpression::Not { expression } => collect_filter_columns(expression, columns),
        TableFilterExpression::Comparison { column, .. }
        | TableFilterExpression::IsNull { column, .. } => columns.push(column.clone()),
    }
}

fn validate_operation(operation: &TableTransformOperation) -> Result<(), AppError> {
    match operation {
        TableTransformOperation::Sort { sort_columns } => {
            require_non_empty_columns(
                &sort_columns
                    .iter()
                    .map(|column| column.column.clone())
                    .collect::<Vec<_>>(),
                "sort columns",
            )?;
        }
        TableTransformOperation::Subset { columns, .. } => {
            reject_blank_columns(columns, "subset columns")?;
        }
        TableTransformOperation::Transpose => {}
        TableTransformOperation::Stack {
            stack_columns,
            id_columns,
        } => {
            require_non_empty_columns(stack_columns, "stack columns")?;
            reject_blank_columns(id_columns, "identifier columns")?;
        }
        TableTransformOperation::Split {
            split_column,
            value_column,
            id_columns,
        } => {
            require_non_empty(split_column, "split column")?;
            require_non_empty(value_column, "value column")?;
            reject_blank_columns(id_columns, "identifier columns")?;
        }
        TableTransformOperation::Summary {
            statistic_columns,
            group_columns,
            statistics,
        } => {
            require_non_empty_columns(statistic_columns, "statistic columns")?;
            reject_blank_columns(group_columns, "group columns")?;
            if statistics.is_empty() {
                return Err(invalid("at least one summary statistic is required"));
            }
        }
        TableTransformOperation::Join {
            left_key,
            right_key,
            ..
        } => {
            require_non_empty(left_key, "left join key")?;
            require_non_empty(right_key, "right join key")?;
        }
        TableTransformOperation::Update {
            match_column,
            update_columns,
        } => {
            require_non_empty(match_column, "update match column")?;
            require_non_empty_columns(update_columns, "update columns")?;
        }
        TableTransformOperation::Concatenate { source_count } => {
            if *source_count == 0 {
                return Err(invalid("concatenate requires at least one source"));
            }
        }
    }
    Ok(())
}

fn require_non_empty(value: &str, label: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{label} is required")));
    }
    Ok(())
}

fn require_non_empty_columns(columns: &[String], label: &str) -> Result<(), AppError> {
    if columns.is_empty() {
        return Err(invalid(format!("at least one {label} value is required")));
    }
    reject_blank_columns(columns, label)
}

fn reject_blank_columns(columns: &[String], label: &str) -> Result<(), AppError> {
    if columns.iter().any(|column| column.trim().is_empty()) {
        return Err(invalid(format!("{label} cannot contain blank names")));
    }
    Ok(())
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::error::AppError;
    use crate::services::spprj_archive::{ProjectDocumentKind, TableColumn};
    use crate::services::workflow_domain::OperationKind;

    use super::*;

    fn column(name: &str, col_type: &str) -> TableColumn {
        TableColumn {
            name: name.to_string(),
            col_type: col_type.to_string(),
            width: None,
            format: None,
            extras: None,
        }
    }

    fn schemas(roles: &[(&str, Vec<TableColumn>)]) -> HashMap<String, Vec<TableColumn>> {
        roles
            .iter()
            .map(|(role, columns)| ((*role).to_string(), columns.clone()))
            .collect()
    }

    fn definition(
        operation: TableTransformOperation,
        input_slots: Vec<TableTransformInputSlot>,
    ) -> TableTransformDefinition {
        TableTransformDefinition {
            id: "transform-1".to_string(),
            name: "Reusable transform".to_string(),
            format_version: "1".to_string(),
            revision: 1,
            operation,
            input_slots,
            output: TableTransformOutput {
                table_document_id: "output-table-1".to_string(),
                name: "Transformed table".to_string(),
            },
        }
    }

    #[test]
    fn all_v1_operations_have_canonical_input_roles() {
        let cases = [
            (
                TableTransformOperation::Sort {
                    sort_columns: vec![SortColumn {
                        column: "value".to_string(),
                        direction: SortDirection::Ascending,
                    }],
                },
                vec!["source"],
            ),
            (
                TableTransformOperation::Subset {
                    columns: vec!["value".to_string()],
                    filter: None,
                },
                vec!["source"],
            ),
            (TableTransformOperation::Transpose, vec!["source"]),
            (
                TableTransformOperation::Stack {
                    stack_columns: vec!["value".to_string()],
                    id_columns: vec!["id".to_string()],
                },
                vec!["source"],
            ),
            (
                TableTransformOperation::Split {
                    split_column: "label".to_string(),
                    value_column: "value".to_string(),
                    id_columns: vec!["id".to_string()],
                },
                vec!["source"],
            ),
            (
                TableTransformOperation::Summary {
                    statistic_columns: vec!["value".to_string()],
                    group_columns: vec!["group".to_string()],
                    statistics: vec![SummaryStatistic::Mean],
                },
                vec!["source"],
            ),
            (
                TableTransformOperation::Join {
                    join_type: JoinType::Inner,
                    left_key: "id".to_string(),
                    right_key: "id".to_string(),
                },
                vec!["left", "right"],
            ),
            (
                TableTransformOperation::Update {
                    match_column: "id".to_string(),
                    update_columns: vec!["value".to_string()],
                },
                vec!["left", "right"],
            ),
            (
                TableTransformOperation::Concatenate { source_count: 3 },
                vec!["source-1", "source-2", "source-3"],
            ),
        ];

        for (operation, expected) in cases {
            assert_eq!(required_input_roles(&operation), expected);
        }
    }

    #[test]
    fn derives_contracts_from_only_operation_referenced_columns() {
        let operation = TableTransformOperation::Summary {
            statistic_columns: vec!["value".to_string()],
            group_columns: vec!["group".to_string()],
            statistics: vec![SummaryStatistic::Mean],
        };
        let contracts = derive_input_contracts(
            &operation,
            &schemas(&[(
                "source",
                vec![
                    column("id", "BIGINT"),
                    column("value", "DOUBLE PRECISION"),
                    column("group", "TEXT"),
                    column("unused", "INTEGER"),
                ],
            )]),
        )
        .expect("derive contracts");

        assert_eq!(contracts.len(), 1);
        assert_eq!(contracts[0].role, "source");
        assert_eq!(
            contracts[0]
                .schema_contract
                .columns
                .iter()
                .map(|column| (column.name.as_str(), column.canonical_duckdb_type.as_str()))
                .collect::<Vec<_>>(),
            vec![("value", "DOUBLE"), ("group", "VARCHAR")],
        );
    }

    #[test]
    fn update_contract_requires_target_and_source_update_columns() {
        let operation = TableTransformOperation::Update {
            match_column: "id".to_string(),
            update_columns: vec!["status".to_string()],
        };
        let contracts = derive_input_contracts(
            &operation,
            &schemas(&[
                ("left", vec![column("id", "INT"), column("status", "TEXT")]),
                (
                    "right",
                    vec![column("id", "INTEGER"), column("status", "VARCHAR")],
                ),
            ]),
        )
        .expect("derive update contracts");

        assert_eq!(contracts[0].role, "left");
        assert_eq!(contracts[0].schema_contract.columns.len(), 2);
        assert_eq!(contracts[1].role, "right");
        assert_eq!(contracts[1].schema_contract.columns.len(), 2);
    }

    #[test]
    fn transpose_contract_records_the_complete_source_schema() {
        let contracts = derive_input_contracts(
            &TableTransformOperation::Transpose,
            &schemas(&[(
                "source",
                vec![column("id", "INTEGER"), column("value", "DOUBLE")],
            )]),
        )
        .expect("derive transpose contract");

        assert_eq!(contracts[0].schema_contract.columns.len(), 2);
    }

    #[test]
    fn subset_filter_is_serializable_and_contributes_referenced_columns() {
        let source_columns = vec![
            column("age", "INTEGER"),
            column("status", "VARCHAR"),
            column("unused", "VARCHAR"),
        ];
        let filter = parse_filter_expression("age >= 18 AND status = 'active'", &source_columns)
            .expect("parse filter");
        let serialized = serde_json::to_value(&filter).expect("serialize filter");
        assert_eq!(serialized["kind"], "logical");

        let contracts = derive_input_contracts(
            &TableTransformOperation::Subset {
                columns: Vec::new(),
                filter: Some(filter),
            },
            &schemas(&[("source", source_columns)]),
        )
        .expect("derive subset contracts");
        assert_eq!(
            contracts[0]
                .schema_contract
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            vec!["age", "status"],
        );
    }

    #[test]
    fn subset_filter_rejects_executable_or_unsupported_sql() {
        let source_columns = vec![column("age", "INTEGER")];
        for expression in [
            "age > 18; DROP TABLE x",
            "EXISTS (SELECT 1)",
            "lower(age) = '18'",
            "age > 18 -- comment",
            "unknown = 1",
        ] {
            let error = parse_filter_expression(expression, &source_columns)
                .expect_err("unsupported filter must be rejected");
            assert!(matches!(error, AppError::InvalidParam(_)));
        }
    }

    #[test]
    fn definition_validation_rejects_version_identity_and_role_errors() {
        let operation = TableTransformOperation::Join {
            join_type: JoinType::Left,
            left_key: "id".to_string(),
            right_key: "id".to_string(),
        };
        let contract = derive_input_contracts(
            &operation,
            &schemas(&[
                ("left", vec![column("id", "INTEGER")]),
                ("right", vec![column("id", "INTEGER")]),
            ]),
        )
        .expect("derive join contracts");

        let mut invalid_version = definition(operation.clone(), contract.clone());
        invalid_version.format_version = "2".to_string();
        assert!(validate_table_transform_definition(&invalid_version).is_err());

        let mut blank_id = definition(operation.clone(), contract.clone());
        blank_id.id = " ".to_string();
        assert!(validate_table_transform_definition(&blank_id).is_err());

        let mut duplicate_role = definition(operation.clone(), contract.clone());
        duplicate_role.input_slots[1].role = "left".to_string();
        assert!(validate_table_transform_definition(&duplicate_role).is_err());

        let mut missing_role = definition(operation, contract);
        missing_role.input_slots.pop();
        assert!(validate_table_transform_definition(&missing_role).is_err());
    }

    #[test]
    fn definition_validation_rejects_missing_operation_contract_columns() {
        let operation = TableTransformOperation::Sort {
            sort_columns: vec![SortColumn {
                column: "value".to_string(),
                direction: SortDirection::Ascending,
            }],
        };
        let mut input_slots = derive_input_contracts(
            &operation,
            &schemas(&[("source", vec![column("value", "DOUBLE")])]),
        )
        .expect("derive sort contract");
        input_slots[0].schema_contract.columns.clear();
        let definition = definition(operation, input_slots);

        assert!(validate_table_transform_definition(&definition).is_err());
    }

    #[test]
    fn workflow_kinds_serialize_as_table_transform() {
        assert_eq!(
            serde_json::to_value(ProjectDocumentKind::TableTransform).unwrap(),
            "tableTransform",
        );
        assert_eq!(
            serde_json::to_value(OperationKind::TableTransform).unwrap(),
            "tableTransform",
        );
    }
}

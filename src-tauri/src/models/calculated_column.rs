use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedCalculatedColumnDefinition {
    pub formula_id: String,
    pub schema_version: String,
    pub output_column_id: String,
    pub archived_definition: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FiniteF64(f64);

impl FiniteF64 {
    pub fn try_new(value: f64) -> Result<Self, String> {
        if value.is_finite() {
            Ok(Self(value))
        } else {
            Err(format!("non-finite floating-point literal: {value}"))
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl Serialize for FiniteF64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_f64(self.0)
    }
}

impl<'de> Deserialize<'de> for FiniteF64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = f64::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CalculatedNumber {
    Integer(i64),
    Float(FiniteF64),
}

impl From<i64> for CalculatedNumber {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

impl From<i32> for CalculatedNumber {
    fn from(value: i32) -> Self {
        Self::Integer(i64::from(value))
    }
}

impl From<u32> for CalculatedNumber {
    fn from(value: u32) -> Self {
        Self::Integer(i64::from(value))
    }
}

impl TryFrom<f64> for CalculatedNumber {
    type Error = String;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Ok(Self::Float(FiniteF64::try_new(value)?))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedUnaryOperatorV1 {
    Plus,
    Minus,
    Not,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedBinaryOperatorV1 {
    Add,
    Subtract,
    Multiply,
    Divide,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedComparisonOperatorV1 {
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedLogicalOperatorV1 {
    And,
    Or,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedFunctionV1 {
    Abs,
    Coalesce,
    If,
    Max,
    Min,
    Round,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalculatedExpressionV1 {
    ColumnRef {
        column_id: String,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedOutputTypeV1 {
    Boolean,
    Continuous,
    Integer,
    Null,
    Text,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedColumnStatus {
    Draft,
    Ready,
    Disabled,
    #[serde(alias = "invalid")]
    Broken,
    Unsupported,
}

impl CalculatedColumnStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Disabled => "disabled",
            Self::Broken => "broken",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalculatedDiagnosticLevel {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnDiagnostic {
    pub level: CalculatedDiagnosticLevel,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_column_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnWarningCount {
    pub total: u32,
    pub expression: u32,
    pub dependency_graph: u32,
    pub validation: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnDefinitionV1 {
    pub formula_id: String,
    pub schema_version: String,
    pub output_column_id: String,
    pub expression: CalculatedExpressionV1,
    pub dependency_column_ids: Vec<String>,
    pub inferred_output_type: CalculatedOutputTypeV1,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedCalculatedColumnState {
    #[serde(
        default = "archived_calculated_default_status",
        skip_serializing_if = "is_archived_calculated_default_status"
    )]
    pub status: CalculatedColumnStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<CalculatedColumnDiagnostic>,
}

impl Default for ArchivedCalculatedColumnState {
    fn default() -> Self {
        Self {
            status: archived_calculated_default_status(),
            diagnostics: Vec::new(),
        }
    }
}

fn archived_calculated_default_status() -> CalculatedColumnStatus {
    CalculatedColumnStatus::Ready
}

fn is_archived_calculated_default_status(status: &CalculatedColumnStatus) -> bool {
    *status == CalculatedColumnStatus::Ready
}

fn archived_calculated_state_is_default(state: &ArchivedCalculatedColumnState) -> bool {
    is_archived_calculated_default_status(&state.status) && state.diagnostics.is_empty()
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArchivedCalculatedColumn {
    Ready {
        definition: CalculatedColumnDefinitionV1,
        state: ArchivedCalculatedColumnState,
    },
    Preserved {
        definition: PreservedCalculatedColumnDefinition,
    },
}

impl ArchivedCalculatedColumn {
    pub fn formula_id(&self) -> &str {
        match self {
            Self::Ready { definition, .. } => &definition.formula_id,
            Self::Preserved { definition } => &definition.formula_id,
        }
    }

    pub fn output_column_id(&self) -> &str {
        match self {
            Self::Ready { definition, .. } => &definition.output_column_id,
            Self::Preserved { definition } => &definition.output_column_id,
        }
    }

    pub fn schema_version(&self) -> &str {
        match self {
            Self::Ready { definition, .. } => &definition.schema_version,
            Self::Preserved { definition } => &definition.schema_version,
        }
    }

    pub fn ready_definition(&self) -> Option<&CalculatedColumnDefinitionV1> {
        match self {
            Self::Ready { definition, .. } => Some(definition),
            Self::Preserved { .. } => None,
        }
    }

    pub fn ready_state(&self) -> Option<&ArchivedCalculatedColumnState> {
        match self {
            Self::Ready { state, .. } => Some(state),
            Self::Preserved { .. } => None,
        }
    }

    pub fn with_ready_state(self, state: ArchivedCalculatedColumnState) -> Self {
        match self {
            Self::Ready { definition, .. } => Self::Ready { definition, state },
            preserved => preserved,
        }
    }
}

impl Serialize for ArchivedCalculatedColumn {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Ready { definition, state } => {
                let mut value = serde_json::json!({
                    "kind": "ready",
                    "definition": definition,
                });
                if !archived_calculated_state_is_default(state) {
                    let object = value.as_object_mut().ok_or_else(|| {
                        serde::ser::Error::custom(
                            "archived calculated column must serialize as an object",
                        )
                    })?;
                    object.insert(
                        "status".to_string(),
                        serde_json::to_value(&state.status).map_err(serde::ser::Error::custom)?,
                    );
                    if !state.diagnostics.is_empty() {
                        object.insert(
                            "diagnostics".to_string(),
                            serde_json::to_value(&state.diagnostics)
                                .map_err(serde::ser::Error::custom)?,
                        );
                    }
                }
                value.serialize(serializer)
            }
            Self::Preserved { definition } => definition.archived_definition.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ArchivedCalculatedColumn {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let archived_definition = serde_json::Value::deserialize(deserializer)?;
        let object = archived_definition.as_object().ok_or_else(|| {
            serde::de::Error::custom("archived calculated column must be an object")
        })?;
        let kind = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                serde::de::Error::custom("archived calculated column kind is missing")
            })?;
        if kind != "ready" {
            return Err(serde::de::Error::custom(format!(
                "unsupported archived calculated column kind {kind}"
            )));
        }
        let definition_value = object.get("definition").ok_or_else(|| {
            serde::de::Error::custom("archived calculated column definition is missing")
        })?;
        let definition_object = definition_value.as_object().ok_or_else(|| {
            serde::de::Error::custom("archived calculated column definition must be an object")
        })?;
        let formula_id = required_archived_string(definition_object, "formulaId")
            .map_err(serde::de::Error::custom)?;
        let schema_version = required_archived_string(definition_object, "schemaVersion")
            .map_err(serde::de::Error::custom)?;
        let output_column_id = required_archived_string(definition_object, "outputColumnId")
            .map_err(serde::de::Error::custom)?;
        let state = ArchivedCalculatedColumnState {
            status: object
                .get("status")
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(serde::de::Error::custom)
                })
                .transpose()?
                .unwrap_or_else(archived_calculated_default_status),
            diagnostics: object
                .get("diagnostics")
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(serde::de::Error::custom)
                })
                .transpose()?
                .unwrap_or_default(),
        };

        if schema_version == "1" {
            let definition =
                serde_json::from_value::<CalculatedColumnDefinitionV1>(definition_value.clone())
                    .map_err(serde::de::Error::custom)?;
            Ok(Self::Ready { definition, state })
        } else {
            Ok(Self::Preserved {
                definition: PreservedCalculatedColumnDefinition {
                    formula_id,
                    schema_version,
                    output_column_id,
                    archived_definition,
                },
            })
        }
    }
}

fn required_archived_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("archived calculated column definition {field} is missing"))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnDescriptor {
    pub formula_id: String,
    pub schema_version: String,
    pub output_column_id: String,
    pub display_formula_text: String,
    pub status: CalculatedColumnStatus,
    pub dependency_column_ids: Vec<String>,
    pub inferred_output_type: CalculatedOutputTypeV1,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnValidationRequest {
    pub definition: CalculatedColumnDefinitionV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub existing_definitions: Vec<CalculatedColumnDefinitionV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnValidationResult {
    pub status: CalculatedColumnStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<CalculatedColumnDiagnostic>,
    pub warning_count: CalculatedColumnWarningCount,
    pub definition: CalculatedColumnDefinitionV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnUpsertRequest {
    pub table_id: String,
    pub definition: CalculatedColumnDefinitionV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedColumnMutationResult {
    pub column_id: String,
    pub dataset_generation: u64,
    pub change_set_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calculated: Option<CalculatedColumnDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<CalculatedColumnDiagnostic>,
    pub warning_count: CalculatedColumnWarningCount,
}

fn escape_display_column_name(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

pub fn display_formula_text<F>(expression: &CalculatedExpressionV1, resolve_name: &F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => resolve_name(column_id)
            .map(|name| escape_display_column_name(&name))
            .unwrap_or_else(|| format!("[{}]", column_id)),
        CalculatedExpressionV1::NumberLiteral { value } => match value {
            CalculatedNumber::Integer(value) => value.to_string(),
            CalculatedNumber::Float(value) => value.get().to_string(),
        },
        CalculatedExpressionV1::BooleanLiteral { value } => {
            if *value {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        CalculatedExpressionV1::NullLiteral => "NULL".into(),
        CalculatedExpressionV1::Unary { operator, operand } => {
            let operand = display_formula_text(operand, resolve_name);
            match operator {
                CalculatedUnaryOperatorV1::Plus => format!("+({operand})"),
                CalculatedUnaryOperatorV1::Minus => format!("-({operand})"),
                CalculatedUnaryOperatorV1::Not => format!("NOT ({operand})"),
            }
        }
        CalculatedExpressionV1::Binary {
            operator,
            left,
            right,
        } => {
            let left = display_formula_text(left, resolve_name);
            let right = display_formula_text(right, resolve_name);
            let symbol = match operator {
                CalculatedBinaryOperatorV1::Add => "+",
                CalculatedBinaryOperatorV1::Subtract => "-",
                CalculatedBinaryOperatorV1::Multiply => "*",
                CalculatedBinaryOperatorV1::Divide => "/",
            };
            format!("({left} {symbol} {right})")
        }
        CalculatedExpressionV1::Comparison {
            operator,
            left,
            right,
        } => {
            let left = display_formula_text(left, resolve_name);
            let right = display_formula_text(right, resolve_name);
            let symbol = match operator {
                CalculatedComparisonOperatorV1::Eq => "=",
                CalculatedComparisonOperatorV1::NotEq => "!=",
                CalculatedComparisonOperatorV1::Lt => "<",
                CalculatedComparisonOperatorV1::Lte => "<=",
                CalculatedComparisonOperatorV1::Gt => ">",
                CalculatedComparisonOperatorV1::Gte => ">=",
            };
            format!("({left} {symbol} {right})")
        }
        CalculatedExpressionV1::Logical {
            operator,
            left,
            right,
        } => {
            let left = display_formula_text(left, resolve_name);
            let right = display_formula_text(right, resolve_name);
            let symbol = match operator {
                CalculatedLogicalOperatorV1::And => "AND",
                CalculatedLogicalOperatorV1::Or => "OR",
            };
            format!("({left} {symbol} {right})")
        }
        CalculatedExpressionV1::Function {
            function,
            arguments,
        } => {
            let function = match function {
                CalculatedFunctionV1::Abs => "ABS",
                CalculatedFunctionV1::Coalesce => "COALESCE",
                CalculatedFunctionV1::If => "IF",
                CalculatedFunctionV1::Max => "MAX",
                CalculatedFunctionV1::Min => "MIN",
                CalculatedFunctionV1::Round => "ROUND",
            };
            let arguments = arguments
                .iter()
                .map(|argument| display_formula_text(argument, resolve_name))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{function}({arguments})")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateCalculatedColumnRequest {
    pub dataset_id: String,
    pub output_name: String,
    pub formula_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_index: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_column_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_generation: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCalculatedColumnRequest {
    pub dataset_id: String,
    pub output_name: String,
    pub formula_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_index: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_column_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_generation: Option<u64>,
}

pub type CalculatedColumnValidation = CalculatedColumnValidationResult;

fn diagnostic_error(
    code: &str,
    message: impl Into<String>,
    related_column_ids: Vec<String>,
) -> CalculatedColumnDiagnostic {
    CalculatedColumnDiagnostic {
        level: CalculatedDiagnosticLevel::Error,
        code: code.to_string(),
        message: message.into(),
        related_column_ids,
    }
}

pub fn expression_dependency_ids(expression: &CalculatedExpressionV1) -> Vec<String> {
    let mut dependency_ids = Vec::new();
    let mut seen = HashSet::new();
    collect_expression_dependency_ids(expression, &mut seen, &mut dependency_ids);
    dependency_ids
}

fn collect_expression_dependency_ids(
    expression: &CalculatedExpressionV1,
    seen: &mut HashSet<String>,
    dependency_ids: &mut Vec<String>,
) {
    match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => {
            if seen.insert(column_id.clone()) {
                dependency_ids.push(column_id.clone());
            }
        }
        CalculatedExpressionV1::NumberLiteral { .. }
        | CalculatedExpressionV1::BooleanLiteral { .. }
        | CalculatedExpressionV1::NullLiteral => {}
        CalculatedExpressionV1::Unary { operand, .. } => {
            collect_expression_dependency_ids(operand, seen, dependency_ids);
        }
        CalculatedExpressionV1::Binary { left, right, .. }
        | CalculatedExpressionV1::Comparison { left, right, .. }
        | CalculatedExpressionV1::Logical { left, right, .. } => {
            collect_expression_dependency_ids(left, seen, dependency_ids);
            collect_expression_dependency_ids(right, seen, dependency_ids);
        }
        CalculatedExpressionV1::Function { arguments, .. } => {
            for argument in arguments {
                collect_expression_dependency_ids(argument, seen, dependency_ids);
            }
        }
    }
}

pub fn definition_fingerprint(definition: &CalculatedColumnDefinitionV1) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical_definition_bytes(definition))
    )
}

fn canonical_definition_bytes(definition: &CalculatedColumnDefinitionV1) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"calculated-column-definition-v1");
    write_string(&mut bytes, &definition.schema_version);
    write_expression_bytes(&mut bytes, &definition.expression);
    write_string_list(&mut bytes, &definition.dependency_column_ids);
    write_string(&mut bytes, definition.inferred_output_type.as_str());
    bytes
}

fn write_string_list(bytes: &mut Vec<u8>, values: &[String]) {
    write_length(bytes, values.len());
    for value in values {
        write_string(bytes, value);
    }
}

fn write_expression_bytes(bytes: &mut Vec<u8>, expression: &CalculatedExpressionV1) {
    match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => {
            bytes.push(0);
            write_string(bytes, column_id);
        }
        CalculatedExpressionV1::NumberLiteral { value } => {
            bytes.push(1);
            match value {
                CalculatedNumber::Integer(value) => {
                    bytes.push(0);
                    write_string(bytes, &value.to_string());
                }
                CalculatedNumber::Float(value) => {
                    bytes.push(1);
                    write_string(bytes, &value.get().to_string());
                }
            }
        }
        CalculatedExpressionV1::BooleanLiteral { value } => {
            bytes.push(2);
            bytes.push(u8::from(*value));
        }
        CalculatedExpressionV1::NullLiteral => {
            bytes.push(3);
        }
        CalculatedExpressionV1::Unary { operator, operand } => {
            bytes.push(4);
            write_string(bytes, operator.as_str());
            write_expression_bytes(bytes, operand);
        }
        CalculatedExpressionV1::Binary {
            operator,
            left,
            right,
        } => {
            bytes.push(5);
            write_string(bytes, operator.as_str());
            write_expression_bytes(bytes, left);
            write_expression_bytes(bytes, right);
        }
        CalculatedExpressionV1::Comparison {
            operator,
            left,
            right,
        } => {
            bytes.push(6);
            write_string(bytes, operator.as_str());
            write_expression_bytes(bytes, left);
            write_expression_bytes(bytes, right);
        }
        CalculatedExpressionV1::Logical {
            operator,
            left,
            right,
        } => {
            bytes.push(7);
            write_string(bytes, operator.as_str());
            write_expression_bytes(bytes, left);
            write_expression_bytes(bytes, right);
        }
        CalculatedExpressionV1::Function {
            function,
            arguments,
        } => {
            bytes.push(8);
            write_string(bytes, function.as_str());
            write_length(bytes, arguments.len());
            for argument in arguments {
                write_expression_bytes(bytes, argument);
            }
        }
    }
}

fn write_string(bytes: &mut Vec<u8>, value: &str) {
    write_length(bytes, value.len());
    bytes.extend_from_slice(value.as_bytes());
}

fn write_length(bytes: &mut Vec<u8>, value: usize) {
    bytes.extend_from_slice(&(value as u64).to_be_bytes());
}

pub fn remap_definition(
    definition: &CalculatedColumnDefinitionV1,
    formula_id: impl Into<String>,
    output_column_id: impl Into<String>,
    old_to_new_column_ids: &HashMap<String, String>,
) -> Result<CalculatedColumnDefinitionV1, CalculatedColumnDiagnostic> {
    let formula_id = formula_id.into();
    let output_column_id = output_column_id.into();
    if formula_id.is_empty() {
        return Err(diagnostic_error(
            "missingFormulaId",
            "formula id cannot be empty",
            Vec::new(),
        ));
    }
    if output_column_id.is_empty() {
        return Err(diagnostic_error(
            "missingOutputColumnId",
            "output column id cannot be empty",
            Vec::new(),
        ));
    }

    let expression = remap_expression(&definition.expression, old_to_new_column_ids)?;
    let dependency_column_ids = expression_dependency_ids(&expression);
    let remapped = CalculatedColumnDefinitionV1 {
        formula_id,
        schema_version: definition.schema_version.clone(),
        output_column_id,
        expression,
        dependency_column_ids,
        inferred_output_type: definition.inferred_output_type.clone(),
        fingerprint: String::new(),
    };
    let fingerprint = definition_fingerprint(&remapped);
    Ok(CalculatedColumnDefinitionV1 {
        fingerprint,
        ..remapped
    })
}

fn remap_expression(
    expression: &CalculatedExpressionV1,
    old_to_new_column_ids: &HashMap<String, String>,
) -> Result<CalculatedExpressionV1, CalculatedColumnDiagnostic> {
    Ok(match expression {
        CalculatedExpressionV1::ColumnRef { column_id } => {
            let Some(new_column_id) = old_to_new_column_ids.get(column_id) else {
                return Err(diagnostic_error(
                    "missingColumnIdMapEntry",
                    format!("missing remap target for column id {column_id}"),
                    vec![column_id.clone()],
                ));
            };
            CalculatedExpressionV1::ColumnRef {
                column_id: new_column_id.clone(),
            }
        }
        CalculatedExpressionV1::NumberLiteral { value } => CalculatedExpressionV1::NumberLiteral {
            value: value.clone(),
        },
        CalculatedExpressionV1::BooleanLiteral { value } => {
            CalculatedExpressionV1::BooleanLiteral { value: *value }
        }
        CalculatedExpressionV1::NullLiteral => CalculatedExpressionV1::NullLiteral,
        CalculatedExpressionV1::Unary { operator, operand } => CalculatedExpressionV1::Unary {
            operator: operator.clone(),
            operand: Box::new(remap_expression(operand, old_to_new_column_ids)?),
        },
        CalculatedExpressionV1::Binary {
            operator,
            left,
            right,
        } => CalculatedExpressionV1::Binary {
            operator: operator.clone(),
            left: Box::new(remap_expression(left, old_to_new_column_ids)?),
            right: Box::new(remap_expression(right, old_to_new_column_ids)?),
        },
        CalculatedExpressionV1::Comparison {
            operator,
            left,
            right,
        } => CalculatedExpressionV1::Comparison {
            operator: operator.clone(),
            left: Box::new(remap_expression(left, old_to_new_column_ids)?),
            right: Box::new(remap_expression(right, old_to_new_column_ids)?),
        },
        CalculatedExpressionV1::Logical {
            operator,
            left,
            right,
        } => CalculatedExpressionV1::Logical {
            operator: operator.clone(),
            left: Box::new(remap_expression(left, old_to_new_column_ids)?),
            right: Box::new(remap_expression(right, old_to_new_column_ids)?),
        },
        CalculatedExpressionV1::Function {
            function,
            arguments,
        } => CalculatedExpressionV1::Function {
            function: function.clone(),
            arguments: arguments
                .iter()
                .map(|argument| remap_expression(argument, old_to_new_column_ids))
                .collect::<Result<Vec<_>, _>>()?,
        },
    })
}

pub fn validate_definition_graph(
    definitions: &[CalculatedColumnDefinitionV1],
) -> Result<(), CalculatedColumnDiagnostic> {
    let mut by_output_id = HashMap::<String, &CalculatedColumnDefinitionV1>::new();
    for definition in definitions {
        if definition.formula_id.is_empty() {
            return Err(diagnostic_error(
                "missingFormulaId",
                "formula id cannot be empty",
                vec![definition.output_column_id.clone()],
            ));
        }
        if definition.output_column_id.is_empty() {
            return Err(diagnostic_error(
                "missingOutputColumnId",
                "output column id cannot be empty",
                vec![definition.formula_id.clone()],
            ));
        }
        if by_output_id
            .insert(definition.output_column_id.clone(), definition)
            .is_some()
        {
            return Err(diagnostic_error(
                "duplicateOutputColumnId",
                format!(
                    "duplicate calculated output column id {}",
                    definition.output_column_id
                ),
                vec![definition.output_column_id.clone()],
            ));
        }

        let expected_dependencies = expression_dependency_ids(&definition.expression);
        if expected_dependencies != definition.dependency_column_ids {
            return Err(diagnostic_error(
                "dependencyMismatch",
                format!(
                    "definition {} dependency ids do not match the expression",
                    definition.formula_id
                ),
                vec![definition.output_column_id.clone()],
            ));
        }

        let expected_fingerprint = definition_fingerprint(definition);
        if expected_fingerprint != definition.fingerprint {
            return Err(diagnostic_error(
                "fingerprintMismatch",
                format!(
                    "definition {} fingerprint does not match its canonical form",
                    definition.formula_id
                ),
                vec![definition.output_column_id.clone()],
            ));
        }
    }

    let mut visited = HashSet::<String>::new();
    let mut visiting = HashSet::<String>::new();
    let mut stack = Vec::<String>::new();

    for definition in definitions {
        visit_definition_graph(
            &definition.output_column_id,
            &by_output_id,
            &mut visited,
            &mut visiting,
            &mut stack,
        )?;
    }

    Ok(())
}

impl CalculatedBinaryOperatorV1 {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Subtract => "subtract",
            Self::Multiply => "multiply",
            Self::Divide => "divide",
        }
    }
}

impl CalculatedUnaryOperatorV1 {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Plus => "plus",
            Self::Minus => "minus",
            Self::Not => "not",
        }
    }
}

impl CalculatedComparisonOperatorV1 {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::NotEq => "notEq",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Gt => "gt",
            Self::Gte => "gte",
        }
    }
}

impl CalculatedFunctionV1 {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Abs => "abs",
            Self::Coalesce => "coalesce",
            Self::If => "if",
            Self::Max => "max",
            Self::Min => "min",
            Self::Round => "round",
        }
    }
}

impl CalculatedLogicalOperatorV1 {
    fn as_str(&self) -> &'static str {
        match self {
            Self::And => "and",
            Self::Or => "or",
        }
    }
}

impl CalculatedOutputTypeV1 {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Boolean => "boolean",
            Self::Continuous => "continuous",
            Self::Integer => "integer",
            Self::Null => "null",
            Self::Text => "text",
            Self::Unknown => "unknown",
        }
    }
}

fn visit_definition_graph(
    output_column_id: &str,
    by_output_id: &HashMap<String, &CalculatedColumnDefinitionV1>,
    visited: &mut HashSet<String>,
    visiting: &mut HashSet<String>,
    stack: &mut Vec<String>,
) -> Result<(), CalculatedColumnDiagnostic> {
    if visited.contains(output_column_id) {
        return Ok(());
    }
    if !visiting.insert(output_column_id.to_string()) {
        let cycle_start = stack
            .iter()
            .position(|id| id == output_column_id)
            .unwrap_or(0);
        let mut related_column_ids = stack[cycle_start..].to_vec();
        related_column_ids.push(output_column_id.to_string());
        return Err(diagnostic_error(
            "cyclicDependency",
            format!("calculated column cycle detected at {output_column_id}"),
            related_column_ids,
        ));
    }

    stack.push(output_column_id.to_string());
    if let Some(definition) = by_output_id.get(output_column_id) {
        for dependency_column_id in &definition.dependency_column_ids {
            if by_output_id.contains_key(dependency_column_id) {
                visit_definition_graph(
                    dependency_column_id,
                    by_output_id,
                    visited,
                    visiting,
                    stack,
                )?;
            }
        }
    }
    stack.pop();
    visiting.remove(output_column_id);
    visited.insert(output_column_id.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_definition() -> CalculatedColumnDefinitionV1 {
        let expression = CalculatedExpressionV1::Function {
            function: CalculatedFunctionV1::Coalesce,
            arguments: vec![
                CalculatedExpressionV1::ColumnRef {
                    column_id: "column-a".into(),
                },
                CalculatedExpressionV1::Binary {
                    operator: CalculatedBinaryOperatorV1::Add,
                    left: Box::new(CalculatedExpressionV1::ColumnRef {
                        column_id: "column-b".into(),
                    }),
                    right: Box::new(CalculatedExpressionV1::NumberLiteral {
                        value: CalculatedNumber::from(1),
                    }),
                },
            ],
        };
        let mut definition = CalculatedColumnDefinitionV1 {
            formula_id: "formula-a".into(),
            schema_version: "1".into(),
            output_column_id: "column-c".into(),
            expression,
            dependency_column_ids: vec!["column-a".into(), "column-b".into()],
            inferred_output_type: CalculatedOutputTypeV1::Continuous,
            fingerprint: String::new(),
        };
        definition.fingerprint = definition_fingerprint(&definition);
        definition
    }

    #[test]
    fn expression_dependency_ids_preserve_first_occurrence_order() {
        let expression = CalculatedExpressionV1::Function {
            function: CalculatedFunctionV1::Coalesce,
            arguments: vec![
                CalculatedExpressionV1::ColumnRef {
                    column_id: "column-a".into(),
                },
                CalculatedExpressionV1::Binary {
                    operator: CalculatedBinaryOperatorV1::Add,
                    left: Box::new(CalculatedExpressionV1::ColumnRef {
                        column_id: "column-b".into(),
                    }),
                    right: Box::new(CalculatedExpressionV1::ColumnRef {
                        column_id: "column-a".into(),
                    }),
                },
            ],
        };

        assert_eq!(
            expression_dependency_ids(&expression),
            vec!["column-a", "column-b"]
        );
    }

    #[test]
    fn definition_fingerprint_matches_sha256_of_canonical_formula_fields() {
        let definition = sample_definition();
        assert_eq!(
            definition_fingerprint(&definition),
            "6dca880d2e71e345040b861d9cb304712fc3754d2c49dc27e9dcef16f1a07a7e"
        );
        assert_eq!(definition_fingerprint(&definition).len(), 64);
        assert!(definition_fingerprint(&definition)
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
    }

    #[test]
    fn v1_surface_rejects_unsupported_binary_and_function_variants() {
        for value in ["modulo", "power", "concatenate"] {
            assert!(serde_json::from_value::<CalculatedBinaryOperatorV1>(json!(value)).is_err());
        }

        for value in [
            "average", "ceil", "count", "floor", "length", "lower", "sum", "upper",
        ] {
            assert!(serde_json::from_value::<CalculatedFunctionV1>(json!(value)).is_err());
        }
    }

    #[test]
    fn unknown_schema_archived_definition_deserializes_to_preserved_and_round_trips() {
        let archived_json = json!({
            "kind": "ready",
            "definition": {
                "formulaId": "formula-opaque",
                "schemaVersion": "99",
                "outputColumnId": "column-opaque",
                "expression": {
                    "kind": "futureAst",
                    "nodes": [{ "columnId": "column-source" }]
                },
                "dependencyColumnIds": ["column-wrong"],
                "inferredOutputType": "continuous",
                "fingerprint": "definitely-not-v1",
                "futureMetadata": {
                    "broken": true,
                    "unsupportedReason": "schema not installed"
                }
            }
        });

        let archived = serde_json::from_value::<ArchivedCalculatedColumn>(archived_json.clone())
            .expect("unknown schema definitions should remain readable");
        let ArchivedCalculatedColumn::Preserved { definition } = &archived else {
            panic!("expected unknown schema archive data to deserialize as preserved");
        };

        assert_eq!(definition.formula_id, "formula-opaque");
        assert_eq!(definition.schema_version, "99");
        assert_eq!(definition.output_column_id, "column-opaque");
        assert_eq!(definition.archived_definition, archived_json);
        assert_eq!(serde_json::to_value(&archived).unwrap(), archived_json);
    }

    #[test]
    fn archived_ready_state_round_trips_when_present() {
        let archived = ArchivedCalculatedColumn::Ready {
            definition: sample_definition(),
            state: ArchivedCalculatedColumnState {
                status: CalculatedColumnStatus::Broken,
                diagnostics: vec![CalculatedColumnDiagnostic {
                    level: CalculatedDiagnosticLevel::Error,
                    code: "missingDependencyColumns".to_string(),
                    message: "missing dependency columns".to_string(),
                    related_column_ids: vec!["column-b".to_string()],
                }],
            },
        };

        let value = serde_json::to_value(&archived).unwrap();
        assert_eq!(value["status"], json!("broken"));
        assert_eq!(
            value["diagnostics"][0]["relatedColumnIds"],
            json!(["column-b"])
        );
        assert_eq!(
            serde_json::from_value::<ArchivedCalculatedColumn>(value).unwrap(),
            archived
        );
    }

    #[test]
    fn archived_ready_state_deserializes_legacy_invalid_status_alias() {
        let value = json!({
            "kind": "ready",
            "definition": sample_definition(),
            "status": "invalid",
            "diagnostics": [
                {
                    "level": "error",
                    "code": "missingDependencyColumns",
                    "message": "missing dependency columns",
                    "relatedColumnIds": ["column-b"]
                }
            ]
        });

        let archived = serde_json::from_value::<ArchivedCalculatedColumn>(value)
            .expect("legacy invalid status alias should remain readable");
        let ArchivedCalculatedColumn::Ready { state, .. } = archived else {
            panic!("expected ready calculated archive state");
        };
        assert_eq!(state.status, CalculatedColumnStatus::Broken);
    }

    #[test]
    fn calculated_number_v1_serializes_with_exact_schema_version_1_shape() {
        let expression = CalculatedExpressionV1::NumberLiteral {
            value: CalculatedNumber::from(2),
        };

        assert_eq!(
            serde_json::to_value(&expression).unwrap(),
            json!({
                "kind": "numberLiteral",
                "value": 2
            })
        );
    }

    #[test]
    fn validation_and_mutation_result_json_use_optional_empty_arrays_and_honest_public_fields() {
        let definition = sample_definition();
        let warning_count = CalculatedColumnWarningCount::default();
        let validation = CalculatedColumnValidationResult {
            status: CalculatedColumnStatus::Ready,
            diagnostics: Vec::new(),
            warning_count: warning_count.clone(),
            definition: definition.clone(),
        };
        let validation_json = serde_json::to_value(&validation).unwrap();
        assert!(validation_json.get("diagnostics").is_none());

        let mutation = CalculatedColumnMutationResult {
            column_id: definition.output_column_id.clone(),
            dataset_generation: 8,
            change_set_id: "change-set-1".to_string(),
            calculated: None,
            diagnostics: Vec::new(),
            warning_count,
        };
        let mutation_json = serde_json::to_value(&mutation).unwrap();
        assert_eq!(mutation_json.get("columnId"), Some(&json!("column-c")));
        assert_eq!(mutation_json.get("datasetGeneration"), Some(&json!(8)));
        assert_eq!(
            mutation_json.get("changeSetId"),
            Some(&json!("change-set-1"))
        );
        assert_eq!(mutation_json.get("calculated"), None);
        assert!(mutation_json.get("diagnostics").is_none());

        let empty_related = CalculatedColumnDiagnostic {
            level: CalculatedDiagnosticLevel::Warning,
            code: "noRelated".into(),
            message: "no related ids".into(),
            related_column_ids: Vec::new(),
        };
        let empty_related_json = serde_json::to_value(&empty_related).unwrap();
        assert!(empty_related_json.get("relatedColumnIds").is_none());

        let populated_related = CalculatedColumnDiagnostic {
            level: CalculatedDiagnosticLevel::Error,
            code: "missingDependencyColumns".into(),
            message: "missing dependency columns".into(),
            related_column_ids: vec!["column-a".into()],
        };
        let populated_related_json = serde_json::to_value(&populated_related).unwrap();
        assert_eq!(
            populated_related_json.get("relatedColumnIds"),
            Some(&json!(["column-a"]))
        );
    }

    #[test]
    fn remap_definition_rewrites_ids_and_recomputes_fingerprint() {
        let definition = sample_definition();
        let remapped = remap_definition(
            &definition,
            "formula-b",
            "column-d",
            &HashMap::from([
                ("column-a".to_string(), "column-x".to_string()),
                ("column-b".to_string(), "column-y".to_string()),
                ("column-c".to_string(), "column-z".to_string()),
            ]),
        )
        .expect("expected remap to succeed");

        assert_eq!(remapped.formula_id, "formula-b");
        assert_eq!(remapped.output_column_id, "column-d");
        assert_eq!(remapped.dependency_column_ids, vec!["column-x", "column-y"]);
        assert_eq!(remapped.fingerprint, definition_fingerprint(&remapped));
    }

    #[test]
    fn remap_definition_rejects_missing_map_entries() {
        let definition = sample_definition();
        let error = remap_definition(
            &definition,
            "formula-b",
            "column-d",
            &HashMap::from([(String::from("column-a"), String::from("column-x"))]),
        )
        .expect_err("expected remap to fail");

        assert_eq!(error.code, "missingColumnIdMapEntry");
    }

    #[test]
    fn validate_definition_graph_rejects_direct_and_indirect_cycles() {
        let direct_cycle = CalculatedColumnDefinitionV1 {
            formula_id: "formula-self".into(),
            schema_version: "1".into(),
            output_column_id: "column-self".into(),
            expression: CalculatedExpressionV1::ColumnRef {
                column_id: "column-self".into(),
            },
            dependency_column_ids: vec!["column-self".into()],
            inferred_output_type: CalculatedOutputTypeV1::Continuous,
            fingerprint: String::new(),
        };
        let mut direct_cycle = direct_cycle;
        direct_cycle.fingerprint = definition_fingerprint(&direct_cycle);

        let direct_error = validate_definition_graph(&[direct_cycle]).expect_err("expected cycle");
        assert_eq!(direct_error.code, "cyclicDependency");

        let indirect_a = CalculatedColumnDefinitionV1 {
            formula_id: "formula-a2".into(),
            schema_version: "1".into(),
            output_column_id: "column-a2".into(),
            expression: CalculatedExpressionV1::ColumnRef {
                column_id: "column-b2".into(),
            },
            dependency_column_ids: vec!["column-b2".into()],
            inferred_output_type: CalculatedOutputTypeV1::Continuous,
            fingerprint: String::new(),
        };
        let mut indirect_a = indirect_a;
        indirect_a.fingerprint = definition_fingerprint(&indirect_a);

        let indirect_b = CalculatedColumnDefinitionV1 {
            formula_id: "formula-b2".into(),
            schema_version: "1".into(),
            output_column_id: "column-b2".into(),
            expression: CalculatedExpressionV1::ColumnRef {
                column_id: "column-a2".into(),
            },
            dependency_column_ids: vec!["column-a2".into()],
            inferred_output_type: CalculatedOutputTypeV1::Continuous,
            fingerprint: String::new(),
        };
        let mut indirect_b = indirect_b;
        indirect_b.fingerprint = definition_fingerprint(&indirect_b);

        let indirect_error =
            validate_definition_graph(&[indirect_a, indirect_b]).expect_err("expected cycle");
        assert_eq!(indirect_error.code, "cyclicDependency");
    }

    #[test]
    fn finite_float_rejects_non_finite_values() {
        assert!(FiniteF64::try_new(f64::NAN).is_err());
        assert!(FiniteF64::try_new(f64::INFINITY).is_err());
    }
}

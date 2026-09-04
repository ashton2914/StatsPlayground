use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use duckdb::params_from_iter;
use duckdb::types::{TimeUnit, Value};

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::distribution::{
    CapabilityOverrideEnvelopeV1, DistributionColumnRefV1, DistributionGroupValueV1,
    DistributionModeV1, DistributionModelingTypeV1, DistributionRequest, DistributionRequestV1,
    FilterExprV1, ObservationContributionPolicyV1, ResourceBudgetV1,
};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreparedObservationV1 {
    pub row_id: i64,
    pub y: f64,
    pub weight: f64,
    pub frequency: u64,
    pub contribution: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreparedGroupV1 {
    pub key: Vec<DistributionGroupValueV1>,
    pub observations: Vec<PreparedObservationV1>,
    pub source_rows: u64,
    pub n_missing: u64,
    pub excluded_rows: u64,
}

#[derive(Clone)]
struct GroupKey(Vec<DistributionGroupValueV1>);

pub(crate) fn resolve_distribution_requests(
    engine: &DuckDbEngine,
    request: &DistributionRequest,
) -> Result<Vec<DistributionRequestV1>, AppError> {
    validate_wire_request(request)?;
    if engine.get_dataset_generation(&request.dataset_id)? != request.generation {
        return Err(AppError::InvalidParam(
            "distribution.run.staleGeneration".to_string(),
        ));
    }

    let user_columns = engine
        .get_user_columns(&request.dataset_id)?
        .into_iter()
        .collect::<HashMap<_, _>>();
    let descriptors = engine
        .get_distribution_columns(&request.dataset_id)?
        .into_iter()
        .map(|column| (column.name.clone(), column))
        .collect::<HashMap<_, _>>();
    for name in request
        .response_columns
        .iter()
        .chain(request.weight_column.iter())
        .chain(request.freq_column.iter())
        .chain(request.by_columns.iter())
    {
        if !user_columns.contains_key(name) || !descriptors.contains_key(name) {
            return Err(AppError::InvalidParam(
                "distribution.config.columnUnknown".to_string(),
            ));
        }
    }
    for name in &request.response_columns {
        if !is_numeric_sql_type(user_columns.get(name).map(String::as_str)) {
            return Err(AppError::InvalidParam(
                "distribution.config.numericTypeRequired".to_string(),
            ));
        }
    }
    if let Some(name) = &request.weight_column {
        if !is_numeric_sql_type(user_columns.get(name).map(String::as_str)) {
            return Err(AppError::InvalidParam(
                "distribution.config.weightInvalid".to_string(),
            ));
        }
    }
    if let Some(name) = &request.freq_column {
        if !is_integer_sql_type(user_columns.get(name).map(String::as_str)) {
            return Err(AppError::InvalidParam(
                "distribution.config.frequencyInvalid".to_string(),
            ));
        }
    }

    let column_id = |name: &str| {
        descriptors
            .get(name)
            .map(|column| column.column_id.clone())
            .ok_or_else(|| AppError::InvalidParam("distribution.config.columnUnknown".to_string()))
    };
    let weight_column_id = request
        .weight_column
        .as_deref()
        .map(&column_id)
        .transpose()?;
    let frequency_column_id = request.freq_column.as_deref().map(&column_id).transpose()?;
    let by_column_ids = request
        .by_columns
        .iter()
        .map(|name| column_id(name))
        .collect::<Result<Vec<_>, _>>()?;

    request
        .response_columns
        .iter()
        .map(|response_name| {
            let capability_overrides = request
                .spec_limits
                .get(response_name)
                .map(|limits| {
                    serde_json::to_value(limits)
                        .map(|payload| {
                            vec![CapabilityOverrideEnvelopeV1 {
                                schema_version: "1".to_string(),
                                capability_id: "capability.normal.individuals".to_string(),
                                payload_schema_version: "1".to_string(),
                                payload,
                            }]
                        })
                        .map_err(|error| AppError::InvalidParam(error.to_string()))
                })
                .transpose()?
                .unwrap_or_default();
            Ok(DistributionRequestV1 {
                schema_version: "1".to_string(),
                analysis_id: "distribution-report".to_string(),
                config_revision: 1,
                source_dataset_id: Some(request.dataset_id.clone()),
                source_data_version: Some(request.generation.to_string()),
                mode: DistributionModeV1::Continuous,
                y_columns: vec![DistributionColumnRefV1 {
                    column_id: column_id(response_name)?,
                    modeling_type: DistributionModelingTypeV1::Continuous,
                }],
                weight_column_id: weight_column_id.clone(),
                frequency_column_id: frequency_column_id.clone(),
                by_column_ids: by_column_ids.clone(),
                filter_expr: FilterExprV1::And { exprs: Vec::new() },
                confidence_level: request.confidence_level,
                histograms_only: false,
                continuous_fit: crate::models::distribution::DistributionContinuousFitConfigV1 {
                    enabled_distribution_ids: request.fit_distributions.clone(),
                    fit_all: false,
                    diagnostics: Default::default(),
                },
                visual_diagnostics: Default::default(),
                enabled_capability_ids: vec!["capability.normal.individuals".to_string()],
                capability_overrides,
                observation_policy: ObservationContributionPolicyV1::strict_v1()?,
                resource_budget: ResourceBudgetV1::default(),
                exact: true,
            })
        })
        .collect()
}

fn validate_wire_request(request: &DistributionRequest) -> Result<(), AppError> {
    use std::collections::HashSet;

    if request.dataset_id.trim().is_empty() || request.response_columns.is_empty() {
        return Err(AppError::InvalidParam(
            "distribution.config.responseRequired".to_string(),
        ));
    }
    if !request.confidence_level.is_finite()
        || request.confidence_level <= 0.0
        || request.confidence_level >= 1.0
    {
        return Err(AppError::InvalidParam(
            "distribution.config.confidenceOutOfRange".to_string(),
        ));
    }
    let mut names = HashSet::new();
    for name in request
        .response_columns
        .iter()
        .chain(request.weight_column.iter())
        .chain(request.freq_column.iter())
        .chain(request.by_columns.iter())
    {
        if name.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "distribution.config.columnRequired".to_string(),
            ));
        }
        if !names.insert(name) {
            return Err(AppError::InvalidParam(
                "distribution.config.roleCollision".to_string(),
            ));
        }
    }
    let response_names = request.response_columns.iter().collect::<HashSet<_>>();
    if request
        .spec_limits
        .keys()
        .any(|name| !response_names.contains(name))
    {
        return Err(AppError::InvalidParam(
            "distribution.config.specColumnUnknown".to_string(),
        ));
    }
    for limits in request.spec_limits.values() {
        let values = [limits.lsl, limits.target, limits.usl];
        if values.into_iter().flatten().any(|value| !value.is_finite())
            || limits
                .lsl
                .zip(limits.usl)
                .is_some_and(|(lsl, usl)| lsl >= usl)
            || limits
                .lsl
                .zip(limits.target)
                .is_some_and(|(lsl, target)| target < lsl)
            || limits
                .target
                .zip(limits.usl)
                .is_some_and(|(target, usl)| target > usl)
        {
            return Err(AppError::InvalidParam(
                "capability.invalidOverride.v1".to_string(),
            ));
        }
    }
    let mut fits = Vec::new();
    for kind in &request.fit_distributions {
        if fits.contains(&kind) {
            return Err(AppError::InvalidParam(
                "distribution.config.fitDuplicate".to_string(),
            ));
        }
        fits.push(kind);
    }
    Ok(())
}

fn is_numeric_sql_type(sql_type: Option<&str>) -> bool {
    sql_type.is_some_and(|value| {
        let normalized = value.to_ascii_uppercase();
        [
            "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "FLOAT", "REAL", "DOUBLE", "DECIMAL",
            "NUMERIC",
        ]
        .iter()
        .any(|kind| normalized.starts_with(kind))
    })
}

fn is_integer_sql_type(sql_type: Option<&str>) -> bool {
    sql_type.is_some_and(|value| {
        matches!(
            value.to_ascii_uppercase().as_str(),
            "TINYINT"
                | "SMALLINT"
                | "INTEGER"
                | "BIGINT"
                | "UTINYINT"
                | "USMALLINT"
                | "UINTEGER"
                | "UBIGINT"
        )
    })
}

impl PartialEq for GroupKey {
    fn eq(&self, other: &Self) -> bool {
        compare_group_keys(&self.0, &other.0) == Ordering::Equal
    }
}

impl Eq for GroupKey {}

impl PartialOrd for GroupKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for GroupKey {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_group_keys(&self.0, &other.0)
    }
}

pub(crate) fn prepare_continuous_groups(
    engine: &DuckDbEngine,
    request: &DistributionRequestV1,
    y: &DistributionColumnRefV1,
) -> Result<Vec<PreparedGroupV1>, AppError> {
    let dataset_id = request
        .source_dataset_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidParam("distribution.run.sourceRequired".to_string()))?;
    let metadata = engine
        .get_distribution_columns(dataset_id)?
        .into_iter()
        .map(|column| (column.column_id, column.name))
        .collect::<HashMap<_, _>>();

    let y_name = resolve_column(&metadata, &y.column_id)?;
    let weight_name = request
        .weight_column_id
        .as_deref()
        .map(|column_id| resolve_column(&metadata, column_id))
        .transpose()?;
    let frequency_name = request
        .frequency_column_id
        .as_deref()
        .map(|column_id| resolve_column(&metadata, column_id))
        .transpose()?;
    let by_names = request
        .by_column_ids
        .iter()
        .map(|column_id| resolve_column(&metadata, column_id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut filter_params = Vec::new();
    let filter_sql = compile_filter(&request.filter_expr, &metadata, &mut filter_params)?;

    let mut select_columns = vec!["\"_row_id\"".to_string(), quote_identifier(y_name)];
    if let Some(column) = weight_name {
        select_columns.push(quote_identifier(column));
    }
    if let Some(column) = frequency_name {
        select_columns.push(quote_identifier(column));
    }
    select_columns.extend(by_names.iter().map(|column| quote_identifier(column)));
    let table_name = quote_identifier(&format!("dataset_{}", dataset_id.replace('-', "_")));
    let sql = format!(
        "SELECT {} FROM {} WHERE {} ORDER BY \"_row_id\" ASC",
        select_columns.join(", "),
        table_name,
        filter_sql,
    );
    let mut statement = engine.conn().prepare(&sql)?;
    let column_count = select_columns.len();
    let mut rows = statement.query(params_from_iter(filter_params.iter()))?;
    let mut groups = BTreeMap::<GroupKey, PreparedGroupV1>::new();
    let mut total_rows = 0_u64;
    let mut estimated_bytes = 0_u64;

    while let Some(row) = rows.next()? {
        total_rows = total_rows
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))?;
        if total_rows > request.resource_budget.max_total_rows {
            return Err(AppError::InvalidParam(
                "distribution.run.budgetExceeded".to_string(),
            ));
        }
        let row_id = value_to_i64(row.get::<_, Value>(0)?)?;
        let y_value = row.get::<_, Value>(1)?;
        let mut offset = 2;
        let weight_value = if weight_name.is_some() {
            let value = row.get::<_, Value>(offset)?;
            offset += 1;
            Some(value)
        } else {
            None
        };
        let frequency_value = if frequency_name.is_some() {
            let value = row.get::<_, Value>(offset)?;
            offset += 1;
            Some(value)
        } else {
            None
        };
        let key = (offset..column_count)
            .map(|index| value_to_group(row.get::<_, Value>(index)?))
            .collect::<Result<Vec<_>, AppError>>()?;
        let group_key = GroupKey(key.clone());
        if !groups.contains_key(&group_key)
            && groups.len() as u64 >= request.resource_budget.max_groups
        {
            return Err(AppError::InvalidParam(
                "distribution.run.budgetExceeded".to_string(),
            ));
        }
        if !groups.contains_key(&group_key) {
            add_estimated_bytes(
                &mut estimated_bytes,
                estimated_group_bytes(&key)?,
                request.resource_budget.max_total_bytes,
            )?;
        }
        let group = groups.entry(group_key).or_insert_with(|| PreparedGroupV1 {
            key,
            observations: Vec::new(),
            source_rows: 0,
            n_missing: 0,
            excluded_rows: 0,
        });
        if group.source_rows >= request.resource_budget.max_rows_per_group {
            return Err(AppError::InvalidParam(
                "distribution.run.budgetExceeded".to_string(),
            ));
        }
        group.source_rows += 1;
        add_estimated_bytes(
            &mut estimated_bytes,
            8,
            request.resource_budget.max_total_bytes,
        )?;
        let weight = optional_positive_f64(weight_value, 1.0)?;
        let frequency = optional_frequency(frequency_value, 1)?;
        let Some(y_number) = optional_f64(y_value)? else {
            group.n_missing += 1;
            continue;
        };
        let Some(weight) = weight else {
            group.excluded_rows += 1;
            continue;
        };
        let Some(frequency) = frequency else {
            group.excluded_rows += 1;
            continue;
        };
        let contribution = weight * frequency as f64;
        if !contribution.is_finite() {
            return Err(AppError::InvalidParam(
                "distribution.config.weightFrequencyInvalid".to_string(),
            ));
        }
        if group.observations.len() as u64 >= request.resource_budget.max_rows_per_group {
            return Err(AppError::InvalidParam(
                "distribution.run.budgetExceeded".to_string(),
            ));
        }
        group.observations.push(PreparedObservationV1 {
            row_id,
            y: y_number,
            weight,
            frequency,
            contribution,
        });
        add_estimated_bytes(
            &mut estimated_bytes,
            std::mem::size_of::<PreparedObservationV1>() as u64,
            request.resource_budget.max_total_bytes,
        )?;
    }

    Ok(groups.into_values().collect())
}

fn resolve_column<'a>(
    metadata: &'a HashMap<String, String>,
    column_id: &str,
) -> Result<&'a str, AppError> {
    metadata
        .get_key_value(column_id)
        .map(|(_, name)| name.as_str())
        .ok_or_else(|| AppError::InvalidParam("distribution.config.columnUnknown".to_string()))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn value_to_i64(value: Value) -> Result<i64, AppError> {
    match value {
        Value::TinyInt(value) => Ok(i64::from(value)),
        Value::SmallInt(value) => Ok(i64::from(value)),
        Value::Int(value) => Ok(i64::from(value)),
        Value::BigInt(value) => Ok(value),
        _ => Err(AppError::Database("invalid row ID type".to_string())),
    }
}

fn optional_f64(value: Value) -> Result<Option<f64>, AppError> {
    let number = match value {
        Value::Null => return Ok(None),
        Value::TinyInt(value) => f64::from(value),
        Value::SmallInt(value) => f64::from(value),
        Value::Int(value) => f64::from(value),
        Value::BigInt(value) => value as f64,
        Value::Float(value) => f64::from(value),
        Value::Double(value) => value,
        _ => {
            return Err(AppError::InvalidParam(
                "distribution.config.numericTypeRequired".to_string(),
            ))
        }
    };
    Ok(number.is_finite().then_some(number))
}

fn optional_positive_f64(value: Option<Value>, default: f64) -> Result<Option<f64>, AppError> {
    let Some(value) = value else {
        return Ok(Some(default));
    };
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    let number = required_finite_f64(value, "distribution.config.weightInvalid")?;
    if number < 0.0 {
        return Err(AppError::InvalidParam(
            "distribution.config.weightInvalid".to_string(),
        ));
    }
    Ok((number > 0.0).then_some(number))
}

fn optional_frequency(value: Option<Value>, default: u64) -> Result<Option<u64>, AppError> {
    let Some(value) = value else {
        return Ok(Some(default));
    };
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    let number = required_finite_f64(value, "distribution.config.frequencyInvalid")?;
    if number < 0.0 || number.fract() != 0.0 || number > u64::MAX as f64 {
        return Err(AppError::InvalidParam(
            "distribution.config.frequencyInvalid".to_string(),
        ));
    }
    let frequency = number as u64;
    Ok((frequency > 0).then_some(frequency))
}

fn value_to_group(value: Value) -> Result<DistributionGroupValueV1, AppError> {
    match value {
        Value::Null => Ok(DistributionGroupValueV1::Missing),
        Value::Boolean(value) => Ok(DistributionGroupValueV1::Boolean { value }),
        Value::Text(value) => Ok(DistributionGroupValueV1::Text { value }),
        Value::Date32(days) => Ok(DistributionGroupValueV1::DateTime {
            utc_millis: i64::from(days) * 86_400_000,
        }),
        Value::Timestamp(unit, value) => Ok(DistributionGroupValueV1::DateTime {
            utc_millis: timestamp_to_millis(unit, value)?,
        }),
        value => optional_f64(value)?
            .map(|value| DistributionGroupValueV1::Number { value })
            .ok_or_else(|| {
                AppError::InvalidParam("distribution.config.byValueInvalid".to_string())
            }),
    }
}

fn required_finite_f64(value: Value, code: &str) -> Result<f64, AppError> {
    let number = match value {
        Value::TinyInt(value) => f64::from(value),
        Value::SmallInt(value) => f64::from(value),
        Value::Int(value) => f64::from(value),
        Value::BigInt(value) => value as f64,
        Value::Float(value) => f64::from(value),
        Value::Double(value) => value,
        _ => return Err(AppError::InvalidParam(code.to_string())),
    };
    if !number.is_finite() {
        return Err(AppError::InvalidParam(code.to_string()));
    }
    Ok(number)
}

fn timestamp_to_millis(unit: TimeUnit, value: i64) -> Result<i64, AppError> {
    match unit {
        TimeUnit::Second => value.checked_mul(1_000),
        TimeUnit::Millisecond => Some(value),
        TimeUnit::Microsecond => Some(value.div_euclid(1_000)),
        TimeUnit::Nanosecond => Some(value.div_euclid(1_000_000)),
    }
    .ok_or_else(|| AppError::InvalidParam("distribution.config.byValueInvalid".to_string()))
}

fn add_estimated_bytes(current: &mut u64, additional: u64, maximum: u64) -> Result<(), AppError> {
    *current = current
        .checked_add(additional)
        .ok_or_else(|| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))?;
    if *current > maximum {
        return Err(AppError::InvalidParam(
            "distribution.run.budgetExceeded".to_string(),
        ));
    }
    Ok(())
}

fn estimated_group_bytes(key: &[DistributionGroupValueV1]) -> Result<u64, AppError> {
    let fixed = std::mem::size_of::<PreparedGroupV1>()
        .checked_add(std::mem::size_of_val(key))
        .ok_or_else(|| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))?;
    let text_bytes = key
        .iter()
        .try_fold(0_usize, |total, value| {
            total.checked_add(match value {
                DistributionGroupValueV1::Text { value } => value.len(),
                _ => 0,
            })
        })
        .ok_or_else(|| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))?;
    u64::try_from(
        fixed
            .checked_add(text_bytes)
            .ok_or_else(|| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))?,
    )
    .map_err(|_| AppError::InvalidParam("distribution.run.budgetExceeded".to_string()))
}

fn compare_group_keys(
    left: &[DistributionGroupValueV1],
    right: &[DistributionGroupValueV1],
) -> Ordering {
    for (left_value, right_value) in left.iter().zip(right) {
        let ordering = match (left_value, right_value) {
            (DistributionGroupValueV1::Missing, DistributionGroupValueV1::Missing) => {
                Ordering::Equal
            }
            (DistributionGroupValueV1::Missing, _) => Ordering::Greater,
            (_, DistributionGroupValueV1::Missing) => Ordering::Less,
            (
                DistributionGroupValueV1::Boolean { value: left },
                DistributionGroupValueV1::Boolean { value: right },
            ) => left.cmp(right),
            (
                DistributionGroupValueV1::Number { value: left },
                DistributionGroupValueV1::Number { value: right },
            ) => left.total_cmp(right),
            (
                DistributionGroupValueV1::Text { value: left },
                DistributionGroupValueV1::Text { value: right },
            ) => left.cmp(right),
            (
                DistributionGroupValueV1::DateTime { utc_millis: left },
                DistributionGroupValueV1::DateTime { utc_millis: right },
            ) => left.cmp(right),
            (left, right) => group_value_rank(left).cmp(&group_value_rank(right)),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn group_value_rank(value: &DistributionGroupValueV1) -> u8 {
    match value {
        DistributionGroupValueV1::Boolean { .. } => 0,
        DistributionGroupValueV1::Number { .. } => 1,
        DistributionGroupValueV1::Text { .. } => 2,
        DistributionGroupValueV1::DateTime { .. } => 3,
        DistributionGroupValueV1::Missing => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::duckdb_engine::DuckDbEngine;
    use crate::models::distribution::{
        DistributionColumnRefV1, DistributionGroupValueV1, DistributionModeV1,
        DistributionModelingTypeV1, DistributionRequestV1, FilterExprV1,
        ObservationContributionPolicyV1, ResourceBudgetV1,
    };

    fn fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .create_empty_table(
                "distribution_fixture",
                "Distribution Fixture",
                &[
                    "y".to_string(),
                    "weight".to_string(),
                    "freq".to_string(),
                    "region".to_string(),
                    "batch".to_string(),
                ],
                &[
                    "DOUBLE".to_string(),
                    "DOUBLE".to_string(),
                    "INTEGER".to_string(),
                    "VARCHAR".to_string(),
                    "INTEGER".to_string(),
                ],
            )
            .expect("fixture table");
        engine
    }

    fn column_id(engine: &DuckDbEngine, name: &str) -> String {
        engine
            .get_distribution_columns("distribution_fixture")
            .expect("column descriptors")
            .into_iter()
            .find(|column| column.name == name)
            .unwrap_or_else(|| panic!("missing column {name}"))
            .column_id
    }

    fn wire_request(engine: &DuckDbEngine) -> DistributionRequest {
        DistributionRequest {
            dataset_id: "distribution_fixture".to_string(),
            generation: engine
                .get_dataset_generation("distribution_fixture")
                .expect("fixture generation"),
            response_columns: vec!["y".to_string()],
            weight_column: Some("weight".to_string()),
            freq_column: Some("freq".to_string()),
            by_columns: vec!["region".to_string(), "batch".to_string()],
            confidence_level: 0.95,
            spec_limits: HashMap::new(),
            fit_distributions: Vec::new(),
        }
    }

    fn assert_invalid_code(result: Result<Vec<DistributionRequestV1>, AppError>, expected: &str) {
        assert!(matches!(result, Err(AppError::InvalidParam(code)) if code == expected));
    }

    #[test]
    fn resolve_rejects_stale_generation() {
        let engine = fixture_engine();
        let mut request = wire_request(&engine);
        request.generation = request.generation.saturating_add(1);

        assert_invalid_code(
            resolve_distribution_requests(&engine, &request),
            "distribution.run.staleGeneration",
        );
    }

    #[test]
    fn resolve_rejects_unknown_and_injection_like_column_names() {
        let engine = fixture_engine();
        for name in ["unknown", "y; DROP TABLE distribution_fixture"] {
            let mut request = wire_request(&engine);
            request.response_columns = vec![name.to_string()];
            assert_invalid_code(
                resolve_distribution_requests(&engine, &request),
                "distribution.config.columnUnknown",
            );
        }
    }

    #[test]
    fn resolve_rejects_duplicate_or_colliding_roles() {
        let engine = fixture_engine();
        let mut duplicate = wire_request(&engine);
        duplicate.by_columns = vec!["region".to_string(), "region".to_string()];
        assert_invalid_code(
            resolve_distribution_requests(&engine, &duplicate),
            "distribution.config.roleCollision",
        );

        let mut collision = wire_request(&engine);
        collision.weight_column = Some("y".to_string());
        assert_invalid_code(
            resolve_distribution_requests(&engine, &collision),
            "distribution.config.roleCollision",
        );
    }

    #[test]
    fn resolve_rejects_invalid_confidence_specs_and_duplicate_fits() {
        let engine = fixture_engine();
        let mut invalid_confidence = wire_request(&engine);
        invalid_confidence.confidence_level = f64::NAN;
        assert_invalid_code(
            resolve_distribution_requests(&engine, &invalid_confidence),
            "distribution.config.confidenceOutOfRange",
        );

        let mut invalid_spec = wire_request(&engine);
        invalid_spec.spec_limits.insert(
            "y".to_string(),
            crate::models::distribution::SpecLimitsOverride {
                lsl: Some(5.0),
                target: Some(f64::INFINITY),
                usl: Some(4.0),
            },
        );
        assert_invalid_code(
            resolve_distribution_requests(&engine, &invalid_spec),
            "capability.invalidOverride.v1",
        );

        let mut duplicate_fit = wire_request(&engine);
        duplicate_fit.fit_distributions = vec![
            crate::models::distribution::ContinuousDistributionIdV1::Normal,
            crate::models::distribution::ContinuousDistributionIdV1::Normal,
        ];
        assert_invalid_code(
            resolve_distribution_requests(&engine, &duplicate_fit),
            "distribution.config.fitDuplicate",
        );
    }

    #[test]
    fn resolve_maps_names_to_stable_ids_and_preserves_by_order() {
        let engine = fixture_engine();
        let request = wire_request(&engine);
        let resolved = resolve_distribution_requests(&engine, &request).expect("resolve request");

        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].y_columns[0].column_id, column_id(&engine, "y"));
        assert_eq!(
            resolved[0].weight_column_id,
            Some(column_id(&engine, "weight"))
        );
        assert_eq!(
            resolved[0].frequency_column_id,
            Some(column_id(&engine, "freq"))
        );
        assert_eq!(
            resolved[0].by_column_ids,
            vec![column_id(&engine, "region"), column_id(&engine, "batch")]
        );
    }

    fn request(engine: &DuckDbEngine) -> DistributionRequestV1 {
        DistributionRequestV1 {
            schema_version: "1".to_string(),
            analysis_id: "analysis-1".to_string(),
            config_revision: 1,
            source_dataset_id: Some("distribution_fixture".to_string()),
            source_data_version: None,
            mode: DistributionModeV1::Continuous,
            y_columns: vec![DistributionColumnRefV1 {
                column_id: column_id(engine, "y"),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: Some(column_id(engine, "weight")),
            frequency_column_id: Some(column_id(engine, "freq")),
            by_column_ids: Vec::new(),
            filter_expr: FilterExprV1::And { exprs: Vec::new() },
            confidence_level: 0.95,
            histograms_only: false,
            continuous_fit: crate::models::distribution::DistributionContinuousFitConfigV1::default(
            ),
            visual_diagnostics:
                crate::models::distribution::DistributionVisualDiagnosticsConfigV1::default(),
            enabled_capability_ids: Vec::new(),
            capability_overrides: Vec::new(),
            observation_policy: ObservationContributionPolicyV1::strict_v1()
                .expect("observation policy"),
            resource_budget: ResourceBudgetV1::default(),
            exact: true,
        }
    }

    fn y_column(request: &DistributionRequestV1) -> DistributionColumnRefV1 {
        request.y_columns[0].clone()
    }

    #[test]
    fn materializes_weight_times_frequency_without_expansion() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute(
                "INSERT INTO dataset_distribution_fixture VALUES (1, 10.0, 2.5, 3, 'East', 1)",
                [],
            )
            .expect("seed row");

        let request = request(&engine);
        let groups = prepare_continuous_groups(&engine, &request, &y_column(&request))
            .expect("prepare groups");

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].observations.len(), 1);
        let observation = &groups[0].observations[0];
        assert_eq!(observation.row_id, 1);
        assert_eq!(observation.weight, 2.5);
        assert_eq!(observation.frequency, 3);
        assert_eq!(observation.contribution, 7.5);
    }

    #[test]
    fn missing_y_is_counted_and_not_materialized() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute_batch(
                "INSERT INTO dataset_distribution_fixture VALUES
                    (1, 10.0, 1.0, 1, 'East', 1),
                    (2, NULL, 1.0, 1, 'East', 1);",
            )
            .expect("seed rows");

        let request = request(&engine);
        let groups = prepare_continuous_groups(&engine, &request, &y_column(&request))
            .expect("prepare groups");

        assert_eq!(groups[0].source_rows, 2);
        assert_eq!(groups[0].n_missing, 1);
        assert_eq!(groups[0].observations.len(), 1);
    }

    #[test]
    fn multiple_by_keys_are_sorted_with_missing_last() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute_batch(
                "INSERT INTO dataset_distribution_fixture VALUES
                    (3, 30.0, 1.0, 1, NULL, 2),
                    (1, 10.0, 1.0, 1, 'East', 2),
                    (2, 20.0, 1.0, 1, 'East', 1);",
            )
            .expect("seed rows");
        let mut grouped_request = request(&engine);
        grouped_request.by_column_ids =
            vec![column_id(&engine, "region"), column_id(&engine, "batch")];

        let groups =
            prepare_continuous_groups(&engine, &grouped_request, &y_column(&grouped_request))
                .expect("prepare groups");

        assert_eq!(groups.len(), 3);
        assert_eq!(
            groups
                .iter()
                .map(|group| group.key.clone())
                .collect::<Vec<_>>(),
            vec![
                vec![
                    DistributionGroupValueV1::Text {
                        value: "East".to_string()
                    },
                    DistributionGroupValueV1::Number { value: 1.0 },
                ],
                vec![
                    DistributionGroupValueV1::Text {
                        value: "East".to_string()
                    },
                    DistributionGroupValueV1::Number { value: 2.0 },
                ],
                vec![
                    DistributionGroupValueV1::Missing,
                    DistributionGroupValueV1::Number { value: 2.0 },
                ],
            ],
        );
    }

    #[test]
    fn filter_expr_limits_rows_and_rejects_unknown_fields() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute_batch(
                "INSERT INTO dataset_distribution_fixture VALUES
                    (1, 10.0, 1.0, 1, 'East', 1),
                    (2, 20.0, 1.0, 1, 'West', 1);",
            )
            .expect("seed rows");
        let mut filtered = request(&engine);
        filtered.filter_expr = FilterExprV1::CategorySet {
            field_id: column_id(&engine, "region"),
            values: vec!["East".to_string()],
            negate: false,
        };

        let groups = prepare_continuous_groups(&engine, &filtered, &y_column(&filtered))
            .expect("filtered groups");
        assert_eq!(groups[0].source_rows, 1);
        assert_eq!(groups[0].observations[0].row_id, 1);

        filtered.filter_expr = FilterExprV1::IsNull {
            field_id: "unknown".to_string(),
            negate: false,
        };
        assert!(matches!(
            prepare_continuous_groups(&engine, &filtered, &y_column(&filtered)),
            Err(AppError::InvalidParam(code)) if code == "distribution.config.columnUnknown"
        ));
    }

    #[test]
    fn zero_values_exclude_and_invalid_weight_or_frequency_fails() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute_batch(
                "INSERT INTO dataset_distribution_fixture VALUES
                    (1, 10.0, 0.0, 1, 'East', 1),
                    (2, 20.0, 1.0, 0, 'East', 1),
                    (3, 30.0, 1.0, 1, 'East', 1);",
            )
            .expect("seed rows");
        let request = request(&engine);
        let groups =
            prepare_continuous_groups(&engine, &request, &y_column(&request)).expect("groups");
        assert_eq!(groups[0].excluded_rows, 2);
        assert_eq!(groups[0].observations.len(), 1);

        engine
            .conn()
            .execute(
                "INSERT INTO dataset_distribution_fixture VALUES (4, 40.0, -1.0, 1, 'East', 1)",
                [],
            )
            .expect("invalid weight row");
        assert!(matches!(
            prepare_continuous_groups(&engine, &request, &y_column(&request)),
            Err(AppError::InvalidParam(code)) if code == "distribution.config.weightInvalid"
        ));
    }

    #[test]
    fn resource_budgets_reject_before_returning_partial_groups() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute_batch(
                "INSERT INTO dataset_distribution_fixture VALUES
                    (1, 10.0, 1.0, 1, 'East', 1),
                    (2, 20.0, 1.0, 1, 'West', 1);",
            )
            .expect("seed rows");
        let mut limited = request(&engine);
        limited.by_column_ids = vec![column_id(&engine, "region")];
        limited.resource_budget.max_groups = 1;

        assert!(matches!(
            prepare_continuous_groups(&engine, &limited, &y_column(&limited)),
            Err(AppError::InvalidParam(code)) if code == "distribution.run.budgetExceeded"
        ));

        limited.resource_budget.max_groups = 10;
        limited.resource_budget.max_rows_per_group = 1;
        limited.by_column_ids.clear();
        assert!(matches!(
            prepare_continuous_groups(&engine, &limited, &y_column(&limited)),
            Err(AppError::InvalidParam(code)) if code == "distribution.run.budgetExceeded"
        ));

        limited.resource_budget.max_rows_per_group = 10;
        limited.resource_budget.max_total_bytes = 1;
        assert!(matches!(
            prepare_continuous_groups(&engine, &limited, &y_column(&limited)),
            Err(AppError::InvalidParam(code)) if code == "distribution.run.budgetExceeded"
        ));
    }

    #[test]
    fn non_finite_weight_is_a_global_error() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute(
                "INSERT INTO dataset_distribution_fixture VALUES (1, 10.0, 'NaN'::DOUBLE, 1, 'East', 1)",
                [],
            )
            .expect("seed non-finite weight");

        assert!(matches!(
            prepare_continuous_groups(&engine, &request(&engine), &y_column(&request(&engine))),
            Err(AppError::InvalidParam(code)) if code == "distribution.config.weightInvalid"
        ));

        let missing_y_engine = fixture_engine();
        missing_y_engine
            .conn()
            .execute(
                "INSERT INTO dataset_distribution_fixture VALUES (1, NULL, -1.0, 1, 'East', 1)",
                [],
            )
            .expect("seed missing Y with invalid weight");
        assert!(matches!(
            prepare_continuous_groups(
                &missing_y_engine,
                &request(&missing_y_engine),
                &y_column(&request(&missing_y_engine)),
            ),
            Err(AppError::InvalidParam(code)) if code == "distribution.config.weightInvalid"
        ));
    }

    #[test]
    fn by_values_preserve_boolean_and_datetime_types() {
        assert_eq!(
            value_to_group(Value::Boolean(true)).expect("boolean group"),
            DistributionGroupValueV1::Boolean { value: true },
        );
        assert_eq!(
            value_to_group(Value::Date32(2)).expect("date group"),
            DistributionGroupValueV1::DateTime {
                utc_millis: 172_800_000
            },
        );
        assert_eq!(
            value_to_group(Value::Timestamp(TimeUnit::Microsecond, -1))
                .expect("pre-epoch timestamp"),
            DistributionGroupValueV1::DateTime { utc_millis: -1 },
        );
    }

    #[test]
    fn local_date_filter_is_rejected_until_timezone_semantics_are_versioned() {
        let engine = fixture_engine();
        let mut filtered = request(&engine);
        filtered.filter_expr = FilterExprV1::DateRange {
            field_id: column_id(&engine, "region"),
            start: Some("2026-01-01".to_string()),
            end: None,
            include_start: true,
            include_end: true,
            time_zone: "local".to_string(),
        };
        assert!(matches!(
            prepare_continuous_groups(&engine, &filtered, &y_column(&filtered)),
            Err(AppError::InvalidParam(code)) if code == "distribution.filter.timeZoneUnsupported"
        ));
    }

    #[test]
    fn stable_column_id_survives_rename() {
        let engine = fixture_engine();
        engine
            .conn()
            .execute(
                "INSERT INTO dataset_distribution_fixture VALUES (1, 10.0, 1.0, 1, 'East', 1)",
                [],
            )
            .expect("seed row");
        let columns = engine
            .get_distribution_columns("distribution_fixture")
            .expect("column descriptors");
        let y_id = columns
            .iter()
            .find(|column| column.name == "y")
            .expect("Y descriptor")
            .column_id
            .clone();
        let mut stable_request = request(&engine);
        stable_request.y_columns[0].column_id = y_id.clone();
        stable_request.weight_column_id = columns
            .iter()
            .find(|column| column.name == "weight")
            .map(|column| column.column_id.clone());
        stable_request.frequency_column_id = columns
            .iter()
            .find(|column| column.name == "freq")
            .map(|column| column.column_id.clone());

        engine
            .rename_column("distribution_fixture", "y", "renamed_y")
            .expect("rename Y");
        let stable_y = DistributionColumnRefV1 {
            column_id: y_id,
            modeling_type: DistributionModelingTypeV1::Continuous,
        };
        let groups = prepare_continuous_groups(&engine, &stable_request, &stable_y)
            .expect("prepare after rename");
        assert_eq!(groups[0].observations[0].y, 10.0);
    }
}

fn compile_filter(
    filter: &FilterExprV1,
    metadata: &HashMap<String, String>,
    params: &mut Vec<Value>,
) -> Result<String, AppError> {
    match filter {
        FilterExprV1::And { exprs } => compile_filter_list("AND", exprs, metadata, params, "TRUE"),
        FilterExprV1::Or { exprs } => compile_filter_list("OR", exprs, metadata, params, "FALSE"),
        FilterExprV1::Not { expr } => {
            Ok(format!("NOT ({})", compile_filter(expr, metadata, params)?))
        }
        FilterExprV1::IsNull { field_id, negate } => {
            let column = quote_identifier(resolve_column(metadata, field_id)?);
            Ok(format!(
                "{column} IS {}NULL",
                if *negate { "NOT " } else { "" }
            ))
        }
        FilterExprV1::NumericRange {
            field_id,
            min,
            max,
            include_min,
            include_max,
        } => {
            let column = quote_identifier(resolve_column(metadata, field_id)?);
            let mut clauses = Vec::new();
            if let Some(minimum) = min {
                if !minimum.is_finite() {
                    return Err(AppError::InvalidParam(
                        "distribution.filter.numericBoundInvalid".to_string(),
                    ));
                }
                params.push(Value::Double(*minimum));
                clauses.push(format!(
                    "{column} {} ?",
                    if *include_min { ">=" } else { ">" }
                ));
            }
            if let Some(maximum) = max {
                if !maximum.is_finite() {
                    return Err(AppError::InvalidParam(
                        "distribution.filter.numericBoundInvalid".to_string(),
                    ));
                }
                params.push(Value::Double(*maximum));
                clauses.push(format!(
                    "{column} {} ?",
                    if *include_max { "<=" } else { "<" }
                ));
            }
            Ok(if clauses.is_empty() {
                "TRUE".to_string()
            } else {
                clauses.join(" AND ")
            })
        }
        FilterExprV1::CategorySet {
            field_id,
            values,
            negate,
        } => {
            let column = quote_identifier(resolve_column(metadata, field_id)?);
            if values.is_empty() {
                return Ok(if *negate { "TRUE" } else { "FALSE" }.to_string());
            }
            let placeholders = vec!["?"; values.len()].join(", ");
            params.extend(values.iter().cloned().map(Value::Text));
            Ok(format!(
                "{column} {}IN ({placeholders})",
                if *negate { "NOT " } else { "" },
            ))
        }
        FilterExprV1::DateRange {
            field_id,
            start,
            end,
            include_start,
            include_end,
            time_zone,
        } => {
            if time_zone != "UTC" {
                return Err(AppError::InvalidParam(
                    "distribution.filter.timeZoneUnsupported".to_string(),
                ));
            }
            let column = quote_identifier(resolve_column(metadata, field_id)?);
            let mut clauses = Vec::new();
            if let Some(start) = start {
                params.push(Value::Text(start.clone()));
                clauses.push(format!(
                    "{column} {} ?",
                    if *include_start { ">=" } else { ">" }
                ));
            }
            if let Some(end) = end {
                params.push(Value::Text(end.clone()));
                clauses.push(format!(
                    "{column} {} ?",
                    if *include_end { "<=" } else { "<" }
                ));
            }
            Ok(if clauses.is_empty() {
                "TRUE".to_string()
            } else {
                clauses.join(" AND ")
            })
        }
    }
}

fn compile_filter_list(
    operator: &str,
    exprs: &[FilterExprV1],
    metadata: &HashMap<String, String>,
    params: &mut Vec<Value>,
    empty: &str,
) -> Result<String, AppError> {
    if exprs.is_empty() {
        return Ok(empty.to_string());
    }
    let clauses = exprs
        .iter()
        .map(|expr| compile_filter(expr, metadata, params).map(|sql| format!("({sql})")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(clauses.join(&format!(" {operator} ")))
}

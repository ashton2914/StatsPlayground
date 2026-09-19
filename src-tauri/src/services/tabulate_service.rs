use crate::error::AppError;
use crate::models::tabulate::TabulateStatistic;
use std::collections::HashSet;

pub(crate) fn validate_definition(
    dataset_id: &str,
    row_fields: &[String],
    column_fields: &[String],
    statistics: &[TabulateStatistic],
) -> Result<(), AppError> {
    if statistics.is_empty() {
        return Err(AppError::InvalidParam(
            "At least one statistic must be requested".into(),
        ));
    }
    if dataset_id.trim().is_empty() {
        return Err(AppError::InvalidParam("dataset_id must be provided".into()));
    }

    // Validate row/column field names are non-blank and not duplicated within their role
    let mut seen = HashSet::new();
    for f in row_fields {
        if f.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "row field names must not be blank".into(),
            ));
        }
        if !seen.insert(f) {
            return Err(AppError::InvalidParam("duplicate row field".into()));
        }
    }
    seen.clear();
    for f in column_fields {
        if f.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "column field names must not be blank".into(),
            ));
        }
        if !seen.insert(f) {
            return Err(AppError::InvalidParam("duplicate column field".into()));
        }
    }

    // Validate statistics content
    for stat in statistics {
        if stat.id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "statistic id must not be blank".into(),
            ));
        }
        if stat.field.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "statistic field must not be blank".into(),
            ));
        }
        if let Some(q) = stat.quantile {
            if !q.is_finite() || !(0.0..=1.0).contains(&q) {
                return Err(AppError::InvalidParam(
                    "quantile must be finite and in [0,1]".into(),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::tabulate::StatisticKind;

    #[test]
    fn tabulate_definition_rejects_empty_statistics() {
        assert!(matches!(validate_definition("dataset", &[], &[], &[]),
            Err(AppError::InvalidParam(message)) if message.contains("statistic")));
    }

    #[test]
    fn tabulate_definition_rejects_non_finite_or_out_of_range_quantiles() {
        for probability in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
            let statistics = [TabulateStatistic {
                id: "quantile".into(), field: "value".into(),
                kind: StatisticKind::Quantile, quantile: Some(probability),
            }];
            assert!(matches!(validate_definition("dataset", &[], &[], &statistics),
                Err(AppError::InvalidParam(message)) if message.contains("quantile")));
        }
    }
}

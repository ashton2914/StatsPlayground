use crate::error::AppError;
use crate::models::graph_data::{
    GraphTemporalAxisKind, GraphTemporalAxisMetadata, GraphTemporalAxisUnit,
    GraphTemporalDisplayZone, TimeSeriesTextDateFormat, TimeSeriesXInterpretation,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidatedTimeSeriesX {
    NativeDate,
    NativeTimestamp,
    NativeTimestampTz,
    TextDate { format: TimeSeriesTextDateFormat },
    Sequence,
}

pub fn text_date_pattern(format: TimeSeriesTextDateFormat) -> &'static str {
    match format {
        TimeSeriesTextDateFormat::IsoDate => "%Y-%m-%d",
        TimeSeriesTextDateFormat::IsoDateTime => "%Y-%m-%d %H:%M:%S",
        TimeSeriesTextDateFormat::UsDate => "%m/%d/%Y",
        TimeSeriesTextDateFormat::UsDateTime => "%m/%d/%Y %H:%M:%S",
        TimeSeriesTextDateFormat::DayFirstDate => "%d/%m/%Y",
        TimeSeriesTextDateFormat::DayFirstDateTime => "%d/%m/%Y %H:%M:%S",
    }
}

pub fn validate_time_series_x(
    sql_type: &str,
    interpretation: &TimeSeriesXInterpretation,
) -> Result<ValidatedTimeSeriesX, AppError> {
    let normalized = normalize_sql_type(sql_type);
    match interpretation {
        TimeSeriesXInterpretation::NativeTemporal => {
            validate_native_temporal_type(sql_type, &normalized)
        }
        TimeSeriesXInterpretation::TextDate { format } => {
            validate_text_date_type(sql_type, &normalized)?;
            Ok(ValidatedTimeSeriesX::TextDate { format: *format })
        }
        TimeSeriesXInterpretation::Sequence => {
            validate_numeric_type(sql_type, &normalized)?;
            Ok(ValidatedTimeSeriesX::Sequence)
        }
    }
}

pub fn temporal_axis_metadata(
    validated: ValidatedTimeSeriesX,
) -> Option<GraphTemporalAxisMetadata> {
    let kind = match validated {
        ValidatedTimeSeriesX::NativeDate => GraphTemporalAxisKind::Date,
        ValidatedTimeSeriesX::NativeTimestamp => GraphTemporalAxisKind::Timestamp,
        ValidatedTimeSeriesX::TextDate { format } if is_date_only_text_format(format) => {
            GraphTemporalAxisKind::Date
        }
        ValidatedTimeSeriesX::TextDate { .. } => GraphTemporalAxisKind::Timestamp,
        ValidatedTimeSeriesX::NativeTimestampTz => GraphTemporalAxisKind::TimestampTz,
        ValidatedTimeSeriesX::Sequence => return None,
    };
    Some(GraphTemporalAxisMetadata {
        unit: GraphTemporalAxisUnit::EpochMilliseconds,
        kind,
        display_zone: GraphTemporalDisplayZone::Utc,
    })
}

fn is_date_only_text_format(format: TimeSeriesTextDateFormat) -> bool {
    matches!(
        format,
        TimeSeriesTextDateFormat::IsoDate
            | TimeSeriesTextDateFormat::UsDate
            | TimeSeriesTextDateFormat::DayFirstDate
    )
}

impl ValidatedTimeSeriesX {
    pub fn projection_sql(&self, quoted_identifier: &str) -> String {
        match self {
            Self::NativeDate => {
                format!("CAST(epoch_ms(CAST({quoted_identifier} AS TIMESTAMP)) AS DOUBLE)")
            }
            Self::NativeTimestamp => {
                format!("CAST(epoch_ms({quoted_identifier}) AS DOUBLE)")
            }
            Self::NativeTimestampTz => {
                format!("CAST(epoch_ms({quoted_identifier}) AS DOUBLE)")
            }
            Self::TextDate { format } => format!(
                "CAST(epoch_ms(try_strptime(CAST({quoted_identifier} AS VARCHAR), '{}')) AS DOUBLE)",
                text_date_pattern(*format)
            ),
            Self::Sequence => format!("CAST({quoted_identifier} AS DOUBLE)"),
        }
    }
}

fn validate_native_temporal_type(
    sql_type: &str,
    normalized: &str,
) -> Result<ValidatedTimeSeriesX, AppError> {
    if is_standalone_time_type(normalized) {
        return Err(AppError::InvalidParam(
            "Standalone TIME is not supported for time series X.".to_string(),
        ));
    }
    if is_timestamp_tz_type(normalized) {
        return Ok(ValidatedTimeSeriesX::NativeTimestampTz);
    }
    if normalized.contains("TIMESTAMP") {
        return Ok(ValidatedTimeSeriesX::NativeTimestamp);
    }
    if normalized == "DATE" {
        return Ok(ValidatedTimeSeriesX::NativeDate);
    }
    Err(AppError::InvalidParam(format!(
        "SQL type {sql_type} is not supported for native time series X."
    )))
}

fn validate_text_date_type(sql_type: &str, normalized: &str) -> Result<(), AppError> {
    if is_string_like_type(normalized) {
        return Ok(());
    }
    Err(AppError::InvalidParam(format!(
        "SQL type {sql_type} is not string-like for parsed time series X."
    )))
}

fn validate_numeric_type(sql_type: &str, normalized: &str) -> Result<(), AppError> {
    if is_numeric_type(normalized) {
        return Ok(());
    }
    Err(AppError::InvalidParam(format!(
        "SQL type {sql_type} is not numeric for sequence time series X."
    )))
}

fn normalize_sql_type(sql_type: &str) -> String {
    sql_type.trim().to_ascii_uppercase()
}

fn normalize_sql_base_type(sql_type: &str) -> &str {
    sql_type
        .split('(')
        .next()
        .unwrap_or(sql_type)
        .split_whitespace()
        .next()
        .unwrap_or("")
}

fn is_standalone_time_type(normalized: &str) -> bool {
    matches!(normalize_sql_base_type(normalized), "TIME" | "TIMETZ")
}

fn is_timestamp_tz_type(normalized: &str) -> bool {
    normalized.contains("WITH TIME ZONE")
        || normalized.contains("TIMESTAMPTZ")
        || normalized.contains("TIMESTAMP_TZ")
}

fn is_string_like_type(normalized: &str) -> bool {
    matches!(
        normalize_sql_base_type(normalized),
        "VARCHAR" | "CHAR" | "BPCHAR" | "TEXT" | "STRING"
    )
}

fn is_numeric_type(normalized: &str) -> bool {
    matches!(
        normalize_sql_base_type(normalized),
        "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "INT"
            | "BIGINT"
            | "HUGEINT"
            | "UTINYINT"
            | "USMALLINT"
            | "UINTEGER"
            | "UBIGINT"
            | "UHUGEINT"
            | "REAL"
            | "FLOAT"
            | "DOUBLE"
            | "DECIMAL"
            | "NUMERIC"
            | "BIGNUM"
    )
}

#[cfg(test)]
mod tests {
    use crate::models::graph_data::{TimeSeriesTextDateFormat, TimeSeriesXInterpretation};

    use super::{text_date_pattern, validate_time_series_x};

    #[test]
    fn time_series_text_date_patterns_are_static() {
        assert_eq!(
            text_date_pattern(TimeSeriesTextDateFormat::UsDate),
            "%m/%d/%Y"
        );
    }

    #[test]
    fn time_series_validation_accepts_supported_native_temporal_type() {
        assert!(validate_time_series_x("DATE", &TimeSeriesXInterpretation::NativeTemporal).is_ok());
    }

    #[test]
    fn time_series_validation_rejects_standalone_time_type() {
        assert!(
            validate_time_series_x("TIME", &TimeSeriesXInterpretation::NativeTemporal).is_err()
        );
    }

    #[test]
    fn time_series_validation_rejects_standalone_time_with_timezone_types() {
        assert!(validate_time_series_x(
            "TIME WITH TIME ZONE",
            &TimeSeriesXInterpretation::NativeTemporal,
        )
        .is_err());
        assert!(
            validate_time_series_x("TIMETZ", &TimeSeriesXInterpretation::NativeTemporal).is_err()
        );
    }

    #[test]
    fn time_series_validation_accepts_timestamp_with_timezone_types() {
        assert!(validate_time_series_x(
            "TIMESTAMP WITH TIME ZONE",
            &TimeSeriesXInterpretation::NativeTemporal,
        )
        .is_ok());
        assert!(
            validate_time_series_x("TIMESTAMPTZ", &TimeSeriesXInterpretation::NativeTemporal,)
                .is_ok()
        );
    }

    #[test]
    fn time_series_validation_accepts_text_date_string_type() {
        assert!(validate_time_series_x(
            "VARCHAR",
            &TimeSeriesXInterpretation::TextDate {
                format: TimeSeriesTextDateFormat::UsDate,
            },
        )
        .is_ok());
    }

    #[test]
    fn time_series_validation_accepts_numeric_sequence_type() {
        assert!(validate_time_series_x("BIGINT", &TimeSeriesXInterpretation::Sequence).is_ok());
    }
}

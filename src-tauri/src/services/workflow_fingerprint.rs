use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::services::workflow_domain::canonical_duckdb_type;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableFingerprintColumn {
    pub name: String,
    pub canonical_type: String,
}

pub fn canonical_json_hash(value: &Value) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(&canonical_json(value.clone())).map_err(|error| {
        AppError::InvalidParam(format!("failed to encode canonical JSON: {error}"))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn canonical_document_hash(value: &Value) -> Result<String, AppError> {
    canonical_json_hash(&strip_runtime_fields(value.clone()))
}

pub fn table_content_hash(
    columns: &[TableFingerprintColumn],
    rows: &[Vec<Value>],
) -> Result<String, AppError> {
    let mut hasher = Sha256::new();
    write_length(&mut hasher, columns.len());
    for column in columns {
        write_bytes(&mut hasher, column.name.as_bytes());
        write_bytes(
            &mut hasher,
            canonical_duckdb_type(&column.canonical_type).as_bytes(),
        );
    }
    write_length(&mut hasher, rows.len());
    for (row_index, row) in rows.iter().enumerate() {
        if row.len() != columns.len() {
            return Err(AppError::InvalidParam(format!(
                "table fingerprint row {row_index} has {} values for {} columns",
                row.len(),
                columns.len()
            )));
        }
        for value in row {
            write_table_value(&mut hasher, value)?;
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn write_table_value(hasher: &mut Sha256, value: &Value) -> Result<(), AppError> {
    match value {
        Value::Null => hasher.update([0]),
        Value::Bool(value) => hasher.update([1, u8::from(*value)]),
        Value::Number(value) => {
            hasher.update([2]);
            write_bytes(hasher, value.to_string().as_bytes());
        }
        Value::String(value) => {
            hasher.update([3]);
            write_bytes(hasher, value.as_bytes());
        }
        Value::Array(_) | Value::Object(_) => {
            hasher.update([4]);
            let canonical = canonical_json(value.clone());
            let bytes = serde_json::to_vec(&canonical).map_err(|error| {
                AppError::InvalidParam(format!("failed to encode table value: {error}"))
            })?;
            write_bytes(hasher, &bytes);
        }
    }
    Ok(())
}

fn write_length(hasher: &mut Sha256, value: usize) {
    hasher.update((value as u64).to_be_bytes());
}

fn write_bytes(hasher: &mut Sha256, value: &[u8]) {
    write_length(hasher, value.len());
    hasher.update(value);
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonical_json).collect()),
        Value::Object(values) => {
            let sorted = values
                .into_iter()
                .map(|(key, value)| (key, canonical_json(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect())
        }
        scalar => scalar,
    }
}

fn strip_runtime_fields(value: Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.into_iter().map(strip_runtime_fields).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "startedAt"
                            | "completedAt"
                            | "createdAt"
                            | "updatedAt"
                            | "executionTimestamp"
                            | "elapsedTime"
                            | "elapsedMs"
                            | "runtimeState"
                            | "transientState"
                            | "cache"
                    )
                })
                .map(|(key, value)| (key, strip_runtime_fields(value)))
                .collect(),
        ),
        scalar => scalar,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn canonical_json_hash_ignores_object_key_order_but_detects_semantic_changes() {
        let first = json!({"b": [2, 3], "a": {"y": true, "x": 1}});
        let reordered = json!({"a": {"x": 1, "y": true}, "b": [2, 3]});
        let changed = json!({"a": {"x": 2, "y": true}, "b": [2, 3]});

        assert_eq!(
            canonical_json_hash(&first).unwrap(),
            canonical_json_hash(&reordered).unwrap()
        );
        assert_ne!(
            canonical_json_hash(&first).unwrap(),
            canonical_json_hash(&changed).unwrap()
        );
    }

    #[test]
    fn document_hash_excludes_audit_fields_but_not_business_fields() {
        let first = json!({
            "title": "Yield",
            "startedAt": "2026-09-08T10:00:00Z",
            "nested": { "elapsedMs": 12, "value": 4 }
        });
        let later = json!({
            "title": "Yield",
            "startedAt": "2026-09-08T11:00:00Z",
            "nested": { "elapsedMs": 99, "value": 4 }
        });
        let changed = json!({
            "title": "Yield",
            "startedAt": "2026-09-08T11:00:00Z",
            "nested": { "elapsedMs": 99, "value": 5 }
        });

        assert_eq!(
            canonical_document_hash(&first).unwrap(),
            canonical_document_hash(&later).unwrap()
        );
        assert_ne!(
            canonical_document_hash(&first).unwrap(),
            canonical_document_hash(&changed).unwrap()
        );
    }

    #[test]
    fn table_hash_detects_schema_row_order_null_placement_and_values() {
        let columns = vec![TableFingerprintColumn {
            name: "value".to_string(),
            canonical_type: "INTEGER".to_string(),
        }];
        let base = table_content_hash(&columns, &[vec![json!(1)], vec![Value::Null]]).unwrap();

        assert_ne!(
            base,
            table_content_hash(&columns, &[vec![Value::Null], vec![json!(1)]]).unwrap()
        );
        assert_ne!(
            base,
            table_content_hash(&columns, &[vec![json!(2)], vec![Value::Null]]).unwrap()
        );
        assert_ne!(
            base,
            table_content_hash(
                &[TableFingerprintColumn {
                    name: "value".to_string(),
                    canonical_type: "BIGINT".to_string()
                }],
                &[vec![json!(1)], vec![Value::Null]]
            )
            .unwrap()
        );
        assert_ne!(
            base,
            table_content_hash(&columns, &[vec![Value::Null], vec![Value::Null]]).unwrap()
        );
    }
}

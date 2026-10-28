use serde_json::Value;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::{ProjectRecordPatch, ProjectSettingWrite};
use crate::services::{project_catalog::ProjectCatalog, spprj_archive};

fn invalid() -> AppError { AppError::InvalidParam("project_filter_setting_invalid".into()) }

fn bind(engine: &DuckDbEngine, dataset: &str, value: Value) -> Result<Vec<Value>, AppError> {
    let parsed: Vec<spprj_archive::ProjectFilterRuleItem> = serde_json::from_value(value.clone()).map_err(|_|invalid())?;
    for (index,rule) in parsed.iter().enumerate() {
        spprj_archive::validate_dataset_filter_rule_item(dataset,index,rule).map_err(|_|invalid())?;
        if rule.id.trim().is_empty() {return Err(invalid());}
    }
    let mut rules=value.as_array().cloned().ok_or_else(invalid)?;
    let columns=engine.get_user_column_descriptors(dataset)?;
    for item in &mut rules {
        let rule=item.get_mut("rule").and_then(Value::as_object_mut).ok_or_else(invalid)?;
        match rule.get("kind").and_then(Value::as_str) {
            Some("continuous")=>{rule.entry("min").or_insert(Value::Null);rule.entry("max").or_insert(Value::Null);},
            Some("date")=>{rule.entry("start").or_insert(Value::Null);rule.entry("end").or_insert(Value::Null);},
            _=>{}
        }
        let field=rule.get_mut("field").and_then(Value::as_object_mut).ok_or_else(invalid)?;
        let name=field.get("name").and_then(Value::as_str).filter(|name|!name.trim().is_empty()).ok_or_else(invalid)?;
        if field.get("columnId").is_none_or(Value::is_null) {
            if let Some(column)=columns.iter().find(|column|column.name==name) {field.insert("columnId".into(),Value::String(column.column_id.clone()));}
        }
    }
    Ok(rules)
}

/// Missing columns disable a filter without erasing its saved stable identity.
/// Replaying schema history can therefore restore it without rewinding later edits.
pub(crate) fn effective(engine: &DuckDbEngine, dataset: &str, value: Value) -> Result<Value, AppError> {
    if value.is_null() {return Ok(Value::Array(vec![]));}
    let columns=engine.get_user_column_descriptors(dataset)?;
    let rules=bind(engine,dataset,value)?;
    let mut active=Vec::new();
    for mut item in rules {
        let kind=item.get("rule").and_then(|rule|rule.get("kind")).and_then(Value::as_str).ok_or_else(invalid)?.to_string();
        let field=item.get_mut("rule").and_then(|rule|rule.get_mut("field")).and_then(Value::as_object_mut).ok_or_else(invalid)?;
        let column=if let Some(id)=field.get("columnId").and_then(Value::as_str) {columns.iter().find(|column|column.column_id==id)}
            else {columns.iter().find(|column|Some(column.name.as_str())==field.get("name").and_then(Value::as_str))};
        if let Some(column)=column {
            let compatible=match kind.as_str() {
                "continuous"=>crate::engine::duckdb_engine::is_numeric_type(&column.sql_type),
                "date"=>crate::engine::duckdb_engine::is_temporal_type(&column.sql_type),
                _=>true,
            };
            if !compatible {continue;}
            field.insert("name".into(),Value::String(column.name.clone()));active.push(item);}
    }
    Ok(Value::Array(active))
}

pub(crate) fn capture(engine: &DuckDbEngine, dataset: &str) -> Result<Option<ProjectSettingWrite>, AppError> {
    let key=format!("filter:{dataset}");
    let Some((revision,value))=ProjectCatalog::new(engine).get_setting(&key)? else {return Ok(None);};
    let value=if value.is_null() {Value::Array(vec![])} else {Value::Array(bind(engine,dataset,value)?)};
    Ok(Some(ProjectSettingWrite {key,expected_revision:Some(revision),value}))
}

pub(crate) fn publish(engine: &DuckDbEngine, captured: Option<ProjectSettingWrite>) -> Result<Option<String>, AppError> {
    let Some(write)=captured else {return Ok(None);};
    let key=write.key.clone();
    ProjectCatalog::new(engine).apply_patch(&ProjectRecordPatch {settings:vec![write],..Default::default()})?;
    Ok(Some(key))
}

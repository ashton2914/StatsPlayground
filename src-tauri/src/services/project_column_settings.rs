use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::{ProjectRecordPatch, ProjectSettingWrite};
use crate::models::table::{ColumnDisplayProps, ColumnDisplayPropsWithoutIndex};
use crate::services::project_catalog::ProjectCatalog;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StableDisplay {
    version: u32,
    columns: BTreeMap<String, ColumnDisplayPropsWithoutIndex>,
}

fn invalid() -> AppError { AppError::InvalidParam("project_display_setting_invalid".into()) }

fn decode(engine: &DuckDbEngine, dataset: &str, value: Value) -> Result<StableDisplay, AppError> {
    let stable = if value.is_null() {StableDisplay {version:1,columns:BTreeMap::new()}} else if value.is_array() {
        let props: Vec<ColumnDisplayProps> = serde_json::from_value(value).map_err(|_| invalid())?;
        let descriptors = engine.get_user_column_descriptors(dataset)?;
        let mut columns = BTreeMap::new();
        for prop in props {
            let column = descriptors.get(prop.col_index).ok_or_else(invalid)?;
            if columns.insert(column.column_id.clone(), ColumnDisplayPropsWithoutIndex {
                width: prop.width, format: prop.format, extras: prop.extras,
            }).is_some() { return Err(invalid()); }
        }
        StableDisplay {version:1, columns}
    } else { serde_json::from_value(value).map_err(|_| invalid())? };
    if stable.version != 1 { return Err(invalid()); }
    for props in stable.columns.values() {
        crate::services::data_service::DataService::validate_display_without_index(props)?;
    }
    Ok(stable)
}

pub(crate) fn read(engine: &DuckDbEngine, dataset: &str) -> Result<Vec<ColumnDisplayProps>, AppError> {
    let Some((_,value)) = ProjectCatalog::new(engine).get_setting(&format!("display:{dataset}"))? else { return Ok(vec![]); };
    let stable = decode(engine,dataset,value)?;
    Ok(engine.get_user_column_descriptors(dataset)?.into_iter().enumerate().filter_map(|(index,column)| {
        stable.columns.get(&column.column_id).map(|props|ColumnDisplayProps {
            col_index:index,width:props.width,format:props.format.clone(),extras:props.extras.clone(),
        })
    }).collect())
}

/// Convert positional legacy settings before changing the column order. Retained
/// IDs also preserve settings for columns restored by undo, without copying rows.
pub(crate) fn stabilize(engine: &DuckDbEngine, dataset: &str) -> Result<Option<String>, AppError> {
    let catalog = ProjectCatalog::new(engine);
    let key = format!("display:{dataset}");
    let Some((revision,value)) = catalog.get_setting(&key)? else { return Ok(None); };
    let positional = value.is_array();
    let stable = decode(engine,dataset,value)?;
    if !positional { return Ok(None); }
    catalog.apply_patch(&ProjectRecordPatch {settings:vec![ProjectSettingWrite {
        key:key.clone(),expected_revision:Some(revision),value:serde_json::to_value(stable).map_err(|_|invalid())?,
    }],..Default::default()})?;
    Ok(Some(key))
}

pub(crate) fn replacement(engine: &DuckDbEngine, dataset: &str, props: &[ColumnDisplayProps]) -> Result<Value, AppError> {
    let existing = ProjectCatalog::new(engine).get_setting(&format!("display:{dataset}"))?;
    let mut stable = match existing { Some((_,value))=>decode(engine,dataset,value)?,None=>StableDisplay {version:1,columns:BTreeMap::new()} };
    let columns = engine.get_user_column_descriptors(dataset)?;
    for column in &columns { stable.columns.remove(&column.column_id); }
    for prop in props {
        let column=columns.get(prop.col_index).ok_or_else(invalid)?;
        stable.columns.insert(column.column_id.clone(),ColumnDisplayPropsWithoutIndex {width:prop.width,format:prop.format.clone(),extras:prop.extras.clone()});
    }
    serde_json::to_value(stable).map_err(|_|invalid())
}

pub(crate) fn schema_signature(engine: &DuckDbEngine, dataset: &str) -> Result<Vec<(String,i32,String,String)>,AppError> {
    Ok(engine.get_user_column_descriptors(dataset)?.into_iter().map(|column|(column.column_id,column.col_index,column.name,column.sql_type)).collect())
}

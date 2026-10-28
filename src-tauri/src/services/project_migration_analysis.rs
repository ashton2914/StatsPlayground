//! One-time conversion of archived frontend analysis records into native document bodies.
use crate::error::AppError;
use super::spprj_archive::{self,ProjectBundle};
use serde_json::{json,Value};
use std::collections::HashSet;

fn invalid()->AppError {AppError::InvalidParam("project_migration_analysis_invalid".into())}
fn text<'a>(body:&'a Value,key:&str)->Result<&'a str,AppError> {
    body.get(key).and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or_else(invalid)
}
fn wrap(legacy:&Value,kind:&str,definition:Value,presentation:Value)->Result<Value,AppError> {
    let created=text(legacy,"createdAt")?;
    let result=json!({"documentType":"analysis","schemaVersion":1,"id":text(legacy,"id")?,"name":text(legacy,"name")?,"analysisKind":kind,"configRevision":1,"source":{"datasetId":text(legacy,"sourceDatasetId")?},"definition":definition,"presentation":presentation,"createdAt":created,"updatedAt":created});
    spprj_archive::validate_analysis_value(&result,"legacy project migration")?;
    Ok(result)
}

pub(crate) fn normalize(bundle:&mut ProjectBundle)->Result<(),AppError> {
    for document in &mut bundle.analyses {
        if document["analysisKind"]=="distribution" {
            let config=document.pointer_mut("/definition/analysis").and_then(Value::as_object_mut).ok_or_else(invalid)?;
            config.insert("specLimits".into(),json!({}));
            config.entry("fitAll").or_insert(Value::Bool(false));
        }
    }
    let mut ids=bundle.analyses.iter().map(|doc|text(doc,"id").map(str::to_owned)).collect::<Result<HashSet<_>,_>>()?;
    for legacy in std::mem::take(&mut bundle.distributions) {
        let mut analysis=legacy["analysis"].clone();
        let fields=analysis.as_object_mut().ok_or_else(invalid)?;
        fields.insert("specLimits".into(),json!({}));
        fields.entry("fitAll").or_insert(Value::Bool(false));
        let definition=json!({"kind":"distribution","responses":legacy["responses"],"weight":legacy["weight"],"frequency":legacy["frequency"],"by":legacy["by"],"nestedSubgroup":legacy.get("nestedSubgroup").unwrap_or(&Value::Null),"analysis":analysis,"graphs":legacy["graphs"]});
        let mut converted=wrap(&legacy,"distribution",definition,json!({"schemaVersion":1,"layout":"distribution-v1"}))?;
        let original=text(&legacy,"id")?;
        let mut id=original.to_owned();let mut suffix=2;
        while ids.contains(&id) {id=format!("{original}-migrated-{suffix}");suffix+=1;}
        converted["id"]=id.clone().into();ids.insert(id.clone());
        if let Some(folder)=bundle.manifest.distribution_folders.get(original){bundle.manifest.analysis_folders.insert(id,folder.clone());}
        bundle.analyses.push(converted);
    }
    for legacy in std::mem::take(&mut bundle.fit_y_by_x) {
        let id=text(&legacy,"id")?.to_owned();
        if !ids.insert(id.clone()){return Err(AppError::InvalidParam("project_migration_analysis_identity_conflict".into()));}
        // The legacy frontend accepts only the role-matched 2D graph.
        if legacy.pointer("/graph/mode").and_then(Value::as_str)!=Some("2d") {return Err(invalid());}
        for (axis,role) in [("x","factor"),("y","response")] {
            let encoded=legacy.pointer(&format!("/graph/modeStates/twoD/encoding/{axis}")).ok_or_else(invalid)?;
            for field in ["name","type"] {
                if encoded.get(field)!=legacy[role].get(field) {return Err(invalid());}
            }
        }
        let definition=json!({"kind":"fitYByX","response":legacy["response"],"factor":legacy["factor"],"personality":legacy["personality"],"confidenceLevel":0.95});
        let converted=wrap(&legacy,"fitYByX",definition,json!({"schemaVersion":1,"layout":"fit-y-by-x-v1","graph":legacy["graph"]}))?;
        if let Some(folder)=bundle.manifest.fit_y_by_x_folders.get(&id){bundle.manifest.analysis_folders.insert(id,folder.clone());}
        bundle.analyses.push(converted);
    }
    for legacy in std::mem::take(&mut bundle.fit_models) {
        let id=text(&legacy,"id")?.to_owned();
        if !ids.insert(id.clone()){return Err(AppError::InvalidParam("project_migration_analysis_identity_conflict".into()));}
        let mut definition=json!({"kind":"fitModel","response":legacy["response"],"construct":legacy.get("construct").cloned().unwrap_or(json!({"kind":"manual"})),"terms":legacy["terms"],"centeringMethod":legacy.get("centeringMethod").and_then(Value::as_str).filter(|s|*s=="mean").unwrap_or("none"),"confidenceLevel":0.95});
        if let Some(issue)=legacy.get("loadIssue"){definition["migrationIssue"]=issue.clone();}
        let converted=wrap(&legacy,"fitModel",definition,json!({"schemaVersion":1,"layout":"fit-model-v1"}))?;
        if let Some(folder)=bundle.manifest.fit_model_folders.get(&id){bundle.manifest.analysis_folders.insert(id,folder.clone());}
        bundle.analyses.push(converted);
    }
    super::project_service::normalize_visible_document_names(bundle);
    bundle.manifest.fit_y_by_x_files.clear();
    bundle.manifest.fit_y_by_x.clear();
    bundle.manifest.fit_models.clear();
    bundle.manifest.distributions.clear();
    bundle.manifest.analyses=bundle.analyses.iter().enumerate().map(|(index,body)|Ok(spprj_archive::DocumentEntryRef {
        id:text(body,"id")?.into(),name:text(body,"name")?.into(),file:format!("analyses/migrated-{index}.span"),kind:spprj_archive::DocumentKind::Analysis,
    })).collect::<Result<Vec<_>,AppError>>()?;
    Ok(())
}

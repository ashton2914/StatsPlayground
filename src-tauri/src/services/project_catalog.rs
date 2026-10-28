use duckdb::{params, OptionalExt};
use serde_json::Value;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::*;
use crate::models::table::DatasetMeta;
use crate::services::{project_schema, spprj_archive, table_transform_domain, workflow_domain};

pub struct ProjectCatalog<'a> { engine: &'a DuckDbEngine }

type SummaryRow = (String, String, String, String, u64, String, Option<String>);

fn invalid(code: &str) -> AppError { AppError::InvalidParam(code.into()) }

fn encode<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|_| invalid("project_record_invalid"))
}

fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, AppError> {
    serde_json::from_str(json).map_err(|_| invalid("project_record_invalid"))
}

fn summary_row(row: &duckdb::Row<'_>) -> duckdb::Result<SummaryRow> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
}

fn decode_summary(raw: SummaryRow) -> Result<ProjectDocumentSummary, AppError> {
    Ok(ProjectDocumentSummary { id: raw.0, kind: decode(&encode(&raw.1)?)?, name: raw.2,
        folder: raw.3, revision: raw.4, dependencies: decode(&raw.5)?, analysis_kind: raw.6 })
}

fn validate_name(name: &str) -> Result<(), AppError> {
    spprj_archive::validate_portable_basename(name, "project document")
        .map_err(|_| invalid("project_name_invalid"))
}

fn validate_folder(folder: &str) -> Result<(), AppError> {
    if !folder.is_empty() { for part in folder.split('/') { validate_name(part)?; } }
    Ok(())
}

fn validate_document(document: &ProjectDocumentBody) -> Result<(), AppError> {
    let summary = &document.summary;
    if document.schema_version != 1 { return Err(invalid("project_document_schema_unsupported")); }
    if summary.id.trim().is_empty() || summary.id.len() > 256 { return Err(invalid("project_document_id_invalid")); }
    validate_name(&summary.name)?;
    validate_folder(&summary.folder)?;
    if document.body.get("id").and_then(Value::as_str) != Some(summary.id.as_str())
        || document.body.get("name").and_then(Value::as_str) != Some(summary.name.as_str()) {
        return Err(invalid("project_document_identity_mismatch"));
    }
    match summary.kind {
        ProjectDocumentKind::GraphNew => spprj_archive::validate_graph_builder_new_value(&document.body),
        ProjectDocumentKind::Analysis => spprj_archive::validate_analysis_value(&document.body, "project document"),
        ProjectDocumentKind::Report => spprj_archive::validate_report_value(&document.body, "project document"),
        ProjectDocumentKind::Workflow => {
            let definition: workflow_domain::WorkflowDefinition = serde_json::from_value(document.body.clone()).map_err(|_| invalid("project_workflow_invalid"))?;
            workflow_domain::validate_workflow_definitions(&[definition])
        }
        ProjectDocumentKind::Transform => {
            let definition: table_transform_domain::TableTransformDefinition = serde_json::from_value(document.body.clone()).map_err(|_| invalid("project_transform_invalid"))?;
            table_transform_domain::validate_table_transform_definition(&definition)
        }
        ProjectDocumentKind::Table | ProjectDocumentKind::Folder => Err(invalid("project_record_requires_typed_operation")),
        // Legacy graphs/tabulates/snapshots retain their existing opaque body contracts.
        ProjectDocumentKind::Graph | ProjectDocumentKind::Tabulate | ProjectDocumentKind::Snapshot => Ok(()),
    }
}

impl<'a> ProjectCatalog<'a> {
    /// Explicit writes advance a retained clock; open and read paths never call this.
    fn advance_document_revision(&self,id:&str,current:u64)->Result<u64,AppError> {
        let conn=self.engine.conn();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_document_revision_watermarks(id VARCHAR PRIMARY KEY,revision UBIGINT NOT NULL)")?;
        let retained:Option<u64>=conn.query_row("SELECT revision FROM _project_document_revision_watermarks WHERE id=?",[id],|row|row.get(0)).optional()?;
        let next=current.max(retained.unwrap_or(0)).checked_add(1).ok_or_else(||invalid("project_revision_exhausted"))?;
        conn.execute("INSERT INTO _project_document_revision_watermarks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=GREATEST(_project_document_revision_watermarks.revision,excluded.revision)",params![id,next])?;
        Ok(next)
    }

    pub fn new(engine: &'a DuckDbEngine) -> Self { Self { engine } }

    fn has_subtypes(&self) -> Result<bool, AppError> {
        Ok(self.engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='_project_document_subtypes')",[],|row|row.get(0))?)
    }

    fn subtype_expression(&self) -> Result<&'static str, AppError> {
        Ok(if self.has_subtypes()? {
            "(SELECT analysis_kind FROM _project_document_subtypes s WHERE s.id=_project_directory.id)"
        } else { "NULL" })
    }

    pub fn list(&self, request: &CatalogPageRequest) -> Result<CatalogPage, AppError> {
        if !(1..=1000).contains(&request.limit) { return Err(invalid("project_page_limit_invalid")); }
        let revision = project_schema::read_header(self.engine.conn(), false)?.committed_revision;
        let (kind, id) = if let Some(after) = &request.after {
            let (expected, kind, id): (u64, String, String) = decode(after)?;
            if expected != revision { return Err(invalid("project_catalog_cursor_stale")); }
            (kind, id)
        } else { (String::new(), String::new()) };
        let mut statement = self.engine.conn().prepare(
            &format!("SELECT id, kind, name, folder, revision, dependencies_json, {} FROM _project_directory
             WHERE kind > ? OR (kind = ? AND id > ?) ORDER BY kind, id LIMIT ?",self.subtype_expression()?),
        )?;
        let raw = statement.query_map(params![&kind, &kind, &id, (request.limit + 1) as i64], summary_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = raw.len() > request.limit;
        let items = raw.into_iter().take(request.limit).map(decode_summary).collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if has_more {
            items.last().map(|last| {
                let kind = serde_json::to_value(last.kind).map_err(|_| invalid("project_kind_invalid"))?;
                encode(&(revision, kind.as_str().ok_or_else(|| invalid("project_kind_invalid"))?, &last.id))
            }).transpose()?
        } else { None };
        Ok(CatalogPage { items, next_cursor, committed_revision: revision })
    }

    /// Validate directory identity and relational metadata without touching body/history values.
    pub(crate) fn validate_metadata(&self) -> Result<(), AppError> {
        let mut page = CatalogPageRequest { after: None, limit: 1000 };
        loop {
            let result = self.list(&page)?;
            for summary in &result.items {
                if summary.id.trim().is_empty() || summary.id.len() > 256 || summary.revision == 0 {
                    return Err(invalid("project_catalog_invalid"));
                }
                if summary.analysis_kind.as_deref().is_some_and(|kind| summary.kind != ProjectDocumentKind::Analysis || !["distribution","fitYByX","fitModel","hypothesisTest"].contains(&kind)) { return Err(invalid("project_catalog_subtype_invalid")); }
                validate_name(&summary.name)?;
                validate_folder(&summary.folder)?;
                if summary.kind == ProjectDocumentKind::Folder {
                    let path = if summary.folder.is_empty() { summary.name.clone() } else { format!("{}/{}",summary.folder,summary.name) };
                    if summary.id != format!("folder:{path}") { return Err(invalid("project_catalog_invalid")); }
                }
            }
            if result.next_cursor.is_none() { break; }
            page.after = result.next_cursor;
        }
        let inconsistencies:i64 = self.engine.conn().query_row(
            "SELECT
             (SELECT count(*) FROM _project_directory d LEFT JOIN _project_directory f ON f.id='folder:' || d.folder AND f.kind='folder'
              WHERE d.folder<>'' AND f.id IS NULL) +
             (SELECT count(*) FROM _project_directory d LEFT JOIN _project_documents b ON b.id=d.id AND b.revision=d.revision
              WHERE d.kind NOT IN ('table','folder') AND b.id IS NULL) +
             (SELECT count(*) FROM _project_documents b LEFT JOIN _project_directory d ON d.id=b.id
              WHERE d.id IS NULL OR d.kind IN ('table','folder')) +
             (SELECT count(*) FROM _project_directory d LEFT JOIN _meta_datasets t ON t.id=d.id
              WHERE d.kind='table' AND t.id IS NULL) +
             (SELECT count(*) FROM _meta_datasets t LEFT JOIN _project_directory d ON d.id=t.id AND d.kind='table'
              WHERE NOT starts_with(t.id,'__workflow_stage_') AND d.id IS NULL) +
             (SELECT count(*) FROM _project_settings WHERE key='' OR revision=0)",[],|row|row.get(0))?;
        if inconsistencies != 0 { return Err(invalid("project_catalog_inconsistent")); }
        Ok(())
    }

    pub(crate) fn summary(&self, id: &str) -> Result<ProjectDocumentSummary, AppError> {
        let row = self.engine.conn().query_row(
            &format!("SELECT id, kind, name, folder, revision, dependencies_json, {} FROM _project_directory WHERE id = ?",self.subtype_expression()?),
            [id], summary_row,
        )?;
        decode_summary(row)
    }

    pub fn get_document(&self, id: &str, expected_revision: u64) -> Result<ProjectDocumentBody, AppError> {
        let summary = self.summary(id)?;
        if summary.revision != expected_revision { return Err(invalid("project_document_revision_stale")); }
        let (schema_version, json): (u32, String) = self.engine.conn().query_row(
            "SELECT schema_version, body_json FROM _project_documents WHERE id = ? AND revision = ?",
            params![id, expected_revision], |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut body: Value = decode(&json)?;
        if let Some(object) = body.as_object_mut() { object.insert("name".into(), Value::String(summary.name.clone())); }
        let document = ProjectDocumentBody { summary, schema_version, body };
        validate_document(&document)?;
        Ok(document)
    }

    fn ensure_folder(&self, folder: &str) -> Result<(), AppError> {
        validate_folder(folder)?;
        if folder.is_empty() { return Ok(()); }
        let mut parent = String::new();
        for part in folder.split('/') {
            let path = if parent.is_empty() { part.to_string() } else { format!("{parent}/{part}") };
            let id = format!("folder:{path}");
            let kind: Option<String> = self.engine.conn().query_row(
                "SELECT kind FROM _project_directory WHERE id=?", [&id], |r| r.get(0),
            ).optional()?;
            if kind.as_deref().is_some_and(|kind| kind != "folder") {
                return Err(invalid("project_directory_kind_conflict"));
            }
            self.engine.conn().execute(
                "INSERT INTO _project_directory VALUES (?, 'folder', ?, ?, 1, '[]') ON CONFLICT(id) DO NOTHING",
                params![format!("folder:{path}"), part, &parent],
            )?;
            parent = path;
        }
        Ok(())
    }

    /// Caller owns the encompassing project transaction; never commits independently.
    pub fn apply_patch(&self, patch: &ProjectRecordPatch) -> Result<(), AppError> {
        let conn = self.engine.conn();
        for write in &patch.documents { validate_document(&write.document)?; }
        // Older opt-in files remain readable without any upgrade on open. Their
        // first explicit document write adds this small metadata index atomically.
        if !patch.documents.is_empty() { conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_document_subtypes (id VARCHAR PRIMARY KEY, analysis_kind VARCHAR NOT NULL)")?; }
        for folder in &patch.created_folders { self.ensure_folder(folder)?; }
        for write in &patch.documents {
            let doc = &write.document;
            let kind = serde_json::to_value(doc.summary.kind).map_err(|_| invalid("project_kind_invalid"))?;
            let old_kind: Option<String> = conn.query_row(
                "SELECT kind FROM _project_directory WHERE id=?", [&doc.summary.id], |r| r.get(0),
            ).optional()?;
            if old_kind.as_deref().is_some_and(|old| Some(old) != kind.as_str()) {
                return Err(invalid("project_directory_kind_conflict"));
            }
            let old: Option<u64> = conn.query_row("SELECT revision FROM _project_documents WHERE id = ?", [&doc.summary.id], |r| r.get(0)).optional()?;
            if old != write.expected_revision { return Err(invalid("project_document_revision_stale")); }
            let proposal = old.unwrap_or(0).checked_add(1).ok_or_else(|| invalid("project_revision_exhausted"))?;
            if doc.summary.revision != proposal { return Err(invalid("project_document_revision_invalid")); }
            let revision = self.advance_document_revision(&doc.summary.id,old.unwrap_or(0))?;
            self.ensure_folder(&doc.summary.folder)?;
            conn.execute("INSERT INTO _project_documents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,schema_version=excluded.schema_version,body_json=excluded.body_json",
                params![&doc.summary.id, revision, doc.schema_version, encode(&doc.body)?])?;
            conn.execute("INSERT INTO _project_directory VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folder=excluded.folder,revision=excluded.revision,dependencies_json=excluded.dependencies_json",
                params![&doc.summary.id, serde_json::to_value(doc.summary.kind).map_err(|_| invalid("project_kind_invalid"))?.as_str(), &doc.summary.name, &doc.summary.folder, revision, encode(&doc.summary.dependencies)?])?;
            let subtype = (doc.summary.kind == ProjectDocumentKind::Analysis).then(|| doc.body.get("analysisKind").and_then(Value::as_str)).flatten();
            if let Some(subtype) = subtype {
                conn.execute("INSERT INTO _project_document_subtypes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET analysis_kind=excluded.analysis_kind",params![&doc.summary.id,subtype])?;
            }
        }
        for movement in &patch.directory_moves {
            self.ensure_folder(&movement.folder)?;
            let summary = self.summary(&movement.id)?;
            if summary.revision != movement.expected_revision { return Err(invalid("project_document_revision_stale")); }
            if summary.kind == ProjectDocumentKind::Folder { return Err(invalid("project_record_requires_typed_operation")); }
            let next = self.advance_document_revision(&movement.id,summary.revision)?;
            let name=movement.name.as_deref().unwrap_or(&summary.name);
            validate_name(name)?;
            if summary.kind==ProjectDocumentKind::Table && movement.name.is_some() { self.engine.rename_dataset(&movement.id,name)?; }
            conn.execute("UPDATE _project_directory SET name=?,folder=?,revision=? WHERE id=?", params![name,&movement.folder, next, &movement.id])?;
            conn.execute("UPDATE _project_documents SET revision=? WHERE id=?", params![next, &movement.id])?;
        }
        for id in &patch.deleted_document_ids {
            let summary = self.summary(id)?;
            if matches!(summary.kind, ProjectDocumentKind::Table | ProjectDocumentKind::Folder) { return Err(invalid("project_record_requires_typed_operation")); }
            conn.execute_batch("CREATE TABLE IF NOT EXISTS _project_document_revision_watermarks(id VARCHAR PRIMARY KEY,revision UBIGINT NOT NULL)")?;
            conn.execute("INSERT INTO _project_document_revision_watermarks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=GREATEST(_project_document_revision_watermarks.revision,excluded.revision)",params![id,summary.revision])?;
            if self.has_subtypes()? { conn.execute("DELETE FROM _project_document_subtypes WHERE id=?", [id])?; }
            conn.execute("DELETE FROM _project_documents WHERE id=?", [id])?;
            conn.execute("DELETE FROM _project_directory WHERE id=?", [id])?;
        }
        for write in &patch.settings {
            let allowed = ["lineage", "logicalFolders", "snapshots"].contains(&write.key.as_str())
                || ["filter:", "display:", "workflowBinding:", "workflowRun:", "transformBinding:"].iter().any(|prefix| write.key.starts_with(prefix) && write.key.len() > prefix.len());
            if !allowed { return Err(invalid("project_setting_unknown")); }
            let old: Option<u64> = conn.query_row("SELECT revision FROM _project_settings WHERE key=?", [&write.key], |r| r.get(0)).optional()?;
            if old != write.expected_revision { return Err(invalid("project_setting_revision_stale")); }
            if !write.value.is_null() {
                if let Some(dataset)=write.key.strip_prefix("filter:").or_else(||write.key.strip_prefix("display:")) {
                    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM _meta_datasets WHERE id=?)",[dataset],|row|row.get(0))?;
                    if !exists {return Err(invalid("project_setting_dataset_missing"));}
                }
            }
            let revision = old.unwrap_or(0).checked_add(1).ok_or_else(|| invalid("project_revision_exhausted"))?;
            conn.execute("INSERT INTO _project_settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",
                params![&write.key, revision, encode(&write.value)?])?;
        }
        for folder in &patch.deleted_folders {
            validate_folder(folder)?;
            if folder.is_empty() { return Err(invalid("project_root_cannot_delete")); }
            let children: i64 = conn.query_row("SELECT count(*) FROM _project_directory WHERE folder=? OR starts_with(folder, ? || '/')", params![folder, folder], |r| r.get(0))?;
            if children != 0 { return Err(invalid("project_folder_not_empty")); }
            conn.execute("DELETE FROM _project_directory WHERE id=? AND kind='folder'", [format!("folder:{folder}")])?;
        }
        Ok(())
    }

    /// Typed table publication shares the data operation's transaction.
    pub(crate) fn publish_table(&self, meta: &DatasetMeta, folder: &str) -> Result<(), AppError> {
        validate_name(&meta.name)?;
        self.ensure_folder(folder)?;
        let old: Option<String> = self.engine.conn().query_row("SELECT kind FROM _project_directory WHERE id=?", [&meta.id], |r| r.get(0)).optional()?;
        if old.as_deref().is_some_and(|kind| kind!="table") { return Err(invalid("project_directory_kind_conflict")); }
        self.engine.conn().execute("INSERT INTO _project_directory VALUES (?, 'table', ?, ?, 1, '[]') ON CONFLICT(id) DO UPDATE SET name=excluded.name,folder=excluded.folder,revision=_project_directory.revision+1",
            params![&meta.id,&meta.name,folder])?;
        Ok(())
    }

    /// Only new table producers call this; updates retain their existing history identity.
    pub(crate) fn publish_new_table(&self, meta:&DatasetMeta, folder:&str) -> Result<super::project_table_lifecycle::LifecycleEvent,AppError> {
        let exists:bool=self.engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_directory WHERE id=?)",[&meta.id],|row|row.get(0))?;
        if exists {return Err(invalid("project_table_already_published"));}
        self.publish_table(meta,folder)?;
        super::project_table_lifecycle::record_creation(self.engine,&meta.id)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<(u64, Value)>, AppError> {
        let value: Option<(u64, String)> = self.engine.conn().query_row("SELECT revision,value_json FROM _project_settings WHERE key=?", [key], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        value.map(|(revision, json)| Ok((revision, decode(&json)?))).transpose()
    }

    pub fn describe_table(&self, id: &str) -> Result<DatasetMeta, AppError> { self.engine.get_dataset_meta(id) }

    pub fn list_history(&self, request: &HistoryPageRequest) -> Result<ProjectHistoryPage, AppError> {
        if !(1..=1000).contains(&request.limit) { return Err(invalid("project_page_limit_invalid")); }
        let revision = project_schema::read_header(self.engine.conn(), false)?.committed_revision;
        let after = if let Some(cursor) = &request.after {
            let (expected, dataset, id): (u64, Option<String>, String) = decode(cursor)?;
            if expected != revision || dataset != request.dataset_id { return Err(invalid("project_history_cursor_stale")); }
            id
        } else { String::new() };
        let public_history = super::project_history_group::public_timeline(self.engine)?;
        let lifecycle_history=super::project_table_lifecycle::history_source(self.engine)?;
        let output_history=super::project_table_lifecycle::output_history_source(self.engine)?;
        let has_imported:bool=self.engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_imported_history_summary')",[],|row|row.get(0))?;
        let imported=if has_imported {"SELECT id,dataset_id,'archived',TRUE,0::UBIGINT,NULL::VARCHAR,description,timestamp FROM _project_imported_history_summary"}else{"SELECT NULL::VARCHAR,NULL::VARCHAR,NULL::VARCHAR,TRUE,0::UBIGINT,NULL::VARCHAR,NULL::VARCHAR,NULL::VARCHAR WHERE FALSE"};
        let sql = format!(
            "SELECT change_set_id,dataset_id,operation,applied,current_generation,dataset_name,description,timestamp FROM (
                 SELECT change_set_id,dataset_id,operation,applied,current_generation,NULL::VARCHAR AS dataset_name,NULL::VARCHAR AS description,NULL::VARCHAR AS timestamp FROM ({public_history}) visible
                 UNION ALL SELECT id,dataset_id,operation,TRUE,generation,NULL::VARCHAR,NULL::VARCHAR,NULL::VARCHAR FROM ({output_history}) outputs
                 UNION ALL SELECT id,dataset_id,operation,applied,generation,dataset_name,NULL::VARCHAR,NULL::VARCHAR FROM ({lifecycle_history}) lifecycle
                 UNION ALL {imported}
             ) history
             WHERE (CAST(? AS VARCHAR) IS NULL OR dataset_id=?) AND change_set_id > ? ORDER BY change_set_id LIMIT ?");
        let mut statement = self.engine.conn().prepare(&sql)?;
        let mut items = statement.query_map(params![&request.dataset_id, &request.dataset_id, after, (request.limit + 1) as i64], |r| Ok(ProjectHistorySummary {
            id: r.get(0)?, dataset_id: r.get(1)?, operation: r.get(2)?, applied: r.get(3)?, generation: r.get(4)?, dataset_name:r.get(5)?,description:r.get(6)?,timestamp:r.get(7)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > request.limit;
        items.truncate(request.limit);
        let next_cursor = if more { items.last().map(|last| encode(&(revision, &request.dataset_id, &last.id))).transpose()? } else { None };
        Ok(ProjectHistoryPage { items, next_cursor, committed_revision: revision })
    }
}

impl crate::services::project_database::ProjectDatabase {
    pub fn commit_records(&self,context:&ProjectWriteContext,patch:&ProjectRecordPatch) -> Result<ProjectCommit<()>,AppError> {
        self.commit_with_effects(context,&("commit_project_records",patch),|engine| {
            if patch.documents.iter().any(|write|write.document.summary.kind==ProjectDocumentKind::Snapshot) {
                return Err(invalid("project_record_requires_typed_operation"));
            }
            for id in &patch.deleted_document_ids {
                if ProjectCatalog::new(engine).summary(id)?.kind==ProjectDocumentKind::Snapshot {
                    return Err(invalid("project_record_requires_typed_operation"));
                }
            }
            ProjectCatalog::new(engine).apply_patch(patch)?;
            Ok(crate::services::project_transaction::CommitEffects {
                value:(),dataset_ids:vec![],
                document_ids:patch.documents.iter().map(|write| write.document.summary.id.clone())
                    .chain(patch.directory_moves.iter().map(|movement| movement.id.clone()))
                    .chain(patch.deleted_document_ids.iter().cloned())
                    .chain(patch.created_folders.iter().chain(&patch.deleted_folders).map(|folder|format!("folder:{folder}"))).collect(),
                setting_ids:patch.settings.iter().map(|setting| setting.key.clone()).collect(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::project_database::ProjectDatabase;
    use crate::models::project_persistence::ProjectWriteContext;
    use serde_json::json;

    fn report(id: &str, name: &str) -> DocumentWrite {
        DocumentWrite { expected_revision: None, document: ProjectDocumentBody {
            summary: ProjectDocumentSummary { id: id.into(), kind: ProjectDocumentKind::Report,
                name: name.into(), folder: String::new(), revision: 1, dependencies: vec![], analysis_kind: None },
            schema_version: 1, body: json!({"id":id,"name":name,"schemaVersion":1,"markdown":"large saved report"}) } }
    }

    fn commit(db: &ProjectDatabase, id: &str, patch: &ProjectRecordPatch) -> Result<(), AppError> {
        let context = ProjectWriteContext { operation_id: id.into(), expected_project_id: db.header().unwrap().project_id, expected_epoch: db.epoch(),
            expected_revision: db.committed_revision()?, request_digest: String::new(),
            document_revisions: vec![], dataset_generations: vec![] };
        db.commit(&context, patch, |engine| ProjectCatalog::new(engine).apply_patch(patch))?;
        Ok(())
    }

    #[test]
    fn project_v5_catalog_recreated_documents_keep_monotonic_revision_clocks() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("document-clock.spprj");let db=ProjectDatabase::create(&path,false).unwrap();
        commit(&db,"original",&ProjectRecordPatch{documents:vec![report("report","Original")],..Default::default()}).unwrap();
        commit(&db,"delete-original",&ProjectRecordPatch{deleted_document_ids:vec!["report".into()],..Default::default()}).unwrap();
        let context=|id:&str|ProjectWriteContext{operation_id:id.into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:db.committed_revision().unwrap(),request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let replacement=ProjectRecordPatch{documents:vec![report("report","Replacement")],..Default::default()};
        super::super::project_transaction::inject_commit_failure_for_test(1);assert!(db.commit_records(&context("failed-create"),&replacement).is_err());
        let created=db.commit_records(&context("recreate"),&replacement).unwrap();
        assert_eq!(created.changed_document_revisions[0].revision,2,"fresh proposal1 must not reuse the deleted body's clock");
        db.with_reader(db.epoch(),|engine| {let catalog=ProjectCatalog::new(engine);assert!(catalog.get_document("report",1).is_err());assert_eq!(catalog.get_document("report",2)?.summary.name,"Replacement");Ok(())}).unwrap();
        let mut stale=report("report","Replacement");stale.expected_revision=Some(1);stale.document.summary.revision=2;
        assert!(db.commit_records(&context("stale-write"),&ProjectRecordPatch{documents:vec![stale],..Default::default()}).is_err());
        let mut edit=report("report","Edited");edit.expected_revision=Some(2);edit.document.summary.revision=3;
        assert_eq!(db.commit_records(&context("edit"),&ProjectRecordPatch{documents:vec![edit],..Default::default()}).unwrap().changed_document_revisions[0].revision,3);
        commit(&db,"delete-again",&ProjectRecordPatch{deleted_document_ids:vec!["report".into()],..Default::default()}).unwrap();
        assert_eq!(db.commit_records(&context("recreate-again"),&replacement).unwrap().changed_document_revisions[0].revision,4);
        db.shutdown().unwrap();let original=std::fs::read(&path).unwrap();let reopened=ProjectDatabase::open(&path,true).unwrap();
        reopened.with_reader(reopened.epoch(),|engine|{assert_eq!(ProjectCatalog::new(engine).get_document("report",4)?.summary.name,"Replacement");Ok(())}).unwrap();reopened.shutdown().unwrap();assert_eq!(std::fs::read(&path).unwrap(),original);
    }

    #[test]
    fn project_v5_catalog_pre_index_files_stay_read_only_until_explicit_document_write() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("pre-index.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        commit(&db,"report",&ProjectRecordPatch {documents:vec![report("report","Report")],..Default::default()}).unwrap();
        db.with_engine(|engine| {engine.conn().execute_batch("DROP TABLE _project_document_subtypes")?;Ok(())}).unwrap();
        db.prepare_close(db.epoch()).unwrap();let original=std::fs::read(&path).unwrap();
        let read_only=ProjectDatabase::open(&path,true).unwrap();
        read_only.with_engine(|engine| {let catalog=ProjectCatalog::new(engine);catalog.validate_metadata()?;assert!(catalog.summary("report")?.analysis_kind.is_none());assert!(!catalog.has_subtypes()?);Ok(())}).unwrap();
        read_only.prepare_close(read_only.epoch()).unwrap();assert_eq!(original,std::fs::read(&path).unwrap());
        let writable=ProjectDatabase::open(&path,false).unwrap();
        let mut write=report("report","Report");write.expected_revision=Some(1);write.document.summary.revision=2;
        commit(&writable,"explicit-edit",&ProjectRecordPatch {documents:vec![write],..Default::default()}).unwrap();
        assert!(writable.with_engine(|engine|ProjectCatalog::new(engine).has_subtypes()).unwrap());
    }

    #[test]
    fn project_v5_catalog_analysis_subtype_is_metadata_and_survives_rename_and_reopen() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("subtypes.spprj");
        let db=ProjectDatabase::create(&path,false).unwrap();
        let body:Value=serde_json::from_str(include_str!("../../../tests/fixtures/mcp-distribution-document.json")).unwrap();
        let write:DocumentWrite=serde_json::from_value(json!({"expectedRevision":null,"document":{"schemaVersion":1,"summary":{
            "id":body["id"],"name":body["name"],"kind":"analysis","folder":"","revision":1,"dependencies":["dataset-1"]},"body":body}})).unwrap();
        commit(&db,"analysis",&ProjectRecordPatch {documents:vec![write],..Default::default()}).unwrap();
        // Listing must use only metadata, even when an unrelated body cannot be parsed.
        db.with_engine(|engine| {engine.conn().execute("UPDATE _project_documents SET body_json='invalid body' WHERE id='analysis-1'",[])?;Ok(())}).unwrap();
        let page=db.with_engine(|engine| ProjectCatalog::new(engine).list(&CatalogPageRequest {after:None,limit:10})).unwrap();
        assert_eq!(serde_json::to_value(&page).unwrap()["items"][0]["analysisKind"],"distribution");
        commit(&db,"rename",&ProjectRecordPatch {directory_moves:vec![DirectoryMove {id:"analysis-1".into(),expected_revision:1,folder:"Reports".into(),name:Some("Renamed analysis".into())}],..Default::default()}).unwrap();
        db.prepare_close(db.epoch()).unwrap();
        let reopened=ProjectDatabase::open(&path,true).unwrap();
        let summary=reopened.with_engine(|engine| ProjectCatalog::new(engine).summary("analysis-1")).unwrap();
        let metadata=serde_json::to_value(summary).unwrap();
        assert_eq!(metadata["name"],"Renamed analysis");assert_eq!(metadata["analysisKind"],"distribution");
    }

    #[test]
    fn project_records_acknowledges_settings_and_directory_revisions() {
        let dir=tempfile::tempdir().unwrap();
        let db=ProjectDatabase::create(&dir.path().join("records.spprj"),false).unwrap();
        let context=ProjectWriteContext {operation_id:"records".into(),expected_project_id:db.header().unwrap().project_id,expected_epoch:db.epoch(),expected_revision:0,request_digest:String::new(),document_revisions:vec![],dataset_generations:vec![]};
        let patch=ProjectRecordPatch {documents:vec![report("report","Report")],settings:vec![ProjectSettingWrite {key:"logicalFolders".into(),expected_revision:None,value:json!([])}],..Default::default()};
        let result=db.commit_records(&context,&patch).unwrap();
        let json=serde_json::to_value(&result).unwrap();
        assert_eq!(json["changedSettingRevisions"][0]["key"],"logicalFolders");
        assert_eq!(json["changedSettingRevisions"][0]["revision"],1);
        assert_eq!(result.changed_document_revisions[0].revision,1);
    }

    #[test]
    fn project_catalog_body_summary_and_revision_are_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("catalog.spprj"), false).unwrap();
        let mut invalid = report("bad", "bad");
        invalid.document.schema_version = 99;
        let patch = ProjectRecordPatch { documents: vec![report("good", "中文报告"), invalid], ..Default::default() };
        assert!(commit(&db, "failed", &patch).is_err());
        let page = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list(&CatalogPageRequest::default())).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(db.committed_revision().unwrap(), 0);
        commit(&db, "valid", &ProjectRecordPatch { documents: vec![report("good", "中文报告")], ..Default::default() }).unwrap();
        let doc = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).get_document("good", 1)).unwrap();
        assert_eq!(doc.summary.name, "中文报告");
        assert_eq!(doc.body["markdown"], "large saved report");
        assert!(db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).get_document("good", 2)).is_err());
    }

    #[test]
    fn project_catalog_paging_rejects_cursor_after_concurrent_change() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("pages.spprj"), false).unwrap();
        commit(&db, "seed", &ProjectRecordPatch { documents: vec![report("a", "A"),report("b", "B"),report("c", "C")], ..Default::default() }).unwrap();
        let first = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list(&CatalogPageRequest { after: None, limit: 2 })).unwrap();
        assert_eq!(first.items.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a","b"]);
        let request = CatalogPageRequest { after: first.next_cursor, limit: 2 };
        let second = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list(&request)).unwrap();
        assert_eq!(second.items.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["c"]);
        commit(&db, "new", &ProjectRecordPatch { documents: vec![report("d", "D")], ..Default::default() }).unwrap();
        assert!(db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list(&request)).is_err());
    }

    #[test]
    fn project_catalog_moves_and_deletes_without_loading_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("folders.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        commit(&db, "seed", &ProjectRecordPatch { documents: vec![report("doc", "Report")],
            created_folders: vec!["数据/空目录".into()], ..Default::default() }).unwrap();
        db.with_engine(|e| { e.conn().execute("UPDATE _project_documents SET body_json = ? WHERE id = ?", ["broken JSON", "doc"])?; Ok(()) }).unwrap();
        commit(&db, "move", &ProjectRecordPatch { directory_moves: vec![DirectoryMove { id: "doc".into(), expected_revision: 1, folder: "数据".into(), name:None }], ..Default::default() }).unwrap();
        let page = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list(&CatalogPageRequest::default())).unwrap();
        assert_eq!(page.items.iter().find(|s| s.id == "doc").unwrap().folder, "数据");
        assert!(page.items.iter().any(|s| s.kind == ProjectDocumentKind::Folder && s.name == "空目录"));
        commit(&db, "delete", &ProjectRecordPatch { deleted_document_ids: vec!["doc".into()], ..Default::default() }).unwrap();
        db.shutdown().unwrap();
        let reopened = ProjectDatabase::open(&path, false).unwrap();
        let page = reopened.with_reader(reopened.epoch(), |e| ProjectCatalog::new(e).list(&CatalogPageRequest::default())).unwrap();
        assert!(page.items.iter().all(|s| s.kind == ProjectDocumentKind::Folder));
    }

    #[test]
    fn project_catalog_settings_revisions_and_unknown_schemas_reject() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("settings.spprj"), false).unwrap();
        let patch = ProjectRecordPatch { settings: vec![ProjectSettingWrite { key: "lineage".into(), expected_revision: None, value: json!({"nodes":[]}) }], ..Default::default() };
        commit(&db, "settings", &patch).unwrap();
        let mut partial = patch.clone();
        partial.documents.push(report("rollback", "Rollback"));
        assert!(commit(&db, "stale-settings", &partial).is_err());
        assert!(db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).get_document("rollback", 1)).is_err());
        let mut bad = report("bad", "Invalid");
        bad.document.body["schemaVersion"] = json!(99);
        assert!(commit(&db, "schema", &ProjectRecordPatch { documents: vec![bad], ..Default::default() }).is_err());
        assert!(serde_json::from_value::<ProjectDocumentKind>(json!("unknown")).is_err());
        assert_eq!(db.committed_revision().unwrap(), 1);
    }

    #[test]
    fn project_catalog_reads_table_counts_and_history_without_payload_scans() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("metadata.spprj"), false).unwrap();
        db.with_engine(|e| {
            e.conn().execute_batch("INSERT INTO _meta_datasets(id,name,source_type,row_count,col_count) VALUES ('table','Table','manual',10000000,20);
                INSERT INTO _history_timeline VALUES ('h','table',0,'delta','update_cells',0,1,1,TRUE,'[]','[]')")?;
            Ok(())
        }).unwrap();
        // No physical dataset_table exists: these operations must use only metadata.
        let meta = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).describe_table("table")).unwrap();
        assert_eq!(meta.row_count, 10_000_000);
        let history = db.with_reader(db.epoch(), |e| ProjectCatalog::new(e).list_history(&HistoryPageRequest { dataset_id: Some("table".into()), after: None, limit: 1 })).unwrap();
        assert_eq!(history.items[0].id, "h");
        assert!(history.items[0].applied);
    }

    #[test]
    fn project_catalog_moves_table_metadata_without_loading_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("table-directory.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        db.with_engine(|engine| {
            engine.conn().execute_batch("INSERT INTO _meta_datasets(id,name,source_type,row_count,col_count) VALUES ('table','Table','manual',10000000,20)")?;
            let catalog = ProjectCatalog::new(engine);
            catalog.publish_table(&catalog.describe_table("table")?, "")
        }).unwrap();
        // A physical data table is deliberately absent: directory operations are metadata-only.
        let context = ProjectWriteContext { operation_id:"move-table".into(), expected_project_id:db.header().unwrap().project_id,
            expected_epoch:db.epoch(), expected_revision:0, request_digest:String::new(),
            document_revisions:vec![DocumentRevision { id:"table".into(), revision:1 }], dataset_generations:vec![] };
        let result = db.commit_records(&context,&ProjectRecordPatch {
            directory_moves:vec![DirectoryMove { id:"table".into(), expected_revision:1, folder:"Data/Sub".into(), name:None }],
            ..Default::default()
        }).unwrap();
        assert_eq!(result.changed_document_revisions[0].revision,2);
        db.shutdown().unwrap();
        let reopened = ProjectDatabase::open(&path,false).unwrap();
        let page = reopened.with_reader(reopened.epoch(), |engine| ProjectCatalog::new(engine).list(&CatalogPageRequest::default())).unwrap();
        let table = page.items.iter().find(|item| item.id == "table").unwrap();
        assert_eq!(table.folder,"Data/Sub");
        assert_eq!(table.revision,2);
        assert_eq!(reopened.with_reader(reopened.epoch(), |engine| ProjectCatalog::new(engine).describe_table("table")).unwrap().row_count,10_000_000);
    }

    #[test]
    fn project_catalog_renames_without_loading_body_or_table_rows() {
        let dir=tempfile::tempdir().unwrap();
        let db=ProjectDatabase::create(&dir.path().join("rename.spprj"),false).unwrap();
        commit(&db,"seed",&ProjectRecordPatch {documents:vec![report("doc","Report")],..Default::default()}).unwrap();
        db.with_engine(|engine| {
            engine.conn().execute_batch("UPDATE _project_documents SET body_json='unparsed-body' WHERE id='doc'; INSERT INTO _meta_datasets(id,name,source_type,row_count,col_count) VALUES ('table','Table','manual',10000000,20)")?;
            ProjectCatalog::new(engine).publish_table(&engine.get_dataset_meta("table")?,"")
        }).unwrap();
        let patch:ProjectRecordPatch=serde_json::from_value(json!({"directoryMoves":[
            {"id":"doc","expectedRevision":1,"folder":"","name":"Renamed report"},
            {"id":"table","expectedRevision":1,"folder":"","name":"Renamed table"}
        ]})).unwrap();
        commit(&db,"rename",&patch).unwrap();
        let page=db.with_reader(db.epoch(),|engine|ProjectCatalog::new(engine).list(&CatalogPageRequest::default())).unwrap();
        assert_eq!(page.items.iter().find(|item|item.id=="doc").unwrap().name,"Renamed report");
        assert_eq!(page.items.iter().find(|item|item.id=="table").unwrap().name,"Renamed table");
        let meta=db.with_reader(db.epoch(),|engine|engine.get_dataset_meta("table")).unwrap();
        assert_eq!(meta.name,"Renamed table");assert_eq!(meta.generation,0);
        let invalid:ProjectRecordPatch=serde_json::from_value(json!({"directoryMoves":[{"id":"doc","expectedRevision":2,"folder":"","name":"bad/name"}]})).unwrap();
        assert!(commit(&db,"invalid-name",&invalid).is_err());
        assert_eq!(db.committed_revision().unwrap(),2);
    }

    #[test]
    fn project_catalog_reader_has_one_consistent_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("snapshot.spprj"), false).unwrap();
        db.with_reader(db.epoch(), |engine| {
            let catalog = ProjectCatalog::new(engine);
            let first = catalog.list(&CatalogPageRequest::default())?;
            commit(&db, "concurrent", &ProjectRecordPatch { documents: vec![report("new", "New")], ..Default::default() })?;
            let second = catalog.list(&CatalogPageRequest::default())?;
            assert_eq!(first.committed_revision, second.committed_revision);
            assert_eq!(first.items, second.items);
            Ok(())
        }).unwrap();
        assert_eq!(db.committed_revision().unwrap(), 1);
    }

    #[test]
    fn project_catalog_cannot_change_kind_of_existing_document() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("kind.spprj"), false).unwrap();
        commit(&db, "seed", &ProjectRecordPatch { documents: vec![report("doc", "Report")], ..Default::default() }).unwrap();
        let mut changed = report("doc", "Report");
        changed.expected_revision = Some(1);
        changed.document.summary.revision = 2;
        changed.document.summary.kind = ProjectDocumentKind::Graph;
        assert!(commit(&db, "kind", &ProjectRecordPatch { documents: vec![changed], ..Default::default() }).is_err());
        assert_eq!(db.committed_revision().unwrap(), 1);
    }
}

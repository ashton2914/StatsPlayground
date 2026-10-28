//! Selected-workflow run metadata, kept separate from output document packets.

use super::{project_schema, workflow_executor::WorkflowRunCommitPacket};
use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::project_persistence::ProjectWorkflowRunState;
use duckdb::{params, OptionalExt};

fn has_index(engine: &DuckDbEngine) -> Result<bool, AppError> {
    Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='_project_workflow_runs')",[],|row|row.get(0))?)
}

fn legacy_source() -> &'static str {
    "SELECT json_extract_string(value_json,'$.run.id') AS id,
        json_extract_string(value_json,'$.run.workflowId') AS workflow_id,
        CAST(json_extract_string(value_json,'$.run.workflowRevision') AS UBIGINT) AS workflow_revision,
        0::UBIGINT AS project_revision,json_extract_string(value_json,'$.run') AS run_json
        FROM _project_settings WHERE starts_with(key,'workflowRun:')"
}

pub(crate) fn metadata_source(engine: &DuckDbEngine) -> Result<String, AppError> {
    Ok(if has_index(engine)? {
        "SELECT id,workflow_id,workflow_revision,project_revision,run_json FROM _project_workflow_runs".into()
    } else {
        legacy_source().into()
    })
}

/// The caller owns the project transaction. Older opt-in files gain only this
/// small metadata index on an explicit run; opening them never writes a schema.
pub(crate) fn record(
    engine: &DuckDbEngine,
    packet: &WorkflowRunCommitPacket,
) -> Result<(), AppError> {
    if packet.commit_id != packet.run.id
        || packet.run.id.trim().is_empty()
        || packet.run.workflow_id.trim().is_empty()
    {
        return Err(AppError::InvalidParam(
            "project_workflow_packet_invalid".into(),
        ));
    }
    if !has_index(engine)? {
        let invalid:bool=engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_settings WHERE starts_with(key,'workflowRun:') AND (json_extract_string(value_json,'$.run.id') IS DISTINCT FROM substr(key,13) OR COALESCE(json_extract_string(value_json,'$.run.workflowId'),'')='' OR json_extract_string(value_json,'$.run.workflowRevision') IS NULL))",[],|row|row.get(0))?;
        if invalid {
            return Err(AppError::Database("project_workflow_run_invalid".into()));
        }
        engine.conn().execute_batch("CREATE TABLE _project_workflow_runs(id VARCHAR PRIMARY KEY,workflow_id VARCHAR NOT NULL,workflow_revision UBIGINT NOT NULL,project_revision UBIGINT NOT NULL,run_json VARCHAR NOT NULL)")?;
        engine.conn().execute(
            &format!("INSERT INTO _project_workflow_runs {}", legacy_source()),
            [],
        )?;
        engine.conn().execute_batch("CREATE INDEX _project_workflow_runs_owner ON _project_workflow_runs(workflow_id,workflow_revision,project_revision)")?;
    }
    let json = serde_json::to_string(&packet.run)
        .map_err(|_| AppError::InvalidParam("project_workflow_packet_invalid".into()))?;
    let existing: Option<String> = engine
        .conn()
        .query_row(
            "SELECT run_json FROM _project_workflow_runs WHERE id=?",
            [&packet.run.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        let old: serde_json::Value = serde_json::from_str(&existing)
            .map_err(|_| AppError::Database("project_workflow_run_invalid".into()))?;
        if old
            != serde_json::to_value(&packet.run)
                .map_err(|_| AppError::InvalidParam("project_workflow_packet_invalid".into()))?
        {
            return Err(AppError::Database("project_workflow_run_id_reused".into()));
        }
    }
    let revision = project_schema::read_header(engine.conn(), true)?
        .committed_revision
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("project_revision_exhausted".into()))?;
    engine.conn().execute("INSERT INTO _project_workflow_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_revision=excluded.project_revision",params![&packet.run.id,&packet.run.workflow_id,packet.run.workflow_revision,revision,json])?;
    Ok(())
}

pub(crate) fn read_state(
    engine: &DuckDbEngine,
    workflow_id: &str,
    workflow_revision: u64,
) -> Result<ProjectWorkflowRunState, AppError> {
    if workflow_id.trim().is_empty() || workflow_id.len() > 256 {
        return Err(AppError::InvalidParam("project_workflow_id_invalid".into()));
    }
    let source = metadata_source(engine)?;
    let total_count = engine.conn().query_row(
        &format!("SELECT COUNT(*) FROM ({source}) runs WHERE workflow_id=?"),
        [workflow_id],
        |row| row.get(0),
    )?;
    let latest:Option<(String,String)>=engine.conn().query_row(&format!("SELECT id,COALESCE(json_extract_string(run_json,'$.outputBindings'),'[]') FROM ({source}) runs WHERE workflow_id=? AND workflow_revision=? ORDER BY project_revision DESC,COALESCE(json_extract_string(run_json,'$.completedAt'),json_extract_string(run_json,'$.startedAt'),'') DESC,id DESC LIMIT 1"),params![workflow_id,workflow_revision],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    let (latest_run_id, latest_output_bindings) = if let Some((id, bindings)) = latest {
        (
            Some(id),
            Some(
                serde_json::from_str(&bindings)
                    .map_err(|_| AppError::Database("project_workflow_run_invalid".into()))?,
            ),
        )
    } else {
        (None, None)
    };
    Ok(ProjectWorkflowRunState {
        workflow_id: workflow_id.into(),
        workflow_revision,
        committed_revision: project_schema::read_header(engine.conn(), false)?.committed_revision,
        total_count,
        latest_run_id,
        latest_output_bindings,
    })
}

#[cfg(test)]
mod tests {
    use crate::models::project_persistence::ProjectWriteContext;
    use crate::services::project_database::ProjectDatabase;
    use crate::services::workflow_executor::WorkflowRunCommitPacket;
    use serde_json::json;

    fn packet(id: &str, binding: &str) -> WorkflowRunCommitPacket {
        serde_json::from_value(json!({"commitId":id,"documents":[],"run":{"id":id,"workflowId":"workflow","workflowRevision":1,"status":"succeeded","completedAt":"2","outputBindings":[{"declarationId":"output","artifactDocumentId":binding}]}})).unwrap()
    }

    #[test]
    fn project_v5_workflow_run_state_reads_metadata_only_and_indexes_on_explicit_commit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runs.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        let old = packet("old", "old-output");
        let mut legacy = serde_json::to_value(&old).unwrap();
        legacy["documents"] = json!([{"unparsedBody":"x".repeat(2000000)}]);
        legacy["run"]["completedAt"] = json!("1");
        db.with_engine(|engine|{engine.conn().execute("INSERT INTO _project_settings VALUES ('workflowRun:old',1,?)",[legacy.to_string()])?;let state=super::read_state(engine,"workflow",1)?;assert_eq!(state.total_count,1);assert_eq!(state.latest_output_bindings.unwrap()[0].artifact_document_id,"old-output");let tables:i64=engine.conn().query_row("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='_project_workflow_runs'",[],|row|row.get(0))?;assert_eq!(tables,0,"metadata reads must not create an index");Ok(())}).unwrap();
        let context = ProjectWriteContext {
            operation_id: "new".into(),
            expected_project_id: db.header().unwrap().project_id,
            expected_epoch: db.epoch(),
            expected_revision: 0,
            request_digest: String::new(),
            dataset_generations: vec![],
            document_revisions: vec![],
        };
        let new = packet("new", "new-output");
        db.commit(&context, &"new", |engine| {
            super::record(engine, &new)?;
            engine.conn().execute(
                "INSERT INTO _project_settings VALUES ('workflowRun:new',1,?)",
                [serde_json::to_string(&new).unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
        db.with_engine(|engine| {
            let state = super::read_state(engine, "workflow", 1)?;
            assert_eq!(state.total_count, 2);
            assert_eq!(state.latest_run_id.as_deref(), Some("new"));
            assert_eq!(state.committed_revision, 1);
            let size = serde_json::to_string(&state).unwrap().len();
            assert!(size < 1000);
            let retained: i64 = engine.conn().query_row(
                "SELECT COUNT(*) FROM _project_workflow_runs",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(retained, 2);
            Ok(())
        })
        .unwrap();
        let failed = ProjectWriteContext {
            operation_id: "rolled-back".into(),
            expected_revision: 1,
            ..context
        };
        crate::services::project_transaction::inject_commit_failure_for_test(1);
        assert!(db
            .commit(&failed, &"failure", |engine| {
                super::record(engine, &packet("failed", "wrong-output"))?;
                Ok(())
            })
            .is_err());
        db.with_engine(|engine| {
            assert_eq!(super::read_state(engine, "workflow", 1)?.total_count, 2);
            assert_eq!(
                super::read_state(engine, "workflow", 2)?.latest_run_id,
                None
            );
            Ok(())
        })
        .unwrap();
        db.shutdown().unwrap();
        let reopened = ProjectDatabase::open(&path, true).unwrap();
        reopened
            .with_engine(|engine| {
                let state = super::read_state(engine, "workflow", 1)?;
                assert_eq!(
                    state.latest_output_bindings.unwrap()[0].artifact_document_id,
                    "new-output"
                );
                assert_eq!(state.total_count, 2);
                Ok(())
            })
            .unwrap();
        reopened.shutdown().unwrap();
    }
}

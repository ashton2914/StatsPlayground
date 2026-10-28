use duckdb::params;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::services::project_database::ProjectDatabase;

pub(crate) fn discard_staged_history_in_transaction(
    engine: &DuckDbEngine,
    id: &str,
) -> Result<(), AppError> {
    let mut statement = engine
        .conn()
        .prepare("SELECT id FROM _history_change_sets WHERE dataset_id=?")?;
    let history = statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for change in history {
        engine.drop_change_set_in_transaction(&change)?;
    }
    engine.conn().execute(
        "DELETE FROM _history_dataset_state WHERE dataset_id=?",
        [id],
    )?;
    Ok(())
}

pub(crate) fn discard_staged_operation_in_transaction(
    engine: &DuckDbEngine,
    operation: &str,
) -> Result<(), AppError> {
    let mut statement = engine
        .conn()
        .prepare("SELECT table_id FROM _project_staging WHERE operation_id=?")?;
    let ids = statement
        .query_map([operation], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let prefix = format!("__workflow_stage_{}_", operation.replace('-', "_"));
    for id in &ids {
        let suffix = id
            .strip_prefix(&prefix)
            .and_then(|rest| rest.split_once('_'));
        let valid = suffix.is_some_and(|(ordinal, uuid)| {
            ordinal.parse::<usize>().is_ok()
                && uuid.len() == 32
                && uuid::Uuid::parse_str(uuid).is_ok()
        });
        let visible: bool = engine.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM _project_directory WHERE id=?)",
            [id],
            |row| row.get(0),
        )?;
        if !valid || visible {
            return Err(AppError::InvalidParam(
                "project_staging_owner_invalid".into(),
            ));
        }
    }
    for id in ids {
        discard_staged_history_in_transaction(engine, &id)?;
        engine.delete_dataset(&id)?;
        engine.conn().execute(
            "DELETE FROM _project_staging WHERE operation_id=? AND table_id=?",
            params![operation, id],
        )?;
    }
    Ok(())
}

impl ProjectDatabase {
    pub(crate) fn discard_staged_operation(
        &self,
        epoch: u64,
        operation: &str,
    ) -> Result<(), AppError> {
        self.check_staging_access(epoch)?;
        self.with_engine(|engine| {
            engine.conn().execute_batch("BEGIN TRANSACTION")?;
            let result = discard_staged_operation_in_transaction(engine, operation);
            crate::services::table_delta_mutation::finish_transaction(engine, result)
        })
    }

    /// Run before exposing a reopened writable session, when no compute is active.
    pub(crate) fn recover_staged_operations(&self, epoch: u64) -> Result<(), AppError> {
        self.check_staging_access(epoch)?;
        self.with_engine(|engine| {
            engine.conn().execute_batch("BEGIN TRANSACTION")?;
            let result = (|| {
                let mut statement = engine
                    .conn()
                    .prepare("SELECT DISTINCT operation_id FROM _project_staging")?;
                let operations = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                for operation in operations {
                    discard_staged_operation_in_transaction(engine, &operation)?;
                }
                Ok(())
            })();
            crate::services::table_delta_mutation::finish_transaction(engine, result)
        })
    }

    fn check_staging_access(&self, epoch: u64) -> Result<(), AppError> {
        if self.is_read_only() {
            return Err(AppError::ReadOnly("project_read_only".into()));
        }
        if epoch != self.epoch() {
            return Err(AppError::InvalidParam("project_epoch_stale".into()));
        }
        Ok(())
    }
}

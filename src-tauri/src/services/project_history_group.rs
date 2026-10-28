use crate::{engine::duckdb_engine::DuckDbEngine, error::AppError};
use duckdb::{params, OptionalExt};

fn exists(engine: &DuckDbEngine) -> Result<bool, AppError> {
    Ok(engine.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM duckdb_tables() WHERE table_name='_project_history_groups')",
        [],
        |r| r.get(0),
    )?)
}

/// Only explicit grouped mutations create this extension on older v5 projects.
pub(crate) fn record(
    engine: &DuckDbEngine,
    children: &[String],
    operation: &str,
) -> Result<String, AppError> {
    let root = children
        .last()
        .ok_or_else(|| AppError::InvalidParam("paste_has_no_changes".into()))?;
    engine.conn().execute_batch("CREATE TABLE IF NOT EXISTS _project_history_groups (root_id VARCHAR NOT NULL, ordinal UINTEGER NOT NULL, child_id VARCHAR NOT NULL UNIQUE, operation VARCHAR NOT NULL, PRIMARY KEY(root_id,ordinal))")?;
    for (ordinal, child) in children.iter().enumerate() {
        engine.conn().execute(
            "INSERT INTO _project_history_groups VALUES (?,?,?,?)",
            params![root, ordinal as u32, child, operation],
        )?;
    }
    Ok(root.clone())
}

pub(crate) fn children(engine: &DuckDbEngine, id: &str) -> Result<Option<Vec<String>>, AppError> {
    if !exists(engine)? {
        return Ok(None);
    }
    let root: Option<String> = engine
        .conn()
        .query_row(
            "SELECT root_id FROM _project_history_groups WHERE child_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(root) = root else {
        return Ok(None);
    };
    if root != id {
        return Err(AppError::InvalidParam(
            "project_history_group_child_not_public".into(),
        ));
    }
    let rows = engine.conn().prepare("SELECT g.child_id,h.dataset_id,h.applied FROM _project_history_groups g JOIN _history_change_sets h ON h.id=g.child_id WHERE g.root_id=? ORDER BY g.ordinal")?.query_map([id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    let count: usize = engine.conn().query_row(
        "SELECT COUNT(*) FROM _project_history_groups WHERE root_id=?",
        [id],
        |r| r.get(0),
    )?;
    if rows.len() != count
        || rows.last().map(|r| r.0.as_str()) != Some(id)
        || rows.iter().any(|r| r.1 != rows[0].1 || r.2 != rows[0].2)
    {
        return Err(AppError::Database("project_history_group_invalid".into()));
    }
    Ok(Some(rows.into_iter().map(|r| r.0).collect()))
}

/// Hide implementation children in both paged reads and commit receipts.
pub(crate) fn public_timeline(engine: &DuckDbEngine) -> Result<String, AppError> {
    if !exists(engine)? {
        return Ok("SELECT * FROM _history_timeline".into());
    }
    Ok("SELECT h.* EXCLUDE(operation), COALESCE(g.operation,h.operation) AS operation FROM _history_timeline h LEFT JOIN _project_history_groups g ON g.child_id=h.change_set_id WHERE g.child_id IS NULL OR g.child_id=g.root_id".into())
}

pub(crate) fn unlink(engine: &DuckDbEngine, id: &str) -> Result<(), AppError> {
    if exists(engine)? {
        engine.conn().execute("DELETE FROM _project_history_groups WHERE root_id IN (SELECT root_id FROM _project_history_groups WHERE child_id=?)", [id])?;
    }
    Ok(())
}

/// DuckDB requires schema changes before row writes in the same transaction.
/// Rebind cell snapshots by stable ID after reversing the group's schema.
pub(crate) fn replay_order(
    engine: &DuckDbEngine,
    children: &[String],
    undo: bool,
) -> Result<Vec<(String, bool)>, AppError> {
    let root = children
        .last()
        .ok_or_else(|| AppError::Database("project_history_group_empty".into()))?;
    let dataset: String = engine.conn().query_row(
        "SELECT dataset_id FROM _history_change_sets WHERE id=?",
        [root],
        |r| r.get(0),
    )?;
    let frontier: Option<String> = engine.conn().query_row(if undo { "SELECT change_set_id FROM _history_timeline WHERE dataset_id=? AND applied=TRUE ORDER BY history_ordinal DESC LIMIT 1" } else { "SELECT change_set_id FROM _history_timeline WHERE dataset_id=? AND applied=FALSE ORDER BY history_ordinal LIMIT 1" }, [&dataset], |r|r.get(0)).optional()?;
    if frontier.as_ref()
        != if undo {
            children.last()
        } else {
            children.first()
        }
    {
        return Err(AppError::InvalidParam(
            "project_history_cursor_stale".into(),
        ));
    }
    let mut schema = Vec::new();
    let mut data = Vec::new();
    let mut ordered = children.to_vec();
    if undo {
        ordered.reverse();
    }
    for child in ordered {
        let kind: String = engine.conn().query_row(
            "SELECT storage_kind FROM _history_change_sets WHERE id=?",
            [&child],
            |r| r.get(0),
        )?;
        if kind == "column_delta" {
            schema.push((child, false));
        } else if kind == "cell_delta" {
            data.push((child, undo));
        } else if kind == "row_delta" {
            data.push((child, false));
        } else {
            return Err(AppError::Database(
                "project_history_group_kind_invalid".into(),
            ));
        }
    }
    schema.extend(data);
    Ok(schema)
}

pub(crate) fn owns_added_column(
    engine: &DuckDbEngine,
    child: &str,
    column: &str,
) -> Result<bool, AppError> {
    Ok(engine.conn().query_row("SELECT EXISTS(SELECT 1 FROM _project_history_groups g JOIN _project_history_groups c ON c.root_id=g.root_id JOIN _history_delta_change_sets d ON d.id=c.child_id JOIN _history_column_deltas cols ON cols.change_set_id=d.id WHERE g.child_id=? AND d.operation='add_columns' AND cols.column_id=?)", params![child,column], |r|r.get(0))?)
}

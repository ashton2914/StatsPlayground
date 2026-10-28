use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::table::CellUpdate;
use crate::services::table_history_archive::{
    advance_history_timeline, capture_history_schema, record_history_timeline,
};
use crate::services::table_mutation_coordinator::TableMutationEffects;
use duckdb::{params, OptionalExt};
use std::collections::{BTreeMap, BTreeSet};

/// Returns only value edits; schema growth, inferred type conversion and
/// calculated outputs remain explicit bulk mutations.
pub(crate) fn compact_paste_updates(
    engine: &DuckDbEngine,
    dataset: &str,
    start: usize,
    start_column: usize,
    rows: &[Vec<String>],
    headers: Option<&[String]>,
    types: &[String],
) -> Result<Option<Vec<CellUpdate>>, AppError> {
    Ok(compact_paste_updates_with_row_ids(engine,dataset,start,start_column,rows,headers,types,None)?.filter(|updates|!updates.is_empty()))
}

// Mirrors the table paste inputs plus explicit stable row identities.
#[allow(clippy::too_many_arguments)]
pub(crate) fn compact_paste_updates_with_row_ids(
    engine:&DuckDbEngine,dataset:&str,start:usize,start_column:usize,rows:&[Vec<String>],headers:Option<&[String]>,types:&[String],row_ids:Option<&[i64]>,
)->Result<Option<Vec<CellUpdate>>,AppError> {
    if headers.is_some() || rows.is_empty() {
        return Ok(None);
    }
    let columns = engine.get_user_columns(dataset)?;
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let end_column = start_column
        .checked_add(width)
        .ok_or_else(|| AppError::InvalidParam("paste_column_overflow".into()))?;
    let end = start
        .checked_add(rows.len())
        .ok_or_else(|| AppError::InvalidParam("paste_row_overflow".into()))?;
    let meta = engine.get_dataset_meta(dataset)?;
    if end_column > columns.len()
        || (row_ids.is_none() && end as u128 > meta.row_count.max(0) as u128)
        || width
            .checked_mul(rows.len())
            .is_none_or(|count| count > 100_000)
    {
        return Ok(None);
    }
    for (offset,(name,sql_type)) in columns[start_column..end_column].iter().enumerate() {
        let Some(requested)=types.get(offset) else {return Ok(None);};
        let requested=engine.canonicalize_column_type_for_create(requested)?;
        if !requested.eq_ignore_ascii_case(sql_type) {
            let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset));let column=DuckDbEngine::quote_identifier(name);
            let has_data:bool=engine.conn().query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column} IS NOT NULL)"),[],|row|row.get(0))?;
            if !has_data {return Ok(None);}
        }
    }
    let ids=if let Some(ids)=row_ids {
        if ids.len()!=rows.len()||ids.iter().copied().collect::<BTreeSet<_>>().len()!=ids.len() {return Err(AppError::InvalidParam("paste_row_identity_invalid".into()));}
        ids.to_vec()
    } else {
    let anchor: (i64,i128,i64) = engine.conn().query_row(
        "SELECT ordinal,order_key,row_id FROM _table_navigation_anchors WHERE dataset_id=? AND generation=? AND ordinal<=? ORDER BY ordinal DESC LIMIT 1",
        params![dataset,meta.generation,start as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    )?;
    let offset = i64::try_from(start)
        .ok()
        .and_then(|start| start.checked_sub(anchor.0))
        .filter(|offset| (0..crate::engine::duckdb_engine::NATURAL_ANCHOR_STRIDE as i64).contains(offset))
        .ok_or_else(|| AppError::Database("paste_anchor_invalid".into()))?;
    let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset));
    let order = crate::engine::duckdb_engine::NATURAL_ORDER_SQL;
    let mut statement = engine.conn().prepare(&format!("SELECT _row_id FROM {table} WHERE {order}>? OR ({order}=? AND _row_id>=?) ORDER BY {order},_row_id LIMIT ? OFFSET ?"))?;
    let ids = statement
        .query_map(
            params![anchor.1, anchor.1, anchor.2, rows.len() as i64, offset],
            |r| r.get::<_, i64>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() != rows.len() {
        return Err(AppError::Database("paste_row_window_incomplete".into()));
    }
    ids
    };
    let mut updates = Vec::new();
    for (row, id) in rows.iter().zip(ids) {
        for (column, value) in row.iter().enumerate() {
            // Existing paste semantics preserve cells for empty input fields.
            if !value.is_empty() {
                updates.push(CellUpdate {
                    row_id: id,
                    column_name: columns[start_column + column].0.clone(),
                    value: Some(value.clone()),
                });
            }
        }
    }
    Ok(Some(updates))
}

/// Caller owns the transaction. Each column snapshot retains its native DuckDB
/// type and contains exactly the touched row IDs, even for sparse pastes.
pub(crate) fn update_cells_compact_in_transaction(
    engine: &DuckDbEngine,
    dataset_id: &str,
    updates: &[CellUpdate],
    expected_generation: u64,
) -> Result<TableMutationEffects<()>, AppError> {
    if updates.len() > 100_000 {
        return Err(AppError::InvalidParam("too_many_cell_updates".into()));
    }
    if engine.get_dataset_generation(dataset_id)? != expected_generation {
        return Err(AppError::InvalidParam(
            "project_dataset_generation_stale".into(),
        ));
    }
    engine.reject_calculated_column_writes(dataset_id, updates.iter().map(|u| u.column_name.as_str()))?;
    let changed_column_ids = engine
        .resolve_column_ids_by_name(dataset_id, updates.iter().map(|u| u.column_name.as_str()))?;
    if updates.is_empty() {
        return Ok(TableMutationEffects {
            value: (),
            changed_column_ids,
            change_set_id: None,
            recompute_column_ids: None,
        });
    }
    let conn = engine.conn();
    let next = expected_generation
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("dataset_generation_exhausted".into()))?;
    let schema = capture_history_schema(engine, dataset_id)?;
    let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset_id));
    let id = uuid::Uuid::new_v4();
    let change_id = id.to_string();
    let mut grouped = BTreeMap::<String, BTreeSet<i64>>::new();
    for update in updates {
        grouped
            .entry(update.column_name.clone())
            .or_default()
            .insert(update.row_id);
    }
    let descriptors=engine.get_user_column_descriptors(dataset_id)?;
    let mut grouped=grouped.into_iter().map(|(name,rows)|(name,std::sync::Arc::new(rows))).collect::<BTreeMap<_,_>>();
    let mut source_rows=crate::services::table_mutation_coordinator::FormulaRowSets::new();
    for (name,rows) in &grouped {
        let column=descriptors.iter().find(|column|column.name==*name).ok_or_else(||AppError::InvalidParam("unknown edited column".into()))?;
        source_rows.insert(column.column_id.clone(),std::sync::Arc::clone(rows));
    }
    let derived=crate::services::table_mutation_coordinator::affected_formula_rows(engine,dataset_id,&source_rows)?;
    for (id,rows) in &derived {
        let column=descriptors.iter().find(|column|column.column_id==*id).ok_or_else(||AppError::Database("calculated output column is missing".into()))?;
        grouped.insert(column.name.clone(),std::sync::Arc::clone(rows));
    }
    let mut snapshots = Vec::new();
    for (ordinal, (name, rows)) in grouped.iter().enumerate() {
        let column_id: String = conn.query_row(
            "SELECT column_id FROM _meta_columns WHERE dataset_id=? AND col_name=?",
            params![dataset_id, name],
            |r| r.get(0),
        )?;
        let snapshot = format!("_history_cells_{}_{}", id.simple(), ordinal);
        let quoted = DuckDbEngine::quote_identifier(&snapshot);
        let column = DuckDbEngine::quote_identifier(name);
        // IDs are parsed i64 values, never SQL supplied by a client.
        let ids = rows
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        conn.execute_batch(&format!("CREATE TABLE {quoted} AS SELECT _row_id, {column} AS before_value, {column} AS after_value FROM {table} WHERE _row_id IN ({ids})"))?;
        let count: u64 =
            conn.query_row(&format!("SELECT count(*) FROM {quoted}"), [], |r| r.get(0))?;
        if count != rows.len() as u64 {
            return Err(AppError::InvalidParam("project_cell_row_missing".into()));
        }
        conn.execute(
            "INSERT INTO _project_cell_history_columns VALUES (?, ?, ?, ?, ?)",
            params![&change_id, ordinal as u32, &column_id, name, &snapshot],
        )?;
        snapshots.push((quoted, column));
    }
    engine.apply_cell_updates_inner(dataset_id, updates)?;
    crate::services::table_mutation_coordinator::materialize_formula_rows(engine,dataset_id,&derived)?;
    for (snapshot, column) in snapshots {
        conn.execute_batch(&format!("UPDATE {snapshot} s SET after_value=t.{column} FROM {table} t WHERE t._row_id=s._row_id"))?;
    }
    conn.execute("INSERT INTO _history_change_sets(id,dataset_id,applied,generation,storage_kind) VALUES (?, ?, TRUE, ?, 'cell_delta')", params![&change_id, dataset_id, next])?;
    // Branch cleanup rolls back with the new edit if publication fails.
    record_history_timeline(
        engine,
        &change_id,
        dataset_id,
        "cell_delta",
        "update_cells",
        expected_generation,
        next,
        &schema,
        &schema,
    )?;
    engine.copy_natural_anchors_between_generations(dataset_id, expected_generation, next)?;
    conn.execute("UPDATE _meta_datasets SET generation=?,updated_at=CAST(current_timestamp AS VARCHAR) WHERE id=?", params![next,dataset_id])?;
    engine.refresh_delta_history_generations_for_dataset(dataset_id)?;
    Ok(TableMutationEffects {
        value: (),
        changed_column_ids,
        change_set_id: Some(change_id),
        recompute_column_ids: None,
    })
}

pub(crate) fn apply_cell_change_set_in_transaction(
    engine: &DuckDbEngine,
    id: &str,
    undo: bool,
) -> Result<(), AppError> {
    apply_cell_history(engine,id,undo,false)
}

pub(crate) fn apply_grouped_cell_undo_in_transaction(engine: &DuckDbEngine, id: &str) -> Result<(), AppError> {
    apply_cell_history(engine,id,true,true)
}

fn apply_cell_history(engine: &DuckDbEngine, id: &str, undo: bool, rebind: bool) -> Result<(), AppError> {
    let conn = engine.conn();
    let (dataset, applied, expected): (String,bool,u64) = conn.query_row("SELECT dataset_id,applied,generation FROM _history_change_sets WHERE id=? AND storage_kind='cell_delta'", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if applied != undo || engine.get_dataset_generation(&dataset)? != expected {
        return Err(AppError::InvalidParam("project_history_state_stale".into()));
    }
    let frontier: Option<String> = conn.query_row(
        if undo { "SELECT change_set_id FROM _history_timeline WHERE dataset_id=? AND applied=TRUE ORDER BY history_ordinal DESC LIMIT 1" }
        else { "SELECT change_set_id FROM _history_timeline WHERE dataset_id=? AND applied=FALSE ORDER BY history_ordinal LIMIT 1" },
        [&dataset], |r| r.get(0),
    ).optional()?;
    if frontier.as_deref() != Some(id) {
        return Err(AppError::InvalidParam(
            "project_history_cursor_stale".into(),
        ));
    }
    let columns = {
        let mut statement = conn.prepare("SELECT column_id,column_name,snapshot_table,ordinal FROM _project_cell_history_columns WHERE change_set_id=? ORDER BY ordinal")?;
        let result = statement
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, u32>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        result
    };
    if columns.is_empty() {
        return Err(AppError::Database("project_cell_history_missing".into()));
    }
    let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset));
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| AppError::InvalidParam("Invalid change set ID".into()))?;
    for (column_id, name, snapshot, ordinal) in columns {
        if snapshot != format!("_history_cells_{}_{ordinal}", parsed.simple()) {
            return Err(AppError::Database("project_cell_snapshot_identity_invalid".into()));
        }
        let current: Option<String> = conn.query_row(
            "SELECT col_name FROM _meta_columns WHERE dataset_id=? AND column_id=?",
            params![&dataset, &column_id],
            |r| r.get(0),
        ).optional()?;
        let Some(current) = current else {
            if rebind && super::project_history_group::owns_added_column(engine,id,&column_id)? { continue; }
            return Err(AppError::InvalidParam("project_history_schema_stale".into()));
        };
        if !rebind && current != name {
            return Err(AppError::InvalidParam(
                "project_history_schema_stale".into(),
            ));
        }
        let column = DuckDbEngine::quote_identifier(&current);
        let snapshot = DuckDbEngine::quote_identifier(&snapshot);
        let side = if undo { "before_value" } else { "after_value" };
        conn.execute_batch(&format!(
            "UPDATE {table} t SET {column}=s.{side} FROM {snapshot} s WHERE t._row_id=s._row_id"
        ))?;
    }
    let next = expected
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidParam("dataset_generation_exhausted".into()))?;
    engine.copy_natural_anchors_between_generations(&dataset, expected, next)?;
    conn.execute("UPDATE _meta_datasets SET generation=?,updated_at=CAST(current_timestamp AS VARCHAR) WHERE id=?", params![next,&dataset])?;
    conn.execute(
        "UPDATE _history_change_sets SET applied=? WHERE id=?",
        params![!undo, id],
    )?;
    engine.refresh_delta_history_generations_for_dataset(&dataset)?;
    advance_history_timeline(engine, &dataset, id, !undo, next)
}

pub(crate) fn drop_cell_snapshots_in_transaction(
    engine: &DuckDbEngine,
    id: &str,
) -> Result<(), AppError> {
    let parsed = uuid::Uuid::parse_str(id)
        .map_err(|_| AppError::InvalidParam("Invalid change set ID".into()))?;
    let snapshots = {
        let mut statement = engine.conn().prepare("SELECT ordinal,snapshot_table FROM _project_cell_history_columns WHERE change_set_id=?")?;
        let result = statement
            .query_map([id], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        result
    };
    for (ordinal, name) in snapshots {
        if name != format!("_history_cells_{}_{ordinal}", parsed.simple()) {
            return Err(AppError::Database(
                "project_cell_snapshot_identity_invalid".into(),
            ));
        }
        engine.conn().execute_batch(&format!(
            "DROP TABLE IF EXISTS {}",
            DuckDbEngine::quote_identifier(&name)
        ))?;
    }
    engine.conn().execute(
        "DELETE FROM _project_cell_history_columns WHERE change_set_id=?",
        [id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::engine::duckdb_engine::{
        full_anchor_rebuild_counter, reset_full_anchor_rebuild_counter, DuckDbEngine,
    };
    use crate::models::table::CellUpdate;
    use crate::services::project_database::ProjectDatabase;

    #[test]
    fn project_v5_small_mutations_paste_uses_natural_order_and_preserves_types() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("paste.spprj"), false).unwrap();
        db.with_engine(|e| {
            e.create_empty_table("data", "Data", &["integer".into(),"date".into(),"time".into()], &["BIGINT".into(),"DATE".into(),"TIMESTAMP_NS".into()])?;
            let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name("data"));
            e.conn().execute_batch(&format!("INSERT INTO {table} (_row_id,_row_order,integer,date,time) VALUES (1,30,1,'2020-01-01','2020-01-01 00:00:00'),(9,10,9,'2020-01-09','2020-01-09 00:00:00'),(3,20,3,'2020-01-03','2020-01-03 00:00:00'); UPDATE _meta_datasets SET row_count=3,next_row_id=10 WHERE id='data'"))?;
            e.rebuild_natural_anchors("data",0)?;
            reset_full_anchor_rebuild_counter();
            let id = e.paste_at_position_with_change_set("data",1,0,&[vec!["9007199254740993".into(),"2024-02-29".into(),"2024-02-29 12:34:56.123456789".into()]],None,&["BIGINT".into(),"DATE".into(),"TIMESTAMP_NS".into()],Some(0))?;
            let kind: String = e.conn().query_row("SELECT storage_kind FROM _history_change_sets WHERE id=?",[&id],|r| r.get(0))?;
            assert_eq!(kind,"cell_delta");
            let actual: (i64,String,String) = e.conn().query_row(&format!("SELECT integer,CAST(date AS VARCHAR),CAST(time AS VARCHAR) FROM {table} WHERE _row_id=3"),[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            assert_eq!(actual,(9007199254740993,"2024-02-29".into(),"2024-02-29 12:34:56.123456789".into()));
            e.apply_change_set(&id,true)?;
            let value: i64=e.conn().query_row(&format!("SELECT integer FROM {table} WHERE _row_id=3"),[],|r| r.get(0))?;
            assert_eq!(value,3);
            e.apply_change_set(&id,false)?;
            assert_eq!(full_anchor_rebuild_counter(),0);
            assert!(e.update_cells_if_generation("data",&[CellUpdate {row_id:3,column_name:"integer".into(),value:None}],Some(0)).is_err());
            Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_small_mutations_history_failure_rolls_back_and_new_edit_drops_redo() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("rollback.spprj"), false).unwrap();
        db.with_engine(|e| {
            e.create_empty_table("data","Data",&["value".into()],&["BIGINT".into()])?;
            let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name("data"));
            e.conn().execute_batch(&format!("INSERT INTO {table} (_row_id,value) VALUES (1,11); UPDATE _meta_datasets SET row_count=1,next_row_id=2 WHERE id='data'"))?;
            e.rebuild_natural_anchors("data",0)?;
            e.conn().execute_batch("ALTER TABLE _history_timeline RENAME TO broken_timeline")?;
            let update=CellUpdate {row_id:1,column_name:"value".into(),value:None};
            assert!(e.update_cells_if_generation("data",std::slice::from_ref(&update),Some(0)).is_err());
            let value: i64=e.conn().query_row(&format!("SELECT value FROM {table}"),[],|r| r.get(0))?;
            assert_eq!(value,11);
            assert_eq!(e.get_dataset_generation("data")?,0);
            e.conn().execute_batch("ALTER TABLE broken_timeline RENAME TO _history_timeline")?;
            e.update_cells_if_generation("data",std::slice::from_ref(&update),Some(0))?;
            let id: String=e.conn().query_row("SELECT id FROM _history_change_sets",[],|r| r.get(0))?;
            e.apply_change_set(&id,true)?;
            e.update_cells_if_generation("data",&[CellUpdate {value:Some("22".into()),..update}],Some(2))?;
            assert!(e.apply_change_set(&id,false).is_err());
            let old: u64=e.conn().query_row("SELECT count(*) FROM _project_cell_history_columns WHERE change_set_id=?",[&id],|r| r.get(0))?;
            assert_eq!(old,0);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn project_v5_small_mutations_share_project_transaction_and_rollback() {
        use crate::models::project_persistence::ProjectWriteContext;
        use crate::services::table_delta_mutation::{
            add_rows_compact_in_transaction, delete_rows_compact_in_transaction,
        };
        let dir = tempfile::tempdir().unwrap();
        let db = ProjectDatabase::create(&dir.path().join("atomic.spprj"), false).unwrap();
        db.with_engine(|e| {
            e.create_empty_table("data", "Data", &["value".into()], &["BIGINT".into()])?;
            Ok(())
        })
        .unwrap();
        let context = ProjectWriteContext {
            operation_id: "fail".into(),
            expected_project_id: db.header().unwrap().project_id, expected_epoch: db.epoch(),
            expected_revision: 0,
            request_digest: String::new(),
            document_revisions: vec![],
            dataset_generations: vec![],
        };
        let outcome = db.commit::<(), _>(&context, &"mixed", |e| {
            let added = add_rows_compact_in_transaction(e, "data", 2, None, 0)?;
            super::update_cells_compact_in_transaction(
                e,
                "data",
                &[CellUpdate {
                    row_id: added.row_ids[0],
                    column_name: "value".into(),
                    value: Some("123".into()),
                }],
                1,
            )?;
            delete_rows_compact_in_transaction(e, "data", &added.row_ids[1..], 2)?;
            Err(crate::error::AppError::InvalidParam(
                "injected_history_failure".into(),
            ))
        });
        assert!(outcome.is_err());
        assert_eq!(db.committed_revision().unwrap(), 0);
        db.with_engine(|e| {
            assert_eq!(e.get_dataset_generation("data")?, 0);
            assert_eq!(e.get_dataset_meta("data")?.row_count, 0);
            let count: u64 =
                e.conn()
                    .query_row("SELECT count(*) FROM _history_change_sets", [], |r| {
                        r.get(0)
                    })?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_v5_small_mutations_capture_only_changed_cells_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cells.spprj");
        let db = ProjectDatabase::create(&path, false).unwrap();
        db.with_engine(|e| {
            e.create_empty_table("data", "Data", &["value".into()], &["BIGINT".into()])?;
            let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name("data"));
            e.conn().execute_batch(&format!("INSERT INTO {table} (_row_id,value) SELECT i,i FROM range(100000) r(i); UPDATE _meta_datasets SET row_count=100000 WHERE id='data'"))?;
            e.rebuild_natural_anchors("data", 0)?;
            reset_full_anchor_rebuild_counter();
            crate::services::table_mutation_coordinator::reset_full_before_table_copy_counter();
            e.update_cells_if_generation("data", &[CellUpdate { row_id: 17, column_name: "value".into(), value: Some("9007199254740993".into()) }], Some(0))?;
            assert_eq!(full_anchor_rebuild_counter(), 0, "plain edit must not rebuild anchors");
            let (kind, id): (String, String) = e.conn().query_row("SELECT storage_kind,id FROM _history_change_sets", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(kind, "cell_delta");
            assert_eq!(crate::services::table_mutation_coordinator::full_before_table_copy_counter(), 0);
            let snapshot: String = e.conn().query_row("SELECT snapshot_table FROM _project_cell_history_columns WHERE change_set_id=?", [&id], |r| r.get(0))?;
            let count: i64 = e.conn().query_row(&format!("SELECT count(*) FROM {}", DuckDbEngine::quote_identifier(&snapshot)), [], |r| r.get(0))?;
            assert_eq!(count, 1);
            assert_eq!(e.get_dataset_generation("data")?, 1);
            Ok(())
        }).unwrap();
        db.shutdown().unwrap();
        let db = ProjectDatabase::open(&path, false).unwrap();
        db.with_engine(|e| {
            let id: String =
                e.conn()
                    .query_row("SELECT id FROM _history_change_sets", [], |r| r.get(0))?;
            let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name("data"));
            reset_full_anchor_rebuild_counter();
            e.apply_change_set(&id, true)?;
            let value: i64 = e.conn().query_row(
                &format!("SELECT value FROM {table} WHERE _row_id=17"),
                [],
                |r| r.get(0),
            )?;
            assert_eq!(value, 17);
            e.apply_change_set(&id, false)?;
            let value: i64 = e.conn().query_row(
                &format!("SELECT value FROM {table} WHERE _row_id=17"),
                [],
                |r| r.get(0),
            )?;
            assert_eq!(value, 9007199254740993);
            assert_eq!(full_anchor_rebuild_counter(), 0);
            Ok(())
        })
        .unwrap();
    }
}
